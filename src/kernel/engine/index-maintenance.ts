import { realpathSync, statSync, watch } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { admitWriteTarget } from "../capture/safe.js";
import type { WriteTargetSource } from "../conventions/write-protocol.js";
import { scanIndexSources } from "./embed/freshness.js";
import { embedQueuedDocument, listPendingDocumentRevisions, maintainDocumentIndex, readMaintenanceState } from "./embed/maintenance.js";
import { assertExternalDatabasePath, engineStorePath } from "./paths.js";
import { acquireMaintenanceOwner } from "./maintenance-owner.js";
import { MaintenanceController, type MaintenanceHooks, type MaintenanceMode, type MaintenanceSchedule, type MaintenanceStatus } from "./maintenance-controller.js";
import { createMaintenanceEmbedding, type MaintenanceEmbedding } from "./maintenance-model.js";

export interface IndexMaintenanceOptions extends Omit<MaintenanceSchedule, "mode"> {
  readonly vault: string;
  readonly source?: WriteTargetSource;
  /** Absence is a strict no-op: no ownership, database open or model resolution. */
  readonly mode?: MaintenanceMode;
  readonly dbPath?: string;
  readonly modelCacheDir?: string;
  readonly modelEnv?: Readonly<Record<string, string | undefined>>;
}

export interface IndexMaintenance {
  readonly controller: MaintenanceController;
  status(): MaintenanceStatus & { readonly sqliteVersion: string };
  notify(relativePath?: string): void;
  stop(): Promise<void>;
}

export interface IndexMaintenanceDeps {
  readonly watch?: MaintenanceHooks["watch"];
  readonly scan?: MaintenanceHooks["scan"];
  readonly createEmbedding?: typeof createMaintenanceEmbedding;
}

export function maintenanceMode(value: string): MaintenanceMode {
  if (value !== "lexical" && value !== "full") throw new Error("Maintenance must be explicitly selected as lexical or full.");
  return value;
}

/** Ignore non-note housekeeping, but retain every known exclusion-control input. */
export function maintenanceWatchHint(relativePath: string | undefined): boolean {
  if (relativePath === undefined) return true;
  const normalized = relativePath.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
  const segments = normalized.split("/");
  if (normalized === "" || path.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || segments.some(part => part === ".." || part === "." || part === "")) return true;
  // Keep aligned with note-exclude.ts/template-paths.ts. Directory replacement
  // affecting a control file is also a full-inventory hint.
  const controls = [".oms/settings.json", ".obsidian/templates.json", ".obsidian/plugins/templater-obsidian/data.json"];
  if (controls.some(control => control === normalized || control.startsWith(`${normalized}/`))) return true;
  return segments[0] !== "_attachments" && !segments.some(part => part.startsWith(".") || part === "node_modules");
}

/** Known fixed upstream SQLite releases; no claim about unknown vendor backports. */
export function sqliteMaintenanceSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]); const minor = Number(match[2]); const patch = Number(match[3]);
  return major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3) || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6)));
}

/** Explicit server startup only. Search and ordinary server construction never call this. */
export async function startIndexMaintenance(options: IndexMaintenanceOptions, deps: IndexMaintenanceDeps = {}): Promise<IndexMaintenance | undefined> {
  if (options.mode === undefined) return undefined;
  const mode = maintenanceMode(options.mode);
  const rejection = await admitWriteTarget({ vault: options.vault, source: options.source as WriteTargetSource });
  if (rejection !== undefined) throw new Error(`MAINTENANCE_TARGET_UNVERIFIED: ${rejection.message}`);
  const configuredVault = path.resolve(options.vault);
  const vault = realpathSync(configuredVault);
  const root = statSync(vault, { bigint: true });
  if (!root.isDirectory() || root.dev <= 0n || root.ino <= 0n) throw new Error("MAINTENANCE_SCOPE_UNVERIFIED: vault must be an identifiable directory.");
  const dbPath = options.dbPath === undefined ? engineStorePath(vault) : assertExternalDatabasePath(vault, options.dbPath);
  // Check the runtime without first opening a potentially affected WAL store.
  const probe = new Database(":memory:");
  let sqliteVersion: string;
  try { sqliteVersion = (probe.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version; }
  finally { probe.close(); }
  if (!sqliteMaintenanceSupported(sqliteVersion)) throw new Error(`MAINTENANCE_SQLITE_UNVERIFIED: SQLite ${sqliteVersion} has no recognized WAL-reset fix. Use 3.51.3 or later, or a documented fixed backport, before enabling automatic maintenance.`);
  let state: ReturnType<typeof readMaintenanceState>;
  try { state = readMaintenanceState(dbPath); }
  catch (error) { throw new Error("MAINTENANCE_INDEX_UNAVAILABLE: initialize or repair the existing index with an explicit oms doctor sync-embeddings operation first.", { cause: error }); }
  const databaseTarget = realpathSync(dbPath);
  const owner = acquireMaintenanceOwner(vault, dbPath);
  let embedding: MaintenanceEmbedding | undefined;
  try {
    if (mode === "full") {
      embedding = (deps.createEmbedding ?? createMaintenanceEmbedding)(vault, options);
      if (state.embeddingIdentity?.fingerprint !== embedding.identity.fingerprint) throw new Error("MAINTENANCE_MODEL_UNVERIFIED: synchronize the selected embedding identity explicitly before full maintenance.");
    }
    const current = (): boolean => {
      try {
        const now = statSync(vault, { bigint: true });
        return owner.isCurrent() && now.dev === root.dev && now.ino === root.ino && realpathSync(configuredVault) === vault
          && realpathSync(assertExternalDatabasePath(vault, dbPath)) === databaseTarget && (embedding?.isCurrent() ?? true);
      } catch { return false; }
    };
    const controller = new MaintenanceController({ ...options, mode }, {
      watch: deps.watch ?? ((change, failure) => {
        let closing = false;
        const watcher = watch(vault, { recursive: true }, (_event, filename) => {
          const relativePath = filename?.toString();
          if (maintenanceWatchHint(relativePath)) change(relativePath);
        });
        watcher.on("error", failure);
        watcher.on("close", () => { if (!closing) failure(new Error("File watcher closed unexpectedly.")); });
        return { close() { closing = true; watcher.close(); } };
      }),
      scan: deps.scan ?? (async () => (await scanIndexSources(vault)).files),
      sources() {
        const snapshot = readMaintenanceState(dbPath);
        const legacy = new Set(snapshot.pending.filter(item => item.revision === null).map(item => item.docPath));
        const chunker = JSON.stringify({ version: 1, maxTokens: 900, overlapRatio: 0.15 });
        return new Map([...snapshot.documents].map(([docPath, source]) => [docPath,
          source === null || source.chunker !== chunker || legacy.has(docPath) ? null
            : source.fingerprint === null ? `bytes:${source.contentSha256}` : `metadata:${source.fingerprint}`]));
      },
      pending: () => listPendingDocumentRevisions(dbPath).map(item => item.docPath),
      maintain: (relPath, signal, isCurrent, purgeExcluded) => maintainDocumentIndex({ vault, dbPath, relPath, signal, isCurrent, purgeExcluded }),
      ...(embedding === undefined ? {} : { embed: (relPath: string, signal: AbortSignal, isCurrent: () => boolean) => embedQueuedDocument({ vault, dbPath, relPath, signal, isCurrent, provider: embedding!.provider, identity: embedding!.identity }) }),
      isCurrent: current,
      async release() { try { await embedding?.provider.dispose(); } finally { owner.release(); } },
    });
    controller.start();
    return { controller, status: () => ({ ...controller.status(), sqliteVersion: state.sqliteVersion }), notify: relativePath => controller.notify(relativePath), stop: () => controller.stop() };
  } catch (error) {
    try { await embedding?.provider.dispose(); } finally { owner.release(); }
    throw error;
  }
}

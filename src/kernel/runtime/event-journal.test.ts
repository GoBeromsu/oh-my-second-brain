import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "./event-journal.js";
import { readRuntimeEvents } from "./event-read.js";
import { RuntimeLedgerError } from "./event-types.js";

const roots: string[] = [];
const identity = { username: "journal-test", hostname: "host-a" } as const;

function temporary(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function hostId(username = identity.username, hostname = identity.hostname): string {
  return createHash("sha256").update(`${username}\0${hostname}`).digest("hex").slice(0, 32);
}

function fixture(): { readonly vault: string; readonly runtimeRoot: string } {
  const root = temporary("oms-event-journal");
  const vault = path.join(root, "vault");
  const runtimeRoot = path.join(root, "runtime");
  mkdirSync(vault);
  writeFileSync(path.join(vault, "owned.md"), "vault-owned\n");
  return { vault, runtimeRoot };
}

function event(kind = "note-write") {
  const invocation = createRuntimeInvocation({ surface: "cli", operation: "write", packageVersion: "1.2.3" });
  return createRuntimeEvent(invocation, { kind, outcome: "success", notePath: "Notes/a.md" });
}

function expectLedgerError(action: () => unknown, code: RuntimeLedgerError["code"]): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeLedgerError);
  expect(caught).toMatchObject({ code });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime event journal", () => {
  it("creates one invocation id per invocation and one event id per actual event", () => {
    const invocation = createRuntimeInvocation({ surface: "mcp", operation: "write" });
    const first = createRuntimeEvent(invocation, { kind: "write", outcome: "success" });
    const second = createRuntimeEvent(invocation, { kind: "write", outcome: "success" });
    expect(first.invocationId).toBe(second.invocationId);
    expect(first.eventId).not.toBe(second.eventId);
    expect(createRuntimeInvocation({ surface: "mcp", operation: "write" }).invocationId).not.toBe(invocation.invocationId);
  });

  it("deduplicates only an identical event-id replay and retains same-kind events", () => {
    const { vault, runtimeRoot } = fixture();
    const invocation = createRuntimeInvocation({ surface: "cli", operation: "write" });
    const first = createRuntimeEvent(invocation, { kind: "write", outcome: "success" });
    const second = createRuntimeEvent(invocation, { kind: "write", outcome: "success" });
    const options = { vaultPath: vault, runtimeRoot, identity };
    expect(appendRuntimeEvent(first, options).inserted).toBe(true);
    expect(appendRuntimeEvent(first, options)).toMatchObject({ eventId: first.eventId, inserted: false });
    expect(appendRuntimeEvent(second, options).inserted).toBe(true);
    expect(readRuntimeEvents(options).events.map(item => item.eventId).sort()).toEqual([first.eventId, second.eventId].sort());
  });

  it("rejects a changed payload replay that reuses an event id", () => {
    const { vault, runtimeRoot } = fixture();
    const original = event();
    const options = { vaultPath: vault, runtimeRoot, identity };
    appendRuntimeEvent(original, options);
    expectLedgerError(() => appendRuntimeEvent({ ...original, kind: "different" }, options), "LEDGER_APPEND_FAILED");
  });

  it("keeps the database and WAL sidecars outside the vault and configures busy timeout", () => {
    const { vault, runtimeRoot } = fixture();
    const pragma = vi.spyOn(Database.prototype, "pragma");
    appendRuntimeEvent(event(), { vaultPath: vault, runtimeRoot, identity });
    const databasePath = path.join(runtimeRoot, hostId(), "events.sqlite");
    const database = new Database(databasePath, { readonly: true });
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    database.close();
    expect(pragma).toHaveBeenCalledWith("busy_timeout = 5000");
    expect(readdirSync(vault)).toEqual(["owned.md"]);
  });

  it("waits through a concurrent writer using the configured busy timeout", async () => {
    const { vault, runtimeRoot } = fixture();
    const options = { vaultPath: vault, runtimeRoot, identity };
    appendRuntimeEvent(event("seed"), options);
    const databasePath = path.join(runtimeRoot, hostId(), "events.sqlite");
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import Database from "better-sqlite3";
       const db = new Database(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 150);`,
      databasePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
    const appendStartedAt = Date.now();
    const appended = appendRuntimeEvent(event("concurrent"), options);
    expect(appended.inserted).toBe(true);
    expect(Date.parse(appended.registeredAt) - appendStartedAt).toBeGreaterThanOrEqual(100);
    expect(await exited).toBe(0);
    expect(readRuntimeEvents(options).events).toHaveLength(2);
  });

  it("seals a runtime root that resolves into the vault before creating anything", () => {
    const { vault } = fixture();
    const linkedRoot = path.join(path.dirname(vault), "runtime-link");
    symlinkSync(vault, linkedRoot, "dir");
    const before = readdirSync(vault);
    expectLedgerError(
      () => appendRuntimeEvent(event(), { vaultPath: vault, runtimeRoot: linkedRoot, identity }),
      "LEDGER_ROOT_INSIDE_VAULT",
    );
    expect(readdirSync(vault)).toEqual(before);
  });

  it("rejects a runtime root lexically inside the vault before mkdir", () => {
    const { vault } = fixture();
    const unsafeRoot = path.join(vault, ".oms", "runtime");
    expectLedgerError(
      () => appendRuntimeEvent(event(), { vaultPath: vault, runtimeRoot: unsafeRoot, identity }),
      "LEDGER_ROOT_INSIDE_VAULT",
    );
    expect(readdirSync(vault)).toEqual(["owned.md"]);
  });

  it("does not modify a vault file hard-linked as the database", () => {
    const { vault, runtimeRoot } = fixture();
    const directory = path.join(runtimeRoot, hostId());
    mkdirSync(directory, { recursive: true });
    const owned = path.join(vault, "owned.md");
    linkSync(owned, path.join(directory, "events.sqlite"));
    const before = readFileSync(owned, "utf8");
    expectLedgerError(
      () => appendRuntimeEvent(event(), { vaultPath: vault, runtimeRoot, identity }),
      "LEDGER_APPEND_FAILED",
    );
    expect(readFileSync(owned, "utf8")).toBe(before);
  });

  it("rejects a dangling database symlink targeting an absent vault file without creating vault bytes", () => {
    const { vault, runtimeRoot } = fixture();
    const directory = path.join(runtimeRoot, hostId());
    mkdirSync(directory, { recursive: true });
    const target = path.join(vault, "must-not-exist.sqlite");
    symlinkSync(target, path.join(directory, "events.sqlite"));
    expectLedgerError(
      () => appendRuntimeEvent(event(), { vaultPath: vault, runtimeRoot, identity }),
      "LEDGER_APPEND_FAILED",
    );
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(vault)).toEqual(["owned.md"]);
  });

  it("rejects a dangling runtime-root ancestor before mkdir follows it", () => {
    const { vault } = fixture();
    const outside = path.dirname(vault);
    const danglingAncestor = path.join(outside, "dangling-runtime");
    symlinkSync(path.join(vault, "absent-directory"), danglingAncestor, "dir");
    expectLedgerError(
      () => appendRuntimeEvent(event(), {
        vaultPath: vault,
        runtimeRoot: path.join(danglingAncestor, "nested"),
        identity,
      }),
      "LEDGER_APPEND_FAILED",
    );
    expect(readdirSync(vault)).toEqual(["owned.md"]);
  });

  it("validates externally supplied events before opening the journal", () => {
    const { vault, runtimeRoot } = fixture();
    const valid = event();
    const options = { vaultPath: vault, runtimeRoot, identity };
    expectLedgerError(
      () => appendRuntimeEvent({ ...valid, inputSignature: "secret-token" }, options),
      "LEDGER_APPEND_FAILED",
    );
    expectLedgerError(
      () => appendRuntimeEvent({ ...valid, eventTime: "not-a-time" }, options),
      "LEDGER_APPEND_FAILED",
    );
    expectLedgerError(
      () => appendRuntimeEvent({ ...valid, outcome: "maybe" as never }, options),
      "LEDGER_APPEND_FAILED",
    );
    expectLedgerError(
      () => appendRuntimeEvent({ ...valid, notePath: "C:\\vault\\secret.md" }, options),
      "LEDGER_APPEND_FAILED",
    );
    expect(existsSync(runtimeRoot)).toBe(false);
    expect(readdirSync(vault)).toEqual(["owned.md"]);
  });

  it("returns a typed visible append diagnostic instead of falling back", () => {
    const { vault, runtimeRoot } = fixture();
    writeFileSync(runtimeRoot, "not a directory");
    let caught: unknown;
    try {
      appendRuntimeEvent(event(), { vaultPath: vault, runtimeRoot, identity });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeLedgerError);
    expect(caught).toMatchObject({ code: "LEDGER_APPEND_FAILED" });
    expect(readdirSync(vault)).toEqual(["owned.md"]);
  });
});

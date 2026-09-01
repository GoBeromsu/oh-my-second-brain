import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { HarnessHostSurface } from "../../kernel/harness/surface-registry.js";
import { resolveHostAdapterSource } from "../../kernel/install/adapter-source.js";
import {
  computeTreeDigest,
  decideOwnership,
  parseProvenance,
  serializeProvenance,
  type OmsInstallProvenance,
} from "../../kernel/install/provenance.js";
import { resolveSharedSkillsSource } from "../../assets/shared-skills.js";
import {
  InstallTargetSymlinkError,
  hostHome,
  mcpServerEntry,
  renderYamlEntryPreservingComments,
  replaceDirectory,
} from "../../kernel/install/common.js";
import type { HostOperationOptions, HostOperationResult } from "../../kernel/install/types.js";

const HERMES_SKILL_CATEGORY = "knowledge-management";
const HERMES_SKILL_NAME = "oms";

const HERMES_MCP_ENTRY_PATH = ["mcp_servers", "oms"] as const;
const HERMES_SKILLS = ["distill", "doctor", "link", "search", "status", "template", "write"] as const;

function refuseSymlink(target: string): void {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new InstallTargetSymlinkError(target);
  }
}

async function atomicWrite(file: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.oms-${process.pid}-${Date.now()}`);
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function rollbackConfig(configPath: string, preImage: Buffer | undefined, original: unknown): Promise<never> {
  try {
    if (preImage === undefined) await rm(configPath, { force: true });
    else await atomicWrite(configPath, preImage);
  } catch (rollbackError) {
    throw new AggregateError([original, rollbackError], "Hermes operation failed and config rollback also failed");
  }
  throw original;
}

async function verifyHermesInstall(configPath: string, skillTarget: string, options: HostOperationOptions): Promise<void> {
  const raw = existsSync(configPath) ? await readFile(configPath) : Buffer.alloc(0);
  const document = parseDocument(raw.toString("utf8"));
  const parsed = document.toJS() as Record<string, unknown> | null;
  const servers = parsed?.mcp_servers;
  const entry = servers && typeof servers === "object" ? (servers as Record<string, unknown>).oms : undefined;
  const expected = mcpServerEntry(options);
  const actual = entry as Record<string, unknown>;
  if (
    document.errors.length > 0 ||
    !entry ||
    typeof entry !== "object" ||
    actual.command !== expected.command ||
    actual.enabled !== true ||
    !Array.isArray(actual.args) ||
    actual.args.join("\0") !== (expected.args as string[]).join("\0")
  ) {
    throw new Error("Hermes config verification failed: mcp_servers.oms does not match the expected entry");
  }
  const installed = new Set(await readdir(skillTarget));
  if (!HERMES_SKILLS.every(skill => installed.has(skill) && existsSync(path.join(skillTarget, skill, "SKILL.md")))) {
    throw new Error("Hermes install verification failed: skill bundle is incomplete");
  }
}

async function verifyHermesTrees(
  skillSource: string,
  skillTarget: string,
  adapterFiles: readonly { readonly source: string; readonly target: string }[],
): Promise<void> {
  if ((await computeTreeDigest(skillSource)) !== (await computeTreeDigest(skillTarget))) {
    throw new Error("Hermes install verification failed: installed skill tree does not match the prepared source");
  }
  for (const file of adapterFiles) {
    if (!(await readFile(file.source)).equals(await readFile(file.target))) {
      throw new Error(`Hermes install verification failed: installed adapter asset does not match its source: ${file.target}`);
    }
  }
}

async function verifyHermesUninstall(configPath: string, targets: readonly string[]): Promise<void> {
  const raw = existsSync(configPath) ? await readFile(configPath) : Buffer.alloc(0);
  const document = parseDocument(raw.toString("utf8"));
  if (document.errors.length > 0 || document.hasIn(HERMES_MCP_ENTRY_PATH)) {
    throw new Error("Hermes uninstall verification failed: mcp_servers.oms remains");
  }
  if (targets.some(existsSync)) {
    throw new Error("Hermes uninstall verification failed: OMS-owned paths remain");
  }
}

function canonicalSkillLayout(entries: readonly string[]): boolean {
  return entries.length === HERMES_SKILLS.length &&
    entries.every(entry => HERMES_SKILLS.includes(entry as (typeof HERMES_SKILLS)[number]));
}

async function legacyOwnershipEvidence(skillTarget: string, adapterManifestTarget: string): Promise<boolean> {
  return existsSync(skillTarget) && existsSync(adapterManifestTarget) &&
    canonicalSkillLayout(await readdir(skillTarget));
}

async function readProvenance(file: string): Promise<{ readonly provenance: OmsInstallProvenance | null; readonly raw: string | null }> {
  if (!existsSync(file)) return { provenance: null, raw: null };
  const raw = await readFile(file, "utf8");
  return { provenance: parseProvenance(raw), raw };
}

function foreignOwnershipError(reason: string): Error {
  return new Error(`Refusing to replace Hermes OMS assets: ${reason} Remove or migrate the existing installation before retrying.`);
}

export async function installHermes(options: HostOperationOptions, host: HarnessHostSurface): Promise<HostOperationResult> {
  const hermesDir = hostHome(options.homeDir, ".hermes", "OMS_HERMES_HOME");
  const adapterSource = resolveHostAdapterSource(options.adapterRoot, host);
  const legacyPluginTarget = path.join(hermesDir, "plugins", "oms");
  const legacyMcpPath = path.join(hermesDir, "mcp", "oms.json");
  const skillSource = resolveSharedSkillsSource(options.adapterRoot);
  const skillTarget = path.join(hermesDir, "skills", HERMES_SKILL_CATEGORY, HERMES_SKILL_NAME);
  const configPath = path.join(hermesDir, "config.yaml");
  const adapterTarget = path.join(hermesDir, "adapters", "oms");
  const adapterManifestTarget = path.join(adapterTarget, "hermes-manifest.json");
  const guidanceTarget = path.join(adapterTarget, "SOUL.md");
  const readmeTarget = path.join(adapterTarget, "README.md");
  const provenanceTarget = path.join(adapterTarget, ".oms-provenance.json");
  const messages = ["Installed Hermes-native Oh My Second Brain skill bundle and registered mcp_servers.oms in ~/.hermes/config.yaml."];
  const manifest = JSON.parse(await readFile(path.join(adapterSource, "hermes-manifest.json"), "utf8")) as { version?: unknown };
  const packageMetadata = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof packageMetadata.version !== "string" || manifest.version !== packageMetadata.version) {
    throw new Error("Hermes install source package version does not match its manifest");
  }
  const expected = { version: packageMetadata.version, treeDigest: await computeTreeDigest(skillSource) };
  if (!options.dryRun) {
    // Prepare + admission: all input and host safety checks precede every write.
    for (const source of [skillSource, path.join(adapterSource, "hermes-manifest.json"), path.join(adapterSource, "hermes", "SOUL.md"), path.join(adapterSource, "hermes", "README.md")]) {
      if (!existsSync(source)) throw new Error(`Hermes install source is missing: ${source}`);
    }
    for (const target of [legacyPluginTarget, legacyMcpPath, adapterTarget, skillTarget, configPath, provenanceTarget]) refuseSymlink(target);
    const recorded = await readProvenance(provenanceTarget);
    const actualTreeDigest = existsSync(skillTarget) ? await computeTreeDigest(skillTarget) : null;
    if (recorded.raw !== null && recorded.provenance === null) {
      throw foreignOwnershipError("the provenance record is not valid npm provenance.");
    }
    const ownership = decideOwnership(recorded.provenance, expected, actualTreeDigest);
    if (ownership.action === "adopt-legacy-candidate" || ownership.action === "reject-foreign") {
      if (!await legacyOwnershipEvidence(skillTarget, adapterManifestTarget)) {
        throw foreignOwnershipError(
          ownership.action === "adopt-legacy-candidate"
            ? "the unrecorded skill tree does not have the exact legacy OMS layout."
            : ownership.reason,
        );
      }
    }
    const preImage = existsSync(configPath) ? await readFile(configPath) : undefined;
    const configRaw = preImage?.toString("utf8") ?? "";
    if (preImage && !preImage.equals(Buffer.from(configRaw, "utf8"))) throw new Error("Hermes config.yaml is not valid UTF-8");
    const config = renderYamlEntryPreservingComments(configRaw, HERMES_MCP_ENTRY_PATH, {
      kind: "set",
      value: { ...mcpServerEntry(options), enabled: true },
    });
    if (ownership.action === "noop") {
      // Assets are identical; the MCP registration may still differ (for example a
      // new vault). Reconcile only the config commit under the same rollback rule.
      if (!config.changed) {
        return {
          runtime: "hermes", action: "install", changed: false, skipped: true,
          paths: [adapterTarget, guidanceTarget, readmeTarget, skillTarget, provenanceTarget, configPath],
          commands: [`Hermes MCP config: ${configPath}`], messages,
        };
      }
      try {
        await atomicWrite(configPath, Buffer.from(config.text, "utf8"));
        await verifyHermesInstall(configPath, skillTarget, options);
      } catch (error) {
        await rollbackConfig(configPath, preImage, error);
      }
      return {
        runtime: "hermes", action: "install", changed: true, skipped: false,
        paths: [adapterTarget, guidanceTarget, readmeTarget, skillTarget, provenanceTarget, configPath],
        commands: [`Hermes MCP config: ${configPath}`], messages,
      };
    }
    try {
      // OMS-owned files commit first. config.yaml is deliberately the final commit.
      await rm(legacyPluginTarget, { recursive: true, force: true });
      await rm(legacyMcpPath, { force: true });
      await replaceDirectory(skillSource, skillTarget, false);
      await rm(adapterTarget, { recursive: true, force: true });
      await mkdir(adapterTarget, { recursive: true });
      await cp(path.join(adapterSource, "hermes-manifest.json"), adapterManifestTarget);
      await cp(path.join(adapterSource, "hermes", "SOUL.md"), guidanceTarget);
      await cp(path.join(adapterSource, "hermes", "README.md"), readmeTarget);
      await atomicWrite(provenanceTarget, Buffer.from(serializeProvenance({
        schemaVersion: 1,
        source: "npm",
        version: expected.version,
        treeDigest: expected.treeDigest,
        installedAt: new Date().toISOString(),
      }), "utf8"));
      if (config.changed) await atomicWrite(configPath, Buffer.from(config.text, "utf8"));
      await verifyHermesInstall(configPath, skillTarget, options);
      await verifyHermesTrees(skillSource, skillTarget, [
        { source: path.join(adapterSource, "hermes-manifest.json"), target: adapterManifestTarget },
        { source: path.join(adapterSource, "hermes", "SOUL.md"), target: guidanceTarget },
        { source: path.join(adapterSource, "hermes", "README.md"), target: readmeTarget },
      ]);
    } catch (error) {
      await rm(skillTarget, { recursive: true, force: true });
      await rm(adapterTarget, { recursive: true, force: true });
      await rollbackConfig(configPath, preImage, error);
    }
  }
  return {
    runtime: "hermes",
    action: "install",
    changed: !options.dryRun,
    skipped: false,
    paths: [adapterTarget, guidanceTarget, readmeTarget, skillTarget, provenanceTarget, configPath],
    commands: [`Hermes MCP config: ${configPath}`],
    messages,
  };
}

export async function uninstallHermes(options: HostOperationOptions): Promise<HostOperationResult> {
  const hermesDir = hostHome(options.homeDir, ".hermes", "OMS_HERMES_HOME");
  const adapterTarget = path.join(hermesDir, "adapters", "oms");
  const skillTarget = path.join(hermesDir, "skills", HERMES_SKILL_CATEGORY, HERMES_SKILL_NAME);
  const legacyPluginTarget = path.join(hermesDir, "plugins", "oms");
  const legacyMcpPath = path.join(hermesDir, "mcp", "oms.json");
  const configPath = path.join(hermesDir, "config.yaml");
  const adapterManifestTarget = path.join(adapterTarget, "hermes-manifest.json");
  const provenanceTarget = path.join(adapterTarget, ".oms-provenance.json");
  const recorded = await readProvenance(provenanceTarget);
  const actualTreeDigest = existsSync(skillTarget) ? await computeTreeDigest(skillTarget) : null;
  const ownsInstall = (recorded.provenance !== null && actualTreeDigest === recorded.provenance.treeDigest) ||
    (recorded.raw === null && await legacyOwnershipEvidence(skillTarget, adapterManifestTarget));
  if ((existsSync(skillTarget) || existsSync(adapterTarget)) && !ownsInstall) {
    throw foreignOwnershipError("the installed tree is not verified OMS npm ownership.");
  }
  const preImage = existsSync(configPath) ? await readFile(configPath) : undefined;
  const configRaw = preImage?.toString("utf8") ?? "";
  if (preImage && !preImage.equals(Buffer.from(configRaw, "utf8"))) throw new Error("Hermes config.yaml is not valid UTF-8");
  for (const target of [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath, configPath, provenanceTarget]) refuseSymlink(target);
  const config = renderYamlEntryPreservingComments(configRaw, HERMES_MCP_ENTRY_PATH, { kind: "delete" });
  let changed = false;
  changed = ownsInstall && config.changed;
  for (const target of ownsInstall ? [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath] : []) {
    if (existsSync(target)) {
      changed = true;
    }
  }
  if (!options.dryRun) {
    try {
      for (const target of ownsInstall ? [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath] : []) {
        await rm(target, { recursive: true, force: true });
      }
      if (ownsInstall && config.changed) await atomicWrite(configPath, Buffer.from(config.text, "utf8"));
      if (ownsInstall) {
        await verifyHermesUninstall(configPath, [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath]);
      }
    } catch (error) {
      await rollbackConfig(configPath, preImage, error);
    }
  }
  return {
    runtime: "hermes",
    action: "uninstall",
    changed: changed && !options.dryRun,
    skipped: !changed,
    paths: [adapterTarget, skillTarget, provenanceTarget, configPath],
    commands: [],
    messages: ["Removed Hermes Oh My Second Brain skill bundle, adapter copy, legacy descriptor files, and mcp_servers.oms."],
  };
}

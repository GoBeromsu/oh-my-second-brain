import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { HarnessHostSurface } from "../../kernel/harness/surface-registry.js";
import { resolveHostAdapterSource } from "../../kernel/install/adapter-source.js";
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

async function verifyHermesMcp(configPath: string): Promise<void> {
  const raw = existsSync(configPath) ? await readFile(configPath) : Buffer.alloc(0);
  const document = parseDocument(raw.toString("utf8"));
  if (document.errors.length > 0 || !document.hasIn(HERMES_MCP_ENTRY_PATH)) {
    throw new Error("Hermes config verification failed: mcp_servers.oms is missing");
  }
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
  const messages = ["Installed Hermes-native Oh My Second Brain skill bundle and registered mcp_servers.oms in ~/.hermes/config.yaml."];
  if (!options.dryRun) {
    // Prepare + admission: all input and host safety checks precede every write.
    for (const source of [skillSource, path.join(adapterSource, "hermes-manifest.json"), path.join(adapterSource, "hermes", "SOUL.md"), path.join(adapterSource, "hermes", "README.md")]) {
      if (!existsSync(source)) throw new Error(`Hermes install source is missing: ${source}`);
    }
    for (const target of [legacyPluginTarget, legacyMcpPath, adapterTarget, skillTarget, configPath]) refuseSymlink(target);
    const preImage = existsSync(configPath) ? await readFile(configPath) : undefined;
    const configRaw = preImage?.toString("utf8") ?? "";
    if (preImage && !preImage.equals(Buffer.from(configRaw, "utf8"))) throw new Error("Hermes config.yaml is not valid UTF-8");
    const config = renderYamlEntryPreservingComments(configRaw, HERMES_MCP_ENTRY_PATH, {
      kind: "set",
      value: { ...mcpServerEntry(options), enabled: true },
    });
    try {
      // OMS-owned files commit first. config.yaml is deliberately the final commit.
      await rm(legacyPluginTarget, { recursive: true, force: true });
      await rm(legacyMcpPath, { force: true });
      await rm(adapterTarget, { recursive: true, force: true });
      await mkdir(adapterTarget, { recursive: true });
      await cp(path.join(adapterSource, "hermes-manifest.json"), adapterManifestTarget);
      await cp(path.join(adapterSource, "hermes", "SOUL.md"), guidanceTarget);
      await cp(path.join(adapterSource, "hermes", "README.md"), readmeTarget);
      await replaceDirectory(skillSource, skillTarget, false);
      if (config.changed) await atomicWrite(configPath, Buffer.from(config.text, "utf8"));
      await verifyHermesMcp(configPath);
    } catch (error) {
      await rollbackConfig(configPath, preImage, error);
    }
  }
  return {
    runtime: "hermes",
    action: "install",
    changed: !options.dryRun,
    skipped: false,
    paths: [adapterTarget, guidanceTarget, readmeTarget, skillTarget, configPath],
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
  const preImage = existsSync(configPath) ? await readFile(configPath) : undefined;
  const configRaw = preImage?.toString("utf8") ?? "";
  if (preImage && !preImage.equals(Buffer.from(configRaw, "utf8"))) throw new Error("Hermes config.yaml is not valid UTF-8");
  for (const target of [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath, configPath]) refuseSymlink(target);
  const config = renderYamlEntryPreservingComments(configRaw, HERMES_MCP_ENTRY_PATH, { kind: "delete" });
  let changed = false;
  changed = config.changed;
  for (const target of [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath]) {
    if (existsSync(target)) {
      changed = true;
    }
  }
  if (!options.dryRun) {
    try {
      for (const target of [adapterTarget, skillTarget, legacyPluginTarget, legacyMcpPath]) {
        await rm(target, { recursive: true, force: true });
      }
      if (config.changed) await atomicWrite(configPath, Buffer.from(config.text, "utf8"));
    } catch (error) {
      await rollbackConfig(configPath, preImage, error);
    }
  }
  return {
    runtime: "hermes",
    action: "uninstall",
    changed: changed && !options.dryRun,
    skipped: !changed,
    paths: [adapterTarget, skillTarget, configPath],
    commands: [],
    messages: ["Removed Hermes Oh My Second Brain skill bundle, adapter copy, legacy descriptor files, and mcp_servers.oms."],
  };
}

import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessHostSurface } from "../../kernel/harness/surface-registry.js";
import { resolveSharedSkillsSource } from "../../assets/shared-skills.js";
import { hostSurfaceForRuntime, resolveHostAdapterSource } from "../../kernel/install/adapter-source.js";
import { InstallTargetSymlinkError, hostHome, jsonString, mcpArgs, replaceDirectory } from "../../kernel/install/common.js";
import {
  decideOwnership,
  digestOneFile,
  parseProvenance,
  serializeProvenance,
  type OmsInstallProvenance,
} from "../../kernel/install/provenance.js";
import type { HostOperationOptions, HostOperationResult } from "../../kernel/install/types.js";

const MANAGED_CODEX_START = "# BEGIN OMS MANAGED MCP";
const MANAGED_CODEX_END = "# END OMS MANAGED MCP";
const CODEX_SKILL_PREFIX = "oms-";
const CODEX_RULE_FILENAME = "oms.md";

/**
 * Installer destinations for the optional Codex role.
 * Registry assetPath is the shipped source; these remain the trusted install paths.
 * The sidecar digest is digestOneFile of this filename, not a hash of ~/.codex/agents.
 */
const CODEX_REVIEWER_FILENAME = "oms-reviewer.toml";
const CODEX_REVIEWER_PROVENANCE_FILENAME = "oms-reviewer.provenance.json";

function codexManagedBlockForVault(vault: string): string {
  const args = mcpArgs({ vault } as HostOperationOptions).map(jsonString).join(", ");
  return [
    MANAGED_CODEX_START,
    "# OMS MCP hookup for Codex CLI. Managed by `oms host install/remove`.",
    "# Codex-native rules live in ~/.codex/rules/oms.md; skills live in ~/.codex/skills/oms-*.",
    "[mcp_servers.oms]",
    'command = "oms"',
    `args = [${args}]`,
    "",
    "[mcp_servers.oms.env]",
    'OMS_AGENT_RUNTIME = "codex"',
    MANAGED_CODEX_END,
    "",
  ].join("\n");
}


/** Recognizes exactly the managed MCP block rendered by this adapter. */
export function isCodexOmsRegistration(content: string, configPath = "Codex config"): boolean {
  const block = managedCodexBlock(content, configPath);
  if (block === undefined) return false;
  const managed = content.slice(block.start, block.end);
  const vault = /^args = \["serve", "mcp", "--vault", ("(?:[^"\\]|\\.)*")\]$/m.exec(managed)?.[1];
  if (vault === undefined) return false;
  let parsedVault: unknown;
  try {
    parsedVault = JSON.parse(vault);
  } catch {
    return false;
  }
  return typeof parsedVault === "string" && managed === codexManagedBlockForVault(parsedVault);
}

function isCodexOMSTable(line: string): boolean {
  return line === "[mcp_servers.oms]" || line.startsWith("[mcp_servers.oms.");
}

type CodexManagedMarker = {
  readonly token: typeof MANAGED_CODEX_START | typeof MANAGED_CODEX_END;
  readonly line: number;
  readonly lineStart: number;
  readonly offset: number;
  readonly valid: boolean;
};

type ManagedCodexBlock = {
  readonly start: number;
  readonly end: number;
};

class CodexManagedBlockAmbiguousError extends Error {
  constructor(configPath: string, markers: readonly CodexManagedMarker[]) {
    const locations = markers.length === 0
      ? "none"
      : markers.map((marker) => `${marker.token} (line ${marker.line})`).join(", ");
    super(
      `Ambiguous OMS managed MCP markers in ${configPath}: ${locations}. `
      + "No changes were made. Manually remove every OMS managed MCP block and its markers, then rerun oms install or uninstall.",
    );
    this.name = "CodexManagedBlockAmbiguousError";
  }
}

function scanCodexManagedMarkers(content: string): CodexManagedMarker[] {
  const markers: CodexManagedMarker[] = [];
  let offset = 0;
  let line = 1;
  for (const sourceLine of content.split(/(?<=\n)/)) {
    const lineContent = sourceLine.replace(/\r?\n$/, "");
    let position = 0;
    while (position < sourceLine.length) {
      const start = sourceLine.indexOf(MANAGED_CODEX_START, position);
      const end = sourceLine.indexOf(MANAGED_CODEX_END, position);
      if (start === -1 && end === -1) break;
      const isStart = start !== -1 && (end === -1 || start < end);
      const token = isStart ? MANAGED_CODEX_START : MANAGED_CODEX_END;
      const tokenOffset = isStart ? start : end;
      markers.push({
        token,
        line,
        lineStart: offset,
        offset: offset + tokenOffset,
        valid: lineContent === `${sourceLine.slice(0, tokenOffset)}${token}`
          && /^[ \t]*$/.test(sourceLine.slice(0, tokenOffset)),
      });
      position = tokenOffset + token.length;
    }
    offset += sourceLine.length;
    line++;
  }
  return markers;
}

function managedCodexBlock(content: string, configPath: string): ManagedCodexBlock | undefined {
  const markers = scanCodexManagedMarkers(content);
  if (markers.length === 0) return undefined;
  if (
    markers.length !== 2
    || markers.some((marker) => !marker.valid)
    || markers[0]?.token !== MANAGED_CODEX_START
    || markers[1]?.token !== MANAGED_CODEX_END
  ) {
    throw new CodexManagedBlockAmbiguousError(configPath, markers);
  }
  const start = markers[0];
  const end = markers[1];
  if (
    start === undefined
    || end === undefined
    || start.offset >= end.offset
    || start.line >= end.line
  ) {
    throw new CodexManagedBlockAmbiguousError(configPath, markers);
  }

  let blockEnd = end.offset + MANAGED_CODEX_END.length;
  if (content.slice(blockEnd, blockEnd + 2) === "\r\n") blockEnd += 2;
  else if (content[blockEnd] === "\n") blockEnd++;
  return { start: start.lineStart, end: blockEnd };
}

function removeManagedCodexBlock(
  content: string,
  configPath: string,
): { content: string; removed: boolean; block: ManagedCodexBlock | undefined } {
  const block = managedCodexBlock(content, configPath);
  if (block !== undefined) {
    return {
      content: `${content.slice(0, block.start)}${content.slice(block.end)}`,
      removed: true,
      block,
    };
  }
  return {
    content,
    removed: false,
    block: undefined,
  };
}


type ReviewerNodeKind = "absent" | "symlink" | "file" | "directory" | "other";
type InspectionMode = "install" | "preserve";
type RoleInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "foreign" }
  | { readonly kind: "file"; readonly bytes: Buffer };
type ProvenanceInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "foreign" }
  | { readonly kind: "file"; readonly provenance: OmsInstallProvenance | null };
type ReviewerPaths = {
  readonly agentsDir: string;
  readonly rolePath: string;
  readonly provenancePath: string;
};
type ReviewerCommit = {
  readonly rolePath: string;
  readonly provenancePath: string;
  readonly roleBytes: Buffer | null;
  readonly provenanceBytes: Buffer | null;
};
type ReviewerRemoval = {
  readonly rolePath: string;
  readonly provenancePath: string;
  readonly removeRole: boolean;
  readonly removeProvenance: boolean;
  readonly leftUnowned: string | null;
};

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function classifyNode(target: string): ReviewerNodeKind {
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return "absent";
    throw error;
  }
}

function reviewerPaths(codexDir: string): ReviewerPaths {
  const agentsDir = path.join(codexDir, "agents");
  return {
    agentsDir,
    rolePath: path.join(agentsDir, CODEX_REVIEWER_FILENAME),
    provenancePath: path.join(agentsDir, CODEX_REVIEWER_PROVENANCE_FILENAME),
  };
}

async function atomicWrite(file: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.oms-${process.pid}-${Date.now()}`);
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function codexPackageVersion(): Promise<string> {
  const metadata = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string" || metadata.version.trim() === "") {
    throw new Error("Codex reviewer source package version is invalid");
  }
  return metadata.version;
}

async function loadShippedReviewer(packageRoot: string): Promise<{ readonly bytes: Buffer; readonly digest: string }> {
  const directory = path.join(packageRoot, "assets", "codex", "agents");
  const file = path.join(directory, CODEX_REVIEWER_FILENAME);
  if (classifyNode(file) !== "file") throw new Error(`Codex reviewer source is missing: ${file}`);
  if (path.relative(directory, file) !== CODEX_REVIEWER_FILENAME) {
    throw new Error(`Codex reviewer source path must be ${CODEX_REVIEWER_FILENAME}`);
  }
  const bytes = await readFile(file);
  return { bytes, digest: digestOneFile(CODEX_REVIEWER_FILENAME, bytes) };
}

async function tryShippedReviewerDigest(adapterRoot: string | undefined): Promise<string | null> {
  if (typeof adapterRoot !== "string" || adapterRoot.trim() === "") return null;
  try {
    const packageRoot = resolveHostAdapterSource(adapterRoot, hostSurfaceForRuntime("codex"));
    return (await loadShippedReviewer(packageRoot)).digest;
  } catch (error) {
    if (error instanceof InstallTargetSymlinkError) return null;
    if (error instanceof Error && (error.name === "HostAdapterSourceError" || error.message.startsWith("Codex reviewer source"))) {
      return null;
    }
    throw error;
  }
}

function assertAgentsDirectory(agentsDir: string): void {
  const kind = classifyNode(agentsDir);
  if (kind === "absent") return;
  if (kind === "symlink") throw new InstallTargetSymlinkError(agentsDir);
  if (kind !== "directory") {
    throw new Error(`Refusing to replace unowned Codex custom agent ${agentsDir}: destination is not a directory.`);
  }
}

async function inspectRoleFile(file: string, mode: InspectionMode): Promise<RoleInspection> {
  const kind = classifyNode(file);
  if (kind === "absent") return { kind: "absent" };
  if (kind === "symlink") {
    if (mode === "install") throw new InstallTargetSymlinkError(file);
    return { kind: "foreign" };
  }
  if (kind !== "file") {
    if (mode === "install") {
      throw new Error(`Refusing to replace unowned Codex custom agent ${file}: destination is not a regular file.`);
    }
    return { kind: "foreign" };
  }
  return { kind: "file", bytes: await readFile(file) };
}

async function inspectProvenance(file: string, mode: InspectionMode): Promise<ProvenanceInspection> {
  const kind = classifyNode(file);
  if (kind === "absent") return { kind: "absent" };
  if (kind === "symlink") {
    if (mode === "install") throw new InstallTargetSymlinkError(file);
    return { kind: "foreign" };
  }
  if (kind !== "file") {
    if (mode === "install") {
      throw new Error(`Refusing to replace unowned Codex custom agent ${file}: destination is not a regular file.`);
    }
    return { kind: "foreign" };
  }
  return { kind: "file", provenance: parseProvenance(await readFile(file, "utf8")) };
}

function reviewerProvenanceBytes(version: string, digest: string): Buffer {
  return Buffer.from(serializeProvenance({
    schemaVersion: 1,
    source: "npm",
    version,
    skillTreeDigest: digest,
    installedAt: new Date().toISOString(),
  }), "utf8");
}

/**
 * Plans the optional custom-agent file. Codex is not spawned and custom-agent
 * discovery is not required; a generic separate subagent remains valid.
 */
async function planCodexReviewerInstall(packageRoot: string, codexDir: string): Promise<ReviewerCommit> {
  const destination = reviewerPaths(codexDir);
  assertAgentsDirectory(destination.agentsDir);
  const role = await inspectRoleFile(destination.rolePath, "install");
  const provenance = await inspectProvenance(destination.provenancePath, "install");
  if (provenance.kind === "file" && provenance.provenance === null) {
    throw new Error(`Refusing to replace Codex custom agent ${destination.rolePath}: the provenance record is not valid npm provenance.`);
  }
  const shipped = await loadShippedReviewer(packageRoot);
  const version = await codexPackageVersion();
  const ownership = decideOwnership(
    provenance.kind === "file" ? provenance.provenance : null,
    { version, skillTreeDigest: shipped.digest },
    role.kind === "file" ? digestOneFile(CODEX_REVIEWER_FILENAME, role.bytes) : null,
  );
  const provenanceBytes = reviewerProvenanceBytes(version, shipped.digest);
  switch (ownership.action) {
    case "reject-foreign":
      throw new Error(`Refusing to replace unowned Codex custom agent ${destination.rolePath}: ${ownership.reason}`);
    case "reject-newer":
      throw new Error(`Refusing to replace Codex custom agent ${destination.rolePath}: ${ownership.reason}`);
    case "noop":
      return { rolePath: destination.rolePath, provenancePath: destination.provenancePath, roleBytes: null, provenanceBytes: null };
    case "adopt-legacy-candidate":
      return { rolePath: destination.rolePath, provenancePath: destination.provenancePath, roleBytes: null, provenanceBytes };
    case "install":
    case "replace":
      return {
        rolePath: destination.rolePath,
        provenancePath: destination.provenancePath,
        roleBytes: shipped.bytes,
        provenanceBytes,
      };
    default: {
      const unexpected: never = ownership.action;
      throw new Error(`Unexpected Codex reviewer ownership decision: ${String(unexpected)}`);
    }
  }
}

async function commitCodexReviewerInstall(commit: ReviewerCommit): Promise<void> {
  if (commit.roleBytes !== null) await atomicWrite(commit.rolePath, commit.roleBytes);
  if (commit.provenanceBytes !== null) await atomicWrite(commit.provenancePath, commit.provenanceBytes);
}

async function planCodexReviewerRemoval(options: HostOperationOptions, codexDir: string): Promise<ReviewerRemoval> {
  const destination = reviewerPaths(codexDir);
  const none: ReviewerRemoval = {
    rolePath: destination.rolePath,
    provenancePath: destination.provenancePath,
    removeRole: false,
    removeProvenance: false,
    leftUnowned: null,
  };
  const parent = classifyNode(destination.agentsDir);
  if (parent !== "absent" && parent !== "directory") {
    return { ...none, leftUnowned: parent === "symlink" ? destination.rolePath : null };
  }
  const role = await inspectRoleFile(destination.rolePath, "preserve");
  const provenance = await inspectProvenance(destination.provenancePath, "preserve");
  if (role.kind === "foreign" || provenance.kind === "foreign") {
    return { ...none, leftUnowned: role.kind === "foreign" ? destination.rolePath : destination.provenancePath };
  }
  if (role.kind === "absent" && provenance.kind === "absent") return none;
  if (role.kind === "absent" && provenance.kind === "file") {
    return provenance.provenance !== null
      ? { ...none, removeProvenance: true }
      : { ...none, leftUnowned: destination.provenancePath };
  }
  if (role.kind !== "file") return none;
  const digest = digestOneFile(CODEX_REVIEWER_FILENAME, role.bytes);
  if (provenance.kind === "file" && provenance.provenance !== null && digest === provenance.provenance.skillTreeDigest) {
    return { ...none, removeRole: true, removeProvenance: true };
  }
  if (provenance.kind === "absent") {
    const expected = await tryShippedReviewerDigest(options.adapterRoot);
    if (expected !== null && digest === expected) return { ...none, removeRole: true };
  }
  return { ...none, leftUnowned: destination.rolePath };
}

async function installCodexNativeArtifacts(
  codexDir: string,
  packageRoot: string,
  skillsSource: string,
): Promise<string[]> {
  const paths: string[] = [];
  const rulesSource = path.join(packageRoot, "assets", "codex", "rules", CODEX_RULE_FILENAME);
  const rulesTarget = path.join(codexDir, "rules", CODEX_RULE_FILENAME);
  const skillsTargetRoot = path.join(codexDir, "skills");

  await mkdir(path.dirname(rulesTarget), { recursive: true });
  await cp(rulesSource, rulesTarget);
  await mkdir(skillsTargetRoot, { recursive: true });
  const entries = await readdir(skillsSource, { withFileTypes: true });
  const desired = new Set(
    entries.filter((entry) => entry.isDirectory()).map((entry) => `${CODEX_SKILL_PREFIX}${entry.name}`),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(skillsTargetRoot, `${CODEX_SKILL_PREFIX}${entry.name}`);
    await replaceDirectory(path.join(skillsSource, entry.name), target, false);
    paths.push(target);
  }
  const installed = await readdir(skillsTargetRoot, { withFileTypes: true });
  for (const entry of installed) {
    if (entry.isDirectory() && entry.name.startsWith(CODEX_SKILL_PREFIX) && !desired.has(entry.name)) {
      await rm(path.join(skillsTargetRoot, entry.name), { recursive: true, force: true });
    }
  }
  return [rulesTarget, ...paths];
}

/** Codex install uses native file copies for its rules and skills. */
export async function installCodex(options: HostOperationOptions, host: HarnessHostSurface): Promise<HostOperationResult> {
  const codexDir = hostHome(options.homeDir, ".codex", "OMS_CODEX_HOME");
  const packageRoot = resolveHostAdapterSource(options.adapterRoot, host);
  const skillsSource = resolveSharedSkillsSource(packageRoot);
  const guidanceSource = path.join(packageRoot, "assets", "codex", "AGENTS.md");
  const guidanceTarget = path.join(codexDir, "plugins", "oms", "AGENTS.md");
  const configPath = path.join(codexDir, "config.toml");
  const original = existsSync(configPath) ? await readFile(configPath, "utf-8") : "";
  const removed = removeManagedCodexBlock(original, configPath);
  if (removed.block === undefined && original.split(/\r?\n/).some(line => isCodexOMSTable(line.trim()))) {
    throw new Error(`Refusing to replace unowned mcp_servers.oms in ${configPath}`);
  }
  const reviewer = await planCodexReviewerInstall(packageRoot, codexDir);
  const next = removed.block === undefined
    ? `${removed.content.trimEnd()}\n\n${codexManagedBlockForVault(options.vault)}`
    : `${original.slice(0, removed.block.start)}${codexManagedBlockForVault(options.vault)}${original.slice(removed.block.end)}`;
  let nativePaths: string[] = [];
  if (!options.dryRun) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, next, "utf-8");
    await rm(path.dirname(guidanceTarget), { recursive: true, force: true });
    await mkdir(path.dirname(guidanceTarget), { recursive: true });
    await cp(guidanceSource, guidanceTarget);
    nativePaths = await installCodexNativeArtifacts(codexDir, packageRoot, skillsSource);
    await commitCodexReviewerInstall(reviewer);
  } else {
    nativePaths = [
      path.join(codexDir, "rules", CODEX_RULE_FILENAME),
      ...host.skillDirs.map((skill) => path.join(codexDir, "skills", `${CODEX_SKILL_PREFIX}${skill}`)),
    ];
  }
  return {
    runtime: "codex",
    action: "install",
    changed: !options.dryRun,
    skipped: false,
    paths: [configPath, guidanceTarget, ...nativePaths, reviewer.rolePath, reviewer.provenancePath],
    commands: [`Codex MCP config: ${configPath}`],
    messages: [
      "Installed Codex-native Oh My Second Brain rules, namespaced skills, and managed MCP/env config.",
      "Installed the optional oms-reviewer custom-agent role definition. Custom-agent discovery is not required; a generic separate subagent remains valid.",
    ],
  };
}

export async function uninstallCodex(options: HostOperationOptions): Promise<HostOperationResult> {
  const codexDir = hostHome(options.homeDir, ".codex", "OMS_CODEX_HOME");
  const pluginTarget = path.join(codexDir, "plugins", "oms");
  const configPath = path.join(codexDir, "config.toml");
  const ruleTarget = path.join(codexDir, "rules", CODEX_RULE_FILENAME);
  const skillsRoot = path.join(codexDir, "skills");
  let changed = false;
  if (existsSync(configPath)) {
    const original = await readFile(configPath, "utf-8");
    const removed = removeManagedCodexBlock(original, configPath);
    changed = removed.removed;
    if (removed.removed && !options.dryRun) await writeFile(configPath, removed.content, "utf-8");
  }
  for (const target of [pluginTarget, ruleTarget]) {
    if (existsSync(target)) {
      changed = true;
      if (!options.dryRun) await rm(target, { recursive: true, force: true });
    }
  }
  if (existsSync(skillsRoot)) {
    for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(CODEX_SKILL_PREFIX)) {
        changed = true;
        if (!options.dryRun) await rm(path.join(skillsRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
  const reviewer = await planCodexReviewerRemoval(options, codexDir);
  if (reviewer.removeRole || reviewer.removeProvenance) {
    changed = true;
    if (!options.dryRun) {
      if (reviewer.removeRole) await rm(reviewer.rolePath, { force: true });
      if (reviewer.removeProvenance) await rm(reviewer.provenancePath, { force: true });
    }
  }
  const messages = ["Removed Codex managed MCP block, Oh My Second Brain rule, namespaced Oh My Second Brain skills, and plugin assets."];
  if (reviewer.removeRole) messages.push("Removed the owned oms-reviewer custom-agent role.");
  if (reviewer.removeProvenance) messages.push("Removed the owned oms-reviewer provenance record.");
  if (reviewer.leftUnowned !== null) messages.push(`Left unowned Codex custom agent in place: ${reviewer.leftUnowned}`);
  return {
    runtime: "codex",
    action: "uninstall",
    changed: changed && !options.dryRun,
    skipped: !changed,
    paths: [configPath, pluginTarget, ruleTarget, path.join(skillsRoot, `${CODEX_SKILL_PREFIX}*`), reviewer.rolePath, reviewer.provenancePath],
    commands: [],
    messages,
  };
}

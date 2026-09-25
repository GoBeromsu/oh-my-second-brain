import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessSurfaceRegistry } from "../kernel/harness/surface-registry.js";
import type { InstalledAssetDeclaration, InstalledAssetState, InstalledHostDeclaration } from "../kernel/install/asset-health.js";
import { hostHome } from "../kernel/install/common.js";
import { HOOK_MATCHER, READ_MATCHER, isCodexOmsRegistration, isHermesOmsRegistration, isOmsHookEntry } from "./host-commands.js";

type PathEvidence = "present" | "absent" | "error";

const CODEX_SKILL_PREFIX = "oms-";

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message : String(error);
}

async function pathEvidence(candidate: string): Promise<{ readonly state: PathEvidence; readonly cause: string | null }> {
  try {
    await lstat(candidate);
    return { state: "present", cause: null };
  } catch (error) {
    const cause = errorCode(error);
    return (cause === "ENOENT" || cause === "ENOTDIR") ? { state: "absent", cause: null } : { state: "error", cause };
  }
}

function codexSurface() {
  const host = harnessSurfaceRegistry.hosts.find(candidate => candidate.runtime === "codex");
  if (host === undefined) throw new Error("Codex host surface is not registered");
  return host;
}

function codexSkillPaths(home: string): readonly string[] {
  return codexSurface().skillDirs.map(skill => path.join(home, "skills", `${CODEX_SKILL_PREFIX}${skill}`));
}

function hostDir(runtime: string): string {
  const variable = `OMS_${runtime.toUpperCase()}_HOME`;
  return hostHome(undefined, `.${runtime}`, variable);
}

function packageRoot(): string {
  return path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
}

function claudeRegistration(settings: unknown): { readonly installed: boolean; readonly complete: boolean } {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return { installed: false, complete: false };
  const hooks = (settings as Record<string, unknown>)["hooks"];
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return { installed: false, complete: false };
  const events = hooks as Record<string, unknown>;
  const pre = Array.isArray(events["PreToolUse"]) ? events["PreToolUse"] : [];
  const owned = (matcher: string): boolean => pre.some(entry => {
    if (!isOmsHookEntry(entry)) return false;
    const record = entry as { readonly matcher: string; readonly hooks: readonly { readonly command: string }[] };
    return record.matcher === matcher && / oms-guard$/.test(record.hooks[0]?.command ?? "");
  });
  const installed = Object.values(events).some(entries => Array.isArray(entries) && entries.some(entry => isOmsHookEntry(entry)));
  return { installed, complete: owned(HOOK_MATCHER) && owned(READ_MATCHER) };
}

async function probeClaude(root: string): Promise<{ readonly host: InstalledHostDeclaration; readonly assets: readonly InstalledAssetDeclaration[] }> {
  const settingsPath = path.join(hostDir("claude"), "settings.json");
  let registration: { readonly installed: boolean; readonly complete: boolean } | null = null;
  let failure: string | null = null;
  try {
    registration = claudeRegistration(JSON.parse(await readFile(settingsPath, "utf8")) as unknown);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") failure = errorCode(error);
  }
  const hooks = harnessSurfaceRegistry.hooks.filter(hook => hook.runtime === "claude");
  const binaryDirectories = process.env.PATH?.split(path.delimiter) ?? [root];
  const binaries = await Promise.all(hooks.map(async (hook) => {
    const candidates = binaryDirectories.map(directory => path.join(directory, hook.bin));
    const evidence = await Promise.all(candidates.map(pathEvidence));
    const index = evidence.findIndex(item => item.state === "present");
    return { hook, path: candidates[index < 0 ? 0 : index] ?? path.join(root, hook.bin), evidence };
  }));
  const binaryPresent = binaries.some(item => item.evidence.some(evidence => evidence.state === "present"));
  if (failure !== null) {
    return {
      host: { host: "claude", state: "degraded" },
      assets: [{ id: "registration:claude", kind: "registration", declaredPath: settingsPath, host: "claude", evidence: { state: "inspection-error", cause: failure } }],
    };
  }
  if (registration === null && !binaryPresent) return { host: { host: "claude", state: "not-installed" }, assets: [] };
  return {
    host: { host: "claude", state: "ok" },
    assets: [
      { id: "registration:claude", kind: "registration", declaredPath: settingsPath, host: "claude", evidence: { state: registration?.complete === true ? "ok" : "missing", cause: null } },
      ...binaries.flatMap(({ hook, path: binary }) => [
        { id: `hook:${hook.bin}`, kind: "hook" as const, declaredPath: path.join(root, hook.path), host: "claude" },
        { id: `binary:${hook.bin}`, kind: "binary" as const, declaredPath: binary, host: "claude" },
      ]),
    ],
  };
}

async function registrationEvidence(runtime: "codex" | "hermes", configPath: string): Promise<{ readonly state: InstalledAssetState; readonly cause: string | null }> {
  try {
    const raw = await readFile(configPath, "utf8");
    const valid = runtime === "codex" ? isCodexOmsRegistration(raw, configPath) : isHermesOmsRegistration(raw);
    return { state: valid ? "ok" : "missing", cause: null };
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { state: "missing", cause: null }
      : { state: "inspection-error", cause: errorCode(error) };
  }
}

async function probeNative(runtime: "codex" | "hermes"): Promise<{ readonly host: InstalledHostDeclaration; readonly assets: readonly InstalledAssetDeclaration[] }> {
  const home = hostDir(runtime);
  const configPath = path.join(home, runtime === "codex" ? "config.toml" : "config.yaml");
  const metadata = JSON.parse(await readFile(path.join(packageRoot(), "package.json"), "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string") throw new Error("OMS package version is invalid");
  const provenanceVersion = metadata.version;
  const candidates = runtime === "codex"
    ? [path.join(home, "plugins", "oms"), path.join(home, "rules", "oms.md"), ...codexSkillPaths(home)]
    : [path.join(home, "skills", "knowledge-management", "oms"), path.join(home, "adapters", "oms", "oms-provenance.json")];
  const evidence = await Promise.all(candidates.map(pathEvidence));
  const registration = await registrationEvidence(runtime, configPath);
  if (evidence.some(item => item.state === "error")) {
    return { host: { host: runtime, state: "degraded" }, assets: [{ id: `discovery:${runtime}`, kind: "registration", declaredPath: home, host: runtime, evidence: { state: "inspection-error", cause: evidence.find(item => item.state === "error")?.cause ?? null } }] };
  }
  if (!evidence.some(item => item.state === "present") && registration.state === "missing") return { host: { host: runtime, state: "not-installed" }, assets: [] };
  const assets: InstalledAssetDeclaration[] = [
    { id: `registration:${runtime}`, kind: "registration", declaredPath: configPath, host: runtime, evidence: registration },
    ...candidates.map((declaredPath, index) => ({
      id: `${runtime}:${index}`,
      kind: runtime === "hermes" && index === 0 ? "skill-tree" as const : "registration" as const,
      declaredPath,
      host: runtime,
      ...(runtime === "hermes" && index === 0
        ? {
            provenancePath: path.join(home, "adapters", "oms", "oms-provenance.json"),
            provenanceVersion,
          }
        : {}),
      evidence: { state: evidence[index]?.state === "present" ? "ok" as const : "missing" as const, cause: null },
    })),
  ];
  // Not a presence candidate: a missing optional role must not hide Codex or the generic subagent.
  return { host: { host: runtime, state: registration.state === "inspection-error" ? "degraded" : "ok" }, assets };
}

export async function discoverHostInstallAssets(): Promise<{ readonly hosts: readonly InstalledHostDeclaration[]; readonly assets: readonly InstalledAssetDeclaration[] }> {
  const root = packageRoot();
  const probes = await Promise.all(harnessSurfaceRegistry.hosts.map((host) => host.runtime === "claude" ? probeClaude(root) : probeNative(host.runtime)));
  return { hosts: probes.map(probe => probe.host), assets: probes.flatMap(probe => probe.assets) };
}

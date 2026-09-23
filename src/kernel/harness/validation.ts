import {
  HARNESS_CLI_COMMANDS,
  HARNESS_HOST_REVIEWERS,
  HARNESS_MCP_TOOLS,
  HARNESS_SHARED_SKILLS,
  HARNESS_WRITE_HOOK,
  type HarnessHostRuntime,
  type HarnessPosture,
  type HarnessStability,
  type HarnessSurfaceOwner,
  type HarnessSurfaceRegistry,
} from "./surface-registry.js";
import { posix as pathPosix } from "node:path";

export type HarnessRegistryViolationCode =
  | "duplicate_name"
  | "duplicate_path"
  | "forbidden_path"
  | "invalid_host"
  | "invalid_owner"
  | "invalid_posture"
  | "invalid_stability"
  | "invalid_write_hook"
  | "missing_owner"
  | "missing_path"
  | "missing_runtime"
  | "missing_surface"
  | "unregistered_surface";

export interface HarnessRegistryViolation {
  readonly code: HarnessRegistryViolationCode;
  readonly surface: string;
  readonly message: string;
  readonly value?: string;
}

const OWNERS: readonly HarnessSurfaceOwner[] = [
  "core",
  "cli",
  "mcp",
  "retrieval",
  "capture",
  "semantic-engine",
  "install",
  "hook",
  "runtime",
  "release",
];
const HOSTS: readonly HarnessHostRuntime[] = ["claude", "codex", "hermes"];
const POSTURES: readonly HarnessPosture[] = ["read", "write"];
const STABILITIES: readonly HarnessStability[] = ["stable", "experimental", "compatibility"];
/**
 * Directory prefixes a shipped package path may live under.
 *
 * `assets/` holds all vendor runtime assets, including the single authored
 * skill source and host-specific guidance, hooks, and rules.
 *
 */
const PACKAGE_PATH_PREFIXES = [
  "assets/",
  "core/",
  "dist/",
  "docs/",
  "scripts/",
] as const;

const SKILLS_PREFIX = "skills/";

/**
 * Root-level files and directories that ship whole.
 *
 * The vendor plugin roots sit at the repository root because a host resolves a
 * manifest's `skills` pointer relative to the manifest, and only a root-level
 * manifest can reference `./assets/skills/` without climbing out of its own
 * plugin root. `agents/` ships the owned Claude reviewer definition.
 */
const PACKAGE_ROOT_ENTRIES = [
  ".claude-plugin",
  ".codex-plugin",
  ".mcp.json",
  ".mcp.codex.json",
  "agents",
  "package.json",
] as const;

/**
 * Root-level documents that legitimately ship.
 *
 * Changelogs are release history a consumer can read; ACKNOWLEDGMENTS carries
 * the upstream credits the licence section points at, so shipping the licence
 * note without it would leave a dangling reference in the published artifact.
 * Contributor-only documents deliberately do NOT belong here.
 */
const PACKAGE_ROOT_DOCUMENT = /^(?:CHANGELOG(?:-[a-z]+)?|ACKNOWLEDGMENTS)\.md$/;

function includesValue<const T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function pushDuplicateViolations(
  violations: HarnessRegistryViolation[],
  surface: string,
  values: readonly string[],
  code: "duplicate_name" | "duplicate_path",
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      continue;
    }
    if (reported.has(value)) continue;
    reported.add(value);
    violations.push({
      code,
      surface,
      value,
      message: `${surface} contains duplicate ${code === "duplicate_name" ? "name" : "path"}: ${value}`,
    });
  }
}

function validateClosedSet(
  violations: HarnessRegistryViolation[],
  surface: string,
  declared: readonly string[],
  required: readonly string[],
): void {
  const requiredSet = new Set(required);
  const declaredSet = new Set(declared);
  for (const value of requiredSet) {
    if (declaredSet.has(value)) continue;
    violations.push({
      code: "missing_surface",
      surface,
      value,
      message: `${surface} is missing registered surface: ${value}`,
    });
  }
  for (const value of declaredSet) {
    if (requiredSet.has(value)) continue;
    violations.push({
      code: "unregistered_surface",
      surface,
      value,
      message: `${surface} declares unregistered surface: ${value}`,
    });
  }
}

function validateOwner(
  violations: HarnessRegistryViolation[],
  surface: string,
  owner: unknown,
): void {
  if (owner === undefined || owner === null || owner === "") {
    violations.push({ code: "missing_owner", surface, message: `${surface} is missing owner metadata.` });
    return;
  }
  if (!includesValue(OWNERS, owner)) {
    violations.push({
      code: "invalid_owner",
      surface,
      value: String(owner),
      message: `${surface} has invalid owner: ${String(owner)}`,
    });
  }
}

function validateStability(
  violations: HarnessRegistryViolation[],
  surface: string,
  stability: unknown,
): void {
  if (!includesValue(STABILITIES, stability)) {
    violations.push({
      code: "invalid_stability",
      surface,
      value: String(stability),
      message: `${surface} has invalid stability: ${String(stability)}`,
    });
  }
}

/**
 * `adapterDir` names where a host's plugin manifest lives, which since the
 * vendor topology move is decoupled from where its skills live. Claude and
 * Codex read repo-root manifests, so `"."` is a legal and expected value here
 * even though it is an unsafe segment in an ordinary package path.
 *
 * The legal set mirrors `resolveHostAdapterSource`'s allowlist exactly. Keeping
 * it exhaustive rather than a prefix rule means there is no traversal to defend
 * against: two literals cannot be escaped from.
 */
const LEGAL_ADAPTER_DIRS = [".", "assets"] as const;

function validateAdapterDir(
  violations: HarnessRegistryViolation[],
  surface: string,
  adapterDir: unknown,
): void {
  if (typeof adapterDir !== "string" || adapterDir.length === 0) {
    violations.push({ code: "missing_path", surface, message: `${surface} is missing a path.` });
    return;
  }

  if (!LEGAL_ADAPTER_DIRS.some((legal) => legal === adapterDir)) {
    violations.push({
      code: "forbidden_path",
      surface,
      value: adapterDir,
      message: `${surface} must be one of ${LEGAL_ADAPTER_DIRS.join(", ")}: ${adapterDir}`,
    });
  }
}

function validatePackagePath(
  violations: HarnessRegistryViolation[],
  surface: string,
  path: unknown,
): void {
  if (typeof path !== "string" || path.length === 0) {
    violations.push({ code: "missing_path", surface, message: `${surface} is missing a path.` });
    return;
  }

  const pathSegments = path.split("/");
  const hasUnsafeSegment = pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..");
  if (pathPosix.isAbsolute(path) || path.includes("\\") || hasUnsafeSegment) {
    violations.push({
      code: "forbidden_path",
      surface,
      value: path,
      message: `${surface} contains an unsafe package path: ${path}`,
    });
    return;
  }

  const normalizedPath = pathPosix.normalize(path);
  if (normalizedPath === "package.json") return;
  // `core/AGENTS.md` is the separately-owned vault-convention SSOT. It must SHIP
  // - dropping it from the package silently removes an authoritative document -
  // but nothing may treat it as a runtime asset or a release-verified artifact.
  // So it is legal in npmFiles and rejected on every other surface.
  if (normalizedPath === "core/AGENTS.md" && surface.startsWith("packageAssets.npmFiles")) return;
  if (normalizedPath === "core/AGENTS.md" || normalizedPath.startsWith("src/")) {
    violations.push({
      code: "forbidden_path",
      surface,
      value: path,
      message: `${surface} points at a source or protected convention file: ${path}`,
    });
    return;
  }
  const underPrefix = PACKAGE_PATH_PREFIXES.some(
    (prefix) => normalizedPath === prefix.slice(0, -1) || normalizedPath.startsWith(prefix),
  ) || (
    (surface.startsWith("packageAssets.npmFiles.") || surface.startsWith("packageAssets.releaseRequiredPaths."))
    && (normalizedPath === SKILLS_PREFIX.slice(0, -1) || normalizedPath.startsWith(SKILLS_PREFIX))
  );
  const underRootEntry = PACKAGE_ROOT_ENTRIES.some(
    (entry) => normalizedPath === entry || normalizedPath.startsWith(`${entry}/`),
  );
  const isRootDocument = PACKAGE_ROOT_DOCUMENT.test(normalizedPath);

  if (!underPrefix && !underRootEntry && !isRootDocument) {
    violations.push({
      code: "forbidden_path",
      surface,
      value: path,
      message: `${surface} points outside shipped package surfaces: ${path}`,
    });
  }
}

function validateRootShippedFile(
  violations: HarnessRegistryViolation[],
  surface: string,
  fileName: unknown,
): void {
  if (typeof fileName !== "string" || fileName.length === 0) {
    violations.push({ code: "missing_path", surface, message: `${surface} is missing a file name.` });
    return;
  }

  if (fileName.includes("/") || fileName.includes("\\") || fileName === ".." || fileName === ".") {
    violations.push({
      code: "forbidden_path",
      surface,
      value: fileName,
      message: `${surface} contains an unsafe root file name: ${fileName}`,
    });
    return;
  }
}

function validateRuntime(
  violations: HarnessRegistryViolation[],
  surface: string,
  runtime: unknown,
): void {
  if (runtime === undefined || runtime === null || runtime === "") {
    violations.push({ code: "missing_runtime", surface, message: `${surface} is missing runtime metadata.` });
    return;
  }
  if (!includesValue(HOSTS, runtime)) {
    violations.push({
      code: "invalid_host",
      surface,
      value: String(runtime),
      message: `${surface} has invalid runtime: ${String(runtime)}`,
    });
  }
}

function validateWriteHook(
  violations: HarnessRegistryViolation[],
  runtime: string,
  writeHook: unknown,
): void {
  const surface = `hosts.${runtime}.writeHook`;
  if (writeHook === undefined || writeHook === null || writeHook === "") {
    violations.push({
      code: "missing_surface",
      surface,
      message: `${surface} is missing write-hook metadata.`,
    });
    return;
  }
  if (writeHook !== "fail-open" && writeHook !== "none") {
    violations.push({
      code: "invalid_write_hook",
      surface,
      value: String(writeHook),
      message: `${surface} must be fail-open or none: ${String(writeHook)}`,
    });
    return;
  }
  if (!includesValue(HOSTS, runtime)) return;
  const required = HARNESS_WRITE_HOOK[runtime];
  if (writeHook !== required) {
    violations.push({
      code: "invalid_write_hook",
      surface,
      value: writeHook,
      message: `${surface} must be ${required}; a boolean hook guarantee is not a write-hook posture.`,
    });
  }
}

function readReviewerMechanisms(value: unknown): readonly {
  readonly id: string;
  readonly selection: unknown;
  readonly isolation: unknown;
  readonly assetPath: unknown;
}[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((mechanism) => {
    const record = mechanism !== null && typeof mechanism === "object"
      ? mechanism as Record<string, unknown>
      : {};
    return {
      id: typeof record.id === "string" ? record.id : "",
      selection: record.selection,
      isolation: record.isolation,
      assetPath: record.assetPath,
    };
  });
}

function validateHostReviewers(
  violations: HarnessRegistryViolation[],
  runtime: string,
  mechanisms: unknown,
): void {
  const surface = `hosts.${runtime}.reviewerMechanisms`;
  if (!includesValue(HOSTS, runtime)) return;
  const required = HARNESS_HOST_REVIEWERS[runtime];
  const declared = readReviewerMechanisms(mechanisms);
  if (declared === undefined) {
    violations.push({
      code: "missing_surface",
      surface,
      message: `${surface} is missing reviewer mechanisms.`,
    });
    for (const mechanism of required) {
      violations.push({
        code: "missing_surface",
        surface,
        value: mechanism.id,
        message: `${surface} is missing registered surface: ${mechanism.id}`,
      });
    }
    return;
  }

  pushDuplicateViolations(
    violations,
    surface,
    declared.map((mechanism) => mechanism.id).filter((id) => id.length > 0),
    "duplicate_name",
  );
  validateClosedSet(
    violations,
    surface,
    declared.map((mechanism) => mechanism.id),
    required.map((mechanism) => mechanism.id),
  );

  for (const requirement of required) {
    const match = declared.find((mechanism) => mechanism.id === requirement.id);
    if (match === undefined) continue;
    const mechanismSurface = `${surface}.${requirement.id}`;
    if (match.selection !== requirement.selection || match.isolation !== requirement.isolation) {
      violations.push({
        code: "unregistered_surface",
        surface: mechanismSurface,
        value: `${String(match.selection)}/${String(match.isolation)}`,
        message: `${mechanismSurface} is not the registered reviewer mechanism.`,
      });
    }
    if (requirement.assetPath !== undefined) {
      if (match.assetPath !== requirement.assetPath) {
        const declaredAsset = typeof match.assetPath === "string" && match.assetPath.length > 0
          ? match.assetPath
          : undefined;
        violations.push({
          code: declaredAsset === undefined ? "missing_surface" : "unregistered_surface",
          surface: mechanismSurface,
          value: declaredAsset ?? requirement.assetPath,
          message: declaredAsset === undefined
            ? `${mechanismSurface} is missing owned reviewer asset: ${requirement.assetPath}`
            : `${mechanismSurface} declares unregistered reviewer asset: ${declaredAsset}`,
        });
      } else {
        validatePackagePath(violations, mechanismSurface, match.assetPath);
      }
    } else if (match.assetPath !== undefined) {
      violations.push({
        code: "unregistered_surface",
        surface: mechanismSurface,
        value: String(match.assetPath),
        message: `${mechanismSurface} owns no reviewer asset.`,
      });
    }
  }
}

function npmFileCovers(npmFiles: readonly string[], requiredPath: string): boolean {
  if (requiredPath === "package.json") return true;
  return npmFiles.some((root) => requiredPath === root || requiredPath.startsWith(`${root}/`));
}

function validateRegisteredShipPaths(
  violations: HarnessRegistryViolation[],
  registry: HarnessSurfaceRegistry,
): void {
  const requiredPaths: string[] = [];
  for (const skill of HARNESS_SHARED_SKILLS) {
    requiredPaths.push(`assets/skills/${skill}/SKILL.md`, `skills/${skill}/SKILL.md`);
  }
  for (const runtime of HOSTS) {
    for (const mechanism of HARNESS_HOST_REVIEWERS[runtime]) {
      if (mechanism.assetPath !== undefined) requiredPaths.push(mechanism.assetPath);
    }
  }
  for (const requiredPath of requiredPaths) {
    if (registry.packageAssets.releaseRequiredPaths.includes(requiredPath)) continue;
    violations.push({
      code: "missing_surface",
      surface: "packageAssets.releaseRequiredPaths",
      value: requiredPath,
      message: `packageAssets.releaseRequiredPaths is missing registered surface: ${requiredPath}`,
    });
  }
  for (const requiredPath of registry.packageAssets.releaseRequiredPaths) {
    if (npmFileCovers(registry.packageAssets.npmFiles, requiredPath)) continue;
    violations.push({
      code: "missing_surface",
      surface: "packageAssets.npmFiles",
      value: requiredPath,
      message: `packageAssets.npmFiles does not ship registered surface: ${requiredPath}`,
    });
  }
}

export function validateHarnessRegistry(registry: HarnessSurfaceRegistry): HarnessRegistryViolation[] {
  const violations: HarnessRegistryViolation[] = [];

  pushDuplicateViolations(violations, "cliCommands", registry.cliCommands.map((command) => command.name), "duplicate_name");
  validateClosedSet(
    violations,
    "cliCommands",
    registry.cliCommands.map((command) => command.name),
    HARNESS_CLI_COMMANDS.map((command) => command.name),
  );
  for (const command of registry.cliCommands) {
    validateOwner(violations, `cliCommands.${command.name}`, command.owner);
    validateStability(violations, `cliCommands.${command.name}`, command.stability);
  }

  for (const tool of HARNESS_MCP_TOOLS) {
    if (HARNESS_SHARED_SKILLS.some((skill) => skill === tool.name)) continue;
    violations.push({
      code: "unregistered_surface",
      surface: "mcpTools",
      value: tool.name,
      message: `mcpTools.${tool.name} is outside the shared skill set.`,
    });
  }
  pushDuplicateViolations(violations, "mcpTools", registry.mcpTools.map((tool) => tool.name), "duplicate_name");
  validateClosedSet(
    violations,
    "mcpTools",
    registry.mcpTools.map((tool) => tool.name),
    HARNESS_MCP_TOOLS.map((tool) => tool.name),
  );
  for (const tool of registry.mcpTools) {
    validateOwner(violations, `mcpTools.${tool.name}`, tool.owner);
    if (!includesValue(POSTURES, tool.posture)) {
      violations.push({
        code: "invalid_posture",
        surface: `mcpTools.${tool.name}`,
        value: String(tool.posture),
        message: `mcpTools.${tool.name} has invalid posture: ${String(tool.posture)}`,
      });
    }
    validateStability(violations, `mcpTools.${tool.name}`, tool.stability);
  }

  pushDuplicateViolations(violations, "hosts", registry.hosts.map((host) => host.runtime), "duplicate_name");
  validateClosedSet(violations, "hosts", registry.hosts.map((host) => host.runtime), HOSTS);
  for (const host of registry.hosts) {
    validateRuntime(violations, `hosts.${host.runtime}`, host.runtime);
    validateAdapterDir(violations, `hosts.${host.runtime}.adapterDir`, host.adapterDir);
    const skillDirs = Array.isArray(host.skillDirs) ? host.skillDirs : [];
    if (!Array.isArray(host.skillDirs)) {
      violations.push({
        code: "missing_surface",
        surface: `hosts.${host.runtime}.skillDirs`,
        message: `hosts.${host.runtime}.skillDirs is missing shared skills.`,
      });
    }
    pushDuplicateViolations(
      violations,
      `hosts.${host.runtime}.skillDirs`,
      skillDirs.map((skillDir) => `${host.runtime}:${skillDir}`),
      "duplicate_name",
    );
    validateClosedSet(violations, `hosts.${host.runtime}.skillDirs`, skillDirs, HARNESS_SHARED_SKILLS);
    validateWriteHook(violations, host.runtime, host.writeHook);
    validateHostReviewers(violations, host.runtime, host.reviewerMechanisms);
  }

  pushDuplicateViolations(violations, "hooks", registry.hooks.map((hook) => hook.bin), "duplicate_name");
  pushDuplicateViolations(violations, "hooks", registry.hooks.map((hook) => hook.path), "duplicate_path");
  for (const hook of registry.hooks) {
    validateOwner(violations, `hooks.${hook.bin}`, hook.owner);
    validateRuntime(violations, `hooks.${hook.bin}`, hook.runtime);
    validateStability(violations, `hooks.${hook.bin}`, hook.stability);
    validatePackagePath(violations, `hooks.${hook.bin}`, hook.path);
  }

  pushDuplicateViolations(
    violations,
    "packageAssets.npmFiles",
    registry.packageAssets.npmFiles,
    "duplicate_path",
  );
  const rootShippedFilesSet = new Set(registry.packageAssets.rootShippedFiles);
  for (const npmFile of registry.packageAssets.npmFiles) {
    if (!rootShippedFilesSet.has(npmFile)) {
      validatePackagePath(violations, `packageAssets.npmFiles.${npmFile}`, npmFile);
    }
  }
  pushDuplicateViolations(
    violations,
    "packageAssets.runtimeAssetRoots",
    registry.packageAssets.runtimeAssetRoots.map((asset) => asset.id),
    "duplicate_name",
  );
  pushDuplicateViolations(
    violations,
    "packageAssets.runtimeAssetRoots",
    registry.packageAssets.runtimeAssetRoots.map((asset) => asset.path),
    "duplicate_path",
  );
  for (const asset of registry.packageAssets.runtimeAssetRoots) {
    validateOwner(violations, `packageAssets.runtimeAssetRoots.${asset.id}`, asset.owner);
    validatePackagePath(violations, `packageAssets.runtimeAssetRoots.${asset.id}`, asset.path);
  }
  pushDuplicateViolations(
    violations,
    "packageAssets.rootShippedFiles",
    registry.packageAssets.rootShippedFiles,
    "duplicate_path",
  );
  for (const rootFile of registry.packageAssets.rootShippedFiles) {
    validateRootShippedFile(violations, `packageAssets.rootShippedFiles.${rootFile}`, rootFile);
    if (!registry.packageAssets.npmFiles.includes(rootFile)) {
      violations.push({
        code: "missing_path",
        surface: `packageAssets.rootShippedFiles.${rootFile}`,
        message: `${rootFile} declared in rootShippedFiles must also be in npmFiles`,
      });
    }
  }

  pushDuplicateViolations(
    violations,
    "packageAssets.releaseRequiredPaths",
    registry.packageAssets.releaseRequiredPaths,
    "duplicate_path",
  );
  for (const requiredPath of registry.packageAssets.releaseRequiredPaths) {
    validatePackagePath(violations, `packageAssets.releaseRequiredPaths.${requiredPath}`, requiredPath);
  }
  validateRegisteredShipPaths(violations, registry);

  return violations;
}

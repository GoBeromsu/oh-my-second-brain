import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { engineAxisCachePath, engineGraphCachePath, engineNodeCachePath, engineStorePath } from "../../src/kernel/engine/paths.js";
import { makeTracerConfig, resolveVault } from "../../src/kernel/engine/tracer.js";
import { absolute, assertNonVacuous, collectFiles, isProductionTs } from "./repo-root.js";

const OWNER = "src/kernel/engine/paths.ts";
const CACHE_OWNERS = [
  { name: "engineStorePath", filename: "engine-store.sqlite", segments: [] as const },
  { name: "engineGraphCachePath", filename: "graph.json", segments: ["engine"] as const },
  { name: "engineNodeCachePath", filename: "node-index.json", segments: ["engine"] as const },
  { name: "engineAxisCachePath", filename: "axes.sqlite", segments: [] as const },
] as const;
const REQUIRED_CONSUMERS = [
  { file: "src/kernel/engine/assemble.ts", owners: ["engineStorePath"] },
  { file: "src/kernel/engine/embed/sync.ts", owners: ["engineStorePath"] },
  { file: "src/kernel/engine/mcp/facade.ts", owners: ["engineStorePath", "engineGraphCachePath", "engineNodeCachePath"] },
  { file: "src/kernel/engine/tracer.ts", owners: ["engineStorePath", "engineGraphCachePath"] },
  { file: "src/kernel/graph/explore.ts", owners: ["engineGraphCachePath", "engineNodeCachePath"] },
  { file: "src/kernel/doctor/service.ts", owners: ["engineStorePath", "engineGraphCachePath", "engineNodeCachePath"] },
  { file: "src/kernel/engine/axes/store.ts", owners: ["engineAxisCachePath"] },
] as const;

type Violation = {
  readonly file: string;
  readonly reason: string;
};

function isPathsImport(specifier: string): boolean {
  return specifier.endsWith("/paths.js") || specifier === "./paths.js";
}

function ownerUsage(source: string, owner: string): { importsOwner: boolean; callsOwner: boolean } {
  const sourceFile = ts.createSourceFile("store-path.ts", source, ts.ScriptTarget.Latest, true);
  let importsOwner = false;
  let callsOwner = false;

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isPathsImport(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      importsOwner ||= node.importClause.namedBindings.elements.some(
        (element) => element.name.text === owner && element.propertyName === undefined,
      );
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === owner) {
      callsOwner = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { importsOwner, callsOwner };
}

function hasCanonicalConstruction(source: string): boolean {
  const sourceFile = ts.createSourceFile("store-path.ts", source, ts.ScriptTarget.Latest, true);
  let found = false;

  const literalValue = (node: ts.Expression): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return undefined;
  };
  const mentionsArtifact = (text: string): boolean =>
    CACHE_OWNERS.some((owner) => text.includes(`/${owner.filename}`) || text.endsWith(owner.filename) && text.includes(".oms"));

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found ||= mentionsArtifact(node.text);
    } else if (ts.isTemplateExpression(node)) {
      found ||= mentionsArtifact(node.getText(sourceFile));
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "path" || node.expression.expression.text === "join") &&
      (node.expression.name.text === "join" || node.expression.name.text === "resolve")
    ) {
      const parts = node.arguments.map(literalValue);
      found ||= CACHE_OWNERS.some((owner) =>
        parts.includes(".oms") && parts.includes(owner.filename) && owner.segments.every((segment) => parts.includes(segment)),
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function sourceViolations(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  if (file !== OWNER && hasCanonicalConstruction(source)) {
    found.push({ file, reason: "constructs a canonical engine cache path outside its owner" });
  }
  const required = REQUIRED_CONSUMERS.find((consumer) => consumer.file === file);
  if (required !== undefined) {
    for (const owner of required.owners) {
      const usage = ownerUsage(source, owner);
      if (!usage.importsOwner || !usage.callsOwner) {
        found.push({ file, reason: `must import and call ${owner} from the path owner` });
      }
    }
  }
  return found;
}

async function violations(files: readonly string[]): Promise<Violation[]> {
  const found: Violation[] = [];
  for (const file of files) found.push(...sourceViolations(file, await readFile(absolute(file), "utf8")));
  return found;
}

describe("engine store path ownership", () => {
  it("keeps current production consumers on the canonical path owner", async () => {
    const files = await collectFiles("src/kernel", isProductionTs);
    assertNonVacuous(files, "src/kernel production TypeScript");
    expect(files).toEqual(expect.arrayContaining([OWNER, ...REQUIRED_CONSUMERS.map((consumer) => consumer.file)]));
    expect(await violations(files)).toEqual([]);
  });

  it("rejects alternate canonical path constructions", () => {
    const file = "src/kernel/engine/alternate-store-path.ts";
    const source = [
      'import path from "node:path";',
      'const dbPath = path.join(vault, ".oms", "engine-store.sqlite");',
      'const graph = path.join(vault, ".oms", "cache", "engine", "graph.json");',
      'const nodes = path.resolve(vault, ".oms", "cache", "engine", "node-index.json");',
      'const axes = path.resolve(vault, ".oms", "cache", "axes.sqlite");',
      'const alternate = `${vault}/.oms/engine-store.sqlite`;',
    ].join("\n");
    expect(sourceViolations(file, source)).toEqual([
      { file, reason: "constructs a canonical engine cache path outside its owner" },
    ]);
  });

  it("rejects a required consumer missing the owner import or call", async () => {
    const tracer = "src/kernel/engine/tracer.ts";
    const source = await readFile(absolute(tracer), "utf8");
    const mutated = source
      .replace('import { engineGraphCachePath, engineStorePath, vaultCacheRoot } from "./paths.js";\n', 'import { engineStorePath, vaultCacheRoot } from "./paths.js";\n')
      .replace("engineGraphCachePath(vaultPath)", 'path.join(vaultPath, ".oms", "cache", "engine", "graph.json")');
    expect(mutated).not.toBe(source);
    expect(sourceViolations(tracer, mutated)).toEqual([
      { file: tracer, reason: "constructs a canonical engine cache path outside its owner" },
      { file: tracer, reason: "must import and call engineGraphCachePath from the path owner" },
    ]);
  });
  it("ignores comments and explicit override paths that are not default constructions", () => {
    const commented = [
      "export function graphPath(vault: string): string {",
      "  // graph.json stays outside <vault>/.oms/cache/engine.",
      "  return engineGraphCachePath(vault);",
      "}",
    ].join("\n");
    const explicitOverride = [
      "const graphCachePath = config.cacheDir === undefined",
      "  ? engineGraphCachePath(vaultPath)",
      '  : path.join(cacheDir, "engine", "graph.json");',
      'const database = options.dbPath ?? engineStorePath(vault);',
    ].join("\n");
    expect(hasCanonicalConstruction(commented)).toBe(false);
    expect(hasCanonicalConstruction(explicitOverride)).toBe(false);
    expect(sourceViolations("src/kernel/engine/commented-cache.ts", commented)).toEqual([]);
    expect(sourceViolations("src/kernel/engine/override-cache.ts", explicitOverride)).toEqual([]);
  });

  it("rejects each default cache mutation independently", () => {
    const file = "src/kernel/engine/axes/store.ts";
    const source = [
      'import { engineAxisCachePath } from "../paths.js";',
      "export function axisStorePath(vault: string): string {",
      "  return engineAxisCachePath(vault);",
      "}",
    ].join("\n");
    const mutated = source.replace("engineAxisCachePath(vault)", 'path.resolve(vault, ".oms", "cache", "axes.sqlite")');
    expect(mutated).not.toBe(source);
    expect(sourceViolations(file, source)).toEqual([]);
    expect(sourceViolations(file, mutated)).toEqual([
      { file, reason: "constructs a canonical engine cache path outside its owner" },
      { file, reason: "must import and call engineAxisCachePath from the path owner" },
    ]);
  });
  it("rejects graph and node default mutations independently", () => {
    const graph = "src/kernel/engine/mcp/facade.ts";
    const graphSource = [
      'import { engineGraphCachePath, engineNodeCachePath, engineStorePath } from "../paths.js";',
      "function storePath(vault: string): string { return engineStorePath(vault); }",
      "function graphCachePath(vault: string): string { return engineGraphCachePath(vault); }",
      "function nodeCachePath(vault: string): string { return engineNodeCachePath(vault); }",
    ].join("\n");
    const graphMutated = graphSource.replace("engineGraphCachePath(vault)", 'path.join(vault, ".oms", "cache", "engine", "graph.json")');
    const nodeMutated = graphSource.replace("engineNodeCachePath(vault)", 'path.join(vault, ".oms", "cache", "engine", "node-index.json")');
    expect(graphMutated).not.toBe(graphSource);
    expect(nodeMutated).not.toBe(graphSource);
    expect(sourceViolations(graph, graphSource)).toEqual([]);
    expect(sourceViolations(graph, graphMutated)).toEqual([
      { file: graph, reason: "constructs a canonical engine cache path outside its owner" },
      { file: graph, reason: "must import and call engineGraphCachePath from the path owner" },
    ]);
    expect(sourceViolations(graph, nodeMutated)).toEqual([
      { file: graph, reason: "constructs a canonical engine cache path outside its owner" },
      { file: graph, reason: "must import and call engineNodeCachePath from the path owner" },
    ]);
  });

  it("allows explicit injected scratch paths and excludes test sources from production scans", () => {
    const scratchTest = "src/kernel/engine/scratch-store.test.ts";
    expect(hasCanonicalConstruction('const dbPath = "/tmp/engine-store.sqlite";')).toBe(true);
    expect(isProductionTs(scratchTest)).toBe(false);
  });

  it("preserves tracer vault and database override precedence", () => {
    const resolvedVault = resolveVault();
    const explicitVault = "/tmp/explicit-vault";
    const explicitDatabase = "/tmp/explicit-store.sqlite";

    expect(makeTracerConfig()).toMatchObject({
      vaultPath: resolvedVault,
      dbPath: engineStorePath(resolvedVault),
    });
    expect(makeTracerConfig({ vaultPath: explicitVault }).dbPath).toBe(engineStorePath(explicitVault));
    expect(makeTracerConfig({ dbPath: explicitDatabase })).toMatchObject({
      vaultPath: resolvedVault,
      dbPath: explicitDatabase,
    });
    expect(makeTracerConfig({ vaultPath: explicitVault, dbPath: explicitDatabase })).toMatchObject({
      vaultPath: explicitVault,
      dbPath: explicitDatabase,
    });
  });
});

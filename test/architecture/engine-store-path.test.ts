import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { engineStorePath } from "../../src/kernel/engine/paths.js";
import { makeTracerConfig, resolveVault } from "../../src/kernel/engine/tracer.js";
import { absolute, assertNonVacuous, collectFiles, isProductionTs } from "./repo-root.js";

const OWNER = "src/kernel/engine/paths.ts";
const OWNER_IMPORT = "engineStorePath";
const STORE_FILENAME = "engine-store.sqlite";
const REQUIRED_CONSUMERS = [
  "src/kernel/engine/assemble.ts",
  "src/kernel/engine/embed/sync.ts",
  "src/kernel/engine/mcp/facade.ts",
  "src/kernel/engine/tracer.ts",
  "src/kernel/doctor/service.ts",
] as const;

type Violation = {
  readonly file: string;
  readonly reason: string;
};

function isPathsImport(specifier: string): boolean {
  return specifier.endsWith("/paths.js") || specifier === "./paths.js";
}

function ownerUsage(source: string): { importsOwner: boolean; callsOwner: boolean } {
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
        (element) => element.name.text === OWNER_IMPORT && element.propertyName === undefined,
      );
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === OWNER_IMPORT) {
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

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found ||= node.text === STORE_FILENAME || node.text.endsWith(`/${STORE_FILENAME}`);
    } else if (ts.isTemplateExpression(node)) {
      found ||= node.getText(sourceFile).includes(STORE_FILENAME);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "path" &&
      node.expression.name.text === "join"
    ) {
      const parts = node.arguments.map(literalValue);
      found ||= parts.includes(".oms") && parts.includes(STORE_FILENAME);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function sourceViolations(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  if (file !== OWNER && hasCanonicalConstruction(source)) {
    found.push({ file, reason: "constructs the canonical engine store path outside its owner" });
  }
  if (REQUIRED_CONSUMERS.includes(file as (typeof REQUIRED_CONSUMERS)[number])) {
    const usage = ownerUsage(source);
    if (!usage.importsOwner || !usage.callsOwner) {
      found.push({ file, reason: "must import and call engineStorePath from the path owner" });
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
    expect(files).toEqual(expect.arrayContaining([OWNER, ...REQUIRED_CONSUMERS]));
    expect(await violations(files)).toEqual([]);
  });

  it("rejects alternate canonical path constructions", () => {
    const file = "src/kernel/engine/alternate-store-path.ts";
    const source = [
      'import path from "node:path";',
      'const dbPath = path.join(vault, ".oms", "engine-store.sqlite");',
      'const alternate = `${vault}/.oms/engine-store.sqlite`;',
    ].join("\n");
    expect(sourceViolations(file, source)).toEqual([
      { file, reason: "constructs the canonical engine store path outside its owner" },
    ]);
  });

  it("rejects a required consumer missing the owner import or call", async () => {
    const tracer = "src/kernel/engine/tracer.ts";
    const source = await readFile(absolute(tracer), "utf8");
    const mutated = source.replace(
      'import { engineStorePath } from "./paths.js";\n',
      "",
    ).replace("engineStorePath(vaultPath)", 'path.join(vaultPath, ".oms", "engine-store.sqlite")');
    expect(mutated).not.toBe(source);
    expect(sourceViolations(tracer, mutated)).toEqual([
      { file: tracer, reason: "constructs the canonical engine store path outside its owner" },
      { file: tracer, reason: "must import and call engineStorePath from the path owner" },
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

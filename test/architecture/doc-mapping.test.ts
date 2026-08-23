import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checker = resolve(repositoryRoot, "scripts/check-doc-mapping.mjs");
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function runChecker(root: string): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [checker, root], { encoding: "utf8", stdio: "pipe" }),
    };
  } catch (error) {
    const result = error as { status: number; stderr: string; stdout: string };
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }
}

function writePackage(root: string, files?: string[]): void {
  writeFileSync(
    resolve(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", ...(files ? { files } : {}) }),
  );
}

describe("documentation mapping checker", () => {
  it("still checks repository documents that the package does not ship", () => {
    // The regression this pins: deriving the scan set from the npm pack manifest
    // alone silently stopped checking AGENTS.md, CONTRIBUTING.md and most of
    // docs/, because `files` ships only a handful of documents. Earlier fixtures
    // called writePackage without a `files` whitelist, so npm packed everything
    // and the gap was invisible. This fixture uses a realistic restricted list.
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture, ["docs/install.md"]);
    mkdirSync(resolve(fixture, "docs"), { recursive: true });
    writeFileSync(resolve(fixture, "docs", "install.md"), "Shipped and fine.\n");
    // Neither of these ships. Both must still be scanned.
    writeFileSync(resolve(fixture, "AGENTS.md"), "[broken](./nowhere-agents.md)\n");
    writeFileSync(resolve(fixture, "docs", "architecture.md"), "[broken](./nowhere-arch.md)\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("AGENTS.md:1: missing reference ./nowhere-agents.md");
    expect(result.output).toContain("docs/architecture.md:1: missing reference ./nowhere-arch.md");
  });

  it("rejects a shipped document linking to a file the package does not ship", () => {
    // A packed document's links must resolve inside the PACKAGE, not merely
    // inside the checkout. Restricting this check to assets/ once let a packed
    // README link to an unpackaged file and pass because the target existed
    // locally.
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture, ["README.md"]);
    writeFileSync(resolve(fixture, "README.md"), "[credits](./ACKNOWLEDGMENTS.md)\n");
    // Exists in the checkout, absent from the tarball.
    writeFileSync(resolve(fixture, "ACKNOWLEDGMENTS.md"), "Credits.\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("unpackaged reference ./ACKNOWLEDGMENTS.md");
  });

  it("reports a deliberately broken relative reference", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture);
    writeFileSync(resolve(fixture, "CONTRIBUTING.md"), "[broken](./missing.md)\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("CONTRIBUTING.md:1: missing reference ./missing.md");
  });

  it("reports a missing inline source path in a docs markdown file", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture);
    mkdirSync(resolve(fixture, "docs"), { recursive: true });
    writeFileSync(resolve(fixture, "docs", "architecture.md"), "The loader is `src/kernel/missing.ts`.\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("docs/architecture.md:1: missing reference src/kernel/missing.ts");
  });

  it("reports a stale source path in any user-facing documentation file", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture);
    mkdirSync(resolve(fixture, "docs"), { recursive: true });
    writeFileSync(resolve(fixture, "docs", "release.md"), "The release tool is `src/ontology/loader.ts`.\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("docs/release.md:1: missing reference src/ontology/loader.ts");
  });

  it("reports a missing inline source path in packaged host guidance", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture);
    mkdirSync(resolve(fixture, "assets", "codex"), { recursive: true });
    writeFileSync(resolve(fixture, "assets", "codex", "AGENTS.md"), "The loader is `src/kernel/missing.ts`.\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("assets/codex/AGENTS.md:1: missing reference src/kernel/missing.ts");
  });

  it("reports a path that exists locally but is absent from the package", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    mkdirSync(resolve(fixture, "assets", "claude"), { recursive: true });
    mkdirSync(resolve(fixture, "core", "agents"), { recursive: true });
    writePackage(fixture, ["assets"]);
    writeFileSync(resolve(fixture, "assets", "claude", "CLAUDE.md"), "Use `core/agents/retriever.md`.\n");
    writeFileSync(resolve(fixture, "core", "agents", "retriever.md"), "Retriever.\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("assets/claude/CLAUDE.md:1: unpackaged reference core/agents/retriever.md");
  });

  it("reports an unnamespaced Codex skill invocation", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture);
    mkdirSync(resolve(fixture, "assets", "codex"), { recursive: true });
    mkdirSync(resolve(fixture, "assets", "skills", "write"), { recursive: true });
    writeFileSync(resolve(fixture, "assets", "codex", "AGENTS.md"), "Use `$write`.\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("assets/codex/AGENTS.md:1: unknown Codex skill $write");
  });

  it("excludes separately-owned core/AGENTS.md from mapping checks", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture, ["core"]);
    mkdirSync(resolve(fixture, "core"), { recursive: true });
    writeFileSync(resolve(fixture, "core", "README.md"), "Core guidance.\n");
    writeFileSync(resolve(fixture, "core", "AGENTS.md"), "[broken](./missing.md)\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(0);
    expect(result.output).toBe("");
  });

  it("reports a broken reference in shipped markdown outside the former scan roots", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture, ["core/ontology"]);
    mkdirSync(resolve(fixture, "core", "ontology", "schemas"), { recursive: true });
    writeFileSync(resolve(fixture, "core", "ontology", "schemas", "README.md"), "[broken](./missing.md)\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain("core/ontology/schemas/README.md:1: missing reference ./missing.md");
  });

  it("fails closed when no user-facing documentation files are scanned", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture, []);

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.output).toContain('architecture gate scanned zero files for "user-facing documentation"');
  });

  it("does not treat upstream research citations as repository paths", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "oms-doc-mapping-"));
    fixtures.push(fixture);
    writePackage(fixture);
    mkdirSync(resolve(fixture, "docs", "research"), { recursive: true });
    writeFileSync(resolve(fixture, "docs", "research", "upstream.md"), "Upstream uses `src/cli/qmd.ts`.\n");

    const result = runChecker(fixture);

    expect(result.status).toBe(0);
    expect(result.output).toBe("");
  });

  it("accepts the repository documentation tree", () => {
    const result = runChecker(repositoryRoot);

    expect(result.status).toBe(0);
    expect(result.output).toBe("");
  });
});

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { absolute, assertNonVacuous, readJson } from "./repo-root.js";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function skillDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function regularFiles(root: string, directory = root): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return regularFiles(root, absolute);
      return entry.isFile() ? [path.relative(root, absolute)] : [];
    }).sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function assertGjcSkillMirror(sourceRoot: string, mirrorRoot: string): void {
  const authored = skillDirectories(sourceRoot);
  const mirrored = skillDirectories(mirrorRoot);
  assertNonVacuous(authored, "assets/skills scan");
  assertNonVacuous(mirrored, "skills scan");
  expect(mirrored, "Run npm run sync:skills to regenerate the shipped GJC skill mirror.").toEqual(authored);

  const authoredFiles = regularFiles(sourceRoot);
  const mirroredFiles = regularFiles(mirrorRoot);
  expect(mirroredFiles, "Run npm run sync:skills to regenerate the shipped GJC skill mirror.").toEqual(authoredFiles);
  for (const relativePath of authoredFiles) {
    expect(statSync(path.join(mirrorRoot, relativePath)).isFile()).toBe(true);
    expect(readFileSync(path.join(mirrorRoot, relativePath)), `Run npm run sync:skills to regenerate the shipped GJC skill mirror: ${relativePath}`).toEqual(
      readFileSync(path.join(sourceRoot, relativePath)),
    );
  }
}

describe("Gajae-Code skill surface", () => {
  it("mirrors every authored skill at the package-root convention path", () => {
    assertGjcSkillMirror(absolute("assets/skills"), absolute("skills"));
  });

  it("fails closed when an authored scan is empty", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    const mirror = path.join(fixture, "skills");
    mkdirSync(source, { recursive: true });
    mkdirSync(path.join(mirror, "write"), { recursive: true });
    writeFileSync(path.join(mirror, "write", "SKILL.md"), "mirrored\n");

    expect(() => assertGjcSkillMirror(source, mirror)).toThrow('architecture gate scanned zero files for "assets/skills scan"');
  });

  it("fails closed when a mirror scan is empty", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    const mirror = path.join(fixture, "skills");
    mkdirSync(source, { recursive: true });
    mkdirSync(mirror, { recursive: true });
    mkdirSync(path.join(source, "write"));
    writeFileSync(path.join(source, "write", "SKILL.md"), "authored\n");

    expect(() => assertGjcSkillMirror(source, mirror)).toThrow('architecture gate scanned zero files for "skills scan"');
  });

  it("rejects an auxiliary file present only in the shipped mirror", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    const mirror = path.join(fixture, "skills");
    mkdirSync(path.join(source, "write"), { recursive: true });
    mkdirSync(path.join(mirror, "write"), { recursive: true });
    writeFileSync(path.join(source, "write", "SKILL.md"), "authored\n");
    writeFileSync(path.join(mirror, "write", "SKILL.md"), "authored\n");
    writeFileSync(path.join(mirror, "write", "reference.md"), "stale\n");

    expect(() => assertGjcSkillMirror(source, mirror)).toThrow("npm run sync:skills");
  });

  it("ships the root skills tree in the npm package", async () => {
    const packageJson = await readJson<{ readonly files?: readonly string[] }>("package.json");
    expect(packageJson.files).toContain("skills");
  });
});

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function assertGjcSkillMirror(sourceRoot: string, mirrorRoot: string): void {
  const authored = skillDirectories(sourceRoot);
  const mirrored = skillDirectories(mirrorRoot);
  assertNonVacuous(authored, "assets/skills scan");
  assertNonVacuous(mirrored, "skills scan");
  expect(mirrored).toEqual(authored);

  for (const name of authored) {
    expect(readFileSync(path.join(mirrorRoot, name, "SKILL.md"))).toEqual(
      readFileSync(path.join(sourceRoot, name, "SKILL.md")),
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

  it("ships the root skills tree in the npm package", async () => {
    const packageJson = await readJson<{ readonly files?: readonly string[] }>("package.json");
    expect(packageJson.files).toContain("skills");
  });
});

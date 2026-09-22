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


  it("never tells an agent that a retired operation may still be live", () => {
    // Shipped guidance describes the approved surface as final. Transitional
    // wording that hedges about retired modes teaches the wrong contract and
    // outlives the cutover.
    const forbidden = [
      "Parent alignment",
      "may still advertise",
      "may still accept",
      "may still include",
      "not yet accept",
      "until then",
      "at cutover",
    ];
    const skillFiles = regularFiles(absolute("assets/skills")).filter(file => file.endsWith("SKILL.md"));
    expect(skillFiles.length).toBeGreaterThan(0);
    for (const relativePath of skillFiles) {
      const body = readFileSync(path.join(absolute("assets/skills"), relativePath), "utf8").toLowerCase();
      for (const phrase of forbidden) {
        expect(body, `${relativePath} still hedges about the retired surface: ${phrase}`).not.toContain(phrase.toLowerCase());
      }
    }
  });

  it("carries proposals in every executable interview payload it shows", () => {
    // Commit rebuilds the interview from the proposals it is given, so a shown
    // payload that omits them teaches a call that cannot publish.
    const body = readFileSync(absolute("assets/skills/interview/SKILL.md"), "utf8");
    const payloads = [...body.matchAll(/```text\n([\s\S]*?)```/gu)]
      .map(match => match[1] ?? "")
      .filter(block => /mode:\s*"(interview-answer|commit-contracts)"/u.test(block));
    expect(payloads.length, "the interview skill must show its answer and commit payloads").toBeGreaterThanOrEqual(2);
    for (const payload of payloads) {
      expect(payload, `an interview payload omits proposals: ${payload}`).toMatch(/\bproposals\b/u);
    }
    expect(body).toMatch(/interview-next.*interview-answer.*commit-contracts/su);
  });

  it("never tells an agent that setup selects a template folder", () => {
    // Setup proposes an empty contract and adopts nothing; folder selection is
    // an interview decision.
    for (const relativePath of regularFiles(absolute("assets/skills")).filter(file => file.endsWith("SKILL.md"))) {
      const body = readFileSync(path.join(absolute("assets/skills"), relativePath), "utf8");
      expect(body, `${relativePath} still says setup selects a folder`).not.toMatch(/setup or interview decision/u);
    }
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

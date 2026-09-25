import {
  authoredSkillDirectories,
  main as syncGjcSkills,
  parseSkillSelection,
} from "../../scripts/sync-gjc-skills.mjs";
import { lstatSync, symlinkSync } from "node:fs";
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

  it("never shows a copyable call for the retired interview surface", () => {
    // The interview ledger is gone. Live docs that still show
    // `write { op: "template", mode: "interview-next" }` teach a call the
    // server no longer accepts.
    const files = [
      "README.md",
      "README.ko.md",
      "docs/adapters.md",
      "docs/cli-map.md",
      "docs/harness-architecture.md",
    ];
    const bare = /write \{ op: "template", mode: "interview-next" \}/gu;
    for (const relativePath of files) {
      const body = readFileSync(absolute(relativePath), "utf8");
      expect(
        body.match(bare) ?? [],
        `${relativePath} still shows a copyable interview-next without proposals`,
      ).toEqual([]);
    }
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

  it("regenerates only the selected authored mirror", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    const mirror = path.join(fixture, "skills");
    for (const name of ["distill", "doctor", "link", "search", "setup", "status", "write"]) {
      mkdirSync(path.join(source, name), { recursive: true });
      writeFileSync(path.join(source, name, "SKILL.md"), `authored ${name}\n`);
      mkdirSync(path.join(mirror, name), { recursive: true });
      writeFileSync(path.join(mirror, name, "SKILL.md"), `stale ${name}\n`);
    }
    const sentinel = Buffer.from("user-owned sentinel\n");
    const sentinelPath = path.join(mirror, "notes.txt");
    writeFileSync(sentinelPath, sentinel);
    const selectedSentinel = Buffer.from("selected-dir sentinel\n");
    const selectedSentinelPath = path.join(mirror, "write", "notes.txt");
    writeFileSync(selectedSentinelPath, selectedSentinel);

    expect(syncGjcSkills(["--skill", "write", "--skill", "link"], { sourceRoot: source, destinationRoot: mirror })).toEqual(["write", "link"]);

    expect(readFileSync(path.join(mirror, "write", "SKILL.md"))).toEqual(readFileSync(path.join(source, "write", "SKILL.md")));
    expect(readFileSync(path.join(mirror, "link", "SKILL.md"))).toEqual(readFileSync(path.join(source, "link", "SKILL.md")));
    expect(readFileSync(path.join(mirror, "doctor", "SKILL.md"), "utf8")).toBe("stale doctor\n");
    expect(readFileSync(sentinelPath)).toEqual(sentinel);
    expect(readFileSync(selectedSentinelPath)).toEqual(selectedSentinel);
    expect(skillDirectories(mirror)).toEqual(skillDirectories(source));
  });

  it("keeps default generation limited to authored skill directories", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    const mirror = path.join(fixture, "skills");
    for (const name of ["write", "distill", "doctor", "link", "search", "setup", "status"]) {
      mkdirSync(path.join(source, name), { recursive: true });
      writeFileSync(path.join(source, name, "SKILL.md"), `authored ${name}\n`);
    }
    mkdirSync(mirror, { recursive: true });
    const sentinel = Buffer.from("keep me\n");
    writeFileSync(path.join(mirror, "user-note.txt"), sentinel);
    mkdirSync(path.join(mirror, "write"), { recursive: true });
    writeFileSync(path.join(mirror, "write", "SKILL.md"), "stale write\n");

    expect(syncGjcSkills([], { sourceRoot: source, destinationRoot: mirror })).toEqual(authoredSkillDirectories(source));

    for (const name of authoredSkillDirectories(source)) {
      expect(readFileSync(path.join(mirror, name, "SKILL.md"))).toEqual(readFileSync(path.join(source, name, "SKILL.md")));
    }
    expect(readFileSync(path.join(mirror, "user-note.txt"))).toEqual(sentinel);
  });
  it("mutates nothing when a later selected source is missing", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    const mirror = path.join(fixture, "skills");
    for (const name of ["distill", "doctor", "link", "search", "setup", "status", "write"]) {
      mkdirSync(path.join(source, name), { recursive: true });
      writeFileSync(path.join(source, name, "SKILL.md"), `authored ${name}\n`);
      mkdirSync(path.join(mirror, name), { recursive: true });
      writeFileSync(path.join(mirror, name, "SKILL.md"), `stale ${name}\n`);
    }
    rmSync(path.join(source, "link", "SKILL.md"));
    const before = readFileSync(path.join(mirror, "write", "SKILL.md"));
    const sibling = readFileSync(path.join(mirror, "doctor", "SKILL.md"));

    expect(() => syncGjcSkills(["--skill", "write", "--skill", "link"], { sourceRoot: source, destinationRoot: mirror })).toThrow("missing source link/SKILL.md");
    expect(readFileSync(path.join(mirror, "write", "SKILL.md"))).toEqual(before);
    expect(readFileSync(path.join(mirror, "doctor", "SKILL.md"))).toEqual(sibling);
    expect(skillDirectories(mirror)).toEqual(skillDirectories(source));
  });

  it("refuses overlapping source and destination before any write", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    for (const name of ["distill", "doctor", "link", "search", "setup", "status", "write"]) {
      mkdirSync(path.join(source, name), { recursive: true });
      writeFileSync(path.join(source, name, "SKILL.md"), `authored ${name}\n`);
    }
    const before = readFileSync(path.join(source, "write", "SKILL.md"));
    const aliasRoot = path.join(fixture, "alias-parent");
    mkdirSync(aliasRoot);
    symlinkSync(path.join(fixture, "assets"), path.join(aliasRoot, "assets"), "dir");

    expect(() => syncGjcSkills(["--skill", "write"], { sourceRoot: source, destinationRoot: source })).toThrow("overlap");
    expect(() => syncGjcSkills(["--skill", "write"], { sourceRoot: source, destinationRoot: path.join(source, "write") })).toThrow("overlap");
    expect(() => syncGjcSkills(["--skill", "write"], {
      sourceRoot: path.join(aliasRoot, "assets", "skills"),
      destinationRoot: source,
    })).toThrow("overlap");
    expect(readFileSync(path.join(source, "write", "SKILL.md"))).toEqual(before);
    const nested = path.join(source, "..mirror");
    expect(() => syncGjcSkills(["--skill", "write"], { sourceRoot: source, destinationRoot: nested })).toThrow("overlap");
    expect(readFileSync(path.join(source, "write", "SKILL.md"))).toEqual(before);
    expect(lstatSync(nested, { throwIfNoEntry: false })).toBeUndefined();

    const sibling = path.join(fixture, "assets", "..mirror");
    mkdirSync(sibling);
    expect(syncGjcSkills(["--skill", "write"], { sourceRoot: source, destinationRoot: sibling })).toEqual(["write"]);
    expect(readFileSync(path.join(sibling, "write", "SKILL.md"))).toEqual(before);
    expect(readFileSync(path.join(source, "write", "SKILL.md"))).toEqual(before);
  });

  it("refuses a destination leaf symlink without following it", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    const mirror = path.join(fixture, "skills");
    const outside = path.join(fixture, "outside.md");
    const outsideBytes = Buffer.from("outside sentinel\n");
    writeFileSync(outside, outsideBytes);
    for (const name of ["distill", "doctor", "link", "search", "setup", "status", "write"]) {
      mkdirSync(path.join(source, name), { recursive: true });
      writeFileSync(path.join(source, name, "SKILL.md"), `authored ${name}\n`);
    }
    mkdirSync(path.join(mirror, "write"), { recursive: true });
    symlinkSync(outside, path.join(mirror, "write", "SKILL.md"));
    const sibling = path.join(mirror, "write", "notes.txt");
    const siblingBytes = Buffer.from("selected-dir sentinel\n");
    writeFileSync(sibling, siblingBytes);

    expect(() => syncGjcSkills(["--skill", "write"], { sourceRoot: source, destinationRoot: mirror })).toThrow("symlink");
    expect(readFileSync(outside)).toEqual(outsideBytes);
    expect(lstatSync(path.join(mirror, "write", "SKILL.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(sibling)).toEqual(siblingBytes);
  });

  it("mutates nothing when the skill selection is invalid", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "oms-gjc-skills-"));
    fixtures.push(fixture);
    const source = path.join(fixture, "assets", "skills");
    const mirror = path.join(fixture, "skills");
    for (const name of ["distill", "doctor", "link", "search", "setup", "status", "write"]) {
      mkdirSync(path.join(source, name), { recursive: true });
      writeFileSync(path.join(source, name, "SKILL.md"), `authored ${name}\n`);
    }
    mkdirSync(path.join(mirror, "write"), { recursive: true });
    const before = Buffer.from("untouched\n");
    writeFileSync(path.join(mirror, "write", "SKILL.md"), before);
    const snapshot = () => readFileSync(path.join(mirror, "write", "SKILL.md"));

    for (const args of [
      ["--skill", "../write"],
      ["--skill", "contract"],
      ["--skill"],
      ["--skill", "write", "link"],
      ["--skill=write/../../etc"],
      ["write"],
    ]) {
      expect(() => syncGjcSkills(args, { sourceRoot: source, destinationRoot: mirror }), args.join(" ")).toThrow("[sync:skills] refusing to sync");
      expect(snapshot(), args.join(" ")).toEqual(before);
      expect(skillDirectories(mirror), args.join(" ")).toEqual(["write"]);
    }
    expect(() => parseSkillSelection(["--skill", "Write"])).toThrow("invalid skill name");
  });
});

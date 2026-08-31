import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalCorpus,
  corpusDigest,
  CORPUS_EXTENSION,
  EXCLUDED_DIRECTORIES,
  snapshotCorpus,
  verifyCorpusDigest,
  type CorpusEntry,
  type CorpusFs,
} from "./parity-corpus.js";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function entry(relativePath: string, content = "body"): CorpusEntry {
  return { relativePath, contentSha256: sha(content) };
}

/**
 * An in-memory vault. Paths are POSIX-joined keys; a value of `null` marks a
 * filesystem node that is neither a regular file nor a directory, which is how
 * `dirent` reports a symlink.
 */
function fakeFs(tree: Readonly<Record<string, string | null>>): CorpusFs {
  const files = new Map(Object.entries(tree));
  const directories = (prefix: string): Set<string> => {
    const names = new Set<string>();
    for (const key of files.keys()) {
      if (prefix !== "" && !key.startsWith(`${prefix}/`)) continue;
      const rest = prefix === "" ? key : key.slice(prefix.length + 1);
      const slash = rest.indexOf("/");
      if (slash !== -1) names.add(rest.slice(0, slash));
    }
    return names;
  };
  return {
    listDirectory: async (directory) => {
      const prefix = directory === "/vault" ? "" : directory.replace(/^\/vault\//u, "");
      const childDirs = [...directories(prefix)].map((name) => ({
        name,
        isDirectory: true,
        isFile: false,
      }));
      const childFiles = [...files.entries()]
        .filter(([key]) => {
          const rest = prefix === "" ? key : key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : null;
          return rest !== null && !rest.includes("/");
        })
        .map(([key, value]) => ({
          name: key.slice(key.lastIndexOf("/") + 1),
          isDirectory: false,
          isFile: value !== null,
        }));
      return [...childDirs, ...childFiles];
    },
    readFileBytes: async (file) => {
      const key = file.replace(/^\/vault\//u, "");
      const value = files.get(key);
      if (value === undefined || value === null) throw new Error(`unexpected read: ${file}`);
      return new TextEncoder().encode(value);
    },
  };
}

describe("canonical corpus encoding", () => {
  it("is independent of the order entries were collected in", () => {
    const forward = [entry("a.md"), entry("b/c.md"), entry("z.md")];
    const shuffled = [entry("z.md"), entry("a.md"), entry("b/c.md")];
    expect(corpusDigest(forward)).toBe(corpusDigest(shuffled));
  });

  it("sorts by code unit rather than locale, so two hosts agree", () => {
    // `localeCompare` would order these by the runtime's collation; a digest that
    // depends on ICU configuration cannot detect the drift it exists to detect.
    const paths = ["B.md", "a.md", "\u00e4.md", "Z.md"];
    const rows = canonicalCorpus(paths.map((p) => entry(p))).split("\n");
    const sortedByCodeUnit = [...paths].sort((l, r) => (l < r ? -1 : l > r ? 1 : 0));
    expect(rows.map((row) => row.split("\u0000")[0])).toEqual(sortedByCodeUnit);
  });

  it("changes when a note's content changes", () => {
    expect(corpusDigest([entry("a.md", "before")]))
      .not.toBe(corpusDigest([entry("a.md", "after")]));
  });

  it("changes when a note is renamed, added, or removed", () => {
    const base = [entry("a.md"), entry("b.md")];
    expect(corpusDigest([entry("a.md"), entry("renamed.md")])).not.toBe(corpusDigest(base));
    expect(corpusDigest([...base, entry("c.md")])).not.toBe(corpusDigest(base));
    expect(corpusDigest([entry("a.md")])).not.toBe(corpusDigest(base));
  });

  it("does not collide when a filename contains a newline", () => {
    // The row separator is a newline, so an injective encoding is the only thing
    // preventing a crafted filename from forging a different corpus.
    const withNewline = [entry("a.md\nb.md")];
    const twoFiles = [entry("a.md"), entry("b.md")];
    expect(corpusDigest(withNewline)).not.toBe(corpusDigest(twoFiles));
  });

  it("rejects entries that would break the encoding's injectivity", () => {
    expect(() => corpusDigest([entry("a.md"), entry("a.md")])).toThrow(/duplicate path/);
    expect(() => corpusDigest([{ relativePath: "a\u0000b.md", contentSha256: sha("x") }]))
      .toThrow(/must not contain NUL/);
    expect(() => corpusDigest([{ relativePath: "", contentSha256: sha("x") }]))
      .toThrow(/non-empty string/);
    for (const bad of ["", "not-hex", "A".repeat(64), "a".repeat(63)]) {
      expect(() => corpusDigest([{ relativePath: "a.md", contentSha256: bad }]))
        .toThrow(/lowercase 64-character sha256/);
    }
  });

  it("digests an empty corpus deterministically rather than throwing", () => {
    // An empty vault is a real (if useless) corpus; the gate's row-count checks are
    // what reject it, not the digest producer.
    expect(corpusDigest([])).toBe(corpusDigest([]));
  });
});

describe("vault snapshot", () => {
  it("collects only markdown notes, recursively", async () => {
    const snapshot = await snapshotCorpus(
      "/vault",
      fakeFs({
        "note.md": "one",
        "sub/deep.md": "two",
        "image.png": "binary",
        "README.txt": "text",
      }),
    );
    expect(snapshot.fileCount).toBe(2);
    expect(snapshot.entries.map((e) => e.relativePath).sort()).toEqual(["note.md", "sub/deep.md"]);
  });

  it("matches the extension case-insensitively", async () => {
    const snapshot = await snapshotCorpus("/vault", fakeFs({ "Note.MD": "one" }));
    expect(snapshot.fileCount).toBe(1);
    expect(CORPUS_EXTENSION).toBe(".md");
  });

  it("excludes the engine's own state so measuring cannot change the corpus", async () => {
    // `.oms` holds the store this very run writes. Including it would make the
    // digest depend on the measurement, and no run could reproduce another.
    expect(EXCLUDED_DIRECTORIES).toContain(".oms");
    const withState = await snapshotCorpus(
      "/vault",
      fakeFs({ "note.md": "one", ".oms/notes-cache.md": "derived" }),
    );
    const withoutState = await snapshotCorpus("/vault", fakeFs({ "note.md": "one" }));
    expect(withState.digest).toBe(withoutState.digest);
  });

  it("excludes any hidden tool directory, not only the names known today", async () => {
    // qmd's `**/*.md` collection glob skips dot-directories. A fixed allowlist
    // leaked `.gjc` session plans into the corpus and would leak the next tool's
    // state too, so the invariant is the prefix rather than today's product names.
    const snapshot = await snapshotCorpus(
      "/vault",
      fakeFs({
        "keep.md": "one",
        ".gjc/session/plan.md": "agent state",
        ".future-tool/cache.md": "future state",
      }),
    );

    expect(snapshot.entries.map((entry) => entry.relativePath)).toEqual(["keep.md"]);
  });

  it.each(EXCLUDED_DIRECTORIES)("skips the %s directory entirely", async (excluded) => {
    const snapshot = await snapshotCorpus(
      "/vault",
      fakeFs({ "keep.md": "one", [`${excluded}/inside.md`]: "ignored" }),
    );
    expect(snapshot.entries.map((e) => e.relativePath)).toEqual(["keep.md"]);
  });

  it("does not follow symlinks", async () => {
    // A link out of the vault would digest files the vault does not own; a cycle
    // would not terminate.
    const snapshot = await snapshotCorpus(
      "/vault",
      fakeFs({ "real.md": "one", "linked.md": null }),
    );
    expect(snapshot.entries.map((e) => e.relativePath)).toEqual(["real.md"]);
  });

  it("produces a digest matching the entries it reports", async () => {
    const fs = fakeFs({ "a.md": "one", "b.md": "two" });
    const snapshot = await snapshotCorpus("/vault", fs);
    expect(snapshot.digest).toBe(corpusDigest(snapshot.entries));
  });

  it("is stable across repeated walks of an unchanged vault", async () => {
    const tree = { "a.md": "one", "sub/b.md": "two" };
    const first = await snapshotCorpus("/vault", fakeFs(tree));
    const second = await snapshotCorpus("/vault", fakeFs(tree));
    expect(second.digest).toBe(first.digest);
  });
});

/**
 * Real-filesystem coverage (integration / medium size).
 *
 * Everything above runs against `fakeFs`, whose `listDirectory` I wrote myself — so
 * those tests prove the digest logic, not the traversal. That distinction matters
 * most for the symlink case: the fake models a symlink as a dirent that is neither
 * file nor directory, which is my *assumption* about `readdir(withFileTypes)`. If
 * that assumption were wrong, the fake would happily agree with itself while the
 * real walk followed the link out of the vault or into a cycle.
 *
 * The real dependency is cheap here (a temp dir, a few files) and `mkdtemp` is
 * already this repo's incumbent pattern for filesystem-touching tests, so there is
 * no reason to trust a hand-written fake for the boundary itself.
 */
describe("vault snapshot against a real filesystem", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "oms-corpus-real-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collects markdown recursively and ignores other extensions", async () => {
    await writeFile(path.join(dir, "top.md"), "top level");
    await writeFile(path.join(dir, "image.png"), "not markdown");
    await writeFile(path.join(dir, "README.txt"), "also not markdown");
    await mkdir(path.join(dir, "sub", "deeper"), { recursive: true });
    await writeFile(path.join(dir, "sub", "deeper", "nested.md"), "nested");

    const snapshot = await snapshotCorpus(dir);

    expect(snapshot.entries.map((e) => e.relativePath).sort())
      .toEqual(["sub/deeper/nested.md", "top.md"]);
    expect(snapshot.fileCount).toBe(2);
  });

  it("matches the extension case-insensitively on the real filesystem", async () => {
    // macOS APFS is case-insensitive by default while Linux ext4 is not, so this
    // is exactly the interaction a fake cannot show.
    await writeFile(path.join(dir, "Shouty.MD"), "upper extension");

    const snapshot = await snapshotCorpus(dir);

    expect(snapshot.fileCount).toBe(1);
    expect(snapshot.entries[0]?.relativePath.toLowerCase()).toBe("shouty.md");
  });

  it("does not follow a real symlink to a file outside the vault", async () => {
    // The claim the fake could only assert about itself: a symlinked note must not
    // enter the digest, or the corpus would include files the vault does not own.
    const outside = await mkdtemp(path.join(tmpdir(), "oms-corpus-outside-"));
    try {
      await writeFile(path.join(outside, "foreign.md"), "not part of the vault");
      await writeFile(path.join(dir, "own.md"), "owned");
      await symlink(path.join(outside, "foreign.md"), path.join(dir, "linked.md"));

      const snapshot = await snapshotCorpus(dir);

      expect(snapshot.entries.map((e) => e.relativePath)).toEqual(["own.md"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("terminates on a real directory symlink cycle", async () => {
    // A followed directory link pointing at its own ancestor would recurse until
    // the process died. Reaching an assertion at all is the proof here.
    await writeFile(path.join(dir, "root.md"), "root");
    await mkdir(path.join(dir, "child"), { recursive: true });
    await writeFile(path.join(dir, "child", "leaf.md"), "leaf");
    await symlink(dir, path.join(dir, "child", "loop"));

    const snapshot = await snapshotCorpus(dir);

    expect(snapshot.entries.map((e) => e.relativePath).sort())
      .toEqual(["child/leaf.md", "root.md"]);
  });

  it("excludes real engine state so measuring a vault cannot change its digest", async () => {
    await writeFile(path.join(dir, "note.md"), "content");
    const before = await snapshotCorpus(dir);

    // Simulate what an actual embed run leaves behind inside the vault.
    await mkdir(path.join(dir, ".oms"), { recursive: true });
    await writeFile(path.join(dir, ".oms", "engine-store.sqlite"), "binary-ish");
    await writeFile(path.join(dir, ".oms", "derived.md"), "derived note");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "COMMIT_EDITMSG"), "wip");
    await mkdir(path.join(dir, ".gjc", "session"), { recursive: true });
    await writeFile(path.join(dir, ".gjc", "session", "plan.md"), "agent state");
    await mkdir(path.join(dir, ".future-tool"), { recursive: true });
    await writeFile(path.join(dir, ".future-tool", "cache.md"), "future state");

    const after = await snapshotCorpus(dir);

    expect(after.digest).toBe(before.digest);
  });

  it("changes the real digest when a note's bytes change", async () => {
    const file = path.join(dir, "note.md");
    await writeFile(file, "original");
    const before = await snapshotCorpus(dir);

    await writeFile(file, "edited");
    const after = await snapshotCorpus(dir);

    expect(after.digest).not.toBe(before.digest);
    expect(after.fileCount).toBe(before.fileCount);
  });

  it("verifies a declared digest against the real vault it was measured from", async () => {
    await writeFile(path.join(dir, "a.md"), "alpha");
    const { digest } = await snapshotCorpus(dir);

    expect(await verifyCorpusDigest(dir, digest)).toMatchObject({ ok: true });

    await writeFile(path.join(dir, "b.md"), "added after preregistration");
    const drifted = await verifyCorpusDigest(dir, digest);

    expect(drifted.ok).toBe(false);
    expect(drifted.reason).toMatch(/corpus digest mismatch/);
  });
});

describe("digest verification", () => {
  it("accepts an unchanged vault", async () => {
    const fs = fakeFs({ "a.md": "one" });
    const { digest } = await snapshotCorpus("/vault", fs);
    expect(await verifyCorpusDigest("/vault", digest, fs)).toEqual({ ok: true, actual: digest });
  });

  it("accepts a prefixed or upper-case declaration as the same digest", async () => {
    const fs = fakeFs({ "a.md": "one" });
    const { digest } = await snapshotCorpus("/vault", fs);
    expect((await verifyCorpusDigest("/vault", `sha256:${digest.toUpperCase()}`, fs)).ok).toBe(true);
  });

  it("reports a mismatch with the measured digest and file count", async () => {
    const declared = (await snapshotCorpus("/vault", fakeFs({ "a.md": "one" }))).digest;
    const result = await verifyCorpusDigest(
      "/vault",
      declared,
      fakeFs({ "a.md": "one", "b.md": "added later" }),
    );
    expect(result.ok).toBe(false);
    expect(result.actual).not.toBe(declared);
    expect(result.reason).toMatch(/corpus digest mismatch/);
    expect(result.reason).toMatch(/over 2 files/);
    expect(result.reason).toMatch(/re-preregister/);
  });

  it("detects an edit that leaves the file count unchanged", async () => {
    // The subtle case: the vault looks identical by count, but a note was edited.
    const declared = (await snapshotCorpus("/vault", fakeFs({ "a.md": "before" }))).digest;
    const result = await verifyCorpusDigest("/vault", declared, fakeFs({ "a.md": "after" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/over 1 files/);
  });
});

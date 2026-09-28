import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchEntry, readExact, readExactDocument, ReadExactError } from "./read-exact.js";

const NFC_NAME = "낙상 위험 평가.md";
const NFD_NAME = NFC_NAME.normalize("NFD");
const ISOLATED_ENV = [
  "HOME",
  "USERPROFILE",
  "OMS_RUNTIME_ROOT",
  "OMS_AUTO_UPDATE_STATE_DIR",
  "OMS_CLAUDE_HOME",
  "OMS_CODEX_HOME",
  "OMS_HERMES_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const;

let base: string;
let vault: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "oms-read-exact-")));
  savedEnv = Object.fromEntries(ISOLATED_ENV.map((name) => [name, process.env[name]]));
  for (const name of ISOLATED_ENV) process.env[name] = path.join(base, "env", name.toLowerCase());
  vault = path.join(base, "vault");
  mkdirSync(path.join(vault, "지식"), { recursive: true });
});

afterEach(() => {
  for (const name of ISOLATED_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

async function rejection(promise: Promise<unknown>): Promise<ReadExactError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(ReadExactError);
  return error as ReadExactError;
}

describe("readExact", () => {
  it("finds an NFD file on disk from an NFC request and returns the on-disk spelling", async () => {
    writeFileSync(path.join(vault, "지식", NFD_NAME), "# nfd\n");
    const result = await readExact(vault, `지식/${NFC_NAME}`);
    expect(result.content).toBe("# nfd\n");
    expect(result.path).toBe(`지식/${NFD_NAME}`);
    expect(result.path).not.toBe(`지식/${NFC_NAME}`);
  });

  it("finds an NFC file on disk from an NFD request", async () => {
    writeFileSync(path.join(vault, "지식", NFC_NAME), "# nfc\n");
    const result = await readExact(vault, `지식/${NFD_NAME}`);
    expect(result.content).toBe("# nfc\n");
    expect(result.path).toBe(`지식/${NFC_NAME}`);
  });

  it("reads a Hangul filename byte-exactly with a sha256 revision", async () => {
    const content = "---\ntitle: 낙상판정기준\n---\n본문\n";
    mkdirSync(path.join(vault, "Resources"));
    writeFileSync(path.join(vault, "Resources", "낙상판정기준.md"), content);
    const result = await readExact(vault, "Resources/낙상판정기준.md");
    expect(result).toEqual({ path: "Resources/낙상판정기준.md", content, revision: sha256(content) });
    expect(result.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts a backslash-separated or ./-prefixed path and returns a POSIX path", async () => {
    writeFileSync(path.join(vault, "지식", NFC_NAME), "x");
    expect((await readExact(vault, `지식\\${NFC_NAME}`)).path).toBe(`지식/${NFC_NAME}`);
    expect((await readExact(vault, `./지식/${NFC_NAME}`)).path).toBe(`지식/${NFC_NAME}`);
  });

  it("prefers the exact spelling when the filesystem keeps both NFC and NFD entries", async () => {
    writeFileSync(path.join(vault, "지식", NFC_NAME), "nfc");
    writeFileSync(path.join(vault, "지식", NFD_NAME), "nfd");
    const entries = readdirSync(path.join(vault, "지식"));
    const nfc = await readExact(vault, `지식/${NFC_NAME}`);
    const nfd = await readExact(vault, `지식/${NFD_NAME}`);
    if (entries.length === 2) {
      // ext4 and other byte-exact filesystems: two distinct files.
      expect(nfc).toMatchObject({ path: `지식/${NFC_NAME}`, content: "nfc" });
      expect(nfd).toMatchObject({ path: `지식/${NFD_NAME}`, content: "nfd" });
    } else {
      // APFS: one file for both spellings, so both requests read it.
      expect(entries).toHaveLength(1);
      expect(nfc).toEqual(nfd);
      expect(nfc.path).toBe(`지식/${entries[0]}`);
    }
  });

  it("matches entries exact first, then NFC, then a single NFC-equal entry", () => {
    expect(matchEntry([NFC_NAME, NFD_NAME], NFD_NAME, "x")).toBe(NFD_NAME);
    expect(matchEntry(["other.md", NFC_NAME], NFD_NAME, "x")).toBe(NFC_NAME);
    expect(matchEntry([NFD_NAME, "other.md"], NFC_NAME, "x")).toBe(NFD_NAME);
    expect(matchEntry(["a.md"], NFC_NAME, "x")).toBeUndefined();
  });

  it("refuses a request that NFC-matches several entries when none is spelled exactly or NFC", () => {
    // Two non-NFC spellings of U+1EAD: canonical and non-canonical combining-mark order.
    // Only a byte-exact filesystem can hold both, so this is checked on the listing directly.
    const canonical = "ậ.md";
    const reordered = "ậ.md";
    expect(canonical.normalize("NFC")).toBe(reordered.normalize("NFC"));
    expect(() => matchEntry([canonical, reordered], "ậ.md", "x/ậ.md")).toThrow(/READ_EXACT_AMBIGUOUS/);
    expect(matchEntry([canonical, reordered], reordered, "x")).toBe(reordered);
  });

  it("raises READ_EXACT_NOT_FOUND for a missing file or directory", async () => {
    expect((await rejection(readExact(vault, "지식/없음.md"))).code).toBe("READ_EXACT_NOT_FOUND");
    const error = await rejection(readExact(vault, "없는폴더/없음.md"));
    expect(error.code).toBe("READ_EXACT_NOT_FOUND");
    expect(error.message).toContain("없는폴더/없음.md");
  });

  it("raises READ_EXACT_NOT_FOUND when a file is used as a directory", async () => {
    writeFileSync(path.join(vault, "a.md"), "x");
    expect((await rejection(readExact(vault, "a.md/b.md"))).code).toBe("READ_EXACT_NOT_FOUND");
  });

  it("raises READ_EXACT_NOT_FILE for a directory", async () => {
    expect((await rejection(readExact(vault, "지식"))).code).toBe("READ_EXACT_NOT_FILE");
  });

  it("rejects .. segments, absolute paths and empty paths before touching disk", async () => {
    writeFileSync(path.join(base, "secret.md"), "secret");
    for (const bad of ["../secret.md", "지식/../../secret.md", "..\\secret.md", path.join(base, "secret.md"), "/etc/hosts", "C:\\x.md", "", "  ", "./"]) {
      expect((await rejection(readExact(vault, bad))).code).toBe("READ_EXACT_INVALID_PATH");
    }
  });

  it("rejects a file symlink that escapes the vault", async () => {
    writeFileSync(path.join(base, "secret.md"), "secret");
    symlinkSync(path.join(base, "secret.md"), path.join(vault, "link.md"));
    expect((await rejection(readExact(vault, "link.md"))).code).toBe("READ_EXACT_ESCAPE");
  });

  it("rejects a directory symlink that escapes the vault", async () => {
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "secret.md"), "secret");
    symlinkSync(path.join(base, "outside"), path.join(vault, "out"), "dir");
    expect((await rejection(readExact(vault, "out/secret.md"))).code).toBe("READ_EXACT_ESCAPE");
  });

  it("follows a symlink that stays inside the vault", async () => {
    writeFileSync(path.join(vault, "지식", NFC_NAME), "inside");
    symlinkSync(path.join(vault, "지식", NFC_NAME), path.join(vault, "alias.md"));
    expect(await readExact(vault, "alias.md")).toMatchObject({ path: "alias.md", content: "inside" });
  });

  it("wraps a read in the document-result shape", async () => {
    writeFileSync(path.join(vault, "지식", NFD_NAME), "doc");
    expect(await readExactDocument(vault, `지식/${NFC_NAME}`)).toEqual({
      available: true,
      documents: [{ target: `지식/${NFC_NAME}`, path: `지식/${NFD_NAME}`, content: "doc", revision: sha256("doc") }],
    });
  });

  it("reports a caller path error as an unavailable document result", async () => {
    const result = await readExactDocument(vault, "지식/없음.md");
    expect(result.available).toBe(false);
    expect(result.documents).toEqual([]);
    expect(result.reason).toMatch(/^READ_EXACT_NOT_FOUND: /);
    expect((await readExactDocument(vault, "../x.md")).reason).toMatch(/^READ_EXACT_INVALID_PATH: /);
  });

  it("rethrows an I/O failure that is not a path error", async () => {
    await expect(readExactDocument(path.join(base, "no-vault"), "a.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves the vault root through a symlink", async () => {
    writeFileSync(path.join(vault, "지식", NFC_NAME), "via link");
    symlinkSync(vault, path.join(base, "vault-link"), "dir");
    expect((await readExact(path.join(base, "vault-link"), `지식/${NFC_NAME}`)).content).toBe("via link");
  });
});

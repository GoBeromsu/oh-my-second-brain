import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileMetadataWitness, readFileSnapshot } from "./file-snapshot.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oms-file-snapshot-"));
  file = path.join(root, "note.md");
  await writeFile(file, "alpha");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const strong = () => ({ isFile: () => true, dev: 1n, ino: 2n, size: 5n, mtimeNs: 1_000_001n, ctimeNs: 2_000_001n });

describe("filesystem snapshot evidence", () => {
  it("preserves exact bigint values without numeric rounding", () => {
    const info = { ...strong(), ino: 2n ** 60n };
    expect(fileMetadataWitness(info)).not.toBeNull();
    expect(fileMetadataWitness({ ...info, ino: info.ino + 1n })).not.toBe(fileMetadataWitness(info));
  });

  it.each([
    null, {}, { ...strong(), isFile: undefined }, { ...strong(), isFile: () => false },
    { ...strong(), dev: -1n }, { ...strong(), dev: 0n }, { ...strong(), ino: 0n }, { ...strong(), size: -1n },
    { ...strong(), mtimeNs: 0n }, { ...strong(), ctimeNs: 0n },
    { ...strong(), mtimeNs: undefined }, { ...strong(), ctimeNs: 3 },
    { ...strong(), mtimeNs: 1_000_000n }, { ...strong(), ctimeNs: 2_000_000n },
  ])("does not attest unknown or weak metadata %#", info => {
    expect(fileMetadataWitness(info)).toBeNull();
  });

  it("binds a read to a supplied identity and rejects an outdated identity", async () => {
    const before = await stat(file, { bigint: true });
    expect((await readFileSnapshot(file, before)).bytes.toString()).toBe("alpha");
    await writeFile(file, "changed");
    await expect(readFileSnapshot(file, before)).rejects.toThrow(/changed while being read/);
  });

  it.each(["inode", "timestamp"])("byte-validates an asymmetric weak %s observation", async field => {
    const before = await stat(file, { bigint: true });
    if (field === "inode") Object.assign(before, { ino: 0n });
    else Object.assign(before, { mtimeNs: 1_000_000n, ctimeNs: 1_000_000n });
    const captured = await readFileSnapshot(file, before);
    expect(captured.bytes.toString()).toBe("alpha");
    expect(captured.witness).toBeNull();
  });

  it("rejects an incomplete handle read and closes the handle on failure", async () => {
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const handle = await original.open(file, "r");
    const close = vi.spyOn(handle, "close");
    vi.spyOn(handle, "readFile").mockResolvedValue(Buffer.from("a"));
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    await expect(readFileSnapshot(file)).rejects.toThrow(/changed while being read/);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a directory instead of treating it as a note", async () => {
    const directory = path.join(root, "directory");
    await mkdir(directory);
    await expect(readFileSnapshot(directory)).rejects.toThrow(/changed while being read/);
  });
});

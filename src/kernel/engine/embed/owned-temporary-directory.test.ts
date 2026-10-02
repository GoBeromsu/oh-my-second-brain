import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { createOwnedTemporaryDirectory } from "./owned-temporary-directory.js";

// Ownership failures are metadata-only unit checks. No replacement directories,
// deletion reproductions, or live filesystem cleanup are exercised by this mock.
vi.mock("node:fs", () => ({ lstatSync: vi.fn(), mkdtempSync: vi.fn(), realpathSync: vi.fn(), rmSync: vi.fn() }));
const root = path.resolve("/canonical-temp");
const alias = path.resolve("/temp-alias");
const directory = path.join(root, "owned-example");
const child = path.join(directory, "core.sqlite");
const identity = {
  dev: 1n, ino: 2n, isDirectory: () => true, isSymbolicLink: () => false,
} as fs.BigIntStats;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.realpathSync).mockImplementation(filename => String(filename) === alias ? root : String(filename));
  vi.mocked(fs.mkdtempSync).mockReturnValue(directory);
  vi.mocked(fs.lstatSync).mockReturnValue(identity);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("owned temporary directory observations", () => {
  it("canonicalizes the root before creation and accepts the captured identity", () => {
    const owned = createOwnedTemporaryDirectory(alias, "owned-");
    expect(fs.mkdtempSync).toHaveBeenCalledWith(path.join(root, "owned-"));
    expect(owned.path).toBe(directory);
    expect(() => owned.assertOwned()).not.toThrow();
    expect(owned.removeFile(child)).toBe(true);
    expect(fs.rmSync).toHaveBeenLastCalledWith(child, { force: true });
    owned.dispose(); owned.dispose();
    expect(owned.removeFile(child)).toBe(true);
    expect(fs.rmSync).toHaveBeenCalledTimes(2);
    expect(fs.rmSync).toHaveBeenLastCalledWith(directory, { recursive: true, force: true });
    expect(console.warn).not.toHaveBeenCalled();
    expect(() => owned.assertOwned()).toThrow(/ownership could not be verified/u);
  });

  const invalid = [
    ["different device", { ...identity, dev: 9n }],
    ["different inode", { ...identity, ino: 9n }],
    ["zero device", { ...identity, dev: 0n }],
    ["zero inode", { ...identity, ino: 0n }],
    ["unknown device", { ...identity, dev: undefined }],
    ["unknown inode", { ...identity, ino: undefined }],
    ["non-directory", { ...identity, isDirectory: () => false }],
    ["symlink", { ...identity, isSymbolicLink: () => true }],
  ] as const;
  it.each(invalid)("rejects %s metadata for reuse and cleanup", (_label, current) => {
    const owned = createOwnedTemporaryDirectory(root, "owned-");
    vi.mocked(fs.lstatSync).mockReturnValue(current as fs.BigIntStats);
    expect(() => owned.assertOwned()).toThrow(/ownership could not be verified/u);
    expect(owned.removeFile(child)).toBe(false);
    owned.dispose();
    // A later observation cannot revive an owner that already saw a mismatch.
    vi.mocked(fs.lstatSync).mockReturnValue(identity);
    expect(() => owned.assertOwned()).toThrow(/ownership could not be verified/u);
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it.each(["ENOENT", "EACCES"])("skips cleanup when ownership observation fails with %s", code => {
    const owned = createOwnedTemporaryDirectory(root, "owned-");
    vi.mocked(fs.lstatSync).mockImplementation(() => { throw Object.assign(new Error("unverifiable"), { code }); });
    owned.dispose();
    expect(owned.removeFile(child)).toBe(false);
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed canonical path without removing anything", () => {
    const owned = createOwnedTemporaryDirectory(root, "owned-");
    vi.mocked(fs.realpathSync).mockReturnValue(path.resolve("/different-observation"));
    expect(owned.removeFile(child)).toBe(false);
    owned.dispose();
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it("requires fresh ownership for each child cleanup and restricts children to the captured directory", () => {
    const owned = createOwnedTemporaryDirectory(root, "owned-");
    expect(owned.removeFile(path.join(root, "other.sqlite"))).toBe(false);
    expect(owned.removeFile(child)).toBe(true);
    vi.mocked(fs.lstatSync).mockReturnValue({ ...identity, ino: 9n });
    expect(owned.removeFile(`${child}-wal`)).toBe(false);
    expect(owned.removeFile(`${child}-shm`)).toBe(false);
    expect(fs.rmSync).toHaveBeenCalledTimes(1);
  });

  it.each(["identity", "canonical", "observation"])("does not clean up an unverified initial %s", failure => {
    if (failure === "identity") vi.mocked(fs.lstatSync).mockReturnValue({ ...identity, ino: 0n });
    if (failure === "canonical") vi.mocked(fs.realpathSync).mockImplementation(filename => String(filename) === root ? root : alias);
    if (failure === "observation") vi.mocked(fs.lstatSync).mockImplementation(() => { throw new Error("lstat failed"); });
    expect(() => createOwnedTemporaryDirectory(root, "owned-")).toThrow();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("preserves the original error even when cleanup and its diagnostic fail", () => {
    const owned = createOwnedTemporaryDirectory(root, "owned-");
    vi.mocked(fs.rmSync).mockImplementation(() => { throw new Error("cleanup failed"); });
    vi.mocked(console.warn).mockImplementation(() => { throw new Error("diagnostic failed"); });
    const failure = new Error("original operation failed");
    expect(() => { try { throw failure; } finally { owned.dispose(); } }).toThrow(failure);
    expect(owned.removeFile(child)).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

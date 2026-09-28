import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Windows reports a directory as EISDIR from open or read rather than through fstat, and a file
// can grow between fstat and read. Neither is reproducible on every host, so `open` is swapped
// for a fake while `readdir` and `realpath` stay real.
const fake = vi.hoisted(() => ({ open: undefined as (() => Promise<unknown>) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => fake.open?.() ?? actual.open(...args),
  };
});

const { READ_EXACT_MAX_BYTES, readExact } = await import("./read-exact.js");

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function handle(overrides: Partial<Record<"stat" | "read", () => Promise<unknown>>>): FileHandle {
  return {
    stat: overrides.stat ?? (() => Promise.resolve({ isFile: () => true, size: 1 })),
    read: overrides.read ?? (() => Promise.resolve({ bytesRead: 0 })),
    close: vi.fn(() => Promise.resolve()),
  } as unknown as FileHandle;
}

let base: string;
let vault: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "oms-read-exact-fs-")));
  vault = path.join(base, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(path.join(vault, "a.md"), "a");
});

afterEach(() => {
  fake.open = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe("readExact filesystem error mapping", () => {
  it("maps EISDIR at open time to READ_EXACT_NOT_FILE", async () => {
    fake.open = () => Promise.reject(errno("EISDIR"));
    await expect(readExact(vault, "a.md")).rejects.toMatchObject({ code: "READ_EXACT_NOT_FILE" });
  });

  it("maps EISDIR at read time to READ_EXACT_NOT_FILE and closes the handle", async () => {
    const opened = handle({ read: () => Promise.reject(errno("EISDIR")) });
    fake.open = () => Promise.resolve(opened);
    await expect(readExact(vault, "a.md")).rejects.toMatchObject({ code: "READ_EXACT_NOT_FILE" });
    expect(opened.close).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other open or read failure unchanged", async () => {
    fake.open = () => Promise.reject(errno("EACCES"));
    await expect(readExact(vault, "a.md")).rejects.toMatchObject({ code: "EACCES" });
    fake.open = () => Promise.resolve(handle({ read: () => Promise.reject(errno("EIO")) }));
    await expect(readExact(vault, "a.md")).rejects.toMatchObject({ code: "EIO" });
  });

  it("stops reading a file that grows past the cap after fstat", async () => {
    const read = vi.fn((buffer: Buffer) => Promise.resolve({ bytesRead: buffer.length }));
    const opened = handle({ read });
    fake.open = () => Promise.resolve(opened);
    await expect(readExact(vault, "a.md")).rejects.toMatchObject({ code: "READ_EXACT_TOO_LARGE" });
    expect(read.mock.calls.length * 64 * 1024).toBeLessThanOrEqual(READ_EXACT_MAX_BYTES + 64 * 1024);
    expect(opened.close).toHaveBeenCalledTimes(1);
  });

  it("accepts a file of exactly the cap", async () => {
    let remaining = READ_EXACT_MAX_BYTES;
    const read = vi.fn((buffer: Buffer) => {
      const bytesRead = Math.min(buffer.length, remaining);
      buffer.fill(0x61, 0, bytesRead);
      remaining -= bytesRead;
      return Promise.resolve({ bytesRead });
    });
    const opened = handle({ stat: () => Promise.resolve({ isFile: () => true, size: READ_EXACT_MAX_BYTES }), read });
    fake.open = () => Promise.resolve(opened);
    const result = await readExact(vault, "a.md");
    expect(result.content.length).toBe(READ_EXACT_MAX_BYTES);
    expect(opened.close).toHaveBeenCalledTimes(1);
  });
});

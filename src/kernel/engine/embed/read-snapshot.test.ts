import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createEngineStoreReadSnapshot, hashReadSnapshotFile } from "./read-snapshot.js";

vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, openSync: vi.fn(original.openSync), closeSync: vi.fn(original.closeSync), readSync: vi.fn(original.readSync), writeSync: vi.fn(original.writeSync), readFileSync: vi.fn(original.readFileSync), rmSync: vi.fn(original.rmSync) };
});

let root: string;
let source: string;
let original: typeof import("node:fs");
beforeEach(async () => {
  original = await vi.importActual<typeof import("node:fs")>("node:fs");
  root = original.mkdtempSync(path.join(tmpdir(), "oms-stream-snapshot-"));
  original.mkdirSync(path.join(root, "source"));
  source = path.join(root, "source", "index.sqlite");
  for (const key of ["openSync", "closeSync", "readSync", "writeSync", "readFileSync", "rmSync"] as const) vi.mocked(fs[key]).mockImplementation(original[key]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); original.rmSync(root, { recursive: true, force: true }); });

describe("bounded read-only database snapshots", () => {
  it("copies exact main/WAL bytes with bounded reads and no whole-image allocation", () => {
    const main = Buffer.alloc(5 * 1024 * 1024 + 17, 65);
    const wal = Buffer.alloc(2 * 1024 * 1024 + 31, 66);
    original.writeFileSync(source, main);
    original.writeFileSync(`${source}-wal`, wal);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("whole-image read is forbidden"); });
    const snapshot = createEngineStoreReadSnapshot(source)!;
    try {
      expect(original.readFileSync(snapshot.dbPath).equals(main)).toBe(true);
      expect(original.readFileSync(`${snapshot.dbPath}-wal`).equals(wal)).toBe(true);
      const reads = vi.mocked(fs.readSync).mock.calls;
      expect(reads.length).toBeGreaterThan(4);
      expect(Math.max(...reads.map(call => Number(call[3])))).toBeLessThanOrEqual(1024 * 1024);
      expect(original.readFileSync(source).equals(main)).toBe(true);
      expect(original.readFileSync(`${source}-wal`).equals(wal)).toBe(true);
    } finally { snapshot.dispose(); }
  });

  it("closes all admitted descriptors when a capture callback fails", () => {
    original.writeFileSync(source, "synthetic database bytes");
    const open = new Set<number>();
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => { const fd = original.openSync(...args); open.add(fd); return fd; });
    vi.mocked(fs.closeSync).mockImplementation(fd => { original.closeSync(fd); open.delete(fd); });
    const failure = new Error("injected after-read failure");
    expect(() => createEngineStoreReadSnapshot(source, { afterRead: () => { throw failure; } })).toThrow(failure);
    expect(open.size).toBe(0);
  });

  it("preserves a capture error if temporary cleanup fails and reports the residue", () => {
    const temporary = path.join(root, "temporary");
    original.mkdirSync(temporary); vi.stubEnv("TMPDIR", temporary);
    original.writeFileSync(source, "synthetic database bytes");
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(fs.rmSync).mockImplementation((filename, options) => {
      if (options?.recursive) throw new Error("injected cleanup failure");
      return original.rmSync(filename, options);
    });
    const failure = new Error("original capture failure");
    expect(() => createEngineStoreReadSnapshot(source, { afterRead: () => { throw failure; } })).toThrow(failure);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("OMS_TEMP_CLEANUP_SKIPPED"));
  });

  it("preserves an initial WAL reset error without attempting a capture", () => {
    original.writeFileSync(source, "synthetic database bytes");
    const failure = new Error("WAL reset failed");
    vi.mocked(fs.rmSync).mockImplementation((filename, options) => {
      if (!options?.recursive) throw failure;
      return original.rmSync(filename, options);
    });
    const afterRead = vi.fn();
    expect(() => createEngineStoreReadSnapshot(source, { afterRead })).toThrow(failure);
    expect(afterRead).not.toHaveBeenCalled();
  });

  it("handles short reads and writes without truncating the copy", () => {
    const bytes = Buffer.alloc(50_001, 97);
    original.writeFileSync(source, bytes);
    vi.mocked(fs.readSync).mockImplementation((fd, buffer, offset, length, position) =>
      original.readSync(fd, buffer, offset, Math.min(Number(length), 777), position));
    vi.mocked(fs.writeSync).mockImplementation((fd, buffer, offset, length, position) =>
      original.writeSync(fd, buffer, offset, Math.min(Number(length), 333), position));
    const snapshot = createEngineStoreReadSnapshot(source)!;
    try { expect(original.readFileSync(snapshot.dbPath).equals(bytes)).toBe(true); }
    finally { snapshot.dispose(); }
  });

  it("rejects a parent directory replacement restored around every source open", () => {
    original.writeFileSync(source, "original database bytes");
    original.mkdirSync(path.join(root, "replacement"));
    original.writeFileSync(path.join(root, "replacement", "index.sqlite"), "different database bytes");
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) !== source) return original.openSync(...args);
      original.renameSync(path.join(root, "source"), path.join(root, "holding"));
      original.renameSync(path.join(root, "replacement"), path.join(root, "source"));
      const fd = original.openSync(...args);
      original.renameSync(path.join(root, "source"), path.join(root, "replacement"));
      original.renameSync(path.join(root, "holding"), path.join(root, "source"));
      return fd;
    });
    expect(() => createEngineStoreReadSnapshot(source)).toThrow(/changed while capturing/u);
    expect(original.readFileSync(source, "utf8")).toBe("original database bytes");
  });

  it("removes an earlier attempt's WAL when a retry observes it absent", () => {
    original.writeFileSync(source, "stable main bytes");
    original.writeFileSync(`${source}-wal`, "old WAL bytes");
    let removed = false;
    const snapshot = createEngineStoreReadSnapshot(source, { afterRead: filename => {
      if (filename === `${source}-wal` && !removed) { original.unlinkSync(filename); removed = true; }
    } })!;
    try {
      expect(original.readFileSync(snapshot.dbPath, "utf8")).toBe("stable main bytes");
      expect(original.existsSync(`${snapshot.dbPath}-wal`)).toBe(false);
    } finally { snapshot.dispose(); }
  });

  it("retries if a WAL appears after its first observation", () => {
    original.writeFileSync(source, "stable main bytes");
    let mains = 0;
    const snapshot = createEngineStoreReadSnapshot(source, { afterRead: filename => {
      if (filename === source && ++mains === 2) original.writeFileSync(`${source}-wal`, "new WAL bytes");
    } })!;
    try {
      expect(mains).toBe(4);
      expect(original.readFileSync(`${snapshot.dbPath}-wal`, "utf8")).toBe("new WAL bytes");
    } finally { snapshot.dispose(); }
  });

  it("returns missing without creating a snapshot and rejects a directory source", () => {
    expect(createEngineStoreReadSnapshot(source)).toBeNull();
    original.mkdirSync(source);
    expect(() => createEngineStoreReadSnapshot(source)).toThrow(/changed while capturing/u);
  });

  it("byte-validates a source with deliberately coarse modification time", () => {
    original.writeFileSync(source, "coarse source bytes");
    original.utimesSync(source, new Date(0), new Date(0));
    vi.mocked(fs.readSync).mockClear();
    const snapshot = createEngineStoreReadSnapshot(source)!;
    try {
      expect(original.readFileSync(snapshot.dbPath, "utf8")).toBe("coarse source bytes");
      expect(vi.mocked(fs.readSync).mock.calls.length).toBe(2);
    } finally { snapshot.dispose(); }
  });

  it("fails and cleans up when a destination cannot make write progress", () => {
    original.writeFileSync(source, "stable source bytes");
    const destinations = new Set<string>();
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[1] === "w") destinations.add(String(args[0]));
      return original.openSync(...args);
    });
    vi.mocked(fs.writeSync).mockReturnValue(0);
    expect(() => createEngineStoreReadSnapshot(source)).toThrow(/complete an engine snapshot write/u);
    expect(destinations.size).toBe(1);
    for (const filename of destinations) expect(original.existsSync(path.dirname(filename))).toBe(false);
  });

  it("hashes large generation files through bounded reads without a temporary write", () => {
    expect(hashReadSnapshotFile(source)).toBeNull();
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 82);
    original.writeFileSync(source, bytes);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("whole-image read is forbidden"); });
    vi.mocked(fs.writeSync).mockClear();
    expect(hashReadSnapshotFile(source)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(vi.mocked(fs.writeSync)).not.toHaveBeenCalled();
  });

  it("retries a short end-of-file capture and publishes only the later complete bytes", () => {
    original.writeFileSync(source, Buffer.alloc(4000, 65));
    let shortened = false;
    vi.mocked(fs.readSync).mockImplementation((fd, buffer, offset, length, position) => {
      if (!shortened) { original.truncateSync(source, 2000); shortened = true; }
      return original.readSync(fd, buffer, offset, length, position);
    });
    const snapshot = createEngineStoreReadSnapshot(source)!;
    try {
      expect(original.readFileSync(snapshot.dbPath).equals(original.readFileSync(source))).toBe(true);
      expect(original.statSync(snapshot.dbPath).size).toBe(2000);
      expect(vi.mocked(fs.readSync).mock.results.some(result => result.value === 0)).toBe(true);
    } finally { snapshot.dispose(); }
  });

  it("propagates unreadable-file errors instead of returning a partial snapshot", () => {
    original.writeFileSync(source, "stable source bytes");
    const failure = Object.assign(new Error("injected permission failure"), { code: "EACCES" });
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === source) throw failure;
      return original.openSync(...args);
    });
    expect(() => createEngineStoreReadSnapshot(source)).toThrow(failure);
  });
});

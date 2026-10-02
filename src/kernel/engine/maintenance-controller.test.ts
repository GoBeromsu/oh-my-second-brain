import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaintenanceController, type MaintenanceHooks, type MaintenanceSchedule } from "./maintenance-controller.js";

const controllers: MaintenanceController[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(async () => { await Promise.allSettled(controllers.splice(0).map(controller => controller.stop())); vi.useRealTimers(); });

function setup(schedule: Partial<MaintenanceSchedule> = {}) {
  const live = new Map<string, string>();
  const stored = new Map<string, string | null>();
  const pending = new Set<string>();
  const events: string[] = [];
  let current = true;
  let change!: (relativePath?: string) => void;
  let failure!: (error: unknown) => void;
  const close = vi.fn(() => { events.push("watch-close"); });
  const hooks: MaintenanceHooks = {
    watch: vi.fn((onChange, onFailure) => { events.push("watch"); change = onChange; failure = onFailure; return { close }; }),
    scan: vi.fn(async () => { events.push("scan"); return new Map(live); }),
    sources: vi.fn(() => new Map(stored)),
    pending: vi.fn(() => [...pending]),
    maintain: vi.fn(async (relativePath, signal, isCurrent) => {
      expect(signal.aborted).toBe(false); expect(isCurrent()).toBe(true);
      if (!live.has(relativePath)) { stored.delete(relativePath); pending.delete(relativePath); return "deleted"; }
      stored.set(relativePath, live.get(relativePath)!); pending.add(relativePath); return "updated";
    }),
    embed: vi.fn(async (relativePath, signal, isCurrent) => {
      expect(signal.aborted).toBe(false); expect(isCurrent()).toBe(true);
      pending.delete(relativePath); return "updated";
    }),
    isCurrent: () => current,
    release: vi.fn(() => { events.push("release"); }),
  };
  const controller = new MaintenanceController({ mode: "lexical", ...schedule }, hooks);
  controllers.push(controller);
  return { controller, hooks, live, stored, pending, events, close, loseScope: () => { current = false; }, change: (value?: string) => change(value), fail: (error: unknown) => failure(error) };
}

describe("explicit maintenance scheduling", () => {
  it("does no work until started and registers watching before the first inventory", async () => {
    const f = setup(); f.live.set("a.md", "one");
    expect(f.events).toEqual([]);
    f.controller.start(); await f.controller.flush();
    expect(f.events.slice(0, 2)).toEqual(["watch", "scan"]);
    expect(f.controller.status()).toMatchObject({ phase: "idle", scans: 1, updated: 1, pendingVectors: 1 });
    expect(f.hooks.embed).not.toHaveBeenCalled();
    expect(() => f.controller.start()).toThrow("already");
  });

  it("coalesces rapid saves to the latest state and does not postpone the first deadline", async () => {
    const f = setup({ debounceMs: 100 }); f.controller.start(); await f.controller.flush();
    for (let i = 0; i < 10; i++) { f.live.set("a.md", String(i)); f.change("a.md"); await vi.advanceTimersByTimeAsync(9); }
    expect(f.controller.status().phase).toBe("catching-up");
    expect(f.hooks.maintain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.hooks.maintain).toHaveBeenCalledTimes(1);
    expect(f.stored.get("a.md")).toBe("9");
  });

  it("retains hints arriving during startup capture", async () => {
    const f = setup(); f.live.set("a.md", "one");
    let resolve!: (value: Map<string, string>) => void;
    vi.mocked(f.hooks.scan).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.controller.start(); const first = f.controller.flush();
    f.live.set("a.md", "two"); f.change("a.md");
    resolve(new Map([["a.md", "one"]])); await first;
    expect(f.controller.status().pendingHints).toBe(1);
    await f.controller.flush();
    expect(f.hooks.maintain).toHaveBeenCalledTimes(2);
    expect(f.stored.get("a.md")).toBe("two");
  });

  it("turns overflow, directories, missing filenames and unsafe paths into full reconciliation", async () => {
    const f = setup({ maxPendingPaths: 2 }); f.controller.start(); await f.controller.flush();
    for (const filename of ["a.md", "b.md", "c.md"]) { f.live.set(filename, "one"); f.change(filename); }
    expect(f.controller.status()).toMatchObject({ pendingHints: 0, needsScan: true });
    await f.controller.flush(); expect(f.stored.size).toBe(3);
    for (const filename of [undefined, "directory", "../outside.md", "/outside.md", "a//b.md", "C:\\outside.md"]) {
      f.change(filename); expect(f.controller.status().needsScan).toBe(true); await f.controller.flush();
    }
    expect(f.hooks.maintain).toHaveBeenCalledTimes(3);
  });
  it("handles uppercase Markdown extensions as bounded per-note hints", async () => {
    const f = setup(); f.controller.start(); await f.controller.flush();
    f.live.set("Note.MD", "one"); f.change("Note.MD"); await f.controller.flush();
    expect(f.stored.get("Note.MD")).toBe("one");
    expect(f.hooks.scan).toHaveBeenCalledOnce();
  });

  it("prunes only after a complete successful scan and reconciles lost rename/delete/recreate events", async () => {
    const f = setup({ reconcileMs: 100 });
    f.live.set("old.md", "one"); f.stored.set("old.md", "one"); f.controller.start(); await f.controller.flush();
    vi.mocked(f.hooks.scan).mockRejectedValueOnce(new Error("EACCES halfway through inventory"));
    f.change(); await f.controller.flush();
    expect(f.hooks.maintain).not.toHaveBeenCalled();
    expect(f.stored.has("old.md")).toBe(true);
    expect(f.controller.status()).toMatchObject({ phase: "backoff", needsScan: true });
    f.live.delete("old.md"); f.live.set("new.md", "one");
    await f.controller.flush();
    expect([...f.stored]).toEqual([["new.md", "one"]]);
    f.live.set("old.md", "two");
    await vi.advanceTimersByTimeAsync(101);
    expect(f.stored.get("old.md")).toBe("two");
  });

  it("recovers watcher failure through reattachment and complete reconciliation", async () => {
    const f = setup(); f.controller.start(); await f.controller.flush();
    f.fail(new Error("overflow"));
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.controller.status()).toMatchObject({ watching: false, needsScan: true, phase: "backoff" });
    f.live.set("missed.md", "one"); await f.controller.flush();
    expect(f.hooks.watch).toHaveBeenCalledTimes(2);
    expect(f.stored.has("missed.md")).toBe(true);
  });

  it("reports unsupported/synchronously failed watchers without claiming healthy ownership", async () => {
    const f = setup();
    vi.mocked(f.hooks.watch).mockImplementation(() => { throw new Error("unsupported"); });
    f.controller.start(); await f.controller.flush();
    expect(f.controller.status()).toMatchObject({ watching: false, phase: "backoff", lastError: expect.stringContaining("reconciliation") });
    const g = setup();
    vi.mocked(g.hooks.watch).mockImplementation((_change, fail) => { fail(new Error("failed during setup")); return { close: g.close }; });
    g.controller.start(); await g.controller.flush();
    expect(g.controller.status().watching).toBe(false);
    expect(g.close).toHaveBeenCalled();
  });

  it("backs off repeated watch failures instead of scanning the whole vault every debounce", async () => {
    const f = setup();
    vi.mocked(f.hooks.watch).mockImplementation(() => { throw new Error("unsupported watcher"); });
    f.controller.start(); await f.controller.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(f.hooks.scan).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(f.hooks.scan).mock.calls.length).toBeLessThanOrEqual(6);
    expect(f.controller.status()).toMatchObject({ phase: "backoff", watching: false });
  });

  it("backs off busy writers without losing work and coalesces concurrent flushes", async () => {
    const f = setup({ retryMs: 20, maxRetryMs: 30 }); f.live.set("a.md", "one");
    vi.mocked(f.hooks.maintain).mockRejectedValueOnce(new Error("writer busy"));
    f.controller.start(); await Promise.all([f.controller.flush(), f.controller.flush()]);
    expect(f.hooks.scan).toHaveBeenCalledOnce();
    expect(f.controller.status()).toMatchObject({ phase: "backoff", lastError: "writer busy" });
    await vi.advanceTimersByTimeAsync(30);
    expect(f.stored.get("a.md")).toBe("one");
    expect(f.controller.status().lastError).toBeUndefined();
  });

  it("limits embedding batches and prioritizes intervening lexical hints", async () => {
    const f = setup({ mode: "full", batchSize: 2 });
    for (const filename of ["a.md", "b.md", "c.md"]) { f.live.set(filename, "one"); f.pending.add(filename); }
    f.controller.start(); await f.controller.flush();
    expect(f.hooks.embed).toHaveBeenCalledTimes(2); expect(f.pending.size).toBe(1);
    expect(f.controller.status().phase).toBe("catching-up");
    const original = f.hooks.embed!;
    vi.mocked(f.hooks.embed!).mockImplementationOnce(async () => { f.change("a.md"); return "stale"; });
    await f.controller.flush();
    expect(f.controller.status()).toMatchObject({ needsScan: true, pendingHints: 1 });
    vi.mocked(f.hooks.embed!).mockImplementation(async filename => { f.pending.delete(filename); return "updated"; });
    await f.controller.flush();
    expect(original).toHaveBeenCalled();
  });

  it("cancels and drains before releasing, rejecting late completion after scope loss", async () => {
    const f = setup({ mode: "full" }); f.pending.add("a.md");
    let finish!: () => void; let sawAborted = false; let sawCurrent = true;
    vi.mocked(f.hooks.embed!).mockImplementation(async (_path, signal, isCurrent) => {
      await new Promise<void>(resolve => { finish = resolve; });
      sawAborted = signal.aborted; sawCurrent = isCurrent(); return "stale";
    });
    f.controller.start(); const running = f.controller.flush();
    await Promise.resolve(); await Promise.resolve();
    const stopped = f.controller.stop();
    expect(f.hooks.release).not.toHaveBeenCalled();
    finish(); await running; await stopped;
    expect(sawAborted).toBe(true); expect(sawCurrent).toBe(false);
    expect(f.hooks.release).toHaveBeenCalledOnce();
    expect(f.controller.status().phase).toBe("stopped");
  });

  it("bounds shutdown wait but holds ownership until an uncancellable provider drains", async () => {
    const f = setup({ mode: "full", shutdownMs: 10 }); f.pending.add("a.md");
    let finish!: () => void;
    vi.mocked(f.hooks.embed!).mockImplementation(() => new Promise(resolve => { finish = () => resolve("stale"); }));
    f.controller.start(); const running = f.controller.flush(); await Promise.resolve(); await Promise.resolve();
    const stopped = f.controller.stop(); const rejected = expect(stopped).rejects.toThrow("DRAIN_TIMEOUT");
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(f.hooks.release).not.toHaveBeenCalled();
    finish(); await running; await Promise.resolve();
    expect(f.hooks.release).toHaveBeenCalledOnce();
  });

  it("stops scheduling when ownership or model scope disappears", async () => {
    const f = setup(); f.controller.start(); await f.controller.flush();
    f.loseScope(); f.change("a.md"); await f.controller.flush();
    expect(f.controller.status()).toMatchObject({ phase: "failed", lastError: expect.stringContaining("SCOPE_LOST") });
    expect(f.hooks.release).toHaveBeenCalledOnce();
    f.change("b.md"); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.hooks.maintain).not.toHaveBeenCalled();
  });

  it.each(["debounceMs", "reconcileMs", "batchSize", "maxPendingPaths", "retryMs", "maxRetryMs", "shutdownMs"])("rejects invalid %s", key => {
    expect(() => setup({ [key]: 0 })).toThrow("positive");
  });
  it("refuses full mode without embedding and refuses unknown modes", () => {
    const f = setup();
    expect(() => new MaintenanceController({ mode: "full" }, { ...f.hooks, embed: undefined })).toThrow("embedding");
    expect(() => new MaintenanceController({ mode: "unknown" as "full" }, f.hooks)).toThrow("mode");
  });
});

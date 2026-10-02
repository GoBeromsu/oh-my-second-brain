import path from "node:path";

export type MaintenanceMode = "lexical" | "full";
export type MaintenanceChange = "updated" | "deleted" | "skipped" | "stale";

export interface MaintenanceStatus {
  readonly mode: MaintenanceMode;
  readonly phase: "starting" | "catching-up" | "idle" | "backoff" | "stopping" | "stopped" | "failed";
  readonly watching: boolean;
  readonly pendingHints: number;
  readonly needsScan: boolean;
  readonly pendingVectors: number;
  readonly scans: number;
  readonly updated: number;
  readonly deleted: number;
  readonly embedded: number;
  readonly lastError?: string;
}

export interface MaintenanceHooks {
  /** Register before scanning. Missing filenames and errors invalidate inventory. */
  watch(change: (relativePath?: string) => void, failure: (error: unknown) => void): { close(): void };
  /** Must resolve only after a complete, strict inventory; partial results throw. */
  scan(): Promise<ReadonlyMap<string, string>>;
  /** Source fingerprints in the existing store, including empty documents. */
  sources(): ReadonlyMap<string, string | null>;
  pending(): readonly string[];
  maintain(relativePath: string, signal: AbortSignal, isCurrent: () => boolean, purgeExcluded: boolean): Promise<MaintenanceChange>;
  embed?(relativePath: string, signal: AbortSignal, isCurrent: () => boolean): Promise<MaintenanceChange>;
  /** Separate owner token, immutable vault scope, and configured model identity. */
  isCurrent(): boolean;
  /** Called only after active work drains, even if stop() times out first. */
  release(): Promise<void> | void;
}

export interface MaintenanceSchedule {
  readonly mode: MaintenanceMode;
  readonly debounceMs?: number;
  readonly reconcileMs?: number;
  readonly maxPendingPaths?: number;
  readonly batchSize?: number;
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  readonly shutdownMs?: number;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(`Maintenance ${name} must be a positive safe integer.`);
  return selected;
}

function relativeNote(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").some(part => part === ".." || part === "." || part === "")) return undefined;
  return normalized.toLowerCase().endsWith(".md") ? normalized : undefined;
}

/**
 * Opt-in scheduler, never constructed by search. Watch events are only hints.
 * Queue overflow becomes reconciliation, and only complete scans admit pruning.
 */
export class MaintenanceController {
  private readonly debounceMs: number;
  private readonly reconcileMs: number;
  private readonly maxPendingPaths: number;
  private readonly batchSize: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly shutdownMs: number;
  private readonly abort = new AbortController();
  private readonly hints = new Set<string>();
  private watcher: { close(): void } | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private periodic: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private released = false;
  private needsScan = true;
  private failures = 0;
  private state: Omit<MaintenanceStatus, "pendingHints" | "needsScan" | "watching">;

  constructor(private readonly options: MaintenanceSchedule, private readonly hooks: MaintenanceHooks) {
    if (options.mode !== "lexical" && options.mode !== "full") throw new Error("Maintenance mode must be lexical or full.");
    if (options.mode === "full" && hooks.embed === undefined) throw new Error("Full maintenance requires an explicit embedding capability.");
    this.debounceMs = positive(options.debounceMs, 150, "debounceMs");
    this.reconcileMs = positive(options.reconcileMs, 30_000, "reconcileMs");
    this.maxPendingPaths = positive(options.maxPendingPaths, 2048, "maxPendingPaths");
    this.batchSize = positive(options.batchSize, 16, "batchSize");
    this.retryMs = positive(options.retryMs, 250, "retryMs");
    this.maxRetryMs = positive(options.maxRetryMs, 30_000, "maxRetryMs");
    this.shutdownMs = positive(options.shutdownMs, 5000, "shutdownMs");
    this.state = { mode: options.mode, phase: "starting", pendingVectors: 0, scans: 0, updated: 0, deleted: 0, embedded: 0 };
  }

  status(): MaintenanceStatus { return { ...this.state, watching: this.watcher !== undefined, pendingHints: this.hints.size, needsScan: this.needsScan }; }

  private current = (): boolean => {
    if (this.abort.signal.aborted) return false;
    try { return this.hooks.isCurrent(); } catch { return false; }
  };

  private assertCurrent(): void {
    if (!this.current()) throw new Error("MAINTENANCE_SCOPE_LOST: ownership, vault or model selection changed; restart explicit maintenance.");
  }

  /** Construction has no I/O; the explicit server startup owns this call. */
  start(): void {
    if (this.periodic !== undefined || this.abort.signal.aborted) throw new Error("Maintenance controller has already started or stopped.");
    this.assertCurrent();
    this.attachWatcher();
    this.periodic = setInterval(() => {
      this.needsScan = true;
      if (this.state.phase === "idle") this.state = { ...this.state, phase: "catching-up" };
      this.schedule(0);
    }, this.reconcileMs);
    this.periodic.unref();
    this.schedule(0);
  }

  private attachWatcher(): void {
    if (this.watcher !== undefined || this.abort.signal.aborted) return;
    try {
      let failed = false;
      const watcher = this.hooks.watch(relativePath => this.notify(relativePath), error => {
        failed = true;
        this.watcher?.close(); this.watcher = undefined;
        this.state = { ...this.state, phase: "backoff", lastError: `Watcher unavailable: ${error instanceof Error ? error.message : String(error)}` };
        this.needsScan = true;
        this.schedule(this.retryMs);
      });
      if (this.abort.signal.aborted || failed) watcher.close(); else this.watcher = watcher;
    } catch (error) {
      this.state = { ...this.state, phase: "backoff", lastError: `Watcher unavailable: ${error instanceof Error ? error.message : String(error)}` };
      this.needsScan = true;
    }
  }

  notify(relativePath?: string): void {
    if (this.abort.signal.aborted) return;
    const note = relativePath === undefined ? undefined : relativeNote(relativePath);
    if (note === undefined || this.hints.size >= this.maxPendingPaths) {
      this.hints.clear(); this.needsScan = true;
    } else this.hints.add(note);
    if (this.state.phase === "idle") this.state = { ...this.state, phase: "catching-up" };
    // The first event fixes the deadline; continuous edits cannot postpone it forever.
    this.schedule(this.debounceMs);
  }

  private schedule(delay: number): void {
    if (this.abort.signal.aborted || this.scheduled !== undefined || this.active !== undefined) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.flush();
    }, delay);
    this.scheduled.unref();
  }

  /** One bounded queue cycle; callers can await this without starting a second writer. */
  async flush(): Promise<void> {
    if (this.abort.signal.aborted) return;
    if (this.scheduled !== undefined) { clearTimeout(this.scheduled); this.scheduled = undefined; }
    if (this.active !== undefined) return this.active;
    const active = this.cycle();
    this.active = active;
    try { await active; }
    finally {
      this.active = undefined;
      if (!this.abort.signal.aborted) {
        if (this.state.phase === "backoff") this.schedule(Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(this.failures, 16)));
        else if (this.needsScan || this.hints.size > 0 || (this.options.mode === "full" && this.state.pendingVectors > 0)) this.schedule(this.debounceMs);
      }
    }
  }

  private record(result: MaintenanceChange): void {
    if (result === "updated") this.state = { ...this.state, updated: this.state.updated + 1 };
    if (result === "deleted") this.state = { ...this.state, deleted: this.state.deleted + 1 };
    if (result === "stale") this.needsScan = true;
  }

  private async apply(relativePath: string, purgeExcluded = false): Promise<void> {
    this.assertCurrent();
    this.record(await this.hooks.maintain(relativePath, this.abort.signal, this.current, purgeExcluded));
    this.assertCurrent();
  }

  private async cycle(): Promise<void> {
    try {
      this.assertCurrent();
      this.attachWatcher();
      this.state = { ...this.state, phase: "catching-up" };
      const full = this.needsScan;
      this.needsScan = false;
      const selected = [...this.hints]; this.hints.clear();
      if (full) {
        // Do not publish an incomplete walk as a deletion set. Events occurring
        // during this await remain in hints/needsScan for the next cycle.
        const snapshot = await this.hooks.scan();
        this.assertCurrent();
        this.state = { ...this.state, scans: this.state.scans + 1 };
        const stored = this.hooks.sources();
        let processed = 0;
        for (const [relativePath, fingerprint] of snapshot) {
          if (stored.get(relativePath) !== fingerprint) await this.apply(relativePath);
          if (++processed % this.batchSize === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
        // Only the complete inventory admits absent/excluded paths. The writer
        // rechecks actual existence and exclusion before publishing a deletion.
        for (const relativePath of stored.keys()) if (!snapshot.has(relativePath)) {
          await this.apply(relativePath, true);
          if (++processed % this.batchSize === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
      } else {
        for (let index = 0; index < selected.length; index++) {
          await this.apply(selected[index]!);
          if ((index + 1) % this.batchSize === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      this.assertCurrent();
      let pending = this.hooks.pending();
      if (this.options.mode === "full" && this.hints.size === 0 && !this.needsScan) {
        for (const relativePath of pending.slice(0, this.batchSize)) {
          if (this.hints.size > 0 || this.needsScan) break;
          this.assertCurrent();
          const result = await this.hooks.embed!(relativePath, this.abort.signal, this.current);
          this.assertCurrent();
          if (result === "updated") this.state = { ...this.state, embedded: this.state.embedded + 1 };
          if (result === "stale") this.needsScan = true;
        }
        pending = this.hooks.pending();
      }
      // Persistent watcher failure must not turn successful polling scans into
      // a 250 ms whole-vault loop. Back off until the normal interval-sized cap.
      this.failures = this.watcher === undefined ? this.failures + 1 : 0;
      const { lastError: _previousError, ...state } = this.state;
      const pendingWork = this.needsScan || this.hints.size > 0 || (this.options.mode === "full" && pending.length > 0);
      this.state = { ...state, pendingVectors: pending.length, phase: this.watcher === undefined ? "backoff" : pendingWork ? "catching-up" : "idle",
        ...(this.watcher === undefined ? { lastError: "Watcher unavailable; complete reconciliation remains active." } : {}) };
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.needsScan = true;
      this.failures++;
      this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error), phase: this.current() ? "backoff" : "failed" };
      if (this.state.phase === "failed") {
        this.abort.abort();
        this.watcher?.close(); this.watcher = undefined;
        if (this.periodic !== undefined) clearInterval(this.periodic);
        // The active cycle has unwound all awaited work at this point.
        await this.release();
      }
    }
  }

  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.hooks.release();
  }

  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.abort.abort();
    this.state = { ...this.state, phase: "stopping" };
    this.hints.clear();
    this.watcher?.close(); this.watcher = undefined;
    if (this.scheduled !== undefined) clearTimeout(this.scheduled);
    if (this.periodic !== undefined) clearInterval(this.periodic);
    const drained = (async () => {
      try { await this.active; }
      finally { await this.release(); this.state = { ...this.state, phase: "stopped" }; }
    })();
    // A provider may ignore cancellation. Reject on a bounded deadline while
    // retaining ownership until it drains; late completion still cannot commit.
    this.stopping = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MAINTENANCE_DRAIN_TIMEOUT: work is cancelled; ownership remains held until it drains.")), this.shutdownMs);
      drained.then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
    });
    return this.stopping;
  }
}

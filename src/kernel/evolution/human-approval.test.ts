import { describe, expect, expectTypeOf, it } from "vitest";
import {
  HUMAN_PROMPT_TIMEOUT_MS, isInteractive, parseHumanAnswer, runHumanSession, type HumanLine, type HumanPromptIO, type HumanSessionOutcome,
} from "./human-approval.js";

/** A terminal whose single read resolves with `line`, and whose clock fires only when told. */
function terminal(line: Promise<HumanLine> | undefined, extra: Partial<HumanPromptIO> = {}) {
  const written: string[] = [];
  const waits: number[] = [];
  let fire: () => void = () => undefined;
  let readAborted = false;
  const io: HumanPromptIO = {
    isTTY: true,
    env: {},
    write: text => { written.push(text); },
    readLine: signal => {
      signal.addEventListener("abort", () => { readAborted = true; });
      return line ?? new Promise<HumanLine>(() => undefined);
    },
    wait: ms => {
      waits.push(ms);
      return new Promise<void>(resolve => { fire = resolve; });
    },
    ...extra,
  };
  return { io, written, waits, fire: () => fire(), aborted: () => readAborted };
}

const line = (text: string): Promise<HumanLine> => Promise.resolve({ kind: "line", text });

describe("HumanSessionOutcome", () => {
  it("decides only approve or reject, and only a reject carries a reason", () => {
    expectTypeOf<HumanSessionOutcome["decision"]>().toEqualTypeOf<"approve" | "reject">();
    expectTypeOf<Extract<HumanSessionOutcome, { decision: "approve" }>>().not.toHaveProperty("reason");
    expectTypeOf<Extract<HumanSessionOutcome, { decision: "reject" }>["reason"]>()
      .toEqualTypeOf<"explicit" | "timeout" | "eof" | "non-tty" | "unknown-input" | "interrupted">();
  });
});

describe("parseHumanAnswer", () => {
  it.each(["approve", "y", "yes", " YES ", "Approve"])("approves %j", text => {
    expect(parseHumanAnswer(text)).toEqual({ decision: "approve" });
  });
  it.each(["reject", "n", "no", " No"])("rejects %j explicitly", text => {
    expect(parseHumanAnswer(text)).toEqual({ decision: "reject", reason: "explicit" });
  });
  it.each(["", "   ", "ok", "sure", "approved", "yess"])("does not read %j as an answer", text => {
    expect(parseHumanAnswer(text)).toEqual({ decision: "reject", reason: "unknown-input" });
  });
});

describe("isInteractive", () => {
  it("needs a real terminal and no OMS_NON_INTERACTIVE=1", () => {
    expect(isInteractive({ isTTY: true, env: {} })).toBe(true);
    expect(isInteractive({ isTTY: true, env: { OMS_NON_INTERACTIVE: "0" } })).toBe(true);
    expect(isInteractive({ isTTY: true, env: { OMS_NON_INTERACTIVE: "1" } })).toBe(false);
    expect(isInteractive({ isTTY: false, env: {} })).toBe(false);
    expect(isInteractive({ isTTY: undefined, env: {} })).toBe(false);
  });
});

describe("runHumanSession", () => {
  it("approves on an approving line, prompting once and stopping the clock", async () => {
    const t = terminal(line("yes"));
    expect(await runHumanSession(t.io, "Seal request r?")).toEqual({ decision: "approve" });
    expect(t.written).toHaveLength(1);
    expect(t.written[0]).toContain("Seal request r?");
    expect(t.waits).toEqual([HUMAN_PROMPT_TIMEOUT_MS]);
  });

  it("rejects explicitly or as unknown input", async () => {
    expect(await runHumanSession(terminal(line("no")).io, "q")).toEqual({ decision: "reject", reason: "explicit" });
    expect(await runHumanSession(terminal(line("")).io, "q")).toEqual({ decision: "reject", reason: "unknown-input" });
  });

  it("never prompts without a terminal", async () => {
    for (const extra of [{ isTTY: false }, { isTTY: undefined }, { env: { OMS_NON_INTERACTIVE: "1" } }] as const) {
      const t = terminal(line("yes"), extra);
      expect(await runHumanSession(t.io, "q")).toEqual({ decision: "reject", reason: "non-tty" });
      expect(t.written).toEqual([]);
      expect(t.waits).toEqual([]);
    }
  });

  it("times out after ten minutes on the injected clock and stops reading", async () => {
    const t = terminal(undefined);
    const session = runHumanSession(t.io, "q");
    await Promise.resolve();
    t.fire();
    expect(await session).toEqual({ decision: "reject", reason: "timeout" });
    expect(t.aborted()).toBe(true);
  });

  it("reports closed input as eof and Ctrl-C or a failed read as interrupted", async () => {
    expect(await runHumanSession(terminal(Promise.resolve({ kind: "eof" })).io, "q")).toEqual({ decision: "reject", reason: "eof" });
    expect(await runHumanSession(terminal(Promise.resolve({ kind: "interrupted" })).io, "q")).toEqual({ decision: "reject", reason: "interrupted" });
    expect(await runHumanSession(terminal(Promise.reject(new Error("read failed"))).io, "q")).toEqual({ decision: "reject", reason: "interrupted" });
  });

  it("reads a parser failure as unknown input", async () => {
    const t = terminal(line("yes"), { parse: () => { throw new Error("parser broke"); } });
    expect(await runHumanSession(t.io, "q")).toEqual({ decision: "reject", reason: "unknown-input" });
  });
});

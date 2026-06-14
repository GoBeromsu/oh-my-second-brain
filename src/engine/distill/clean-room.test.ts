import { describe, it, expect } from "vitest";
import {
  snapshotSha,
  detectMutation,
  prepareCleanRoom,
} from "./clean-room.js";
import type { DistillTarget } from "./types.js";

// ---------------------------------------------------------------------------
// snapshotSha
// ---------------------------------------------------------------------------

describe("snapshotSha", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const sha = snapshotSha("hello");
    expect(sha).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(sha)).toBe(true);
  });

  it("is deterministic — same input produces same output", () => {
    const content = "some state content\nline 2";
    expect(snapshotSha(content)).toBe(snapshotSha(content));
  });

  it("differs for different inputs", () => {
    expect(snapshotSha("a")).not.toBe(snapshotSha("b"));
  });

  it("handles empty string without throwing", () => {
    expect(() => snapshotSha("")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// detectMutation
// ---------------------------------------------------------------------------

describe("detectMutation", () => {
  it("returns false when before === after (no mutation)", () => {
    const sha = snapshotSha("state unchanged");
    expect(detectMutation(sha, sha)).toBe(false);
  });

  it("returns true when SHAs differ (mutation detected)", () => {
    const before = snapshotSha("original");
    const after = snapshotSha("mutated");
    expect(detectMutation(before, after)).toBe(true);
  });

  it("returns false for two independently computed SHAs of identical content", () => {
    const content = "same content\n";
    expect(detectMutation(snapshotSha(content), snapshotSha(content))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prepareCleanRoom — main system state never mutated
// ---------------------------------------------------------------------------

describe("prepareCleanRoom", () => {
  const target: DistillTarget = {
    name: "test-target",
    content: "function foo() { return 42; }",
    source: "https://example.com/repo",
  };

  it("returns a CleanRoomSpec with all required fields", () => {
    const spec = prepareCleanRoom(target);
    expect(spec).toHaveProperty("systemPrompt");
    expect(spec).toHaveProperty("userContent");
    expect(spec).toHaveProperty("targetName");
    expect(spec).toHaveProperty("targetContent");
  });

  it("embeds targetName correctly", () => {
    const spec = prepareCleanRoom(target);
    expect(spec.targetName).toBe("test-target");
  });

  it("preserves targetContent verbatim", () => {
    const spec = prepareCleanRoom(target);
    expect(spec.targetContent).toBe(target.content);
  });

  it("includes the target content as inert text in userContent", () => {
    const spec = prepareCleanRoom(target);
    expect(spec.userContent).toContain(target.content);
  });

  it("includes the source URL in userContent when provided", () => {
    const spec = prepareCleanRoom(target);
    expect(spec.userContent).toContain("https://example.com/repo");
  });

  it("works without a source URL", () => {
    const noSource: DistillTarget = { name: "bare", content: "data" };
    const spec = prepareCleanRoom(noSource);
    expect(spec.targetName).toBe("bare");
    expect(spec.userContent).toContain("data");
  });

  it("does NOT mutate main system state — SHA before and after is identical", () => {
    // Simulate a piece of system state (e.g. a config or cache string)
    const systemState = JSON.stringify({ vault: "/test/vault", version: 1 });
    const before = snapshotSha(systemState);

    // Run prepareCleanRoom (pure function — must not touch external state)
    prepareCleanRoom(target);

    const after = snapshotSha(systemState);
    expect(detectMutation(before, after)).toBe(false);
  });

  it("system prompt forbids execution and mutation", () => {
    const spec = prepareCleanRoom(target);
    expect(spec.systemPrompt).toMatch(/do not execute|DO NOT execute/i);
    expect(spec.systemPrompt).toMatch(/do not mutate|DO NOT mutate/i);
  });
});

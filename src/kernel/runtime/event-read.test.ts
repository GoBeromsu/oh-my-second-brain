import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "./event-journal.js";
import { readRuntimeEvents } from "./event-read.js";
import { RuntimeLedgerError } from "./event-types.js";

const roots: string[] = [];
const hostA = { username: "reader", hostname: "host-a" } as const;
const hostB = { username: "reader", hostname: "host-b" } as const;

function temporary(): string {
  const root = mkdtempSync(path.join(tmpdir(), "oms-event-read-"));
  roots.push(root);
  return root;
}

function vaultAt(root: string, name: string): string {
  const vault = path.join(root, name);
  mkdirSync(vault);
  writeFileSync(path.join(vault, "owned.md"), "owned\n");
  return vault;
}

function append(
  vaultPath: string,
  runtimeRoot: string,
  identity = hostA,
  input: Parameters<typeof createRuntimeEvent>[1] = { kind: "write", outcome: "success" },
) {
  const invocation = createRuntimeInvocation({ surface: "cli", operation: "write", gitCommit: null });
  const event = createRuntimeEvent(invocation, input);
  appendRuntimeEvent(event, { vaultPath, runtimeRoot, identity });
  return event;
}

function expectLedgerError(action: () => unknown, code: RuntimeLedgerError["code"]): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeLedgerError);
  expect(caught).toMatchObject({ code });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readRuntimeEvents", () => {
  it("returns an empty result without creating an absent runtime root", () => {
    const root = temporary();
    const vault = vaultAt(root, "vault");
    const runtimeRoot = path.join(root, "absent-runtime");
    expect(readRuntimeEvents({ vaultPath: vault, runtimeRoot, identity: hostA })).toEqual({ events: [], partial: false });
    expect(existsSync(runtimeRoot)).toBe(false);
    expect(readdirSync(vault)).toEqual(["owned.md"]);
  });

  it("seals symlinked roots on an absent query without creating vault paths", () => {
    const root = temporary();
    const vault = vaultAt(root, "vault");
    const runtimeRoot = path.join(root, "runtime-link");
    symlinkSync(vault, runtimeRoot, "dir");
    expectLedgerError(
      () => readRuntimeEvents({ vaultPath: vault, runtimeRoot, identity: hostA }),
      "LEDGER_ROOT_INSIDE_VAULT",
    );
    expect(readdirSync(vault)).toEqual(["owned.md"]);
  });

  it("returns stored identity and registration fields without inventing mutation time", () => {
    const root = temporary();
    const vault = vaultAt(root, "vault");
    const runtimeRoot = path.join(root, "runtime");
    const source = append(vault, runtimeRoot, hostA, {
      kind: "external-change-observed",
      outcome: "observation-gap",
      eventTime: null,
      changedBetweenFrom: "2026-01-01T00:00:00.000Z",
      changedBetweenTo: "2026-01-03T00:00:00.000Z",
      inputSignature: `sha256:${"a".repeat(64)}`,
      templateSignature: `sha256:${"b".repeat(64)}`,
    });
    const result = readRuntimeEvents({ vaultPath: vault, runtimeRoot, identity: hostA });
    expect(result.partial).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: source.eventId,
      eventTime: null,
      outcome: "observation-gap",
      changedBetweenFrom: "2026-01-01T00:00:00.000Z",
      changedBetweenTo: "2026-01-03T00:00:00.000Z",
      inputSignature: `sha256:${"a".repeat(64)}`,
      templateSignature: `sha256:${"b".repeat(64)}`,
    });
    expect(result.events[0]!.hostId).toMatch(/^[a-f0-9]{32}$/);
    expect(result.events[0]!.vaultFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(result.events[0]!.registeredAt)).not.toBeNaN();
    expect(result.events[0]!.registeredAt >= result.events[0]!.observedAt).toBe(true);
  });

  it("filters strictly by current host and real vault fingerprint", () => {
    const root = temporary();
    const vaultA = vaultAt(root, "vault-a");
    const vaultB = vaultAt(root, "vault-b");
    const runtimeRoot = path.join(root, "runtime");
    const eventA = append(vaultA, runtimeRoot, hostA, { kind: "a", outcome: "success" });
    append(vaultB, runtimeRoot, hostA, { kind: "other-vault", outcome: "success" });
    append(vaultA, runtimeRoot, hostB, { kind: "other-host", outcome: "success" });
    expect(readRuntimeEvents({ vaultPath: vaultA, runtimeRoot, identity: hostA }).events.map(item => item.eventId)).toEqual([eventA.eventId]);
    expect(readRuntimeEvents({ vaultPath: vaultB, runtimeRoot, identity: hostA }).events.map(item => item.kind)).toEqual(["other-vault"]);
    expect(readRuntimeEvents({ vaultPath: vaultA, runtimeRoot, identity: hostB }).events.map(item => item.kind)).toEqual(["other-host"]);
  });

  it("supports filters and marks an explicitly limited result as partial", () => {
    const root = temporary();
    const vault = vaultAt(root, "vault");
    const runtimeRoot = path.join(root, "runtime");
    append(vault, runtimeRoot, hostA, { kind: "write", outcome: "failure" });
    append(vault, runtimeRoot, hostA, { kind: "write", outcome: "success" });
    append(vault, runtimeRoot, hostA, { kind: "check", outcome: "unchanged" });
    const limited = readRuntimeEvents({ vaultPath: vault, runtimeRoot, identity: hostA, kinds: ["write"], limit: 1 });
    expect(limited.events).toHaveLength(1);
    expect(limited.partial).toBe(true);
    expect(readRuntimeEvents({ vaultPath: vault, runtimeRoot, identity: hostA, outcomes: ["unchanged"] }).events.map(item => item.kind)).toEqual(["check"]);
  });

  it("does not apply TTL and returns the complete history by default", () => {
    const root = temporary();
    const vault = vaultAt(root, "vault");
    const runtimeRoot = path.join(root, "runtime");
    append(vault, runtimeRoot, hostA, { kind: "old", outcome: "success", eventTime: "1999-01-01T00:00:00.000Z" });
    append(vault, runtimeRoot, hostA, { kind: "current", outcome: "success", eventTime: "2026-01-01T00:00:00.000Z" });
    const result = readRuntimeEvents({ vaultPath: vault, runtimeRoot, identity: hostA });
    expect(result.events.map(item => item.kind).sort()).toEqual(["current", "old"]);
    expect(result.partial).toBe(false);
  });
});

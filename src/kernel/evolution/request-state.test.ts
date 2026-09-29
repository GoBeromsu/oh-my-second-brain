import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LineageEvent } from "../contract/lineage.js";
import { digestBytes } from "../conventions/canonical.js";
import { manifestDigestOf } from "../contract/digest.js";
import { candidateManifest } from "../contract/store.js";
import type { PropertyContract, VaultContract } from "../contract/types.js";
import { readEvolutionEvents } from "./events.js";
import {
  createRequest, effectiveState, assertActive, listRequests, readPinnedCandidate, readRequest, REQUEST_TTL_MS,
  settleRequest, transition, writeRequest, type RequestDeps, type RequestRecord,
} from "./request-state.js";

const ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-evo-request-")));
  root = join(base, "home", ".oms", "vaults");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const status = (values: string[]): PropertyContract => ({ meaning: "state", type: "text", default: false, required: false, rules: [{ kind: "allowed", values }] });
const PARENT: VaultContract = { folders: { Projects: { meaning: "projects", searchExclude: false } }, properties: { status: status(["a", "b"]) } };
const CANDIDATE: VaultContract = { ...PARENT, properties: { status: status(["a"]) } };
const OTHER: VaultContract = { ...PARENT, properties: { status: status(["b"]) } };
const PARENT_DIGEST = candidateManifest(PARENT).digest;
const CANDIDATE_DIGEST = candidateManifest(CANDIDATE).digest;
const OTHER_DIGEST = candidateManifest(OTHER).digest;
const NOW = 1_700_000_000_000;
const evolutionDir = (): string => join(root, `.${ID}.state`, "evolution");

let counter = 0;
function deps(now = NOW): RequestDeps {
  return {
    now: () => now,
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    newToken: () => (++counter).toString(16).padStart(32, "0"),
  };
}

function event(eventSeq: number, parentDigest: string, digest: string, extra: Partial<LineageEvent> = {}): LineageEvent {
  return { eventSeq, kind: "sealed", generation: eventSeq, parentDigest, digest, mutations: [], manifestDigests: {}, ...extra } as LineageEvent;
}

const HISTORY: LineageEvent[] = [event(1, "none", PARENT_DIGEST)];

async function issue(state?: "open" | "awaiting-human", kind: "evolve" | "revert" = "evolve"): Promise<RequestRecord> {
  return createRequest(root, ID, {
    kind, contract: CANDIDATE, mutations: [], parent: { eventSeq: 1, digest: PARENT_DIGEST }, ...(state ? { state } : {}),
    ...(kind === "revert" ? { revertOf: OTHER_DIGEST as never } : {}),
  }, deps());
}

describe("createRequest", () => {
  it("pins the candidate bytes, stores a private state and records the issue", async () => {
    const request = await issue();
    expect(request).toMatchObject({ version: 1, kind: "evolve", state: "open", issuedAt: NOW, expiresAt: NOW + REQUEST_TTL_MS, parentEventSeq: 1, expectedParentDigest: PARENT_DIGEST, candidateDigest: CANDIDATE_DIGEST, usedSlots: [], verdicts: [] });
    expect(request.slots).toHaveLength(3);
    expect(new Set([request.nonce, ...request.slots]).size).toBe(4);
    const directory = join(evolutionDir(), "pending", request.requestId);
    expect((await stat(join(directory, "state.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "candidate", "manifest.json"), "utf8")).toBe(candidateManifest(CANDIDATE).manifestText);
    expect(await readRequest(root, ID, request.requestId)).toEqual(request);
    const events = (await readEvolutionEvents(root, ID)).events;
    expect(events.map(item => item.kind)).toEqual(["request.issued"]);
    expect(events[0]).toMatchObject({ requestId: request.requestId, detail: { candidateDigest: CANDIDATE_DIGEST, parentEventSeq: 1 } });
  });

  it("issues straight into awaiting-human and records it", async () => {
    const request = await issue("awaiting-human");
    expect(request.state).toBe("awaiting-human");
    expect((await readEvolutionEvents(root, ID)).events.map(item => item.kind)).toEqual(["request.issued", "request.awaiting-human"]);
  });

  it("stores the digest a revert restores and refuses a revert without one", async () => {
    expect((await issue(undefined, "revert")).revertOf).toBe(OTHER_DIGEST);
    await expect(createRequest(root, ID, { kind: "revert", contract: CANDIDATE, mutations: [], parent: { eventSeq: 1, digest: PARENT_DIGEST } }, deps())).rejects.toThrow(/^EVOLUTION_REQUEST_INVALID:/);
  });

  it("refuses a malformed id, repeated tokens and an id already in use", async () => {
    await expect(createRequest(root, ID, { kind: "evolve", contract: CANDIDATE, mutations: [], parent: { eventSeq: 0, digest: "none" } }, { ...deps(), newId: () => "../x" })).rejects.toThrow(/^EVOLUTION_REQUEST_UNKNOWN:/);
    await expect(createRequest(root, ID, { kind: "evolve", contract: CANDIDATE, mutations: [], parent: { eventSeq: 0, digest: "none" } }, { ...deps(), newToken: () => "a".repeat(32) })).rejects.toThrow(/^EVOLUTION_REQUEST_INVALID:/);
    const fixed = { ...deps(), newId: () => "00000000-0000-4000-8000-00000000abcd" };
    await createRequest(root, ID, { kind: "evolve", contract: CANDIDATE, mutations: [], parent: { eventSeq: 0, digest: "none" } }, fixed);
    await expect(createRequest(root, ID, { kind: "evolve", contract: CANDIDATE, mutations: [], parent: { eventSeq: 0, digest: "none" } }, fixed)).rejects.toThrow(/already exists/);
  });
});

describe("reading requests", () => {
  it("reads an absent request as null and creates nothing", async () => {
    expect(await readRequest(root, ID, "00000000-0000-4000-8000-000000000001")).toBeNull();
    expect(await listRequests(root, ID)).toEqual({ records: [], invalid: [] });
    await expect(stat(evolutionDir())).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(evolutionDir(), { recursive: true, mode: 0o700 });
    expect(await listRequests(root, ID)).toEqual({ records: [], invalid: [] });
    await mkdir(join(evolutionDir(), "pending", "00000000-0000-4000-8000-000000000001"), { recursive: true });
    expect(await readRequest(root, ID, "00000000-0000-4000-8000-000000000001")).toBeNull();
  });

  it("refuses a malformed state and lists it as invalid", async () => {
    const request = await issue();
    const path = join(evolutionDir(), "pending", request.requestId, "state.json");
    await writeFile(path, "{");
    await expect(readRequest(root, ID, request.requestId)).rejects.toThrow(/^EVOLUTION_REQUEST_INVALID: .*not JSON/);
    await writeFile(path, JSON.stringify({ ...request, state: "done" }));
    await expect(readRequest(root, ID, request.requestId)).rejects.toThrow(/^EVOLUTION_REQUEST_INVALID: .*schema/);
    await writeFile(path, JSON.stringify({ ...request, requestId: "00000000-0000-4000-8000-000000000999" }));
    await expect(readRequest(root, ID, request.requestId)).rejects.toThrow(/schema/);
    await writeFile(path, " ".repeat(1024 * 1024 + 1));
    await expect(readRequest(root, ID, request.requestId)).rejects.toThrow(/too large/);
    await mkdir(join(evolutionDir(), "pending", "stray"));
    const listing = await listRequests(root, ID);
    expect(listing.records).toEqual([]);
    expect(listing.invalid.map(item => item.name).sort()).toEqual([request.requestId, "stray"].sort());
  });

  it.each([
    ["a bad verdict", { verdicts: [{ slot: 0 }] }],
    ["a bad seal attempt", { sealAttempt: { requestId: "x" } }],
    ["a seal attempt with a bad time", { sealAttempt: { requestId: "x", parentEventSeq: 1, candidateDigest: CANDIDATE_DIGEST, mode: "human", at: -1 } }],
    ["a bad revert digest", { revertOf: "nope" }],
    ["a bad maker", { makerSessionId: 3 }],
    ["a bad reject reason", { rejectReason: 3 }],
    ["a wrong kind", { kind: "grow" }],
    ["a revert without its target", { kind: "revert" }],
  ])("refuses %s", async (_name, change) => {
    const request = await issue();
    await writeFile(join(evolutionDir(), "pending", request.requestId, "state.json"), JSON.stringify({ ...request, ...change }));
    await expect(readRequest(root, ID, request.requestId)).rejects.toThrow(/^EVOLUTION_REQUEST_INVALID:/);
  });

  it("lists requests oldest first and notes a request directory without state", async () => {
    const later = await createRequest(root, ID, { kind: "evolve", contract: OTHER, mutations: [], parent: { eventSeq: 1, digest: PARENT_DIGEST } }, deps(NOW + 5));
    const earlier = await issue();
    await mkdir(join(evolutionDir(), "pending", "00000000-0000-4000-8000-00000000ffff"));
    const listing = await listRequests(root, ID);
    expect(listing.records.map(item => item.requestId)).toEqual([earlier.requestId, later.requestId]);
    expect(listing.invalid).toEqual([{ name: "00000000-0000-4000-8000-00000000ffff", reason: "no state.json" }]);
  });

  it("refuses a symlinked state file, request directory or pending directory", async () => {
    const request = await issue();
    const pending = join(evolutionDir(), "pending");
    const state = join(pending, request.requestId, "state.json");
    await writeFile(join(base, "target.json"), JSON.stringify(request));
    await rm(state);
    await symlink(join(base, "target.json"), state);
    await expect(readRequest(root, ID, request.requestId)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await expect(writeRequest(root, ID, request)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await rm(join(pending, request.requestId), { recursive: true });
    await mkdir(join(base, "elsewhere"));
    await symlink(join(base, "elsewhere"), join(pending, request.requestId));
    await expect(readRequest(root, ID, request.requestId)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await rm(pending, { recursive: true });
    await symlink(join(base, "elsewhere"), pending);
    await expect(listRequests(root, ID)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await expect(issue()).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
    await rm(pending);
    await writeFile(pending, "");
    await expect(readRequest(root, ID, request.requestId)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
  });

  it("refuses to write an unknown request", async () => {
    const request = await issue();
    await expect(writeRequest(root, ID, { ...request, requestId: "00000000-0000-4000-8000-000000000777" })).rejects.toThrow(/^EVOLUTION_REQUEST_UNKNOWN:/);
  });
});

describe("transitions", () => {
  it("allows only the documented moves", async () => {
    const open = await issue();
    expect(transition(open, "awaiting-human").state).toBe("awaiting-human");
    expect(transition(open, "sealed").state).toBe("sealed");
    expect(transition(open, "expired").state).toBe("expired");
    expect(() => transition(open, "rejected")).toThrow(/^EVOLUTION_REQUEST_TRANSITION_INVALID:/);
    const waiting = transition(open, "awaiting-human");
    expect(transition(waiting, "rejected", { rejectReason: "explicit" })).toMatchObject({ state: "rejected", rejectReason: "explicit" });
    expect(transition(waiting, "sealed").state).toBe("sealed");
    expect(() => transition(waiting, "expired")).toThrow(/TRANSITION_INVALID/);
    expect(() => transition(waiting, "open")).toThrow(/TRANSITION_INVALID/);
  });

  it.each(["sealed", "superseded", "expired", "rejected"] as const)("refuses every move out of %s", async state => {
    const closed = { ...await issue(), state };
    for (const to of ["open", "awaiting-human", "sealed", "rejected"] as const) {
      expect(() => transition(closed, to)).toThrow(expect.objectContaining({ code: "EVOLUTION_REQUEST_CLOSED", state }));
    }
  });
});

describe("effectiveState", () => {
  it("stays open until the TTL and expires at it", async () => {
    const request = await issue();
    expect(effectiveState(request, HISTORY, request.expiresAt - 1)).toBe("open");
    expect(effectiveState(request, HISTORY, request.expiresAt)).toBe("expired");
  });

  it("keeps an expired request expired after it is settled and re-read, even with the clock back", async () => {
    const request = await issue();
    const settled = await settleRequest(root, ID, request, HISTORY, request.expiresAt);
    expect(settled.state).toBe("expired");
    const reread = await readRequest(root, ID, request.requestId);
    expect(reread?.state).toBe("expired");
    expect(effectiveState(reread!, HISTORY, NOW)).toBe("expired");
    expect((await readEvolutionEvents(root, ID)).events.map(item => item.kind)).toEqual(["request.issued", "request.expired"]);
  });

  it("leaves awaiting-human without a TTL", async () => {
    const request = await issue("awaiting-human");
    expect(effectiveState(request, HISTORY, NOW + 30 * 24 * 60 * 60 * 1000)).toBe("awaiting-human");
  });

  it("supersedes when the lineage moves, including a return to the same digest", async () => {
    const request = await issue();
    const moved = [...HISTORY, event(2, PARENT_DIGEST, OTHER_DIGEST)];
    expect(effectiveState(request, moved, NOW)).toBe("superseded");
    const back = [...moved, event(3, OTHER_DIGEST, PARENT_DIGEST, { revertOf: PARENT_DIGEST as never })];
    expect(effectiveState(request, back, NOW)).toBe("superseded");
    const waiting = { ...request, state: "awaiting-human" as const };
    expect(effectiveState(waiting, back, NOW)).toBe("superseded");
    expect(effectiveState(request, [], NOW)).toBe("superseded");
  });

  it("settles and records a supersede", async () => {
    const request = await issue();
    const moved = [...HISTORY, event(2, PARENT_DIGEST, OTHER_DIGEST)];
    expect((await settleRequest(root, ID, request, moved, NOW)).state).toBe("superseded");
    const events = (await readEvolutionEvents(root, ID)).events;
    expect(events.at(-1)).toMatchObject({ kind: "request.superseded", requestId: request.requestId, detail: { parentEventSeq: 1, tailEventSeq: 2, tailDigest: OTHER_DIGEST } });
    expect(await settleRequest(root, ID, (await readRequest(root, ID, request.requestId))!, moved, NOW)).toMatchObject({ state: "superseded" });
    expect((await readEvolutionEvents(root, ID)).events).toHaveLength(events.length);
  });

  it("reads a seal naming the request as sealed, whatever came after", async () => {
    const request = await issue();
    const lineage = [...HISTORY, event(2, PARENT_DIGEST, CANDIDATE_DIGEST, { requestId: request.requestId }), event(3, CANDIDATE_DIGEST, OTHER_DIGEST)];
    expect(effectiveState(request, lineage, request.expiresAt + 1)).toBe("sealed");
    expect(effectiveState({ ...request, state: "expired" }, lineage, NOW)).toBe("sealed");
  });

  it("reads the same digest sealed right after the parent as sealed before anything else", async () => {
    const request = await issue();
    const human = [...HISTORY, event(2, PARENT_DIGEST, CANDIDATE_DIGEST)];
    expect(effectiveState(request, human, request.expiresAt + 1)).toBe("sealed");
    const otherRequest = [...HISTORY, event(2, PARENT_DIGEST, CANDIDATE_DIGEST, { requestId: "00000000-0000-4000-8000-000000000999" })];
    expect(effectiveState(request, otherRequest, NOW)).toBe("superseded");
    const later = [...HISTORY, event(2, PARENT_DIGEST, OTHER_DIGEST), event(3, OTHER_DIGEST, CANDIDATE_DIGEST)];
    expect(effectiveState(request, later, NOW)).toBe("superseded");
  });

  it("reads an unrecorded seal as sealed only when this request attempted it", async () => {
    const request = await issue();
    const recovered = [...HISTORY, event(2, PARENT_DIGEST, CANDIDATE_DIGEST, { kind: "recovered", reason: "unrecorded-seal" })];
    expect(effectiveState(request, recovered, NOW)).toBe("superseded");
    const attempted = { ...request, sealAttempt: { requestId: request.requestId, parentEventSeq: 1, candidateDigest: CANDIDATE_DIGEST, mode: "autonomous" as const } };
    expect(effectiveState(attempted, recovered, NOW)).toBe("sealed");
    const bootstrap = [...HISTORY, event(2, PARENT_DIGEST, CANDIDATE_DIGEST, { kind: "recovered", reason: "bootstrap" })];
    expect(effectiveState(attempted, bootstrap, NOW)).toBe("superseded");
    const elsewhere = { ...attempted, sealAttempt: { ...attempted.sealAttempt, parentEventSeq: 4 } };
    expect(effectiveState(elsewhere, recovered, NOW)).toBe("superseded");
  });

  it("keeps a persisted terminal state", async () => {
    const request = { ...await issue("awaiting-human"), state: "rejected" as const };
    expect(effectiveState(request, HISTORY, NOW)).toBe("rejected");
  });

  it("assertActive refuses a closed or derived-closed request with its state", async () => {
    const request = await issue();
    expect(assertActive(request, HISTORY, NOW, ["open"])).toBe("open");
    expect(() => assertActive(request, [...HISTORY, event(2, PARENT_DIGEST, OTHER_DIGEST)], NOW, ["open"])).toThrow(expect.objectContaining({ code: "EVOLUTION_REQUEST_CLOSED", state: "superseded" }));
    expect(() => assertActive(request, HISTORY, NOW, ["awaiting-human"])).toThrow(/^EVOLUTION_REQUEST_CLOSED: .* is open/);
  });
});

describe("readPinnedCandidate", () => {
  it("returns the pinned contract", async () => {
    const request = await issue();
    const pinned = await readPinnedCandidate(root, ID, request);
    expect(pinned.digest).toBe(CANDIDATE_DIGEST);
    expect(candidateManifest(pinned.contract, pinned.declined).digest).toBe(CANDIDATE_DIGEST);
  });

  it("refuses altered, extra, missing or mismatched bytes", async () => {
    const request = await issue();
    const candidate = join(evolutionDir(), "pending", request.requestId, "candidate");
    const files = (await readdir(candidate, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && entry.name !== "manifest.json");
    const victim = join(files[0]!.parentPath, files[0]!.name);
    const original = await readFile(victim, "utf8");
    await writeFile(victim, `${original} `);
    await expect(readPinnedCandidate(root, ID, request)).rejects.toThrow(/^EVOLUTION_CANDIDATE_MISMATCH: .*altered/);
    await writeFile(victim, original);
    await writeFile(join(candidate, "extra.json"), "{}");
    await expect(readPinnedCandidate(root, ID, request)).rejects.toThrow(/^EVOLUTION_CANDIDATE_MISMATCH:/);
    await rm(join(candidate, "extra.json"));
    await expect(readPinnedCandidate(root, ID, { ...request, candidateDigest: OTHER_DIGEST })).rejects.toThrow(/^EVOLUTION_CANDIDATE_MISMATCH:/);
    await rm(join(candidate, "manifest.json"));
    await expect(readPinnedCandidate(root, ID, request)).rejects.toThrow(/^EVOLUTION_CANDIDATE_MISMATCH:/);
    await rm(candidate, { recursive: true });
    await expect(readPinnedCandidate(root, ID, request)).rejects.toThrow(/no pinned candidate/);
    await expect(readPinnedCandidate(root, ID, { ...request, requestId: "00000000-0000-4000-8000-000000000777" })).rejects.toThrow(/^EVOLUTION_REQUEST_UNKNOWN:/);
  });

  it("refuses a pinned candidate replaced by a symlink", async () => {
    const request = await issue();
    const candidate = join(evolutionDir(), "pending", request.requestId, "candidate");
    await rm(candidate, { recursive: true });
    await mkdir(join(base, "fake"));
    await symlink(join(base, "fake"), candidate);
    await expect(readPinnedCandidate(root, ID, request)).rejects.toMatchObject({ code: "STATE_DIR_UNSAFE" });
  });
  async function repin(request: RequestRecord, files: Record<string, string>, version = 3): Promise<RequestRecord> {
    const candidate = join(evolutionDir(), "pending", request.requestId, "candidate");
    await rm(candidate, { recursive: true });
    await mkdir(candidate);
    const digests: Record<string, string> = {};
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(candidate, path, ".."), { recursive: true });
      await writeFile(join(candidate, path), text);
      digests[path] = digestBytes(text);
    }
    const manifest = JSON.stringify({ version, files: digests });
    await writeFile(join(candidate, "manifest.json"), manifest);
    return { ...request, candidateDigest: manifestDigestOf(manifest) };
  }

  it("refuses consistent bytes that do not form a current contract", async () => {
    const request = await issue();
    const invalid = await repin(request, { "unknown.json": "{}" });
    await expect(readPinnedCandidate(root, ID, invalid)).rejects.toThrow(/not a current contract/);
  });

  it("refuses consistent bytes that sealing would not reproduce", async () => {
    const request = await issue();
    const files = Object.fromEntries(candidateManifest(CANDIDATE).files);
    const reformatted = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, `${JSON.stringify(JSON.parse(text), null, 4)}\n`]));
    const pinned = await repin(request, reformatted);
    await expect(readPinnedCandidate(root, ID, pinned)).rejects.toThrow(/does not reproduce its digest/);
  });
});

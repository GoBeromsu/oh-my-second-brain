/**
 * Apply tests — the optimistic-concurrency and splice contract.
 *
 * The rule that matters most: a stale `baseContentHash` must produce ZERO
 * writes. Suggestions are computed against a snapshot of the body; if the note
 * moved underneath us, every offset in those candidates points at the wrong
 * text, and applying them silently corrupts the note.
 */

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { applyLinks, hashBody } from "./apply.js";
import type { LinkifyWriteTarget, WriteNoteLike } from "./apply.js";
import type { WriteNoteInput, WriteNoteResult, WriteStatus } from "../../capture/safe.js";
import type { LinkCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGET: LinkifyWriteTarget = {
  target: { vault: "/tmp/vault", source: "explicit" },
  ontology: { concepts: new Map(), taxonomy: { version: 1, folders: {} } },
  notePath: "notes/Sage.md",
};

/** A full kernel result so the fake writer honours the real contract shape. */
function kernelResult(status: WriteStatus, input: WriteNoteInput, reason?: string): WriteNoteResult {
  return {
    status,
    mode: input.mode,
    notePath: input.notePath ?? "",
    concept: "term",
    folder: "notes",
    fields: [],
    frontmatter: {},
    missingFields: [],
    violations: [],
    ...(reason === undefined ? {} : { reason }),
  };
}

/** A writeNote spy that records calls and returns a canned success. */
function spyWriter(): { readonly fn: WriteNoteLike; readonly calls: WriteNoteInput[] } {
  const calls: WriteNoteInput[] = [];
  const fn: WriteNoteLike = (input) => {
    calls.push(input);
    return Promise.resolve(kernelResult("written", input));
  };
  return { fn, calls };
}

function candidate(partial: Partial<LinkCandidate> & Pick<LinkCandidate, "startOffset" | "endOffset" | "matchedText" | "renderedReplacement">): LinkCandidate {
  return {
    targetPath: "terms/Ataraxia.md",
    source: "basename",
    confidence: 0.9,
    ambiguous: false,
    rivalPaths: ["terms/Ataraxia.md"],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// hashBody
// ---------------------------------------------------------------------------

describe("hashBody", () => {
  it("is the sha256 hex digest of the utf-8 body", () => {
    // Given: a body string
    const body = "Ataraxia matters.\n";
    // When: it is hashed
    // Then: the digest matches an independent node:crypto computation
    expect(hashBody(body)).toBe(createHash("sha256").update(body, "utf-8").digest("hex"));
  });

  it("differs for bodies that differ by one character", () => {
    // Given: two nearly identical bodies
    // When: both are hashed
    // Then: the digests differ
    expect(hashBody("a")).not.toBe(hashBody("b"));
  });
});

// ---------------------------------------------------------------------------
// Stale state
// ---------------------------------------------------------------------------

describe("applyLinks — stale state", () => {
  it("writes NOTHING when the base hash does not match the current body", async () => {
    // Given: a hash taken from an older revision of the body
    const body = "The goal is Ataraxia today.\n";
    const writer = spyWriter();
    const staleHash = hashBody("The goal is Ataraxia yesterday.\n");
    // When: apply runs with that stale hash
    const result = await applyLinks({
      body,
      baseContentHash: staleHash,
      accepted: [candidate({ startOffset: 12, endOffset: 20, matchedText: "Ataraxia", renderedReplacement: "[[Ataraxia]]" })],
      writeNote: writer.fn,
      target: TARGET,
    });
    // Then: a typed no-op is returned and the writer was never called
    expect(result).toEqual({ applied: false, reason: "note-changed" });
    expect(writer.calls).toEqual([]);
  });

  it("writes NOTHING when there are no accepted candidates", async () => {
    // Given: a matching hash but an empty acceptance list
    const body = "nothing to link here\n";
    const writer = spyWriter();
    // When: apply runs
    const result = await applyLinks({
      body,
      baseContentHash: hashBody(body),
      accepted: [],
      writeNote: writer.fn,
      target: TARGET,
    });
    // Then: a typed no-op is returned and no write happens
    expect(result).toEqual({ applied: false, reason: "no-candidates" });
    expect(writer.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Splice + persist
// ---------------------------------------------------------------------------

describe("applyLinks — splice and persist", () => {
  it("splices one candidate and persists the exact new body via writeNote", async () => {
    // Given: a fresh hash and one accepted candidate
    const body = "The goal is Ataraxia today.\n";
    const writer = spyWriter();
    // When: apply runs
    const result = await applyLinks({
      body,
      baseContentHash: hashBody(body),
      accepted: [candidate({ startOffset: 12, endOffset: 20, matchedText: "Ataraxia", renderedReplacement: "[[Ataraxia]]" })],
      writeNote: writer.fn,
      target: TARGET,
    });
    // Then: the returned body carries the link and the same string was persisted
    expect(result.applied).toBe(true);
    expect(result.applied ? result.body : "").toBe("The goal is [[Ataraxia]] today.\n");
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toMatchObject({
      mode: "update",
      notePath: "notes/Sage.md",
      body: "The goal is [[Ataraxia]] today.\n",
    });
  });

  it("splices multiple candidates right-to-left so earlier offsets stay valid", async () => {
    // Given: two accepted candidates supplied out of document order
    const body = "Ataraxia and Stoicism together.\n";
    const writer = spyWriter();
    const accepted = [
      candidate({ startOffset: 13, endOffset: 21, matchedText: "Stoicism", renderedReplacement: "[[Stoicism]]", targetPath: "terms/Stoicism.md" }),
      candidate({ startOffset: 0, endOffset: 8, matchedText: "Ataraxia", renderedReplacement: "[[Ataraxia]]" }),
    ];
    // When: apply runs
    const result = await applyLinks({
      body,
      baseContentHash: hashBody(body),
      accepted,
      writeNote: writer.fn,
      target: TARGET,
    });
    // Then: both links land in the right places
    expect(result.applied ? result.body : "").toBe("[[Ataraxia]] and [[Stoicism]] together.\n");
  });

  it("renders a Korean alias candidate leaving its particle outside the link", async () => {
    // Given: a stem-only span followed by the object particle
    const body = "그는 아타락시아를 추구했다.\n";
    const writer = spyWriter();
    const start = body.indexOf("아타락시아");
    // When: apply runs
    const result = await applyLinks({
      body,
      baseContentHash: hashBody(body),
      accepted: [
        candidate({
          startOffset: start,
          endOffset: start + "아타락시아".length,
          matchedText: "아타락시아",
          renderedReplacement: "[[Ataraxia|아타락시아]]",
          source: "alias",
        }),
      ],
      writeNote: writer.fn,
      target: TARGET,
    });
    // Then: the particle survives outside the brackets
    expect(result.applied ? result.body : "").toBe("그는 [[Ataraxia|아타락시아]]를 추구했다.\n");
  });

  it("reports the new content hash so a caller can chain a second apply", async () => {
    // Given: a successful apply
    const body = "Ataraxia today.\n";
    const writer = spyWriter();
    // When: apply runs
    const result = await applyLinks({
      body,
      baseContentHash: hashBody(body),
      accepted: [candidate({ startOffset: 0, endOffset: 8, matchedText: "Ataraxia", renderedReplacement: "[[Ataraxia]]" })],
      writeNote: writer.fn,
      target: TARGET,
    });
    // Then: the returned hash is the hash of the returned body
    expect(result.applied ? result.contentHash : "").toBe(hashBody("[[Ataraxia]] today.\n"));
  });

  it("rejects a candidate whose matchedText no longer matches its offsets", async () => {
    // Given: a candidate whose recorded span text disagrees with the body
    const body = "The goal is Ataraxia today.\n";
    const writer = spyWriter();
    // When: apply runs
    const result = await applyLinks({
      body,
      baseContentHash: hashBody(body),
      accepted: [candidate({ startOffset: 0, endOffset: 8, matchedText: "Ataraxia", renderedReplacement: "[[Ataraxia]]" })],
      writeNote: writer.fn,
      target: TARGET,
    });
    // Then: the mismatch is refused without a write
    expect(result).toEqual({ applied: false, reason: "candidate-drift" });
    expect(writer.calls).toEqual([]);
  });

  it("rejects overlapping candidates without writing", async () => {
    // Given: two accepted candidates whose spans overlap
    const body = "Ataraxia today.\n";
    const writer = spyWriter();
    // When: apply runs
    const result = await applyLinks({
      body,
      baseContentHash: hashBody(body),
      accepted: [
        candidate({ startOffset: 0, endOffset: 8, matchedText: "Ataraxia", renderedReplacement: "[[Ataraxia]]" }),
        candidate({ startOffset: 4, endOffset: 8, matchedText: "axia", renderedReplacement: "[[Axia]]" }),
      ],
      writeNote: writer.fn,
      target: TARGET,
    });
    // Then: the overlap is refused without a write
    expect(result).toEqual({ applied: false, reason: "overlapping-candidates" });
    expect(writer.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Write failure propagation
// ---------------------------------------------------------------------------

describe("applyLinks — write outcome", () => {
  it("surfaces a rejected write instead of claiming success", async () => {
    // Given: a kernel that rejects the update
    const body = "Ataraxia today.\n";
    const calls: WriteNoteInput[] = [];
    const writeNote: WriteNoteLike = (input) => {
      calls.push(input);
      return Promise.resolve(kernelResult("rejected", input, "contract violation"));
    };
    // When: apply runs
    const result = await applyLinks({
      body,
      baseContentHash: hashBody(body),
      accepted: [candidate({ startOffset: 0, endOffset: 8, matchedText: "Ataraxia", renderedReplacement: "[[Ataraxia]]" })],
      writeNote,
      target: TARGET,
    });
    // Then: the failure is reported, carrying the kernel's own result
    expect(result.applied).toBe(false);
    expect(result.applied ? null : result.reason).toBe("write-rejected");
    expect(calls).toHaveLength(1);
  });
});

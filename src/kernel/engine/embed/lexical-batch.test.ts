import { describe, expect, it, vi } from "vitest";
import { serialize } from "node:v8";
import { LexicalDocumentBatch, LEXICAL_BATCH_BYTES, LEXICAL_BATCH_CHUNKS, LEXICAL_BATCH_DOCUMENTS, type CapturedLexicalDocument } from "./lexical-batch.js";

vi.mock("node:v8", async original => {
  const actual = await original<typeof import("node:v8")>();
  return { ...actual, serialize: vi.fn(actual.serialize) };
});

function document(index: number, text = "marker"): CapturedLexicalDocument {
  const docPath = `note-${index}.md`;
  return { docPath, source: { fingerprint: null, contentSha256: "a".repeat(64), chunker: "test" },
    chunks: [{ docPath, ordinal: 0, text, title: "Title", headingPath: ["Title", "Section"], sha: "b".repeat(64) }] };
}
function bounded(batch: LexicalDocumentBatch) {
  expect(batch.retained().documents).toBeLessThanOrEqual(LEXICAL_BATCH_DOCUMENTS);
  expect(batch.retained().chunks).toBeLessThanOrEqual(LEXICAL_BATCH_CHUNKS);
  expect(batch.retained().bytes).toBeLessThanOrEqual(LEXICAL_BATCH_BYTES);
}

describe("owned bounded lexical document batches", () => {
  it("commits full and residual batches in order, preserving complete canonical records", () => {
    const inputs = Array.from({ length: 35 }, (_, index) => document(index));
    const commit = vi.fn(); const batch = new LexicalDocumentBatch(commit);
    for (const input of inputs) { batch.add(input); bounded(batch); }
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0]).toEqual(inputs.slice(0, 32));
    expect(batch.retained().documents).toBe(3);
    batch.flush(); batch.flush();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]![0]).toEqual(inputs.slice(32));
    expect(batch.retained()).toEqual({ documents: 0, bytes: 0, chunks: 0 });
  });

  it("owns bytes, including metadata, and charges buffer backing capacity", () => {
    const input = document(1, "text\ud800");
    const expected = structuredClone(input);
    const commit = vi.fn(); const batch = new LexicalDocumentBatch(commit);
    batch.add(input);
    expect(batch.retained().bytes).toBeGreaterThanOrEqual(serialize(input).buffer.byteLength);
    // A caller's later mutable array edit cannot alter a queued record.
    input.chunks[0]!.headingPath.push("later");
    batch.flush(); expect(commit.mock.calls[0]![0]).toEqual([expected]);
  });

  it("refuses a small view backed by an oversized serialization allocation", async () => {
    const actual = await vi.importActual<typeof import("node:v8")>("node:v8");
    vi.mocked(serialize).mockImplementationOnce(value => {
      const encoded = actual.serialize(value);
      const backing = Buffer.alloc(LEXICAL_BATCH_BYTES + 1);
      encoded.copy(backing);
      return backing.subarray(0, encoded.length);
    });
    const commit = vi.fn(); const batch = new LexicalDocumentBatch(commit); const input = document(0);
    batch.add(input);
    expect(commit.mock.calls[0]![0][0]).toBe(input);
    expect(batch.retained()).toEqual({ documents: 0, bytes: 0, chunks: 0 });
  });

  it("flushes on byte and chunk limits before admitting another record", () => {
    const commit = vi.fn(); const batch = new LexicalDocumentBatch(commit);
    const large = "x".repeat(600_000);
    for (let index = 0; index < 12; index++) { batch.add(document(index, large)); bounded(batch); }
    batch.flush(); expect(commit.mock.calls.length).toBeGreaterThan(1);
    expect(commit.mock.calls.flatMap(call => call[0])).toHaveLength(12);
    commit.mockClear();
    const many = document(20); const chunks = Array.from({ length: 600 }, (_, ordinal) => ({ ...many.chunks[0]!, ordinal }));
    batch.add({ ...many, chunks }); batch.add({ ...many, docPath: "other.md", chunks }); bounded(batch);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0][0].chunks).toHaveLength(600);
    batch.flush(); expect(commit).toHaveBeenCalledTimes(2);
    const exact = Array.from({ length: LEXICAL_BATCH_CHUNKS }, (_, ordinal) => ({ ...many.chunks[0]!, ordinal }));
    batch.add({ ...many, chunks: exact });
    expect(commit).toHaveBeenCalledTimes(3);
    expect(batch.retained().chunks).toBe(0);
  });

  it.each(["text", "title", "headings", "source", "chunks"])("processes oversized %s alone without retaining it", kind => {
    const commit = vi.fn(); const batch = new LexicalDocumentBatch(commit);
    batch.add(document(0));
    const base = document(1); const huge = "x".repeat(LEXICAL_BATCH_BYTES);
    const input = kind === "source" ? { ...base, source: { ...base.source, chunker: huge } }
      : { ...base, chunks: kind === "chunks" ? Array.from({ length: LEXICAL_BATCH_CHUNKS + 1 }, (_, ordinal) => ({ ...base.chunks[0]!, ordinal }))
        : [{ ...base.chunks[0]!, ...(kind === "text" ? { text: huge } : kind === "title" ? { title: huge } : { headingPath: [huge] }) }] };
    batch.add(input);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]![0]).toEqual([document(0)]);
    expect(commit.mock.calls[1]![0][0]).toBe(input);
    expect(batch.retained()).toEqual({ documents: 0, bytes: 0, chunks: 0 });
  });

  it("clears failed and discarded batches, without silently retrying or publishing them", () => {
    const failure = new Error("commit refused");
    const commit = vi.fn().mockImplementationOnce(() => { throw failure; });
    const batch = new LexicalDocumentBatch(commit);
    batch.add(document(0));
    expect(() => batch.flush()).toThrow(failure);
    expect(batch.retained()).toEqual({ documents: 0, bytes: 0, chunks: 0 });
    batch.flush(); expect(commit).toHaveBeenCalledTimes(1);
    batch.add(document(1)); batch.discard(); batch.flush(); expect(commit).toHaveBeenCalledTimes(1);
    batch.add(document(2)); batch.flush(); expect(commit.mock.calls[1]![0]).toEqual([document(2)]);
  });
});

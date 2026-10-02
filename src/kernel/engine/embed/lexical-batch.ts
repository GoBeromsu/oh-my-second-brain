import { deserialize, serialize } from "node:v8";
import type { Chunk } from "../types.js";
import type { DocumentSource } from "./source.js";

export interface CapturedLexicalDocument {
  readonly docPath: string;
  readonly source: DocumentSource;
  readonly chunks: readonly Chunk[];
}

export const LEXICAL_BATCH_DOCUMENTS = 32;
export const LEXICAL_BATCH_CHUNKS = 1024;
export const LEXICAL_BATCH_BYTES = 4 * 1024 * 1024;
const RECORD_ALLOWANCE = 512;

/** Avoid an extra serialization allocation for obviously oversized documents. */
function oversized(document: CapturedLexicalDocument): boolean {
  if (document.chunks.length > LEXICAL_BATCH_CHUNKS) return true;
  let bytes = RECORD_ALLOWANCE + 2 * (document.docPath.length + document.source.contentSha256.length
    + document.source.chunker.length + (document.source.fingerprint?.length ?? 0));
  for (const chunk of document.chunks) {
    bytes += RECORD_ALLOWANCE + 2 * (chunk.docPath.length + chunk.text.length + chunk.title.length + chunk.sha.length);
    for (const heading of chunk.headingPath) bytes += 64 + 2 * heading.length;
    if (bytes > LEXICAL_BATCH_BYTES) return true;
  }
  return bytes > LEXICAL_BATCH_BYTES;
}

/**
 * Only owned binary records wait between source reads. Counting whole backing
 * buffers includes serialized titles/headings/source metadata and spare capacity,
 * rather than retaining string slices of unbounded original note bodies.
 * Record/chunk limits also bound wrapper/decoded object counts. These are queue
 * bounds, not a cap on one source capture, decoded/native work, or process RSS.
 */
export class LexicalDocumentBatch {
  private pending: Buffer[] = [];
  private bytes = 0;
  private chunks = 0;

  constructor(private readonly commit: (documents: readonly CapturedLexicalDocument[]) => void) {}

  add(document: CapturedLexicalDocument): void {
    if (oversized(document)) {
      this.flush(); this.commit([document]); return;
    }
    const owned = serialize(document);
    const bytes = owned.buffer.byteLength + RECORD_ALLOWANCE;
    if (bytes > LEXICAL_BATCH_BYTES) {
      this.flush(); this.commit([document]); return;
    }
    if (this.pending.length >= LEXICAL_BATCH_DOCUMENTS || this.bytes + bytes > LEXICAL_BATCH_BYTES
      || this.chunks + document.chunks.length > LEXICAL_BATCH_CHUNKS) this.flush();
    this.pending.push(owned); this.bytes += bytes; this.chunks += document.chunks.length;
    if (this.pending.length === LEXICAL_BATCH_DOCUMENTS || this.chunks === LEXICAL_BATCH_CHUNKS) this.flush();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const pending = this.pending;
    this.discard();
    // These buffers were serialized locally above; no persisted/untrusted input.
    this.commit(pending.map(bytes => deserialize(bytes) as CapturedLexicalDocument));
  }

  discard(): void { this.pending = []; this.bytes = 0; this.chunks = 0; }

  retained(): { readonly documents: number; readonly bytes: number; readonly chunks: number } {
    return { documents: this.pending.length, bytes: this.bytes, chunks: this.chunks };
  }
}

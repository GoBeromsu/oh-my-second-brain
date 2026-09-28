import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Chunk } from "../types.js";
import { BIGRAM_INDEX_VERSION, openBigramIndex } from "./bigram-index.js";
import { openEngineStoreCore, type EngineStore } from "./store.js";

function chunk(docPath: string, text: string, ordinal = 0): Chunk {
  return { docPath, ordinal, text, title: "", headingPath: [], sha: `${docPath}#${ordinal}` };
}

describe("openBigramIndex", () => {
  let base: string;
  let dbPath: string;
  let store: EngineStore;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "oms-bigram-index-"));
    dbPath = path.join(base, "engine.db");
    store = openEngineStoreCore(dbPath);
    store.upsertLex([
      chunk("wound.md", "욕창단계분류 기준을 정리한다."),
      chunk("books.md", "책 목록과 RAG 파이프라인 메모."),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("finds an infix of a compound that the production lexical path misses", () => {
    const index = openBigramIndex(dbPath);
    try {
      expect(index.ensure()).toBe(true);
      expect(store.queryLex("단계분류", 10)).toEqual([]);
      expect(index.queryBigram("단계분류", 10).map((hit) => hit.docPath)).toEqual(["wound.md"]);
    } finally {
      index.close();
    }
  });

  it("finds a one-syllable query and mixed English terms", () => {
    const index = openBigramIndex(dbPath);
    try {
      index.ensure();
      expect(index.queryBigram("책", 10).map((hit) => hit.docPath)).toEqual(["books.md"]);
      expect(index.queryBigram("rag 파이프", 10).map((hit) => hit.docPath)).toEqual(["books.md"]);
    } finally {
      index.close();
    }
  });

  it("returns no hits for an unsearchable query and scores hits by rank", () => {
    const index = openBigramIndex(dbPath);
    try {
      index.ensure();
      expect(index.queryBigram("?!", 10)).toEqual([]);
      const [first] = index.queryBigram("기준", 10);
      expect(first).toEqual({ docPath: "wound.md", chunkOrdinal: 0, score: 1 });
    } finally {
      index.close();
    }
  });

  it("skips the rebuild when version and row count match, and rebuilds when chunks change", () => {
    const first = openBigramIndex(dbPath);
    first.ensure();
    first.close();

    const index = openBigramIndex(dbPath);
    try {
      expect(index.ensure()).toBe(false);
      store.upsertLex([chunk("new.md", "새로운 메모")]);
      expect(index.ensure()).toBe(true);
      expect(index.queryBigram("새로운", 10).map((hit) => hit.docPath)).toEqual(["new.md"]);
    } finally {
      index.close();
    }
  });

  it("exports a positive integer index version", () => {
    expect(Number.isInteger(BIGRAM_INDEX_VERSION)).toBe(true);
    expect(BIGRAM_INDEX_VERSION).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { expandKoreanBigrams, hangulBigrams, makeBigramFtsQuery } from "./lexical-ko.js";

describe("hangulBigrams", () => {
  it("splits a Hangul run into overlapping syllable bigrams", () => {
    expect(hangulBigrams("욕창단계")).toEqual(["욕창", "창단", "단계"]);
  });

  it("keeps a one-syllable run as itself and an empty run as nothing", () => {
    expect(hangulBigrams("책")).toEqual(["책"]);
    expect(hangulBigrams("")).toEqual([]);
  });
});

describe("expandKoreanBigrams", () => {
  it("expands a particle-attached word so its stem bigram is indexed", () => {
    expect(expandKoreanBigrams("기준을").split(" ")).toContain("기준");
  });

  it("indexes the bigrams inside a compound, so an infix is searchable", () => {
    expect(expandKoreanBigrams("욕창단계분류").split(" ")).toEqual(["욕창", "창단", "단계", "계분", "분류"]);
  });

  it("passes mixed English and digits through lowercased and drops punctuation", () => {
    expect(expandKoreanBigrams("RAG 파이프라인, v2!")).toBe("rag 파이 이프 프라 라인 v2");
  });

  it("normalizes NFD Hangul to NFC before splitting", () => {
    expect(expandKoreanBigrams("한글".normalize("NFD"))).toBe("한글");
  });
});

describe("makeBigramFtsQuery", () => {
  it("matches a particle-attached query by its bigrams", () => {
    expect(makeBigramFtsQuery("기준을")).toBe('"기준" OR "준을"');
  });

  it("queries an infix of a compound by its bigrams", () => {
    expect(makeBigramFtsQuery("단계분류")).toBe('"단계" OR "계분" OR "분류"');
  });

  it("prefix-matches non-Hangul terms of two or more characters and drops one-character ones", () => {
    expect(makeBigramFtsQuery("RAG 파이프 x")).toBe('"rag"* OR "파이" OR "이프"');
  });

  it("turns a one-syllable query into a prefix term instead of dropping it", () => {
    expect(makeBigramFtsQuery("책")).toBe('"책"*');
  });

  it("deduplicates repeated bigrams and returns empty for unsearchable text", () => {
    expect(makeBigramFtsQuery("단계 단계")).toBe('"단계"');
    expect(makeBigramFtsQuery("?! -")).toBe("");
  });

  it("caps the expression at 64 terms", () => {
    const long = Array.from({ length: 100 }, (_, index) => `t${index}`).join(" ");
    expect(makeBigramFtsQuery(long).split(" OR ")).toHaveLength(64);
  });
});

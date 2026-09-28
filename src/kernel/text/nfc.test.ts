import { describe, expect, it } from "vitest";
import { nfcEquals, toNfc } from "./nfc.js";

const NFC = "낙상 위험 평가";
const NFD = NFC.normalize("NFD");

describe("toNfc", () => {
  it("composes a decomposed Hangul string", () => {
    expect(NFD).not.toBe(NFC);
    expect(toNfc(NFD)).toBe(NFC);
  });

  it("leaves NFC and ASCII text unchanged", () => {
    expect(toNfc(NFC)).toBe(NFC);
    expect(toNfc("Resources/a.md")).toBe("Resources/a.md");
  });
});

describe("nfcEquals", () => {
  it("treats NFC and NFD spellings of one name as equal", () => {
    expect(nfcEquals(NFC, NFD)).toBe(true);
    expect(nfcEquals(NFD, NFC)).toBe(true);
  });

  it("is true for identical strings", () => {
    expect(nfcEquals("a.md", "a.md")).toBe(true);
  });

  it("is false for different text", () => {
    expect(nfcEquals(NFC, "낙상판정기준")).toBe(false);
    expect(nfcEquals("A.md", "a.md")).toBe(false);
  });
});

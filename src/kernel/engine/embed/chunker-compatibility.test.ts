import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { chunkDocument } from "./chunker.js";
import { parseNote } from "../../conventions/frontmatter.js";

// BEGIN COMPATIBILITY INPUTS
const documents = [
  "",
  " \n\r\n \t\n",
  Array.from({ length: 1000 }, (_, index) => `item ${index}`).join("\n"),
  Array.from({ length: 300 }, (_, index) => `한글 日本語 漢字 가 😀 é ${index}`).join("\n"),
  "\ufeff---\r\ntitle: Declared\r\n---\r\n# Body\r\n" + "plain 中文 😀\r\n".repeat(100),
  "---\ntitle: [broken\n---\n# Actual heading\n" + "short\n".repeat(400),
  "---\n# Not a body title\n" + "missing fence\n".repeat(300),
  "---\ntitle: |\n  Two\n  lines\nloop: &loop [*loop]\n---\n" + "[[Target]] text\n".repeat(250),
  "```markdown\n# Sample\n```\n# Real\n## Child\n" + ("x".repeat(7000) + "\n").repeat(3),
  "---\ntitle: \"a\\u0000b\"\n---\n\u0000body\n\ud800\n\udc00\n\u{20000}\n" + "~\n".repeat(300),
];
const options = [1, 1.25, 13, 64, 900].flatMap(maxTokens =>
  [0, 0.15, 1].map(overlapRatio => ({ maxTokens, overlapRatio })));
// END COMPATIBILITY INPUTS

it("preserves canonical chunks and digests across line, Unicode and overlap boundaries", () => {
  // Golden output from pre-optimization #205, tree 95783f5. It covers every
  // chunk's exact text, title, heading path, ordinal and digest in 150 cases.
  const digest = createHash("sha256");
  const sharedDigest = createHash("sha256");
  for (const [index, raw] of documents.entries()) {
    for (const opts of options) {
      digest.update(JSON.stringify(chunkDocument(`case-${index}.md`, raw, opts)));
      sharedDigest.update(JSON.stringify(chunkDocument(`case-${index}.md`, raw, opts, parseNote(raw))));
    }
  }
  expect(digest.digest("hex")).toBe("eb571cc94b1db38afc6c5602e2b181ef3cd643fe3371df2be0dee03e079923db");
  expect(sharedDigest.digest("hex")).toBe("eb571cc94b1db38afc6c5602e2b181ef3cd643fe3371df2be0dee03e079923db");
});

it("preserves chunk boundaries at every CJK interval edge and UTF-16 surrogate shape", () => {
  const edges = [
    0x1100, 0x11ff, 0x3000, 0x303f, 0x3040, 0x30ff, 0x3130, 0x318f,
    0x3400, 0x4dbf, 0x4e00, 0x9fff, 0xa960, 0xa97f, 0xac00, 0xd7a3,
    0xd7b0, 0xd7ff, 0xf900, 0xfaff, 0xff00, 0xffef, 0x20000, 0x2fa1f,
  ];
  const points = [...new Set([
    0, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff, 0x10000, 0x10ffff,
    ...edges.flatMap(edge => [edge - 1, edge, edge + 1]),
  ])];
  const inputs = [
    points.map(point => `${String.fromCodePoint(point).repeat(9)} x\n`).join(""),
    "\ud800\ud800\udc00\udc00\n\udbff\udfff\udbff\n\udfff\n\u{1ffff}\u{20000}\u{2fa1f}\u{2fa20}\n".repeat(40),
  ];
  const digest = createHash("sha256");
  for (const [index, raw] of inputs.entries()) {
    for (const maxTokens of [1, 1.25, 4, 13, 64, 900]) {
      for (const overlapRatio of [0, 0.15, 1]) {
        digest.update(JSON.stringify(chunkDocument(`unicode-${index}.md`, raw, { maxTokens, overlapRatio })));
      }
    }
  }
  // Captured from the unchanged for-of/codePointAt implementation at 468ffce.
  expect(digest.digest("hex")).toBe("415994edb53a4ad42f1b303ae81b0a4bc0277935318645b551430996bf2a35e0");
});

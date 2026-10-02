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

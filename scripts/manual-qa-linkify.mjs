#!/usr/bin/env node
/**
 * Manual QA for the linkify core, run against the BUILT dist/ artifacts.
 *
 * Vault is in-memory: three `term` notes (one with a Korean alias) plus a note
 * body that mentions them in prose AND inside a fenced code block. The script
 * prints the mask partition, the suggest candidates, and the applied body so a
 * reviewer can see with their own eyes that prose was linked and code was not.
 *
 * No disk writes: the writeNote seam is a spy that echoes what it was handed.
 */

import { maskBody } from "../dist/engine/linkify/mask.js";
import { suggestLinks, termBoundNotes } from "../dist/engine/linkify/suggest.js";
import { applyLinks, hashBody } from "../dist/engine/linkify/apply.js";

const VAULT = [
  { path: "terms/Ataraxia.md", concept: "term", aliases: ["아타락시아", "tranquility"] },
  { path: "terms/Stoicism.md", concept: "term", aliases: [] },
  { path: "terms/Apatheia.md", concept: "term", aliases: ["아파테이아"] },
  { path: "journal/Diary.md", concept: "journal", aliases: ["diary"] },
];

const NOTE_PATH = "notes/On the Sage.md";

const BODY = [
  "---",
  "title: On the Sage",
  "concept: note",
  "---",
  "",
  "## Reading notes",
  "",
  "The sage seeks Apatheia; 그는 아타락시아를 목표로 삼는다.",
  "Stoicism is the school; my diary tracks the practice.",
  "Later Ataraxia 언급 — same note, second surface, must NOT link twice.",
  "",
  "```ts",
  "// Ataraxia and Stoicism must stay untouched in here",
  "const 아타락시아 = 1;",
  "```",
  "",
  "See also [[Stoicism]] which is already linked, and `Ataraxia()` in code.",
  "",
].join("\n");

const rule = (title) => `\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`;

// --- 1. mask ---------------------------------------------------------------
console.log(rule("1. MASK — protected regions (never linkified)"));
const mask = maskBody(BODY);
for (const span of mask.protectedSpans) {
  console.log(`  [${String(span.start).padStart(3)},${String(span.end).padStart(3)}) ${span.kind.padEnd(14)} ${JSON.stringify(BODY.slice(span.start, span.end))}`);
}
console.log("\n  FREE regions (scannable prose):");
for (const span of mask.freeSpans) {
  console.log(`  [${String(span.start).padStart(3)},${String(span.end).padStart(3)}) ${JSON.stringify(BODY.slice(span.start, span.end))}`);
}

// --- 2. suggest ------------------------------------------------------------
console.log(rule("2. SUGGEST — ranked candidates over FREE regions only"));
const universe = termBoundNotes(VAULT);
console.log(`  candidate universe (concept === "term"): ${universe.map((n) => n.path).join(", ")}`);
console.log(`  dropped by concept filter: ${VAULT.filter((n) => !universe.includes(n)).map((n) => n.path).join(", ")}`);
const candidates = suggestLinks(BODY, universe, { notePath: NOTE_PATH });
for (const c of candidates) {
  console.log(
    `  ${c.matchedText.padEnd(12)} @[${String(c.startOffset)},${String(c.endOffset)}) -> ${c.targetPath.padEnd(20)} ${c.renderedReplacement.padEnd(28)} src=${c.source} conf=${c.confidence.toFixed(2)} ambiguous=${String(c.ambiguous)}`,
  );
}

// --- 3. apply (happy path) -------------------------------------------------
console.log(rule("3. APPLY — hash match, persisted via injected writeNote"));
const persisted = [];
const writeNote = async (input) => {
  persisted.push(input);
  return {
    status: "written",
    mode: input.mode,
    notePath: input.notePath ?? "",
    concept: "note",
    folder: "notes",
    fields: [],
    frontmatter: {},
    missingFields: [],
    violations: [],
  };
};

const target = {
  target: { vault: "/tmp/in-memory-vault", source: "explicit" },
  ontology: { concepts: new Map(), taxonomy: { version: 1, folders: {} } },
  notePath: NOTE_PATH,
};

const applied = await applyLinks({
  body: BODY,
  baseContentHash: hashBody(BODY),
  accepted: candidates,
  writeNote,
  target,
});

console.log(`  applied: ${String(applied.applied)}   writeNote calls: ${String(persisted.length)}`);
console.log("  --- resulting body (returned by applyLinks) ---");
console.log(applied.applied ? applied.body.split("\n").map((l) => `  | ${l}`).join("\n") : "  (no body)");
console.log(`\n  persisted body === returned body: ${String(persisted[0]?.body === (applied.applied ? applied.body : null))}`);
console.log(`  persisted mode: ${persisted[0]?.mode}`);

// --- 4. assertions a reviewer can check ------------------------------------
console.log(rule("4. OBSERVABLE ASSERTIONS (on the returned body string)"));
const out = applied.applied ? applied.body : "";
const codeBlock = out.slice(out.indexOf("```ts"), out.indexOf("```", out.indexOf("```ts") + 5) + 3);
const checks = [
  ["Korean alias rendered stem-only, particle outside the link", out.includes("[[Ataraxia|아타락시아]]를")],
  ["Latin basename got a bare wikilink", out.includes("seeks [[Apatheia]];")],
  ["second surface of an already-linked note stays plain", out.includes("Later Ataraxia 언급")],
  ["Stoicism prose linked", out.includes("[[Stoicism]] is the school")],
  ["code fence untouched (no [[ inside)", !codeBlock.includes("[[")],
  ["existing [[Stoicism]] not double-linked", !out.includes("[[[[")],
  ["inline `Ataraxia()` untouched", out.includes("`Ataraxia()`")],
  ["heading untouched", out.includes("## Reading notes")],
  ["frontmatter untouched", out.startsWith("---\ntitle: On the Sage")],
  ["journal note excluded by term filter (no diary link)", !out.includes("[[Diary")],
];
for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);

// --- 5. adversarial: stale hash -------------------------------------------
console.log(rule("5. ADVERSARIAL — stale hash must write NOTHING"));
const staleCalls = [];
const staleResult = await applyLinks({
  body: BODY,
  baseContentHash: hashBody(`${BODY}someone else edited this\n`),
  accepted: candidates,
  writeNote: async (input) => {
    staleCalls.push(input);
    throw new Error("unreachable: writeNote must not be called on a stale hash");
  },
  target,
});
console.log(`  result: ${JSON.stringify(staleResult)}`);
console.log(`  writeNote calls: ${String(staleCalls.length)} (must be 0)`);
console.log(`  ${staleResult.applied === false && staleResult.reason === "note-changed" && staleCalls.length === 0 ? "PASS" : "FAIL"}  stale apply is a typed no-op with zero writes`);

// --- 6. adversarial: malformed bodies -------------------------------------
console.log(rule("6. ADVERSARIAL — malformed bodies do not crash or over-link"));
const MALFORMED = [
  ["empty body", ""],
  ["frontmatter only", "---\ntitle: X\n---\n"],
  ["unterminated fence", "prose Ataraxia\n\n```ts\nconst Ataraxia = 1;\n"],
  ["nested brackets", "see [[a [[Ataraxia]] b]] and [x [Ataraxia](y)](z)\n"],
  ["unterminated inline code", "prose `Ataraxia unclosed\n"],
];
for (const [name, body] of MALFORMED) {
  const m = maskBody(body);
  const c = suggestLinks(body, universe, { notePath: NOTE_PATH });
  console.log(`  ${name.padEnd(26)} protected=${String(m.protectedSpans.length)} free=${String(m.freeSpans.length)} candidates=${String(c.length)} ${c.map((x) => x.renderedReplacement).join(" ") || "(none)"}`);
}

// --- 7. adversarial: ambiguity --------------------------------------------
console.log(rule("7. ADVERSARIAL — ambiguity is flagged, never auto-picked"));
const rivals = [
  { path: "terms/Ataraxia.md", concept: "term", aliases: [] },
  { path: "terms/greek/Ataraxia.md", concept: "term", aliases: [] },
];
const ambiguous = suggestLinks("Ataraxia matters.\n", rivals, { notePath: NOTE_PATH });
for (const c of ambiguous) {
  console.log(`  matched=${c.matchedText} ambiguous=${String(c.ambiguous)} rivals=[${c.rivalPaths.join(", ")}]`);
}
console.log(`  ${ambiguous.length === 1 && ambiguous[0].ambiguous === true && ambiguous[0].rivalPaths.length === 2 ? "PASS" : "FAIL"}  both rivals reported, no shortest-path tie-break applied`);

console.log(`\n${"=".repeat(72)}\nDONE\n${"=".repeat(72)}`);

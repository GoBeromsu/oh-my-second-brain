/**
 * Red-team adversarial analyzer for distill (M4 — C6).
 *
 * Architecture mirrors M1's EmbeddingProvider injection pattern:
 * - AnalyzerProvider interface — the seam for LLM injection.
 * - createStubAnalyzerProvider() — deterministic stub for tests (no network).
 * - runAnalysis() — orchestration: prompt construction → provider call → validation.
 *
 * No hardcoded network calls. Inject a real LLM client in production;
 * inject the stub in tests and dry-run mode.
 */

import type { CleanRoomSpec, AnalyzerResult, DistillPattern, DistillRisk } from "./types.js";

// ---------------------------------------------------------------------------
// Provider seam (mirrors EmbeddingProvider in src/engine/types.ts)
// ---------------------------------------------------------------------------

/**
 * LLM provider seam for the red-team analyzer.
 *
 * Inject a stub via createStubAnalyzerProvider() for tests.
 * Inject a real LLM client (e.g. wrapping Claude API) for production.
 *
 * The provider receives a CleanRoomSpec (system prompt + user content)
 * and returns a structured AnalyzerResult.
 */
export interface AnalyzerProvider {
  /** Human-readable identifier for the provider (e.g. "stub" or "claude-sonnet-4"). */
  readonly model: string;
  /**
   * Run adversarial analysis inside the clean-room context.
   *
   * The provider must:
   * - Send systemPrompt as the system message and userContent as the user message.
   * - Parse the LLM response as AnalyzerResult JSON.
   * - Never mutate external state as a side-effect of this call.
   */
  analyze(spec: CleanRoomSpec): Promise<AnalyzerResult>;
}

// ---------------------------------------------------------------------------
// Orchestration entry-point
// ---------------------------------------------------------------------------

/**
 * Run adversarial analysis using the given provider.
 *
 * Orchestrates: CleanRoomSpec → provider.analyze() → schema validation.
 * Throws if the provider returns a structurally invalid result.
 */
export async function runAnalysis(
  spec: CleanRoomSpec,
  provider: AnalyzerProvider,
): Promise<AnalyzerResult> {
  const raw = await provider.analyze(spec);
  return validateResult(raw);
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateResult(raw: AnalyzerResult): AnalyzerResult {
  if (!Array.isArray(raw.patterns)) {
    throw new Error("AnalyzerResult.patterns must be an array");
  }
  if (!Array.isArray(raw.risks)) {
    throw new Error("AnalyzerResult.risks must be an array");
  }
  if (!raw.attribution || typeof raw.attribution !== "object") {
    throw new Error("AnalyzerResult.attribution must be an object");
  }
  if (typeof raw.attribution.repo !== "string") {
    throw new Error("AnalyzerResult.attribution.repo must be a string");
  }
  if (typeof raw.attribution.url !== "string") {
    throw new Error("AnalyzerResult.attribution.url must be a string");
  }
  if (typeof raw.attribution.license_note !== "string") {
    throw new Error("AnalyzerResult.attribution.license_note must be a string");
  }
  for (const p of raw.patterns) {
    if (typeof p.file !== "string") {
      throw new Error("Pattern.file must be a string");
    }
    if (typeof p.line !== "number") {
      throw new Error("Pattern.line must be a number");
    }
    if (typeof p.description !== "string") {
      throw new Error("Pattern.description must be a string");
    }
    if (
      typeof p.absorb_confidence !== "number" ||
      p.absorb_confidence < 0 ||
      p.absorb_confidence > 1
    ) {
      throw new Error(
        `Pattern.absorb_confidence must be 0.0–1.0; got ${p.absorb_confidence}`,
      );
    }
  }
  for (const r of raw.risks) {
    if (typeof r.description !== "string") {
      throw new Error("Risk.description must be a string");
    }
    if (!["low", "medium", "high", "critical"].includes(r.severity)) {
      throw new Error(`Risk.severity must be low|medium|high|critical; got ${r.severity}`);
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Deterministic stub provider
// ---------------------------------------------------------------------------

/**
 * Known-pattern signatures used by the stub to detect patterns without LLM.
 * Each entry carries the keyword triggers, a human description, and confidence.
 *
 * Derived from docs/research/embedding-pipeline-patterns-mining.md and
 * docs/research/graphify-graph-implementation-mining.md (absorption ledger).
 */
const KNOWN_PATTERN_SIGNATURES: ReadonlyArray<{
  keywords: string[];
  description: string;
  absorb_confidence: number;
}> = [
  // qmd patterns (from embedding-pipeline-patterns-mining.md)
  {
    keywords: ["embedBatch", "Promise.all", "parallel"],
    description:
      "Hardware-adaptive parallel embedding context pool (P-01) — distributes embed work across parallel LLM contexts via Promise.all",
    absorb_confidence: 0.95,
  },
  {
    keywords: ["sha256", "SHA-256", "SHA256", "sha-256", "fingerprint", "file_hash"],
    description:
      "SHA-256 incremental fingerprint for change detection — skip re-embed on unchanged content",
    absorb_confidence: 0.92,
  },
  {
    keywords: ["sqlite-vec", "vec0", "sqlite_vec", "sqliteVec", "better-sqlite3"],
    description:
      "sqlite-vec vec0 content-addressable store with lazy-load + 5-min unload guard",
    absorb_confidence: 0.90,
  },
  {
    keywords: ["chunkDocumentByTokens", "chunk", "token", "overlap"],
    description:
      "Token-aware chunker with configurable overlap — respects heading boundaries and code-fence protection",
    absorb_confidence: 0.88,
  },
  {
    keywords: ["retryFailedChunks", "retry", "success-counter"],
    description:
      "64-success-counter deferred retry pass — accumulates failures during batch, retries after threshold",
    absorb_confidence: 0.75,
  },
  {
    keywords: ["RRF", "k=60", "reciprocal rank", "rank fusion", "Reciprocal Rank"],
    description:
      "RRF k=60 rank fusion — gbrain/MS-GraphRAG-parity fusion across lex/vec/hyde/graph sub-types",
    absorb_confidence: 0.90,
  },
  {
    keywords: ["lex", "vec", "hyde", "typed sub-query", "TypedSubQuery", "sub-query"],
    description:
      "Typed sub-query dispatcher interface: lex | vec | hyde | graph — mirrors qmd surface",
    absorb_confidence: 0.92,
  },
  // graphify patterns (from graphify-graph-implementation-mining.md)
  {
    keywords: ["deduplicate_entities", "dedup", "MinHash", "Jaro-Winkler", "JaroWinkler", "JW"],
    description:
      "4-pass entity deduplication pipeline: exact → entropy → MinHash → Jaro-Winkler",
    absorb_confidence: 0.88,
  },
  {
    keywords: ["Leiden", "Louvain", "community", "cluster", "cohesion"],
    description:
      "Leiden-first / Louvain-fallback community detection with cohesion-split escape hatch",
    absorb_confidence: 0.85,
  },
  {
    keywords: ["build_merge", "grow-only", "build_graph", "incremental"],
    description:
      "Grow-only build_merge strategy — avoids re-extracting unchanged files; incremental graph update",
    absorb_confidence: 0.82,
  },
  {
    keywords: ["EXTRACTED", "INFERRED", "AMBIGUOUS", "confidence_score"],
    description:
      "3-tier edge confidence classification: EXTRACTED | INFERRED | AMBIGUOUS — with numeric score",
    absorb_confidence: 0.80,
  },
  {
    keywords: [
      "ARCHITECTURE.md",
      "detect.py",
      "extract.py",
      "build.py",
      "cluster.py",
      "dedup.py",
    ],
    description:
      "Pipeline-as-independent-modules pattern — each stage is a single-function module with no shared mutable state",
    absorb_confidence: 0.78,
  },
  {
    keywords: ["tree-sitter", "AST", "semantic", "2-pass", "extract"],
    description:
      "2-pass extraction: tree-sitter AST (structural) + LLM semantic — used for entity/relation extraction",
    absorb_confidence: 0.76,
  },
  {
    keywords: ["2-step CoT", "CoT", "step1", "step2", "analysis pass", "synthesis pass"],
    description:
      "2-step Chain-of-Thought: Step 1 analysis pass (entities/concepts/contradictions) → Step 2 synthesis pass (page + wikilinks)",
    absorb_confidence: 0.88,
  },
];

/**
 * Create a deterministic stub AnalyzerProvider for use in tests and dry-runs.
 *
 * The stub:
 * - Scans target content for known pattern keywords from the absorption ledger.
 * - Returns a structured AnalyzerResult without any network calls.
 * - Is fully deterministic: same input → same output.
 * - Never mutates external state.
 */
export function createStubAnalyzerProvider(): AnalyzerProvider {
  return {
    model: "stub",
    async analyze(spec: CleanRoomSpec): Promise<AnalyzerResult> {
      return stubAnalyze(spec);
    },
  };
}

// ---------------------------------------------------------------------------
// Stub analysis implementation
// ---------------------------------------------------------------------------

function stubAnalyze(spec: CleanRoomSpec): AnalyzerResult {
  const content = spec.targetContent;
  const lines = content.split("\n");

  const patterns: DistillPattern[] = detectPatterns(lines, spec.targetName);
  const risks: DistillRisk[] = detectRisks(content);
  const attribution = extractAttribution(spec.targetName, content);

  // Sort descending by absorb_confidence (§1 report ranking requirement)
  patterns.sort((a, b) => b.absorb_confidence - a.absorb_confidence);

  return { patterns, risks, attribution };
}

function detectPatterns(
  lines: string[],
  targetName: string,
): DistillPattern[] {
  const found: DistillPattern[] = [];
  const seenDescriptions = new Set<string>();

  for (const sig of KNOWN_PATTERN_SIGNATURES) {
    for (const keyword of sig.keywords) {
      const matchIdx = lines.findIndex((l) => l.includes(keyword));
      if (matchIdx !== -1 && !seenDescriptions.has(sig.description)) {
        seenDescriptions.add(sig.description);
        found.push({
          file: guessFile(lines, matchIdx, targetName),
          line: matchIdx + 1,
          description: sig.description,
          absorb_confidence: sig.absorb_confidence,
        });
        break;
      }
    }
  }

  return found;
}

/** Heuristically determine a file context from surrounding lines. */
function guessFile(
  lines: string[],
  matchLine: number,
  targetName: string,
): string {
  // Look backwards up to 20 lines for a backtick filename or code-fence header
  for (let i = matchLine; i >= Math.max(0, matchLine - 20); i--) {
    const line = lines[i] ?? "";
    const m = line.match(/`([^`]+\.[a-zA-Z]+)`/) ?? line.match(/^```(\S+)/);
    if (m?.[1]) {
      return m[1];
    }
  }
  return targetName;
}

function detectRisks(content: string): DistillRisk[] {
  const risks: DistillRisk[] = [];

  if (/GPL-?3\.0|GPL-3/i.test(content)) {
    risks.push({
      description:
        "GPL-3.0 licensed source — idea-only absorption required; no verbatim code copy permitted",
      severity: "high",
    });
  }
  if (/license unconfirmed|license:\s*TBD|license TBD/i.test(content)) {
    risks.push({
      description:
        "License status unconfirmed for at least one source — flag for ACKNOWLEDGMENTS and legal review before absorption",
      severity: "medium",
    });
  }
  if (/\[OPEN-BUG\]|\[OPEN-RFC\]/i.test(content)) {
    risks.push({
      description:
        "Open bugs or RFCs referenced — verify the absorbed patterns are from [SHIPPED-IN-CODE] or [MERGED] entries only",
      severity: "medium",
    });
  }
  if (/\[UNVERIFIED\]/i.test(content)) {
    risks.push({
      description:
        "[UNVERIFIED] items present in source — these must NOT be absorbed per standing rule",
      severity: "high",
    });
  }
  if (/setInterval|setTimeout|daemon|watcher|fs\.watch|chokidar/i.test(content)) {
    risks.push({
      description:
        "Stateful/persistent pattern detected (daemon/watcher/setInterval) — violates R2 stateless constraint if absorbed verbatim",
      severity: "high",
    });
  }
  if (/hardcoded|hard-coded|HARDCODED/i.test(content)) {
    risks.push({
      description:
        "Hardcoded values present — violates Non-Sticky/Vault-Agnostic principle (R16) if absorbed without parameterization",
      severity: "medium",
    });
  }

  return risks;
}

function extractAttribution(
  targetName: string,
  content: string,
): AnalyzerResult["attribution"] {
  const repoMatch = content.match(/source_repo:\s*([^\n]+)/);
  const urlMatch = content.match(/https?:\/\/[^\s\)\]]+/);
  const licenseMatch =
    content.match(/^license[:\s]+([^\n]+)/im) ??
    content.match(/MIT|Apache 2\.0|GPL-?3\.0|Apache-2|BSD/);

  return {
    repo: repoMatch ? repoMatch[1]!.trim() : targetName,
    url: urlMatch ? urlMatch[0].replace(/[,)]+$/, "") : "",
    license_note: licenseMatch
      ? (licenseMatch[1] ?? licenseMatch[0])!.trim()
      : "unconfirmed — review before code absorption",
  };
}

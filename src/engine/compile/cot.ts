/**
 * Nashsu 2-step Chain-of-Thought compile pipeline.
 *
 * GPL-3.0 IDEA-ONLY: The 2-step CoT approach (analysis → synthesis with
 * [[wikilink]] insertion) is absorbed from nashsu/llm_wiki as an algorithm
 * description only.  No verbatim code from nashsu is used here.
 * Reimplemented from scratch.
 *
 * Step 1 — analysis pass: extract entities / concepts / arguments /
 *           contradictions / structure from source materials.
 * Step 2 — synthesis pass: produce source summary + concept page +
 *           [[wikilink]] insertion.  Step 1 output is the context for Step 2.
 *
 * Always sequential: Step 1 must complete before Step 2 begins.
 */

import type { CoTResult, CoTStep1Result, LLMProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildStep1Prompt(concept: string, formattedMaterials: string): string {
  return `You are a knowledge-graph analyst. Analyze the following source materials about the concept "${concept}".

MATERIALS:
${formattedMaterials}

Produce a structured analysis with EXACTLY these labeled sections (no extra text before ENTITIES):
ENTITIES: (comma-separated list of named entities mentioned)
CONCEPTS: (comma-separated list of related concepts)
ARGUMENTS:
- (each key claim on its own line prefixed with "- ")
CONTRADICTIONS:
- (each conflicting claim on its own line, or a single line "- none")
STRUCTURE: (one paragraph describing how "${concept}" relates to the above entities/concepts)`;
}

function buildStep2Prompt(
  concept: string,
  formattedMaterials: string,
  step1: CoTStep1Result,
): string {
  const contradictionText =
    step1.contradictions.length > 0
      ? step1.contradictions.join(" | ")
      : "none";
  return `You are a wiki synthesis engine. Create a comprehensive concept page for "${concept}".

ANALYSIS CONTEXT (from Step 1):
Entities: ${step1.entities.join(", ")}
Concepts: ${step1.concepts.join(", ")}
Key Arguments: ${step1.arguments.join(" | ")}
Contradictions: ${contradictionText}
Structure: ${step1.structure}

SOURCE MATERIALS:
${formattedMaterials}

Write a Markdown concept page. Requirements:
1. Begin with a 2-3 sentence summary of ${concept}.
2. Use ## headings for major sections.
3. Insert [[wikilinks]] for all related concepts, entities, and referenced topics.
4. Where sources contradict, note the conflict inline: > **Conflict:** Source A claims X; Source B claims Y. Unresolved.
5. End with a ## See Also section listing related concept wikilinks.
Output ONLY the Markdown body (no YAML frontmatter, no preamble).`;
}

// ---------------------------------------------------------------------------
// Step 1 response parser
// ---------------------------------------------------------------------------

function parseStep1(raw: string): CoTStep1Result {
  /** Extract the content of a labeled section, stopping at the next ALL-CAPS label. */
  const extractSection = (label: string): string => {
    const match = raw.match(
      new RegExp(`${label}:[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, "i"),
    );
    return match?.[1]?.trim() ?? "";
  };

  const extractInline = (label: string): string => {
    const match = raw.match(new RegExp(`${label}:\\s*(.+)`, "i"));
    return match?.[1]?.trim() ?? "";
  };

  const splitList = (s: string): string[] =>
    s
      .split(/\n|,/)
      .map((x) => x.replace(/^[-•*]\s*/, "").trim())
      .filter(Boolean);

  return {
    entities: splitList(extractInline("ENTITIES")),
    concepts: splitList(extractInline("CONCEPTS")),
    arguments: splitList(extractSection("ARGUMENTS")),
    contradictions: splitList(extractSection("CONTRADICTIONS")).filter(
      (s) => s.toLowerCase() !== "none",
    ),
    structure: extractInline("STRUCTURE"),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the nashsu 2-step CoT pipeline.  Always sequential: Step 1 completes
 * before Step 2 begins.
 *
 * @param concept            - Concept name being compiled (used in prompts).
 * @param formattedMaterials - Pre-formatted material string from provenance.formatForSynthesis.
 * @param provider           - Injected LLM provider (use createDeterministicStub in tests).
 */
export async function runCoT(
  concept: string,
  formattedMaterials: string,
  provider: LLMProvider,
): Promise<CoTResult> {
  // Step 1: analysis — must complete before Step 2
  const step1Raw = await provider.complete(
    buildStep1Prompt(concept, formattedMaterials),
  );
  const step1 = parseStep1(step1Raw);

  // Step 2: synthesis — uses Step 1 as context
  const body = await provider.complete(
    buildStep2Prompt(concept, formattedMaterials, step1),
  );

  return { step1, body };
}

// ---------------------------------------------------------------------------
// Deterministic stub provider (for tests and offline environments)
// ---------------------------------------------------------------------------

/**
 * A deterministic LLMProvider stub that produces predictable CoT output.
 * Does NOT make network calls.  Safe for vitest.
 */
export function createDeterministicStub(): LLMProvider {
  return {
    async complete(prompt: string): Promise<string> {
      // Detect Step 1 by the presence of the ENTITIES section label
      if (prompt.includes("ENTITIES:") && prompt.includes("ARGUMENTS:")) {
        const conceptMatch = /concept "([^"]+)"/.exec(prompt);
        const concept = conceptMatch?.[1] ?? "unknown";
        return [
          `ENTITIES: ${concept}, entity-A, entity-B`,
          `CONCEPTS: ${concept}-theory, ${concept}-practice, meta-${concept}`,
          `ARGUMENTS:`,
          `- ${concept} is fundamental to knowledge organization`,
          `- Multiple sources confirm ${concept} utility`,
          `CONTRADICTIONS:`,
          `- none`,
          `STRUCTURE: ${concept} connects entity-A and entity-B into a structured knowledge graph`,
        ].join("\n");
      }

      // Step 2: synthesis response
      const conceptMatch = /concept page for "([^"]+)"/.exec(prompt);
      const concept = conceptMatch?.[1] ?? "unknown";
      return [
        `## ${concept}`,
        ``,
        `${concept} is a foundational concept in knowledge management. It connects related ideas and provides structure to information.`,
        ``,
        `## Key Properties`,
        ``,
        `- Relates to [[entity-A]] and [[entity-B]]`,
        `- Supports [[${concept}-theory]] and [[${concept}-practice]]`,
        ``,
        `## Applications`,
        ``,
        `${concept} is applied in knowledge graphs and [[meta-${concept}]] contexts.`,
        ``,
        `## See Also`,
        ``,
        `- [[${concept}-theory]]`,
        `- [[${concept}-practice]]`,
        `- [[meta-${concept}]]`,
      ].join("\n");
    },
  };
}

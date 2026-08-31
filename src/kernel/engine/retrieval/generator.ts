/**
 * HyDE hypothetical-document generator backed by a local GGUF model.
 *
 * HyDE embeds a *hypothetical answer* rather than the raw question, on the theory
 * that an answer-shaped passage sits closer in embedding space to real answers
 * than a question does. The `hyde` sub-query type has existed in the dispatcher
 * since M1, but nothing ever produced that passage: the seam defaulted to an
 * identity stub that returned the query unchanged, so an explicit HyDE request was
 * silently an ordinary vector search. That stub is gone, which correctly turned the
 * path into a loud failure — and left the capability genuinely unimplemented until
 * this module.
 *
 * Not to be confused with query expansion. Expansion produces several alternative
 * *queries*; HyDE produces one hypothetical *document*. Both can use the same
 * generation model, and they are separate capabilities.
 *
 * Sampling settings follow the reference toolchain's non-thinking Qwen3 recipe
 * (temperature 0.7, topK 20, topP 0.8, presence penalty over a 64-token window).
 * Greedy decoding is deliberately NOT used: at temperature 0 these models fall
 * into repetition loops, which the reference implementation calls out explicitly.
 */

import type {
  ExpandedSubQuery,
  ExpansionRequest,
  HydeGenerator,
  QueryExpander,
} from "./dispatcher.js";

/** Tokens of hypothetical passage to generate. A short passage embeds better. */
const DEFAULT_MAX_TOKENS = 220;

/** Context window for the generation session, bounded to limit VRAM. */
const DEFAULT_CONTEXT_SIZE = 2048;

export interface LlamaGeneratorOptions {
  /** Absolute path to the GGUF generation model. */
  readonly modelPath: string;
  readonly maxTokens?: number;
  readonly contextSize?: number;
  /** Test seam: supply a loader instead of importing node-llama-cpp. */
  readonly loader?: () => Promise<GenerationRuntime>;
}

/** The slice of node-llama-cpp this module needs, named so tests can fake it. */
export interface GenerationRuntime {
  readonly generate: (prompt: string, options: {
    readonly maxTokens: number;
    readonly temperature: number;
    readonly topK: number;
    readonly topP: number;
    readonly mode: "passage" | "typed-plan";
  }) => Promise<string>;
  readonly dispose: () => Promise<void>;
}

export interface DisposableGenerator {
  readonly generate: HydeGenerator;
  readonly expand: QueryExpander;
  readonly dispose: () => Promise<void>;
}

function isCancelled(cancel: ExpansionRequest["cancel"]): boolean {
  // Read through a function on both sides of an await. A caller may own a mutable
  // cancellation token even though this module only receives a readonly view;
  // direct checks let TypeScript incorrectly narrow the post-await value forever.
  return cancel?.cancelled === true;
}

/**
 * Prompt the model for a passage that reads like an answer.
 *
 * `/no_think` matches the reference toolchain's directive for Qwen3 models, which
 * otherwise emit a visible reasoning block that would be embedded as if it were
 * document text.
 */
function hydePrompt(query: string): string {
  return (
    `/no_think Write a short factual passage that would answer this search query. ` +
    `Write only the passage, with no preamble, no heading, and no quotation marks.\n\n` +
    `Query: ${query}`
  );
}

function expansionPrompt(query: string, context: string | undefined): string {
  const contextBlock = context === undefined || context.trim() === ""
    ? ""
    : (
      `\nVault folder intents (authoritative taxonomy context; use only when relevant):\n` +
      `${context.trim()}\n`
    );
  return (
    `/no_think Expand this search query into typed retrieval lines.\n` +
    `Each output line must be exactly one of: lex: text, vec: text, hyde: text.\n` +
    `Do not explain the output and do not repeat a line.\n` +
    contextBlock +
    `Query: ${query}`
  );
}

async function defaultLoader(
  modelPath: string,
  contextSize: number,
): Promise<GenerationRuntime> {
  const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  return {
    generate: async (prompt, options) => {
      // A fresh context prevents one expansion/HyDE call from inheriting another
      // call's chat history. The model itself remains loaded and shared.
      const context = await model.createContext({ contextSize });
      const sequence = context.getSequence();
      try {
        const session = new LlamaChatSession({ contextSequence: sequence });
        const grammar = options.mode === "typed-plan"
          ? await llama.createGrammar({
            grammar: `
              root ::= line+
              line ::= type ": " content "\\n"?
              type ::= "lex" | "vec" | "hyde"
              content ::= [^\\n]+
            `,
          })
          : undefined;
        // Await here. Returning the promise directly runs `finally` immediately,
        // disposing the native context while generation is still decoding. On
        // node-llama-cpp 3.20 that raised DisposedError and then aborted Metal.
        return await session.prompt(prompt, {
          ...(grammar === undefined ? {} : { grammar }),
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          topK: options.topK,
          topP: options.topP,
          // Repetition control from the reference recipe. Without it these models
          // loop on a phrase and fill the whole token budget with it.
          repeatPenalty: { lastTokens: 64, presencePenalty: 0.5 },
        });
      } finally {
        // node-llama-cpp 3.20 made sequence disposal asynchronous. Dispose and
        // await the child before its parent context; context.dispose() alone fires
        // sequence cleanup without awaiting it and can race Metal teardown.
        try {
          await sequence.dispose();
        } finally {
          await context.dispose().catch(() => undefined);
        }
      }
    },
    dispose: async () => model.dispose().catch(() => undefined),
  };
}

/**
 * Strip artefacts a chat model adds around the passage.
 *
 * Models wrap output in quotes, prefix `Passage:`, or emit a `<think>` block even
 * when told not to. Embedding that scaffolding would embed instructions rather
 * than an answer, so it is removed before the text is used.
 */
/**
 * Delimiter pairs a model may wrap a passage in.
 *
 * Listed as explicit open/close pairs rather than matched with a backreference,
 * because typographic quotes are two *different* codepoints: `“` is U+201C and `”`
 * is U+201D, so `/^(["'“”])(.+)\1$/` silently fails to unwrap exactly the case a
 * chat model is most likely to emit.
 */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["\u201c", "\u201d"],
  ["\u2018", "\u2019"],
];

export function cleanGeneratedPassage(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/giu, "");
  text = text.replace(/^\s*(?:passage|answer|response)\s*:\s*/iu, "");
  text = text.trim();

  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length <= open.length + close.length) continue;
    if (!text.startsWith(open) || !text.endsWith(close)) continue;
    const inner = text.slice(open.length, text.length - close.length);
    // Only unwrap when the delimiters enclose the whole passage. If the closing
    // mark also appears inside, the text is something like `"a" and "b"` and the
    // outer marks are not a wrapper, so stripping them would corrupt it.
    if (inner.includes(close)) continue;
    return inner.trim();
  }
  return text;
}

/**
 * Parse and validate the closed typed-query plan emitted by the generation model.
 */
export function parseExpandedPlan(
  raw: string,
  originalQuery: string,
  maxQueries = 12,
): readonly ExpandedSubQuery[] {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
  if (cleaned === "") throw new Error("Expansion generated no typed queries.");

  const plan: ExpandedSubQuery[] = [];
  for (const [index, line] of cleaned.split(/\r?\n/u).entries()) {
    const match = /^(lex|vec|hyde):\s+(.+)$/u.exec(line.trim());
    if (match === null) {
      throw new Error(`Expansion output line ${index + 1} is not a valid lex, vec, or hyde query.`);
    }
    const type = match[1] as ExpandedSubQuery["type"];
    const query = match[2]!.trim();
    if (query === "") throw new Error(`Expansion output line ${index + 1} has an empty query.`);
    plan.push({ type, query });
  }
  return validateExpandedPlan(plan, originalQuery, maxQueries);
}

/**
 * Validate a plan at the assembly/facade boundary too, so caller-injected
 * expanders cannot bypass the same closed contract as the local model.
 */
export function validateExpandedPlan(
  value: unknown,
  originalQuery: string,
  maxQueries = 12,
): readonly ExpandedSubQuery[] {
  if (!Number.isSafeInteger(maxQueries) || maxQueries < 1 || maxQueries > 32) {
    throw new Error("Expansion maxQueries must be a safe integer between 1 and 32.");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Expansion generated no typed queries.");
  }
  if (value.length > maxQueries) {
    throw new Error(`Expansion output exceeds the ${maxQueries}-query budget.`);
  }
  const plan: ExpandedSubQuery[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (
      typeof item !== "object"
      || item === null
      || Array.isArray(item)
      || !("type" in item)
      || !("query" in item)
      || (item.type !== "lex" && item.type !== "vec" && item.type !== "hyde")
      || typeof item.query !== "string"
      || item.query.trim() === ""
    ) {
      throw new Error(`Expansion query ${index + 1} must contain a non-empty lex, vec, or hyde query.`);
    }
    const subQuery: ExpandedSubQuery = { type: item.type, query: item.query.trim() };
    const key = `${subQuery.type}\u0000${subQuery.query.toLocaleLowerCase()}`;
    if (seen.has(key)) {
      throw new Error(`Expansion output contains a duplicate ${subQuery.type} query.`);
    }
    seen.add(key);
    plan.push(subQuery);
  }
  if (plan.every((subQuery) => subQuery.query === originalQuery.trim())) {
    throw new Error(
      "Expansion returned only the original query unchanged; identity/no-op expansion is not success.",
    );
  }
  return plan;
}

/**
 * Create one lazy generation capability shared by HyDE and explicit expansion.
 *
 * Concurrent first calls share one construction promise, so two simultaneous HyDE
 * requests do not load the 1.7B model twice. Disposal releases the context and
 * model exactly once and is safe to call without ever having generated.
 */
export function createLlamaHydeGenerator(
  options: LlamaGeneratorOptions,
): DisposableGenerator {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const contextSize = options.contextSize ?? DEFAULT_CONTEXT_SIZE;
  let runtime: GenerationRuntime | null = null;
  let loading: Promise<GenerationRuntime> | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let activeCalls = 0;
  const idleWaiters: Array<() => void> = [];

  const ensureRuntime = async (): Promise<GenerationRuntime> => {
    if (runtime !== null) return runtime;
    loading ??= (options.loader ?? (() => defaultLoader(options.modelPath, contextSize)))()
      .then((loaded) => {
        runtime = loaded;
        return loaded;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  const beginCall = (): void => {
    if (disposed) throw new Error("Generator has been disposed.");
    activeCalls += 1;
  };
  const endCall = (): void => {
    activeCalls -= 1;
    if (activeCalls !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  const waitForIdle = async (): Promise<void> => {
    if (activeCalls === 0) return;
    await new Promise<void>((resolve) => idleWaiters.push(resolve));
  };

  return {
    generate: async (query: string): Promise<string> => {
      beginCall();
      try {
        const active = await ensureRuntime();
        const raw = await active.generate(hydePrompt(query), {
          maxTokens,
          temperature: 0.7,
          topK: 20,
          topP: 0.8,
          mode: "passage",
        });
        const passage = cleanGeneratedPassage(raw);
        // An empty passage is a generation failure, not a hypothetical document.
        // The dispatcher separately rejects a passage equal to the query, so a
        // model that merely echoes its input cannot masquerade as HyDE.
        if (passage === "") {
          throw new Error(
            "HyDE generation produced an empty hypothetical document after cleaning.",
          );
        }
        return passage;
      } finally {
        endCall();
      }
    },
    expand: async (request: ExpansionRequest): Promise<readonly ExpandedSubQuery[]> => {
      if (isCancelled(request.cancel)) throw new Error("Expansion cancelled.");
      if (typeof request.query !== "string" || request.query.trim() === "") {
        throw new Error("Expansion requires a non-empty query.");
      }
      beginCall();
      try {
        const active = await ensureRuntime();
        const raw = await active.generate(
          expansionPrompt(request.query, request.context),
          {
            maxTokens: 600,
            temperature: 0.7,
            topK: 20,
            topP: 0.8,
            mode: "typed-plan",
          },
        );
        if (isCancelled(request.cancel)) throw new Error("Expansion cancelled.");
        return parseExpandedPlan(raw, request.query, request.maxQueries);
      } finally {
        endCall();
      }
    },
    dispose: (): Promise<void> => {
      disposed = true;
      disposePromise ??= (async () => {
        // Wait for an in-flight load so its model is not orphaned.
        if (loading !== null) await loading.catch(() => undefined);
        // Loading and generation are distinct races: a resolved runtime may still
        // have one or more prompts decoding. Native model teardown starts only
        // after every admitted call has left its context.
        await waitForIdle();
        await runtime?.dispose().catch(() => undefined);
        runtime = null;
      })();
      return disposePromise;
    },
  };
}

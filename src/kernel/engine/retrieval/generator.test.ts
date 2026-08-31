import { describe, expect, it, vi } from "vitest";
import {
  cleanGeneratedPassage,
  createLlamaHydeGenerator,
  parseExpandedPlan,
  type GenerationRuntime,
} from "./generator.js";

/** A scripted runtime, so prompt and sampling are asserted without a real model. */
function fakeRuntime(reply: string | (() => Promise<string>)): {
  runtime: GenerationRuntime;
  calls: Array<{ prompt: string; options: Record<string, unknown> }>;
  disposed: () => number;
} {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  let disposeCount = 0;
  return {
    calls,
    disposed: () => disposeCount,
    runtime: {
      generate: async (prompt, options) => {
        calls.push({ prompt, options: { ...options } });
        return typeof reply === "string" ? reply : reply();
      },
      dispose: async () => {
        disposeCount += 1;
      },
    },
  };
}

describe("cleanGeneratedPassage", () => {
  it("keeps an ordinary passage untouched", () => {
    expect(cleanGeneratedPassage("Ataraxia is a state of serene calmness."))
      .toBe("Ataraxia is a state of serene calmness.");
  });

  it("removes a thinking block the model emits despite /no_think", () => {
    // Embedding a reasoning trace would embed the model's deliberation rather than
    // an answer, which defeats the point of HyDE.
    expect(cleanGeneratedPassage("<think>let me consider</think>\nAtaraxia is calm."))
      .toBe("Ataraxia is calm.");
    expect(cleanGeneratedPassage("<THINK>x</THINK> Real text")).toBe("Real text");
  });

  it("strips a leading label the model adds", () => {
    for (const prefix of ["Passage:", "passage: ", "Answer:", "Response:"]) {
      expect(cleanGeneratedPassage(`${prefix} Ataraxia is calm.`)).toBe("Ataraxia is calm.");
    }
  });

  it("unwraps a fully quoted passage", () => {
    expect(cleanGeneratedPassage('"Ataraxia is calm."')).toBe("Ataraxia is calm.");
    expect(cleanGeneratedPassage("\u201cAtaraxia is calm.\u201d")).toBe("Ataraxia is calm.");
  });

  it("leaves an internal quotation intact", () => {
    // Only a passage wrapped end to end is unwrapped; a quote inside the text is
    // part of the content.
    const text = 'Epicurus called it "ataraxia" in his letters.';
    expect(cleanGeneratedPassage(text)).toBe(text);
  });

  it("returns empty for output that was nothing but scaffolding", () => {
    expect(cleanGeneratedPassage("<think>only thinking</think>")).toBe("");
    expect(cleanGeneratedPassage("   ")).toBe("");
  });
});

describe("parseExpandedPlan", () => {
  it("accepts a closed typed plan while preserving model order", () => {
    expect(parseExpandedPlan(
      "lex: inner peace\nvec: freedom from anxiety\nhyde: A calm mind is undisturbed.",
      "what is ataraxia",
    )).toEqual([
      { type: "lex", query: "inner peace" },
      { type: "vec", query: "freedom from anxiety" },
      { type: "hyde", query: "A calm mind is undisturbed." },
    ]);
  });

  it.each([
    ["unknown type", "graph: ataraxia"],
    ["missing separator", "lex ataraxia"],
    ["empty query", "vec: "],
    ["prose wrapper", "Here are the queries:\nlex: ataraxia"],
  ])("rejects %s rather than partially executing the model output", (_case, output) => {
    expect(() => parseExpandedPlan(output, "ataraxia")).toThrow(/not a valid|empty query/);
  });

  it("rejects duplicate channels and text", () => {
    expect(() => parseExpandedPlan(
      "vec: inner peace\nvec: INNER PEACE",
      "ataraxia",
    )).toThrow(/duplicate vec query/);
  });

  it("rejects an identity/no-op-only plan", () => {
    expect(() => parseExpandedPlan(
      "lex: what is ataraxia\nvec: what is ataraxia\nhyde: what is ataraxia",
      "what is ataraxia",
    )).toThrow(/identity\/no-op/);
  });

  it("accepts the original lexical query when another channel is genuinely expanded", () => {
    expect(parseExpandedPlan(
      "lex: what is ataraxia\nvec: inner calm without disturbance",
      "what is ataraxia",
    )).toEqual([
      { type: "lex", query: "what is ataraxia" },
      { type: "vec", query: "inner calm without disturbance" },
    ]);
  });

  it("enforces a finite bounded plan budget", () => {
    expect(() => parseExpandedPlan("lex: a", "q", 0)).toThrow(/between 1 and 32/);
    expect(() => parseExpandedPlan("lex: a", "q", Number.NaN)).toThrow(/between 1 and 32/);
    expect(() => parseExpandedPlan("lex: a\nvec: b", "q", 1)).toThrow(/exceeds the 1-query budget/);
  });

  it("removes a thinking block before validating typed lines", () => {
    expect(parseExpandedPlan(
      "<think>I should expand this.</think>\nlex: calm\nvec: tranquility",
      "ataraxia",
    )).toEqual([
      { type: "lex", query: "calm" },
      { type: "vec", query: "tranquility" },
    ]);
  });
});

describe("createLlamaHydeGenerator", () => {
  it("loads no model until the first generation", async () => {
    const loader = vi.fn(async () => fakeRuntime("A calm mind.").runtime);
    const generator = createLlamaHydeGenerator({ modelPath: "/models/gen.gguf", loader });

    // Constructing an engine must not pay for a 1.7B model nobody asked for.
    expect(loader).not.toHaveBeenCalled();

    await generator.generate("what is calm");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("prompts for a passage and suppresses the thinking mode", async () => {
    const fake = fakeRuntime("A calm mind is undisturbed.");
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => fake.runtime,
    });

    await generator.generate("what is inner peace");

    const [call] = fake.calls;
    expect(call?.prompt).toContain("/no_think");
    expect(call?.prompt).toContain("Query: what is inner peace");
    // The instruction must ask for a passage, since HyDE embeds an answer rather
    // than the question.
    expect(call?.prompt).toMatch(/passage/i);
  });

  it("uses non-greedy sampling, which these models require", async () => {
    // Greedy decoding (temperature 0) drives repetition loops in this model
    // family; the reference toolchain calls that out explicitly.
    const fake = fakeRuntime("A calm mind.");
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => fake.runtime,
    });

    await generator.generate("q");

    expect(fake.calls[0]?.options).toMatchObject({
      temperature: 0.7,
      topK: 20,
      topP: 0.8,
    });
    expect(fake.calls[0]?.options.temperature).not.toBe(0);
  });

  it("expands through the same lazy runtime with taxonomy context and typed-plan mode", async () => {
    const fake = fakeRuntime("lex: ataraxia\nvec: freedom from mental disturbance");
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => fake.runtime,
    });

    const plan = await generator.expand({
      query: "what is ataraxia",
      context: "- 30. Zettels: Permanent notes and literature notes",
    });

    expect(plan).toEqual([
      { type: "lex", query: "ataraxia" },
      { type: "vec", query: "freedom from mental disturbance" },
    ]);
    expect(fake.calls[0]?.prompt).toContain("30. Zettels: Permanent notes and literature notes");
    expect(fake.calls[0]?.prompt).toContain("Query: what is ataraxia");
    expect(fake.calls[0]?.options).toMatchObject({
      mode: "typed-plan",
      temperature: 0.7,
      topK: 20,
      topP: 0.8,
    });
  });

  it("does not load a model for an already-cancelled expansion", async () => {
    const loader = vi.fn(async () => fakeRuntime("lex: never").runtime);
    const generator = createLlamaHydeGenerator({ modelPath: "/models/gen.gguf", loader });

    await expect(generator.expand({
      query: "cancel me",
      cancel: { cancelled: true },
    })).rejects.toThrow(/cancelled/);

    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects cancellation that arrives while generation is in flight", async () => {
    const cancel = { cancelled: false };
    const fake = fakeRuntime(async () => {
      cancel.cancelled = true;
      return "lex: ataraxia\nvec: calm";
    });
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => fake.runtime,
    });

    await expect(generator.expand({ query: "ataraxia", cancel })).rejects.toThrow(/cancelled/);
  });

  it("reuses one runtime across calls and shares a concurrent first load", async () => {
    let loads = 0;
    const fake = fakeRuntime("A calm mind.");
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => {
        loads += 1;
        return fake.runtime;
      },
    });

    await Promise.all([generator.generate("a"), generator.generate("b")]);
    await generator.generate("c");

    expect(loads).toBe(1);
    expect(fake.calls).toHaveLength(3);
  });

  it("rejects an empty passage rather than embedding nothing", async () => {
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => fakeRuntime("<think>nothing else</think>").runtime,
    });

    await expect(generator.generate("q")).rejects.toThrow(/empty hypothetical document/);
  });

  it("propagates a generation failure instead of returning the query", async () => {
    // Falling back to the raw query is the identity-stub behavior that made HyDE
    // dishonest in the first place.
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => fakeRuntime(async () => {
        throw new Error("context overflow");
      }).runtime,
    });

    await expect(generator.generate("what is calm")).rejects.toThrow(/context overflow/);
  });

  it("disposes the runtime exactly once, even for repeated dispose", async () => {
    const fake = fakeRuntime("A calm mind.");
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => fake.runtime,
    });

    await generator.generate("q");
    await Promise.all([generator.dispose(), generator.dispose()]);
    await generator.dispose();

    expect(fake.disposed()).toBe(1);
  });

  it("disposes without ever loading when no generation happened", async () => {
    const loader = vi.fn(async () => fakeRuntime("x").runtime);
    const generator = createLlamaHydeGenerator({ modelPath: "/models/gen.gguf", loader });

    await generator.dispose();

    expect(loader).not.toHaveBeenCalled();
  });

  it("refuses to generate after disposal", async () => {
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => fakeRuntime("A calm mind.").runtime,
    });

    await generator.dispose();

    await expect(generator.generate("q")).rejects.toThrow(/has been disposed/);
  });

  it("does not orphan a model that finishes loading during disposal", async () => {
    // The race worth guarding: dispose arrives while the load is in flight, so the
    // runtime appears after dispose ran and would otherwise leak its native context.
    const fake = fakeRuntime("A calm mind.");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => {
        await gate;
        return fake.runtime;
      },
    });

    const generating = generator.generate("q").catch(() => undefined);
    const disposing = generator.dispose();
    release?.();
    await Promise.all([generating, disposing]);

    expect(fake.disposed()).toBe(1);
  });

  it("waits for an in-flight prompt before disposing the native runtime", async () => {
    let releasePrompt: ((value: string) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const reply = new Promise<string>((resolve) => {
      releasePrompt = resolve;
    });
    let disposals = 0;
    const generator = createLlamaHydeGenerator({
      modelPath: "/models/gen.gguf",
      loader: async () => ({
        generate: async () => {
          markStarted?.();
          return reply;
        },
        dispose: async () => {
          disposals += 1;
        },
      }),
    });

    const generating = generator.generate("q");
    await started;
    let disposalFinished = false;
    const disposing = generator.dispose().then(() => {
      disposalFinished = true;
    });
    await Promise.resolve();

    expect(disposals).toBe(0);
    expect(disposalFinished).toBe(false);
    await expect(generator.generate("new call")).rejects.toThrow(/disposed/);

    releasePrompt?.("A hypothetical answer.");
    await expect(generating).resolves.toBe("A hypothetical answer.");
    await disposing;
    expect(disposals).toBe(1);
  });
});

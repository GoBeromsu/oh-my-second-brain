import { describe, expect, it } from "vitest";
import { createDeterministicStub, runCoT } from "./cot.js";

const stub = createDeterministicStub();

describe("runCoT — Step 1 analysis", () => {
  it("returns entities as a non-empty array", async () => {
    const result = await runCoT("knowledge-graph", "Source: graphs connect concepts.", stub);
    expect(Array.isArray(result.step1.entities)).toBe(true);
    expect(result.step1.entities.length).toBeGreaterThan(0);
  });

  it("returns concepts as a non-empty array", async () => {
    const result = await runCoT("knowledge-graph", "Source: graphs connect concepts.", stub);
    expect(result.step1.concepts.length).toBeGreaterThan(0);
  });

  it("returns arguments as an array", async () => {
    const result = await runCoT("test-concept", "Source: test material.", stub);
    expect(Array.isArray(result.step1.arguments)).toBe(true);
  });

  it("returns contradictions as an array", async () => {
    const result = await runCoT("test-concept", "Source: test material.", stub);
    expect(Array.isArray(result.step1.contradictions)).toBe(true);
  });

  it("returns structure as a non-empty string", async () => {
    const result = await runCoT("test-concept", "Source: test material.", stub);
    expect(typeof result.step1.structure).toBe("string");
    expect(result.step1.structure.length).toBeGreaterThan(0);
  });
});

describe("runCoT — Step 2 synthesis", () => {
  it("returns a body string", async () => {
    const result = await runCoT("knowledge-graph", "Source: graphs.", stub);
    expect(typeof result.body).toBe("string");
    expect(result.body.length).toBeGreaterThan(0);
  });

  it("body contains [[wikilinks]]", async () => {
    const result = await runCoT("test-concept", "Source: content.", stub);
    expect(result.body).toContain("[[");
    expect(result.body).toContain("]]");
  });

  it("body contains a ## See Also section", async () => {
    const result = await runCoT("test-concept", "Source: content.", stub);
    expect(result.body).toContain("## See Also");
  });
});

describe("runCoT — sequential ordering (Step 1 before Step 2)", () => {
  it("calls Step 1 (analysis) before Step 2 (synthesis)", async () => {
    const callLog: Array<"step1" | "step2"> = [];
    const trackingStub = {
      async complete(prompt: string): Promise<string> {
        if (prompt.includes("ENTITIES:") && prompt.includes("ARGUMENTS:")) {
          callLog.push("step1");
        } else {
          callLog.push("step2");
        }
        return stub.complete(prompt);
      },
    };
    await runCoT("concept", "material content", trackingStub);
    expect(callLog).toHaveLength(2);
    expect(callLog[0]).toBe("step1");
    expect(callLog[1]).toBe("step2");
  });

  it("Step 2 prompt includes Step 1 analysis context", async () => {
    const prompts: string[] = [];
    const captureStub = {
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return stub.complete(prompt);
      },
    };
    await runCoT("my-concept", "raw material", captureStub);
    // Step 2 prompt (index 1) must contain ANALYSIS CONTEXT block from Step 1
    expect(prompts[1]).toContain("ANALYSIS CONTEXT");
    expect(prompts[1]).toContain("Entities:");
  });
});

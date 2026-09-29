import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractStatus } from "../../kernel/contract/status.js";
import type { ToolContext } from "./shared.js";

// The posture is derived from contractStatus alone; stubbing it keeps the
// test away from the real ~/.oms store.
const contract = vi.hoisted(() => ({ current: null as ContractStatus | null }));
vi.mock("../../kernel/contract/status.js", () => ({ contractStatus: async () => contract.current }));
vi.mock("../../kernel/engine/retrieval/template-source.js", () => ({
  readSearchTemplateSource: async () => ({ source: { templates: null }, digest: "d", diagnostics: [] }),
}));
vi.mock("../../kernel/runtime/event-summary.js", () => ({ summarizeRuntimeHistory: () => ({}) }));

const { handleStatus } = await import("./status.js");

function ctx(source: ToolContext["source"]): ToolContext {
  return { vault: "/vault", source, engine: { adapter: { graphStatus: async () => null } } } as unknown as ToolContext;
}

async function writeTools(source: ToolContext["source"]): Promise<unknown> {
  const result = await handleStatus(ctx(source), ["search"]);
  return JSON.parse((result.content[0] as { text: string }).text).writeTools;
}

function unreadable(reason: "tampered" | "broken"): ContractStatus {
  return { contract: "unreadable", reason, row: "sealed", findings: [], templates: [] } as unknown as ContractStatus;
}

describe("handleStatus writeTools", () => {
  beforeEach(() => {
    contract.current = { contract: "sealed", row: "sealed", findings: [], templates: [] } as unknown as ContractStatus;
  });

  it("gates writes by target and contract on a readable contract", async () => {
    expect(await writeTools("explicit")).toBe("write-gated-by-verified-target-and-contract");
  });

  it("disables writes on a tampered contract", async () => {
    contract.current = unreadable("tampered");
    expect(await writeTools("explicit")).toBe("write-disabled-contract-tampered");
  });

  it("lets writes through unverified on a broken contract", async () => {
    contract.current = unreadable("broken");
    expect(await writeTools("explicit")).toBe("write-unverified-contract");
  });

  it("disables writes on a cwd-inferred target, whatever the contract", async () => {
    for (const current of [unreadable("tampered"), unreadable("broken")]) {
      contract.current = current;
      expect(await writeTools("cwd")).toBe("write-disabled-target-unverified");
    }
  });

  it("carries the unreadable reason in the contract status", async () => {
    contract.current = unreadable("broken");
    const result = await handleStatus(ctx("explicit"), ["search"]);
    expect(JSON.parse((result.content[0] as { text: string }).text).contract).toMatchObject({ contract: "unreadable", reason: "broken" });
  });
});

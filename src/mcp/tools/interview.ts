import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runInterview } from "../../kernel/contract/interview.js";
import { publicQuestion, scriptedIO } from "../../kernel/contract/scripted-interview.js";
import { contractStatus } from "../../kernel/contract/status.js";
import { errorText, jsonText, type ToolContext } from "./shared.js";

const ANSWER_ROUTE = "Ask the owner each question, then run `oms setup --answers <file>` (or the owner runs `oms interview` in a terminal). This tool seals nothing.";

/**
 * MCP `interview`: the questions the vault interview would ask now, and the seal state.
 * It runs the interview with no answers, so every run ends before the seal question is
 * answered and nothing is written. Answers go through `oms setup --answers`.
 */
export async function handleInterview(ctx: ToolContext, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const { vault } = ctx;
  const reask = args?.["reask"] === true;
  const seal = await contractStatus(vault);
  const { io, notes } = scriptedIO({});
  let result: Awaited<ReturnType<typeof runInterview>>;
  try {
    result = await runInterview({ vault, io, nonLoosening: true, ...(reask ? { reask: true } : {}) });
  } catch (error: unknown) {
    return errorText(`Oh My Second Brain MCP error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const base = { vault, contract: seal };
  switch (result.state) {
    case "incomplete":
      return jsonText({ ...base, status: "questions", questions: result.questions.map(publicQuestion), notes, next: ANSWER_ROUTE });
    case "interpretation-required":
      return jsonText({
        ...base,
        status: "interpretation-required",
        sources: result.sources,
        next: "Read each template source and pass its interpretation to `oms setup --questions --interpretations <file>` to see the remaining questions; observedHash must equal the sourceHash listed here.",
      });
    case "refused":
      return jsonText({ ...base, status: "refused", reasons: result.reasons });
    case "loosening":
      return jsonText({ ...base, status: "loosening", changes: result.changes, next: "Only the owner can loosen the sealed contract, by running `oms interview` in a terminal." });
    default:
      // No answers were given, so a seal or an owner decision cannot have happened.
      return errorText(`Oh My Second Brain MCP error: the interview ended in an unexpected state (${result.state}) without answers.`);
  }
}

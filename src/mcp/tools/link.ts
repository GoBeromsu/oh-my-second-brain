import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { checkLinksForNote, linkCheckPayload, linkSuggestPayload, suggestLinksForNote } from "../link-tools.js";
import { errorText, jsonText, stringArg, type ToolContext } from "./shared.js";

/** MCP `search op: link` and `doctor op: link-check`: suggest or check wikilinks. Returns undefined for an operation it does not own. */
export async function handleLink(ctx: ToolContext, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult | undefined> {
  const { vault, source } = ctx;
  if (name === "oms_link_suggest") {
    const notePath = stringArg(args, "notePath");
    if (!notePath) {
      return errorText('Missing required string argument "notePath".');
    }
    const suggestion = await suggestLinksForNote(
      { vault, source, notePath },
      { folder: stringArg(args, "folder") },
    );
    return jsonText({ vault, ...linkSuggestPayload(suggestion) });
  }

  if (name === "oms_link_check") {
    const notePath = stringArg(args, "notePath");
    if (!notePath) {
      return errorText('Missing required string argument "notePath".');
    }
    const report = await checkLinksForNote(
      { vault, source, notePath },
      { folder: stringArg(args, "folder") },
    );
    return jsonText({ vault, ...linkCheckPayload(report) });
  }
  return undefined;
}

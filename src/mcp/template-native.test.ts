import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";

import { omsMcpTools } from "./server.js";

function validate(tool: string, input: Record<string, unknown>): boolean {
  const schema = omsMcpTools.find(candidate => candidate.name === tool)?.inputSchema;
  if (schema === undefined) throw new Error(`missing ${tool} schema`);
  return new AjvJsonSchemaValidator().getValidator(schema)(input).valid;
}

describe("template-native MCP surface", () => {
  it("keeps template listing, showing, and document reads mutually exclusive", () => {
    expect(validate("search", { op: "template-scan" })).toBe(false);
    expect(validate("search", { op: "templates" })).toBe(true);
    expect(validate("search", { op: "templates", templateId: "note" })).toBe(false);
    expect(validate("search", { op: "get-document", target: "notes/a.md" })).toBe(true);
    expect(validate("search", { op: "get-document", targets: ["notes/a.md"] })).toBe(true);
    expect(validate("search", { op: "get-document", notePath: "notes/a.md", fromLine: 1, lineCount: 20 })).toBe(true);
    expect(validate("search", { op: "get-document", target: "notes/a.md", targets: ["notes/a.md"] })).toBe(false);
  });

  it("advertises one write payload: {path, content, template?}", () => {
    expect(validate("write", { path: "notes/a.md", content: "body" })).toBe(true);
    expect(validate("write", { path: "notes/a.md", content: "body", template: "note" })).toBe(true);
    expect(validate("write", { path: "notes/a.md" })).toBe(false);
    expect(validate("write", { content: "body" })).toBe(false);
    // Retired guide/check/template branches have no schema at all.
    expect(validate("write", { op: "guide", notePath: "notes/a.md", templateId: "note" })).toBe(false);
    expect(validate("write", { op: "check", connectionId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" })).toBe(false);
    expect(validate("write", { op: "template", mode: "publish-contract", policy: { version: 5 }, transactionId: "33333333-3333-4333-8333-333333333333" })).toBe(false);
    expect(validate("write", { path: "notes/a.md", content: "body", templateId: "note" })).toBe(false);
  });

  it("keeps link read-only and doctor free of note backfill", () => {
    expect(validate("link", { op: "suggest", notePath: "notes/a.md" })).toBe(true);
    expect(validate("link", { op: "check", notePath: "notes/a.md" })).toBe(true);
    expect(validate("link", { op: "apply", notePath: "notes/a.md", baseContentHash: "0".repeat(64), candidateIds: [] })).toBe(false);
    expect(validate("doctor", { op: "validate" })).toBe(true);
    expect(validate("doctor", { op: "backfill-defaults", notePath: "notes/a.md", dryRun: true })).toBe(false);
  });

  it("uses query and index discriminators without retired aliases", () => {
    expect(validate("search", { op: "query", query: "lexical default" })).toBe(true);
    expect(validate("search", { op: "query", mode: "vsearch", query: "vector" })).toBe(true);
    expect(validate("search", { op: "query", searches: [{ type: "lex", query: "typed" }] })).toBe(true);
    expect(validate("search", { op: "query", mode: "query", searches: [{ type: "lex", query: "typed" }] })).toBe(false);
    expect(validate("search", { op: "query", query: "one", searches: [{ type: "lex", query: "two" }] })).toBe(false);
    expect(validate("search", { op: "index-status", view: "status" })).toBe(true);
    expect(validate("search", { op: "index-status", view: "collections" })).toBe(true);
    expect(validate("search", { op: "index-status", view: "contexts" })).toBe(true);
    expect(validate("search", { op: "collections" })).toBe(false);
  });

  it("keeps index repair exclusive from sync and embed options", () => {
    expect(validate("doctor", { op: "sync-embeddings", mode: "repair", repairMode: "rebuild" })).toBe(true);
    expect(validate("doctor", { op: "sync-embeddings", mode: "repair", repairMode: "drop", dryRun: true })).toBe(true);
    expect(validate("doctor", { op: "sync-embeddings", mode: "repair" })).toBe(false);
    expect(validate("doctor", { op: "sync-embeddings", mode: "sync", repairMode: "drop" })).toBe(false);
    expect(validate("doctor", { op: "sync-embeddings", mode: "embed", dryRun: true })).toBe(false);
  });
});

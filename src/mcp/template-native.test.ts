import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";

import { omsMcpTools } from "./server.js";

function validate(tool: string, input: Record<string, unknown>): boolean {
  const schema = omsMcpTools.find(candidate => candidate.name === tool)?.inputSchema;
  if (schema === undefined) throw new Error(`missing ${tool} schema`);
  return new AjvJsonSchemaValidator().getValidator(schema)(input).valid;
}

describe("template-native MCP surface", () => {
  it("keeps template listing, showing, scanning, and document reads mutually exclusive", () => {
    expect(validate("search", { op: "template-scan" })).toBe(true);
    expect(validate("search", { op: "templates" })).toBe(true);
    expect(validate("search", { op: "templates", templateId: "note" })).toBe(true);
    expect(validate("search", { op: "get-document", target: "notes/a.md" })).toBe(true);
    expect(validate("search", { op: "get-document", targets: ["notes/a.md"] })).toBe(true);
    expect(validate("search", { op: "get-document", notePath: "notes/a.md", fromLine: 1, lineCount: 20 })).toBe(true);
    expect(validate("search", { op: "get-document", target: "notes/a.md", targets: ["notes/a.md"] })).toBe(false);
  });

  it("accepts explicit and default note creation as distinct branches", () => {
    expect(validate("write", { op: "note", mode: "create", templateId: "note", body: "body" })).toBe(true);
    expect(validate("write", { op: "note", mode: "create", body: "body" })).toBe(true);
    expect(validate("write", { op: "note", mode: "create", templateId: "note", notePath: "notes/a.md", body: "body" })).toBe(false);
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

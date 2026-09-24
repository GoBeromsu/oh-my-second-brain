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

  it("advertises contract selection and a locator-bound check", () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    // Guide selects a contract for one explicit saved path.
    expect(validate("write", { op: "guide", notePath: "notes/a.md", templateId: "note" })).toBe(true);
    expect(validate("write", { op: "guide", notePath: "notes/a.md", headingBindings: { summary: "Summary" } })).toBe(true);
    expect(validate("write", { op: "guide" })).toBe(false);
    // Check reads the selection the session already holds, not caller-supplied rules.
    expect(validate("write", { op: "check", connectionId, sessionId })).toBe(true);
    expect(validate("write", { op: "check", connectionId })).toBe(false);
    expect(validate("write", { op: "check", notePath: "notes/a.md" })).toBe(false);
    // Completion is not an operation: OMS reports mechanics, not a verdict.
    expect(validate("write", { op: "complete", checkpoint: { schemaVersion: 1 }, review: {} })).toBe(false);
    // OMS does not write ordinary notes, so no note-write branch exists.
    expect(validate("write", { op: "note", mode: "create", templateId: "note", body: "body" })).toBe(false);
    expect(validate("write", { op: "check", connectionId, sessionId, body: "unsaved" })).toBe(false);
  });

  it("exposes the linear review protocol with canonical CAS and approval guards", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(validate("write", { op: "template", mode: "interview-next" })).toBe(true);
    expect(validate("write", { op: "template", mode: "interview-next", dryRun: true })).toBe(false);
    expect(validate("write", {
      op: "template",
      mode: "interview-answer",
      questionId: digest,
      answer: { required: true },
      censusDigest: digest,
      expectedLedgerDigest: null,
    })).toBe(true);
    expect(validate("write", {
      op: "template",
      mode: "interview-answer",
      questionId: digest,
      answer: { required: true },
      censusDigest: digest,
      expectedLedgerDigest: "sha256:BAD",
    })).toBe(false);
    expect(validate("write", {
      op: "template",
      mode: "commit-contracts",
      censusDigest: digest,
      expectedLedgerDigest: null,
      dryRun: true,
    })).toBe(true);
    expect(validate("write", {
      op: "template",
      mode: "commit-contracts",
      censusDigest: digest,
      expectedLedgerDigest: digest,
      dryRun: false,
      approvedDigest: digest,
    })).toBe(true);
    expect(validate("write", {
      op: "template",
      mode: "commit-contracts",
      censusDigest: digest,
      expectedLedgerDigest: null,
      dryRun: false,
    })).toBe(false);
    expect(validate("write", {
      op: "template",
      mode: "interview-answer",
      questionId: digest,
      answer: true,
      censusDigest: digest,
      expectedLedgerDigest: null,
      question: [],
    })).toBe(false);
  });

  it("retires every template authoring and folder-registration mode", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    for (const mode of ["create", "update", "reclassify", "relocate-folder", "remove", "default", "register-folder", "register", "add-file", "later", "review"]) {
      expect(validate("write", { op: "template", mode, dryRun: true }), mode).toBe(false);
    }
    // Only the interview mutates contract configuration.
    expect(validate("write", { op: "template", mode: "interview-next" })).toBe(true);
    expect(validate("write", {
      op: "template",
      mode: "commit-contracts",
      censusDigest: digest,
      expectedLedgerDigest: null,
      dryRun: true,
    })).toBe(true);
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

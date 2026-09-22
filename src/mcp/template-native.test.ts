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
    expect(validate("write", { op: "note", mode: "create", templateId: "note", targetFolder: "Inbox", body: "body" })).toBe(true);
  });

  it("exposes the linear review protocol with canonical CAS and approval guards", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(validate("write", { op: "template", mode: "interview-next" })).toBe(true);
    expect(validate("write", { op: "template", mode: "interview-next", templateId: "agent-session" })).toBe(true);
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

  it("exposes exact-digest pending-source repair as a guarded branch", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const request = {
      op: "template",
      mode: "repair-pending-source",
      templateId: "agent-session",
      pendingSource: {
        path: "Templates/agent-session.md",
        content: "---\ntitle: Agent Session\n---\n<!-- oms:content -->\n",
        expectedDigest: digest,
        renderer: "obsidian-core",
      },
    };
    expect(validate("write", { ...request, dryRun: true })).toBe(true);
    expect(validate("write", {
      ...request,
      pendingSource: { ...request.pendingSource, expectedDigest: "sha256:BAD" },
      dryRun: true,
    })).toBe(false);
    expect(validate("write", request)).toBe(false);
  });

  it("keeps folder registration while retiring per-file and guessed review modes", () => {
    expect(validate("write", {
      op: "template",
      mode: "register-folder",
      folder: { path: "Templates/Review" },
      dryRun: true,
    })).toBe(true);
    expect(validate("write", {
      op: "template",
      mode: "register-folder",
      folder: { path: "Templates/Review", mode: "auto" },
      dryRun: true,
    })).toBe(false);
    for (const mode of ["register", "add-file", "later", "review"]) {
      expect(validate("write", { op: "template", mode, dryRun: true })).toBe(false);
    }
  });

  it("requires write publication for create while retaining verified moved updates", () => {
    const binding = {
      templateId: "note",
      destinationClass: "managed-default",
      renderer: "obsidian-core",
      sourceFolder: "Templates/Review",
      sourcePath: "Templates/Review/note.md",
      contract: "note",
      naming: "{{title}}.md",
    };
    const source = {
      path: "Templates/Review/note.md",
      content: "# Note\n",
    };
    expect(validate("write", {
      op: "template",
      mode: "create",
      binding,
      source: { ...source, publication: "write" },
      dryRun: true,
    })).toBe(true);
    expect(validate("write", {
      op: "template",
      mode: "create",
      binding,
      source: { ...source, publication: "verify-existing" },
      dryRun: true,
    })).toBe(false);
    expect(validate("write", {
      op: "template",
      mode: "update",
      templateId: "note",
      binding,
      source: { ...source, publication: "verify-existing" },
      moveStrategy: "register-already-moved",
      dryRun: true,
    })).toBe(true);
    expect(validate("write", {
      op: "template",
      mode: "update",
      templateId: "note",
      binding: { ...binding, content: { version: 1 } },
      source: { ...source, publication: "write" },
      dryRun: true,
    })).toBe(false);
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

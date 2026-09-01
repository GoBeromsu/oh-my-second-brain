import { describe, expect, it } from "vitest";
import {
  UnsafeYamlEditError,
  renderYamlEntryPreservingComments,
} from "./common.js";

const entry = { command: "oms", args: ["mcp", "--vault", "/vault"], enabled: true };
const path = ["mcp_servers", "oms"] as const;

describe("renderYamlEntryPreservingComments", () => {
  it("splices only the oms entry while retaining Korean text, BOM, CRLF, and comments", () => {
    const raw = "\uFEFF# 앞\r\nmcp_servers:\r\n  other: keep # 유지\r\n  oms:\r\n    command: old\r\n# 뒤\r\n";
    const result = renderYamlEntryPreservingComments(raw, path, { kind: "set", value: entry });
    expect(result.changed).toBe(true);
    expect(result.text.startsWith("\uFEFF# 앞\r\nmcp_servers:\r\n  other: keep # 유지\r\n")).toBe(true);
    expect(result.text).toContain("# 뒤\r\n");
    expect(result.text).toContain("    command: oms\r\n");
  });

  it("is idempotent and preserves a missing-entry document through deletion", () => {
    const raw = "name: 한글\n# keep\nmcp_servers:\n  other: keep\n";
    const inserted = renderYamlEntryPreservingComments(raw, path, { kind: "set", value: entry });
    const again = renderYamlEntryPreservingComments(inserted.text, path, { kind: "set", value: entry });
    expect(again.text).toBe(inserted.text);
    const removed = renderYamlEntryPreservingComments(inserted.text, path, { kind: "delete" });
    expect(removed.text).toBe(raw);
  });

  it("rejects null, scalar, and sequence mcp_servers sections for either edit", () => {
    for (const raw of ["mcp_servers: null\n", "mcp_servers: disabled\n", "mcp_servers: []\n"]) {
      for (const edit of [{ kind: "set", value: entry } as const, { kind: "delete" } as const]) {
        expect(() => renderYamlEntryPreservingComments(raw, path, edit)).toThrow(UnsafeYamlEditError);
      }
    }
  });

  it("adds a leading EOL when appending to a file without a final newline", () => {
    const raw = "mcp_servers:\n  other: keep";
    const result = renderYamlEntryPreservingComments(raw, path, { kind: "set", value: entry });
    expect(result.text).toBe("mcp_servers:\n  other: keep\n  oms:\n    command: oms\n    args:\n      - mcp\n      - --vault\n      - /vault\n    enabled: true");
  });

  it("restores the original bytes when a newly-created section is deleted", () => {
    const raw = "name: 한글";
    const inserted = renderYamlEntryPreservingComments(raw, path, { kind: "set", value: entry });
    const removed = renderYamlEntryPreservingComments(inserted.text, path, { kind: "delete" });
    expect(removed.text).toBe(raw);
  });

  it("rejects target comments and root insertion around terminators or trailing comments", () => {
    for (const raw of [
      "mcp_servers:\n  oms: # owned\n    command: old\n",
      "mcp_servers:\n  # owned\n  oms:\n    command: old\n",
      "name: keep\n...\n",
      "name: keep\n# trailing\n",
    ]) {
      expect(() => renderYamlEntryPreservingComments(raw, path, { kind: "set", value: entry })).toThrow(UnsafeYamlEditError);
    }
  });

  it("rejects ambiguous YAML constructs before any write", () => {
    for (const raw of [
      "mcp_servers: &servers {}\n",
      "mcp_servers: *servers\n",
      "mcp_servers:\n  <<: { oms: {} }\n",
      "mcp_servers:\n\toms: {}\n",
      "mcp_servers:\n  oms: {}\n  oms: {}\n",
    ]) {
      expect(() => renderYamlEntryPreservingComments(raw, path, { kind: "set", value: entry })).toThrow(UnsafeYamlEditError);
    }
  });
});

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

  it("rejects ambiguous YAML constructs before any write", () => {
    for (const raw of [
      "mcp_servers: &servers {}\n",
      "mcp_servers: *servers\n",
      "mcp_servers:\n\toms: {}\n",
      "mcp_servers:\n  oms: {}\n  oms: {}\n",
    ]) {
      expect(() => renderYamlEntryPreservingComments(raw, path, { kind: "set", value: entry })).toThrow(UnsafeYamlEditError);
    }
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContractView } from "../contract/types.js";
import { buildReceipt, contractRevision, noteRevision } from "./receipt.js";

const SEALED: ContractView = { state: "sealed", contract: { folders: null, properties: null, templates: {} } };

function sha(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

describe("write receipt", () => {
  it("has exactly the fixed receipt keys", () => {
    const receipt = buildReceipt({ path: "Projects/a.md", content: "A\n", view: SEALED, keyword: "updated", conformed: [{ field: "created", action: "default" }], missingDefaults: ["due"] });
    expect(Object.keys(receipt).sort()).toEqual(["conformed", "contractRevision", "index", "missingDefaults", "ok", "path", "revision"]);
    expect(receipt).toEqual({
      ok: true,
      path: "Projects/a.md",
      revision: sha("A\n"),
      contractRevision: sha(JSON.stringify(SEALED.state === "sealed" ? SEALED.contract : null)),
      index: { keyword: "updated", vector: "pending" },
      conformed: [{ field: "created", action: "default" }],
      missingDefaults: [{ field: "due" }],
    });
  });

  it("queues vectors only when the keyword update reached the store", () => {
    for (const keyword of ["failed", "skipped"] as const) {
      const receipt = buildReceipt({ path: "a.md", content: "", view: SEALED, keyword, conformed: [], missingDefaults: [] });
      expect(receipt.index).toEqual({ keyword, vector: "disabled" });
    }
  });

  it("names no contract revision for an open or unreadable contract", () => {
    expect(contractRevision({ state: "open" })).toBeNull();
    expect(contractRevision({ state: "unreadable" })).toBeNull();
    expect(buildReceipt({ path: "a.md", content: "x", view: { state: "open" }, keyword: "skipped", conformed: [], missingDefaults: [] }).contractRevision).toBeNull();
  });

  it("uses the digest of the note bytes as its revision", () => {
    expect(noteRevision("목표\n")).toBe(sha("목표\n"));
    expect(noteRevision("a")).not.toBe(noteRevision("b"));
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContractView } from "../contract/types.js";
import { buildReceipt, contractRevision, noteRevision } from "./receipt.js";

const SEALED: ContractView = { state: "sealed", contract: { folders: null, properties: null, templates: {} } };

function sha(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

describe("write receipt", () => {
  it("has exactly the fixed receipt keys", () => {
    const receipt = buildReceipt({ path: "Projects/a.md", content: "A\n", view: SEALED, keyword: "updated", conformed: [{ field: "created", action: "default" }], missingDefaults: ["due"] });
    expect(Object.keys(receipt).sort()).toEqual(["conformed", "contractRevision", "fixes", "index", "missingDefaults", "ok", "path", "revision", "warnings"]);
    expect(receipt).toEqual({
      ok: true,
      path: "Projects/a.md",
      revision: sha("A\n"),
      contractRevision: sha(JSON.stringify(SEALED.state === "sealed" ? SEALED.contract : null)),
      index: { keyword: "updated", vector: "pending" },
      conformed: [{ field: "created", action: "default" }],
      missingDefaults: [{ field: "due" }],
      warnings: [],
      fixes: [],
    });
  });

  it("carries every warning and fix down to field and kind", () => {
    const warning = { field: "status", kind: "not-allowed", detail: "x" } as const;
    const receipt = buildReceipt({
      path: "a.md", content: "x", view: SEALED, keyword: "skipped", conformed: [], missingDefaults: [],
      warnings: [warning, { field: "mood", kind: "unknown-property" }], fixes: [{ field: "title", kind: "missing" }],
    });
    expect(receipt.warnings).toEqual([{ field: "status", kind: "not-allowed" }, { field: "mood", kind: "unknown-property" }]);
    expect(receipt.fixes).toEqual([{ field: "title", kind: "missing" }]);
    expect(JSON.stringify(receipt)).not.toContain("detail");
  });

  it("names the revision read once by the pipeline instead of recomputing it from the view", () => {
    const precomputed = sha("contract read once");
    const base = { path: "a.md", content: "x", view: SEALED, keyword: "skipped", conformed: [], missingDefaults: [] } as const;
    expect(buildReceipt({ ...base, contractRevision: precomputed }).contractRevision).toBe(precomputed);
    expect(buildReceipt({ ...base, contractRevision: null }).contractRevision).toBeNull();
    expect(buildReceipt(base).contractRevision).toBe(contractRevision(SEALED));
  });

  it("lists recorded gaps and a failed ledger only when there is something to say", () => {
    const base = { path: "a.md", content: "x", view: SEALED, keyword: "skipped", conformed: [], missingDefaults: [] } as const;
    const gap = { id: "g1", axis: "value", kind: "no-fit", field: "status" } as const;
    expect(buildReceipt({ ...base, gaps: [] })).not.toHaveProperty("gaps");
    expect(buildReceipt({ ...base, gaps: [gap] }).gaps).toEqual([gap]);
    expect(buildReceipt({ ...base, gapLedger: "failed" }).gapLedger).toBe("failed");
    expect(buildReceipt(base)).not.toHaveProperty("gapLedger");
  });

  it("queues vectors only when the keyword update reached the store", () => {
    for (const keyword of ["failed", "skipped"] as const) {
      const receipt = buildReceipt({ path: "a.md", content: "", view: SEALED, keyword, conformed: [], missingDefaults: [] });
      expect(receipt.index).toEqual({ keyword, vector: "disabled" });
    }
  });

  it("names no contract revision for an open or unreadable contract", () => {
    expect(contractRevision({ state: "open" })).toBeNull();
    expect(contractRevision({ state: "unreadable", reason: "broken" })).toBeNull();
    expect(buildReceipt({ path: "a.md", content: "x", view: { state: "open" }, keyword: "skipped", conformed: [], missingDefaults: [] }).contractRevision).toBeNull();
  });

  it("uses the digest of the note bytes as its revision", () => {
    expect(noteRevision("목표\n")).toBe(sha("목표\n"));
    expect(noteRevision("a")).not.toBe(noteRevision("b"));
  });
});

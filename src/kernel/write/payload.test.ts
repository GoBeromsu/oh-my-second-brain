import { describe, expect, it } from "vitest";
import type { WriteRejection } from "../conventions/write-protocol.js";
import { formatDenyReason } from "../contract/types.js";
import { deniedWritePayload, writePayload } from "./payload.js";
import type { WriteCheck } from "./pipeline.js";
import type { WriteReceipt } from "./receipt.js";

const RECEIPT: WriteReceipt = {
  ok: true,
  path: "a.md",
  revision: `sha256:${"a".repeat(64)}`,
  contractRevision: null,
  index: { keyword: "skipped", vector: "disabled" },
  conformed: [],
  missingDefaults: [],
  warnings: [],
  fixes: [],
};

describe("writePayload", () => {
  it("passes a receipt through unchanged", () => {
    expect(writePayload({ kind: "written", receipt: RECEIPT })).toBe(RECEIPT);
  });

  it("reports a rejected target", () => {
    const rejection: WriteRejection = { stage: "admission", code: "target-unverified", message: "m", recoverable: true, remediation: "r" };
    expect(writePayload({ kind: "rejected", rejection })).toEqual({ ok: false, status: "rejected", rejection });
  });

  it("denies with the refusals stripped to field and kind, the deprecated violations and a reason", () => {
    const extra = { field: "path", kind: "path-unsafe", detail: "x" } as const;
    const payload = writePayload({ kind: "denied", refusals: [extra] });
    expect(payload).toEqual({
      ok: false,
      status: "denied",
      refusals: [{ field: "path", kind: "path-unsafe" }],
      violations: [{ field: "path", kind: "path-unsafe" }],
      reason: formatDenyReason([extra]),
    });
    expect(JSON.stringify(payload)).not.toContain("detail");
    expect(deniedWritePayload([{ field: "ifMatch", kind: "unsupported-input" }])).toMatchObject({
      ok: false, status: "denied", refusals: [{ field: "ifMatch", kind: "unsupported-input" }], violations: [{ field: "ifMatch", kind: "unsupported-input" }],
    });
  });

  it("carries the draft ref and warnings of a drafted note and nothing of its content", () => {
    // A caller may hand a finding with extra detail; the payload must still carry only field and kind.
    const warning = { field: "path", kind: "unregistered-folder", detail: "Elsewhere" } as const;
    const payload = writePayload({ kind: "drafted", draftRef: "draft-00000000-0000-4000-8000-000000000001.md", warnings: [warning] });
    expect(payload).toEqual({ ok: false, status: "drafted", draftRef: "draft-00000000-0000-4000-8000-000000000001.md", warnings: [{ field: "path", kind: "unregistered-folder" }] });
    expect(JSON.stringify(payload)).not.toContain("Elsewhere");
    expect(writePayload({ kind: "denied", refusals: [] })).not.toHaveProperty("draftRef");
  });

  it("asks for ifMatch on an overwrite", () => {
    expect(writePayload({ kind: "if-match-required" })).toMatchObject({ ok: false, code: "WRITE_IF_MATCH_REQUIRED", kind: "if-match-required" });
  });

  it("marks changed, vanished and absent targets as retryable", () => {
    expect(writePayload({ kind: "retry", state: "changed" })).toMatchObject({ ok: false, code: "WRITE_TARGET_CHANGED", retryable: true });
    expect(writePayload({ kind: "retry", state: "vanished" })).toMatchObject({ ok: false, code: "WRITE_TARGET_VANISHED", retryable: true });
    expect(writePayload({ kind: "retry", state: "absent" })).toMatchObject({ ok: false, code: "WRITE_TARGET_ABSENT", retryable: true, reason: expect.stringContaining("without ifMatch") });
  });

  it("reports template-source drift separately from a changed note", () => {
    expect(writePayload({ kind: "retry", state: "source-changed" })).toEqual({
      ok: false,
      code: "WRITE_TEMPLATE_SOURCE_CHANGED",
      retryable: true,
      reason: "The live template sources changed after they were read; no note was published. Retry the write to use the current templates.",
    });
  });

  it("flattens a check result", () => {
    const check: WriteCheck = {
      ok: true,
      path: "a.md",
      revision: null,
      contractRevision: null,
      refusals: [],
      warnings: [{ field: "status", kind: "not-allowed" }],
      fixes: [],
      violations: [],
      missingDefaults: ["due"],
      conformed: [{ field: "content", action: "variable" }],
      frame: { contract: "open", folder: null, properties: [], template: null, defaults: [] },
      resolution: { action: "save", gaps: [], wouldDraft: false },
    };
    expect(writePayload({ kind: "checked", check })).toEqual({
      ...check,
      status: "checked",
      refusals: [],
      warnings: [{ field: "status", kind: "not-allowed" }],
      fixes: [],
      violations: [],
      missingDefaults: [{ field: "due" }],
    });
    const refused: WriteCheck = { ...check, ok: false, refusals: [{ field: "path", kind: "outside-vault" }], violations: [{ field: "path", kind: "outside-vault" }], warnings: [] };
    expect(writePayload({ kind: "checked", check: refused })).toMatchObject({
      ok: false, refusals: [{ field: "path", kind: "outside-vault" }], violations: [{ field: "path", kind: "outside-vault" }], warnings: [],
    });
  });
});

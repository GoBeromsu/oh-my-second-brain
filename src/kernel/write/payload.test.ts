import { describe, expect, it } from "vitest";
import type { WriteRejection } from "../conventions/write-protocol.js";
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
};

describe("writePayload", () => {
  it("passes a receipt through unchanged", () => {
    expect(writePayload({ kind: "written", receipt: RECEIPT })).toBe(RECEIPT);
  });

  it("reports a rejected target", () => {
    const rejection: WriteRejection = { stage: "admission", code: "target-unverified", message: "m", recoverable: true, remediation: "r" };
    expect(writePayload({ kind: "rejected", rejection })).toEqual({ ok: false, status: "rejected", rejection });
  });

  it("strips violations down to field and kind with a reason", () => {
    const extra = { field: "status", kind: "not-allowed", detail: "x" } as const;
    const payload = writePayload({ kind: "denied", violations: [extra] });
    expect(payload).toMatchObject({ ok: false, violations: [{ field: "status", kind: "not-allowed" }] });
    expect(JSON.stringify(payload)).not.toContain("detail");
    expect(deniedWritePayload([{ field: "ifMatch", kind: "unsupported-input" }])).toMatchObject({ ok: false, violations: [{ field: "ifMatch", kind: "unsupported-input" }] });
  });

  it("asks for ifMatch on an overwrite", () => {
    expect(writePayload({ kind: "if-match-required" })).toMatchObject({ ok: false, code: "WRITE_IF_MATCH_REQUIRED", kind: "if-match-required" });
  });

  it("marks changed, vanished and absent targets as retryable", () => {
    expect(writePayload({ kind: "retry", state: "changed" })).toMatchObject({ ok: false, code: "WRITE_TARGET_CHANGED", retryable: true });
    expect(writePayload({ kind: "retry", state: "vanished" })).toMatchObject({ ok: false, code: "WRITE_TARGET_VANISHED", retryable: true });
    expect(writePayload({ kind: "retry", state: "absent" })).toMatchObject({ ok: false, code: "WRITE_TARGET_ABSENT", retryable: true, reason: expect.stringContaining("without ifMatch") });
  });

  it("flattens a check result", () => {
    const check: WriteCheck = {
      ok: false,
      path: "a.md",
      revision: null,
      contractRevision: null,
      violations: [{ field: "status", kind: "not-allowed" }],
      missingDefaults: ["due"],
      conformed: [{ field: "content", action: "variable" }],
      frame: { contract: "open", folder: null, properties: [], template: null, defaults: [] },
    };
    expect(writePayload({ kind: "checked", check })).toEqual({
      ...check,
      status: "checked",
      violations: [{ field: "status", kind: "not-allowed" }],
      missingDefaults: [{ field: "due" }],
    });
  });
});

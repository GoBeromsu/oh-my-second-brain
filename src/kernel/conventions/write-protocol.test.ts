import { describe, it, expect } from "vitest";
import { rejection } from "./write-protocol.js";
import type { WriteRejectionCode } from "./write-protocol.js";

describe("write-protocol", () => {
  describe("rejection()", () => {
    it("stamps recoverable=true for target-unverified", () => {
      const result = rejection(
        "admission",
        "target-unverified",
        "no verified target",
        "run oms setup"
      );
      expect(result.recoverable).toBe(true);
      expect(result.stage).toBe("admission");
      expect(result.code).toBe("target-unverified");
      expect(result.message).toBe("no verified target");
      expect(result.remediation).toBe("run oms setup");
    });

    it("stamps recoverable=true for contract-violation", () => {
      const result = rejection(
        "acceptance",
        "contract-violation",
        "missing required field",
        "add the field"
      );
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe("contract-violation");
    });

    it("stamps recoverable=true for body-missing", () => {
      const result = rejection(
        "admission",
        "body-missing",
        "body required",
        "provide body"
      );
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe("body-missing");
    });

    it("stamps recoverable=true for args-invalid", () => {
      const result = rejection(
        "admission",
        "args-invalid",
        "invalid args",
        "check args"
      );
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe("args-invalid");
    });

    it("stamps recoverable=true for path-unsafe", () => {
      const result = rejection(
        "admission",
        "path-unsafe",
        "path is unsafe",
        "use safe path"
      );
      expect(result.recoverable).toBe(true);
      expect(result.code).toBe("path-unsafe");
    });

    it("stamps recoverable=false for note-exists", () => {
      const result = rejection(
        "admission",
        "note-exists",
        "note already exists",
        "use different path"
      );
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe("note-exists");
    });

    it("stamps recoverable=false for note-missing", () => {
      const result = rejection(
        "acceptance",
        "note-missing",
        "note not found",
        "create note first"
      );
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe("note-missing");
    });

    it("stamps recoverable=false for concept-unbound", () => {
      const result = rejection(
        "admission",
        "concept-unbound",
        "concept not bound",
        "bind concept"
      );
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe("concept-unbound");
    });

    it("stamps recoverable=false for target-invalid", () => {
      const result = rejection(
        "admission",
        "target-invalid",
        "target invalid",
        "register valid target"
      );
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe("target-invalid");
    });

    it("stamps recoverable=false for postcondition-failed", () => {
      const result = rejection(
        "acceptance",
        "postcondition-failed",
        "postcondition failed",
        "inspect file"
      );
      expect(result.recoverable).toBe(false);
      expect(result.code).toBe("postcondition-failed");
    });

    it("passes through stage, code, message, and remediation verbatim", () => {
      const stage = "acceptance";
      const code: WriteRejectionCode = "body-missing";
      const message = "body is missing";
      const remediation = "provide a body";

      const result = rejection(stage, code, message, remediation);

      expect(result.stage).toBe(stage);
      expect(result.code).toBe(code);
      expect(result.message).toBe(message);
      expect(result.remediation).toBe(remediation);
    });

    it("rejects unknown code at compile time", () => {
      // @ts-expect-error intentional - testing that unknown code is rejected
      rejection("admission", "not-a-code", "x", "y");
    });
  });
});

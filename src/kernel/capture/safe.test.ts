import { describe, expect, it } from "vitest";
import { admitWriteTarget } from "./safe.js";

const VAULT = "/tmp/oms-safe-admission";

describe("write target source admission", () => {
  it.each([
    ["explicit", "explicit vault selection"],
    ["vault", "local vault evidence"],
    ["bridge", "verified v2 bridge"],
    ["env", "OMS_VAULT"],
  ] as const)("admits a %s target from %s", async (source) => {
    expect(await admitWriteTarget({ vault: VAULT, source })).toBeUndefined();
  });

  it.each([
    ["cwd", /current directory/, new RegExp(VAULT)],
    ["legacy-bridge", /v1 bridge/, /was not converted/],
    ["selected-default", /unexpected source \(selected-default\)/, /not a verified write origin/],
  ] as const)("refuses a %s target with target-unverified guidance", async (source, origin, detail) => {
    const refused = await admitWriteTarget({ vault: VAULT, source });
    expect(refused?.stage).toBe("admission");
    expect(refused?.code).toBe("target-unverified");
    expect(refused?.recoverable).toBe(true);
    expect(refused?.message).toMatch(/guide, check, or complete/);
    expect(refused?.message).toMatch(origin);
    expect(refused?.message).toMatch(detail);
    expect(refused?.message).not.toMatch(/Refusing to write/);
    expect(refused?.remediation).toMatch(/explicit vault target/);
    expect(refused?.remediation).toMatch(/oms setup/);
    expect(refused?.remediation).toMatch(/OMS_VAULT/);
  });

  it("keeps a refused legacy bridge distinct from current-directory inference", async () => {
    const legacy = await admitWriteTarget({ vault: VAULT, source: "legacy-bridge" });
    const cwd = await admitWriteTarget({ vault: VAULT, source: "cwd" });
    expect(legacy?.message).not.toMatch(/current directory/);
    expect(cwd?.message).not.toMatch(/resolved from a v1 bridge/);
    expect(legacy?.message).not.toBe(cwd?.message);
  });
});

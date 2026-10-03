import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
// @ts-expect-error - shared release helper is plain ESM JavaScript without a declaration file
import { assertBoundMcpRegistration } from "../scripts/release-mcp-registration.mjs";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean | string;
}

interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
  "continue-on-error"?: boolean | string;
}

interface Workflow {
  on: {
    push: { tags: string[] };
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const readRepositoryFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflowSource = readRepositoryFile(".github/workflows/release.yml");
const workflow = parse(workflowSource) as Workflow;
const { verify, publish } = workflow.jobs;

describe("release rehearsal bound MCP registration", () => {
  it("accepts the verified Node alias, candidate CLI and canonical pointer vault", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oms-release-bound-"));
    try {
      const nodeAlias = path.join(root, "node");
      symlinkSync(process.execPath, nodeAlias);
      const cli = path.join(root, "oms.js");
      const vault = path.join(root, "vault");
      const vaultAlias = path.join(root, "vault-alias");
      writeFileSync(cli, "// candidate");
      mkdirSync(vault);
      symlinkSync(vault, vaultAlias);
      expect(() => assertBoundMcpRegistration(
        { command: nodeAlias, args: [cli, "serve", "mcp", "--vault", vaultAlias] },
        { node: process.execPath, cli, vault, pointerVault: vault },
      )).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["bare", "wrong-node", "wrong-cli", "wrong-vault", "wrong-pointer", "missing-pointer", "relative-node", "relative-cli", "wrong-op", "extra-arg"])(
    "refuses %s instead of weakening the installed-launch gate", (failure) => {
      const root = mkdtempSync(path.join(tmpdir(), "oms-release-bound-"));
      try {
        const cli = path.join(root, "oms.js");
        const other = path.join(root, "other");
        const vault = path.join(root, "vault");
        const otherVault = path.join(root, "other-vault");
        writeFileSync(cli, "// candidate");
        writeFileSync(other, "// wrong candidate");
        mkdirSync(vault); mkdirSync(otherVault);
        const registration = { command: process.execPath, args: [cli, "serve", "mcp", "--vault", vault] };
        const expected: { node: string; cli: string; vault: string; pointerVault?: string } = { node: process.execPath, cli, vault, pointerVault: vault };
        if (failure === "bare") { registration.command = "oms"; registration.args.shift(); }
        if (failure === "wrong-node") registration.command = other;
        if (failure === "wrong-cli") registration.args[0] = other;
        if (failure === "wrong-vault") registration.args[4] = otherVault;
        if (failure === "wrong-pointer") expected.pointerVault = otherVault;
        if (failure === "missing-pointer") delete expected.pointerVault;
        if (failure === "relative-node") registration.command = "node";
        if (failure === "relative-cli") registration.args[0] = "oms.js";
        if (failure === "wrong-op") registration.args[2] = "http";
        if (failure === "extra-arg") registration.args.push("--other");
        expect(() => assertBoundMcpRegistration(registration, expected)).toThrow();
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it("checks the actual installed launch and pointer before using that registration", () => {
    const smoke = readRepositoryFile("scripts/release-artifact-smoke.mjs");
    expect(smoke).toContain("assertBoundMcpRegistration(registration, {");
    expect(smoke).toContain("pointerVault: statusPayload.pointer?.pointer?.vault");
    expect(smoke).toContain("command: registration.command");
    expect(smoke).toContain("args: registration.args");
    expect(smoke).not.toContain('registration?.command !== "oms"');
  });
});

function publishEnabled(
  event: string,
  refType: string,
  ref: string,
  rehearsal: boolean | undefined,
  verification = "success",
): boolean {
  // Evaluate the actual workflow condition, not a duplicate policy function.
  // This condition uses only the shared JS/GitHub expression subset plus startsWith.
  expect(typeof publish.if).toBe("string");
  return runInNewContext(publish.if!, {
    github: { event_name: event, ref_type: refType, ref },
    inputs: { rehearsal },
    needs: { verify: { result: verification } },
    startsWith: (value: string, prefix: string) => value.toLowerCase().startsWith(prefix.toLowerCase()),
  }, { timeout: 1000 }) === true;
}

describe("release workflow authority", () => {
  it("grants only read access by default and in the shared verification job", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(["publish", "verify"]);
    // Explicit permission maps leave every unlisted permission, including id-token, at none.
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(verify.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(JSON.stringify(verify)).not.toMatch(/ACTIONS_ID_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN/);
  });

  it("requires shared verification and an explicit release-tag push before publishing", () => {
    expect(workflow.on.push).toEqual({ tags: ["oms-v*"] });
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(publish.needs).toBe("verify");
    expect(publishEnabled("push", "tag", "refs/tags/oms-v0.20.7", undefined)).toBe(true);
  });

  it.each([true, false, undefined])("keeps branch and tag dispatch verification-only with rehearsal=%s", (rehearsal) => {
    expect(publishEnabled("workflow_dispatch", "branch", "refs/heads/main", rehearsal)).toBe(false);
    expect(publishEnabled("workflow_dispatch", "branch", "refs/heads/oms-v0.20.7", rehearsal)).toBe(false);
    expect(publishEnabled("workflow_dispatch", "tag", "refs/tags/oms-v0.20.7", rehearsal)).toBe(false);
  });

  it.each([
    ["push", "branch", "refs/heads/main"],
    ["push", "branch", "refs/heads/oms-v0.20.7"],
    ["push", "tag", "refs/tags/v0.20.7"],
    ["push", "branch", "refs/tags/oms-v0.20.7"],
    ["pull_request", "tag", "refs/tags/oms-v0.20.7"],
    ["workflow_run", "tag", "refs/tags/oms-v0.20.7"],
  ])("refuses publication for event=%s ref_type=%s ref=%s", (event, refType, ref) => {
    expect(publishEnabled(event, refType, ref, undefined)).toBe(false);
  });

  it.each(["failure", "cancelled", "skipped", "", "in_progress"])(
    "cannot publish when verification result is %s",
    (verification) => {
      expect(publishEnabled("push", "tag", "refs/tags/oms-v0.20.7", undefined, verification)).toBe(false);
    },
  );

  it("keeps every publishing command inside the gated publish job and removes publish dry runs", () => {
    const publishingSteps = Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
      job.steps.filter((step) => /\bnpm publish\b|\bgh release create\b/.test(step.run ?? ""))
        .map((step) => ({ jobId, step })),
    );
    expect(publishingSteps).toHaveLength(2);
    expect(publishingSteps.map(({ jobId }) => jobId)).toEqual(["publish", "publish"]);
    expect(publishingSteps.map(({ step }) => step.name)).toEqual([
      "Publish to npm with provenance", "Create GitHub Release",
    ]);
    expect(workflowSource).not.toMatch(/\bnpm publish[^\n]*--dry-run/);
    expect(workflowSource).not.toMatch(/\bgit (?:tag|push)\b/);
    expect(publish["continue-on-error"]).toBeUndefined();
    for (const { step } of publishingSteps) {
      expect(step["continue-on-error"]).toBeUndefined();
      expect(step.if).toBeUndefined();
    }
  });
});

describe("release workflow verification", () => {
  it("runs the complete packing, artifact, plugin and measurement gates without optional failure paths", () => {
    expect(verify.if).toBeUndefined();
    expect(verify["continue-on-error"]).toBeUndefined();
    expect(verify.env).toMatchObject({
      OMS_REQUIRE_PLUGIN_VALIDATION: "1",
      OMS_MEASUREMENT_REQUIRED: "1",
      OMS_MEASUREMENT_ATTESTATION_REQUIRED: "1",
      OMS_MEASUREMENT_RELEASE: "1",
    });
    const releaseCheck = verify.steps.find((step) => step.run === "npm run release:check");
    expect(releaseCheck).toBeDefined();
    expect(releaseCheck?.if).toBeUndefined();
    expect(releaseCheck?.["continue-on-error"]).toBeUndefined();
    const { scripts } = JSON.parse(readRepositoryFile("package.json")) as { scripts: Record<string, string> };
    const gates = scripts["release:check"].split(" && ");
    expect(gates).toEqual([
      "npm run lint", "npm run build", "npm test", "npm run audit", "npm run check:docs",
      "npm run check:measurement", "npm run release:pack", "npm run release:artifact-smoke", "npm run release:plugin",
    ]);
    expect(scripts["release:pack"]).toBe("node scripts/release-pack.mjs");
    expect(scripts["release:artifact-smoke"]).toBe("node scripts/release-artifact-smoke.mjs");
    expect(scripts["release:plugin"]).toBe("node scripts/release-plugin.mjs");
    for (const path of ["scripts/release-pack.mjs", "scripts/release-artifact-smoke.mjs", "scripts/release-plugin.mjs"]) {
      expect(readRepositoryFile(path)).not.toMatch(/\bpublish\b[^\n]*--dry-run/);
    }
  });

  it("checks out the same immutable triggering commit in both jobs without persisted credentials", () => {
    for (const job of [verify, publish]) {
      const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0].with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
    }
    const installIndex = publish.steps.findIndex((step) => step.run === "npm ci");
    const buildIndex = publish.steps.findIndex((step) => step.run === "npm run build");
    const publishIndex = publish.steps.findIndex((step) => step.name === "Publish to npm with provenance");
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(buildIndex).toBeLessThan(publishIndex);
    expect(publish.steps[buildIndex].if).toBeUndefined();
    expect(publish.steps[buildIndex]["continue-on-error"]).toBeUndefined();
  });
});

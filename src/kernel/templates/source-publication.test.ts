import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes, hashCanonical } from "./canonical.js";
import { parseContractPolicyV5, serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";
import { prepareContractSourceAcknowledgment, prepareContractSourceRelink, type ContractSourcePublicationLocator } from "./source-registry.js";
import { serializeVaultSettings } from "./vault-settings.js";
import { commitPreparedContractSourcePublication, commitVaultPublication, inspectContractSourcePublication, planVaultPublication, prepareContractSourcePublication, prepareRollbackApprovalDigest, recoverVaultPublication, resumeContractSourcePublication, type VaultPublicationPlan } from "./vault-publication.js";

const roots: string[] = [];
const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_VAULT_ID = "55555555-5555-4555-8555-555555555555";
const reviewId = "33333333-3333-4333-8333-333333333333";
const relinkId = "44444444-4444-4444-8444-444444444444";
const ordinaryId = "22222222-2222-4222-8222-222222222222";
const markdown = "<%* throw new Error('must not execute') %>\n## Details\n{{agent-owned}}\n";
const changed = `${markdown}\nreviewed comment\n`;
const note = "ordinary note stays untouched\n";
const REVIEW_DECISION = "requested source acknowledgment; contract rules unchanged";
const RELINK_DECISION = "requested source relocation; contract rules unchanged";
const POLICY = ".oms/template-policy.json";
const SETTINGS = ".oms/settings.json";
const MARKER = ".oms/template-transaction.json";
const FLOWER = "Templates/agent/flower.md";
const APPROVAL = "Templates/human approval.md";
const MOVED = "Templates/moved.md";
const publisher = fileURLToPath(new URL("../../../dist/kernel/templates/vault-publication.js", import.meta.url));
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function locator(kind: ContractSourcePublicationLocator["kind"], templateId = "flower", transactionId = kind === "source-review" ? reviewId : relinkId): ContractSourcePublicationLocator {
  return { transactionId, kind, templateId };
}
async function tree(root: string, base = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    const relative = absolute.slice(base.length + 1);
    if (entry.isSymbolicLink()) result[relative] = `symlink:${await readFile(absolute, "utf8")}`;
    else if (entry.isDirectory()) Object.assign(result, await tree(absolute, base));
    else result[relative] = (await readFile(absolute)).toString("base64");
  }
  return result;
}
function policyText(kind: "review" | "relink", sourcePath = FLOWER): string {
  const policy: ContractPolicyV5 = {
    version: 5, revision: 1,
    properties: { tags: { type: "tags" } },
    common: { status: "active", fields: { tags: {} } },
    templates: {
      flower: { status: "active", fields: {}, headings: [{ headingId: "details", title: "Details", level: 2 }], source: { identity: "source-flower", path: sourcePath, rawDigest: digestBytes(markdown) } },
      other: { status: "active", fields: {}, source: { identity: "source-other", path: "Templates/other.md", rawDigest: digestBytes("other") } },
    },
  };
  return serializeContractPolicyV5(policy);
}
async function fixture(kind: "review" | "relink" = "review", sourcePath = FLOWER) {
  const created = await mkdtemp(join(tmpdir(), "oms-source-publication-"));
  const vault = await realpath(created);
  roots.push(vault);
  await mkdir(join(vault, ".oms/history/contracts"), { recursive: true });
  await mkdir(join(vault, "Templates"), { recursive: true });
  if (sourcePath === FLOWER || sourcePath.startsWith("Templates/agent/")) await mkdir(join(vault, "Templates/agent"), { recursive: true });
  await mkdir(join(vault, "Notes"), { recursive: true });
  await writeFile(join(vault, "Templates/other.md"), "other");
  await writeFile(join(vault, "Notes/untouched.md"), note);
  if (kind === "review") {
    await mkdir(join(vault, sourcePath, ".."), { recursive: true });
    await writeFile(join(vault, sourcePath), changed);
  } else await writeFile(join(vault, MOVED), markdown);
  const bytes = policyText(kind, sourcePath);
  await writeFile(join(vault, POLICY), bytes);
  await writeFile(join(vault, SETTINGS), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateRoots: ["Templates"] }));
  const target = { vault, source: "explicit" as const };
  const prepared = kind === "review"
    ? await prepareContractSourceAcknowledgment(vault, bytes, locator("source-review"))
    : await prepareContractSourceRelink(vault, bytes, locator("relink"), MOVED);
  return { vault, target, bytes, prepared, kind, sourcePath };
}
async function prepare(item: Awaited<ReturnType<typeof fixture>>) {
  return prepareContractSourcePublication(item.target, locator(item.kind === "review" ? "source-review" : "relink"), item.prepared.preparation);
}
function txRoot(vault: string, id: string): string { return join(vault, ".oms/.template-transactions", id); }
function historyPath(record: { revision: number }): string { return `.oms/history/contracts/${record.revision}.json`; }
async function snapshot(vault: string): Promise<Record<string, string>> { return tree(vault); }
async function unchanged(vault: string, before: Record<string, string>): Promise<void> { expect(await snapshot(vault)).toEqual(before); }
function decode(blob: { base64: string }): string { return Buffer.from(blob.base64, "base64").toString("utf8"); }
function rehash(plan: VaultPublicationPlan): VaultPublicationPlan {
  const { planDigest: _ignored, ...material } = plan;
  return { ...plan, planDigest: hashCanonical("oms.vault-publication.plan.v1", material) };
}
function withoutAbsentSources(plan: VaultPublicationPlan): VaultPublicationPlan {
  const { absentSources: _omitted, ...rest } = plan;
  return rehash(rest);
}
async function factualPlan(item: Awaited<ReturnType<typeof fixture>>): Promise<VaultPublicationPlan> {
  const sourcePath = item.kind === "review" ? item.sourcePath : MOVED;
  const reviewed = item.kind === "review" ? changed : markdown;
  const after = serializeContractPolicyV5({
    ...parseContractPolicyV5(item.bytes),
    revision: 2,
    templates: {
      ...parseContractPolicyV5(item.bytes).templates,
      flower: {
        ...parseContractPolicyV5(item.bytes).templates.flower,
        source: item.kind === "review"
          ? { identity: "source-flower", path: sourcePath, rawDigest: digestBytes(reviewed) }
          : { identity: "source-flower", path: MOVED, rawDigest: digestBytes(markdown) },
      },
    },
  });
  const review = item.kind === "review"
    ? { operation: "source-acknowledgment", templateId: "flower", sourceIdentity: "source-flower", sourcePath, previousRawDigest: digestBytes(markdown), reviewedRawDigest: digestBytes(reviewed) }
    : { operation: "source-relink", templateId: "flower", sourceIdentity: "source-flower", fromPath: item.sourcePath, toPath: MOVED, previousRawDigest: digestBytes(markdown), reviewedRawDigest: digestBytes(markdown) };
  const record = { version: 1, transactionId: item.kind === "review" ? reviewId : relinkId, kind: item.kind === "review" ? "source-review" : "relink", revision: 2, previousPolicyDigest: digestBytes(item.bytes), policyDigest: digestBytes(after), decision: item.kind === "review" ? REVIEW_DECISION : RELINK_DECISION, review };
  const request = {
    kind: "contract-publication" as const,
    vaultId: VAULT_ID,
    transactionId: record.transactionId,
    outputs: [{ path: POLICY, expectedDigest: digestBytes(item.bytes), content: after }, { path: historyPath(record), expectedDigest: null, content: `${JSON.stringify({ version: 1, transactionId: record.transactionId, kind: "publication", revision: 2, previousPolicyDigest: record.previousPolicyDigest, policyDigest: record.policyDigest, decision: "ordinary publication placeholder" })}\n` }],
    sources: [{ path: sourcePath, digest: digestBytes(reviewed) }],
  };
  const planned = await planVaultPublication(item.target, request);
  const history = planned.outputs.find(output => output.path === historyPath(record));
  if (history === undefined) throw new Error("ordinary plan did not emit history");
  const replaced: VaultPublicationPlan = {
    ...planned,
    outputs: planned.outputs.map(output => output.path === history.path ? { ...output, after: { digest: digestBytes(`${JSON.stringify(record)}\n`), base64: Buffer.from(`${JSON.stringify(record)}\n`).toString("base64") } } : output),
    ...(item.kind === "relink" ? { absentSources: [item.sourcePath] } : {}),
  };
  return rehash(replaced);
}
function installFs(method: "lstat" | "readdir", implementation: (...args: never[]) => Promise<unknown>): { calls: () => number; restore: () => void } {
  const descriptor = Object.getOwnPropertyDescriptor(fs.promises, method);
  let calls = 0;
  Object.defineProperty(fs.promises, method, { configurable: true, writable: true, value: async (...args: never[]) => { calls += 1; return implementation(...args); } });
  syncBuiltinESMExports();
  return { calls: () => calls, restore() { if (descriptor) Object.defineProperty(fs.promises, method, descriptor); syncBuiltinESMExports(); } };
}
async function absent(path: string): Promise<boolean> {
  try { await fs.promises.lstat(path); return false; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
}
function childEnv(home: string, vault: string, id: string, kind: ContractSourcePublicationLocator["kind"]): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    OMS_RUNTIME_ROOT: join(home, "runtime"),
    OMS_CHILD_PUBLISHER: publisher,
    OMS_CHILD_VAULT: vault,
    OMS_CHILD_TX: id,
    OMS_CHILD_KIND: kind,
  };
}
async function resumeChild(vault: string, id: string, kind: ContractSourcePublicationLocator["kind"]): Promise<{ status: string; digest: string; home: string; xdg: string; runtime: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oms-source-child-")));
  roots.push(home);
  const child = execFileSync(process.execPath, ["--input-type=module", "-e", "const { resumeContractSourcePublication } = await import(process.env.OMS_CHILD_PUBLISHER); const receipt = await resumeContractSourcePublication({ vault: process.env.OMS_CHILD_VAULT, source: 'explicit' }, { transactionId: process.env.OMS_CHILD_TX, kind: process.env.OMS_CHILD_KIND, templateId: 'flower' }); process.stdout.write(JSON.stringify({ status: receipt.status, digest: receipt.planDigest, home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, runtime: process.env.OMS_RUNTIME_ROOT }));"], {
    encoding: "utf8",
    env: childEnv(home, vault, id, kind),
  });
  return JSON.parse(child) as { status: string; digest: string; home: string; xdg: string; runtime: string };
}
async function settingsBytes(vaultId: string): Promise<string> {
  return serializeVaultSettings({ version: 1, vaultId, templateRoots: ["Templates"] });
}
async function replaceSettings(vault: string, vaultId: string): Promise<void> {
  await writeFile(join(vault, SETTINGS), await settingsBytes(vaultId));
}

describe("native source publication", () => {
  it("seals a successful source acknowledgment and changes only revision plus the selected digest", async () => {
    const item = await fixture();
    const settingsBefore = await readFile(join(item.vault, SETTINGS), "utf8");
    const publication = await prepare(item);
    const receipt = await commitPreparedContractSourcePublication(item.target, publication);
    expect(receipt.status).toBe("complete");
    const publishedText = await readFile(join(item.vault, POLICY), "utf8");
    const previous = parseContractPolicyV5(item.bytes);
    const flower = previous.templates.flower;
    if (flower.status !== "active") throw new Error("fixture flower is not active");
    expect(publishedText).toBe(serializeContractPolicyV5({ ...previous, revision: previous.revision + 1, templates: { ...previous.templates, flower: { ...flower, source: { ...flower.source, rawDigest: digestBytes(changed) } } } }));
    expect(await readFile(join(item.vault, FLOWER), "utf8")).toBe(changed);
    expect(await readFile(join(item.vault, "Notes/untouched.md"), "utf8")).toBe(note);
    expect(await readFile(join(item.vault, SETTINGS), "utf8")).toBe(settingsBefore);
    const history = JSON.parse(await readFile(join(item.vault, ".oms/history/contracts/2.json"), "utf8")) as { review: { sourcePath: string } };
    expect(history.review.sourcePath).toBe(FLOWER);
  });

  it("seals a successful relink and changes only revision plus the selected path", async () => {
    const item = await fixture("relink");
    const publication = await prepare(item);
    expect((await commitPreparedContractSourcePublication(item.target, publication)).status).toBe("complete");
    const publishedText = await readFile(join(item.vault, POLICY), "utf8");
    const previous = parseContractPolicyV5(item.bytes);
    const flower = previous.templates.flower;
    if (flower.status !== "active") throw new Error("fixture flower is not active");
    expect(publishedText).toBe(serializeContractPolicyV5({ ...previous, revision: previous.revision + 1, templates: { ...previous.templates, flower: { ...flower, source: { ...flower.source, path: MOVED } } } }));
    expect(await readFile(join(item.vault, MOVED), "utf8")).toBe(markdown);
    expect(await readFile(join(item.vault, "Notes/untouched.md"), "utf8")).toBe(note);
    await expect(readFile(join(item.vault, FLOWER))).rejects.toThrow();
  });

  it("acknowledges a legitimate source path containing human approval as data, not as an approval claim", async () => {
    const item = await fixture("review", APPROVAL);
    const publication = await prepare(item);
    const receipt = await commitPreparedContractSourcePublication(item.target, publication);
    expect(receipt.status).toBe("complete");
    const published = parseContractPolicyV5(await readFile(join(item.vault, POLICY), "utf8"));
    expect(published.templates.flower.source.path).toBe(APPROVAL);
    expect(published.templates.flower.source.rawDigest).toBe(digestBytes(changed));
    expect(await readFile(join(item.vault, APPROVAL), "utf8")).toBe(changed);
    const history = JSON.parse(await readFile(join(item.vault, ".oms/history/contracts/2.json"), "utf8")) as { decision: string; review: { sourcePath: string } };
    expect(history.decision).toBe(REVIEW_DECISION);
    expect(history.review.sourcePath).toBe(APPROVAL);
    expect(JSON.stringify(history)).not.toContain("approved");
  });

  it("refuses serialized, cross-root, and rebound private capabilities without writes", async () => {
    const item = await fixture();
    const before = await snapshot(item.vault);
    await expect(prepareContractSourcePublication(item.target, locator("source-review"), {})).rejects.toThrow(/capability|actual current policy/);
    await expect(prepareContractSourcePublication(item.target, locator("source-review"), JSON.parse(JSON.stringify(item.prepared)))).rejects.toThrow(/capability|actual current policy/);
    const other = await fixture();
    await expect(prepareContractSourcePublication(other.target, locator("source-review"), item.prepared.preparation)).rejects.toThrow(/capability|actual current policy/);
    await writeFile(join(item.vault, FLOWER), `${changed}\nrebound\n`);
    await expect(prepare(item)).rejects.toThrow(/capability|actual current policy/);
    await writeFile(join(item.vault, FLOWER), changed);
    await unchanged(item.vault, before);
    await unchanged(other.vault, await snapshot(other.vault));
  });

  it("refuses a public commit of an exact factual source plan before the private factory seals it", async () => {
    const item = await fixture();
    const before = await snapshot(item.vault);
    const forged = await factualPlan(item);
    expect(forged.outputs.map(output => output.path).sort()).toEqual([".oms/history/contracts/2.json", POLICY]);
    await expect(commitVaultPublication(item.target, forged, forged.planDigest)).rejects.toThrow(/private factory/);
    await unchanged(item.vault, before);
    expect((await readdir(join(item.vault, ".oms"))).sort()).toEqual(["history", "settings.json", "template-policy.json"]);
    await expect(readdir(join(item.vault, ".oms/.template-transactions"))).rejects.toThrow();
  });

  it("refuses ordinary fake migration and source history kinds through the public planner", async () => {
    const item = await fixture();
    const before = await snapshot(item.vault);
    const base = { path: POLICY, expectedDigest: digestBytes(item.bytes), content: item.bytes };
    await expect(planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, transactionId: reviewId, history: { kind: "source-review", decision: REVIEW_DECISION }, outputs: [base] })).rejects.toThrow("dedicated private source planner");
    await expect(planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, transactionId: relinkId, history: { kind: "relink", decision: RELINK_DECISION }, outputs: [base] })).rejects.toThrow("dedicated private source planner");
    await expect(planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, transactionId: ordinaryId, history: { kind: "migration", decision: "not a migration" }, outputs: [base, { path: ".oms/history/contracts/1.json", expectedDigest: null, content: "{}" }] })).rejects.toThrow(/migration|history|revision/);
    await unchanged(item.vault, before);
  });

  it("refuses strict history extra, missing, wrong keys, decision, policy-field, status, and identity tampering", async () => {
    const item = await fixture();
    const before = await snapshot(item.vault);
    const forged = await factualPlan(item);
    const history = forged.outputs.find(output => output.path.endsWith("/2.json"));
    if (history === undefined) throw new Error("missing factual history");
    const record = JSON.parse(decode(history.after)) as Record<string, unknown> & { review: Record<string, string>; decision: string; policyDigest: string; revision: number };
    const mutations: { value: Record<string, unknown>; reason: RegExp }[] = [
      { value: { ...record, extra: true }, reason: /unapproved member/ },
      { value: (() => { const { decision: _decision, ...rest } = record; return rest; })(), reason: /decision is invalid/ },
      { value: { ...record, unexpected: "member" }, reason: /unapproved member/ },
      { value: { ...record, decision: "human approved this source" }, reason: /decision is not factual/ },
      { value: { ...record, review: { ...record.review, operation: "source-relink" } }, reason: /decision is not factual/ },
      { value: { ...record, review: { ...record.review, templateId: "other" } }, reason: /PUBLICATION_INVALID: source publication history does not bind the claimed source facts/ },
      { value: { ...record, review: { ...record.review, extra: "field" } }, reason: /review fields are not exact/ },
      { value: (() => { const { sourcePath: _path, ...review } = record.review; return { ...record, review }; })(), reason: /review fields are not exact/ },
      { value: { ...record, policyDigest: digestBytes("other-policy") }, reason: /exact raw policy bytes/ },
      { value: { ...record, revision: 9 }, reason: /revision must match/ },
    ];
    for (const tampered of mutations) {
      const text = `${JSON.stringify(tampered.value)}\n`;
      const next = rehash({ ...forged, outputs: forged.outputs.map(output => output.path === history.path ? { ...output, after: { digest: digestBytes(text), base64: Buffer.from(text).toString("base64") } } : output) });
      await expect(commitVaultPublication(item.target, next, next.planDigest)).rejects.toMatchObject({ code: "PUBLICATION_INVALID", message: expect.stringMatching(tampered.reason) });
      await unchanged(item.vault, before);
    }
    const policy = forged.outputs.find(output => output.path === POLICY);
    if (policy === undefined) throw new Error("missing policy output");
    const parsed = parseContractPolicyV5(decode(policy.after));
    const flower = parsed.templates.flower;
    if (flower.status !== "active") throw new Error("factual policy is not active");
    const statusChanged = serializeContractPolicyV5({ ...parsed, templates: { ...parsed.templates, flower: { status: "review-required", reasons: ["forged status"], legacy: null } } });
    const identityChanged = serializeContractPolicyV5({ ...parsed, templates: { ...parsed.templates, flower: { ...flower, source: { ...flower.source, identity: "source-forged" } } } });
    for (const text of [statusChanged, identityChanged]) {
      const next = rehash({ ...forged, outputs: forged.outputs.map(output => output.path === POLICY ? { ...output, after: { digest: digestBytes(text), base64: Buffer.from(text).toString("base64") } } : output) });
      await expect(commitVaultPublication(item.target, next, next.planDigest)).rejects.toMatchObject({ code: "PUBLICATION_INVALID", message: expect.stringMatching(/status|source identity|one-field delta|exact raw policy/) });
      await unchanged(item.vault, before);
    }
    await unchanged(item.vault, before);
  });

  it("refuses omitted, extra, intersecting, duplicated, and rehashed source or absence assertions while preserving the snapshot", async () => {
    const item = await fixture("relink");
    const before = await snapshot(item.vault);
    const forged = await factualPlan(item);
    const variants: { plan: VaultPublicationPlan; reason: RegExp }[] = [
      { plan: rehash({ ...forged, sources: [] }), reason: /positive assertion is not exact/ },
      { plan: rehash({ ...forged, sources: [...forged.sources, { path: "Templates/other.md", digest: digestBytes("other") }] }), reason: /positive assertion is not exact/ },
      { plan: rehash({ ...forged, sources: [{ path: MOVED, digest: digestBytes("other") }] }), reason: /positive assertion is not exact/ },
      { plan: rehash({ ...forged, sources: [forged.sources[0]!, forged.sources[0]!] }), reason: /duplicated|unique/ },
      { plan: withoutAbsentSources(forged), reason: /PUBLICATION_INVALID: source relocation absence assertion is not exact/ },
      { plan: rehash({ ...forged, absentSources: [FLOWER, "Templates/other.md"] }), reason: /absence assertion is not exact/ },
      { plan: rehash({ ...forged, absentSources: [MOVED] }), reason: /absence assertion is not exact|disjoint/ },
      { plan: rehash({ ...forged, absentSources: [FLOWER, FLOWER] }), reason: /absence assertion is not exact|unique/ },
      { plan: { ...forged, planDigest: digestBytes("rehashed-without-material") }, reason: /PUBLICATION_INVALID: plan digest mismatch/ },
    ];
    for (const variant of variants) {
      await expect(commitVaultPublication(item.target, variant.plan, variant.plan.planDigest)).rejects.toMatchObject({ code: "PUBLICATION_INVALID", message: expect.stringMatching(variant.reason) });
      await unchanged(item.vault, before);
    }
  });

  it("refuses a changed portable settings UUID before commit, after staging, and after completion", async () => {
    const item = await fixture();
    const publication = await prepare(item);
    const before = await snapshot(item.vault);
    await replaceSettings(item.vault, OTHER_VAULT_ID);
    await expect(commitPreparedContractSourcePublication(item.target, publication)).rejects.toThrow(/portable vault identity/);
    await replaceSettings(item.vault, VAULT_ID);
    expect(await snapshot(item.vault)).toEqual(before);
    await expect(commitPreparedContractSourcePublication(item.target, publication, { async fault(point) { if (point === "after-staging") await replaceSettings(item.vault, OTHER_VAULT_ID); } })).rejects.toThrow(/portable vault identity/);
    await replaceSettings(item.vault, VAULT_ID);
    expect(await readFile(join(item.vault, POLICY), "utf8")).toBe(item.bytes);
    const receipt = await commitPreparedContractSourcePublication(item.target, publication);
    const completed = await snapshot(item.vault);
    await replaceSettings(item.vault, OTHER_VAULT_ID);
    await expect(resumeContractSourcePublication(item.target, locator("source-review"))).rejects.toThrow(/portable vault identity/);
    await replaceSettings(item.vault, VAULT_ID);
    expect(await snapshot(item.vault)).toEqual(completed);
    expect(receipt.planDigest).toBe((await resumeContractSourcePublication(item.target, locator("source-review"))).planDigest);
  });

  it("treats a stable missing source ancestor as genuine absence and refuses replacement, symlink, or inaccessible ancestry", async () => {
    const missing = await fixture("relink", "Templates/missing-root/flower.md");
    const publication = await prepare(missing);
    expect((await commitPreparedContractSourcePublication(missing.target, publication)).status).toBe("complete");
    const replaced = await fixture("relink");
    const replacedPublication = await prepare(replaced);
    const ancestor = join(replaced.vault, "Templates/agent");
    const retained = join(replaced.vault, "retained-agent");
    const saved = lstatSync(ancestor);
    let substitutions = 0;
    const actual = fs.promises.lstat.bind(fs.promises);
    const installed = installFs("lstat", async (path: string) => {
      if (String(path) === ancestor && substitutions === 0) {
        substitutions += 1;
        await rename(ancestor, retained);
        await mkdir(ancestor);
        expect(lstatSync(ancestor).ino).not.toBe(saved.ino);
      }
      return actual(path);
    });
    try {
      await expect(commitPreparedContractSourcePublication(replaced.target, replacedPublication)).rejects.toThrow(/ancestor changed/);
    } finally {
      installed.restore();
      if (substitutions === 1) {
        await rm(ancestor, { recursive: true, force: true });
        await rename(retained, ancestor);
      }
    }
    expect(substitutions).toBe(1);
    expect(installed.calls()).toBeGreaterThan(0);
    expect(lstatSync(ancestor).ino).toBe(saved.ino);
    expect(await readFile(join(replaced.vault, POLICY), "utf8")).toBe(replaced.bytes);
    const linked = await fixture("relink");
    await rm(join(linked.vault, "Templates/agent"), { recursive: true });
    await symlink(join(linked.vault, "Templates"), join(linked.vault, "Templates/agent"));
    await expect(prepare(linked)).rejects.toThrow(/unsafe|unreadable|capability|actual current policy/);
    if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() === 0) return;
    const blocked = await fixture("relink");
    const preparation = await prepareContractSourceRelink(blocked.vault, blocked.bytes, locator("relink"), MOVED);
    const blockedAncestor = join(blocked.vault, "Templates/agent");
    chmodSync(blockedAncestor, 0);
    try {
      await expect(prepareContractSourcePublication(blocked.target, locator("relink"), preparation.preparation)).rejects.toThrow(/EACCES|unreadable|unsafe/);
    } finally { chmodSync(blockedAncestor, 0o755); }
    expect(await readFile(join(blocked.vault, POLICY), "utf8")).toBe(blocked.bytes);
  });

  it("blocks live output when the old source reappears before plan, after staging, or in a nonthrowing after-marker, then resumes the same locator", async () => {
    const item = await fixture("relink");
    const publication = await prepare(item);
    await writeFile(join(item.vault, FLOWER), markdown);
    await expect(commitPreparedContractSourcePublication(item.target, publication)).rejects.toThrow(/path must be absent|reappeared/);
    await rm(join(item.vault, FLOWER));
    expect(await readFile(join(item.vault, POLICY), "utf8")).toBe(item.bytes);
    await expect(commitPreparedContractSourcePublication(item.target, publication, { fault(point) { if (point === "after-staging") writeFileSync(join(item.vault, FLOWER), markdown); } })).rejects.toThrow(/path must be absent|reappeared/);
    await rm(join(item.vault, FLOWER));
    const reached = new Set<string>();
    await expect(commitPreparedContractSourcePublication(item.target, publication, { fault(point) { reached.add(point); if (point === "after-marker") writeFileSync(join(item.vault, FLOWER), markdown); } })).rejects.toThrow(/path must be absent|reappeared/);
    expect(reached.has("after-marker")).toBe(true);
    await rm(join(item.vault, FLOWER));
    expect((await resumeContractSourcePublication(item.target, locator("relink"))).status).toBe("complete");
  });

  it("does not invalidate a completed relink receipt when the old source reappears afterward", async () => {
    const item = await fixture("relink");
    const receipt = await commitPreparedContractSourcePublication(item.target, await prepare(item));
    await writeFile(join(item.vault, FLOWER), markdown);
    const retried = await resumeContractSourcePublication(item.target, locator("relink"));
    expect(retried).toEqual(receipt);
    expect(await readFile(join(item.vault, FLOWER), "utf8")).toBe(markdown);
    expect(parseContractPolicyV5(await readFile(join(item.vault, POLICY), "utf8")).templates.flower.source.path).toBe(MOVED);
  });
  it("refuses acknowledgment source drift at the nonthrowing after-output seam before sealing a complete receipt", async () => {
    const item = await fixture();
    const publication = await prepare(item);
    const reached: string[] = [];
    await expect(commitPreparedContractSourcePublication(item.target, publication, { fault(point, path) {
      reached.push(`${point}:${path ?? ""}`);
      if (point === "after-output" && path === POLICY) writeFileSync(join(item.vault, FLOWER), `${changed}\nlater drift\n`);
    } })).rejects.toThrow(/Source changed before publication/);
    expect(reached).toContain(`after-output:${POLICY}`);
    expect(JSON.parse(await readFile(join(item.vault, MARKER), "utf8")).status).toBe("in-progress");
    await expect(readFile(join(txRoot(item.vault, reviewId), "complete-receipt.json"))).rejects.toThrow();
    expect(parseContractPolicyV5(await readFile(join(item.vault, POLICY), "utf8")).revision).toBe(2);
    await writeFile(join(item.vault, FLOWER), changed);
    const first = await resumeContractSourcePublication(item.target, locator("source-review"));
    expect(first.status).toBe("complete");
    expect((await resumeContractSourcePublication(item.target, locator("source-review"))).planDigest).toBe(first.planDigest);
    expect((await resumeContractSourcePublication(item.target, locator("source-review"))).planDigest).toBe(first.planDigest);
  });

  it("refuses old-path recreation at the nonthrowing after-output seam before sealing a relink receipt", async () => {
    const item = await fixture("relink");
    const publication = await prepare(item);
    const reached: string[] = [];
    await expect(commitPreparedContractSourcePublication(item.target, publication, { fault(point, path) {
      reached.push(`${point}:${path ?? ""}`);
      if (point === "after-output" && path === POLICY) writeFileSync(join(item.vault, FLOWER), markdown);
    } })).rejects.toThrow(/path must be absent|reappeared/);
    expect(reached).toContain(`after-output:${POLICY}`);
    expect(JSON.parse(await readFile(join(item.vault, MARKER), "utf8")).status).toBe("in-progress");
    await expect(readFile(join(txRoot(item.vault, relinkId), "complete-receipt.json"))).rejects.toThrow();
    expect(parseContractPolicyV5(await readFile(join(item.vault, POLICY), "utf8")).templates.flower.source.path).toBe(MOVED);
    await rm(join(item.vault, FLOWER));
    const first = await resumeContractSourcePublication(item.target, locator("relink"));
    expect(first.status).toBe("complete");
    expect((await resumeContractSourcePublication(item.target, locator("relink"))).planDigest).toBe(first.planDigest);
    expect((await resumeContractSourcePublication(item.target, locator("relink"))).planDigest).toBe(first.planDigest);
  });

  it("recovers after-plan with no marker and with an exact completed ordinary predecessor", async () => {
    const fresh = await fixture();
    await expect(commitPreparedContractSourcePublication(fresh.target, await prepare(fresh), { fault(point) { if (point === "after-plan") throw new Error("after-plan"); } })).rejects.toThrow("after-plan");
    expect(await readFile(join(fresh.vault, MARKER)).catch(() => null)).toBeNull();
    expect((await resumeContractSourcePublication(fresh.target, locator("source-review"))).status).toBe("complete");
    const predecessor = await planVaultPublication(fresh.target, { kind: "settings-update", vaultId: VAULT_ID, transactionId: ordinaryId, outputs: [{ path: SETTINGS, expectedDigest: digestBytes(await readFile(join(fresh.vault, SETTINGS))), content: await settingsBytes(VAULT_ID) }] });
    await commitVaultPublication(fresh.target, predecessor, predecessor.planDigest);
    const nextBytes = await readFile(join(fresh.vault, POLICY), "utf8");
    await writeFile(join(fresh.vault, FLOWER), `${changed}\nsecond\n`);
    const second = await prepareContractSourceAcknowledgment(fresh.vault, nextBytes, locator("source-review", "flower", "66666666-6666-4666-8666-666666666666"));
    await expect(commitPreparedContractSourcePublication(fresh.target, await prepareContractSourcePublication(fresh.target, locator("source-review", "flower", "66666666-6666-4666-8666-666666666666"), second.preparation), { fault(point) { if (point === "after-plan") throw new Error("after-plan"); } })).rejects.toThrow("after-plan");
    expect(JSON.parse(await readFile(join(fresh.vault, MARKER), "utf8")).transactionId).toBe(ordinaryId);
    expect((await resumeContractSourcePublication(fresh.target, locator("source-review", "flower", "66666666-6666-4666-8666-666666666666"))).status).toBe("complete");
  });

  it("recovers an after-marker crash and an after-receipt crash that finalizes the in-progress marker", async () => {
    const marked = await fixture();
    await expect(commitPreparedContractSourcePublication(marked.target, await prepare(marked), { fault(point) { if (point === "after-marker") throw new Error("after-marker"); } })).rejects.toThrow("after-marker");
    expect(JSON.parse(await readFile(join(marked.vault, MARKER), "utf8")).status).toBe("in-progress");
    expect((await resumeContractSourcePublication(marked.target, locator("source-review"))).status).toBe("complete");
    const receipted = await fixture("relink");
    await expect(commitPreparedContractSourcePublication(receipted.target, await prepare(receipted), { fault(point) { if (point === "after-receipt") throw new Error("after-receipt"); } })).rejects.toThrow("after-receipt");
    expect(JSON.parse(await readFile(join(receipted.vault, MARKER), "utf8")).status).toBe("in-progress");
    expect(await readFile(join(txRoot(receipted.vault, relinkId), "complete-receipt.json"), "utf8")).toContain("complete");
    expect((await resumeContractSourcePublication(receipted.target, locator("relink"))).status).toBe("complete");
    expect(JSON.parse(await readFile(join(receipted.vault, MARKER), "utf8")).status).toBe("complete");
  });

  it("resumes from a fresh built child before any parent resume and repeats the original receipt three times", async () => {
    const item = await fixture();
    await expect(commitPreparedContractSourcePublication(item.target, await prepare(item), { fault(point) { if (point === "after-marker") throw new Error("after-marker"); } })).rejects.toThrow("after-marker");
    expect(readFileSync(publisher, "utf8")).toContain("export async function resumeContractSourcePublication");
    const first = await resumeChild(item.vault, reviewId, "source-review");
    expect(first.home).not.toBe(process.env.HOME);
    expect(first.xdg).toBe(join(first.home, ".config"));
    expect(first.runtime).toBe(join(first.home, "runtime"));
    const second = await resumeChild(item.vault, reviewId, "source-review");
    const third = await resumeChild(item.vault, reviewId, "source-review");
    expect([second.digest, third.digest]).toEqual([first.digest, first.digest]);
    expect([second.status, third.status]).toEqual(["complete", "complete"]);
    const parent = await resumeContractSourcePublication(item.target, locator("source-review"));
    expect(parent.planDigest).toBe(first.digest);
    expect(parent.status).toBe("complete");
  });

  it("refuses a completed receipt with restored policy preimage three times without republishing", async () => {
    const item = await fixture();
    const receipt = await commitPreparedContractSourcePublication(item.target, await prepare(item));
    const published = await readFile(join(item.vault, POLICY));
    await writeFile(join(item.vault, POLICY), item.bytes);
    const before = await snapshot(item.vault);
    for (let count = 0; count < 3; count += 1) await expect(resumeContractSourcePublication(item.target, locator("source-review"))).rejects.toThrow(/postcondition|preimage|postimage/);
    expect(await snapshot(item.vault)).toEqual(before);
    expect(await readFile(join(item.vault, POLICY))).toEqual(Buffer.from(item.bytes));
    expect(published.equals(Buffer.from(item.bytes))).toBe(false);
    expect(receipt.status).toBe("complete");
  });

  it("refuses a named root that is missing, empty, partial, or has a corrupt plan", async () => {
    const missing = await fixture();
    await expect(inspectContractSourcePublication(missing.target, locator("source-review"))).resolves.toMatchObject({ status: "absent" });
    await expect(resumeContractSourcePublication(missing.target, locator("source-review"))).rejects.toThrow(/not sealed/);
    const empty = await fixture();
    await mkdir(txRoot(empty.vault, reviewId), { recursive: true });
    await expect(inspectContractSourcePublication(empty.target, locator("source-review"))).rejects.toThrow(/incomplete|unreadable/);
    const partial = await fixture();
    await mkdir(join(txRoot(partial.vault, reviewId), "staged"), { recursive: true });
    await writeFile(join(txRoot(partial.vault, reviewId), "staged/0.bin"), "partial");
    await expect(resumeContractSourcePublication(partial.target, locator("source-review"))).rejects.toThrow(/incomplete|unreadable/);
    const corrupt = await fixture();
    await mkdir(txRoot(corrupt.vault, reviewId), { recursive: true });
    await writeFile(join(txRoot(corrupt.vault, reviewId), "plan.json"), "{not-json");
    await expect(inspectContractSourcePublication(corrupt.target, locator("source-review"))).rejects.toThrow(/malformed|mismatched|corrupt/);
    expect(await readFile(join(corrupt.vault, POLICY), "utf8")).toBe(corrupt.bytes);
  });

  it("refuses its own terminal marker when the receipt is missing or corrupt", async () => {
    const missing = await fixture();
    const receipt = await commitPreparedContractSourcePublication(missing.target, await prepare(missing));
    const receiptPath = join(txRoot(missing.vault, reviewId), "complete-receipt.json");
    const saved = await readFile(receiptPath);
    await rm(receiptPath);
    await expect(resumeContractSourcePublication(missing.target, locator("source-review"))).rejects.toThrow(/receipt/);
    await writeFile(receiptPath, saved);
    expect((await resumeContractSourcePublication(missing.target, locator("source-review"))).planDigest).toBe(receipt.planDigest);
    const corrupt = await fixture("relink");
    await commitPreparedContractSourcePublication(corrupt.target, await prepare(corrupt));
    const corruptPath = join(txRoot(corrupt.vault, relinkId), "complete-receipt.json");
    await writeFile(corruptPath, `${await readFile(corruptPath, "utf8")}tamper`);
    await expect(resumeContractSourcePublication(corrupt.target, locator("relink"))).rejects.toThrow(/corrupt|receipt/);
    expect(parseContractPolicyV5(await readFile(join(corrupt.vault, POLICY), "utf8")).templates.flower.source.path).toBe(MOVED);
  });

  it("rolls a completed source publication back, then refuses source forward resume", async () => {
    const item = await fixture();
    const publication = await prepare(item);
    const receipt = await commitPreparedContractSourcePublication(item.target, publication);
    const planPath = join(txRoot(item.vault, reviewId), "plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")) as VaultPublicationPlan;
    const approval = prepareRollbackApprovalDigest(plan);
    expect((await recoverVaultPublication(item.target, "contract-publication", reviewId, plan.planDigest, "rollback", { rollbackApprovalDigest: approval })).status).toBe("rolled-back");
    expect(await readFile(join(item.vault, POLICY), "utf8")).toBe(item.bytes);
    await expect(resumeContractSourcePublication(item.target, locator("source-review"))).rejects.toThrow(/rolled-back|cannot be resumed/);
    expect(receipt.status).toBe("complete");
    expect(await readFile(join(item.vault, FLOWER), "utf8")).toBe(changed);
  });

  it("refuses late leaf recreation during the real readdir after the helper's initial ENOENT", async () => {
    const item = await fixture("relink");
    const publication = await prepare(item);
    const ancestor = await realpath(join(item.vault, "Templates/agent"));
    const leaf = join(ancestor, "flower.md");
    let mutations = 0;
    let observedEnoent = false;
    const actual = fs.promises.readdir.bind(fs.promises);
    const installed = installFs("readdir", async (path: string, options?: { withFileTypes?: boolean }) => {
      if (String(path) === ancestor && await absent(leaf)) {
        observedEnoent = true;
        await writeFile(leaf, markdown);
        mutations += 1;
      }
      return actual(path, options);
    });
    try {
      await expect(commitPreparedContractSourcePublication(item.target, publication)).rejects.toThrow(/path must be absent|reappeared/);
    } finally { installed.restore(); await rm(leaf, { force: true }); }
    expect(observedEnoent).toBe(true);
    expect(mutations).toBe(1);
    expect(installed.calls()).toBeGreaterThan(0);
    expect(await readFile(join(item.vault, POLICY), "utf8")).toBe(item.bytes);
  });
});

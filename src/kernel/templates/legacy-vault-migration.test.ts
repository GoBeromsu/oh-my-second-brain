import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type HistoricalBundle, v3Bundle, v4Bundle, v4Policy } from "../../../test/fixtures/legacy-publication-builders.js";
import { digestBytes, hashCanonical } from "./canonical.js";
import { VAULT_PUBLICATION_LEASE } from "./file-lock.js";
import { parseContractPolicyV5, serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";
import { createLegacyEquivalenceArchive, executeLegacyDecoderEquivalence, type LegacyEquivalenceProof } from "./legacy-equivalence.js";
import {
  contractHistoryRecord,
  commitVaultPublication,
  executeLegacyVaultEquivalence,
  inspectLegacyVaultMigrationRetry,
  inspectLegacyVaultPublication,
  planLegacyVaultMigration,
  planVaultPublication,
  prepareRollbackApprovalDigest,
  recoverVaultPublication,
  type VaultPublicationFault,
  type VaultPublicationPlan,
} from "./vault-publication.js";

const roots: string[] = [];
const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_VAULT_ID = "33333333-3333-4333-8333-333333333333";
const TX_IDS = [
  "22222222-2222-4222-8222-222222222222",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
] as const;
const RETRY_TX = "66666666-6666-4666-8666-666666666666";
const encoder = new TextEncoder();
const RAW_CAP = 8 * 1024 * 1024;
const POLICY_PATH = ".oms/template-policy.json";
const TAXONOMY_PATH = ".oms/taxonomy.json";
const PROJECTION_PATH = ".oms/types.json";
const MARKER_PATH = ".oms/template-transaction.json";
const V3_MARKER_PATH = ".oms/template-migration.json";
const FAULTS = ["after-plan", "after-backup", "after-staging", "after-marker", "after-output", "after-complete-marker", "after-receipt"] as const satisfies readonly VaultPublicationFault[];

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-legacy-migration-"));
  roots.push(root);
  return root;
}
async function writeTree(root: string, files: Record<string, Uint8Array>): Promise<void> {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
}
async function tree(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) found[absolute.slice(root.length + 1)] = `symlink:${await readFile(absolute, "utf8").catch(() => "unreadable")}`;
      else if (entry.isDirectory()) await walk(absolute);
      else found[absolute.slice(root.length + 1)] = digestBytes(await readFile(absolute));
    }
  }
  await walk(root);
  return found;
}
function bytes(value: Uint8Array): Buffer { return Buffer.from(value); }
function blobOf(value: Uint8Array): { digest: string; base64: string } {
  return { digest: digestBytes(value), base64: Buffer.from(value).toString("base64") };
}
function migrationArchive(plan: VaultPublicationPlan): Record<string, unknown> {
  return JSON.parse(Buffer.from(plan.evidence.find(item => item.name === "legacy-migration")!.content.base64, "base64").toString("utf8")) as Record<string, unknown>;
}
function changedPolicy(plan: VaultPublicationPlan): string {
  const current = parseContractPolicyV5(Buffer.from(plan.outputs.find(output => output.path === POLICY_PATH)!.after.base64, "base64").toString("utf8"));
  if (current.common.status !== "active") throw new Error("forged policy has no active common");
  return serializeContractPolicyV5({
    ...current,
    properties: { ...current.properties, summary: { type: "text", intent: "Forged summary." } },
    common: { ...current.common, fields: { ...current.common.fields, summary: { property: "summary", required: true } } },
  });
}
function successorText(current: string, revision: number, summaryRequired: boolean): string {
  const parsed = parseContractPolicyV5(current);
  if (parsed.common.status !== "active") throw new Error("successor common is not active");
  return serializeContractPolicyV5({
    ...parsed,
    revision,
    properties: { ...parsed.properties, summary: { type: "text", intent: "Required summary." } },
    common: { ...parsed.common, fields: { ...parsed.common.fields, summary: { property: "summary", required: summaryRequired } } },
  });
}
async function ordinaryPlan(item: Installed, transactionId: string, expected: string, content: string, decision: string): Promise<VaultPublicationPlan> {
  return planVaultPublication(item.target, {
    kind: "contract-publication",
    vaultId: VAULT_ID,
    transactionId,
    history: { kind: "publication", decision },
    outputs: [{ path: POLICY_PATH, expectedDigest: digestBytes(expected), content }],
  });
}
function nativeMarker(plan: VaultPublicationPlan, status: "in-progress" | "rolling-back" | "complete" | "rolled-back", owner = plan): Buffer {
  const value = { version: "oms.vault-publication.v1", transactionId: owner.transactionId, kind: owner.kind, planDigest: owner.planDigest, status };
  return Buffer.from(`${JSON.stringify({ ...value, checksum: hashCanonical("oms.vault-publication.marker.v1", value) })}\n`);
}
function externalOnly(before: Record<string, string>, after: Record<string, string>, injected: readonly string[]): string[] {
  return Object.keys(after).filter(path => before[path] !== after[path] && !injected.includes(path));
}

interface Observed { readonly root: string; readonly target: { vault: string; source: "explicit" }; readonly admission: Awaited<ReturnType<typeof inspectLegacyVaultPublication>>; readonly bundle: HistoricalBundle }
async function observe(bundle: HistoricalBundle, original: string | null): Promise<Observed> {
  const root = await vault();
  await writeTree(root, { [bundle.markerPath]: bundle.markerBytes, [bundle.planPath]: bundle.planBytes, ...bundle.observed });
  if (original !== null) {
    await mkdir(join(root, "Templates"), { recursive: true });
    await writeFile(join(root, "Templates/note.md"), original);
  }
  const target = { vault: root, source: "explicit" as const };
  return { root, target, admission: await inspectLegacyVaultPublication(target), bundle };
}
interface Installed { readonly root: string; readonly target: { vault: string; source: "explicit" }; readonly admission: Awaited<ReturnType<typeof inspectLegacyVaultPublication>>; readonly proof: LegacyEquivalenceProof; readonly bundle: HistoricalBundle; readonly original: string | null }
async function install(bundle: HistoricalBundle, original: string | null): Promise<Installed> {
  const observed = await observe(bundle, original);
  expect(observed.admission.status, observed.admission.reasons.join("; ")).toBe("verified");
  const execution = executeLegacyVaultEquivalence(observed.admission);
  expect(execution?.disposition, execution && execution.disposition !== "proved" ? execution.reasons.join("; ") : undefined).toBe("proved");
  if (execution?.disposition !== "proved") throw new Error("synthetic proof missing");
  expect(execution.proposal.unavailableHistoricalSources).toEqual([]);
  expect(execution.proposal.decoding.automaticMigrationBlocked).toBe(false);
  return { ...observed, proof: execution.proof, original };
}
function admitted(markdown = ""): Promise<Installed> { return install(v4Bundle(v4Policy(markdown)), markdown); }
function admittedV3(): Promise<Installed> { return install(v3Bundle(), null); }

async function planOf(item: Installed, transactionId: string, settings?: string): Promise<VaultPublicationPlan> {
  return planLegacyVaultMigration(item.target, item.admission, item.proof, { vaultId: VAULT_ID, transactionId, ...(settings === undefined ? {} : { missingSettings: { content: settings } }) });
}
function settingsText(vaultId = VAULT_ID): string {
  return JSON.stringify({ version: 1, vaultId, templateRoots: ["Templates"] });
}
async function commit(item: Installed, plan: VaultPublicationPlan) {
  return commitVaultPublication(item.target, plan, plan.planDigest);
}
function publisherMarker(root: string): Promise<string> { return readFile(join(root, MARKER_PATH), "utf8"); }
function policyOf(root: string): Promise<ContractPolicyV5> {
  return readFile(join(root, POLICY_PATH), "utf8").then(text => JSON.parse(text) as ContractPolicyV5);
}

describe("dedicated legacy vault migration", () => {
  it("rejects forged proof, unregistered admission, and caller authority", async () => {
    const item = await admitted();
    expect(executeLegacyVaultEquivalence({})).toBeNull();
    expect(executeLegacyVaultEquivalence(JSON.parse(JSON.stringify(item.admission)))).toBeNull();
    await expect(planLegacyVaultMigration(item.target, {}, item.proof, { vaultId: VAULT_ID })).rejects.toThrow("not a private record");
    await expect(planLegacyVaultMigration(item.target, item.admission, {}, { vaultId: VAULT_ID })).rejects.toThrow("proof");
    await expect(planLegacyVaultMigration(item.target, item.admission, item.proof, { vaultId: VAULT_ID, outputs: [] } as never)).rejects.toThrow("cannot supply");
    expect(await readdir(join(item.root, ".oms"))).not.toContain("migrations");
  });

  it("derives an active empty-body original and refuses live drift", async () => {
    const item = await admitted("");
    const plan = await planOf(item, TX_IDS[0]);
    expect(plan.sources).toEqual([{ path: "Templates/note.md", digest: digestBytes("") }]);
    expect(plan.outputs.map(output => output.path).sort()).toEqual([".oms/history/contracts/0.json", POLICY_PATH]);
    const before = await tree(item.root);
    await writeFile(join(item.root, "Templates/note.md"), "drifted");
    await expect(commit(item, plan)).rejects.toThrow("Source changed");
    expect(await readFile(join(item.root, "Templates/note.md"), "utf8")).toBe("drifted");
    expect(externalOnly(before, await tree(item.root), ["Templates/note.md"])).toEqual([]);
  });

  it("keeps nonempty approved Markdown review-held instead of activating it", async () => {
    const item = await observe(v4Bundle(v4Policy("# guidance")), "# guidance");
    expect(item.admission.status).toBe("verified");
    const execution = executeLegacyVaultEquivalence(item.admission);
    expect(execution?.disposition).toBe("proposed");
    if (execution?.disposition !== "proposed") throw new Error("nonempty body was not held");
    const note = execution.proposal.candidate.policy.templates.note;
    expect(note?.status).toBe("review-required");
    if (note?.status !== "review-required") throw new Error("named template was activated");
    expect(note.reasons.join(" ")).toMatch(/approved Markdown/);
    expect(execution.proposal.decoding.automaticMigrationBlocked).toBe(true);
    expect(await readdir(join(item.root, ".oms"))).not.toContain("migrations");
  });

  it.each(["missing", "symlink", "hardlink"] as const)("blocks %s live original before the forward marker", async kind => {
    const item = await admitted("");
    const plan = await planOf(item, TX_IDS[0]);
    const source = join(item.root, "Templates/note.md");
    const before = await tree(item.root);
    if (kind === "missing") await rm(source);
    if (kind === "symlink") { await rm(source); await symlink(join(item.root, POLICY_PATH), source); }
    if (kind === "hardlink") { const copy = join(item.root, "Templates/linked.md"); await writeFile(copy, ""); await rm(source); await link(copy, source); }
    await expect(commit(item, plan)).rejects.toThrow(kind === "missing" ? "registered source path must exist" : /Source changed|regular file|symlink|hard/);
    expect(await readdir(join(item.root, ".oms"))).not.toContain("migrations");
    const injected = kind === "hardlink" ? ["Templates/note.md", "Templates/linked.md"] : ["Templates/note.md"];
    expect(externalOnly(before, await tree(item.root), injected)).toEqual([]);
    if (kind === "symlink") expect((await lstat(source)).isSymbolicLink()).toBe(true);
    if (kind === "hardlink") expect((await lstat(source)).nlink).toBeGreaterThan(1);
  });

  it("does not rewrite existing settings and accepts settings only when absent and identity-matched", async () => {
    const item = await admitted();
    const settings = settingsText();
    await writeFile(join(item.root, ".oms/settings.json"), settings);
    await expect(planLegacyVaultMigration(item.target, item.admission, item.proof, { vaultId: VAULT_ID, missingSettings: { content: settings } })).rejects.toThrow("never rewritten");
    expect(await readFile(join(item.root, ".oms/settings.json"), "utf8")).toBe(settings);
    await writeFile(join(item.root, ".oms/settings.json"), settingsText(OTHER_VAULT_ID));
    await expect(planLegacyVaultMigration(item.target, item.admission, item.proof, { vaultId: VAULT_ID, missingSettings: { content: settings } })).rejects.toThrow("never rewritten");
    await rm(join(item.root, ".oms/settings.json"));
    await expect(planLegacyVaultMigration(item.target, item.admission, item.proof, { vaultId: VAULT_ID, missingSettings: { content: settingsText(OTHER_VAULT_ID) } })).rejects.toThrow("identity");
    const plan = await planOf(item, TX_IDS[0], settings);
    expect(plan.outputs.map(output => output.path)).toContain(".oms/settings.json");
    expect((await commit(item, plan)).status).toBe("complete");
    expect(await readFile(join(item.root, ".oms/settings.json"), "utf8")).toBe(settings);
  });

  it("refuses an oversized sealed plan only after proving the raw archive is under 8 MiB", async () => {
    const opaque = JSON.stringify({ retained: "x".repeat(5 * 1024 * 1024) });
    const projection = encoder.encode(opaque);
    const bundle = v4Bundle(v4Policy(), { [PROJECTION_PATH]: projection });
    const raw = bundle.markerBytes.byteLength + bundle.planBytes.byteLength + bundle.policy.byteLength + Object.values(bundle.observed).reduce((total, item) => total + item.byteLength, 0);
    expect(raw).toBeLessThan(RAW_CAP);
    expect(bundle.policy.byteLength).toBeLessThan(256 * 1024);
    const item = await install(bundle, "");
    expect(item.proof).toEqual(expect.any(Object));
    let thrown: unknown;
    try { await planLegacyVaultMigration(item.target, item.admission, item.proof, { vaultId: VAULT_ID }); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("PUBLICATION_RESOURCE_EXHAUSTED");
    expect(message.length).toBeLessThan(500);
    expect(message).not.toContain(opaque.slice(0, 80));
    expect(await readdir(join(item.root, ".oms"))).not.toContain("migrations");
    expect(bytes(await readFile(join(item.root, POLICY_PATH)))).toEqual(bytes(bundle.policy));
    expect(bytes(await readFile(join(item.root, PROJECTION_PATH)))).toEqual(bytes(projection));
  });

  it("publishes the initial v4 commit from a same-process fresh execution and keeps the old marker only in the archive", async () => {
    const item = await admitted();
    const planPath = item.bundle.planPath;
    const sameProcess = executeLegacyDecoderEquivalence(createLegacyEquivalenceArchive({
      format: "v4",
      markerPath: item.bundle.markerPath,
      markerBytes: await readFile(join(item.root, item.bundle.markerPath)),
      planPath,
      planBytes: await readFile(join(item.root, planPath)),
      policyPath: POLICY_PATH,
      policyBytes: await readFile(join(item.root, POLICY_PATH)),
      observedOutputs: new Map(Object.entries(item.bundle.observed).map(([path, content]) => [path, content])),
    }));
    expect(sameProcess.disposition).toBe("proved");
    if (sameProcess.disposition !== "proved") throw new Error("same-process proof missing");
    const plan = await planLegacyVaultMigration(item.target, item.admission, sameProcess.proof, { vaultId: VAULT_ID, transactionId: TX_IDS[0] });
    expect(plan.evidence.map(evidence => evidence.name)).toEqual(["legacy-migration"]);
    expect(plan.evidence.map(evidence => evidence.name)).not.toContain("retained-v3");
    const receipt = await commit(item, plan);
    expect(receipt.status).toBe("complete");
    expect(await policyOf(item.root)).toMatchObject({ version: 5, revision: 0, common: { status: "active" } });
    expect(serializeContractPolicyV5(await policyOf(item.root))).toContain("\"status\": \"active\"");
    expect(await publisherMarker(item.root)).toContain(TX_IDS[0]);
    expect(await readFile(join(item.root, item.bundle.markerPath), "utf8")).not.toBe(item.bundle.markerBytes.toString());
    await expect(readFile(join(item.root, V3_MARKER_PATH))).rejects.toThrow();
  });

  it("commits an initial common-only v3, then advances two ordinary publications and one settings update without another migration", async () => {
    const item = await admittedV3();
    const retained = item.bundle.markerBytes;
    const migration = await planOf(item, TX_IDS[0]);
    expect(migration.kind).toBe("schema-migration");
    expect(migration.sources).toEqual([]);
    expect((await commit(item, migration)).status).toBe("complete");
    expect(bytes(await readFile(join(item.root, V3_MARKER_PATH)))).toEqual(bytes(retained));
    const initialTransactions = await readdir(join(item.root, ".oms/.template-transactions"));
    const migrated = await policyOf(item.root);
    const migratedText = serializeContractPolicyV5(migrated);
    const successorAdmission = await inspectLegacyVaultPublication(item.target);
    expect(successorAdmission.status).toBe("publisher-marker");
    expect(executeLegacyVaultEquivalence(successorAdmission)).toBeNull();
    await expect(planLegacyVaultMigration(item.target, successorAdmission, item.proof, { vaultId: VAULT_ID, transactionId: TX_IDS[1] })).rejects.toThrow("not a private record");
    const predecessor = await publisherMarker(item.root);
    const tightened = parseContractPolicyV5(migratedText);
    if (tightened.common.status !== "active") throw new Error("migrated common is not active");
    const tightenedText = serializeContractPolicyV5({
      ...tightened,
      revision: migrated.revision + 1,
      properties: { ...tightened.properties, summary: { type: "text", intent: "Required summary." } },
      common: { ...tightened.common, fields: { ...tightened.common.fields, summary: { property: "summary", required: true } } },
    });
    const first = await planVaultPublication(item.target, {
      kind: "contract-publication",
      vaultId: VAULT_ID,
      transactionId: TX_IDS[1],
      history: { kind: "publication", decision: "ordinary publication adds a required summary; not another migration" },
      outputs: [{ path: POLICY_PATH, expectedDigest: digestBytes(migratedText), content: tightenedText }],
    });
    expect(first.kind).toBe("contract-publication");
    expect(first.markerBefore?.digest).toBe(digestBytes(encoder.encode(predecessor)));
    expect(first.outputs.map(output => output.path).sort()).toEqual([".oms/history/contracts/1.json", POLICY_PATH]);
    expect((await commitVaultPublication(item.target, first, first.planDigest)).status).toBe("complete");
    expect(await readFile(join(item.root, ".oms/history/contracts/1.json"), "utf8")).toContain("\"kind\":\"publication\"");
    expect(await readdir(join(item.root, ".oms/.template-transactions"))).toContain(TX_IDS[1]);
    const relaxedSource = parseContractPolicyV5(tightenedText);
    if (relaxedSource.common.status !== "active") throw new Error("tightened common is not active");
    const relaxedText = serializeContractPolicyV5({
      ...relaxedSource,
      revision: relaxedSource.revision + 1,
      common: { ...relaxedSource.common, fields: { ...relaxedSource.common.fields, summary: { property: "summary", required: false } } },
    });
    const secondMarker = await publisherMarker(item.root);
    const second = await planVaultPublication(item.target, {
      kind: "contract-publication",
      vaultId: VAULT_ID,
      transactionId: TX_IDS[2],
      history: { kind: "publication", decision: "ordinary publication relaxes the summary requirement" },
      outputs: [{ path: POLICY_PATH, expectedDigest: digestBytes(tightenedText), content: relaxedText }],
    });
    expect(second.markerBefore?.digest).toBe(digestBytes(encoder.encode(secondMarker)));
    expect((await commitVaultPublication(item.target, second, second.planDigest)).status).toBe("complete");
    const published = await policyOf(item.root);
    expect(published.revision).toBe(2);
    expect(published.common).toMatchObject({ status: "active", fields: { summary: { required: false } } });
    expect(published.templates).toEqual({});
    expect(serializeContractPolicyV5(published)).not.toBe(migratedText);
    const history = await readdir(join(item.root, ".oms/history/contracts"));
    expect(history.sort()).toEqual(["0.json", "1.json", "2.json"]);
    expect(await readFile(join(item.root, ".oms/history/contracts/0.json"), "utf8")).toContain("\"kind\":\"migration\"");
    expect(await readFile(join(item.root, ".oms/history/contracts/2.json"), "utf8")).toContain("\"kind\":\"publication\"");
    const settings = settingsText();
    const settingsPlan = await planVaultPublication(item.target, {
      kind: "settings-update",
      vaultId: VAULT_ID,
      transactionId: RETRY_TX,
      outputs: [{ path: ".oms/settings.json", expectedDigest: null, content: settings }],
    });
    expect(settingsPlan.kind).toBe("settings-update");
    expect(settingsPlan.outputs.map(output => output.path)).toEqual([".oms/settings.json"]);
    expect((await commitVaultPublication(item.target, settingsPlan, settingsPlan.planDigest)).status).toBe("complete");
    expect(await readFile(join(item.root, ".oms/settings.json"), "utf8")).toBe(settings);
    expect(bytes(await readFile(join(item.root, V3_MARKER_PATH)))).toEqual(bytes(retained));
    expect(await readdir(join(item.root, ".oms/migrations"))).toEqual([TX_IDS[0]]);
    const expectedTransactions = [...new Set([...initialTransactions, TX_IDS[1], TX_IDS[2], RETRY_TX, dirname(VAULT_PUBLICATION_LEASE).split("/").at(-1)!])].sort();
    expect([...(await readdir(join(item.root, ".oms/.template-transactions"))).sort()]).toEqual(expectedTransactions);
  });

  it("rejects a caller-rehashed sealed plan after policy, history, source, raw, candidate, or slot mutation", async () => {
    const item = await admitted("");
    const plan = await planOf(item, TX_IDS[0]);
    const reseal = (change: (value: VaultPublicationPlan) => void): VaultPublicationPlan => {
      const copy = structuredClone(plan);
      change(copy);
      const { planDigest: _ignored, ...material } = copy;
      return { ...copy, planDigest: hashCanonical("oms.vault-publication.plan.v1", material) };
    };
    const before = await tree(item.root);
    const forgedPolicy = changedPolicy(plan);
    const matchedHistory = `${JSON.stringify(contractHistoryRecord({ transactionId: TX_IDS[0], kind: "migration", decision: "automatic historical equivalence; not human authorization", revision: 0, previousPolicyDigest: digestBytes(item.bundle.policy), policyDigest: digestBytes(forgedPolicy) }))}\n`;
    const historyOnly = `${JSON.stringify({ ...JSON.parse(Buffer.from(plan.outputs.find(output => output.path.endsWith("/0.json"))!.after.base64, "base64").toString("utf8")), review: { forged: true } })}\n`;
    const archive = migrationArchive(plan);
    const seal = archive.seal as Record<string, unknown>;
    const policyComponent = archive.policy as { path: string; digest: string; base64: string };
    const candidateArchive = { ...archive, seal: { ...seal, canonicalPolicy: forgedPolicy } };
    const rawArchive = { ...archive, policy: { ...policyComponent, ...blobOf(encoder.encode(forgedPolicy)) } };
    const materialArchive = { ...archive, materialDigest: digestBytes("forged-material"), seal: { ...seal, candidateDigest: digestBytes("forged-candidate") } };
    const forged = [
      reseal(value => {
        value.outputs.find(output => output.path === POLICY_PATH)!.after = blobOf(encoder.encode(forgedPolicy));
        value.outputs.find(output => output.path.endsWith("/0.json"))!.after = blobOf(encoder.encode(matchedHistory));
      }),
      reseal(value => { value.outputs.find(output => output.path.endsWith("/0.json"))!.after = blobOf(encoder.encode(historyOnly)); }),
      reseal(value => { value.sources.push({ path: "Templates/extra.md", digest: digestBytes("") }); }),
      reseal(value => { value.sources.splice(0, value.sources.length); }),
      reseal(value => { value.evidence.find(item => item.name === "legacy-migration")!.content = blobOf(Buffer.from(JSON.stringify(candidateArchive))); }),
      reseal(value => { value.evidence.find(item => item.name === "legacy-migration")!.content = blobOf(Buffer.from(JSON.stringify(rawArchive))); }),
      reseal(value => { value.evidence.find(item => item.name === "legacy-migration")!.content = blobOf(Buffer.from(JSON.stringify(materialArchive))); }),
    ];
    for (const candidate of forged) {
      await expect(commitVaultPublication(item.target, candidate, candidate.planDigest)).rejects.toThrow(/does not match the sealed|source observations|fresh migration execution|checksum/);
      expect(await tree(item.root)).toEqual(before);
    }
    await writeFile(join(item.root, ".oms/template-backfill.json"), "{\"late\":true}\n");
    await expect(commit(item, plan)).rejects.toThrow("slots");
    await rm(join(item.root, ".oms/template-backfill.json"));
    expect(externalOnly(before, await tree(item.root), [".oms/template-backfill.json"])).toEqual([]);
    expect((await commit(item, plan)).status).toBe("complete");
  });

  it.each(FAULTS)("recovers migration %s three times without duplicating history", async point => {
    const item = await admitted();
    const plan = await planOf(item, TX_IDS[0]);
    const before = await tree(item.root);
    await expect(commitVaultPublication(item.target, plan, plan.planDigest, { fault(actual) { if (actual === point) throw new Error(point); } })).rejects.toThrow(point);
    for (let count = 0; count < 3; count += 1) expect((await recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "resume")).status).toBe("complete");
    const history = await readdir(join(item.root, ".oms/history/contracts"));
    expect(history).toEqual(["0.json"]);
    expect(externalOnly(before, await tree(item.root), [])).not.toContain("Templates/note.md");
  });

  it("requires a separate rollback approval and a terminal receipt before retry", async () => {
    const item = await admitted();
    const plan = await planOf(item, TX_IDS[0]);
    await commit(item, plan);
    await expect(inspectLegacyVaultMigrationRetry(item.target)).resolves.toMatchObject({ status: "legacy-invalid" });
    await expect(recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "rollback")).rejects.toThrow("separate approval");
    const approval = prepareRollbackApprovalDigest(plan);
    expect((await recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "rollback", { rollbackApprovalDigest: approval })).status).toBe("rolled-back");
    expect((await recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "rollback", { rollbackApprovalDigest: approval })).status).toBe("rolled-back");
    const retry = await inspectLegacyVaultMigrationRetry(item.target);
    expect(retry.status).toBe("migration-retry");
    await expect(planLegacyVaultMigration(item.target, retry, {} as LegacyEquivalenceProof, { vaultId: VAULT_ID })).rejects.toThrow("proof");
    const forged = Buffer.from(`${JSON.stringify({ version: 1, status: "rolled-back", transactionId: TX_IDS[0] })}\n`);
    await writeFile(join(item.root, `.oms/migrations/${TX_IDS[0]}/rolled-back-receipt.json`), forged);
    await expect(inspectLegacyVaultMigrationRetry(item.target)).resolves.toMatchObject({ status: "legacy-invalid" });
    await rm(join(item.root, `.oms/migrations/${TX_IDS[0]}/rolled-back-receipt.json`));
    await expect(inspectLegacyVaultMigrationRetry(item.target)).resolves.toMatchObject({ status: "legacy-unavailable" });
  });

  it("refuses nonterminal retry, live preimage mutation, and changed retained slots", async () => {
    const item = await admitted();
    const plan = await planOf(item, TX_IDS[0]);
    await expect(commitVaultPublication(item.target, plan, plan.planDigest, { fault(point) { if (point === "after-marker") throw new Error("after-marker"); } })).rejects.toThrow("after-marker");
    await expect(inspectLegacyVaultMigrationRetry(item.target)).resolves.toMatchObject({ status: "legacy-invalid" });
    expect((await recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "resume")).status).toBe("complete");
    const approval = prepareRollbackApprovalDigest(plan);
    expect((await recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "rollback", { rollbackApprovalDigest: approval })).status).toBe("rolled-back");
    const policy = join(item.root, POLICY_PATH);
    const original = await readFile(policy);
    await writeFile(policy, `${original} `);
    await expect(inspectLegacyVaultMigrationRetry(item.target)).resolves.toMatchObject({ status: "legacy-inconsistent" });
    await writeFile(policy, original);
    await writeFile(join(item.root, ".oms/template-backfill.json"), "{\"slot\":true}\n");
    await expect(inspectLegacyVaultMigrationRetry(item.target)).resolves.toMatchObject({ status: "legacy-inconsistent" });
    await rm(join(item.root, ".oms/template-backfill.json"));
    expect((await inspectLegacyVaultMigrationRetry(item.target)).status).toBe("migration-retry");
  });

  it("retries a rolled-back migration with a fresh private proof and a new successful transaction", async () => {
    const item = await admitted("");
    const plan = await planOf(item, TX_IDS[0]);
    await expect(commitVaultPublication(item.target, plan, plan.planDigest, { fault(point) { if (point === "after-marker") throw new Error("after-marker"); } })).rejects.toThrow("after-marker");
    const approval = prepareRollbackApprovalDigest(plan);
    expect((await recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "rollback", { rollbackApprovalDigest: approval })).status).toBe("rolled-back");
    const retry = await inspectLegacyVaultMigrationRetry(item.target);
    expect(retry.status).toBe("migration-retry");
    const fresh = executeLegacyVaultEquivalence(item.admission);
    expect(fresh?.disposition).toBe("proved");
    if (fresh?.disposition !== "proved") throw new Error("fresh private proof missing");
    const next = await planLegacyVaultMigration(item.target, retry, fresh.proof, { vaultId: VAULT_ID, transactionId: RETRY_TX });
    expect(next.transactionId).not.toBe(plan.transactionId);
    expect(next.outputs.find(output => output.path === POLICY_PATH)?.after.digest).toBe(plan.outputs.find(output => output.path === POLICY_PATH)?.after.digest);
    expect((await commitVaultPublication(item.target, next, next.planDigest)).status).toBe("complete");
    expect(await publisherMarker(item.root)).toContain(RETRY_TX);
    expect((await policyOf(item.root)).version).toBe(5);
    expect(await readdir(join(item.root, ".oms/history/contracts"))).toEqual(["0.json"]);
  });

  it("does not auto-activate an unknown, markerless, blocked, or nonempty-source publication", async () => {
    const empty = await vault();
    expect((await inspectLegacyVaultPublication({ vault: empty, source: "explicit" })).status).toBe("absent");
    const unknown = await vault();
    await mkdir(join(unknown, ".oms"));
    await writeFile(join(unknown, ".oms/template-other.json"), "{}\n");
    expect((await inspectLegacyVaultPublication({ vault: unknown, source: "explicit" })).status).toBe("absent");
    const blocked = await observe(v4Bundle({ ...v4Policy(), completion: { retryBudget: 2, agentRepair: { enabled: false } } }), null);
    expect(blocked.admission.status).toBe("verified");
    expect(executeLegacyVaultEquivalence(blocked.admission)?.disposition).toBe("proposed");
    const nonempty = await observe(v4Bundle(v4Policy("body")), "body");
    expect(nonempty.admission.status).toBe("verified");
    expect(executeLegacyVaultEquivalence(nonempty.admission)?.disposition).toBe("proposed");
    for (const root of [empty, unknown, blocked.root, nonempty.root]) expect(await readdir(join(root, ".oms")).catch(() => [])).not.toContain("migrations");
  });

  it("fails a missing known source binding without modifying the source or note", async () => {
    const policy = v4Policy("");
    const note = (policy.templates as { note: Record<string, unknown> }).note;
    delete note.source;
    const item = await observe(v4Bundle(policy), "");
    expect(item.admission.status).toBe("verified");
    const execution = executeLegacyVaultEquivalence(item.admission);
    expect(execution?.disposition).toBe("proposed");
    if (execution?.disposition !== "proposed") throw new Error("missing binding was proved");
    expect(execution.proposal.unavailableHistoricalSources.map(source => source.templateId)).toContain("note");
    expect(await readFile(join(item.root, "Templates/note.md"), "utf8")).toBe("");
    expect(await readFile(join(item.root, ".oms/templates/note.md"), "utf8")).toBe("");
    expect(await readdir(join(item.root, ".oms"))).not.toContain("migrations");
  });

  it("refuses cross-vault admission and a stale raw policy, marker, plan, or read set", async () => {
    const item = await admitted();
    const other = await vault();
    await expect(planLegacyVaultMigration({ vault: other, source: "explicit" }, item.admission, item.proof, { vaultId: VAULT_ID })).rejects.toThrow(/PUBLICATION_INVALID: migration admission is not a private record bound to this vault/);
    const before = await tree(item.root);
    await writeFile(join(item.root, POLICY_PATH), Buffer.concat([item.bundle.policy, encoder.encode(" ")]));
    await expect(planOf(item, TX_IDS[0])).rejects.toThrow(/live policy|does not match/);
    await writeFile(join(item.root, POLICY_PATH), item.bundle.policy);
    await writeFile(join(item.root, item.bundle.markerPath), Buffer.concat([item.bundle.markerBytes, encoder.encode(" ")]));
    await expect(inspectLegacyVaultPublication(item.target)).resolves.toMatchObject({ status: "legacy-invalid" });
    await writeFile(join(item.root, item.bundle.markerPath), item.bundle.markerBytes);
    await writeFile(join(item.root, item.bundle.planPath), Buffer.concat([item.bundle.planBytes, encoder.encode(" ")]));
    await expect(inspectLegacyVaultPublication(item.target)).resolves.toMatchObject({ status: "legacy-invalid" });
    expect(externalOnly(before, await tree(item.root), [POLICY_PATH, item.bundle.markerPath, item.bundle.planPath])).toEqual([]);
  });

  it("refuses generic schema migration at every ordinary callsite", async () => {
    const item = await admitted();
    await expect(planVaultPublication(item.target, { kind: "schema-migration", vaultId: VAULT_ID, outputs: [] })).rejects.toThrow(/dedicated|marker|Historical/);
    await expect(planVaultPublication(item.target, { kind: "contract-publication", vaultId: VAULT_ID, outputs: [] })).rejects.toThrow(/Historical|marker/);
  });

  it("recovers a crashed migration from a fresh built publisher in an isolated child process", async () => {
    const item = await admitted();
    const plan = await planOf(item, TX_IDS[0]);
    await expect(commitVaultPublication(item.target, plan, plan.planDigest, { fault(point) { if (point === "after-marker") throw new Error("after-marker"); } })).rejects.toThrow("after-marker");
    const home = await mkdtemp(join(tmpdir(), "oms-migration-child-home-"));
    roots.push(home);
    const runtime = join(home, "runtime");
    const publisher = fileURLToPath(new URL("../../../dist/kernel/templates/vault-publication.js", import.meta.url));
    expect(readFileSync(publisher, "utf8")).toContain("export async function recoverVaultPublication");
    const child = execFileSync(process.execPath, ["--input-type=module", "-e", "const { recoverVaultPublication } = await import(process.env.OMS_CHILD_PUBLISHER); const receipt = await recoverVaultPublication({ vault: process.env.OMS_CHILD_VAULT, source: 'explicit' }, 'schema-migration', process.env.OMS_CHILD_TX, process.env.OMS_CHILD_DIGEST, 'resume'); process.stdout.write(JSON.stringify({ status: receipt.status, home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, runtime: process.env.OMS_RUNTIME_ROOT }));"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        OMS_RUNTIME_ROOT: runtime,
        OMS_CHILD_PUBLISHER: publisher,
        OMS_CHILD_VAULT: item.root,
        OMS_CHILD_TX: TX_IDS[0],
        OMS_CHILD_DIGEST: plan.planDigest,
      },
    });
    const recovered = JSON.parse(child) as { status: string; home: string; xdg: string; runtime: string };
    expect(recovered).toEqual({ status: "complete", home, xdg: join(home, ".config"), runtime });
    expect(await publisherMarker(item.root)).toContain("\"status\":\"complete\"");
    expect((await policyOf(item.root)).version).toBe(5);
  });
  it("rejects post-admission changes to the nested plan, exact v3 marker, and another observation independently", async () => {
    const item = await admittedV3();
    const plan = await planOf(item, TX_IDS[0]);
    const before = await tree(item.root);
    const planPath = item.bundle.planPath;
    const originalPlan = await readFile(join(item.root, planPath));
    await writeFile(join(item.root, planPath), Buffer.concat([originalPlan, encoder.encode(" ")]));
    await expect(commit(item, plan)).rejects.toThrow(/observation|archive|changed/);
    await writeFile(join(item.root, planPath), originalPlan);
    const originalMarker = await readFile(join(item.root, V3_MARKER_PATH));
    await writeFile(join(item.root, V3_MARKER_PATH), Buffer.concat([originalMarker, encoder.encode(" ")]));
    await expect(commit(item, plan)).rejects.toThrow(/slots|marker|changed/);
    await writeFile(join(item.root, V3_MARKER_PATH), originalMarker);
    const observed = join(item.root, TAXONOMY_PATH);
    const originalObserved = await readFile(observed);
    await writeFile(observed, Buffer.concat([originalObserved, encoder.encode(" ")]));
    await expect(commit(item, plan)).rejects.toThrow(/observation|archive|changed/);
    await writeFile(observed, originalObserved);
    expect(await tree(item.root)).toEqual(before);
    expect(await readdir(join(item.root, ".oms"))).not.toContain("migrations");
  });

  it.each(["source-drift", "retained-v3", "backfill"] as const)("stops after staging when %s changes and does not publish", async kind => {
    const item = await admittedV3();
    const plan = await planOf(item, TX_IDS[0]);
    const before = await tree(item.root);
    await expect(commitVaultPublication(item.target, plan, plan.planDigest, { fault(point) {
      if (point !== "after-staging") return;
      if (kind === "source-drift") return writeFile(join(item.root, POLICY_PATH), Buffer.concat([item.bundle.policy, encoder.encode(" ")]));
      if (kind === "retained-v3") return writeFile(join(item.root, V3_MARKER_PATH), Buffer.concat([item.bundle.markerBytes, encoder.encode(" ")]));
      return writeFile(join(item.root, ".oms/template-backfill.json"), "{\"late\":true}\n");
    } })).rejects.toThrow(/changed|slots|External/);
    expect(bytes(await readFile(join(item.root, V3_MARKER_PATH)))).toEqual(kind === "retained-v3" ? bytes(Buffer.concat([item.bundle.markerBytes, encoder.encode(" ")])) : bytes(item.bundle.markerBytes));
    await expect(readFile(join(item.root, MARKER_PATH))).rejects.toThrow();
    expect(bytes(await readFile(join(item.root, POLICY_PATH)))).toEqual(kind === "source-drift" ? bytes(Buffer.concat([item.bundle.policy, encoder.encode(" ")])) : bytes(item.bundle.policy));
    const staged = join(item.root, `.oms/migrations/${TX_IDS[0]}/staged`);
    expect((await readdir(staged)).length).toBeGreaterThan(0);
    expect(externalOnly(before, await tree(item.root), [POLICY_PATH, V3_MARKER_PATH, ".oms/template-backfill.json"]).every(path => path.startsWith(`.oms/migrations/${TX_IDS[0]}/`))).toBe(true);
  });

  it.each(["after-marker", "after-receipt"] as const)("recovers the first and second ordinary retained successors from %s three times", async point => {
    const item = await admittedV3();
    const retained = item.bundle.markerBytes;
    expect((await commit(item, await planOf(item, TX_IDS[0]))).status).toBe("complete");
    const migratedText = serializeContractPolicyV5(await policyOf(item.root));
    const firstText = successorText(migratedText, 1, true);
    const first = await ordinaryPlan(item, TX_IDS[1], migratedText, firstText, "ordinary publication adds a required summary; not another migration");
    await expect(commitVaultPublication(item.target, first, first.planDigest, { fault(actual) { if (actual === point) throw new Error(point); } })).rejects.toThrow(point);
    for (let count = 0; count < 3; count += 1) expect((await recoverVaultPublication(item.target, "contract-publication", TX_IDS[1], first.planDigest, "resume")).status).toBe("complete");
    const secondText = successorText(firstText, 2, false);
    const second = await ordinaryPlan(item, TX_IDS[2], firstText, secondText, "ordinary publication relaxes the summary requirement");
    await expect(commitVaultPublication(item.target, second, second.planDigest, { fault(actual) { if (actual === point) throw new Error(point); } })).rejects.toThrow(point);
    for (let count = 0; count < 3; count += 1) expect((await recoverVaultPublication(item.target, "contract-publication", TX_IDS[2], second.planDigest, "resume")).status).toBe("complete");
    expect((await policyOf(item.root)).revision).toBe(2);
    expect(bytes(await readFile(join(item.root, V3_MARKER_PATH)))).toEqual(bytes(retained));
    expect((await readdir(join(item.root, ".oms/history/contracts"))).sort()).toEqual(["0.json", "1.json", "2.json"]);
  });

  it("rejects a settings update over a rolled-back migration without replacing its retry anchor", async () => {
    const item = await admitted();
    const plan = await planOf(item, TX_IDS[0]);
    await expect(commitVaultPublication(item.target, plan, plan.planDigest, { fault(point) { if (point === "after-marker") throw new Error("after-marker"); } })).rejects.toThrow("after-marker");
    const approval = prepareRollbackApprovalDigest(plan);
    expect((await recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "rollback", { rollbackApprovalDigest: approval })).status).toBe("rolled-back");
    const marker = await publisherMarker(item.root);
    const settings = settingsText();
    await expect(planVaultPublication(item.target, { kind: "settings-update", vaultId: VAULT_ID, transactionId: RETRY_TX, outputs: [{ path: ".oms/settings.json", expectedDigest: null, content: settings }] })).rejects.toThrow(/explicit migration retry|rolled-back/);
    expect(await publisherMarker(item.root)).toBe(marker);
    await expect(readFile(join(item.root, ".oms/settings.json"))).rejects.toThrow();
    expect((await inspectLegacyVaultMigrationRetry(item.target)).status).toBe("migration-retry");
  });

  it("rejects an ordinary successor when the predecessor terminal receipt is missing or malformed", async () => {
    const item = await admittedV3();
    const retained = item.bundle.markerBytes;
    const migration = await planOf(item, TX_IDS[0]);
    expect((await commit(item, migration)).status).toBe("complete");
    const migratedText = serializeContractPolicyV5(await policyOf(item.root));
    const receiptPath = join(item.root, `.oms/migrations/${TX_IDS[0]}/complete-receipt.json`);
    const receipt = await readFile(receiptPath);
    const controls = await tree(item.root);
    await rm(receiptPath);
    const missing = successorText(migratedText, 1, true);
    await expect(ordinaryPlan(item, TX_IDS[1], migratedText, missing, "ordinary publication adds a required summary; not another migration")).rejects.toThrow(/receipt/);
    await writeFile(receiptPath, Buffer.from(`${JSON.stringify({ version: 1, status: "complete", transactionId: TX_IDS[0] })}\n`));
    await expect(ordinaryPlan(item, TX_IDS[1], migratedText, missing, "ordinary publication adds a required summary; not another migration")).rejects.toThrow(/receipt/);
    await writeFile(receiptPath, receipt);
    expect(await tree(item.root)).toEqual(controls);
    expect(bytes(await readFile(join(item.root, V3_MARKER_PATH)))).toEqual(bytes(retained));
    expect(await readFile(join(item.root, POLICY_PATH), "utf8")).toBe(migratedText);
  });
  it.each(["foreign-owner", "same-owner-rolling-back"] as const)("preserves a %s direct marker injected after receipt without forward revival", async kind => {
    const item = await admitted();
    const plan = await planOf(item, TX_IDS[0]);
    const foreign: VaultPublicationPlan = { ...plan, transactionId: TX_IDS[1], kind: "settings-update" };
    const injected = nativeMarker(plan, kind === "foreign-owner" ? "complete" : "rolling-back", kind === "foreign-owner" ? foreign : plan);
    await expect(commitVaultPublication(item.target, plan, plan.planDigest, { fault(point) {
      if (point !== "after-receipt") return;
      return writeFile(join(item.root, MARKER_PATH), injected);
    } })).rejects.toThrow(kind === "foreign-owner" ? /PUBLICATION_CONFLICT: historical publication slots changed since migration planning/ : /rolling back/);
    expect(bytes(await readFile(join(item.root, MARKER_PATH)))).toEqual(bytes(injected));
    const receipt = await readFile(join(item.root, `.oms/migrations/${TX_IDS[0]}/complete-receipt.json`));
    expect(receipt.toString("utf8")).toContain("\"status\":\"complete\"");
    await expect(recoverVaultPublication(item.target, "schema-migration", TX_IDS[0], plan.planDigest, "resume")).rejects.toThrow(kind === "foreign-owner" ? /PUBLICATION_CONFLICT: historical publication slots changed since migration planning|Another publication owns/ : /rolling back/);
    expect(bytes(await readFile(join(item.root, MARKER_PATH)))).toEqual(bytes(injected));
    expect(bytes(await readFile(join(item.root, `.oms/migrations/${TX_IDS[0]}/complete-receipt.json`)))).toEqual(bytes(receipt));
    expect((await policyOf(item.root)).version).toBe(5);
  });
});

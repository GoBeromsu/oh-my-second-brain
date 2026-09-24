import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "./canonical.js";
import { serializeContractPolicyV5, type ContractPolicyV5 } from "./contract-v5.js";
import { claimPreparedContractSourceCommit, discoverRegisteredSources, findSourceRelinkCandidates, inspectContractSource, prepareContractSourceAcknowledgment, prepareContractSourceRelink, proposeSourceAcknowledgment, proposeSourceRelink, revalidateContractSelection, selectContractV5, type ContractSourcePublicationLocator } from "./source-registry.js";

const roots: string[] = [];
const markdown = "<%* throw new Error('must not execute') %>\n## Details\n{{agent-owned}}\n";
async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), "oms-source-registry-"));
  roots.push(vault);
  await mkdir(join(vault, "Templates", "agent"), { recursive: true });
  await writeFile(join(vault, "Templates", "agent", "flower.md"), markdown);
  const policy: ContractPolicyV5 = {
    version: 5, revision: 1,
    properties: { tags: { type: "tags" } },
    common: { status: "active", fields: { tags: {} } },
    templates: {
      flower: { status: "active", fields: {}, headings: [{ headingId: "details", title: "Details", level: 2 }], source: { identity: "source-flower", path: "Templates/agent/flower.md", rawDigest: digestBytes(markdown) } },
    },
  };
  return { vault, policy };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("explicit source discovery", () => {
  it("discovers seven leaves recursively while keeping exactly one registration and zero control writes", async () => {
    const { vault, policy } = await fixture();
    for (const directory of ["auto", "manual", "zotero"]) {
      await mkdir(join(vault, "Templates", directory), { recursive: true });
      for (const number of [1, 2]) await writeFile(join(vault, "Templates", directory, `${number}.md`), `# ${directory} ${number}`);
    }
    const before = serializeContractPolicyV5(policy);
    const result = await discoverRegisteredSources(vault, policy, ["Templates"]);
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(7);
    expect(result.registeredCount).toBe(1);
    expect(result.candidates.filter(item => item.registeredId !== null)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("must not execute");
    expect(result).not.toHaveProperty("sources");
    expect(serializeContractPolicyV5(policy)).toBe(before);
    expect(await readdir(vault)).toEqual(["Templates"]);
    expect(await readFile(join(vault, "Templates/agent/flower.md"), "utf8")).toBe(markdown);
  });

  it("makes an incomplete subtree explicit rather than presenting partial discovery as complete", async () => {
    const { vault, policy } = await fixture();
    await symlink(join(vault, "Templates/agent"), join(vault, "Templates/shortcut"));
    await writeFile(join(vault, "Templates/.private.md"), "private source");
    const result = await discoverRegisteredSources(vault, policy, ["Templates"]);
    expect(result.complete).toBe(false);
    expect(result.diagnostics.some(item => item.path === "Templates/shortcut" && item.code === "TEMPLATE_SOURCE_UNSAFE")).toBe(true);
    expect(result.diagnostics.some(item => item.path === "Templates/.private.md")).toBe(true);
    expect(result.candidates).toHaveLength(1);
    const missing = await discoverRegisteredSources(vault, policy, ["Absent"]);
    expect(missing.complete).toBe(false);
    expect(missing.candidates).toHaveLength(0);
  });

  it("reports depth and unreadable UTF-8 limits without registering or copying anything", async () => {
    const { vault, policy } = await fixture();
    const deep = join(vault, "Templates", ...Array(18).fill("nested"));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "hidden-by-depth.md"), "leaf");
    await writeFile(join(vault, "Templates/bad.md"), Buffer.from([0xff, 0xfe]));
    const result = await discoverRegisteredSources(vault, policy, ["Templates"]);
    expect(result.complete).toBe(false);
    expect(result.diagnostics.map(item => item.code)).toContain("TEMPLATE_PROPOSAL_OVERSIZE");
    expect(result.diagnostics.map(item => item.code)).toContain("TEMPLATE_SOURCE_MALFORMED");
    expect(result.registeredCount).toBe(1);
    expect(await readdir(vault)).toEqual(["Templates"]);
  });
});

describe("source-bound selection", () => {
  it("returns plain source text without executing it or requiring a default Markdown file", async () => {
    const { vault, policy } = await fixture();
    const selected = await selectContractV5(vault, policy, "flower");
    expect(selected.source?.text).toBe(markdown);
    expect(selected.binding).toMatchObject({ templateId: "flower", policyRevision: 1, sourceDigest: digestBytes(markdown), sourceIdentity: "source-flower", sourcePath: "Templates/agent/flower.md" });
    const common = await selectContractV5(vault, policy, null);
    expect(common.source).toBeNull();
    expect(common.binding).toMatchObject({ sourceIdentity: null, sourcePath: null, sourceDigest: null });
    expect(await readdir(vault)).toEqual(["Templates"]);
    await expect(selectContractV5(vault, policy, "unknown")).rejects.toThrow("CONTRACT_UNKNOWN_TEMPLATE");
  });

  it("blocks only the selected changed source while unrelated registrations remain usable", async () => {
    const { vault, policy } = await fixture();
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    await writeFile(join(vault, "Templates/agent/other.md"), "other");
    const withOther: ContractPolicyV5 = { ...policy, templates: { ...policy.templates, other: { ...entry, source: { identity: "other", path: "Templates/agent/other.md", rawDigest: digestBytes("other") } } } };
    await writeFile(join(vault, "Templates/agent/flower.md"), "edited");
    await expect(selectContractV5(vault, withOther, "flower")).rejects.toThrow("SOURCE_DRIFT");
    expect((await selectContractV5(vault, withOther, "other")).source?.text).toBe("other");
    expect((await selectContractV5(vault, withOther, null)).binding.templateId).toBeNull();
    await rm(join(vault, "Templates/agent/flower.md"));
    await expect(selectContractV5(vault, withOther, "flower")).rejects.toThrow("SOURCE_MISSING");
  });

  it("rechecks both contract and source fingerprints even if the policy revision was not advanced", async () => {
    const { vault, policy } = await fixture();
    const selected = await selectContractV5(vault, policy, "flower");
    expect((await revalidateContractSelection(vault, policy, selected.binding)).source?.text).toBe(markdown);
    await expect(revalidateContractSelection(vault, { ...policy, revision: 2 }, selected.binding)).rejects.toThrow("RESELECT_REQUIRED");
    const changed: ContractPolicyV5 = { ...policy, common: { status: "active", fields: { tags: { required: true } } } };
    await expect(revalidateContractSelection(vault, changed, selected.binding)).rejects.toThrow("RESELECT_REQUIRED");
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    const renamedIdentity: ContractPolicyV5 = { ...policy, templates: { flower: { ...entry, source: { ...entry.source, identity: "another-identity" } } } };
    await expect(revalidateContractSelection(vault, renamedIdentity, selected.binding)).rejects.toThrow("RESELECT_REQUIRED");
    await writeFile(join(vault, "Templates/copy.md"), markdown);
    const changedPath: ContractPolicyV5 = { ...policy, templates: { flower: { ...entry, source: { ...entry.source, path: "Templates/copy.md" } } } };
    await expect(revalidateContractSelection(vault, changedPath, selected.binding)).rejects.toThrow("RESELECT_REQUIRED");
    await writeFile(join(vault, "Templates/agent/flower.md"), "edited");
    await expect(revalidateContractSelection(vault, policy, selected.binding)).rejects.toThrow("RESELECT_REQUIRED");
  });

  it("requires heading slots at selection rather than fitting them to a saved note", async () => {
    const { vault, policy } = await fixture();
    const dynamic: ContractPolicyV5 = { ...policy, common: { status: "active", fields: {}, headings: [{ headingId: "topic", binding: "topic", level: 2 }] } };
    await expect(selectContractV5(vault, dynamic, null)).rejects.toThrow("HEADING_BINDING_INVALID");
    const selected = await selectContractV5(vault, dynamic, null, { topic: "Budget" });
    expect(selected.binding.headingBindings).toEqual({ topic: "Budget" });
  });
});

describe("confirmed source relocation", () => {
  it("does not mistake a still-present source or inaccessible original for a relocation", async () => {
    const { vault, policy } = await fixture();
    await writeFile(join(vault, "Templates/copy.md"), markdown);
    const bytes = serializeContractPolicyV5(policy);
    await expect(findSourceRelinkCandidates(vault, policy, "flower", ["Templates"])).rejects.toThrow("SOURCE_NOT_MISSING");
    await expect(proposeSourceRelink(vault, bytes, "flower", "Templates/copy.md", true)).rejects.toThrow("SOURCE_NOT_MISSING");
    await rm(join(vault, "Templates/agent/flower.md"));
    await symlink(join(vault, "Templates/copy.md"), join(vault, "Templates/agent/flower.md"));
    await expect(proposeSourceRelink(vault, bytes, "flower", "Templates/copy.md", true)).rejects.toThrow("SOURCE_UNREADABLE");
    expect(await readFile(join(vault, "Templates/copy.md"), "utf8")).toBe(markdown);
    expect(await readdir(vault)).toEqual(["Templates"]);
  });

  it("reports zero, one or two hash candidates without relinking automatically", async () => {
    const { vault, policy } = await fixture();
    await rm(join(vault, "Templates/agent/flower.md"));
    expect((await findSourceRelinkCandidates(vault, policy, "flower", ["Templates"])).candidates).toEqual([]);
    await writeFile(join(vault, "Templates/one.md"), markdown);
    const one = await findSourceRelinkCandidates(vault, policy, "flower", ["Templates"]);
    expect(one.candidates).toEqual(["Templates/one.md"]);
    expect(one.confirmationRequired).toBe(true);
    await expect(selectContractV5(vault, policy, "flower")).rejects.toThrow("SOURCE_MISSING");
    await writeFile(join(vault, "Templates/two.md"), markdown);
    expect((await findSourceRelinkCandidates(vault, policy, "flower", ["Templates"])).candidates).toEqual(["Templates/one.md", "Templates/two.md"]);
    expect(await readdir(vault)).toEqual(["Templates"]);
  });

  it("requires explicit confirmation and returns a whole-policy CAS proposal without writing it", async () => {
    const { vault, policy } = await fixture();
    await rename(join(vault, "Templates/agent/flower.md"), join(vault, "Templates/moved.md"));
    const bytes = serializeContractPolicyV5(policy);
    await expect(proposeSourceRelink(vault, bytes, "flower", "Templates/moved.md", false)).rejects.toThrow("RELINK_CONFIRMATION_REQUIRED");
    const proposal = await proposeSourceRelink(vault, bytes, "flower", "Templates/moved.md", true);
    expect(proposal).toMatchObject({ expectedPolicyDigest: digestBytes(bytes), sourceIdentity: "source-flower", fromPath: "Templates/agent/flower.md", toPath: "Templates/moved.md" });
    expect(proposal.policy.revision).toBe(2);
    expect((await selectContractV5(vault, proposal.policy, "flower")).source?.text).toBe(markdown);
    expect(serializeContractPolicyV5(policy)).toBe(bytes);
    expect(await readdir(vault)).toEqual(["Templates"]);
    await writeFile(join(vault, "Templates/moved.md"), "not approved");
    await expect(proposeSourceRelink(vault, bytes, "flower", "Templates/moved.md", true)).rejects.toThrow("SOURCE_DRIFT");
  });
  it("rejects non-canonical explicit relink spellings instead of silently selecting the normalized path", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    await rename(join(vault, "Templates/agent/flower.md"), join(vault, "Templates/moved.md"));
    const nfd = `Templates/${"e\u0301"}.md`;
    await writeFile(join(vault, "Templates", `${"é"}.md`), markdown);
    const before = await readdir(join(vault, "Templates"));
    for (const candidate of ["Templates/./moved.md", "Templates//moved.md", "Templates\\moved.md", nfd]) {
      await expect(proposeSourceRelink(vault, bytes, "flower", candidate, true)).rejects.toThrow(/SOURCE_REVIEW_EVIDENCE_INVALID: Explicit relink candidate must already be canonical/);
    }
    const proposal = await proposeSourceRelink(vault, bytes, "flower", "Templates/moved.md", true);
    expect(proposal.toPath).toBe("Templates/moved.md");
    expect(await readdir(join(vault, "Templates"))).toEqual(before);
  });
});

describe("explicit source review", () => {
  it("reports absent historical bytes honestly and preserves effective rules on an approved SHA-only update", async () => {
    const { vault, policy } = await fixture();
    const before = await selectContractV5(vault, policy, "flower");
    const bytes = serializeContractPolicyV5(policy);
    const changed = `${markdown}\nA source comment changed.\n`;
    await writeFile(join(vault, "Templates/agent/flower.md"), changed);
    const review = await inspectContractSource(vault, policy, "flower");
    expect(review).toMatchObject({ state: "drift", previousBytesAvailable: false, previousText: null, currentText: changed, currentDigest: digestBytes(changed) });
    expect((await inspectContractSource(vault, policy, "flower", Buffer.from(markdown))).previousText).toBe(markdown);
    await expect(inspectContractSource(vault, policy, "flower", Buffer.from(changed))).rejects.toThrow("SOURCE_REVIEW_EVIDENCE_INVALID");
    await expect(proposeSourceAcknowledgment(vault, bytes, "flower", digestBytes(changed), false)).rejects.toThrow("SOURCE_REVIEW_CONFIRMATION_REQUIRED");
    expect(serializeContractPolicyV5(policy)).toBe(bytes);
    const proposal = await proposeSourceAcknowledgment(vault, bytes, "flower", digestBytes(changed), true);
    const after = await selectContractV5(vault, proposal.policy, "flower");
    expect(proposal.policy.revision).toBe(2);
    expect(proposal.expectedPolicyDigest).toBe(digestBytes(bytes));
    expect(after.binding.contractDigest).toBe(before.binding.contractDigest);
    expect(after.binding.sourceIdentity).toBe(before.binding.sourceIdentity);
    expect(after.binding.sourcePath).toBe(before.binding.sourcePath);
    expect(after.binding.sourceDigest).toBe(digestBytes(changed));
    await expect(revalidateContractSelection(vault, proposal.policy, before.binding)).rejects.toThrow("RESELECT_REQUIRED");
    expect(await readdir(vault)).toEqual(["Templates"]);
    expect(await readFile(join(vault, "Templates/agent/flower.md"), "utf8")).toBe(changed);
  });

  it("refuses stale confirmation, unavailable sources and unnecessary duplicate acknowledgment", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    expect((await inspectContractSource(vault, policy, "flower")).state).toBe("unchanged");
    await expect(proposeSourceAcknowledgment(vault, bytes, "flower", digestBytes(markdown), true)).rejects.toThrow("SOURCE_REVIEW_NOT_NEEDED");
    await writeFile(join(vault, "Templates/agent/flower.md"), "second edit");
    await expect(proposeSourceAcknowledgment(vault, bytes, "flower", digestBytes("first edit"), true)).rejects.toThrow("SOURCE_DRIFT");
    await writeFile(join(vault, "Templates/agent/flower.md"), Buffer.from([0xff]));
    expect((await inspectContractSource(vault, policy, "flower")).state).toBe("unreadable");
    await expect(proposeSourceAcknowledgment(vault, bytes, "flower", digestBytes("first edit"), true)).rejects.toThrow("SOURCE_UNREADABLE");
    await rm(join(vault, "Templates/agent/flower.md"));
    expect((await inspectContractSource(vault, policy, "flower")).state).toBe("missing");
    await expect(proposeSourceAcknowledgment(vault, bytes, "flower", digestBytes("first edit"), true)).rejects.toThrow("SOURCE_MISSING");
    await expect(inspectContractSource(vault, policy, "unknown")).rejects.toThrow("CONTRACT_UNKNOWN_TEMPLATE");
    const pending: ContractPolicyV5 = { ...policy, templates: { flower: { status: "review-required", reasons: ["unclassified meaning"], legacy: {} } } };
    await expect(inspectContractSource(vault, pending, "flower")).rejects.toThrow("RESELECT_REQUIRED");
    expect(await readdir(vault)).toEqual(["Templates"]);
  });
});

const reviewId = "11111111-1111-4111-8111-111111111111";
const relinkId = "22222222-2222-4222-8222-222222222222";
function locator(kind: ContractSourcePublicationLocator["kind"], templateId = "flower", transactionId = kind === "source-review" ? reviewId : relinkId): ContractSourcePublicationLocator {
  return { transactionId, kind, templateId };
}
describe("private source-commit capabilities", () => {
  it("binds a drifted acknowledgment and refuses unknown, held, unchanged, missing, or unreadable sources", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    const changed = `${markdown}\nreviewed comment\n`;
    await writeFile(join(vault, "Templates/agent/flower.md"), changed);
    const prepared = await prepareContractSourceAcknowledgment(vault, bytes, locator("source-review"));
    expect(prepared.review).toMatchObject({ state: "drift", previousText: null, previousBytesAvailable: false, currentDigest: digestBytes(changed) });
    expect(JSON.stringify(prepared.review)).not.toMatch(/human approval|historical source bytes were available|historical text/i);
    const facts = await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("source-review"), policyBytes: bytes });
    expect(facts).toEqual({ kind: "source-review", transactionId: reviewId, templateId: "flower", canonicalVault: await realpath(vault), expectedPolicyDigest: digestBytes(bytes), policyRevision: 1, sourceIdentity: "source-flower", fromPath: "Templates/agent/flower.md", toPath: "Templates/agent/flower.md", previousRawDigest: digestBytes(markdown), reviewedRawDigest: digestBytes(changed) });
    expect(await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("source-review"), policyBytes: bytes })).toBeNull();
    await expect(prepareContractSourceAcknowledgment(vault, bytes, locator("source-review", "unknown"))).rejects.toThrow("CONTRACT_UNKNOWN_TEMPLATE");
    const held: ContractPolicyV5 = { ...policy, templates: { flower: { status: "review-required", reasons: ["held"], legacy: {} } } };
    await expect(prepareContractSourceAcknowledgment(vault, serializeContractPolicyV5(held), locator("source-review"))).rejects.toThrow("RESELECT_REQUIRED");
    await writeFile(join(vault, "Templates/agent/flower.md"), markdown);
    await expect(prepareContractSourceAcknowledgment(vault, bytes, locator("source-review"))).rejects.toThrow("SOURCE_REVIEW_NOT_NEEDED");
    await rm(join(vault, "Templates/agent/flower.md"));
    await expect(prepareContractSourceAcknowledgment(vault, bytes, locator("source-review"))).rejects.toThrow("SOURCE_MISSING");
    await writeFile(join(vault, "Templates/agent/flower.md"), Buffer.from([0xff]));
    await expect(prepareContractSourceAcknowledgment(vault, bytes, locator("source-review"))).rejects.toThrow("SOURCE_UNREADABLE");
    expect(await readdir(vault)).toEqual(["Templates"]);
  });

  it("binds an explicit missing-path relink and rejects a still-present or different-SHA candidate", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    await rename(join(vault, "Templates/agent/flower.md"), join(vault, "Templates/moved.md"));
    const prepared = await prepareContractSourceRelink(vault, bytes, locator("relink"), "Templates/moved.md");
    const facts = await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("relink"), policyBytes: bytes });
    expect(facts).toMatchObject({ kind: "relink", fromPath: "Templates/agent/flower.md", toPath: "Templates/moved.md", previousRawDigest: digestBytes(markdown), reviewedRawDigest: digestBytes(markdown) });
    expect(prepared.review.state).toBe("missing");
    expect(prepared.review.previousText).toBeNull();
    await writeFile(join(vault, "Templates/agent/flower.md"), markdown);
    await expect(prepareContractSourceRelink(vault, bytes, locator("relink"), "Templates/moved.md")).rejects.toThrow("SOURCE_NOT_MISSING");
    await rm(join(vault, "Templates/agent/flower.md"));
    await writeFile(join(vault, "Templates/other.md"), "different");
    await expect(prepareContractSourceRelink(vault, bytes, locator("relink"), "Templates/other.md")).rejects.toThrow("SOURCE_DRIFT");
    expect(await readdir(vault)).toEqual(["Templates"]);
  });
  it("rejects non-canonical explicit private relink candidates even when the NFC file has the same SHA", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    await rename(join(vault, "Templates/agent/flower.md"), join(vault, "Templates/moved.md"));
    const nfd = `Templates/${"e\u0301"}.md`;
    await writeFile(join(vault, "Templates", `${"é"}.md`), markdown);
    for (const candidate of ["Templates/./moved.md", "Templates//moved.md", "Templates\\moved.md", nfd]) {
      await expect(prepareContractSourceRelink(vault, bytes, locator("relink"), candidate)).rejects.toThrow(/SOURCE_REVIEW_EVIDENCE_INVALID: Explicit relink candidate must already be canonical/);
    }
    const prepared = await prepareContractSourceRelink(vault, bytes, locator("relink"), "Templates/moved.md");
    expect((await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("relink"), policyBytes: bytes }))?.toPath).toBe("Templates/moved.md");
    expect(await readdir(vault)).toEqual(["Templates"]);
  });

  it("rejects forged, round-tripped, cross-root, and same-SHA rebound capabilities without consuming a valid one", async () => {
    const { vault, policy } = await fixture();
    const other = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    const changed = `${markdown}\nreviewed\n`;
    await writeFile(join(vault, "Templates/agent/flower.md"), changed);
    await writeFile(join(other.vault, "Templates/agent/flower.md"), changed);
    const prepared = await prepareContractSourceAcknowledgment(vault, bytes, locator("source-review"));
    expect(await claimPreparedContractSourceCommit({}, { vault, locator: locator("source-review"), policyBytes: bytes })).toBeNull();
    expect(await claimPreparedContractSourceCommit(JSON.parse(JSON.stringify({ preparation: {}, review: prepared.review })), { vault, locator: locator("source-review"), policyBytes: bytes })).toBeNull();
    expect(await claimPreparedContractSourceCommit(prepared.preparation, { vault: other.vault, locator: locator("source-review"), policyBytes: bytes })).toBeNull();
    const entry = policy.templates.flower;
    if (entry.status !== "active") throw new Error("fixture");
    const renamed = serializeContractPolicyV5({ ...policy, templates: { flower: { ...entry, source: { ...entry.source, identity: "other-source" } } } });
    expect(await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("source-review"), policyBytes: renamed })).toBeNull();
    const moved = serializeContractPolicyV5({ ...policy, templates: { flower: { ...entry, source: { ...entry.source, path: "Templates/copy.md" } } } });
    expect(await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("source-review"), policyBytes: moved })).toBeNull();
    const revised = serializeContractPolicyV5({ ...policy, revision: 2 });
    expect(await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("source-review"), policyBytes: revised })).toBeNull();
    const reformatted = `${bytes.trimEnd()} \n`;
    expect(digestBytes(reformatted)).not.toBe(digestBytes(bytes));
    expect(await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("source-review"), policyBytes: reformatted })).toBeNull();
    expect(await claimPreparedContractSourceCommit(prepared.preparation, { vault, locator: locator("source-review"), policyBytes: bytes })).not.toBeNull();
  });

  it("copies public review data and binds a symlink alias to the canonical root", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    const alias = join(vault, "alias");
    await symlink(vault, alias);
    const changed = `${markdown}\nalias reviewed\n`;
    await writeFile(join(vault, "Templates/agent/flower.md"), changed);
    const input = { ...locator("source-review") };
    const prepared = await prepareContractSourceAcknowledgment(alias, bytes, input);
    input.transactionId = "33333333-3333-4333-8333-333333333333";
    prepared.review.diagnostics.push({ code: "FORGED", message: "mutated" });
    const facts = await claimPreparedContractSourceCommit(prepared.preparation, { vault: alias, locator: locator("source-review"), policyBytes: bytes });
    expect(facts?.transactionId).toBe(reviewId);
    expect(facts?.canonicalVault).toBe(await realpath(vault));
    expect(prepared.review.diagnostics.some(item => item.code === "FORGED")).toBe(true);
    expect(facts).not.toHaveProperty("policyBytes");
    expect(await readdir(vault)).toEqual(["Templates", "alias"]);
  });

  it("rejects malformed locator ids, kinds, extra string fields, and symbol keys", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    await writeFile(join(vault, "Templates/agent/flower.md"), `${markdown}\nreviewed\n`);
    const extra = { ...locator("source-review"), confirmed: true };
    const symbol = Object.assign(locator("source-review"), { [Symbol("brand")]: true });
    await expect(prepareContractSourceAcknowledgment(vault, bytes, { ...locator("source-review"), transactionId: "NOT-A-UUID" })).rejects.toThrow("SOURCE_REVIEW_EVIDENCE_INVALID");
    await expect(prepareContractSourceAcknowledgment(vault, bytes, { ...locator("source-review"), kind: "publication" as "source-review" })).rejects.toThrow("SOURCE_REVIEW_EVIDENCE_INVALID");
    await expect(prepareContractSourceAcknowledgment(vault, bytes, extra)).rejects.toThrow("SOURCE_REVIEW_EVIDENCE_INVALID");
    await expect(prepareContractSourceAcknowledgment(vault, bytes, symbol)).rejects.toThrow("SOURCE_REVIEW_EVIDENCE_INVALID");
    await expect(prepareContractSourceAcknowledgment(vault, bytes, locator("relink"))).rejects.toThrow("SOURCE_REVIEW_EVIDENCE_INVALID");
  });

  it("lets exactly one simultaneous claim succeed", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    await writeFile(join(vault, "Templates/agent/flower.md"), `${markdown}\nreviewed\n`);
    const prepared = await prepareContractSourceAcknowledgment(vault, bytes, locator("source-review"));
    const expected = { vault, locator: locator("source-review"), policyBytes: bytes };
    const [left, right] = await Promise.all([
      claimPreparedContractSourceCommit(prepared.preparation, expected),
      claimPreparedContractSourceCommit(prepared.preparation, expected),
    ]);
    expect([left, right].filter(item => item !== null)).toHaveLength(1);
    expect(await claimPreparedContractSourceCommit(prepared.preparation, expected)).toBeNull();
  });

  it("returns no facts when the source changes or a missing path reappears before claim", async () => {
    const { vault, policy } = await fixture();
    const bytes = serializeContractPolicyV5(policy);
    await writeFile(join(vault, "Templates/agent/flower.md"), `${markdown}\nreviewed\n`);
    const review = await prepareContractSourceAcknowledgment(vault, bytes, locator("source-review"));
    await writeFile(join(vault, "Templates/agent/flower.md"), `${markdown}\nchanged again\n`);
    expect(await claimPreparedContractSourceCommit(review.preparation, { vault, locator: locator("source-review"), policyBytes: bytes })).toBeNull();
    await writeFile(join(vault, "Templates/agent/flower.md"), markdown);
    await rename(join(vault, "Templates/agent/flower.md"), join(vault, "Templates/moved.md"));
    const relink = await prepareContractSourceRelink(vault, bytes, locator("relink"), "Templates/moved.md");
    await writeFile(join(vault, "Templates/agent/flower.md"), markdown);
    expect(await claimPreparedContractSourceCommit(relink.preparation, { vault, locator: locator("relink"), policyBytes: bytes })).toBeNull();
    expect(await readdir(vault)).toEqual(["Templates"]);
  });
});

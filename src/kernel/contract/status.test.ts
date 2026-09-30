import { appendFile, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSharedCopy, buildTruthTableRow, TRUTH_TABLE_ROWS, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import { guardEventsPath } from "./guard-events.js";
import type { TemplatedContract } from "./legacy.js";
import { appendInterviewEvent, EVENTS_FILE, pendingLogKey } from "./interview-log.js";
import { stateDir } from "./state-dir.js";
import {
  contractDoctor, contractStatus, doctorFix, legacyTemplateFinding, ROW_FINDING, SHARED_FINDING, STORE_UNREADABLE_FINDING, templateFolderUnsetFinding, type DoctorFixResult,
} from "./status.js";
import { readVaultSettings, serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { GUIDANCE_FOR, type VaultContract } from "./types.js";
import { resolveSealState, type SealRow } from "./vault-id.js";

const fixtures: TruthTableFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

async function row(name: SealRow, contract?: VaultContract | TemplatedContract): Promise<TruthTableFixture> {
  const fixture = await buildTruthTableRow(name, contract);
  fixtures.push(fixture);
  return fixture;
}

const EXPECTED_CONTRACT: Readonly<Record<SealRow, "none" | "sealed" | "unreadable">> = {
  "never-sealed": "none",
  "synced-second-machine": "none",
  "store-without-index": "sealed",
  "vault-moved": "sealed",
  "sealed": "sealed",
  "index-without-store": "unreadable",
  "settings-missing": "unreadable",
  "vault-id-tampered": "unreadable",
  "index-corrupt": "sealed",
};

const EXPECTED_REASON: Partial<Record<SealRow, "broken" | "tampered">> = {
  "index-without-store": "broken",
  "settings-missing": "broken",
  "vault-id-tampered": "tampered",
};

const EXPECTED_FIX: Readonly<Record<SealRow, DoctorFixResult>> = {
  "never-sealed": "nothing-to-fix",
  "synced-second-machine": "not-fixable",
  "store-without-index": "reindexed",
  "vault-moved": "reindexed",
  "sealed": "nothing-to-fix",
  "index-without-store": "not-fixable",
  "settings-missing": "not-fixable",
  "vault-id-tampered": "not-fixable",
  "index-corrupt": "reindexed",
};

describe("contractStatus", () => {
  for (const name of TRUTH_TABLE_ROWS) {
    it(`reports the fixed finding for ${name}`, async () => {
      const fixture = await row(name);
      const status = await contractStatus(fixture.vault, fixture.root);
      expect(status.row).toBe(name);
      expect(status.contract).toBe(EXPECTED_CONTRACT[name]);
      expect(status.reason).toBe(EXPECTED_REASON[name]);
      expect(status.findings).toEqual([ROW_FINDING[name]]);
      expect(JSON.stringify(status)).not.toContain(fixture.vaultId);
      expect(JSON.stringify(status)).not.toContain(fixture.root);
    });
  }

  it("points every row without a local contract to the command its write warning names", () => {
    expect(ROW_FINDING["never-sealed"].guidance).toBe(GUIDANCE_FOR["contract-open"]);
    expect(ROW_FINDING["synced-second-machine"].guidance).toBe(GUIDANCE_FOR["contract-open"]);
    expect(ROW_FINDING["index-without-store"].guidance).toBe(GUIDANCE_FOR["contract-unreadable"]);
  });

  it("points an unreadable store to the diagnosis a tampered write warning names, never to a reseal", () => {
    expect(STORE_UNREADABLE_FINDING.guidance).toBe(GUIDANCE_FOR["contract-tampered"]);
  });

  it("adds the shared finding for a copied vault", async () => {
    const fixture = await row("sealed");
    await addSharedCopy(fixture);
    expect((await contractStatus(fixture.vault, fixture.root)).findings).toEqual([ROW_FINDING.sealed, SHARED_FINDING]);
  });

  it("reports an altered store as unreadable", async () => {
    const fixture = await row("sealed");
    const generation = (await readdir(fixture.root)).find(entry => entry.startsWith(`.${fixture.vaultId}.`))!;
    await writeFile(join(fixture.root, generation, "folders.json"), "{}");
    const status = await contractStatus(fixture.vault, fixture.root);
    expect(status.contract).toBe("unreadable");
    expect(status.findings).toEqual([ROW_FINDING.sealed, STORE_UNREADABLE_FINDING]);
  });

  it("counts the template constraints of a legacy generation and reports them as ignored", async () => {
    const template = { source: "Templates/Meeting.md", sourceHash: `sha256:${"a".repeat(64)}` as const, requiredProperties: ["status"], narrowedRules: {}, requiredHeadings: ["Agenda"] };
    const contract: TemplatedContract = { folders: null, properties: null, templates: { Meeting: template, Gone: { ...template, source: "Templates/Gone.md" } } };
    const fixture = await row("sealed", contract);
    const status = await contractStatus(fixture.vault, fixture.root);
    expect(status).toMatchObject({ contract: "sealed", legacyTemplates: 2 });
    expect(status.findings).toContainEqual(legacyTemplateFinding(2));
    expect(legacyTemplateFinding(2)).toEqual({ message: "legacy-template-constraints-ignored: 2", guidance: "oms interview" });
  });

  it("suggests a template folder for a legacy generation whose settings name none, without writing it", async () => {
    const template = { source: "Templates/Meeting.md", sourceHash: `sha256:${"a".repeat(64)}` as const, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] };
    const contract: TemplatedContract = { folders: null, properties: null, templates: { Meeting: template, Daily: { ...template, source: "Templates/Daily.md" } } };
    const fixture = await row("sealed", contract);
    const before = await readFile(join(fixture.vault, SETTINGS_PATH), "utf8");
    const status = await contractStatus(fixture.vault, fixture.root);
    expect(status.findings).toContainEqual({
      message: "template-folder-unset: set \"templateFolder\" to \"Templates\" in .oms/settings.json so templates scaffold new notes",
      guidance: null,
    });
    expect(await readFile(join(fixture.vault, SETTINGS_PATH), "utf8")).toBe(before);
  });

  it("names no folder when the legacy templates do not share one", () => {
    expect(templateFolderUnsetFinding(["Templates/Meeting.md", "Other/Daily.md"]).message).toContain("to your template folder in");
    expect(templateFolderUnsetFinding(["Meeting.md"]).message).toContain("to your template folder in");
  });

  it("makes no template folder suggestion once the settings name one", async () => {
    const template = { source: "Templates/Meeting.md", sourceHash: `sha256:${"a".repeat(64)}` as const, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] };
    const fixture = await row("sealed", { folders: null, properties: null, templates: { Meeting: template } });
    const settings = await readVaultSettings(fixture.vault);
    await writeFile(join(fixture.vault, SETTINGS_PATH), serializeVaultSettings({ ...settings!, templateFolder: "Templates" }));
    const status = await contractStatus(fixture.vault, fixture.root);
    expect(status.findings).toContainEqual(legacyTemplateFinding(1));
    expect(status.findings.some(finding => finding.message.startsWith("template-folder-unset"))).toBe(false);
  });

  it("reports no legacy template finding for a version 3 generation", async () => {
    const fixture = await row("sealed");
    const status = await contractStatus(fixture.vault, fixture.root);
    expect(status).toMatchObject({ contract: "sealed", legacyTemplates: 0 });
    expect(status.findings.some(finding => finding.message.startsWith("legacy-template-constraints-ignored"))).toBe(false);
    expect(status.findings.some(finding => finding.message.startsWith("template-folder-unset"))).toBe(false);
  });
});

describe("contractDoctor", () => {
  const CAUSE: Partial<Record<SealRow, string>> = { "index-without-store": "index-without-store", "settings-missing": "settings-missing", "vault-id-tampered": "vault-id-mismatch" };

  for (const name of TRUTH_TABLE_ROWS) {
    it(`AC16: reports the cause and recovery for ${name} without naming a path or id`, async () => {
      const fixture = await row(name);
      const report = await contractDoctor(fixture.vault, "human", fixture.root);
      const cause = CAUSE[name] ?? null;
      // With its link gone, the generation left behind is an orphan.
      const orphans = name === "index-without-store" ? 1 : 0;
      expect(report).toMatchObject({ cause, recovery: cause === null ? null : "oms setup", staleLocks: 0, orphans, unexpectedControlFiles: [] });
      expect(JSON.stringify(report)).not.toContain(fixture.vaultId);
      expect(JSON.stringify(report)).not.toContain(fixture.root);
    });
  }

  it("names a store cause for an altered or dangling store", async () => {
    const altered = await row("sealed");
    const generation = (await readdir(altered.root)).find(entry => entry.startsWith(`.${altered.vaultId}.`))!;
    await writeFile(join(altered.root, generation, "folders.json"), "{}");
    expect(await contractDoctor(altered.vault, "human", altered.root)).toMatchObject({ contract: "unreadable", cause: "manifest-mismatch", recovery: "oms setup" });

    const dangling = await row("sealed");
    await rm(join(dangling.root, dangling.vaultId));
    await symlink(`.${dangling.vaultId}.404`, join(dangling.root, dangling.vaultId));
    expect(await contractDoctor(dangling.vault, "human", dangling.root)).toMatchObject({ contract: "unreadable", cause: "link-dangling", recovery: "oms setup" });
  });

  it("counts stale locks and orphan generations without naming them", async () => {
    const fixture = await row("sealed");
    await writeFile(join(fixture.root, `.${fixture.vaultId}.lock.stale-1`), "{}");
    await mkdir(join(fixture.root, `.${fixture.vaultId}.99`));
    const report = await contractDoctor(fixture.vault, "human", fixture.root);
    expect(report).toMatchObject({ contract: "sealed", cause: null, staleLocks: 1, orphans: 1 });
    expect(JSON.stringify(report)).not.toContain(".99");
  });

  it("reports hook transport failures as counts per kind only", async () => {
    const fixture = await row("sealed");
    expect((await contractDoctor(fixture.vault, "agent", fixture.root)).transportFailures).toEqual({ total: 0, kinds: {} });
    await writeFile(guardEventsPath(fixture.root), `${JSON.stringify({ ts: "2026-09-25T00:00:00.000Z", kind: "timeout" })}\n`);
    const report = await contractDoctor(fixture.vault, "agent", fixture.root);
    expect(report.transportFailures).toEqual({ total: 1, kinds: { timeout: 1 } });
    expect(JSON.stringify(report)).not.toContain("2026-09-25");
  });

  it("reports corrupt interview log lines by line number, read-only, for the id log and the pending log", async () => {
    const fixture = await row("sealed");
    const answered = { type: "answered" as const, questionId: "q", questionDigest: "d", payload: { answer: "yes" } };
    expect((await contractDoctor(fixture.vault, "agent", fixture.root)).interviewLog).toEqual({ corrupt: [], pendingCorrupt: [], unreadable: false });
    await appendInterviewEvent(fixture.root, fixture.vaultId, answered);
    const log = join(stateDir(fixture.root, fixture.vaultId), "interview", EVENTS_FILE);
    await appendFile(log, "not json\n");
    const pendingKey = await pendingLogKey(fixture.vault);
    await appendInterviewEvent(fixture.root, pendingKey, answered);
    const pending = join(stateDir(fixture.root, pendingKey), "interview", EVENTS_FILE);
    await appendFile(pending, "{\"type\":\"bogus\"}\n");
    const before = [await readFile(log, "utf8"), await readFile(pending, "utf8")];
    const report = await contractDoctor(fixture.vault, "human", fixture.root);
    expect(report.interviewLog).toEqual({ corrupt: [2], pendingCorrupt: [2], unreadable: false });
    expect([await readFile(log, "utf8"), await readFile(pending, "utf8")]).toEqual(before);
  });

  it("reports an interview log it may not read as unreadable instead of failing", async () => {
    const fixture = await row("sealed");
    await mkdir(join(fixture.vault, "..", "elsewhere"));
    // The seal already made the state directory (its snapshots); replace it with the link.
    await rm(stateDir(fixture.root, fixture.vaultId), { recursive: true, force: true });
    await symlink(join(fixture.vault, "..", "elsewhere"), stateDir(fixture.root, fixture.vaultId));
    expect((await contractDoctor(fixture.vault, "agent", fixture.root)).interviewLog).toEqual({ corrupt: [], pendingCorrupt: [], unreadable: true });
  });

  it("lists unexpected control files by their disk names for a person and only counts them for an agent", async () => {
    const fixture = await row("sealed");
    await writeFile(join(fixture.vault, ".oms", "b-leftover.json"), "{}");
    await mkdir(join(fixture.vault, ".oms", "a-dir"));
    expect((await contractDoctor(fixture.vault, "human", fixture.root)).unexpectedControlFiles).toEqual([
      { path: ".oms/a-dir", kind: "unexpected-control-file" },
      { path: ".oms/b-leftover.json", kind: "unexpected-control-file" },
    ]);
    const agent = await contractDoctor(fixture.vault, "agent", fixture.root);
    expect(agent.unexpectedControlFiles).toBe(2);
    expect(JSON.stringify(agent)).not.toContain("leftover");
  });
});

describe("doctorFix", () => {
  for (const name of TRUTH_TABLE_ROWS) {
    it(`returns ${EXPECTED_FIX[name]} for ${name}`, async () => {
      const fixture = await row(name);
      expect(await doctorFix(fixture.vault, fixture.root)).toBe(EXPECTED_FIX[name]);
      if (EXPECTED_FIX[name] === "reindexed") {
        expect((await resolveSealState(fixture.vault, fixture.root)).row).toBe("sealed");
      }
    });
  }
});

import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSharedCopy, buildTruthTableRow, TRUTH_TABLE_ROWS, type TruthTableFixture } from "../../../test/fixtures/contract-truth-table.js";
import { extractTemplate } from "./extract.js";
import { guardEventsPath } from "./guard-events.js";
import {
  contractDoctor, contractStatus, doctorFix, ROW_FINDING, SHARED_FINDING, STORE_UNREADABLE_FINDING, type DoctorFixResult,
} from "./status.js";
import type { VaultContract } from "./types.js";
import { resolveSealState, type SealRow } from "./vault-id.js";

const fixtures: TruthTableFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

async function row(name: SealRow, contract?: VaultContract): Promise<TruthTableFixture> {
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
  "vault-id-tampered": "unreadable",
  "index-corrupt": "sealed",
};

const EXPECTED_FIX: Readonly<Record<SealRow, DoctorFixResult>> = {
  "never-sealed": "nothing-to-fix",
  "synced-second-machine": "not-fixable",
  "store-without-index": "reindexed",
  "vault-moved": "reindexed",
  "sealed": "nothing-to-fix",
  "index-without-store": "not-fixable",
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
      expect(status.findings).toEqual([ROW_FINDING[name]]);
      expect(JSON.stringify(status)).not.toContain(fixture.vaultId);
      expect(JSON.stringify(status)).not.toContain(fixture.root);
    });
  }

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

  it("lists template drift by name", async () => {
    const probe = await row("never-sealed");
    await mkdir(join(probe.vault, "Templates"));
    await writeFile(join(probe.vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n");
    const extracted = await extractTemplate(probe.vault, "Templates/Meeting.md");
    if (!extracted.ok) throw new Error("extraction failed");
    const template = { source: "Templates/Meeting.md", sourceHash: extracted.extraction.sourceHash, requiredProperties: [], narrowedRules: {}, requiredHeadings: [] };
    const contract: VaultContract = { folders: null, properties: null, templates: { Meeting: template, Gone: { ...template, source: "Templates/Gone.md" } } };

    const fixture = await row("sealed", contract);
    await mkdir(join(fixture.vault, "Templates"));
    await writeFile(join(fixture.vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n");
    expect((await contractStatus(fixture.vault, fixture.root)).templates).toEqual([
      { name: "Gone", state: "missing" },
      { name: "Meeting", state: "active" },
    ]);
    await writeFile(join(fixture.vault, "Templates/Meeting.md"), "---\nstatus: closed\n---\n");
    expect((await contractStatus(fixture.vault, fixture.root)).templates).toContainEqual({ name: "Meeting", state: "drift" });
  });
});

describe("contractDoctor", () => {
  const CAUSE: Partial<Record<SealRow, string>> = { "index-without-store": "index-without-store", "vault-id-tampered": "vault-id-mismatch" };

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

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../src/kernel/templates/canonical.js";
import { serializeVaultSettings } from "../src/kernel/templates/vault-settings.js";
import { writeApprovedVault } from "../src/kernel/templates/approved-vault-fixture.js";
import {
  answerTemplateInterview,
  commitTemplateContracts,
  nextTemplateInterview,
} from "../src/kernel/templates/interview-service.js";
import { loadResolvedTemplates } from "../src/kernel/templates/resolver.js";
import { readTemplateChangeNotice } from "../src/mcp/template-notice.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const distCli = join(repoRoot, "dist", "cli", "oms.js");

/** Runs the built CLI so the public surface itself is under test. */
function cli(vault: string, args: readonly string[]) {
  if (!existsSync(distCli)) throw new Error("dist/cli/oms.js is missing; run npm run build first.");
  return spawnSync(process.execPath, [distCli, ...args, "--vault", vault], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, OMS_NO_UPDATE_NOTICE: "1" },
  });
}

/**
 * Contract review end to end.
 *
 * The interview is the only way a contract changes. It asks one question at a
 * time, binds every answer to the census and ledger it was asked from, and
 * publishes through one user-approved digest. Raw template sources and ordinary
 * notes are never publication outputs.
 */

const roots: string[] = [];
const encoder = new TextEncoder();
const PUBLISH_TX = "aaaaaaaa-1111-4111-8111-111111111111";
const ACKNOWLEDGE_TX = "bbbbbbbb-2222-4222-8222-222222222222";
const SOURCE_PATH = "Templates/Review/article.md";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Bytes an agent or plugin would have written, including BOM and CRLF. */
const RAW_SOURCE = encoder.encode(
  "\ufeff---\r\n"
  + "title: English\r\n"
  + "language: en\r\n"
  + "---\r\n"
  + "# Overview\r\n",
);
const EXISTING_NOTE = encoder.encode(
  "\ufeff---\r\n"
  + "title: Existing\r\n"
  + "---\r\n"
  + "Do not rewrite this note.\r\n",
);

/** A vault whose template folder is declared by the user's own Obsidian settings. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-contract-review-"));
  roots.push(root);
  await writeApprovedVault(root, {
    properties: {
      title: { type: "text", intent: "Article title." },
      language: { type: "select", intent: "Language.", allowedValues: ["en", "ko"] },
    },
    obsidianTypes: { title: "text", language: "select" },
  });
  await mkdir(join(root, "Templates", "Review"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, ".obsidian", "templates.json"), JSON.stringify({ folder: "Templates/Review" }));
  await writeFile(join(root, SOURCE_PATH), RAW_SOURCE);
  await writeFile(join(root, "notes", "existing.md"), EXISTING_NOTE);
  return root;
}

/** A vault ready for explicit publication: settings, a real source, no policy. */
async function contractFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oms-contract-publish-")));
  roots.push(root);
  await mkdir(join(root, "Templates", "Review"), { recursive: true });
  await mkdir(join(root, ".oms"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, ".oms", "settings.json"), serializeVaultSettings({ version: 1, vaultId: "11111111-1111-4111-8111-111111111111", templateRoots: ["Templates"] }));
  await writeFile(join(root, SOURCE_PATH), RAW_SOURCE);
  await writeFile(join(root, "notes", "existing.md"), EXISTING_NOTE);
  return root;
}

function target(vault: string) {
  return { vault, source: "explicit" as const };
}

/**
 * Explicit contract meaning, supplied by the caller. OMS never derives a field,
 * heading, or template id by reading the source file's name or syntax.
 */
const PROPOSALS = [
  {
    kind: "individual",
    templateId: "article",
    sourcePath: SOURCE_PATH,
    sourceIdentity: "article-source",
    fields: { title: { property: "title", required: true }, language: { property: "language" } },
    headings: [],
    semanticCriteria: [],
  },
] as const;

async function bytes(root: string, relative: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(root, relative)));
}

/** Answers questions until the interview is ready to commit. */
async function runInterview(vault: string, answer: unknown = { disposition: "confirm", raw: "yes" }): Promise<{ readonly censusDigest: string; readonly expectedLedgerDigest: string | null }> {
  let state = await nextTemplateInterview(target(vault), { proposals: PROPOSALS as never });
  let guard = 0;
  while (state.state === "question") {
    if (guard++ > 24) throw new Error("the interview did not converge");
    const question = state.next as { readonly questionId: string };
    state = await answerTemplateInterview(target(vault), {
      questionId: question.questionId,
      answer,
      censusDigest: state.censusDigest,
      expectedLedgerDigest: state.expectedLedgerDigest,
      proposals: PROPOSALS as never,
    }) as typeof state;
  }
  if (state.state === "blocked") {
    throw new Error(`interview blocked: ${JSON.stringify(state.diagnostics)}`);
  }
  return { censusDigest: state.censusDigest, expectedLedgerDigest: state.expectedLedgerDigest };
}

describe("contract review end to end", () => {
  it("asks one question at a time from the user's declared folder", async () => {
    const root = await fixture();

    const first = await nextTemplateInterview(target(root), { proposals: PROPOSALS as never });

    expect(first.state).toBe("question");
    const question = first.next as { readonly questionId: string };
    expect(question.questionId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.censusDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Asking is read-only: the raw source keeps its exact bytes, BOM and all.
    expect(await bytes(root, SOURCE_PATH)).toEqual(RAW_SOURCE);
  });

  it("refuses a stale or forged answer without mutating anything", async () => {
    const root = await fixture();
    const first = await nextTemplateInterview(target(root), { proposals: PROPOSALS as never });
    const question = (first.next as { readonly questionId: string }).questionId;
    const before = await bytes(root, ".oms/template-policy.json");

    await expect(answerTemplateInterview(target(root), {
      questionId: question,
      answer: { disposition: "confirm", raw: "yes" },
      censusDigest: digestBytes("not the census"),
      expectedLedgerDigest: first.expectedLedgerDigest,
      proposals: PROPOSALS as never,
    })).rejects.toThrow(/TEMPLATE_INTERVIEW_STALE|TEMPLATE_INTERVIEW_INVALID/u);

    await expect(answerTemplateInterview(target(root), {
      questionId: question,
      answer: { disposition: "confirm", raw: "yes" },
      censusDigest: first.censusDigest,
      expectedLedgerDigest: digestBytes("not the ledger"),
      proposals: PROPOSALS as never,
    })).rejects.toThrow(/TEMPLATE_INTERVIEW_STALE|TEMPLATE_INTERVIEW_INVALID/u);

    expect(await bytes(root, ".oms/template-policy.json")).toEqual(before);
  });

  it("shares one approval digest between the dry run and the applied publication", async () => {
    const root = await fixture();
    const ready = await runInterview(root);
    const policyBefore = await bytes(root, ".oms/template-policy.json");

    const planned = await commitTemplateContracts(target(root), { ...ready, dryRun: true, proposals: PROPOSALS as never });
    expect(planned.status).toBe("planned");
    const approvalDigest = (planned as { readonly approvalDigest: string }).approvalDigest;
    expect(approvalDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // A dry run publishes nothing.
    expect(await bytes(root, ".oms/template-policy.json")).toEqual(policyBefore);

    const applied = await commitTemplateContracts(target(root), { ...ready, approvedDigest: approvalDigest, proposals: PROPOSALS as never });
    expect(applied.status).toBe("applied");
    expect(await bytes(root, ".oms/template-policy.json")).not.toEqual(policyBefore);
  });

  it("refuses a forged approval digest", async () => {
    const root = await fixture();
    const ready = await runInterview(root);
    const before = await bytes(root, ".oms/template-policy.json");

    const receipt = await commitTemplateContracts(target(root), {
      ...ready,
      approvedDigest: digestBytes("not the approval"),
      proposals: PROPOSALS as never,
    });

    expect(receipt.status).toBe("rejected");
    expect(await bytes(root, ".oms/template-policy.json")).toEqual(before);
  });

  it("refuses to apply when the vault changed between the dry run and the approval", async () => {
    const root = await fixture();
    const ready = await runInterview(root);
    const planned = await commitTemplateContracts(target(root), { ...ready, dryRun: true, proposals: PROPOSALS as never });
    const approvalDigest = (planned as { readonly approvalDigest: string }).approvalDigest;

    // Someone edits a control after the user saw the proposal.
    const tampered = JSON.parse(await readFile(join(root, ".oms", "taxonomy.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(root, ".oms", "taxonomy.json"), JSON.stringify({ ...tampered, folders: { notes: { intent: "Changed." } } }));
    const taxonomyAfterEdit = await bytes(root, ".oms/taxonomy.json");

    // The approval described a vault that no longer exists, so publication is
    // refused loudly rather than applied against changed bytes.
    await expect(commitTemplateContracts(target(root), { ...ready, approvedDigest: approvalDigest, proposals: PROPOSALS as never }))
      .rejects.toThrow(/TEMPLATE_INTERVIEW_STALE|TEMPLATE_INTERVIEW_REVIEW_REQUIRED/u);
    expect(await bytes(root, ".oms/taxonomy.json")).toEqual(taxonomyAfterEdit);
  });

  it("publishes only controls, never a raw source or an ordinary note", async () => {
    const root = await fixture();
    const ready = await runInterview(root);
    const planned = await commitTemplateContracts(target(root), { ...ready, dryRun: true, proposals: PROPOSALS as never });
    const approvalDigest = (planned as { readonly approvalDigest: string }).approvalDigest;

    const applied = await commitTemplateContracts(target(root), { ...ready, approvedDigest: approvalDigest, proposals: PROPOSALS as never });
    expect(applied.status).toBe("applied");

    const outputs = (applied as { readonly outputs?: readonly { readonly finalVaultRelativePath: string }[] }).outputs ?? [];
    expect(outputs.every(output => output.finalVaultRelativePath.startsWith(".oms/"))).toBe(true);
    // The user's own bytes are untouched on both sides.
    expect(await bytes(root, SOURCE_PATH)).toEqual(RAW_SOURCE);
    expect(await bytes(root, "notes/existing.md")).toEqual(EXISTING_NOTE);
  });

  it("makes a published contract visible in the approved snapshot", async () => {
    const root = await fixture();
    const ready = await runInterview(root);
    const planned = await commitTemplateContracts(target(root), { ...ready, dryRun: true, proposals: PROPOSALS as never });
    const approvalDigest = (planned as { readonly approvalDigest: string }).approvalDigest;
    await commitTemplateContracts(target(root), { ...ready, approvedDigest: approvalDigest, proposals: PROPOSALS as never });

    const snapshot = await loadResolvedTemplates(root);
    expect(snapshot.generationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Every published template keeps its raw source identified by digest.
    for (const freshness of snapshot.sources) {
      expect(freshness.source.rawDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it("offers review through a notice that names nothing", async () => {
    const root = await contractFixture();
    const documentPath = join(root, "contract.json");
    await writeFile(documentPath, `${JSON.stringify({
      version: 5,
      revision: 0,
      properties: { title: { type: "text", intent: "Article title." } },
      common: { status: "active", fields: { title: { required: true } } },
      templates: { article: { status: "active", source: { identity: "article-source", path: SOURCE_PATH, rawDigest: digestBytes(RAW_SOURCE) }, fields: {} } },
    }, null, 2)}\n`);
    expect(cli(root, ["template", "publish", "--policy", documentPath, "--transaction-id", PUBLISH_TX, "--yes"]).status).toBe(0);

    expect(await readTemplateChangeNotice(root)).toBeNull();

    // The user edits their own template source outside OMS.
    await writeFile(join(root, SOURCE_PATH), encoder.encode("\ufeff---\r\ntitle: English\r\nlanguage: en\r\n---\r\n# Overview\r\nMore prose.\r\n"));

    const notice = await readTemplateChangeNotice(root);
    expect(notice).toMatchObject({ state: "pending", actions: ["확인하기", "나중에"] });
    expect(JSON.stringify(notice)).not.toContain("article");
    expect(JSON.stringify(notice)).not.toContain("Templates/Review");
  });


  it("publishes and acknowledges through the public CLI without an interview", async () => {
    const root = await contractFixture();
    const document = {
      version: 5,
      revision: 0,
      properties: { title: { type: "text", intent: "Article title." }, language: { type: "select", intent: "Language.", valuePolicy: "closed", allowedValues: ["en", "ko"] } },
      common: { status: "active", fields: { title: { required: true } } },
      templates: {
        article: {
          status: "active",
          source: { identity: "article-source", path: SOURCE_PATH, rawDigest: digestBytes(RAW_SOURCE) },
          fields: { language: { required: true } },
        },
      },
    };
    const documentPath = join(root, "contract.json");
    await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);

    const preview = cli(root, ["template", "publish", "--policy", documentPath, "--transaction-id", PUBLISH_TX]);
    expect(preview.status, `${preview.stdout}\n${preview.stderr}`).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ state: "confirmation-required", plan: { revision: 0, addedTemplates: ["article"] } });

    const applied = cli(root, ["template", "publish", "--policy", documentPath, "--transaction-id", PUBLISH_TX, "--yes"]);
    expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ state: "published", revision: 0, receipt: { status: "complete" } });
    // Publication touches controls only; the user's own source is untouched.
    expect(await bytes(root, SOURCE_PATH)).toEqual(RAW_SOURCE);

    const clean = JSON.parse(cli(root, ["template", "review-sources"]).stdout) as { readonly reviews: readonly { readonly state: string; readonly currentDigest: string }[] };
    expect(clean.reviews.map(item => item.state)).toEqual(["unchanged"]);

    // The user edits their own source outside OMS.
    await writeFile(join(root, SOURCE_PATH), encoder.encode("\ufeff---\r\ntitle: English\r\nlanguage: en\r\n---\r\n# Overview\r\nMore prose.\r\n"));
    const drifted = JSON.parse(cli(root, ["template", "review-sources", "--template-id", "article"]).stdout) as { readonly reviews: readonly { readonly state: string; readonly currentDigest: string }[] };
    expect(drifted.reviews[0]?.state).toBe("drift");

    const acknowledged = cli(root, [
      "template", "acknowledge-source", "--template-id", "article",
      "--reviewed-digest", drifted.reviews[0]!.currentDigest,
      "--transaction-id", ACKNOWLEDGE_TX, "--yes",
    ]);
    expect(acknowledged.status, `${acknowledged.stdout}\n${acknowledged.stderr}`).toBe(0);
    expect(JSON.parse(acknowledged.stdout)).toMatchObject({ state: "published", revision: 1 });
    expect(JSON.parse(cli(root, ["template", "review-sources"]).stdout).reviews[0].state).toBe("unchanged");
  });

  it("refuses the retired interview leaves with no alias", async () => {
    const root = await fixture();
    const before = await bytes(root, ".oms/template-policy.json");
    for (const args of [["template", "review"], ["template", "answer", "x"], ["template", "commit"]]) {
      const refused = cli(root, args);
      expect(refused.status, args.join(" ")).toBe(1);
      expect(JSON.parse(refused.stdout).diagnostics[0].code).toBe("TEMPLATE_ARGS_INVALID");
    }
    expect(await bytes(root, ".oms/template-policy.json")).toEqual(before);
  });

  it("creates no vault state when an interview is only read", async () => {
    const root = await mkdtemp(join(tmpdir(), "oms-template-contract-review-bare-"));
    roots.push(root);
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "one.md"), "Plain note.\n");

    await expect(nextTemplateInterview(target(root))).resolves.toMatchObject({ state: expect.any(String) });

    expect(await readdir(root)).toEqual(["notes"]);
  });
});

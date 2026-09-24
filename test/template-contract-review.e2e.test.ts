import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../src/kernel/templates/canonical.js";
import { serializeVaultSettings } from "../src/kernel/templates/vault-settings.js";
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

async function bytes(root: string, relative: string): Promise<Uint8Array> {
  return Uint8Array.from(await readFile(join(root, relative)));
}

/**
 * Explicit contract meaning, supplied by the caller. OMS never derives a field,
 * heading, or template id by reading the source file's name or syntax.
 */
describe("explicit contract publication end to end", () => {
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
    const root = await contractFixture();
    const before = await readdir(join(root, ".oms"));
    for (const args of [["template", "review"], ["template", "answer", "x"], ["template", "commit"], ["template", "regenerate-types", "--dry-run"]]) {
      const refused = cli(root, args);
      expect(refused.status, args.join(" ")).toBe(1);
      expect(JSON.parse(refused.stdout).diagnostics[0].code).toBe("TEMPLATE_ARGS_INVALID");
    }
    // A refused leaf publishes nothing at all.
    expect(await readdir(join(root, ".oms"))).toEqual(before);
  });

});

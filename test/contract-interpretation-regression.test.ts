import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digestBytes } from "../src/kernel/conventions/canonical.js";
import { enumerateTemplateSources, resolveInterpretations, type TemplateInterpretation } from "../src/kernel/contract/interpretation.js";
import { rekeySealedTemplates, runInterview } from "../src/kernel/contract/interview.js";
import { scriptedIO, type Answers } from "../src/kernel/contract/scripted-interview.js";
import { readStore, sealContract } from "../src/kernel/contract/store.js";
import type { TemplateContract, VaultContract } from "../src/kernel/contract/types.js";
import { serializeVaultSettings, SETTINGS_PATH } from "../src/kernel/vault/settings.js";

/**
 * The templates that made deterministic pre-analysis untenable, as fixtures.
 *
 * These are copies of real templates, not reads of a vault: every body here is a literal
 * in this file. The first four put a variable in a structural position, so no textual
 * substitution leaves parseable YAML. The fifth is worse: it is a Templater JavaScript
 * block with no frontmatter at all, which the retired parser accepted silently as
 * `fields: [] headings: []` while the template really declares ten properties and four
 * headings. A parser that cannot tell "nothing declared" from "unreadable" cannot be the
 * input to a contract, which is the whole reason the interpretation is submitted.
 */

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

/** `from:{{from_links}}` — no space after the colon, so the variable is part of the key. */
const MAIL = [
  "---",
  "aliases: []",
  "type: mail",
  "subject: {{subject_yaml}}",
  "from:{{from_links}}",
  "to:{{to_links}}",
  "participants:{{participants}}",
  "---",
  "",
  "# {{subject}}",
  "",
  "## Body",
  "",
].join("\n");

const MAIL_THREAD = [
  "---",
  "type: mail-thread",
  "subject: {{subject_yaml}}",
  "participants:{{participants}}",
  "---",
  "",
  "## Messages",
  "",
].join("\n");

/** The variable sits at column zero inside a block mapping value, between two comments. */
const MEETING = [
  "---",
  "type: meeting",
  "date_meet: {{date_meet}}",
  "participants:",
  "  # meeting-transcript:participants:start",
  "{{participants_yaml}}",
  "  # meeting-transcript:participants:end",
  "---",
  "## Thinking",
  "",
  "## Discussed",
  "",
].join("\n");

/** Templater JavaScript, no frontmatter: the retired parser read it as declaring nothing. */
const MANUAL_MEETING = [
  "<%*",
  "const title = await tp.system.prompt(\"Title\");",
  "const project = await tp.system.prompt(\"Project\");",
  "tR += `---\\ntype: meeting\\ntitle: ${title}\\n---`;",
  "%>",
  "## Thinking",
  "",
  "## Discussed",
  "",
  "## Decisions",
  "",
  "## Actions",
  "",
].join("\n");

let base: string;
let vault: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-interpretation-regression-")));
  vault = join(base, "vault");
  root = join(base, "home", ".oms", "vaults");
  await mkdir(join(vault, "Templates", "agent"), { recursive: true });
  await mkdir(join(vault, "Templates", "manual"));
  await mkdir(join(vault, ".oms"));
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID, templateFolder: "Templates" }));
  await writeFile(join(vault, "Templates/agent/mail.template.md"), MAIL);
  await writeFile(join(vault, "Templates/agent/mail-thread.template.md"), MAIL_THREAD);
  await writeFile(join(vault, "Templates/agent/meeting.template.md"), MEETING);
  await writeFile(join(vault, "Templates/manual/meeting.template.md"), MANUAL_MEETING);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** What the agent submits, with the hash OMS computed for each source. */
function interpretations(): readonly TemplateInterpretation[] {
  return [
    {
      source: "Templates/agent/mail.template.md",
      observedHash: digestBytes(MAIL),
      fields: [
        { name: "aliases", inferredType: "aliases", literal: [], variable: null },
        { name: "type", inferredType: "text", literal: "mail", variable: null },
        { name: "subject", inferredType: "text", literal: null, variable: "free" },
        { name: "from", inferredType: "multitext", literal: null, variable: "free" },
        { name: "to", inferredType: "multitext", literal: null, variable: "free" },
        { name: "participants", inferredType: "multitext", literal: null, variable: "free" },
      ],
      headings: [{ title: "Body", level: 2, variable: false }],
    },
    {
      source: "Templates/agent/mail-thread.template.md",
      observedHash: digestBytes(MAIL_THREAD),
      fields: [
        { name: "type", inferredType: "text", literal: "mail-thread", variable: null },
        { name: "subject", inferredType: "text", literal: null, variable: "free" },
        { name: "participants", inferredType: "multitext", literal: null, variable: "free" },
      ],
      headings: [{ title: "Messages", level: 2, variable: false }],
    },
    {
      source: "Templates/agent/meeting.template.md",
      observedHash: digestBytes(MEETING),
      fields: [
        { name: "type", inferredType: "text", literal: "meeting", variable: null },
        { name: "date_meet", inferredType: "date", literal: null, variable: "date" },
        { name: "participants", inferredType: "multitext", literal: null, variable: "free" },
      ],
      headings: [{ title: "Thinking", level: 2, variable: false }, { title: "Discussed", level: 2, variable: false }],
    },
    {
      source: "Templates/manual/meeting.template.md",
      observedHash: digestBytes(MANUAL_MEETING),
      // The ten properties and four headings the JS block really produces. No parser
      // reading this file's text could report them; the agent that read the JS can.
      fields: [
        { name: "type", inferredType: "text", literal: "meeting", variable: null },
        { name: "title", inferredType: "text", literal: null, variable: "title" },
        { name: "index", inferredType: "multitext", literal: null, variable: "free" },
        { name: "aliases", inferredType: "aliases", literal: [], variable: null },
        { name: "date_created", inferredType: "datetime", literal: null, variable: "datetime" },
        { name: "date_modified", inferredType: "datetime", literal: null, variable: "datetime" },
        { name: "created_by", inferredType: "text", literal: null, variable: "free" },
        { name: "authorship", inferredType: "text", literal: "mixed", variable: null },
        { name: "up", inferredType: "multitext", literal: null, variable: "free" },
        { name: "source_media", inferredType: "text", literal: null, variable: "free" },
      ],
      headings: [
        { title: "Thinking", level: 2, variable: false },
        { title: "Discussed", level: 2, variable: false },
        { title: "Decisions", level: 2, variable: false },
        { title: "Actions", level: 2, variable: false },
      ],
    },
  ];
}

async function sources() {
  const enumerated = await enumerateTemplateSources(vault, { path: "Templates", kind: "folder" });
  if (!enumerated.ok) throw new Error(enumerated.diagnostics.map(item => item.code).join(", "));
  return enumerated.sources;
}

describe("templates no parser could read", () => {
  it("are enumerated with a digest each, and OMS reports nothing about their content", async () => {
    const found = await sources();
    expect(found.map(source => source.path)).toEqual([
      "Templates/agent/mail-thread.template.md",
      "Templates/agent/mail.template.md",
      "Templates/agent/meeting.template.md",
      "Templates/manual/meeting.template.md",
    ]);
    // Enumeration reads bytes to hash them and reports no field, heading or value.
    expect(JSON.stringify(found)).not.toMatch(/participants|Thinking|subject/);
  });

  it("resolve to templates scoped by folder, so the two meetings do not collide", async () => {
    const resolved = resolveInterpretations("Templates", await sources(), interpretations());
    if (!resolved.ok) throw new Error(resolved.reasons.join("\n"));
    expect(resolved.templates.map(template => template.name)).toEqual([
      "agent__mail-thread.template",
      "agent__mail.template",
      "agent__meeting.template",
      "manual__meeting.template",
    ]);
  });

  it("carry every field and heading the retired parser lost, and seal them from the owner's answers", async () => {
    const answers: Answers = {
      "folder:Templates:register": false,
      "template:manual__meeting.template:interpretation": true,
      "template:manual__meeting.template:register": true,
      "template:manual__meeting.template:heading:Actions": true,
      "template:manual__meeting.template:apply-folder": "",
    };
    // Every other question is declined, so only the JS template's answers reach the contract.
    for (const name of ["agent__mail-thread.template", "agent__mail.template", "agent__meeting.template"]) {
      answers[`template:${name}:interpretation`] = true;
      answers[`template:${name}:register`] = false;
    }
    for (const field of interpretations()[3]!.fields) {
      answers[`template:manual__meeting.template:field:${field.name}:required`] = field.variable === null;
      if (field.variable === null && field.literal !== null && !Array.isArray(field.literal)) {
        answers[`template:manual__meeting.template:field:${field.name}:literal`] = "example-only";
      }
    }
    for (const heading of ["Thinking", "Discussed", "Decisions"]) answers[`template:manual__meeting.template:heading:${heading}`] = false;
    for (const property of ["type", "title", "index", "aliases", "date_created", "date_modified", "created_by", "authorship", "up", "source_media", "date_meet", "subject", "from", "to", "participants"]) {
      answers[`property:${property}:register`] = false;
    }
    answers["seal"] = true;

    const { io } = scriptedIO(answers);
    const result = await runInterview({ vault, io, root, nonLoosening: true, interpretations: interpretations() });
    expect(result).toMatchObject({ state: "sealed", templates: ["manual__meeting.template"] });
    const store = await readStore(VAULT_ID, root);
    if (store.state !== "ok") throw new Error(store.state);
    const sealed = store.contract.templates["manual__meeting.template"];
    // All ten properties were asked about; the three with no variable are the required ones.
    expect(sealed?.requiredProperties).toEqual(["type", "aliases", "authorship"]);
    expect(sealed?.requiredHeadings).toEqual(["Actions"]);
  });
});

describe("condition 1 — the hash OMS computed is the only one it trusts", () => {
  it("refuses an interpretation whose observedHash is not the source's digest", async () => {
    const forged = interpretations().map((entry, index) => index === 0 ? { ...entry, observedHash: digestBytes("other bytes") } : entry);
    expect(resolveInterpretations("Templates", await sources(), forged)).toMatchObject({
      ok: false,
      reasons: [expect.stringContaining("read from different bytes")],
    });
  });

  it("stores its own digest, so a submission can never report a changed template as unchanged", async () => {
    const found = await sources();
    const resolved = resolveInterpretations("Templates", found, interpretations());
    if (!resolved.ok) throw new Error(resolved.reasons.join("\n"));
    for (const template of resolved.templates) {
      expect(template.sourceHash).toBe(found.find(source => source.path === template.source)?.digest);
      expect(template.sourceHash).toBe(digestBytes(await readFile(join(vault, template.source), "utf8")));
    }
  });
});

describe("condition 2 — scope arrives with the rekey migration", () => {
  const sealedTemplate = (source: string): TemplateContract => ({
    source,
    sourceHash: digestBytes("whatever"),
    requiredProperties: [],
    narrowedRules: {},
    requiredHeadings: [],
  });

  it("rekeys a contract sealed under bare file names, so nothing reads as removed", () => {
    const templates = {
      "mail.template": sealedTemplate("Templates/agent/mail.template.md"),
      "meeting.template": sealedTemplate("Templates/agent/meeting.template.md"),
    };
    expect(Object.keys(rekeySealedTemplates(templates, "Templates"))).toEqual([
      "agent__mail.template",
      "agent__meeting.template",
    ]);
  });

  it("lets a vault sealed under the old keys reseal without a terminal", async () => {
    const bare: VaultContract = {
      version: 1,
      vaultId: VAULT_ID,
      folders: {},
      properties: {},
      templates: { "meeting.template": sealedTemplate("Templates/agent/meeting.template.md") },
    };
    await sealContract({ vaultRealPath: vault, vaultId: VAULT_ID, contract: bare }, root);
    // The sealed template declared nothing required, so answering the same way reseals it.
    const answers: Answers = { seal: true };
    for (const entry of interpretations()) {
      const name = entry.source.replace(/^Templates\//, "").replace(/\.md$/, "").replace("/", "__");
      answers[`template:${name}:interpretation`] = true;
      // Only the previously sealed template is registered; a declined one is asked nothing else.
      const register = name === "agent__meeting.template";
      answers[`template:${name}:register`] = register;
      if (!register) continue;
      answers[`template:${name}:apply-folder`] = "";
      for (const field of entry.fields) {
        answers[`template:${name}:field:${field.name}:required`] = false;
        if (field.variable === null && field.literal !== null && !Array.isArray(field.literal)) answers[`template:${name}:field:${field.name}:literal`] = "example-only";
      }
      for (const heading of entry.headings) answers[`template:${name}:heading:${heading.title}`] = false;
    }
    for (const property of ["type", "title", "index", "aliases", "date_created", "date_modified", "created_by", "authorship", "up", "source_media", "date_meet", "subject", "from", "to", "participants"]) {
      answers[`property:${property}:register`] = false;
    }
    answers["folder:Templates:register"] = false;
    const { io } = scriptedIO(answers);
    const result = await runInterview({ vault, io, root, nonLoosening: true, interpretations: interpretations() });
    // Without the rekey this would be `loosening` with `templates.meeting.template removed`.
    if (result.state === "incomplete") throw new Error(result.questions.map(question => question.id).join("\n"));
    expect(result).toMatchObject({ state: "sealed" });
    const store = await readStore(VAULT_ID, root);
    if (store.state !== "ok") throw new Error(store.state);
    expect(Object.keys(store.contract.templates)).toEqual(["agent__meeting.template"]);
  });
});

describe("condition 4 — interpretation is a seal-time cost", () => {
  it("keeps every interpretation module out of the write-checking judge's imports", async () => {
    // A 22,000-note vault cannot afford an interpretation per note write, so the judge
    // must not reach the interpretation modules even transitively.
    const seen = new Set<string>();
    const queue = ["src/kernel/contract/judge.ts", "src/kernel/contract/judge-write.ts"];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = await readFile(join(import.meta.dirname, "..", file), "utf8");
      for (const match of text.matchAll(/from "(\.[^"]+)\.js"/g)) {
        const target = join(file, "..", `${match[1]!}.ts`);
        expect(target).not.toMatch(/interpretation/);
        queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

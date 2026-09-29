import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digestBytes } from "../src/kernel/conventions/canonical.js";
import { enumerateTemplateSources, resolveInterpretations, scopedTemplateName, type TemplateInterpretation } from "../src/kernel/contract/interpretation.js";
import { rekeySealedTemplates, runInterview, type InterviewIO } from "../src/kernel/contract/interview.js";
import { scriptedIO, type Answers } from "../src/kernel/contract/scripted-interview.js";
import { bootstrapSnapshots, isSafeName, readStore } from "../src/kernel/contract/store.js";
import { sealLegacyGeneration } from "../src/kernel/contract/legacy-store-fixture.js";
import type { LegacyTemplateContract, VaultContract } from "../src/kernel/contract/types.js";
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

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const JUDGE = join(SOURCE_ROOT, "kernel/contract/judge.ts");
const JUDGE_ENTRIES = [JUDGE, join(SOURCE_ROOT, "kernel/contract/judge-write.ts")];

/**
 * Every relative module an emitted file still loads at runtime, read from the TypeScript
 * AST rather than a regex: a static import, a side-effect import, `export ... from`, and a
 * dynamic `import()` with a literal specifier all survive emit and are followed. A
 * type-only import is erased, so it is not an edge.
 */
function runtimeEdges(source: ts.SourceFile): string[] {
  const edges: string[] = [];
  const specifier = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isStringLiteral(node) && node.text.startsWith(".")) edges.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true) specifier(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly) specifier(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return edges;
}

/** The transitive closure of `runtimeEdges` over the source tree, as absolute `.ts` paths. */
async function reachableFrom(entries: readonly string[]): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    for (const edge of runtimeEdges(source)) {
      const base = join(file, "..", edge.replace(/\.js$/, ""));
      const candidates = [`${base}.ts`, join(base, "index.ts")];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return seen;
}

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

/** Answers that seal only the JS template and decline everything else. */
function sealAnswers(): Answers {
  const answers: Record<string, string | number | boolean> = {
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
  return answers;
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
    const { io, notes } = scriptedIO(sealAnswers());
    const result = await runInterview({ vault, io, root, nonLoosening: true, interpretations: interpretations() });
    // slice f2: move to templateFolder — the answers are reported as not stored.
    expect(result).toMatchObject({ state: "sealed", templates: [], warnings: ["CONTRACT_TEMPLATES_NOT_STORED: template answers are not stored until templates move to templateFolder"] });
    // All ten properties were asked about; the three with no variable are the required ones.
    expect(notes).toContain("  template manual__meeting.template: properties [type, aliases, authorship], headings [Actions]");
    // A version 3 seal stores the answers nowhere; only folders and properties persist.
    const store = await readStore(VAULT_ID, root);
    if (store.state !== "ok") throw new Error(store.state);
    expect(Object.hasOwn(store.contract, "templates")).toBe(false);
  });

  it("refuse to seal when a template source changes after the owner answered, and leave nothing behind", async () => {
    // The interpretation was read and confirmed from bytes that no longer exist by the
    // time the seal commits. Detecting it as drift afterwards is too late: the contract
    // would already be sealed narrower than the vault.
    const { io } = scriptedIO(sealAnswers());
    const mutating: InterviewIO = {
      say: io.say,
      ask: async question => {
        if (question.id === "seal") await writeFile(join(vault, "Templates/manual/meeting.template.md"), `${MANUAL_MEETING}\nsecret_added: injected\n`);
        return io.ask(question);
      },
    };
    const result = await runInterview({ vault, io: mutating, root, nonLoosening: true, interpretations: interpretations() });
    expect(result).toMatchObject({ state: "refused", reasons: [expect.stringContaining("changed during the interview")] });
    expect((await readStore(VAULT_ID, root)).state).not.toBe("ok");
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
  const sealedTemplate = (source: string): LegacyTemplateContract => ({
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

  it("gives separator-bearing components distinct names, so a valid layout is sealable", () => {
    // `a__b/meeting` and `a/b/meeting` both joined to `a__b__meeting` before the escape,
    // and `resolveInterpretations` then refused the vault for a duplicate name.
    expect(scopedTemplateName("T", "T/a/b/meeting.md")).not.toBe(scopedTemplateName("T", "T/a__b/meeting.md"));
    expect(scopedTemplateName("T", "T/meeting.md")).toBe("meeting");
    expect(scopedTemplateName("T", "T/a/b/c/meeting.md")).toBe("a__b__c__meeting");
    expect(scopedTemplateName("T", "T/a_b/meeting.md")).toBe("a_-b__meeting");
    // Injective across a deliberately hostile set: no two paths share a name.
    const hostile = ["a/b/m.md", "a__b/m.md", "a_/b/m.md", "a/_b/m.md", "a_-b/m.md", "a/b_/m.md", "a__b__m.md", "m.md"];
    const names = hostile.map(path => scopedTemplateName("T", `T/${path}`));
    expect(new Set(names).size).toBe(hostile.length);
    for (const name of names) expect(isSafeName(name)).toBe(true);
  });

  it("rekeys with the same encoding, and a second rekey changes nothing", () => {
    const templates = {
      "m.template": sealedTemplate("Templates/a__b/m.template.md"),
      "other.template": sealedTemplate("Templates/a/b/m.template.md"),
    };
    const once = rekeySealedTemplates(templates, "Templates");
    expect(Object.keys(once)).toEqual(["a_-_-b__m.template", "a__b__m.template"]);
    // Idempotent: a rekeyed key re-derives to itself, so a second run is a no-op.
    expect(rekeySealedTemplates(once, "Templates")).toEqual(once);
  });

  it("lets a vault sealed under the old keys reseal without a terminal", async () => {
    const bare: VaultContract = { folders: {}, properties: {} };
    // Old keys only ever lived in a version 1 or 2 generation, which stored templates.
    await sealLegacyGeneration({
      vaultRealPath: vault,
      vaultId: VAULT_ID,
      contract: bare,
      templates: { "meeting.template": sealedTemplate("Templates/agent/meeting.template.md") },
    }, root);
    await bootstrapSnapshots(root, VAULT_ID);
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
    expect(result).toMatchObject({
      state: "sealed",
      templates: [],
      warnings: [expect.stringMatching(/^CONTRACT_LEGACY_TEMPLATES_DROPPED: \d+ legacy templates/), "CONTRACT_TEMPLATES_NOT_STORED: template answers are not stored until templates move to templateFolder"],
    });
    const store = await readStore(VAULT_ID, root);
    if (store.state !== "ok") throw new Error(store.state);
    // The reseal is forward-only: a new version 3 head with the legacy templates dropped.
    expect(Object.hasOwn(store.contract, "templates")).toBe(false);
    expect(store.legacy).toBeUndefined();
  });
});

describe("condition 4 — interpretation is a seal-time cost", () => {
  it("keeps every interpretation module out of the write-checking judge's imports", async () => {
    // A 22,000-note vault cannot afford an interpretation per note write, so the judge
    // must not reach the interpretation modules even transitively.
    const reached = await reachableFrom(JUDGE_ENTRIES);
    for (const file of reached) expect(file).not.toMatch(/interpretation/);
    expect(reached.size).toBeGreaterThan(2);
  });

  it("fails on a direct, a re-exported and a dynamic edge, so it can actually catch one", async () => {
    // Negative controls: a test that cannot be broken is not evidence. Each mutation adds
    // one edge shape the walker must follow, and each must make the gate above fail.
    const barrel = join(SOURCE_ROOT, "kernel/contract/interpretation-barrel.ts");
    const probe = join(SOURCE_ROOT, "kernel/contract/interpretation-probe.ts");
    const edges = [
      { name: "static", extra: [], line: 'import "./interpretation.js";' },
      { name: "re-export", extra: [[barrel, 'export { SCOPE_SEPARATOR } from "./interpretation.js";\n']], line: 'import "./interpretation-barrel.js";' },
      { name: "dynamic", extra: [[probe, 'export const load = () => import("./interpretation.js");\n']], line: 'import "./interpretation-probe.js";' },
    ] as const;
    for (const edge of edges) {
      const original = await readFile(JUDGE, "utf8");
      try {
        for (const [path, body] of edge.extra) await writeFile(path, body);
        await writeFile(JUDGE, `${edge.line}\n${original}`);
        const reached = await reachableFrom(JUDGE_ENTRIES);
        expect([edge.name, [...reached].some(file => /interpretation/.test(file))]).toEqual([edge.name, true]);
      } finally {
        await writeFile(JUDGE, original);
        for (const [path] of edge.extra) await rm(path, { force: true });
      }
    }
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { templateDrift } from "./drift.js";
import { draftDescription, InterviewAborted, runInterview, sealGuard, type InterviewIO, type Question } from "./interview.js";
import { PUBLIC_MANIFEST_PATH, readPublicManifest } from "./public.js";
import { loadLayers } from "./store.js";
import type { SealedLayer } from "./types.js";
import { VAULT_ID_PATH, readVaultId } from "./vault-id.js";

const roots: string[] = [];
const previousRoot = process.env["OMS_CONTRACT_STORE_ROOT"];
let store: string;
let vault: string;

beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), "oms-contract-interview-store-"));
  vault = await mkdtemp(join(tmpdir(), "oms-contract-interview-vault-"));
  roots.push(store, vault);
  process.env["OMS_CONTRACT_STORE_ROOT"] = join(store, "vaults");
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env["OMS_CONTRACT_STORE_ROOT"];
  else process.env["OMS_CONTRACT_STORE_ROOT"] = previousRoot;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function put(rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(vault, rel)), { recursive: true });
  await writeFile(join(vault, rel), content);
}

type Script = Record<string, string | string[]>;

/** Answers by question id; unscripted questions take the default (initial text, yes, first option). */
function scripted(script: Script = {}): InterviewIO & { readonly asked: string[]; readonly said: string[]; readonly questions: Question[] } {
  const queues = new Map(Object.entries(script).map(([id, answer]) => [id, Array.isArray(answer) ? [...answer] : [answer]]));
  const asked: string[] = [];
  const said: string[] = [];
  const questions: Question[] = [];
  return {
    asked,
    said,
    questions,
    async ask(question) {
      asked.push(question.id);
      questions.push(question);
      const queue = queues.get(question.id);
      if (queue !== undefined && queue.length > 0) return queue.length === 1 ? queue[0]! : queue.shift()!;
      if (question.kind === "confirm") return question.id.startsWith("common:add:") ? "n" : "y";
      if (question.kind === "choice") return "1";
      return "";
    },
    say(line) {
      said.push(line);
    },
  };
}

const MEETING = [
  "---",
  "created: \"{{date}}\"",
  "run: \"<% tp.file.title %>\"",
  "status: open",
  "kind: standup",
  "score: 3",
  "code: ABC",
  "aliases: []",
  "---",
  "# {{title}}",
  "## Agenda",
  "## Notes",
  "",
].join("\n");

const MEETING_ANSWERS: Script = {
  "field:status:literal": "one-of-allowed",
  "field:status:allowed": "open, closed",
  "field:kind:literal": "must-equal",
  "field:score:literal": "example-only",
  "field:score:rule": "range",
  "field:score:range-min": "1",
  "field:score:range-max": "5",
  "field:code:literal": "3",
  "field:code:rule": "pattern",
  "field:code:pattern": "[A-Z]{3}",
  "field:aliases:required": "n",
  "heading:Notes": "n",
  "apply-folder": "./Meetings/",
};

async function sealedLayers(): Promise<{ id: string; layers: Awaited<ReturnType<typeof loadLayers>> }> {
  const id = await readVaultId(vault);
  const manifest = await readPublicManifest(vault);
  if (id.state !== "ok" || manifest.state !== "ok") throw new Error("contract not sealed");
  return { id: id.id, layers: await loadLayers(id.id, manifest.manifest) };
}

describe("draftDescription", () => {
  it("names the rule kind but never a value", () => {
    expect(draftDescription("status", "text", true, [{ kind: "allowed", values: ["open"] }], null)).toBe("`status` must be one of the defined values. Required.");
    expect(draftDescription("kind", "text", false, [{ kind: "fixed", value: "x" }], null)).toBe("`kind` must have its defined value.");
    expect(draftDescription("code", "text", false, [{ kind: "pattern", regex: "x" }], null)).toBe("`code` must match its defined format.");
    expect(draftDescription("score", "number", false, [{ kind: "range", min: 1 }], null)).toBe("`score` must be within its defined range.");
    expect(draftDescription("run", "text", false, [], "free")).toBe("`run` is a free value filled by the agent.");
    expect(draftDescription("created", "date", false, [], "date")).toBe("`created` is a date value filled by the agent.");
    expect(draftDescription("note", "text", false, [], null)).toBe("`note` is a text value.");
  });
});

describe("runInterview: template", () => {
  it("seals must-equal, one-of-allowed and example-only answers into the private store only", async () => {
    await put("Templates/Meeting.md", MEETING);
    const io = scripted(MEETING_ANSWERS);
    const result = await runInterview({ vault, target: { kind: "template", sourcePath: "./Templates/Meeting.md" }, io });
    expect(result.state).toBe("sealed");
    if (result.state !== "sealed") return;
    expect(result.vaultIdCreated).toBe(true);
    expect(result.publicTemplate).toMatchObject({ id: "Templates/Meeting.md", name: "Meeting", applyFolder: "Meetings", requiredHeadings: ["Agenda"] });
    expect(io.asked).not.toContain("field:created:literal");
    expect(io.asked).toContain("field:run:free");
    expect(io.asked).not.toContain("field:aliases:rule");

    const { id, layers } = await sealedLayers();
    expect(id).toBe(result.vaultId);
    const loaded = layers.templates.get("Templates/Meeting.md");
    expect(loaded?.state).toBe("ok");
    if (loaded?.state !== "ok") return;
    const rules = Object.fromEntries(loaded.layer.fields.map(field => [field.name, field.rules]));
    expect(rules["status"]).toEqual([{ kind: "allowed", values: ["open", "closed"] }]);
    expect(rules["kind"]).toEqual([{ kind: "fixed", value: "standup" }]);
    expect(rules["score"]).toEqual([{ kind: "range", min: 1, max: 5 }]);
    expect(rules["code"]).toEqual([{ kind: "pattern", regex: "[A-Z]{3}" }]);
    expect(rules["run"]).toEqual([]);
    expect(loaded.layer.fields.find(field => field.name === "run")?.variable).toBe("free");
    expect(loaded.layer.fields.find(field => field.name === "aliases")?.required).toBe(false);

    const manifestText = await readFile(join(vault, PUBLIC_MANIFEST_PATH), "utf8");
    const vaultIdText = await readFile(join(vault, VAULT_ID_PATH), "utf8");
    for (const hidden of ["closed", "standup", "[A-Z]{3}", "ABC"]) {
      expect(manifestText).not.toContain(hidden);
      expect(vaultIdText).not.toContain(hidden);
    }
    const layerFile = join(store, "vaults", id, "layers", `${loaded.layer.sealId}.json`);
    expect((await stat(layerFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(store, "vaults", id))).mode & 0o777).toBe(0o700);
    expect(await templateDrift(vault, result.publicTemplate!)).toBe("active");
  });

  it("refuses to seal a description that carries a hidden value and writes nothing", async () => {
    await put("Templates/Meeting.md", MEETING);
    const io = scripted({ ...MEETING_ANSWERS, "field:status:description": "Status is open or closed." });
    const result = await runInterview({ vault, target: { kind: "template", sourcePath: "Templates/Meeting.md" }, io });
    expect(result.state).toBe("refused");
    if (result.state !== "refused") return;
    expect(result.reasons).toEqual(["The description of `status` contains a hidden value; rewrite it without the value."]);
    expect(result.reasons.join(" ")).not.toContain("closed");
    expect(io.asked).not.toContain("seal");
    expect(await readdir(store)).toEqual([]);
    expect((await readVaultId(vault)).state).toBe("absent");
    expect((await readPublicManifest(vault)).state).toBe("absent");
  });

  it("aborts without writing when the seal is declined or the IO gives up", async () => {
    await put("Templates/Meeting.md", MEETING);
    expect(await runInterview({ vault, target: { kind: "template", sourcePath: "Templates/Meeting.md" }, io: scripted({ ...MEETING_ANSWERS, seal: "n" }) }))
      .toEqual({ state: "aborted" });
    const closing: InterviewIO = { ask: async () => { throw new InterviewAborted(); }, say: () => undefined };
    expect(await runInterview({ vault, target: { kind: "template", sourcePath: "Templates/Meeting.md" }, io: closing })).toEqual({ state: "aborted" });
    expect(await readdir(store)).toEqual([]);
    expect((await readPublicManifest(vault)).state).toBe("absent");
  });

  it("asks again after an invalid answer and aborts after three", async () => {
    await put("T.md", "---\nscore: 3\n---\n");
    const retried = scripted({ "field:score:type": ["numeric", "number"], "field:score:literal": ["maybe", "2"], "field:score:allowed": "1, 2, 3", "apply-folder": "" });
    const result = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io: retried });
    expect(result.state).toBe("sealed");
    expect(retried.said.some(line => line.includes("Use one of:"))).toBe(true);
    const { layers } = await sealedLayers();
    const loaded = layers.templates.get("T.md");
    expect(loaded?.state === "ok" && loaded.layer.fields[0]?.rules).toEqual([{ kind: "allowed", values: [1, 2, 3] }]);

    await put("U.md", "---\nscore: 3\n---\n");
    const stubborn = scripted({ "field:score:type": "numeric" });
    expect(await runInterview({ vault, target: { kind: "template", sourcePath: "U.md" }, io: stubborn })).toEqual({ state: "aborted" });
    expect(stubborn.asked.filter(id => id === "field:score:type")).toHaveLength(3);
  });

  it("rejects an apply folder that leaves the vault", async () => {
    await put("T.md", "---\nnote: x\n---\n");
    const io = scripted({ "field:note:literal": "example-only", "field:note:rule": "none", "apply-folder": ["../out", "Notes"] });
    const result = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io });
    expect(result.state === "sealed" && result.publicTemplate?.applyFolder).toBe("Notes");
    expect(io.said.some(line => line.includes("without `..`"))).toBe(true);
  });

  it("lets the user decline a free value and reports a missing template", async () => {
    await put("T.md", "---\nrun: \"<% tp.file.title %>\"\n---\n");
    const io = scripted({ "field:run:free": "n", "field:run:rule": "none" });
    const result = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io });
    expect(result.state).toBe("sealed");
    const { layers } = await sealedLayers();
    const loaded = layers.templates.get("T.md");
    expect(loaded?.state === "ok" && loaded.layer.fields[0]?.variable).toBeNull();

    const missing = await runInterview({ vault, target: { kind: "template", sourcePath: "None.md" }, io: scripted() });
    expect(missing.state === "refused" && missing.reasons[0]).toMatch(/^TEMPLATE_SOURCE_MISSING/);
  });

  it("re-interviews a drifted template, asks only what changed and replaces the old seal", async () => {
    await put("Templates/Meeting.md", MEETING);
    const first = await runInterview({ vault, target: { kind: "template", sourcePath: "Templates/Meeting.md" }, io: scripted(MEETING_ANSWERS) });
    if (first.state !== "sealed") throw new Error("first seal failed");
    const oldSeal = first.publicTemplate!.sealId;

    await put("Templates/Meeting.md", MEETING.replace("status: open", "status: draft").replace("code: ABC\n", "owner: me\n").replace("## Notes", "## Notes\n## Actions"));
    expect(await templateDrift(vault, first.publicTemplate!)).toBe("drift");

    const io = scripted({ "field:status:literal": "one-of-allowed", "field:status:allowed": "draft, open, closed", "field:owner:literal": "example-only", "field:owner:rule": "none", "heading:Actions": "n" });
    const second = await runInterview({ vault, target: { kind: "template", sourcePath: "Templates/Meeting.md" }, io });
    expect(second.state).toBe("sealed");
    if (second.state !== "sealed") return;
    const fieldQuestions = new Set(io.asked.filter(id => id.startsWith("field:")).map(id => id.split(":")[1]));
    expect([...fieldQuestions].sort()).toEqual(["owner", "status"]);
    expect(io.asked).not.toContain("heading:Agenda");
    expect(io.asked).not.toContain("apply-folder");
    expect(io.said).toContain("Dropped `code` (no longer in the template).");
    expect(io.said).toContain("Kept `kind` (unchanged since the last seal).");

    const { id, layers } = await sealedLayers();
    expect(await readdir(join(store, "vaults", id, "layers"))).toEqual([`${second.publicTemplate!.sealId}.json`]);
    expect(second.publicTemplate!.sealId).not.toBe(oldSeal);
    expect(second.publicTemplate).toMatchObject({ applyFolder: "Meetings", requiredHeadings: ["Agenda"] });
    const loaded = layers.templates.get("Templates/Meeting.md");
    expect(loaded?.state === "ok" && loaded.layer.fields.find(field => field.name === "status")?.rules).toEqual([{ kind: "allowed", values: ["draft", "open", "closed"] }]);
    expect(await templateDrift(vault, second.publicTemplate!)).toBe("active");
  });

  it("reseals a template whose sealed layer is unreadable", async () => {
    await put("T.md", "---\nnote: x\n---\n");
    const answers = { "field:note:literal": "must-equal", "apply-folder": "" };
    const first = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io: scripted(answers) });
    if (first.state !== "sealed") throw new Error("first seal failed");
    await writeFile(join(store, "vaults", first.vaultId, "layers", `${first.publicTemplate!.sealId}.json`), "{");
    const io = scripted(answers);
    const second = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io });
    expect(second.state).toBe("sealed");
    expect(io.said).toContain("The previous seal is unreadable; every field is asked again.");
    const { layers } = await sealedLayers();
    expect(layers.templates.get("T.md")?.state).toBe("ok");
  });

  it("refuses when the public manifest is unreadable", async () => {
    await put("T.md", "---\nnote: x\n---\n");
    await put(PUBLIC_MANIFEST_PATH, "{");
    const result = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io: scripted() });
    expect(result.state).toBe("refused");
  });
});

describe("runInterview: common layer", () => {
  const COMMON: Script = {
    "common:add:1": "y",
    "common:add:1:name": "status",
    "field:status:rule": "one-of-allowed",
    "field:status:allowed": "open, closed",
  };

  it("seals declared common fields and publishes only their public part", async () => {
    const io = scripted(COMMON);
    const result = await runInterview({ vault, target: { kind: "common" }, io });
    expect(result.state).toBe("sealed");
    if (result.state !== "sealed") return;
    expect(result.publicCommon?.fields).toEqual([{ name: "status", type: "text", required: true, description: "`status` must be one of the defined values. Required." }]);
    const { layers } = await sealedLayers();
    expect(layers.common?.state === "ok" && layers.common.layer.fields[0]?.rules).toEqual([{ kind: "allowed", values: ["open", "closed"] }]);
    expect(await readFile(join(vault, PUBLIC_MANIFEST_PATH), "utf8")).not.toContain("closed");
  });

  it("refuses an empty common layer", async () => {
    const result = await runInterview({ vault, target: { kind: "common" }, io: scripted() });
    expect(result).toEqual({ state: "refused", reasons: ["The common rules declare no field; nothing to seal."] });
  });

  it("refuses a template that contradicts the common rules", async () => {
    expect((await runInterview({ vault, target: { kind: "common" }, io: scripted(COMMON) })).state).toBe("sealed");
    await put("T.md", "---\nstatus: done\n---\n");
    const outside = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io: scripted({ "field:status:literal": "must-equal", "apply-folder": "" }) });
    expect(outside).toEqual({ state: "refused", reasons: ["`status` has a fixed value outside the allowed values of the common rules."] });
    const disjoint = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io: scripted({ "field:status:literal": "one-of-allowed", "apply-folder": "" }) });
    expect(disjoint).toEqual({ state: "refused", reasons: ["`status` allowed values do not overlap with the common rules."] });
    const typed = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io: scripted({ "field:status:type": "number", "field:status:literal": "example-only", "field:status:rule": "none", "apply-folder": "" }) });
    expect(typed.state === "refused" && typed.reasons).toEqual(["`status` has type number here but text in the common rules."]);
    const narrowed = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io: scripted({ "field:status:literal": "one-of-allowed", "field:status:allowed": "open", "apply-folder": "" }) });
    expect(narrowed.state).toBe("sealed");
  });

  it("keeps, edits or removes existing common fields on re-interview", async () => {
    const first = await runInterview({ vault, target: { kind: "common" }, io: scripted({ ...COMMON, "common:add:2": "y", "common:add:2:name": "topic", "field:topic:rule": "none" }) });
    if (first.state !== "sealed") throw new Error("first seal failed");
    const io = scripted({ "common:status:action": "keep", "common:topic:action": "remove" });
    const second = await runInterview({ vault, target: { kind: "common" }, io });
    expect(second.state === "sealed" && second.publicCommon?.fields.map(field => field.name)).toEqual(["status"]);
    const { id } = await sealedLayers();
    expect(await readdir(join(store, "vaults", id, "layers"))).toEqual([`${second.state === "sealed" ? second.publicCommon!.sealId : ""}.json`]);
  });

  it("refuses a template while the sealed common rules are unreadable", async () => {
    const first = await runInterview({ vault, target: { kind: "common" }, io: scripted(COMMON) });
    if (first.state !== "sealed") throw new Error("first seal failed");
    await rm(join(store, "vaults", first.vaultId, "layers", `${first.publicCommon!.sealId}.json`));
    await put("T.md", "---\nnote: x\n---\n");
    const result = await runInterview({ vault, target: { kind: "template", sourcePath: "T.md" }, io: scripted() });
    expect(result.state === "refused" && result.reasons[0]).toMatch(/interview --common` first/);
  });
});

describe("sealGuard", () => {
  const base: SealedLayer = {
    sealId: "00000000-0000-4000-8000-0000000000a1",
    fields: [{ name: "status", type: "text", required: true, description: "`status` must be one of the defined values.", rules: [{ kind: "allowed", values: ["secret-open"] }], variable: null }],
    requiredHeadings: ["Agenda"],
    applyFolder: "Notes",
    sourcePath: "T.md",
    sourceHash: `sha256:${"a".repeat(64)}`,
    answers: {},
  };

  it("accepts clean public text", () => {
    expect(sealGuard(base)).toEqual([]);
  });

  it("finds hidden values of any layer in descriptions, headings and the apply folder", () => {
    const other: SealedLayer = { ...base, sealId: "00000000-0000-4000-8000-0000000000a2", sourcePath: null, sourceHash: null, requiredHeadings: [], applyFolder: null, fields: [{ ...base.fields[0]!, name: "kind", rules: [{ kind: "fixed", value: "Agenda" }] }] };
    const leaking: SealedLayer = { ...base, applyFolder: "secret-open", fields: [{ ...base.fields[0]!, description: "use secret-open" }] };
    expect(sealGuard(leaking, [{ label: "the common rules", layer: other }])).toEqual([
      "The description of `status` contains a hidden value; rewrite it without the value.",
      "The apply folder contains a hidden value.",
      "Required heading 1 contains a hidden value; do not require it.",
    ]);
  });

  it("refuses two different fixed values for a scalar field", () => {
    const fixed = (value: string): SealedLayer => ({ ...base, fields: [{ ...base.fields[0]!, rules: [{ kind: "fixed", value }] }] });
    expect(sealGuard(fixed("a"), [{ label: "the common rules", layer: fixed("b") }])).toEqual(["`status` has a different fixed value in the common rules."]);
  });
});

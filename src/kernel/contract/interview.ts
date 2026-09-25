import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { extractTemplate, type ExtractedField } from "./extract.js";
import { EMPTY_PUBLIC_MANIFEST, readPublicManifest, writePublicManifest } from "./public.js";
import { buildRedactor, hiddenValuesOf } from "./redact.js";
import { loadLayers, sealLayer, type LoadedLayers } from "./store.js";
import {
  compareCodePoint,
  FIELD_TYPES,
  type FieldType,
  type HiddenRule,
  type JsonScalar,
  type PublicCommon,
  type PublicField,
  type PublicManifest,
  type PublicTemplate,
  type SealedField,
  type SealedLayer,
  type VariableKind,
} from "./types.js";
import { ensureVaultId, readVaultId } from "./vault-id.js";

/**
 * Deterministic seal-time questionnaire (ADR-007 §2). No LLM asks anything: every
 * question comes from the extracted template or the previous seal. All IO is injected,
 * so the kernel never touches a terminal. Only the CLI calls it.
 */

export type Question =
  | { readonly id: string; readonly prompt: string; readonly kind: "choice"; readonly options: readonly string[] }
  | { readonly id: string; readonly prompt: string; readonly kind: "text"; readonly initial?: string }
  | { readonly id: string; readonly prompt: string; readonly kind: "confirm" };

export interface InterviewIO {
  ask(question: Question): Promise<string>;
  say(line: string): void;
}

export type InterviewTarget = { readonly kind: "common" } | { readonly kind: "template"; readonly sourcePath: string };

export type InterviewResult =
  | {
    readonly state: "sealed";
    readonly vaultId: string;
    readonly vaultIdCreated: boolean;
    readonly publicTemplate: PublicTemplate | null;
    readonly publicCommon: PublicCommon | null;
  }
  | { readonly state: "refused"; readonly reasons: readonly string[] }
  | { readonly state: "aborted" };

/** Thrown by an IO (or after repeated invalid answers) to end the interview without sealing. */
export class InterviewAborted extends Error {
  constructor(message = "interview aborted") {
    super(message);
    this.name = "InterviewAborted";
  }
}

export const LITERAL_CHOICES = ["must-equal", "one-of-allowed", "example-only"] as const;
const COMMON_RULE_CHOICES = ["none", "one-of-allowed", "must-equal", "pattern", "range"] as const;
const MAX_ATTEMPTS = 3;
const STRING_TYPES = new Set<FieldType>(["text", "string", "select", "file"]);
const LIST_TYPES = new Set<FieldType>(["list", "multitext", "multi", "tags", "aliases"]);
const RANGE_TYPES = new Set<FieldType>(["number", "date", "datetime"]);

/** A rejected answer; the question is asked again with this message. */
class Invalid {
  constructor(readonly error: string) {}
}

const invalid = (error: string): Invalid => new Invalid(error);

class Asker {
  constructor(private readonly io: InterviewIO) {}

  say(line: string): void {
    this.io.say(line);
  }

  private async loop<T>(question: Question, parse: (answer: string) => T | Invalid): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const parsed = parse(await this.io.ask(question));
      if (!(parsed instanceof Invalid)) return parsed;
      this.io.say(`  ${parsed.error}`);
    }
    throw new InterviewAborted(`too many invalid answers to ${question.id}`);
  }

  choice<T extends string>(id: string, prompt: string, options: readonly T[]): Promise<T> {
    return this.loop({ id, prompt, kind: "choice", options }, answer => {
      const text = answer.trim();
      const index = /^\d+$/.test(text) ? Number(text) - 1 : -1;
      const found = options[index] ?? options.find(option => option.toLowerCase() === text.toLowerCase());
      return found ?? invalid(`Choose one of: ${options.join(", ")}.`);
    });
  }

  confirm(id: string, prompt: string): Promise<boolean> {
    return this.loop({ id, prompt, kind: "confirm" }, answer => {
      const text = answer.trim().toLowerCase();
      if (text === "y" || text === "yes") return true;
      if (text === "n" || text === "no") return false;
      return invalid("Answer yes or no.");
    });
  }

  text<T = string>(id: string, prompt: string, initial: string | undefined, parse: (answer: string) => T | Invalid): Promise<T> {
    const question: Question = initial === undefined ? { id, prompt, kind: "text" } : { id, prompt, kind: "text", initial };
    return this.loop(question, answer => parse(answer.trim() === "" ? initial ?? "" : answer.trim()));
  }
}

function sameScalar(left: JsonScalar, right: JsonScalar): boolean {
  if (typeof left === "string" && typeof right === "string") return left.normalize("NFC") === right.normalize("NFC");
  return left === right;
}

function coerce(type: FieldType, raw: string): JsonScalar | Invalid {
  if (type === "number") {
    const value = Number(raw);
    return raw !== "" && Number.isFinite(value) ? value : invalid(`"${raw}" is not a number.`);
  }
  if (type === "boolean" || type === "checkbox") {
    if (raw === "true" || raw === "false") return raw === "true";
    return invalid("Use true or false.");
  }
  return raw;
}

function parseValues(type: FieldType, raw: string): JsonScalar[] | Invalid {
  const values: JsonScalar[] = [];
  for (const part of raw.split(",").map(item => item.trim()).filter(item => item !== "")) {
    const value = coerce(type, part);
    if (value instanceof Invalid) return value;
    if (!values.some(known => sameScalar(known, value))) values.push(value);
  }
  return values.length > 0 ? values : invalid("Give at least one value, separated by commas.");
}

function hasLiteral(literal: ExtractedField["literal"]): literal is JsonScalar | readonly JsonScalar[] {
  if (literal === null || literal === "") return false;
  return !Array.isArray(literal) || literal.length > 0;
}

function literalMembers(literal: JsonScalar | readonly JsonScalar[]): readonly JsonScalar[] {
  return Array.isArray(literal) ? literal : [literal as JsonScalar];
}

/** The public draft never names a value; it only says a rule exists. */
export function draftDescription(name: string, type: FieldType, required: boolean, rules: readonly HiddenRule[], variable: VariableKind | null): string {
  const kinds = new Set(rules.map(rule => rule.kind));
  let sentence: string;
  if (kinds.has("fixed")) sentence = `\`${name}\` must have its defined value.`;
  else if (kinds.has("allowed")) sentence = `\`${name}\` must be one of the defined values.`;
  else if (kinds.has("pattern")) sentence = `\`${name}\` must match its defined format.`;
  else if (kinds.has("range")) sentence = `\`${name}\` must be within its defined range.`;
  else if (variable === "free") sentence = `\`${name}\` is a free value filled by the agent.`;
  else if (variable !== null) sentence = `\`${name}\` is a ${type} value filled by the agent.`;
  else sentence = `\`${name}\` is a ${type} value.`;
  return required ? `${sentence} Required.` : sentence;
}

function contradiction(field: SealedField, other: SealedField, otherLabel: string): string | null {
  const name = `\`${field.name}\``;
  if (field.type !== other.type) return `${name} has type ${field.type} here but ${other.type} in ${otherLabel}.`;
  const allowed = (target: SealedField) => target.rules.filter((rule): rule is Extract<HiddenRule, { kind: "allowed" }> => rule.kind === "allowed");
  const fixed = (target: SealedField) => target.rules.filter((rule): rule is Extract<HiddenRule, { kind: "fixed" }> => rule.kind === "fixed");
  for (const left of allowed(field)) {
    for (const right of allowed(other)) {
      if (!left.values.some(value => right.values.some(known => sameScalar(value, known)))) {
        return `${name} allowed values do not overlap with ${otherLabel}.`;
      }
    }
  }
  for (const [fixedSide, allowedSide] of [[field, other], [other, field]] as const) {
    for (const rule of fixed(fixedSide)) {
      if (allowed(allowedSide).some(set => !set.values.some(value => sameScalar(value, rule.value)))) {
        return `${name} has a fixed value outside the allowed values of ${fixedSide === field ? otherLabel : "this layer"}.`;
      }
    }
  }
  if (!LIST_TYPES.has(field.type)) {
    for (const left of fixed(field)) {
      if (fixed(other).some(right => !sameScalar(left.value, right.value))) return `${name} has a different fixed value in ${otherLabel}.`;
    }
  }
  return null;
}

/**
 * Refuses a seal whose public text carries a hidden value of any layer, or whose rules
 * contradict another layer. Reasons name fields, never values.
 */
export function sealGuard(layer: SealedLayer, others: readonly { readonly label: string; readonly layer: SealedLayer }[] = [], publicTokens: readonly string[] = []): string[] {
  const reasons: string[] = [];
  const tokens = [
    ...FIELD_TYPES,
    ...publicTokens,
    ...layer.fields.map(field => field.name),
    ...others.flatMap(other => other.layer.fields.map(field => field.name)),
  ];
  const redact = buildRedactor(hiddenValuesOf([layer, ...others.map(other => other.layer)]), { publicTokens: tokens });
  for (const field of layer.fields) {
    if (redact(field.description) !== field.description) {
      reasons.push(`The description of \`${field.name}\` contains a hidden value; rewrite it without the value.`);
    }
  }
  if (layer.applyFolder !== null && redact(layer.applyFolder) !== layer.applyFolder) reasons.push("The apply folder contains a hidden value.");
  layer.requiredHeadings.forEach((heading, index) => {
    if (redact(heading) !== heading) reasons.push(`Required heading ${index + 1} contains a hidden value; do not require it.`);
  });
  for (const other of others) {
    for (const field of layer.fields) {
      const counterpart = other.layer.fields.find(candidate => candidate.name === field.name);
      const reason = counterpart === undefined ? null : contradiction(field, counterpart, other.label);
      if (reason !== null) reasons.push(reason);
    }
  }
  return reasons;
}

function publicField(field: SealedField): PublicField {
  return { name: field.name, type: field.type, required: field.required, description: field.description };
}

function normalizeSourcePath(sourcePath: string): string {
  return sourcePath.normalize("NFC").replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^(?:\.\/)+/, "");
}

function templateName(id: string): string {
  const base = id.slice(id.lastIndexOf("/") + 1);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}

function parseFolder(raw: string): string | null | Invalid {
  if (raw === "" || raw === "-") return null;
  const folder = raw.normalize("NFC").replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (folder.startsWith("/") || /^[A-Za-z]:/.test(folder) || folder.split("/").some(part => part === ".." || part === ".")) {
    return invalid("Give a vault-relative folder without `..`, or leave it empty.");
  }
  return folder === "" ? null : folder;
}

async function askExtraRule(asker: Asker, name: string, type: FieldType): Promise<HiddenRule[]> {
  const options = ["none", ...(STRING_TYPES.has(type) ? ["pattern"] : []), ...(RANGE_TYPES.has(type) ? ["range"] : [])];
  if (options.length === 1) return [];
  const choice = await asker.choice(`field:${name}:rule`, `Add a hidden format rule to \`${name}\`?`, options);
  if (choice === "pattern") return [await askPattern(asker, name)];
  if (choice === "range") return [await askRange(asker, name, type)];
  return [];
}

async function askPattern(asker: Asker, name: string): Promise<HiddenRule> {
  const regex = await asker.text(`field:${name}:pattern`, `Regular expression every \`${name}\` value must fully match`, undefined, raw => {
    if (raw === "") return invalid("Give a regular expression.");
    try {
      new RegExp(raw, "u");
      return raw;
    } catch {
      return invalid("That is not a valid regular expression.");
    }
  });
  return { kind: "pattern", regex };
}

async function askRange(asker: Asker, name: string, type: FieldType): Promise<HiddenRule> {
  const bound = (raw: string): number | string | undefined | Invalid => {
    if (raw === "" || raw === "-") return undefined;
    if (type !== "number") return raw;
    const value = coerce(type, raw);
    return typeof value === "number" ? value : invalid(`"${raw}" is not a number.`);
  };
  for (;;) {
    const min = await asker.text(`field:${name}:range-min`, `Lowest allowed \`${name}\` (empty for none)`, undefined, bound);
    const max = await asker.text(`field:${name}:range-max`, `Highest allowed \`${name}\` (empty for none)`, undefined, bound);
    if (min !== undefined && max !== undefined && min > max) {
      asker.say(`  The lowest value is above the highest; give the range again.`);
      continue;
    }
    if (min === undefined && max === undefined) {
      asker.say(`  Give at least one bound.`);
      continue;
    }
    return { kind: "range", ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  }
}

async function askType(asker: Asker, name: string, initial: FieldType): Promise<FieldType> {
  return asker.text(`field:${name}:type`, `Type of \`${name}\` (${FIELD_TYPES.join(", ")})`, initial, raw =>
    (FIELD_TYPES as readonly string[]).includes(raw) ? raw as FieldType : invalid(`Use one of: ${FIELD_TYPES.join(", ")}.`));
}

async function askDescription(asker: Asker, name: string, draft: string): Promise<string> {
  return asker.text(`field:${name}:description`, `Public description of \`${name}\` (agents see this; never include a hidden value)`, draft, raw =>
    raw.includes("\n") ? invalid("Keep the description on one line.") : raw);
}

/** One template field. The extraction proposes; the user decides. */
async function askTemplateField(asker: Asker, extracted: ExtractedField): Promise<SealedField> {
  const { name } = extracted;
  let variable = extracted.variable;
  if (variable === "free") {
    const free = await asker.confirm(`field:${name}:free`, `\`${name}\` holds a template expression OMS cannot interpret. Treat it as a free value the agent fills?`);
    if (!free) variable = null;
  }
  const type = await askType(asker, name, extracted.inferredType);
  const required = await asker.confirm(`field:${name}:required`, `Is \`${name}\` required in every note from this template?`);
  const rules: HiddenRule[] = [];
  if (variable === null && hasLiteral(extracted.literal)) {
    const members = literalMembers(extracted.literal);
    const choice = await asker.choice(
      `field:${name}:literal`,
      `The template writes a value for \`${name}\`. Must notes use exactly that value, one of several allowed values, or is it just an example?`,
      LITERAL_CHOICES,
    );
    if (choice === "must-equal") {
      for (const value of members) rules.push({ kind: "fixed", value });
    } else if (choice === "one-of-allowed") {
      const values = await asker.text(`field:${name}:allowed`, `Allowed values for \`${name}\` (comma separated)`, members.map(String).join(", "), raw => parseValues(type, raw));
      rules.push({ kind: "allowed", values });
    }
  }
  if (rules.length === 0 && variable === null) rules.push(...await askExtraRule(asker, name, type));
  const description = await askDescription(asker, name, draftDescription(name, type, required, rules, variable));
  return { name, type, required, description, rules, variable };
}

/** One common field, declared by the user (the common layer has no source template). */
async function askCommonField(asker: Asker, name: string, previous: SealedField | null): Promise<SealedField> {
  const type = await askType(asker, name, previous?.type ?? "text");
  const required = await asker.confirm(`field:${name}:required`, `Must every note have \`${name}\`?`);
  const choice = await asker.choice(`field:${name}:rule`, `Hidden rule for \`${name}\``, COMMON_RULE_CHOICES);
  const rules: HiddenRule[] = [];
  if (choice === "one-of-allowed") {
    rules.push({ kind: "allowed", values: await asker.text(`field:${name}:allowed`, `Allowed values for \`${name}\` (comma separated)`, undefined, raw => parseValues(type, raw)) });
  } else if (choice === "must-equal") {
    const value = await asker.text(`field:${name}:fixed`, `Value \`${name}\` must have`, undefined, raw => raw === "" ? invalid("Give a value.") : coerce(type, raw));
    rules.push({ kind: "fixed", value });
  } else if (choice === "pattern") {
    rules.push(await askPattern(asker, name));
  } else if (choice === "range") {
    rules.push(await askRange(asker, name, type));
  }
  const draft = draftDescription(name, type, required, rules, null);
  const description = await askDescription(asker, name, previous !== null && previous.rules.length === 0 && rules.length === 0 ? previous.description || draft : draft);
  return { name, type, required, description, rules, variable: null };
}

interface Context {
  readonly manifest: PublicManifest;
  readonly loaded: LoadedLayers | null;
}

async function readContext(vault: string): Promise<Context | { readonly refused: string[] }> {
  const manifest = await readPublicManifest(vault);
  if (manifest.state === "invalid") return { refused: ["The public manifest .oms/contract-public.json is unreadable; restore it before sealing."] };
  const known = manifest.state === "ok" ? manifest.manifest : EMPTY_PUBLIC_MANIFEST;
  const vaultId = await readVaultId(vault);
  if (vaultId.state === "invalid") return { refused: [`.oms/vault-id is unreadable (${vaultId.reason}); restore it before sealing.`] };
  if (vaultId.state === "absent") return { manifest: known, loaded: null };
  const loaded = await loadLayers(vaultId.id, known);
  if (loaded.orphaned) {
    return { refused: ["The sealed store holds a layer the public manifest does not name; restore .oms/contract-public.json before sealing."] };
  }
  return { manifest: known, loaded };
}

function okLayer(state: LoadedLayers["common"] | undefined): SealedLayer | null {
  return state !== undefined && state !== null && state.state === "ok" ? state.layer : null;
}

async function templateLayer(vault: string, sourcePath: string, asker: Asker, context: Context): Promise<{ readonly layer: SealedLayer; readonly replaces?: string; readonly others: { label: string; layer: SealedLayer }[] } | { readonly refused: string[] }> {
  const id = normalizeSourcePath(sourcePath);
  const entry = context.manifest.templates.find(template => template.id === id);
  const previous = okLayer(context.loaded?.templates.get(id));
  const common = context.manifest.common === null ? null : okLayer(context.loaded?.common);
  if (context.manifest.common !== null && common === null) {
    return { refused: ["The sealed common rules are unreadable, so a template cannot be checked against them; run `oms contract interview --common` first."] };
  }
  const extraction = await extractTemplate(vault, id);
  if (!extraction.ok) return { refused: extraction.diagnostics.map(item => `${item.code}: ${item.message}`) };
  if (entry !== undefined && previous === null) asker.say("The previous seal is unreadable; every field is asked again.");

  const answers: Record<string, string> = {};
  const fields: SealedField[] = [];
  for (const extracted of extraction.extraction.fields) {
    const fingerprint = JSON.stringify([extracted.inferredType, extracted.literal, extracted.variable]);
    const key = `field:${extracted.name}:source`;
    answers[key] = fingerprint;
    const kept = previous?.answers[key] === fingerprint ? previous.fields.find(field => field.name === extracted.name) : undefined;
    if (kept !== undefined) {
      asker.say(`Kept \`${kept.name}\` (unchanged since the last seal).`);
      fields.push(kept);
      continue;
    }
    fields.push(await askTemplateField(asker, extracted));
  }
  for (const field of previous?.fields ?? []) {
    if (!fields.some(current => current.name === field.name)) asker.say(`Dropped \`${field.name}\` (no longer in the template).`);
  }

  const requiredHeadings: string[] = [];
  for (const heading of extraction.extraction.headings) {
    if (heading.variable || requiredHeadings.includes(heading.title)) continue;
    const key = `heading:${heading.title}`;
    const earlier = previous?.answers[key];
    const required = earlier !== undefined
      ? earlier === "required"
      : await asker.confirm(key, `Must notes from this template keep the heading "${heading.title}"?`);
    answers[key] = required ? "required" : "optional";
    if (required) requiredHeadings.push(heading.title);
  }

  let applyFolder: string | null;
  if (entry !== undefined) {
    applyFolder = entry.applyFolder;
  } else {
    applyFolder = await asker.text("apply-folder", "Folder this template applies to (empty for any folder)", "", parseFolder);
  }

  const layer: SealedLayer = {
    sealId: randomUUID(),
    fields,
    requiredHeadings,
    applyFolder,
    sourcePath: id,
    sourceHash: extraction.extraction.sourceHash,
    answers,
  };
  return {
    layer,
    ...(entry === undefined ? {} : { replaces: entry.sealId }),
    others: common === null ? [] : [{ label: "the common rules", layer: common }],
  };
}

async function commonLayer(asker: Asker, context: Context): Promise<{ readonly layer: SealedLayer; readonly replaces?: string; readonly others: { label: string; layer: SealedLayer }[] } | { readonly refused: string[] }> {
  const previous = okLayer(context.loaded?.common);
  if (context.manifest.common !== null && previous === null) asker.say("The previous common rules are unreadable; declare them again.");
  const fields: SealedField[] = [];
  for (const field of [...previous?.fields ?? []].sort((left, right) => compareCodePoint(left.name, right.name))) {
    const action = await asker.choice(`common:${field.name}:action`, `Common field \`${field.name}\` (${field.type}, ${field.required ? "required" : "optional"})`, ["keep", "edit", "remove"]);
    if (action === "keep") fields.push(field);
    else if (action === "edit") fields.push(await askCommonField(asker, field.name, field));
  }
  for (let index = 1; await asker.confirm(`common:add:${index}`, "Add a common field?"); index += 1) {
    const name = await asker.text(`common:add:${index}:name`, "Field name", undefined, raw => {
      if (raw === "" || /[\n:#]/.test(raw)) return invalid("Give a field name without `:` or `#`.");
      if (fields.some(field => field.name === raw)) return invalid(`\`${raw}\` is already declared.`);
      return raw;
    });
    fields.push(await askCommonField(asker, name, null));
  }
  if (fields.length === 0) return { refused: ["The common rules declare no field; nothing to seal."] };
  const others: { label: string; layer: SealedLayer }[] = [];
  for (const template of context.manifest.templates) {
    const layer = okLayer(context.loaded?.templates.get(template.id));
    if (layer !== null) others.push({ label: `template ${template.id}`, layer });
  }
  const layer: SealedLayer = {
    sealId: randomUUID(),
    fields: fields.sort((left, right) => compareCodePoint(left.name, right.name)),
    requiredHeadings: [],
    applyFolder: null,
    sourcePath: null,
    sourceHash: null,
    answers: {},
  };
  return { layer, ...(context.manifest.common === null ? {} : { replaces: context.manifest.common.sealId }), others };
}

function preview(io: InterviewIO, layer: SealedLayer): void {
  io.say("Public part (agents will see this):");
  for (const field of layer.fields) {
    io.say(`  - ${field.name} (${field.type}, ${field.required ? "required" : "optional"}): ${field.description}`);
  }
  if (layer.requiredHeadings.length > 0) io.say(`  Required headings: ${layer.requiredHeadings.join(", ")}`);
  if (layer.sourcePath !== null) io.say(`  Apply folder: ${layer.applyFolder ?? "(any)"}`);
}

export async function runInterview(input: { readonly vault: string; readonly target: InterviewTarget; readonly io: InterviewIO }): Promise<InterviewResult> {
  const { vault, target, io } = input;
  const asker = new Asker(io);
  try {
    const context = await readContext(vault);
    if ("refused" in context) return { state: "refused", reasons: context.refused };
    const built = target.kind === "common" ? await commonLayer(asker, context) : await templateLayer(vault, target.sourcePath, asker, context);
    if ("refused" in built) return { state: "refused", reasons: built.refused };
    const { layer, others } = built;
    const publicTokens = layer.sourcePath === null ? [] : [layer.sourcePath, templateName(layer.sourcePath)];
    const reasons = sealGuard(layer, others, publicTokens);
    if (reasons.length > 0) return { state: "refused", reasons };

    preview(io, layer);
    if (!await asker.confirm("seal", "Seal this contract?")) return { state: "aborted" };

    const vaultId = await ensureVaultId(vault);
    if (vaultId.state !== "ok") return { state: "refused", reasons: [`.oms/vault-id could not be created (${vaultId.reason}).`] };
    const sealed = await sealLayer(vaultId.id, layer, await realpath(vault), built.replaces === undefined ? {} : { replaces: built.replaces });
    if (!sealed.ok) return { state: "refused", reasons: [`The sealed store could not be written (${sealed.reason}).`] };

    const publicFields = layer.fields.map(publicField);
    let publicTemplate: PublicTemplate | null = null;
    let publicCommon: PublicCommon | null = null;
    let manifest: PublicManifest;
    if (layer.sourcePath === null) {
      publicCommon = { fields: publicFields, sealId: layer.sealId };
      manifest = { ...context.manifest, common: publicCommon };
    } else {
      publicTemplate = {
        id: layer.sourcePath,
        name: templateName(layer.sourcePath),
        applyFolder: layer.applyFolder,
        fields: publicFields,
        requiredHeadings: layer.requiredHeadings,
        sourceHash: layer.sourceHash!,
        sealId: layer.sealId,
      };
      const id = publicTemplate.id;
      manifest = { ...context.manifest, templates: [...context.manifest.templates.filter(template => template.id !== id), publicTemplate] };
    }
    const written = await writePublicManifest(vault, manifest);
    if (!written.ok) {
      return { state: "refused", reasons: [`The layer was sealed but .oms/contract-public.json could not be written (${written.reason}); run the interview again.`] };
    }
    return { state: "sealed", vaultId: vaultId.id, vaultIdCreated: vaultId.created, publicTemplate, publicCommon };
  } catch (error: unknown) {
    if (error instanceof InterviewAborted) return { state: "aborted" };
    throw error;
  }
}

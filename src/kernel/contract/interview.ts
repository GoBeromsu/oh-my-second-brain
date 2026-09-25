import { lstat, readdir, realpath } from "node:fs/promises";
import { compareCodePoints } from "../conventions/canonical.js";
import { readVaultSettings, type VaultSettings } from "../vault/settings.js";
import { normalizeFolderPath, verifyVaultPath } from "../vault/paths.js";
import { extractTemplate, type Extraction } from "./extract.js";
import { FIELD_TYPES, readObsidianTemplateFolder, readObsidianTypes } from "./obsidian.js";
import { buildRedactor, hiddenValuesOf, publicTokensOf } from "./redact.js";
import { scanTemplateSources } from "./scan.js";
import { currentSequence, isSafeName, NO_DECLINED, readDeclined, sealContract, storeRoot, type DeclinedSet, type SealDeps } from "./store.js";
import type {
  FieldType,
  FolderContract,
  JsonScalar,
  PropertyContract,
  Rule,
  TemplateContract,
  VaultContract,
} from "./types.js";
import { ensureVaultId, resolveSealState, writeVaultSettings } from "./vault-id.js";

/**
 * Deterministic seal-time questionnaire over a full vault scan: top-level folders,
 * properties (template fields and Obsidian types) and the templates in the template
 * folder. No LLM asks anything and all IO is injected. Only the CLI calls it.
 * With a readable sealed contract, a rerun asks only about new folders, new properties
 * and new or changed templates, and keeps every existing answer (diff-only). Declined
 * folders, properties and templates (with their source hash) are kept beside the contract
 * and not asked again until they change or the caller asks to review them.
 */

export type Question =
  | { readonly id: string; readonly prompt: string; readonly kind: "choice"; readonly options: readonly string[] }
  | { readonly id: string; readonly prompt: string; readonly kind: "text"; readonly initial?: string }
  | { readonly id: string; readonly prompt: string; readonly kind: "confirm"; readonly initial?: boolean };

export interface InterviewIO {
  ask(question: Question): Promise<string>;
  say(line: string): void;
}

export type InterviewResult =
  | {
    readonly state: "sealed";
    readonly vaultIdCreated: boolean;
    readonly folders: number;
    readonly properties: number;
    readonly templates: readonly string[];
    /** Sealed templates whose source file was gone and that the user removed. */
    readonly removedTemplates?: readonly string[];
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

const LITERAL_CHOICES = ["must-equal", "one-of-allowed", "example-only"] as const;
const RULE_CHOICES = ["none", "one-of-allowed", "must-equal", "pattern", "range"] as const;
const MAX_ATTEMPTS = 3;

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

  confirm(id: string, prompt: string, initial?: boolean): Promise<boolean> {
    const question: Question = initial === undefined ? { id, prompt, kind: "confirm" } : { id, prompt, kind: "confirm", initial };
    return this.loop(question, answer => {
      const text = answer.trim().toLowerCase();
      if (text === "" && initial !== undefined) return initial;
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

function oneLine(raw: string): string | Invalid {
  return raw.includes("\n") ? invalid("Keep it on one line.") : raw;
}

/**
 * Conservative ReDoS screen: refuses a group that holds a quantifier or an alternation
 * and is itself repeated by `*`, `+` or `{…}`, such as `(a+)+`, `(a*)*` or `(a|a)*`.
 * Some safe patterns are refused too; the judge also caps the input it matches.
 */
export function hasNestedQuantifier(source: string): boolean {
  const open: boolean[] = [];
  let closedRisky = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const afterGroup = closedRisky;
    closedRisky = false;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      for (index += 1; index < source.length && source[index] !== "]"; index += 1) if (source[index] === "\\") index += 1;
      continue;
    }
    if (char === "(") {
      open.push(false);
      if (source[index + 1] === "?") {
        index += 1;
        if (source[index + 1] === "<" && source[index + 2] !== "=" && source[index + 2] !== "!") {
          while (index < source.length && source[index] !== ">") index += 1;
        } else index += 1;
      }
      continue;
    }
    if (char === ")") {
      const risky = open.pop() ?? false;
      if (open.length > 0 && risky) open[open.length - 1] = true;
      closedRisky = risky;
      continue;
    }
    const repeats = char === "*" || char === "+" || char === "{" && /^\{\d*,?\d*\}/.test(source.slice(index));
    if (repeats && afterGroup) return true;
    if ((repeats || char === "?" || char === "|") && open.length > 0) open[open.length - 1] = true;
  }
  return false;
}

async function askPattern(asker: Asker, id: string, name: string): Promise<Rule> {
  const regex = await asker.text(`${id}:pattern`, `Regular expression every \`${name}\` value must fully match`, undefined, raw => {
    if (raw === "") return invalid("Give a regular expression.");
    try {
      new RegExp(raw, "u");
    } catch {
      return invalid("That is not a valid regular expression.");
    }
    return hasNestedQuantifier(raw) ? invalid("Nested repetition such as (a+)+ or (a|b)* can hang the check; rewrite it without repeating a repeated group.") : raw;
  });
  return { kind: "pattern", regex };
}

async function askRange(asker: Asker, id: string, name: string, type: FieldType): Promise<Rule> {
  const bound = (raw: string): number | string | undefined | Invalid => {
    if (raw === "" || raw === "-") return undefined;
    if (type !== "number") return raw;
    const value = coerce(type, raw);
    return typeof value === "number" ? value : invalid(`"${raw}" is not a number.`);
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const min = await asker.text(`${id}:range-min`, `Lowest allowed \`${name}\` (empty for none)`, undefined, bound);
    const max = await asker.text(`${id}:range-max`, `Highest allowed \`${name}\` (empty for none)`, undefined, bound);
    if (min === undefined && max === undefined) asker.say("  Give at least one bound.");
    else if (min !== undefined && max !== undefined && min > max) asker.say("  The lowest value is above the highest; give the range again.");
    else return { kind: "range", ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  }
  throw new InterviewAborted(`too many invalid answers to ${id}:range`);
}

async function askRules(asker: Asker, id: string, name: string, type: FieldType): Promise<Rule[]> {
  const choice = await asker.choice(`${id}:rule`, `Hidden rule for \`${name}\``, RULE_CHOICES);
  if (choice === "one-of-allowed") {
    return [{ kind: "allowed", values: await asker.text(`${id}:allowed`, `Allowed values for \`${name}\` (comma separated)`, undefined, raw => parseValues(type, raw)) }];
  }
  if (choice === "must-equal") {
    return [{ kind: "fixed", value: await asker.text(`${id}:fixed`, `Value \`${name}\` must have`, undefined, raw => raw === "" ? invalid("Give a value.") : coerce(type, raw)) }];
  }
  if (choice === "pattern") return [await askPattern(asker, id, name)];
  if (choice === "range") return [await askRange(asker, id, name, type)];
  return [];
}

interface Discovered {
  readonly folders: readonly string[];
  readonly templates: readonly { readonly name: string; readonly source: string; readonly extraction: Extraction }[];
  readonly observedTypes: ReadonlyMap<string, FieldType>;
}

async function topLevelFolders(vault: string): Promise<string[]> {
  const folders: string[] = [];
  for (const entry of await readdir(vault, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      folders.push(normalizeFolderPath(entry.name));
    } catch {
      // Internal or unsafe names are never offered as contract folders.
    }
  }
  return folders.sort(compareCodePoints);
}

async function discover(vault: string, templateFolder: string | undefined): Promise<Discovered | { readonly refused: string[] }> {
  const observedTypes = new Map<string, FieldType>();
  try {
    for (const [name, type] of Object.entries(await readObsidianTypes(vault))) observedTypes.set(name, type);
  } catch {
    return { refused: ["The Obsidian property types file is unreadable; fix it in Obsidian first."] };
  }

  const templates: { name: string; source: string; extraction: Extraction }[] = [];
  const reasons: string[] = [];
  if (templateFolder !== undefined) {
    const inventory = await scanTemplateSources(vault, [{ path: templateFolder, kind: "folder" }]);
    if (!inventory.complete) reasons.push("The template folder could not be scanned completely; fix the reported template files first.");
    const seen = new Set<string>();
    for (const found of inventory.sources) {
      const source = String(found.path);
      const base = source.slice(source.lastIndexOf("/") + 1);
      const name = base.endsWith(".md") ? base.slice(0, -3) : base;
      if (!isSafeName(name)) {
        reasons.push(`A template file name is not usable as a template name (${JSON.stringify(name)}).`);
        continue;
      }
      if (seen.has(name)) {
        reasons.push(`Two templates share the name "${name}"; rename one.`);
        continue;
      }
      seen.add(name);
      const extracted = await extractTemplate(vault, source);
      if (!extracted.ok) {
        reasons.push(`Template "${name}" cannot be read (${extracted.diagnostics.map(item => item.code).join(", ")}).`);
        continue;
      }
      templates.push({ name, source, extraction: extracted.extraction });
      for (const field of extracted.extraction.fields) {
        if (!observedTypes.has(field.name)) observedTypes.set(field.name, field.inferredType);
      }
    }
  }
  if (reasons.length > 0) return { refused: reasons };
  templates.sort((left, right) => compareCodePoints(left.name, right.name));
  return { folders: await topLevelFolders(vault), templates, observedTypes };
}

/** A vault-relative folder that exists, stays inside the vault and is not hidden; null otherwise. */
async function usableFolder(vault: string, raw: string): Promise<string | null> {
  try {
    const folder = normalizeFolderPath(raw);
    const verified = await verifyVaultPath(vault, folder, { expected: "either" });
    if (verified.targetRealPath === null) return null;
    return (await lstat(verified.absolutePath)).isDirectory() ? folder : null;
  } catch {
    return null;
  }
}

/**
 * The template folder when the vault settings name none: the Obsidian Templates or
 * Templater folder once the owner confirms it, otherwise a folder the owner names.
 * An empty answer means the vault has no templates (`null`).
 */
async function askTemplateFolder(asker: Asker, vault: string): Promise<string | null> {
  const detected = await readObsidianTemplateFolder(vault);
  const candidate = detected === null ? null : await usableFolder(vault, detected);
  if (candidate !== null && await asker.confirm("template-folder:confirm", `Use \`${candidate}\` (from the Obsidian template settings) as the template folder?`, true)) return candidate;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = await asker.text("template-folder:path", "Vault-relative template folder (empty if this vault has no templates)", "", oneLine);
    if (answer === "") return null;
    const folder = await usableFolder(vault, answer);
    if (folder !== null) return folder;
    asker.say("  Give an existing folder inside the vault that is not hidden, or leave it empty.");
  }
  throw new InterviewAborted("too many invalid answers to template-folder:path");
}

async function askFolders(asker: Asker, folders: readonly string[]): Promise<Record<string, FolderContract> | null> {
  const result: Record<string, FolderContract> = {};
  for (const folder of folders) {
    if (!await asker.confirm(`folder:${folder}:register`, `Register the folder \`${folder}\`? Notes may only be written in registered folders.`)) continue;
    const meaning = await asker.text(`folder:${folder}:meaning`, `What belongs in \`${folder}\`? (agents see this; never include a hidden value)`, "", oneLine);
    const searchExclude = await asker.confirm(`folder:${folder}:search-exclude`, `Exclude \`${folder}\` from search?`);
    result[folder] = { meaning, searchExclude };
  }
  return Object.keys(result).length === 0 ? null : result;
}

async function askProperties(asker: Asker, observed: ReadonlyMap<string, FieldType>): Promise<Record<string, PropertyContract> | null> {
  const result: Record<string, PropertyContract> = {};
  for (const name of [...observed.keys()].sort(compareCodePoints)) {
    const id = `property:${name}`;
    if (!await asker.confirm(`${id}:register`, `Register the property \`${name}\`? Unregistered properties are refused once any is registered.`)) continue;
    const type = await asker.text(`${id}:type`, `Type of \`${name}\` (${FIELD_TYPES.join(", ")})`, observed.get(name), raw =>
      (FIELD_TYPES as readonly string[]).includes(raw) ? raw as FieldType : invalid(`Use one of: ${FIELD_TYPES.join(", ")}.`));
    const required = await asker.confirm(`${id}:required`, `Must every note have \`${name}\`?`);
    const fallback = required ? false : await asker.confirm(`${id}:default`, `When a note leaves \`${name}\` out, should the write pass and report it as missing?`);
    const rules = await askRules(asker, id, name, type);
    const meaning = await asker.text(`${id}:meaning`, `What does \`${name}\` mean? (agents see this; never include a hidden value)`, "", oneLine);
    result[name] = { meaning, type, default: fallback, required, rules };
  }
  return Object.keys(result).length === 0 ? null : result;
}

async function askTemplate(asker: Asker, name: string, source: string, extraction: Extraction): Promise<TemplateContract | null> {
  const id = `template:${name}`;
  if (!await asker.confirm(`${id}:register`, `Seal the template "${name}"?`)) return null;
  const requiredProperties: string[] = [];
  const narrowedRules: Record<string, Rule[]> = {};
  for (const field of extraction.fields) {
    if (await asker.confirm(`${id}:field:${field.name}:required`, `Must notes from "${name}" keep \`${field.name}\`?`)) requiredProperties.push(field.name);
    const literal = field.literal;
    if (field.variable !== null || literal === null || literal === "" || Array.isArray(literal) && literal.length === 0) continue;
    const members: readonly JsonScalar[] = Array.isArray(literal) ? literal : [literal as JsonScalar];
    const choice = await asker.choice(
      `${id}:field:${field.name}:literal`,
      `"${name}" writes a value for \`${field.name}\`. Must notes use exactly that value, one of several allowed values, or is it just an example?`,
      LITERAL_CHOICES,
    );
    if (choice === "must-equal") {
      narrowedRules[field.name] = members.map(value => ({ kind: "fixed", value }));
    } else if (choice === "one-of-allowed") {
      const values = await asker.text(`${id}:field:${field.name}:allowed`, `Allowed values for \`${field.name}\` (comma separated)`, members.map(String).join(", "), raw => parseValues(field.inferredType, raw));
      narrowedRules[field.name] = [{ kind: "allowed", values }];
    }
  }
  const requiredHeadings: string[] = [];
  for (const heading of extraction.headings) {
    if (heading.variable || requiredHeadings.includes(heading.title)) continue;
    if (await asker.confirm(`${id}:heading:${heading.title}`, `Must notes from "${name}" keep the heading "${heading.title}"?`)) requiredHeadings.push(heading.title);
  }
  const applyFolder = await asker.text(`${id}:apply-folder`, `Folder "${name}" applies to (empty for any folder)`, "", raw => {
    if (raw === "" || raw === "-") return null;
    try {
      return normalizeFolderPath(raw);
    } catch {
      return invalid("Give a vault-relative folder without hidden or `..` segments, or leave it empty.");
    }
  });
  return {
    source,
    sourceHash: extraction.sourceHash,
    ...(applyFolder === null ? {} : { applyFolder }),
    requiredProperties,
    narrowedRules,
    requiredHeadings,
  };
}

/** Refuses a contract whose public text carries a hidden value or that no note could pass. Reasons never name a value. */
export function sealGuard(contract: VaultContract): string[] {
  const reasons: string[] = [];
  const redact = buildRedactor(hiddenValuesOf(contract), { publicTokens: publicTokensOf(contract) });
  for (const [folder, entry] of Object.entries(contract.folders ?? {})) {
    if (redact(entry.meaning) !== entry.meaning) reasons.push(`The meaning of folder \`${folder}\` contains a hidden value; rewrite it without the value.`);
  }
  for (const [name, entry] of Object.entries(contract.properties ?? {})) {
    if (redact(entry.meaning) !== entry.meaning) reasons.push(`The meaning of \`${name}\` contains a hidden value; rewrite it without the value.`);
  }
  if (contract.properties !== null) {
    for (const [name, template] of Object.entries(contract.templates)) {
      for (const field of [...template.requiredProperties, ...Object.keys(template.narrowedRules)]) {
        if (!Object.hasOwn(contract.properties, field)) reasons.push(`Template "${name}" uses \`${field}\`, which is not a registered property.`);
      }
    }
  }
  return [...new Set(reasons)];
}

function preview(io: InterviewIO, contract: VaultContract): void {
  io.say("Public part (agents will see this):");
  for (const [folder, entry] of Object.entries(contract.folders ?? {})) io.say(`  folder ${folder}: ${entry.meaning}`);
  if (contract.folders === null) io.say("  folders: any");
  for (const [name, entry] of Object.entries(contract.properties ?? {})) {
    io.say(`  property ${name} (${entry.type}, ${entry.required ? "required" : "optional"}): ${entry.meaning}`);
  }
  if (contract.properties === null) io.say("  properties: any");
  for (const [name, template] of Object.entries(contract.templates)) {
    io.say(`  template ${name}: properties [${template.requiredProperties.join(", ")}], headings [${template.requiredHeadings.join(", ")}]`);
  }
}

/** Answers kept from the sealed contract merged with the new ones; null stays null only when both are. */
function merge<T>(kept: Readonly<Record<string, T>> | null, asked: Readonly<Record<string, T>> | null): Record<string, T> | null {
  return kept === null && asked === null ? null : { ...kept, ...asked };
}

export async function runInterview(input: {
  readonly vault: string;
  readonly io: InterviewIO;
  readonly root?: string;
  readonly sealDeps?: Partial<SealDeps>;
  /** Ask again about folders, properties and templates declined at an earlier seal. */
  readonly reask?: boolean;
}): Promise<InterviewResult> {
  const { vault, io } = input;
  const root = input.root ?? storeRoot();
  const asker = new Asker(io);
  try {
    const state = await resolveSealState(vault, root);
    if (state.row === "vault-id-tampered") {
      throw new Error("CONTRACT_VAULT_ID_TAMPERED: the vault id in .oms/settings.json does not match the id this vault was sealed with; restore the original .oms/settings.json or run `oms contract doctor`");
    }
    if (state.shared) {
      throw new Error("CONTRACT_VAULT_ID_SHARED: another existing vault uses this vault id (a copied vault); remove .oms/settings.json in the copy, then run `oms contract setup` again");
    }
    let settings: VaultSettings | null;
    try {
      settings = await readVaultSettings(vault);
    } catch {
      return { state: "refused", reasons: ["The vault settings are unreadable; run `oms contract doctor`."] };
    }
    const baseSeq = state.vaultId === null ? "none" : await currentSequence(state.vaultId, root);
    const previous = state.view.state === "sealed" ? state.view.contract : null;
    const pickFolder = settings?.templateFolder === undefined && (previous === null || input.reask === true);
    const chosenFolder = pickFolder ? await askTemplateFolder(asker, vault) : null;
    const found = await discover(vault, settings?.templateFolder ?? chosenFolder ?? undefined);
    if ("refused" in found) return { state: "refused", reasons: found.refused };

    const earlier: DeclinedSet = input.reask === true || state.vaultId === null ? NO_DECLINED : await readDeclined(state.vaultId, root);
    const newFolders = found.folders.filter(folder => !Object.hasOwn(previous?.folders ?? {}, folder));
    const newProperties = new Map([...found.observedTypes].filter(([name]) => !Object.hasOwn(previous?.properties ?? {}, name)));
    const changedTemplates = found.templates.filter(template => previous?.templates[template.name]?.sourceHash !== template.extraction.sourceHash);
    const askFolderList = newFolders.filter(folder => !earlier.folders.includes(folder));
    const askPropertyMap = new Map([...newProperties].filter(([name]) => !earlier.properties.includes(name)));
    const askTemplateList = changedTemplates.filter(template => earlier.templates[template.name] !== template.extraction.sourceHash);
    const goneTemplates = Object.keys(previous?.templates ?? {}).filter(name => !found.templates.some(template => template.name === name)).sort(compareCodePoints);
    if (previous !== null) {
      io.say(askFolderList.length + askPropertyMap.size + askTemplateList.length + goneTemplates.length === 0
        ? "Nothing new since the last seal; existing answers are kept."
        : "Asking only about what is new or changed since the last seal; existing answers are kept.");
    }
    const skipped = newFolders.length - askFolderList.length + newProperties.size - askPropertyMap.size + changedTemplates.length - askTemplateList.length;
    if (skipped > 0) io.say(`Skipping ${skipped} item(s) declined at an earlier seal; run \`oms contract setup --reask\` to answer them again.`);

    const askedFolders = await askFolders(asker, askFolderList);
    const askedProperties = await askProperties(asker, askPropertyMap);
    const folders = merge(previous?.folders ?? null, askedFolders);
    const properties = merge(previous?.properties ?? null, askedProperties);
    const templates: Record<string, TemplateContract> = { ...previous?.templates };
    const declinedTemplates: Record<string, string> = {};
    for (const template of askTemplateList) {
      const sealed = await askTemplate(asker, template.name, template.source, template.extraction);
      if (sealed === null) {
        delete templates[template.name];
        declinedTemplates[template.name] = template.extraction.sourceHash;
      } else templates[template.name] = sealed;
    }
    const removedTemplates: string[] = [];
    for (const name of goneTemplates) {
      if (!await asker.confirm(`template:${name}:remove`, `The source of the sealed template "${name}" is gone. Remove it from the contract?`, true)) continue;
      delete templates[name];
      removedTemplates.push(name);
    }
    const contract: VaultContract = { folders, properties, templates };
    const reasons = sealGuard(contract);
    if (reasons.length > 0) return { state: "refused", reasons };

    preview(io, contract);
    if (removedTemplates.length > 0) io.say(`  removed templates: ${removedTemplates.join(", ")}`);
    if (!await asker.confirm("seal", "Seal this contract?")) return { state: "aborted" };

    const currentTemplates = new Map(found.templates.map(template => [template.name, template.extraction.sourceHash]));
    const declined: DeclinedSet = {
      folders: [
        ...earlier.folders.filter(folder => found.folders.includes(folder) && !Object.hasOwn(folders ?? {}, folder)),
        ...askFolderList.filter(folder => !Object.hasOwn(askedFolders ?? {}, folder)),
      ],
      properties: [
        ...earlier.properties.filter(name => found.observedTypes.has(name) && !Object.hasOwn(properties ?? {}, name)),
        ...[...askPropertyMap.keys()].filter(name => !Object.hasOwn(askedProperties ?? {}, name)),
      ],
      templates: {
        ...Object.fromEntries(Object.entries(earlier.templates).filter(([name, hash]) => currentTemplates.get(name) === hash && !Object.hasOwn(templates, name))),
        ...declinedTemplates,
      },
    };
    const vaultId = await ensureVaultId(vault);
    const deps: Partial<SealDeps> = {
      confirmStaleReclaim: () => asker.confirm("seal-lock:reclaim", "An earlier seal did not finish and left its lock behind. Reclaim it and continue?"),
      ...input.sealDeps,
    };
    await sealContract({ vaultRealPath: await realpath(vault), vaultId, contract, baseSeq, declined }, root, deps);
    if (chosenFolder !== null) {
      const current = await readVaultSettings(vault);
      if (current !== null) await writeVaultSettings(vault, { ...current, templateFolder: chosenFolder });
    }
    return {
      state: "sealed",
      vaultIdCreated: settings === null,
      folders: Object.keys(folders ?? {}).length,
      properties: Object.keys(properties ?? {}).length,
      templates: Object.keys(templates),
      ...(removedTemplates.length === 0 ? {} : { removedTemplates }),
    };
  } catch (error: unknown) {
    if (error instanceof InterviewAborted) return { state: "aborted" };
    throw error;
  }
}

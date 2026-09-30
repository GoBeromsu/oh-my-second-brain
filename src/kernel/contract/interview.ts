import { lstat, readdir, realpath } from "node:fs/promises";
import { compareCodePoints, hashCanonical } from "../conventions/canonical.js";
import { readVaultSettings, type VaultSettings } from "../vault/settings.js";
import { normalizeFolderPath, verifyVaultPath } from "../vault/paths.js";
import { FIELD_TYPES, readObsidianTemplateFolder, readObsidianTypes } from "./obsidian.js";
import { looseningChanges, unsafePatternChanges, type LooseningChange } from "./loosening.js";
import { buildRedactor, hiddenValuesOf, publicTokensOf } from "./redact.js";
import { PATTERN_SOURCE_LIMIT, patternRefusal } from "./pattern.js";
import { currentSequence, NO_DECLINED, readDeclined, sealContract, storeRoot, type DeclinedSet, type SealDeps, type SequenceObservation } from "./store.js";
import { legacyTemplatesOf } from "./legacy.js";
import { readLiveTemplates } from "../write/live-templates.js";
import { LineageAppendFailed } from "./lineage.js";
import type {
  FieldType,
  FolderContract,
  JsonScalar,
  PropertyContract,
  Rule,
  VaultContract,
} from "./types.js";
import { ensureVaultId, resolveSealState, writeVaultSettings } from "./vault-id.js";

export { hasNestedQuantifier } from "./pattern.js";

/**
 * Deterministic seal-time questionnaire over the vault's two axes: top-level folders and
 * properties (the Obsidian property types). Templates are not contract: they scaffold new
 * notes from the template folder, so the interview records which folder that is and offers
 * the keys its templates set as properties, but never asks about or seals a template. No LLM asks anything and all IO is injected.
 * With a readable sealed contract, a rerun asks only about new folders and new properties
 * and keeps every existing answer (diff-only). Declined folders and properties are kept
 * beside the contract and not asked again until the caller asks to review them.
 */

export type Question =
  | { readonly id: string; readonly prompt: string; readonly kind: "choice"; readonly options: readonly string[] }
  | { readonly id: string; readonly prompt: string; readonly kind: "text"; readonly initial?: string }
  | { readonly id: string; readonly prompt: string; readonly kind: "confirm"; readonly initial?: boolean };

export interface InterviewIO {
  /**
   * The answer, or null when the question has no answer yet. An unanswered question is
   * collected and a fixed placeholder that opens no follow-up is used instead; such a
   * run ends `incomplete` and never seals.
   */
  ask(question: Question): Promise<string | null>;
  say(line: string): void;
  /** Optional: told each accepted answer, the proposal before the seal question, and the seal. */
  record?(event: InterviewRecord): Promise<void>;
}

export type InterviewRecord =
  /** A question put to the person (the terminal), not one answered from the log or a script. */
  | { readonly type: "asked"; readonly question: Question }
  | { readonly type: "answered"; readonly question: Question; readonly answer: string }
  /**
   * `digest` covers the contract the seal question is about; `baseSeq` is the sealed
   * generation the proposal was made against. `templateFolder` is the folder chosen in
   * this run, which the seal records in the settings; absent when the settings already
   * name one or none was chosen.
   */
  | {
    readonly type: "proposed";
    readonly digest: string;
    readonly baseSeq: SequenceObservation;
    readonly templateFolder?: string;
    /** How many templates an older generation sealed that this seal does not carry forward. */
    readonly droppedLegacyTemplates?: number;
  }
  | { readonly type: "sealed"; readonly vaultId: string };

/**
 * The digest of what the seal question proposes, as recorded in `proposed`. It covers the
 * folders and properties a seal stores; a version 3 generation stores no templates.
 */
export function proposalDigest(contract: VaultContract): string {
  return hashCanonical("oms-interview-proposal-v3", { contract: { folders: contract.folders, properties: contract.properties } });
}

export type InterviewResult =
  | {
    readonly state: "sealed";
    readonly vaultIdCreated: boolean;
    readonly folders: number;
    readonly properties: number;
    /**
     * The contract is sealed, but with something the caller should know: legacy templates
     * this seal did not carry forward, or a failure after the seal (such as logging it).
     */
    readonly warnings?: readonly string[];
  }
  | { readonly state: "refused"; readonly reasons: readonly string[] }
  | { readonly state: "aborted" }
  /** Some questions had no answer; they are listed in the order asked. Nothing was sealed. */
  | { readonly state: "incomplete"; readonly questions: readonly Question[] }
  /** A `nonLoosening` reseal would loosen the sealed contract. Changes name fields and kinds only. */
  | { readonly state: "loosening"; readonly changes: readonly LooseningChange[] };

/** Thrown by an IO (or after repeated invalid answers) to end the interview without sealing. */
export class InterviewAborted extends Error {
  constructor(message = "interview aborted") {
    super(message);
    this.name = "InterviewAborted";
  }
}

const RULE_CHOICES = ["none", "one-of-allowed", "must-equal", "pattern", "range"] as const;
const MAX_ATTEMPTS = 3;
export const SEAL_QUESTION = { id: "seal", prompt: "Seal this contract?", kind: "confirm" } as const satisfies Question;

/** A rejected answer; the question is asked again with this message. */
class Invalid {
  constructor(readonly error: string) {}
}

const invalid = (error: string): Invalid => new Invalid(error);

/**
 * Each call names the placeholder used when the IO has no answer yet. Placeholders open
 * no follow-up question, so answering one later only adds questions after it.
 */
class Asker {
  readonly unanswered: Question[] = [];

  constructor(private readonly io: InterviewIO) {}

  say(line: string): void {
    this.io.say(line);
  }

  private async loop<T>(question: Question, parse: (answer: string) => T | Invalid, placeholder: () => T): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const answer = await this.io.ask(question);
      if (answer === null) {
        this.unanswered.push(question);
        return placeholder();
      }
      const parsed = parse(answer);
      if (!(parsed instanceof Invalid)) {
        await this.io.record?.({ type: "answered", question, answer });
        return parsed;
      }
      this.io.say(`  ${parsed.error}`);
    }
    throw new InterviewAborted(`too many invalid answers to ${question.id}`);
  }

  choice<T extends string>(id: string, prompt: string, options: readonly T[], placeholder: T): Promise<T> {
    return this.loop({ id, prompt, kind: "choice", options }, answer => {
      const text = answer.trim();
      const index = /^\d+$/.test(text) ? Number(text) - 1 : -1;
      const found = options[index] ?? options.find(option => option.toLowerCase() === text.toLowerCase());
      return found ?? invalid(`Choose one of: ${options.join(", ")}.`);
    }, () => placeholder);
  }

  confirm(id: string, prompt: string, initial?: boolean, placeholder = initial ?? false): Promise<boolean> {
    const question: Question = initial === undefined ? { id, prompt, kind: "confirm" } : { id, prompt, kind: "confirm", initial };
    return this.loop(question, answer => {
      const text = answer.trim().toLowerCase();
      if (text === "" && initial !== undefined) return initial;
      if (text === "y" || text === "yes") return true;
      if (text === "n" || text === "no") return false;
      return invalid("Answer yes or no.");
    }, () => placeholder);
  }

  /** The placeholder is the parsed initial answer, or `placeholder` when that is not valid. */
  text<T = string>(
    id: string,
    prompt: string,
    initial: string | undefined,
    parse: (answer: string) => T | Invalid,
    placeholder?: T,
  ): Promise<T> {
    const question: Question = { id, prompt, kind: "text", ...(initial === undefined ? {} : { initial }) };
    return this.loop(question, answer => parse(answer.trim() !== "" ? answer.trim() : initial ?? ""), () => {
      const parsed = parse(initial ?? "");
      return parsed instanceof Invalid ? placeholder as T : parsed;
    });
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

async function askPattern(asker: Asker, id: string, name: string): Promise<Rule> {
  const regex = await asker.text(`${id}:pattern`, `Regular expression every \`${name}\` value must fully match`, undefined, raw => {
    const refusal = patternRefusal(raw);
    if (refusal === "empty") return invalid("Give a regular expression.");
    if (refusal === "too-long") return invalid(`Keep it to ${PATTERN_SOURCE_LIMIT} characters or fewer.`);
    if (refusal === "invalid") return invalid("That is not a valid regular expression.");
    return refusal === "nested" ? invalid("Nested repetition such as (a+)+ or (a|b)* can hang the check; rewrite it without repeating a repeated group.") : raw;
  }, "");
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
    const before = asker.unanswered.length;
    const min = await asker.text(`${id}:range-min`, `Lowest allowed \`${name}\` (empty for none)`, undefined, bound);
    const max = await asker.text(`${id}:range-max`, `Highest allowed \`${name}\` (empty for none)`, undefined, bound);
    if (asker.unanswered.length > before) return { kind: "range" };
    if (min === undefined && max === undefined) asker.say("  Give at least one bound.");
    else if (min !== undefined && max !== undefined && min > max) asker.say("  The lowest value is above the highest; give the range again.");
    else return { kind: "range", ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  }
  throw new InterviewAborted(`too many invalid answers to ${id}:range`);
}

async function askRules(asker: Asker, id: string, name: string, type: FieldType): Promise<Rule[]> {
  const choice = await asker.choice(`${id}:rule`, `Hidden rule for \`${name}\``, RULE_CHOICES, "none");
  if (choice === "one-of-allowed") {
    return [{ kind: "allowed", values: await asker.text(`${id}:allowed`, `Allowed values for \`${name}\` (comma separated)`, undefined, raw => parseValues(type, raw), []) }];
  }
  if (choice === "must-equal") {
    return [{ kind: "fixed", value: await asker.text(`${id}:fixed`, `Value \`${name}\` must have`, undefined, raw => raw === "" ? invalid("Give a value.") : coerce(type, raw), "") }];
  }
  if (choice === "pattern") return [await askPattern(asker, id, name)];
  if (choice === "range") return [await askRange(asker, id, name, type)];
  return [];
}

interface Discovered {
  readonly folders: readonly string[];
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

const TEMPLATE_VALUE = /^\s*(?:"[^"]*"|'[^']*'|[^:]*?)\s*:[ \t]*(.*)$/;
const DATE_VALUE = /^(?:\d{4}-\d{2}-\d{2}|\{\{\s*date(?::\s*YYYY-MM-DD\s*)?\s*\}\})$/;
const DATETIME_VALUE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?|\{\{\s*date:\s*YYYY-MM-DDTHH:mm(?::ss)?\s*\}\})$/;

/** The type a template's `key: value` text clearly has: a list, a date or a datetime; text otherwise. */
export function templateFieldType(text: string): FieldType {
  const [first = "", ...rest] = text.split(/\r?\n/);
  const raw = TEMPLATE_VALUE.exec(first)?.[1]?.trim() ?? "";
  if (raw === "" && rest.length > 0 && rest.every(line => line.trim().startsWith("-"))) return "list";
  if (raw.startsWith("[") && raw.endsWith("]")) return "list";
  const value = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
  if (DATE_VALUE.test(value)) return "date";
  if (DATETIME_VALUE.test(value)) return "datetime";
  return "text";
}

/**
 * The folders and properties the seal questions are built from: the Obsidian property types,
 * then the keys the live templates set. Obsidian's type wins; otherwise the type the template
 * values clearly share (list, date or datetime), and text when they disagree or say nothing.
 */
async function discover(vault: string, templateFolder: string | undefined): Promise<Discovered | { readonly refused: string[] }> {
  const observedTypes = new Map<string, FieldType>();
  try {
    for (const [name, type] of Object.entries(await readObsidianTypes(vault))) observedTypes.set(name, type);
  } catch {
    return { refused: ["The Obsidian property types file is unreadable; fix it in Obsidian first."] };
  }
  const templates = templateFolder === undefined ? [] : await readLiveTemplates(vault, templateFolder);
  const inferred = new Map<string, FieldType>();
  for (const field of templates.flatMap(template => template.fields)) {
    if (observedTypes.has(field.name)) continue;
    const type = templateFieldType(field.text);
    const seen = inferred.get(field.name);
    inferred.set(field.name, seen === undefined || seen === type ? type : "text");
  }
  for (const [name, type] of inferred) observedTypes.set(name, type);
  return { folders: await topLevelFolders(vault), observedTypes };
}

/** A vault-relative folder that exists, stays inside the vault and is not hidden; null otherwise. */
export async function usableFolder(vault: string, raw: string): Promise<string | null> {
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
    const required = await asker.confirm(`${id}:required`, `Must every note have \`${name}\`?`, undefined, true);
    const fallback = required ? false : await asker.confirm(`${id}:default`, `When a note leaves \`${name}\` out, should the write pass and report it as missing?`);
    const rules = await askRules(asker, id, name, type);
    const meaning = await asker.text(`${id}:meaning`, `What does \`${name}\` mean? (agents see this; never include a hidden value)`, "", oneLine);
    result[name] = { meaning, type, default: fallback, required, rules };
  }
  return Object.keys(result).length === 0 ? null : result;
}

function unsafePattern(rule: Rule): boolean {
  return rule.kind === "pattern" && patternRefusal(rule.regex) !== null;
}

/**
 * A sealed pattern the seal screen now refuses (an older release sealed it) fails every
 * value, so the owner answers that property's rule again and its other rules are kept.
 * Prompts name the field only, never the sealed pattern.
 */
async function askUnsafePatterns(asker: Asker, properties: Record<string, PropertyContract> | null): Promise<void> {
  for (const [name, property] of Object.entries(properties ?? {}).sort(([left], [right]) => compareCodePoints(left, right))) {
    if (!property.rules.some(unsafePattern)) continue;
    asker.say(`The sealed pattern rule for \`${name}\` is no longer accepted; answer its rule again (its other rules are kept).`);
    const rules = [...property.rules.filter(rule => !unsafePattern(rule)), ...await askRules(asker, `property:${name}:repair`, name, property.type)];
    properties![name] = { ...property, rules };
  }
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
  /** Ask again about folders and properties declined at an earlier seal. */
  readonly reask?: boolean;
  /**
   * Answers that did not come from the owner at a terminal: only a first seal or a
   * reseal that adds or tightens is allowed. Loosening stays with the terminal interview.
   */
  readonly nonLoosening?: boolean;
}): Promise<InterviewResult> {
  const { vault, io } = input;
  const root = input.root ?? storeRoot();
  const asker = new Asker(io);
  try {
    const state = await resolveSealState(vault, root);
    if (state.row === "vault-id-tampered") {
      throw new Error("CONTRACT_VAULT_ID_TAMPERED: the vault id in .oms/settings.json does not match the id this vault was sealed with; restore the original .oms/settings.json or run `oms doctor contract`");
    }
    if (state.shared) {
      throw new Error("CONTRACT_VAULT_ID_SHARED: another existing vault uses this vault id (a copied vault); remove .oms/settings.json in the copy, then run `oms interview` again");
    }
    // A first seal on this machine (no store yet) or a reseal of a readable seal; every recovery row stays with the terminal.
    const firstOrReseal = state.row === "never-sealed" || state.row === "synced-second-machine" || (state.row === "sealed" && state.view.state === "sealed");
    if (input.nonLoosening === true && !firstOrReseal) {
      return { state: "refused", reasons: ["The seal needs recovery first; run `oms doctor contract`, then run `oms interview` yourself in a terminal."] };
    }
    let settings: VaultSettings | null;
    try {
      settings = await readVaultSettings(vault);
    } catch {
      return { state: "refused", reasons: ["The vault settings are unreadable; run `oms doctor contract`."] };
    }
    const baseSeq = state.vaultId === null ? "none" : await currentSequence(state.vaultId, root);
    const previous = state.view.state === "sealed" ? state.view.contract : null;
    // An older generation may carry templates; they are not contract and are not carried forward.
    const legacyTemplates = Object.keys(legacyTemplatesOf(state.view)).length;
    // A sealed pattern refused by today's seal screen can only be replaced, which is looser.
    const unsafe = input.nonLoosening === true && previous !== null ? unsafePatternChanges(previous) : [];
    if (unsafe.length > 0) return { state: "loosening", changes: unsafe };
    const pickFolder = settings?.templateFolder === undefined && (previous === null || input.reask === true);
    const chosenFolder = pickFolder ? await askTemplateFolder(asker, vault) : null;
    const found = await discover(vault, settings?.templateFolder ?? chosenFolder ?? undefined);
    if ("refused" in found) return { state: "refused", reasons: found.refused };

    const earlier: DeclinedSet = input.reask === true || state.vaultId === null ? NO_DECLINED : await readDeclined(state.vaultId, root);
    const newFolders = found.folders.filter(folder => !Object.hasOwn(previous?.folders ?? {}, folder));
    const newProperties = new Map([...found.observedTypes].filter(([name]) => !Object.hasOwn(previous?.properties ?? {}, name)));
    const askFolderList = newFolders.filter(folder => !earlier.folders.includes(folder));
    const askPropertyMap = new Map([...newProperties].filter(([name]) => !earlier.properties.includes(name)));
    if (previous !== null) {
      io.say(askFolderList.length + askPropertyMap.size === 0
        ? "Nothing new since the last seal; existing answers are kept."
        : "Asking only about what is new since the last seal; existing answers are kept.");
    }
    const skipped = newFolders.length - askFolderList.length + newProperties.size - askPropertyMap.size;
    if (skipped > 0) io.say(`Skipping ${skipped} item(s) declined at an earlier seal; run \`oms setup --reask\` to answer them again.`);

    const askedFolders = await askFolders(asker, askFolderList);
    const askedProperties = await askProperties(asker, askPropertyMap);
    const folders = merge(previous?.folders ?? null, askedFolders);
    const properties = merge(previous?.properties ?? null, askedProperties);
    await askUnsafePatterns(asker, properties);
    if (asker.unanswered.length > 0) return { state: "incomplete", questions: [...asker.unanswered, SEAL_QUESTION] };
    const contract: VaultContract = { folders, properties };
    const reasons = sealGuard(contract);
    if (reasons.length > 0) return { state: "refused", reasons };
    if (input.nonLoosening === true && previous !== null) {
      const changes = looseningChanges(previous, contract);
      if (changes.length > 0) return { state: "loosening", changes };
    }
    const notices = legacyTemplates === 0
      ? []
      : [`CONTRACT_LEGACY_TEMPLATES_DROPPED: ${legacyTemplates} template(s) sealed by an older generation are not carried forward; templates now scaffold new notes from the template folder and are never judged`];

    preview(io, contract);
    for (const notice of notices) io.say(notice);
    await io.record?.({
      type: "proposed",
      digest: proposalDigest(contract),
      baseSeq,
      ...(chosenFolder === null ? {} : { templateFolder: chosenFolder }),
      ...(legacyTemplates === 0 ? {} : { droppedLegacyTemplates: legacyTemplates }),
    });
    const seal = await asker.confirm(SEAL_QUESTION.id, SEAL_QUESTION.prompt);
    if (asker.unanswered.length > 0) return { state: "incomplete", questions: asker.unanswered };
    if (!seal) return { state: "aborted" };

    const declined: DeclinedSet = {
      folders: [
        ...earlier.folders.filter(folder => found.folders.includes(folder) && !Object.hasOwn(folders ?? {}, folder)),
        ...askFolderList.filter(folder => !Object.hasOwn(askedFolders ?? {}, folder)),
      ],
      properties: [
        ...earlier.properties.filter(name => found.observedTypes.has(name) && !Object.hasOwn(properties ?? {}, name)),
        ...[...askPropertyMap.keys()].filter(name => !Object.hasOwn(askedProperties ?? {}, name)),
      ],
    };
    const vaultId = await ensureVaultId(vault);
    const deps: Partial<SealDeps> = {
      confirmStaleReclaim: () => asker.confirm("seal-lock:reclaim", "An earlier seal did not finish and left its lock behind. Reclaim it and continue?"),
      ...input.sealDeps,
    };
    const recordTemplateFolder = async (): Promise<void> => {
      if (chosenFolder === null) return;
      const current = await readVaultSettings(vault);
      if (current !== null) await writeVaultSettings(vault, { ...current, templateFolder: chosenFolder });
    };
    try {
      await sealContract({
        vaultRealPath: await realpath(vault),
        vaultId,
        contract,
        baseSeq,
        declined,
      }, root, deps);
    } catch (error: unknown) {
      // The generation is linked even though its lineage event is not: settle the settings
      // the seal was built from, so `oms doctor lineage-recover` alone completes it.
      // Swallowed: the append failure (whose `cause` is already the append error) is what the
      // caller must act on, and lineage-recover completes the seal without the template folder.
      if (error instanceof LineageAppendFailed) await recordTemplateFolder().catch(() => undefined);
      throw error;
    }
    await recordTemplateFolder();
    // The contract is sealed by now: a failure to log that is a warning, not a failed seal.
    const warnings: string[] = [...notices];
    try {
      await io.record?.({ type: "sealed", vaultId });
    } catch (error: unknown) {
      warnings.push(`INTERVIEW_LOG_UNRECORDED: the seal was not logged (${error instanceof Error ? error.message : String(error)})`);
    }
    return {
      state: "sealed",
      vaultIdCreated: settings === null,
      folders: Object.keys(folders ?? {}).length,
      properties: Object.keys(properties ?? {}).length,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  } catch (error: unknown) {
    if (error instanceof InterviewAborted) return { state: "aborted" };
    throw error;
  }
}

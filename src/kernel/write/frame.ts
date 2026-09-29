import { compareCodePoints } from "../conventions/canonical.js";
import { normalizePath } from "../contract/judge.js";
import { buildRedactor, hiddenValuesOf, publicTokensOf, REDACTED, redactResponse, type Redactor } from "../contract/redact.js";
import type { ContractView, FieldType, JsonScalar, Rule, VaultContract } from "../contract/types.js";
import type { LiveTemplate } from "./live-templates.js";

/**
 * The frame an agent writes into: what the target folder and each property mean, the
 * live template that will scaffold the note, and the allowed values. Every string and every allowed
 * value passes the redactor, so a hidden sealed value never leaves as itself.
 */

export interface FrameProperty {
  readonly name: string;
  readonly meaning: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly default: boolean;
  /** True when any rule constrains the value; the rule itself is never shown. */
  readonly constrained: boolean;
  /** The allowed values, or null when the property has no allowed-list rule. */
  readonly allowed: readonly JsonScalar[] | null;
}

/** A preview of the scaffold: what the template adds, never what the judge requires. */
export interface FrameTemplate {
  readonly name: string;
  readonly source: string;
  /** The frontmatter keys the template fills as defaults. */
  readonly properties: readonly string[];
  readonly headings: readonly string[];
}

export interface WriteFrame {
  readonly contract: ContractView["state"];
  readonly folder: { readonly path: string; readonly meaning: string } | null;
  readonly properties: readonly FrameProperty[];
  readonly template: FrameTemplate | null;
  /** Properties that may be absent; the write passes and reports them in `missingDefaults`. */
  readonly defaults: readonly string[];
}

export interface FrameOptions {
  /** Vault-relative folder the note goes into. */
  readonly folder?: string | undefined;
  /** The live template that scaffolds the note (`selectTemplate`). */
  readonly scaffold?: LiveTemplate | undefined;
}

function emptyFrame(state: ContractView["state"]): WriteFrame {
  return { contract: state, folder: null, properties: [], template: null, defaults: [] };
}

/** Nearest registered folder at or above `folder`; the vault root is never registered. */
function nearestFolder(contract: VaultContract, folder: string | undefined): WriteFrame["folder"] {
  if (contract.folders === null || folder === undefined) return null;
  const parts = normalizePath(folder).split("/").filter(part => part !== "" && part !== ".");
  for (let length = parts.length; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join("/");
    if (Object.hasOwn(contract.folders, candidate)) return { path: candidate, meaning: contract.folders[candidate]!.meaning };
  }
  return null;
}

function allowedValues(rules: readonly Rule[]): readonly JsonScalar[] | null {
  const rule = rules.find(candidate => candidate.kind === "allowed");
  return rule === undefined || rule.kind !== "allowed" ? null : rule.values;
}

/** Numbers are not reached by `redactResponse`, so each allowed value is checked as text. */
function redactValue(value: JsonScalar, redactor: Redactor): JsonScalar {
  if (typeof value !== "string" && typeof value !== "number") return value;
  return redactor(String(value)) === String(value) ? value : REDACTED;
}

/** Only the property contract makes a property required; a template never does. */
function frameProperties(contract: VaultContract, redactor: Redactor): FrameProperty[] {
  const entries = Object.entries(contract.properties ?? {}).sort(([left], [right]) => compareCodePoints(left, right));
  return entries.map(([name, property]) => {
    const allowed = allowedValues(property.rules);
    return {
      name,
      meaning: property.meaning,
      type: property.type,
      required: property.required,
      default: property.default,
      constrained: property.rules.length > 0,
      allowed: allowed === null ? null : allowed.map(value => redactValue(value, redactor)),
    };
  });
}

export function frameFor(view: ContractView, options: FrameOptions = {}): WriteFrame {
  if (view.state !== "sealed") return emptyFrame(view.state);
  const contract = view.contract;
  const template = options.scaffold;
  const redactor = buildRedactor(hiddenValuesOf(contract), { publicTokens: publicTokensOf(contract) });
  const properties = frameProperties(contract, redactor);
  const frame: WriteFrame = {
    contract: "sealed",
    folder: nearestFolder(contract, options.folder),
    properties,
    template: template === undefined ? null : {
      name: template.name,
      source: template.source,
      properties: template.fields.map(field => field.name),
      headings: template.headings.map(heading => heading.title),
    },
    defaults: properties.filter(property => property.default && !property.required).map(property => property.name),
  };
  return redactResponse(frame, redactor);
}

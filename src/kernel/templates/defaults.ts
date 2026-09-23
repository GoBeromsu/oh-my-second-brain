import { contractDigest, effectiveHeadingOrder, parseTemplatePolicy, validateTemplateId } from "./policy.js";
import type {
  ApprovedLayerBytes,
  ContractLayer,
  HeadingContract,
  JsonValue,
  LayerFieldRef,
  PropertyDefinition,
  ResolvedContract,
  ResolvedField,
  ResolvedHeading,
} from "./types.js";

/**
 * Composes one approved version 4 policy into the contract for a single note.
 * `templateId` null uses the default layer only. A string adds that one template.
 * Nothing in the approved markdown is executed or inferred: no tokens, dates, or headings.
 */
export function composeTemplateContract(
  policy: string | unknown,
  templateId: string | null,
  placement?: JsonValue | null,
): ResolvedContract {
  const parsed = parseTemplatePolicy(policy);
  const placementValue = placement ?? null;
  const digest = contractDigest(parsed, templateId, placementValue);
  const id = templateId === null ? null : validateTemplateId(templateId);
  const template = id === null ? undefined : parsed.templates[id];
  if (id !== null && template === undefined) {
    throw new Error(`TEMPLATE_POLICY_INVALID: template ${id} is not registered`);
  }
  const headingOrder = effectiveHeadingOrder(parsed.default, template ?? null);
  const approved: ResolvedContract["approved"] = {
    defaultLayer: approvedLayer(parsed.default),
    ...(template === undefined ? {} : { templateLayer: approvedLayer(template) }),
  };
  return {
    templateId: id,
    headingOrder,
    fields: composeFields(parsed.properties, parsed.default.fields, template?.fields),
    headings: [
      ...parsed.default.headings.map(heading => resolveHeading(heading, "default")),
      ...(template === undefined ? [] : template.headings.map(heading => resolveHeading(heading, "template"))),
    ],
    semanticCriteria: [
      ...parsed.default.semanticCriteria,
      ...(template === undefined ? [] : template.semanticCriteria),
    ],
    approved,
    contractDigest: digest,
  };
}

function approvedLayer(layer: ContractLayer): ApprovedLayerBytes {
  return {
    templatePath: layer.templatePath,
    approvedMarkdown: layer.approvedMarkdown,
    approvedMarkdownDigest: layer.approvedMarkdownDigest,
  };
}

function poolDefinition(pool: Readonly<Record<string, PropertyDefinition>>, name: string): PropertyDefinition {
  const definition = pool[name];
  if (definition === undefined) {
    throw new Error(`TEMPLATE_POLICY_DANGLING_FIELD: referenced property ${name} is not in the pool`);
  }
  return definition;
}

function composeFields(
  pool: Readonly<Record<string, PropertyDefinition>>,
  base: Readonly<Record<string, LayerFieldRef>>,
  extra: Readonly<Record<string, LayerFieldRef>> | undefined,
): Readonly<Record<string, ResolvedField>> {
  const names = [
    ...Object.keys(base),
    ...Object.keys(extra ?? {}).filter(name => !Object.hasOwn(base, name)),
  ];
  const fields: Record<string, ResolvedField> = Object.create(null);
  for (const name of names) {
    const definition = poolDefinition(pool, name);
    const parent = base[name];
    const child = extra?.[name];
    const allowedValues = child?.allowedValues ?? parent?.allowedValues ?? definition.allowedValues;
    fields[name] = {
      property: name,
      type: definition.type,
      intent: definition.intent,
      required: parent?.required === true || child?.required === true,
      ...(allowedValues === undefined ? {} : { allowedValues }),
      ...(definition.format === undefined ? {} : { format: definition.format }),
    };
  }
  return fields;
}

function resolveHeading(heading: HeadingContract, origin: ResolvedHeading["origin"]): ResolvedHeading {
  return {
    headingId: heading.headingId,
    title: heading.title,
    level: heading.level,
    required: true,
    ...(heading.extensions === undefined ? {} : { extensions: heading.extensions }),
    origin,
  };
}

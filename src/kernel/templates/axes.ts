import type { FieldNormalize, GlobalAxis, JsonValue, ObsidianContractType, ResolvedConvention, RetrievalView, TemplateId } from "./types.js";

export interface TemplateIdentityAxis {
  readonly kind: "field";
  readonly key: "template";
  readonly type: "string";
  readonly templateId: TemplateId;
}

export interface TemplateFieldAxis {
  readonly kind: "field";
  readonly key: string;
  readonly type: ObsidianContractType;
  readonly templateId: TemplateId;
  readonly intent?: string;
  readonly allowedValues?: readonly string[];
  readonly normalize?: FieldNormalize;
}

export type SearchableAxis = TemplateIdentityAxis | TemplateFieldAxis | GlobalAxis;

export interface TemplateAxisSet {
  readonly templateId: TemplateId;
  readonly axes: readonly (TemplateIdentityAxis | TemplateFieldAxis)[];
  readonly views: readonly RetrievalView[];
}

export interface TemplateRetrievalAxes {
  readonly templates: readonly TemplateAxisSet[];
  readonly globalAxes: readonly GlobalAxis[];
}

function fail(message: string): never { throw new Error(`TEMPLATE_AXIS_UNDECLARED_FIELD: ${message}`); }
function fieldOrder(keyOrder: readonly string[], fields: Readonly<Record<string, unknown>>): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of keyOrder) {
    if (Object.hasOwn(fields, key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return [...ordered, ...Object.keys(fields).filter(key => !seen.has(key)).sort((a, b) => a.localeCompare(b))];
}

/** Derives retrieval metadata only; it does not read or alter vault state. */
export function deriveTemplateRetrievalAxes(convention: ResolvedConvention): TemplateRetrievalAxes {
  const templates = Object.values(convention.templates)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(template => {
      const axes: (TemplateIdentityAxis | TemplateFieldAxis)[] = [{ kind: "field", key: "template", type: "string", templateId: template.id }];
      for (const key of fieldOrder(template.keyOrder, template.fields)) {
        const field = template.fields[key];
        if (field === undefined || field.type === undefined) fail(`${template.id}:${key}`);
        axes.push({
          kind: "field",
          key,
          type: field.type,
          templateId: template.id,
          ...(field.intent === undefined ? {} : { intent: field.intent }),
          ...(field.allowedValues === undefined ? {} : { allowedValues: field.allowedValues }),
          ...(field.normalize === undefined ? {} : { normalize: field.normalize }),
        });
      }
      for (const view of template.views) {
        for (const key of view.keys) if (!Object.hasOwn(template.fields, key)) fail(`${template.id}:view:${view.name}:${key}`);
      }
      return { templateId: template.id, axes, views: template.views.map(view => ({ ...view, keys: [...view.keys] })) };
    });
  return { templates, globalAxes: Object.values(convention.globalAxes) };
}

export function axisValueEquals(left: JsonValue | undefined, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

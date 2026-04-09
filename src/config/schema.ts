import * as path from "node:path";
import type {
  GuidelineDomainMap,
  GuidelineRequirement,
  ManagedPluginConfig,
  OmsbConfig,
  RoutingConfig,
} from "../rules/types.js";

const VALID_SEVERITIES = ["block", "deny", "advisory"] as const;
const VALID_GUIDELINE_REQUIREMENTS = ["folder", "frontmatter"] as const;
type Severity = (typeof VALID_SEVERITIES)[number];

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertString(v: unknown, path: string): string {
  if (!isString(v)) throw new Error(`omsb config: "${path}" must be a string, got ${typeof v}`);
  return v;
}

function assertStringArray(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || !v.every(isString)) {
    throw new Error(`omsb config: "${path}" must be an array of strings`);
  }
  return v as string[];
}

function assertSeverity(v: unknown, path: string): Severity {
  if (!VALID_SEVERITIES.includes(v as Severity)) {
    throw new Error(
      `omsb config: "${path}" must be one of ${VALID_SEVERITIES.join(", ")}, got "${v}"`
    );
  }
  return v as Severity;
}

function assertGuidelineRequirementArray(
  v: unknown,
  path: string,
): GuidelineRequirement[] {
  if (
    !Array.isArray(v) ||
    !v.every(
      (item) =>
        typeof item === "string" &&
        VALID_GUIDELINE_REQUIREMENTS.includes(item as GuidelineRequirement),
    )
  ) {
    throw new Error(
      `omsb config: "${path}" must be an array containing only ${VALID_GUIDELINE_REQUIREMENTS.join(", ")}`,
    );
  }
  return v as GuidelineRequirement[];
}

function validateEnforcement(
  raw: unknown
): OmsbConfig["enforcement"] {
  if (!isObject(raw)) throw new Error(`omsb config: "enforcement" must be an object`);
  return {
    raw_boundary: assertSeverity(raw["raw_boundary"], "enforcement.raw_boundary"),
    frontmatter: assertSeverity(raw["frontmatter"], "enforcement.frontmatter"),
    naming: assertSeverity(raw["naming"], "enforcement.naming"),
  };
}

function validateGuidelines(raw: unknown): OmsbConfig["guidelines"] {
  if (!isObject(raw)) throw new Error(`omsb config: "guidelines" must be an object`);
  const guidelines: OmsbConfig["guidelines"] = {
    root: assertString(raw["root"], "guidelines.root"),
    files: assertStringArray(raw["files"], "guidelines.files"),
  };
  if (raw["required"] !== undefined) {
    guidelines.required = assertGuidelineRequirementArray(
      raw["required"],
      "guidelines.required",
    );
  }
  if (raw["domains"] !== undefined) {
    if (!isObject(raw["domains"])) {
      throw new Error(`omsb config: "guidelines.domains" must be an object`);
    }
    const domains: GuidelineDomainMap = {};
    for (const [key, value] of Object.entries(raw["domains"])) {
      if (!VALID_GUIDELINE_REQUIREMENTS.includes(key as GuidelineRequirement)) {
        throw new Error(
          `omsb config: "guidelines.domains.${key}" must be one of ${VALID_GUIDELINE_REQUIREMENTS.join(", ")}`,
        );
      }
      domains[key as GuidelineRequirement] = assertString(
        value,
        `guidelines.domains.${key}`,
      );
    }
    guidelines.domains = domains;
  }
  return guidelines;
}

function validateRules(raw: unknown): OmsbConfig["rules"] {
  if (!isObject(raw)) throw new Error(`omsb config: "rules" must be an object`);

  const result: OmsbConfig["rules"] = {
    raw_paths: assertStringArray(raw["raw_paths"], "rules.raw_paths"),
  };

  // raw_path_exceptions (optional)
  if (raw["raw_path_exceptions"] !== undefined) {
    if (!isObject(raw["raw_path_exceptions"])) {
      throw new Error(`omsb config: "rules.raw_path_exceptions" must be an object`);
    }
    const exc = raw["raw_path_exceptions"];
    result.raw_path_exceptions = {};
    if (exc["allowed_fields"] !== undefined) {
      result.raw_path_exceptions.allowed_fields = assertStringArray(
        exc["allowed_fields"],
        "rules.raw_path_exceptions.allowed_fields"
      );
    }
    if (exc["allowed_ops"] !== undefined) {
      result.raw_path_exceptions.allowed_ops = assertStringArray(
        exc["allowed_ops"],
        "rules.raw_path_exceptions.allowed_ops"
      );
    }
  }

  // frontmatter_required (optional)
  if (raw["frontmatter_required"] !== undefined) {
    result.frontmatter_required = assertStringArray(
      raw["frontmatter_required"],
      "rules.frontmatter_required"
    );
  }

  // frontmatter_values (optional)
  if (raw["frontmatter_values"] !== undefined) {
    if (!isObject(raw["frontmatter_values"])) {
      throw new Error(`omsb config: "rules.frontmatter_values" must be an object`);
    }
    const fv: OmsbConfig["rules"]["frontmatter_values"] = {};
    for (const [field, spec] of Object.entries(raw["frontmatter_values"])) {
      if (!isObject(spec)) {
        throw new Error(`omsb config: "rules.frontmatter_values.${field}" must be an object`);
      }
      fv[field] = {};
      if (spec["enum"] !== undefined) {
        fv[field].enum = assertStringArray(spec["enum"], `rules.frontmatter_values.${field}.enum`);
      }
      if (spec["format"] !== undefined) {
        fv[field].format = assertString(spec["format"], `rules.frontmatter_values.${field}.format`);
      }
      if (spec["case"] !== undefined) {
        fv[field].case = assertString(spec["case"], `rules.frontmatter_values.${field}.case`);
      }
      if (spec["no_spaces"] !== undefined) {
        if (typeof spec["no_spaces"] !== "boolean") {
          throw new Error(
            `omsb config: "rules.frontmatter_values.${field}.no_spaces" must be a boolean`
          );
        }
        fv[field].no_spaces = spec["no_spaces"];
      }
    }
    result.frontmatter_values = fv;
  }

  // naming_conventions (optional)
  if (raw["naming_conventions"] !== undefined) {
    if (!isObject(raw["naming_conventions"])) {
      throw new Error(`omsb config: "rules.naming_conventions" must be an object`);
    }
    const nc: OmsbConfig["rules"]["naming_conventions"] = {};
    for (const [key, spec] of Object.entries(raw["naming_conventions"])) {
      if (!isObject(spec)) {
        throw new Error(`omsb config: "rules.naming_conventions.${key}" must be an object`);
      }
      nc[key] = {
        pattern: assertString(spec["pattern"], `rules.naming_conventions.${key}.pattern`),
      };
    }
    result.naming_conventions = nc;
  }

  return result;
}

function validateAuthorship(raw: unknown): OmsbConfig["authorship"] {
  if (!isObject(raw)) throw new Error(`omsb config: "authorship" must be an object`);
  if (typeof raw["enabled"] !== "boolean") {
    throw new Error(`omsb config: "authorship.enabled" must be a boolean`);
  }
  return {
    enabled: raw["enabled"],
    agent_name: assertString(raw["agent_name"], "authorship.agent_name"),
    created_by_field: assertString(raw["created_by_field"], "authorship.created_by_field"),
    modified_by_field: assertString(raw["modified_by_field"], "authorship.modified_by_field"),
  };
}

function validateRouting(raw: unknown): RoutingConfig {
  if (!isObject(raw)) throw new Error(`omsb config: "routing" must be an object`);

  const routing: RoutingConfig = {};
  if (raw["inbox_fallback"] !== undefined) {
    routing.inbox_fallback = assertString(
      raw["inbox_fallback"],
      "routing.inbox_fallback",
    );
  }

  if (raw["note_targets"] !== undefined) {
    if (!isObject(raw["note_targets"])) {
      throw new Error(`omsb config: "routing.note_targets" must be an object`);
    }
    const noteTargets: Record<string, string[]> = {};
    for (const [kind, value] of Object.entries(raw["note_targets"])) {
      noteTargets[kind] = assertStringArray(
        value,
        `routing.note_targets.${kind}`,
      );
    }
    routing.note_targets = noteTargets;
  }

  return routing;
}

function validateManagedPlugins(raw: unknown): ManagedPluginConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error(`omsb config: "managed_plugins" must be an array`);
  }
  return raw.map((entry, index) => {
    if (!isObject(entry)) {
      throw new Error(`omsb config: "managed_plugins[${index}]" must be an object`);
    }
    const id = assertString(entry["id"], `managed_plugins[${index}].id`);
    const dataJsonPath =
      entry["data_json_path"] === undefined
        ? undefined
        : assertString(
            entry["data_json_path"],
            `managed_plugins[${index}].data_json_path`,
          );

    if (dataJsonPath !== undefined) {
      if (path.isAbsolute(dataJsonPath)) {
        throw new Error(
          `omsb config: "managed_plugins[${index}].data_json_path" must be vault-relative`,
        );
      }

      const normalized = dataJsonPath.replace(/\\/g, "/");
      const expectedPrefix = `.obsidian/plugins/${id}/`;
      if (!normalized.startsWith(expectedPrefix) || !normalized.endsWith("/data.json")) {
        throw new Error(
          `omsb config: "managed_plugins[${index}].data_json_path" must point to ${expectedPrefix}data.json`,
        );
      }
    }

    return {
      id,
      data_json_path: dataJsonPath,
    };
  });
}

function validateCompile(raw: unknown): NonNullable<OmsbConfig["compile"]> {
  if (!isObject(raw)) throw new Error(`omsb config: "compile" must be an object`);

  if (!isObject(raw["outputs"])) {
    throw new Error(`omsb config: "compile.outputs" must be an object`);
  }

  const outputsRaw = raw["outputs"];
  const outputs: NonNullable<OmsbConfig["compile"]>["outputs"] = {};

  if (outputsRaw["wiki"] !== undefined) {
    outputs.wiki = assertString(outputsRaw["wiki"], "compile.outputs.wiki");
  }

  if (outputsRaw["article"] !== undefined) {
    outputs.article = assertString(outputsRaw["article"], "compile.outputs.article");
  }

  return {
    sources: assertStringArray(raw["sources"], "compile.sources"),
    terminology_dir:
      raw["terminology_dir"] === undefined
        ? undefined
        : assertString(raw["terminology_dir"], "compile.terminology_dir"),
    outputs,
  };
}

/**
 * Validate raw parsed JSON against the OmsbConfig shape.
 * Throws a descriptive error if any required field is missing or has the wrong type.
 */
export function validateConfig(data: unknown): OmsbConfig {
  if (!isObject(data)) {
    throw new Error("omsb config: root value must be a JSON object");
  }

  if (data["version"] !== 1) {
    throw new Error(`omsb config: "version" must be 1, got ${JSON.stringify(data["version"])}`);
  }

  const config: OmsbConfig = {
    version: 1,
    vault_path: assertString(data["vault_path"], "vault_path"),
    vault_name: assertString(data["vault_name"], "vault_name"),
    guidelines: validateGuidelines(data["guidelines"]),
    rules: validateRules(data["rules"]),
    enforcement: validateEnforcement(data["enforcement"]),
  };

  if (data["authorship"] !== undefined) {
    config.authorship = validateAuthorship(data["authorship"]);
  }

  if (data["routing"] !== undefined) {
    config.routing = validateRouting(data["routing"]);
  }

  if (data["managed_plugins"] !== undefined) {
    config.managed_plugins = validateManagedPlugins(data["managed_plugins"]);
  }

  if (data["compile"] !== undefined) {
    config.compile = validateCompile(data["compile"]);
  }

  return config;
}

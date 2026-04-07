import type { OmsbConfig } from "../rules/types.js";

const VALID_SEVERITIES = ["block", "deny", "advisory"] as const;
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
  return {
    root: assertString(raw["root"], "guidelines.root"),
    files: assertStringArray(raw["files"], "guidelines.files"),
  };
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

  return config;
}

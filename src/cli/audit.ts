import {
  collectObservedFields,
  collectObservedFieldValues,
  type ObservedField,
  type ObservedFieldValueDrift,
} from "../setup/axis.js";
import { lintVault, type VaultLintViolation } from "../engine/conventions/vault-lint.js";
import { resolveActiveOntology } from "../ontology/active.js";
import type { Ontology } from "../core/ontology/types.js";

/** Fields observed in a folder that its bound concept(s) do not declare. */
function undeclaredObservedFields(
  ontology: Ontology,
  summary: { readonly folder: string; readonly fields: readonly ObservedField[] },
): ObservedField[] {
  const binding = ontology.taxonomy.folders[summary.folder];
  if (!binding || binding.concept === null) return [...summary.fields];
  const conceptNames = Array.isArray(binding.concept) ? binding.concept : [binding.concept];
  const declared = new Set<string>();
  for (const name of conceptNames) {
    const concept = ontology.concepts.get(name);
    if (!concept) continue;
    for (const field of concept.fields) declared.add(field.name);
  }
  return summary.fields.filter((field) => !declared.has(field.name));
}


export async function runAudit(opts: {
  readonly vault: string;
  readonly json?: boolean;
  readonly folder?: string;
  readonly suggestFields?: boolean;
}): Promise<number> {
  const { vault, json = false, folder, suggestFields = false } = opts;

  try {
    const { ontology } = await resolveActiveOntology(vault);
    const report = await lintVault(vault, ontology, { folder });

    let suggestedFields: Array<{ folder: string; fields: ObservedField[] }> = [];
    let driftValues: readonly ObservedFieldValueDrift[] = [];
    if (suggestFields) {
      const observed = await collectObservedFields({ vault, ontology, folder });
      suggestedFields = observed
        .map((summary) => ({
          folder: summary.folder,
          fields: undeclaredObservedFields(ontology, summary),
        }))
        .filter((summary) => summary.fields.length > 0);
      driftValues = await collectObservedFieldValues({ vault, ontology, folder });
    }

    if (json) {
      console.log(
        JSON.stringify(
          {
            vault,
            folder: folder ?? null,
            scannedNotes: report.scannedNotes,
            excludedNotes: report.excludedNotes,
            clean: report.clean,
            violations: report.violations,
            ...(suggestFields ? { suggestedFields, driftValues } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `\nOh My Second Brain audit: ${report.scannedNotes} note(s) scanned, ${report.excludedNotes} excluded, ${report.violations.length} violation(s).`,
      );

      if (report.violations.length === 0) {
        console.log("Vault is clean — no contract violations found.\n");
      } else {
        const byNote = new Map<string, VaultLintViolation[]>();
        for (const violation of report.violations) {
          const list = byNote.get(violation.notePath) ?? [];
          list.push(violation);
          byNote.set(violation.notePath, list);
        }
        for (const [notePath, violations] of byNote) {
          console.log(`\n  ${notePath}`);
          for (const violation of violations) {
            console.log(`    [${violation.rule}] ${violation.message}`);
          }
        }
        console.log(`\n${report.violations.length} violation(s) across ${byNote.size} note(s).\n`);
      }

      if (suggestFields) {
        console.log("--- Unregistered fields observed in vault (candidates for concept schema) ---");
        if (suggestedFields.length === 0) console.log("  (none)");
        for (const summary of suggestedFields) {
          const fieldList = summary.fields.map((field) => `${field.name}:${field.type}(${field.count})`).join(", ");
          console.log(`  ${summary.folder}: ${fieldList}`);
        }

        console.log("\n--- Enum drift: values outside declared enum (top 20 by frequency) ---");
        const top = driftValues.slice(0, 20);
        if (top.length === 0) console.log("  (none)");
        for (const drift of top) {
          console.log(`  ${drift.folder} / ${drift.field} = "${drift.value}" (${drift.count})`);
        }
        console.log("");
      }
    }

    return report.violations.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`[oms] audit could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

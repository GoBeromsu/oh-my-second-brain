import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { detectLinkIssues } from "../kernel/conventions/lint.js";
import { formatLintReport } from "../kernel/conventions/report.js";
import { hostHome } from "../kernel/install/common.js";
import { computeTreeDigest, parseProvenance } from "../kernel/install/provenance.js";
import { diagnoseTemplates } from "../kernel/templates/index.js";
import path from "node:path";

async function hermesProvenanceSummary(): Promise<string> {
  const hermesRoot = hostHome(undefined, ".hermes", "OMS_HERMES_HOME");
  const skillRoot = path.join(hermesRoot, "skills", "knowledge-management", "oms");
  const provenancePath = path.join(hermesRoot, "adapters", "oms", ".oms-provenance.json");
  if (!existsSync(provenancePath) || !existsSync(skillRoot)) return "Hermes provenance: not installed.";
  try {
    const provenance = parseProvenance(await readFile(provenancePath, "utf8"));
    const packageVersion = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (provenance !== null && typeof packageVersion.version === "string" &&
      provenance.version === packageVersion.version && provenance.treeDigest === await computeTreeDigest(skillRoot)) {
      return "Hermes provenance: package and installed tree match.";
    }
  } catch {
    return "Hermes provenance: drift detected.";
  }
  return "Hermes provenance: drift detected.";
}

export async function runDoctor(opts: {
  vault: string;
  verbose?: boolean;
  json?: boolean;
  maxPerTemplate?: number;
}): Promise<number> {
  try {
    const diagnosis = await diagnoseTemplates({ vault: opts.vault, source: "explicit", maxPerTemplate: opts.maxPerTemplate });
    if (opts.json) {
      console.log(JSON.stringify({ vault: opts.vault, ...diagnosis }, null, 2));
      return 0;
    }
    console.log(`\nOh My Second Brain doctor: ${diagnosis.status}.`);
    console.log(`Migration marker: ${diagnosis.migrationMarker}.`);
    console.log(`Managed template sources excluded: ${diagnosis.managedSourceExclusions.length}.`);
    console.log(await hermesProvenanceSummary());
    if (diagnosis.unresolvedLegacyNotes.length > 0) {
      console.log(`Unresolved legacy notes: ${diagnosis.unresolvedLegacyNotes.length}.`);
    }
    for (const item of diagnosis.diagnostics) {
      console.log(`  [${item.code}]${item.path === undefined ? "" : ` ${item.path}`} — ${item.remediation}`);
    }
    console.log("");
  } catch (error) {
    console.error(`[oms] doctor could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}

export async function runLint(opts: {
  vault: string;
  verbose?: boolean;
  json?: boolean;
}): Promise<number> {
  try {
    const result = await detectLinkIssues(opts.vault);
    if (opts.json) {
      console.log(JSON.stringify({ totalNotes: result.totalNotes, brokenLinks: result.brokenLinks, orphanPaths: result.orphanPaths }, null, 2));
    } else {
      console.log(formatLintReport(result, { vault: opts.vault, verbose: opts.verbose }));
    }
  } catch (error) {
    console.error(`[oms] lint could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}

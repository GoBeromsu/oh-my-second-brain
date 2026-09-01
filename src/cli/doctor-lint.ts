import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { detectLinkIssues } from "../kernel/conventions/lint.js";
import { formatLintReport } from "../kernel/conventions/report.js";
import { hostHome } from "../kernel/install/common.js";
import { computeTreeDigest, parseProvenance } from "../kernel/install/provenance.js";
import { diagnoseTemplates } from "../kernel/templates/index.js";
import path from "node:path";

export type HermesProvenanceStatus = {
  readonly state: "not-installed" | "match" | "drift";
  readonly packageVersion: string | null;
  readonly recordedVersion: string | null;
  readonly digestMatch: boolean | null;
};

async function hermesProvenanceStatus(): Promise<HermesProvenanceStatus> {
  const hermesRoot = hostHome(undefined, ".hermes", "OMS_HERMES_HOME");
  const skillRoot = path.join(hermesRoot, "skills", "knowledge-management", "oms");
  const provenancePath = path.join(hermesRoot, "adapters", "oms", "oms-provenance.json");
  const packageMetadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  const packageVersion = typeof packageMetadata.version === "string" ? packageMetadata.version : null;
  if (!existsSync(provenancePath) || !existsSync(skillRoot)) {
    return { state: "not-installed", packageVersion, recordedVersion: null, digestMatch: null };
  }
  try {
    const provenance = parseProvenance(await readFile(provenancePath, "utf8"));
    const digestMatch = provenance === null ? false : provenance.skillTreeDigest === await computeTreeDigest(skillRoot);
    if (provenance !== null && packageVersion !== null && provenance.version === packageVersion && digestMatch) {
      return { state: "match", packageVersion, recordedVersion: provenance.version, digestMatch };
    }
    return { state: "drift", packageVersion, recordedVersion: provenance?.version ?? null, digestMatch };
  } catch {
    return { state: "drift", packageVersion, recordedVersion: null, digestMatch: false };
  }
}

function formatHermesProvenanceStatus(status: HermesProvenanceStatus): string {
  return `Hermes provenance: ${status.state} (package ${status.packageVersion ?? "unknown"}, recorded ${status.recordedVersion ?? "none"}).`;
}

export async function runDoctor(opts: {
  vault: string;
  verbose?: boolean;
  json?: boolean;
  maxPerTemplate?: number;
}): Promise<number> {
  try {
    const legacyTaxonomy = path.join(opts.vault, ".oms", "taxonomy.yaml");
    if (existsSync(legacyTaxonomy)) {
      const taxonomy = path.join(opts.vault, ".oms", "taxonomy.json");
      const message = existsSync(taxonomy)
        ? "legacy .oms/taxonomy.yaml remains after conversion — remove it; .oms/taxonomy.json is authoritative"
        : "legacy .oms/taxonomy.yaml is no longer read — run oms setup to convert to taxonomy.json";
      if (opts.json) console.log(JSON.stringify({ vault: opts.vault, status: "needs-repair", diagnostics: [{ code: "LEGACY_TAXONOMY_YAML", path: ".oms/taxonomy.yaml", remediation: message }] }, null, 2));
      else console.error(`[oms] ${message}`);
      return 1;
    }
    const diagnosis = await diagnoseTemplates({ vault: opts.vault, source: "explicit", maxPerTemplate: opts.maxPerTemplate });
    const hermesProvenance = await hermesProvenanceStatus();
    if (opts.json) {
      console.log(JSON.stringify({ vault: opts.vault, ...diagnosis, hermesProvenance }, null, 2));
      return 0;
    }
    console.log(`\nOh My Second Brain doctor: ${diagnosis.status}.`);
    console.log(`Migration marker: ${diagnosis.migrationMarker}.`);
    console.log(`Managed template sources excluded: ${diagnosis.managedSourceExclusions.length}.`);
    console.log(formatHermesProvenanceStatus(hermesProvenance));
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

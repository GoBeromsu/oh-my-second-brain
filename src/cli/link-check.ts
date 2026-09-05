import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { detectLinkIssues } from "../kernel/conventions/lint.js";
import { formatLintReport } from "../kernel/conventions/report.js";
import { inspectInstalledAssets } from "../kernel/install/asset-health.js";
import { diagnoseTemplates } from "../kernel/templates/index.js";
import path from "node:path";
import { discoverHostInstallAssets } from "./host-probe.js";

export type HermesProvenanceStatus = {
  readonly state: "not-installed" | "match" | "drift";
  readonly packageVersion: string | null;
  readonly recordedVersion: string | null;
  readonly digestMatch: boolean | null;
};

async function packageVersion(): Promise<string | null> {
  const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  return typeof metadata.version === "string" ? metadata.version : null;
}

async function hermesProvenanceStatus(status: Awaited<ReturnType<typeof inspectInstalledAssets>>): Promise<HermesProvenanceStatus> {
  const installed = status.hosts.find(host => host.host === "hermes")?.state !== "not-installed";
  const asset = status.assets.find(candidate => candidate.id === "hermes:0");
  const version = asset?.packageVersion ?? await packageVersion();
  if (!installed) return { state: "not-installed", packageVersion: version, recordedVersion: null, digestMatch: null };
  const recordedVersion = asset?.recordedVersion ?? null;
  const digestMatch = asset?.digestMatch ?? false;
  return {
    state: version !== null && recordedVersion === version && digestMatch ? "match" : "drift",
    packageVersion: version,
    recordedVersion,
    digestMatch,
  };
}

function formatHermesProvenanceStatus(status: HermesProvenanceStatus): string {
  return `Hermes provenance: ${status.state} (packageVersion=${status.packageVersion ?? "unknown"}, recordedVersion=${status.recordedVersion ?? "none"}, digestMatch=${status.digestMatch ?? "unknown"}).`;
}

function formatInstallAssets(status: Awaited<ReturnType<typeof inspectInstalledAssets>>): string {
  const unusable = status.assets.filter(asset => asset.state !== "ok").length;
  return unusable === 0
    ? `Install assets: ok (${status.assets.length} checked).`
    : `Install assets: degraded (${unusable} of ${status.assets.length} unusable).`;
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
    const hostEvidence = await discoverHostInstallAssets();
    const installAssets = await inspectInstalledAssets({ vault: opts.vault, ...hostEvidence });
    const hermesProvenance = await hermesProvenanceStatus(installAssets);
    if (opts.json) {
      console.log(JSON.stringify({ vault: opts.vault, ...diagnosis, hermesProvenance, installAssets }, null, 2));
      return 0;
    }
    console.log(`\nOh My Second Brain doctor: ${diagnosis.status}.`);
    console.log(`Migration marker: ${diagnosis.migrationMarker}.`);
    console.log(`Managed template sources excluded: ${diagnosis.managedSourceExclusions.length}.`);
    console.log(formatHermesProvenanceStatus(hermesProvenance));
    console.log(formatInstallAssets(installAssets));
    if (diagnosis.unresolvedLegacyNotes.length > 0) {
      console.log(`Unresolved legacy notes: ${diagnosis.unresolvedLegacyNotes.length}.`);
    }
    for (const item of [...diagnosis.diagnostics, ...installAssets.assets.filter(asset => asset.state !== "ok").map(asset => ({
      code: asset.state.toUpperCase().replace(/-/g, "_"),
      path: asset.realPath !== null && asset.realPath !== asset.declaredPath ? `${asset.declaredPath} -> ${asset.realPath}` : asset.declaredPath,
      remediation: asset.remediation,
      cause: asset.cause,
      packageVersion: asset.packageVersion,
      recordedVersion: asset.recordedVersion,
      digestMatch: asset.digestMatch,
    }))]) {
      const provenance = "packageVersion" in item && "recordedVersion" in item && "digestMatch" in item
        ? ` packageVersion=${item.packageVersion ?? "unknown"} recordedVersion=${item.recordedVersion ?? "unknown"} digestMatch=${item.digestMatch ?? "unknown"}`
        : "";
      console.log(`  [${item.code}]${item.path === undefined ? "" : ` ${item.path}`}${"cause" in item && item.cause !== null ? ` (${item.cause})` : ""}${provenance} — ${item.remediation}`);
    }
    console.log("");
  } catch (error) {
    console.error(`[oms] doctor could not complete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}

export async function runLinkCheck(opts: {
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

/**
 * `oms doctor`: diagnosis and repair, placed on one family. Each leaf reuses the
 * module that already owns the behavior; only the spelling changed in 0.19.
 * `doctor status` is read-only. Repairs keep their verified-target gates.
 */

export function doctorUsage(): string {
  return `Usage: oms doctor <leaf> [options]

  status [--vault <path>]
            Read-only vault health: contract posture, history, engine and graph.
  contract [--fix] [--vault <path>]
            Diagnose the sealed contract. --fix only re-indexes a moved or unindexed vault.
  audit [--folder <path>] [--max-per-template <n>] [--json] [--vault <path>]
            Report notes that do not match the sealed contract. Notes are never rewritten.
  link-check [<note>] [--vault <path>]
            Report broken wikilinks in one note, or in the whole vault.
  sync-embeddings --mode <sync|embed|repair> [options] [--vault <path>]
            Build or refresh the search index. With --mode repair,
            --repair-mode <mode> picks the repair and --dry-run previews it.
  cleanup [--index <path>] [--vault <path>]
            Remove index entries for notes that no longer exist.
  build-graph [--vault <path>]
            Rebuild the vault graph.`;
}

const SYNC_MODES = ["sync", "embed", "repair"] as const;

function fail(message: string): void {
  process.exitCode = 1;
  console.error(`[oms] ${message}`);
}

/** `--mode` picks the index leaf; `--repair-mode` becomes the repair leaf's own `--mode`. */
function syncEmbeddingsArgs(argv: readonly string[]): readonly string[] | string {
  let mode: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--mode") {
      if (mode !== undefined) return "doctor sync-embeddings: duplicate flag --mode";
      mode = argv[++index];
      if (mode === undefined || mode.startsWith("--")) return "doctor sync-embeddings: --mode requires a value (sync, embed, or repair)";
    } else if (token === "--repair-mode") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) return "doctor sync-embeddings: --repair-mode requires a value";
      rest.push("--mode", value);
    } else {
      rest.push(token);
    }
  }
  if (mode === undefined) return "doctor sync-embeddings: --mode <sync|embed|repair> is required";
  if (!(SYNC_MODES as readonly string[]).includes(mode)) return `doctor sync-embeddings: unknown mode ${mode} (sync, embed, or repair)`;
  if (mode !== "repair" && rest.includes("--mode")) return "doctor sync-embeddings: --repair-mode applies only to --mode repair";
  return [mode, ...rest];
}

export async function runDoctorCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  const [leaf, ...rest] = argv;
  if (leaf === undefined || leaf === "--help" || leaf === "-h") {
    console.log(doctorUsage());
    if (leaf === undefined) process.exitCode = 1;
    return;
  }
  switch (leaf) {
    case "status": {
      const { runStatusCommand } = await import("./status-command.js");
      await runStatusCommand(rest);
      return;
    }
    case "contract": {
      const { runContractCommand } = await import("./contract-command.js");
      await runContractCommand(["doctor", ...rest]);
      return;
    }
    case "audit": {
      const { runNoteCommand } = await import("./note-command.js");
      await runNoteCommand(["audit", ...rest]);
      return;
    }
    case "link-check": {
      const { runLinkFamilyCommand } = await import("./link-command.js");
      await runLinkFamilyCommand(["check", ...rest]);
      return;
    }
    case "sync-embeddings": {
      const translated = syncEmbeddingsArgs(rest);
      if (typeof translated === "string") {
        fail(translated);
        return;
      }
      const { runIndexFamilyCommand } = await import("./search.js");
      await runIndexFamilyCommand(translated);
      return;
    }
    case "cleanup": {
      const { runIndexFamilyCommand } = await import("./search.js");
      await runIndexFamilyCommand(["clean", ...rest]);
      return;
    }
    case "build-graph": {
      const { runGraphCommand } = await import("./graph-command.js");
      await runGraphCommand(["build", ...rest]);
      return;
    }
    default:
      fail(`Unknown doctor leaf: ${leaf}. Leaves: status, contract, audit, link-check, sync-embeddings, cleanup, build-graph.`);
  }
}

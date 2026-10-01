/**
 * `oms doctor`: diagnosis and repair, placed on one family. Each leaf reuses the
 * module that already owns the behavior; only the spelling changed in 0.19.
 * `doctor status` is read-only. Repairs keep their verified-target gates.
 */

export function doctorUsage(): string {
  return `Usage: oms doctor <leaf> [options]

  status [--vault <path>]
            Read-only vault health: contract posture, history, engine and graph.
  status [--view status|collections|contexts] [--index <path>] [--collection <name>] [--vault <path>]
            Read-only search-index view. --view, --index or --collection selects it;
            it never creates a missing store.
  contract [--fix] [--vault <path>]
            Diagnose the sealed contract. --fix only re-indexes a moved or unindexed vault,
            or rebuilds an unreadable index.
  gaps [--vault <path>]
            Report open gaps between written notes and the sealed contract, and
            contradictions inside the contract. Wanted values are never printed.
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
            Rebuild the vault graph.
  lineage-recover [--vault <path>]
            Record seals the contract lineage missed and snapshot kept generations.
            A gap the chain cannot account for is refused.
  lineage-reanchor [--vault <path>]
            As lineage-recover, and also anchor a gap so the lineage continues.
            Owner only: asks for confirmation in a terminal.
  evolve --maker-session <id> [--vault <path>]
            Open a contract evolution request for an evaluator to judge.
            The maker's session is required so it can never evaluate its own candidate.
  evolve-verdict --verdict <file|-> [--vault <path>]
            Submit an evaluator verdict (one JSON object) for an open request.
  revert-propose --target <digest> [--vault <path>]
            Propose returning the contract to a kept generation; it goes through the seal gate.
  reclaim-evolution-lock [--vault <path>]
            Owner only: release a stale evolution lock after confirming in a terminal.`;
}

const SYNC_MODES = ["sync", "embed", "repair"] as const;

/** Flags that select the read-only search-index view of `doctor status` instead of the vault report. */
const INDEX_STATUS_FLAGS = new Set(["--view", "--index", "--collection"]);

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
      if (rest.some((token) => INDEX_STATUS_FLAGS.has(token))) {
        const { runIndexFamilyCommand } = await import("./search.js");
        await runIndexFamilyCommand(["status", ...rest]);
        return;
      }
      const { runStatusCommand } = await import("./status-command.js");
      await runStatusCommand(rest);
      return;
    }
    case "contract": {
      const { runContractCommand } = await import("./contract-command.js");
      await runContractCommand(["doctor", ...rest]);
      return;
    }
    case "gaps": {
      const { runContractCommand } = await import("./contract-command.js");
      await runContractCommand(["gaps", ...rest]);
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
    case "lineage-recover":
    case "lineage-reanchor":
    case "evolve":
    case "evolve-verdict":
    case "revert-propose":
    case "reclaim-evolution-lock": {
      const { runLineageCommand } = await import("./lineage-command.js");
      await runLineageCommand(leaf, rest);
      return;
    }
    default:
      fail(`Unknown doctor leaf: ${leaf}. Leaves: status, contract, gaps, audit, link-check, sync-embeddings, cleanup, build-graph, lineage-recover, lineage-reanchor, evolve, evolve-verdict, revert-propose, reclaim-evolution-lock.`);
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { repairDoctor, type DoctorHuman } from "../kernel/doctor/service.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { doctorHuman, terminalPromptIO } from "./evolution-approve.js";

/**
 * The contract repairs on `oms doctor`: the two lineage repairs (`lineage-recover`,
 * `lineage-reanchor`) and the evolution ops (`evolve`, `evolve-verdict`, `revert-propose`,
 * `reclaim-evolution-lock`). Recover refuses a lineage gap; reanchor anchors it. All keep
 * the verified-target gate: a cwd-inferred vault is rejected. The owner-only leaves
 * (reanchor, reclaim) ask the owner in this terminal and refuse without one.
 */

export type LineageLeaf = "lineage-recover" | "lineage-reanchor" | "evolve" | "evolve-verdict" | "revert-propose" | "reclaim-evolution-lock";

/** Each leaf's own flag, if any, the op argument it fills, and the value its usage line shows. */
const LEAF_FLAG: Readonly<Partial<Record<LineageLeaf, { readonly flag: string; readonly arg: string; readonly placeholder: string; readonly required: boolean }>>> = {
  evolve: { flag: "--maker-session", arg: "makerSessionId", placeholder: "id", required: true },
  "evolve-verdict": { flag: "--verdict", arg: "verdict", placeholder: "file|-", required: true },
  "revert-propose": { flag: "--target", arg: "targetDigest", placeholder: "digest", required: true },
};

const OWNER_ONLY: ReadonlySet<LineageLeaf> = new Set(["lineage-reanchor", "reclaim-evolution-lock"]);

function usage(leaf: LineageLeaf): string {
  const own = LEAF_FLAG[leaf];
  const flag = own === undefined ? "" : ` ${own.flag} <${own.placeholder}>`;
  return `Usage: oms doctor ${leaf}${flag} [--vault <path>]`;
}

interface LeafArgs {
  readonly vault?: string;
  readonly value?: string;
}

function parseArgs(leaf: LineageLeaf, argv: readonly string[]): LeafArgs {
  const own = LEAF_FLAG[leaf];
  let vault: string | undefined;
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== "--vault" && token !== own?.flag) throw new Error(`CONTRACT_ARGS_INVALID: doctor ${leaf} received unknown argument ${token}`);
    if ((token === "--vault" ? vault : value) !== undefined) throw new Error(`CONTRACT_ARGS_INVALID: duplicate flag ${token}`);
    const next = argv[++index];
    if (next === undefined || next.startsWith("--")) throw new Error(`CONTRACT_ARGS_INVALID: ${token} requires a value`);
    if (token === "--vault") vault = next;
    else value = next;
  }
  if (own?.required === true && value === undefined) throw new Error(`CONTRACT_ARGS_INVALID: doctor ${leaf} needs ${own.flag}`);
  return { ...(vault === undefined ? {} : { vault }), ...(value === undefined ? {} : { value }) };
}

async function target(explicit: string | undefined): Promise<{ readonly vault: string; readonly source: WriteTargetSource }> {
  if (explicit !== undefined) return { vault: path.resolve(explicit), source: "explicit" };
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}

async function readStdin(stdin: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** An evaluator's verdict is one JSON object, read from a file or stdin (`-`). */
async function readVerdict(source: string, stdin: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source === "-" ? await readStdin(stdin) : await readFile(path.resolve(source), "utf8"));
  } catch {
    throw new Error("EVOLUTION_ARGUMENT_INVALID: the verdict could not be read as JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("EVOLUTION_ARGUMENT_INVALID: the verdict must be a JSON object");
  return parsed as Record<string, unknown>;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export interface LineageCommandDeps {
  /** The owner for the owner-only leaves; defaults to this process's terminal. */
  readonly human?: DoctorHuman;
  /** Where `--verdict -` reads; defaults to process.stdin. */
  readonly stdin?: AsyncIterable<unknown>;
}

export async function runLineageCommand(leaf: LineageLeaf, argv: readonly string[], deps: LineageCommandDeps = {}): Promise<void> {
  process.exitCode = 0;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(usage(leaf));
    return;
  }
  const terminal = OWNER_ONLY.has(leaf) && deps.human === undefined ? terminalPromptIO() : null;
  try {
    const parsed = parseArgs(leaf, argv);
    const resolved = await target(parsed.vault);
    const own = LEAF_FLAG[leaf];
    const args = parsed.value === undefined || own === undefined ? undefined
      : own.arg === "verdict" ? await readVerdict(parsed.value, deps.stdin ?? process.stdin)
        : { [own.arg]: parsed.value };
    const human = deps.human ?? (terminal === null ? undefined : doctorHuman(terminal.io));
    const result = await repairDoctor({ operation: leaf, vault: resolved.vault, source: resolved.source, args, ...(human === undefined ? {} : { human }) });
    if (result.kind === "error") {
      process.exitCode = 1;
      print({ status: "error", message: result.message });
      return;
    }
    if (result.kind === "rejected") process.exitCode = 1;
    print(result.value);
  } catch (error: unknown) {
    process.exitCode = 1;
    print({ status: "rejected", diagnostics: [failure(error)] });
  } finally {
    terminal?.close();
  }
}

const FAILURE_CODE = /^[A-Z][A-Z0-9_]+$/;
/** Absolute POSIX or Windows paths, quoted (may hold spaces) or bare: the store lives under the user's home and stays out of the report. */
const QUOTED_PATH = /(['"`])(?:[A-Za-z]:)?[\\/][^'"`]*\1/g;
const ABSOLUTE_PATH = /(?<![\w.])(?:[A-Za-z]:)?(?:[\\/][^\s'"`,()\\/]+)+[\\/]?/g;

function failure(error: unknown): { readonly code: string; readonly remediation: string } {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = message.split(":", 1)[0]!;
  return {
    code: error instanceof Error && FAILURE_CODE.test(prefix) ? prefix : "CONTRACT_LINEAGE_REPAIR_FAILED",
    remediation: message.replace(QUOTED_PATH, "$1<path>$1").replace(ABSOLUTE_PATH, "<path>"),
  };
}

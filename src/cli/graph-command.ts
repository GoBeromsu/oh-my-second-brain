import path from "node:path";

import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { repairDoctor } from "../kernel/doctor/service.js";
import { assembleGraphOnlyEngine, type AssembledEngine } from "../kernel/engine/assemble.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";

interface ParsedGraphCommand {
  readonly verb: "build" | "status";
  readonly vault: string | undefined;
}

function usage(): string {
  return "Usage: oms graph <build|status> [--vault <path>]";
}

function parse(argv: readonly string[]): ParsedGraphCommand {
  const verb = argv[0];
  if (verb !== "build" && verb !== "status") {
    throw new Error(`GRAPH_ARGS_INVALID: expected build or status, received ${verb ?? "(none)"}`);
  }
  let vault: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== "--vault") throw new Error(`GRAPH_ARGS_INVALID: unknown argument ${token}`);
    if (vault !== undefined) throw new Error("GRAPH_ARGS_INVALID: duplicate flag --vault");
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("GRAPH_ARGS_INVALID: --vault requires a value");
    }
    vault = value;
  }
  return { verb, vault };
}

async function target(explicit: string | undefined): Promise<{
  readonly vault: string;
  readonly source: WriteTargetSource;
}> {
  if (explicit !== undefined) return { vault: path.resolve(explicit), source: "explicit" };
  const resolved = await resolveEffectiveVault(process.cwd(), process.env);
  return { vault: resolved.vault, source: resolved.source };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runGraphCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  const helpOnly = argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
  const verbHelp = argv.length === 2 &&
    (argv[0] === "build" || argv[0] === "status") &&
    (argv[1] === "--help" || argv[1] === "-h");
  if (helpOnly || verbHelp) {
    console.log(usage());
    return;
  }

  let engine: AssembledEngine | undefined;
  try {
    const parsed = parse(argv);
    const resolved = await target(parsed.vault);

    if (parsed.verb === "status") {
      engine = assembleGraphOnlyEngine({ vault: resolved.vault });
      const status = await engine.adapter.graphStatus(resolved.vault);
      print(status);
      if (!status.available) process.exitCode = 1;
      return;
    }

    const result = await repairDoctor({
      operation: "build-graph",
      vault: resolved.vault,
      source: resolved.source,
      args: undefined,
      resolveAdapter: () => {
        engine = assembleGraphOnlyEngine({ vault: resolved.vault });
        return engine.adapter;
      },
    });
    if (result.kind === "error") {
      process.exitCode = 1;
      print({ status: "error", message: result.message });
      return;
    }
    if (result.kind === "rejected") process.exitCode = 1;
    print(result.value);
  } catch (error: unknown) {
    process.exitCode = 1;
    print({
      status: "rejected",
      diagnostics: [{
        code: error instanceof Error ? error.message.split(":", 1)[0] : "GRAPH_COMMAND_FAILED",
        remediation: error instanceof Error ? error.message : String(error),
      }],
    });
  } finally {
    await engine?.dispose().catch(() => undefined);
  }
}

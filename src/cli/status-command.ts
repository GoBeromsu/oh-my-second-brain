import path from "node:path";
import { existsSync } from "node:fs";

import { runEngineSession } from "./engine-session.js";
import { assembleGraphOnlyEngine } from "../kernel/engine/assemble.js";
import { engineStorePath } from "../kernel/engine/paths.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";
import { summarizeRuntimeHistory } from "../kernel/runtime/event-summary.js";
import { loadResolvedTemplates } from "../kernel/templates/resolver.js";

function usage(): string {
  return "Usage: oms status [--vault <path>]";
}

function parseVault(argv: readonly string[]): string | undefined {
  let vault: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== "--vault") throw new Error(`STATUS_ARGS_INVALID: unknown argument ${token}`);
    if (vault !== undefined) throw new Error("STATUS_ARGS_INVALID: duplicate flag --vault");
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("STATUS_ARGS_INVALID: --vault requires a value");
    }
    vault = value;
  }
  return vault;
}

function diagnostic(error: unknown): {
  readonly code: string;
  readonly remediation: string;
} {
  return {
    code: error instanceof Error ? error.message.split(":", 1)[0] ?? "STATUS_READ_FAILED" : "STATUS_READ_FAILED",
    remediation: error instanceof Error ? error.message : String(error),
  };
}

export async function runStatusCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(usage());
    return;
  }

  try {
    const explicit = parseVault(argv);
    const resolved = explicit === undefined
      ? await resolveEffectiveVault(process.cwd(), process.env)
      : { vault: path.resolve(explicit), source: "explicit" as const };

    let convention: unknown;
    const policyPath = path.join(resolved.vault, ".oms", "template-policy.json");
    if (!existsSync(policyPath)) {
      convention = {
        status: "absent",
        diagnostics: [{
          code: "TEMPLATE_POLICY_ABSENT",
          remediation: `No template convention exists at "${policyPath}".`,
        }],
      };
    } else {
      try {
        convention = await loadResolvedTemplates(resolved.vault);
      } catch (error: unknown) {
        convention = { status: "invalid", diagnostics: [diagnostic(error)] };
      }
    }

    let history: unknown;
    try {
      history = summarizeRuntimeHistory({ vaultPath: resolved.vault });
    } catch (error: unknown) {
      history = { status: "unavailable", diagnostics: [diagnostic(error)] };
    }

    let engine: unknown;
    if (!existsSync(engineStorePath(resolved.vault))) {
      engine = { available: false as const, reason: "Engine store not found" };
    } else {
      try {
        engine = await runEngineSession(
          resolved.vault,
          { write: false },
          (adapter) => adapter.semanticStatus({ vault: resolved.vault }),
        );
      } catch (error: unknown) {
        engine = {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
          diagnostics: [diagnostic(error)],
        };
      }
    }

    const graphEngine = assembleGraphOnlyEngine({ vault: resolved.vault });
    let graph: unknown;
    try {
      graph = await graphEngine.adapter.graphStatus(resolved.vault);
    } finally {
      await graphEngine.dispose();
    }
    console.log(JSON.stringify({
      vault: resolved.vault,
      source: resolved.source,
      convention,
      history,
      engine,
      graph,
    }, null, 2));
  } catch (error: unknown) {
    process.exitCode = 1;
    console.log(JSON.stringify({
      status: "rejected",
      diagnostics: [{
        code: error instanceof Error ? error.message.split(":", 1)[0] : "STATUS_COMMAND_FAILED",
        remediation: error instanceof Error ? error.message : String(error),
      }],
    }, null, 2));
  }
}

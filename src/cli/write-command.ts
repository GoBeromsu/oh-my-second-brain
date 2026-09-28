import path from "node:path";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";
import { writePayload } from "../kernel/write/payload.js";
import { runWritePipeline } from "../kernel/write/pipeline.js";

/**
 * `oms write <path> [--template <t>] [--if-match <rev>] [--check] < stdin`: the CLI face
 * of the write pipeline. The same kernel path as MCP `write`: one judge, a denied or
 * rejected write leaves disk untouched, and a vault inferred from the current directory
 * is refused. `--check` judges only and never touches disk.
 */

export interface WriteCommandDeps {
  /** Reads the note body. Defaults to process stdin, refused when stdin is a terminal. */
  readonly readStdin?: () => Promise<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function writeUsage(): string {
  return `Usage: oms write <vault-relative path> [--template <template>] [--if-match sha256:<rev>] [--check] [--vault <path>] < note.md

Reads the whole note (frontmatter and body) from stdin, applies mechanical fixes (date and
title variables, date defaults, template headings) and saves it only when the sealed vault
contract allows it. Overwriting an existing note needs --if-match with its current revision,
as a previous receipt or --check reports it. --check judges and prints the frame without
touching disk. The target vault of a write must be verified: --vault, the vault's own
.oms/settings.json, a bridge link, or OMS_VAULT. A vault inferred from the current directory
is read-only, so the write is refused. Prints JSON; exits 1 when nothing was written or the
check found violations.`;
}

interface WriteArgs {
  readonly notePath: string;
  readonly template: string | undefined;
  readonly vault: string | undefined;
  readonly ifMatch: string | undefined;
  readonly check: boolean;
}

function parseWriteArgs(argv: readonly string[]): WriteArgs {
  let notePath: string | undefined;
  let template: string | undefined;
  let vault: string | undefined;
  let ifMatch: string | undefined;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--check") {
      if (check) throw new Error("--check may be specified only once");
      check = true;
      continue;
    }
    if (token === "--template" || token === "--vault" || token === "--if-match") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
      if (token === "--template") {
        if (template !== undefined) throw new Error("--template may be specified only once");
        template = value;
      } else if (token === "--if-match") {
        if (ifMatch !== undefined) throw new Error("--if-match may be specified only once");
        ifMatch = value;
      } else {
        if (vault !== undefined) throw new Error("--vault may be specified only once");
        vault = value;
      }
      continue;
    }
    if (token.startsWith("--")) throw new Error(`unknown write option ${token}`);
    if (notePath !== undefined) throw new Error("write takes exactly one note path");
    notePath = token;
  }
  if (notePath === undefined || notePath.length === 0) throw new Error("write requires a vault-relative note path");
  return { notePath, template, vault, ifMatch, check };
}

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new Error("write reads the note from stdin; pipe or redirect the content (oms write <path> < note.md)");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveTarget(
  explicit: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly vault: string; readonly source: WriteTargetSource }> {
  if (explicit !== undefined) return { vault: path.resolve(cwd, explicit), source: "explicit" };
  const { resolveEffectiveVault } = await import("../kernel/link/link.js");
  const resolved = await resolveEffectiveVault(cwd, env);
  return { vault: resolved.vault, source: resolved.source };
}

export async function runWriteCommand(argv: readonly string[], deps: WriteCommandDeps = {}): Promise<void> {
  process.exitCode = 0;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(writeUsage());
    return;
  }
  try {
    const args = parseWriteArgs(argv);
    const target = await resolveTarget(args.vault, deps.cwd ?? process.cwd(), deps.env ?? process.env);
    const content = await (deps.readStdin ?? readProcessStdin)();
    const payload = writePayload(await runWritePipeline({
      vault: target.vault,
      source: target.source,
      path: args.notePath,
      content,
      template: args.template,
      ifMatch: args.ifMatch,
      check: args.check,
    }));
    console.log(JSON.stringify(payload, null, 2));
    if (!payload.ok) process.exitCode = 1;
  } catch (error) {
    process.exitCode = 1;
    console.error(`[oms] ${error instanceof Error ? error.message : String(error)}`);
  }
}

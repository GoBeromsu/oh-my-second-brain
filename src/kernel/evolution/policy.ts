import { constants } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "../contract/fs-private.js";
import { checkStateFile, ensureStateDir, existingStateDir, openStateFile } from "../contract/state-dir.js";

/**
 * The autonomous-evolution policy: `<root>/.<id>.state/evolution/policy.json`. Opt-in and
 * off by default. Its limits start at the ceiling (1 autonomous seal per 24 hours, 3 per
 * 7 days) and can only be lowered. Anything unreadable, malformed or above the ceiling
 * reads as off: the policy fails closed.
 *
 * Only the interactive `oms setup` turns it on; MCP and a non-interactive run
 * (`OMS_NON_INTERACTIVE=1`) are refused with EVOLUTION_POLICY_REQUIRES_TTY. Turning it
 * off is always allowed.
 */

export const POLICY_FILE = "policy.json";
const MAX_POLICY_BYTES = 64 * 1024;

export interface EvolutionLimits {
  readonly perDay: number;
  readonly perWeek: number;
}

export const LIMIT_CEILING: EvolutionLimits = { perDay: 1, perWeek: 3 };

export interface EvolutionPolicy {
  readonly version: 1;
  readonly autonomous: boolean;
  readonly limits: EvolutionLimits;
}

export const DEFAULT_POLICY: EvolutionPolicy = { version: 1, autonomous: false, limits: LIMIT_CEILING };

function validLimit(value: unknown, ceiling: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= ceiling;
}

function parsePolicy(text: string): EvolutionPolicy | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  const limits = policy.limits as Record<string, unknown> | null | undefined;
  if (policy.version !== 1 || typeof policy.autonomous !== "boolean" || typeof limits !== "object" || limits === null) return null;
  if (!validLimit(limits.perDay, LIMIT_CEILING.perDay) || !validLimit(limits.perWeek, LIMIT_CEILING.perWeek)) return null;
  return { version: 1, autonomous: policy.autonomous, limits: { perDay: limits.perDay, perWeek: limits.perWeek } };
}

export type PolicyRead =
  | { readonly state: "absent"; readonly policy: EvolutionPolicy }
  | { readonly state: "ok"; readonly policy: EvolutionPolicy }
  | { readonly state: "invalid"; readonly policy: EvolutionPolicy };

/** The stored policy, or the default (off) when absent or invalid; never creates anything. */
export async function readPolicy(root: string, vaultId: string): Promise<PolicyRead> {
  const directory = await existingStateDir(root, vaultId, "evolution");
  if (directory === null) return { state: "absent", policy: DEFAULT_POLICY };
  const handle = await openStateFile(join(directory, POLICY_FILE), constants.O_RDONLY);
  if (handle === null) return { state: "absent", policy: DEFAULT_POLICY };
  let text: string;
  try {
    if ((await handle.stat()).size > MAX_POLICY_BYTES) return { state: "invalid", policy: DEFAULT_POLICY };
    text = (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
  const policy = parsePolicy(text);
  return policy === null ? { state: "invalid", policy: DEFAULT_POLICY } : { state: "ok", policy };
}

export interface PolicyWriteContext {
  /** True only for the interactive `oms setup` on a TTY. */
  readonly interactive: boolean;
}

export class PolicyRequiresTty extends Error {
  readonly code = "EVOLUTION_POLICY_REQUIRES_TTY";

  constructor() {
    super("EVOLUTION_POLICY_REQUIRES_TTY: autonomous evolution can only be turned on by the owner in an interactive `oms setup`");
    this.name = "PolicyRequiresTty";
  }
}

export class PolicyLimitRaised extends Error {
  readonly code = "EVOLUTION_POLICY_LIMIT_RAISED";

  constructor(detail: string) {
    super(`EVOLUTION_POLICY_LIMIT_RAISED: ${detail}; limits can only be lowered (at most ${LIMIT_CEILING.perDay} per 24h and ${LIMIT_CEILING.perWeek} per 7 days)`);
    this.name = "PolicyLimitRaised";
  }
}

/**
 * Stores a policy. Turning autonomy on needs an interactive context; a limit above the
 * ceiling, or not a whole number, is refused. Nothing is written on a refusal.
 */
export async function writePolicy(root: string, vaultId: string, policy: EvolutionPolicy, context: PolicyWriteContext): Promise<EvolutionPolicy> {
  if (!validLimit(policy.limits.perDay, LIMIT_CEILING.perDay)) throw new PolicyLimitRaised(`perDay ${String(policy.limits.perDay)}`);
  if (!validLimit(policy.limits.perWeek, LIMIT_CEILING.perWeek)) throw new PolicyLimitRaised(`perWeek ${String(policy.limits.perWeek)}`);
  if (policy.autonomous && !context.interactive) throw new PolicyRequiresTty();
  const stored: EvolutionPolicy = { version: 1, autonomous: policy.autonomous, limits: { perDay: policy.limits.perDay, perWeek: policy.limits.perWeek } };
  const directory = await ensureStateDir(root, vaultId, "evolution");
  const path = join(directory, POLICY_FILE);
  await checkStateFile(path);
  await writePrivate(path, `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

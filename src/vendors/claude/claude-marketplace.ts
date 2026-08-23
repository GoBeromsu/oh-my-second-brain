import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord, runExternal, type ExternalCommandResult } from "../../kernel/install/common.js";

/**
 * Published marketplace source used when the running install has no repo
 * checkout on disk.
 */
const PUBLISHED_MARKETPLACE_REPO = "GoBeromsu/oh-my-second-brain";

/**
 * Marketplace name published in `.claude-plugin/marketplace.json`. Only used
 * when that manifest is not readable locally; a local checkout always wins so
 * a renamed marketplace cannot drift from the commands OMS prints.
 */
const PUBLISHED_MARKETPLACE_NAME = "oms";

const MARKETPLACE_MANIFEST = path.join(".claude-plugin", "marketplace.json");

/**
 * Claude leaves `autoUpdate` off for third-party marketplaces, and
 * `claude plugin marketplace add` writes the `extraKnownMarketplaces` entry
 * itself. OMS therefore never touches that key: enabling background updates
 * for a third-party source stays an explicit user decision.
 */
export const MARKETPLACE_AUTO_UPDATE_MESSAGE =
  "Claude keeps autoUpdate off for third-party marketplaces. To let this marketplace update itself, set " +
  '`extraKnownMarketplaces.<name>.autoUpdate` to true in ~/.claude/settings.json; otherwise run ' +
  "`claude plugin marketplace update` when you want a refresh. OMS does not change this setting for you.";

export type ClaudeMarketplaceSource =
  | { readonly kind: "local"; readonly source: string; readonly marketplaceName: string }
  | { readonly kind: "github"; readonly source: string; readonly marketplaceName: string };

/**
 * Reads the marketplace name a repo root declares. Returns null when the
 * manifest is missing, unreadable, or declares no string `name`, so callers can
 * fall back instead of printing a command with a guessed marketplace id.
 */
export async function readMarketplaceName(repoRoot: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(repoRoot, MARKETPLACE_MANIFEST), "utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const name = parsed["name"];
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * Resolves the marketplace Claude should add. A repo checkout containing the
 * manifest at its plugin root is preferred (dev and offline installs);
 * otherwise the published GitHub repo is used.
 */
export async function resolveClaudeMarketplaceSource(pluginPath: string): Promise<ClaudeMarketplaceSource> {
  const localName = await readMarketplaceName(pluginPath);
  if (localName !== null) {
    return { kind: "local", source: pluginPath, marketplaceName: localName };
  }
  return {
    kind: "github",
    source: PUBLISHED_MARKETPLACE_REPO,
    marketplaceName: PUBLISHED_MARKETPLACE_NAME,
  };
}

export interface ClaudePluginInstallPlan {
  readonly marketplace: ClaudeMarketplaceSource;
  readonly pluginPath: string;
  readonly describeFailure: (result: ExternalCommandResult) => string;
}

/**
 * Installs the plugin through the marketplace, falling back to the local plugin
 * path whenever the marketplace flow does not complete (offline, private
 * checkout, or a Claude build without the marketplace surface). The fallback is
 * the pre-marketplace behavior and must stay reachable.
 */
export function runClaudePluginInstall(plan: ClaudePluginInstallPlan): {
  installed: boolean;
  messages: string[];
} {
  const messages: string[] = [];
  const addResult = runExternal("claude", ["plugin", "marketplace", "add", plan.marketplace.source]);
  messages.push(
    addResult.ok
      ? `Executed: ${addResult.message}`
      : "Claude marketplace add failed [claude_marketplace_add_failed]; falling back to the local plugin path.",
  );

  if (addResult.ok) {
    const pluginId = `oms@${plan.marketplace.marketplaceName}`;
    const installResult = runExternal("claude", ["plugin", "install", pluginId]);
    if (installResult.ok) {
      messages.push(`Executed: ${installResult.message}`);
      return { installed: true, messages };
    }
    messages.push(
      `Claude marketplace install of ${pluginId} failed [claude_marketplace_install_failed]; falling back to the local plugin path.`,
    );
  }

  const fallbackResult = runExternal("claude", ["plugin", "install", plan.pluginPath]);
  messages.push(
    fallbackResult.ok
      ? `Executed: ${fallbackResult.message} (local plugin path fallback).`
      : plan.describeFailure(fallbackResult),
  );
  return { installed: fallbackResult.ok, messages };
}

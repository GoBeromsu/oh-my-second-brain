import { resolveBundledAssetPaths } from "../runtime/assets.js";

const bundledAssets = resolveBundledAssetPaths();

export interface ClaudeInstallPlan {
  pluginPath: string;
  pluginInstallCommand: string;
  mcpRegistrationCommand: string;
  mcpRuntimeStatus: "read-status-runtime";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildClaudeInstallPlan(opts: { vault: string }): ClaudeInstallPlan {
  const pluginPath = bundledAssets.claudeAdapterDir;
  return {
    pluginPath,
    pluginInstallCommand: `claude plugin install ${shellQuote(pluginPath)}`,
    mcpRegistrationCommand: `claude mcp add oms -- oms mcp --vault ${shellQuote(opts.vault)}`,
    mcpRuntimeStatus: "read-status-runtime",
  };
}

export function printClaudeInstallPlan(plan: ClaudeInstallPlan): void {
  console.log("Claude Code harness install plan (dry-run).");
  console.log(`  Plugin path: ${plan.pluginPath}`);
  console.log(`  Plugin command: ${plan.pluginInstallCommand}`);
  console.log(`  MCP command: ${plan.mcpRegistrationCommand}`);
  console.log(
    "  MCP status: status/read/cache/retrieval plus safe capture; commit is gated by vault confinement and contract validation.",
  );
}

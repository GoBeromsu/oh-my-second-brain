import { resolveBundledAssetPaths } from "../core/runtime/assets.js";

const bundledAssets = resolveBundledAssetPaths();

export interface ClaudeInstallPlan {
  pluginPath: string;
  pluginInstallCommand: string;
  pluginMcpAsset: string;
  mcpRuntimeStatus: "read-status-runtime";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildClaudeInstallPlan(_opts: { vault: string }): ClaudeInstallPlan {
  const pluginPath = bundledAssets.packageRoot;
  return {
    pluginPath,
    pluginInstallCommand: `claude plugin install ${shellQuote(pluginPath)}`,
    pluginMcpAsset: `${pluginPath}/.mcp.json`,
    mcpRuntimeStatus: "read-status-runtime",
  };
}

export function printClaudeInstallPlan(plan: ClaudeInstallPlan): void {
  console.log("Claude Code harness install plan (dry-run).");
  console.log(`  Plugin path: ${plan.pluginPath}`);
  console.log(`  Plugin command: ${plan.pluginInstallCommand}`);
  console.log(`  MCP asset: ${plan.pluginMcpAsset}`);
  console.log("  MCP registration: plugin-owned and plugin-qualified; no bare `claude mcp add oms` command.");
  console.log(
    "  MCP status: status/read/cache/retrieval plus write; write is gated by vault confinement and contract validation.",
  );
}

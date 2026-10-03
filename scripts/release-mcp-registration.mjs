import { realpathSync } from "node:fs";
import path from "node:path";

function requireSamePath(actual, expected, label) {
  if (typeof actual !== "string" || !path.isAbsolute(actual) ||
    typeof expected !== "string" || !path.isAbsolute(expected)) {
    throw new Error(`installed Hermes MCP ${label} must be an absolute path`);
  }
  if (realpathSync(actual) !== realpathSync(expected)) {
    throw new Error(`installed Hermes MCP ${label} does not match the verified candidate`);
  }
}

/** Validate the installed launch itself before the release rehearsal executes it. */
export function assertBoundMcpRegistration(registration, expected) {
  if (registration === null || typeof registration !== "object" ||
    !Array.isArray(registration.args) || registration.args.length !== 5 ||
    !registration.args.every(arg => typeof arg === "string") ||
    registration.args[1] !== "serve" || registration.args[2] !== "mcp" || registration.args[3] !== "--vault") {
    throw new Error("installed Hermes MCP registration must use the bound Node/CLI serve mcp launch");
  }
  requireSamePath(registration.command, expected.node, "Node executable");
  requireSamePath(registration.args[0], expected.cli, "CLI entrypoint");
  requireSamePath(registration.args[4], expected.vault, "vault");
  requireSamePath(expected.pointerVault, expected.vault, "host pointer vault");
}

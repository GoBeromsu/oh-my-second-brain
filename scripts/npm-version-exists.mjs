#!/usr/bin/env node
// Registry presence check for idempotent re-runs of release.yml.
// Usage: node scripts/npm-version-exists.mjs <X.Y.Z>
// Exit 0 = version is published, 1 = version is absent, 2 = the check itself failed
// (network/registry/auth error - NEVER report an unreachable registry as 'absent').
import { execFileSync } from "node:child_process";

const PACKAGE_NAME = "oh-my-second-brain";

const version = process.argv[2];
if (!version) {
  console.error("[npm-version-exists] usage: node scripts/npm-version-exists.mjs <X.Y.Z>");
  process.exit(2);
}

const spec = `${PACKAGE_NAME}@${version}`;

let stdout;
try {
  stdout = execFileSync("npm", ["view", spec, "version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  if (/E404|404 Not Found|is not in this registry|no such package available/i.test(stderr)) {
    console.log(`[npm-version-exists] ${spec} is not published`);
    process.exit(1);
  }
  process.stderr.write(stderr);
  console.error(`[npm-version-exists] registry check failed for ${spec}: npm view exited ${error?.status ?? "unknown"}`);
  process.exit(2);
}

const printed = stdout.trim();
if (printed === "") {
  // npm exits 0 with empty stdout when the name exists but the exact version does not.
  console.log(`[npm-version-exists] ${spec} is not published`);
  process.exit(1);
}

console.log(`[npm-version-exists] ${spec} is published (${printed})`);
process.exit(0);

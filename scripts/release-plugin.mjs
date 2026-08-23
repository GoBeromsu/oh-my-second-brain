#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const REQUIRED_ATTESTATION_FIELDS = [
  "actor",
  "timestamp",
  "command",
  "pluginPath",
  "exitCode",
];

function fail(message) {
  console.error(`[release:plugin] ${message}`);
  process.exit(1);
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf-8" });
  return result.status === 0;
}

function readAttestation() {
  const raw = process.env.OMS_PLUGIN_VALIDATION_ATTESTATION;
  if (!raw) return null;
  const text = existsSync(raw) ? readFileSync(raw, "utf-8") : raw;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid OMS_PLUGIN_VALIDATION_ATTESTATION JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateAttestation(attestation) {
  const missing = REQUIRED_ATTESTATION_FIELDS.filter((field) => attestation[field] === undefined || attestation[field] === "");
  if (missing.length > 0) {
    fail(`plugin validation attestation missing required fields: ${missing.join(", ")}`);
  }
  if (attestation.exitCode !== 0) {
    fail(`plugin validation attestation exitCode must be 0, got ${attestation.exitCode}`);
  }
  console.log(`[release:plugin] ok: accepted validation attestation from ${attestation.actor} at ${attestation.timestamp}.`);
}

if (commandExists("claude")) {
  const result = spawnSync("claude", ["plugin", "validate", "."], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`claude plugin validate failed with exit ${result.status}`);
  }
  console.log("[release:plugin] ok: claude plugin validate . passed.");
  process.exit(0);
}

const attestation = readAttestation();
if (attestation) {
  validateAttestation(attestation);
  process.exit(0);
}

if (process.env.OMS_REQUIRE_PLUGIN_VALIDATION === "1") {
  fail("Claude CLI unavailable and no valid OMS_PLUGIN_VALIDATION_ATTESTATION was provided; publish is blocked.");
}

console.warn("[release:plugin] warning: Claude CLI unavailable; skipped local plugin validation. Publish workflows must set OMS_REQUIRE_PLUGIN_VALIDATION=1 or provide attestation.");

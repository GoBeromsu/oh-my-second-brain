#!/usr/bin/env node
// One-command operator release: preflight -> lockstep bump -> changelog roll -> release:check
// -> commit -> tag -> atomic push -> CI watch. Publishing itself is CI-only (release.yml).
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  bumpedJsonVersion,
  bumpedMarketplace,
  bumpedPackageLock,
  isStableVersion,
  isVersionGreater,
  rolledChangelog,
  versionMismatches,
} from "./release-lib.mjs";

const TAG_PREFIX = "oms-v";
const RELEASE_BRANCH = "main";
const WATCH_POLL_MS = 15_000;
const WATCH_TIMEOUT_MS = 30 * 60 * 1000;
const USAGE = "usage: npm run release -- <X.Y.Z> [--allow-empty-changelog] | npm run release -- watch";

const JSON_CARRIERS = {
  packageJson: "package.json",
  claudePluginJson: "adapters/claude-code/.claude-plugin/plugin.json",
  codexPluginJson: "adapters/codex/.codex-plugin/plugin.json",
  hermesManifestJson: "adapters/hermes/manifest.json",
};
const PACKAGE_LOCK = "package-lock.json";
// Carries the version twice (top-level + plugins[0]), so it is bumped by parse-and-set.
const MARKETPLACE_JSON = ".claude-plugin/marketplace.json";
const CHANGELOG = "CHANGELOG.md";

const FIX_FORWARD = [
  "fix-forward guidance:",
  `  - the tag is immutable: never retag, delete, or force-push ${TAG_PREFIX}<version>.`,
  "  - commit the fix on main and release a NEWER version (npm run release -- <next X.Y.Z>).",
  "  - inspect the failing run with: gh run view <databaseId> --log-failed",
].join("\n");

/**
 * Parse operator CLI arguments. Pure: no I/O, throws on anything invalid.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{ mode: "watch" } | { mode: "release", version: string, allowEmptyChangelog: boolean }}
 */
export function parseReleaseCli(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.length === 1 && args[0] === "watch") {
    return { mode: "watch" };
  }
  const [version, ...rest] = args;
  if (!isStableVersion(version)) {
    throw new Error(`invalid version: ${version === undefined ? "(none)" : String(version)}\n${USAGE}`);
  }
  let allowEmptyChangelog = false;
  for (const arg of rest) {
    if (arg === "--allow-empty-changelog") {
      if (allowEmptyChangelog) {
        throw new Error(`duplicate flag: ${arg}\n${USAGE}`);
      }
      allowEmptyChangelog = true;
      continue;
    }
    throw new Error(`unexpected argument: ${String(arg)}\n${USAGE}`);
  }
  return { mode: "release", version, allowEmptyChangelog };
}

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

/**
 * Run a command, inheriting stderr so no child output is swallowed.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
function capture(command, args) {
  return execFileSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string }}
 */
function tryCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] });
  return { status: result.status, stdout: (result.stdout ?? "").trim() };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {number} exit status
 */
function runInherit(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  return result.status ?? 1;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Every check aborts before any file or git state is mutated.
 *
 * @param {string} version
 */
function preflight(version) {
  const status = tryCapture("git", ["status", "--porcelain"]);
  if (status.status !== 0) {
    fail("preflight: `git status --porcelain` failed; run the release from a git working tree.");
  }
  if (status.stdout !== "") {
    const changes = status.stdout
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    fail(`preflight: working tree is not clean. Commit or stash these changes before releasing:\n${changes}`);
  }

  const branch = tryCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status !== 0) {
    fail("preflight: could not resolve the current branch.");
  }
  if (branch.stdout !== RELEASE_BRANCH) {
    fail(`preflight: must run on ${RELEASE_BRANCH}, currently on ${branch.stdout}.`);
  }

  const fetch = tryCapture("git", ["fetch", "origin", RELEASE_BRANCH]);
  if (fetch.status !== 0) {
    fail(`preflight: \`git fetch origin ${RELEASE_BRANCH}\` failed; check network access to origin.`);
  }
  const head = capture("git", ["rev-parse", "HEAD"]);
  const upstream = tryCapture("git", ["rev-parse", `origin/${RELEASE_BRANCH}`]);
  if (upstream.status !== 0) {
    fail(`preflight: could not resolve origin/${RELEASE_BRANCH}.`);
  }
  if (head !== upstream.stdout) {
    fail(
      `preflight: HEAD (${head}) is not origin/${RELEASE_BRANCH} (${upstream.stdout}); pull or push before releasing.`,
    );
  }

  const auth = spawnSync("gh", ["auth", "status"], { stdio: "inherit" });
  if (auth.status !== 0) {
    fail("preflight: `gh auth status` failed; run `gh auth login` before releasing.");
  }

  if (!isStableVersion(version)) {
    fail(`preflight: invalid version ${version} (expected stable X.Y.Z).\n${USAGE}`);
  }
  const current = readJson(JSON_CARRIERS.packageJson).version;
  if (!isVersionGreater(version, current)) {
    fail(`preflight: version ${version} must be greater than the current version ${current}.`);
  }

  const tag = `${TAG_PREFIX}${version}`;
  const localTag = tryCapture("git", ["tag", "-l", tag]);
  if (localTag.status !== 0) {
    fail("preflight: `git tag -l` failed.");
  }
  if (localTag.stdout !== "") {
    fail(`preflight: tag ${tag} already exists locally; tags are immutable - release a newer version.`);
  }
  const remoteTag = tryCapture("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  if (remoteTag.status !== 0) {
    fail("preflight: `git ls-remote --tags origin` failed; check network access to origin.");
  }
  if (remoteTag.stdout !== "") {
    fail(`preflight: tag ${tag} already exists on origin; tags are immutable - release a newer version.`);
  }

  console.log(`[release] preflight ok: ${current} -> ${version} on ${RELEASE_BRANCH}.`);
}

/**
 * @param {string} version
 */
function bumpVersionCarriers(version) {
  for (const path of Object.values(JSON_CARRIERS)) {
    writeFileSync(path, bumpedJsonVersion(readFileSync(path, "utf-8"), version));
  }
  writeFileSync(PACKAGE_LOCK, bumpedPackageLock(readFileSync(PACKAGE_LOCK, "utf-8"), version));
  writeFileSync(MARKETPLACE_JSON, bumpedMarketplace(readFileSync(MARKETPLACE_JSON, "utf-8"), version));

  const mismatches = versionMismatches({
    version,
    packageJson: readJson(JSON_CARRIERS.packageJson),
    packageLock: readJson(PACKAGE_LOCK),
    claudePluginJson: readJson(JSON_CARRIERS.claudePluginJson),
    codexPluginJson: readJson(JSON_CARRIERS.codexPluginJson),
    hermesManifestJson: readJson(JSON_CARRIERS.hermesManifestJson),
    marketplaceJson: readJson(MARKETPLACE_JSON),
  });
  if (mismatches.length > 0) {
    fail(
      `version bump left carriers inconsistent (nothing committed; run \`git checkout -- .\` to restore):\n${mismatches
        .map((item) => `  - ${item}`)
        .join("\n")}`,
    );
  }
  console.log(`[release] bumped all version carriers to ${version}.`);
}

/**
 * @param {string} version
 * @param {boolean} allowEmpty
 */
function rollChangelog(version, allowEmpty) {
  const content = readFileSync(CHANGELOG, "utf-8");
  let rolled;
  try {
    rolled = rolledChangelog(content, version, utcDate(), { allowEmpty });
  } catch (error) {
    fail(
      `changelog roll failed (nothing committed; run \`git checkout -- .\` to restore): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  writeFileSync(CHANGELOG, rolled);
  console.log(`[release] rolled ${CHANGELOG} into [${version}].`);
}

/**
 * Poll release.yml runs for the given commit until one reaches a terminal conclusion.
 *
 * @param {string} sha
 * @returns {never}
 */
function watchRelease(sha) {
  console.log(`[release] watching release.yml runs for ${sha} (poll ${WATCH_POLL_MS / 1000}s, timeout ${WATCH_TIMEOUT_MS / 60000}min).`);
  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const listed = tryCapture("gh", [
      "run",
      "list",
      "--workflow=release.yml",
      "--json",
      "databaseId,status,conclusion,headSha",
      "--limit",
      "10",
    ]);
    if (listed.status !== 0) {
      console.error("[release] `gh run list` failed; retrying after the poll interval.");
    } else {
      let runs = [];
      try {
        runs = JSON.parse(listed.stdout);
      } catch (error) {
        console.error(`[release] could not parse gh run list JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      const run = runs.find((candidate) => candidate.headSha === sha);
      if (run && run.status === "completed") {
        if (run.conclusion === "success") {
          console.log(`[release] ok: release run ${run.databaseId} for ${sha} concluded success.`);
          process.exit(0);
        }
        console.error(`[release] release run ${run.databaseId} for ${sha} concluded ${run.conclusion}.`);
        console.error(FIX_FORWARD);
        process.exit(1);
      }
      console.log(
        run
          ? `[release] run ${run.databaseId} status=${run.status}; waiting.`
          : `[release] no release.yml run for ${sha} yet; waiting.`,
      );
    }
    sleep(WATCH_POLL_MS);
  }
  console.error(`[release] timed out after ${WATCH_TIMEOUT_MS / 60000}min waiting for a release.yml run for ${sha}.`);
  console.error(FIX_FORWARD);
  process.exit(1);
}

/**
 * Block the operator CLI without busy-waiting (no timers: this script is strictly sequential).
 *
 * @param {number} ms
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string[]} argv
 */
function main(argv) {
  let parsed;
  try {
    parsed = parseReleaseCli(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (parsed.mode === "watch") {
    watchRelease(capture("git", ["rev-parse", "HEAD"]));
  }

  const { version, allowEmptyChangelog } = parsed;
  const tag = `${TAG_PREFIX}${version}`;

  preflight(version);
  bumpVersionCarriers(version);
  rollChangelog(version, allowEmptyChangelog);

  const checkStatus = runInherit("npm", ["run", "release:check"]);
  if (checkStatus !== 0) {
    fail(
      `npm run release:check failed with exit ${checkStatus}. The version bump and changelog roll are still UNCOMMITTED in your working tree; run \`git checkout -- .\` to restore, or fix the failure and re-run.`,
    );
  }

  if (runInherit("git", ["add", "-u"]) !== 0) {
    fail("`git add -u` failed; the bump and changelog roll remain in the working tree.");
  }
  if (runInherit("git", ["commit", "-m", `chore(release): bump version to ${version}`]) !== 0) {
    fail("`git commit` failed; the bump is staged but uncommitted.");
  }
  if (runInherit("git", ["tag", tag]) !== 0) {
    fail(`\`git tag ${tag}\` failed; the release commit is local-only.`);
  }
  if (runInherit("git", ["push", "--atomic", "origin", RELEASE_BRANCH, tag]) !== 0) {
    fail(
      `\`git push --atomic origin ${RELEASE_BRANCH} ${tag}\` failed; nothing was published (the push is atomic, so neither ref moved). Fix the push and re-run \`git push --atomic origin ${RELEASE_BRANCH} ${tag}\`.`,
    );
  }

  console.log(`[release] pushed ${RELEASE_BRANCH} and ${tag}; CI (release.yml) owns publishing from here.`);
  watchRelease(capture("git", ["rev-parse", "HEAD"]));
}

// Run the flow only when executed directly; importing for tests must be inert.
// realpathSync keeps the comparison honest when the invoked path goes through a symlink
// (e.g. macOS /tmp -> /private/tmp, or npm bin links).
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2));
}

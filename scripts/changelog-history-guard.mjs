// Fails CI loudly if a previously-released CHANGELOG.md heading disappears
// between the base ref and the working tree. A missing base ref is a CI
// config failure (exit 2), never a silent pass.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { missingReleasedHeadings } from "./release-lib.mjs";

const base = process.env.CHANGELOG_GUARD_BASE || "origin/main";

try {
  execFileSync("git", ["rev-parse", "--verify", base], { stdio: "pipe" });
} catch {
  console.error(`changelog-history-guard: base ref '${base}' does not exist or is not fetched.`);
  process.exit(2);
}

let baseContent;
try {
  baseContent = execFileSync("git", ["show", `${base}:CHANGELOG.md`], {
    encoding: "utf8",
    stdio: "pipe",
  });
} catch {
  console.log(
    `changelog-history-guard: CHANGELOG.md does not exist at '${base}' yet - treating as first introduction. ok.`,
  );
  process.exit(0);
}

let headContent;
try {
  headContent = readFileSync("CHANGELOG.md", "utf8");
} catch {
  headContent = "";
}

const missing = missingReleasedHeadings(baseContent, headContent);

if (missing.length > 0) {
  console.error(
    `changelog-history-guard: ${missing.length} released heading(s) present at '${base}' are missing from the working tree CHANGELOG.md:`,
  );
  for (const heading of missing) {
    console.error(`  - ${heading}`);
  }
  process.exit(1);
}

console.log("changelog-history-guard: ok - no released headings were removed.");
process.exit(0);

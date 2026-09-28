#!/usr/bin/env node
// MIRACL-ko download for bench tier 2. Disabled: it refuses to run.
//
// The Hugging Face cards for miracl/miracl and miracl/miracl-corpus declare
// Apache-2.0, but the Korean passages are Wikipedia text, which upstream is
// CC BY-SA. The cards do not reconcile the two, so redistribution and derived
// fixtures are not cleared. Tier 2 stays skipped until the owner signs off on the
// license; enabling this script is that sign-off's code change.

import { pathToFileURL } from "node:url";

/** Why tier 2 is skipped. Reports and the runner print this verbatim. */
export const MIRACL_SKIP_REASON =
  "skipped (license unverified): MIRACL-ko cards declare Apache-2.0, but the passages are Wikipedia text under CC BY-SA; owner sign-off is required before download";

export const MIRACL_SOURCES = /** @type {const} */ ([
  "https://huggingface.co/datasets/miracl/miracl",
  "https://huggingface.co/datasets/miracl/miracl-corpus",
]);

function main() {
  process.stderr.write(`miracl-download refused: ${MIRACL_SKIP_REASON}\nsources: ${MIRACL_SOURCES.join(", ")}\n`);
  process.exitCode = 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { absolute, pathExists } from "./repo-root.js";

/**
 * Installable-default disclosure gate.
 *
 * `docs/measurements/model-default-deferral.md` withholds *automatic*
 * default-model acquisition until a green real-vault `model-default` manifest
 * exists, and separately records the vault owner's authorisation of the
 * explicit, opt-in `oms setup --embedding-default` install. Nothing in
 * `package.json` or the workflows ever asks for that manifest — `check:measurement`
 * runs the `boost-c040` profile only — so the deferral can stay open indefinitely
 * while an installable default ships.
 *
 * This gate does NOT try to close that by demanding the manifest. Only the vault
 * owner can produce one from a real vault with curated labels, so a gate
 * requiring it would fail every CI run for a reason no contributor could fix,
 * and the preregistration forbids satisfying it with fabricated relevance. That
 * decision belongs to the owner, not to a test.
 *
 * What a test CAN hold is the honesty invariant underneath it: **if an
 * installable default ships, the repository must still say the model is
 * unmeasured.** Today that disclosure is prose, and prose can be deleted or
 * reworded in a routine edit while the shipping default stays exactly as it is —
 * which would turn an openly-declared tradeoff into a silent one. That is the
 * half of the drift a gate can actually prevent, so this gate prevents it.
 *
 * Both directions are enforced. Withdrawing the default is legitimate and lifts
 * the requirement; keeping the default while dropping the disclosure fails.
 */

const DEFERRAL_DOC = "docs/measurements/model-default-deferral.md";
const MODEL_SOURCE = "src/kernel/engine/embed/model.ts";
const CLI_SOURCE = "src/cli/oms.ts";
const CLI_ARGS = "src/cli/args.ts";

const PINNED_CONSTANT = "PINNED_DEFAULT_EMBEDDING_MODEL";
const DEFAULT_FLAG = "--embedding-default";

/**
 * Sentences that carry the unmeasured status. Each is matched as a regex so
 * incidental whitespace or line wrapping does not decide whether the repository
 * is judged honest, but the substance still has to be present.
 */
const DISCLOSURE_ANCHORS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  {
    label: "states no real-vault model-default measurement exists for this model",
    pattern: /No real-vault\s+`model-default`\s+measurement exists for this model/u,
  },
  {
    label: "attributes quality to matching the reference toolchain rather than measurement",
    pattern: /not on a measured\s+comparison/u,
  },
  {
    label: "keeps the closing condition on a validator-accepted real-vault manifest",
    pattern: /closes only on a validator-accepted, green\s+`model-default`\s+manifest/u,
  },
  {
    label: "keeps automatic or implicit acquisition withheld",
    pattern: /automatic or implicit default-model acquisition stays withheld/u,
  },
];

async function read(relativePath: string): Promise<string> {
  return readFile(absolute(relativePath), "utf8");
}

/**
 * True when the tree ships a default a user can install in one step: the
 * descriptor constant exists, the CLI consumes it, and a flag reaches that path.
 * All three are required, so deleting any one of them is a real withdrawal
 * rather than a way to slip past the disclosure requirement.
 */
async function shipsInstallableDefault(): Promise<boolean> {
  const [model, cli, args] = await Promise.all([
    read(MODEL_SOURCE),
    read(CLI_SOURCE),
    read(CLI_ARGS),
  ]);
  return (
    model.includes(`export const ${PINNED_CONSTANT}`) &&
    cli.includes(PINNED_CONSTANT) &&
    args.includes(DEFAULT_FLAG)
  );
}

describe("installable default embedding model discloses its unmeasured status", () => {
  it("scans the real source and documentation paths", async () => {
    // A gate that silently stopped finding its own inputs would pass forever.
    for (const relativePath of [DEFERRAL_DOC, MODEL_SOURCE, CLI_SOURCE, CLI_ARGS]) {
      expect(await pathExists(relativePath), `${relativePath} must exist for this gate to mean anything`).toBe(true);
    }
  });

  it("keeps the unmeasured-status disclosure while an installable default ships", async () => {
    if (!(await shipsInstallableDefault())) {
      // No installable default ships, so there is nothing to disclose. This is
      // the legitimate withdrawal path, not a bypass.
      return;
    }

    const doc = await read(DEFERRAL_DOC);
    const missing = DISCLOSURE_ANCHORS.filter((anchor) => !anchor.pattern.test(doc)).map(
      (anchor) => anchor.label,
    );

    expect(
      missing,
      `${DEFERRAL_DOC} must keep disclosing that the shipped installable default is unmeasured. ` +
        "Missing: " +
        missing.join("; ") +
        ". Either restore the disclosure, or withdraw the installable default " +
        `(${PINNED_CONSTANT} plus its ${DEFAULT_FLAG} wiring).`,
    ).toEqual([]);
  });

  it("records that no pipeline demands the model-default measurement", async () => {
    // The gap itself is a governance decision for the vault owner, but it must
    // not be possible to believe it was closed. If some pipeline later does
    // demand the profile, this expectation fails and the comment above plus the
    // deferral doc's standing caveat need rewriting to match reality.
    const packageJson = await read("package.json");
    expect(packageJson).toContain("OMS_MEASUREMENT_PROFILE=boost-c040");
    expect(packageJson).not.toContain("OMS_MEASUREMENT_PROFILE=model-default");
  });
});

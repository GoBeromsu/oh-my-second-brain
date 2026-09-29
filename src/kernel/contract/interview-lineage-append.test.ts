import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVaultSettings, serializeVaultSettings, SETTINGS_PATH } from "../vault/settings.js";
import { runInterview, type InterviewIO, type Question } from "./interview.js";
import { lineageHealth } from "./lineage-health.js";
import { LineageAppendFailed } from "./lineage.js";
import { recoverLineage } from "./store.js";
import { resolveSealState } from "./vault-id.js";

// The seal's default `onSealed` fails while `failAppend` is set, as a full disk would.
const failAppend = vi.hoisted(() => ({ on: false }));
vi.mock("./lineage.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./lineage.js")>();
  return {
    ...actual,
    lineageAppender: (...args: Parameters<typeof actual.lineageAppender>) => {
      const append = actual.lineageAppender(...args);
      return async (sealed: Parameters<typeof append>[0]) => {
        if (failAppend.on) throw new Error("disk full");
        return append(sealed);
      };
    },
  };
});

// interview.ts records the template folder through this export; fail it while `failSettings` is set.
const failSettings = vi.hoisted(() => ({ on: false }));
vi.mock("./vault-id.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./vault-id.js")>();
  return {
    ...actual,
    writeVaultSettings: async (...args: Parameters<typeof actual.writeVaultSettings>) => {
      if (failSettings.on) throw new Error("EACCES: settings unwritable");
      return actual.writeVaultSettings(...args);
    },
  };
});

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";

let base: string;
let vault: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "oms-interview-append-")));
  vault = join(base, "vault");
  root = join(base, "home", ".oms", "vaults");
  await mkdir(join(vault, "Projects"), { recursive: true });
  await mkdir(join(vault, ".obsidian"));
  await mkdir(join(vault, "Templates"));
  await mkdir(join(vault, ".oms"));
  await writeFile(join(vault, SETTINGS_PATH), serializeVaultSettings({ version: 1, vaultId: VAULT_ID }));
  await writeFile(join(vault, ".obsidian/templates.json"), JSON.stringify({ folder: "Templates" }));
  await writeFile(join(vault, "Templates/Meeting.md"), "---\nstatus: open\n---\n## Agenda\n");
});

afterEach(async () => {
  failAppend.on = false;
  failSettings.on = false;
  await rm(base, { recursive: true, force: true });
});

const ANSWERS: Readonly<Record<string, string>> = {
  "template-folder:confirm": "",
  "folder:Projects:register": "y",
  "folder:Projects:meaning": "project notes",
  "folder:Projects:search-exclude": "n",
  "folder:Templates:register": "n",
  // Offered because the Meeting template sets it.
  "property:status:register": "n",
  "seal": "y",
};

function scripted(): InterviewIO & { readonly recorded: string[] } {
  const recorded: string[] = [];
  return {
    recorded,
    say: () => undefined,
    ask: async (question: Question) => {
      const answer = ANSWERS[question.id];
      if (answer === undefined) throw new Error(`unscripted question ${question.id}`);
      return answer;
    },
    record: async event => { recorded.push(event.type); },
  };
}

describe("a first interview seal whose lineage append fails", () => {
  it("still records the chosen template folder, so lineage-recover alone completes the seal", async () => {
    failAppend.on = true;
    const io = scripted();
    await expect(runInterview({ vault, io, root }))
      .rejects.toMatchObject({ code: "CONTRACT_LINEAGE_APPEND_FAILED", message: expect.stringContaining("oms doctor lineage-recover") });
    expect((await readVaultSettings(vault))?.templateFolder).toBe("Templates");
    expect(io.recorded).not.toContain("sealed");
    expect((await resolveSealState(vault, root)).row).toBe("store-without-index");

    // What `oms doctor lineage-recover` runs for this row: the index entry, then the lineage.
    failAppend.on = false;
    await recoverLineage(root, VAULT_ID, { policy: "refuse", reindex: await realpath(vault) });
    expect((await resolveSealState(vault, root)).row).toBe("sealed");
    expect((await lineageHealth(VAULT_ID, root)).findings).toEqual([]);
  });

  it("still throws the append failure when recording the template folder also fails", async () => {
    failAppend.on = true;
    failSettings.on = true;
    const failure = await runInterview({ vault, io: scripted(), root }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(LineageAppendFailed);
    expect(failure).toMatchObject({ code: "CONTRACT_LINEAGE_APPEND_FAILED", cause: expect.objectContaining({ message: "disk full" }) });
    expect((await readVaultSettings(vault))?.templateFolder).toBeUndefined();
  });

  it("leaves the settings alone when the seal fails before linking the generation", async () => {
    const symlinkFailed = async (): Promise<void> => { throw Object.assign(new Error("EIO: symlink failed"), { code: "EIO" }); };
    const sealDeps = { fs: { rename, rm, symlink: symlinkFailed } };
    await expect(runInterview({ vault, io: scripted(), root, sealDeps }))
      .rejects.toMatchObject({ code: "EIO" });
    expect((await readVaultSettings(vault))?.templateFolder).toBeUndefined();
  });
});

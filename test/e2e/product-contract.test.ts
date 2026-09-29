import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealContract } from "../../src/kernel/contract/store.js";
import type { VaultContract } from "../../src/kernel/contract/types.js";
import { writeSettings } from "../fixtures/contract-truth-table.js";
// @ts-expect-error -- plain .mjs fixture helper shared with the bench script; it has no type declarations.
import { materializeKoVault, NFC_NOTE, NFD_NOTE, NFD_NOTE_ON_DISK } from "../fixtures/ko-vault.mjs";

/**
 * Product-contract snapshot of the built CLI (0.18.3 behaviour).
 *
 * Every subprocess runs `dist/cli/oms.js` with HOME, USERPROFILE, XDG_* and every OMS_* home
 * redirected into a fresh temp dir. The contract store root is `homedir()/.oms/vaults` with
 * no env override, so HOME isolation is what keeps the real store safe; the suite proves it
 * by comparing a content snapshot of the real `~/.oms` before and after.
 */

const REPO = path.resolve(import.meta.dirname, "..", "..");
const OMS = path.join(REPO, "dist", "cli", "oms.js");
// Resolved from the passwd entry, not $HOME, which the vitest setup file already redirected.
const REAL_OMS = path.join(userInfo().homedir, ".oms");

type TreeSnapshot = { readonly exists: false } | { readonly exists: true; readonly entries: Readonly<Record<string, string>> };

/**
 * Files that a live OMS process on this machine (for example an MCP server an editor started)
 * legitimately rewrites while the suite runs:
 * - the SQLite WAL/SHM sidecars under `runtime/`
 * - the event journal under `runtime/`
 * - directory entries under `runtime/`, which such a process may create or remove
 * - the update-notice cache
 * They are excluded so the snapshot does not give false failures on dev machines. Everything
 * else, including `vaults/**` and `config.yaml`, is still compared by sha256: the suite must
 * never create, change or remove it.
 */
function isVolatile(rel: string, isDirectory: boolean): boolean {
  const posix = rel.split(path.sep).join("/");
  if (posix === "update-notice-cache.json") return true;
  if (!posix.startsWith("runtime/")) return false;
  return isDirectory || /(\.sqlite-wal|\.sqlite-shm|\/events\.sqlite)$/.test(posix);
}

function snapshotTree(root: string): TreeSnapshot {
  if (!existsSync(root)) return { exists: false };
  const entries: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        if (!isVolatile(rel, false)) entries[rel] = `symlink:${readlinkSync(full)}`;
      } else if (stat.isDirectory()) {
        if (!isVolatile(rel, true)) entries[rel] = "dir";
        walk(full);
      } else if (!isVolatile(rel, false)) entries[rel] = `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
    }
  };
  walk(root);
  return { exists: true, entries };
}

const CONTRACT: VaultContract = {
  folders: {
    Projects: { meaning: "active projects", searchExclude: false },
    Areas: { meaning: "ongoing areas", searchExclude: false },
    Resources: { meaning: "reference material", searchExclude: false },
    지식: { meaning: "knowledge notes", searchExclude: false },
    Daily: { meaning: "daily notes", searchExclude: false },
  },
  properties: {
    status: {
      meaning: "note lifecycle",
      type: "text",
      default: false,
      required: true,
      rules: [{ kind: "allowed", values: ["진행중", "완료", "보류", "active"] }],
    },
  },
};

let base = "";
let vault = "";
let env: NodeJS.ProcessEnv = {};
let realOmsBefore: TreeSnapshot = { exists: false };

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function oms(args: readonly string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync(process.execPath, [OMS, ...args], {
    cwd: base,
    env: { ...env, ...extraEnv },
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json(run: Run): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  realOmsBefore = snapshotTree(REAL_OMS);
  if (!existsSync(OMS)) throw new Error("run `npm run build` before the product-contract e2e tests (dist/cli/oms.js missing)");

  base = await realpath(await mkdtemp(path.join(tmpdir(), "oms-product-contract-")));
  const home = path.join(base, "home");
  const isolated: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    OMS_RUNTIME_ROOT: path.join(base, "runtime"),
    OMS_AUTO_UPDATE_STATE_DIR: path.join(base, "auto-update"),
    OMS_CLAUDE_HOME: path.join(base, "claude"),
    OMS_CODEX_HOME: path.join(base, "codex"),
    OMS_HERMES_HOME: path.join(base, "hermes"),
    XDG_CONFIG_HOME: path.join(base, "xdg-config"),
    XDG_CACHE_HOME: path.join(base, "xdg-cache"),
  };
  for (const dir of Object.values(isolated)) await mkdir(dir, { recursive: true });
  env = { ...process.env, ...isolated };
  delete env["OMS_VAULT"];

  vault = materializeKoVault(path.join(base, "vault")) as string;
  const vaultId = randomUUID();
  await writeSettings(vault, vaultId);
  await sealContract({ vaultRealPath: await realpath(vault), vaultId, contract: CONTRACT }, path.join(home, ".oms", "vaults"));
});

afterAll(async () => {
  if (base !== "") await rm(base, { recursive: true, force: true });
  expect(snapshotTree(REAL_OMS)).toEqual(realOmsBefore);
});

describe("product contract (built CLI, isolated home)", () => {
  it("materializes one NFD and one NFC Hangul filename", () => {
    const nfdDir = readdirSync(path.join(vault, path.dirname(NFD_NOTE)));
    expect(nfdDir).toContain(path.basename(NFD_NOTE).normalize("NFD"));
    expect(nfdDir).not.toContain(path.basename(NFD_NOTE).normalize("NFC"));
    expect(readdirSync(path.join(vault, path.dirname(NFC_NOTE)))).toContain(path.basename(NFC_NOTE).normalize("NFC"));
  });

  it("search is lexical-only and finds the Korean compound-word note", () => {
    const run = oms(["search", "낙상판정기준", "--vault", vault]);
    expect(run.status).toBe(0);
    const out = json(run) as { available: boolean; hits: { path: string; evidence: { lexical: boolean; vector: boolean } }[]; receipt: { usedChannels: string[] } };
    expect(out.available).toBe(true);
    expect(out.receipt.usedChannels).toEqual(["lex"]);
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits.map(hit => hit.path.normalize("NFC"))).toContain(NFC_NOTE);
    for (const hit of out.hits) expect(hit.evidence).toMatchObject({ lexical: true, vector: false });
  });

  it("search reaches the NFD-named note", () => {
    const run = oms(["search", "고위험군 중재", "--vault", vault]);
    expect(run.status).toBe(0);
    const out = json(run) as { hits: { path: string }[] };
    expect(out.hits.map(hit => hit.path.normalize("NFC"))).toContain(NFD_NOTE);
  });

  it("search with no match returns an empty, available result", () => {
    const run = oms(["search", "zzzqqq", "--vault", vault]);
    expect(run.status).toBe(0);
    expect(json(run)).toMatchObject({ available: true, hits: [], totalCount: 0 });
  });

  it("search --path reads the NFC note by path", async () => {
    const run = oms(["search", "--path", NFC_NOTE, "--vault", vault]);
    expect(run.status).toBe(0);
    const out = json(run) as { available: boolean; documents: { path: string; content: string }[] };
    expect(out.available).toBe(true);
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0]!.path).toBe(NFC_NOTE);
    expect(out.documents[0]!.content).toBe(await readFile(path.join(vault, NFC_NOTE), "utf8"));
  });

  it("search --path reads the NFD-named note by its on-disk spelling on every platform", async () => {
    const run = oms(["search", "--path", NFD_NOTE_ON_DISK, "--vault", vault]);
    expect(run.status).toBe(0);
    const out = json(run) as { available: boolean; documents: { path: string; content: string }[] };
    expect(out.available).toBe(true);
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0]!.path).toBe(NFD_NOTE_ON_DISK);
    expect(out.documents[0]!.content).toBe(await readFile(path.join(vault, NFD_NOTE_ON_DISK), "utf8"));
  });

  it("search --path accepts the NFD hit path that search returns", async () => {
    const search = json(oms(["search", "고위험군 중재", "--vault", vault])) as { hits: { path: string }[] };
    const hit = search.hits.find(candidate => candidate.path.normalize("NFC") === NFD_NOTE);
    expect(hit).toBeDefined();
    const run = oms(["search", "--path", hit!.path, "--vault", vault]);
    expect(run.status).toBe(0);
    const out = json(run) as { available: boolean; documents: { content: string }[] };
    expect(out.available).toBe(true);
    expect(out.documents[0]!.content).toBe(await readFile(path.join(vault, NFD_NOTE_ON_DISK), "utf8"));
  }, 30_000);

  it("search --path reads the NFD-named note from its NFC spelling on every platform", async () => {
    const run = oms(["search", "--path", NFD_NOTE.normalize("NFC"), "--vault", vault]);
    expect(run.status).toBe(0);
    const out = json(run) as { available: boolean; documents: { target: string; path: string; content: string; revision: string }[] };
    expect(out.available).toBe(true);
    expect(out.documents).toHaveLength(1);
    const bytes = await readFile(path.join(vault, NFD_NOTE_ON_DISK));
    expect(out.documents[0]).toEqual({
      target: NFD_NOTE.normalize("NFC"),
      path: NFD_NOTE_ON_DISK,
      content: bytes.toString("utf8"),
      revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  });

  it("search --path on a missing path or a bare title is unavailable with exit 1", () => {
    for (const target of ["Resources/없음.md", "낙상판정기준"]) {
      const run = oms(["search", "--path", target, "--vault", vault]);
      expect(run.status).toBe(1);
      expect(json(run)).toMatchObject({ available: false, documents: [] });
    }
  }, 30_000);

  it("MCP write over stdio saves an allowed note, keeps an out-of-rule one as written, drafts unparsable frontmatter and refuses a control path", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [OMS, "serve", "mcp", "--vault", vault],
      cwd: base,
      env: env as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "product-contract-e2e", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual(["doctor", "interview", "search", "write"]);

      const allowedPath = "Projects/새 프로젝트.md";
      const allowedContent = "---\nstatus: 진행중\n---\n# 새 프로젝트\n\n[[낙상판정기준]] 참고.\n";
      const allowed = (await client.callTool({ name: "write", arguments: { path: allowedPath, content: allowedContent } })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      expect(allowed.isError).toBeFalsy();
      expect(JSON.parse(allowed.content[0]!.text)).toMatchObject({ ok: true, missingDefaults: [] });
      expect(await readFile(path.join(vault, allowedPath), "utf8")).toBe(allowedContent);

      // A value outside the allowed values is saved as written with a warning.
      const keptPath = "Projects/엉터리 상태.md";
      const kept = (await client.callTool({
        name: "write",
        arguments: { path: keptPath, content: "---\nstatus: 엉터리\n---\n# 엉터리\n" },
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      expect(kept.isError).toBeFalsy();
      expect(JSON.parse(kept.content[0]!.text)).toMatchObject({ ok: true, warnings: [{ field: "status", kind: "not-allowed" }], fixes: [] });
      expect(await readFile(path.join(vault, keptPath), "utf8")).toBe("---\nstatus: 엉터리\n---\n# 엉터리\n");

      // Frontmatter that does not parse is kept as a draft outside the vault; the result is not an error.
      const draftedPath = "Projects/깨진 머리말.md";
      const drafted = (await client.callTool({
        name: "write",
        arguments: { path: draftedPath, content: "---\nstatus: [엉터리\n---\n# 엉터리\n" },
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      expect(drafted.isError).toBeFalsy();
      expect(JSON.parse(drafted.content[0]!.text)).toMatchObject({ ok: false, status: "drafted", warnings: [{ field: "content", kind: "yaml-syntax" }] });
      expect(existsSync(path.join(vault, draftedPath))).toBe(false);

      // Only a safety refusal is an error.
      const refused = (await client.callTool({
        name: "write",
        arguments: { path: ".oms/엉터리.md", content: "---\nstatus: 완료\n---\n" },
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0]!.text)).toMatchObject({ ok: false, status: "denied", refusals: [{ field: "path", kind: "control-path" }] });
      expect(existsSync(path.join(vault, ".oms", "엉터리.md"))).toBe(false);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("hook pre allows a Write that violates the sealed contract with a warning", () => {
    const target = path.join(vault, "Projects", "가드 경고.md");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target, content: "---\nstatus: 엉터리\n---\n# 가드\n" },
      cwd: vault,
    };
    const run = oms(["hook", "pre"], JSON.stringify(payload), { OMS_VAULT: vault });
    expect(run.status).toBe(0);
    const message = '[oms] write allowed with warnings: [{"field":"status","kind":"not-allowed"}] Run: oms doctor status';
    expect(json(run)).toEqual({ systemMessage: message, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } });
    expect(existsSync(target)).toBe(false);
  });

  it("hook pre denies a Write to the vault's control path", () => {
    const target = path.join(vault, ".oms", "가드 거부.md");
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: target, content: "---\nstatus: 완료\n---\n# 가드\n" },
      cwd: vault,
    };
    const run = oms(["hook", "pre"], JSON.stringify(payload), { OMS_VAULT: vault });
    expect(run.status).toBe(0);
    expect(json(run)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: '[oms] write denied: [{"field":"path","kind":"control-path"}] Run: oms doctor status',
      },
    });
    expect(existsSync(target)).toBe(false);
  });

  it("hook pre allows a Write that satisfies the sealed contract", () => {
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(vault, "Projects", "가드 허용.md"), content: "---\nstatus: 완료\n---\n# 가드\n" },
      cwd: vault,
    };
    const run = oms(["hook", "pre"], JSON.stringify(payload), { OMS_VAULT: vault });
    expect(run.status).toBe(0);
    expect(json(run)).toEqual({ continue: true, suppressOutput: true });
  });

  it("doctor contract reports the sealed contract for the fixture vault", () => {
    const run = oms(["doctor", "contract", "--vault", vault]);
    expect(run.status).toBe(0);
    expect(json(run)).toMatchObject({
      contract: "sealed",
      findings: [{ message: "contract: sealed", guidance: null }],
      cause: null,
      unsafePatterns: [],
      staleLocks: 0,
      orphans: 0,
      unexpectedControlFiles: [],
    });
  });
});

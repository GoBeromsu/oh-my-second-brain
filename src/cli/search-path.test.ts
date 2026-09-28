import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readExactDocument } from "../kernel/search/read-exact.js";
import { runSearchCommand, type SearchCommandDeps } from "./search.js";

const NFC_NAME = "낙상 위험 평가.md";
const NFD_NAME = NFC_NAME.normalize("NFD");
const ISOLATED_ENV = [
  "HOME",
  "USERPROFILE",
  "OMS_RUNTIME_ROOT",
  "OMS_AUTO_UPDATE_STATE_DIR",
  "OMS_CLAUDE_HOME",
  "OMS_CODEX_HOME",
  "OMS_HERMES_HOME",
  "OMS_VAULT",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

let base: string;
let vault: string;
let savedEnv: Record<string, string | undefined>;
let logs: string[];
let errors: string[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "oms-search-path-")));
  savedEnv = Object.fromEntries(ISOLATED_ENV.map((name) => [name, process.env[name]]));
  for (const name of ISOLATED_ENV) process.env[name] = path.join(base, "env", name.toLowerCase());
  delete process.env.OMS_VAULT;
  vault = path.join(base, "vault");
  mkdirSync(path.join(vault, "지식"), { recursive: true });
  writeFileSync(path.join(vault, "지식", NFD_NAME), "# 낙상\n본문\n");
  logs = [];
  errors = [];
  process.exitCode = 0;
  vi.spyOn(console, "log").mockImplementation((message: unknown) => { logs.push(String(message)); });
  vi.spyOn(console, "error").mockImplementation((message: unknown) => { errors.push(String(message)); });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const name of ISOLATED_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

/** Real readExact behind a spy; the engine gateway is a spy that must never run. */
function spiedDeps(): SearchCommandDeps & {
  readonly readExactDocument: ReturnType<typeof vi.fn<SearchCommandDeps["readExactDocument"]>>;
  readonly runEngineSession: ReturnType<typeof vi.fn>;
  readonly runLinkFamilyCommand: ReturnType<typeof vi.fn<SearchCommandDeps["runLinkFamilyCommand"]>>;
} {
  return {
    readExactDocument: vi.fn<SearchCommandDeps["readExactDocument"]>(readExactDocument),
    runEngineSession: vi.fn(() => Promise.reject(new Error("engine must not open for search --path"))),
    runLinkFamilyCommand: vi.fn<SearchCommandDeps["runLinkFamilyCommand"]>(() => Promise.resolve()),
  };
}

function printed(): unknown {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]!);
}

describe("oms search --path", () => {
  it("reads the NFD note from its NFC spelling without opening an engine session", async () => {
    const deps = spiedDeps();
    await runSearchCommand(["--path", `지식/${NFC_NAME}`, "--vault", vault], deps);
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
    expect(printed()).toEqual({
      available: true,
      documents: [{
        target: `지식/${NFC_NAME}`,
        path: `지식/${NFD_NAME}`,
        content: "# 낙상\n본문\n",
        revision: `sha256:${createHash("sha256").update("# 낙상\n본문\n").digest("hex")}`,
      }],
    });
    expect(deps.readExactDocument).toHaveBeenCalledTimes(1);
    expect(deps.readExactDocument).toHaveBeenCalledWith(vault, `지식/${NFC_NAME}`);
    // The engine gateway is the only route to the Database constructor and the model
    // loader; readExact's own import graph is held engine-free by read-exact-isolation.
    expect(deps.runEngineSession).toHaveBeenCalledTimes(0);
  });

  it("accepts --vault before --path", async () => {
    const deps = spiedDeps();
    await runSearchCommand(["--vault", vault, "--path", `지식/${NFD_NAME}`], deps);
    expect(process.exitCode).toBe(0);
    expect(printed()).toMatchObject({ available: true, documents: [{ path: `지식/${NFD_NAME}` }] });
    expect(deps.runEngineSession).toHaveBeenCalledTimes(0);
  });

  it("prints an unavailable document result with exit 1 for a missing note", async () => {
    const deps = spiedDeps();
    await runSearchCommand(["--path", "지식/없음.md", "--vault", vault], deps);
    expect(process.exitCode).toBe(1);
    expect(printed()).toEqual({
      available: false,
      reason: expect.stringMatching(/^READ_EXACT_NOT_FOUND: /),
      documents: [],
    });
    expect(deps.runEngineSession).toHaveBeenCalledTimes(0);
  });

  it("refuses a path that leaves the vault", async () => {
    const deps = spiedDeps();
    await runSearchCommand(["--path", "../secret.md", "--vault", vault], deps);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatchObject({ available: false, reason: expect.stringMatching(/^READ_EXACT_INVALID_PATH: /) });
  });

  it.each([
    [["query", "topic", "--path", "a.md"]],
    [["--path", "a.md", "query", "topic"]],
    [["--path", "a.md", "--mode", "search"]],
    [["--path", "a.md", "--lex", "topic"]],
    [["context", "--path", "a.md"]],
    [["--path", "a.md", "b.md"]],
    [["query", "--path", "a.md", "--", "topic"]],
  ])("refuses --path combined with other search arguments: %j", async (argv) => {
    const deps = spiedDeps();
    await runSearchCommand([...argv, "--vault", vault], deps);
    expect(process.exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors).toEqual([expect.stringMatching(/^SEARCH_ARGS_INVALID: --path is mutually exclusive/)]);
    expect(deps.readExactDocument).toHaveBeenCalledTimes(0);
    expect(deps.runEngineSession).toHaveBeenCalledTimes(0);
  });

  it.each([[["--path"]], [["--path", "--vault", "x"]]])("requires a value for --path: %j", async (argv) => {
    const deps = spiedDeps();
    await runSearchCommand(argv, deps);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/SEARCH_ARGS_INVALID: (--path requires|--vault requires)/);
    expect(deps.readExactDocument).toHaveBeenCalledTimes(0);
  });

  it("surfaces an I/O failure on stderr with exit 1", async () => {
    const deps = spiedDeps();
    await runSearchCommand(["--path", "a.md", "--vault", path.join(base, "missing-vault")], deps);
    expect(process.exitCode).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toMatch(/ENOENT/);
    expect(deps.runEngineSession).toHaveBeenCalledTimes(0);
  });

  it("treats --path after a -- terminator as query text, not path mode", async () => {
    const deps = spiedDeps();
    const semanticQuery = vi.fn(() => Promise.resolve({ available: true, hits: [] }));
    const runEngineSession = vi.fn<SearchCommandDeps["runEngineSession"]>(
      (_vault, _options, fn) => fn({ semanticQuery } as never),
    );
    await runSearchCommand(["--vault", vault, "--", "--path"], { ...deps, runEngineSession });
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
    expect(runEngineSession).toHaveBeenCalledTimes(1);
    expect(semanticQuery).toHaveBeenCalledWith(expect.objectContaining({ query: "--path" }));
    expect(deps.readExactDocument).toHaveBeenCalledTimes(0);
  });

  it("treats --vault after a -- terminator as query text, not the vault flag", async () => {
    const deps = spiedDeps();
    const semanticQuery = vi.fn(() => Promise.resolve({ available: true, hits: [] }));
    const runEngineSession = vi.fn<SearchCommandDeps["runEngineSession"]>(
      (_vault, _options, fn) => fn({ semanticQuery } as never),
    );
    await runSearchCommand(["--vault", vault, "--", "--vault", "elsewhere"], { ...deps, runEngineSession });
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
    expect(runEngineSession).toHaveBeenCalledWith(path.resolve(vault), expect.anything(), expect.any(Function));
    expect(semanticQuery).toHaveBeenCalledWith(expect.objectContaining({ query: "--vault elsewhere" }));
  });

  it("still routes search query through the injected engine gateway", async () => {
    const deps = spiedDeps();
    const runEngineSession = vi.fn<SearchCommandDeps["runEngineSession"]>(
      () => Promise.resolve({ available: true, hits: [] } as never),
    );
    await runSearchCommand(["topic", "--vault", vault], { ...deps, runEngineSession });
    expect(process.exitCode).toBe(0);
    expect(runEngineSession).toHaveBeenCalledTimes(1);
    expect(deps.readExactDocument).toHaveBeenCalledTimes(0);
  });
});

describe("oms search --link", () => {
  it("forwards the resolved argv, not the raw argv, to link suggestion", async () => {
    for (const argv of [
      ["--vault", vault, "--link", "지식/a.md", "--json"],
      ["--link", "지식/a.md", "--vault", vault, "--json"],
      ["--link", "지식/a.md", "--json", "--vault", vault],
    ]) {
      const deps = spiedDeps();
      await runSearchCommand(argv, deps);
      expect(process.exitCode, argv.join(" ")).toBe(0);
      expect(deps.runLinkFamilyCommand, argv.join(" ")).toHaveBeenCalledWith(
        ["suggest", "지식/a.md", "--json", "--vault", vault],
      );
      expect(deps.runEngineSession).toHaveBeenCalledTimes(0);
    }
  });

  it("refuses a -- terminator with link suggestion rather than forwarding what follows as flags", async () => {
    const deps = spiedDeps();
    await runSearchCommand(["--link", "지식/a.md", "--", "--folder", "x", "--vault", vault], deps);
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([expect.stringMatching(/^SEARCH_ARGS_INVALID: --link does not accept a -- terminator/)]);
    expect(deps.runLinkFamilyCommand).toHaveBeenCalledTimes(0);
    expect(deps.runEngineSession).toHaveBeenCalledTimes(0);
  });

  it("keeps a later --link as a query filter rather than link suggestion", async () => {
    const deps = spiedDeps();
    const runEngineSession = vi.fn<SearchCommandDeps["runEngineSession"]>(
      () => Promise.resolve({ available: true, hits: [] } as never),
    );
    await runSearchCommand(["topic", "--link", "지식/a.md", "--vault", vault], { ...deps, runEngineSession });
    expect(deps.runLinkFamilyCommand).toHaveBeenCalledTimes(0);
    expect(runEngineSession).toHaveBeenCalledTimes(1);
  });
});

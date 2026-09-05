import { readFile } from "node:fs/promises";
import path from "node:path";

import { readModelsConfig, resolveModelCapabilities } from "../kernel/engine/embed/config.js";
import {
  acquireModelSet,
  applyModelSelection,
  modelAcquisitionApprovalDigest,
  modelsConfigFromAcquisitionManifest,
  parseModelSetAcquisitionManifest,
  PINNED_DEFAULT_EMBEDDING_MODEL,
  proposeModelSelection,
  readInstalledModelsReceipt,
  type ModelSetAcquisitionManifest,
} from "../kernel/engine/embed/model.js";
import { resolveEffectiveVault } from "../kernel/link/link.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VALUE_FLAGS = new Set(["vault", "descriptor", "cache-dir", "approved-digest"]);
const BOOLEAN_FLAGS = new Set(["default", "dry-run", "yes", "help"]);
type Options = Record<string, string | boolean>;

interface ParsedModelArgs {
  readonly verb: string;
  readonly options: Options;
}

function invalid(message: string): never {
  throw new Error(`MODEL_ARGS_INVALID: ${message}`);
}

function parse(argv: readonly string[]): ParsedModelArgs {
  const verb = argv[0];
  if (verb === undefined || verb.startsWith("-")) invalid("missing model verb");
  const options: Options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) invalid(`unexpected positional argument ${token}`);
    const name = token.slice(2);
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) invalid(`unknown flag --${name}`);
    if (Object.hasOwn(options, name)) invalid(`duplicate flag --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) invalid(`--${name} requires a value`);
    options[name] = value;
  }
  return { verb, options };
}

function text(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function flag(options: Options, name: string): boolean {
  return options[name] === true;
}

function only(parsed: ParsedModelArgs, allowed: readonly string[]): void {
  const unsupported = Object.keys(parsed.options).filter((name) => !allowed.includes(name));
  if (unsupported.length > 0) invalid(`--${unsupported[0]} is not valid for ${parsed.verb}`);
}

function defaultManifest(): ModelSetAcquisitionManifest {
  const model = PINNED_DEFAULT_EMBEDDING_MODEL;
  return {
    schemaVersion: 1,
    embed: {
      provider: model.provider,
      model: model.model,
      revision: model.revision,
      sha256: model.sha256,
      promptScheme: model.prefixScheme,
      url: model.url,
      filename: model.filename,
      dimensions: model.dimensions,
      contextLength: model.context,
      mrlDim: model.mrlDim,
      normalization: model.normalization,
    },
  };
}

async function chosenManifest(options: Options): Promise<ModelSetAcquisitionManifest> {
  const descriptor = text(options, "descriptor");
  const useDefault = flag(options, "default");
  if ((descriptor === undefined) === !useDefault) {
    invalid("choose exactly one of --default or --descriptor <path>");
  }
  if (useDefault) return defaultManifest();
  return parseModelSetAcquisitionManifest(JSON.parse(await readFile(path.resolve(descriptor!), "utf8")) as unknown);
}

function approval(options: Options, expected: string): void {
  if (!flag(options, "yes")) invalid("apply requires --yes and --approved-digest from dry-run");
  const approved = text(options, "approved-digest");
  if (approved === undefined || !DIGEST.test(approved)) invalid("apply requires --approved-digest sha256:<64hex> from dry-run");
  if (approved !== expected) throw new Error(`MODEL_APPROVAL_MISMATCH: expected ${expected}.`);
}

async function target(options: Options): Promise<{ readonly vault: string; readonly source: string }> {
  const explicit = text(options, "vault");
  if (explicit !== undefined) return { vault: path.resolve(explicit), source: "explicit" };
  return resolveEffectiveVault(process.cwd(), process.env);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function install(parsed: ParsedModelArgs): Promise<void> {
  only(parsed, ["descriptor", "default", "cache-dir", "dry-run", "yes", "approved-digest"]);
  const manifest = await chosenManifest(parsed.options);
  const approvalDigest = modelAcquisitionApprovalDigest(manifest);
  if (flag(parsed.options, "dry-run")) {
    if (flag(parsed.options, "yes") || text(parsed.options, "approved-digest") !== undefined) invalid("--dry-run conflicts with --yes and --approved-digest");
    print({ status: "proposed", operation: "install", approvalDigest, acquisition: manifest, modelsConfig: modelsConfigFromAcquisitionManifest(manifest) });
    return;
  }
  approval(parsed.options, approvalDigest);
  const result = await acquireModelSet({ manifest, cacheDir: text(parsed.options, "cache-dir") });
  print({ status: "installed", approvalDigest, artifacts: result.artifacts, verified: true });
}

async function select(parsed: ParsedModelArgs): Promise<void> {
  only(parsed, ["descriptor", "default", "vault", "cache-dir", "dry-run", "yes", "approved-digest"]);
  const manifest = await chosenManifest(parsed.options);
  const resolved = await target(parsed.options);
  if (resolved.source === "cwd") invalid("selection requires --vault or an existing verified vault/bridge/env target");
  const proposal = await proposeModelSelection({ vault: resolved.vault, config: modelsConfigFromAcquisitionManifest(manifest), cacheDir: text(parsed.options, "cache-dir") });
  if (flag(parsed.options, "dry-run")) {
    if (flag(parsed.options, "yes") || text(parsed.options, "approved-digest") !== undefined) invalid("--dry-run conflicts with --yes and --approved-digest");
    print({ status: "proposed", operation: "select", ...proposal });
    return;
  }
  approval(parsed.options, proposal.approvalDigest);
  print(await applyModelSelection({ vault: resolved.vault, config: proposal.proposed, approvedDigest: proposal.approvalDigest, cacheDir: text(parsed.options, "cache-dir") }));
}

async function waive(parsed: ParsedModelArgs): Promise<void> {
  only(parsed, ["vault", "yes"]);
  if (!flag(parsed.options, "yes")) invalid("waive requires --yes");
  const resolved = await target(parsed.options);
  print({ status: "waived", scope: "this-operation", persisted: false, modelsConfigPreserved: await readModelsConfig(resolved.vault) });
}

async function status(parsed: ParsedModelArgs): Promise<void> {
  only(parsed, ["vault", "cache-dir"]);
  const resolved = await target(parsed.options);
  const config = await readModelsConfig(resolved.vault);
  const installed = await readInstalledModelsReceipt({ cacheDir: text(parsed.options, "cache-dir") });
  print({
    status: "ok",
    vault: resolved.vault,
    modelsConfig: config,
    installed,
    resolutions: resolveModelCapabilities({ env: process.env, vaultConfig: config, installedArtifacts: installed.artifacts, setupDefaults: installed.defaults }),
  });
}

export function modelUsage(): string {
  return "Usage: oms model install|select|waive|status [options]\n  install --default|--descriptor <path> --dry-run\n  select --default|--descriptor <path> [--vault <path>] --dry-run\n  Apply install/select with --yes --approved-digest <digest>.";
}

export async function runModelCommand(argv: readonly string[]): Promise<void> {
  process.exitCode = 0;
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      console.log(modelUsage());
      return;
    }
    const parsed = parse(argv);
    if (flag(parsed.options, "help")) {
      only(parsed, ["help"]);
      console.log(modelUsage());
      return;
    }
    if (parsed.verb === "install") await install(parsed);
    else if (parsed.verb === "select") await select(parsed);
    else if (parsed.verb === "waive") await waive(parsed);
    else if (parsed.verb === "status") await status(parsed);
    else invalid(`unknown or retired model verb ${parsed.verb}`);
  } catch (error: unknown) {
    process.exitCode = 1;
    print({ status: "rejected", diagnostics: [{ code: error instanceof Error ? error.message.split(":", 1)[0] : "MODEL_COMMAND_FAILED", remediation: error instanceof Error ? error.message : String(error) }] });
  }
}

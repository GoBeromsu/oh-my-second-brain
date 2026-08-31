import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { parseNote } from "../conventions/frontmatter.js";
import {
  evaluateTemplateWriteContract,
  type TemplateWriteContract,
  type TemplateWriteContractViolation,
} from "../conventions/write-contract.js";
import { rejection, type WriteRejection, type WriteTargetSource } from "../conventions/write-protocol.js";

export type WriteMode = "create" | "append" | "update";
export type TemplateWriteStatus = "written" | "rejected";

export interface WriteTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
}

export interface ResolvedTemplate {
  readonly contract: TemplateWriteContract;
  readonly folder?: string;
  readonly filename?: string;
}

export interface WriteResolvedTemplateNoteInput {
  readonly target: WriteTarget;
  readonly template: ResolvedTemplate;
  readonly mode: WriteMode;
  readonly dryRun: boolean;
  readonly notePath?: string;
  readonly frontmatter?: Record<string, unknown>;
  readonly body?: string;
  readonly readBack?: (fullPath: string) => Promise<string>;
}

export interface TemplateWriteReceipt {
  readonly resolvedVault: string;
  readonly resolutionSource: WriteTargetSource;
  readonly notePath: string;
  readonly mode: WriteMode;
  readonly postconditionVerified: boolean;
}

export interface WriteResolvedTemplateNoteResult {
  readonly status: TemplateWriteStatus;
  readonly mode: WriteMode;
  readonly notePath: string;
  readonly frontmatter: Record<string, unknown>;
  readonly violations: readonly TemplateWriteContractViolation[];
  readonly reason?: string;
  readonly rejection?: WriteRejection;
  readonly receipt?: TemplateWriteReceipt;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

function defaultFilename(frontmatter: Record<string, unknown>): string {
  const title = frontmatter["title"];
  const value = typeof title === "string" ? title : "untitled";
  return `${new Date().toISOString().slice(0, 10)}-${slugify(value)}.md`;
}

function formatNote(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${yamlStringify(frontmatter).trimEnd()}\n---\n\n${body}`;
}

function normalizeBody(body: string): string {
  return body.replace(/^\n+/, "").replace(/\s+$/, "");
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function fileExists(fullPath: string): Promise<boolean> {
  try {
    await access(fullPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

export function safeVaultNotePath(vault: string, notePath: string): string {
  if (path.isAbsolute(notePath)) throw new Error("notePath must be vault-relative");
  const normalized = notePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) throw new Error("notePath must end with .md");
  const segments = normalized.split("/");
  if (segments.some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("notePath must not contain unsafe path segments");
  }
  if (segments.some((part) => part.startsWith(".")) || segments.includes("node_modules")) {
    throw new Error("notePath cannot target hidden, internal, or dependency folders");
  }
  const resolved = path.resolve(vault, normalized);
  const relative = path.relative(vault, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("notePath must stay inside the configured vault");
  }
  return resolved;
}

function trySafeNotePath(
  vault: string,
  notePath: string,
): { readonly ok: true; readonly fullPath: string; readonly normalized: string } | { readonly ok: false; readonly reason: string } {
  try {
    const fullPath = safeVaultNotePath(vault, notePath);
    return { ok: true, fullPath, normalized: path.relative(vault, fullPath).replace(/\\/g, "/") };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function admitWriteTarget(target: WriteTarget): Promise<WriteRejection | undefined> {
  if (target.source !== "cwd") return undefined;
  return rejection(
    "admission",
    "target-unverified",
    `Refusing to write: the target vault was inferred from the current directory (${target.vault}), which is not a verified Oh My Second Brain vault`,
    "run `oms setup` in your Obsidian vault (or set OMS_VAULT), then retry",
  );
}

function result(
  status: TemplateWriteStatus,
  mode: WriteMode,
  notePath: string,
  frontmatter: Record<string, unknown>,
  violations: readonly TemplateWriteContractViolation[],
  rejectionPayload?: WriteRejection,
): WriteResolvedTemplateNoteResult {
  return {
    status,
    mode,
    notePath,
    frontmatter,
    violations,
    ...(rejectionPayload === undefined ? {} : { reason: rejectionPayload.message, rejection: rejectionPayload }),
  };
}

function rejected(
  mode: WriteMode,
  notePath: string,
  frontmatter: Record<string, unknown>,
  code: Parameters<typeof rejection>[1],
  message: string,
  remediation: string,
  violations: readonly TemplateWriteContractViolation[] = [],
): WriteResolvedTemplateNoteResult {
  return result("rejected", mode, notePath, frontmatter, violations, rejection("admission", code, message, remediation));
}

function resolvedPath(input: WriteResolvedTemplateNoteInput, frontmatter: Record<string, unknown>): string | undefined {
  if (input.notePath !== undefined) return input.notePath;
  if (input.mode !== "create") return undefined;
  const folder = input.template.folder;
  if (folder === undefined || folder === "") return undefined;
  return `${folder}/${input.template.filename ?? defaultFilename(frontmatter)}`;
}

function receipt(input: WriteResolvedTemplateNoteInput, notePath: string): TemplateWriteReceipt {
  return {
    resolvedVault: input.target.vault,
    resolutionSource: input.target.source,
    notePath,
    mode: input.mode,
    postconditionVerified: true,
  };
}

async function verifyPostcondition(
  input: WriteResolvedTemplateNoteInput,
  fullPath: string,
  expectedFrontmatter: Record<string, unknown>,
  expectedBody: string,
): Promise<string | undefined> {
  const readBack = input.readBack ?? ((target: string) => readFile(target, "utf-8"));
  const parsed = parseNote(await readBack(fullPath));
  const evaluation = evaluateTemplateWriteContract(parsed.frontmatter, input.template.contract);
  if (!evaluation.valid) return "persisted frontmatter violates the template contract";
  if (JSON.stringify(evaluation.frontmatter) !== JSON.stringify(expectedFrontmatter)) {
    return "persisted frontmatter does not match the resolved template values";
  }
  if (parsed.body !== expectedBody) return "persisted body does not match the staged content";
  return undefined;
}

export async function writeResolvedTemplateNote(
  input: WriteResolvedTemplateNoteInput,
): Promise<WriteResolvedTemplateNoteResult> {
  const admission = await admitWriteTarget(input.target);
  const supplied = input.frontmatter ?? {};
  if (admission !== undefined) return result("rejected", input.mode, input.notePath ?? "", supplied, [], admission);

  const pathValue = resolvedPath(input, supplied);
  if (pathValue === undefined) {
    return rejected(input.mode, "", supplied, "args-invalid", `${input.mode} requires notePath`, "pass a vault-relative notePath, then retry");
  }
  const safe = trySafeNotePath(input.target.vault, pathValue);
  if (!safe.ok) return rejected(input.mode, pathValue, supplied, "path-unsafe", safe.reason, "pass a safe vault-relative markdown path, then retry");

  const exists = await fileExists(safe.fullPath);
  if (input.mode === "create" && exists) {
    return rejected(input.mode, safe.normalized, supplied, "note-exists", "Cannot create note: target already exists", "choose a different notePath");
  }
  if (input.mode !== "create" && !exists) {
    return rejected(input.mode, safe.normalized, supplied, "note-missing", `Cannot ${input.mode}: target note does not exist`, "create the note first or correct notePath");
  }
  if (input.mode !== "update" && input.body === undefined) {
    return rejected(input.mode, safe.normalized, supplied, "body-missing", `${input.mode} requires a body`, "pass a body, then retry");
  }
  if (input.mode === "update" && input.frontmatter === undefined && input.body === undefined) {
    return rejected(input.mode, safe.normalized, supplied, "args-invalid", "update requires frontmatter or body", "pass frontmatter, body, or both, then retry");
  }

  const current = exists ? parseNote(await readFile(safe.fullPath, "utf-8")) : undefined;
  const merged = current === undefined
    ? supplied
    : input.mode === "update"
      ? { ...current.frontmatter, ...supplied }
      : current.frontmatter;
  const evaluation = evaluateTemplateWriteContract(merged, input.template.contract);
  if (!evaluation.valid) {
    return rejected(
      input.mode,
      safe.normalized,
      evaluation.frontmatter,
      "contract-violation",
      "Note does not satisfy the resolved template contract",
      "correct the reported fields, then retry",
      evaluation.violations,
    );
  }

  const body = input.mode === "create"
    ? input.body as string
    : input.mode === "append"
      ? `${current?.body ?? ""}\n\n${normalizeBody(input.body as string)}`
      : input.body === undefined ? current?.body ?? "" : input.body;
  const staged = formatNote(evaluation.frontmatter, body);
  const stagedParsed = parseNote(staged);
  if (stagedParsed.body !== body) {
    return rejected(input.mode, safe.normalized, evaluation.frontmatter, "postcondition-failed", "Staged body does not survive note formatting", "correct the body, then retry");
  }

  if (input.dryRun) return result("written", input.mode, safe.normalized, evaluation.frontmatter, []);

  await mkdir(path.dirname(safe.fullPath), { recursive: true });
  if (input.mode === "append") await appendFile(safe.fullPath, `\n\n${normalizeBody(input.body as string)}`, "utf-8");
  else if (input.mode === "create") await writeFile(safe.fullPath, staged, { encoding: "utf-8", flag: "wx" });
  else await writeFile(safe.fullPath, staged, "utf-8");

  const postcondition = await verifyPostcondition(input, safe.fullPath, evaluation.frontmatter, body);
  if (postcondition !== undefined) {
    return rejected(input.mode, safe.normalized, evaluation.frontmatter, "postcondition-failed", `Postcondition failed after writing ${safe.normalized}: ${postcondition}`, "inspect the persisted file and repair or delete it before retrying");
  }

  return { ...result("written", input.mode, safe.normalized, evaluation.frontmatter, []), receipt: receipt(input, safe.normalized) };
}

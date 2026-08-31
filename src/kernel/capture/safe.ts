import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { parseNote } from "../conventions/frontmatter.js";
import { evaluateResolvedTemplateContract, type TemplateContractViolation } from "../conventions/write-contract.js";
import { rejection, type WriteRejection, type WriteTargetSource } from "../conventions/write-protocol.js";
import { resolveDefaults } from "../templates/defaults.js";
import { renderNoteName } from "../templates/naming.js";
import { normalizeTemplateSourcePath, verifyVaultPath } from "../templates/paths.js";
import type { JsonValue, PreparedWrite, ResolvedConvention, ResolvedTemplate } from "../templates/types.js";

export type WriteMode = "create" | "append" | "update";
export type TemplateWriteStatus = "ask" | "written" | "rejected";

export interface WriteTarget {
  readonly vault: string;
  readonly source: WriteTargetSource;
}

export function safeVaultNotePath(vault: string, notePath: string): string {
  if (path.isAbsolute(notePath)) throw new Error("notePath must be vault-relative");
  const normalized = notePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) throw new Error("notePath must end with .md");
  const segments = normalized.split("/");
  if (segments.some(part => part === ".." || part === "." || part === "")) throw new Error("notePath must not contain unsafe path segments");
  if (segments.some(part => part.startsWith(".")) || segments.includes("node_modules")) throw new Error("notePath cannot target hidden, internal, or dependency folders");
  const resolved = path.resolve(vault, normalized);
  const relative = path.relative(vault, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("notePath must stay inside the configured vault");
  return resolved;
}

export async function admitWriteTarget(target: WriteTarget): Promise<WriteRejection | undefined> {
  if (target.source !== "cwd") return undefined;
  return rejection("admission", "target-unverified", `Refusing to write: the target vault was inferred from the current directory (${target.vault}), which is not a verified Oh My Second Brain vault`, "run `oms setup` in your Obsidian vault (or set OMS_VAULT), then retry");
}

function normalizeBody(body: string): string {
  return body.replace(/^\n+/, "").replace(/\s+$/, "");
}

interface TemplateSourceLayout {
  readonly bom: boolean;
  readonly eol: "lf" | "crlf";
  readonly finalNewline: boolean;
}

function templateSourceLayout(template: ResolvedTemplate): TemplateSourceLayout {
  return {
    bom: template.bom,
    eol: template.eol,
    finalNewline: template.finalNewline,
  };
}

function expressionError(template: ResolvedTemplate, location: string, rawToken: string): never {
  const error = new Error(`TEMPLATE_EXPRESSION_UNSUPPORTED: ${template.sourcePath}:${location}: ${rawToken}`);
  Object.assign(error, { code: "TEMPLATE_EXPRESSION_UNSUPPORTED", sourcePath: template.sourcePath, location, rawToken });
  throw error;
}

function renderExpressions(
  value: JsonValue,
  template: ResolvedTemplate,
  location: string,
  title: string,
  resolvedAt: string,
): JsonValue {
  if (typeof value === "string") {
    return value.replace(/{{[\s\S]*?}}/g, (rawToken) => {
      if (rawToken === "{{title}}") return title;
      if (rawToken === "{{date}}") return resolvedAt.slice(0, 10);
      if (rawToken === "{{time}}") return resolvedAt.slice(11, 16);
      return expressionError(template, location, rawToken);
    });
  }
  if (Array.isArray(value)) return value.map((item, index) => renderExpressions(item, template, `${location}[${index}]`, title, resolvedAt));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, renderExpressions(member, template, `${location}.${key}`, title, resolvedAt)]));
  }
  return value;
}

function resolvedInstant(value: string | undefined): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("RESOLVED_AT_INVALID: resolvedAt must be an ISO instant");
  return date.toISOString();
}

export interface TemplateWriteNoteInput {
  readonly target: WriteTarget;
  readonly convention: ResolvedConvention;
  readonly templateId?: string;
  readonly mode: WriteMode;
  readonly dryRun: boolean;
  readonly notePath?: string;
  readonly frontmatter?: Readonly<Record<string, JsonValue>>;
  readonly body?: string;
  readonly resolvedAt?: string;
  readonly readBack?: (fullPath: string) => Promise<string>;
}

export interface TemplateWriteReceipt {
  readonly resolvedVault: string;
  readonly resolutionSource: WriteTargetSource;
  readonly templateId: string;
  readonly notePath: string;
  readonly mode: WriteMode;
  readonly resolvedAt?: string;
  readonly writtenPaths: readonly string[];
  readonly inputSignature: string;
  readonly templateSignature: string;
  readonly postconditionVerified: true;
}

export interface TemplateWriteResult {
  readonly status: TemplateWriteStatus;
  readonly mode: WriteMode;
  readonly notePath: string;
  readonly templateId: string | null;
  readonly frontmatter: Readonly<Record<string, JsonValue>>;
  readonly body: string;
  readonly prepared?: PreparedWrite;
  readonly violations: readonly TemplateContractViolation[];
  readonly reason?: string;
  readonly rejection?: WriteRejection;
  readonly receipt?: TemplateWriteReceipt;
}

function templateResult(
  status: TemplateWriteStatus,
  input: TemplateWriteNoteInput,
  template: ResolvedTemplate | undefined,
  notePath: string,
  frontmatter: Readonly<Record<string, JsonValue>>,
  body: string,
  violations: readonly TemplateContractViolation[] = [],
  reason?: string,
  rejectionPayload?: WriteRejection,
): TemplateWriteResult {
  return {
    status,
    mode: input.mode,
    notePath,
    templateId: template?.id ?? null,
    frontmatter,
    body,
    violations,
    ...(reason === undefined ? {} : { reason }),
    ...(rejectionPayload === undefined ? {} : { rejection: rejectionPayload }),
  };
}

function orderedTemplateFrontmatter(
  template: ResolvedTemplate,
  values: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  const ordered: Record<string, JsonValue> = {};
  for (const key of template.keyOrder) if (Object.hasOwn(values, key)) ordered[key] = values[key]!;
  for (const [key, value] of Object.entries(values)) if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  return ordered;
}

function renderTemplateBody(template: ResolvedTemplate, content: string, title: string, resolvedAt: string): string {
  const marker = "<!-- oms:content -->";
  const rendered = renderExpressions(template.body, template, "body", title, resolvedAt);
  if (typeof rendered !== "string") throw new Error("TEMPLATE_SOURCE_INVALID: template body must be a string");
  const standalone = /(^|\r?\n)<!-- oms:content -->(?=\r?\n|$)/g;
  const markerCount = [...rendered.matchAll(standalone)].length;
  if (markerCount > 1) throw new Error(`TEMPLATE_SOURCE_INVALID: ${template.sourcePath} contains multiple oms content markers`);
  if (markerCount === 1) return rendered.replace(standalone, (_match, prefix: string) => `${prefix}${content}`);
  if (content.length === 0) return rendered;
  const eol = rendered.includes("\r\n") ? "\r\n" : "\n";
  return `${rendered}${rendered.endsWith(eol) ? eol : `${eol}${eol}`}${content}`;
}

function formatTemplateNote(template: ResolvedTemplate, frontmatter: Readonly<Record<string, JsonValue>>, body: string): string {
  const layout = templateSourceLayout(template);
  const eol = layout.eol === "crlf" ? "\r\n" : "\n";
  let normalizedBody = body.replace(/\r\n|\r|\n/g, eol);
  if (layout.finalNewline && !normalizedBody.endsWith(eol)) normalizedBody += eol;
  if (!layout.finalNewline) normalizedBody = normalizedBody.replace(/(?:\r\n|\n)+$/g, "");
  return `${layout.bom ? "\ufeff" : ""}---${eol}${yamlStringify(frontmatter).trimEnd().replace(/\r\n|\r|\n/g, eol)}${eol}---${eol}${normalizedBody}`;
}

function formatExistingNote(
  raw: string,
  parsed: ReturnType<typeof parseNote>,
  frontmatter: Readonly<Record<string, JsonValue>>,
  bodyOverride: string | undefined,
): string {
  if (parsed.frontmatterRange === null) throw new Error("TEMPLATE_SOURCE_INVALID: existing note has no frontmatter range");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const yaml = yamlStringify(frontmatter).trimEnd().replace(/\r\n|\r|\n/g, eol);
  const bodyStart = raw.length - parsed.body.length;
  const prefix = `${raw.slice(0, parsed.frontmatterRange.start)}${yaml}${raw.slice(parsed.frontmatterRange.end, bodyStart)}`;
  if (bodyOverride === undefined) return `${prefix}${parsed.body}`;
  let body = bodyOverride.replace(/\r\n|\r|\n/g, eol);
  const hadFinalNewline = raw.endsWith(eol);
  if (hadFinalNewline && !body.endsWith(eol)) body += eol;
  if (!hadFinalNewline) body = body.replace(/(?:\r\n|\n)+$/g, "");
  return `${prefix}${body}`;
}

function parsePersistedNote(raw: string) {
  return parseNote(raw.startsWith("\ufeff") ? raw.slice(1) : raw);
}

function templateRejection(code: WriteRejection["code"], message: string, remediation: string): WriteRejection {
  return rejection("admission", code, message, remediation);
}

function templateFor(input: TemplateWriteNoteInput): ResolvedTemplate | undefined {
  return input.templateId === undefined ? undefined : input.convention.templates[input.templateId];
}

function identityRejection(template: ResolvedTemplate): WriteRejection {
  return templateRejection(
    "TEMPLATE_IDENTITY_IMMUTABLE",
    `TEMPLATE_IDENTITY_IMMUTABLE: persisted frontmatter.template must equal ${template.id}`,
    "select the template recorded by the existing note or create a new note",
  );
}

function hasTemplateIdentity(frontmatter: Readonly<Record<string, JsonValue>>, template: ResolvedTemplate): boolean {
  return frontmatter.template === template.id;
}

async function verifiedTemplateNotePath(vault: string, notePath: string, expected: "existing-file" | "absent" | "either") {
  const normalized = normalizeTemplateSourcePath(notePath);
  return verifyVaultPath(vault, normalized, { expected });
}

function preparedTemplateWrite(
  input: TemplateWriteNoteInput,
  template: ResolvedTemplate,
  mode: WriteMode,
  notePath: string,
  frontmatter: Readonly<Record<string, JsonValue>>,
  body: string,
  resolvedAt: string,
): PreparedWrite {
  return {
    mode,
    templateId: template.id,
    resolvedAt,
    notePath,
    frontmatter,
    body,
    inputSignature: template.inputSignature,
    templateSignature: template.templateSignature,
  };
}

/**
 */
export async function writeResolvedTemplateNote(input: TemplateWriteNoteInput): Promise<TemplateWriteResult> {
  const caller = input.frontmatter ?? {};
  const targetRejection = await admitWriteTarget(input.target);
  if (targetRejection) return templateResult("rejected", input, undefined, input.notePath ?? "", caller, input.body ?? "", [], targetRejection.message, targetRejection);

  let template = input.mode === "create" ? templateFor(input) : undefined;
  if (input.mode === "create" && template === undefined) {
    const payload = templateRejection("args-invalid", "templateId does not identify a resolved template", "load a resolved convention and pass one of its stable template IDs");
    return templateResult("rejected", input, undefined, input.notePath ?? "", caller, input.body ?? "", [], payload.message, payload);
  }

  if (input.mode === "append") {
    if (input.notePath === undefined || input.body === undefined || input.frontmatter !== undefined || input.templateId !== undefined) {
      const payload = templateRejection("args-invalid", "append requires an existing notePath and body only", "pass notePath and body; do not pass frontmatter for append");
      return templateResult("rejected", input, template, input.notePath ?? "", caller, input.body ?? "", [], payload.message, payload);
    }
    let target: Awaited<ReturnType<typeof verifiedTemplateNotePath>>;
    try { target = await verifiedTemplateNotePath(input.target.vault, input.notePath, "existing-file"); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes("must exist") ? "note-missing" : "path-unsafe";
      const payload = templateRejection(code, message, "pass an existing, safe vault-relative markdown note path");
      return templateResult("rejected", input, template, input.notePath, caller, input.body, [], payload.message, payload);
    }
    const raw = await readFile(target.absolutePath, "utf-8");
    const parsed = parsePersistedNote(raw);
    const persistedTemplateId = parsed.frontmatter["template"];
    template = typeof persistedTemplateId === "string" ? input.convention.templates[persistedTemplateId] : undefined;
    if (template === undefined) {
      const payload = templateRejection("TEMPLATE_IDENTITY_IMMUTABLE", "persisted frontmatter.template does not identify a resolved template", "repair the note identity before appending");
      return templateResult("rejected", input, undefined, target.vaultRelativePath, parsed.frontmatter as Record<string, JsonValue>, parsed.body, [], payload.message, payload);
    }
    if (!hasTemplateIdentity(parsed.frontmatter as Record<string, JsonValue>, template)) {
      const payload = identityRejection(template);
      return templateResult("rejected", input, template, target.vaultRelativePath, parsed.frontmatter as Record<string, JsonValue>, parsed.body, [], payload.message, payload);
    }
    const contract = evaluateResolvedTemplateContract(parsed.frontmatter as Record<string, JsonValue>, template, input.convention.base);
    if (!contract.valid) return templateResult("rejected", input, template, target.vaultRelativePath, parsed.frontmatter as Record<string, JsonValue>, parsed.body, contract.violations, "Existing note violates the resolved template contract");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const appendedBody = normalizeBody(input.body).replace(/\r\n|\r|\n/g, eol);
    const appended = `${raw.endsWith(eol) ? eol : `${eol}${eol}`}${appendedBody}${eol}`;
    if (input.dryRun) return templateResult("written", input, template, target.vaultRelativePath, parsed.frontmatter as Record<string, JsonValue>, `${parsed.body}${appended}`);
    await appendFile(target.absolutePath, appended, "utf-8");
    const persisted = await (input.readBack ?? ((file: string) => readFile(file, "utf-8")))(target.absolutePath);
    const persistedNote = parsePersistedNote(persisted);
    if (!hasTemplateIdentity(persistedNote.frontmatter as Record<string, JsonValue>, template) || !normalizeBody(persisted).endsWith(input.body.trim())) {
      const payload = rejection("acceptance", "postcondition-failed", "Postcondition failed after append", "inspect the persisted note before retrying");
      return templateResult("rejected", input, template, target.vaultRelativePath, parsed.frontmatter as Record<string, JsonValue>, parsed.body, [], payload.message, payload);
    }
    return { ...templateResult("written", input, template, target.vaultRelativePath, parsed.frontmatter as Record<string, JsonValue>, `${parsed.body}${appended}`), receipt: { resolvedVault: input.target.vault, resolutionSource: input.target.source, templateId: template.id, notePath: target.vaultRelativePath, mode: "append", writtenPaths: [target.vaultRelativePath], inputSignature: template.inputSignature, templateSignature: template.templateSignature, postconditionVerified: true } };
  }

  if (input.mode === "update") {
    if (input.notePath === undefined || input.templateId !== undefined || (input.frontmatter === undefined && input.body === undefined)) {
      const payload = templateRejection("args-invalid", "update requires notePath and explicit frontmatter or body", "pass an existing notePath and at least one explicit change");
      return templateResult("rejected", input, template, input.notePath ?? "", caller, input.body ?? "", [], payload.message, payload);
    }
    let target: Awaited<ReturnType<typeof verifiedTemplateNotePath>>;
    try { target = await verifiedTemplateNotePath(input.target.vault, input.notePath, "existing-file"); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload = templateRejection(message.includes("must exist") ? "note-missing" : "path-unsafe", message, "pass an existing, safe vault-relative markdown note path");
      return templateResult("rejected", input, template, input.notePath, caller, input.body ?? "", [], payload.message, payload);
    }
    const raw = await readFile(target.absolutePath, "utf-8");
    const parsed = parsePersistedNote(raw);
    const persistedTemplateId = parsed.frontmatter["template"];
    template = typeof persistedTemplateId === "string" ? input.convention.templates[persistedTemplateId] : undefined;
    if (template === undefined) {
      const payload = templateRejection("TEMPLATE_IDENTITY_IMMUTABLE", "persisted frontmatter.template does not identify a resolved template", "repair the note identity before updating");
      return templateResult("rejected", input, undefined, target.vaultRelativePath, parsed.frontmatter as Record<string, JsonValue>, parsed.body, [], payload.message, payload);
    }
    if (!hasTemplateIdentity(parsed.frontmatter as Record<string, JsonValue>, template) || (caller.template !== undefined && caller.template !== template.id)) {
      const payload = identityRejection(template);
      return templateResult("rejected", input, template, target.vaultRelativePath, parsed.frontmatter as Record<string, JsonValue>, parsed.body, [], payload.message, payload);
    }
    const merged = orderedTemplateFrontmatter(template, { ...(parsed.frontmatter as Record<string, JsonValue>), ...caller });
    const body = input.body ?? parsed.body;
    const contract = evaluateResolvedTemplateContract(merged, template, input.convention.base);
    if (!contract.valid) return templateResult("rejected", input, template, target.vaultRelativePath, merged, body, contract.violations, "Resulting note violates the resolved template contract");
    const staged = formatExistingNote(raw, parseNote(raw), merged, input.body);
    if (input.dryRun) return templateResult("written", input, template, target.vaultRelativePath, merged, body);
    await writeFile(target.absolutePath, staged, "utf-8");
    const persisted = parsePersistedNote(await (input.readBack ?? ((file: string) => readFile(file, "utf-8")))(target.absolutePath));
    const persistedContract = evaluateResolvedTemplateContract(persisted.frontmatter as Record<string, JsonValue>, template, input.convention.base);
    if (!hasTemplateIdentity(persisted.frontmatter as Record<string, JsonValue>, template) || !persistedContract.valid || normalizeBody(persisted.body) !== normalizeBody(body)) {
      const payload = rejection("acceptance", "postcondition-failed", "Postcondition failed after update", "inspect the persisted note before retrying");
      return templateResult("rejected", input, template, target.vaultRelativePath, merged, body, persistedContract.violations, payload.message, payload);
    }
    return { ...templateResult("written", input, template, target.vaultRelativePath, merged, body), receipt: { resolvedVault: input.target.vault, resolutionSource: input.target.source, templateId: template.id, notePath: target.vaultRelativePath, mode: "update", writtenPaths: [target.vaultRelativePath], inputSignature: template.inputSignature, templateSignature: template.templateSignature, postconditionVerified: true } };
  }

  if (template === undefined) throw new Error("TEMPLATE_IDENTITY_INVALID: create template is unresolved");
  if (input.body === undefined) {
    const payload = templateRejection("body-missing", "create requires a body", "pass body content for the new note");
    return templateResult("rejected", input, template, input.notePath ?? "", caller, "", [], payload.message, payload);
  }
  if (input.notePath !== undefined) {
    const payload = templateRejection("args-invalid", "create derives notePath from the resolved template", "remove notePath and use template naming and placement");
    return templateResult("rejected", input, template, input.notePath, caller, input.body, [], payload.message, payload);
  }
  const title = typeof caller.title === "string" ? caller.title.trim() : "";
  if (
    title.length === 0 &&
    (template.body.includes("{{title}}") || JSON.stringify(template.frontmatterTemplate).includes("{{title}}"))
  ) {
    const message = "TEMPLATE_TITLE_REQUIRED: title is required by the selected template";
    return templateResult("ask", input, template, input.notePath ?? "", caller, input.body, [{ field: "title", rule: "required", message }], message, rejection("admission", "contract-violation", message, "provide a non-empty title and retry"));
  }
  let resolvedAt: string;
  let defaults: ReturnType<typeof resolveDefaults>;
  try {
    resolvedAt = resolvedInstant(input.resolvedAt);
    const renderedTemplate = Object.fromEntries(Object.entries(template.frontmatterTemplate).map(([key, value]) => [key, renderExpressions(value, template, key, title, resolvedAt)]));
    defaults = resolveDefaults({
      mode: "create",
      fields: { ...input.convention.base.fields, ...template.fields },
      template: { ...renderedTemplate, template: template.id },
      caller: { ...caller, ...(title === "" ? {} : { title }), template: template.id },
      resolvedAt,
    });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return templateResult("ask", input, template, input.notePath ?? "", caller, input.body, [{ field: message.split(":")[1]?.trim().split(" ")[0] ?? "", rule: "required", message }], message, rejection("admission", "contract-violation", message, "provide the required field and retry"));
  }
  const fields = orderedTemplateFrontmatter(template, defaults.fields);
  let notePath: string;
  try { notePath = `${template.targetFolder}/${renderNoteName({ pattern: template.naming, fields, resolvedAt: defaults.resolvedAt })}`; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = templateRejection("args-invalid", message, "provide fields that produce a valid template filename");
    return templateResult("rejected", input, template, "", fields, input.body, [], payload.message, payload);
  }
  let target: Awaited<ReturnType<typeof verifiedTemplateNotePath>>;
  try { target = await verifiedTemplateNotePath(input.target.vault, notePath, "absent"); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = templateRejection(message.includes("must be absent") ? "note-exists" : "path-unsafe", message, "choose a safe unused vault-relative markdown note path");
    return templateResult("rejected", input, template, notePath, fields, input.body, [], payload.message, payload);
  }
  const body = renderTemplateBody(template, input.body, title, defaults.resolvedAt);
  const contract = evaluateResolvedTemplateContract(fields, template, input.convention.base);
  if (!contract.valid) return templateResult("ask", input, template, target.vaultRelativePath, fields, body, contract.violations, "Resolved template values violate the contract", rejection("admission", "contract-violation", "Resolved template values violate the contract", "correct the supplied fields and retry"));
  const prepared = preparedTemplateWrite(input, template, "create", target.vaultRelativePath, fields, body, defaults.resolvedAt);
  const staged = formatTemplateNote(template, prepared.frontmatter, prepared.body);
  const stagedParsed = parsePersistedNote(staged);
  const stagedContract = evaluateResolvedTemplateContract(stagedParsed.frontmatter as Record<string, JsonValue>, template, input.convention.base);
  if (!stagedContract.valid) return templateResult("rejected", input, template, prepared.notePath, fields, body, stagedContract.violations, "Rendered template note violates the contract", rejection("acceptance", "contract-violation", "Rendered template note violates the contract", "correct the supplied fields and retry"));
  if (input.dryRun) return { ...templateResult("written", input, template, prepared.notePath, fields, body), prepared };
  await mkdir(path.dirname(target.absolutePath), { recursive: true });
  await writeFile(target.absolutePath, staged, { encoding: "utf-8", flag: "wx" });
  const persisted = parsePersistedNote(await (input.readBack ?? ((file: string) => readFile(file, "utf-8")))(target.absolutePath));
  const persistedContract = evaluateResolvedTemplateContract(persisted.frontmatter as Record<string, JsonValue>, template, input.convention.base);
  if (!hasTemplateIdentity(persisted.frontmatter as Record<string, JsonValue>, template) || !persistedContract.valid || normalizeBody(persisted.body) !== normalizeBody(prepared.body)) {
    const payload = rejection("acceptance", "postcondition-failed", "Postcondition failed after create", "inspect the persisted note before retrying");
    return templateResult("rejected", input, template, prepared.notePath, fields, body, persistedContract.violations, payload.message, payload);
  }
  return { ...templateResult("written", input, template, prepared.notePath, fields, body), prepared, receipt: { resolvedVault: input.target.vault, resolutionSource: input.target.source, templateId: template.id, notePath: prepared.notePath, mode: "create", resolvedAt: prepared.resolvedAt, writtenPaths: [prepared.notePath], inputSignature: template.inputSignature, templateSignature: template.templateSignature, postconditionVerified: true } };
}

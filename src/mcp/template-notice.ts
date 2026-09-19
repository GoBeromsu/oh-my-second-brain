import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../kernel/runtime/event-journal.js";
import { readBundledPackageVersion } from "../kernel/runtime/assets.js";
import { canonicalJson } from "../kernel/templates/canonical.js";
import { readTemplateReviewContext, type TemplateReviewContext } from "../kernel/templates/review-context.js";
import type { Digest, JsonValue } from "../kernel/templates/types.js";

/**
 * The first notice deliberately contains no source identity or change
 * classification. Hosts can use the machine fields to enter the review flow.
 */
export const TEMPLATE_CHANGE_NOTICE_MESSAGE = "템플릿에 변경이 있습니다";

export const TEMPLATE_CHANGE_NOTICE_ACTIONS = ["확인하기", "나중에"] as const;

export interface TemplateChangeNotice {
  readonly state: "pending";
  readonly pendingDigest: Digest;
  readonly pendingCount: number;
  readonly actions: typeof TEMPLATE_CHANGE_NOTICE_ACTIONS;
  readonly next: {
    readonly tool: "oms_write";
    readonly arguments: {
      readonly op: "template";
      readonly mode: "interview-next";
    };
  };
}

type NoticeDelivery = "dedupe" | "poll";

const deliveredPendingDigests = new Set<Digest>();

function digest(value: string): Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as Digest;
}

function canonicalNoticeDigest(context: TemplateReviewContext): Digest {
  return digest(canonicalJson({
    vault: context.vault,
    censusDigest: context.censusDigest,
  }));
}

function normalizedSourcePath(value: string): string {
  return value.replaceAll("\\", "/").normalize("NFC");
}

function normalizedTemplateId(value: string): string {
  return value.normalize("NFC");
}

function affectedSourceKey(
  templateId: string | undefined,
  sourcePath: string | undefined,
  sourceById: ReadonlyMap<string, string>,
): string | undefined {
  if (templateId !== undefined) {
    const mappedPath = sourceById.get(normalizedTemplateId(templateId));
    if (mappedPath !== undefined) return `path:${normalizedSourcePath(mappedPath)}`;
  }
  if (sourcePath !== undefined) return `path:${normalizedSourcePath(sourcePath)}`;
  if (templateId !== undefined) return `id:${normalizedTemplateId(templateId)}`;
  return undefined;
}

function pendingCount(context: TemplateReviewContext): number {
  const pending = new Set<string>();
  const sourceById = new Map<string, string>();
  for (const entry of context.census.entries) {
    if (entry.templateId !== undefined) {
      sourceById.set(normalizedTemplateId(entry.templateId), entry.sourcePath);
    }
  }
  for (const [templateId, binding] of Object.entries(context.policy.templates)) {
    if (!sourceById.has(normalizedTemplateId(templateId))) sourceById.set(normalizedTemplateId(templateId), binding.sourcePath);
    if (!sourceById.has(normalizedTemplateId(binding.templateId))) sourceById.set(normalizedTemplateId(binding.templateId), binding.sourcePath);
  }
  for (const diff of context.census.diffs) {
    const key = affectedSourceKey(
      diff.templateId,
      diff.newSourcePath ?? diff.sourcePath,
      sourceById,
    );
    if (key !== undefined) pending.add(key);
  }
  for (const diagnostic of context.census.diagnostics) {
    const key = affectedSourceKey(diagnostic.templateId, diagnostic.path, sourceById)
      ?? `diagnostic:${diagnostic.code}`;
    pending.add(key);
  }
  // Resolver review can remain pending even when the census has no source
  // diff: a projection may omit a managed entry/descriptor, or its content
  // body coverage may be stale. Fresh IDs are the per-binding coverage
  // result, so count only policy identities absent from that set rather than
  // invalidating fresh siblings or adding one duplicate per symptom.
  const freshTemplateIds = new Set(context.freshTemplateIds.map(normalizedTemplateId));
  for (const binding of Object.values(context.policy.templates)) {
    if (freshTemplateIds.has(normalizedTemplateId(binding.templateId))) continue;
    const key = affectedSourceKey(binding.templateId, binding.sourcePath, sourceById)
      ?? `id:${normalizedTemplateId(binding.templateId)}`;
    pending.add(key);
  }
  if (pending.size === 0 && !context.projectionUsable && Object.keys(context.policy.templates).length > 0) {
    // A missing/unusable projection still needs the reviewed bootstrap path,
    // even when a bound source is currently absent and therefore has no
    // current census entry to classify.
    pending.add("projection");
  }
  return pending.size;
}

export function templateNoticeFromContext(context: TemplateReviewContext): TemplateChangeNotice | null {
  const count = pendingCount(context);
  if (count === 0) return null;
  return {
    state: "pending",
    pendingDigest: canonicalNoticeDigest(context),
    pendingCount: count,
    actions: TEMPLATE_CHANGE_NOTICE_ACTIONS,
    next: {
      tool: "oms_write",
      arguments: {
        op: "template",
        mode: "interview-next",
      },
    },
  };
}

function recordNoticeFailure(vault: string): void {
  try {
    const invocation = createRuntimeInvocation({
      surface: "mcp",
      operation: "template-notice",
      packageVersion: readBundledPackageVersion(),
    });
    appendRuntimeEvent(
      createRuntimeEvent(invocation, {
        kind: "template-notice-failed",
        outcome: "failure",
      }),
      { vaultPath: vault },
    );
  } catch {
    // Notice telemetry is best effort and must not become a tool failure.
  }
}

/**
 * Reads the current folder census and turns it into the host-facing notice.
 * The read-only review context does not require a valid derived projection.
 * Any census/notice failure is isolated and logged without writing stdout.
 */
export async function readTemplateChangeNotice(vault: string): Promise<TemplateChangeNotice | null> {
  try {
    return templateNoticeFromContext(await readTemplateReviewContext(vault));
  } catch {
    recordNoticeFailure(vault);
    return null;
  }
}

/**
 * Returns a notice for a tool result. Write/search delivery is once per
 * process and pending digest; status is an explicit polling channel and
 * therefore returns the full notice every time.
 */
export async function templateNoticeForTool(
  vault: string,
  delivery: NoticeDelivery,
): Promise<TemplateChangeNotice | null> {
  const notice = await readTemplateChangeNotice(vault);
  if (notice === null || delivery === "poll") return notice;
  if (deliveredPendingDigests.has(notice.pendingDigest)) return null;
  deliveredPendingDigests.add(notice.pendingDigest);
  return notice;
}

/** Clears process-local delivery state for isolated tests. */
export function resetTemplateNoticeDeliveryForTests(): void {
  deliveredPendingDigests.clear();
}

/**
 * Renders only the generic first-line message for boot instructions. The
 * machine notice itself belongs in tool-result JSON and is never interpolated
 * into this text.
 */
export function templateNoticeInstruction(
  notice: TemplateChangeNotice | null | undefined,
): string | null {
  return notice === null || notice === undefined ? null : TEMPLATE_CHANGE_NOTICE_MESSAGE;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergedStructuredNotice(
  result: CallToolResult,
  notice: TemplateChangeNotice,
): CallToolResult["structuredContent"] | undefined {
  if (!isJsonObject(result.structuredContent)) return result.structuredContent;
  return {
    ...result.structuredContent,
    templateNotice: notice,
  };
}

/**
 * Attaches a machine notice while preserving the primary result and its
 * `isError` bit. JSON text results retain both their text and any existing
 * structured carrier; non-JSON results retain their original content and use
 * a compact text block when no structured carrier exists.
 */
export async function attachTemplateNotice(
  result: CallToolResult,
  vault: string,
  delivery: NoticeDelivery,
): Promise<CallToolResult> {
  const notice = await templateNoticeForTool(vault, delivery);
  if (notice === null) return result;

  const first = result.content[0];
  if (first?.type === "text") {
    try {
      const parsed: unknown = JSON.parse(first.text);
      if (isJsonObject(parsed)) {
        return {
          ...result,
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: mergedStructuredNotice(result, notice) }),
          content: [
            {
              ...first,
              text: JSON.stringify({ ...parsed, templateNotice: notice }, null, 2),
            },
            ...result.content.slice(1),
          ],
        };
      }
    } catch {
      // Preserve non-JSON primary text below.
    }
  }

  const structuredContent = mergedStructuredNotice(result, notice);
  if (structuredContent !== undefined) {
    return {
      ...result,
      structuredContent,
    };
  }

  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: TEMPLATE_CHANGE_NOTICE_MESSAGE,
      },
    ],
  };
}

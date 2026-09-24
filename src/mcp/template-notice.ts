import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { appendRuntimeEvent, createRuntimeEvent, createRuntimeInvocation } from "../kernel/runtime/event-journal.js";
import { readBundledPackageVersion } from "../kernel/runtime/assets.js";
import { canonicalJson } from "../kernel/templates/canonical.js";
import { reviewContractSources, type ContractSourceReviewResult } from "../kernel/templates/service.js";
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
  /**
   * Mode hint only. This is not a complete CallToolRequest: OMS never invents
   * contract meaning, and a host must not replay `next` as a tool call.
   */
  readonly next: {
    readonly skill: "interview";
    readonly mode: "review-sources";
  };
}

type NoticeDelivery = "dedupe" | "poll";

const deliveredPendingDigests = new Set<Digest>();

function digest(value: string): Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as Digest;
}

function canonicalNoticeDigest(review: ContractSourceReviewResult): Digest {
  return digest(canonicalJson({
    vault: review.vault,
    revision: review.revision,
    pending: pendingKeys(review),
  }));
}

function normalizedSourcePath(value: string): string {
  return value.replaceAll("\\", "/").normalize("NFC");
}

/**
 * One pending key per affected registration. A drifted, missing, or unreadable
 * source and a held contract are all reasons to offer review; none of them is
 * inspected for meaning here.
 */
function pendingKeys(review: ContractSourceReviewResult): readonly string[] {
  const pending = new Set<string>();
  for (const item of review.reviews) {
    if (item.state !== "unchanged") pending.add(`path:${normalizedSourcePath(item.path)}`);
  }
  for (const held of review.held) pending.add(`template:${held.templateId}`);
  return [...pending].sort();
}

export function templateNoticeFromReview(review: ContractSourceReviewResult): TemplateChangeNotice | null {
  const count = pendingKeys(review).length;
  if (count === 0) return null;
  return {
    state: "pending",
    pendingDigest: canonicalNoticeDigest(review),
    pendingCount: count,
    actions: TEMPLATE_CHANGE_NOTICE_ACTIONS,
    next: {
      skill: "interview",
      mode: "review-sources",
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
 * Reads the published contract's source review and turns it into the
 * host-facing notice. The review is read-only and requires no projection. Any
 * failure is isolated and logged without writing stdout.
 */
export async function readTemplateChangeNotice(vault: string): Promise<TemplateChangeNotice | null> {
  try {
    return templateNoticeFromReview(await reviewContractSources({ target: { vault, source: "explicit" } }));
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

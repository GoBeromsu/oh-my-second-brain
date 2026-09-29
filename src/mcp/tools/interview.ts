import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { admitWriteTarget } from "../../kernel/capture/safe.js";
import { parseInterpretations, type TemplateInterpretation } from "../../kernel/contract/interpretation.js";
import { appendInterviewEvent, questionDigest } from "../../kernel/contract/interview-log.js";
import { confirmedProposal, interviewLogKey, latestProposal, logRecorder, resumableIO, vaultLog } from "../../kernel/contract/interview-resume.js";
import { proposalDigest, runInterview, SEAL_QUESTION, usableFolder, type InterviewRecord, type InterviewResult } from "../../kernel/contract/interview.js";
import { parseAnswers, publicQuestion, type Answers } from "../../kernel/contract/scripted-interview.js";
import { contractStatus } from "../../kernel/contract/status.js";
import { currentSequence, readStore, storeRoot, type SealDeps } from "../../kernel/contract/store.js";
import { writeVaultSettings } from "../../kernel/contract/vault-id.js";
import { readVaultSettings } from "../../kernel/vault/settings.js";
import { errorText, isRecord, jsonText, type ToolContext } from "./shared.js";

/**
 * MCP `interview`: the vault interview over several calls, kept in the interview log
 * beside the contract store so each call continues where the last one stopped.
 *
 * - `questions` (default) lists what is still unanswered and writes nothing.
 * - `answer` records answers; once every question is answered it records the proposal
 *   and returns its digest with the public preview.
 * - `confirm` records the owner's yes to exactly that proposal digest.
 * - `seal` seals only when the log holds that confirmation and the interview, run again
 *   from the log, still proposes the same digest. A retry after a seal whose log entry
 *   was lost finds the confirmed contract already sealed and records the seal instead of
 *   sealing a new generation.
 *
 * `answer`, `confirm` and `seal` need a verified target vault; a vault inferred from
 * the working directory may only list questions. The seal never reclaims a stale lock:
 * that decision stays with the owner in a terminal.
 */

export interface InterviewToolDeps {
  /** Store root and clock for tests; the defaults are ~/.oms/vaults and Date.now. */
  readonly root?: string;
  readonly now?: () => number;
  readonly sealDeps?: Partial<SealDeps>;
}

const OPS = ["questions", "answer", "confirm", "seal"] as const;
type InterviewOp = typeof OPS[number];

const ANSWER_ROUTE = "Ask the owner each question, then call interview with op \"answer\" and their answers keyed by question id. Earlier answers are kept; only unanswered questions are listed.";
const CONFIRM_ROUTE = "Show the owner the preview in notes. Only when the owner agrees, call interview with op \"confirm\" and this proposed digest, then op \"seal\".";
const TERMINAL_ROUTE = "The owner runs `oms interview` (or `oms setup`) in a terminal, where the stale lock can be reclaimed after they confirm.";

interface Rejection {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly remediation: string;
}

function rejected(vault: string, rejection: Rejection | object): CallToolResult {
  return jsonText({ ok: false, status: "rejected", vault, rejection });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ProposalChanged extends Error {
  constructor(readonly confirmed: string, readonly current: string) {
    super("INTERVIEW_CONFIRM_STALE: the interview now proposes a different contract than the one confirmed");
  }
}

function interpretationsArg(args: Record<string, unknown> | undefined): readonly TemplateInterpretation[] {
  const value = args?.["interpretations"];
  return value === undefined ? [] : parseInterpretations(JSON.stringify(value));
}

function answersArg(args: Record<string, unknown> | undefined): Answers {
  const value = args?.["answers"];
  if (!isRecord(value)) throw new Error("CONTRACT_ANSWERS_INVALID: answers must be one object from question id to answer");
  return parseAnswers(JSON.stringify(value));
}

export async function handleInterview(ctx: ToolContext, args: Record<string, unknown> | undefined, deps: InterviewToolDeps = {}): Promise<CallToolResult> {
  const { vault } = ctx;
  const op = (args?.["op"] ?? "questions") as InterviewOp;
  if (!OPS.includes(op)) return errorText(`Oh My Second Brain MCP error: unknown interview op ${String(args?.["op"])}`);
  const root = deps.root ?? storeRoot();
  const now = deps.now ?? Date.now;
  if (op !== "questions") {
    const refusal = await admitWriteTarget({ vault, source: ctx.source });
    if (refusal !== undefined) return rejected(vault, refusal);
  }
  try {
    switch (op) {
      case "questions": return await questions(vault, root, args);
      case "answer": return await answer(vault, root, now, args);
      case "confirm": return await confirm(vault, root, now, args);
      case "seal": return await seal(vault, root, now, args, deps.sealDeps ?? {});
    }
  } catch (error: unknown) {
    return errorText(`Oh My Second Brain MCP error: ${message(error)}`);
  }
}

async function run(vault: string, root: string, args: Record<string, unknown> | undefined, io: Parameters<typeof runInterview>[0]["io"], sealDeps?: Partial<SealDeps>): Promise<InterviewResult> {
  return runInterview({
    vault,
    io,
    root,
    nonLoosening: true,
    interpretations: interpretationsArg(args),
    ...(sealDeps === undefined ? {} : { sealDeps }),
    ...(args?.["reask"] === true ? { reask: true } : {}),
  });
}

/** The result as data; `proposed` is the digest the run stopped at, when it reached the seal question. */
async function report(vault: string, root: string, result: InterviewResult, extra: { readonly notes: readonly string[]; readonly drift: readonly unknown[]; readonly proposed: string | null }): Promise<CallToolResult> {
  const base = { vault, contract: await contractStatus(vault, root) };
  const drift = extra.drift.length === 0 ? {} : { drift: extra.drift };
  switch (result.state) {
    case "incomplete": {
      const open = result.questions.filter(question => question.id !== SEAL_QUESTION.id);
      if (open.length === 0 && extra.proposed !== null) {
        return jsonText({ ...base, status: "proposed", proposed: extra.proposed, notes: extra.notes, ...drift, next: CONFIRM_ROUTE });
      }
      return jsonText({ ...base, status: "questions", questions: open.map(publicQuestion), notes: extra.notes, ...drift, next: ANSWER_ROUTE });
    }
    case "interpretation-required":
      return jsonText({
        ...base,
        status: "interpretation-required",
        sources: result.sources,
        next: "Read each template source and pass its interpretation as `interpretations` on every interview call; observedHash must equal the sourceHash listed here.",
      });
    case "refused":
      return jsonText({ ...base, status: "refused", reasons: result.reasons });
    case "loosening":
      return jsonText({ ...base, status: "loosening", changes: result.changes, next: "Only the owner can loosen the sealed contract, by running `oms interview` in a terminal." });
    case "sealed":
      return jsonText({ ...base, ok: true, status: "sealed", result, ...drift });
    default:
      return errorText(`Oh My Second Brain MCP error: the interview ended in an unexpected state (${result.state}).`);
  }
}

/** Read-only: replays the log, asks nothing new and records nothing. */
async function questions(vault: string, root: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  let proposed: string | null = null;
  const resumed = await resumableIO({ vault, root, record: async event => { if (event.type === "proposed") proposed = event.digest; } });
  const result = await run(vault, root, args, resumed.io);
  return report(vault, root, result, { notes: resumed.notes, drift: resumed.drift, proposed });
}

/** Records the new answers (and the proposal, once every question is answered) only after the run succeeds. */
async function answer(vault: string, root: string, now: () => number, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  let answers: Answers;
  try {
    answers = answersArg(args);
  } catch (error: unknown) {
    return rejected(vault, { code: "INTERVIEW_ANSWERS_INVALID", message: message(error), recoverable: true, remediation: "Pass answers as one object from question id to answer." });
  }
  if (Object.hasOwn(answers, SEAL_QUESTION.id) || Object.hasOwn(answers, "seal-lock:reclaim")) {
    return rejected(vault, {
      code: "INTERVIEW_SEAL_NOT_AN_ANSWER",
      message: "The seal is not answered with op \"answer\".",
      recoverable: true,
      remediation: "Answer the other questions, then confirm the proposed digest with op \"confirm\" and seal with op \"seal\".",
    });
  }
  const buffered: InterviewRecord[] = [];
  let proposed: string | null = null;
  const resumed = await resumableIO({
    vault,
    root,
    answers,
    record: async event => {
      if (event.type === "proposed") proposed = event.digest;
      buffered.push(event);
    },
  });
  const result = await run(vault, root, args, resumed.io);
  const { events } = await vaultLog(vault, root);
  const already = latestProposal(events)?.payload["digest"];
  const record = logRecorder(vault, root, now);
  for (const event of buffered) {
    // The same proposal again is not a new proposal: an earlier confirmation of it still stands.
    if (event.type === "proposed" && event.digest === already) continue;
    await record(event);
  }
  return report(vault, root, result, { notes: resumed.notes, drift: resumed.drift, proposed });
}

async function confirm(vault: string, root: string, now: () => number, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const cited = args?.["proposed"];
  const { events } = await vaultLog(vault, root);
  const latest = latestProposal(events)?.payload["digest"];
  if (typeof latest !== "string") {
    return rejected(vault, {
      code: "INTERVIEW_NOTHING_PROPOSED",
      message: "No contract has been proposed yet.",
      recoverable: true,
      remediation: "Answer every question with op \"answer\" until the result is status \"proposed\".",
    });
  }
  if (cited !== latest) {
    return rejected(vault, {
      code: "INTERVIEW_CONFIRM_STALE",
      message: "The confirmation cites a proposal that is not the latest one.",
      recoverable: true,
      remediation: "Call op \"questions\", show the owner the current preview, and confirm the digest it proposes.",
    });
  }
  await appendInterviewEvent(root, await interviewLogKey(vault, root), {
    type: "answered",
    questionId: SEAL_QUESTION.id,
    questionDigest: questionDigest(SEAL_QUESTION),
    payload: { answer: "yes", confirm: true, proposed: latest },
  }, now);
  return jsonText({ vault, ok: true, status: "confirmed", proposed: latest, next: "Call interview with op \"seal\"." });
}

async function seal(vault: string, root: string, now: () => number, args: Record<string, unknown> | undefined, overrides: Partial<SealDeps>): Promise<CallToolResult> {
  const { events } = await vaultLog(vault, root);
  const confirmed = confirmedProposal(events);
  if (confirmed === null) {
    const proposal = latestProposal(events);
    return rejected(vault, proposal === null
      ? { code: "INTERVIEW_NOTHING_PROPOSED", message: "No contract has been proposed yet.", recoverable: true, remediation: "Answer every question with op \"answer\" until the result is status \"proposed\"." }
      : { code: "INTERVIEW_CONFIRM_REQUIRED", message: "The owner has not confirmed the latest proposal.", recoverable: true, remediation: "Show the owner the preview, then call op \"confirm\" with the proposed digest before op \"seal\"." });
  }
  const log = logRecorder(vault, root, now);
  const already = await alreadySealed(vault, root, events, confirmed, log);
  if (already !== null) return report(vault, root, already, { notes: [], drift: [], proposed: confirmed });
  const resumed = await resumableIO({
    vault,
    root,
    answers: { [SEAL_QUESTION.id]: true },
    record: async event => {
      if (event.type === "proposed" && event.digest !== confirmed) throw new ProposalChanged(confirmed, event.digest);
      if (event.type === "sealed") await log(event);
    },
  });
  let result: InterviewResult;
  try {
    // The MCP seal never reclaims a stale lock, whatever the caller injects.
    result = await run(vault, root, args, resumed.io, { ...overrides, now: overrides.now ?? now, confirmStaleReclaim: undefined });
  } catch (error: unknown) {
    if (error instanceof ProposalChanged) {
      return rejected(vault, { code: "INTERVIEW_CONFIRM_STALE", message: error.message, recoverable: true, remediation: "Call op \"questions\", show the owner the current preview, and confirm the digest it proposes." });
    }
    const text = message(error);
    if (text.startsWith("CONTRACT_SEAL_LOCK_STALE")) {
      return rejected(vault, { code: "INTERVIEW_SEAL_LOCK_STALE", message: "An earlier seal did not finish and left its lock behind. This tool does not reclaim it.", recoverable: false, remediation: TERMINAL_ROUTE });
    }
    if (text.startsWith("CONTRACT_SEAL_BUSY")) {
      return rejected(vault, { code: "CONTRACT_SEAL_BUSY", message: text, recoverable: true, retryable: true, remediation: "Another seal is in progress; call op \"seal\" again shortly." });
    }
    throw error;
  }
  return report(vault, root, result, { notes: resumed.notes, drift: resumed.drift, proposed: confirmed });
}

/**
 * The confirmed proposal is already the sealed contract, sealed after the proposal was
 * made: an earlier `seal` finished but its log entry was lost. The missing `sealed` event
 * is recorded (a failure is a warning) and no new generation is sealed. Null otherwise.
 * The seal writes the chosen template folder to the settings after the generation, so a
 * run cut short between the two is completed here from the proposal. Declined templates
 * need nothing: they are part of the sealed generation itself.
 */
async function alreadySealed(vault: string, root: string, events: Parameters<typeof latestProposal>[0], confirmed: string, log: (event: InterviewRecord) => Promise<void>): Promise<InterviewResult | null> {
  const payload = latestProposal(events)?.payload ?? {};
  const removed = payload["removedTemplates"];
  if (!Array.isArray(removed) || !removed.every(name => typeof name === "string")) return null;
  // Without settings there is no vault id, so nothing shows the vault was sealed.
  const settings = await readVaultSettings(vault);
  if (settings === null) return null;
  const { vaultId } = settings;
  if (await currentSequence(vaultId, root) === payload["baseSeq"]) return null;
  const store = await readStore(vaultId, root);
  if (store.state !== "ok" || proposalDigest(store.contract, removed) !== confirmed) return null;
  const warnings: string[] = [];
  const logged = payload["templateFolder"];
  if (typeof logged === "string" && settings.templateFolder === undefined) {
    // The log is outside the vault but not trusted: the folder is checked as the interview checks an answer.
    const templateFolder = await usableFolder(vault, logged);
    if (templateFolder === null) {
      warnings.push("INTERVIEW_TEMPLATE_FOLDER_UNRECORDED: the logged template folder is not an existing, visible folder inside the vault, so it was not saved");
    } else {
      try {
        await writeVaultSettings(vault, { ...settings, templateFolder });
      } catch (error: unknown) {
        warnings.push(`INTERVIEW_TEMPLATE_FOLDER_UNRECORDED: the template folder was not saved (${message(error)})`);
      }
    }
  }
  try {
    await log({ type: "sealed", vaultId });
  } catch (error: unknown) {
    warnings.push(`INTERVIEW_LOG_UNRECORDED: the seal was not logged (${message(error)})`);
  }
  const { contract } = store;
  return {
    state: "sealed",
    vaultIdCreated: false,
    folders: Object.keys(contract.folders ?? {}).length,
    properties: Object.keys(contract.properties ?? {}).length,
    templates: Object.keys(contract.templates),
    ...(removed.length === 0 ? {} : { removedTemplates: removed }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

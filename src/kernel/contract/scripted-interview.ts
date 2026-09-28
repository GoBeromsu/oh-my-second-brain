import type { InterviewIO, InterviewRecord, Question } from "./interview.js";
import { questionDigest } from "./interview-log.js";

/**
 * The interview driven by an answer file instead of a terminal, for an agent that asks
 * the owner each question itself. Questions come from runInterview; nothing here
 * decides what is asked. An answer that the interview rejects, or an answer for a
 * question never asked, ends the run with an error and nothing is sealed.
 */

export type AnswerValue = string | number | boolean;
export type Answers = Readonly<Record<string, AnswerValue>>;

/** The question as printed to an agent. A secret initial answer (template literal values) is left out. */
export interface PublicQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly kind: Question["kind"];
  readonly choices?: readonly string[];
  readonly default?: string | boolean;
}

export function publicQuestion(question: Question): PublicQuestion {
  const base = { id: question.id, prompt: question.prompt, kind: question.kind };
  if (question.kind === "choice") return { ...base, choices: question.options };
  if (question.kind === "confirm") return question.initial === undefined ? base : { ...base, default: question.initial };
  return question.initial === undefined || question.secret === true ? base : { ...base, default: question.initial };
}

/** Parses an answer file: one JSON object from question id to a string, number or boolean. */
export function parseAnswers(text: string): Answers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("CONTRACT_ANSWERS_INVALID: the answers are not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CONTRACT_ANSWERS_INVALID: the answers must be one JSON object from question id to answer");
  }
  const answers: Record<string, AnswerValue> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`CONTRACT_ANSWER_INVALID: ${id}: give a string, number or boolean`);
    }
    answers[id] = value;
  }
  return answers;
}

/** Ids asked outside the question list itself; an answer for them is never reported as unknown. */
const LATE_IDS = new Set(["seal", "seal-lock:reclaim"]);

export function scriptedIO(answers: Answers): { readonly io: InterviewIO; readonly notes: readonly string[] } {
  const notes: string[] = [];
  const asked = new Set<string>();
  const io: InterviewIO = {
    say: line => { notes.push(line); },
    ask: async question => {
      if (asked.has(question.id)) {
        // The interview asks again only after it rejected the answer or a combination with it.
        const reason = notes.at(-1)?.trim() ?? "the answer was rejected";
        throw new Error(`CONTRACT_ANSWER_INVALID: ${question.id}: ${reason}`);
      }
      asked.add(question.id);
      if (question.id === "seal") {
        const unknown = Object.keys(answers).filter(id => !asked.has(id) && !LATE_IDS.has(id));
        if (unknown.length > 0) throw new Error(`CONTRACT_ANSWER_UNKNOWN: no question has the id ${unknown.map(id => JSON.stringify(id)).join(", ")}`);
      }
      if (!Object.hasOwn(answers, question.id)) return null;
      return answerText(question, answers[question.id]!);
    },
  };
  return { io, notes };
}

function answerText(question: Question, value: AnswerValue): string {
  if (typeof value === "boolean") return question.kind === "confirm" ? (value ? "yes" : "no") : String(value);
  return String(value);
}

/** An answer taken from the interview log, with the digest of the question it answered. */
export interface ReplayedAnswer {
  readonly questionDigest: string;
  readonly answer: string;
}

/** A logged answer that was dropped: its question now reads differently, or the interview rejected it. */
export interface ReplayDrift {
  readonly questionId: string;
  readonly reason: "question-changed" | "answer-rejected";
}

/**
 * Replay mode: logged answers first, then `answers`, then `fallback` (a terminal), else
 * no answer. A logged answer is used only while its question digest still matches;
 * otherwise it is dropped, reported as drift, and the question is answered as if new.
 * Replayed answers are already in the log, so `record` is not told about them again.
 * A question handed to `fallback` is recorded as `asked` first.
 */
export function replayIO(options: {
  readonly replay: ReadonlyMap<string, ReplayedAnswer>;
  readonly answers?: Answers;
  readonly fallback?: InterviewIO;
  readonly record?: (event: InterviewRecord) => Promise<void>;
}): { readonly io: InterviewIO; readonly notes: readonly string[]; readonly drift: readonly ReplayDrift[] } {
  const answers = options.answers ?? {};
  const { fallback } = options;
  const notes: string[] = [];
  const drift: ReplayDrift[] = [];
  const replayed = new Map<string, string>();
  const scripted = new Set<string>();
  const asked = new Set<string>();
  const io: InterviewIO = {
    say: line => {
      notes.push(line);
      fallback?.say(line);
    },
    ask: async question => {
      const logged = options.replay.get(question.id);
      if (replayed.has(question.id)) {
        // Asked again: the interview rejected the logged answer, so it is not offered twice.
        replayed.delete(question.id);
        drift.push({ questionId: question.id, reason: "answer-rejected" });
      } else if (logged !== undefined && !asked.has(question.id)) {
        asked.add(question.id);
        if (logged.questionDigest === questionDigest(question)) {
          replayed.set(question.id, logged.answer);
          return logged.answer;
        }
        drift.push({ questionId: question.id, reason: "question-changed" });
      }
      asked.add(question.id);
      if (question.id === "seal") {
        const unknown = Object.keys(answers).filter(id => !asked.has(id) && !LATE_IDS.has(id));
        if (unknown.length > 0) throw new Error(`CONTRACT_ANSWER_UNKNOWN: no question has the id ${unknown.map(id => JSON.stringify(id)).join(", ")}`);
      }
      if (Object.hasOwn(answers, question.id)) {
        if (scripted.has(question.id)) {
          const reason = notes.at(-1)?.trim() ?? "the answer was rejected";
          throw new Error(`CONTRACT_ANSWER_INVALID: ${question.id}: ${reason}`);
        }
        scripted.add(question.id);
        return answerText(question, answers[question.id]!);
      }
      if (fallback === undefined) return null;
      // Only a question put to the person is logged as asked; replayed and scripted ones are not.
      await io.record?.({ type: "asked", question });
      return fallback.ask(question);
    },
    record: async event => {
      if (event.type === "answered" && replayed.get(event.question.id) === event.answer) return;
      await options.record?.(event);
      await fallback?.record?.(event);
    },
  };
  return { io, notes, drift };
}

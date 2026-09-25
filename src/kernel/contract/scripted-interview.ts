import type { InterviewIO, Question } from "./interview.js";

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
      const value = answers[question.id]!;
      if (typeof value === "boolean") return question.kind === "confirm" ? (value ? "yes" : "no") : String(value);
      return String(value);
    },
  };
  return { io, notes };
}

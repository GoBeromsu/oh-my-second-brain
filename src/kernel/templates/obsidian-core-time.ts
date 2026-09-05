export const OBSIDIAN_TIME_FORMAT_TOKENS = [
  "YYYY", "YY", "MM", "M", "DD", "D", "HH", "H", "hh", "h", "mm", "m", "ss", "s", "A", "a",
] as const;

export type ObsidianTimeFormatToken =
  | { readonly kind: "token"; readonly value: typeof OBSIDIAN_TIME_FORMAT_TOKENS[number] }
  | { readonly kind: "literal"; readonly value: "-" | "/" | "." | ":" | " " | "T" };

export class TemplateExpressionError extends Error {
  readonly code = "TEMPLATE_EXPRESSION_UNSUPPORTED";

  constructor(
    readonly sourcePath: string,
    readonly location: string,
    readonly rawToken: string,
  ) {
    super(`TEMPLATE_EXPRESSION_UNSUPPORTED: ${sourcePath}:${location}: ${rawToken}`);
    this.name = "TemplateExpressionError";
  }
}

const TOKEN_BY_LENGTH = [...OBSIDIAN_TIME_FORMAT_TOKENS].sort((left, right) => right.length - left.length);
const LITERALS = new Set(["-", "/", ".", ":", " ", "T"]);
function tokenFamily(token: typeof OBSIDIAN_TIME_FORMAT_TOKENS[number]): string {
  if (token.startsWith("Y")) return "year";
  if (token.startsWith("M")) return "month";
  if (token.startsWith("D")) return "day";
  if (token.startsWith("H")) return "hour24";
  if (token.startsWith("h")) return "hour12";
  if (token.startsWith("m")) return "minute";
  if (token.startsWith("s")) return "second";
  return "meridiem";
}

/** Parses the exact Obsidian Core Templates time-format subset supported by OMS. */
export function parseObsidianTimeFormat(fmt: string): readonly ObsidianTimeFormatToken[] {
  if (fmt.length === 0) throw new TemplateExpressionError("<format>", "format", fmt);
  const result: ObsidianTimeFormatToken[] = [];
  let offset = 0;
  while (offset < fmt.length) {
    const token = TOKEN_BY_LENGTH.find(candidate => fmt.startsWith(candidate, offset));
    if (token !== undefined) {
      const previous = result[result.length - 1];
      if (previous?.kind === "token" && tokenFamily(previous.value) === tokenFamily(token)) {
        throw new TemplateExpressionError("<format>", "format", `${previous.value}${token}`);
      }
      result.push({ kind: "token", value: token });
      offset += token.length;
      continue;
    }
    const character = fmt[offset]!;
    if (LITERALS.has(character)) {
      result.push({ kind: "literal", value: character as Extract<ObsidianTimeFormatToken, { kind: "literal" }>['value'] });
      offset += 1;
      continue;
    }
    throw new TemplateExpressionError("<format>", "format", character);
  }
  return result;
}

function pad(value: number, width = 2): string { return String(value).padStart(width, "0"); }

/** Deterministically renders local wall-clock fields. Callers pass the resolvedAt instant as `date`. */
export function formatObsidianTime(fmt: string, date: Date, kind: "date" | "time"): string {
  if (Number.isNaN(date.getTime())) throw new TypeError("TEMPLATE_EXPRESSION_UNSUPPORTED: date must be valid");
  const effectiveFormat = fmt === "" ? kind === "date" ? "YYYY-MM-DD" : "HH:mm" : fmt;
  const hour = date.getHours();
  const hour12 = hour % 12 || 12;
  const values: Record<typeof OBSIDIAN_TIME_FORMAT_TOKENS[number], string> = {
    YYYY: pad(date.getFullYear(), 4), YY: pad(date.getFullYear() % 100),
    MM: pad(date.getMonth() + 1), M: String(date.getMonth() + 1),
    DD: pad(date.getDate()), D: String(date.getDate()),
    HH: pad(hour), H: String(hour), hh: pad(hour12), h: String(hour12),
    mm: pad(date.getMinutes()), m: String(date.getMinutes()),
    ss: pad(date.getSeconds()), s: String(date.getSeconds()),
    A: hour < 12 ? "AM" : "PM", a: hour < 12 ? "am" : "pm",
  };
  return parseObsidianTimeFormat(effectiveFormat).map(part => part.kind === "literal" ? part.value : values[part.value]).join("");
}

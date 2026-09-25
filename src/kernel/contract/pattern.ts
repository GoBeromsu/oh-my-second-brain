/**
 * The one screen every sealed `pattern` rule passes: the interview asks with it, the store
 * refuses to seal without it, and the judge refuses to run a source longer than the cap.
 */

/** Longest regular-expression source a pattern rule may hold, in UTF-16 code units. */
export const PATTERN_SOURCE_LIMIT = 1_000;

export type PatternRefusal = "empty" | "too-long" | "invalid" | "nested";

/**
 * Conservative ReDoS screen: refuses a group that holds a quantifier or an alternation
 * and is itself repeated by `*`, `+` or `{…}`, such as `(a+)+`, `(a*)*` or `(a|a)*`.
 * Some safe patterns are refused too; the judge also caps the input it matches.
 */
export function hasNestedQuantifier(source: string): boolean {
  const open: boolean[] = [];
  let closedRisky = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const afterGroup = closedRisky;
    closedRisky = false;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      for (index += 1; index < source.length && source[index] !== "]"; index += 1) if (source[index] === "\\") index += 1;
      continue;
    }
    if (char === "(") {
      open.push(false);
      if (source[index + 1] === "?") {
        index += 1;
        if (source[index + 1] === "<" && source[index + 2] !== "=" && source[index + 2] !== "!") {
          while (index < source.length && source[index] !== ">") index += 1;
        } else index += 1;
      }
      continue;
    }
    if (char === ")") {
      const risky = open.pop() ?? false;
      if (open.length > 0 && risky) open[open.length - 1] = true;
      closedRisky = risky;
      continue;
    }
    const repeats = char === "*" || char === "+" || char === "{" && /^\{\d*,?\d*\}/.test(source.slice(index));
    if (repeats && afterGroup) return true;
    if ((repeats || char === "?" || char === "|") && open.length > 0) open[open.length - 1] = true;
  }
  return false;
}

/** Why a pattern source may not be sealed, or null when it may. The length is checked before compiling. */
export function patternRefusal(source: string): PatternRefusal | null {
  if (source === "") return "empty";
  if (source.length > PATTERN_SOURCE_LIMIT) return "too-long";
  try {
    new RegExp(source, "u");
  } catch {
    return "invalid";
  }
  return hasNestedQuantifier(source) ? "nested" : null;
}

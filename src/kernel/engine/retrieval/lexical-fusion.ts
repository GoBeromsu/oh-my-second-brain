/**
 * Fusion of the production lexical list (CUR) with the Korean bigram list (BI).
 * Branch-only experiment (PR6); see lexical-ko.ts.
 */

import type { ScoredHit } from "../types.js";
import { fuseRRF } from "./rrf.js";

/** RRF constant for CUR+BI, the same k=60 the dispatcher uses. */
export const KO_LEXICAL_RRF_K = 60;

/** Fuses CUR and BI with RRF; CUR comes first so ties keep its order key. */
export function fuseKoreanLexical(cur: ScoredHit[], bigram: ScoredHit[]): ScoredHit[] {
  return fuseRRF([cur, bigram], KO_LEXICAL_RRF_K);
}

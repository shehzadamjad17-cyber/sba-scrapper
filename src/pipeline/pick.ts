/**
 * Winner selection: walk the desc-sorted scored list taking up to `max`
 * candidates with totalScore ≥ minScore, at most nicheCap per assigned
 * niche, skipping any candidate within simThreshold cosine of an
 * already-picked winner (same-day near-dupe guard).
 */
import { cosineSimilarity } from "@/lib/gemini";
import type { ScoredCandidate } from "./score";

export interface PickOptions {
  max?: number;
  minScore?: number;
  nicheCap?: number;
  simThreshold?: number;
}

export function pickWinners(sorted: ScoredCandidate[], opts: PickOptions = {}): ScoredCandidate[] {
  const { max = 3, minScore = 0.4, nicheCap = 2, simThreshold = 0.8 } = opts;
  const picked: ScoredCandidate[] = [];
  const nicheCounts = new Map<string, number>();

  for (const c of sorted) {
    if (picked.length >= max) break;
    if (c.totalScore < minScore) break; // sorted desc — nothing below qualifies
    if ((nicheCounts.get(c.assignedNicheSlug) ?? 0) >= nicheCap) continue;
    if (picked.some((p) => cosineSimilarity(p.embedding, c.embedding) > simThreshold)) continue;
    picked.push(c);
    nicheCounts.set(c.assignedNicheSlug, (nicheCounts.get(c.assignedNicheSlug) ?? 0) + 1);
  }
  return picked;
}

/**
 * Score each candidate question:
 *   totalScore = nicheMatch × intentScore × sourceWeight × engagementBoost
 *
 * - nicheMatch:    cosine sim between question embedding and centroid of niche.keywords
 *                  embeddings. Hard reject if < 0.3.
 * - intentScore:   Gemini micro-call ("rate 0-1 how strongly this person needs funding now")
 *                  cached per question text within this run.
 * - sourceWeight:  hard-coded per source (1.0 reddit, 1.5 paa, 0.7 youtube)
 * - engagementBoost: 1 + min(0.3, log10(max(1, engagement)) / 10)  (range [1, 1.3])
 */
import { SchemaType } from "@google/generative-ai";
import { embedContent, cosineSimilarity, centroid, generateContent } from "@/lib/gemini";
import type { CandidateQuestion } from "@/adapters/types";
import type { NicheConfig } from "@/lib/niche";
import { logger } from "@/lib/logger";

const NICHE_MATCH_HARD_THRESHOLD = 0.3;

export interface ScoredCandidate {
  candidate: CandidateQuestion;
  nicheMatch: number;
  intentScore: number;
  sourceWeight: number;
  engagementBoost: number;
  totalScore: number;
}

const SOURCE_WEIGHTS: Record<CandidateQuestion["sourceType"], number> = {
  reddit: 1.0,
  google_paa: 1.5,
  youtube: 0.7,
};

function engagementBoost(engagement: number): number {
  return 1 + Math.min(0.3, Math.log10(Math.max(1, engagement)) / 10);
}

async function buildNicheCentroid(niche: NicheConfig): Promise<number[]> {
  const vectors: number[][] = [];
  for (const kw of niche.keywords) {
    vectors.push(await embedContent(kw));
  }
  return centroid(vectors);
}

async function rateIntent(questionText: string): Promise<number> {
  const { parsed } = await generateContent({
    prompt:
      `On a scale of 0 to 1, how strongly does this question indicate someone is actively considering paying for business funding right now?\n\n` +
      `Question: "${questionText}"\n\n` +
      `Return JSON with a single field "intent" between 0 and 1.`,
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: { intent: { type: SchemaType.NUMBER } },
      required: ["intent"],
    },
    temperature: 0,
  });
  const intent = (parsed as { intent?: number }).intent;
  if (typeof intent !== "number" || intent < 0 || intent > 1) return 0.5;
  return intent;
}

export async function scoreCandidates(
  candidates: CandidateQuestion[],
  niche: NicheConfig
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return [];

  // 1. Niche centroid (one embedding per keyword)
  logger.info("Building niche centroid", { keywordCount: niche.keywords.length });
  const nicheCentroidVec = await buildNicheCentroid(niche);

  // 2. Embed each candidate, compute nicheMatch, hard-reject low-match ones
  const survivors: ScoredCandidate[] = [];
  for (const c of candidates) {
    const vec = await embedContent(c.questionText);
    const nicheMatch = cosineSimilarity(vec, nicheCentroidVec);
    if (nicheMatch < NICHE_MATCH_HARD_THRESHOLD) continue;
    survivors.push({
      candidate: c,
      nicheMatch,
      intentScore: 0, // filled in next step
      sourceWeight: SOURCE_WEIGHTS[c.sourceType],
      engagementBoost: engagementBoost(c.engagement),
      totalScore: 0,
    });
  }
  logger.info("Survived niche-match threshold", {
    inputCount: candidates.length,
    survivors: survivors.length,
  });

  // 3. Intent-score the survivors (one Gemini Flash call each)
  for (const s of survivors) {
    s.intentScore = await rateIntent(s.candidate.questionText);
    s.totalScore = s.nicheMatch * s.intentScore * s.sourceWeight * s.engagementBoost;
  }

  // 4. Sort descending by totalScore
  survivors.sort((a, b) => b.totalScore - a.totalScore);
  return survivors;
}

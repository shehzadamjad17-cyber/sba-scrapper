/**
 * Score each candidate question (BATCHED — the 300s fix):
 *   totalScore = nicheMatch × intentScore × sourceWeight × engagementBoost
 *
 * - nicheMatch: max cosine sim between candidate embedding and each niche's
 *   keyword-centroid; the argmax niche becomes assignedNicheSlug.
 *   Hard reject if < 0.3.
 * - intentScore: Gemini calls batched 25 questions at a time.
 * - Embeddings: ALL via embedBatch (≤100/call). Candidate embeddings are
 *   carried on ScoredCandidate so dedup/pick never re-embed.
 */
import { SchemaType } from "@google/generative-ai";
import { embedBatch, cosineSimilarity, centroid, generateContent } from "@/lib/gemini";
import type { CandidateQuestion } from "@/adapters/types";
import type { NicheConfig } from "@/lib/niche";
import { logger } from "@/lib/logger";

const NICHE_MATCH_HARD_THRESHOLD = 0.3;
const INTENT_BATCH_SIZE = 25;

export interface ScoredCandidate {
  candidate: CandidateQuestion;
  embedding: number[];
  nicheMatch: number;
  assignedNicheSlug: string;
  intentScore: number;
  sourceWeight: number;
  engagementBoost: number;
  totalScore: number;
}

export const SOURCE_WEIGHTS: Record<CandidateQuestion["sourceType"], number> = {
  reddit: 1.0,
  google_paa: 1.5,
  google_autocomplete: 1.2,
  youtube: 0.7,
};

function engagementBoost(engagement: number): number {
  return 1 + Math.min(0.3, Math.log10(Math.max(1, engagement)) / 10);
}

/** One centroid per niche; every keyword of every niche embedded in one batch. */
async function buildNicheCentroids(
  niches: NicheConfig[]
): Promise<{ slug: string; vec: number[] }[]> {
  const allKeywords = niches.flatMap((n) => n.keywords);
  const vectors = await embedBatch(allKeywords);
  const out: { slug: string; vec: number[] }[] = [];
  let offset = 0;
  for (const n of niches) {
    out.push({ slug: n.slug, vec: centroid(vectors.slice(offset, offset + n.keywords.length)) });
    offset += n.keywords.length;
  }
  return out;
}

/** Rate 0-1 purchase intent for a batch of questions in ONE Gemini call. */
async function rateIntentBatch(questions: string[]): Promise<number[]> {
  const numbered = questions.map((q, i) => `${i}. "${q}"`).join("\n");
  const { parsed } = await generateContent({
    prompt:
      `For each numbered question below, rate 0 to 1 how strongly it indicates a small business owner actively considering paying for business funding right now.\n\n` +
      `${numbered}\n\n` +
      `Return JSON: {"ratings":[{"index":<number>,"intent":<0..1>}, ...]} with one entry per question.`,
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        ratings: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              index: { type: SchemaType.NUMBER },
              intent: { type: SchemaType.NUMBER },
            },
            required: ["index", "intent"],
          },
        },
      },
      required: ["ratings"],
    },
    temperature: 0,
  });

  const scores = new Array<number>(questions.length).fill(0.5);
  const ratings = (parsed as { ratings?: { index?: number; intent?: number }[] }).ratings ?? [];
  for (const r of ratings) {
    if (
      typeof r.index === "number" &&
      typeof r.intent === "number" &&
      r.index >= 0 &&
      r.index < questions.length &&
      r.intent >= 0 &&
      r.intent <= 1
    ) {
      scores[r.index] = r.intent;
    }
  }
  return scores;
}

export async function scoreCandidates(
  candidates: CandidateQuestion[],
  niches: NicheConfig[]
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return [];

  logger.info("Building niche centroids", { nicheCount: niches.length });
  const centroids = await buildNicheCentroids(niches);

  // Embed all candidates in one batch; argmax niche; hard-reject low match
  const candidateVecs = await embedBatch(candidates.map((c) => c.questionText));
  const survivors: ScoredCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    let best = { slug: "", sim: -Infinity };
    for (const c of centroids) {
      const sim = cosineSimilarity(candidateVecs[i], c.vec);
      if (sim > best.sim) best = { slug: c.slug, sim };
    }
    if (best.sim < NICHE_MATCH_HARD_THRESHOLD) continue;
    survivors.push({
      candidate: candidates[i],
      embedding: candidateVecs[i],
      nicheMatch: best.sim,
      assignedNicheSlug: best.slug,
      intentScore: 0,
      sourceWeight: SOURCE_WEIGHTS[candidates[i].sourceType],
      engagementBoost: engagementBoost(candidates[i].engagement),
      totalScore: 0,
    });
  }
  logger.info("Survived niche-match threshold", {
    inputCount: candidates.length,
    survivors: survivors.length,
  });

  // Intent-score survivors in batches of 25
  for (let i = 0; i < survivors.length; i += INTENT_BATCH_SIZE) {
    const batch = survivors.slice(i, i + INTENT_BATCH_SIZE);
    const scores = await rateIntentBatch(batch.map((s) => s.candidate.questionText));
    batch.forEach((s, j) => {
      s.intentScore = scores[j];
      s.totalScore = s.nicheMatch * s.intentScore * s.sourceWeight * s.engagementBoost;
    });
  }

  survivors.sort((a, b) => b.totalScore - a.totalScore);
  return survivors;
}

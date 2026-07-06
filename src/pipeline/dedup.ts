/**
 * Dedup scored candidates against the last 60 days of BlogPost titles
 * (ALL statuses — scraper-created drafts count) and non-rejected BlogDraft
 * titles. Reject candidate if max cosine > 0.80.
 *
 * Titles are embedded in ONE batch call; candidate embeddings are reused
 * from the scoring step (never re-embedded).
 */
import { prisma } from "@/lib/db";
import { embedBatch, cosineSimilarity } from "@/lib/gemini";
import type { ScoredCandidate } from "./score";
import { logger } from "@/lib/logger";

const DEDUP_SIMILARITY_THRESHOLD = 0.8;
const RECENT_DAYS = 60;

async function fetchRecentTitles(): Promise<string[]> {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const [posts, drafts] = await Promise.all([
    prisma.blogPost.findMany({
      where: { createdAt: { gte: cutoff } },
      select: { title: true },
    }),
    prisma.blogDraft.findMany({
      where: { createdAt: { gte: cutoff }, status: { not: "rejected" } },
      select: { title: true },
    }),
  ]);
  return Array.from(new Set([...posts.map((p) => p.title), ...drafts.map((d) => d.title)]));
}

export async function dedupCandidates(scored: ScoredCandidate[]): Promise<ScoredCandidate[]> {
  if (scored.length === 0) return [];

  const titles = await fetchRecentTitles();
  if (titles.length === 0) {
    logger.info("Dedup: no recent posts/drafts, returning all candidates", {
      candidateCount: scored.length,
    });
    return scored;
  }

  const titleVecs = await embedBatch(titles);

  const survivors: ScoredCandidate[] = [];
  let rejectedCount = 0;
  for (const s of scored) {
    let maxSim = 0;
    let nearest = "";
    for (let i = 0; i < titleVecs.length; i++) {
      const sim = cosineSimilarity(s.embedding, titleVecs[i]);
      if (sim > maxSim) {
        maxSim = sim;
        nearest = titles[i];
      }
    }
    if (maxSim > DEDUP_SIMILARITY_THRESHOLD) {
      logger.info("Dedup rejected", {
        question: s.candidate.questionText.slice(0, 80),
        maxSim: maxSim.toFixed(3),
        nearest: nearest.slice(0, 80),
      });
      rejectedCount++;
      continue;
    }
    survivors.push(s);
  }

  logger.info("Dedup pass complete", {
    inputCount: scored.length,
    rejected: rejectedCount,
    survivors: survivors.length,
  });
  return survivors;
}

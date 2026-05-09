/**
 * Dedup scored candidates against the last 60 days of BlogPost titles
 * (published) and BlogDraft titles (any non-rejected state).
 *
 * Reject candidate if max(cosineSim(candidate, eachRecentTitle)) > 0.80.
 *
 * Embeddings are computed on the fly (we don't cache them in DB to keep
 * the schema simple). At ~100 candidates × ~50-100 recent titles, that's
 * ~150-200 embedding calls per run, well within Gemini's free tier.
 */
import { prisma } from "@/lib/db";
import { embedContent, cosineSimilarity } from "@/lib/gemini";
import type { ScoredCandidate } from "./score";
import { logger } from "@/lib/logger";

const DEDUP_SIMILARITY_THRESHOLD = 0.8;
const RECENT_DAYS = 60;

interface RecentTitle {
  text: string;
  source: "BlogPost" | "BlogDraft";
}

async function fetchRecentTitles(): Promise<RecentTitle[]> {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const [posts, drafts] = await Promise.all([
    prisma.blogPost.findMany({
      where: {
        status: "published",
        publishedAt: { gte: cutoff },
      },
      select: { title: true },
    }),
    prisma.blogDraft.findMany({
      where: {
        createdAt: { gte: cutoff },
        status: { not: "rejected" },
      },
      select: { title: true },
    }),
  ]);
  return [
    ...posts.map((p) => ({ text: p.title, source: "BlogPost" as const })),
    ...drafts.map((d) => ({ text: d.title, source: "BlogDraft" as const })),
  ];
}

export async function dedupCandidates(scored: ScoredCandidate[]): Promise<ScoredCandidate[]> {
  if (scored.length === 0) return [];

  const recents = await fetchRecentTitles();
  if (recents.length === 0) {
    logger.info("Dedup: no recent posts/drafts, returning all candidates", {
      candidateCount: scored.length,
    });
    return scored;
  }

  // Embed every recent title once
  const recentEmbeddings: { text: string; embedding: number[]; source: string }[] = [];
  for (const r of recents) {
    recentEmbeddings.push({
      text: r.text,
      embedding: await embedContent(r.text),
      source: r.source,
    });
  }

  const survivors: ScoredCandidate[] = [];
  let rejectedCount = 0;
  for (const s of scored) {
    const candidateEmbedding = await embedContent(s.candidate.questionText);
    let maxSim = 0;
    let mostSimilarTitle = "";
    for (const r of recentEmbeddings) {
      const sim = cosineSimilarity(candidateEmbedding, r.embedding);
      if (sim > maxSim) {
        maxSim = sim;
        mostSimilarTitle = r.text;
      }
    }
    if (maxSim > DEDUP_SIMILARITY_THRESHOLD) {
      logger.info("Dedup rejected", {
        question: s.candidate.questionText.slice(0, 80),
        maxSim: maxSim.toFixed(3),
        nearest: mostSimilarTitle.slice(0, 80),
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

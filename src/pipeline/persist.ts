/**
 * Persist one generated article:
 *   1. BlogPost  (status="draft")  → visible in the main site's admin UI
 *   2. BlogDraft (status="promoted") → provenance/audit record, linked via
 *      promotedToPostId. No schema changes — legacy JSON columns store "[]".
 *
 * ScraperRun bookkeeping is the ORCHESTRATOR's job, not ours.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ScoredCandidate } from "./score";
import type { ArticleGenResult } from "./article";
import type { NicheConfig } from "@/lib/niche";

const MAX_SLUG_ATTEMPTS = 10;

async function resolveSlug(base: string): Promise<string> {
  let slug = base;
  for (let n = 2; n <= MAX_SLUG_ATTEMPTS + 1; n++) {
    const existing = await prisma.blogPost.findUnique({ where: { slug }, select: { id: true } });
    if (!existing) return slug;
    slug = `${base}-${n}`;
  }
  throw new Error(`Could not find a free slug for "${base}" after ${MAX_SLUG_ATTEMPTS} attempts`);
}

async function pickCoverImage(niche: NicheConfig): Promise<string> {
  const pool = niche.imagePool.length > 0
    ? niche.imagePool
    : process.env.DEFAULT_COVER_IMAGE
      ? [process.env.DEFAULT_COVER_IMAGE]
      : [];
  if (pool.length === 0) {
    throw new Error(
      `No cover image available for niche "${niche.slug}" (empty imagePool and no DEFAULT_COVER_IMAGE)`
    );
  }
  const count = await prisma.blogDraft.count({ where: { niche: niche.displayName } });
  return pool[count % pool.length];
}

/** First paragraph of the body = the direct answer (GEO opening). */
function firstParagraph(body: string): string {
  return body.split(/\n\s*\n/)[0]?.trim() ?? "";
}

export async function persistArticle(opts: {
  winner: ScoredCandidate;
  gen: ArticleGenResult;
  niche: NicheConfig;
}): Promise<{ blogPostId: string; blogDraftId: string; slug: string }> {
  const { winner, gen, niche } = opts;

  const authorId = process.env.SCRAPER_AUTHOR_ID;
  if (!authorId) throw new Error("SCRAPER_AUTHOR_ID env var is required");

  const coverImage = await pickCoverImage(niche);
  const slug = await resolveSlug(gen.article.slug);

  const post = await prisma.blogPost.create({
    data: {
      slug,
      title: gen.article.title,
      excerpt: gen.article.excerpt,
      coverImage,
      body: gen.article.body,
      status: "draft",
      authorId,
    },
  });

  const draft = await prisma.blogDraft.create({
    data: {
      sourceType: winner.candidate.sourceType,
      sourceUrl: winner.candidate.sourceUrl,
      sourceQuestion: winner.candidate.questionText,
      niche: niche.displayName,
      title: gen.article.title,
      titleVariants: "[]",
      clearAnswer: firstParagraph(gen.article.body),
      bodyOutline: gen.article.body,
      comparisonTable: "[]",
      faqSection: "[]",
      internalLinks: "[]",
      ctaBlock: niche.ctaPath,
      imagePrompt: coverImage,
      intentScore: winner.intentScore,
      nicheMatch: winner.nicheMatch,
      totalScore: winner.totalScore,
      status: "promoted",
      promotedToPostId: post.id,
      promotedAt: new Date(),
      llmModel: gen.llmModel,
      llmPromptVersion: gen.llmPromptVersion,
      llmResponseRaw: gen.llmResponseRaw,
    },
  });

  logger.info("Article persisted", { blogPostId: post.id, blogDraftId: draft.id, slug });
  return { blogPostId: post.id, blogDraftId: draft.id, slug };
}

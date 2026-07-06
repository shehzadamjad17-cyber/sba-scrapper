/**
 * Full-article generation (replaces the old outline.ts).
 *
 * One Gemini 2.5 Flash structured-output call produces a publish-ready
 * article {slug, title, excerpt, body}. The SEO/GEO validator gates the
 * result; ONE retry with the violations fed back; second failure throws
 * (caller skips this article, run continues).
 */
import { SchemaType } from "@google/generative-ai";
import { generateContent, embedBatch, cosineSimilarity, GEMINI_GEN_MODEL } from "@/lib/gemini";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { SEO_RULES_PROMPT, validateArticle, type GeneratedArticle } from "@/lib/seo-rules";
import type { ScoredCandidate } from "./score";
import type { NicheConfig } from "@/lib/niche";

export const PROMPT_VERSION = "v2.0";

const LINK_MENU_SIZE = 8;
const LINK_MENU_POOL = 50;

export interface LinkMenuItem {
  title: string;
  slug: string;
}

export interface ArticleGenResult {
  article: GeneratedArticle;
  llmModel: string;
  llmPromptVersion: string;
  llmResponseRaw: string;
}

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    slug: { type: SchemaType.STRING },
    title: { type: SchemaType.STRING },
    excerpt: { type: SchemaType.STRING },
    body: { type: SchemaType.STRING },
  },
  required: ["slug", "title", "excerpt", "body"],
};

/**
 * Top-8 published posts most relevant to the winner (by title embedding
 * similarity) — the ONLY internal slugs the model may link to.
 */
export async function buildLinkMenu(winnerEmbedding: number[]): Promise<LinkMenuItem[]> {
  const posts = await prisma.blogPost.findMany({
    where: { status: "published" },
    orderBy: { publishedAt: "desc" },
    take: LINK_MENU_POOL,
    select: { title: true, slug: true },
  });
  if (posts.length === 0) return [];
  const vecs = await embedBatch(posts.map((p) => p.title));
  return posts
    .map((p, i) => ({ ...p, sim: cosineSimilarity(winnerEmbedding, vecs[i]) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, LINK_MENU_SIZE)
    .map(({ title, slug }) => ({ title, slug }));
}

export function buildArticlePrompt(
  winner: ScoredCandidate,
  niche: NicheConfig,
  menu: LinkMenuItem[]
): string {
  const menuBlock =
    menu.length > 0
      ? menu.map((m) => `- "${m.title}" → /blog/${m.slug}`).join("\n")
      : "(none available — do NOT include any /blog/ links in this article)";

  return `You are Joseph Snado, founder of SBA Loan Options — a brokerage helping small business owners find funding after MCA hardship or SBA denial. Write a COMPLETE, publish-ready blog article.

Reader's question (verbatim from a real small business owner): "${winner.candidate.questionText}"
Source context: ${winner.candidate.contextSnippet || "(none)"}
Topic niche: ${niche.displayName}
Call-to-action path for this article: ${niche.ctaPath}

Internal articles you may link to (2-4 of them, only these):
${menuBlock}

${SEO_RULES_PROMPT}

Return JSON: { "slug", "title", "excerpt", "body" } where body is the full markdown article.`;
}

export async function generateArticle(
  winner: ScoredCandidate,
  niche: NicheConfig,
  menu: LinkMenuItem[]
): Promise<ArticleGenResult> {
  const basePrompt = buildArticlePrompt(winner, niche, menu);
  const allowedInternalSlugs = menu.map((m) => m.slug);
  let lastViolations: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nYour previous attempt was REJECTED for these rule violations — fix ALL of them:\n${lastViolations.map((x) => `- ${x}`).join("\n")}`;

    logger.info("Generating article", {
      attempt,
      question: winner.candidate.questionText.slice(0, 80),
    });
    const { raw, parsed } = await generateContent({
      prompt,
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
    });

    const article = parsed as GeneratedArticle;
    const result = validateArticle(article, { allowedInternalSlugs });
    if (result.ok) {
      return {
        article,
        llmModel: GEMINI_GEN_MODEL,
        llmPromptVersion: PROMPT_VERSION,
        llmResponseRaw: raw,
      };
    }
    lastViolations = result.violations;
    logger.warn("Article failed validation", { attempt, violations: result.violations });
  }

  throw new Error(`Article rejected after 2 attempts: ${lastViolations.join("; ")}`);
}

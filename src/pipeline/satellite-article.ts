/**
 * Satellite variant of article generation. Reuses the shared Gemini call +
 * validateArticle, but with the target's persona, link base path, CTA, and
 * a link menu built from the target's static cornerstones + its own
 * published generated posts (NEVER the main site's /blog/ posts).
 */
import { SchemaType } from "@google/generative-ai";
import { generateContent, embedBatch, cosineSimilarity, GEMINI_GEN_MODEL } from "@/lib/gemini";
import { logger } from "@/lib/logger";
import { validateArticle, normalizeExcerpt, type GeneratedArticle } from "@/lib/seo-rules";
import { fetchPublishedSitePosts, type ExecuteFn } from "@/lib/content-db";
import type { ScoredCandidate } from "./score";
import type { NicheConfig } from "@/lib/niche";
import type { SatelliteTarget } from "@/lib/targets";
import type { ArticleGenResult, LinkMenuItem } from "./article";

export const SATELLITE_PROMPT_VERSION = "sat-v1.1";

const LINK_MENU_SIZE = 8;

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

export async function buildSatelliteLinkMenu(
  target: SatelliteTarget,
  winnerEmbedding: number[],
  execute?: ExecuteFn
): Promise<LinkMenuItem[]> {
  const generated = await fetchPublishedSitePosts(target.siteId, execute).catch(() => []);
  const pool = [...target.cornerstones, ...generated];
  if (pool.length === 0) return [];
  const vecs = await embedBatch(pool.map((p) => p.title));
  return pool
    .map((p, i) => ({ ...p, sim: cosineSimilarity(winnerEmbedding, vecs[i]) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, LINK_MENU_SIZE)
    .map(({ title, slug }) => ({ title, slug }));
}

function buildSatelliteRulesPrompt(target: SatelliteTarget): string {
  return `
STRICT CONTENT RULES (violations cause automatic rejection):

Metadata
- title: mirrors the reader's question, ≤60 characters, no clickbait.
- slug: lowercase kebab-case, primary keyword, no stopwords, ≤60 characters.
- excerpt: 120-155 characters; primary keyword + a concrete benefit (used as the meta description).

Structure (GEO/AEO)
- Open with 2-3 sentences that DIRECTLY and completely answer the question. No heading before it, no throat-clearing.
- NO H1 headings anywhere (the site renders the H1). Use exactly 4-6 content H2 sections (##).
- Each H2 section opens with one self-contained factual sentence that makes sense quoted out of context.
- Include exactly one markdown comparison table (relevant options/tradeoffs). It MUST use this exact pipe syntax:
| Option | Typical speed | Best for |
|---|---|---|
| Example row | Example | Example |
- End sections with a "## FAQ" heading containing 4-6 "### <question>?" subheadings, each followed by a 1-3 sentence answer paragraph.
- 1,500-2,200 words total — NEVER under 1,400. Short paragraphs (≤3 sentences). Use bullet lists. Bold key phrases sparingly.
- NEVER use numbered lists (1. 2. 3.) — hyphen bullet lists only.
- Define niche jargon on first use. Write at an 8th-grade reading level.

Links
- Link EXACTLY 3 of the provided internal articles inline where genuinely relevant, format [anchor text](${target.blogBasePath}/<slug>). ONLY use slugs from the provided list. NEVER more than 4 internal links in the whole article — count them before finishing.
- MANDATORY (the article is auto-rejected without it): include a call-to-action link to ${target.ctaPath}, e.g. [See your options](${target.ctaPath}) in the closing section before the FAQ.
- At most 2 external links, ONLY to: sba.gov, federalreserve.gov, irs.gov.

Voice & compliance
- ${target.persona}
- NEVER fabricate statistics, dollar figures, rates, lender names, borrower stories, or testimonials. Use ranges and qualitative statements ("often", "typically", "can range widely").
- NEVER write: "direct lender", "direct funder", "our own capital", "we lend", "guaranteed approval", "100% approval", or anything implying certainty of funding.
- NEVER mention any funding company, brand, or website other than ${target.brandName} (and the .gov sources above).
- Markdown only. NO curly braces { }, NO raw HTML tags, NO placeholders of any kind — the output must be publish-ready.
`.trim();
}

export function buildSatellitePrompt(
  winner: ScoredCandidate,
  niche: NicheConfig,
  menu: LinkMenuItem[],
  target: SatelliteTarget
): string {
  const menuBlock =
    menu.length > 0
      ? menu.map((m) => `- "${m.title}" → ${target.blogBasePath}/${m.slug}`).join("\n")
      : `(none available — do NOT include any ${target.blogBasePath}/ links in this article)`;

  return `${target.persona} Write a COMPLETE, publish-ready blog article for the ${target.brandName} website.

Reader's question (verbatim from a real small business owner): "${winner.candidate.questionText}"
Source context: ${winner.candidate.contextSnippet || "(none)"}
Topic niche: ${niche.displayName}
Call-to-action path for this article: ${target.ctaPath}

Internal articles you may link to (2-4 of them, only these):
${menuBlock}

${buildSatelliteRulesPrompt(target)}

Return JSON: { "slug", "title", "excerpt", "body" } where body is the full markdown article.`;
}

export async function generateSatelliteArticle(
  winner: ScoredCandidate,
  niche: NicheConfig,
  menu: LinkMenuItem[],
  target: SatelliteTarget
): Promise<ArticleGenResult> {
  const basePrompt = buildSatellitePrompt(winner, niche, menu, target);
  const allowedInternalSlugs = menu.map((m) => m.slug);
  let lastViolations: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nYour previous attempt was REJECTED for these rule violations — fix ALL of them:\n${lastViolations.map((x) => `- ${x}`).join("\n")}`;

    logger.info("Generating satellite article", {
      target: target.siteId,
      attempt,
      question: winner.candidate.questionText.slice(0, 80),
    });
    const { raw, parsed } = await generateContent({
      prompt,
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
    });

    const article = parsed as GeneratedArticle;
    article.excerpt = normalizeExcerpt(article.excerpt ?? "");
    const result = validateArticle(article, {
      allowedInternalSlugs,
      internalLinkPrefix: `${target.blogBasePath}/`,
      moneyPages: [target.ctaPath],
    });
    if (result.ok) {
      return {
        article,
        llmModel: GEMINI_GEN_MODEL,
        llmPromptVersion: SATELLITE_PROMPT_VERSION,
        llmResponseRaw: raw,
      };
    }
    lastViolations = result.violations;
    logger.warn("Satellite article rejected by validator", {
      target: target.siteId,
      attempt,
      violations: result.violations,
    });
  }
  throw new Error(`Satellite article failed validation twice: ${lastViolations.join(" | ")}`);
}

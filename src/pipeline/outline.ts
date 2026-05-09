/**
 * Generate a structured BlogDraft outline from a winning candidate via
 * Gemini 2.5 Flash with structured-output (responseSchema) mode.
 *
 * Implements the SEO Playbook's article structure:
 *   title / titleVariants / clearAnswer / bodyOutline (markdown w/ {{INSERT_REAL_NUMBERS_HERE}})
 *   / comparisonTable / faqSection / internalLinks / ctaBlock / imagePrompt
 *
 * After Gemini returns, we resolve internalLinkSuggestions (which are
 * topic-title strings) to actual BlogPost.id values via cosine similarity.
 */
import { SchemaType } from "@google/generative-ai";
import { generateContent, embedContent, cosineSimilarity, GEMINI_GEN_MODEL } from "@/lib/gemini";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ScoredCandidate } from "./score";
import type { NicheConfig } from "@/lib/niche";

export const PROMPT_VERSION = "v1.0";

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING },
    titleVariants: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    clearAnswer: { type: SchemaType.STRING },
    bodyOutline: { type: SchemaType.STRING },
    comparisonTable: {
      type: SchemaType.OBJECT,
      properties: {
        headers: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        rows: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
      },
      required: ["headers", "rows"],
    },
    faqSection: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          q: { type: SchemaType.STRING },
          a: { type: SchemaType.STRING },
        },
        required: ["q", "a"],
      },
    },
    internalLinkSuggestions: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    ctaBlock: { type: SchemaType.STRING },
    imagePrompt: { type: SchemaType.STRING },
  },
  required: [
    "title",
    "titleVariants",
    "clearAnswer",
    "bodyOutline",
    "comparisonTable",
    "faqSection",
    "internalLinkSuggestions",
    "ctaBlock",
    "imagePrompt",
  ],
};

interface ParsedLLMOutline {
  title: string;
  titleVariants: string[];
  clearAnswer: string;
  bodyOutline: string;
  comparisonTable: { headers: string[]; rows: string[][] };
  faqSection: { q: string; a: string }[];
  internalLinkSuggestions: string[];
  ctaBlock: string;
  imagePrompt: string;
}

export interface ResolvedOutline extends Omit<ParsedLLMOutline, "internalLinkSuggestions"> {
  internalLinks: { title: string; blogPostId: string }[];
  llmModel: string;
  llmPromptVersion: string;
  llmResponseRaw: string;
}

function buildPrompt(question: string, contextSnippet: string, sourceUrl: string, niche: NicheConfig): string {
  return `You are an SEO content writer for SBA Loan Options, a brokerage that helps small business owners find funding alternatives after MCA hardship or SBA denial.

Niche focus: ${niche.displayName}
Brand voice: trustworthy, plainspoken, never salesy, examples-driven
Reference question (verbatim from a real small business owner): "${question}"
Source URL: ${sourceUrl}
Source context: ${contextSnippet || "(none)"}

Generate a draft article outline that:
1. Title — clearly mirrors the question. Avoid clickbait. 50-70 chars.
2. titleVariants — 3 alternative titles, each 50-70 chars.
3. clearAnswer — first paragraph (2-3 sentences). Direct answer to the question.
4. bodyOutline — markdown body with 4-6 H2 sections. Use bullets liberally. INSERT placeholders like "{{INSERT_REAL_NUMBERS_HERE — Joe to fill in approval amount/term}}" wherever you would otherwise need real-world specifics. DO NOT fabricate financial figures, lender names, or borrower stories. Around 600-1000 words of outline.
5. comparisonTable — 4 columns × 3-5 rows.
6. faqSection — 4-6 related Q&As with concise answers.
7. internalLinkSuggestions — 3 short topic titles for related posts (we will resolve to real blog posts).
8. ctaBlock — short markdown CTA (~50 words). Point reader at /apply or /instant-quote.
9. imagePrompt — descriptive, brand-appropriate, no people in branded clothing.

Return JSON.`;
}

async function resolveInternalLinks(
  suggestions: string[]
): Promise<{ title: string; blogPostId: string }[]> {
  // Pull every published BlogPost; embed once each
  const posts = await prisma.blogPost.findMany({
    where: { status: "published" },
    select: { id: true, title: true },
  });
  if (posts.length === 0) {
    return suggestions.map((s) => ({ title: s, blogPostId: "" }));
  }

  const postEmbeddings = await Promise.all(
    posts.map(async (p) => ({ id: p.id, title: p.title, embedding: await embedContent(p.title) }))
  );

  const out: { title: string; blogPostId: string }[] = [];
  for (const s of suggestions) {
    const sEmb = await embedContent(s);
    let bestSim = -1;
    let bestPost = postEmbeddings[0];
    for (const p of postEmbeddings) {
      const sim = cosineSimilarity(sEmb, p.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestPost = p;
      }
    }
    out.push({ title: bestPost.title, blogPostId: bestPost.id });
  }
  return out;
}

export async function generateOutline(
  winner: ScoredCandidate,
  niche: NicheConfig
): Promise<ResolvedOutline> {
  const prompt = buildPrompt(
    winner.candidate.questionText,
    winner.candidate.contextSnippet,
    winner.candidate.sourceUrl,
    niche
  );

  logger.info("Calling Gemini for outline", { question: winner.candidate.questionText.slice(0, 80) });
  const { raw, parsed } = await generateContent({
    prompt,
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0.7,
  });

  const llm = parsed as ParsedLLMOutline;

  // Sanity-check the parsed shape
  if (
    !llm.title ||
    !llm.clearAnswer ||
    !llm.bodyOutline ||
    !Array.isArray(llm.titleVariants) ||
    !Array.isArray(llm.faqSection) ||
    !Array.isArray(llm.internalLinkSuggestions) ||
    !llm.comparisonTable ||
    !llm.ctaBlock ||
    !llm.imagePrompt
  ) {
    throw new Error(`Gemini response missing required fields:\n${raw.slice(0, 800)}`);
  }

  // Resolve internal-link suggestions to real BlogPost ids
  const internalLinks = await resolveInternalLinks(llm.internalLinkSuggestions);

  return {
    title: llm.title,
    titleVariants: llm.titleVariants,
    clearAnswer: llm.clearAnswer,
    bodyOutline: llm.bodyOutline,
    comparisonTable: llm.comparisonTable,
    faqSection: llm.faqSection,
    internalLinks,
    ctaBlock: llm.ctaBlock,
    imagePrompt: llm.imagePrompt,
    llmModel: GEMINI_GEN_MODEL,
    llmPromptVersion: PROMPT_VERSION,
    llmResponseRaw: raw,
  };
}

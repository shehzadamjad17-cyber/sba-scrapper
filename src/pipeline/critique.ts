/**
 * Layer-2 quality gate: a SEPARATE Gemini call reviews the article against
 * a quality rubric and returns {score, issues}. score < CRITIQUE_THRESHOLD
 * → draft. An API failure throws; the caller fails CLOSED (draft) — a good
 * article sitting in drafts is recoverable, a bad one live is not.
 */
import { SchemaType } from "@google/generative-ai";
import { generateContent } from "@/lib/gemini";
import type { SatelliteTarget } from "@/lib/targets";

export interface CritiqueVerdict {
  score: number;
  issues: string[];
}

export const CRITIQUE_THRESHOLD = 7;

const VERDICT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    score: { type: SchemaType.NUMBER },
    issues: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ["score", "issues"],
};

function buildCritiquePrompt(a: { title: string; excerpt: string; body: string }, target: SatelliteTarget): string {
  return `You are a strict editorial reviewer for ${target.brandName}, an independent ${target.niches[0].displayName.toLowerCase()} funding desk. Review this article and score it 0-10.

Score 9-10: publish-ready, accurate, genuinely useful.
Score 7-8: minor style nits only — still publishable.
Score 0-6: DO NOT PUBLISH — has at least one real problem.

Deduct to 6 or below if ANY of these are true:
- A factual claim is stated with false precision (specific rates, limits, or statistics presented as current fact rather than hedged typical ranges).
- Any number reads as this company's own performance data ("we", "our clients") rather than an illustrative or industry-typical figure.
- The content drifts off the topic of ${target.niches.map((n) => n.displayName).join(" / ")}.
- It reads like generic AI filler: padded, repetitive, or content-free sections.
- It gives specific legal or tax advice instead of directing the reader to a professional.
- It mentions ANY company or brand as the author's affiliation other than ${target.brandName}.

Return JSON {"score": <number>, "issues": [<strings — every problem you found, empty if none>]}.

ARTICLE TITLE: ${a.title}
ARTICLE EXCERPT: ${a.excerpt}
ARTICLE BODY (markdown):
${a.body}`;
}

export async function critiqueArticle(
  a: { title: string; excerpt: string; body: string },
  target: SatelliteTarget
): Promise<CritiqueVerdict> {
  const { parsed } = await generateContent({
    prompt: buildCritiquePrompt(a, target),
    responseSchema: VERDICT_SCHEMA,
    temperature: 0.2,
  });
  const verdict = parsed as CritiqueVerdict;
  return {
    score: typeof verdict.score === "number" ? verdict.score : 0,
    issues: Array.isArray(verdict.issues) ? verdict.issues.map(String) : [],
  };
}

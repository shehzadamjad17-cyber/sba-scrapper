/**
 * Google Autocomplete question-miner (resilience backstop for the fragile
 * PAA browser scraper). Plain HTTP to suggestqueries.google.com — no
 * browser, no API key, no quota.
 *
 * For each niche: question-prefix × first 3 keywords = 12 seeds/niche.
 * Suggestions are real queries people type — high SEO signal (weight 1.2).
 */
import type { NicheConfig } from "@/lib/niche";
import type { AdapterResult, SourceAdapter, CandidateQuestion } from "./types";
import { logger } from "@/lib/logger";

const QUESTION_PREFIXES = ["how", "can", "what", "why"];
const KEYWORDS_PER_NICHE = 3;
const MIN_SUGGESTION_LENGTH = 15;

export function buildSeeds(niches: NicheConfig[]): string[] {
  const seeds: string[] = [];
  for (const niche of niches) {
    for (const kw of niche.keywords.slice(0, KEYWORDS_PER_NICHE)) {
      for (const prefix of QUESTION_PREFIXES) {
        seeds.push(`${prefix} ${kw}`);
      }
    }
  }
  return Array.from(new Set(seeds));
}

export function filterSuggestions(suggestions: string[], seed: string): string[] {
  return suggestions.filter(
    (s) =>
      s.length >= MIN_SUGGESTION_LENGTH &&
      s.toLowerCase() !== seed.toLowerCase()
  );
}

async function fetchSuggestions(seed: string): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(seed)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`autocomplete HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) && Array.isArray((data as unknown[])[1])
    ? ((data as unknown[])[1] as string[])
    : [];
}

export const autocompleteAdapter: SourceAdapter = {
  sourceType: "google_autocomplete",
  sourceWeight: 1.2,

  async fetchQuestions(niches: NicheConfig[]): Promise<AdapterResult> {
    const errors: string[] = [];
    const questions: CandidateQuestion[] = [];
    const seen = new Set<string>();

    for (const seed of buildSeeds(niches)) {
      try {
        const suggestions = filterSuggestions(await fetchSuggestions(seed), seed);
        for (const text of suggestions) {
          const key = text.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          questions.push({
            sourceType: "google_autocomplete",
            sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(text)}`,
            questionText: text,
            contextSnippet: `Google Autocomplete suggestion for seed "${seed}".`,
            engagement: 0,
            capturedAt: new Date(),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`seed "${seed}": ${msg}`);
        logger.warn("Autocomplete seed failed", { seed, error: msg });
      }
    }

    logger.info("Autocomplete complete", { captured: questions.length, errors: errors.length });
    return { questions, errors };
  },
};

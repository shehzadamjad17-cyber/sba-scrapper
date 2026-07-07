/**
 * Google "People Also Ask" question-miner — via the Firecrawl scrape API.
 *
 * History: v1 ran headless Chromium (@sparticuz/chromium-min + playwright)
 * inside the function. After fixing an AL2023 lib issue, Google's anti-bot
 * interstitial ("unusual traffic") still blocked every SERP request from
 * both datacenter and residential headless browsers. Firecrawl's stealth
 * proxy fleet gets through and returns the SERP as markdown containing the
 * "People also ask" block, so we scrape through it instead: one HTTP call
 * per seed, all seeds in parallel, no browser binary at all.
 *
 * Engagement is always 0 (PAA exposes no signal), compensated by
 * sourceWeight=1.5. Fail-soft: a failed seed logs + continues; the adapter
 * only returns empty when every seed fails.
 *
 * Cost: 12 seeds/day × 1-5 Firecrawl credits ≈ ≤1,800 credits/month.
 */
import type { NicheConfig } from "@/lib/niche";
import type { AdapterResult, SourceAdapter, CandidateQuestion } from "./types";
import { logger } from "@/lib/logger";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const PER_SEED_TIMEOUT_MS = 45_000;
const MAX_QUESTIONS_PER_SEED = 10;

/**
 * Pull the question lines out of a SERP markdown's "People also ask" block.
 *
 * Shape observed from Firecrawl (2026-07): a plain "People also ask" line,
 * then each question as its own paragraph line ending in "?", interleaved
 * with answer text and source links. We take standalone question lines
 * (not markdown links), bounded to the section (stops at "People also
 * search for" or similar follow-on blocks).
 */
export function extractPaaQuestions(markdown: string): string[] {
  const startIdx = markdown.search(/people also ask/i);
  if (startIdx === -1) return [];

  const afterStart = markdown.slice(startIdx);
  const endMatch = afterStart.search(/people also search|related searches/i);
  const section = endMatch > 0 ? afterStart.slice(0, endMatch) : afterStart;

  const out: string[] = [];
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line.endsWith("?")) continue;
    if (line.length < 9 || line.length > 200) continue;
    if (line.includes("](") || line.startsWith("[") || line.startsWith("!")) continue; // link/image lines
    if (line.startsWith("#")) continue; // headings
    out.push(line);
    if (out.length >= MAX_QUESTIONS_PER_SEED) break;
  }
  return Array.from(new Set(out));
}

async function scrapeSerpMarkdown(seed: string, apiKey: string): Promise<string> {
  const serpUrl = `https://www.google.com/search?q=${encodeURIComponent(seed)}&hl=en&gl=us`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_SEED_TIMEOUT_MS);
  try {
    const res = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: serpUrl, formats: ["markdown"], proxy: "auto" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new Error(`firecrawl HTTP ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { success?: boolean; data?: { markdown?: string }; error?: string };
    if (!json.success || typeof json.data?.markdown !== "string") {
      throw new Error(`firecrawl unsuccessful: ${json.error ?? "no markdown in response"}`);
    }
    return json.data.markdown;
  } finally {
    clearTimeout(timer);
  }
}

export const googlePaaAdapter: SourceAdapter = {
  sourceType: "google_paa",
  sourceWeight: 1.5,

  async fetchQuestions(niches: NicheConfig[]): Promise<AdapterResult> {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      logger.error("PAA adapter disabled — missing FIRECRAWL_API_KEY");
      return { questions: [], errors: ["Missing FIRECRAWL_API_KEY"] };
    }

    const seeds = niches.flatMap((n) => n.paaSeeds);
    const errors: string[] = [];
    const questions: CandidateQuestion[] = [];
    const seen = new Set<string>();

    // All seeds in parallel — well under Firecrawl's concurrency limit, and
    // wall time becomes the slowest single scrape instead of the sum.
    const results = await Promise.all(
      seeds.map(async (seed) => {
        try {
          const markdown = await scrapeSerpMarkdown(seed, apiKey);
          const paas = extractPaaQuestions(markdown);
          if (paas.length === 0) {
            // Distinguish "no PAA panel" from bot walls/format drift.
            const snippet = markdown.slice(0, 160).replace(/\s+/g, " ");
            throw new Error(`0 questions — page began: ${snippet}`);
          }
          logger.info("PAA fetched", { seed, count: paas.length });
          return { seed, paas };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`seed "${seed}": ${msg}`);
          logger.warn("PAA seed fetch failed", { seed, error: msg });
          return { seed, paas: [] as string[] };
        }
      })
    );

    for (const { seed, paas } of results) {
      for (const text of paas) {
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        questions.push({
          sourceType: "google_paa",
          sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(seed)}`,
          questionText: text,
          contextSnippet: `Seed query: "${seed}". Surfaced in Google's "People also ask" panel (via Firecrawl).`,
          engagement: 0,
          capturedAt: new Date(),
        });
      }
    }

    return { questions, errors };
  },
};

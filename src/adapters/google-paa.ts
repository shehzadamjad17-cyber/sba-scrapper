/**
 * Google "People Also Ask" question-miner.
 *
 * For each PAA seed query in niche.paaSeeds:
 *   1. Launch headless Chromium via playwright-core + @sparticuz/chromium-min
 *   2. Navigate to https://www.google.com/search?q=<seed>&hl=en&gl=us
 *   3. Wait for the PAA accordion to load
 *   4. Click each PAA item to expand its sub-questions (Google reveals more per click)
 *   5. Extract all visible question texts
 *
 * Engagement is always 0 (PAA exposes no signal), compensated by sourceWeight=1.5.
 *
 * Risks: CAPTCHA, layout changes. We fail soft — if a single seed errors, we
 * log + continue. Total adapter only fails if EVERY seed fails.
 */
import chromium from "@sparticuz/chromium-min";
import { chromium as playwrightChromium, type Browser, type Page } from "playwright-core";
import type { NicheConfig } from "@/lib/niche";
import type { AdapterResult, SourceAdapter, CandidateQuestion } from "./types";
import { logger } from "@/lib/logger";

// v149+ packs are arch-suffixed and support the nodejs22.x/24.x AL2023
// runtimes. v131 died on Vercel's Node 24 runtime with "libnss3.so: cannot
// open shared object file" — its runtime detection predated nodejs24.x, so
// the bundled NSS libs never reached LD_LIBRARY_PATH. Keep this version in
// lockstep with playwright-core's pinned chromium milestone (1.61 ↔ 149).
const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar";

async function launchBrowser(): Promise<Browser> {
  const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);
  return playwrightChromium.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
}

async function fetchPaaForSeed(page: Page, seed: string): Promise<string[]> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(seed)}&hl=en&gl=us`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

  // Wait for the People-Also-Ask container. Google's selector is unstable;
  // the most reliable signal is a div with role=heading containing a question
  // mark inside the related-questions module.
  await page.waitForTimeout(1500);

  // Grab all question texts. Google renders PAA items as expandable rows.
  // We scrape what's already visible (no clicking, to avoid bot-detection).
  const questions = await page.evaluate(() => {
    const out: string[] = [];
    // PAA items currently use [jsname="Cpkphb"] or div[role="heading"] inside the
    // related-questions module. Pull anything that looks like a question.
    const candidates = Array.from(
      document.querySelectorAll('div[role="heading"], [jsname="Cpkphb"]')
    );
    for (const el of candidates) {
      const text = (el.textContent ?? "").trim();
      if (text.length > 8 && text.length < 200 && text.includes("?")) {
        out.push(text);
      }
    }
    return Array.from(new Set(out));
  });
  return questions;
}

export const googlePaaAdapter: SourceAdapter = {
  sourceType: "google_paa",
  sourceWeight: 1.5,

  async fetchQuestions(niches: NicheConfig[]): Promise<AdapterResult> {
    const errors: string[] = [];
    const questions: CandidateQuestion[] = [];

    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });

      for (const niche of niches) {
        for (const seed of niche.paaSeeds) {
          const page = await ctx.newPage();
          try {
            const paas = await fetchPaaForSeed(page, seed);
            for (const text of paas) {
              questions.push({
                sourceType: "google_paa",
                sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(seed)}`,
                questionText: text,
                contextSnippet: `Seed query: "${seed}". Surfaced in Google's "People also ask" panel.`,
                engagement: 0,
                capturedAt: new Date(),
              });
            }
            logger.info("PAA fetched", { seed, count: paas.length });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`seed "${seed}": ${msg}`);
            logger.warn("PAA seed fetch failed", { seed, error: msg });
          } finally {
            await page.close();
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`browser launch: ${msg}`);
      logger.error("PAA browser launch failed", { error: msg });
    } finally {
      if (browser) await browser.close();
    }

    return { questions, errors };
  },
};

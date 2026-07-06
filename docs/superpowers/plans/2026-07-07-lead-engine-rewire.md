# Lead Engine Rewire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire the sba-content-scraper so every daily run produces up to 3 publish-ready, SEO/GEO-compliant draft articles in the main site's existing admin blog UI.

**Architecture:** Single-pass daily cron (Vercel Pro, ≤300s). Mine questions from 4 niches via 3-4 adapters → batch-score with Gemini → dedup (reusing embeddings) → pick top 3 → generate 3 full articles in parallel, each gated by a mechanical SEO/GEO validator → persist as `BlogPost(status="draft")` + `BlogDraft` provenance rows. No schema changes.

**Tech Stack:** Next.js 14 (route handler), TypeScript strict, Prisma 7 + libSQL/Turso, `@google/generative-ai` (gemini-2.5-flash + gemini-embedding-001), Resend, Vitest (new), playwright-core + @sparticuz/chromium-min.

**Spec:** `docs/superpowers/specs/2026-07-07-lead-engine-rewire-design.md`

## Global Constraints

- **NO Prisma schema changes, NO migrations** — prod Turso tables (`BlogDraft`, `ScraperRun`, `BlogPost`) are used exactly as they exist.
- `npm run build` must pass before every push (user rule).
- Never `prisma migrate dev` (user rule).
- Use `Array.from(new Set(...))` not spread-of-Set (user rule, TS target).
- Path alias `@/*` → `src/*` (existing tsconfig).
- All Gemini traffic goes through `src/lib/gemini.ts` primitives (key rotation + rate limiting live there).
- Fail-soft everywhere: an adapter, niche, or single article failing must never kill the run.
- Every log line goes through `logger` from `@/lib/logger` (prefixes `[scraper]`).
- Forbidden phrases in generated content (case-insensitive): "direct lender", "guaranteed approval", "100% approval", "as an AI", "I cannot".
- Cron stays `0 11 * * *`; route stays `runtime="nodejs"`, `maxDuration=300`, auth via `CRON_SECRET`.
- New env vars: `SCRAPER_AUTHOR_ID` (required), `SITE_PUBLIC_URL` (required), `DEFAULT_COVER_IMAGE` (optional fallback).

## File Structure

```
vitest.config.ts                    CREATE  — vitest + @ alias
src/lib/niche.ts                    REWRITE — NICHES[] (4 niches), NicheConfig + ctaPath/imagePool
src/lib/gemini.ts                   MODIFY  — add embedBatch(), chunk(), widen generateContent schema type
src/lib/seo-rules.ts                CREATE  — SEO_RULES_PROMPT + validateArticle()
src/adapters/types.ts               MODIFY  — fetchQuestions(niches[]), +"google_autocomplete"
src/adapters/reddit.ts              MODIFY  — loop niches
src/adapters/youtube.ts             MODIFY  — loop niches
src/adapters/google-paa.ts          MODIFY  — one browser, loop niches
src/adapters/autocomplete.ts        CREATE  — Google Autocomplete adapter
src/pipeline/score.ts               REWRITE — batched embeddings + batched intent, multi-niche argmax
src/pipeline/dedup.ts               REWRITE — reuse embeddings, include BlogPost drafts
src/pipeline/pick.ts                CREATE  — winner selection (top-3, niche cap, pairwise-distinct)
src/pipeline/article.ts             CREATE  — full-article generation + validate/retry (replaces outline.ts)
src/pipeline/outline.ts             DELETE  (in Task 12)
src/pipeline/persist.ts             REWRITE — BlogPost draft + BlogDraft provenance, slug collision, image rotation
src/pipeline/alert.ts               MODIFY  — add sendSuccessDigest()
src/cron/runDaily.ts                REWRITE — orchestrator (self-heal, mine, score, pick, parallel gen)
app/api/cron/daily/route.ts         MODIFY  — ?dryRun=1 & ?max=N params
tests/*.test.ts                     CREATE  — one file per module
package.json                        MODIFY  — vitest devDep + "test" script
```

---

### Task 1: Vitest harness

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/smoke.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm test` (= `vitest run`) used by every later task.

- [ ] **Step 1: Install vitest**

```powershell
Set-Location "C:\Users\GREEN IT 7\Desktop\Projects\sba-content-scraper"; npm install -D vitest
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
```

- [ ] **Step 3: Add script to `package.json`** — in `"scripts"` add `"test": "vitest run"` after `"dryrun"`.

- [ ] **Step 4: Write `tests/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { logger } from "@/lib/logger";

describe("harness", () => {
  it("resolves the @ alias", () => {
    expect(typeof logger.info).toBe("function");
  });
});
```

- [ ] **Step 5: Run** `npm test` — expected: 1 passed.

- [ ] **Step 6: Commit**

```powershell
git add vitest.config.ts tests/smoke.test.ts package.json package-lock.json; git commit -m "test: add vitest harness"
```

---

### Task 2: Multi-niche config

**Files:**
- Rewrite: `src/lib/niche.ts`
- Test: `tests/niche.test.ts`

**Interfaces:**
- Produces: `NICHES: NicheConfig[]` (4 entries); `NicheConfig` gains `ctaPath: string` and `imagePool: string[]`. `CURRENT_NICHE` export is REMOVED (Task 12 removes its last consumer).

- [ ] **Step 1: Write failing test `tests/niche.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { NICHES } from "@/lib/niche";

describe("NICHES", () => {
  it("has 4 niches with unique slugs", () => {
    expect(NICHES).toHaveLength(4);
    expect(new Set(NICHES.map((n) => n.slug)).size).toBe(4);
  });
  it("every niche satisfies the mining budget invariants", () => {
    for (const n of NICHES) {
      expect(n.paaSeeds).toHaveLength(3);
      expect(n.youtubeSearches.length).toBeGreaterThanOrEqual(2);
      expect(n.youtubeSearches.length).toBeLessThanOrEqual(3);
      expect(n.keywords.length).toBeGreaterThanOrEqual(8);
      expect(["/apply", "/instant-quote"]).toContain(n.ctaPath);
      expect(Array.isArray(n.imagePool)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL: `NICHES` not exported.

- [ ] **Step 3: Rewrite `src/lib/niche.ts`**

```ts
/**
 * The scraper's focus niches. Single source of truth.
 *
 * All 4 niches are mined every day; candidates are ASSIGNED to their
 * best-matching niche by embedding similarity (argmax), so these keyword
 * lists define the centroids. imagePool entries are UploadThing URLs the
 * user uploads once; empty pool falls back to DEFAULT_COVER_IMAGE env.
 */

export interface NicheConfig {
  slug: string;
  displayName: string;
  keywords: string[];
  subreddits: string[];
  paaSeeds: string[];
  youtubeSearches: string[];
  ctaPath: "/apply" | "/instant-quote";
  imagePool: string[];
}

export const NICHES: NicheConfig[] = [
  {
    slug: "mca-debt-relief",
    displayName: "MCA Debt Relief",
    keywords: [
      "merchant cash advance",
      "mca",
      "daily ach payment",
      "cash advance debt",
      "mca refinance",
      "mca consolidation",
      "mca default",
      "mca relief",
      "stop mca",
      "stuck in mca",
      "mca lawsuit",
    ],
    subreddits: ["smallbusiness", "Entrepreneur", "EntrepreneurRideAlong", "MerchantCashAdvance"],
    paaSeeds: [
      "how do I refinance MCA debt",
      "what happens after MCA default",
      "can MCA debt be consolidated",
    ],
    youtubeSearches: ["merchant cash advance horror story", "mca debt help", "stuck with daily mca payments"],
    ctaPath: "/apply",
    imagePool: [],
  },
  {
    slug: "sba-loan-denial",
    displayName: "SBA Loan Denial",
    keywords: [
      "sba loan denied",
      "sba loan denial",
      "denied sba loan",
      "sba loan declined",
      "sba denial reasons",
      "reapply sba loan",
      "sba loan alternatives",
      "business loan denied",
      "sba 7a denied",
      "loan denial letter",
    ],
    subreddits: ["smallbusiness", "Entrepreneur", "sba"],
    paaSeeds: [
      "why was my SBA loan denied",
      "what to do after SBA loan denial",
      "can I reapply after SBA denial",
    ],
    youtubeSearches: ["sba loan denied what next", "sba loan denial reasons"],
    ctaPath: "/instant-quote",
    imagePool: [],
  },
  {
    slug: "working-capital",
    displayName: "Working Capital",
    keywords: [
      "working capital loan",
      "business cash flow",
      "short term business loan",
      "bridge loan business",
      "fast business funding",
      "business funding options",
      "revenue based financing",
      "invoice factoring",
      "payroll funding",
      "emergency business loan",
    ],
    subreddits: ["smallbusiness", "Entrepreneur"],
    paaSeeds: [
      "how to get fast working capital",
      "best short term business loans",
      "what is revenue based financing",
    ],
    youtubeSearches: ["working capital loan explained", "fast business funding options"],
    ctaPath: "/instant-quote",
    imagePool: [],
  },
  {
    slug: "equipment-loc-basics",
    displayName: "Equipment & LOC Basics",
    keywords: [
      "equipment financing",
      "equipment loan",
      "heavy equipment loan",
      "business line of credit",
      "revolving credit business",
      "equipment lease vs buy",
      "line of credit vs loan",
      "equipment loan rates",
      "startup equipment financing",
      "secured line of credit",
    ],
    subreddits: ["smallbusiness", "Entrepreneur"],
    paaSeeds: [
      "how does equipment financing work",
      "business line of credit requirements",
      "equipment lease vs loan which is better",
    ],
    youtubeSearches: ["equipment financing explained", "business line of credit basics"],
    ctaPath: "/apply",
    imagePool: [],
  },
];
```

- [ ] **Step 4: Run** `npm test` — expected: niche tests PASS (other files will fail to compile only when touched later; `CURRENT_NICHE` consumers still compile because TS checks per-build, not per-test — do NOT run `npm run build` yet).

- [ ] **Step 5: Commit**

```powershell
git add src/lib/niche.ts tests/niche.test.ts; git commit -m "feat: 4-niche config with ctaPath + imagePool"
```

---

### Task 3: `embedBatch` in gemini.ts

**Files:**
- Modify: `src/lib/gemini.ts`
- Test: `tests/gemini.test.ts`

**Interfaces:**
- Produces: `chunk<T>(arr: T[], size: number): T[][]` (exported for tests); `embedBatch(texts: string[]): Promise<number[][]>` (order-preserving, ≤100 texts per API call, one rate-limit slot per call); `generateContent` now accepts `responseSchema: Record<string, unknown>` (widened so array-bearing schemas fit).

- [ ] **Step 1: Write failing test `tests/gemini.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { chunk, cosineSimilarity, centroid } from "@/lib/gemini";

describe("chunk", () => {
  it("splits into size-limited groups preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("returns [] for empty input", () => {
    expect(chunk([], 100)).toEqual([]);
  });
  it("returns one group when under limit", () => {
    expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
  });
});

describe("existing vector math (regression)", () => {
  it("cosineSimilarity of identical vectors is 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it("centroid averages", () => {
    expect(centroid([[0, 0], [2, 2]])).toEqual([1, 1]);
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL: `chunk` not exported.

- [ ] **Step 3: Implement in `src/lib/gemini.ts`** — add after the `centroid` function:

```ts
/**
 * Split an array into consecutive groups of ≤size (order preserved).
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const EMBED_BATCH_LIMIT = 100;

/**
 * Batch-embed texts via batchEmbedContents. One API request (= one
 * rate-limit slot) per 100 texts instead of one per text. Order-preserving.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (const group of chunk(texts, EMBED_BATCH_LIMIT)) {
    const av = await waitForAvailableKey();
    recordCall(av.index);
    const client = new GoogleGenerativeAI(av.key);
    const model = client.getGenerativeModel({ model: GEMINI_EMBED_MODEL });
    const res = await model.batchEmbedContents({
      requests: group.map((text) => ({
        content: { role: "user", parts: [{ text }] },
      })),
    });
    for (const e of res.embeddings) out.push(e.values);
  }
  if (out.length !== texts.length) {
    throw new Error(`embedBatch: expected ${texts.length} embeddings, got ${out.length}`);
  }
  return out;
}
```

Also **widen `generateContent`'s schema param** — replace its `opts` type:

```ts
export async function generateContent(opts: {
  prompt: string;
  responseSchema: Record<string, unknown>;
  temperature?: number;
}): Promise<{ raw: string; parsed: unknown }> {
```

(The `SchemaType` import stays — the schema literals in callers still use it. The `as any` cast where the schema is passed to the SDK already exists and still compiles.)

- [ ] **Step 4: Run** `npm test` — expected PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/gemini.ts tests/gemini.test.ts; git commit -m "feat: embedBatch (batchEmbedContents, 100/call) + widened schema type"
```

---

### Task 4: Adapter signature change (niches plural)

**Files:**
- Modify: `src/adapters/types.ts`, `src/adapters/reddit.ts`, `src/adapters/youtube.ts`, `src/adapters/google-paa.ts`

**Interfaces:**
- Produces: `SourceType = "reddit" | "google_paa" | "youtube" | "google_autocomplete"`; `SourceAdapter.fetchQuestions(niches: NicheConfig[]): Promise<AdapterResult>`. Consumed by Tasks 5, 6, 12.
- Note: `runDaily.ts` still calls the singular form after this task — it is rewritten in Task 12. `npm run build` will fail between Tasks 4 and 12; `npm test` is the gate until then. This is why Tasks 4–12 land on one branch push at the end.

- [ ] **Step 1: Update `src/adapters/types.ts`**

```ts
/**
 * Shared types between source adapters and the pipeline.
 */

import type { NicheConfig } from "@/lib/niche";

export type SourceType = "reddit" | "google_paa" | "youtube" | "google_autocomplete";

export interface CandidateQuestion {
  sourceType: SourceType;
  sourceUrl: string;             // permalink to the original
  questionText: string;          // verbatim
  contextSnippet: string;        // surrounding text for the LLM prompt
  engagement: number;            // upvotes / likes / reply count
  capturedAt: Date;
}

export interface AdapterResult {
  questions: CandidateQuestion[];
  errors: string[];              // non-fatal errors to record in adapterStats
}

export interface SourceAdapter {
  sourceType: SourceType;
  sourceWeight: number;          // 1.0 reddit, 1.5 paa, 1.2 autocomplete, 0.7 youtube
  /** Mine ALL niches in one call so heavyweight resources (e.g. the PAA browser) are shared. */
  fetchQuestions(niches: NicheConfig[]): Promise<AdapterResult>;
}
```

- [ ] **Step 2: Update `src/adapters/reddit.ts`** — change the method to iterate niches, de-duping subreddits across niches (keyword match uses the UNION of all niche keywords):

```ts
  async fetchQuestions(niches: NicheConfig[]): Promise<AdapterResult> {
    const errors: string[] = [];
    const questions: CandidateQuestion[] = [];

    let client: Snoowrap;
    try {
      client = getClient();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Reddit client init failed", { error: msg });
      return { questions: [], errors: [msg] };
    }

    const allSubreddits = Array.from(new Set(niches.flatMap((n) => n.subreddits)));
    const allKeywords = Array.from(new Set(niches.flatMap((n) => n.keywords)));

    for (const subName of allSubreddits) {
      try {
        const sub = client.getSubreddit(subName);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const posts: any[] = await sub.getNew({ limit: 100 });

        for (const p of posts) {
          const title: string = p.title ?? "";
          if (!title.includes("?")) continue;
          if (!matchesKeyword(title, allKeywords)) continue;

          questions.push({
            sourceType: "reddit",
            sourceUrl: `https://reddit.com${p.permalink}`,
            questionText: title,
            contextSnippet: (p.selftext ?? "").slice(0, 800),
            engagement: typeof p.score === "number" ? p.score : 0,
            capturedAt: new Date(),
          });
        }
        logger.info("Reddit fetched", { subreddit: subName, captured: questions.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`r/${subName}: ${msg}`);
        logger.warn("Reddit subreddit fetch failed", { subreddit: subName, error: msg });
      }
    }

    return { questions, errors };
  },
```

- [ ] **Step 3: Update `src/adapters/youtube.ts`** — same pattern. Replace the loop body of `fetchQuestions`:

```ts
  async fetchQuestions(niches: NicheConfig[]): Promise<AdapterResult> {
    const errors: string[] = [];
    const questions: CandidateQuestion[] = [];

    let yt;
    try {
      yt = getClient();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("YouTube client init failed", { error: msg });
      return { questions: [], errors: [msg] };
    }

    const allKeywords = Array.from(new Set(niches.flatMap((n) => n.keywords)));
    const allSearches = Array.from(new Set(niches.flatMap((n) => n.youtubeSearches)));

    for (const query of allSearches) {
      try {
        const searchRes = await yt.search.list({
          q: query,
          part: ["snippet"],
          type: ["video"],
          maxResults: 5,
          relevanceLanguage: "en",
          regionCode: "US",
        });
        const videos = searchRes.data.items ?? [];
        const videoIds = videos
          .map((v) => v.id?.videoId)
          .filter((id): id is string => Boolean(id));

        for (const videoId of videoIds) {
          try {
            const commentsRes = await yt.commentThreads.list({
              videoId,
              part: ["snippet"],
              maxResults: 20,
              order: "relevance",
              textFormat: "plainText",
            });
            const threads = commentsRes.data.items ?? [];

            for (const thread of threads) {
              const top = thread.snippet?.topLevelComment?.snippet;
              if (!top) continue;
              const text = (top.textDisplay ?? "").trim();
              if (!text.includes("?")) continue;
              if (!matchesKeyword(text, allKeywords)) continue;

              questions.push({
                sourceType: "youtube",
                sourceUrl: `https://www.youtube.com/watch?v=${videoId}&lc=${thread.id ?? ""}`,
                questionText: text.slice(0, 280),
                contextSnippet: text.slice(0, 800),
                engagement: typeof top.likeCount === "number" ? top.likeCount : 0,
                capturedAt: new Date(),
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`video ${videoId}: ${msg}`);
            logger.warn("YouTube comments fetch failed", { videoId, error: msg });
          }
        }
        logger.info("YouTube query processed", { query, videoCount: videoIds.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`query "${query}": ${msg}`);
        logger.warn("YouTube search failed", { query, error: msg });
      }
    }

    return { questions, errors };
  },
```

(YouTube quota: 4 niches × 2-3 searches = 9-12 searches × 100 units + ~50 commentThreads ≈ 1,250 units — 12.5% of the 10k free tier.)

- [ ] **Step 4: Update `src/adapters/google-paa.ts`** — ONE browser for all niches. Replace `fetchQuestions`:

```ts
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
```

- [ ] **Step 5: Run** `npm test` — expected: existing tests still PASS (adapters have no unit tests; they're I/O shells validated at build time in Task 12).

- [ ] **Step 6: Commit**

```powershell
git add src/adapters/; git commit -m "refactor: adapters mine all niches per call; +google_autocomplete source type"
```

---

### Task 5: Google Autocomplete adapter

**Files:**
- Create: `src/adapters/autocomplete.ts`
- Test: `tests/autocomplete.test.ts`

**Interfaces:**
- Consumes: `SourceAdapter`, `CandidateQuestion` from `./types`.
- Produces: `autocompleteAdapter: SourceAdapter` (weight 1.2); exported pure helpers `buildSeeds(niches): string[]` and `filterSuggestions(suggestions: string[], seed: string): string[]` for tests.

- [ ] **Step 1: Write failing test `tests/autocomplete.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildSeeds, filterSuggestions } from "@/adapters/autocomplete";
import { NICHES } from "@/lib/niche";

describe("buildSeeds", () => {
  it("builds prefix×keyword seeds, 12 per niche, deduped", () => {
    const seeds = buildSeeds(NICHES);
    expect(seeds.length).toBeLessThanOrEqual(NICHES.length * 12);
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(seeds).toContain("how merchant cash advance");
  });
});

describe("filterSuggestions", () => {
  it("keeps question-shaped suggestions, drops short/echo ones", () => {
    const out = filterSuggestions(
      [
        "how to get out of mca debt fast",
        "mca",                                  // too short
        "how merchant cash advance",            // pure echo of seed
        "can you consolidate merchant cash advances",
      ],
      "how merchant cash advance"
    );
    expect(out).toEqual([
      "how to get out of mca debt fast",
      "can you consolidate merchant cash advances",
    ]);
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL: module not found.

- [ ] **Step 3: Create `src/adapters/autocomplete.ts`**

```ts
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
  const data = (await res.json()) as [string, string[]];
  return Array.isArray(data[1]) ? data[1] : [];
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
```

- [ ] **Step 4: Run** `npm test` — expected PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/autocomplete.ts tests/autocomplete.test.ts; git commit -m "feat: Google Autocomplete adapter (weight 1.2, no browser)"
```

---

### Task 6: Batched scoring with niche argmax

**Files:**
- Rewrite: `src/pipeline/score.ts`
- Test: `tests/score.test.ts`

**Interfaces:**
- Consumes: `embedBatch`, `generateContent`, `cosineSimilarity`, `centroid` from `@/lib/gemini`; `NicheConfig`.
- Produces: `ScoredCandidate` now carries `embedding: number[]` and `assignedNicheSlug: string`; `scoreCandidates(candidates: CandidateQuestion[], niches: NicheConfig[]): Promise<ScoredCandidate[]>` (sorted desc by totalScore); `SOURCE_WEIGHTS` includes `google_autocomplete: 1.2`.

- [ ] **Step 1: Write failing test `tests/score.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CandidateQuestion } from "@/adapters/types";
import type { NicheConfig } from "@/lib/niche";

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return { ...actual, embedBatch: vi.fn(), generateContent: vi.fn() };
});

import { embedBatch, generateContent } from "@/lib/gemini";
import { scoreCandidates } from "@/pipeline/score";

const nicheA: NicheConfig = {
  slug: "a", displayName: "A", keywords: ["alpha"], subreddits: [],
  paaSeeds: ["x", "y", "z"], youtubeSearches: ["s1", "s2"], ctaPath: "/apply", imagePool: [],
};
const nicheB: NicheConfig = {
  slug: "b", displayName: "B", keywords: ["beta"], subreddits: [],
  paaSeeds: ["x", "y", "z"], youtubeSearches: ["s1", "s2"], ctaPath: "/instant-quote", imagePool: [],
};

function q(text: string): CandidateQuestion {
  return {
    sourceType: "google_paa", sourceUrl: "https://g", questionText: text,
    contextSnippet: "", engagement: 0, capturedAt: new Date(),
  };
}

// Unit vectors: nicheA keyword → [1,0], nicheB keyword → [0,1]
beforeEach(() => {
  vi.mocked(embedBatch).mockReset();
  vi.mocked(generateContent).mockReset();
});

describe("scoreCandidates", () => {
  it("assigns each candidate to its argmax niche and carries embedding", async () => {
    vi.mocked(embedBatch)
      .mockResolvedValueOnce([[1, 0], [0, 1]])        // keyword embeds (alpha, beta)
      .mockResolvedValueOnce([[0.9, 0.1], [0.1, 0.9]]); // candidate embeds
    vi.mocked(generateContent).mockResolvedValue({
      raw: "", parsed: { ratings: [{ index: 0, intent: 0.8 }, { index: 1, intent: 0.6 }] },
    });

    const out = await scoreCandidates([q("about alpha"), q("about beta")], [nicheA, nicheB]);
    expect(out).toHaveLength(2);
    const bySlug = Object.fromEntries(out.map((s) => [s.assignedNicheSlug, s]));
    expect(bySlug.a.candidate.questionText).toBe("about alpha");
    expect(bySlug.b.candidate.questionText).toBe("about beta");
    expect(bySlug.a.embedding).toEqual([0.9, 0.1]);
  });

  it("hard-rejects candidates below 0.3 niche match", async () => {
    vi.mocked(embedBatch)
      .mockResolvedValueOnce([[1, 0], [0, 1]])
      .mockResolvedValueOnce([[-1, 0]]); // cosine -1 vs both centroids
    const out = await scoreCandidates([q("off topic")], [nicheA, nicheB]);
    expect(out).toHaveLength(0);
    expect(generateContent).not.toHaveBeenCalled(); // no intent call for rejects
  });

  it("defaults intent 0.5 for missing/malformed ratings and sorts desc", async () => {
    vi.mocked(embedBatch)
      .mockResolvedValueOnce([[1, 0], [0, 1]])
      .mockResolvedValueOnce([[1, 0], [0.9, 0.1]]);
    vi.mocked(generateContent).mockResolvedValue({
      raw: "", parsed: { ratings: [{ index: 0, intent: 0.9 }] }, // index 1 missing
    });
    const out = await scoreCandidates([q("one"), q("two")], [nicheA, nicheB]);
    expect(out[0].intentScore).toBe(0.9);
    expect(out[1].intentScore).toBe(0.5);
    expect(out[0].totalScore).toBeGreaterThanOrEqual(out[1].totalScore);
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL (old signature).

- [ ] **Step 3: Rewrite `src/pipeline/score.ts`**

```ts
/**
 * Score each candidate question (BATCHED — the 300s fix):
 *   totalScore = nicheMatch × intentScore × sourceWeight × engagementBoost
 *
 * - nicheMatch: max cosine sim between candidate embedding and each niche's
 *   keyword-centroid; the argmax niche becomes assignedNicheSlug.
 *   Hard reject if < 0.3.
 * - intentScore: Gemini calls batched 25 questions at a time.
 * - Embeddings: ALL via embedBatch (≤100/call). Candidate embeddings are
 *   carried on ScoredCandidate so dedup/pick never re-embed.
 */
import { SchemaType } from "@google/generative-ai";
import { embedBatch, cosineSimilarity, centroid, generateContent } from "@/lib/gemini";
import type { CandidateQuestion } from "@/adapters/types";
import type { NicheConfig } from "@/lib/niche";
import { logger } from "@/lib/logger";

const NICHE_MATCH_HARD_THRESHOLD = 0.3;
const INTENT_BATCH_SIZE = 25;

export interface ScoredCandidate {
  candidate: CandidateQuestion;
  embedding: number[];
  nicheMatch: number;
  assignedNicheSlug: string;
  intentScore: number;
  sourceWeight: number;
  engagementBoost: number;
  totalScore: number;
}

export const SOURCE_WEIGHTS: Record<CandidateQuestion["sourceType"], number> = {
  reddit: 1.0,
  google_paa: 1.5,
  google_autocomplete: 1.2,
  youtube: 0.7,
};

function engagementBoost(engagement: number): number {
  return 1 + Math.min(0.3, Math.log10(Math.max(1, engagement)) / 10);
}

/** One centroid per niche; every keyword of every niche embedded in one batch. */
async function buildNicheCentroids(
  niches: NicheConfig[]
): Promise<{ slug: string; vec: number[] }[]> {
  const allKeywords = niches.flatMap((n) => n.keywords);
  const vectors = await embedBatch(allKeywords);
  const out: { slug: string; vec: number[] }[] = [];
  let offset = 0;
  for (const n of niches) {
    out.push({ slug: n.slug, vec: centroid(vectors.slice(offset, offset + n.keywords.length)) });
    offset += n.keywords.length;
  }
  return out;
}

/** Rate 0-1 purchase intent for a batch of questions in ONE Gemini call. */
async function rateIntentBatch(questions: string[]): Promise<number[]> {
  const numbered = questions.map((q, i) => `${i}. "${q}"`).join("\n");
  const { parsed } = await generateContent({
    prompt:
      `For each numbered question below, rate 0 to 1 how strongly it indicates a small business owner actively considering paying for business funding right now.\n\n` +
      `${numbered}\n\n` +
      `Return JSON: {"ratings":[{"index":<number>,"intent":<0..1>}, ...]} with one entry per question.`,
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        ratings: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              index: { type: SchemaType.NUMBER },
              intent: { type: SchemaType.NUMBER },
            },
            required: ["index", "intent"],
          },
        },
      },
      required: ["ratings"],
    },
    temperature: 0,
  });

  const scores = new Array<number>(questions.length).fill(0.5);
  const ratings = (parsed as { ratings?: { index?: number; intent?: number }[] }).ratings ?? [];
  for (const r of ratings) {
    if (
      typeof r.index === "number" &&
      typeof r.intent === "number" &&
      r.index >= 0 &&
      r.index < questions.length &&
      r.intent >= 0 &&
      r.intent <= 1
    ) {
      scores[r.index] = r.intent;
    }
  }
  return scores;
}

export async function scoreCandidates(
  candidates: CandidateQuestion[],
  niches: NicheConfig[]
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return [];

  logger.info("Building niche centroids", { nicheCount: niches.length });
  const centroids = await buildNicheCentroids(niches);

  // Embed all candidates in one batch; argmax niche; hard-reject low match
  const candidateVecs = await embedBatch(candidates.map((c) => c.questionText));
  const survivors: ScoredCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    let best = { slug: "", sim: -Infinity };
    for (const c of centroids) {
      const sim = cosineSimilarity(candidateVecs[i], c.vec);
      if (sim > best.sim) best = { slug: c.slug, sim };
    }
    if (best.sim < NICHE_MATCH_HARD_THRESHOLD) continue;
    survivors.push({
      candidate: candidates[i],
      embedding: candidateVecs[i],
      nicheMatch: best.sim,
      assignedNicheSlug: best.slug,
      intentScore: 0,
      sourceWeight: SOURCE_WEIGHTS[candidates[i].sourceType],
      engagementBoost: engagementBoost(candidates[i].engagement),
      totalScore: 0,
    });
  }
  logger.info("Survived niche-match threshold", {
    inputCount: candidates.length,
    survivors: survivors.length,
  });

  // Intent-score survivors in batches of 25
  for (let i = 0; i < survivors.length; i += INTENT_BATCH_SIZE) {
    const batch = survivors.slice(i, i + INTENT_BATCH_SIZE);
    const scores = await rateIntentBatch(batch.map((s) => s.candidate.questionText));
    batch.forEach((s, j) => {
      s.intentScore = scores[j];
      s.totalScore = s.nicheMatch * s.intentScore * s.sourceWeight * s.engagementBoost;
    });
  }

  survivors.sort((a, b) => b.totalScore - a.totalScore);
  return survivors;
}
```

- [ ] **Step 4: Run** `npm test` — expected PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/score.ts tests/score.test.ts; git commit -m "feat: batched scoring with multi-niche argmax assignment"
```

---

### Task 7: Dedup reusing embeddings

**Files:**
- Rewrite: `src/pipeline/dedup.ts`
- Test: `tests/dedup.test.ts`

**Interfaces:**
- Consumes: `ScoredCandidate` (with `.embedding`), `embedBatch`, `cosineSimilarity`, `prisma`.
- Produces: `dedupCandidates(scored: ScoredCandidate[]): Promise<ScoredCandidate[]>` — same name/return as before; now recent titles = ALL `BlogPost` created in last 60 days (drafts included) + non-rejected `BlogDraft`; candidates are NOT re-embedded.

- [ ] **Step 1: Write failing test `tests/dedup.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScoredCandidate } from "@/pipeline/score";

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return { ...actual, embedBatch: vi.fn() };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    blogPost: { findMany: vi.fn() },
    blogDraft: { findMany: vi.fn() },
  },
}));

import { embedBatch } from "@/lib/gemini";
import { prisma } from "@/lib/db";
import { dedupCandidates } from "@/pipeline/dedup";

function sc(text: string, embedding: number[]): ScoredCandidate {
  return {
    candidate: {
      sourceType: "google_paa", sourceUrl: "https://g", questionText: text,
      contextSnippet: "", engagement: 0, capturedAt: new Date(),
    },
    embedding, nicheMatch: 0.7, assignedNicheSlug: "a", intentScore: 0.8,
    sourceWeight: 1.5, engagementBoost: 1, totalScore: 0.84,
  };
}

beforeEach(() => {
  vi.mocked(embedBatch).mockReset();
  vi.mocked(prisma.blogPost.findMany).mockReset();
  vi.mocked(prisma.blogDraft.findMany).mockReset();
});

describe("dedupCandidates", () => {
  it("rejects candidates >0.8 similar to a recent title, embeds titles only", async () => {
    vi.mocked(prisma.blogPost.findMany).mockResolvedValue([{ title: "existing post" }] as never);
    vi.mocked(prisma.blogDraft.findMany).mockResolvedValue([] as never);
    vi.mocked(embedBatch).mockResolvedValue([[1, 0]]); // the one title

    const dupe = sc("near dupe", [0.99, 0.01]);
    const fresh = sc("fresh", [0, 1]);
    const out = await dedupCandidates([dupe, fresh]);

    expect(out.map((s) => s.candidate.questionText)).toEqual(["fresh"]);
    expect(embedBatch).toHaveBeenCalledTimes(1); // titles only — candidates reuse their embedding
  });

  it("returns all candidates when no recent titles", async () => {
    vi.mocked(prisma.blogPost.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.blogDraft.findMany).mockResolvedValue([] as never);
    const out = await dedupCandidates([sc("a", [1, 0])]);
    expect(out).toHaveLength(1);
    expect(embedBatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL.

- [ ] **Step 3: Rewrite `src/pipeline/dedup.ts`**

```ts
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
```

- [ ] **Step 4: Run** `npm test` — expected PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/dedup.ts tests/dedup.test.ts; git commit -m "feat: dedup reuses scoring embeddings, includes draft BlogPosts"
```

---

### Task 8: Winner selection

**Files:**
- Create: `src/pipeline/pick.ts`
- Test: `tests/pick.test.ts`

**Interfaces:**
- Consumes: `ScoredCandidate` (sorted desc), `cosineSimilarity`.
- Produces: `pickWinners(sorted: ScoredCandidate[], opts?): ScoredCandidate[]` with defaults `{ max: 3, minScore: 0.4, nicheCap: 2, simThreshold: 0.8 }`. Consumed by Task 12.

- [ ] **Step 1: Write failing test `tests/pick.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { pickWinners } from "@/pipeline/pick";
import type { ScoredCandidate } from "@/pipeline/score";

function sc(text: string, score: number, niche: string, embedding: number[]): ScoredCandidate {
  return {
    candidate: {
      sourceType: "google_paa", sourceUrl: "https://g", questionText: text,
      contextSnippet: "", engagement: 0, capturedAt: new Date(),
    },
    embedding, nicheMatch: 0.7, assignedNicheSlug: niche, intentScore: 0.8,
    sourceWeight: 1.5, engagementBoost: 1, totalScore: score,
  };
}

describe("pickWinners", () => {
  it("takes top 3 above 0.4", () => {
    const out = pickWinners([
      sc("a", 0.9, "n1", [1, 0, 0]),
      sc("b", 0.8, "n2", [0, 1, 0]),
      sc("c", 0.7, "n3", [0, 0, 1]),
      sc("d", 0.6, "n4", [1, 1, 0]),
    ]);
    expect(out.map((s) => s.candidate.questionText)).toEqual(["a", "b", "c"]);
  });

  it("stops at minScore (list is sorted desc)", () => {
    const out = pickWinners([sc("a", 0.5, "n1", [1, 0, 0]), sc("b", 0.3, "n2", [0, 1, 0])]);
    expect(out).toHaveLength(1);
  });

  it("caps 2 per niche", () => {
    const out = pickWinners([
      sc("a", 0.9, "same", [1, 0, 0]),
      sc("b", 0.8, "same", [0, 1, 0]),
      sc("c", 0.7, "same", [0, 0, 1]),
      sc("d", 0.6, "other", [1, 1, 1]),
    ]);
    expect(out.map((s) => s.assignedNicheSlug)).toEqual(["same", "same", "other"]);
  });

  it("skips same-day near-duplicates of already-picked winners", () => {
    const out = pickWinners([
      sc("a", 0.9, "n1", [1, 0, 0]),
      sc("a-dupe", 0.8, "n2", [0.99, 0.01, 0]),
      sc("b", 0.7, "n3", [0, 1, 0]),
    ]);
    expect(out.map((s) => s.candidate.questionText)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL: module not found.

- [ ] **Step 3: Create `src/pipeline/pick.ts`**

```ts
/**
 * Winner selection: walk the desc-sorted scored list taking up to `max`
 * candidates with totalScore ≥ minScore, at most nicheCap per assigned
 * niche, skipping any candidate within simThreshold cosine of an
 * already-picked winner (same-day near-dupe guard).
 */
import { cosineSimilarity } from "@/lib/gemini";
import type { ScoredCandidate } from "./score";

export interface PickOptions {
  max?: number;
  minScore?: number;
  nicheCap?: number;
  simThreshold?: number;
}

export function pickWinners(sorted: ScoredCandidate[], opts: PickOptions = {}): ScoredCandidate[] {
  const { max = 3, minScore = 0.4, nicheCap = 2, simThreshold = 0.8 } = opts;
  const picked: ScoredCandidate[] = [];
  const nicheCounts = new Map<string, number>();

  for (const c of sorted) {
    if (picked.length >= max) break;
    if (c.totalScore < minScore) break; // sorted desc — nothing below qualifies
    if ((nicheCounts.get(c.assignedNicheSlug) ?? 0) >= nicheCap) continue;
    if (picked.some((p) => cosineSimilarity(p.embedding, c.embedding) > simThreshold)) continue;
    picked.push(c);
    nicheCounts.set(c.assignedNicheSlug, (nicheCounts.get(c.assignedNicheSlug) ?? 0) + 1);
  }
  return picked;
}
```

- [ ] **Step 4: Run** `npm test` — expected PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/pick.ts tests/pick.test.ts; git commit -m "feat: winner selection (top-3, niche cap, pairwise-distinct)"
```

---

### Task 9: SEO/GEO rules engine

**Files:**
- Create: `src/lib/seo-rules.ts`
- Test: `tests/seo-rules.test.ts`

**Interfaces:**
- Produces: `GeneratedArticle { slug; title; excerpt; body }`; `SEO_RULES_PROMPT: string`; `validateArticle(a: GeneratedArticle, opts: { allowedInternalSlugs: string[] }): { ok: boolean; violations: string[] }`. Consumed by Task 10.

- [ ] **Step 1: Write failing test `tests/seo-rules.test.ts`** — build one VALID fixture, then break one rule per test:

```ts
import { describe, it, expect } from "vitest";
import { validateArticle, type GeneratedArticle } from "@/lib/seo-rules";

const para = (s: string) => `${s} This sentence pads the word count with plain useful language for small business owners weighing their funding options carefully today.`;
const filler = Array.from({ length: 30 }, (_, i) => para(`Filler paragraph number ${i + 1} explains one practical funding consideration in plainspoken terms.`)).join("\n\n");

function validBody(): string {
  return [
    "If your SBA loan was denied, you can usually reapply after 90 days once the underlying issue is fixed.",
    "## Why SBA loans get denied",
    para("Lenders decline applications for a handful of recurring reasons."),
    "See our guide on [reapplying](/blog/reapply-guide) and [credit repair](/blog/credit-repair).",
    "## What the denial letter tells you",
    para("Your denial letter names the specific reason."),
    "## Alternatives while you wait",
    para("Several funding routes stay open after a denial."),
    "| Option | Speed | Typical range |\n|---|---|---|\n| Line of credit | Fast | Small to medium |\n| Equipment loan | Medium | Asset-based |",
    "## How to strengthen a reapplication",
    para("Fix the named issue before anything else."),
    filler,
    "Ready to see your options? [Get pre-qualified](/apply) in minutes.",
    "Official guidance is at [sba.gov](https://www.sba.gov/funding-programs/loans).",
    "## FAQ",
    "### Can I reapply after an SBA denial?",
    "Yes. Most lenders accept reapplications after 90 days once the cited issue is resolved.",
    "### Does a denial hurt my credit?",
    "The application inquiry may appear, but the denial itself is not reported as a negative event.",
    "### How long should I wait to reapply?",
    "Ninety days is the common minimum, but waiting until the root cause is fixed matters more.",
    "### Are there alternatives to reapplying?",
    "Yes — lines of credit, equipment financing, and revenue-based options remain available.",
  ].join("\n\n");
}

function valid(): GeneratedArticle {
  return {
    slug: "sba-loan-denied-reapply",
    title: "SBA Loan Denied? When and How to Reapply",
    excerpt:
      "Denied an SBA loan? Learn the common denial reasons, what your letter means, and the fastest path to reapproval or an alternative.",
    body: validBody(),
  };
}

const OPTS = { allowedInternalSlugs: ["reapply-guide", "credit-repair"] };

describe("validateArticle", () => {
  it("passes a fully compliant article", () => {
    const r = validateArticle(valid(), OPTS);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  const cases: [string, (a: GeneratedArticle) => void, string][] = [
    ["long title", (a) => (a.title = "x".repeat(61)), "title"],
    ["bad slug", (a) => (a.slug = "Bad Slug!"), "slug"],
    ["short excerpt", (a) => (a.excerpt = "too short"), "excerpt"],
    ["H1 in body", (a) => (a.body = "# Top\n\n" + a.body), "H1"],
    ["missing FAQ", (a) => (a.body = a.body.replace("## FAQ", "## Questions")), "FAQ"],
    ["no table", (a) => (a.body = a.body.replace(/\|.*\n?/g, "")), "table"],
    ["hallucinated internal link", (a) => (a.body = a.body.replace("/blog/reapply-guide", "/blog/made-up")), "internal"],
    ["no money link", (a) => (a.body = a.body.replace("(/apply)", "(/blog/credit-repair)")), "money"],
    ["disallowed external domain", (a) => (a.body = a.body.replace("https://www.sba.gov/funding-programs/loans", "https://evil.example.com")), "external"],
    ["MDX braces", (a) => (a.body += "\n\n{{bad}}"), "MDX"],
    ["raw HTML", (a) => (a.body += "\n\n<div>hi</div>"), "MDX"],
    ["forbidden phrase", (a) => (a.body += "\n\nWe are a direct lender."), "forbidden"],
  ];

  for (const [name, mutate, keyword] of cases) {
    it(`fails on ${name}`, () => {
      const a = valid();
      mutate(a);
      const r = validateArticle(a, OPTS);
      expect(r.ok).toBe(false);
      expect(r.violations.join(" ")).toMatch(new RegExp(keyword, "i"));
    });
  }

  it("fails when word count is out of range", () => {
    const a = valid();
    a.body = a.body.split(/\s+/).slice(0, 400).join(" ") + "\n\n## FAQ\n\n### Q one?\n\nA.\n\n### Q two?\n\nA.\n\n### Q three?\n\nA.\n\n### Q four?\n\nA.";
    const r = validateArticle(a, OPTS);
    expect(r.violations.join(" ")).toMatch(/word count/i);
  });

  it("empty menu: internal links become forbidden instead of required", () => {
    const withLinks = validateArticle(valid(), { allowedInternalSlugs: [] });
    expect(withLinks.violations.join(" ")).toMatch(/internal links not allowed/i);

    const a = valid();
    a.body = a.body
      .replace("[reapplying](/blog/reapply-guide)", "reapplying")
      .replace("[credit repair](/blog/credit-repair)", "credit repair");
    const noLinks = validateArticle(a, { allowedInternalSlugs: [] });
    expect(noLinks.violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL: module not found.

- [ ] **Step 3: Create `src/lib/seo-rules.ts`**

```ts
/**
 * SEO/GEO rules engine.
 *
 * SEO_RULES_PROMPT is injected into every article-generation prompt.
 * validateArticle() mechanically enforces every checkable rule BEFORE
 * anything is written to the DB — an article that fails twice is skipped.
 *
 * The FAQ format rules mirror the main site's extractor exactly
 * (src/app/blog/[slug]/page.tsx extractFaqs): `## FAQ` heading, then
 * `### Question?` subheadings each followed by answer paragraphs — this is
 * what turns into FAQPage JSON-LD automatically.
 */

export interface GeneratedArticle {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
}

export const MONEY_PAGES = ["/apply", "/instant-quote", "/sba-loan-calculator"];
export const EXTERNAL_ALLOWLIST = ["sba.gov", "federalreserve.gov", "irs.gov"];
export const FORBIDDEN_PHRASES = [
  "direct lender",
  "guaranteed approval",
  "100% approval",
  "as an ai",
  "i cannot",
];

const WORD_MIN = 1200;
const WORD_MAX = 1800;

export const SEO_RULES_PROMPT = `
STRICT CONTENT RULES (violations cause automatic rejection):

Metadata
- title: mirrors the reader's question, ≤60 characters, no clickbait.
- slug: lowercase kebab-case, primary keyword, no stopwords, ≤60 characters.
- excerpt: 120-155 characters; primary keyword + a concrete benefit (used as the meta description).

Structure (GEO/AEO)
- Open with 2-3 sentences that DIRECTLY and completely answer the question. No heading before it, no throat-clearing.
- NO H1 headings anywhere (the site renders the H1). Use exactly 4-6 content H2 sections (##).
- Each H2 section opens with one self-contained factual sentence that makes sense quoted out of context.
- Include exactly one markdown comparison table (relevant options/tradeoffs).
- End sections with a "## FAQ" heading containing 4-6 "### <question>?" subheadings, each followed by a 1-3 sentence answer paragraph.
- 1,200-1,800 words total. Short paragraphs (≤3 sentences). Use bullet lists. Bold key phrases sparingly.
- Define niche jargon on first use. Write at an 8th-grade reading level.

Links
- Link 2-4 of the provided internal articles inline where genuinely relevant, format [anchor text](/blog/<slug>). ONLY use slugs from the provided list.
- Include at least one call-to-action link to the provided CTA path.
- At most 2 external links, ONLY to: sba.gov, federalreserve.gov, irs.gov.

Voice & compliance
- Written by Joseph Snado, founder of SBA Loan Options: plainspoken, trustworthy, never salesy.
- NEVER fabricate statistics, dollar figures, rates, lender names, borrower stories, or testimonials. Use ranges and qualitative statements ("often", "typically", "can range widely").
- NEVER write: "direct lender", "guaranteed approval", "100% approval", or anything implying certainty of funding.
- Markdown only. NO curly braces { }, NO raw HTML tags, NO placeholders of any kind — the output must be publish-ready.
`.trim();

export function validateArticle(
  a: GeneratedArticle,
  opts: { allowedInternalSlugs: string[] }
): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  const body = a.body ?? "";

  // --- metadata ---
  if (!a.title || a.title.length > 60) v.push(`title must be 1-60 chars (got ${a.title?.length ?? 0})`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.slug ?? "") || (a.slug ?? "").length > 60)
    v.push(`slug must be kebab-case ≤60 chars (got "${a.slug}")`);
  if (!a.excerpt || a.excerpt.length < 120 || a.excerpt.length > 155)
    v.push(`excerpt must be 120-155 chars (got ${a.excerpt?.length ?? 0})`);

  // --- word count ---
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < WORD_MIN || words > WORD_MAX) v.push(`word count must be ${WORD_MIN}-${WORD_MAX} (got ${words})`);

  // --- headings ---
  if (/^#\s/m.test(body)) v.push("body must not contain H1 headings");
  const h2s = Array.from(body.matchAll(/^##\s+(.+)$/gm)).map((m) => m[1].trim());
  const contentH2s = h2s.filter((h) => h.toUpperCase() !== "FAQ");
  if (contentH2s.length < 4 || contentH2s.length > 6)
    v.push(`must have 4-6 content H2 sections (got ${contentH2s.length})`);

  // --- FAQ block (must match the site extractor) ---
  const faqMatch = body.match(/^##\s+FAQ\s*$/im);
  if (!faqMatch) {
    v.push("missing '## FAQ' section");
  } else {
    const after = body.slice(body.indexOf(faqMatch[0]) + faqMatch[0].length);
    const nextH2 = after.search(/\n##\s+\S/);
    const faqSection = nextH2 === -1 ? after : after.slice(0, nextH2);
    const entries = faqSection.split(/\n###\s+/).slice(1);
    if (entries.length < 4 || entries.length > 6) v.push(`FAQ must have 4-6 entries (got ${entries.length})`);
    for (const e of entries) {
      const lineBreak = e.indexOf("\n");
      const q = lineBreak === -1 ? e.trim() : e.slice(0, lineBreak).trim();
      const answer = lineBreak === -1 ? "" : e.slice(lineBreak).trim();
      if (!q.endsWith("?")) v.push(`FAQ question must end with '?': "${q.slice(0, 60)}"`);
      if (!answer) v.push(`FAQ entry has no answer: "${q.slice(0, 60)}"`);
    }
  }

  // --- table ---
  if (!/\|\s*-{3,}/.test(body)) v.push("missing markdown comparison table");

  // --- links ---
  const links = Array.from(body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)).map((m) => m[1]);
  const internal = links.filter((u) => u.startsWith("/blog/"));
  if (opts.allowedInternalSlugs.length === 0) {
    // No published posts to link to — ANY internal link is a hallucination.
    if (internal.length > 0) v.push(`internal links not allowed when no published posts exist (got ${internal.length})`);
  } else {
    if (internal.length < 2 || internal.length > 4)
      v.push(`must have 2-4 internal /blog/ links (got ${internal.length})`);
    const allowed = new Set(opts.allowedInternalSlugs);
    for (const u of internal) {
      const slug = u.replace("/blog/", "").replace(/[#?].*$/, "");
      if (!allowed.has(slug)) v.push(`internal link to unknown slug "${slug}" (hallucinated?)`);
    }
  }
  if (!links.some((u) => MONEY_PAGES.some((m) => u === m || u.startsWith(`${m}?`))))
    v.push(`missing money-page link (one of: ${MONEY_PAGES.join(", ")})`);
  const external = links.filter((u) => /^https?:\/\//i.test(u));
  if (external.length > 2) v.push(`at most 2 external links (got ${external.length})`);
  for (const u of external) {
    let host = "";
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      v.push(`unparseable external URL "${u}"`);
      continue;
    }
    if (!EXTERNAL_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`)))
      v.push(`external link to non-allowlisted domain "${host}"`);
  }

  // --- MDX safety ---
  if (/[{}]/.test(body)) v.push("MDX-unsafe: body contains { or }");
  if (/<[a-zA-Z!/]/.test(body)) v.push("MDX-unsafe: body contains raw HTML tags");

  // --- forbidden phrases (title + excerpt + body) ---
  const haystack = `${a.title}\n${a.excerpt}\n${body}`.toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (haystack.includes(phrase)) v.push(`forbidden phrase: "${phrase}"`);
  }

  return { ok: v.length === 0, violations: v };
}
```

- [ ] **Step 4: Run** `npm test` — expected PASS. If the valid fixture trips word count, adjust the filler count (30 × ~24 words ≈ 720 + rest ≈ 1,300 — in range).

- [ ] **Step 5: Commit**

```powershell
git add src/lib/seo-rules.ts tests/seo-rules.test.ts; git commit -m "feat: SEO/GEO rules engine — prompt block + mechanical validator"
```

---

### Task 10: Full-article generation

**Files:**
- Create: `src/pipeline/article.ts`
- Test: `tests/article.test.ts`

**Interfaces:**
- Consumes: `generateContent`, `embedBatch`, `cosineSimilarity` from `@/lib/gemini`; `prisma`; `SEO_RULES_PROMPT`, `validateArticle`, `GeneratedArticle` from `@/lib/seo-rules`; `ScoredCandidate`; `NicheConfig`.
- Produces:
  - `PROMPT_VERSION = "v2.0"`
  - `LinkMenuItem { title: string; slug: string }`
  - `buildLinkMenu(winnerEmbedding: number[]): Promise<LinkMenuItem[]>` — top 8 relevant published posts
  - `buildArticlePrompt(winner, niche, menu): string` (exported for tests)
  - `generateArticle(winner: ScoredCandidate, niche: NicheConfig, menu: LinkMenuItem[]): Promise<ArticleGenResult>` where `ArticleGenResult { article: GeneratedArticle; llmModel: string; llmPromptVersion: string; llmResponseRaw: string }` — validates, retries ONCE with violations appended, throws `Error` on second failure.

- [ ] **Step 1: Write failing test `tests/article.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScoredCandidate } from "@/pipeline/score";
import { NICHES } from "@/lib/niche";

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return { ...actual, generateContent: vi.fn(), embedBatch: vi.fn() };
});
vi.mock("@/lib/db", () => ({ prisma: { blogPost: { findMany: vi.fn() } } }));
vi.mock("@/lib/seo-rules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seo-rules")>();
  return { ...actual, validateArticle: vi.fn() };
});

import { generateContent } from "@/lib/gemini";
import { validateArticle } from "@/lib/seo-rules";
import { generateArticle, buildArticlePrompt } from "@/pipeline/article";

const winner: ScoredCandidate = {
  candidate: {
    sourceType: "google_paa", sourceUrl: "https://g",
    questionText: "can I reapply after SBA denial", contextSnippet: "ctx",
    engagement: 0, capturedAt: new Date(),
  },
  embedding: [1, 0], nicheMatch: 0.7, assignedNicheSlug: "sba-loan-denial",
  intentScore: 0.8, sourceWeight: 1.5, engagementBoost: 1, totalScore: 0.84,
};
const niche = NICHES.find((n) => n.slug === "sba-loan-denial")!;
const menu = [{ title: "Reapply Guide", slug: "reapply-guide" }];
const fakeArticle = { slug: "s", title: "t", excerpt: "e", body: "b" };

beforeEach(() => {
  vi.mocked(generateContent).mockReset();
  vi.mocked(validateArticle).mockReset();
});

describe("buildArticlePrompt", () => {
  it("includes question, rules, CTA path, and the link menu", () => {
    const p = buildArticlePrompt(winner, niche, menu);
    expect(p).toContain("can I reapply after SBA denial");
    expect(p).toContain("STRICT CONTENT RULES");
    expect(p).toContain("/instant-quote");
    expect(p).toContain("/blog/reapply-guide");
  });
});

describe("generateArticle", () => {
  it("returns on first-try valid article", async () => {
    vi.mocked(generateContent).mockResolvedValue({ raw: "raw1", parsed: fakeArticle });
    vi.mocked(validateArticle).mockReturnValue({ ok: true, violations: [] });
    const out = await generateArticle(winner, niche, menu);
    expect(out.article).toEqual(fakeArticle);
    expect(out.llmPromptVersion).toBe("v2.0");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("retries once with violations fed back, then succeeds", async () => {
    vi.mocked(generateContent)
      .mockResolvedValueOnce({ raw: "raw1", parsed: fakeArticle })
      .mockResolvedValueOnce({ raw: "raw2", parsed: fakeArticle });
    vi.mocked(validateArticle)
      .mockReturnValueOnce({ ok: false, violations: ["missing '## FAQ' section"] })
      .mockReturnValueOnce({ ok: true, violations: [] });
    const out = await generateArticle(winner, niche, menu);
    expect(generateContent).toHaveBeenCalledTimes(2);
    const retryPrompt = vi.mocked(generateContent).mock.calls[1][0].prompt;
    expect(retryPrompt).toContain("missing '## FAQ' section");
    expect(out.llmResponseRaw).toBe("raw2");
  });

  it("throws after two invalid attempts", async () => {
    vi.mocked(generateContent).mockResolvedValue({ raw: "raw", parsed: fakeArticle });
    vi.mocked(validateArticle).mockReturnValue({ ok: false, violations: ["word count must be 1200-1800 (got 5)"] });
    await expect(generateArticle(winner, niche, menu)).rejects.toThrow(/word count/);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL: module not found.

- [ ] **Step 3: Create `src/pipeline/article.ts`**

```ts
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
```

- [ ] **Step 4: Run** `npm test` — expected PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/article.ts tests/article.test.ts; git commit -m "feat: full-article generation with validate/retry gate"
```

---

### Task 11: Persistence — BlogPost draft + BlogDraft provenance

**Files:**
- Rewrite: `src/pipeline/persist.ts`
- Test: `tests/persist.test.ts`

**Interfaces:**
- Consumes: `prisma`; `ScoredCandidate`; `ArticleGenResult`; `NicheConfig`.
- Produces: `persistArticle(opts: { winner: ScoredCandidate; gen: ArticleGenResult; niche: NicheConfig }): Promise<{ blogPostId: string; blogDraftId: string; slug: string }>`. Throws if `SCRAPER_AUTHOR_ID` missing or no cover image resolvable. Does NOT touch `ScraperRun` (orchestrator owns that now).

- [ ] **Step 1: Write failing test `tests/persist.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScoredCandidate } from "@/pipeline/score";
import type { ArticleGenResult } from "@/pipeline/article";
import { NICHES } from "@/lib/niche";

vi.mock("@/lib/db", () => ({
  prisma: {
    blogPost: { findUnique: vi.fn(), create: vi.fn() },
    blogDraft: { count: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { persistArticle } from "@/pipeline/persist";

const winner: ScoredCandidate = {
  candidate: {
    sourceType: "google_paa", sourceUrl: "https://g", questionText: "q?",
    contextSnippet: "", engagement: 0, capturedAt: new Date(),
  },
  embedding: [1], nicheMatch: 0.7, assignedNicheSlug: "mca-debt-relief",
  intentScore: 0.8, sourceWeight: 1.5, engagementBoost: 1, totalScore: 0.84,
};
const gen: ArticleGenResult = {
  article: {
    slug: "my-article", title: "T", excerpt: "E",
    body: "First paragraph answer.\n\n## Section\n\nMore.",
  },
  llmModel: "gemini-2.5-flash", llmPromptVersion: "v2.0", llmResponseRaw: "{}",
};
const niche = { ...NICHES[0], imagePool: ["https://img/1.png", "https://img/2.png"] };

beforeEach(() => {
  vi.mocked(prisma.blogPost.findUnique).mockReset().mockResolvedValue(null as never);
  vi.mocked(prisma.blogPost.create).mockReset().mockResolvedValue({ id: "post1" } as never);
  vi.mocked(prisma.blogDraft.count).mockReset().mockResolvedValue(0 as never);
  vi.mocked(prisma.blogDraft.create).mockReset().mockResolvedValue({ id: "draft1" } as never);
  process.env.SCRAPER_AUTHOR_ID = "admin1";
  delete process.env.DEFAULT_COVER_IMAGE;
});

describe("persistArticle", () => {
  it("creates BlogPost draft + BlogDraft provenance and links them", async () => {
    const out = await persistArticle({ winner, gen, niche });
    expect(out).toEqual({ blogPostId: "post1", blogDraftId: "draft1", slug: "my-article" });

    const postArgs = vi.mocked(prisma.blogPost.create).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(postArgs.data.status).toBe("draft");
    expect(postArgs.data.authorId).toBe("admin1");
    expect(postArgs.data.coverImage).toBe("https://img/1.png");

    const draftArgs = vi.mocked(prisma.blogDraft.create).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(draftArgs.data.status).toBe("promoted");
    expect(draftArgs.data.promotedToPostId).toBe("post1");
    expect(draftArgs.data.clearAnswer).toBe("First paragraph answer.");
    expect(draftArgs.data.bodyOutline).toBe(gen.article.body);
  });

  it("suffixes slug on collision", async () => {
    vi.mocked(prisma.blogPost.findUnique)
      .mockResolvedValueOnce({ id: "x" } as never)   // my-article taken
      .mockResolvedValueOnce({ id: "y" } as never)   // my-article-2 taken
      .mockResolvedValueOnce(null as never);          // my-article-3 free
    const out = await persistArticle({ winner, gen, niche });
    expect(out.slug).toBe("my-article-3");
  });

  it("rotates cover image by existing draft count", async () => {
    vi.mocked(prisma.blogDraft.count).mockResolvedValue(3 as never); // 3 % 2 = 1
    await persistArticle({ winner, gen, niche });
    const postArgs = vi.mocked(prisma.blogPost.create).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(postArgs.data.coverImage).toBe("https://img/2.png");
  });

  it("falls back to DEFAULT_COVER_IMAGE for empty pool, throws if neither", async () => {
    const bare = { ...niche, imagePool: [] };
    process.env.DEFAULT_COVER_IMAGE = "https://img/default.png";
    await persistArticle({ winner, gen, niche: bare });
    const postArgs = vi.mocked(prisma.blogPost.create).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(postArgs.data.coverImage).toBe("https://img/default.png");

    delete process.env.DEFAULT_COVER_IMAGE;
    await expect(persistArticle({ winner, gen, niche: bare })).rejects.toThrow(/cover image/i);
  });

  it("throws when SCRAPER_AUTHOR_ID missing", async () => {
    delete process.env.SCRAPER_AUTHOR_ID;
    await expect(persistArticle({ winner, gen, niche })).rejects.toThrow(/SCRAPER_AUTHOR_ID/);
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL.

- [ ] **Step 3: Rewrite `src/pipeline/persist.ts`**

```ts
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
```

- [ ] **Step 4: Run** `npm test` — expected PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/persist.ts tests/persist.test.ts; git commit -m "feat: persist article as BlogPost draft + BlogDraft provenance"
```

---

### Task 12: Success digest, orchestrator rewrite, route params

**Files:**
- Modify: `src/pipeline/alert.ts` (add digest)
- Rewrite: `src/cron/runDaily.ts`
- Modify: `app/api/cron/daily/route.ts`
- Delete: `src/pipeline/outline.ts`
- Test: `tests/alert.test.ts`, `tests/runDaily.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-11.
- Produces:
  - `buildDigestHtml(articles: DigestArticle[]): string` and `sendSuccessDigest(articles: DigestArticle[]): Promise<void>` where `DigestArticle { title: string; niche: string; totalScore: number; blogPostId: string; slug: string }`
  - `runDaily(opts?: { dryRun?: boolean; max?: number }): Promise<RunResult>` with `RunResult { scraperRunId: string; status: "succeeded" | "no_question_picked" | "failed"; articles: { blogPostId: string; blogDraftId: string; slug: string; niche: string }[]; errorMessage?: string }`
  - Route accepts `?dryRun=1` and `?max=N` (clamped 1-3).

- [ ] **Step 1: Write failing test `tests/alert.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildDigestHtml } from "@/pipeline/alert";

beforeEach(() => {
  process.env.SITE_PUBLIC_URL = "https://www.example.com";
});

describe("buildDigestHtml", () => {
  it("renders one row per article with edit + preview links", () => {
    const html = buildDigestHtml([
      { title: "Post A", niche: "MCA Debt Relief", totalScore: 0.81, blogPostId: "p1", slug: "post-a" },
      { title: "Post B", niche: "Working Capital", totalScore: 0.62, blogPostId: "p2", slug: "post-b" },
    ]);
    expect(html).toContain("Post A");
    expect(html).toContain("https://www.example.com/admin/blog/p1/edit");
    expect(html).toContain("https://www.example.com/blog/post-b?preview=1");
    expect(html).toContain("0.81");
  });

  it("escapes HTML in titles", () => {
    const html = buildDigestHtml([
      { title: "<script>x</script>", niche: "N", totalScore: 0.5, blogPostId: "p", slug: "s" },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected FAIL.

- [ ] **Step 3: Add to `src/pipeline/alert.ts`** (keep `sendFailureAlert` and `escapeHtml` as-is; append):

```ts
export interface DigestArticle {
  title: string;
  niche: string;
  totalScore: number;
  blogPostId: string;
  slug: string;
}

export function buildDigestHtml(articles: DigestArticle[]): string {
  const base = (process.env.SITE_PUBLIC_URL ?? "").replace(/\/$/, "");
  const rows = articles
    .map(
      (a) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">
          <strong>${escapeHtml(a.title)}</strong><br/>
          <span style="color:#666;font-size:12px;">${escapeHtml(a.niche)} · score ${a.totalScore.toFixed(2)}</span>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;">
          <a href="${base}/admin/blog/${a.blogPostId}/edit">Review &amp; publish</a><br/>
          <a href="${base}/blog/${a.slug}?preview=1" style="font-size:12px;">Preview</a>
        </td>
      </tr>`
    )
    .join("");
  return `
    <p>The scraper created <strong>${articles.length}</strong> draft article(s) ready for review:</p>
    <table style="border-collapse:collapse;width:100%;">${rows}</table>
    <p style="color:#666;font-size:12px;">Review each draft, adjust anything you like, and click Publish.</p>
  `;
}

export async function sendSuccessDigest(articles: DigestArticle[]): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.SCRAPER_ALERT_EMAIL;
  if (!apiKey || !to) {
    logger.warn("Cannot send success digest — missing RESEND_API_KEY or SCRAPER_ALERT_EMAIL");
    return;
  }
  const resend = new Resend(apiKey);
  try {
    await resend.emails.send({
      from: "SBA Content Scraper <noreply@sbaloanoptions.com>",
      to,
      subject: `[scraper] ${articles.length} draft(s) ready for review`,
      html: buildDigestHtml(articles),
    });
    logger.info("Success digest sent", { to, count: articles.length });
  } catch (err) {
    logger.error("Failed to send success digest", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

- [ ] **Step 4: Write failing test `tests/runDaily.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScoredCandidate } from "@/pipeline/score";

vi.mock("@/lib/db", () => ({
  prisma: {
    scraperRun: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("@/adapters/reddit", () => ({ redditAdapter: { sourceType: "reddit", sourceWeight: 1, fetchQuestions: vi.fn() } }));
vi.mock("@/adapters/google-paa", () => ({ googlePaaAdapter: { sourceType: "google_paa", sourceWeight: 1.5, fetchQuestions: vi.fn() } }));
vi.mock("@/adapters/youtube", () => ({ youtubeAdapter: { sourceType: "youtube", sourceWeight: 0.7, fetchQuestions: vi.fn() } }));
vi.mock("@/adapters/autocomplete", () => ({ autocompleteAdapter: { sourceType: "google_autocomplete", sourceWeight: 1.2, fetchQuestions: vi.fn() } }));
vi.mock("@/pipeline/score", () => ({ scoreCandidates: vi.fn() }));
vi.mock("@/pipeline/dedup", () => ({ dedupCandidates: vi.fn() }));
vi.mock("@/pipeline/pick", () => ({ pickWinners: vi.fn() }));
vi.mock("@/pipeline/article", () => ({ buildLinkMenu: vi.fn(), generateArticle: vi.fn() }));
vi.mock("@/pipeline/persist", () => ({ persistArticle: vi.fn() }));
vi.mock("@/pipeline/alert", () => ({ sendFailureAlert: vi.fn(), sendSuccessDigest: vi.fn() }));

import { prisma } from "@/lib/db";
import { googlePaaAdapter } from "@/adapters/google-paa";
import { autocompleteAdapter } from "@/adapters/autocomplete";
import { youtubeAdapter } from "@/adapters/youtube";
import { scoreCandidates } from "@/pipeline/score";
import { dedupCandidates } from "@/pipeline/dedup";
import { pickWinners } from "@/pipeline/pick";
import { buildLinkMenu, generateArticle } from "@/pipeline/article";
import { persistArticle } from "@/pipeline/persist";
import { sendSuccessDigest, sendFailureAlert } from "@/pipeline/alert";
import { runDaily } from "@/cron/runDaily";

function sc(text: string, niche: string): ScoredCandidate {
  return {
    candidate: {
      sourceType: "google_paa", sourceUrl: "https://g", questionText: text,
      contextSnippet: "", engagement: 0, capturedAt: new Date(),
    },
    embedding: [1], nicheMatch: 0.7, assignedNicheSlug: niche,
    intentScore: 0.8, sourceWeight: 1.5, engagementBoost: 1, totalScore: 0.84,
  };
}
const q = { sourceType: "google_paa" as const, sourceUrl: "u", questionText: "t?", contextSnippet: "", engagement: 0, capturedAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.scraperRun.create).mockResolvedValue({ id: "run1" } as never);
  vi.mocked(prisma.scraperRun.update).mockResolvedValue({} as never);
  vi.mocked(prisma.scraperRun.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(googlePaaAdapter.fetchQuestions).mockResolvedValue({ questions: [q], errors: [] });
  vi.mocked(autocompleteAdapter.fetchQuestions).mockResolvedValue({ questions: [], errors: [] });
  vi.mocked(youtubeAdapter.fetchQuestions).mockResolvedValue({ questions: [], errors: [] });
  vi.mocked(buildLinkMenu).mockResolvedValue([]);
  delete process.env.REDDIT_CLIENT_ID;
});

describe("runDaily", () => {
  it("self-heals orphaned running rows at start", async () => {
    vi.mocked(scoreCandidates).mockResolvedValue([]);
    vi.mocked(dedupCandidates).mockResolvedValue([]);
    vi.mocked(pickWinners).mockReturnValue([]);
    await runDaily();
    expect(prisma.scraperRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running" }),
        data: expect.objectContaining({ status: "failed" }),
      })
    );
  });

  it("persists every winner, sends digest, returns succeeded", async () => {
    const winners = [sc("w1", "mca-debt-relief"), sc("w2", "sba-loan-denial")];
    vi.mocked(scoreCandidates).mockResolvedValue(winners);
    vi.mocked(dedupCandidates).mockResolvedValue(winners);
    vi.mocked(pickWinners).mockReturnValue(winners);
    vi.mocked(generateArticle).mockResolvedValue({
      article: { slug: "s", title: "T", excerpt: "E", body: "B" },
      llmModel: "m", llmPromptVersion: "v2.0", llmResponseRaw: "{}",
    });
    vi.mocked(persistArticle)
      .mockResolvedValueOnce({ blogPostId: "p1", blogDraftId: "d1", slug: "s1" })
      .mockResolvedValueOnce({ blogPostId: "p2", blogDraftId: "d2", slug: "s2" });

    const out = await runDaily();
    expect(out.status).toBe("succeeded");
    expect(out.articles).toHaveLength(2);
    expect(sendSuccessDigest).toHaveBeenCalledOnce();
    expect(sendFailureAlert).not.toHaveBeenCalled();
  });

  it("is fail-soft per article: one generation failure still succeeds run", async () => {
    const winners = [sc("w1", "a"), sc("w2", "b")];
    vi.mocked(scoreCandidates).mockResolvedValue(winners);
    vi.mocked(dedupCandidates).mockResolvedValue(winners);
    vi.mocked(pickWinners).mockReturnValue(winners);
    vi.mocked(generateArticle)
      .mockRejectedValueOnce(new Error("rejected twice"))
      .mockResolvedValueOnce({
        article: { slug: "s", title: "T", excerpt: "E", body: "B" },
        llmModel: "m", llmPromptVersion: "v2.0", llmResponseRaw: "{}",
      });
    vi.mocked(persistArticle).mockResolvedValue({ blogPostId: "p", blogDraftId: "d", slug: "s" });

    const out = await runDaily();
    expect(out.status).toBe("succeeded");
    expect(out.articles).toHaveLength(1);
  });

  it("returns no_question_picked when no winners", async () => {
    vi.mocked(scoreCandidates).mockResolvedValue([]);
    vi.mocked(dedupCandidates).mockResolvedValue([]);
    vi.mocked(pickWinners).mockReturnValue([]);
    const out = await runDaily();
    expect(out.status).toBe("no_question_picked");
    expect(sendSuccessDigest).not.toHaveBeenCalled();
  });

  it("fails run when winners exist but ALL articles fail", async () => {
    const winners = [sc("w1", "a")];
    vi.mocked(scoreCandidates).mockResolvedValue(winners);
    vi.mocked(dedupCandidates).mockResolvedValue(winners);
    vi.mocked(pickWinners).mockReturnValue(winners);
    vi.mocked(generateArticle).mockRejectedValue(new Error("rejected twice"));
    const out = await runDaily();
    expect(out.status).toBe("failed");
    expect(sendFailureAlert).toHaveBeenCalledOnce();
  });

  it("respects max option", async () => {
    const winners = [sc("w1", "a")];
    vi.mocked(scoreCandidates).mockResolvedValue(winners);
    vi.mocked(dedupCandidates).mockResolvedValue(winners);
    vi.mocked(pickWinners).mockReturnValue(winners);
    vi.mocked(generateArticle).mockResolvedValue({
      article: { slug: "s", title: "T", excerpt: "E", body: "B" },
      llmModel: "m", llmPromptVersion: "v2.0", llmResponseRaw: "{}",
    });
    vi.mocked(persistArticle).mockResolvedValue({ blogPostId: "p", blogDraftId: "d", slug: "s" });
    await runDaily({ max: 1 });
    expect(pickWinners).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ max: 1 }));
  });
});
```

- [ ] **Step 5: Run** `npm test` — expected FAIL (old runDaily shape).

- [ ] **Step 6: Rewrite `src/cron/runDaily.ts`**

```ts
/**
 * Orchestrator for the daily scraper run.
 *
 * Flow:
 *   0. Self-heal orphaned ScraperRun rows (status="running" >1h old)
 *   1. Open ScraperRun row (status="running")
 *   2. Mine candidates: all adapters × all 4 niches (75s cap per adapter)
 *   3. Score (batched embeddings + batched intent, niche argmax)
 *   4. Dedup vs recent titles (reusing embeddings)
 *   5. Pick winners: top ≤3, ≥0.4, ≤2/niche, pairwise-distinct
 *   6. Generate full articles IN PARALLEL, each validated (retry once)
 *   7. Persist each: BlogPost(draft) + BlogDraft(promoted)
 *   8. Close run + success digest / failure alert
 *
 * Fail-soft: adapter errors and single-article failures never kill the run.
 * Run fails only on infrastructure errors or when ALL picked articles fail.
 */
import { prisma } from "@/lib/db";
import { NICHES, type NicheConfig } from "@/lib/niche";
import { logger } from "@/lib/logger";
import { redditAdapter } from "@/adapters/reddit";
import { googlePaaAdapter } from "@/adapters/google-paa";
import { youtubeAdapter } from "@/adapters/youtube";
import { autocompleteAdapter } from "@/adapters/autocomplete";
import type { SourceAdapter, AdapterResult } from "@/adapters/types";
import { scoreCandidates, type ScoredCandidate } from "@/pipeline/score";
import { dedupCandidates } from "@/pipeline/dedup";
import { pickWinners } from "@/pipeline/pick";
import { buildLinkMenu, generateArticle } from "@/pipeline/article";
import { persistArticle } from "@/pipeline/persist";
import { sendFailureAlert, sendSuccessDigest, type DigestArticle } from "@/pipeline/alert";

const ADAPTER_TIMEOUT_MS = 75_000;
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ARTICLES = 3;

function getAdapters(): SourceAdapter[] {
  const adapters: SourceAdapter[] = [];
  const hasReddit =
    !!process.env.REDDIT_CLIENT_ID &&
    !!process.env.REDDIT_CLIENT_SECRET &&
    !!process.env.REDDIT_USER_AGENT;
  if (hasReddit) {
    adapters.push(redditAdapter);
  } else {
    logger.info("Reddit adapter disabled (REDDIT_* env vars not set)");
  }
  adapters.push(googlePaaAdapter, autocompleteAdapter, youtubeAdapter);
  return adapters;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RunResult {
  scraperRunId: string;
  status: "succeeded" | "no_question_picked" | "failed";
  articles: { blogPostId: string; blogDraftId: string; slug: string; niche: string }[];
  errorMessage?: string;
}

export async function runDaily(
  opts: { dryRun?: boolean; max?: number } = {}
): Promise<RunResult> {
  const maxArticles = Math.min(Math.max(opts.max ?? DEFAULT_MAX_ARTICLES, 1), DEFAULT_MAX_ARTICLES);
  logger.info("Daily run starting", {
    niches: NICHES.map((n) => n.slug),
    dryRun: !!opts.dryRun,
    maxArticles,
  });

  // 0. Self-heal orphaned runs (also cleans historical stale rows)
  const healed = await prisma.scraperRun.updateMany({
    where: { status: "running", startedAt: { lt: new Date(Date.now() - ORPHAN_AGE_MS) } },
    data: { status: "failed", errorMessage: "orphaned (self-heal)", completedAt: new Date() },
  });
  if (healed.count > 0) logger.warn("Self-healed orphaned runs", { count: healed.count });

  const ADAPTERS = getAdapters();

  // 1. Open ScraperRun row
  const run = await prisma.scraperRun.create({
    data: {
      status: "running",
      niche: NICHES.map((n) => n.slug).join(","),
      adapterStats: JSON.stringify({}),
    },
  });

  try {
    // 2. Mine from every adapter in parallel (all niches per adapter, 75s cap)
    const fetchResults: { adapter: SourceAdapter; result: AdapterResult }[] = await Promise.all(
      ADAPTERS.map(async (a) => ({
        adapter: a,
        result: await withTimeout(a.fetchQuestions(NICHES), ADAPTER_TIMEOUT_MS, a.sourceType).catch(
          (err): AdapterResult => ({
            questions: [],
            errors: [err instanceof Error ? err.message : String(err)],
          })
        ),
      }))
    );
    const allCandidates = fetchResults.flatMap((r) => r.result.questions);
    const adapterStats: Record<string, unknown> = Object.fromEntries(
      fetchResults.map((r) => [
        r.adapter.sourceType,
        { fetched: r.result.questions.length, errored: r.result.errors.length, errors: r.result.errors },
      ])
    );
    logger.info("Adapters complete", { totalCandidates: allCandidates.length, adapterStats });

    // 3-5. Score → dedup → pick
    const scored = allCandidates.length > 0 ? await scoreCandidates(allCandidates, NICHES) : [];
    const survivors = await dedupCandidates(scored);
    const winners = pickWinners(survivors, { max: maxArticles });

    if (winners.length === 0) {
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: {
          status: "no_question_picked",
          completedAt: new Date(),
          itemsFetched: allCandidates.length,
          candidatesAfterDedup: survivors.length,
          topScore: survivors[0]?.totalScore ?? null,
          adapterStats: JSON.stringify(adapterStats),
        },
      });
      logger.info("No winners — quiet exit", {
        topScoreSeen: survivors[0]?.totalScore?.toFixed(3) ?? "(none)",
      });
      return { scraperRunId: run.id, status: "no_question_picked", articles: [] };
    }

    logger.info("Winners picked", {
      count: winners.length,
      questions: winners.map((w) => w.candidate.questionText.slice(0, 60)),
    });

    // Dry-run: stop before any Gemini generation / DB writes
    if (opts.dryRun) {
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          itemsFetched: allCandidates.length,
          candidatesAfterDedup: survivors.length,
          topScore: winners[0].totalScore,
          adapterStats: JSON.stringify({ ...adapterStats, _dryRun: true }),
        },
      });
      return { scraperRunId: run.id, status: "succeeded", articles: [] };
    }

    // 6-7. Generate + persist each winner IN PARALLEL, fail-soft per article
    const nicheBySlug = new Map<string, NicheConfig>(NICHES.map((n) => [n.slug, n]));
    const settled = await Promise.all(
      winners.map(async (winner: ScoredCandidate) => {
        try {
          const niche = nicheBySlug.get(winner.assignedNicheSlug);
          if (!niche) throw new Error(`Unknown niche slug "${winner.assignedNicheSlug}"`);
          const menu = await buildLinkMenu(winner.embedding);
          const gen = await generateArticle(winner, niche, menu);
          const ids = await persistArticle({ winner, gen, niche });
          return { ok: true as const, winner, niche, gen, ids };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Article failed", {
            question: winner.candidate.questionText.slice(0, 80),
            error: message,
          });
          return { ok: false as const, winner, error: message };
        }
      })
    );

    const created = settled.filter((s) => s.ok);
    const skipped = settled.filter((s) => !s.ok);
    const articles = created.map((s) => ({
      blogPostId: s.ids.blogPostId,
      blogDraftId: s.ids.blogDraftId,
      slug: s.ids.slug,
      niche: s.niche.slug,
    }));

    const finalStats = JSON.stringify({
      ...adapterStats,
      articles: created.map((s) => ({
        blogDraftId: s.ids.blogDraftId,
        blogPostId: s.ids.blogPostId,
        slug: s.ids.slug,
        niche: s.niche.slug,
        totalScore: s.winner.totalScore,
      })),
      skipped: skipped.map((s) => ({
        question: s.winner.candidate.questionText.slice(0, 120),
        reason: s.error,
      })),
    });

    if (created.length === 0) {
      const errorMessage = `All ${winners.length} article(s) failed: ${skipped
        .map((s) => s.error)
        .join(" | ")}`;
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          errorMessage,
          itemsFetched: allCandidates.length,
          candidatesAfterDedup: survivors.length,
          adapterStats: finalStats,
        },
      });
      await sendFailureAlert({
        niche: NICHES.map((n) => n.slug).join(","),
        errorMessage,
        scraperRunId: run.id,
      });
      return { scraperRunId: run.id, status: "failed", articles: [], errorMessage };
    }

    // 8. Close run + digest
    await prisma.scraperRun.update({
      where: { id: run.id },
      data: {
        status: "succeeded",
        completedAt: new Date(),
        itemsFetched: allCandidates.length,
        candidatesAfterDedup: survivors.length,
        draftId: created[0].ids.blogDraftId,
        topScore: created[0].winner.totalScore,
        adapterStats: finalStats,
      },
    });

    const digest: DigestArticle[] = created.map((s) => ({
      title: s.gen.article.title,
      niche: s.niche.displayName,
      totalScore: s.winner.totalScore,
      blogPostId: s.ids.blogPostId,
      slug: s.ids.slug,
    }));
    await sendSuccessDigest(digest);

    logger.info("Run complete", { scraperRunId: run.id, created: created.length, skipped: skipped.length });
    return { scraperRunId: run.id, status: "succeeded", articles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Daily run failed", { error: message });

    await prisma.scraperRun.update({
      where: { id: run.id },
      data: { status: "failed", completedAt: new Date(), errorMessage: message },
    });
    await sendFailureAlert({
      niche: NICHES.map((n) => n.slug).join(","),
      errorMessage: message,
      scraperRunId: run.id,
    });
    return { scraperRunId: run.id, status: "failed", articles: [], errorMessage: message };
  }
}

// CLI dry-run support: `npm run dryrun`
if (process.argv[1]?.endsWith("runDaily.ts") || process.argv[1]?.endsWith("runDaily.js")) {
  const dryRun = process.argv.includes("--dry-run");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dotenv = require("dotenv");
  dotenv.config({ path: ".env.local" });

  runDaily({ dryRun })
    .then((r) => {
      console.log("\n=== Run result ===");
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 7: Update `app/api/cron/daily/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { runDaily } from "@/cron/runDaily";

export const runtime = "nodejs";
// 300 seconds — Vercel Pro. The run mines 4 niches, makes ~12-18 batched
// Gemini calls, and generates up to 3 full articles in parallel (~2-3.5 min).
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const maxRaw = parseInt(url.searchParams.get("max") ?? "", 10);
  const max = Number.isFinite(maxRaw) ? maxRaw : undefined;

  const result = await runDaily({ dryRun, max });
  return NextResponse.json(result);
}
```

- [ ] **Step 8: Delete `src/pipeline/outline.ts`**

```powershell
git rm src/pipeline/outline.ts
```

- [ ] **Step 9: Run** `npm test` — expected: ALL tests PASS.

- [ ] **Step 10: Run** `npm run build` — expected: compiles clean (first full-compile checkpoint since Task 4).

- [ ] **Step 11: Commit**

```powershell
git add -A; git commit -m "feat: orchestrator rewrite — parallel articles, self-heal, digest, route params"
```

---

### Task 13: Env docs, final verification, push

**Files:**
- Modify: `.env.local.example`, `README.md` (env table section only)

**Interfaces:** none — documentation + gates.

- [ ] **Step 1: Append to `.env.local.example`**

```bash
# --- Lead-engine rewire (2026-07) ---
# Admin User.id on the main site — author for scraper-created BlogPost drafts
SCRAPER_AUTHOR_ID=""
# Main site origin, used for digest email links (no trailing slash)
SITE_PUBLIC_URL="https://www.sbaloanoptions.com"
# Fallback cover image (UploadThing URL) when a niche imagePool is empty
DEFAULT_COVER_IMAGE=""
```

- [ ] **Step 2: Update README env section** — add the same 3 vars with one-line descriptions to the existing env-var table/list.

- [ ] **Step 3: Full gates**

```powershell
npm test; npm run lint; npm run build
```

Expected: all pass.

- [ ] **Step 4: Push**

```powershell
git add .env.local.example README.md; git commit -m "docs: new env vars for lead-engine rewire"; git push origin main
```

- [ ] **Step 5: Post-deploy setup (user + agent together)**
  1. Query Turso for the admin user id → set `SCRAPER_AUTHOR_ID` in Vercel Production.
  2. Set `SITE_PUBLIC_URL` and (recommended) `DEFAULT_COVER_IMAGE` in Vercel Production.
  3. Redeploy, then verify per spec §6: `?dryRun=1` → `?max=1` → check draft in admin, preview render, digest email → publish → let cron run.

---

## Verification checklist (spec §6 / §8)

- [ ] `?dryRun=1` returns `no_question_picked` or `succeeded` with mining stats populated in `ScraperRun`
- [ ] `?max=1` creates exactly 1 BlogPost draft + 1 promoted BlogDraft, linked
- [ ] Draft visible in main-site admin blog list; preview page renders (no MDX crash)
- [ ] Preview page source contains FAQPage + Article + Breadcrumb JSON-LD
- [ ] Digest email received with working edit + preview links
- [ ] No forbidden phrases in generated body (spot-check)
- [ ] Full cron run < 300s (check Vercel function logs)

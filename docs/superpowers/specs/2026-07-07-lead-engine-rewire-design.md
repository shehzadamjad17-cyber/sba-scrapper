# Lead Engine Rewire — sba-content-scraper

**Date:** 2026-07-07
**Status:** Approved design, pending implementation plan
**Repo:** `sba-content-scraper` (Vercel project `sba-scrapper`, now on **Pro** plan)

## 1. Problem

The scraper is code-complete but produces zero business value as wired:

1. **Write-only pipeline.** It writes `BlogDraft` rows that nothing reads — the main
   site has no UI or API touching that table. Drafts land in Turso and rot.
2. **Skeleton output.** It generates an *outline* with `{{INSERT_REAL_NUMBERS_HERE}}`
   placeholders requiring manual completion in an editor that doesn't exist. Worse:
   the site renders blog bodies through MDXRemote, so `{{ }}` would crash the page.
3. **Self-inflicted slowness.** ~250 serial Gemini calls per run (per-candidate intent
   calls, per-text embeds, candidates re-embedded in dedup) throttled at 10 RPM/key.
4. **One niche, one article/day max.** Too slow to build topical authority.
5. **No SEO/GEO discipline.** No slug, meta description, schema conventions, internal
   links to money pages, or compliance guardrails in the generated content.

## 2. Goal

Every morning, up to **3 publish-ready draft articles** appear in the main site's
existing admin blog UI. Review = read + click Publish (~2 min each). Articles follow
SEO/GEO rules that make them rank in Google and get cited by AI engines, and funnel
readers to `/apply` and `/instant-quote`. That is the lead path.

## 3. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Publish flow | Full article → `BlogPost` `status="draft"` → existing admin UI review |
| Velocity | Up to 3 articles/day, max 2 per niche per day |
| Niches | 4: MCA debt relief, SBA loan denial, working capital, equipment/LOC basics |
| Runtime | Vercel Pro (user upgraded), `maxDuration = 300` kept |
| Cover images | Preset pool per niche (user-uploaded UploadThing URLs), rotated |
| Architecture | Approach A: single-pass daily cron, no new tables, no prod schema changes |

## 4. Architecture

```
daily cron (0 11 * * *, Vercel Pro, ≤300s)
  └─ runDaily()
       ├─ self-heal: mark ScraperRun rows stuck "running" >1h as failed
       ├─ mine: adapters × 4 niches (each adapter hard-capped at 75s)
       │    ├─ google-paa   (playwright, 3 seeds/niche = 12 SERPs, weight 1.5)
       │    ├─ autocomplete (NEW — suggestqueries.google.com HTTP, weight 1.2)
       │    ├─ youtube      (3 searches/niche, weight 0.7)
       │    └─ reddit       (optional, only if REDDIT_* env vars set, weight 1.0)
       ├─ score: batched embeddings + batched intent calls
       ├─ dedup: reuse candidate embeddings; compare vs recent titles
       ├─ pick: top 3 with totalScore ≥ 0.4, max 2 per niche, pairwise-distinct
       ├─ generate: 3 full articles in PARALLEL (each own try/catch)
       │    └─ per article: prompt(SEO/GEO rules) → validate → retry once → skip
       ├─ persist: per article → BlogPost(draft) + BlogDraft(provenance)
       └─ notify: Resend success digest / failure alert
```

### 4.1 Niches (`src/lib/niche.ts`)

`CURRENT_NICHE` becomes `NICHES: NicheConfig[]` with 4 entries. `NicheConfig` gains:

```ts
ctaPath: string;        // "/apply" | "/instant-quote"
imagePool: string[];    // UploadThing URLs, user-supplied, may be empty pre-launch
```

| slug | focus | ctaPath |
|---|---|---|
| `mca-debt-relief` | MCA consolidation / default / daily-payment relief (keeps current keywords) | `/apply` |
| `sba-loan-denial` | denied SBA loan, why, reapplying, alternatives after denial | `/instant-quote` |
| `working-capital` | fast business funding, bridge funding, cash-flow gaps | `/instant-quote` |
| `equipment-loc-basics` | equipment financing and business line of credit fundamentals | `/apply` |

Each niche: ~8-12 keywords, exactly 3 `paaSeeds`, 2-3 `youtubeSearches`, subreddits
(used only if Reddit enabled). Budgets: 12 PAA SERP loads at page-concurrency 2
(~40-60s), YouTube ≈ 1,300 quota units/day (13% of free tier).

### 4.2 Adapter changes (`src/adapters/`)

- **Signature change:** `fetchQuestions(niches: NicheConfig[])` (plural) so PAA
  launches ONE browser for all 12 seeds instead of 4 browsers.
- **New `autocomplete.ts`:** for each niche, query
  `https://suggestqueries.google.com/complete/search?client=firefox&q=<seed>` with
  question-prefixed seeds (`can/how/what/why + keyword`). Plain HTTP, no browser,
  no key. Filters suggestions to question-like strings. `sourceType: "google_autocomplete"`,
  weight 1.2. This is the resilience backstop for PAA (CAPTCHA-fragile).
- **Per-adapter timeout:** orchestrator wraps each adapter in `Promise.race` with a
  75s timer → timeout counts as adapter error, run continues (fail-soft preserved).
- `SourceType` union gains `"google_autocomplete"`; `SOURCE_WEIGHTS` updated.

### 4.3 Batched scoring (`src/pipeline/score.ts`, `src/lib/gemini.ts`)

- `gemini.ts` gains `embedBatch(texts: string[]): Promise<number[][]>` using
  `batchEmbedContents`, chunked ≤100 texts/call. One batch call = one rate-limit slot.
- Niche centroids: all 4 niches' keywords embedded in ONE batch call, one centroid each.
- Candidates embedded in 1-2 batch calls. `nicheMatch` = **max** cosine across the 4
  centroids; candidate's `assignedNiche` = argmax. Hard-reject < 0.3 (unchanged).
- Intent scoring batched: 25 questions per Gemini call, JSON array response
  `[{index, intent}]` (3-5 calls total). Malformed/missing entries default 0.5.
- `totalScore = nicheMatch × intent × sourceWeight × engagementBoost` (unchanged).
- Scored candidates carry their embedding forward (`embedding: number[]` on
  `ScoredCandidate`) so dedup never re-embeds.

Expected total Gemini requests/run: **~12-18** (vs ~250 today). Runtime target:
adapters ≤75s ∥, scoring ≤40s, dedup ≤15s, 3 parallel article gens ≤90s, persist ≤5s
→ **~3.5 min worst case** inside the 300s ceiling.

### 4.4 Dedup + winner selection (`src/pipeline/dedup.ts`, `runDaily.ts`)

- Recent titles (last 60 days) now include: published `BlogPost` **+ draft `BlogPost`**
  + non-rejected `BlogDraft`. Titles embedded in one batch call.
- Candidate embeddings come from scoring — no re-embedding.
- Threshold 0.8 cosine (unchanged).
- Winner selection: sort by `totalScore` desc → walk down taking candidates with
  score ≥ 0.4, skipping any within 0.8 cosine of an already-picked winner
  (same-day near-dupe guard), max 2 per `assignedNiche`, stop at 3.

### 4.5 Article generation (`src/pipeline/article.ts` — replaces `outline.ts`)

One Gemini 2.5 Flash structured-output call per winner; the 3 winners generate in
`Promise.all`, each wrapped in try/catch so one failure never kills the others.

**Prompt inputs:** question verbatim, context snippet, source URL, niche config,
the SEO/GEO rules block (§4.6), and an **internal-link menu**: the 8 most relevant
published posts (by embedding similarity to the question, from ≤50 recent published
posts — titles + `/blog/<slug>` URLs). The model links 2-4 of them inline; the
validator rejects any href not on the menu (kills hallucinated URLs).

**Response schema:**

```ts
{
  slug: string;          // kebab, ≤60 chars
  title: string;         // ≤60 chars
  excerpt: string;       // 120-155 chars, doubles as meta description
  body: string;          // full MDX-safe markdown article
}
```

**Body structure (enforced):** answer-first opening paragraph (no heading) → 4-6
content H2s → exactly one markdown comparison table somewhere → `## FAQ` with 4-6
`### Question?` entries (site auto-extracts FAQPage JSON-LD from this exact shape) →
CTA paragraph linking the niche's `ctaPath`. 1,200-1,800 words.

### 4.6 SEO/GEO rules engine (`src/lib/seo-rules.ts`)

Two exports: `SEO_RULES_PROMPT` (injected into every article prompt) and
`validateArticle(article, { allowedInternalSlugs }): { ok, violations: string[] }`.

**Prompted + mechanically validated:**

| Rule | Validation |
|---|---|
| Title ≤60 chars, mirrors question, no clickbait | length check |
| Slug `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤60 chars | regex |
| Excerpt 120-155 chars | length check |
| No H1 in body (site renders H1 from title) | reject `^# ` lines |
| 4-6 content H2s + required `## FAQ` | heading parse |
| FAQ: 4-6 `### …?` entries, each with answer paragraph | parse (mirrors site extractor) |
| At least one markdown table | `\|---\|` detection |
| 2-4 internal `/blog/<slug>` links, slugs ∈ menu | link parse + set check |
| ≥1 money-page link (`/apply`, `/instant-quote`, `/sba-loan-calculator`) | link parse |
| ≤2 external links, domain allowlist: sba.gov, federalreserve.gov, irs.gov | link parse |
| Word count 1,200-1,800 | count |
| **MDX-safe:** no `{` or `}`, no raw HTML tags | regex `[{}]`, `<[a-zA-Z]` |
| **Forbidden phrases** (case-insensitive): "direct lender", "guaranteed approval", "100% approval", "as an AI", "I cannot" | substring scan |

**Prompt-only (not mechanically checkable):** answer-first opening; quotable
standalone opening sentence per H2 section; define niche terms on first use; short
paragraphs (≤3 sentences); bold key phrases; ~8th-grade reading level; semantic
entity coverage without keyword stuffing; Joseph Snado founder voice, plainspoken,
never salesy; **anti-fabrication**: ranges/qualitative statements instead of invented
figures, no fake lender names, borrower stories, or testimonials; official public
facts OK when high-confidence.

**Failure loop:** validate → if violations, ONE retry with violations appended to the
prompt → if still failing, skip this article (log to adapterStats), continue others.

### 4.7 Persistence (`src/pipeline/persist.ts`)

Per successful article, in order:

1. **Slug collision check:** `blogPost.findUnique({ where: { slug } })`; on collision
   append `-2`, `-3`, … (recheck each).
2. **Cover image:** `niche.imagePool[BlogDraft count for niche % pool.length]`;
   empty pool → `DEFAULT_COVER_IMAGE` env; that also unset → skip article with clear
   log (never create a draft that can't render).
3. **Create `BlogPost`:** `{ slug, title, excerpt, coverImage, body, status: "draft",
   authorId: SCRAPER_AUTHOR_ID }`.
4. **Create `BlogDraft`** (provenance/audit): source fields + scores as today;
   `bodyOutline` = full article markdown; `title` = article title; `clearAnswer` =
   first paragraph of body; `ctaBlock` = niche `ctaPath`; `imagePrompt` = chosen
   cover image URL; `comparisonTable`/`faqSection`/`titleVariants`/`internalLinks`
   store `"[]"` (superseded — content lives inside body);
   `status: "promoted"`, `promotedToPostId: <new post id>`, `promotedAt: now`;
   `llmModel`, `llmPromptVersion: "v2.0"`, `llmResponseRaw` kept.
5. **`ScraperRun`:** `draftId` = first article's BlogDraft id (schema unchanged);
   `adapterStats` JSON gains `articles: [{ blogDraftId, blogPostId, slug, niche,
   totalScore }]` and `skipped: [{ question, reason }]`.

**No Prisma schema changes in either repo. No migrations on prod Turso.**

### 4.8 Ops & notifications (`src/pipeline/alert.ts`, `runDaily.ts`, `route.ts`)

- **Success digest** (new, Resend → `SCRAPER_ALERT_EMAIL`): sent when ≥1 article
  created. Subject `"[scraper] N draft(s) ready for review"`; per article: title,
  niche, score, admin edit link `${SITE_PUBLIC_URL}/admin/blog/<postId>/edit`,
  preview link `${SITE_PUBLIC_URL}/blog/<slug>?preview=1`.
- Failure alert unchanged. `no_question_picked` stays silent.
- **Self-heal at run start:** `ScraperRun` rows with `status="running"` and
  `startedAt < now - 1h` → `status="failed"`, `errorMessage="orphaned (self-heal)"`.
  This also cleans the existing stale row from the July manual runs.
- **Route params** (`app/api/cron/daily/route.ts`): `?dryRun=1` (stop before
  generation, mark run succeeded with `_dryRun` flag) and `?max=N` (cap articles,
  1 ≤ N ≤ 3) for cheap manual verification. Auth via `CRON_SECRET` unchanged.
- `runtime="nodejs"`, `maxDuration=300`, cron `0 11 * * *` unchanged.

### 4.9 Env vars

| Var | Status |
|---|---|
| existing 7 (`DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `GEMINI_API_KEYS`, `YOUTUBE_API_KEY`, `CRON_SECRET`, `RESEND_API_KEY`, `SCRAPER_ALERT_EMAIL`) | unchanged |
| `SCRAPER_AUTHOR_ID` | **NEW, required** — admin User.id on the main site (fetched from Turso during setup) |
| `SITE_PUBLIC_URL` | **NEW, required** — main site origin for digest links |
| `DEFAULT_COVER_IMAGE` | **NEW, recommended** — fallback UploadThing URL |
| `REDDIT_*` ×3 | optional, unchanged |

## 5. Testing (Vitest — new to this repo)

Unit tests, externals mocked: score math + niche argmax; intent-batch parsing incl.
malformed responses; batch chunker; dedup incl. same-day winner guard; winner
selection (threshold, niche cap, pairwise); `validateArticle` per rule (each rule
gets a failing fixture); slug collision suffixing; image rotation + fallbacks; FAQ
format compatibility with the site extractor regex (copied fixture); prompt builder
(menu injection). Integration: `runDaily` happy path + partial-failure paths with
all I/O stubbed. Gates: `npm run build` + `npx vitest run` green before push.

## 6. Rollout

1. Implement + tests green + build green → push to `main` → Vercel deploy.
2. Set new env vars in Vercel Production; user uploads image pools (or we launch
   with `DEFAULT_COVER_IMAGE` only and add pools later — config accepts empty pools).
3. Manual trigger `?dryRun=1` → verify scoring/mining stats in ScraperRun.
4. Manual trigger `?max=1` → verify: draft appears in admin blog list, preview
   renders (no MDX crash), FAQ JSON-LD present on preview page, digest email lands.
5. Publish the first article manually. Let the daily cron run.
6. Watch first 3 cron days via digest emails; tune `MIN_TOTAL_SCORE` if starved
   (0 articles repeatedly) or drowning (junk above 0.4).

## 7. Out of scope (explicit)

- Satellite-site content (waits for domains; niches here are main-site only)
- Question-bank two-stage architecture (Approach B — revisit if mining starves)
- AI cover-image generation; Reddit adapter re-enable; main-site code changes
- Credential rotation for keys pasted in old chats (separate ops task, still owed)
- Outcome tracking (which articles produce leads) — future; requires site analytics

## 8. Success criteria

- Cron completes < 300s with 3 articles on a normal day
- Drafts appear in existing admin UI, publishable without edits (only review)
- Preview renders clean MDX; FAQPage/Article/Breadcrumb JSON-LD all present
- Zero fabricated figures / forbidden phrases (validator-enforced)
- Digest email arrives daily; failures alert; stale runs self-heal

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

export function getAdapters(): SourceAdapter[] {
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

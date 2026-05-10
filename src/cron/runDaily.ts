/**
 * Orchestrator for the daily scraper run.
 *
 * Flow:
 *   1. Open ScraperRun row (status="running")
 *   2. Fetch candidates from all source adapters in parallel
 *   3. Score candidates (niche match + intent + source weight + engagement)
 *   4. Dedup against last 60 days of BlogPost + BlogDraft titles
 *   5. Pick the highest-scoring candidate above MIN_TOTAL_SCORE
 *   6. Generate the outline via Gemini 2.5 Flash
 *   7. Persist BlogDraft + close ScraperRun row
 *
 * On any caught error: ScraperRun.status="failed" + Resend alert.
 * On no winner: ScraperRun.status="no_question_picked" (no email — expected).
 */
import { prisma } from "@/lib/db";
import { CURRENT_NICHE, type NicheConfig } from "@/lib/niche";
import { logger } from "@/lib/logger";
import { redditAdapter } from "@/adapters/reddit";
import { googlePaaAdapter } from "@/adapters/google-paa";
import { youtubeAdapter } from "@/adapters/youtube";
import type { SourceAdapter, AdapterResult } from "@/adapters/types";
import { scoreCandidates } from "@/pipeline/score";
import { dedupCandidates } from "@/pipeline/dedup";
import { generateOutline } from "@/pipeline/outline";
import { persistDraft } from "@/pipeline/persist";
import { sendFailureAlert } from "@/pipeline/alert";

const MIN_TOTAL_SCORE = 0.4;

/**
 * Build the active adapter list at runtime.
 *
 * Reddit is OPTIONAL — included only when all three REDDIT_* env vars are
 * present. This lets the scraper ship without a Reddit account (Reddit
 * silently blocks app creation for new accounts, which can take days to
 * unblock). To re-enable later, just add the 3 env vars to Vercel and
 * redeploy — no code change needed.
 *
 * Google PAA and YouTube are always enabled.
 *
 * Called inside runDaily() (not at module top-level) so the env-var check
 * happens AFTER dotenv loads .env.local for local CLI runs.
 */
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
  adapters.push(googlePaaAdapter, youtubeAdapter);
  return adapters;
}

export interface RunResult {
  scraperRunId: string;
  status: "succeeded" | "no_question_picked" | "failed";
  draftId?: string;
  errorMessage?: string;
}

export async function runDaily(opts: { dryRun?: boolean } = {}): Promise<RunResult> {
  const niche: NicheConfig = CURRENT_NICHE;
  logger.info("Daily run starting", { niche: niche.displayName, dryRun: !!opts.dryRun });

  const ADAPTERS = getAdapters();
  logger.info("Active adapters", { count: ADAPTERS.length, types: ADAPTERS.map((a) => a.sourceType) });

  // 1. Open ScraperRun row
  const run = await prisma.scraperRun.create({
    data: {
      status: "running",
      niche: niche.displayName,
      adapterStats: JSON.stringify({}),
    },
  });

  try {
    // 2. Fetch from every adapter in parallel
    const fetchResults: { adapter: SourceAdapter; result: AdapterResult }[] = await Promise.all(
      ADAPTERS.map(async (a) => ({
        adapter: a,
        result: await a.fetchQuestions(niche).catch((err): AdapterResult => ({
          questions: [],
          errors: [err instanceof Error ? err.message : String(err)],
        })),
      }))
    );
    const allCandidates = fetchResults.flatMap((r) => r.result.questions);
    const adapterStats = Object.fromEntries(
      fetchResults.map((r) => [
        r.adapter.sourceType,
        { fetched: r.result.questions.length, errored: r.result.errors.length, errors: r.result.errors },
      ])
    );
    logger.info("Adapters complete", { totalCandidates: allCandidates.length, adapterStats });

    if (allCandidates.length === 0) {
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: {
          status: "no_question_picked",
          completedAt: new Date(),
          itemsFetched: 0,
          adapterStats: JSON.stringify(adapterStats),
        },
      });
      return { scraperRunId: run.id, status: "no_question_picked" };
    }

    // 3. Score
    const scored = await scoreCandidates(allCandidates, niche);

    // 4. Dedup
    const survivors = await dedupCandidates(scored);

    // 5. Pick winner
    const winner = survivors.find((s) => s.totalScore >= MIN_TOTAL_SCORE) ?? null;
    if (!winner) {
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
      logger.info("No question above MIN_TOTAL_SCORE — quiet exit", {
        topScoreSeen: survivors[0]?.totalScore?.toFixed(3) ?? "(none)",
      });
      return { scraperRunId: run.id, status: "no_question_picked" };
    }

    logger.info("Winner picked", {
      question: winner.candidate.questionText.slice(0, 80),
      totalScore: winner.totalScore.toFixed(3),
    });

    // 6. Generate outline (skip if dry-run)
    if (opts.dryRun) {
      logger.info("[dry-run] Would call Gemini and persist BlogDraft, exiting early");
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          itemsFetched: allCandidates.length,
          candidatesAfterDedup: survivors.length,
          topScore: winner.totalScore,
          adapterStats: JSON.stringify({ ...adapterStats, _dryRun: true }),
        },
      });
      return { scraperRunId: run.id, status: "succeeded" };
    }

    const outline = await generateOutline(winner, niche);

    // Update itemsFetched + candidatesAfterDedup BEFORE persistDraft so the
    // numbers are stored even if the persistDraft fails partway
    await prisma.scraperRun.update({
      where: { id: run.id },
      data: {
        itemsFetched: allCandidates.length,
        candidatesAfterDedup: survivors.length,
        adapterStats: JSON.stringify(adapterStats),
      },
    });

    // 7. Persist
    const { draftId } = await persistDraft({
      scraperRunId: run.id,
      winner,
      outline,
      niche,
    });

    logger.info("Run complete", { scraperRunId: run.id, draftId });
    return { scraperRunId: run.id, status: "succeeded", draftId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Daily run failed", { error: message });

    await prisma.scraperRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: message,
      },
    });

    await sendFailureAlert({ niche: niche.displayName, errorMessage: message, scraperRunId: run.id });
    return { scraperRunId: run.id, status: "failed", errorMessage: message };
  }
}

// CLI dry-run support: `npm run dryrun`
if (process.argv[1]?.endsWith("runDaily.ts") || process.argv[1]?.endsWith("runDaily.js")) {
  const dryRun = process.argv.includes("--dry-run");
  // Load .env.local for local dev
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

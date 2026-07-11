/**
 * Per-target satellite runs. Each target is fully isolated in try/catch —
 * one brand failing never blocks the others, and the main-site run
 * (runDaily) is entirely separate. Publishes through the two-layer gate:
 * lint (deterministic) then critique (LLM). Gate fail → draft.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { TARGETS, type SatelliteTarget } from "@/lib/targets";
import { getAdapters } from "@/cron/runDaily";
import type { AdapterResult, SourceAdapter } from "@/adapters/types";
import { scoreCandidates, type ScoredCandidate } from "@/pipeline/score";
import { dedupCandidates } from "@/pipeline/dedup";
import { pickWinners } from "@/pipeline/pick";
import { buildSatelliteLinkMenu, generateSatelliteArticle } from "@/pipeline/satellite-article";
import { lintSatelliteArticle } from "@/pipeline/gate";
import { critiqueArticle, CRITIQUE_THRESHOLD } from "@/pipeline/critique";
import {
  insertGeneratedPost,
  resolveSiteSlug,
  fetchRecentSiteTitles,
} from "@/lib/content-db";
import { pingIndexNow } from "@/lib/indexnow";
import { buildUnpublishUrl } from "@/lib/unpublish-token";
import { sendSatelliteDigest, type SatelliteDigestSection } from "@/pipeline/alert";

const ADAPTER_TIMEOUT_MS = 75_000;
const DEFAULT_MAX_ARTICLES = 3;
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const REQUIRED_ENV = ["CONTENT_DATABASE_URL", "CONTENT_DATABASE_AUTH_TOKEN", "UNPUBLISH_SECRET", "SCRAPER_PUBLIC_URL"];

export interface SatelliteRunResult {
  siteId: string;
  status: "succeeded" | "no_question_picked" | "failed";
  published: { id: string; slug: string; title: string }[];
  drafted: { id: string; slug: string; title: string }[];
  errorMessage?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function runOneTarget(
  target: SatelliteTarget,
  adapters: SourceAdapter[],
  opts: { dryRun?: boolean; max?: number }
): Promise<{ result: SatelliteRunResult; digest: SatelliteDigestSection }> {
  const maxArticles = Math.min(Math.max(opts.max ?? DEFAULT_MAX_ARTICLES, 1), DEFAULT_MAX_ARTICLES);
  const digest: SatelliteDigestSection = {
    brandName: target.brandName,
    siteUrl: target.siteUrl,
    published: [],
    drafted: [],
    errors: [],
  };

  let runId: string | null = null;

  try {
    const run = await prisma.scraperRun.create({
      data: {
        status: "running",
        site: target.siteId,
        niche: target.niches.map((n) => n.slug).join(","),
        adapterStats: JSON.stringify({}),
      },
    });
    runId = run.id;

    // Mine
    const fetchResults = await Promise.all(
      adapters.map(async (a) => ({
        adapter: a,
        result: await withTimeout(a.fetchQuestions(target.niches), ADAPTER_TIMEOUT_MS, `${target.siteId}:${a.sourceType}`).catch(
          (err): AdapterResult => ({
            questions: [],
            errors: [err instanceof Error ? err.message : String(err)],
          })
        ),
      }))
    );
    const candidates = fetchResults.flatMap((r) => r.result.questions);
    const adapterStats = Object.fromEntries(
      fetchResults.map((r) => [
        r.adapter.sourceType,
        { fetched: r.result.questions.length, errored: r.result.errors.length, errors: r.result.errors },
      ])
    );

    // Score → dedup (vs THIS site's generated titles) → pick
    const scored = candidates.length > 0 ? await scoreCandidates(candidates, target.niches) : [];
    const recentTitles = await fetchRecentSiteTitles(target.siteId).catch(() => []);
    const survivors = await dedupCandidates(scored, { recentTitles });
    const winners = pickWinners(survivors, { max: maxArticles });

    if (winners.length === 0 || opts.dryRun) {
      await prisma.scraperRun.update({
        where: { id: runId },
        data: {
          status: winners.length === 0 ? "no_question_picked" : "succeeded",
          completedAt: new Date(),
          itemsFetched: candidates.length,
          candidatesAfterDedup: survivors.length,
          topScore: survivors[0]?.totalScore ?? null,
          adapterStats: JSON.stringify({ ...adapterStats, _dryRun: !!opts.dryRun }),
        },
      });
      return {
        result: {
          siteId: target.siteId,
          status: winners.length === 0 ? "no_question_picked" : "succeeded",
          published: [],
          drafted: [],
        },
        digest,
      };
    }

    // Generate → gate → persist, fail-soft per article
    const nicheBySlug = new Map(target.niches.map((n) => [n.slug, n]));
    const published: SatelliteRunResult["published"] = [];
    const drafted: SatelliteRunResult["drafted"] = [];

    for (const winner of winners as ScoredCandidate[]) {
      try {
        const niche = nicheBySlug.get(winner.assignedNicheSlug);
        if (!niche) throw new Error(`Unknown niche slug "${winner.assignedNicheSlug}"`);
        const menu = await buildSatelliteLinkMenu(target, winner.embedding);
        const gen = await generateSatelliteArticle(winner, niche, menu, target);

        // Two-layer gate
        const lint = lintSatelliteArticle(gen.article, target);
        let critiqueScore = -1;
        let critiqueIssues: string[] = [];
        if (lint.ok) {
          try {
            const verdict = await critiqueArticle(gen.article, target);
            critiqueScore = verdict.score;
            critiqueIssues = verdict.issues;
          } catch (err) {
            critiqueIssues = [`critique call failed: ${err instanceof Error ? err.message : String(err)}`];
          }
        }
        const publish = lint.ok && critiqueScore >= CRITIQUE_THRESHOLD;
        const qualityNotes = JSON.stringify({
          lint: lint.violations,
          critiqueScore,
          critiqueIssues,
        });

        const slug = await resolveSiteSlug(
          target.siteId,
          gen.article.slug,
          undefined,
          target.cornerstones.map((c) => c.slug)
        );
        const { id } = await insertGeneratedPost({
          site: target.siteId,
          slug,
          title: gen.article.title,
          excerpt: gen.article.excerpt,
          content: gen.article.body,
          category: target.defaultCategory,
          status: publish ? "published" : "draft",
          qualityNotes,
          sourceQuestion: winner.candidate.questionText,
          llmModel: gen.llmModel,
        });

        if (publish) {
          const url = `${target.siteUrl}${target.blogBasePath}/${slug}`;
          await pingIndexNow({ host: target.host, key: target.indexNowKey, urls: [url] });
          published.push({ id, slug, title: gen.article.title });
          digest.published.push({ title: gen.article.title, url, unpublishUrl: buildUnpublishUrl(id) });
        } else {
          drafted.push({ id, slug, title: gen.article.title });
          digest.drafted.push({
            title: gen.article.title,
            reasons: [...lint.violations, ...critiqueIssues, ...(critiqueScore >= 0 ? [`critique score ${critiqueScore}`] : [])],
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Satellite article failed", { target: target.siteId, error: msg });
        digest.errors.push(msg);
      }
    }

    await prisma.scraperRun.update({
      where: { id: runId },
      data: {
        status: "succeeded",
        completedAt: new Date(),
        itemsFetched: candidates.length,
        candidatesAfterDedup: survivors.length,
        topScore: winners[0].totalScore,
        adapterStats: JSON.stringify({
          ...adapterStats,
          published: published.map((p) => p.slug),
          drafted: drafted.map((d) => d.slug),
        }),
      },
    });

    return {
      result: { siteId: target.siteId, status: "succeeded", published, drafted },
      digest,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Satellite run failed", { target: target.siteId, error: msg });
    if (runId) {
      await prisma.scraperRun
        .update({
          where: { id: runId },
          data: { status: "failed", completedAt: new Date(), errorMessage: msg },
        })
        .catch(() => {});
    }
    digest.errors.push(msg);
    return {
      result: { siteId: target.siteId, status: "failed", published: [], drafted: [], errorMessage: msg },
      digest,
    };
  }
}

export async function runSatellites(
  opts: { dryRun?: boolean; max?: number; only?: string } = {}
): Promise<SatelliteRunResult[]> {
  // 0. Self-heal orphaned satellite ScraperRun rows (mirrors runDaily's self-heal)
  await prisma.scraperRun
    .updateMany({
      where: { status: "running", startedAt: { lt: new Date(Date.now() - ORPHAN_AGE_MS) } },
      data: { status: "failed", errorMessage: "orphaned (self-heal)", completedAt: new Date() },
    })
    .catch(() => {});

  const targets = opts.only ? TARGETS.filter((t) => t.siteId === opts.only) : TARGETS;
  if (targets.length === 0) {
    logger.warn("runSatellites: no matching targets", { only: opts.only });
    return [];
  }

  // Env preflight — never create a ScraperRun or attempt to publish with a
  // half-configured environment. Fail every selected target up front instead.
  if (!opts.dryRun) {
    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      const errorMessage = `preflight: missing env ${missing.join(", ")}`;
      logger.error("runSatellites preflight failed — missing env", { missing });
      return targets.map((t) => ({
        siteId: t.siteId,
        status: "failed",
        published: [],
        drafted: [],
        errorMessage,
      }));
    }
  }

  const adapters = getAdapters();
  const results: SatelliteRunResult[] = [];
  const digests: SatelliteDigestSection[] = [];

  // SEQUENTIAL by design: keeps Gemini/Firecrawl usage flat and per-target
  // failures isolated. ~30-45s per target inside the 300s cron budget.
  // Each target is additionally wrapped here so a crash inside runOneTarget
  // itself (not just inside its own try/catch) can never abort the loop or
  // drop that target's digest section.
  for (const target of targets) {
    try {
      const { result, digest } = await runOneTarget(target, adapters, opts);
      results.push(result);
      digests.push(digest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Satellite target crashed", { target: target.siteId, error: msg });
      results.push({ siteId: target.siteId, status: "failed", published: [], drafted: [], errorMessage: msg });
      digests.push({ brandName: target.brandName, siteUrl: target.siteUrl, published: [], drafted: [], errors: [msg] });
    }
  }

  if (!opts.dryRun && digests.some((d) => d.published.length + d.drafted.length + d.errors.length > 0)) {
    await sendSatelliteDigest(digests);
  }
  return results;
}

/**
 * YouTube comment question-miner.
 *
 * For each search query in niche.youtubeSearches:
 *   1. youtube.search.list to get top 5 video IDs
 *   2. For each video, youtube.commentThreads.list for top 20 comments by relevance
 *   3. Filter comments that contain `?` AND at least one niche keyword
 *
 * Quota cost: ~5 searches × 100 + 25 commentThreads × 1 = 525 units/day.
 * Free tier is 10k units/day, so ~19× headroom.
 */
import { google } from "googleapis";
import type { NicheConfig } from "@/lib/niche";
import type { AdapterResult, SourceAdapter, CandidateQuestion } from "./types";
import { logger } from "@/lib/logger";

function getClient() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("Missing YOUTUBE_API_KEY");
  return google.youtube({ version: "v3", auth: apiKey });
}

function matchesKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

export const youtubeAdapter: SourceAdapter = {
  sourceType: "youtube",
  sourceWeight: 0.7,

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
};

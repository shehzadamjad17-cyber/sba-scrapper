/**
 * Reddit question-miner.
 *
 * For each subreddit in niche.subreddits, fetch the top 100 NEW posts.
 * Filter to posts whose title contains a `?` AND at least one niche keyword.
 * Return as CandidateQuestion[].
 *
 * Uses snoowrap (Reddit's official-style OAuth2 client). Auto-throttles to
 * Reddit's rate limits (60 reqs/min for OAuth scripts).
 */
import Snoowrap from "snoowrap";
import type { NicheConfig } from "@/lib/niche";
import type { AdapterResult, SourceAdapter, CandidateQuestion } from "./types";
import { logger } from "@/lib/logger";

let _client: Snoowrap | null = null;

function getClient(): Snoowrap {
  if (_client) return _client;
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT;
  if (!clientId || !clientSecret || !userAgent) {
    throw new Error("Missing REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET / REDDIT_USER_AGENT");
  }
  // Script-type apps use clientId+secret only (no username/password needed for read-only)
  _client = new Snoowrap({
    userAgent,
    clientId,
    clientSecret,
    refreshToken: undefined as unknown as string, // not needed for app-only auth
    accessToken: "",
  });
  // snoowrap will fetch its own access token on first request via Application-Only OAuth
  return _client;
}

function matchesKeyword(title: string, keywords: string[]): boolean {
  const lower = title.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

export const redditAdapter: SourceAdapter = {
  sourceType: "reddit",
  sourceWeight: 1.0,

  async fetchQuestions(niche: NicheConfig): Promise<AdapterResult> {
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

    for (const subName of niche.subreddits) {
      try {
        // .new fetches the most recently submitted posts (limit 100)
        const sub = client.getSubreddit(subName);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const posts: any[] = await sub.getNew({ limit: 100 });

        for (const p of posts) {
          const title: string = p.title ?? "";
          if (!title.includes("?")) continue;
          if (!matchesKeyword(title, niche.keywords)) continue;

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
};

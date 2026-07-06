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
    const winners = [sc("w1", "mca-debt-relief"), sc("w2", "sba-loan-denial")];
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
    const winners = [sc("w1", "mca-debt-relief")];
    vi.mocked(scoreCandidates).mockResolvedValue(winners);
    vi.mocked(dedupCandidates).mockResolvedValue(winners);
    vi.mocked(pickWinners).mockReturnValue(winners);
    vi.mocked(generateArticle).mockRejectedValue(new Error("rejected twice"));
    const out = await runDaily();
    expect(out.status).toBe("failed");
    expect(sendFailureAlert).toHaveBeenCalledOnce();
  });

  it("respects max option", async () => {
    const winners = [sc("w1", "mca-debt-relief")];
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

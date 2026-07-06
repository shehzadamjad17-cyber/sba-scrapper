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

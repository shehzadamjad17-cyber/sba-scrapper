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

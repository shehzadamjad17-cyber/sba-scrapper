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

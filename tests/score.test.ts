import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CandidateQuestion } from "@/adapters/types";
import type { NicheConfig } from "@/lib/niche";

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return { ...actual, embedBatch: vi.fn(), generateContent: vi.fn() };
});

import { embedBatch, generateContent } from "@/lib/gemini";
import { scoreCandidates } from "@/pipeline/score";

const nicheA: NicheConfig = {
  slug: "a", displayName: "A", keywords: ["alpha"], subreddits: [],
  paaSeeds: ["x", "y", "z"], youtubeSearches: ["s1", "s2"], ctaPath: "/apply", imagePool: [],
};
const nicheB: NicheConfig = {
  slug: "b", displayName: "B", keywords: ["beta"], subreddits: [],
  paaSeeds: ["x", "y", "z"], youtubeSearches: ["s1", "s2"], ctaPath: "/instant-quote", imagePool: [],
};

function q(text: string): CandidateQuestion {
  return {
    sourceType: "google_paa", sourceUrl: "https://g", questionText: text,
    contextSnippet: "", engagement: 0, capturedAt: new Date(),
  };
}

// Unit vectors: nicheA keyword → [1,0], nicheB keyword → [0,1]
beforeEach(() => {
  vi.mocked(embedBatch).mockReset();
  vi.mocked(generateContent).mockReset();
});

describe("scoreCandidates", () => {
  it("assigns each candidate to its argmax niche and carries embedding", async () => {
    vi.mocked(embedBatch)
      .mockResolvedValueOnce([[1, 0], [0, 1]])        // keyword embeds (alpha, beta)
      .mockResolvedValueOnce([[0.9, 0.1], [0.1, 0.9]]); // candidate embeds
    vi.mocked(generateContent).mockResolvedValue({
      raw: "", parsed: { ratings: [{ index: 0, intent: 0.8 }, { index: 1, intent: 0.6 }] },
    });

    const out = await scoreCandidates([q("about alpha"), q("about beta")], [nicheA, nicheB]);
    expect(out).toHaveLength(2);
    const bySlug = Object.fromEntries(out.map((s) => [s.assignedNicheSlug, s]));
    expect(bySlug.a.candidate.questionText).toBe("about alpha");
    expect(bySlug.b.candidate.questionText).toBe("about beta");
    expect(bySlug.a.embedding).toEqual([0.9, 0.1]);
  });

  it("hard-rejects candidates below 0.3 niche match", async () => {
    vi.mocked(embedBatch)
      .mockResolvedValueOnce([[1, 0], [0, 1]])
      .mockResolvedValueOnce([[-1, 0]]); // cosine -1 vs both centroids
    const out = await scoreCandidates([q("off topic")], [nicheA, nicheB]);
    expect(out).toHaveLength(0);
    expect(generateContent).not.toHaveBeenCalled(); // no intent call for rejects
  });

  it("defaults intent 0.5 for missing/malformed ratings and sorts desc", async () => {
    vi.mocked(embedBatch)
      .mockResolvedValueOnce([[1, 0], [0, 1]])
      .mockResolvedValueOnce([[1, 0], [0.9, 0.1]]);
    vi.mocked(generateContent).mockResolvedValue({
      raw: "", parsed: { ratings: [{ index: 1, intent: 0.9 }] }, // index 0 missing, defaults to 0.5
    });
    const out = await scoreCandidates([q("one"), q("two")], [nicheA, nicheB]);
    expect(out[0].candidate.questionText).toBe("two");
    expect(out[0].intentScore).toBe(0.9);
    expect(out[1].intentScore).toBe(0.5);
    expect(out[0].totalScore).toBeGreaterThan(out[1].totalScore);
  });
});

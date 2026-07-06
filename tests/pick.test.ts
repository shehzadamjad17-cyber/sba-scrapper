import { describe, it, expect } from "vitest";
import { pickWinners } from "@/pipeline/pick";
import type { ScoredCandidate } from "@/pipeline/score";

function sc(text: string, score: number, niche: string, embedding: number[]): ScoredCandidate {
  return {
    candidate: {
      sourceType: "google_paa", sourceUrl: "https://g", questionText: text,
      contextSnippet: "", engagement: 0, capturedAt: new Date(),
    },
    embedding, nicheMatch: 0.7, assignedNicheSlug: niche, intentScore: 0.8,
    sourceWeight: 1.5, engagementBoost: 1, totalScore: score,
  };
}

describe("pickWinners", () => {
  it("takes top 3 above 0.4", () => {
    const out = pickWinners([
      sc("a", 0.9, "n1", [1, 0, 0]),
      sc("b", 0.8, "n2", [0, 1, 0]),
      sc("c", 0.7, "n3", [0, 0, 1]),
      sc("d", 0.6, "n4", [1, 1, 0]),
    ]);
    expect(out.map((s) => s.candidate.questionText)).toEqual(["a", "b", "c"]);
  });

  it("breaks (not continues) at first sub-minScore item — nothing after is picked", () => {
    const out = pickWinners([
      sc("a", 0.9, "n1", [1, 0, 0]),
      sc("b", 0.3, "n2", [0, 1, 0]),
      sc("c", 0.9, "n3", [0, 0, 1]), // would be picked by a buggy `continue`
    ]);
    expect(out.map((s) => s.candidate.questionText)).toEqual(["a"]);
  });

  it("caps 2 per niche", () => {
    const out = pickWinners([
      sc("a", 0.9, "same", [1, 0, 0]),
      sc("b", 0.8, "same", [0, 1, 0]),
      sc("c", 0.7, "same", [0, 0, 1]),
      sc("d", 0.6, "other", [1, 1, 1]),
    ]);
    expect(out.map((s) => s.assignedNicheSlug)).toEqual(["same", "same", "other"]);
  });

  it("skips same-day near-duplicates of already-picked winners", () => {
    const out = pickWinners([
      sc("a", 0.9, "n1", [1, 0, 0]),
      sc("a-dupe", 0.8, "n2", [0.99, 0.01, 0]),
      sc("b", 0.7, "n3", [0, 1, 0]),
    ]);
    expect(out.map((s) => s.candidate.questionText)).toEqual(["a", "b"]);
  });
});

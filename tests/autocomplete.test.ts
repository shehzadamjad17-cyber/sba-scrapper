import { describe, it, expect, afterEach, vi } from "vitest";
import { buildSeeds, filterSuggestions, autocompleteAdapter } from "@/adapters/autocomplete";
import { NICHES } from "@/lib/niche";
import type { NicheConfig } from "@/lib/niche";

describe("buildSeeds", () => {
  it("builds prefix×keyword seeds, 12 per niche, deduped", () => {
    const seeds = buildSeeds(NICHES);
    expect(seeds.length).toBeLessThanOrEqual(NICHES.length * 12);
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(seeds).toContain("how merchant cash advance");
  });
});

describe("filterSuggestions", () => {
  it("keeps question-shaped suggestions, drops short/echo ones", () => {
    const out = filterSuggestions(
      [
        "how to get out of mca debt fast",
        "mca",                                  // too short
        "how merchant cash advance",            // pure echo of seed
        "can you consolidate merchant cash advances",
      ],
      "how merchant cash advance"
    );
    expect(out).toEqual([
      "how to get out of mca debt fast",
      "can you consolidate merchant cash advances",
    ]);
  });
});

describe("fetchQuestions", () => {
  // Single niche, single keyword -> 4 seeds (one per question prefix), deterministic.
  const ONE_NICHE: NicheConfig[] = [
    {
      slug: "mca-debt-relief",
      displayName: "MCA Debt Relief",
      keywords: ["merchant cash advance"],
      subreddits: [],
      paaSeeds: [],
      youtubeSearches: [],
      ctaPath: "/apply",
      imagePool: [],
    },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails soft when fetch rejects for every seed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await autocompleteAdapter.fetchQuestions(ONE_NICHE);

    expect(result.questions).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails soft when fetch resolves non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429 })
    );

    const result = await autocompleteAdapter.fetchQuestions(ONE_NICHE);

    expect(result.questions).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("dedupes case-insensitive duplicates across seeds on the happy path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          "seed",
          [
            "how to get out of mca debt fast",
            "HOW TO GET OUT OF MCA DEBT FAST",
          ],
        ],
      })
    );

    const result = await autocompleteAdapter.fetchQuestions(ONE_NICHE);

    expect(result.errors).toEqual([]);
    const matches = result.questions.filter(
      (q) => q.questionText.toLowerCase() === "how to get out of mca debt fast"
    );
    expect(matches.length).toBe(1);
    for (const q of result.questions) {
      expect(q.sourceType).toBe("google_autocomplete");
      expect(q.engagement).toBe(0);
    }
  });

  it("fails soft on a malformed (null) response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => null,
      })
    );

    const result = await autocompleteAdapter.fetchQuestions(ONE_NICHE);

    expect(result.questions).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { extractPaaQuestions, googlePaaAdapter } from "@/adapters/google-paa";
import type { NicheConfig } from "@/lib/niche";

// Mirrors the real markdown shape Firecrawl returned for a Google SERP
// (observed 2026-07): plain "People also ask" marker, question lines as
// their own paragraphs, interleaved answers and source links.
const SERP_MARKDOWN = `
Some organic result text up here.

[Some Result Title](https://example.com/page)

People also ask

How to get out of MCA debt?

An error has occurred. Please try again later.

What happens if you can't pay back a MCA loan?

Many MCA contracts include a personal guarantee, which puts your personal assets at risk.

[**What happens if you default on a merchant cash advance**\\
Swoop Funding\\
https://swoopfunding.com](https://swoopfunding.com/us/business-loans/)

Can MCA debt be consolidated?

Yes, several lenders offer consolidation programs.

People also search for

merchant cash advance lawsuit?

More organic results below.
`;

const niche: NicheConfig = {
  slug: "test", displayName: "Test", keywords: ["mca"], subreddits: [],
  paaSeeds: ["seed one", "seed two", "seed three"], youtubeSearches: ["a", "b"],
  ctaPath: "/apply", imagePool: [],
};

describe("extractPaaQuestions", () => {
  it("pulls standalone question lines from the PAA section only", () => {
    const out = extractPaaQuestions(SERP_MARKDOWN);
    expect(out).toEqual([
      "How to get out of MCA debt?",
      "What happens if you can't pay back a MCA loan?",
      "Can MCA debt be consolidated?",
    ]);
  });

  it("excludes link-formatted lines and questions after the section end", () => {
    const out = extractPaaQuestions(SERP_MARKDOWN);
    expect(out.join(" ")).not.toContain("default on a merchant cash advance");
    expect(out.join(" ")).not.toContain("lawsuit");
  });

  it("returns [] when no PAA marker exists (bot wall or missing panel)", () => {
    expect(extractPaaQuestions("Our systems have detected unusual traffic")).toEqual([]);
  });
});

describe("googlePaaAdapter.fetchQuestions", () => {
  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FIRECRAWL_API_KEY;
  });

  it("returns questions from successful scrapes, deduped case-insensitively across seeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { markdown: SERP_MARKDOWN } }),
    }));
    const out = await googlePaaAdapter.fetchQuestions([niche]);
    // 3 seeds × same 3 questions → deduped to 3
    expect(out.questions).toHaveLength(3);
    expect(out.questions[0].sourceType).toBe("google_paa");
    expect(out.questions[0].engagement).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it("is fail-soft: HTTP errors and rejections produce errors, never throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const out = await googlePaaAdapter.fetchQuestions([niche]);
    expect(out.questions).toEqual([]);
    expect(out.errors).toHaveLength(3);
  });

  it("records a diagnostic when the page has no PAA section", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { markdown: "unusual traffic detected page" } }),
    }));
    const out = await googlePaaAdapter.fetchQuestions([niche]);
    expect(out.questions).toEqual([]);
    expect(out.errors[0]).toMatch(/0 questions — page began: unusual traffic/);
  });

  it("reports missing FIRECRAWL_API_KEY without calling fetch", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await googlePaaAdapter.fetchQuestions([niche]);
    expect(out.errors).toEqual(["Missing FIRECRAWL_API_KEY"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

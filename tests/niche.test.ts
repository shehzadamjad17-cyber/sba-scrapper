import { describe, it, expect } from "vitest";
import { NICHES } from "@/lib/niche";

describe("NICHES", () => {
  it("has 4 niches with unique slugs", () => {
    expect(NICHES).toHaveLength(4);
    expect(new Set(NICHES.map((n) => n.slug)).size).toBe(4);
  });
  it("every niche satisfies the mining budget invariants", () => {
    for (const n of NICHES) {
      expect(n.paaSeeds).toHaveLength(3);
      expect(n.youtubeSearches.length).toBeGreaterThanOrEqual(2);
      expect(n.youtubeSearches.length).toBeLessThanOrEqual(3);
      expect(n.keywords.length).toBeGreaterThanOrEqual(8);
      expect(["/apply", "/instant-quote"]).toContain(n.ctaPath);
      expect(Array.isArray(n.imagePool)).toBe(true);
    }
  });
});

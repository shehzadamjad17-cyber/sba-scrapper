import { describe, it, expect } from "vitest";
import { buildSeeds, filterSuggestions } from "@/adapters/autocomplete";
import { NICHES } from "@/lib/niche";

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

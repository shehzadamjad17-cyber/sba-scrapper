import { describe, it, expect } from "vitest";
import { chunk, cosineSimilarity, centroid } from "@/lib/gemini";

describe("chunk", () => {
  it("splits into size-limited groups preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("returns [] for empty input", () => {
    expect(chunk([], 100)).toEqual([]);
  });
  it("returns one group when under limit", () => {
    expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
  });
});

describe("existing vector math (regression)", () => {
  it("cosineSimilarity of identical vectors is 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it("centroid averages", () => {
    expect(centroid([[0, 0], [2, 2]])).toEqual([1, 1]);
  });
});

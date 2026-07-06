process.env.GEMINI_API_KEYS = process.env.GEMINI_API_KEYS || "test-key-1,test-key-2";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { chunk, cosineSimilarity, centroid, embedBatch } from "@/lib/gemini";

const batchEmbedContentsMock = vi.fn();
vi.mock("@google/generative-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/generative-ai")>();
  return {
    ...actual,
    GoogleGenerativeAI: vi.fn().mockImplementation(function () {
      return {
        getGenerativeModel: vi.fn().mockReturnValue({
          batchEmbedContents: batchEmbedContentsMock,
        }),
      };
    }),
  };
});

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

describe("embedBatch", () => {
  beforeEach(() => {
    batchEmbedContentsMock.mockReset();
  });

  it("makes one batchEmbedContents call per <=100-text chunk (slot-per-call, not per-text)", async () => {
    batchEmbedContentsMock.mockImplementation(async (request: { requests: unknown[] }) => ({
      embeddings: request.requests.map((_, i) => ({ values: [i] })),
    }));

    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const result = await embedBatch(texts);

    expect(batchEmbedContentsMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(150);
  });

  it("throws when the returned embedding count does not match requested text count", async () => {
    batchEmbedContentsMock.mockResolvedValue({
      embeddings: [{ values: [0] }, { values: [1] }], // fewer than requested
    });

    const texts = ["a", "b", "c"];
    await expect(embedBatch(texts)).rejects.toThrow(/expected 3 embeddings, got 2/);
  });

  it("preserves order across chunk boundaries", async () => {
    batchEmbedContentsMock.mockImplementation(async (request: { requests: Array<{ content: { parts: Array<{ text: string }> } }> }) => ({
      embeddings: request.requests.map((r) => ({
        values: [Number(r.content.parts[0].text.replace("text-", ""))],
      })),
    }));

    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const result = await embedBatch(texts);

    expect(result).toHaveLength(150);
    result.forEach((vec, i) => {
      expect(vec).toEqual([i]);
    });
  });

  it("returns [] for empty input without touching the SDK", async () => {
    const result = await embedBatch([]);

    expect(result).toEqual([]);
    expect(batchEmbedContentsMock).not.toHaveBeenCalled();
  });
});

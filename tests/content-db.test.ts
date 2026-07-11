import { describe, it, expect, vi } from "vitest";
import {
  resolveSiteSlug,
  insertGeneratedPost,
  fetchRecentSiteTitles,
  fetchPublishedSitePosts,
  setPostStatus,
} from "@/lib/content-db";

describe("resolveSiteSlug", () => {
  it("returns base slug when free", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    expect(await resolveSiteSlug("selnet-loc", "my-post", execute)).toBe("my-post");
  });
  it("suffixes -2 when taken", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "x" }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await resolveSiteSlug("selnet-loc", "my-post", execute)).toBe("my-post-2");
  });
  it("suffixes -2 when the base slug is reserved (e.g. a cornerstone slug)", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    expect(await resolveSiteSlug("selnet-loc", "my-post", execute, ["my-post"])).toBe("my-post-2");
  });
});

describe("insertGeneratedPost", () => {
  it("inserts with published timestamp when status=published", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const r = await insertGeneratedPost(
      {
        site: "selnet-equipment", slug: "s", title: "T", excerpt: "E", content: "C",
        category: "Guides", status: "published", qualityNotes: "{}",
        sourceQuestion: "q?", llmModel: "gemini-2.5-flash",
      },
      execute
    );
    expect(r.id).toBeTruthy();
    const [sql, args] = execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO GeneratedPost/);
    expect(args).toContain("published");
    // publishedAt (last arg) must be a non-null ISO string for published posts
    expect(typeof args[args.length - 1]).toBe("string");
  });
  it("leaves publishedAt null for drafts", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await insertGeneratedPost(
      {
        site: "selnet-equipment", slug: "s", title: "T", excerpt: "E", content: "C",
        category: "", status: "draft", qualityNotes: "{}", sourceQuestion: "", llmModel: "",
      },
      execute
    );
    const [, args] = execute.mock.calls[0];
    expect(args[args.length - 1]).toBeNull();
  });
});

describe("fetch helpers", () => {
  it("fetchRecentSiteTitles returns unique titles", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ title: "A" }, { title: "A" }, { title: "B" }] });
    expect(await fetchRecentSiteTitles("selnet-cre", execute)).toEqual(["A", "B"]);
  });
  it("fetchPublishedSitePosts maps title+slug", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ title: "A", slug: "a" }] });
    expect(await fetchPublishedSitePosts("selnet-cre", execute)).toEqual([{ title: "A", slug: "a" }]);
  });
});

describe("setPostStatus", () => {
  it("updates and returns identifying fields", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ site: "selnet-loc", slug: "a", title: "A", id: "p1", status: "published" }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await setPostStatus("p1", "unpublished", execute);
    expect(r).toEqual({ site: "selnet-loc", slug: "a", title: "A" });
    expect(execute.mock.calls[1][0]).toMatch(/UPDATE GeneratedPost SET status/);
  });
  it("returns null for unknown id", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    expect(await setPostStatus("nope", "unpublished", execute)).toBeNull();
  });
});

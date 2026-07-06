import { describe, it, expect, beforeEach } from "vitest";
import { buildDigestHtml } from "@/pipeline/alert";

beforeEach(() => {
  process.env.SITE_PUBLIC_URL = "https://www.example.com";
});

describe("buildDigestHtml", () => {
  it("renders one row per article with edit + preview links", () => {
    const html = buildDigestHtml([
      { title: "Post A", niche: "MCA Debt Relief", totalScore: 0.81, blogPostId: "p1", slug: "post-a" },
      { title: "Post B", niche: "Working Capital", totalScore: 0.62, blogPostId: "p2", slug: "post-b" },
    ]);
    expect(html).toContain("Post A");
    expect(html).toContain("https://www.example.com/admin/blog/p1/edit");
    expect(html).toContain("https://www.example.com/blog/post-b?preview=1");
    expect(html).toContain("0.81");
  });

  it("escapes HTML in titles", () => {
    const html = buildDigestHtml([
      { title: "<script>x</script>", niche: "N", totalScore: 0.5, blogPostId: "p", slug: "s" },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

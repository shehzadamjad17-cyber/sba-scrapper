import { describe, it, expect } from "vitest";
import { validateArticle, normalizeExcerpt, type GeneratedArticle } from "@/lib/seo-rules";

describe("normalizeExcerpt", () => {
  it("returns compliant excerpts unchanged", () => {
    const ok = "Denied an SBA loan? Learn the common denial reasons, what your letter means, and the fastest path to reapproval or an alternative.";
    expect(normalizeExcerpt(ok)).toBe(ok);
  });

  it("truncates overlong excerpts at a word boundary into the 120-155 window", () => {
    const long =
      "Denied an SBA loan? Learn the common denial reasons, what your denial letter actually means for you, and the fastest realistic path back to reapproval or a funding alternative today.";
    expect(long.length).toBeGreaterThan(155);
    const out = normalizeExcerpt(long);
    expect(out.length).toBeLessThanOrEqual(155);
    expect(out.length).toBeGreaterThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it("collapses internal whitespace and newlines", () => {
    const messy = "Denied an SBA loan?\n  Learn the common denial reasons, what your letter means, and the fastest path to reapproval or an alternative.";
    expect(normalizeExcerpt(messy)).not.toMatch(/\s{2,}|\n/);
  });
});

const para = (s: string) => `${s} This sentence pads the word count with plain useful language for small business owners weighing their funding options carefully today.`;
const filler = Array.from({ length: 30 }, (_, i) => para(`Filler paragraph number ${i + 1} explains one practical funding consideration in plainspoken terms.`)).join("\n\n");

function validBody(): string {
  return [
    "If your SBA loan was denied, you can usually reapply after 90 days once the underlying issue is fixed.",
    "## Why SBA loans get denied",
    para("Lenders decline applications for a handful of recurring reasons."),
    "See our guide on [reapplying](/blog/reapply-guide) and [credit repair](/blog/credit-repair).",
    "## What the denial letter tells you",
    para("Your denial letter names the specific reason."),
    "## Alternatives while you wait",
    para("Several funding routes stay open after a denial."),
    "| Option | Speed | Typical range |\n|---|---|---|\n| Line of credit | Fast | Small to medium |\n| Equipment loan | Medium | Asset-based |",
    "## How to strengthen a reapplication",
    para("Fix the named issue before anything else."),
    filler,
    "Ready to see your options? [Get pre-qualified](/apply) in minutes.",
    "Official guidance is at [sba.gov](https://www.sba.gov/funding-programs/loans).",
    "## FAQ",
    "### Can I reapply after an SBA denial?",
    "Yes. Most lenders accept reapplications after 90 days once the cited issue is resolved.",
    "### Does a denial hurt my credit?",
    "The application inquiry may appear, but the denial itself is not reported as a negative event.",
    "### How long should I wait to reapply?",
    "Ninety days is the common minimum, but waiting until the root cause is fixed matters more.",
    "### Are there alternatives to reapplying?",
    "Yes — lines of credit, equipment financing, and revenue-based options remain available.",
  ].join("\n\n");
}

function valid(): GeneratedArticle {
  return {
    slug: "sba-loan-denied-reapply",
    title: "SBA Loan Denied? When and How to Reapply",
    excerpt:
      "Denied an SBA loan? Learn the common denial reasons, what your letter means, and the fastest path to reapproval or an alternative.",
    body: validBody(),
  };
}

const OPTS = { allowedInternalSlugs: ["reapply-guide", "credit-repair"] };

describe("validateArticle", () => {
  it("passes a fully compliant article", () => {
    const r = validateArticle(valid(), OPTS);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  const cases: [string, (a: GeneratedArticle) => void, string][] = [
    ["long title", (a) => (a.title = "x".repeat(61)), "title"],
    ["bad slug", (a) => (a.slug = "Bad Slug!"), "slug"],
    ["short excerpt", (a) => (a.excerpt = "too short"), "excerpt"],
    ["H1 in body", (a) => (a.body = "# Top\n\n" + a.body), "H1"],
    ["missing FAQ", (a) => (a.body = a.body.replace("## FAQ", "## Questions")), "FAQ"],
    ["no table", (a) => (a.body = a.body.replace(/\|.*\n?/g, "")), "table"],
    ["hallucinated internal link", (a) => (a.body = a.body.replace("/blog/reapply-guide", "/blog/made-up")), "internal"],
    ["no money link", (a) => (a.body = a.body.replace("(/apply)", "(/blog/credit-repair)")), "money"],
    ["disallowed external domain", (a) => (a.body = a.body.replace("https://www.sba.gov/funding-programs/loans", "https://evil.example.com")), "external"],
    ["MDX braces", (a) => (a.body += "\n\n{{bad}}"), "MDX"],
    ["raw HTML", (a) => (a.body += "\n\n<div>hi</div>"), "MDX"],
    ["forbidden phrase", (a) => (a.body += "\n\nWe are a direct lender."), "forbidden"],
  ];

  for (const [name, mutate, keyword] of cases) {
    it(`fails on ${name}`, () => {
      const a = valid();
      mutate(a);
      const r = validateArticle(a, OPTS);
      expect(r.ok).toBe(false);
      expect(r.violations.join(" ")).toMatch(new RegExp(keyword, "i"));
    });
  }

  it("fails when word count is out of range", () => {
    const a = valid();
    a.body = a.body.split(/\s+/).slice(0, 400).join(" ") + "\n\n## FAQ\n\n### Q one?\n\nA.\n\n### Q two?\n\nA.\n\n### Q three?\n\nA.\n\n### Q four?\n\nA.";
    const r = validateArticle(a, OPTS);
    expect(r.violations.join(" ")).toMatch(/word count/i);
  });

  it("empty menu: internal links become forbidden instead of required", () => {
    const withLinks = validateArticle(valid(), { allowedInternalSlugs: [] });
    expect(withLinks.violations.join(" ")).toMatch(/internal links not allowed/i);

    const a = valid();
    a.body = a.body
      .replace("[reapplying](/blog/reapply-guide)", "reapplying")
      .replace("[credit repair](/blog/credit-repair)", "credit repair");
    const noLinks = validateArticle(a, { allowedInternalSlugs: [] });
    expect(noLinks.violations).toEqual([]);
  });

  it("accepts money links with anchor, trailing slash, or query suffixes", () => {
    for (const variant of ["/apply#form", "/apply/", "/apply?src=blog"]) {
      const a = valid();
      a.body = a.body.replace("(/apply)", `(${variant})`);
      expect(validateArticle(a, OPTS).violations).toEqual([]);
    }
  });
});

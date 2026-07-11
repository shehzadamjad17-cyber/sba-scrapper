/**
 * SEO/GEO rules engine.
 *
 * SEO_RULES_PROMPT is injected into every article-generation prompt.
 * validateArticle() mechanically enforces every checkable rule BEFORE
 * anything is written to the DB — an article that fails twice is skipped.
 *
 * The FAQ format rules mirror the main site's extractor exactly
 * (src/app/blog/[slug]/page.tsx extractFaqs): `## FAQ` heading, then
 * `### Question?` subheadings each followed by answer paragraphs — this is
 * what turns into FAQPage JSON-LD automatically.
 */

export interface GeneratedArticle {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
}

export const MONEY_PAGES = ["/apply", "/instant-quote", "/sba-loan-calculator"];
export const EXTERNAL_ALLOWLIST = ["sba.gov", "federalreserve.gov", "irs.gov"];
export const FORBIDDEN_PHRASES = [
  "direct lender",
  "guaranteed approval",
  "100% approval",
  "as an ai",
  "i cannot",
];

const WORD_MIN = 1200;
// Prompt targets 2,200 so the model has headroom before this hard cap —
// first prod run produced a good 2,066-word article that the old 1,800
// cap rejected twice (wasted both attempts).
const WORD_MAX = 2400;

const EXCERPT_MAX = 155;
const EXCERPT_MIN = 120;

/**
 * Collapse whitespace and hard-truncate overlong excerpts at a word
 * boundary (mechanical fix — the model habitually overshoots by ~20-30
 * chars, and rejecting for that wastes a full generation attempt).
 * Truncation never lands below EXCERPT_MIN.
 */
export function normalizeExcerpt(excerpt: string): string {
  const clean = (excerpt ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= EXCERPT_MAX) return clean;
  const cut = clean.slice(0, EXCERPT_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace >= EXCERPT_MIN - 1 ? cut.slice(0, lastSpace).trimEnd() : cut;
  return `${base}…`;
}

export const SEO_RULES_PROMPT = `
STRICT CONTENT RULES (violations cause automatic rejection):

Metadata
- title: mirrors the reader's question, ≤60 characters, no clickbait.
- slug: lowercase kebab-case, primary keyword, no stopwords, ≤60 characters.
- excerpt: 120-155 characters; primary keyword + a concrete benefit (used as the meta description).

Structure (GEO/AEO)
- Open with 2-3 sentences that DIRECTLY and completely answer the question. No heading before it, no throat-clearing.
- NO H1 headings anywhere (the site renders the H1). Use exactly 4-6 content H2 sections (##).
- Each H2 section opens with one self-contained factual sentence that makes sense quoted out of context.
- Include exactly one markdown comparison table (relevant options/tradeoffs). It MUST use this exact pipe syntax:
| Option | Typical speed | Best for |
|---|---|---|
| Example row | Example | Example |
- End sections with a "## FAQ" heading containing 4-6 "### <question>?" subheadings, each followed by a 1-3 sentence answer paragraph.
- 1,200-2,200 words total. Short paragraphs (≤3 sentences). Use bullet lists. Bold key phrases sparingly.
- Define niche jargon on first use. Write at an 8th-grade reading level.

Links
- Link 2-4 of the provided internal articles inline where genuinely relevant, format [anchor text](/blog/<slug>). ONLY use slugs from the provided list.
- Include at least one call-to-action link to the provided CTA path.
- At most 2 external links, ONLY to: sba.gov, federalreserve.gov, irs.gov.

Voice & compliance
- Written by Joseph Snado, founder of SBA Loan Options: plainspoken, trustworthy, never salesy.
- NEVER fabricate statistics, dollar figures, rates, lender names, borrower stories, or testimonials. Use ranges and qualitative statements ("often", "typically", "can range widely").
- NEVER write: "direct lender", "guaranteed approval", "100% approval", or anything implying certainty of funding.
- Markdown only. NO curly braces { }, NO raw HTML tags, NO placeholders of any kind — the output must be publish-ready.
`.trim();

export function validateArticle(
  a: GeneratedArticle,
  opts: {
    allowedInternalSlugs: string[];
    internalLinkPrefix?: string;
    moneyPages?: string[];
  }
): { ok: boolean; violations: string[] } {
  const prefix = opts.internalLinkPrefix ?? "/blog/";
  const moneyPages = opts.moneyPages ?? MONEY_PAGES;
  const v: string[] = [];
  const body = a.body ?? "";

  // --- metadata ---
  if (!a.title || a.title.length > 60) v.push(`title must be 1-60 chars (got ${a.title?.length ?? 0})`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.slug ?? "") || (a.slug ?? "").length > 60)
    v.push(`slug must be kebab-case ≤60 chars (got "${a.slug}")`);
  if (!a.excerpt || a.excerpt.length < 120 || a.excerpt.length > 155)
    v.push(`excerpt must be 120-155 chars (got ${a.excerpt?.length ?? 0})`);

  // --- word count ---
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < WORD_MIN || words > WORD_MAX) v.push(`word count must be ${WORD_MIN}-${WORD_MAX} (got ${words})`);

  // --- headings ---
  if (/^#\s/m.test(body)) v.push("body must not contain H1 headings");
  const h2s = Array.from(body.matchAll(/^##\s+(.+)$/gm)).map((m) => m[1].trim());
  const contentH2s = h2s.filter((h) => h.toUpperCase() !== "FAQ");
  if (contentH2s.length < 4 || contentH2s.length > 6)
    v.push(`must have 4-6 content H2 sections (got ${contentH2s.length})`);

  // --- FAQ block (must match the site extractor) ---
  const faqMatch = body.match(/^##\s+FAQ\s*$/im);
  if (!faqMatch) {
    v.push("missing '## FAQ' section");
  } else {
    const after = body.slice(body.indexOf(faqMatch[0]) + faqMatch[0].length);
    const nextH2 = after.search(/\n##\s+\S/);
    const faqSection = nextH2 === -1 ? after : after.slice(0, nextH2);
    const entries = faqSection.split(/\n###\s+/).slice(1);
    if (entries.length < 4 || entries.length > 6) v.push(`FAQ must have 4-6 entries (got ${entries.length})`);
    for (const e of entries) {
      const lineBreak = e.indexOf("\n");
      const q = lineBreak === -1 ? e.trim() : e.slice(0, lineBreak).trim();
      const answer = lineBreak === -1 ? "" : e.slice(lineBreak).trim();
      if (!q.endsWith("?")) v.push(`FAQ question must end with '?': "${q.slice(0, 60)}"`);
      if (!answer) v.push(`FAQ entry has no answer: "${q.slice(0, 60)}"`);
    }
  }

  // --- table ---
  if (!/\|\s*-{3,}/.test(body)) v.push("missing markdown comparison table");

  // --- links ---
  const links = Array.from(body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)).map((m) => m[1]);
  const internal = links.filter((u) => u.startsWith(prefix));
  if (opts.allowedInternalSlugs.length === 0) {
    // No published posts to link to — ANY internal link is a hallucination.
    if (internal.length > 0) v.push(`internal links not allowed when no published posts exist (got ${internal.length})`);
  } else {
    if (internal.length < 2 || internal.length > 4)
      v.push(`must have 2-4 internal ${prefix} links (got ${internal.length})`);
    const allowed = new Set(opts.allowedInternalSlugs);
    for (const u of internal) {
      const slug = u.replace(prefix, "").replace(/[#?].*$/, "");
      if (!allowed.has(slug)) v.push(`internal link to unknown slug "${slug}" (hallucinated?)`);
    }
  }
  const isMoneyLink = (u: string) =>
    moneyPages.some((m) => u === m || u.startsWith(`${m}?`) || u.startsWith(`${m}#`) || u.startsWith(`${m}/`));
  if (!links.some(isMoneyLink)) v.push(`missing money-page link (one of: ${moneyPages.join(", ")})`);
  const external = links.filter((u) => /^https?:\/\//i.test(u));
  if (external.length > 2) v.push(`at most 2 external links (got ${external.length})`);
  for (const u of external) {
    let host = "";
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      v.push(`unparseable external URL "${u}"`);
      continue;
    }
    if (!EXTERNAL_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`)))
      v.push(`external link to non-allowlisted domain "${host}"`);
  }

  // --- MDX safety ---
  if (/[{}]/.test(body)) v.push("MDX-unsafe: body contains { or }");
  if (/<[a-zA-Z!/]/.test(body)) v.push("MDX-unsafe: body contains raw HTML tags");

  // --- forbidden phrases (title + excerpt + body) ---
  const haystack = `${a.title}\n${a.excerpt}\n${body}`.toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (haystack.includes(phrase)) v.push(`forbidden phrase: "${phrase}"`);
  }

  return { ok: v.length === 0, violations: v };
}

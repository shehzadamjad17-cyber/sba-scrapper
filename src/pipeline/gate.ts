/**
 * Layer-1 quality gate: deterministic lint. Code, not AI — it cannot
 * hallucinate a pass. Any violation → the article is saved as draft,
 * never published. Word count / headings / FAQ shape are already enforced
 * by validateArticle() at generation time; this layer owns brand
 * independence, honesty, fabrication tells, and link hygiene.
 */
import type { SatelliteTarget } from "@/lib/targets";

export interface LintResult {
  ok: boolean;
  violations: string[];
}

/** Sister-brand terms; a target's ownBrandTerms are exempted at runtime. */
const BRAND_TERMS: { label: string; re: RegExp }[] = [
  { label: "SBA Loan Options", re: /sba loan options/i },
  { label: "sbaloanoptions.com", re: /sbaloanoptions/i },
  { label: "Selective Capital", re: /selective capital/i },
  { label: "Selective SBA", re: /selective sba/i },
  { label: "Tempo", re: /\btempo\b/i },
  { label: "Relief Capital", re: /relief capital/i },
  { label: "reliefcapital.biz", re: /reliefcapital/i },
  { label: "Equipment Capital", re: /equipment capital/i },
  { label: "equipmentcapital.biz", re: /equipmentcapital/i },
  { label: "FlexCreditLine", re: /flex ?credit ?line/i },
  { label: "EquityBridge", re: /equity ?bridge/i },
  { label: "vercel.app host", re: /\.vercel\.app/i },
];

const FORBIDDEN_CLAIMS = [
  "direct lender",
  "direct funder",
  "our own capital",
  "we lend",
  "in-house capital",
  "hold our own paper",
  "our own balance sheet",
  "guaranteed approval",
  "guaranteed funding",
  "100% approval",
];

const FABRICATION_TELLS = [
  "one of our clients",
  "a client of ours",
  "we've funded $",
  "we have funded $",
  "our clients have saved",
];

const PLACEHOLDER_TELLS = ["[insert", "todo", "as an ai", "lorem ipsum"];

const EXTERNAL_ALLOWLIST = ["sba.gov", "federalreserve.gov", "irs.gov"];

export function lintSatelliteArticle(
  a: { title: string; excerpt: string; body: string },
  target: SatelliteTarget
): LintResult {
  const v: string[] = [];
  const haystack = `${a.title}\n${a.excerpt}\n${a.body}`;
  const lower = haystack.toLowerCase();

  // --- brand independence (own brand exempt) ---
  const own = target.ownBrandTerms.map((t) => t.toLowerCase());
  for (const { label, re } of BRAND_TERMS) {
    if (own.some((o) => label.toLowerCase().includes(o) || o.includes(label.toLowerCase()))) continue;
    if (re.test(haystack)) v.push(`sister-brand leak: "${label}"`);
  }

  // --- honesty ---
  for (const phrase of FORBIDDEN_CLAIMS) {
    if (lower.includes(phrase)) v.push(`forbidden claim: "${phrase}"`);
  }

  // --- fabrication ---
  for (const tell of FABRICATION_TELLS) {
    if (lower.includes(tell)) v.push(`fabrication tell: "${tell}"`);
  }

  // --- placeholders ---
  for (const tell of PLACEHOLDER_TELLS) {
    if (tell === "todo") {
      if (/\btodo\b/i.test(haystack)) v.push(`placeholder: "TODO"`);
    } else if (lower.includes(tell)) {
      v.push(`placeholder: "${tell}"`);
    }
  }

  // --- CTA link present ---
  const links = Array.from(a.body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)).map((m) => m[1]);
  const hasCta = links.some(
    (u) => u === target.ctaPath || u.startsWith(`${target.ctaPath}?`) || u.startsWith(`${target.ctaPath}#`)
  );
  if (!hasCta) v.push(`missing CTA link to ${target.ctaPath}`);

  // --- absolute URLs: own site or allowlisted gov domains only ---
  for (const u of links.filter((x) => /^https?:\/\//i.test(x))) {
    let host = "";
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      v.push(`unparseable URL "${u}"`);
      continue;
    }
    const ownHost = host === target.host || `www.${host}` === target.host || host === target.host.replace(/^www\./, "");
    const allowed = EXTERNAL_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`));
    if (!ownHost && !allowed) v.push(`external link to non-allowlisted domain "${host}"`);
  }

  return { ok: v.length === 0, violations: v };
}

import { describe, it, expect } from "vitest";
import { lintSatelliteArticle } from "@/pipeline/gate";
import { TARGETS } from "@/lib/targets";

const equipment = TARGETS.find((t) => t.siteId === "selnet-equipment")!;
const cre = TARGETS.find((t) => t.siteId === "selnet-cre")!;

const GOOD_BODY = [
  "Equipment financing typically works like this. You apply, a lender reviews the file, and terms come back within days.",
  "",
  "Learn more in [our guide](/resources/financing-used-equipment) and [rates overview](/resources/how-equipment-loan-payments-work).",
  "",
  "Ready to move? [See your rate](/apply) today.",
].join("\n");

function article(overrides: Partial<{ title: string; excerpt: string; body: string }> = {}) {
  return { title: "How equipment financing works", excerpt: "A practical look.", body: GOOD_BODY, ...overrides };
}

describe("lintSatelliteArticle — brand independence", () => {
  it("passes a clean article", () => {
    expect(lintSatelliteArticle(article(), equipment).ok).toBe(true);
  });
  it("fails on any sister brand mention", () => {
    for (const leak of [
      "As seen on SBA Loan Options.",
      "Part of the Selective Capital network.",
      "Our sister desk Relief Capital helps too.",
      "Compare with FlexCreditLine offers.",
      "Check tempo for MCA relief.",
      "Visit sbaloanoptions.com for more.",
      "hosted at tempo-mca.vercel.app",
    ]) {
      const r = lintSatelliteArticle(article({ body: `${GOOD_BODY}\n\n${leak}` }), equipment);
      expect(r.ok, leak).toBe(false);
    }
  });
  it("does NOT fail on the target's own brand", () => {
    const r = lintSatelliteArticle(article({ body: `${GOOD_BODY}\n\nEquipment Capital reviews every file.` }), equipment);
    expect(r.ok).toBe(true);
  });
  it("does not false-positive 'tempo' inside other words", () => {
    const r = lintSatelliteArticle(article({ body: `${GOOD_BODY}\n\nA contemporary temporary fix.` }), equipment);
    expect(r.ok).toBe(true);
  });
});

describe("lintSatelliteArticle — honesty & fabrication", () => {
  it("fails forbidden claims", () => {
    for (const claim of ["We are a direct lender.", "We lend from our own capital.", "Guaranteed approval today."]) {
      expect(lintSatelliteArticle(article({ body: `${GOOD_BODY}\n\n${claim}` }), equipment).ok).toBe(false);
    }
  });
  it("fails fabrication tells", () => {
    for (const tell of ["One of our clients saved $50,000.", "We've funded $2 million this year."]) {
      expect(lintSatelliteArticle(article({ body: `${GOOD_BODY}\n\n${tell}` }), equipment).ok).toBe(false);
    }
  });
  it("fails placeholder junk", () => {
    expect(lintSatelliteArticle(article({ body: `${GOOD_BODY}\n\n[insert stat here]` }), equipment).ok).toBe(false);
  });
});

describe("lintSatelliteArticle — structure", () => {
  it("fails when the CTA link is missing", () => {
    const noCta = GOOD_BODY.replace("[See your rate](/apply)", "See your rate");
    expect(lintSatelliteArticle(article({ body: noCta }), equipment).ok).toBe(false);
  });
  it("fails on absolute URLs to non-allowlisted hosts", () => {
    const r = lintSatelliteArticle(
      article({ body: `${GOOD_BODY}\n\nSee [this](https://www.equipmentcapital.biz/rates) and [that](https://random-blog.com/x).` }),
      equipment
    );
    // own host allowed, random-blog.com not
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/random-blog\.com/);
  });
  it("uses the target's own cta path (cre = /apply under /insights base)", () => {
    const creBody = GOOD_BODY.replace(/\/resources\//g, "/insights/");
    expect(lintSatelliteArticle(article({ body: creBody }), cre).ok).toBe(true);
  });
});

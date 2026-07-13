/**
 * Satellite blog targets. Single source of truth for the per-brand runs.
 *
 * INDEPENDENCE RULE: each persona speaks ONLY as its own brand. No sister
 * brands, no network mentions — the gate (src/pipeline/gate.ts) hard-fails
 * any leak. IndexNow keys are the public key-file names already served from
 * each site's /<key>.txt.
 */
import type { NicheConfig } from "./niche";

export interface SatelliteTarget {
  siteId: "selnet-equipment" | "selnet-loc" | "selnet-cre";
  brandName: string;
  siteUrl: string;
  host: string;
  blogBasePath: "/resources" | "/insights";
  ctaPath: "/apply";
  persona: string;
  ownBrandTerms: string[];
  niches: NicheConfig[];
  cornerstones: { title: string; slug: string }[];
  indexNowKey: string;
  defaultCategory: string;
}

const HONESTY_LINES =
  "You are an independent funding desk, NOT a lender: you match each file across the lenders you work with, and one person owns the file start to finish. NEVER claim to lend your own money, hold capital, or guarantee approval. Never mention any other funding brand or website by name.";

export const TARGETS: SatelliteTarget[] = [
  {
    siteId: "selnet-equipment",
    brandName: "Equipment Capital",
    siteUrl: "https://www.equipmentcapital.biz",
    host: "www.equipmentcapital.biz",
    blogBasePath: "/resources",
    ctaPath: "/apply",
    persona:
      `You are the founder of Equipment Capital, an independent equipment-financing desk in Boca Raton, FL. You help small businesses finance machinery, vehicles, and equipment — new, used, and at auction — through a vetted network of equipment lenders. Plainspoken, practical, numbers-literate; never salesy. ${HONESTY_LINES}`,
    ownBrandTerms: ["equipment capital", "equipmentcapital"],
    niches: [
      {
        slug: "equipment-financing",
        displayName: "Equipment Financing",
        keywords: [
          "equipment financing", "equipment loan", "heavy equipment loan",
          "finance used equipment", "equipment loan rates", "equipment financing bad credit",
          "semi truck financing", "construction equipment financing", "equipment lease vs loan",
          // GSC-derived 2026-07-13: queries already earning impressions for this domain
          "restaurant equipment financing", "equipment financing for startups",
          "capital equipment costs", "capital equipment finance", "used capital equipment",
        ],
        subreddits: ["smallbusiness", "Entrepreneur", "Construction"],
        paaSeeds: [
          "how does equipment financing work",
          "what credit score do I need to finance equipment",
          "can I finance used equipment for my business",
          // GSC-derived 2026-07-13
          "how to finance restaurant equipment",
          "can a startup get equipment financing",
          "how much does capital equipment cost",
        ],
        youtubeSearches: ["equipment financing explained", "how to finance construction equipment"],
        ctaPath: "/apply",
        imagePool: [],
      },
      {
        slug: "equipment-tax-strategy",
        displayName: "Equipment Tax Strategy",
        keywords: [
          "section 179", "bonus depreciation", "equipment tax deduction",
          "depreciation equipment", "section 179 vehicles", "year end equipment purchase",
          "equipment write off",
        ],
        subreddits: ["smallbusiness", "tax"],
        paaSeeds: [
          "how does Section 179 work",
          "what equipment qualifies for Section 179",
          "is it better to lease or buy equipment for taxes",
        ],
        youtubeSearches: ["section 179 explained", "equipment tax deduction small business"],
        ctaPath: "/apply",
        imagePool: [],
      },
    ],
    cornerstones: [
      { title: "Section 179: How to Write Off Your Equipment in 2026", slug: "section-179-write-off-equipment" },
      { title: "Lease vs. Loan: Which Is Cheaper for Equipment?", slug: "lease-vs-loan-equipment" },
      { title: "How to Finance Used Equipment in 2026", slug: "financing-used-equipment" },
      { title: "Equipment Financing by Industry: Machinery, Vehicles, Restaurant & More", slug: "equipment-financing-by-industry" },
      { title: "How Much Equipment Can a Small Business Finance?", slug: "how-much-equipment-can-you-finance" },
      { title: "What Credit Score Do You Need for Equipment Financing?", slug: "equipment-financing-credit-requirements" },
      { title: "How Equipment Loan Payments Actually Work", slug: "how-equipment-loan-payments-work" },
      { title: "Financing Equipment You're Buying at Auction", slug: "buying-equipment-at-auction" },
    ],
    indexNowKey: "5a94a0ce813bea5fb0a42a8fac5d30b9",
    defaultCategory: "Guides",
  },
  {
    siteId: "selnet-loc",
    brandName: "FlexCreditLine",
    siteUrl: "https://www.flexcreditline.biz",
    host: "www.flexcreditline.biz",
    blogBasePath: "/resources",
    ctaPath: "/apply",
    persona:
      `You are the founder of FlexCreditLine, an independent business line-of-credit desk in Boca Raton, FL. You help small businesses set up revolving credit lines for working capital, payroll, inventory, and seasonal cash-flow swings through a vetted network of credit-line lenders. Plainspoken, practical; never salesy. ${HONESTY_LINES}`,
    ownBrandTerms: ["flexcreditline", "flex credit line"],
    niches: [
      {
        slug: "business-line-of-credit",
        displayName: "Business Line of Credit",
        keywords: [
          "business line of credit", "business credit line", "revolving credit business",
          "line of credit requirements", "line of credit vs loan", "draw on line of credit",
          "business line of credit rates", "unsecured business line of credit",
        ],
        subreddits: ["smallbusiness", "Entrepreneur"],
        paaSeeds: [
          "how does a business line of credit work",
          "what do I need to qualify for a business line of credit",
          "is a line of credit better than a loan for a small business",
        ],
        youtubeSearches: ["business line of credit explained", "how to get a business line of credit"],
        ctaPath: "/apply",
        imagePool: [],
      },
      {
        slug: "working-capital-cash-flow",
        displayName: "Working Capital & Cash Flow",
        keywords: [
          "working capital", "cash flow management small business", "seasonal cash flow",
          "payroll funding", "cover slow season", "short term business funding",
          "inventory financing",
        ],
        subreddits: ["smallbusiness", "Entrepreneur"],
        paaSeeds: [
          "how do I cover payroll in a slow month",
          "what is working capital financing",
          "how much working capital does my business need",
        ],
        youtubeSearches: ["working capital explained", "small business cash flow management"],
        ctaPath: "/apply",
        imagePool: [],
      },
    ],
    cornerstones: [
      { title: "Line of Credit vs. Term Loan: Which Fits Your Business?", slug: "line-of-credit-vs-term-loan" },
      { title: "How Business Line-of-Credit Interest Actually Works", slug: "how-line-of-credit-interest-works" },
      { title: "When to Draw on Your Credit Line — and When to Wait", slug: "when-to-draw-on-your-line" },
      { title: "How Lenders Decide Your Credit Limit", slug: "how-lenders-set-your-limit" },
      { title: "5 Smart Ways to Use a Business Line of Credit", slug: "smart-ways-to-use-a-business-line-of-credit" },
      { title: "What Lenders Actually Look At Before Approving a Line", slug: "business-line-of-credit-requirements" },
      { title: "Line of Credit Fees, Explained Honestly", slug: "line-of-credit-fees-explained" },
      { title: "A Line of Credit Playbook for Seasonal Cash Flow", slug: "seasonal-business-cash-flow-playbook" },
    ],
    indexNowKey: "c50a1787d066a2616eb9df9d7a4b1db1",
    defaultCategory: "Guides",
  },
  {
    siteId: "selnet-cre",
    brandName: "EquityBridge",
    siteUrl: "https://www.equitybridge.biz",
    host: "www.equitybridge.biz",
    blogBasePath: "/insights",
    ctaPath: "/apply",
    persona:
      `You are the founder of EquityBridge, an independent commercial real estate financing desk in Boca Raton, FL. You help property owners and investors structure commercial mortgages, bridge loans, and refinances through a vetted network of CRE capital sources. Analytical, direct, underwriter-minded; never salesy. ${HONESTY_LINES}`,
    ownBrandTerms: ["equitybridge", "equity bridge"],
    niches: [
      {
        slug: "commercial-mortgages",
        displayName: "Commercial Mortgages",
        keywords: [
          "commercial mortgage", "commercial real estate loan", "owner occupied commercial loan",
          "commercial mortgage rates", "dscr loan", "commercial property loan requirements",
          "commercial refinance",
        ],
        subreddits: ["CommercialRealEstate", "realestateinvesting"],
        paaSeeds: [
          "how do commercial mortgages work",
          "what is DSCR on a commercial loan",
          "how much down payment do I need for commercial property",
        ],
        youtubeSearches: ["commercial real estate loans explained", "dscr loan explained"],
        ctaPath: "/apply",
        imagePool: [],
      },
      {
        slug: "bridge-financing",
        displayName: "Bridge Financing",
        keywords: [
          "bridge loan real estate", "bridge financing", "hard money vs bridge loan",
          "refinance balloon commercial", "value add financing", "cre bridge lender",
          "loan maturity commercial",
        ],
        subreddits: ["CommercialRealEstate", "realestateinvesting"],
        paaSeeds: [
          "how does a bridge loan work for commercial property",
          "when should I use a bridge loan",
          "what happens when my commercial loan matures",
        ],
        youtubeSearches: ["bridge loans explained", "commercial bridge financing"],
        ctaPath: "/apply",
        imagePool: [],
      },
    ],
    cornerstones: [
      { title: "How a commercial mortgage actually gets underwritten", slug: "how-lenders-underwrite-commercial-mortgages" },
      { title: "Bridge vs. permanent financing: when speed beats rate", slug: "bridge-vs-permanent-financing" },
      { title: "DSCR explained: the one ratio that decides your loan", slug: "dscr-explained" },
      { title: "LTV, LTC, and how much leverage you can really get", slug: "ltv-ltc-leverage-explained" },
      { title: "The 2025–26 maturity wall: what it means for property owners", slug: "cre-maturity-wall" },
      { title: "SBA 504 vs conventional for owner-occupied property", slug: "sba-504-vs-conventional" },
      { title: "How to close a CRE loan in weeks, not months", slug: "close-cre-loan-faster" },
      { title: "What lenders look for in a value-add multifamily deal", slug: "value-add-multifamily-financing" },
      { title: "Commercial mortgage rates in 2026: what's driving them", slug: "commercial-mortgage-rates-2026" },
      { title: "Reading a rent roll the way an underwriter does", slug: "reading-a-rent-roll-like-an-underwriter" },
    ],
    indexNowKey: "af6f392d5097575e926083f033a05cc2",
    defaultCategory: "Insights",
  },
];

export function getTarget(siteId: string): SatelliteTarget | undefined {
  return TARGETS.find((t) => t.siteId === siteId);
}

/**
 * The scraper's focus niches. Single source of truth.
 *
 * All 4 niches are mined every day; candidates are ASSIGNED to their
 * best-matching niche by embedding similarity (argmax), so these keyword
 * lists define the centroids. imagePool entries are UploadThing URLs the
 * user uploads once; empty pool falls back to DEFAULT_COVER_IMAGE env.
 */

export interface NicheConfig {
  slug: string;
  displayName: string;
  keywords: string[];
  subreddits: string[];
  paaSeeds: string[];
  youtubeSearches: string[];
  ctaPath: "/apply" | "/instant-quote";
  imagePool: string[];
}

export const NICHES: NicheConfig[] = [
  {
    slug: "mca-debt-relief",
    displayName: "MCA Debt Relief",
    keywords: [
      "merchant cash advance",
      "mca",
      "daily ach payment",
      "cash advance debt",
      "mca refinance",
      "mca consolidation",
      "mca default",
      "mca relief",
      "stop mca",
      "stuck in mca",
      "mca lawsuit",
    ],
    subreddits: ["smallbusiness", "Entrepreneur", "EntrepreneurRideAlong", "MerchantCashAdvance"],
    paaSeeds: [
      "how do I refinance MCA debt",
      "what happens after MCA default",
      "can MCA debt be consolidated",
    ],
    youtubeSearches: ["merchant cash advance horror story", "mca debt help", "stuck with daily mca payments"],
    ctaPath: "/apply",
    imagePool: [],
  },
  {
    slug: "sba-loan-denial",
    displayName: "SBA Loan Denial",
    keywords: [
      "sba loan denied",
      "sba loan denial",
      "denied sba loan",
      "sba loan declined",
      "sba denial reasons",
      "reapply sba loan",
      "sba loan alternatives",
      "business loan denied",
      "sba 7a denied",
      "loan denial letter",
    ],
    subreddits: ["smallbusiness", "Entrepreneur", "sba"],
    paaSeeds: [
      "why was my SBA loan denied",
      "what to do after SBA loan denial",
      "can I reapply after SBA denial",
    ],
    youtubeSearches: ["sba loan denied what next", "sba loan denial reasons"],
    ctaPath: "/instant-quote",
    imagePool: [],
  },
  {
    slug: "working-capital",
    displayName: "Working Capital",
    keywords: [
      "working capital loan",
      "business cash flow",
      "short term business loan",
      "bridge loan business",
      "fast business funding",
      "business funding options",
      "revenue based financing",
      "invoice factoring",
      "payroll funding",
      "emergency business loan",
    ],
    subreddits: ["smallbusiness", "Entrepreneur"],
    paaSeeds: [
      "how to get fast working capital",
      "best short term business loans",
      "what is revenue based financing",
    ],
    youtubeSearches: ["working capital loan explained", "fast business funding options"],
    ctaPath: "/instant-quote",
    imagePool: [],
  },
  {
    slug: "equipment-loc-basics",
    displayName: "Equipment & LOC Basics",
    keywords: [
      "equipment financing",
      "equipment loan",
      "heavy equipment loan",
      "business line of credit",
      "revolving credit business",
      "equipment lease vs buy",
      "line of credit vs loan",
      "equipment loan rates",
      "startup equipment financing",
      "secured line of credit",
    ],
    subreddits: ["smallbusiness", "Entrepreneur"],
    paaSeeds: [
      "how does equipment financing work",
      "business line of credit requirements",
      "equipment lease vs loan which is better",
    ],
    youtubeSearches: ["equipment financing explained", "business line of credit basics"],
    ctaPath: "/apply",
    imagePool: [],
  },
];

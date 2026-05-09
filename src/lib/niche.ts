/**
 * The current focus niche for the scraper. Single source of truth.
 *
 * Changing this is a one-line PR + redeploy. Old BlogDraft rows keep their
 * original niche label for posterity (the niche field on BlogDraft is
 * frozen at generation time).
 */

export interface NicheConfig {
  slug: string;
  displayName: string;
  keywords: string[];
  subreddits: string[];
  paaSeeds: string[];
  youtubeSearches: string[];
}

export const CURRENT_NICHE: NicheConfig = {
  slug: "mca-consolidation",
  displayName: "MCA Consolidation",

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

  subreddits: [
    "smallbusiness",
    "Entrepreneur",
    "EntrepreneurRideAlong",
    "MerchantCashAdvance",
  ],

  paaSeeds: [
    "how do I refinance MCA debt",
    "what happens after MCA default",
    "can MCA debt be consolidated",
    "best MCA alternatives",
    "stop MCA daily payments",
  ],

  youtubeSearches: [
    "merchant cash advance horror story",
    "mca debt help",
    "stuck with daily mca payments",
  ],
};

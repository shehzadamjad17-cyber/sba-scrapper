/**
 * Shared types between source adapters and the pipeline.
 */

import type { NicheConfig } from "@/lib/niche";

export type SourceType = "reddit" | "google_paa" | "youtube" | "google_autocomplete";

export interface CandidateQuestion {
  sourceType: SourceType;
  sourceUrl: string;             // permalink to the original
  questionText: string;          // verbatim
  contextSnippet: string;        // surrounding text for the LLM prompt
  engagement: number;            // upvotes / likes / reply count
  capturedAt: Date;
}

export interface AdapterResult {
  questions: CandidateQuestion[];
  errors: string[];              // non-fatal errors to record in adapterStats
}

export interface SourceAdapter {
  sourceType: SourceType;
  sourceWeight: number;          // 1.0 reddit, 1.5 paa, 1.2 autocomplete, 0.7 youtube
  /** Mine ALL niches in one call so heavyweight resources (e.g. the PAA browser) are shared. */
  fetchQuestions(niches: NicheConfig[]): Promise<AdapterResult>;
}

/**
 * Shared types between source adapters and the pipeline.
 */

import type { NicheConfig } from "@/lib/niche";

export type SourceType = "reddit" | "google_paa" | "youtube";

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
  sourceWeight: number;          // 1.0 (reddit), 1.5 (paa), 0.7 (youtube)
  fetchQuestions(niche: NicheConfig): Promise<AdapterResult>;
}

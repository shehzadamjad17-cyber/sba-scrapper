/**
 * Insert a BlogDraft row from a generated outline + the original winning candidate,
 * then update the open ScraperRun row with status="succeeded" + draftId + topScore.
 */
import { prisma } from "@/lib/db";
import type { ScoredCandidate } from "./score";
import type { ResolvedOutline } from "./outline";
import type { NicheConfig } from "@/lib/niche";

export async function persistDraft(opts: {
  scraperRunId: string;
  winner: ScoredCandidate;
  outline: ResolvedOutline;
  niche: NicheConfig;
}): Promise<{ draftId: string }> {
  const { scraperRunId, winner, outline, niche } = opts;

  const draft = await prisma.blogDraft.create({
    data: {
      sourceType: winner.candidate.sourceType,
      sourceUrl: winner.candidate.sourceUrl,
      sourceQuestion: winner.candidate.questionText,
      niche: niche.displayName,
      title: outline.title,
      titleVariants: JSON.stringify(outline.titleVariants),
      clearAnswer: outline.clearAnswer,
      bodyOutline: outline.bodyOutline,
      comparisonTable: JSON.stringify(outline.comparisonTable),
      faqSection: JSON.stringify(outline.faqSection),
      internalLinks: JSON.stringify(outline.internalLinks),
      ctaBlock: outline.ctaBlock,
      imagePrompt: outline.imagePrompt,
      intentScore: winner.intentScore,
      nicheMatch: winner.nicheMatch,
      totalScore: winner.totalScore,
      llmModel: outline.llmModel,
      llmPromptVersion: outline.llmPromptVersion,
      llmResponseRaw: outline.llmResponseRaw,
    },
  });

  await prisma.scraperRun.update({
    where: { id: scraperRunId },
    data: {
      completedAt: new Date(),
      status: "succeeded",
      draftId: draft.id,
      topScore: winner.totalScore,
    },
  });

  return { draftId: draft.id };
}

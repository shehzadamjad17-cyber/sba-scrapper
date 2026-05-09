/**
 * Send a Resend email when a ScraperRun ends in status=failed.
 *
 * Quiet on status=succeeded (obviously) and status=no_question_picked
 * (expected per the playbook — never spam Joe with "no draft today" emails).
 */
import { Resend } from "resend";
import { logger } from "@/lib/logger";

export async function sendFailureAlert(opts: {
  niche: string;
  errorMessage: string;
  scraperRunId: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.SCRAPER_ALERT_EMAIL;

  if (!apiKey || !to) {
    logger.warn("Cannot send failure alert — missing RESEND_API_KEY or SCRAPER_ALERT_EMAIL");
    return;
  }

  const resend = new Resend(apiKey);
  try {
    await resend.emails.send({
      from: "SBA Content Scraper <noreply@sbaloanoptions.com>",
      to,
      subject: `Daily scraper run failed — niche=${opts.niche}`,
      html: `
        <p>Today's scraper run did not complete successfully.</p>
        <p><strong>Niche:</strong> ${opts.niche}</p>
        <p><strong>ScraperRun id:</strong> <code>${opts.scraperRunId}</code></p>
        <p><strong>Error:</strong></p>
        <pre style="background:#f4f4f4;padding:10px;border-radius:4px;font-size:13px;">${escapeHtml(opts.errorMessage)}</pre>
        <p>Check the Vercel function logs for the sba-content-scraper project for the full stack trace.</p>
      `,
    });
    logger.info("Failure alert sent", { to, scraperRunId: opts.scraperRunId });
  } catch (err) {
    logger.error("Failed to send failure alert", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

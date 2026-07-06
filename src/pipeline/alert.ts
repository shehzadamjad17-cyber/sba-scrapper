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

export interface DigestArticle {
  title: string;
  niche: string;
  totalScore: number;
  blogPostId: string;
  slug: string;
}

export function buildDigestHtml(articles: DigestArticle[]): string {
  const base = (process.env.SITE_PUBLIC_URL ?? "").replace(/\/$/, "");
  const rows = articles
    .map(
      (a) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">
          <strong>${escapeHtml(a.title)}</strong><br/>
          <span style="color:#666;font-size:12px;">${escapeHtml(a.niche)} · score ${a.totalScore.toFixed(2)}</span>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;">
          <a href="${base}/admin/blog/${a.blogPostId}/edit">Review &amp; publish</a><br/>
          <a href="${base}/blog/${a.slug}?preview=1" style="font-size:12px;">Preview</a>
        </td>
      </tr>`
    )
    .join("");
  return `
    <p>The scraper created <strong>${articles.length}</strong> draft article(s) ready for review:</p>
    <table style="border-collapse:collapse;width:100%;">${rows}</table>
    <p style="color:#666;font-size:12px;">Review each draft, adjust anything you like, and click Publish.</p>
  `;
}

export async function sendSuccessDigest(articles: DigestArticle[]): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.SCRAPER_ALERT_EMAIL;
  if (!apiKey || !to) {
    logger.warn("Cannot send success digest — missing RESEND_API_KEY or SCRAPER_ALERT_EMAIL");
    return;
  }
  const resend = new Resend(apiKey);
  try {
    await resend.emails.send({
      from: "SBA Content Scraper <noreply@sbaloanoptions.com>",
      to,
      subject: `[scraper] ${articles.length} draft(s) ready for review`,
      html: buildDigestHtml(articles),
    });
    logger.info("Success digest sent", { to, count: articles.length });
  } catch (err) {
    logger.error("Failed to send success digest", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

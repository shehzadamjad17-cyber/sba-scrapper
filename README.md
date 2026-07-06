# SBA Content Scraper

A daily cron job that mines buying-intent questions from Reddit + Google PAA + YouTube comments across 4 niches (MCA Debt Relief, SBA Loan Denial, Working Capital, Equipment & LOC Basics), scores them, dedup-filters against recent posts, and uses Gemini 2.5 Flash to generate full-article drafts (up to 3/day). Drafts land as `BlogDraft` rows linked to matching `BlogPost` records in the `sba-ebsite` Turso DB for human review and promotion to published.

## Architecture

See the design spec at `sba-ebsite/docs/superpowers/specs/2026-05-09-content-scraper-question-miner-design.md`.

## Local development

```bash
cp .env.local.example .env.local       # fill in real values
npm install
npm run build                          # type-check + prisma generate
npm run dryrun                         # run the pipeline locally without writing to prod
```

## Environment variables

See `.env.local.example` for the full list. Lead-engine rewire (2026-07) additions:

- `SCRAPER_AUTHOR_ID` — Admin `User.id` on the main site; author for scraper-created `BlogPost` drafts.
- `SITE_PUBLIC_URL` — Main site origin, used for digest email links (no trailing slash).
- `DEFAULT_COVER_IMAGE` — Fallback cover image (UploadThing URL) when a niche `imagePool` is empty.

## Deployment

This project is deployed as a separate Vercel Pro project. Daily cron at 6 AM EST hits `/api/cron/daily`. Cron secret is auto-injected by Vercel; manual triggers must include `Authorization: Bearer ${CRON_SECRET}`.

## Niche configuration

Edit `src/lib/niche.ts` to change which keywords / subreddits / PAA seeds / YouTube searches are monitored. Niche changes are a one-line PR + redeploy.

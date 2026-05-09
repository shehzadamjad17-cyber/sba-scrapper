# SBA Content Scraper

A daily cron job that mines buying-intent questions from Reddit + Google PAA + YouTube comments scoped to the current niche (default: MCA Consolidation), scores them, dedup-filters against recent posts, and uses Gemini 2.5 Flash to generate a structured outline draft. Drafts land in the `BlogDraft` table of the `sba-ebsite` Turso DB for human review and promotion to published `BlogPost`.

## Architecture

See the design spec at `sba-ebsite/docs/superpowers/specs/2026-05-09-content-scraper-question-miner-design.md`.

## Local development

```bash
cp .env.local.example .env.local       # fill in real values
npm install
npm run build                          # type-check + prisma generate
npm run dryrun                         # run the pipeline locally without writing to prod
```

## Deployment

This project is deployed as a separate Vercel Pro project. Daily cron at 6 AM EST hits `/api/cron/daily`. Cron secret is auto-injected by Vercel; manual triggers must include `Authorization: Bearer ${CRON_SECRET}`.

## Niche configuration

Edit `src/lib/niche.ts` to change which keywords / subreddits / PAA seeds / YouTube searches are monitored. Niche changes are a one-line PR + redeploy.

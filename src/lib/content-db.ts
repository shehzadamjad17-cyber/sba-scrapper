/**
 * Writer/reader for the shared network-content Turso DB (GeneratedPost).
 * Raw @libsql/client — NO Prisma (separate DB from the main-site schema).
 * All functions accept an injectable ExecuteFn for tests.
 */
import { createClient, type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";

export interface GeneratedPostInsert {
  site: string;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  category: string;
  status: "published" | "draft";
  qualityNotes: string;
  sourceQuestion: string;
  llmModel: string;
}

export type ExecuteFn = (
  sql: string,
  args: (string | number | null)[]
) => Promise<{ rows: Record<string, unknown>[] }>;

let cached: Client | null = null;

export function contentExecute(): ExecuteFn {
  const url = process.env.CONTENT_DATABASE_URL;
  const authToken = process.env.CONTENT_DATABASE_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error("CONTENT_DATABASE_URL / CONTENT_DATABASE_AUTH_TOKEN not configured");
  }
  if (!cached) cached = createClient({ url, authToken });
  const client = cached;
  return async (sql, args) => {
    const res = await client.execute({ sql, args });
    return { rows: res.rows as unknown as Record<string, unknown>[] };
  };
}

const MAX_SLUG_ATTEMPTS = 10;

export async function resolveSiteSlug(
  site: string,
  base: string,
  execute: ExecuteFn = contentExecute(),
  reserved?: string[]
): Promise<string> {
  const reservedSet = new Set(reserved ?? []);
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    if (reservedSet.has(slug)) continue;
    const res = await execute(`SELECT id FROM GeneratedPost WHERE site = ? AND slug = ? LIMIT 1`, [site, slug]);
    if (res.rows.length === 0) return slug;
  }
  throw new Error(`No free slug for "${base}" on ${site} after ${MAX_SLUG_ATTEMPTS} attempts`);
}

export async function insertGeneratedPost(
  p: GeneratedPostInsert,
  execute: ExecuteFn = contentExecute()
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const publishedAt = p.status === "published" ? now : null;
  await execute(
    `INSERT INTO GeneratedPost
      (id, site, slug, title, excerpt, content, category, coverImage, status,
       qualityNotes, sourceQuestion, llmModel, createdAt, publishedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
    [id, p.site, p.slug, p.title, p.excerpt, p.content, p.category, p.status,
     p.qualityNotes, p.sourceQuestion, p.llmModel, now, publishedAt]
  );
  return { id, slug: p.slug };
}

const RECENT_DAYS = 60;

export async function fetchRecentSiteTitles(
  site: string,
  execute: ExecuteFn = contentExecute()
): Promise<string[]> {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const res = await execute(
    `SELECT title FROM GeneratedPost WHERE site = ? AND createdAt >= ?`,
    [site, cutoff]
  );
  return Array.from(new Set(res.rows.map((r) => String(r.title))));
}

export async function fetchPublishedSitePosts(
  site: string,
  execute: ExecuteFn = contentExecute()
): Promise<{ title: string; slug: string }[]> {
  const res = await execute(
    `SELECT title, slug FROM GeneratedPost WHERE site = ? AND status = 'published' ORDER BY publishedAt DESC LIMIT 50`,
    [site]
  );
  return res.rows.map((r) => ({ title: String(r.title), slug: String(r.slug) }));
}

export async function getPostById(
  id: string,
  execute: ExecuteFn = contentExecute()
): Promise<{ id: string; site: string; slug: string; title: string; status: string } | null> {
  const res = await execute(
    `SELECT id, site, slug, title, status FROM GeneratedPost WHERE id = ? LIMIT 1`,
    [id]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: String(r.id), site: String(r.site), slug: String(r.slug),
    title: String(r.title), status: String(r.status),
  };
}

export async function setPostStatus(
  id: string,
  status: string,
  execute: ExecuteFn = contentExecute()
): Promise<{ site: string; slug: string; title: string } | null> {
  const existing = await execute(
    `SELECT id, site, slug, title, status FROM GeneratedPost WHERE id = ? LIMIT 1`,
    [id]
  );
  if (existing.rows.length === 0) return null;
  await execute(`UPDATE GeneratedPost SET status = ? WHERE id = ?`, [status, id]);
  const r = existing.rows[0];
  return { site: String(r.site), slug: String(r.slug), title: String(r.title) };
}

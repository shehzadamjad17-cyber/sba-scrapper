import { createHmac, timingSafeEqual } from "node:crypto";

function secretOrThrow(secret?: string): string {
  const s = secret ?? process.env.UNPUBLISH_SECRET;
  if (!s) throw new Error("UNPUBLISH_SECRET not configured");
  return s;
}

export function signUnpublishToken(postId: string, secret?: string): string {
  return createHmac("sha256", secretOrThrow(secret)).update(postId).digest("hex");
}

export function verifyUnpublishToken(postId: string, token: string, secret?: string): boolean {
  if (!token) return false;
  const expected = signUnpublishToken(postId, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildUnpublishUrl(postId: string): string {
  const base = (process.env.SCRAPER_PUBLIC_URL ?? "").replace(/\/$/, "");
  return `${base}/api/unpublish?id=${encodeURIComponent(postId)}&token=${signUnpublishToken(postId)}`;
}

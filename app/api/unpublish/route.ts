import { NextRequest, NextResponse } from "next/server";
import { verifyUnpublishToken } from "@/lib/unpublish-token";
import { getPostById, setPostStatus } from "@/lib/content-db";

export const runtime = "nodejs";

function page(body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html><body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 20px;">${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!id || !verifyUnpublishToken(id, token)) return page("<h2>Invalid or expired link.</h2>", 403);

  const post = await getPostById(id);
  if (!post) return page("<h2>Post not found.</h2>", 404);
  if (post.status !== "published") return page(`<h2>Already ${post.status}.</h2><p>${post.title}</p>`);

  return page(`
    <h2>Unpublish this post?</h2>
    <p><strong>${post.title}</strong><br/><code>${post.site} / ${post.slug}</code></p>
    <form method="POST" action="/api/unpublish?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}">
      <button type="submit" style="background:#c00;color:#fff;border:0;padding:12px 24px;border-radius:6px;font-size:16px;cursor:pointer;">
        Yes, unpublish now
      </button>
    </form>
    <p style="color:#666;font-size:13px;">It disappears from the site and sitemap within ~5 minutes.</p>
  `);
}

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!id || !verifyUnpublishToken(id, token)) return page("<h2>Invalid or expired link.</h2>", 403);

  const result = await setPostStatus(id, "unpublished");
  if (!result) return page("<h2>Post not found.</h2>", 404);
  return page(`<h2>Unpublished ✓</h2><p><strong>${result.title}</strong> is off ${result.site} (live within ~5 minutes).</p>`);
}

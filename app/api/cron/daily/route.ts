/**
 * Daily cron entrypoint. Vercel cron hits this URL once per day at 6 AM EST.
 *
 * Authorization header is auto-injected by Vercel cron. We validate it
 * against CRON_SECRET so nobody else can manually trigger the pipeline.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }
  if (authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pipeline orchestrator wired in Task 13
  return NextResponse.json({
    ok: true,
    message: "Cron route ready; pipeline not yet wired",
  });
}

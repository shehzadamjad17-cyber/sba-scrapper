import { NextRequest, NextResponse } from "next/server";
import { runDaily } from "@/cron/runDaily";

export const runtime = "nodejs";
// 300 seconds = Vercel Pro limit. The scoring step makes a Gemini micro-call
// per candidate (~85 candidates × 1-2s each = 85-170s) which exceeds the
// Hobby 60s ceiling. Pro plan is required.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runDaily();
  return NextResponse.json(result);
}

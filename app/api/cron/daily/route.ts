import { NextRequest, NextResponse } from "next/server";
import { runDaily } from "@/cron/runDaily";

export const runtime = "nodejs";
// 300 seconds — Vercel Pro. The run mines 4 niches, makes ~12-18 batched
// Gemini calls, and generates up to 3 full articles in parallel (~2-3.5 min).
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

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const maxRaw = parseInt(url.searchParams.get("max") ?? "", 10);
  const max = Number.isFinite(maxRaw) ? maxRaw : undefined;

  const result = await runDaily({ dryRun, max });
  return NextResponse.json(result);
}

import { NextRequest, NextResponse } from "next/server";
import { runDaily } from "@/cron/runDaily";
import { runSatellites } from "@/cron/runSatellites";

export const runtime = "nodejs";
// 300 seconds — Vercel Pro. Main run (~2-3.5 min at worst) + 3 sequential
// satellite targets (~30-45s each). Satellites are skippable via ?satellites=0.
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
  const skipSatellites = url.searchParams.get("satellites") === "0";
  const skipMain = url.searchParams.get("main") === "0";
  const only = url.searchParams.get("only") ?? undefined;

  const main = skipMain ? null : await runDaily({ dryRun, max });
  const satellites = skipSatellites ? [] : await runSatellites({ dryRun, max, only });
  return NextResponse.json({ main, satellites });
}

import { NextRequest, NextResponse } from "next/server";
import { runDaily } from "@/cron/runDaily";
import { runSatellites } from "@/cron/runSatellites";

export const runtime = "nodejs";
// 300 seconds — Vercel Pro. The cron schedule (vercel.json) is split into
// FOUR separate invocations so a single request never runs main + all 3
// satellite targets together: one main-only run (?satellites=0, ~2-3.5 min
// at worst) and three satellite-only runs (?main=0&only=<siteId>, ~30-45s
// each). Ad-hoc calls without those params still run everything in one
// invocation (main + all satellites) — fine for manual/dry-run use, just
// not how the schedule invokes it.
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

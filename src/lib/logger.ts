/**
 * Tiny structured logger. Prefixes every line with `[scraper]` so it's easy
 * to filter in Vercel function logs. JSON.stringify any object args.
 */

type LogLevel = "info" | "warn" | "error";

function fmt(level: LogLevel, msg: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const ctxPart = ctx ? ` ${JSON.stringify(ctx)}` : "";
  return `[scraper] ${ts} ${level.toUpperCase()} ${msg}${ctxPart}`;
}

export const logger = {
  info(msg: string, ctx?: Record<string, unknown>) {
    console.log(fmt("info", msg, ctx));
  },
  warn(msg: string, ctx?: Record<string, unknown>) {
    console.warn(fmt("warn", msg, ctx));
  },
  error(msg: string, ctx?: Record<string, unknown>) {
    console.error(fmt("error", msg, ctx));
  },
};

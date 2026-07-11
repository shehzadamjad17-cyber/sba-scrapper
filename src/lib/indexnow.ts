/**
 * IndexNow ping — tells Bing/DuckDuckGo/Yandex/AI-search a URL changed.
 * Fire-and-forget: failures are logged, never thrown (a missed ping just
 * means the sitemap crawl picks it up later).
 */
import { logger } from "@/lib/logger";

export async function pingIndexNow(opts: { host: string; key: string; urls: string[] }): Promise<boolean> {
  if (opts.urls.length === 0) return true;
  try {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: opts.host,
        key: opts.key,
        keyLocation: `https://${opts.host}/${opts.key}.txt`,
        urlList: opts.urls,
      }),
    });
    const ok = res.status === 200 || res.status === 202;
    logger.info("IndexNow ping", { host: opts.host, urls: opts.urls.length, status: res.status });
    return ok;
  } catch (err) {
    logger.error("IndexNow ping failed", {
      host: opts.host,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

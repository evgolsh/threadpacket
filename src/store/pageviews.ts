/**
 * Page views of the control center's public pages, counted per day by page, source and country. There is no
 * row per visit and nothing that identifies a visitor: no cookie, no IP address, no user agent.
 */

/** The pages that are counted. Nothing else is: not invitations, Packets, the console, files or sign-in steps. */
export const COUNTED_PAGES: ReadonlySet<string> = new Set(["/", "/use-cases", "/join", "/connect", "/login", "/privacy", "/terms", "/contact", "/about", "/stats"]);

export interface PageView {
  path: string;
  /** The referring site's host, a ?ref= or utm_source tag, "self" for this site, or "" when there is none. */
  source: string;
  /** Cloudflare's two-character country code, or "". */
  country: string;
}

const AUTOMATED = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|python|curl|wget/i;
const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$/;
const SUBDOMAIN = /^(www|m|old|out|l|lm)\./;

/** Where a visit came from: a tag in the link wins over the Referer header, which browsers cut to the site. */
export function sourceOf(url: URL, referer: string | null, ownHost: string): string {
  const tag = (url.searchParams.get("ref") ?? url.searchParams.get("utm_source") ?? "").trim().toLowerCase();
  if (TAG.test(tag)) return tag;
  if (!referer) return "";
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return "";
  }
  const own = ownHost.toLowerCase();
  if (host === own || host.replace(SUBDOMAIN, "") === own) return "self";
  host = host.replace(SUBDOMAIN, "");
  return HOST.test(host) ? host : "";
}

/** True when the request looks like a real browser page navigation rather than a bot, script, or prefetch. */
export function isBrowserNavigation(req: Request): boolean {
  if (req.method !== "GET") return false;
  const h = req.headers;
  if (h.get("sec-fetch-mode") !== "navigate" || h.get("sec-fetch-dest") !== "document") return false;
  if (h.get("sec-purpose") || h.get("purpose")) return false;
  if (AUTOMATED.test(h.get("user-agent") ?? "")) return false;
  return true;
}

/**
 * The view a response counts as, or null. Only a browser's own page load is counted: a GET that returned an
 * HTML page, marked by the browser as a navigation to a document, not a prefetch, from a counted page.
 */
export function pageViewOf(req: Request, res: Response, ownHost: string): PageView | null {
  if (!isBrowserNavigation(req) || res.status !== 200) return null;
  if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return null;
  const url = new URL(req.url);
  if (!COUNTED_PAGES.has(url.pathname)) return null;
  const country = (req as Request & { cf?: { country?: unknown } }).cf?.country;
  return {
    path: url.pathname,
    source: sourceOf(url, req.headers.get("referer"), ownHost),
    country: typeof country === "string" && /^[A-Z][A-Z0-9]$/.test(country) ? country : "",
  };
}

/** Views counted per minute in one isolate. More are dropped, so made-up sources cannot fill the table. */
const PER_MINUTE = 600;
let minuteNow = 0;
let inMinute = 0;

/** Adds one view to its day's count. Never throws: counting must not break the page. */
export async function countPageView(db: D1Database, v: PageView, now: Date = new Date()): Promise<void> {
  const minute = Math.floor(now.getTime() / 60_000);
  if (minute !== minuteNow) {
    minuteNow = minute;
    inMinute = 0;
  }
  if (++inMinute > PER_MINUTE) return;
  try {
    await db
      .prepare(
        `INSERT INTO page_views (day, path, source, country, n) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(day, path, source, country) DO UPDATE SET n = n + 1`,
      )
      .bind(now.toISOString().slice(0, 10), v.path, v.source, v.country)
      .run();
  } catch {
    // Missing table or a D1 hiccup: the page was already served.
  }
}

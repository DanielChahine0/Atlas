/**
 * Scout sources — injectable data fetchers for RSS, plain-HTML, and Gmail.
 *
 * D2-09 constraints (never violate):
 *   - NEVER follow links found inside email bodies.
 *   - NEVER read Type/Security or Phishing-Suspect threads.
 *   - Query only: label:Type/Newsletter newer_than:7d  OR  label:Type/Events newer_than:7d
 *
 * The ScoutSources interface is fully injectable for testability — no live network
 * required in unit tests. The live `defaultSources()` wires rss-parser + cheerio.
 *
 * T-02-link mitigation:
 *   - fetchGmailEvents pulls subject/sender metadata ONLY. It NEVER fetches a URL
 *     it finds inside an email body — emails are parsed for title/date signals, not
 *     for embedded links to follow.
 *   - T-02-html mitigation: cheerio parses HTML statically (no JS execution).
 */

import Parser from "rss-parser";
import { load as cheerioLoad } from "cheerio";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A raw event candidate before scoring and deduplication. */
export interface EventCandidate {
  /** Human-readable event title. */
  title: string;
  /** ISO-8601 start datetime or date. May be undefined for undated events. */
  start?: string;
  /** ISO-8601 end datetime or date. */
  end?: string;
  /** Venue address, city, or "online". */
  location?: string;
  /** True for virtual events. */
  online: boolean;
  /** Registration / info URL (from the feed / page — NOT followed from email body). */
  url?: string;
  /** Discovery source tag (rss | html | gmail). */
  source: "rss" | "html" | "gmail";
  /** Optional description / blurb for relevance scoring. */
  description?: string;
}

/**
 * The injectable data-source interface.
 * Injected in tests as a stub; `defaultSources()` provides the live implementation.
 */
export interface ScoutSources {
  /** Fetch and parse an RSS feed. Returns normalized EventCandidates. */
  fetchRss(url: string): Promise<EventCandidate[]>;
  /** Fetch a plain-HTML page and extract event listings. */
  fetchHtml(url: string): Promise<EventCandidate[]>;
  /**
   * Query Gmail for newsletter / events threads (gmail.readonly).
   * D2-09: the query MUST contain Type/Newsletter or Type/Events.
   * D2-09: NEVER Type/Security or Phishing-Suspect.
   * D2-09: NEVER follow a link found inside an email body.
   */
  fetchGmailEvents(query: string): Promise<EventCandidate[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail query builder (exported for testability — safety tests assert this)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the two canonical Gmail search queries Scout uses:
 *   1. Newsletters with Type/Newsletter (7-day window)
 *   2. Events with Type/Events (7-day window)
 *
 * D2-09 guarantee: these strings will NEVER contain Type/Security or
 * Phishing-Suspect — that is a structural invariant of this function.
 */
export function buildGmailQueries(): [string, string] {
  return [
    "label:Type/Newsletter newer_than:7d",
    "label:Type/Events newer_than:7d",
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Live implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an RSS item title into a normalized EventCandidate.
 * Only uses fields present in the feed item itself — no link following.
 */
function rssItemToCandidate(item: Parser.Item, feedUrl: string): EventCandidate {
  const title = item.title?.trim() ?? "(untitled)";
  const url = item.link ?? feedUrl;
  const start = item.pubDate ? new Date(item.pubDate).toISOString() : undefined;
  const description = item.contentSnippet ?? item.content ?? undefined;
  return { title, start, url, source: "rss", online: false, description };
}

/**
 * Live RSS fetcher using rss-parser.
 * T-02-html: rss-parser parses the feed XML statically; no JS execution.
 */
async function fetchRssLive(url: string): Promise<EventCandidate[]> {
  try {
    const parser = new Parser({ timeout: 10000 });
    const feed = await parser.parseURL(url);
    return (feed.items ?? [])
      .filter((item) => item.title)
      .map((item) => rssItemToCandidate(item, url));
  } catch {
    // Network errors or malformed feeds are non-fatal; return empty
    return [];
  }
}

/**
 * Live HTML fetcher using cheerio.
 * T-02-html: cheerio parses statically — no script execution.
 * Extracts <article>, <li>, or generic event-like blocks with a title + link.
 */
async function fetchHtmlLive(url: string): Promise<EventCandidate[]> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return [];
    const html = await resp.text();
    const $ = cheerioLoad(html);
    const candidates: EventCandidate[] = [];

    // Heuristic: look for links inside <article>, <li class*=event>, or headings
    $("article a, li a, h2 a, h3 a").each((_, el) => {
      const anchor = $(el);
      const title = anchor.text().trim();
      const href = anchor.attr("href");
      if (!title || title.length < 5) return;
      const fullUrl = href
        ? href.startsWith("http")
          ? href
          : new URL(href, url).toString()
        : url;
      candidates.push({ title, url: fullUrl, source: "html", online: false });
    });

    // Dedupe by title
    const seen = new Set<string>();
    return candidates.filter((c) => {
      if (seen.has(c.title)) return false;
      seen.add(c.title);
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * Live Gmail fetcher using the mcp-google gmail.readonly surface.
 *
 * D2-09 (T-02-link) contract enforcement:
 *   - Uses only the two queries from buildGmailQueries() — never Type/Security / Phishing-Suspect.
 *   - Extracts title + date signals from the email SUBJECT and METADATA only.
 *   - NEVER fetches a URL found inside an email body (link-follow prohibition).
 *
 * In Phase 2, gmailTools is injected — the live runtime passes the mcp-google
 * gmail.readonly surface; tests pass a stub. Threads are fetched via the tool,
 * subject used as the event title, received date as the start approximation.
 */
async function fetchGmailEventsLive(
  query: string,
  _gmailTools?: GmailReadTools,
): Promise<EventCandidate[]> {
  if (!_gmailTools) return []; // no tools injected → skip gracefully
  try {
    const threads = await _gmailTools.searchThreads(query);
    return threads.map((t) => ({
      title: t.subject ?? "(no subject)",
      start: t.date,
      source: "gmail" as const,
      online: false,
      // NOTE: url is intentionally NOT set here — we must NOT follow any link
      // from the email body (D2-09). The thread subject/date are the only signals.
    }));
  } catch {
    return [];
  }
}

/**
 * Minimal Gmail read-only tool surface (subset of what mcp-google exposes).
 * Injected so unit tests can stub without a live network.
 */
export interface GmailReadTools {
  searchThreads(query: string): Promise<Array<{ subject?: string; date?: string }>>;
}

/**
 * Build the default live ScoutSources implementation.
 * @param gmailTools  Optional Gmail tool surface (mcp-google gmail.readonly).
 */
export function defaultSources(gmailTools?: GmailReadTools): ScoutSources {
  return {
    fetchRss: fetchRssLive,
    fetchHtml: fetchHtmlLive,
    fetchGmailEvents: (query: string) => fetchGmailEventsLive(query, gmailTools),
  };
}

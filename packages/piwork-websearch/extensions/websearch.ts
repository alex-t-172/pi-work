/**
 * piwork-websearch — gives the agent `web_search` and `fetch_url`.
 *
 * Pi ships no web search, so this fills the gap and works out of the box with no setup:
 *   - web_search: keyless by default, trying Bing then DuckDuckGo (Bing is far more tolerant
 *     of casual use — DuckDuckGo rate-limits scrapers aggressively). If a Brave Search API key
 *     is present (PIWORK_BRAVE_API_KEY, set from Piwork's settings) it uses the Brave API —
 *     the reliable path for heavier use.
 *   - fetch_url: fetch a page and return its readable text (the container has no curl, and
 *     Pi's built-in tools can't fetch), so the agent can actually read a search result.
 *
 * Dependency-free (Node's global fetch + light HTML parsing), so it bakes into the image as a
 * single file like the other built-ins.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface Result {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last, so a literal &amp;#39; isn't double-decoded
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

async function braveSearch(query: string, count: number, key: string, signal?: AbortSignal): Promise<Result[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
    signal,
  });
  if (!res.ok) throw new Error(`Brave Search returned ${res.status}`);
  const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: stripTags(r.title ?? ""),
    url: r.url ?? "",
    snippet: stripTags(r.description ?? ""),
  }));
}

// Bing wraps result URLs in a /ck/a redirect with the real URL base64url-encoded in `u=a1<…>`.
// (The href uses &amp; entities, so don't anchor on a literal ? or & before the param.)
function decodeBingUrl(href: string): string {
  const m = href.match(/u=a1([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      let b = m[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      return Buffer.from(b, "base64").toString("utf8");
    } catch { /* fall through */ }
  }
  return href;
}

async function bingSearch(query: string, count: number, signal?: AbortSignal): Promise<Result[]> {
  const res = await fetch("https://www.bing.com/search?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html" },
    signal,
  });
  if (!res.ok) throw new Error(`Bing returned ${res.status}`);
  const html = await res.text();
  const results: Result[] = [];
  // Split on the result class rather than requiring an exact <li …> shape (Bing's markup
  // varies). Each chunk holds one result: a <h2><a href=ck/a…>Title</a> plus a <p> snippet.
  const seen = new Set<string>();
  for (const chunk of html.split('class="b_algo"').slice(1)) {
    if (results.length >= count) break;
    const a = chunk.match(/<h2[^>]*>[\s\S]*?<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decodeBingUrl(a[1]);
    if (!/^https?:\/\//.test(url) || url.includes("bing.com/ck/a") || seen.has(url)) continue;
    seen.add(url);
    const p = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title: stripTags(a[2]), url, snippet: p ? stripTags(p[1]) : "" });
  }
  return results;
}

async function duckSearch(query: string, count: number, signal?: AbortSignal): Promise<Result[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: `q=${encodeURIComponent(query)}`,
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  const html = await res.text();
  const results: Result[] = [];
  // Each result: <a class="result__a" href="//duckduckgo.com/l/?uddg=<enc>">Title</a> … <a class="result__snippet">Snippet</a>
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]));
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) && results.length < count) {
    const href = lm[1];
    // Real results are wrapped in a redirect: //duckduckgo.com/l/?uddg=<encoded real url>.
    // Only accept those — a rate-limit/nav page's plain duckduckgo.com links aren't results.
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (!uddg) { i++; continue; }
    const url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) { i++; continue; }
    results.push({ title: stripTags(lm[2]), url, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web for results (title, URL, snippet) — current info, docs, anything outside the workspace. Use `fetch_url` to read a result's page.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        count: { type: "number", description: "How many results to return (default 6, max 10)." },
      },
      required: ["query"],
    } as never,
    execute: async (_id, params, signal) => {
      const p = params as { query: string; count?: number };
      const count = Math.max(1, Math.min(10, p.count ?? 6));
      const key = process.env.PIWORK_BRAVE_API_KEY?.trim();
      // With a Brave key, use it directly. Keyless, try Bing then DuckDuckGo (first with results
      // wins) — one engine being rate-limited doesn't sink the query.
      const engines: Array<[string, () => Promise<Result[]>]> = key
        ? [["brave", () => braveSearch(p.query, count, key, signal)]]
        : [["bing", () => bingSearch(p.query, count, signal)], ["duckduckgo", () => duckSearch(p.query, count, signal)]];
      let lastErr = "";
      for (const [engine, run] of engines) {
        try {
          const results = await run();
          if (results.length > 0) {
            const text = results.map((r, n) => `${n + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
            return { content: [{ type: "text", text }], details: { results, engine } };
          }
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
        }
      }
      const hint = key ? "" : " Keyless search may be rate-limited; add a free Brave Search API key in Customise → Extensions → Web search for more reliable results.";
      const detail = lastErr ? ` (${lastErr})` : "";
      return { content: [{ type: "text", text: `No results for "${p.query}".${detail}${hint}` }], details: { results: [], error: lastErr || undefined } };
    },
  });

  pi.registerTool({
    name: "fetch_url",
    label: "Fetch a URL",
    description:
      "Fetch a web page and return its readable text (HTML stripped). Use to read a page found via web_search, or any URL the user gives you.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (http/https)." },
        maxChars: { type: "number", description: "Truncate the text to this many characters (default 20000)." },
      },
      required: ["url"],
    } as never,
    execute: async (_id, params, signal) => {
      const p = params as { url: string; maxChars?: number };
      const cap = Math.max(1000, Math.min(100000, p.maxChars ?? 20000));
      if (!/^https?:\/\//.test(p.url)) {
        return { content: [{ type: "text", text: `Not a valid http(s) URL: ${p.url}` }], details: { error: "bad url" } };
      }
      try {
        const res = await fetch(p.url, { headers: { "User-Agent": UA, Accept: "text/html,text/plain,*/*" }, signal });
        if (!res.ok) return { content: [{ type: "text", text: `Fetch failed: ${res.status} ${res.statusText}` }], details: { status: res.status } };
        const ctype = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        let text: string;
        if (ctype.includes("html") || /^\s*</.test(raw)) {
          text = decodeEntities(
            raw
              .replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<[^>]+>/g, " "),
          ).replace(/\s+/g, " ").trim();
        } else {
          text = raw;
        }
        const truncated = text.length > cap;
        return {
          content: [{ type: "text", text: truncated ? text.slice(0, cap) + "\n\n…(truncated)" : text }],
          details: { url: p.url, truncated, bytes: raw.length },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `Fetch failed: ${msg}` }], details: { error: msg } };
      }
    },
  });
}

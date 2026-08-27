/**
 * piwork-websearch — gives the agent `web_search` and `fetch_url`.
 *
 * Pi ships no web search, so this fills the gap and works out of the box with no setup:
 *   - web_search: DuckDuckGo (keyless) by default. If a Brave Search API key is present
 *     (PIWORK_BRAVE_API_KEY, set from Piwork's settings), it uses the Brave API instead —
 *     more reliable, since DuckDuckGo rate-limits scrapers.
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
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
    let href = lm[1];
    // DuckDuckGo wraps result URLs in a redirect: //duckduckgo.com/l/?uddg=<encoded real url>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    else if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//.test(href)) { i++; continue; }
    results.push({ title: stripTags(lm[2]), url: href, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web and get a list of results (title, URL, snippet). Use for current information, docs, or anything outside the workspace. Follow up with fetch_url to read a result's page.",
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
      try {
        const results = key
          ? await braveSearch(p.query, count, key, signal)
          : await duckSearch(p.query, count, signal);
        if (results.length === 0) {
          const hint = key ? "" : " DuckDuckGo may be rate-limiting keyless search; add a free Brave Search API key in Piwork's settings for reliable results.";
          return { content: [{ type: "text", text: `No results for "${p.query}".${hint}` }], details: { results: [] } };
        }
        const text = results.map((r, n) => `${n + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
        return { content: [{ type: "text", text }], details: { results, engine: key ? "brave" : "duckduckgo" } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const hint = key ? "" : " If this keeps happening, add a free Brave Search API key in Piwork's settings.";
        return { content: [{ type: "text", text: `Web search failed: ${msg}.${hint}` }], details: { error: msg } };
      }
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

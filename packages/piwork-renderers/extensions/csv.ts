/**
 * piwork-renderers/csv — renders CSV/TSV files as an HTML table in the Piwork viewer.
 *
 * Demonstrates the Piwork file→artifact renderer contract: the viewer is sandboxed, so
 * extensions can't inject render code — instead they TRANSFORM a file into an artifact
 * (html/markdown) and the base viewer renders it. Register at load time via the well-known
 * global; the base /piwork-render-file command dispatches to us and shows the result.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes, CRLF.
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

export default function (_pi: ExtensionAPI) {
  const g = globalThis as unknown as { __piwork?: { registerFileRenderer: (r: unknown) => void } };
  g.__piwork?.registerFileRenderer({
    id: "csv-table",
    label: "Table",
    extensions: [".csv", ".tsv"],
    render: ({ path, text }: { path: string; text: () => string }) => {
      const delim = path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
      const MAX_ROWS = 2000;
      const rows = parseDelimited(text(), delim);
      if (rows.length === 0) return { html: "<p>Empty file.</p>" };
      const [head, ...body] = rows;
      const shown = body.slice(0, MAX_ROWS);
      const thead = `<tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
      const tbody = shown.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
      const note = body.length > MAX_ROWS ? `<p class="note">Showing first ${MAX_ROWS} of ${body.length} rows.</p>` : "";
      const style = "<style>table{border-collapse:collapse;font:13px/1.4 -apple-system,sans-serif}th,td{border:1px solid #d5d8de;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f0f1f4;position:sticky;top:0}tr:nth-child(even) td{background:#fafbfc}.note{color:#8b909a}</style>";
      return { html: `${style}${note}<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>` };
    },
  });
}

/**
 * piwork-artifacts — auto-preview files in the workspace's `.artifacts/` folder.
 *
 * When the agent (or any tool) writes an .html/.md/.txt file to `/workspace/.artifacts/`,
 * this shows it live in Piwork's artifact panel via the first-class `showArtifact` intent.
 * Deleting the file clears its panel. A polling watcher keeps it simple and reliable in
 * containers (fs.watch recursive is unreliable on Linux).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_BYTES = 200_000;
const POLL_MS = 1500;

let poller: ReturnType<typeof setInterval> | undefined;

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

type Ui = {
  showArtifact?: (o: { key: string; title?: string; html?: string; markdown?: string }) => void;
  clearArtifact?: (key: string) => void;
  notify: (m: string, t?: string) => void;
};

function showFile(ui: Ui, full: string, name: string): void {
  let content: string;
  try {
    content = fs.readFileSync(full, "utf8");
  } catch {
    return;
  }
  if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES) + "\n… (truncated)";
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "html" || ext === "htm") ui.showArtifact?.({ key: name, title: name, html: content });
  else if (ext === "md" || ext === "markdown") ui.showArtifact?.({ key: name, title: name, markdown: content });
  else ui.showArtifact?.({ key: name, title: name, html: `<pre>${escapeHtml(content)}</pre>` });
}

export default function (pi: ExtensionAPI) {
  // A discoverable tool so the agent knows it can show the user rich output. (The
  // .artifacts/ folder watcher below is a secondary path for tools that write files.)
  pi.registerTool({
    name: "show_artifact",
    label: "Show artifact",
    description:
      "Display a document, report, table, chart, or preview to the user in a side panel (rendered HTML or Markdown). Use this to present formatted results the user should read or keep visible, instead of dumping large content into the chat.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the panel." },
        markdown: { type: "string", description: "Markdown content to render." },
        html: { type: "string", description: "HTML content to render (alternative to markdown)." },
      },
      required: ["title"],
    } as never,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const p = params as { title: string; markdown?: string; html?: string };
      const ui = (ctx as { ui: { showArtifact?: (o: unknown) => void } }).ui;
      if (typeof ui.showArtifact !== "function") {
        return { content: [{ type: "text", text: "Artifacts need the Piwork shell." }], details: {} };
      }
      ui.showArtifact({ key: p.title || "artifact", title: p.title, html: p.html, markdown: p.markdown });
      return { content: [{ type: "text", text: `Shown "${p.title}" in the artifacts panel.` }], details: {} };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (poller) { clearInterval(poller); poller = undefined; }
    const ui = ctx.ui as unknown as Ui;
    if (typeof ui.showArtifact !== "function") return; // needs the Piwork shell

    const dir = path.join(process.cwd(), ".artifacts");
    const seen = new Map<string, number>(); // filename -> mtimeMs

    const scan = () => {
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => /\.(html?|md|markdown|txt)$/i.test(f));
      } catch {
        files = [];
      }
      const present = new Set<string>();
      for (const f of files) {
        const full = path.join(dir, f);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        present.add(f);
        if (seen.get(f) === st.mtimeMs) continue; // unchanged
        seen.set(f, st.mtimeMs);
        showFile(ui, full, f);
      }
      for (const key of [...seen.keys()]) {
        if (!present.has(key)) {
          seen.delete(key);
          ui.clearArtifact?.(key);
        }
      }
    };

    scan();
    poller = setInterval(scan, POLL_MS);
  });
}

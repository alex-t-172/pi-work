/**
 * piwork-artifacts — gives the agent a `show_artifact` tool to PRESENT a finished artifact
 * to the user in Piwork's viewer: a file it produced (report, document, page, chart, image,
 * CSV, …) or inline rendered HTML/Markdown. It's an explicit "here's what I made", meant for
 * the end of a turn.
 *
 * Ships installed by default, but it's a normal removable extension (Pi philosophy: a tool the
 * agent chooses to call). The viewer + the `showArtifact` intent it targets are core to the
 * shell; presenting a `file` reuses the same host-side open + renderer pipeline as the Files
 * panel, so the "artifact" is just a workspace file the agent opened for you.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "show_artifact",
    label: "Show artifact",
    description:
      'Present a FINISHED artifact to the user in the side viewer — typically at the END of your turn, as an explicit "here\'s what I made". Prefer `file`: pass the workspace-relative path of a file you produced (a report, document, HTML page, chart, image, CSV, …) and Piwork opens it in the viewer, rendered where possible. Otherwise pass inline `markdown` or `html` for rendered content you did not write to a file. Use this to present completed results the user should read or keep visible — not intermediate steps or progress.',
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the panel." },
        file: { type: "string", description: "Workspace-relative path of a file you made, to present (preferred)." },
        markdown: { type: "string", description: "Inline Markdown to render (when not presenting a file)." },
        html: { type: "string", description: "Inline HTML to render (alternative to markdown)." },
      },
      required: ["title"],
    } as never,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const p = params as { title: string; file?: string; markdown?: string; html?: string };
      const ui = (ctx as { ui: { showArtifact?: (o: unknown) => void } }).ui;
      if (typeof ui.showArtifact !== "function") {
        return { content: [{ type: "text", text: "Artifacts need the Piwork shell." }], details: {} };
      }
      if (p.file) {
        // Present a real workspace file — the shell opens it host-side in the viewer.
        ui.showArtifact({ key: `file:${p.file}`, title: p.title, file: p.file });
        return { content: [{ type: "text", text: `Presented "${p.file}" in the viewer.` }], details: { file: p.file } };
      }
      ui.showArtifact({ key: p.title || "artifact", title: p.title, html: p.html, markdown: p.markdown });
      return { content: [{ type: "text", text: `Shown "${p.title}" in the viewer.` }], details: {} };
    },
  });
}

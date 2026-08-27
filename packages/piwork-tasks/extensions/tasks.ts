/**
 * piwork-tasks — a task list the agent maintains during a session.
 *
 * The model calls `set_tasks` with the full current list; we render it as a docked
 * widget (`setWidget`) and persist it as a custom session entry (`pi.appendEntry`) so it
 * survives compaction and /reload (custom entries don't participate in LLM context).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Status = "todo" | "doing" | "done";
interface Task { text: string; status?: Status }

const CUSTOM_TYPE = "piwork-tasks";
const ICON: Record<Status, string> = { todo: "☐", doing: "◐", done: "✓" };

function render(ui: { setWidget: (k: string, lines: string[] | undefined, o?: { placement?: string }) => void }, tasks: Task[]) {
  if (!tasks.length) { ui.setWidget(CUSTOM_TYPE, undefined); return; }
  const done = tasks.filter((t) => t.status === "done").length;
  const lines = [`Tasks (${done}/${tasks.length})`, ...tasks.map((t) => `${ICON[t.status ?? "todo"]} ${t.text}`)];
  ui.setWidget(CUSTOM_TYPE, lines, { placement: "aboveEditor" });
}

export default function (pi: ExtensionAPI) {
  // Restore + re-render on (re)load.
  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    let tasks: Task[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; customType?: string; data?: { tasks?: Task[] } };
      if (e.type === "custom" && e.customType === CUSTOM_TYPE) { tasks = e.data?.tasks ?? []; break; }
    }
    render(ctx.ui as never, tasks);
  });

  pi.registerTool({
    name: "set_tasks",
    label: "Set task list",
    description: "Replace the visible task list — pass the full list each time. Use it to plan and track multi-step work.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "The full task list, in order.",
          items: {
            type: "object",
            properties: { text: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] } },
            required: ["text"],
          },
        },
      },
      required: ["tasks"],
    } as never,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const tasks: Task[] = Array.isArray((params as { tasks?: Task[] }).tasks) ? (params as { tasks: Task[] }).tasks : [];
      pi.appendEntry(CUSTOM_TYPE, { tasks }); // persist
      render((ctx as { ui: never }).ui, tasks);
      const done = tasks.filter((t) => t.status === "done").length;
      return { content: [{ type: "text", text: `Task list updated (${done}/${tasks.length} done).` }], details: { tasks } };
    },
  });
}

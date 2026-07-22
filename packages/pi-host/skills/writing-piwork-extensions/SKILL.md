---
name: writing-piwork-extensions
description: How to customize Piwork by writing a Pi extension or skill for the current project — add commands, tools, UI panels, or agent instructions, then reload live. Use when the user asks to change/extend how Piwork or the agent behaves.
---

# Customizing Piwork (extensions & skills)

Piwork is the Pi coding agent in a GUI. You can customize it **while working** by writing
files into the current project's `.pi/` folder (which is `/workspace/.pi/` inside the
sandbox), then reloading. No build step — files load directly.

Two kinds of customization:

- **Skill** — Markdown instructions for *you* (the agent). Best for "always behave like X",
  workflows, domain knowledge. No code. **Prefer a skill when the request is about behavior.**
- **Extension** — TypeScript that adds slash commands, tools the model can call, or custom
  UI panels. Use when the request needs real logic or new UI.

After creating or editing either, run the **`/piwork-reload`** command (tell the user to run
it, or run it yourself) so it loads without restarting the session.

## Writing a skill (no code)

Create `/workspace/.pi/skills/<name>/SKILL.md`:

```markdown
---
name: <kebab-case-name>
description: <one line — when should this skill be used>
---

# <Title>

<Instructions, steps, context. Loaded on demand when relevant.>
```

Then `/piwork-reload`. The skill's name + description appear in your prompt; the body loads
when relevant.

## Writing an extension (code)

Create `/workspace/.pi/extensions/<name>.ts` with a default-exported function:

```ts
export default function (pi) {
  // A slash command the user can run from the composer:
  pi.registerCommand("greet", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });

  // A tool the MODEL can call during a turn:
  pi.registerTool({
    name: "word_count",
    label: "Word count",
    description: "Count the words in some text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (_id, params) => {
      const n = String(params.text ?? "").split(/\s+/).filter(Boolean).length;
      return { content: [{ type: "text", text: `${n} words` }], details: { n } };
    },
  });

  // React to lifecycle events:
  pi.on("session_start", (_event, ctx) => ctx.ui.notify("my extension loaded", "info"));
}
```

Then `/piwork-reload`.

### The `ctx.ui` surface (what you can show the user)

- `ctx.ui.notify(message, "info" | "warning" | "error")` — a toast.
- `ctx.ui.select(title, [options])` → chosen string (or undefined). `confirm(title, message)` → boolean.
  `input(title, placeholder?)` → string. `editor(title, prefill?)` → multi-line string. (all `await`.)
- `ctx.ui.setStatus(key, text)` — a status chip. `setWidget(key, [lines])` — a docked panel.
- **Piwork first-class intents:**
  - `ctx.ui.openExternal(url)` — open a URL in the user's real browser.
  - `ctx.ui.showArtifact({ key, title, html, markdown })` — render rich content in a
    sandboxed panel. `clearArtifact(key)` removes it. Great for reports/dashboards/previews.

Tool `parameters` is plain JSON Schema. `execute` returns `{ content: [{type:"text",text}], details }`;
throw on failure.

## Scope: project vs global

- **Project** (`/workspace/.pi/…`) — applies to this project only; travels with the repo. Default.
- **Global** — applies to every project. The user manages global extensions/skills from the
  Piwork Home screen; don't write global files yourself unless asked.

## Rules of thumb

- Behavior/knowledge → **skill**. New command/tool/UI → **extension**.
- Keep secrets OUT of project files (they may be committed). Read tokens from env or ask the user.
- Always finish by reloading (`/piwork-reload`) and telling the user what you added and how to use it.

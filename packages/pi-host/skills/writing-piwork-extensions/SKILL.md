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

### Custom file renderers (make the viewer understand a filetype)

The document viewer natively shows text, markdown, images and HTML. To teach it a *new*
filetype (CSV, a log format, a config, …), register a **file renderer**: you can't inject
UI code (the viewer is sandboxed), so you transform the file into HTML/markdown — an
artifact — and the base viewer renders it. Register at load time on the Piwork global:

```ts
export default function (_pi) {
  const g = globalThis; // Piwork exposes __piwork in the container
  g.__piwork?.registerFileRenderer({
    id: "my-logs",
    label: "Log view",
    extensions: [".log"],                 // or match: (relPath) => boolean
    render: ({ path, text, absPath }) => ({ html: `<pre>${text()}</pre>` }),
  });
}
```

When the user opens a matching file in the workspace browser, Piwork shows your rendered
view (they can still switch back to the raw text). `render` runs in-container, may be async,
and returns `{ html }` or `{ markdown }`. Keep output self-contained (inline styles; no
network — the viewer's CSP blocks it).

## Scope: project vs global

- **Project** (`/workspace/.pi/…`) — applies to this project only; travels with the repo. Default.
- **Global** — applies to every project. The user manages global extensions/skills from the
  Piwork Home screen; don't write global files yourself unless asked.

## Sharing what you build

If the user wants to share an extension or skill with others, use Pi's package convention —
no Piwork-specific format:

- **Project extension → just share the repo.** It already lives in `.pi/`, which travels with
  git. The user commits and pushes; a collaborator clones, opens the folder in Piwork, and it
  auto-loads. Nothing to package.
- **Global or standalone → make it a Pi package, then push it to a git repo.** A package is a
  folder with a `package.json`:

  ```json
  {
    "name": "my-standup",
    "version": "0.1.0",
    "keywords": ["pi-package"],
    "pi": { "extensions": ["./extensions"] }
  }
  ```

  (use `"pi": { "skills": ["./skills"] }` for a skill). Put the extension under `extensions/`
  next to it, `git init`, and push to a repo (e.g. with `gh repo create … --push`). If asked,
  you can scaffold these files and run the git commands yourself in a project session.

- **Others install it** from Piwork's 🧩 panel → *Install by source* → paste `git:user/repo`
  (or `npm:pkg-name`), at global or project scope. So "share" = a git link they paste.

## Rules of thumb

- Behavior/knowledge → **skill**. New command/tool/UI → **extension**.
- Keep secrets OUT of project files (they may be committed). Read tokens from env or ask the user.
- Always finish by reloading (`/piwork-reload`) and telling the user what you added and how to use it.

# Piwork

A GUI desktop shell for the [Pi coding agent](https://pi.dev), plus a removable **Suite**
of extensions that deliver Cowork-like features on top. Piwork is to Cowork what Pi is to
Claude Code: the core shell stays minimal; features are Pi extensions expressed through a
UI-intent contract, and you can install — or **author from inside the app** — more.

It's aimed at technical-but-non-developer users: work with a coding agent in a sandbox,
view the files it produces, connect your tools, and customise the app as you go — without
touching a terminal.

See [`pi-cowork-design.md`](./pi-cowork-design.md) for the original design and rationale.

## What it does

- **Sandboxed sessions per folder.** Open a folder → a container starts with that folder
  bind-mounted at `/workspace`; the agent works only there. The container is the trust
  boundary. Streaming chat with steer / follow-up / abort, rich tool rendering, and a
  visual **Rewind** (branch the conversation back to any earlier message).
- **Global chat.** A folderless assistant from the home screen — chat + your connectors &
  skills, with **no file access** (enforced by having no folder mounted, not by tool hacks).
- **Host-side file browser + document viewer.** Browse folders to pick where to start
  (before any container exists) and, in-session, read the workspace. Click a file to view
  it (text · markdown · images · HTML) in a resizable pane. **Read-only** — the agent makes
  changes, you view results.
- **Model providers via OAuth.** Connect Anthropic (or others) from within the app; the
  browser OAuth handshake is relayed out of the container.
- **MCP connectors.** Connect hosted services (Notion, Linear, Sentry, Stripe, …) with a
  **seamless OAuth "Connect" button**, or add any custom MCP server (remote URL or local
  stdio + token). Powered by the baked [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter).
- **Resource manager.** Install / remove skills, plugins and extensions from the UI, at
  **global** (every project) or **project** scope — managed like a CLI agent's dot-folders.
- **Self-extension.** Ask Piwork to write a new skill or extension — a `/command`, a tool,
  a UI panel, or even a new file-type renderer — and reload it live, at project or global
  scope. Customise the app in the course of doing work with it.
- **Themes** you can change from the UI, and a **checkpoint** safety net (git auto-commit
  before each turn) among the Suite packages.

## Architecture — one contract, three buckets

Piwork keeps the shell tiny and pushes everything it can into Pi extensions, expressed
through a single UI-intent contract. Everything sorts into three buckets:

- **Base (host/shell):** an Electron app. Owns the container lifecycle, relays the bridge to
  a sandboxed renderer, opens OAuth URLs in the real browser, reads workspace files
  host-side, and writes connector/config files. **Executes no extension code.**
- **Contract (the wire):** strict LF-only JSONL over the container's stdio. We reuse **Pi's
  RPC protocol as the intent contract** — it already serialises `ctx.ui` calls into typed
  JSON intents (`extension_ui_request`) and exposes the typed command surface — rather than
  inventing one.
- **Extension (in-container):** `pi-host` embeds the Pi SDK and runs Pi's `runRpcMode`. We
  **"own the shim"** — prototype-patching `bindExtensions` to augment `ctx.ui` with
  first-class Piwork intents (`openExternal`, `showArtifact`, `showSessionTree`,
  `showMcpStatus`) that the shell renders. New capabilities are injected base-extension
  commands, so adding one = a line in `pi-host` + a renderer in the shell.

```
Electron main (Node, host)                        container (trust boundary)
 ├ ContainerBridge ── docker run -i ─JSONL─►  pi-host ─ Pi SDK + runRpcMode
 │                    ◄─────────────────────           ├ own-the-shim ctx.ui → intents
 ├ host file reads (workspace)                          ├ base cmds: reload/tree/rewind/mcp-auth
 ├ OAuth + MCP callback servers (browser relay)         ├ pi-mcp-adapter (MCP engine)
 └ IPC (preload, contextIsolation)                      └ Suite extensions (.pi / agent store)
      └ React renderer (sandboxed, no Node):
        left rail · chat · file viewer · modals
```

## Layout

```
packages/
  bridge-protocol/   shared JSONL framing + protocol types + guards (unit-tested)
  pi-host/           embeds the Pi SDK; container-side bridge + base extension + baked skills
  shell/             Electron app — electron/ (main, preload, ContainerBridge) + src/ (React)
  piwork-artifacts/  Suite: auto-preview files written to .artifacts/
  piwork-ask/        Suite: agent asks you a question (choice / free text) mid-turn
  piwork-checkpoint/ Suite: git auto-checkpoint before each turn
  piwork-renderers/  Suite: extra viewer renderers (CSV → table) — the file→artifact contract
  piwork-tasks/      Suite: a task list the agent maintains, docked + persisted
  piwork-ui/         helper lib for extensions to emit Piwork UI intents
images/Dockerfile    node:24 + git + ripgrep + pi-host + pinned Pi SDK + pi-mcp-adapter + skills
docs/                living roadmap
```

## Prerequisites

- **Node ≥ 22.18** on the host (native TypeScript type-stripping; `pi-host` and the smoke
  scripts run `.ts` directly, no build step).
- **Docker** running (developed on Rancher Desktop).
- A **model credential** — connect a provider in-app via OAuth, or reuse an existing Pi
  agent home (see below). Local dev can also self-host on Ollama reached via
  `host.docker.internal`.

## Build & run

```bash
npm install                                                   # workspaces: React/Vite/Electron
docker build -t piwork-sandbox:spike -f images/Dockerfile .   # build the sandbox image

cd packages/shell
npm run dev                                                   # launches Vite + Electron (auto-reload)
```

In the app: **Open a folder to work in…** starts a sandboxed session; **💬 New chat** starts
the folderless global chat. While streaming: **Enter = steer**, **Alt+Enter = follow-up**,
**Shift+Enter = newline**. The left rail opens Files 📁, Skills 🧩, Connectors 🔌, Rewind ⏪,
Theme 🎨 and Debug 🐞.

By default the shell uses a shared named volume (`piwork-agent`) as the agent home and you
connect a provider in-app. To reuse an existing Pi agent home instead, set
`PIWORK_AGENT_DIR=/abs/path/to/agent` (with `auth.json`/`models.json`/`settings.json`) —
handy for local dev. `npm run dev` auto-enables `host.docker.internal` for reaching a host
Ollama.

> Editing the renderer hot-reloads. Editing `electron/main.ts` or `preload.ts` relaunches
> Electron automatically. Editing `pi-host` or the Dockerfile requires
> `docker build … -t piwork-sandbox:spike` and a fresh session.

## The Suite

Suite packages are installed from the **Skills 🧩** panel (one-click presets) at global or
project scope — or via `node scripts/install-suite.mjs`. They're ordinary Pi packages; the
shell renders whatever intents they emit. None are required; the shell works with zero
installed.

## Extending Piwork from inside the app

- **Project scope:** in a folder session, ask the agent to add a `/command`, tool or skill.
  It writes to `/workspace/.pi/{extensions,skills}/…` and runs `/piwork-reload` to load it
  live. Guided by the baked **`writing-piwork-extensions`** skill. Extensions are
  `<name>/index.ts` (or flat `<name>.ts`) — **not** `extension.ts`.
- **Global scope:** in the global chat, purpose-built, path-scoped tools
  (`piwork_{list,read,write,delete}_config`) let the agent author skills/extensions into the
  agent store's native scan locations (`~/.pi/agent/{skills,extensions}`), so they load in
  every session. Guided by the baked **`configuring-piwork`** skill. The tools are scoped to
  those subtrees, so credentials stay unreachable.
- **New viewer file types:** an extension registers a `render(file) → { html | markdown }`
  transform via `globalThis.__piwork.registerFileRenderer`; the sandboxed viewer renders the
  result. `piwork-renderers` (CSV → table) is the worked example.

## MCP connectors

Connectors are standard MCP servers described in `mcp.json`, read by the baked
`pi-mcp-adapter`. Piwork manages those files host-side and drives the adapter's OAuth:

- **Config:** global connectors → `~/.piwork/mcp-global/mcp.json` (host-side, mounted into
  the container); project connectors → `<repo>/.pi/mcp.json` (in-repo, portable).
- **Seamless OAuth:** clicking **Connect** runs the auth flow in a dedicated short-lived
  container (independent of your chat); the browser redirect lands on a host callback server
  and completes automatically. Tokens live in the container's agent store and auto-refresh.
- **Secrets:** the shell refuses to write a token-bearing connector (stdio `env` / auth
  header) to **project** scope — those would land in an in-repo file. Add token-based
  connectors at **global** scope, where the secret stays on your machine.

## Verification

`bridge-protocol` has unit tests; the shell has headless smoke tests that drive real
containers end-to-end (against a local Ollama):

```bash
npm test -w @piwork/bridge-protocol                 # framing + guards

node packages/shell/scripts/smoke-bridge.mjs        # Node bridge, end-to-end
node packages/shell/scripts/smoke-sessions.mjs      # per-folder session history
node packages/shell/scripts/smoke-suite.mjs         # Suite install + load
node packages/shell/scripts/smoke-global.mjs        # folderless, tool-restricted global chat
node packages/shell/scripts/smoke-authoring-e2e.mjs # agent writes a project extension, reload, live
node packages/shell/scripts/smoke-config.mjs        # global self-authoring (skills + extensions)
node packages/shell/scripts/smoke-renderers.mjs     # file → artifact renderer contract
node packages/shell/scripts/smoke-mcp.mjs           # MCP adapter + connector auth wiring
node packages/shell/scripts/smoke-artifacts.mjs     # artifact / html intent
node packages/shell/scripts/smoke-tree.mjs          # session tree + rewind
node packages/shell/scripts/smoke-login.mjs         # provider OAuth relay
```

## Gotchas worth knowing (learned the hard way)

- **macOS/Rancher bind mounts only work under shared paths** (`/Users`). Sources under
  `/tmp` or `/var/folders` silently mount empty — write temp fixtures under the repo.
- **`.ts` packages under `node_modules` won't type-strip**, and richer TS (enums, parameter
  properties) needs `--experimental-transform-types`. `pi-mcp-adapter` is baked as a plain
  dir and `pi-host` runs with that flag.
- **Pi's TUI theme is a `globalThis` singleton** that throws until `initTheme()` runs;
  headless embeds must call it or extensions that render status crash the session.
- **`settings.json` with a `packages` array triggers a startup `npm install`** whose
  subprocess writes to fd 1 (the protocol channel), corrupting it. Keep the agent home
  clean; bake Suite/engine packages into the image. `pi-host` writes diagnostics to stderr.
- **`ctx.ui` intents come from `bindExtensions`, not the factory** — Piwork augments the
  bound `uiContext` on the `AgentSession` prototype so replacement sessions inherit it.

## Docs

- [`pi-cowork-design.md`](./pi-cowork-design.md) — original design & rationale.
- [`docs/`](./docs) — living roadmap.

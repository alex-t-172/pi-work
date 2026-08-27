# Piwork

[![CI](https://github.com/alext-tessl/pi-work/actions/workflows/ci.yml/badge.svg)](https://github.com/alext-tessl/pi-work/actions/workflows/ci.yml)

Piwork is a desktop app for the [Pi coding agent](https://pi.dev). You open a folder and an
agent works inside it, in a sandbox: it can read and change files in that folder, but nothing
else on your machine. You chat with it, watch what it does, view the files it writes, and
connect tools like Slack or Notion. It all happens in a window, not a terminal.

Most of Piwork's features are Pi extensions rather than app code, so you can add more, or ask
the agent to write one for you. (If you know Claude's tools: Piwork is to Cowork roughly what Pi
is to Claude Code.)

> **Status:** early, and a personal project written mostly with an AI coding agent. It still
> takes the engineering seriously where it counts: a pinned-SDK contract check gates every image
> build, CI runs the checks, and the [security model](SECURITY.md) is stated plainly. It runs as
> a dev build for now — clone the repo, build the sandbox image, run the app; a packaged,
> downloadable version comes later. macOS first.

## What it does

- **Sandboxed sessions per folder.** Open a folder and Piwork starts a container with that
  folder mounted at `/workspace`. The agent can only work there. You get streaming chat with
  steer, follow-up, and abort, plus Rewind to jump the conversation back to an earlier message.
- **A terminal, too.** Type `!command` to run it in the sandbox and see the output in the chat.
  Good for a quick `!git diff` or `!npm test` without leaving the conversation.
- **Global chat.** A folderless agent you reach from the home screen. It has no file access
  because nothing is mounted, but it can still use your connectors and skills, and help you set
  up Piwork itself.
- **File browser and viewer.** Browse folders to pick where to start, and read the workspace
  while a session runs. It shows text, markdown, images, and HTML in a resizable pane. It's
  read-only: the agent changes files, you look at the results.
- **Sign in to models.** Connect Anthropic or another provider from inside the app. Piwork opens
  your browser for the sign-in and finishes the handshake for you, with nothing to copy and paste.
- **Connectors.** Add hosted services with an OAuth sign-in: Notion, Linear, Sentry, Stripe are
  one click; Slack needs a Slack app you register first. You can also add any other MCP server.
  This runs on the bundled [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter).
- **Web search, built in.** Pi ships no web search, so Piwork adds `web_search` and `fetch_url`
  that work with no setup (keyless DuckDuckGo). Add a free Brave Search API key in Customise for
  more reliable results.
- **Built-in extensions.** A handful ship by default, each removable in Customise: ask-the-user
  dialogs, a file and HTML viewer tool, a task list the agent keeps, web search, and subagents
  (`pi-subagents`). They live in [`packages/piwork-*`](packages), listed in
  [`built-ins.json`](packages/pi-host/built-ins.json).
- **Extend it from inside.** Ask Piwork to write a new command, tool, panel, or file renderer,
  and load it live, for one project or everywhere. There's a reference extension in
  [`examples/`](examples).
- **Themes** you can edit in the app.

## Prerequisites

- **Node 22.18 or newer.** Piwork runs `.ts` files directly, so `pi-host` needs no build step.
- **A container runtime with a working `docker` command.** Docker Desktop, colima, Rancher
  Desktop, and OrbStack all work. If `docker` isn't on your `PATH` (Rancher's lives at
  `~/.rd/bin/docker`), set `PIWORK_DOCKER=/path/to/docker`.
- macOS is the main target for now.

## Quick start (dev build)

```bash
git clone https://github.com/alext-tessl/pi-work
cd pi-work
npm install        # workspaces: shell (React/Vite/Electron), pi-host, built-ins
npm run image      # build the sandbox image (also runs the verify-pi check)
npm run dev        # launch Vite + Electron with auto-reload
```

In the app, open a folder to start a session, or start the global chat. Then connect a model
from the Models panel, for example by signing in to Anthropic. The first run seeds a fresh agent
store with the built-in extensions, so there's nothing to install.

While the agent is replying, **Enter** steers, **Alt+Enter** queues a follow-up, and
**Shift+Enter** adds a newline. The left rail has Files, Customise, Connectors, Models, Rewind,
Theme, and Debug.

> The renderer hot-reloads, and editing the Electron main or preload relaunches the app.
> Changing `pi-host`, the Dockerfile, or a built-in means running `npm run image` again and
> starting a fresh session. To work on a built-in without rebuilding, the shell mounts your
> `packages/` over the baked copy in dev. To reuse an existing Pi agent home, set
> `PIWORK_AGENT_DIR=/abs/path/to/agent`.

## How it's built: one contract, three parts

Piwork keeps the shell small and puts as much as it can into Pi extensions, all speaking one
UI-intent contract. Everything falls into three parts.

- **The shell (host).** An Electron app. It runs the container, relays the bridge to a sandboxed
  renderer, opens OAuth URLs in your real browser, reads workspace files, and writes connector
  and config files. It runs no extension code.
- **The wire (the contract).** Strict LF-only JSONL over the container's stdio. Piwork reuses
  Pi's RPC protocol as the contract instead of inventing one. It already turns `ctx.ui` calls
  into typed JSON intents (`extension_ui_request`) and exposes the typed command surface.
- **The extensions (in the container).** `pi-host` embeds the Pi SDK and runs Pi's `runRpcMode`.
  Piwork "owns the shim": it patches `bindExtensions` to add first-class Piwork intents to
  `ctx.ui` (`openExternal`, `showArtifact`, `showSessionTree`, `showMcpStatus`) that the shell
  renders. Adding a capability is a line in `pi-host` plus a renderer in the shell.

```
Electron main (Node, host)                        container (trust boundary)
 ├ ContainerBridge ── docker run -i ─JSONL─►  pi-host ─ Pi SDK + runRpcMode
 │                    ◄─────────────────────           ├ own-the-shim ctx.ui → intents
 ├ host file reads (workspace)                          ├ base cmds: reload/tree/rewind/mcp-auth
 ├ OAuth + MCP callback servers (browser relay)         ├ pi-mcp-adapter (MCP engine)
 └ IPC (preload, contextIsolation)                      └ built-in + installed extensions
      └ React renderer (sandboxed, no Node):
        left rail · chat · file viewer · modals
```

## Layout

```
packages/
  bridge-protocol/   shared JSONL framing + protocol types + guards (unit-tested)
  pi-host/           embeds the Pi SDK; container bridge + base extension + baked skills
                     + built-ins.json (the built-in manifest) + verify harnesses
  shell/             Electron app: electron/ (main, preload, ContainerBridge) + src/ (React)
  piwork-ask/        built-in: agent asks you a question (choice or free text) mid-turn
  piwork-artifacts/  built-in: show_artifact tool, to present a file or rich HTML in the viewer
  piwork-websearch/  built-in: web_search + fetch_url (keyless, or Brave with a key)
  piwork-tasks/      built-in: a task list the agent maintains, docked and persisted
examples/
  extensions/        reference extensions (not installed), e.g. piwork-checkpoint
images/Dockerfile    node:24 + git + ripgrep + pinned Pi SDK + pi-mcp-adapter + pi-subagents
                     + baked built-in extensions + skills
```

The `piwork-*` packages plus `pi-subagents` are the built-in extensions. They're baked into the
image and installed into a fresh store by default, and each is removable in Customise. Baking
puts the code in the image; the store's `settings.json` decides what's turned on. To add a
built-in, add an entry to [`built-ins.json`](packages/pi-host/built-ins.json) and a bake step to
the Dockerfile. The `verify:builtins` check catches mistakes.

## Extending Piwork from the app

- **For one project.** In a folder session, ask the agent to add a `/command`, tool, or skill.
  It writes to `/workspace/.pi/{extensions,skills}/…` and runs `/piwork-reload` to load it live.
  The baked `writing-piwork-extensions` skill guides it. Extensions are `<name>/index.ts` or a
  flat `<name>.ts`, not `extension.ts`.
- **For everywhere.** In the global chat, a set of path-scoped tools
  (`piwork_{list,read,write,delete}_config`) let the agent write skills and extensions into the
  agent store's own scan locations (`~/.pi/agent/{skills,extensions}`), so they load in every
  session. The baked `configuring-piwork` skill guides it. Those tools are scoped to the skills
  and extensions subtrees, so credentials stay out of reach.
- **New file types in the viewer.** An extension registers a `render(file) → { html | markdown }`
  transform on `globalThis.__piwork.registerFileRenderer`, and the sandboxed viewer shows the
  result.

There's a worked example to copy from in
[`examples/extensions/piwork-checkpoint`](examples/extensions/piwork-checkpoint).

## Connectors

Connectors are standard MCP servers listed in `mcp.json` and read by the bundled
`pi-mcp-adapter`. Piwork manages those files on the host and drives the sign-in.

- **Presets.** One-click OAuth connectors for Notion, Linear, Sentry, and Stripe, plus a form for
  any other remote or local server. Slack works too but isn't one click: its MCP server has no
  dynamic client registration, so you register a Slack app yourself and paste its Client ID and
  Secret into the "Set up" form (which shows the redirect URL to use).
- **Where config lives.** Global connectors go in `~/.piwork/mcp-global/mcp.json` on the host,
  mounted into the container. Project connectors go in `<repo>/.pi/mcp.json`, so they travel with
  the repo.
- **Sign-in.** Clicking Connect runs the auth flow in a short-lived container, separate from your
  chat. Your browser redirect lands on a small local server that finishes the flow. Tokens are
  stored in the container's agent store and refresh themselves.
- **Secrets.** Piwork won't write a connector that carries a token into project config, since
  that file can end up committed. Add token-based connectors as global, where the secret stays on
  your machine.

## Contributing and checks

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the dev loop, and [SECURITY.md](SECURITY.md)
for the sandbox model and how to report an issue. Before you open a PR (CI runs all of this on
every push):

```bash
npm run typecheck && npm run lint && npm test
npm run image && npm run verify:builtins
```

Two checks are worth knowing. `verify-pi` runs inside `docker build` and confirms `pi-host`
still binds to the pinned Pi SDK. `verify:builtins` confirms every built-in still loads and
registers its tools. For upgrading the Pi SDK, see
[`packages/pi-host/UPGRADING-PI.md`](packages/pi-host/UPGRADING-PI.md).

There are also deeper end-to-end smoke tests that drive real containers (some need a local
model) in [`packages/shell/scripts`](packages/shell/scripts).

## Gotchas worth knowing (learned the hard way)

- **On macOS with Rancher, bind mounts only work under shared paths** like `/Users`. Sources
  under `/tmp` or `/var/folders` mount empty with no error, so write temp fixtures under the repo
  or your home directory.
- **`.ts` packages under `node_modules` won't type-strip.** Richer TS (enums, parameter
  properties) also needs `--experimental-transform-types`. `pi-mcp-adapter` is baked as a plain
  directory, and `pi-host` runs with that flag.
- **Pi's TUI theme is a `globalThis` singleton** that throws until `initTheme()` runs. A headless
  embed has to call it, or an extension that renders status will crash the session.
- **A `settings.json` with a `packages` array triggers an `npm install` at startup.** That
  subprocess writes to fd 1, which is the protocol channel, and corrupts it. Bake extension
  packages into the image instead; `pi-host` keeps its diagnostics on stderr.
- **`ctx.ui` intents come from `bindExtensions`, not the factory.** Piwork augments the bound
  `uiContext` on the `AgentSession` prototype so replacement sessions inherit it.

## Credits

Piwork is a thin GUI over [Pi](https://github.com/earendil-works/pi) — Pi, and the bundled
[`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter), do the actual agent work; Piwork just
puts a window around them. Thanks to the Pi team ([earendil-works](https://github.com/earendil-works))
for building it and releasing it openly.

## Docs and license

- [`pi-cowork-design.md`](./pi-cowork-design.md) has the original design and rationale (a
  snapshot from the start of the project — the architecture holds, some specifics have evolved).
- Licensed **MIT**. See [`LICENSE`](LICENSE) and [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

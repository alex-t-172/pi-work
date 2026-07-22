# Piwork

A minimal GUI desktop shell for the [Pi coding agent](https://pi.dev), plus (later) a
removable **Suite** of extensions that deliver Cowork-like features on top. Piwork is to
Cowork what Pi is to Claude Code: the core stays barebones; the features are packages.

See [`pi-cowork-design.md`](./pi-cowork-design.md) for the full design and rationale.

## Status

Phase 0 (de-risking) and the Phase 1 shell foundation are built and verified.

| Piece | State |
|---|---|
| **Spike A** — SDK-in-container, event streaming, JSONL framing, blocking `ctx.ui.select` round-trip | ✅ passing (`node scripts/spike-a.mjs`) |
| **`bridge-protocol`** — LF-only framing + versioned handshake + typed guards | ✅ 8/8 unit tests |
| **`pi-host`** — embeds the Pi SDK, runs Pi's `runRpcMode`, emits a `piwork_hello` handshake | ✅ verified |
| **Shell bridge (`ContainerBridge`)** — Electron main's container/protocol layer | ✅ passing (`packages/shell/scripts/smoke-bridge.mjs`) |
| **Shell renderer** (React) — chat stream, steer/follow-up, abort, intent renderer (toast/modal/status/widget), command palette, native model picker | ✅ builds; GUI is desktop-verified by running `npm run dev` |
| **Spike B** — `/login` OAuth relay | ⏳ mechanism stubbed (`piwork:openExternal`); needs a real provider login to exercise |

## Architecture (one contract, two artefacts)

- **The shell (core):** an Electron app. Owns container lifecycle, relays the bridge to a
  sandboxed renderer, opens OAuth URLs in a real browser. Executes no extension code.
- **`pi-host` (in the container):** embeds the Pi SDK via `createAgentSession` and runs Pi's
  shipped `runRpcMode`, which already serializes `ctx.ui` calls into JSON intents and exposes
  the typed command surface. **Pi's RPC protocol _is_ the UI-intent contract** — we adopt it
  rather than invent one.
- **The wire:** strict LF-only JSONL over the container's stdio (`docker run -i`). Commands
  host→container; AgentSessionEvents + `extension_ui_request`s + responses container→host.

```
Electron main (Node)                         container
 ├ ContainerBridge ── docker run -i ─JSONL─►  pi-host ─ createAgentSession + runRpcMode
 │                    ◄─────────────────────           └ ctx.ui shim → extension_ui_request
 └ IPC (preload, contextIsolation)
      └ React renderer (sandboxed, no Node): chat, intents, command palette, model picker
```

## Layout

```
packages/
  bridge-protocol/   shared framing + protocol types + guards (unit-tested)
  pi-host/           embeds the Pi SDK; the container-side bridge (run via Node TS strip)
  shell/             Electron app: electron/ (main+preload+ContainerBridge) + src/ (React)
images/Dockerfile    node:24-slim + git + ripgrep + pi-host (+ pinned Pi SDK)
scripts/spike-a.mjs  Phase-0 end-to-end proof
```

## Prerequisites

- Node ≥ 22.18 (uses native TypeScript type-stripping; no build step for `pi-host`).
- Docker (tested with Rancher Desktop) running.
- A model credential. This machine has no valid cloud key, so the spikes self-host on a
  local **Ollama** (`gemma4:12b`) reached from the container via `host.docker.internal`.

## Build & run

```bash
npm install                                   # workspaces; pulls React/Vite/Electron
docker build -t piwork-sandbox:spike -f images/Dockerfile .

# Phase-0 end-to-end proof (build image + drive a full session)
node scripts/spike-a.mjs

# Unit + integration checks
npm test -w @piwork/bridge-protocol           # framing + guards
node packages/shell/scripts/smoke-bridge.mjs  # shell's Node bridge, end-to-end

# Run the GUI (opens a window on your desktop)
cd packages/shell
PIWORK_AGENT_DIR=/abs/path/to/agent PIWORK_ADD_HOST_GATEWAY=1 npm run dev
```

`PIWORK_AGENT_DIR` bind-mounts an agent home (with `auth.json`/`models.json`/`settings.json`)
into the container so the shell can chat immediately; without it the shell uses a per-workspace
named volume and relies on `/login` (Spike B). In the GUI: **Open folder…** starts a sandboxed
session; while streaming, **Enter = steer**, **Alt+Enter = follow-up**, **Shift+Enter = newline**.

## Gotchas worth knowing (learned the hard way)

- **macOS/Rancher single-file bind mounts silently become directories** when the source is
  outside a shared path (e.g. `/var/folders`). Mount directories from under `/Users`.
- **`settings.json` with a `packages` array triggers a startup `npm install`** whose subprocess
  writes to fd 1 — the JSONL protocol channel — corrupting it. Keep the container agent home
  clean; preinstall Suite packages at image-build time. pi-host writes diagnostics only to stderr.
- Custom providers are excluded from `getAvailable()`; select them via `settings.json`
  `defaultModel` and give them a credential keyed by provider id in `auth.json`.

## Next

- Spike B: wire `AuthStorage.login({onAuth, onManualCodeInput})` into pi-host and relay the URL
  to the shell's `piwork:openExternal`.
- Phase 2: formalize the intent contract as a documented profile of Pi's RPC UI protocol;
  publish `piwork-ui`; note that `renderCall/renderResult` can't serialize headless, so the
  shell owns a default structured-tool renderer registry.
- Phase 3: the Suite (`piwork-tasks`, `piwork-artifacts`, `piwork-tree`, …).

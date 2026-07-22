# Piwork - design and build plan

A minimal desktop shell for the Pi coding agent, plus a suite of extensions that deliver Cowork-like functionality on top. Piwork is to Cowork what Pi is to Claude Code: the core is barebones, the features are packages - but the features still get built. Side project, aiming for open source.

## Executive Summary

- **The idea:** Claude Cowork is a desktop shell wrapped around Claude Code - sandboxed execution, mounted folders, skills, connectors, GUI widgets. Piwork delivers the same experience on Pi, split into two deliberately separate artefacts: a **minimal shell** (a GUI renderer for Pi, nothing more) and the **Piwork Suite** - first-party extensions that provide the Cowork-style features, installed by default but removable like any Pi package.
- **The core design move:** the shell is not "Cowork rebuilt on Pi" - it is a GUI renderer for Pi, the way Pi's TUI is a terminal renderer. Pi's built-in commands (`/model`, `/settings`, `/tree`) drive their UI through the same `ctx.ui` surface extensions use, so a shell that renders that surface gets model picking, settings, and session navigation for free.
- **The irreducible core is five things:** container lifecycle, a JSONL bridge, a UI intent renderer with a chat surface, a command palette, and an OAuth proxy. Everything else - task lists, artifacts, tree visualisation, connectors, even the package browser - is a Suite extension, proving the same contract third parties will use.
- **Plan:** two de-risking spikes, the shell, the intent contract as a public spec, then the Suite built one package at a time. The Suite is the roadmap; the core stays frozen.

## Context

- Pi ([pi.dev](https://pi.dev)) is a minimal terminal agent harness. It deliberately omits sub-agents, plan mode, todos, permission popups, and MCP - all provided by extensions or packages. Its README has a "[what we didn't build](https://pi.dev/docs/latest)" section; Piwork's core should have one too.
- Pi runs in four modes: interactive TUI, print/JSON, RPC (JSONL over stdio), and an embeddable Node SDK. The local SDK docs (`docs/sdk.md`) cover `createAgentSession`, event subscription, prompting, extension binding, session runtime, tools, auth, model registry, and resource loading — enough to proceed with spike 0 without web access.
- Claude Cowork demonstrates the product shape but fixes the workflows: its widgets are baked in by Anthropic. Piwork's bet is that the same experience can be assembled from removable parts.
- Assumed from earlier exploration: Docker-via-colima as the sandbox, `pi-mcp-adapter` as the connector layer, Electron as the shell (fastest path in TypeScript; revisit if it grates).

## Problem

- **Cowork's workflows are chosen for you** - if your team works differently, tough.
- **Pi's extensibility is trapped in the terminal** - extensions can build rich TUI, invisible to anyone who won't live in a terminal.
- **Pi has no safety story for non-experts** - no permission popups by design; the docs say "run it in a container". Fine for me, a non-starter for a Cowork-style audience.
- The gap: a GUI shell with Pi's extensibility and Cowork's safety and out-of-box usefulness - achieved without a fixed-feature core.

## Architecture overview

Two artefacts, one contract:

1. **The shell (core):** Electron app + pi-host. Renders Pi's event stream and UI intents. Frozen scope.
2. **The Piwork Suite:** Pi extensions running inside the sandbox, expressing their UI through the intent contract. Preinstalled in the default image, removable with `pi remove`, replaceable by third-party alternatives.

The contract between them - the **UI intent schema** - is the open-source spec. The Suite is both the Cowork parity layer and the reference implementation third-party authors copy.

### Core (genuinely new code, earns its place only if an extension cannot do it)

| Component | Why it must be core |
|---|---|
| **Workspace/container lifecycle** | Extensions run *inside* the container; something on the host must create it. |
| **Bridge + pi-host** | A thin Node process embedding Pi via SDK in the container, JSONL over stdio (`docker attach`) to the shell. |
| **UI intent renderer + chat surface** | Streaming messages, input, abort, Pi's steer/follow-up queue, and native rendering of serialised `ctx.ui` calls. |
| **Command palette** | Forwards `/command` strings to Pi. Because built-in commands render through `ctx.ui`, this *is* the model picker, settings pane, and session browser. No bespoke UI for any of them. |
| **OAuth proxy** | `/login` needs a browser; the container can't open one. The shell relays URL/callback. |

### Process model

```
┌─ Host ──────────────────────────────────────────────┐
│  Electron main: container lifecycle, bridge client,  │
│                 OAuth relay                           │
│  Electron renderer (sandboxed, no Node):              │
│                 chat, intent renderer, command palette│
├─ Trust boundary 1: container ───────────────────────┤
│  pi-host (Node, embeds Pi via SDK)                    │
│  - owns the AgentSession                              │
│  - loads extensions (the Suite + anything installed)  │
│  - ui shim: serialises ctx.ui calls → UI intents      │
│  - bridge server: JSONL over stdio                    │
│  Mounts: project folder at /workspace (rw),           │
│          named volume at /root/.pi/agent              │
├─ Trust boundary 2: the mount ───────────────────────┤
│  Host filesystem: only the selected folder            │
└──────────────────────────────────────────────────────┘
```

- **Why pi-host inside the container:** extensions are arbitrary TypeScript and must execute behind the boundary, never in the shell. The SDK (vs external RPC) lets pi-host install the ui shim and intercept events. The most important security decision in the design.
- **Bridge protocol:** three message families on one duplex JSONL stream - agent events (container → host, passthrough of Pi session events), commands (host → container: `prompt`, `steer`, `follow_up`, `abort`, `command("/...")`, `shutdown`), and UI intents/responses. Versioned envelope from day one. LF-only framing (Pi's RPC docs warn about this).

### The UI intent contract (the public spec)

pi-host provides a shim implementation of `ctx.ui` that serialises each call into a declarative intent and awaits the host's response:

- `notify` → toast. `select`/settings lists → native list/form modals, resolving the extension's promise with the user's choice.
- `setStatus`/`setWidget` → chips and dockable panels around the chat.
- `renderCall`/`renderResult` → declarative renderer registry: `markdown`, `diff`, `table`, `progress`, `json`.
- **Escape hatch:** an `html` intent in a CSP-locked, no-Node iframe, postMessage only. Opt-in per package, visibly badged. Cut from v1 if hairy.
- **Degradation rule:** extensions that construct raw TUI components (custom `render()` code) degrade to plain text or an "unsupported UI" notice; their tools still work. New-style extensions use a `piwork-ui` helper lib to emit intents directly. One extension codebase, TUI and GUI - the adoption wedge.

⚠️ Feasibility depends on how the SDK exposes the ui implementation, and whether built-in commands flow through the same surface. Both are spike 0.

### Workspace model

- A **workspace** = one host folder + one container + one config volume + its sessions. Lazy container start, idle shutdown. Default image = `node:24-bookworm-slim` + git + ripgrep + Pi + the Suite preinstalled; per-workspace Dockerfile override for anything else.
- **Auth:** `auth.json` in the named volume, populated via `/login` relayed through the shell. Host credentials never mounted.
- **Sessions:** Pi's JSONL tree files in the volume; `/resume`, `/tree`, `/fork` work through the command palette with no shell-side session code.

### Security model

- **Extensions are untrusted:** they run only in the container; the shell executes no package code - intents are schema-validated data. The Suite gets no special privileges; it uses the same contract as any third-party package.
- **Renderer sandboxed:** no Node integration, context isolation, html intents in locked iframes. **No docker socket in containers**, ever.
- **Blast radius per workspace:** the mounted folder is writable by design; `piwork-checkpoint` (Suite, optional) mitigates via auto-commit.
- Whatever credential the container holds, the agent can spend - sandboxing protects files, not tokens. Surface Pi's cost tracking in the footer; prefer per-workspace keys.

## The Piwork Suite

The Cowork parity layer, as separate packages. Each is a normal Pi extension using the intent contract - buildable in any order, individually removable, individually replaceable. Rough build order by value-for-effort:

| Package | What it does | Design notes | Effort |
|---|---|---|---|
| `piwork-renderers` | Rich tool output: diffs, tables, progress, file trees | Pure `renderCall`/`renderResult` mappings; no state. Do first - makes every other package and plain chat better. | S |
| `piwork-ask` | Cowork's AskUserQuestion: structured forms/selects the model can invoke as a tool | Adapt or wrap the existing `pi-ask-user` package rather than rewriting; its select calls already fit the shim. | S |
| `piwork-tasks` | Cowork's task list: a todo tool + persistent docked widget | `registerTool` for the model + `setWidget` for the panel. Persist in session entries so it survives `/reload` and compaction (prior art: `rpiv-todo`). | S-M |
| `piwork-artifacts` | Cowork's artifacts: live HTML/markdown outputs | Watches `/workspace/.artifacts/`, emits sandboxed `html`/`markdown` intents with a reload affordance. First consumer of the html escape hatch - drives that design. | M |
| `piwork-tree` | Visual session tree: branch graph, click-to-rewind | Reads session JSONL via `ctx.sessionManager`, emits a graph widget; rewind issues the same branch operations as `/tree`. The flagship demo. | M |
| `piwork-connectors` | Cowork's MCP connectors with a settings form | Bundles `pi-mcp-adapter`; a form intent writes its config; creds to the workspace volume. Mostly glue. | M |
| `piwork-packages` | In-app package browser/installer | An extension can shell out to `pi install` inside the container and trigger reload - so even this needn't be core. List intents over the registry API. | M |
| `piwork-checkpoint` | Safety net: git auto-commit before each turn | Thin wrapper over Pi's existing git-checkpointing example. Optional, off by default - the container is the permission model. | S |
| `piwork-scheduler` | Cowork's scheduled tasks | ⚠️ The one that can't be pure extension: schedules must fire when no container runs. Needs either (a) userland cron + `docker run pi -p` documented as the v1 answer, or (b) one extra host primitive - a timer service extensions can register against via intent. Decide at phase 3; bias to (a) first. | M-L |

Out-of-box experience: default image ships with the Suite preinstalled, so first run feels like Cowork - chat, tasks, forms, artifacts, connectors. `pi remove npm:piwork-tasks` strips any of it. The shell works with zero Suite installed; it's just sparse.

### Userland (deliberately not built, documented in the README)

- **Egress control** → the user's container/network config, not product surface. Document honestly.
- **Trust/curation badging** → Pi's stance is "review the source before installing"; Piwork keeps it.
- **Image customisation** → per-workspace Dockerfile override; the default image stays small.
- **Theming** → map Pi theme files to CSS variables if cheap; otherwise a user-editable stylesheet. No settings UI.

## Implementation plan

### Phase 0 - spikes (throwaway)

1. **SDK-in-container:** pi-host embedding Pi via `createAgentSession` in the Docker image, prompt in / events out over stdio. Reference local `docs/sdk.md` for the factory API and event types.
2. **UI shim go/no-go:** intercept `ctx.ui` for (a) one stock extension and (b) one built-in command (`/model`). If built-ins don't flow through the shim, the command palette shrinks and core grows - find out now. Fallback: RPC mode and a narrower contract.
3. ~~Read the OpenClaw source first~~ — blocked; OpenClaw is not installed locally and source is on GitHub (requires web). Defer to post-flight.

### Phase 1 - the shell

- One workspace, folder picker, container lifecycle, streaming chat with markdown, abort, steer (Enter) vs follow-up (Alt+Enter), command palette, `/login` relay.
- **Exit criterion: I stop using terminal Pi for one real project, with zero Suite installed.**

### Phase 2 - the contract

- Formalise the intent schema (the public spec), implement the shim properly, publish `piwork-ui` helper lib, degradation path for TUI-only extensions.
- Validate with `piwork-renderers` + `piwork-ask` - the two smallest Suite packages double as the contract's test suite.

### Phase 3 - the Suite

- Build in the table's order: `piwork-tasks`, `piwork-artifacts`, `piwork-tree`, `piwork-connectors`, `piwork-packages`, `piwork-checkpoint`. Each ships independently as it lands; the default image picks them up as they're released.
- Decide the scheduler question (cron docs vs host timer primitive).
- **Exit criterion: a non-terminal user can do a Cowork-shaped session end to end.**

### Phase 4 - open-source release

- Repo split: `piwork` (shell), `piwork-ui` (lib), `ui-intents` (spec), `piwork-suite` (monorepo of Suite packages).
- macOS signing, auto-update, CI. README leads with the core/Suite split and the "what the core didn't build" section. Pitch: *"Cowork chose your workflows for you. Piwork is the cowork where you choose them."*

## Risks

- **SDK ui shim infeasible** (high impact) - the whole design rests on it; spike 0 with an RPC fallback.
- **Built-in commands don't route through `ctx.ui`** (medium) - forces bespoke model/settings/session UI into core, roughly doubling shell scope. Also spike 0.
- **Suite quietly becomes core** (likely, cultural) - the pressure to "just ship it in the shell" will be constant. Defence: the Suite gets no privileged APIs; if a Suite package needs something third parties can't have, that's a contract gap to fix, not a core feature to add.
- **Pi SDK churn** (likely) - pin Pi versions per release, keep pi-host thin.
- **The `html` intent** (high severity if mishandled) - opt-in, badged, CSP-locked; `piwork-artifacts` is the forcing function to get it right or cut it.
- **Unrestricted egress** (certain until addressed) - acceptable for personal use; document rather than half-solve.

## Open Questions

1. Does the Pi SDK let the embedder supply the `ctx.ui` implementation, or does the shim need to monkey-patch? (Spike 0; local `docs/sdk.md` covers the API surface, extension types are in `docs/extensions.md`. OpenClaw cross-reference deferred until back online.)
2. Do built-in commands (`/model`, `/settings`, `/tree`) render through the same ui surface in SDK mode? Determines whether the command palette trick works. (Spike 0.)
3. Does the SDK expose the steering/follow-up queue distinction, or only plain prompts? (Local `docs/sdk.md` shows `steer()` and `followUp()` on `AgentSession` — looks answered.)
4. Scheduler: is userland cron good enough for v1, or is one host timer primitive worth the core growth? (Phase 3.)
5. Should the intent schema align with MCP's elicitation/UI proposals rather than being bespoke? **Blocked** — requires web access to check current MCP proposals. Defer until phase 2.
6. Naming: "Piwork" vs something less Cowork-adjacent - check trademark comfort before phase 4. **Blocked** — requires USPTO/trademark search online. Defer.

## References

- Local Pi docs (installed with npm package):
  - `docs/sdk.md` — AgentSession API, event types, prompting, extensions, tools, auth
  - `docs/extensions.md` — ExtensionAPI, factory interface
  - `docs/rpc.md` — JSON-RPC protocol
  - `docs/containerization.md` — container guidance
  - `docs/tui.md` — TUI component API (for understanding what ctx.ui renders)
  - `docs/themes.md`, `docs/skills.md`, `docs/packages.md` — supporting context
- ~~[OpenClaw](https://github.com/OpenClaw/OpenClaw)~~ — deferred; requires web access
- External references requiring web (defer to post-flight):
  - [pi.dev](https://pi.dev) and sub-pages for latest docs, package registry
  - [Agent Skills standard](https://agentskills.io)
  - MCP elicitation/UI proposals

# Contributing to Piwork

Thanks for your interest! Piwork is an early project — issues, ideas, and PRs are all welcome.

## What Piwork is (and why setup has an extra step)

Piwork isn't a plain Electron app. It's **three parts that work together**:

1. an **Electron shell** (the GUI on your machine),
2. a **Docker sandbox image** where the Pi agent actually runs (the trust boundary), and
3. **built-in extensions** baked into that image.

So running Piwork needs a container runtime, not just Node. See [`README.md`](README.md) for the
architecture.

## Prerequisites

- **Node ≥ 22.18** (Piwork runs `.ts` directly via native type-stripping — no build step for
  `pi-host`).
- **A Docker-compatible runtime with a working `docker` CLI**: Docker Desktop, colima, Rancher
  Desktop, or OrbStack. If `docker` isn't on your `PATH` (e.g. Rancher's is at `~/.rd/bin/docker`),
  set `PIWORK_DOCKER=/path/to/docker`.
- macOS is the primary target today.

## Setup

```bash
git clone https://github.com/alex-t-172/pi-work
cd pi-work
npm install            # installs workspaces (shell / pi-host / bridge-protocol / built-ins)
npm run image          # docker build -t piwork-sandbox:spike -f images/Dockerfile .
npm run dev            # launches Vite + Electron (auto-reload)
```

On first launch: **open a folder** to start a sandboxed session, then **connect a model** (e.g.
sign in to Anthropic) from the Models panel. A fresh agent store is auto-provisioned with the
built-in extensions.

## The dev loop

- **Renderer** (`packages/shell/src`) hot-reloads.
- **Electron main / preload** (`packages/shell/electron`) relaunches automatically.
- **`pi-host`, the built-in extensions, or the Dockerfile** are baked into the image → re-run
  `npm run image` and start a fresh session.
- To iterate on a **built-in extension** without rebuilding, the shell live-mounts the repo's
  `packages/` over the baked copy in dev (set `PIWORK_SUITE_DIR`), so edits + `/piwork-reload` apply live.

## Before you open a PR

```bash
npm run typecheck      # tsc across the shell
npm run lint           # eslint (0 errors required; a couple of hook-deps warnings are OK)
npm test               # bridge-protocol framing unit tests
npm run image          # build the sandbox image (RUNs verify-pi as a gate)
npm run verify:builtins # every default built-in loads from the image + registers its tools
```

CI runs all of these on every PR (`.github/workflows/ci.yml`). Two gates worth calling out:
`verify:pi` (inside `docker build`) asserts pi-host still binds to the pinned Pi SDK, and
`verify:builtins` asserts the built-in extensions still load. See
[`packages/pi-host/UPGRADING-PI.md`](packages/pi-host/UPGRADING-PI.md) for upgrading the Pi SDK.

A Prettier config exists (`npm run format`), but the codebase hasn't been reformatted yet, so
formatting isn't enforced in CI — match the surrounding style for now.

## Writing an extension

Piwork features are Pi extensions. Start from the worked example in
[`examples/extensions/piwork-checkpoint`](examples/extensions/piwork-checkpoint), or ask the agent
inside a running session — the baked **`writing-piwork-extensions`** skill guides it. The shape is
a `package.json` with `"pi": { "extensions": ["./extensions"] }` and one or more `.ts` files that
`export default (pi) => { … }`.

## PR conventions

- Keep PRs small and focused; describe the *why*, not just the *what*.
- Make sure the checks above pass locally. CI runs them too.

## Reporting bugs / ideas

Open an issue with the templates provided. For anything security-sensitive, see
[`SECURITY.md`](SECURITY.md) — please don't file a public issue for vulnerabilities.

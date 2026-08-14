# Upgrading the Pi SDK

Piwork embeds the Pi SDK (`@earendil-works/pi-coding-agent`) in `pi-host`, baked into the
sandbox image. This is the routine for moving to a new Pi version safely.

## Policy

- **Pin one minor/patch behind the latest** to reduce supply-chain exposure (e.g. use `0.84.0`
  when `0.84.1` is latest). The exact pin is in `packages/pi-host/package.json`.
- **Watch the pi-ai version floor.** Modern Pi packages import subpaths that only exist in
  newer pi-ai — e.g. `@earendil-works/pi-ai/compat` was added in **pi-ai 0.80.1**. A package that
  needs a subpath your pinned Pi lacks fails to load (the extension silently registers no tools).
  When adopting a package, check its `peerDependencies` pi-ai floor against your pin.

## Procedure

1. **Bump the pin** — one line in `packages/pi-host/package.json`:
   `"@earendil-works/pi-coding-agent": "<new-version>"`. This is the single authoritative
   version; the image installs from this file.
2. **Regenerate the lock** — from the repo root: `npm install --package-lock-only`. This locks
   the transitive `pi-ai` / `pi-agent-core` / `pi-tui` / `pi-client` / `pi-protocol` to the set
   the new Pi declares (Pi's own tested combination). Ignore the stray root-level pi-coding-agent
   entry — it's the dev-time resolution of the Suite packages' `"*"` peer and doesn't reach the
   container.
3. **Read the changelog** for every version between old and new, focusing on **Breaking Changes**.
   The SDK surface pi-host binds to is the import block at the top of `src/index.ts` (the
   documented "binding surface") plus `src/login.ts` (the isolated auth adapter). Reconcile any
   renamed/removed symbol in those two files only — the rest of pi-host is Pi-agnostic.
4. **Rebuild the image**: `docker build -t piwork-sandbox:spike -f images/Dockerfile .`
   The build runs `verify-pi` as a **gate** (step 5) — a broken binding fails the build here,
   not later in the GUI.
5. **Run the contract harness** (also runs automatically in the build):
   `npm --prefix packages/pi-host run verify:pi` (or `sh packages/pi-host/scripts/verify-pi.sh`).
   It asserts, against the built image: all imports resolve, `createRuntime` builds a session
   with **zero extension load errors**, the base commands register, built-in tools + the
   mcp-adapter load, `ModelRuntime` lists OAuth-capable providers, and the `before_agent_start`
   system-prompt hook works. Green here means the machine-checkable contract holds.
6. **Manual GUI pass** — the seams a harness can't fully cover:
   - Open a folder → chat **streams** markdown (the `message_update` delta path).
   - Model picker lists models (incl. custom `models.json`); switch model; thinking level.
   - **`/login` OAuth round-trip**: browser opens, paste the redirect URL/code back, `auth.json`
     is written, a subsequent prompt succeeds (exercises `login.ts`).
   - A connector (MCP) OAuth connect + status via the `piwork-mcp-*` commands.
   - Rewind to a human message; attach a file; `/piwork-reload`; view the system prompt.
7. **Commit** the `package.json` + `package-lock.json` + any `index.ts`/`login.ts` reconciliation
   together, referencing the Pi version.

## What tends to break (history)

- **0.80.8** removed `AuthStorage`; OAuth login moved to `ModelRuntime.login(providerId, type,
  interaction)`, and the named-callback bag collapsed into `AuthInteraction` =
  `{ notify(AuthEvent), prompt(AuthPrompt) }`. This is why `login.ts` is kept as a thin,
  isolated adapter — it's the most volatile seam.
- **0.83.0** bumped bundled TypeBox to 1.3.7 and removed deprecated `Type.*` / `Value.Mutate`
  APIs. Our config tools use plain JSON-schema objects (unaffected); check any extension that
  builds tool schemas with TypeBox.
- **0.84.0** made `message_update` emit **deltas only** (removed cumulative `message`/`partial`).
  The shell already assembles from `assistantMessageEvent` deltas, so this was a no-op — but a
  future client that reads cumulative fields would break.

## The mcp-adapter

`pi-mcp-adapter` is pinned separately in `images/Dockerfile` and loaded by a **direct import**
(not Pi's extension loader), so the self-contained `2.11.0` bake is insulated from the host Pi
version. `verify-pi` confirms it still loads against a new Pi. If it ever breaks at the
extension-API boundary, bump to an adapter release that targets the new Pi (`>=2.21.1` targets
0.84) and resolve its host-provided `pi-ai`/`pi-tui` (those releases are no longer
self-contained). See the pin comment in the Dockerfile.

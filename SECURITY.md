# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Instead:

- open a private **GitHub Security Advisory** on this repo, or
- email **alext@tessl.io**.

We'll acknowledge as soon as we can and keep you posted on a fix.

## The security model (what Piwork does and doesn't protect)

Piwork's core promise is that a coding agent runs in a **sandbox you control**. The design and
its boundaries:

- **The container is the trust boundary.** The agent (Pi + extensions) runs inside a Docker
  container. Only the folder you open is bind-mounted, at `/workspace` — the agent can read and
  write **there** and nowhere else on your machine. The global chat mounts no folder, so it has
  **no file access** at all.
- **The workspace is writable by design.** Inside the opened folder the agent can change and
  delete files — that's the point. Keep work in version control; the example
  `piwork-checkpoint` extension can auto-commit before each turn as a rollback net.
- **Credentials stay on the host / in the agent store.** Model and connector credentials live in
  the agent store (a Docker volume or a directory you point at), not in the workspace or the
  repo. OAuth is driven from the host: Piwork opens your real browser and the callback is caught
  by a loopback server bound to **`127.0.0.1` only**, then handed to the container to complete.
- **The renderer is locked down.** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. External links open in your real browser rather than navigating the app;
  artifact/HTML previews render in a sandboxed frame under a strict CSP.

## Non-goals / things to be aware of

- **No network egress restriction inside the container.** The agent can reach the internet (to
  call model APIs, install packages, etc.). Piwork sandboxes the **filesystem**, not the network.
- **MCP connectors and installed extensions run with the agent's privileges** inside the
  container and can use the network and the workspace. Only connect/install things you trust.
- **The image bundles third-party code** (the Pi SDK and `pi-mcp-adapter`, both MIT) — see
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
- Piwork is early software and has not had a formal security audit.

# Third-party notices

Piwork builds on the Pi ecosystem and bundles the following into its sandbox image. All are
MIT-licensed (like Piwork itself).

| Component | Role | License |
|---|---|---|
| [`@earendil-works/pi-coding-agent`](https://pi.dev) (and its `pi-ai` / `pi-tui` / `pi-agent-core` deps) | the Pi coding agent SDK, embedded by `pi-host` | MIT |
| [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) | the MCP connectors engine, baked into the image | MIT |

When you build the image (`npm run image`), these and their transitive dependencies are fetched
from npm. Their individual licenses ship inside their packages under `node_modules`.

The pinned Pi SDK version lives in `packages/pi-host/package.json`; the adapter version is pinned
in `images/Dockerfile`.

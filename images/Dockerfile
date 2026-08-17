# Piwork sandbox image.
#
# Based on Pi's documented containerization recipe (docs/containerization.md),
# plus pi-host (the SDK-embedding bridge) installed at /opt/pi-host.
#
# The Pi SDK is pulled in as pi-host's own dependency (pinned in
# packages/pi-host/package.json) rather than a global install, so `node` can
# resolve `@earendil-works/pi-coding-agent` by bare specifier from pi-host.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi-host
# Install pi-host deps (the pinned Pi SDK). package-lock is optional at this stage.
COPY packages/pi-host/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Bake the recommended MCP adapter (pi.dev/packages/pi-mcp-adapter) as the connectors
# engine — remote + OAuth MCP, standard mcp.json config. Extract the package to a PLAIN dir
# (not under node_modules) so Node 24 can type-strip its index.ts, then install its deps
# beside it. pi-host loads the extension in-process.
#
# PIN AN EXACT VERSION. Floating @2 silently broke us: newer releases (≥2.12) DROPPED
# typebox / @earendil-works/pi-ai / pi-tui from their package.json (they expect the Pi host
# to "remap" them to shims), so a standalone bake fails at import with ERR_MODULE_NOT_FOUND
# and MCP quietly doesn't load. 2.11.0 still DECLARES those as real deps, so `npm install`
# self-contains it. Bump deliberately (and re-verify the adapter imports) rather than floating.
# See packages/pi-host/UPGRADING-PI.md ("The mcp-adapter") for how it relates to the Pi version.
RUN mkdir -p /opt/pi-mcp-adapter && cd /opt/pi-mcp-adapter \
  && npm pack pi-mcp-adapter@2.11.0 --silent \
  && tar -xzf pi-mcp-adapter-*.tgz --strip-components=1 \
  && rm pi-mcp-adapter-*.tgz \
  && npm install --omit=dev --no-audit --no-fund

# Bake pi-subagents (the Pi ecosystem's subagent/delegation extension) as a built-in. Unlike our
# single-file built-ins it's an npm package with deps, so pack + install them beside it (like the
# adapter); Pi's extension loader aliases its @earendil-works/* + typebox peers to the host copies
# at load time. Baked OUTSIDE /opt/piwork-suite so the dev suite-mount doesn't shadow it (it's not
# a repo package). Default-installed via the seeded settings.json; removable in Customise.
RUN mkdir -p /opt/pi-subagents && cd /opt/pi-subagents \
  && npm pack pi-subagents@0.49.0 --silent \
  && tar -xzf pi-subagents-*.tgz --strip-components=1 \
  && rm pi-subagents-*.tgz \
  && npm install --omit=dev --no-audit --no-fund

# pi-host source (run directly via Node 24 native TypeScript type-stripping).
COPY packages/pi-host/src ./src
# Baked-in Piwork skills (always available: the "how to write an extension" guide).
COPY packages/pi-host/skills ./skills
# The Pi-SDK contract harness (also runnable at dev time via scripts/verify-pi.sh).
COPY packages/pi-host/scripts ./scripts
# Built-in extensions manifest (single source shared with the shell + the built-ins-load test).
COPY packages/pi-host/built-ins.json ./built-ins.json

# Piwork's built-in extensions (the Suite), baked at /opt/piwork-suite so a fresh install has
# them with no repo mount. They're DEFAULT-INSTALLED via the store's settings.json (seeded by
# the shell on first run) and fully removable in Customise — baking is delivery, not activation.
# In dev the shell mounts the repo's packages/ over this path (DEV_SUITE_DIR) for live editing.
# Each is a single .ts file with type-only imports, so no dependency install is needed.
COPY packages/piwork-ask       /opt/piwork-suite/piwork-ask
COPY packages/piwork-artifacts /opt/piwork-suite/piwork-artifacts
COPY packages/piwork-tasks     /opt/piwork-suite/piwork-tasks

# BUILD-TIME GATE: assert pi-host still binds to the pinned Pi SDK (all imports resolve,
# extensions load with zero errors, ModelRuntime/OAuth surface intact, system-prompt hook
# works). Runs offline as root. If a Pi upgrade breaks the binding, the IMAGE FAILS TO BUILD
# here rather than at runtime in the GUI. See packages/pi-host/UPGRADING-PI.md.
# The build-time agent dir is ephemeral (shadowed by the mounted store at runtime); remove it
# so the harness's cache files don't ship in the image.
RUN node --experimental-transform-types /opt/pi-host/scripts/verify-pi.mjs \
  && rm -rf /root/.pi/agent

# The mounted project lives here.
WORKDIR /workspace

ENV PIWORK_WORKSPACE=/workspace
# --experimental-transform-types (superset of type-stripping) so we can load .ts packages
# that use enums / namespaces / parameter properties (e.g. pi-mcp-adapter), which plain
# strip mode rejects. pi-host's own code is strip-compatible, so transform is safe for it too.
ENTRYPOINT ["node", "--experimental-transform-types", "/opt/pi-host/src/index.ts"]

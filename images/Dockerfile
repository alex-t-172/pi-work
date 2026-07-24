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
# beside it. pi-host loads the extension in-process. Pin the major to avoid surprise breakage.
RUN mkdir -p /opt/pi-mcp-adapter && cd /opt/pi-mcp-adapter \
  && npm pack pi-mcp-adapter@2 --silent \
  && tar -xzf pi-mcp-adapter-*.tgz --strip-components=1 \
  && rm pi-mcp-adapter-*.tgz \
  && npm install --omit=dev --no-audit --no-fund

# pi-host source (run directly via Node 24 native TypeScript type-stripping).
COPY packages/pi-host/src ./src
# Baked-in Piwork skills (always available: the "how to write an extension" guide).
COPY packages/pi-host/skills ./skills

# The mounted project lives here.
WORKDIR /workspace

ENV PIWORK_WORKSPACE=/workspace
# --experimental-transform-types (superset of type-stripping) so we can load .ts packages
# that use enums / namespaces / parameter properties (e.g. pi-mcp-adapter), which plain
# strip mode rejects. pi-host's own code is strip-compatible, so transform is safe for it too.
ENTRYPOINT ["node", "--experimental-transform-types", "/opt/pi-host/src/index.ts"]

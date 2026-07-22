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

# pi-host source (run directly via Node 24 native TypeScript type-stripping).
COPY packages/pi-host/src ./src
# Baked-in Piwork skills (always available: the "how to write an extension" guide).
COPY packages/pi-host/skills ./skills

# The mounted project lives here.
WORKDIR /workspace

ENV PIWORK_WORKSPACE=/workspace
ENTRYPOINT ["node", "/opt/pi-host/src/index.ts"]

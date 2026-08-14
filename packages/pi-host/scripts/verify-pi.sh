#!/usr/bin/env sh
# Run the verify-pi contract harness inside the Piwork image.
#
# Hermetic by design: it uses the container's own empty /root/.pi/agent, so it exercises the
# BAKED binding (pi-host base extension + mcp-adapter) without depending on the dev agent store
# or the Suite mount. scripts/ is mounted read-only so the harness can be iterated without a
# rebuild; src/ is baked, so index.ts changes need `docker build` first.
#
# Env overrides: PIWORK_IMAGE (default piwork-sandbox:spike), PIWORK_DOCKER (default docker).
set -eu

IMAGE="${PIWORK_IMAGE:-piwork-sandbox:spike}"
DOCKER="${PIWORK_DOCKER:-docker}"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

exec "$DOCKER" run --rm \
  -v "$SCRIPTS_DIR:/opt/pi-host/scripts:ro" \
  --entrypoint node \
  "$IMAGE" --experimental-transform-types /opt/pi-host/scripts/verify-pi.mjs

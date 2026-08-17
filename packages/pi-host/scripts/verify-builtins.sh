#!/usr/bin/env sh
# Run the built-ins-load check inside the Piwork image. Hermetic: the harness creates its own
# temp store, so it exercises the BAKED built-ins with no dev-mount. Env overrides: PIWORK_IMAGE
# (default piwork-sandbox:spike), PIWORK_DOCKER (default docker).
set -eu

IMAGE="${PIWORK_IMAGE:-piwork-sandbox:spike}"
DOCKER="${PIWORK_DOCKER:-docker}"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

exec "$DOCKER" run --rm \
  -v "$SCRIPTS_DIR:/opt/pi-host/scripts:ro" \
  --entrypoint node \
  "$IMAGE" --experimental-transform-types /opt/pi-host/scripts/verify-builtins.mjs

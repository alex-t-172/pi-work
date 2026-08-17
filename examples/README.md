# Examples

Reference extensions that are **not** installed by default and don't ship in the Piwork
image — they're here to show how to extend Piwork.

- [`extensions/piwork-checkpoint`](extensions/piwork-checkpoint) — git-commit the workspace
  before each agent turn (a rollback safety net). Demonstrates the `before_agent_start` hook.

To use one, install it by path from a running session (`/install <path>` then
`/piwork-reload`, or **Customise → Extensions → Install by source**).

The built-in extensions that *do* ship live under `packages/piwork-*`.

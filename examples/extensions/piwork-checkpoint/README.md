# piwork-checkpoint (example extension)

> **This is an example, not a built-in.** It is not installed by default and does not
> ship in the Piwork image. It lives here to show how to write a Piwork/Pi extension.

`piwork-checkpoint` git-commits the workspace before each agent turn, as a safety net you
can roll back to. It's a small, self-contained illustration of the extension pattern:

- a single `.ts` file under `extensions/`,
- a `before_agent_start` hook (runs code each turn),
- shelling out to `git` in the workspace,
- surfacing status to the user via `ctx.ui`.

## Try it in your own Piwork

From a running session, install it by path and reload:

```
# in the agent chat:
/install <absolute-path-to>/examples/extensions/piwork-checkpoint
/piwork-reload
```

Or add it in **Customise → Extensions → Install by source**. Remove it the same way.

## Writing your own

Copy this folder as a starting point. The shape is:

```
my-extension/
  package.json      # { "pi": { "extensions": ["./extensions"] }, peerDeps: pi-coding-agent }
  extensions/
    my-extension.ts # export default (pi) => { pi.on(...) / pi.registerTool(...) / pi.registerCommand(...) }
```

See the baked skill **writing-piwork-extensions** (available in every session) for the full guide.

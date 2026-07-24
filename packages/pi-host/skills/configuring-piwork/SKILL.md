---
name: configuring-piwork
description: How to configure Piwork ITSELF from the global chat — add global skills or extensions (commands, tools, UI panels, agent instructions) that load in every session. Use when the user asks to customise Piwork, add a global skill/tool/command, or "set yourself up", and you have the piwork_*_config tools.
---

# Configuring Piwork from the global console

You are the Piwork **global chat**: a folderless session with no access to the user's
files. You cannot read or write project files or the agent's credentials — there are no
file/bash tools. What you *can* do is configure **Piwork itself** through four tools:

- `piwork_list_config` — see the current global config files
- `piwork_read_config` — read one
- `piwork_write_config` — create/overwrite one
- `piwork_delete_config` — remove one

These write into Piwork's **global config**, which loads into *every* session (this global
chat and every project folder the user opens). All paths start with one of two folders:

- `skills/<name>/SKILL.md` — a **skill**: markdown guidance the agent loads on demand.
- `extensions/<name>/index.ts` — an **extension**: code adding slash `/commands`, tools, or
  UI. (A single-file extension is `extensions/<name>.ts` instead.) The entry file MUST be
  `index.ts` for the subdirectory form — `extension.ts` is NOT discovered. No build step:
  `.ts` loads directly (Node type-stripping).

## The loop

1. `piwork_list_config` to see what exists (read before overwriting).
2. `piwork_write_config` the file(s).
3. Tell the user to run **`/piwork-reload`** (or say you'll do it) so it goes live. New
   global skills/extensions then appear in this session *and* in their project work.

## A skill

`skills/<kebab-name>/SKILL.md` — YAML frontmatter (`name`, `description`) then markdown.
The `description` is what the agent matches on to decide when to load it, so make it
specific about *when* to use the skill.

```markdown
---
name: pr-review-style
description: The team's PR review conventions. Use when reviewing or writing a pull request.
---

# PR review style
- Lead with the risk, not the nitpicks.
- ...
```

## An extension

`extensions/<kebab-name>/index.ts` — default-export a function receiving the extension API.
Register a command and/or a tool:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("standup", {
    description: "Draft today's standup update",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Drafting standup…", "info");
      await ctx.prompt("Summarise what we did today as a standup update.");
    },
  });
}
```

Tools use `pi.registerTool({ name, label, description, parameters, execute })` where
`parameters` is a raw JSON Schema object and `execute(id, args)` returns
`{ content: [{ type: "text", text }] }`.

## Rules

- Keep names kebab-case and paths inside `skills/` or `extensions/` — writes anywhere else
  (including sibling files like credentials) are rejected.
- This is Piwork's *global* config. It is shared across all the user's projects, so keep
  it general-purpose; project-specific customisation belongs in that project's `.pi/`.
- You cannot change model providers or credentials from here — that's deliberate.

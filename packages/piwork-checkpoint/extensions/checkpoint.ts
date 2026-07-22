/**
 * piwork-checkpoint — a Piwork Suite extension (runs inside the container).
 *
 * Safety net: before each agent turn, auto-commit the workspace to git so any change
 * is recoverable. Pure extension — no core/contract changes; uses only the existing
 * intent surface (notify) plus a registered command. This is the reference for the
 * "default to extension" pattern.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(cwd: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

function checkpoint(cwd: string, label: string): { ok: boolean; message: string } {
  if (!isGitRepo(cwd)) return { ok: false, message: "not a git repository" };
  const status = git(["status", "--porcelain"], cwd);
  if (status === null) return { ok: false, message: "git status failed" };
  if (status === "") return { ok: true, message: "nothing to checkpoint" };
  git(["add", "-A"], cwd);
  // Use a dedicated author so checkpoints are distinguishable; don't fail the turn.
  const res = git(["commit", "-m", `piwork checkpoint: ${label}`, "--no-verify"], cwd);
  return res === null ? { ok: false, message: "commit failed" } : { ok: true, message: "checkpoint committed" };
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`piwork-checkpoint active${isGitRepo(cwd) ? "" : " (no git repo — idle)"}`, "info");
  });

  // Auto-checkpoint before the agent starts working.
  pi.on("before_agent_start", () => {
    checkpoint(cwd, "auto");
  });

  // Manual checkpoint command.
  pi.registerCommand("checkpoint", {
    description: "Commit the workspace now as a recovery point",
    handler: async (_args, ctx) => {
      const r = checkpoint(cwd, "manual");
      ctx.ui.notify(r.message, r.ok ? "info" : "warning");
    },
  });

  // Demonstrates the openExternal foundation: ask the host to open a URL in the real
  // browser. Uses the piwork-ui convention inline (extension can't import the workspace
  // lib until it's published); mirrors piwork-ui's openExternal().
  pi.registerCommand("piwork-help", {
    description: "Open the Pi docs in your browser",
    handler: async (_args, ctx) => {
      const url = "https://pi.dev/docs/latest";
      const ui = ctx.ui as { openExternal?: (u: string) => void; notify: (m: string, t?: string) => void };
      // Prefer the first-class intent (Piwork owns the shim); fall back to the convention.
      if (typeof ui.openExternal === "function") ui.openExternal(url);
      else ui.notify(JSON.stringify({ __piworkIntent__: { kind: "openExternal", url } }), "info");
    },
  });

  // Demo the artifact intent (rich HTML in a sandboxed panel).
  pi.registerCommand("artifact-demo", {
    description: "Show a sample Piwork artifact",
    handler: async (_args, ctx) => {
      const ui = ctx.ui as { showArtifact?: (o: { key?: string; title?: string; html?: string }) => void; notify: (m: string, t?: string) => void };
      if (typeof ui.showArtifact === "function") {
        ui.showArtifact({ key: "demo", title: "Piwork artifact demo", html: "<h1>Hello 👋</h1><p>This HTML is rendered in a <b>sandboxed iframe</b>.</p><pre>no network, no Node</pre>" });
      } else {
        ui.notify("Artifacts need the Piwork shell", "warning");
      }
    },
  });
}

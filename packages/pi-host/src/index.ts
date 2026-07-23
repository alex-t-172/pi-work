#!/usr/bin/env node
/**
 * pi-host — embeds the Pi SDK inside the container and bridges it to the Piwork
 * shell over JSONL stdio.
 *
 * Phase 0 / Spike A: this is a thin wrapper around Pi's shipped `runRpcMode`,
 * which already implements the whole bridge we need — a serialized `ctx.ui`
 * (extension_ui_request/response), event streaming, and the typed command
 * surface (prompt/steer/follow_up/abort/set_model/switch_session/fork/compact/…).
 *
 * The point of the spike is NOT to write protocol code (Pi ships it) — it is to
 * prove that this pipeline survives running inside Docker with stdio piped to the
 * host. Later phases vendor/extend `rpc-mode.js` to add the commands RPC lacks
 * (session-tree read, package install) and the OAuth-relay login flow.
 *
 * IMPORTANT: stdout is the protocol channel (runRpcMode takes it over). Only ever
 * write diagnostics to stderr.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  runRpcMode,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { runLogin } from "./login.ts";

const cwd = process.env.PIWORK_WORKSPACE ?? process.cwd();
// Per-workspace session dir (the shell sets this) so history is scoped per folder even
// when several workspaces share one agent store.
const sessionDir = process.env.PIWORK_SESSION_DIR || undefined;

/** Choose how the session opens, driven by the shell via PIWORK_SESSION. */
function pickSessionManager(): SessionManager {
  const sel = process.env.PIWORK_SESSION;
  if (sel && sel !== "new" && sel !== "recent") return SessionManager.open(sel, sessionDir);
  if (sel === "recent") return SessionManager.continueRecent(cwd, sessionDir);
  return SessionManager.create(cwd, sessionDir);
}

/** "list" mode: emit this workspace's past sessions (for the launcher), then exit. */
async function runList(): Promise<void> {
  const sessions = await SessionManager.list(cwd, sessionDir);
  const out = sessions.map((s) => ({
    path: s.path,
    id: s.id,
    name: s.name,
    firstMessage: s.firstMessage,
    messageCount: s.messageCount,
    created: s.created instanceof Date ? s.created.toISOString() : s.created,
    modified: s.modified instanceof Date ? s.modified.toISOString() : s.modified,
  }));
  process.stdout.write(JSON.stringify({ type: "piwork_sessions", sessions: out }) + "\n");
  setTimeout(() => process.exit(0), 50);
}

/** "resources" mode: enumerate loaded skills/extensions/prompts + configured packages. */
async function runResources(): Promise<void> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();

  const skills = loader.getSkills().skills.map((s) => ({
    name: s.name,
    description: s.description,
    scope: s.sourceInfo?.scope,
    origin: s.sourceInfo?.origin,
    source: s.sourceInfo?.source,
    path: s.filePath,
  }));
  const extensions = loader.getExtensions().extensions.map((e) => ({
    name: nodePath.basename(e.path),
    commands: [...e.commands.keys()],
    tools: [...e.tools.keys()],
    scope: e.sourceInfo?.scope,
    origin: e.sourceInfo?.origin,
    source: e.sourceInfo?.source,
    path: e.path,
  }));
  const prompts = loader.getPrompts().prompts.map((p) => ({
    name: p.name,
    description: p.description,
    scope: p.sourceInfo?.scope,
    source: p.sourceInfo?.source,
  }));

  let packages: unknown[] = [];
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    packages = pm.listConfiguredPackages().map((p) => ({ source: p.source, scope: p.scope, installedPath: p.installedPath, filtered: p.filtered }));
  } catch (e) {
    console.error("[pi-host:resources] package list failed:", e);
  }

  process.stdout.write(JSON.stringify({ type: "piwork_resources", skills, extensions, prompts, packages }) + "\n");
  setTimeout(() => process.exit(0), 50);
}

/** Protocol version — mirrors @piwork/bridge-protocol PROTOCOL_VERSION. */
const PROTOCOL_VERSION = 1;

function piVersion(): string {
  // The package restricts `exports` (no CJS "." main), so use the ESM resolver, then
  // walk up from the resolved entry to its nearest package.json.
  try {
    let dir = nodePath.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    for (let i = 0; i < 8; i++) {
      const pkg = nodePath.join(dir, "package.json");
      if (fs.existsSync(pkg)) {
        const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (json.name === "@earendil-works/pi-coding-agent") return json.version ?? "unknown";
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

// Baked-in "how to write a Piwork extension/skill" guide (see Dockerfile COPY).
const PIWORK_SKILLS_DIR = "/opt/pi-host/skills";

// Always-on base extension: gives every session a /piwork-reload command so newly
// authored/installed extensions, skills and connectors go live WITHOUT ending the
// session. Injected via the resource loader, so it needs no package install.
// Trim a SessionTreeNode into a compact serializable shape for the shell's tree view.
function trimTreeNode(node: any): any {
  const e = node?.entry ?? {};
  const msg = e.type === "message" ? e.message : undefined;
  const text = msg && Array.isArray(msg.content)
    ? msg.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ").trim()
    : "";
  return {
    id: e.id,
    type: e.type,
    role: msg?.role,
    label: node?.label,
    preview: text.slice(0, 140),
    children: Array.isArray(node?.children) ? node.children.map(trimTreeNode) : [],
  };
}

const piworkBaseExtension = (pi: {
  registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: any) => Promise<void> }) => void;
}) => {
  pi.registerCommand("piwork-reload", {
    description: "Reload Piwork skills, extensions & connectors without ending the session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Reloading resources…", "info");
      await ctx.reload();
    },
  });

  const emitTree = (ctx: any) => {
    const tree = ctx.sessionManager.getTree().map(trimTreeNode);
    ctx.ui.showSessionTree({ tree, leaf: ctx.sessionManager.getLeafId() });
  };

  // Show the session's branch tree in the shell.
  pi.registerCommand("piwork-tree", {
    description: "Show the session's branch tree (for the visual navigator)",
    handler: async (_args, ctx) => emitTree(ctx),
  });

  // Rewind the conversation to an earlier entry (creates/moves to that branch).
  pi.registerCommand("piwork-rewind", {
    description: "Rewind the conversation to an earlier point by entry id",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) return;
      const result = await ctx.navigateTree(id);
      ctx.ui.notify(result?.cancelled ? "Rewind cancelled" : "Rewound to an earlier point", result?.cancelled ? "warning" : "info");
      emitTree(ctx);
    },
  });
};

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: {
      extensionFactories: [piworkBaseExtension as never],
      ...(fs.existsSync(PIWORK_SKILLS_DIR) ? { additionalSkillPaths: [PIWORK_SKILLS_DIR] } : {}),
    },
  });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

async function main() {
  console.error(`[pi-host] starting; cwd=${cwd} agentDir=${getAgentDir()}`);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager: pickSessionManager(),
  });
  console.error(`[pi-host] runtime ready; entering rpc bridge`);

  // Emit the versioned handshake as the FIRST stdout line, before runRpcMode takes
  // over stdout. The shell reads this to confirm protocol compatibility and learn
  // the initial session id. (Serialized inline to keep the container image free of
  // extra workspace packages; shape mirrors @piwork/bridge-protocol BridgeHello.)
  const hello = {
    type: "piwork_hello",
    protocolVersion: PROTOCOL_VERSION,
    piVersion: piVersion(),
    sessionId: runtime.session.sessionId,
    cwd,
  };
  process.stdout.write(JSON.stringify(hello) + "\n");

  // ── Own the UI shim ──────────────────────────────────────────────────────────
  // We keep Pi's shipped runRpcMode (command loop, event stream, framing, backpressure,
  // session replacement) but AUGMENT the ctx.ui it hands extensions with first-class
  // Piwork intents. runRpcMode will call takeOverStdout() (which reroutes
  // process.stdout.write to stderr), so we capture the REAL stdout writer NOW and emit
  // our extra intents on it directly — same JSONL channel the shell already reads.
  const rawStdout = process.stdout.write.bind(process.stdout);
  const emitUiIntent = (method: string, extra: Record<string, unknown>) => {
    rawStdout(JSON.stringify({ type: "extension_ui_request", id: cryptoRandomId(), method, ...extra }) + "\n");
  };
  // Extra ctx.ui methods extensions can call (via the piwork-ui helper). Adding a new
  // first-class intent = one line here + a renderer in the shell. This is the whole point.
  const augmentUiContext = (ui: Record<string, unknown>) => ({
    ...ui,
    openExternal: (url: string) => emitUiIntent("openExternal", { url: String(url) }),
    // Render rich HTML/markdown in a sandboxed panel (the "artifact" escape hatch).
    showArtifact: (opts: { key?: string; title?: string; html?: string; markdown?: string }) =>
      emitUiIntent("artifact", {
        key: String(opts?.key ?? "default"),
        title: opts?.title != null ? String(opts.title) : undefined,
        html: opts?.html != null ? String(opts.html) : undefined,
        markdown: opts?.markdown != null ? String(opts.markdown) : undefined,
      }),
    clearArtifact: (key?: string) => emitUiIntent("artifact", { key: String(key ?? "default"), clear: true }),
    // Session-tree graph for the visual navigator.
    showSessionTree: (data: { tree: unknown; leaf: string | null }) => emitUiIntent("sessionTree", { tree: data.tree, leaf: data.leaf }),
  });
  // Patch bindExtensions on the AgentSession PROTOTYPE so it also covers sessions created
  // by replacement (new/fork/switch), which runRpcMode rebinds automatically.
  try {
    const proto = Object.getPrototypeOf(runtime.session) as { bindExtensions?: (b: unknown) => unknown };
    const orig = proto.bindExtensions;
    if (typeof orig === "function") {
      proto.bindExtensions = function (bindings: { uiContext?: Record<string, unknown> } & Record<string, unknown>) {
        const next = bindings?.uiContext ? { ...bindings, uiContext: augmentUiContext(bindings.uiContext) } : bindings;
        return orig.call(this, next);
      };
    } else {
      console.error("[pi-host] could not patch bindExtensions (openExternal will fall back to convention)");
    }
  } catch (e) {
    console.error("[pi-host] uiContext augmentation failed:", e);
  }

  await runRpcMode(runtime);
}

function cryptoRandomId(): string {
  // Avoid Math.random for id uniqueness; crypto is always present in Node.
  return crypto.randomUUID();
}

const mode = process.env.PIWORK_MODE;
const entry =
  mode === "login"
    ? runLogin(AuthStorage.create(nodePath.join(getAgentDir(), "auth.json")), process.env.PIWORK_LOGIN_PROVIDER)
    : mode === "list"
      ? runList()
      : mode === "resources"
        ? runResources()
        : main();

entry.catch((err) => {
  console.error("[pi-host] fatal:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

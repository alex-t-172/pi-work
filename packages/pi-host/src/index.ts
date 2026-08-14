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
// ── Pi SDK binding surface ──────────────────────────────────────────────────────────
// This import block is the SINGLE place pi-host binds to the Pi SDK. When upgrading Pi
// (see packages/pi-host/UPGRADING-PI.md), reconcile any renamed/removed symbols HERE and
// in login.ts (the isolated auth adapter); everything else in this file is Pi-agnostic.
// Pinned version lives in packages/pi-host/package.json. Current: pi-coding-agent 0.84.0.
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
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
    text: text.slice(0, 4000), // full-ish text so the shell can prefill on human-message rewind
    children: Array.isArray(node?.children) ? node.children.map(trimTreeNode) : [],
  };
}

// ── File-renderer contract ────────────────────────────────────────────────────────
// The renderer UI is sandboxed, so extensions can't inject render code. Instead they
// TRANSFORM a file into an artifact (html/markdown) that the base viewer renders. An
// extension registers a renderer on a well-known global (same in-process embed as the
// "own the shim" pattern); the base /piwork-render-file command dispatches to it and emits
// the result as an artifact. Renderers should register at load time (in their factory).
interface PiworkFileRenderer {
  id: string;
  label?: string;
  extensions?: string[]; // e.g. [".csv"] — matched case-insensitively
  match?: (relPath: string) => boolean; // or full control
  render: (input: { path: string; absPath: string; text: () => string }) =>
    { html?: string; markdown?: string } | Promise<{ html?: string; markdown?: string }>;
}
const piworkGlobal = globalThis as unknown as {
  __piwork?: { fileRenderers: PiworkFileRenderer[]; registerFileRenderer: (r: PiworkFileRenderer) => void };
};
if (!piworkGlobal.__piwork) {
  const fileRenderers: PiworkFileRenderer[] = [];
  piworkGlobal.__piwork = { fileRenderers, registerFileRenderer: (r) => fileRenderers.push(r) };
}

// Piwork's default system-prompt layer — APPENDED (never replaces) to Pi's base, so we keep
// Pi's carefully-tuned base + its updates, and user AGENTS.md/append/replace layer on top.
// Facts only (environment + boundaries); no persona/behaviour tuning. Visible in the prompt viewer.
const PIWORK_ENV_FOLDER = `You are running inside Piwork, a desktop app that puts pi behind a graphical chat rather than a terminal. A few facts about this environment:

- You work in a sandboxed container. Your working directory /workspace is a folder on the user's own machine that they chose to open, so the files you read and change there are their real files — but you cannot access anything outside /workspace.
- Files the user attaches in the chat are copied into .attachments/ in the workspace.
- The user reads your replies in a graphical app, not a terminal, so don't rely on keystroke- or TUI-only instructions.`;
const PIWORK_ENV_GLOBAL = `You are running inside Piwork, a desktop app for pi. This is a folderless global chat: you have no file access here, but you can help the user set up and customise Piwork itself — its global skills, commands, and tools.`;

export const piworkBaseExtension = (pi: {
  registerCommand: (name: string, opts: { description: string; handler: (args: string, ctx: any) => Promise<void> }) => void;
  on: (event: string, handler: (event: any, ctx: any) => unknown) => void;
}) => {
  // Append the Piwork environment layer to every turn's system prompt (chained onto Pi's base;
  // idempotent — the prompt is rebuilt each turn). Global chat gets the folderless variant.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${process.env.PIWORK_CONFIG_WRITABLE === "1" ? PIWORK_ENV_GLOBAL : PIWORK_ENV_FOLDER}`,
  }));
  // Render a workspace file through a registered file renderer (→ artifact). Silent no-op
  // when nothing matches: the shell has already shown the base (raw) view.
  pi.registerCommand("piwork-render-file", {
    description: "Render a workspace file into the viewer via a registered file renderer",
    handler: async (args, ctx) => {
      const rel = args.trim();
      if (!rel) return;
      const ext = nodePath.extname(rel).toLowerCase();
      const renderer = (piworkGlobal.__piwork?.fileRenderers ?? []).find(
        (r) => (r.match?.(rel) ?? false) || (r.extensions?.some((e) => e.toLowerCase() === ext) ?? false),
      );
      if (!renderer) return;
      const absPath = nodePath.isAbsolute(rel) ? rel : nodePath.join(cwd, rel);
      try {
        const out = await renderer.render({ path: rel, absPath, text: () => fs.readFileSync(absPath, "utf8") });
        if (out?.html || out?.markdown) {
          ctx.ui.showArtifact({ key: `file:${rel}`, title: `${nodePath.basename(rel)} (rendered)`, html: out.html, markdown: out.markdown });
        }
      } catch (e) {
        ctx.ui.notify(`Couldn't render ${nodePath.basename(rel)}: ${e instanceof Error ? e.message : String(e)}`, "warning");
      }
    },
  });

  pi.registerCommand("piwork-reload", {
    description: "Reload Piwork skills, extensions & connectors without ending the session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Reloading resources…", "info");
      await ctx.reload();
    },
  });

  // Emit the current composed system prompt so the shell can show it (read-only) — lets the
  // user see what they're editing before appending to / replacing it.
  pi.registerCommand("piwork-system-prompt", {
    description: "Show the agent's current system prompt in Piwork",
    handler: async (_args, ctx) => {
      const c = ctx as { getSystemPrompt?: () => string; ui: { showSystemPrompt?: (d: { prompt: string }) => void } };
      // getSystemPrompt() outside a turn returns the base (before the before_agent_start layer),
      // so append the SAME Piwork layer here to show exactly what the model gets each turn.
      const base = typeof c.getSystemPrompt === "function" ? c.getSystemPrompt() : "";
      const layer = process.env.PIWORK_CONFIG_WRITABLE === "1" ? PIWORK_ENV_GLOBAL : PIWORK_ENV_FOLDER;
      c.ui.showSystemPrompt?.({ prompt: `${String(base ?? "")}\n\n${layer}` });
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

  // ── MCP connector OAuth relay ─────────────────────────────────────────────────
  // Drive the baked pi-mcp-adapter's OAuth flow from the Piwork shell (not the model,
  // not the adapter's TUI). The flow is split: piwork-mcp-auth calls startAuth() → we open
  // the URL in the host browser (openExternal); the host's callback server catches the
  // redirect and calls back with piwork-mcp-complete → completeAuthFromInput(). Both run
  // in THIS process, so the adapter's in-memory pending-transport survives between them.
  const mcpFlow = () => import("/opt/pi-mcp-adapter/mcp-auth-flow.ts") as Promise<any>;
  const mcpConfig = () => import("/opt/pi-mcp-adapter/config.ts") as Promise<any>;
  const findServer = async (name: string): Promise<{ url?: string; def: any } | null> => {
    try {
      const { loadMcpConfig } = await mcpConfig();
      const cfg = loadMcpConfig(undefined, cwd);
      const def = cfg?.mcpServers?.[name];
      return def ? { url: def.url, def } : null;
    } catch (e) {
      console.error("[pi-host] mcp config load failed:", e);
      return null;
    }
  };
  const emitMcpStatus = async (ctx: any) => {
    try {
      const { loadMcpConfig } = await mcpConfig();
      const { getAuthStatus, supportsOAuth } = await mcpFlow();
      const cfg = loadMcpConfig(undefined, cwd);
      const servers = cfg?.mcpServers ?? {};
      const out = [] as Array<{ name: string; oauth: boolean; status: string }>;
      for (const [name, def] of Object.entries(servers)) {
        const oauth = !!supportsOAuth(def);
        out.push({ name, oauth, status: oauth ? await getAuthStatus(name) : "n/a" });
      }
      ctx.ui.showMcpStatus?.({ servers: out });
    } catch (e) {
      console.error("[pi-host] mcp status failed:", e);
    }
  };

  pi.registerCommand("piwork-mcp-auth", {
    description: "Begin OAuth for an MCP connector (opens the browser)",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) return;
      const found = await findServer(name);
      if (!found) { ctx.ui.notify(`Connector "${name}" not found`, "error"); return; }
      try {
        const { startAuth, supportsOAuth } = await mcpFlow();
        if (!supportsOAuth(found.def)) { ctx.ui.notify(`"${name}" doesn't use OAuth`, "warning"); return; }
        const { authorizationUrl } = await startAuth(name, found.url, found.def);
        if (!authorizationUrl) { ctx.ui.notify(`"${name}" is already connected`, "info"); await emitMcpStatus(ctx); return; }
        ctx.ui.openExternal(authorizationUrl); // host opens it; host callback server finishes
      } catch (e) {
        ctx.ui.notify(`Couldn't start OAuth for "${name}": ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("piwork-mcp-complete", {
    description: "Finish MCP OAuth from the captured redirect (host-driven)",
    handler: async (args, ctx) => {
      // args: "<server> <redirectUrl>" — server is a single token, URL is the rest.
      const trimmed = args.trim();
      const sp = trimmed.indexOf(" ");
      if (sp < 0) return;
      const name = trimmed.slice(0, sp);
      const redirectUrl = trimmed.slice(sp + 1).trim();
      try {
        const { completeAuthFromInput } = await mcpFlow();
        await completeAuthFromInput(name, redirectUrl);
        ctx.ui.notify(`Connected "${name}" ✓`, "info");
        await emitMcpStatus(ctx);
      } catch (e) {
        ctx.ui.notify(`Couldn't finish connecting "${name}": ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("piwork-mcp-logout", {
    description: "Disconnect an MCP connector (clear its OAuth credentials)",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) return;
      try {
        const { removeAuth } = await mcpFlow();
        await removeAuth(name);
        ctx.ui.notify(`Disconnected "${name}"`, "info");
        await emitMcpStatus(ctx);
      } catch (e) {
        ctx.ui.notify(`Couldn't disconnect "${name}": ${e instanceof Error ? e.message : String(e)}`, "warning");
      }
    },
  });

  pi.registerCommand("piwork-mcp-status", {
    description: "Report MCP connector auth status to the shell",
    handler: async (_args, ctx) => emitMcpStatus(ctx),
  });

  // Rewind the conversation to an earlier entry (creates/moves to that branch).
  pi.registerCommand("piwork-rewind", {
    description: "Rewind the conversation to an earlier point by entry id",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) return;
      const result = await ctx.navigateTree(id);
      if (result?.cancelled) {
        ctx.ui.notify("Rewind cancelled", "warning");
        return;
      }
      // For a human message the shell prefills the composer locally from the tree node's
      // text; navigateTree's editorText is unreliable in headless mode.
      if (result?.editorText) ctx.ui.setEditorText(result.editorText);
      ctx.ui.notify("Rewound", "info");
      emitTree(ctx);
    },
  });
};

// The global console can configure Piwork itself. Global skills/extensions live in Pi's
// NATIVE global-scan locations inside the agent store — ~/.pi/agent/{skills,extensions}/ —
// so they auto-load in EVERY session (this global chat + every project) with no extra
// wiring. Enabled only in the global console (PIWORK_CONFIG_WRITABLE).
const CONFIG_WRITABLE = process.env.PIWORK_CONFIG_WRITABLE === "1";

// Phase-2 global console: purpose-built tools that let the global chat author those global
// skills/extensions WITHOUT any raw file/bash tool. The session runs with noTools:"builtin",
// so these are the ONLY filesystem reach — and they are hard-scoped to the skills/ and
// extensions/ subtrees of the agent store, so their SIBLINGS (auth.json/models.json/
// sessions/) stay unreachable by construction.
const piworkConfigExtension = (pi: {
  registerTool: (t: {
    name: string; label: string; description: string; parameters: unknown;
    execute: (id: string, args: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }) => void;
}) => {
  const agentDir = getAgentDir();
  const roots: Record<string, string> = {
    skills: nodePath.join(agentDir, "skills"),
    extensions: nodePath.join(agentDir, "extensions"),
  };
  // Resolve a caller path, allowing ONLY things under skills/ or extensions/. Rejects `..`
  // traversal, absolute escapes, and any sibling of the two allowed roots (e.g. auth.json).
  const resolve = (rel: unknown): string => {
    const clean = String(rel ?? "").replace(/^[/\\]+/, "");
    const top = clean.split(/[/\\]/)[0];
    const rootDir = roots[top];
    if (!rootDir) throw new Error(`path must start with "skills/" or "extensions/" (got "${String(rel)}")`);
    const full = nodePath.resolve(agentDir, clean);
    if (full !== rootDir && !full.startsWith(rootDir + nodePath.sep)) throw new Error(`path "${String(rel)}" escapes ${top}/`);
    return full;
  };
  const text = (t: string) => ({ content: [{ type: "text", text: t }] });
  const walk = (dir: string, base: string, out: string[]) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(nodePath.join(dir, e.name), rel, out);
      else out.push(rel);
    }
  };
  const scoped = { type: "object", additionalProperties: false } as const;
  const pathParam = { type: "string", description: 'path under skills/ or extensions/, e.g. "skills/my-skill/SKILL.md" or "extensions/my-ext/index.ts"' };

  pi.registerTool({
    name: "piwork_list_config",
    label: "Piwork: list config",
    description: "List Piwork's own GLOBAL config files: skills under skills/, extensions under extensions/. These customise Piwork itself and load in every session (this chat and every project) — they are NOT the user's project files.",
    parameters: { ...scoped, properties: {} },
    execute: async () => {
      const out: string[] = [];
      for (const [name, dir] of Object.entries(roots)) walk(dir, name, out);
      return text(out.length ? out.sort().join("\n") : "(no Piwork global config files yet)");
    },
  });
  pi.registerTool({
    name: "piwork_read_config",
    label: "Piwork: read config",
    description: "Read one of Piwork's global config files (under skills/ or extensions/).",
    parameters: { ...scoped, properties: { path: pathParam }, required: ["path"] },
    execute: async (_id, args) => text(fs.readFileSync(resolve(args?.path), "utf8")),
  });
  pi.registerTool({
    name: "piwork_write_config",
    label: "Piwork: write config",
    description: 'Create or overwrite one of Piwork\'s global config files (creating parent folders). A skill is "skills/<name>/SKILL.md"; an extension is "extensions/<name>/index.ts" (subdirectory form) or "extensions/<name>.ts" (single file) — NOT extension.ts. After writing, run /piwork-reload to load it.',
    parameters: { ...scoped, properties: { path: pathParam, content: { type: "string", description: "full file contents" } }, required: ["path", "content"] },
    execute: async (_id, args) => {
      const full = resolve(args?.path);
      fs.mkdirSync(nodePath.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(args?.content ?? ""), "utf8");
      return text(`Wrote ${args?.path}. Run /piwork-reload to load it into this session (it also loads in every project).`);
    },
  });
  pi.registerTool({
    name: "piwork_delete_config",
    label: "Piwork: delete config",
    description: "Delete one of Piwork's global config files or folders (under skills/ or extensions/). Run /piwork-reload afterwards.",
    parameters: { ...scoped, properties: { path: pathParam }, required: ["path"] },
    execute: async (_id, args) => {
      fs.rmSync(resolve(args?.path), { recursive: true, force: true });
      return text(`Deleted ${args?.path}. Run /piwork-reload to apply.`);
    },
  });
};

// Load the baked pi-mcp-adapter extension factory (in-process). Returns null if absent or
// unloadable — MCP then simply isn't available, but the session still runs.
async function loadMcpAdapter(): Promise<unknown | null> {
  const entry = "/opt/pi-mcp-adapter/index.ts";
  if (!fs.existsSync(entry)) return null;
  try {
    const mod = (await import(entry)) as { default?: unknown; extension?: unknown };
    const factory = (typeof mod.default === "function" && mod.default) || (typeof mod.extension === "function" && mod.extension) || null;
    if (!factory) { console.error("[pi-host] mcp-adapter: no callable extension export"); return null; }
    console.error("[pi-host] mcp-adapter loaded");
    return factory;
  } catch (e) {
    console.error("[pi-host] mcp-adapter load failed:", e instanceof Error ? e.stack ?? e.message : String(e));
    return null;
  }
}

export const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const factories: unknown[] = [piworkBaseExtension];
  // The authoring tools exist only in the global console; global skills/extensions they
  // write land in the agent store's native scan locations, so they load everywhere with
  // no additionalExtensionPaths/additionalSkillPaths wiring.
  if (CONFIG_WRITABLE) factories.push(piworkConfigExtension);
  // MCP connectors engine (baked pi-mcp-adapter). Loaded in-process as an extension factory;
  // defensive so a load failure degrades to "no MCP" rather than breaking the session.
  const mcpAdapter = await loadMcpAdapter();
  if (mcpAdapter) factories.push(mcpAdapter);
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: {
      extensionFactories: factories as never,
      ...(fs.existsSync(PIWORK_SKILLS_DIR) ? { additionalSkillPaths: [PIWORK_SKILLS_DIR] } : {}),
    },
  });
  // Global chat mode restricts built-in file tools (read/bash/edit/write); extension &
  // connector tools remain, so it's chat + connectors/skills with no filesystem reach.
  const noTools = process.env.PIWORK_NO_TOOLS as "all" | "builtin" | undefined;
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, ...(noTools ? { noTools } : {}) })),
    services,
    diagnostics: services.diagnostics,
  };
};

// Initialize Pi's TUI theme singleton. Pi's theme is a globalThis-keyed singleton that
// THROWS "Theme not initialized" on any access before initTheme() runs. Interactive/TUI
// mode calls this; our headless RPC embed doesn't — but extensions that render status/UI
// (e.g. pi-mcp-adapter's status bar) still touch the theme and would crash the session.
// The package's `exports` map blocks the deep specifier, so import the file by ABSOLUTE
// path (allowed) — and since the theme lives on globalThis, this sets the value every
// module instance reads. Defensive: a failure just means we skip it.
export async function initPiTheme(): Promise<void> {
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")); // …/dist/index.js
    const themePath = nodePath.join(nodePath.dirname(entry), "modes/interactive/theme/theme.js");
    const mod = (await import(themePath)) as { initTheme?: (name?: string, watch?: boolean) => void };
    mod.initTheme?.(undefined, false); // no file watcher in a container
    console.error("[pi-host] theme initialized (for extension status UI)");
  } catch (e) {
    console.error("[pi-host] theme init skipped:", e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  console.error(`[pi-host] starting; cwd=${cwd} agentDir=${getAgentDir()}`);
  await initPiTheme();
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
    showArtifact: (opts: { key?: string; title?: string; html?: string; markdown?: string; file?: string }) =>
      emitUiIntent("artifact", {
        key: String(opts?.key ?? "default"),
        title: opts?.title != null ? String(opts.title) : undefined,
        html: opts?.html != null ? String(opts.html) : undefined,
        markdown: opts?.markdown != null ? String(opts.markdown) : undefined,
        // A workspace file to present: the shell opens it host-side in the viewer (same
        // pipeline as the Files panel — renderers, images), so an artifact is just a file.
        file: opts?.file != null ? String(opts.file) : undefined,
      }),
    clearArtifact: (key?: string) => emitUiIntent("artifact", { key: String(key ?? "default"), clear: true }),
    // Session-tree graph for the visual navigator.
    showSessionTree: (data: { tree: unknown; leaf: string | null }) => emitUiIntent("sessionTree", { tree: data.tree, leaf: data.leaf }),
    // MCP connector auth status for the Connectors UI.
    showMcpStatus: (data: { servers: unknown }) => emitUiIntent("mcpStatus", { servers: data.servers }),
    // The composed system prompt (so the user can see what they're editing/replacing).
    showSystemPrompt: (data: { prompt: string }) => emitUiIntent("systemPrompt", { prompt: String(data?.prompt ?? "") }),
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
async function dispatch(): Promise<void> {
  if (mode === "login") {
    // 0.84: OAuth login is driven by ModelRuntime (AuthStorage was removed). Bind it to the
    // same auth.json the session uses so credentials land where the runtime later reads them.
    const runtime = await ModelRuntime.create({ authPath: nodePath.join(getAgentDir(), "auth.json") });
    return runLogin(runtime, process.env.PIWORK_LOGIN_PROVIDER);
  }
  if (mode === "list") return runList();
  if (mode === "resources") return runResources();
  return main();
}

// Only launch when run as the entrypoint. Importing this module (e.g. the verify-pi harness,
// which reuses createRuntime / piworkBaseExtension) must NOT start the RPC bridge or exit.
const isEntrypoint = !!process.argv[1] && fileURLToPath(import.meta.url) === nodePath.resolve(process.argv[1]);
if (isEntrypoint) {
  dispatch().catch((err) => {
    console.error("[pi-host] fatal:", err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}

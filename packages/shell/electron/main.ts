/**
 * Electron main process.
 *
 * Responsibilities (the irreducible host-side core):
 *   - create the sandboxed window,
 *   - own the container lifecycle via ContainerBridge,
 *   - relay bridge messages <-> renderer over IPC,
 *   - open OAuth URLs in a real browser (shell.openExternal).
 *
 * It executes NO extension code — everything from the container is schema-shaped data
 * forwarded to the renderer to render.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { ContainerBridge } from "./container.ts";

const DOCKER = process.env.PIWORK_DOCKER || "docker";

// ── Logging ──────────────────────────────────────────────────────────────────────
// A single rolling log file (truncated each launch) plus a tee to the terminal, so
// bug reports are one `cat` away. Captures every bridge message (both directions),
// container stderr, renderer errors, and lifecycle.
const LOG_DIR = path.join(os.homedir(), ".piwork", "logs");
const LOG_FILE = path.join(LOG_DIR, "piwork.log");
let logStream: fs.WriteStream | undefined;
function initLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
  } catch (e) {
    process.stderr.write(`[piwork] could not open log file: ${String(e)}\n`);
  }
  log(`piwork shell starting — log file: ${LOG_FILE}`);
  process.stdout.write(`\n[piwork] logging to ${LOG_FILE}\n\n`);
}
function log(line: string) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  logStream?.write(entry);
  process.stdout.write(entry);
}
/** Compact one-line summary of a bridge payload for the log. */
function summarize(channel: string, payload: unknown): string {
  const p = payload as Record<string, any>;
  if (channel === "event" && p?.type === "message_update") {
    const ev = p.assistantMessageEvent;
    const d = typeof ev?.delta === "string" ? ` ${JSON.stringify(ev.delta.slice(0, 40))}` : "";
    return `event message_update/${ev?.type}${d}`;
  }
  if (channel === "event") return `event ${p?.type}`;
  if (channel === "ui_request") return `ui_request ${p?.method}`;
  if (channel === "response") return `response ${p?.command} success=${p?.success}${p?.error ? " err=" + p.error : ""}`;
  if (channel === "hello") return `hello pi=${p?.piVersion} session=${p?.sessionId}`;
  if (channel === "stderr") return `stderr ${String(payload).trimEnd()}`;
  if (channel === "exit") return `exit code=${p?.code}`;
  if (channel === "error") return `error ${p?.message}`;
  return channel;
}

const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";
const DEV_URL = process.env.PIWORK_DEV_URL; // set by dev script to the Vite server

// Optional dev/e2e knobs so the shell can run against this machine's local Ollama
// exactly like the proven spike (bind an agent dir + reach host.docker.internal).
// Env paths can get polluted by shell hooks (e.g. fnm prints "Using Node vX" when a
// subshell cd's, contaminating $(cd .. && pwd)). Defend: take the last non-empty line
// and trim, so a stray banner line can't produce a broken -v volume spec.
function cleanPath(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const last = v.split("\n").map((s) => s.trim()).filter(Boolean).pop();
  return last || undefined;
}

// In dev (launched by dev-electron, which sets PIWORK_DEV_URL) auto-fill the dev knobs
// so a bare `npm run dev` "just works" — no fragile env-var incantation to remember.
const IS_DEV = !!process.env.PIWORK_DEV_URL;
// __dirname is <repo>/packages/shell/dist/electron in dev → the suite dir is ../../..
const DEV_SUITE_GUESS = path.resolve(__dirname, "..", "..", "..");
const DEV_HOME_AGENT = path.join(os.homedir(), ".piwork-agent");

const DEV_AGENT_DIR = cleanPath(process.env.PIWORK_AGENT_DIR)
  ?? (IS_DEV && fs.existsSync(DEV_HOME_AGENT) ? DEV_HOME_AGENT : undefined);
const DEV_ADD_HOST_GATEWAY = process.env.PIWORK_ADD_HOST_GATEWAY === "1" || IS_DEV; // reach host Ollama by default in dev
// Host path to the monorepo `packages/` dir, mounted at /opt/piwork-suite so Suite
// extensions installed by local path (pi install /opt/piwork-suite/<pkg>) resolve.
const DEV_SUITE_DIR = cleanPath(process.env.PIWORK_SUITE_DIR)
  ?? (IS_DEV && fs.existsSync(path.join(DEV_SUITE_GUESS, "piwork-checkpoint")) ? DEV_SUITE_GUESS : undefined);
// Mount the suite AND the repo's root node_modules (at /opt/node_modules) so mounted
// suite packages resolve hoisted deps (e.g. the MCP SDK) — resolution walks up from
// /opt/piwork-suite/<pkg> to /opt/node_modules. (Prod installs deps via pi install.)
const suiteMountArgs = DEV_SUITE_DIR
  ? ["-v", `${DEV_SUITE_DIR}:/opt/piwork-suite:ro`, "-v", `${path.join(DEV_SUITE_DIR, "..", "node_modules")}:/opt/node_modules:ro`]
  : [];

let win: BrowserWindow | undefined;
let bridge: ContainerBridge | undefined;
let loginBridge: ContainerBridge | undefined;
/** Remembered so an OAuth login can target the SAME agent store the session uses. */
let lastAgent: { workspace: string; agentHostDir?: string; agentVolume?: string } | undefined;

// ONE shared agent store across all projects = the "global" home (like ~/.pi for CLI
// agents). Per-folder isolation comes from the session dir, not separate volumes — so a
// globally-installed skill/plugin is visible in every project's sessions.
function agentMount() {
  return {
    agentHostDir: DEV_AGENT_DIR,
    agentVolume: DEV_AGENT_DIR ? undefined : "piwork-agent",
  };
}

// A neutral empty folder used as /workspace for GLOBAL resource operations (so no
// project .pi leaks in). Lives under a shared path so Rancher mounts it.
function globalCwd(): string {
  const dir = path.join(os.homedir(), ".piwork", "global-cwd");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}
/** Resolve a renderer-supplied workspace ("" / null ⇒ global operations). */
function resolveWs(workspace: string | null | undefined): string {
  return workspace && workspace.length > 0 ? workspace : globalCwd();
}

/** Per-workspace session dir (container path) so history is scoped per folder. */
function sessionDirFor(workspace: string): string {
  return `/root/.pi/agent/sessions/ws-${hash(workspace)}`;
}

// Recent-folders store (host side), for the launcher.
const RECENT_FILE = path.join(os.homedir(), ".piwork", "recent.json");
function readRecent(): string[] {
  try {
    const arr = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function addRecent(workspace: string) {
  const next = [workspace, ...readRecent().filter((w) => w !== workspace)].slice(0, 12);
  try {
    fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
    fs.writeFileSync(RECENT_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    log(`could not write recent folders: ${String(e)}`);
  }
}

/** Run pi-host "list" mode as a short-lived container; return this workspace's sessions. */
function listSessions(workspace: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    const args = [
      "run", "--rm",
      "-e", "PIWORK_MODE=list",
      "-e", `PIWORK_SESSION_DIR=${sessionDirFor(workspace)}`,
      "-v", `${workspace}:/workspace`, ...agentVolArgs(),
      IMAGE,
    ];
    const p = spawn(DOCKER, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => resolve([]));
    p.on("exit", () => {
      const line = out.split("\n").find((l) => l.includes("piwork_sessions"));
      try {
        resolve(JSON.parse(line ?? "").sessions ?? []);
      } catch {
        resolve([]);
      }
    });
  });
}

function createWindow() {
  const dir = __dirname; // esbuild emits CJS; __dirname === dist/electron
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: "Piwork",
    webPreferences: {
      preload: path.join(dir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(dir, "..", "renderer", "index.html"));
}

function forward(channel: string, payload: unknown) {
  log(`→ ${summarize(channel, payload)}`);
  win?.webContents.send("piwork:message", { channel, payload });
}

function wireBridge(b: ContainerBridge) {
  b.on("hello", (h) => forward("hello", h));
  b.on("event", (e) => forward("event", e));
  b.on("ui_request", (r) => forward("ui_request", r));
  b.on("response", (r) => forward("response", r));
  b.on("stderr", (c) => forward("stderr", c));
  b.on("exit", (code) => forward("exit", { code }));
  b.on("error", (err) => forward("error", { message: err.message }));
}

ipcMain.handle("piwork:pickWorkspace", async () => {
  const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
});

async function startSessionFor(workspace: string, session?: string, opts?: { global?: boolean }): Promise<{ ok: boolean; error?: string }> {
  try {
    // Detach the old bridge before stopping it, so its intentional "exit" (from replacing it,
    // e.g. during a reconnect) isn't forwarded to the renderer and mistaken for a fresh drop.
    if (bridge) { const old = bridge; bridge = undefined; old.removeAllListeners(); await old.stop(); }
    bridge = new ContainerBridge();
    wireBridge(bridge);
    const mount = agentMount();
    lastAgent = { workspace, ...mount };
    if (!opts?.global) addRecent(workspace); // global chat isn't a folder
    log(`starting ${opts?.global ? "GLOBAL " : ""}session: workspace=${workspace} session=${session ?? "new"} agentDir=${mount.agentHostDir ?? mount.agentVolume} suite=${DEV_SUITE_DIR ?? "(none)"}`);
    bridge.start({
      workspace,
      image: IMAGE,
      addHostGateway: DEV_ADD_HOST_GATEWAY,
      ...mount,
      extraDockerArgs: [...suiteMountArgs, ...shareAgentsArgs(), ...mcpMountArgs()],
      env: {
        PIWORK_SESSION_DIR: sessionDirFor(workspace),
        PIWORK_WS_KEY: hash(workspace),
        MCP_OAUTH_CALLBACK_PORT: String(MCP_CALLBACK_PORT), // adapter's in-container listener (vestigial); we catch on the host
        ...(session ? { PIWORK_SESSION: session } : {}),
        // Global console: chat-only (no filesystem tools) + purpose-built config-authoring
        // tools scoped to the agent store's skills/ & extensions/ (Pi's native global-scan
        // locations), so it can configure Piwork itself without reaching credentials.
        ...(opts?.global ? { PIWORK_NO_TOOLS: "builtin", PIWORK_CONFIG_WRITABLE: "1" } : {}),
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle("piwork:startSession", (_e, workspace: string, session?: string) => startSessionFor(workspace, session));
// Global chat: folderless (mount only the neutral global cwd → no host files), tool-restricted.
ipcMain.handle("piwork:startGlobalSession", (_e, session?: string) => startSessionFor(globalCwd(), session, { global: true }));
ipcMain.handle("piwork:recentFolders", () => readRecent());
ipcMain.handle("piwork:listSessions", (_e, workspace: string) => listSessions(workspace));

// ── Resource manager (skills / plugins / extensions) ────────────────────────────
// Shell config store (e.g. whether to share the host's ~/.agents skills into the sandbox).
const CONFIG_FILE = path.join(os.homedir(), ".piwork", "config.json");
function getConfig(): { shareAgentsDir?: boolean } {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
function setConfig(patch: Record<string, unknown>) {
  const next = { ...getConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  } catch (e) { log(`could not write config: ${String(e)}`); }
  return next;
}
/** Opt-in: mount the host's global ~/.agents skills read-only into the sandbox. */
function shareAgentsArgs(): string[] {
  if (!getConfig().shareAgentsDir) return [];
  const dir = path.join(os.homedir(), ".agents");
  return fs.existsSync(dir) ? ["-v", `${dir}:/root/.agents:ro`] : [];
}
function agentVolArgs(): string[] {
  const m = agentMount();
  return m.agentHostDir ? ["-v", `${m.agentHostDir}:/root/.pi/agent`] : ["-v", `${m.agentVolume}:/root/.pi/agent`];
}

function listResources(workspace: string): Promise<Record<string, unknown>> {
  const cwd = resolveWs(workspace);
  return new Promise((resolve) => {
    const args = [
      "run", "--rm", "-e", "PIWORK_MODE=resources",
      "-v", `${cwd}:/workspace`, ...agentVolArgs(), ...suiteMountArgs, ...shareAgentsArgs(),
      IMAGE,
    ];
    const p = spawn(DOCKER, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => resolve({ skills: [], extensions: [], prompts: [], packages: [] }));
    p.on("exit", () => {
      const line = out.split("\n").find((l) => l.includes("piwork_resources"));
      try { resolve(JSON.parse(line ?? "")); } catch { resolve({ skills: [], extensions: [], prompts: [], packages: [] }); }
    });
  });
}

/** Run the pi CLI (install/remove) in a one-shot container against this workspace's store. */
function runPi(workspace: string, cliArgs: string[]): Promise<{ ok: boolean; output: string }> {
  const cwd = resolveWs(workspace);
  return new Promise((resolve) => {
    const args = [
      "run", "--rm", "--entrypoint", "/opt/pi-host/node_modules/.bin/pi",
      "-w", "/workspace",
      "-v", `${cwd}:/workspace`, ...agentVolArgs(), ...suiteMountArgs,
      IMAGE, ...cliArgs,
    ];
    log(`pi ${cliArgs.join(" ")}`);
    const p = spawn(DOCKER, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("error", (e) => resolve({ ok: false, output: String(e) }));
    p.on("exit", (code) => resolve({ ok: code === 0, output: out }));
  });
}

ipcMain.handle("piwork:listResources", (_e, workspace: string) => listResources(workspace));
ipcMain.handle("piwork:installPackage", async (_e, workspace: string, source: string, scope: "global" | "project") => {
  const r = await runPi(workspace, scope === "project" ? ["install", "-l", source] : ["install", source]);
  return { ok: r.ok, error: r.ok ? undefined : r.output.trim().split("\n").slice(-3).join("\n") };
});
ipcMain.handle("piwork:removePackage", async (_e, workspace: string, source: string, scope: "global" | "project") => {
  const r = await runPi(workspace, scope === "project" ? ["remove", "-l", source] : ["remove", source]);
  return { ok: r.ok, error: r.ok ? undefined : r.output.trim().split("\n").slice(-3).join("\n") };
});
ipcMain.handle("piwork:reloadSession", async () => {
  // Prefer a LIVE reload via the always-on /piwork-reload command (ctx.reload()) — no
  // container restart, conversation preserved. Fall back to a restart if no live session.
  if (bridge) {
    log("reload: /piwork-reload (live)");
    bridge.send({ type: "prompt", message: "/piwork-reload" });
    setTimeout(() => bridge?.send({ id: "get_commands", type: "get_commands" }), 1500); // refresh autocomplete
    return { ok: true };
  }
  if (lastAgent) return startSessionFor(lastAgent.workspace, "recent");
  return { ok: false, error: "no active session" };
});
ipcMain.handle("piwork:getConfig", () => getConfig());
ipcMain.handle("piwork:setConfig", (_e, patch: Record<string, unknown>) => setConfig(patch));

// Add (or update) a custom model in the agent store's models.json, then restart the session
// so its ModelRegistry re-reads it. Lets you use a model the pinned Pi SDK doesn't list yet
// (e.g. a just-released Opus) without waiting for an SDK bump: it merges into the built-in
// provider by id and reuses that provider's existing OAuth / API-key auth.
function mergeModel(json: Record<string, any>, provider: string, model: Record<string, unknown>): void {
  json.providers = json.providers && typeof json.providers === "object" ? json.providers : {};
  const p = json.providers[provider] && typeof json.providers[provider] === "object" ? json.providers[provider] : (json.providers[provider] = {});
  p.models = Array.isArray(p.models) ? p.models : [];
  const i = p.models.findIndex((x: any) => x && x.id === (model as { id: string }).id);
  if (i >= 0) p.models[i] = model; else p.models.push(model);
}
ipcMain.handle("piwork:addModel", async (_e, m: { provider?: string; id?: string; name?: string }) => {
  try {
    const provider = String(m?.provider ?? "").trim();
    const id = String(m?.id ?? "").trim();
    if (!provider || !id) return { ok: false, error: "provider and model id are required" };
    const model: Record<string, unknown> = {
      id,
      ...(m?.name?.trim() ? { name: m.name.trim() } : {}),
      reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // display only; unknown for a custom model
    };
    const mount = agentMount();
    if (mount.agentHostDir) {
      const p = path.join(mount.agentHostDir, "models.json");
      let json: Record<string, any> = {};
      try { json = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* new file */ }
      mergeModel(json, provider, model);
      fs.mkdirSync(mount.agentHostDir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify(json, null, 2));
    } else {
      // Prod volume: main can't fs-touch a docker volume, so merge via a throwaway container.
      const script = "const fs=require('fs');const P='/root/.pi/agent/models.json';let j={};try{j=JSON.parse(fs.readFileSync(P,'utf8'))}catch{};const {provider,model}=JSON.parse(process.env.PW);j.providers=(j.providers&&typeof j.providers==='object')?j.providers:{};const p=(j.providers[provider]&&typeof j.providers[provider]==='object')?j.providers[provider]:(j.providers[provider]={});p.models=Array.isArray(p.models)?p.models:[];const i=p.models.findIndex(x=>x&&x.id===model.id);i>=0?(p.models[i]=model):p.models.push(model);fs.writeFileSync(P,JSON.stringify(j,null,2));";
      const r = spawnSync(DOCKER, ["run", "--rm", "--entrypoint", "node", "-e", `PW=${JSON.stringify({ provider, model })}`, IMAGE, "-e", script], { encoding: "utf8" });
      if (r.status !== 0) return { ok: false, error: `write failed: ${r.stderr || r.status}` };
    }
    log(`addModel: ${provider}/${id} → models.json`);
    // Re-read models.json: restart the live session so the ModelRegistry picks up the new model.
    if (bridge && lastAgent) await startSessionFor(lastAgent.workspace, "recent");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── File attach ("upload") ─────────────────────────────────────────────────────────
// Bring a file in from anywhere → copy it into the workspace's .attachments/ staging tray
// (the workspace is bind-mounted, so it appears in the container instantly). Kept out of git
// LOCALLY via .git/info/exclude (not the tracked .gitignore — a personal staging tray isn't a
// team convention). The agent reads the file from its workspace path; "promote to keep" =
// move it out of .attachments/ (then git tracks it normally).
const ATTACH_DIR = ".attachments";
function ensureAttachExcluded(workspace: string): void {
  try {
    // Only for git repos; find the exact exclude file (robust to worktrees/submodules).
    const inside = spawnSyncGit(workspace, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.trim() !== "true") return;
    let excludeRel = spawnSyncGit(workspace, ["rev-parse", "--git-path", "info/exclude"]).trim();
    if (!excludeRel) return;
    const excludePath = path.isAbsolute(excludeRel) ? excludeRel : path.join(workspace, excludeRel);
    let cur = "";
    try { cur = fs.readFileSync(excludePath, "utf8"); } catch { /* may not exist yet */ }
    if (cur.split(/\r?\n/).some((l) => l.trim() === `${ATTACH_DIR}/` || l.trim() === ATTACH_DIR)) return; // already excluded
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, `${cur && !cur.endsWith("\n") ? "\n" : ""}# Piwork brought-in files (local, not shared)\n${ATTACH_DIR}/\n`);
    log(`attach: excluded ${ATTACH_DIR}/ via ${excludePath}`);
  } catch (e) {
    log(`attach: git-exclude skipped: ${String(e)}`); // never fail an upload over ignore bookkeeping
  }
}
function spawnSyncGit(cwd: string, args: string[]): string {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.status === 0 ? String(r.stdout) : "";
}
/** Copy files into <workspace>/.attachments/, de-duping names; return workspace-relative paths. */
ipcMain.handle("piwork:attachFiles", (_e, workspace: string, sources: string[]) => {
  try {
    if (!workspace) return { ok: false, error: "no workspace", files: [] };
    const dir = path.join(workspace, ATTACH_DIR);
    fs.mkdirSync(dir, { recursive: true });
    ensureAttachExcluded(workspace);
    const files: Array<{ name: string; relPath: string }> = [];
    for (const src of sources) {
      try {
        const base = path.basename(src);
        let name = base;
        // De-dupe: foo.png → foo-2.png → foo-3.png …
        const ext = path.extname(base); const stem = base.slice(0, base.length - ext.length);
        for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem}-${n}${ext}`;
        fs.copyFileSync(src, path.join(dir, name));
        files.push({ name, relPath: `${ATTACH_DIR}/${name}` });
      } catch (e) { log(`attach: copy failed for ${src}: ${String(e)}`); }
    }
    return files.length ? { ok: true, files } : { ok: false, error: "nothing copied", files: [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), files: [] };
  }
});
/** Open a multi-select file picker; returns chosen source paths (or []). */
ipcMain.handle("piwork:pickAttachFiles", async () => {
  const res = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
  return res.canceled ? [] : res.filePaths;
});

// ── Host-side file viewing ────────────────────────────────────────────────────────
// The workspace is the user's own folder (bind-mounted into the container), so the
// main process reads it directly — no container round-trip, and it works before/after a
// session. The sandbox exists to contain the AGENT, not the user's view of their files.
// Guards: dirs-first sorted listing; text capped + binary-detected; images capped.
const TEXT_CAP = 512 * 1024; // 512 KB of text max
const IMG_CAP = 12 * 1024 * 1024; // 12 MB image max
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
};

ipcMain.handle("piwork:listDir", async (_e, dir?: string) => {
  const target = dir && dir.length > 0 ? dir : os.homedir();
  try {
    const dirents = fs.readdirSync(target, { withFileTypes: true });
    const entries = dirents.map((d) => {
      const full = path.join(target, d.name);
      let isDir = d.isDirectory();
      let size = 0;
      // Resolve symlinks + get size without throwing on broken links.
      try { const st = fs.statSync(full); isDir = st.isDirectory(); size = st.size; } catch { /* keep dirent guess */ }
      return { name: d.name, path: full, isDir, size };
    });
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    const parent = path.dirname(target);
    return { ok: true, path: target, parent: parent === target ? null : parent, entries };
  } catch (err) {
    return { ok: false, path: target, parent: null, entries: [], error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("piwork:readFile", async (_e, filePath: string) => {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const fail = (error: string) => ({ ok: false, path: filePath, name, kind: "binary" as const, content: "", size: 0, error });
  try {
    const st = fs.statSync(filePath);
    if (st.isDirectory()) return fail("is a directory");
    // Images → data URL (capped).
    if (IMAGE_MIME[ext]) {
      if (st.size > IMG_CAP) return fail(`image too large (${Math.round(st.size / 1e6)} MB)`);
      const mime = IMAGE_MIME[ext];
      const b64 = fs.readFileSync(filePath).toString("base64");
      return { ok: true, path: filePath, name, kind: "image" as const, content: `data:${mime};base64,${b64}`, mime, size: st.size };
    }
    // Everything else: read up to the cap, detect binary via NUL bytes.
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(Math.min(st.size, TEXT_CAP));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const slice = buf.subarray(0, read);
    if (slice.subarray(0, 8000).includes(0)) return { ok: true, path: filePath, name, kind: "binary" as const, content: "", size: st.size };
    const kind = ext === ".md" || ext === ".markdown" ? "markdown" : ext === ".html" || ext === ".htm" ? "html" : "text";
    return { ok: true, path: filePath, name, kind: kind as "text" | "markdown" | "html", content: slice.toString("utf8"), size: st.size, truncated: st.size > read };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// ── MCP connectors (pi-mcp-adapter) ────────────────────────────────────────────────
// Connectors are standard MCP servers described in mcp.json, read by the baked
// pi-mcp-adapter. We manage those files host-side and drive the adapter's OAuth from here:
//   • Global config → ~/.piwork/mcp-global/mcp.json, mounted at /root/.config/mcp (a path
//     the adapter reads as user-global) so it applies in every session.
//   • Project config → <workspace>/.pi/mcp.json (the adapter's project path; in-repo &
//     portable, like Claude/Cursor .mcp.json — it holds no secrets, tokens live elsewhere).
//   • OAuth tokens are stored by the adapter under the agent volume (persist across sessions).
// Seamless OAuth: each oauth server's redirectUri is pinned to a fixed localhost port; the
// browser (on the host) redirects there and OUR host callback server catches it, then tells
// pi-host to finish — so no copy/paste, and we never depend on the adapter's in-container
// callback listener (unreachable from the host browser).
const MCP_CALLBACK_PORT = Number(process.env.PIWORK_MCP_CALLBACK_PORT ?? 51823);
const MCP_REDIRECT_URI = `http://localhost:${MCP_CALLBACK_PORT}/callback`;
const MCP_GLOBAL_DIR = path.join(os.homedir(), ".piwork", "mcp-global");
function mcpMountArgs(): string[] {
  try { fs.mkdirSync(MCP_GLOBAL_DIR, { recursive: true }); } catch { /* ignore */ }
  return ["-v", `${MCP_GLOBAL_DIR}:/root/.config/mcp`];
}

interface McpServer {
  name: string; label?: string; url?: string; auth?: "oauth" | "bearer";
  command?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string>;
}
function mcpConfigPath(scope: "global" | "project", folder?: string): string {
  if (scope === "project" && folder) return path.join(folder, ".pi", "mcp.json");
  return path.join(MCP_GLOBAL_DIR, "mcp.json");
}
function readMcpServers(scope: "global" | "project", folder?: string): { servers: McpServer[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpConfigPath(scope, folder), "utf8"));
    const map = raw.mcpServers ?? {};
    const servers: McpServer[] = Object.entries<any>(map).map(([name, def]) => ({
      name, label: def.label, url: def.url, auth: def.auth, command: def.command, args: def.args, headers: def.headers, env: def.env,
    }));
    return { servers };
  } catch { return { servers: [] }; }
}
function writeMcpServers(scope: "global" | "project", folder: string | undefined, servers: McpServer[]): void {
  const mcpServers: Record<string, any> = {};
  for (const s of servers) {
    const entry: any = {};
    if (s.label) entry.label = s.label;
    if (s.url) entry.url = s.url;
    if (s.command) entry.command = s.command;
    if (s.args?.length) entry.args = s.args;
    if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers;
    if (s.env && Object.keys(s.env).length) entry.env = s.env;
    if (s.auth) entry.auth = s.auth;
    // Pin the redirect to our host callback port so browser OAuth returns seamlessly.
    if (s.auth === "oauth") entry.oauth = { redirectUri: MCP_REDIRECT_URI };
    mcpServers[s.name] = entry;
  }
  const file = mcpConfigPath(scope, folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers }, null, 2));
}

ipcMain.handle("piwork:getMcpServers", (_e, scope: "global" | "project", folder?: string) => readMcpServers(scope, folder));
ipcMain.handle("piwork:setMcpServers", (_e, scope: "global" | "project", folder: string | undefined, servers: McpServer[]) => {
  // Guard: a project connector is written to <repo>/.pi/mcp.json, which can be committed.
  // Refuse to put a secret (stdio env token / auth header) there — those belong in global
  // config (~/.piwork/mcp-global, host-side, never in a repo). OAuth/plain-URL are fine:
  // their secrets live in the container's token store, not the file.
  if (scope === "project") {
    const leaky = servers.find((s) => (s.env && Object.keys(s.env).length > 0) || (s.headers && Object.keys(s.headers).length > 0));
    if (leaky) {
      return { ok: false, error: `“${leaky.label ?? leaky.name}” carries a token/secret, which can't be saved to a project — it would be written to this repo's .pi/mcp.json and could be committed. Add it as a Global connector instead (its secret stays on your machine).` };
    }
  }
  try { writeMcpServers(scope, folder, servers); return { ok: true }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
});

// Host-side OAuth callback server: the browser redirect lands here (on the host) and we
// hand the full redirect URL to the auth container to finish the flow.
let mcpCallbackServer: import("node:http").Server | undefined;
let pendingMcpAuth: { server: string } | undefined;
function ensureMcpCallbackServer(): void {
  if (mcpCallbackServer) return;
  const http = require("node:http") as typeof import("node:http");
  mcpCallbackServer = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (!url.startsWith("/callback")) { res.writeHead(404); res.end(); return; }
    const fullUrl = `http://localhost:${MCP_CALLBACK_PORT}${url}`;
    const server = pendingMcpAuth?.server;
    pendingMcpAuth = undefined;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><body style=\"font:15px -apple-system,sans-serif;padding:40px;text-align:center\"><h2>Connected ✓</h2><p>You can close this tab and return to Piwork.</p></body>");
    if (server && authBridge) {
      log(`mcp oauth: callback for ${server}, completing`);
      authBridge.send({ type: "prompt", message: `/piwork-mcp-complete ${server} ${fullUrl}` });
      bumpAuthIdle();
    } else {
      log(`mcp oauth: callback with no pending server/auth container (server=${server})`);
    }
  });
  mcpCallbackServer.on("error", (e) => log(`mcp callback server error: ${String(e)}`));
  mcpCallbackServer.listen(MCP_CALLBACK_PORT, "127.0.0.1", () => log(`mcp callback server on ${MCP_REDIRECT_URI}`));
}

// A dedicated, short-lived container that hosts pi-mcp-adapter for connector auth/status —
// independent of any chat session. This is why Connect works from the home screen, and why
// authorizing never injects a /command into the user's conversation. One at a time; idle-
// torn-down. Its openExternal opens the host browser; its notify/mcpStatus are forwarded to
// the UI (toast + live status), but NOT its hello/events (so the chat view never switches).
let authBridge: ContainerBridge | undefined;
let authIdleTimer: ReturnType<typeof setTimeout> | undefined;
function bumpAuthIdle(): void {
  if (authIdleTimer) clearTimeout(authIdleTimer);
  authIdleTimer = setTimeout(() => void teardownAuthBridge(), 6 * 60 * 1000);
}
async function teardownAuthBridge(): Promise<void> {
  if (authIdleTimer) { clearTimeout(authIdleTimer); authIdleTimer = undefined; }
  const b = authBridge; authBridge = undefined; pendingMcpAuth = undefined;
  await b?.stop();
}
function ensureAuthBridge(scope: "global" | "project", folder?: string): Promise<ContainerBridge> {
  bumpAuthIdle();
  if (authBridge) return Promise.resolve(authBridge);
  const cwd = scope === "project" && folder ? folder : globalCwd();
  const mount = agentMount();
  const ab = new ContainerBridge();
  authBridge = ab;
  ab.on("ui_request", (r: any) => {
    if (r.method === "openExternal" && typeof r.url === "string") void shell.openExternal(r.url);
    else if (r.method === "mcpStatus") forward("ui_request", r); // live status → modal
    else if (r.method === "notify") {
      // The adapter's startup bootstrap notifies "Failed to connect … Re-authentication
      // required" for not-yet-authed servers — noise during a connect. Drop just that;
      // keep "Connected ✓" and genuine errors.
      const msg = String(r.message ?? "");
      if (/failed to connect.*(re-?authentication|unauthorized|auth)/i.test(msg)) { log(`[mcp-auth] suppressed: ${msg}`); return; }
      forward("ui_request", r);
    }
  });
  ab.on("stderr", (c: string) => { const s = String(c).trim(); if (s) log(`[mcp-auth] ${s}`); });
  ab.on("error", (e: Error) => log(`mcp auth container error: ${e.message}`));
  ab.on("exit", () => { if (authBridge === ab) authBridge = undefined; });
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(ab); } };
    ab.on("hello", done);
    ab.start({
      workspace: cwd, image: IMAGE, addHostGateway: DEV_ADD_HOST_GATEWAY, ...mount,
      extraDockerArgs: [...mcpMountArgs()],
      env: { MCP_OAUTH_CALLBACK_PORT: String(MCP_CALLBACK_PORT), PIWORK_NO_TOOLS: "all" },
    });
    setTimeout(done, 15000); // fallback if hello is slow/unavailable
  });
}

ipcMain.handle("piwork:mcpConnect", async (_e, server: string, scope: "global" | "project", folder?: string) => {
  try {
    ensureMcpCallbackServer();
    const ab = await ensureAuthBridge(scope, folder);
    pendingMcpAuth = { server };
    ab.send({ type: "prompt", message: `/piwork-mcp-auth ${server}` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle("piwork:mcpLogout", async (_e, server: string, scope: "global" | "project", folder?: string) => {
  try {
    const ab = await ensureAuthBridge(scope, folder);
    ab.send({ type: "prompt", message: `/piwork-mcp-logout ${server}` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle("piwork:mcpRefreshStatus", (_e, scope: "global" | "project", folder?: string) => {
  // Prefer the active chat session's adapter if present (free); else the auth container if
  // one is already up. Don't spin a container just to poll status.
  if (bridge) { bridge.send({ type: "prompt", message: "/piwork-mcp-status" }); return { ok: true }; }
  if (authBridge) { authBridge.send({ type: "prompt", message: "/piwork-mcp-status" }); bumpAuthIdle(); return { ok: true }; }
  return { ok: false };
});

// Theme persistence (host-side file so it survives restarts and dev/prod origins).
const THEME_FILE = path.join(os.homedir(), ".piwork", "theme.json");
ipcMain.handle("piwork:getTheme", () => {
  try {
    return JSON.parse(fs.readFileSync(THEME_FILE, "utf8"));
  } catch {
    return null;
  }
});
ipcMain.on("piwork:setTheme", (_e, theme: unknown) => {
  try {
    fs.mkdirSync(path.dirname(THEME_FILE), { recursive: true });
    fs.writeFileSync(THEME_FILE, JSON.stringify(theme, null, 2));
  } catch (e) {
    log(`could not write theme: ${String(e)}`);
  }
});

ipcMain.handle("piwork:stopSession", async () => {
  // Detach first so the user-initiated stop's "exit" isn't forwarded as a drop.
  if (bridge) { const old = bridge; bridge = undefined; old.removeAllListeners(); await old.stop(); }
});

ipcMain.on("piwork:send", (_e, command: Record<string, unknown>) => {
  log(`← command ${JSON.stringify(command)}`);
  bridge?.send(command);
});
ipcMain.on("piwork:respondUi", (_e, response: Record<string, unknown>) => {
  log(`← ui_response ${JSON.stringify(response)}`);
  bridge?.respondUi(response as never);
});
ipcMain.on("piwork:log", (_e, entry: string) => log(`[renderer] ${entry}`));

ipcMain.on("piwork:openExternal", (_e, url: string) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) void shell.openExternal(url);
});

// ── OAuth login relay ──────────────────────────────────────────────────────────
// Runs a short-lived container in pi-host "login" mode against the SAME agent store
// the session uses. pi-host does the actual OAuth via Pi's AuthStorage.login; we ferry
// its callbacks to the renderer and open URLs in the user's real browser.
ipcMain.handle("piwork:startLogin", async (_e, provider?: string) => {
  if (!lastAgent) return { ok: false, error: "Open a folder first (login targets that workspace's agent store)." };
  try {
    await loginBridge?.stop();
    loginBridge = new ContainerBridge();
    loginBridge.on("stderr", (c) => log(`[login] ${c.trimEnd()}`));
    loginBridge.on("error", (err) => forward("login", { type: "login_error", message: err.message }));
    loginBridge.on("exit", (code) => log(`[login] container exit ${code}`));
    loginBridge.on("event", (e) => handleLoginEvent(e));
    log(`starting login container${provider ? ` provider=${provider}` : ""}`);
    loginBridge.start({
      workspace: lastAgent.workspace,
      image: IMAGE,
      addHostGateway: DEV_ADD_HOST_GATEWAY,
      agentHostDir: lastAgent.agentHostDir,
      agentVolume: lastAgent.agentVolume,
      env: { PIWORK_MODE: "login", ...(provider ? { PIWORK_LOGIN_PROVIDER: provider } : {}) },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

function handleLoginEvent(e: Record<string, any>) {
  // Open login/verification URLs in the user's real browser.
  if (e.type === "login_open_url" && typeof e.url === "string") void shell.openExternal(e.url);
  if (e.type === "login_device_code" && typeof e.verificationUri === "string") void shell.openExternal(e.verificationUri);
  forward("login", e);
  if (e.type === "login_done") {
    log("login done → restarting session to pick up new credentials");
    void (async () => {
      await loginBridge?.stop();
      loginBridge = undefined;
      if (lastAgent) await startSessionFor(lastAgent.workspace);
    })();
  }
  if (e.type === "login_error") {
    void loginBridge?.stop().then(() => (loginBridge = undefined));
  }
}

ipcMain.on("piwork:loginChoose", (_e, provider: string) => loginBridge?.send({ type: "login_choose", provider }));
ipcMain.on("piwork:loginInput", (_e, id: string, value: string) => loginBridge?.send({ type: "login_input", id, value }));

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

app.whenReady().then(() => {
  initLog();
  createWindow();
});
app.on("window-all-closed", async () => {
  await loginBridge?.stop();
  await bridge?.stop();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

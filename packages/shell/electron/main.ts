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
import { spawn } from "node:child_process";
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

async function startSessionFor(workspace: string, session?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await bridge?.stop();
    bridge = new ContainerBridge();
    wireBridge(bridge);
    const mount = agentMount();
    lastAgent = { workspace, ...mount };
    addRecent(workspace);
    // session: undefined/"new" → fresh; "recent" → continue latest; else a session path.
    log(`starting session: workspace=${workspace} session=${session ?? "new"} agentDir=${mount.agentHostDir ?? mount.agentVolume} hostGateway=${DEV_ADD_HOST_GATEWAY} suite=${DEV_SUITE_DIR ?? "(none)"}`);
    bridge.start({
      workspace,
      image: IMAGE,
      addHostGateway: DEV_ADD_HOST_GATEWAY,
      ...mount,
      extraDockerArgs: [...suiteMountArgs, ...shareAgentsArgs(), ...connectorsMountArgs()],
      env: { PIWORK_SESSION_DIR: sessionDirFor(workspace), PIWORK_WS_KEY: hash(workspace), ...(session ? { PIWORK_SESSION: session } : {}) },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle("piwork:startSession", (_e, workspace: string, session?: string) => startSessionFor(workspace, session));
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

// ── MCP connectors ───────────────────────────────────────────────────────────────
// Config lives host-side (secrets never in a repo) and is mounted read-only into the
// sandbox at /root/.piwork-connectors: global.json + proj-<wsKey>.json.
const CONNECTORS_DIR = path.join(os.homedir(), ".piwork", "connectors");
function connectorsMountArgs(): string[] {
  try { fs.mkdirSync(CONNECTORS_DIR, { recursive: true }); } catch { /* ignore */ }
  return ["-v", `${CONNECTORS_DIR}:/root/.piwork-connectors:ro`];
}
function connectorsFile(scope: "global" | "project", folder?: string): string {
  fs.mkdirSync(CONNECTORS_DIR, { recursive: true });
  return scope === "project" && folder ? path.join(CONNECTORS_DIR, `proj-${hash(folder)}.json`) : path.join(CONNECTORS_DIR, "global.json");
}
function readConnectors(scope: "global" | "project", folder?: string): { servers: unknown[] } {
  try { return JSON.parse(fs.readFileSync(connectorsFile(scope, folder), "utf8")); } catch { return { servers: [] }; }
}
let connectorsEngineEnsured = false;
async function ensureConnectorsEngine(): Promise<void> {
  if (connectorsEngineEnsured) return;
  // Idempotent: make sure the piwork-connectors extension is installed globally so config takes effect.
  await runPi("", ["install", "/opt/piwork-suite/piwork-connectors"]);
  connectorsEngineEnsured = true;
}

ipcMain.handle("piwork:getConnectors", (_e, scope: "global" | "project", folder?: string) => readConnectors(scope, folder));
ipcMain.handle("piwork:setConnectors", async (_e, scope: "global" | "project", folder: string | undefined, config: { servers: unknown[] }) => {
  try {
    fs.writeFileSync(connectorsFile(scope, folder), JSON.stringify(config, null, 2));
    if ((config.servers ?? []).length > 0) await ensureConnectorsEngine();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
  await bridge?.stop();
  bridge = undefined;
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

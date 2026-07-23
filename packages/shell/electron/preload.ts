/**
 * Preload — the ONLY bridge between the sandboxed renderer and the Node/main process.
 *
 * The renderer runs with contextIsolation:true, nodeIntegration:false, sandbox:true,
 * so it has no Node access. We expose a small, explicit, serializable-only API on
 * `window.piwork` via contextBridge. Nothing else crosses the boundary.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface PiworkApi {
  /** Open the folder picker; resolves to the chosen workspace path (or null). */
  pickWorkspace(): Promise<string | null>;
  /** Start the container for a workspace. `session` = a session path, "recent", or omit for new. */
  startSession(workspace: string, session?: string): Promise<{ ok: boolean; error?: string }>;
  /** Start a folderless, tool-restricted global chat session. */
  startGlobalSession(session?: string): Promise<{ ok: boolean; error?: string }>;
  /** Stop the current container. */
  stopSession(): Promise<void>;
  /** Recently opened folders (most recent first). */
  recentFolders(): Promise<string[]>;
  /** List a workspace's past sessions (for the launcher). */
  listSessions(workspace: string): Promise<Array<{ path: string; id: string; name?: string; firstMessage: string; messageCount: number; created: string; modified: string }>>;
  /** Load the persisted theme (or null for default). */
  getTheme(): Promise<unknown>;
  /** Persist the theme. */
  setTheme(theme: unknown): void;
  /** Enumerate a workspace's loaded skills/extensions/prompts + configured packages. */
  listResources(workspace: string): Promise<{ skills: any[]; extensions: any[]; prompts: any[]; packages: any[] }>;
  /** Install a package/plugin (scope "global" or "project"). */
  installPackage(workspace: string, source: string, scope: "global" | "project"): Promise<{ ok: boolean; error?: string }>;
  /** Remove a configured package. */
  removePackage(workspace: string, source: string, scope: "global" | "project"): Promise<{ ok: boolean; error?: string }>;
  /** Restart the current session so newly installed resources load. */
  reloadSession(): Promise<{ ok: boolean; error?: string }>;
  /** Shell config (e.g. { shareAgentsDir }). */
  getConfig(): Promise<{ shareAgentsDir?: boolean }>;
  setConfig(patch: Record<string, unknown>): Promise<{ shareAgentsDir?: boolean }>;
  /** MCP connector config (scope global or project). */
  getConnectors(scope: "global" | "project", folder?: string): Promise<{ servers: any[] }>;
  setConnectors(scope: "global" | "project", folder: string | undefined, config: { servers: any[] }): Promise<{ ok: boolean; error?: string }>;
  /** Send a command to pi-host (RpcCommand-shaped). */
  send(command: Record<string, unknown>): void;
  /** Respond to a blocking ctx.ui request. */
  respondUi(response: Record<string, unknown>): void;
  /** Subscribe to bridge messages (hello/event/ui_request/response/stderr/exit). Returns an unsubscribe fn. */
  onMessage(listener: (msg: { channel: string; payload: unknown }) => void): () => void;
  /** Forward a renderer-side log line into the main-process log file. */
  log(entry: string): void;
  /** Open a URL in the user's real browser (host side). */
  openExternal(url: string): void;
  /** Start an OAuth login (optionally pre-choosing a provider id). */
  startLogin(provider?: string): Promise<{ ok: boolean; error?: string }>;
  /** Choose a provider when the login flow offers a list. */
  loginChoose(provider: string): void;
  /** Answer a login prompt/select by request id. */
  loginInput(id: string, value: string): void;
}

const api: PiworkApi = {
  pickWorkspace: () => ipcRenderer.invoke("piwork:pickWorkspace"),
  startSession: (workspace, session) => ipcRenderer.invoke("piwork:startSession", workspace, session),
  startGlobalSession: (session) => ipcRenderer.invoke("piwork:startGlobalSession", session),
  stopSession: () => ipcRenderer.invoke("piwork:stopSession"),
  recentFolders: () => ipcRenderer.invoke("piwork:recentFolders"),
  listSessions: (workspace) => ipcRenderer.invoke("piwork:listSessions", workspace),
  getTheme: () => ipcRenderer.invoke("piwork:getTheme"),
  setTheme: (theme) => ipcRenderer.send("piwork:setTheme", theme),
  listResources: (workspace) => ipcRenderer.invoke("piwork:listResources", workspace),
  installPackage: (workspace, source, scope) => ipcRenderer.invoke("piwork:installPackage", workspace, source, scope),
  removePackage: (workspace, source, scope) => ipcRenderer.invoke("piwork:removePackage", workspace, source, scope),
  reloadSession: () => ipcRenderer.invoke("piwork:reloadSession"),
  getConfig: () => ipcRenderer.invoke("piwork:getConfig"),
  setConfig: (patch) => ipcRenderer.invoke("piwork:setConfig", patch),
  getConnectors: (scope, folder) => ipcRenderer.invoke("piwork:getConnectors", scope, folder),
  setConnectors: (scope, folder, config) => ipcRenderer.invoke("piwork:setConnectors", scope, folder, config),
  send: (command) => ipcRenderer.send("piwork:send", command),
  respondUi: (response) => ipcRenderer.send("piwork:respondUi", response),
  onMessage: (listener) => {
    const channel = "piwork:message";
    const handler = (_e: unknown, msg: { channel: string; payload: unknown }) => listener(msg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  },
  log: (entry) => ipcRenderer.send("piwork:log", entry),
  openExternal: (url) => ipcRenderer.send("piwork:openExternal", url),
  startLogin: (provider) => ipcRenderer.invoke("piwork:startLogin", provider),
  loginChoose: (provider) => ipcRenderer.send("piwork:loginChoose", provider),
  loginInput: (id, value) => ipcRenderer.send("piwork:loginInput", id, value),
};

contextBridge.exposeInMainWorld("piwork", api);

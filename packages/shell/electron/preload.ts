/**
 * Preload — the ONLY bridge between the sandboxed renderer and the Node/main process.
 *
 * The renderer runs with contextIsolation:true, nodeIntegration:false, sandbox:true,
 * so it has no Node access. We expose a small, explicit, serializable-only API on
 * `window.piwork` via contextBridge. Nothing else crosses the boundary.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

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
  listGlobalSessions(): Promise<Array<{ path: string; id: string; name?: string; firstMessage: string; messageCount: number; created: string; modified: string }>>;
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
  /** MCP connectors (mcp.json) — read/write the server list for a scope. */
  getMcpServers(scope: "global" | "project", folder?: string): Promise<{ servers: any[] }>;
  setMcpServers(scope: "global" | "project", folder: string | undefined, servers: any[]): Promise<{ ok: boolean; error?: string }>;
  /** Begin OAuth for a connector — opens the browser via a dedicated auth container. */
  mcpConnect(server: string, scope: "global" | "project", folder?: string): Promise<{ ok: boolean; error?: string }>;
  /** Disconnect a connector (clear its OAuth credentials). */
  mcpLogout(server: string, scope: "global" | "project", folder?: string): Promise<{ ok: boolean; error?: string }>;
  /** Ask for current connector auth status (arrives as an mcpStatus message), if a container is up. */
  mcpRefreshStatus(scope: "global" | "project", folder?: string): Promise<{ ok: boolean }>;
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
  /** Add/update a custom model in models.json (merges into a provider, reuses its auth), then reload. */
  addModel(model: { provider: string; id: string; name?: string; reasoning?: boolean }): Promise<{ ok: boolean; error?: string }>;
  /** Add a custom API-key provider (baseUrl/api/apiKey + a starter model) to models.json, then reload. */
  addProvider(p: { provider: string; api: string; baseUrl?: string; apiKey: string; modelId: string; modelName?: string; reasoning?: boolean }): Promise<{ ok: boolean; error?: string }>;
  /** Persist the default thinking level (settings.json). Live level is set via the set_thinking_level RPC. */
  setDefaultThinking(level: string): Promise<{ ok: boolean; error?: string }>;
  /** Read an instructions file (kind: "agents" | "append" | "replace") for a scope. */
  readInstructions(scope: "global" | "project", folder: string | undefined, kind: string): Promise<{ ok: boolean; content: string; error?: string }>;
  /** Write an instructions file and reload. */
  writeInstructions(scope: "global" | "project", folder: string | undefined, kind: string, content: string): Promise<{ ok: boolean; error?: string }>;
  /** Copy files into the workspace's .attachments/ (git-excluded); returns their workspace paths. */
  attachFiles(workspace: string, sources: string[]): Promise<{ ok: boolean; error?: string; files: Array<{ name: string; relPath: string }> }>;
  /** Open a multi-select file picker; returns chosen source paths (or []). */
  pickAttachFiles(): Promise<string[]>;
  /** Resolve the host path of a dropped File (Electron ≥32 removed File.path). */
  getPathForFile(file: File): string;
  /** List a directory (host-side). Omit dir for the user's home. */
  listDir(dir?: string): Promise<{ ok: boolean; path: string; parent: string | null; entries: Array<{ name: string; path: string; isDir: boolean; size: number }>; error?: string }>;
  /** Read a file (host-side) as a viewer document. */
  readFile(path: string): Promise<{ ok: boolean; path: string; name: string; kind: "text" | "markdown" | "html" | "image" | "binary"; content: string; mime?: string; size: number; truncated?: boolean; error?: string }>;
}

const api: PiworkApi = {
  pickWorkspace: () => ipcRenderer.invoke("piwork:pickWorkspace"),
  startSession: (workspace, session) => ipcRenderer.invoke("piwork:startSession", workspace, session),
  startGlobalSession: (session) => ipcRenderer.invoke("piwork:startGlobalSession", session),
  stopSession: () => ipcRenderer.invoke("piwork:stopSession"),
  recentFolders: () => ipcRenderer.invoke("piwork:recentFolders"),
  listSessions: (workspace) => ipcRenderer.invoke("piwork:listSessions", workspace),
  listGlobalSessions: () => ipcRenderer.invoke("piwork:listGlobalSessions"),
  getTheme: () => ipcRenderer.invoke("piwork:getTheme"),
  setTheme: (theme) => ipcRenderer.send("piwork:setTheme", theme),
  listResources: (workspace) => ipcRenderer.invoke("piwork:listResources", workspace),
  installPackage: (workspace, source, scope) => ipcRenderer.invoke("piwork:installPackage", workspace, source, scope),
  removePackage: (workspace, source, scope) => ipcRenderer.invoke("piwork:removePackage", workspace, source, scope),
  reloadSession: () => ipcRenderer.invoke("piwork:reloadSession"),
  getConfig: () => ipcRenderer.invoke("piwork:getConfig"),
  setConfig: (patch) => ipcRenderer.invoke("piwork:setConfig", patch),
  getMcpServers: (scope, folder) => ipcRenderer.invoke("piwork:getMcpServers", scope, folder),
  setMcpServers: (scope, folder, servers) => ipcRenderer.invoke("piwork:setMcpServers", scope, folder, servers),
  mcpConnect: (server, scope, folder) => ipcRenderer.invoke("piwork:mcpConnect", server, scope, folder),
  mcpLogout: (server, scope, folder) => ipcRenderer.invoke("piwork:mcpLogout", server, scope, folder),
  mcpRefreshStatus: (scope, folder) => ipcRenderer.invoke("piwork:mcpRefreshStatus", scope, folder),
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
  addModel: (model) => ipcRenderer.invoke("piwork:addModel", model),
  addProvider: (p) => ipcRenderer.invoke("piwork:addProvider", p),
  setDefaultThinking: (level) => ipcRenderer.invoke("piwork:setDefaultThinking", level),
  readInstructions: (scope, folder, kind) => ipcRenderer.invoke("piwork:readInstructions", scope, folder, kind),
  writeInstructions: (scope, folder, kind, content) => ipcRenderer.invoke("piwork:writeInstructions", scope, folder, kind, content),
  attachFiles: (workspace, sources) => ipcRenderer.invoke("piwork:attachFiles", workspace, sources),
  pickAttachFiles: () => ipcRenderer.invoke("piwork:pickAttachFiles"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listDir: (dir) => ipcRenderer.invoke("piwork:listDir", dir),
  readFile: (p) => ipcRenderer.invoke("piwork:readFile", p),
};

contextBridge.exposeInMainWorld("piwork", api);

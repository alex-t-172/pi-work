// Shared renderer-side types + the window.piwork surface (mirrors electron/preload.ts).

export interface SessionMeta {
  path: string;
  id: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  created: string;
  modified: string;
}

export interface PiworkApi {
  pickWorkspace(): Promise<string | null>;
  startSession(workspace: string, session?: string): Promise<{ ok: boolean; error?: string }>;
  startGlobalSession(session?: string): Promise<{ ok: boolean; error?: string }>;
  stopSession(): Promise<void>;
  recentFolders(): Promise<string[]>;
  listSessions(workspace: string): Promise<SessionMeta[]>;
  getTheme(): Promise<unknown>;
  setTheme(theme: unknown): void;
  listResources(workspace: string): Promise<ResourceList>;
  installPackage(workspace: string, source: string, scope: "global" | "project"): Promise<{ ok: boolean; error?: string }>;
  removePackage(workspace: string, source: string, scope: "global" | "project"): Promise<{ ok: boolean; error?: string }>;
  reloadSession(): Promise<{ ok: boolean; error?: string }>;
  getConfig(): Promise<{ shareAgentsDir?: boolean }>;
  setConfig(patch: Record<string, unknown>): Promise<{ shareAgentsDir?: boolean }>;
  getMcpServers(scope: "global" | "project", folder?: string): Promise<{ servers: McpServer[] }>;
  setMcpServers(scope: "global" | "project", folder: string | undefined, servers: McpServer[]): Promise<{ ok: boolean; error?: string }>;
  mcpConnect(server: string, scope: "global" | "project", folder?: string): Promise<{ ok: boolean; error?: string }>;
  mcpLogout(server: string, scope: "global" | "project", folder?: string): Promise<{ ok: boolean; error?: string }>;
  mcpRefreshStatus(scope: "global" | "project", folder?: string): Promise<{ ok: boolean }>;
  send(command: Record<string, unknown>): void;
  respondUi(response: Record<string, unknown>): void;
  onMessage(listener: (msg: { channel: string; payload: unknown }) => void): () => void;
  log(entry: string): void;
  openExternal(url: string): void;
  startLogin(provider?: string): Promise<{ ok: boolean; error?: string }>;
  loginChoose(provider: string): void;
  loginInput(id: string, value: string): void;
  /** Add/update a custom model in models.json (merges into a provider, reuses its auth), then reload. */
  addModel(model: { provider: string; id: string; name?: string }): Promise<{ ok: boolean; error?: string }>;
  /** Copy files into the workspace's .attachments/ (git-excluded); returns their workspace paths. */
  attachFiles(workspace: string, sources: string[]): Promise<{ ok: boolean; error?: string; files: Array<{ name: string; relPath: string }> }>;
  /** Open a multi-select file picker; returns chosen source paths (or []). */
  pickAttachFiles(): Promise<string[]>;
  /** Resolve the host path of a dropped File. */
  getPathForFile(file: File): string;
  /** List a directory (host-side). Omit dir for the user's home. */
  listDir(dir?: string): Promise<DirListing>;
  /** Read a file (host-side) as a viewer document. */
  readFile(path: string): Promise<FileContent>;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}
export interface DirListing {
  ok: boolean;
  path: string;
  parent: string | null;
  entries: DirEntry[];
  error?: string;
}
export interface FileContent {
  ok: boolean;
  path: string;
  name: string;
  kind: "text" | "markdown" | "html" | "image" | "binary";
  content: string; // text for text/markdown/html; a data: URL for image; empty for binary
  mime?: string;
  size: number;
  truncated?: boolean;
  error?: string;
}

export interface TreeNode {
  id: string;
  type: string;
  role?: string;
  label?: string;
  preview: string;
  text?: string;
  children: TreeNode[];
}

// An MCP connector as stored in mcp.json (read by pi-mcp-adapter). `name` is the adapter's
// server key (tokens are keyed by it). Remote (url) servers can use OAuth; stdio (command)
// servers are the advanced/local path.
export interface McpServer {
  name: string;
  label?: string;
  url?: string;
  auth?: "oauth" | "bearer";
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>; // secrets for stdio servers (e.g. SLACK_BOT_TOKEN)
}
export type McpAuthStatus = "authenticated" | "expired" | "not_authenticated" | "n/a";
export interface McpStatusEntry { name: string; oauth: boolean; status: McpAuthStatus }
export interface McpStatus { servers: McpStatusEntry[] }

export interface ResourceItem {
  name: string;
  description?: string;
  scope?: "user" | "project" | "temporary";
  origin?: "package" | "top-level";
  source?: string;
  path?: string;
  commands?: string[];
  tools?: string[];
}
export interface PackageItem {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
  filtered?: boolean;
}
export interface ResourceList {
  skills: ResourceItem[];
  extensions: ResourceItem[];
  prompts: ResourceItem[];
  packages: PackageItem[];
}

export interface LoginProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
}

export interface LoginPrompt {
  kind: "prompt" | "select";
  id: string;
  message: string;
  placeholder?: string;
  options?: { id: string; label: string }[];
}

export interface LoginState {
  active: boolean;
  status?: string;
  providers?: LoginProvider[];
  needProvider?: boolean;
  prompt?: LoginPrompt;
  error?: string;
}

declare global {
  interface Window {
    piwork: PiworkApi;
  }
}

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatItem {
  id: string;
  role: ChatRole;
  /** Assistant/user markdown text (accumulated during streaming). */
  text: string;
  /** Accumulated reasoning/thinking output (shown muted, collapsible). */
  thinking?: string;
  /** For tool items. */
  toolName?: string;
  toolStatus?: "running" | "ok" | "error";
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolDetails?: Record<string, unknown>;
  /** Assistant is still streaming. */
  streaming?: boolean;
}

export interface UiDialog {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface Toast {
  id: string;
  message: string;
  level: "info" | "warning" | "error";
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
}

export type Connection = "idle" | "starting" | "connected" | "exited" | "error";

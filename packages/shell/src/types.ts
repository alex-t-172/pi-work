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
  getConnectors(scope: "global" | "project", folder?: string): Promise<{ servers: ConnectorServer[] }>;
  setConnectors(scope: "global" | "project", folder: string | undefined, config: { servers: ConnectorServer[] }): Promise<{ ok: boolean; error?: string }>;
  send(command: Record<string, unknown>): void;
  respondUi(response: Record<string, unknown>): void;
  onMessage(listener: (msg: { channel: string; payload: unknown }) => void): () => void;
  log(entry: string): void;
  openExternal(url: string): void;
  startLogin(provider?: string): Promise<{ ok: boolean; error?: string }>;
  loginChoose(provider: string): void;
  loginInput(id: string, value: string): void;
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

export interface ConnectorServer {
  id: string;
  label?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

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

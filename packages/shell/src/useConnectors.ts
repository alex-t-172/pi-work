import { useCallback, useState } from "react";
import type { McpServer } from "./types.ts";

export type ConnectorMode = "global" | "project";

/** State + actions for the MCP connectors UI (backed by mcp.json + pi-mcp-adapter). */
export function useConnectors() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ConnectorMode>("global");
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [servers, setServers] = useState<McpServer[]>([]);
  // Global connectors shown (read-only) when viewing a project: they're mounted into every
  // session, so a global Notion is already active in this project — surface it as inherited
  // rather than offering to set it up again.
  const [inherited, setInherited] = useState<McpServer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async (m: ConnectorMode, f?: string) => {
    const cfg = await window.piwork.getMcpServers(m, f);
    setServers(cfg.servers ?? []);
    // In project scope, also load global connectors to show as inherited (none in global scope).
    if (m === "project") setInherited((await window.piwork.getMcpServers("global", undefined)).servers ?? []);
    else setInherited([]);
  }, []);

  const openFor = useCallback(async (m: ConnectorMode, f?: string) => {
    setMode(m);
    setFolder(m === "project" ? f : undefined);
    setOpen(true);
    setError(null);
    setDirty(false);
    await load(m, f);
    window.piwork.mcpRefreshStatus(m, m === "project" ? f : undefined); // status arrives via mcpStatus
  }, [load]);

  const close = useCallback(() => setOpen(false), []);

  const persist = useCallback(async (next: McpServer[]) => {
    const prev = servers;
    setServers(next); // optimistic
    setBusy("Saving…");
    const r = await window.piwork.setMcpServers(mode, folder, next);
    setBusy(null);
    if (!r.ok) { setError(r.error ?? "save failed"); setServers(prev); } // revert on rejection (e.g. secret-in-project guard)
    else { setError(null); setDirty(true); }
  }, [mode, folder, servers]);

  const add = useCallback((s: McpServer) => persist([...servers.filter((x) => x.name !== s.name), s]), [servers, persist]);
  const remove = useCallback((name: string) => persist(servers.filter((s) => s.name !== name)), [servers, persist]);

  const connect = useCallback(async (name: string) => {
    setError(null);
    setBusy(`Connecting ${name}…`);
    const r = await window.piwork.mcpConnect(name, mode, mode === "project" ? folder : undefined);
    setBusy(null);
    if (!r.ok) setError(r.error ?? "connect failed");
  }, [mode, folder]);
  const disconnect = useCallback(async (name: string) => {
    setError(null);
    const r = await window.piwork.mcpLogout(name, mode, mode === "project" ? folder : undefined);
    if (!r.ok) setError(r.error ?? "disconnect failed");
  }, [mode, folder]);

  const reload = useCallback(async () => {
    setBusy("Reloading session…");
    await window.piwork.reloadSession();
    setBusy(null);
    setDirty(false);
    window.piwork.mcpRefreshStatus(mode, mode === "project" ? folder : undefined);
  }, [mode, folder]);

  return { open, mode, folder, servers, inherited, busy, error, dirty, openFor, close, add, remove, connect, disconnect, reload };
}

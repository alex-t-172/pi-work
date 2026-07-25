import { useCallback, useState } from "react";
import type { McpServer } from "./types.ts";

export type ConnectorMode = "global" | "project";

/** State + actions for the MCP connectors UI (backed by mcp.json + pi-mcp-adapter). */
export function useConnectors() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ConnectorMode>("global");
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async (m: ConnectorMode, f?: string) => {
    const cfg = await window.piwork.getMcpServers(m, f);
    setServers(cfg.servers ?? []);
  }, []);

  const openFor = useCallback(async (m: ConnectorMode, f?: string) => {
    setMode(m);
    setFolder(m === "project" ? f : undefined);
    setOpen(true);
    setError(null);
    setDirty(false);
    await load(m, f);
    window.piwork.mcpRefreshStatus(); // auth status arrives via the mcpStatus bridge message
  }, [load]);

  const close = useCallback(() => setOpen(false), []);

  const persist = useCallback(async (next: McpServer[]) => {
    setServers(next);
    setBusy("Saving…");
    const r = await window.piwork.setMcpServers(mode, folder, next);
    setBusy(null);
    if (!r.ok) setError(r.error ?? "save failed");
    else setDirty(true);
  }, [mode, folder]);

  const add = useCallback((s: McpServer) => persist([...servers.filter((x) => x.name !== s.name), s]), [servers, persist]);
  const remove = useCallback((name: string) => persist(servers.filter((s) => s.name !== name)), [servers, persist]);

  const connect = useCallback(async (name: string) => {
    setError(null);
    const r = await window.piwork.mcpConnect(name);
    if (!r.ok) setError(r.error ?? "connect failed");
  }, []);
  const disconnect = useCallback(async (name: string) => {
    setError(null);
    const r = await window.piwork.mcpLogout(name);
    if (!r.ok) setError(r.error ?? "disconnect failed");
  }, []);

  const reload = useCallback(async () => {
    setBusy("Reloading session…");
    await window.piwork.reloadSession();
    setBusy(null);
    setDirty(false);
    window.piwork.mcpRefreshStatus();
  }, []);

  return { open, mode, folder, servers, busy, error, dirty, openFor, close, add, remove, connect, disconnect, reload };
}

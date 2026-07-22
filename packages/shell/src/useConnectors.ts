import { useCallback, useState } from "react";
import type { ConnectorServer } from "./types.ts";

export type ConnectorMode = "global" | "project";

/** State + actions for the MCP connectors config UI. */
export function useConnectors() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ConnectorMode>("global");
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [servers, setServers] = useState<ConnectorServer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const openFor = useCallback(async (m: ConnectorMode, f?: string) => {
    setMode(m);
    setFolder(m === "project" ? f : undefined);
    setOpen(true);
    setError(null);
    setDirty(false);
    const cfg = await window.piwork.getConnectors(m, f);
    setServers(cfg.servers ?? []);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const persist = useCallback(async (next: ConnectorServer[]) => {
    setServers(next);
    setBusy("Saving…");
    const r = await window.piwork.setConnectors(mode, folder, { servers: next });
    setBusy(null);
    if (!r.ok) setError(r.error ?? "save failed");
    else setDirty(true);
  }, [mode, folder]);

  const upsert = useCallback((server: ConnectorServer) => {
    persist([...servers.filter((s) => s.id !== server.id), server]);
  }, [servers, persist]);
  const toggle = useCallback((id: string) => {
    persist(servers.map((s) => (s.id === id ? { ...s, enabled: s.enabled === false } : s)));
  }, [servers, persist]);
  const removeServer = useCallback((id: string) => {
    persist(servers.filter((s) => s.id !== id));
  }, [servers, persist]);

  const reload = useCallback(async () => {
    setBusy("Reloading session…");
    await window.piwork.reloadSession();
    setBusy(null);
    setDirty(false);
    setOpen(false);
  }, []);

  return { open, mode, folder, servers, busy, error, dirty, openFor, close, upsert, toggle, removeServer, reload };
}

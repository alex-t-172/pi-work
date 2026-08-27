import { useCallback, useState } from "react";
import type { ResourceList } from "./types.ts";

/** State + actions for the in-app resource manager (skills / plugins / extensions). */
export type ResourceMode = "global" | "project";

export function useResources() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ResourceMode>("global");
  const [workspace, setWorkspace] = useState<string>(""); // "" ⇒ global store
  const [data, setData] = useState<ResourceList | null>(null);
  const [config, setConfigState] = useState<{ shareAgentsDir?: boolean; braveApiKey?: string }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false); // install/remove happened → running session needs reload

  const refresh = useCallback(async (ws: string) => {
    setData(null);
    try { setData(await window.piwork.listResources(ws)); } catch { setData({ skills: [], extensions: [], prompts: [], packages: [] }); }
  }, []);

  const openFor = useCallback(async (m: ResourceMode, folder?: string) => {
    const ws = m === "project" ? (folder ?? "") : "";
    setMode(m);
    setWorkspace(ws);
    setOpen(true);
    setError(null);
    setDirty(false);
    setConfigState(await window.piwork.getConfig());
    await refresh(ws);
  }, [refresh]);

  const close = useCallback(() => setOpen(false), []);

  const install = useCallback(async (source: string) => {
    setError(null);
    setBusy(`Installing ${source}…`);
    const r = await window.piwork.installPackage(workspace, source, mode);
    setBusy(null);
    if (!r.ok) setError(r.error ?? "install failed");
    else setDirty(true);
    await refresh(workspace);
  }, [workspace, mode, refresh]);

  const remove = useCallback(async (source: string, scope: "global" | "project") => {
    setError(null);
    setBusy(`Removing ${source}…`);
    const r = await window.piwork.removePackage(workspace, source, scope);
    setBusy(null);
    if (!r.ok) setError(r.error ?? "remove failed");
    else setDirty(true);
    await refresh(workspace);
  }, [workspace, refresh]);

  const setShareAgents = useCallback(async (on: boolean) => {
    const next = await window.piwork.setConfig({ shareAgentsDir: on });
    setConfigState(next);
    setDirty(true);
  }, []);

  // Optional Brave Search API key for the web-search built-in. Applies on the next session
  // start (it's passed to the container as an env var), so mark the session dirty for reload.
  const setBraveKey = useCallback(async (key: string) => {
    const next = await window.piwork.setConfig({ braveApiKey: key.trim() });
    setConfigState(next);
    setDirty(true);
  }, []);

  const reload = useCallback(async () => {
    setBusy("Reloading session…");
    await window.piwork.reloadSession();
    setBusy(null);
    setDirty(false);
    setOpen(false);
  }, []);

  return { open, mode, workspace, data, config, busy, error, dirty, openFor, close, install, remove, setShareAgents, setBraveKey, reload };
}

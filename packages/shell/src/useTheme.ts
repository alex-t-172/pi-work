import { useCallback, useEffect, useRef, useState } from "react";
import { applyTheme, DEFAULT_THEME, migrate, resolveTheme, type ThemeState, type ThemeToken } from "./theme.ts";

/** Load the persisted theme, apply it live, and persist any changes. */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeState>(DEFAULT_THEME);
  const ref = useRef(theme);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const initial = migrate(await window.piwork.getTheme());
      if (cancelled) return;
      ref.current = initial;
      setThemeState(initial);
      applyTheme(initial);
    })();
    return () => { cancelled = true; };
  }, []);

  const commit = useCallback((next: ThemeState) => {
    ref.current = next;
    setThemeState(next);
    applyTheme(next);
    window.piwork.setTheme(next);
  }, []);

  // Select a preset ("preset:Name") or a saved theme ("user:id"); drops unsaved tweaks.
  const select = useCallback((id: string) => commit({ ...ref.current, activeId: id, overrides: {} }), [commit]);

  const setColor = useCallback((token: ThemeToken, value: string) => {
    const o = ref.current.overrides;
    commit({ ...ref.current, overrides: { ...o, colors: { ...(o.colors ?? {}), [token]: value } } });
  }, [commit]);
  const setFont = useCallback((font: string) => commit({ ...ref.current, overrides: { ...ref.current.overrides, font } }), [commit]);
  const setSize = useCallback((size: number) => commit({ ...ref.current, overrides: { ...ref.current.overrides, size } }), [commit]);
  const resetTweaks = useCallback(() => commit({ ...ref.current, overrides: {} }), [commit]);

  // Capture the current look (base + tweaks) as a new named theme, and select it.
  const saveAsNew = useCallback((name: string) => {
    const id = crypto.randomUUID();
    const theme = resolveTheme(ref.current);
    commit({ activeId: `user:${id}`, overrides: {}, userThemes: { ...ref.current.userThemes, [id]: { id, name: name.trim() || "My theme", theme } } });
  }, [commit]);

  // Fold live tweaks into the active saved theme (only valid when a user theme is selected).
  const saveChanges = useCallback(() => {
    const s = ref.current;
    if (!s.activeId.startsWith("user:")) return;
    const id = s.activeId.slice(5);
    const existing = s.userThemes[id];
    if (!existing) return;
    commit({ ...s, overrides: {}, userThemes: { ...s.userThemes, [id]: { ...existing, theme: resolveTheme(s) } } });
  }, [commit]);

  const rename = useCallback((id: string, name: string) => {
    const u = ref.current.userThemes[id];
    if (!u) return;
    commit({ ...ref.current, userThemes: { ...ref.current.userThemes, [id]: { ...u, name: name.trim() || u.name } } });
  }, [commit]);

  const remove = useCallback((id: string) => {
    const { [id]: _gone, ...rest } = ref.current.userThemes;
    const activeId = ref.current.activeId === `user:${id}` ? "preset:Midnight" : ref.current.activeId;
    commit({ activeId, overrides: {}, userThemes: rest });
  }, [commit]);

  return { theme, select, setColor, setFont, setSize, resetTweaks, saveAsNew, saveChanges, rename, remove };
}

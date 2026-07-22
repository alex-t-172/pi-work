import { useCallback, useEffect, useRef, useState } from "react";
import { applyTheme, DEFAULT_THEME, type ThemeState, type ThemeToken } from "./theme.ts";

/** Load the persisted theme, apply it live, and persist any changes. */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeState>(DEFAULT_THEME);
  const ref = useRef(theme);
  useEffect(() => { ref.current = theme; }, [theme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = (await window.piwork.getTheme()) as ThemeState | null;
      const initial = saved && typeof saved === "object" && "preset" in saved ? saved : DEFAULT_THEME;
      if (cancelled) return;
      setTheme(initial);
      applyTheme(initial);
    })();
    return () => { cancelled = true; };
  }, []);

  const commit = useCallback((next: ThemeState) => {
    setTheme(next);
    applyTheme(next);
    window.piwork.setTheme(next);
  }, []);

  const setPreset = useCallback((preset: string) => commit({ preset, overrides: {} }), [commit]);
  const setOverride = useCallback(
    (token: ThemeToken, value: string) => commit({ preset: ref.current.preset, overrides: { ...ref.current.overrides, [token]: value } }),
    [commit],
  );
  const resetTweaks = useCallback(() => commit({ preset: ref.current.preset, overrides: {} }), [commit]);

  return { theme, setPreset, setOverride, resetTweaks };
}

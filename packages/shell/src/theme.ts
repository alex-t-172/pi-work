/**
 * Theming: the shell's look is driven entirely by CSS custom properties on :root.
 * A theme = a preset (full set of token values) + optional per-token overrides the
 * user tweaks in-app. Everything is applied live and persisted host-side, so a
 * non-developer never touches CSS or the terminal.
 */

/** The tunable tokens, with human labels for the customizer. Order = display order. */
export const THEME_TOKENS = [
  { key: "accent", label: "Accent" },
  { key: "bg", label: "Background" },
  { key: "fg", label: "Text" },
  { key: "panel", label: "Panels & bubbles" },
  { key: "bg2", label: "Bars" },
  { key: "border", label: "Borders" },
  { key: "muted", label: "Muted text" },
  { key: "user", label: "Your messages" },
] as const;

export type ThemeToken =
  | "bg" | "bg2" | "panel" | "border" | "fg" | "muted" | "accent" | "user" | "live" | "error" | "warn";

export type ThemeVars = Record<ThemeToken, string>;

export interface ThemeState {
  preset: string;
  overrides: Partial<ThemeVars>;
}

/** Built-in presets. Each is a COMPLETE set so switching never leaves stale tokens. */
export const PRESETS: Record<string, ThemeVars> = {
  Midnight: { bg: "#16181d", bg2: "#1d2027", panel: "#23262e", border: "#2f333c", fg: "#e6e8ec", muted: "#8b909a", accent: "#6ea8fe", user: "#2a3550", live: "#3fb950", error: "#f85149", warn: "#d29922" },
  Graphite: { bg: "#1a1a1a", bg2: "#212121", panel: "#282828", border: "#383838", fg: "#eaeaea", muted: "#9a9a9a", accent: "#e0895a", user: "#33302b", live: "#7fb950", error: "#f06a6a", warn: "#d8a657" },
  Light: { bg: "#f7f8fa", bg2: "#eef0f3", panel: "#ffffff", border: "#d8dce2", fg: "#1c1f24", muted: "#6b7280", accent: "#2563eb", user: "#dbe6ff", live: "#1a7f37", error: "#cf222e", warn: "#9a6700" },
  Sepia: { bg: "#f4ecd8", bg2: "#ece3cc", panel: "#fbf5e6", border: "#ddd0b0", fg: "#3b352a", muted: "#8a7f68", accent: "#b3541e", user: "#e8dcc0", live: "#5a7d2a", error: "#a3311e", warn: "#9a6700" },
  Matrix: { bg: "#000000", bg2: "#0a0f0a", panel: "#0d160d", border: "#173d17", fg: "#c8facc", muted: "#4f8f57", accent: "#39ff14", user: "#0f2a12", live: "#39ff14", error: "#ff5555", warn: "#e3b341" },
};

export const DEFAULT_THEME: ThemeState = { preset: "Midnight", overrides: {} };

/** Final token values = preset merged with the user's overrides. */
export function resolveVars(t: ThemeState): ThemeVars {
  const base = PRESETS[t.preset] ?? PRESETS.Midnight;
  return { ...base, ...t.overrides };
}

/** Apply a theme to the live document (inline vars on :root win over stylesheet defaults). */
export function applyTheme(t: ThemeState): void {
  const vars = resolveVars(t);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--${k}`, v);
}

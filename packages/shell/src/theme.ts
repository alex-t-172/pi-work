/**
 * Theming: the shell's look is driven entirely by CSS custom properties on :root.
 *
 * A theme bundles colours + typography (font + base size). Built-in PRESETS are read-only
 * starting points; the user tweaks live (overrides) and can "Save as new theme" to persist a
 * named theme into `userThemes`. Everything applies live and persists host-side, so a
 * non-developer never touches CSS or the terminal. Fonts are system stacks only (the
 * renderer is sandboxed/offline — no downloading web fonts).
 */

/** Colour tokens, with human labels for the customizer. Order = display order. */
export const THEME_TOKENS = [
  { key: "accent", label: "Accent" },
  { key: "bg", label: "Background" },
  { key: "fg", label: "Text" },
  { key: "panel", label: "Panels & bubbles" },
  { key: "bg2", label: "Bars" },
  { key: "border", label: "Borders" },
  { key: "muted", label: "Muted text" },
  { key: "user", label: "Your messages" },
  { key: "code", label: "Code blocks" },
  { key: "link", label: "Links" },
] as const;

export type ThemeToken =
  | "bg" | "bg2" | "panel" | "border" | "fg" | "muted" | "accent" | "user" | "code" | "link" | "live" | "error" | "warn";

export type ThemeColors = Record<ThemeToken, string>;

/** Curated system font stacks (system-available only). Stored by key so themes stay portable. */
export const FONT_OPTIONS = [
  { key: "system", label: "System", stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { key: "grotesk", label: "Grotesk", stack: '"Helvetica Neue", Arial, "Segoe UI", sans-serif' },
  { key: "reading", label: "Reading", stack: 'Verdana, Geneva, Tahoma, sans-serif' },
  { key: "serif", label: "Serif", stack: 'Georgia, "Times New Roman", serif' },
  { key: "mono", label: "Monospace", stack: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace' },
] as const;
export const FONT_STACKS: Record<string, string> = Object.fromEntries(FONT_OPTIONS.map((o) => [o.key, o.stack]));

export const SIZE_MIN = 12;
export const SIZE_MAX = 19;
export const SIZE_DEFAULT = 14;
export const FONT_DEFAULT = "system";

export interface Theme { colors: ThemeColors; font: string; size: number }
export interface ThemeOverrides { colors?: Partial<ThemeColors>; font?: string; size?: number }
export interface UserTheme { id: string; name: string; theme: Theme }
export interface ThemeState {
  activeId: string; // "preset:<Name>" | "user:<id>"
  overrides: ThemeOverrides; // live, unsaved tweaks on the active base
  userThemes: Record<string, UserTheme>;
}

/** Built-in colour presets. Each is a COMPLETE set so switching never leaves stale tokens. */
export const PRESETS: Record<string, ThemeColors> = {
  // Softened from the original: text is a cool grey rather than near-white, so the contrast
  // against the dark ground no longer strains the eyes; the ground lifts a touch to match.
  Midnight: { bg: "#191c22", bg2: "#20242b", panel: "#262a32", border: "#333844", fg: "#cbd1db", muted: "#868c98", accent: "#6ea8fe", user: "#2a3550", code: "#10131a", link: "#7cb0ff", live: "#3fb950", error: "#f85149", warn: "#d29922" },
  Graphite: { bg: "#1a1a1a", bg2: "#212121", panel: "#282828", border: "#383838", fg: "#eaeaea", muted: "#9a9a9a", accent: "#e0895a", user: "#33302b", code: "#121212", link: "#e0a070", live: "#7fb950", error: "#f06a6a", warn: "#d8a657" },
  Light: { bg: "#f7f8fa", bg2: "#eef0f3", panel: "#ffffff", border: "#d8dce2", fg: "#1c1f24", muted: "#6b7280", accent: "#2563eb", user: "#dbe6ff", code: "#eef1f4", link: "#2563eb", live: "#1a7f37", error: "#cf222e", warn: "#9a6700" },
  // Warm paper with a dark ink text and a muted teal accent — a reading-room palette, kept
  // deliberately clear of the cream-and-coral look it used to lean on.
  Sepia: { bg: "#f1ead8", bg2: "#e8e0cd", panel: "#faf4e4", border: "#d9cdb2", fg: "#33302a", muted: "#867a60", accent: "#2b7a70", user: "#e4dcc4", code: "#e8e0cd", link: "#1f6f65", live: "#5a7d2a", error: "#a3311e", warn: "#9a6700" },
  // A phosphor terminal on a true-black ground: the green comes in through the accents,
  // borders, and links rather than the surface, and the text is a soft pale green so the
  // whole screen no longer reads as saturated green.
  Matrix: { bg: "#000000", bg2: "#070a07", panel: "#0b100c", border: "#1d3f27", fg: "#cfe6d3", muted: "#5f9668", accent: "#33d15b", user: "#0f2716", code: "#060a07", link: "#62d67c", live: "#33d15b", error: "#ff6b6b", warn: "#e3b341" },
};

export const DEFAULT_THEME: ThemeState = { activeId: "preset:Midnight", overrides: {}, userThemes: {} };

/** The base theme behind the active selection (a preset's colours + default typography, or a saved theme). */
export function baseTheme(state: Pick<ThemeState, "activeId" | "userThemes">): Theme {
  if (state.activeId.startsWith("user:")) {
    const u = state.userThemes[state.activeId.slice(5)];
    if (u) return u.theme;
  }
  const name = state.activeId.startsWith("preset:") ? state.activeId.slice(7) : "Midnight";
  return { colors: PRESETS[name] ?? PRESETS.Midnight, font: FONT_DEFAULT, size: SIZE_DEFAULT };
}

// Sensible code-block background for a theme that predates the `code` token: a subtle
// panel that contrasts with the theme's text — light box on a light theme, dark on a dark one.
function deriveCode(bg: string): string {
  const h = bg.replace("#", "");
  if (h.length < 6) return "#0d0f13";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.5 ? "#e9ebef" : "#0d0f13";
}

/** Final theme = base merged with the user's live tweaks. */
export function resolveTheme(state: ThemeState): Theme {
  const b = baseTheme(state);
  const o = state.overrides ?? {};
  const colors = { ...b.colors, ...(o.colors ?? {}) };
  if (!colors.code) colors.code = deriveCode(colors.bg); // back-fill for pre-`code` saved themes
  if (!colors.link) colors.link = colors.accent; // back-fill for pre-`link` themes (accent is always themed + contrasty)
  return { colors, font: o.font ?? b.font, size: o.size ?? b.size };
}

export function hasTweaks(o: ThemeOverrides | undefined): boolean {
  return !!(o && ((o.colors && Object.keys(o.colors).length > 0) || o.font !== undefined || o.size !== undefined));
}

/** Apply a theme to the live document (inline vars on :root win over stylesheet defaults). */
export function applyTheme(state: ThemeState): void {
  const t = resolveTheme(state);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.colors)) root.style.setProperty(`--${k}`, v);
  root.style.setProperty("--font-family", FONT_STACKS[t.font] ?? FONT_STACKS.system);
  root.style.setProperty("--font-size", `${t.size}px`);
}

/** Normalise whatever was persisted (incl. the old {preset, overrides} shape) into ThemeState. */
export function migrate(saved: unknown): ThemeState {
  if (saved && typeof saved === "object") {
    const s = saved as Record<string, unknown>;
    if (typeof s.activeId === "string") {
      return { activeId: s.activeId, overrides: (s.overrides as ThemeOverrides) ?? {}, userThemes: (s.userThemes as Record<string, UserTheme>) ?? {} };
    }
    if (typeof s.preset === "string") {
      const preset = PRESETS[s.preset] ? s.preset : "Midnight";
      return { activeId: `preset:${preset}`, overrides: { colors: (s.overrides as Partial<ThemeColors>) ?? {} }, userThemes: {} };
    }
  }
  return DEFAULT_THEME;
}

/**
 * piwork-ui — the abstraction seam between Piwork extensions and the shell's intent
 * contract. Extensions call these helpers instead of hand-rolling intents, so when the
 * contract grows (e.g. openExternal becomes a first-class intent once we own the shim),
 * extension code doesn't change — only this library's implementation does.
 *
 * CURRENT IMPLEMENTATION NOTE: Pi's shipped RPC UI context (which pi-host uses via
 * runRpcMode) has a FIXED method set — we can't add a real `openExternal` intent
 * without owning the shim. So today `openExternal` rides on `notify` with a reserved
 * sentinel that the shell recognizes. This is a documented convention, contained here;
 * it upgrades to a first-class intent later with zero changes to callers.
 */

/** Reserved marker the shell looks for inside a `notify` payload. Keep in sync with the shell. */
export const PIWORK_INTENT_SENTINEL = "__piworkIntent__";

export interface PiworkArtifact {
  /** Stable key; re-showing the same key replaces that artifact. */
  key?: string;
  title?: string;
  html?: string;
  markdown?: string;
}

/** Minimal shape of the `ui` object on an extension context (ctx.ui). */
export interface PiworkUiLike {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** First-class intents, present when running under a Piwork shell that owns the shim. */
  openExternal?: (url: string) => void;
  showArtifact?: (opts: PiworkArtifact) => void;
  clearArtifact?: (key?: string) => void;
}

/** Render rich HTML/markdown in the shell's sandboxed artifact panel. */
export function showArtifact(ui: PiworkUiLike, artifact: PiworkArtifact): void {
  if (typeof ui.showArtifact === "function") ui.showArtifact(artifact);
  else ui.notify("This host can't render artifacts (needs the Piwork shell).", "warning");
}

/** Remove a previously shown artifact by key. */
export function clearArtifact(ui: PiworkUiLike, key?: string): void {
  ui.clearArtifact?.(key);
}

/**
 * Ask the host to open a URL in the user's real browser. Prefers the first-class
 * `ctx.ui.openExternal` intent (Piwork owns the shim); falls back to the notify-sentinel
 * convention on shells/older hosts that don't provide it. Callers never change.
 */
export function openExternal(ui: PiworkUiLike, url: string): void {
  if (typeof ui.openExternal === "function") {
    ui.openExternal(url);
    return;
  }
  ui.notify(JSON.stringify({ [PIWORK_INTENT_SENTINEL]: { kind: "openExternal", url } }), "info");
}

/** Parse a notify message that may carry a Piwork intent. Returns null if it's a plain toast. */
export function parsePiworkIntent(message: string): { kind: string; [k: string]: unknown } | null {
  if (typeof message !== "string" || message[0] !== "{") return null;
  try {
    const obj = JSON.parse(message);
    const intent = obj?.[PIWORK_INTENT_SENTINEL];
    return intent && typeof intent.kind === "string" ? intent : null;
  } catch {
    return null;
  }
}

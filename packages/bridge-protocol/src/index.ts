/**
 * @piwork/bridge-protocol — the wire contract between the Piwork shell (host) and
 * pi-host (inside the container).
 *
 * DESIGN: pi-host runs Pi's `runRpcMode`, so the wire protocol IS Pi's RPC/JSONL
 * protocol (commands host->container on stdin; responses + AgentSessionEvents +
 * extension UI requests container->host on stdout). We deliberately do NOT wrap each
 * message in an envelope — that would fight Pi's shipped stream. Instead:
 *   - framing is shared and strict (see ./framing),
 *   - the message shapes mirror Pi's dist/modes/rpc/rpc-types.d.ts (kept minimal and
 *     stable here so the shell needn't depend on Pi's internal export surface),
 *   - versioning is handled by an explicit handshake (`BridgeHello`) that pi-host
 *     emits on startup, so host and container can detect protocol drift on day one.
 */
export * from "./framing.ts";

/** Bump when the wire contract changes in a breaking way. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * First line pi-host emits on stdout after the runtime is ready, before any events.
 * Lets the shell confirm protocol compatibility and learn initial session facts.
 * (pi-host emits this in addition to running Pi's runRpcMode.)
 */
export interface BridgeHello {
  type: "piwork_hello";
  protocolVersion: number;
  piVersion: string;
  sessionId?: string;
  cwd: string;
}

// ── Extension UI intents (mirror Pi's RpcExtensionUIRequest/Response) ──────────────
// These are the serialized ctx.ui calls the shell must render. Blocking dialogs
// (select/confirm/input/editor) expect a matching response keyed by `id`; the rest
// are fire-and-forget.

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/** Methods that block on a host response (vs. fire-and-forget). */
export const BLOCKING_UI_METHODS = ["select", "confirm", "input", "editor"] as const;

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

// ── Type guards ─────────────────────────────────────────────────────────────────
type AnyMsg = Record<string, unknown>;

export function isBridgeHello(m: unknown): m is BridgeHello {
  return isObj(m) && m.type === "piwork_hello";
}
export function isExtensionUiRequest(m: unknown): m is ExtensionUiRequest {
  return isObj(m) && m.type === "extension_ui_request" && typeof m.method === "string";
}
export function isResponse(m: unknown): m is { type: "response"; command: string; success: boolean; id?: string; data?: unknown; error?: string } {
  return isObj(m) && m.type === "response" && typeof m.command === "string";
}
/** True for AgentSessionEvent passthrough (anything that isn't a response/UI/hello). */
export function isAgentEvent(m: unknown): boolean {
  if (!isObj(m) || typeof m.type !== "string") return false;
  return m.type !== "response" && m.type !== "extension_ui_request" && m.type !== "piwork_hello";
}
export function isBlockingUiRequest(m: ExtensionUiRequest): boolean {
  return (BLOCKING_UI_METHODS as readonly string[]).includes(m.method);
}

function isObj(m: unknown): m is AnyMsg {
  return typeof m === "object" && m !== null;
}

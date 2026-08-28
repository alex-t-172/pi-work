import { useCallback, useEffect, useRef, useState } from "react";
import type { Activity, ChatItem, Connection, LoginState, McpStatusEntry, ModelInfo, SessionMeta, Toast, TreeNode, UiDialog } from "./types.ts";

// Extensions written for Pi's terminal UI (e.g. pi-mcp-adapter) color their status/widget/
// notify text with ANSI escape codes. Pi's TUI renders them; our GUI would show the raw codes
// (e.g. "\x1b[38;5;109mMCP: 0/1 servers"), so strip them before display — we style chips in CSS.
 
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s: unknown): string => String(s ?? "").replace(ANSI_RE, "");

// Mirrors piwork-ui's PIWORK_INTENT_SENTINEL. Extensions ride richer intents on `notify`
// until they become first-class (once we own the shim). Kept in sync by convention.
const PIWORK_INTENT_SENTINEL = "__piworkIntent__";

// The chain of nodes from a session-tree root down to the given leaf (used to find the last
// user message on the current branch, e.g. to retry it). Null if the leaf isn't found.
function pathToLeaf(nodes: TreeNode[], leafId: string | null): TreeNode[] | null {
  if (!leafId) return null;
  for (const n of nodes) {
    if (n.id === leafId) return [n];
    const sub = pathToLeaf(n.children, leafId);
    if (sub) return [n, ...sub];
  }
  return null;
}
function parsePiworkIntent(message: unknown): { kind: string; [k: string]: unknown } | null {
  if (typeof message !== "string" || message[0] !== "{") return null;
  try {
    const intent = JSON.parse(message)?.[PIWORK_INTENT_SENTINEL];
    return intent && typeof intent.kind === "string" ? intent : null;
  } catch {
    return null;
  }
}

/** All renderer state derived from the bridge message stream, plus action senders. */
export function useBridge() {
  const [connection, setConnection] = useState<Connection>("idle");
  const [hello, setHello] = useState<{ piVersion: string; sessionId?: string } | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  // What the agent is doing right now, for a phase-aware live indicator. `since` is a
  // client clock (ms) reset on each phase change, so the UI can show elapsed-in-phase —
  // a ticking timer = liveness, a long-climbing one = probably stuck.
  const [activity, setActivity] = useState<Activity | null>(null);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [widgets, setWidgets] = useState<{ above: Record<string, string[]>; below: Record<string, string[]> }>({ above: {}, below: {} });
  const [dialog, setDialog] = useState<UiDialog | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelInfo | null>(null);
  const [thinkingLevel, setThinkingLevelState] = useState<string>("medium");
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null); // composed prompt (fetched on demand)
  const [stderrLog, setStderrLog] = useState<string[]>([]);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [login, setLogin] = useState<LoginState>({ active: false });
  const [artifacts, setArtifacts] = useState<Record<string, { title?: string; html?: string; markdown?: string }>>({});
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [lastArtifactKey, setLastArtifactKey] = useState<string | null>(null);
  const [commands, setCommands] = useState<Array<{ name: string; description?: string; source?: string }>>([]);
  const [sessionTree, setSessionTree] = useState<{ tree: TreeNode[]; leaf: string | null } | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatusEntry[]>([]);
  // The sandbox exited WITHOUT the user ending it (e.g. the Mac slept and the docker
  // connection dropped). We keep the session context and offer/auto-do a reconnect instead
  // of silently bouncing to home. intentionalEnd distinguishes a user-triggered End.
  const [dropped, setDropped] = useState(false);
  // Bumped when the agent finishes a turn, so the Files panel re-reads the workspace (the agent
  // may have added/changed/removed files) without the user hitting a manual refresh.
  const [turnTick, setTurnTick] = useState(0);
  // A blocking session-start failure (docker missing / daemon down / image not built), shown
  // persistently in the session screen — not just a transient toast.
  const [startError, setStartError] = useState<string | null>(null);
  const intentionalEnd = useRef(false);
  // Set when the agent presents a workspace file via show_artifact; App opens it in the viewer.
  const [fileOpenRequest, setFileOpenRequest] = useState<{ rel: string; nonce: number } | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  // Queued steer/follow-up messages Pi reports (queue_update), so the composer can show
  // "N queued" instead of a message vanishing into thin air after Alt+Enter.
  const [queue, setQueue] = useState<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] });
  // A turn that ended in failure after Pi's auto-retries gave up (e.g. the connection dropped).
  // Drives an inline Retry affordance; cleared when a new turn starts.
  const [turnError, setTurnError] = useState<string | null>(null);
  const retryPending = useRef(false); // Retry clicked → fetching the tree to find the last user msg
  const resendAfterRewind = useRef<string | null>(null); // text to resend once the retry rewind lands
  // rewindTo is defined below the message-subscription effect; a ref lets the effect call it
  // without a forward reference in its dependency array.
  const rewindToRef = useRef<((id: string, prefill?: string) => void) | null>(null);
  const [injectedText, setInjectedText] = useState<{ text: string; nonce: number } | null>(null);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  // The most recent session overall (a folder session or the global chat), for the home
  // "Resume previous session" shortcut. Written host-side whenever any session starts.
  const [resumeTarget, setResumeTarget] = useState<{ kind: "folder"; folder: string } | { kind: "global" } | null>(null);
  const [launcherFolder, setLauncherFolder] = useState<string | null>(null);
  const [launcherSessions, setLauncherSessions] = useState<SessionMeta[] | null>(null);
  const [launcherGlobal, setLauncherGlobal] = useState(false); // showing the global-chat history launcher
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [globalMode, setGlobalMode] = useState(false);

  const idc = useRef(0);
  const nextId = () => `it-${++idc.current}`;
  const assistantId = useRef<string | null>(null);
  const toolIds = useRef<Map<string, string>>(new Map());
  const bashIds = useRef<Map<string, string>>(new Map()); // bash command id → chat item id
  const rewindInFlight = useRef(false); // a rewind was requested, awaiting the fresh tree (= success)
  const pendingPrefill = useRef<string | null>(null);
  const streamingRef = useRef(false);

  useEffect(() => { streamingRef.current = streaming; }, [streaming]);

  const pushToast = useCallback((message: string, level: Toast["level"]) => {
    const id = nextId();
    setToasts((t) => [...t, { id, message, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // NOTE: keep setItems updaters PURE (React StrictMode double-invokes them). Generate
  // ids and mutate refs OUTSIDE the updater.
  const ensureAssistant = useCallback((): string => {
    let id = assistantId.current;
    if (!id) {
      id = nextId();
      assistantId.current = id;
      window.piwork?.log(`renderer: created assistant bubble ${id}`);
      setItems((prev) => [...prev, { id: id!, role: "assistant", text: "", thinking: "", streaming: true }]);
    }
    return id;
  }, []);

  const appendText = useCallback((delta: string) => {
    const id = ensureAssistant();
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, text: it.text + delta } : it)));
  }, [ensureAssistant]);

  const appendThinking = useCallback((delta: string) => {
    const id = ensureAssistant();
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, thinking: (it.thinking ?? "") + delta } : it)));
  }, [ensureAssistant]);

  const finalizeAssistant = useCallback(() => {
    const id = assistantId.current;
    assistantId.current = null;
    if (id) setItems((prev) => prev.map((it) => (it.id === id ? { ...it, streaming: false } : it)));
  }, []);

  // Rebuild the chat from message history (on resume, and after a tree rewind).
  const loadMessages = useCallback((messages: any[]) => {
    assistantId.current = null;
    const items: ChatItem[] = [];
    for (const m of messages ?? []) {
      const parts = Array.isArray(m?.content) ? m.content : [];
      const text = parts.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
      if (m?.role === "user" && text.trim()) items.push({ id: nextId(), role: "user", text });
      else if (m?.role === "assistant" && text.trim()) items.push({ id: nextId(), role: "assistant", text });
    }
    // Replace unconditionally — a rewind to before an early human message truncates the
    // conversation to (possibly) empty, and the chat must reflect that, not keep stale messages.
    setItems(items);
  }, []);

  useEffect(() => {
    const unsub = window.piwork.onMessage(({ channel, payload }) => {
      const p = payload as Record<string, any>;
      // Ring buffer for the in-app debug drawer (the renderer's view of the stream).
      const tag =
        channel === "event" && p?.type === "message_update"
          ? `event message_update/${p.assistantMessageEvent?.type}`
          : channel === "event"
            ? `event ${p?.type}`
            : channel === "ui_request"
              ? `ui_request ${p?.method}`
              : channel === "response"
                ? `response ${p?.command} ok=${p?.success}`
                : channel;
      setDebugLog((l) => [...l.slice(-299), `${new Date().toLocaleTimeString()} ${tag}`]);
      switch (channel) {
        case "hello":
          setConnection("connected");
          setDropped(false); // we're live — never show the reconnect banner while connected
          setHello({ piVersion: p.piVersion, sessionId: p.sessionId });
          window.piwork.send({ id: "get_state", type: "get_state" });
          window.piwork.send({ id: "get_available_models", type: "get_available_models" });
          window.piwork.send({ id: "get_commands", type: "get_commands" });
          window.piwork.send({ id: "history", type: "get_messages" }); // show history on resume
          break;

        case "event":
          handleEvent(p);
          break;

        case "ui_request":
          handleUi(p);
          break;

        case "login":
          handleLogin(p);
          break;

        case "response":
          if (p.command === "get_commands" && p.success) setCommands(p.data?.commands ?? []);
          else if (p.command === "get_messages" && p.success) loadMessages(p.data?.messages ?? []);
          else if (p.command === "get_available_models" && p.success) setModels(p.data?.models ?? []);
          else if (p.command === "set_model" && p.success) setCurrentModel(p.data ?? null);
          else if (p.command === "get_state" && p.success) {
            if (p.data?.model) setCurrentModel(p.data.model);
            if (p.data?.thinkingLevel) setThinkingLevelState(p.data.thinkingLevel);
            setStreaming(Boolean(p.data?.isStreaming));
            // On reconnect mid-stream we don't know the phase; show a generic working state.
            setActivity((a) => (p.data?.isStreaming ? a ?? { phase: "working", since: Date.now() } : null));
          } else if (p.command === "bash") {
            // Result of a user-run `!command`: fill in its item (output + exit).
            const itemId = bashIds.current.get(String(p.id));
            if (itemId) {
              bashIds.current.delete(String(p.id));
              const r = (p.data ?? {}) as { output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean };
              const ok = Boolean(p.success) && !r.cancelled && (r.exitCode === 0 || r.exitCode == null);
              setItems((prev) => prev.map((it) => (it.id === itemId
                ? { ...it, toolStatus: ok ? "ok" : "error", toolResult: p.success ? (r.output ?? "") : String(p.error ?? "bash failed"), toolDetails: { exitCode: r.exitCode, cancelled: r.cancelled, truncated: r.truncated } }
                : it)));
            }
          } else if (p.success === false) {
            pushToast(`${p.command} failed: ${p.error ?? "error"}`, "error");
          }
          break;

        case "stderr":
          setStderrLog((l) => [...l.slice(-400), String(p)]);
          break;
        case "exit":
          setStreaming(false);
          setActivity(null);
          if (intentionalEnd.current) {
            intentionalEnd.current = false; // user ended it; endSession owns the connection state
          } else {
            setConnection("exited");
            setDropped(true); // unexpected drop → keep context, offer reconnect
          }
          break;
        case "error":
          setConnection("error");
          pushToast(String(p?.message ?? "bridge error"), "error");
          break;
      }
    });
    return unsub;

    function handleEvent(p: Record<string, any>) {
      switch (p.type) {
        case "agent_start":
          setStreaming(true);
          setTurnError(null); // a fresh turn clears any prior failure banner
          setActivity({ phase: "working", since: Date.now() });
          break;
        case "message_end":
          // Close the current assistant bubble at each message boundary. A single turn
          // can contain several assistant messages (text → tool → text); without this
          // they merge into one bubble and run together ("…end.Start of next…").
          if (p.message?.role === "assistant") finalizeAssistant();
          break;
        case "agent_end":
          // willRetry === the turn failed but Pi will auto-retry it. Don't tear the stream
          // down (no "done" flicker); auto_retry_start keeps the pill in a retrying state.
          if (p.willRetry) break;
          setStreaming(false);
          setActivity(null);
          setTurnTick((n) => n + 1);
          finalizeAssistant();
          break;
        // Pi paused the turn to summarize history down to fit the context window. Without a
        // distinct phase this reads as a multi-minute "Working…" freeze.
        case "compaction_start":
          setActivity({ phase: "compacting", since: Date.now() });
          break;
        case "compaction_end":
          // Leave a marker in the transcript so the pause is explained in-history (and because
          // people often choose to restart a session after a compaction).
          if (!p.aborted) {
            setItems((prev) => [...prev, { id: nextId(), role: "system", text: "Context compacted to fit the model's window." }]);
          }
          setActivity((a) => (a ? { phase: "working", since: Date.now() } : a));
          break;
        // The model request failed (usually a flaky connection) and Pi is retrying it. Surface
        // the attempt count instead of a stalled "Responding…".
        case "auto_retry_start":
          setActivity({ phase: "retrying", since: Date.now(), attempt: p.attempt, maxAttempts: p.maxAttempts });
          break;
        case "auto_retry_end":
          if (p.success) setActivity((a) => (a ? { phase: "working", since: Date.now() } : a));
          else setTurnError(typeof p.finalError === "string" && p.finalError ? p.finalError : "The connection dropped before the turn could finish.");
          break;
        // Queued steer/follow-up messages (Alt+Enter). Mirror them so the composer can show them.
        case "queue_update":
          setQueue({ steering: Array.isArray(p.steering) ? p.steering : [], followUp: Array.isArray(p.followUp) ? p.followUp : [] });
          break;
        // Keep the thinking-level control in sync if it changes server-side (some models force one).
        case "thinking_level_changed":
          if (typeof p.level === "string") setThinkingLevelState(p.level);
          break;
        case "message_update": {
          const ev = p.assistantMessageEvent;
          if (!ev) break;
          if (ev.type === "text_delta") {
            appendText(ev.delta ?? "");
            setActivity((a) => (a && a.phase === "responding" ? a : { phase: "responding", since: Date.now() }));
          } else if (ev.type === "thinking_delta") {
            appendThinking(ev.delta ?? "");
            setActivity((a) => (a && a.phase === "thinking" ? a : { phase: "thinking", since: Date.now() }));
          } else if (ev.type === "toolcall_start" || ev.type === "toolcall_delta") {
            // The model is streaming a tool call's arguments (e.g. writing a doc into the
            // call) — this can take many seconds with no visible text. Give it its own phase
            // so it doesn't read as a frozen "Responding…", and accumulate the streamed size
            // so a growing byte count shows it's actively producing. The tool name isn't in
            // these events (0.84 stripped the cumulative `partial`); it arrives at execution.
            const add = ev.delta ? String(ev.delta).length : 0;
            setActivity((a) =>
              a && a.phase === "toolcall"
                ? { ...a, bytes: (a.bytes ?? 0) + add }
                : { phase: "toolcall", since: Date.now(), bytes: add },
            );
          } else if (ev.type === "done") finalizeAssistant();
          else if (ev.type === "error") {
            finalizeAssistant();
            pushToast(`model error: ${ev.reason ?? ""} ${ev.error ?? ""}`, "error");
          }
          break;
        }
        case "tool_execution_start": {
          const id = nextId();
          toolIds.current.set(String(p.toolCallId), id);
          setItems((prev) => [...prev, { id, role: "tool", text: "", toolName: p.toolName, toolStatus: "running", toolArgs: p.args }]);
          setActivity({ phase: "tool", label: p.toolName ? String(p.toolName) : undefined, since: Date.now() });
          break;
        }
        case "tool_execution_end": {
          const id = toolIds.current.get(String(p.toolCallId));
          const result = p.result ?? {};
          const resultText = Array.isArray(result.content) ? result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("") : undefined;
          if (id) setItems((prev) => prev.map((it) => (it.id === id ? { ...it, toolStatus: p.isError ? "error" : "ok", toolResult: resultText, toolDetails: result.details } : it)));
          // Tool finished; the model resumes — back to a generic working phase until it emits.
          setActivity((a) => (a ? { phase: "working", since: Date.now() } : a));
          break;
        }
      }
    }

    function handleUi(p: Record<string, any>) {
      switch (p.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor":
          setDialog({ id: p.id, method: p.method, title: p.title, message: p.message, options: p.options, placeholder: p.placeholder, prefill: p.prefill });
          break;
        case "notify": {
          const intent = parsePiworkIntent(p.message);
          if (intent?.kind === "openExternal" && typeof intent.url === "string") {
            window.piwork.openExternal(intent.url);
          } else {
            pushToast(stripAnsi(p.message), p.notifyType ?? "info");
          }
          break;
        }
        case "setStatus":
          setStatuses((s) => {
            const next = { ...s };
            if (p.statusText === undefined || p.statusText === null) delete next[p.statusKey];
            else next[p.statusKey] = stripAnsi(p.statusText);
            return next;
          });
          break;
        case "setWidget": {
          const placement = p.widgetPlacement === "belowEditor" ? "below" : "above";
          setWidgets((w) => {
            const group = { ...w[placement] };
            if (p.widgetLines === undefined || p.widgetLines === null) delete group[p.widgetKey];
            else group[p.widgetKey] = (Array.isArray(p.widgetLines) ? p.widgetLines : []).map(stripAnsi);
            return { ...w, [placement]: group };
          });
          break;
        }
        case "setTitle":
          if (typeof p.title === "string") document.title = p.title;
          break;
        case "set_editor_text": // e.g. rewinding to a human message prefills its text
          setInjectedText((prev) => ({ text: String(p.text ?? ""), nonce: (prev?.nonce ?? 0) + 1 }));
          break;
        case "openExternal": // first-class intent (Piwork owns the shim)
          if (typeof p.url === "string") window.piwork.openExternal(p.url);
          break;
        case "mcpStatus":
          setMcpStatus((Array.isArray(p.servers) ? p.servers : []) as McpStatusEntry[]);
          break;
        case "systemPrompt":
          setSystemPrompt(String(p.prompt ?? ""));
          break;
        case "sessionTree": {
          const tree = (p.tree as TreeNode[]) ?? [];
          const leaf = (p.leaf as string | null) ?? null;
          setSessionTree({ tree, leaf });
          // Retry flow: we fetched the tree quietly (not to open the panel) to find the user's
          // last message, then rewind to it and resend it once the rewind lands.
          if (retryPending.current) {
            retryPending.current = false;
            const path = pathToLeaf(tree, leaf) ?? [];
            const lastUser = [...path].reverse().find((n) => n.type === "message" && n.role === "user");
            if (lastUser) {
              resendAfterRewind.current = lastUser.text ?? lastUser.preview ?? "";
              rewindToRef.current?.(lastUser.id); // no prefill — we resend on success
            }
            break; // don't open the panel
          }
          setTreeOpen(true);
          if (rewindInFlight.current) {
            // pi-host only re-emits the tree on a SUCCESSFUL rewind (not on cancel), so
            // this is where we know it worked — reload the chat from the new leaf (this is the
            // reliable signal, vs a fixed timer that can fire before navigate completes) and
            // apply the human-message prefill.
            window.piwork.send({ id: "history", type: "get_messages" });
            if (pendingPrefill.current != null) {
              const text = pendingPrefill.current;
              setInjectedText((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
            }
            rewindInFlight.current = false;
            pendingPrefill.current = null;
            setRewinding(false);
            // A Retry resends the user's last message automatically once we're back at it.
            if (resendAfterRewind.current != null) {
              const text = resendAfterRewind.current;
              resendAfterRewind.current = null;
              if (text.trim()) setTimeout(() => submitRef.current?.(text, "auto"), 0);
            }
          }
          break;
        }
        case "artifact": {
          const key = String(p.key ?? "default");
          if (typeof p.file === "string" && p.file) {
            // Present a workspace file: let the shell open it host-side in the viewer (same
            // pipeline as the Files panel). A nonce so re-presenting the same file re-triggers.
            setFileOpenRequest((prev) => ({ rel: String(p.file), nonce: (prev?.nonce ?? 0) + 1 }));
            break;
          }
          const empty = p.clear || (p.html == null && p.markdown == null);
          setArtifacts((prev) => {
            const next = { ...prev };
            if (empty) delete next[key];
            else next[key] = { title: p.title, html: p.html, markdown: p.markdown };
            return next;
          });
          if (!empty) { setArtifactsOpen(true); setLastArtifactKey(key); } // auto-open + select the new artifact
          break;
        }
      }
    }

    function handleLogin(p: Record<string, any>) {
      switch (p.type) {
        case "login_providers":
          setLogin((s) => ({ ...s, active: true, providers: p.providers, needProvider: !!p.needChoice, status: p.needChoice ? "Choose a provider" : "Authorizing…" }));
          break;
        case "login_open_url":
          setLogin((s) => ({ ...s, status: "Opened your browser - complete sign-in there." }));
          break;
        case "login_device_code":
          setLogin((s) => ({ ...s, status: `Enter code ${p.userCode} at ${p.verificationUri}` }));
          break;
        case "login_progress":
          setLogin((s) => ({ ...s, status: String(p.message ?? "") }));
          break;
        case "login_prompt":
          setLogin((s) => ({ ...s, prompt: { kind: "prompt", id: p.id, message: p.message, placeholder: p.placeholder } }));
          break;
        case "login_select":
          setLogin((s) => ({ ...s, prompt: { kind: "select", id: p.id, message: p.message, options: p.options } }));
          break;
        case "login_done":
          setLogin({ active: false, status: "Signed in" });
          pushToast("Signed in ✓ - reconnecting session", "info");
          break;
        case "login_error":
          setLogin((s) => ({ ...s, error: String(p.message ?? "login failed"), prompt: undefined }));
          pushToast(`Login failed: ${p.message}`, "error");
          break;
      }
    }
  }, [appendText, appendThinking, finalizeAssistant, pushToast, loadMessages]);

  // ── launcher actions ─────────────────────────────────────────────────────────
  const refreshRecent = useCallback(async () => {
    try { setRecentFolders(await window.piwork.recentFolders()); } catch { /* ignore */ }
    try { setResumeTarget(await window.piwork.lastSession()); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void refreshRecent(); }, [refreshRecent]);

  const selectFolder = useCallback(async (folder: string) => {
    setLauncherGlobal(false);
    setLauncherFolder(folder);
    setLauncherSessions(null); // loading
    try {
      setLauncherSessions(await window.piwork.listSessions(folder));
    } catch {
      setLauncherSessions([]);
    }
  }, []);
  // Global-chat launcher: like a folder's history, but for the folderless global chat.
  const selectGlobal = useCallback(async () => {
    setLauncherFolder(null);
    setLauncherGlobal(true);
    setLauncherSessions(null);
    try {
      setLauncherSessions(await window.piwork.listGlobalSessions());
    } catch {
      setLauncherSessions([]);
    }
  }, []);
  const pickFolder = useCallback(async () => {
    const p = await window.piwork.pickWorkspace();
    if (p) await selectFolder(p);
  }, [selectFolder]);
  const backToFolders = useCallback(() => {
    setLauncherFolder(null);
    setLauncherGlobal(false);
    setLauncherSessions(null);
  }, []);

  // Clear everything scoped to a single session so nothing bleeds across folders.
  const resetSessionState = useCallback(() => {
    setItems([]);
    setStreaming(false);
    setActivity(null);
    setStatuses({});
    setWidgets({ above: {}, below: {} });
    setDialog(null);
    setArtifacts({});
    setArtifactsOpen(false);
    setLastArtifactKey(null);
    setSessionTree(null);
    setTreeOpen(false);
    setRewinding(false);
  }, []);

  const startWith = useCallback(async (folder: string, session?: string) => {
    setGlobalMode(false);
    setActiveFolder(folder);
    setDropped(false);
    setStartError(null);
    setConnection("starting");
    resetSessionState();
    const res = await window.piwork.startSession(folder, session);
    if (!res.ok) {
      setConnection("error");
      setStartError(res.error ?? "Couldn't start the session.");
      pushToast(res.error ?? "Couldn't start the session.", "error");
    } else {
      void refreshRecent();
    }
  }, [pushToast, refreshRecent, resetSessionState]);

  const startGlobal = useCallback(async (session?: string) => {
    setGlobalMode(true);
    setActiveFolder(null);
    setDropped(false);
    setStartError(null);
    setConnection("starting");
    resetSessionState();
    const res = await window.piwork.startGlobalSession(session);
    if (!res.ok) {
      setConnection("error");
      setStartError(res.error ?? "Couldn't start the session.");
      pushToast(res.error ?? "Couldn't start the session.", "error");
    } else {
      void refreshRecent(); // refresh the resume target (now the global chat)
    }
  }, [pushToast, refreshRecent, resetSessionState]);

  // End the session (kill the sandbox), then choose where to land.
  const endSession = useCallback(async () => {
    intentionalEnd.current = true; // so the resulting exit isn't treated as a drop
    setDropped(false);
    await window.piwork.stopSession();
    setConnection("idle");
    resetSessionState();
    void refreshRecent();
  }, [refreshRecent, resetSessionState]);

  // Resume the current context's most recent session after an unexpected drop (the
  // conversation reloads from disk). Used by the reconnect banner + auto-reconnect on focus.
  const reconnect = useCallback(() => {
    if (globalMode) return startGlobal("recent");
    if (activeFolder) return startWith(activeFolder, "recent");
  }, [globalMode, activeFolder, startGlobal, startWith]);
  const endToHome = useCallback(async () => {
    await endSession();
    backToFolders();
  }, [endSession, backToFolders]);
  const endToSessions = useCallback(async () => {
    const folder = activeFolder;
    await endSession();
    if (folder) await selectFolder(folder);
    else backToFolders();
  }, [activeFolder, endSession, selectFolder, backToFolders]);
  // The global-chat analogue of endToSessions: leave the chat back to the list of past chats.
  const endToGlobalSessions = useCallback(async () => {
    await endSession();
    await selectGlobal();
  }, [endSession, selectGlobal]);
  // One-click resume of whatever you were last in — a folder session or the global chat.
  const resumeLast = useCallback(() => {
    if (!resumeTarget) return;
    if (resumeTarget.kind === "global") void startGlobal("recent");
    else void startWith(resumeTarget.folder, "recent");
  }, [resumeTarget, startGlobal, startWith]);

  // Run a `!command` in the sandbox (Pi's RPC bash) and show it as a terminal item in chat.
  // Output is included in the agent's context (like a terminal `!`), so the agent sees it too.
  const runBash = useCallback((command: string) => {
    const itemId = nextId();
    const cmdId = `bash-${itemId}`;
    bashIds.current.set(cmdId, itemId);
    setItems((prev) => [...prev, { id: itemId, role: "tool", userBash: true, text: "", toolName: "bash", toolStatus: "running", toolArgs: { command } }]);
    window.piwork.send({ id: cmdId, type: "bash", command });
  }, []);

  const submit = useCallback(
    async (text: string, mode: "auto" | "steer" | "followUp", attachments?: string[]) => {
      // `!command` → run bash in the sandbox instead of prompting the agent (like a terminal).
      const trimmed = text.trim();
      if (trimmed.startsWith("!") && trimmed.slice(1).trim()) {
        runBash(trimmed.slice(1).trim());
        return;
      }
      // Attachments: copy the picked host files into the workspace's .attachments/ (host-side,
      // git-excluded), then reference their workspace paths in the prompt so the agent reads them.
      let finalText = text;
      if (attachments && attachments.length > 0 && activeFolder) {
        const res = await window.piwork.attachFiles(activeFolder, attachments);
        if (res.ok && res.files.length > 0) {
          const refs = res.files.map((f) => `\`${f.relPath}\``).join(", ");
          finalText = `${text.trim() ? `${text.trim()}\n\n` : ""}Attached to the workspace: ${refs}`;
        } else if (!res.ok) {
          pushToast(res.error ?? "Couldn't attach the file.", "error");
        }
      }
      if (!finalText.trim()) return;
      const isCommand = finalText.startsWith("/");
      setItems((prev) => [...prev, { id: nextId(), role: "user", text: finalText }]);
      if (!streaming || mode === "auto" || isCommand) {
        window.piwork.send({ id: "prompt", type: "prompt", message: finalText, streamingBehavior: streaming ? "steer" : undefined });
      } else if (mode === "steer") {
        window.piwork.send({ id: "steer", type: "steer", message: finalText });
      } else {
        window.piwork.send({ id: "follow_up", type: "follow_up", message: finalText });
      }
    },
    [streaming, activeFolder, pushToast, runBash],
  );
  // The message-subscription effect (mounted once) needs the current `submit` to resend on a
  // Retry; a ref keeps it fresh without re-subscribing.
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const openSessionTree = useCallback(() => window.piwork.send({ id: "tree", type: "prompt", message: "/piwork-tree" }), []);
  // Ask pi-host for the composed system prompt (arrives via the "systemPrompt" intent).
  const fetchSystemPrompt = useCallback(() => window.piwork.send({ id: "sysprompt", type: "prompt", message: "/piwork-system-prompt" }), []);
  const rewindTo = useCallback((id: string, prefill?: string) => {
    if (streamingRef.current) return; // no rewinding mid-turn (UI is disabled too)
    rewindInFlight.current = true;
    pendingPrefill.current = prefill ?? null; // applied only once the rewind succeeds (see sessionTree handler)
    setRewinding(true);
    window.piwork.send({ id: "rewind", type: "prompt", message: `/piwork-rewind ${id}` });
    // The chat reload now happens when the success tree arrives (see the sessionTree handler),
    // which is the reliable signal — no fixed timer that could fire before navigate completes.
    setTimeout(() => { // safety: if no fresh tree arrives (e.g. rewind cancelled), don't hang/prefill
      if (rewindInFlight.current) { rewindInFlight.current = false; pendingPrefill.current = null; setRewinding(false); }
    }, 6000);
  }, []);
  rewindToRef.current = rewindTo; // keep the effect's forward-ref caller current

  // Resume a turn that failed after Pi's retries gave up: fetch the tree, rewind to the user's
  // last message, and resend it (the clean restart, one click). The work happens in the
  // sessionTree handler once the tree arrives.
  const retryLastTurn = useCallback(() => {
    if (streamingRef.current) return;
    setTurnError(null);
    retryPending.current = true;
    window.piwork.send({ id: "tree", type: "prompt", message: "/piwork-tree" });
  }, []);

  const abort = useCallback(() => window.piwork.send({ id: "abort", type: "abort" }), []);
  const respondDialog = useCallback((resp: Record<string, unknown>) => {
    window.piwork.respondUi(resp);
    setDialog(null);
  }, []);
  const setModel = useCallback((provider: string, id: string) => {
    window.piwork.send({ id: "set_model", type: "set_model", provider, modelId: id });
  }, []);
  // Set the thinking level live for this session (Pi no-ops it on non-reasoning models), and
  // persist it as the default for future sessions.
  const setThinkingLevel = useCallback((level: string) => {
    setThinkingLevelState(level);
    window.piwork.send({ id: "set_thinking", type: "set_thinking_level", level });
    void window.piwork.setDefaultThinking(level);
  }, []);

  const startLogin = useCallback(async () => {
    setLogin({ active: true, status: "Starting login…" });
    try {
      if (typeof window.piwork?.startLogin !== "function") {
        throw new Error("Login isn't available in the running app - its main process is stale. Fully quit and restart `npm run dev`.");
      }
      const res = await window.piwork.startLogin();
      if (!res?.ok) setLogin({ active: true, error: res?.error ?? "Failed to start login." });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.piwork?.log?.(`startLogin error: ${msg}`);
      setLogin({ active: true, error: msg });
    }
  }, []);
  const chooseProvider = useCallback((id: string) => {
    window.piwork.loginChoose(id);
    setLogin((s) => ({ ...s, needProvider: false, providers: undefined, status: "Authorizing…" }));
  }, []);
  const submitLoginInput = useCallback((id: string, value: string) => {
    window.piwork.loginInput(id, value);
    setLogin((s) => ({ ...s, prompt: undefined, status: "Working…" }));
  }, []);
  const closeLogin = useCallback(() => setLogin({ active: false }), []);

  return {
    connection, hello, items, streaming, activity, statuses, widgets, dialog, toasts, models, currentModel, thinkingLevel, setThinkingLevel, stderrLog, debugLog, login,
    recentFolders, resumeTarget, resumeLast, launcherFolder, launcherSessions, launcherGlobal, selectGlobal, activeFolder, globalMode, startGlobal,
    artifacts, artifactsOpen, setArtifactsOpen, lastArtifactKey, commands,
    sessionTree, treeOpen, setTreeOpen, openSessionTree, rewindTo, rewinding, injectedText,
    systemPrompt, fetchSystemPrompt,
    mcpStatus, setMcpStatus,
    dropped, reconnect, startError, turnTick,
    queue, turnError, retryLastTurn,
    fileOpenRequest,
    submit, abort, respondDialog, setModel,
    startLogin, chooseProvider, submitLoginInput, closeLogin,
    refreshRecent, pickFolder, selectFolder, backToFolders, startWith, endToHome, endToSessions, endToGlobalSessions,
  };
}

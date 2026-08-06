import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatItem, Connection, LoginState, McpStatusEntry, ModelInfo, SessionMeta, Toast, TreeNode, UiDialog } from "./types.ts";

// Mirrors piwork-ui's PIWORK_INTENT_SENTINEL. Extensions ride richer intents on `notify`
// until they become first-class (once we own the shim). Kept in sync by convention.
const PIWORK_INTENT_SENTINEL = "__piworkIntent__";
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
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [widgets, setWidgets] = useState<{ above: Record<string, string[]>; below: Record<string, string[]> }>({ above: {}, below: {} });
  const [dialog, setDialog] = useState<UiDialog | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelInfo | null>(null);
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
  const intentionalEnd = useRef(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [injectedText, setInjectedText] = useState<{ text: string; nonce: number } | null>(null);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [launcherFolder, setLauncherFolder] = useState<string | null>(null);
  const [launcherSessions, setLauncherSessions] = useState<SessionMeta[] | null>(null);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [globalMode, setGlobalMode] = useState(false);

  const idc = useRef(0);
  const nextId = () => `it-${++idc.current}`;
  const assistantId = useRef<string | null>(null);
  const toolIds = useRef<Map<string, string>>(new Map());
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
    if (items.length) setItems(items);
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
            setStreaming(Boolean(p.data?.isStreaming));
          } else if (p.success === false) {
            pushToast(`${p.command} failed: ${p.error ?? "error"}`, "error");
          }
          break;

        case "stderr":
          setStderrLog((l) => [...l.slice(-400), String(p)]);
          break;
        case "exit":
          setStreaming(false);
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
          break;
        case "message_end":
          // Close the current assistant bubble at each message boundary. A single turn
          // can contain several assistant messages (text → tool → text); without this
          // they merge into one bubble and run together ("…end.Start of next…").
          if (p.message?.role === "assistant") finalizeAssistant();
          break;
        case "agent_end":
          setStreaming(false);
          finalizeAssistant();
          break;
        case "message_update": {
          const ev = p.assistantMessageEvent;
          if (!ev) break;
          if (ev.type === "text_delta") appendText(ev.delta ?? "");
          else if (ev.type === "thinking_delta") appendThinking(ev.delta ?? "");
          else if (ev.type === "done") finalizeAssistant();
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
          break;
        }
        case "tool_execution_end": {
          const id = toolIds.current.get(String(p.toolCallId));
          const result = p.result ?? {};
          const resultText = Array.isArray(result.content) ? result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("") : undefined;
          if (id) setItems((prev) => prev.map((it) => (it.id === id ? { ...it, toolStatus: p.isError ? "error" : "ok", toolResult: resultText, toolDetails: result.details } : it)));
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
            pushToast(String(p.message ?? ""), p.notifyType ?? "info");
          }
          break;
        }
        case "setStatus":
          setStatuses((s) => {
            const next = { ...s };
            if (p.statusText === undefined || p.statusText === null) delete next[p.statusKey];
            else next[p.statusKey] = p.statusText;
            return next;
          });
          break;
        case "setWidget": {
          const placement = p.widgetPlacement === "belowEditor" ? "below" : "above";
          setWidgets((w) => {
            const group = { ...w[placement] };
            if (p.widgetLines === undefined || p.widgetLines === null) delete group[p.widgetKey];
            else group[p.widgetKey] = p.widgetLines;
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
        case "sessionTree":
          setSessionTree({ tree: (p.tree as TreeNode[]) ?? [], leaf: (p.leaf as string | null) ?? null });
          setTreeOpen(true);
          if (rewindInFlight.current) {
            // pi-host only re-emits the tree on a SUCCESSFUL rewind (not on cancel), so
            // this is where we know it worked — apply the human-message prefill now.
            if (pendingPrefill.current != null) {
              const text = pendingPrefill.current;
              setInjectedText((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
            }
            rewindInFlight.current = false;
            pendingPrefill.current = null;
            setRewinding(false);
          }
          break;
        case "artifact": {
          const key = String(p.key ?? "default");
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
          setLogin((s) => ({ ...s, status: "Opened your browser — complete sign-in there." }));
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
          pushToast("Signed in ✓ — reconnecting session", "info");
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
  }, []);
  useEffect(() => { void refreshRecent(); }, [refreshRecent]);

  const selectFolder = useCallback(async (folder: string) => {
    setLauncherFolder(folder);
    setLauncherSessions(null); // loading
    try {
      setLauncherSessions(await window.piwork.listSessions(folder));
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
    setLauncherSessions(null);
  }, []);

  // Clear everything scoped to a single session so nothing bleeds across folders.
  const resetSessionState = useCallback(() => {
    setItems([]);
    setStreaming(false);
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
    setConnection("starting");
    resetSessionState();
    const res = await window.piwork.startSession(folder, session);
    if (!res.ok) {
      setConnection("error");
      pushToast(res.error ?? "failed to start", "error");
    } else {
      void refreshRecent();
    }
  }, [pushToast, refreshRecent, resetSessionState]);

  const startGlobal = useCallback(async (session?: string) => {
    setGlobalMode(true);
    setActiveFolder(null);
    setDropped(false);
    setConnection("starting");
    resetSessionState();
    const res = await window.piwork.startGlobalSession(session);
    if (!res.ok) {
      setConnection("error");
      pushToast(res.error ?? "failed to start", "error");
    }
  }, [pushToast, resetSessionState]);

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

  const submit = useCallback(
    (text: string, mode: "auto" | "steer" | "followUp") => {
      if (!text.trim()) return;
      const isCommand = text.startsWith("/");
      setItems((prev) => [...prev, { id: nextId(), role: "user", text }]);
      if (!streaming || mode === "auto" || isCommand) {
        window.piwork.send({ id: "prompt", type: "prompt", message: text, streamingBehavior: streaming ? "steer" : undefined });
      } else if (mode === "steer") {
        window.piwork.send({ id: "steer", type: "steer", message: text });
      } else {
        window.piwork.send({ id: "follow_up", type: "follow_up", message: text });
      }
    },
    [streaming],
  );

  const openSessionTree = useCallback(() => window.piwork.send({ id: "tree", type: "prompt", message: "/piwork-tree" }), []);
  const rewindTo = useCallback((id: string, prefill?: string) => {
    if (streamingRef.current) return; // no rewinding mid-turn (UI is disabled too)
    rewindInFlight.current = true;
    pendingPrefill.current = prefill ?? null; // applied only once the rewind succeeds (see sessionTree handler)
    setRewinding(true);
    window.piwork.send({ id: "rewind", type: "prompt", message: `/piwork-rewind ${id}` });
    setTimeout(() => window.piwork.send({ id: "history", type: "get_messages" }), 900); // refresh chat after rewind
    setTimeout(() => { // safety: if no fresh tree arrives (e.g. rewind cancelled), don't hang/prefill
      if (rewindInFlight.current) { rewindInFlight.current = false; pendingPrefill.current = null; setRewinding(false); }
    }, 6000);
  }, []);

  const abort = useCallback(() => window.piwork.send({ id: "abort", type: "abort" }), []);
  const respondDialog = useCallback((resp: Record<string, unknown>) => {
    window.piwork.respondUi(resp);
    setDialog(null);
  }, []);
  const setModel = useCallback((provider: string, id: string) => {
    window.piwork.send({ id: "set_model", type: "set_model", provider, modelId: id });
  }, []);

  const startLogin = useCallback(async () => {
    setLogin({ active: true, status: "Starting login…" });
    try {
      if (typeof window.piwork?.startLogin !== "function") {
        throw new Error("Login isn't available in the running app — its main process is stale. Fully quit and restart `npm run dev`.");
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
    connection, hello, items, streaming, statuses, widgets, dialog, toasts, models, currentModel, stderrLog, debugLog, login,
    recentFolders, launcherFolder, launcherSessions, activeFolder, globalMode, startGlobal,
    artifacts, artifactsOpen, setArtifactsOpen, lastArtifactKey, commands,
    sessionTree, treeOpen, setTreeOpen, openSessionTree, rewindTo, rewinding, injectedText,
    mcpStatus, setMcpStatus,
    dropped, reconnect,
    submit, abort, respondDialog, setModel,
    startLogin, chooseProvider, submitLoginInput, closeLogin,
    refreshRecent, pickFolder, selectFolder, backToFolders, startWith, endToHome, endToSessions,
  };
}

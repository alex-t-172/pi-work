import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { useBridge } from "./useBridge.ts";
import { useTheme } from "./useTheme.ts";
import { useResources } from "./useResources.ts";
import { useConnectors } from "./useConnectors.ts";
import { FONT_OPTIONS, hasTweaks, PRESETS, resolveTheme, SIZE_MAX, SIZE_MIN, THEME_TOKENS } from "./theme.ts";
import type { Activity, ChatItem, DirEntry, FileContent, LoginState, McpServer, McpStatusEntry, ResourceItem, ResourceList, SessionMeta, TreeNode, UiDialog } from "./types.ts";
// Rail icons — real artwork instead of emoji (Vite bundles + hashes these).
import fileIcon from "./assets/rail/file.png";
import extensionsIcon from "./assets/rail/extensions.png";
import connectorsIcon from "./assets/rail/connectors.png";
import modelsIcon from "./assets/rail/models.png";
import themeIcon from "./assets/rail/theme.png";
import debugIcon from "./assets/rail/debug.png";
import rewindIcon from "./assets/rail/rewind.png";

// Curated extensions you can install/remove in one click. The first four are also the defaults
// (baked + auto-installed — this list lets you remove them); the rest are optional.
const SUITE_PRESETS = [
  { name: "Ask", source: "/opt/piwork-suite/piwork-ask", dir: "piwork-ask", desc: "Let the agent ask you a question mid-turn" },
  { name: "Artifacts", source: "/opt/piwork-suite/piwork-artifacts", dir: "piwork-artifacts", desc: "Present a finished file or view in the viewer" },
  { name: "Tasks", source: "/opt/piwork-suite/piwork-tasks", dir: "piwork-tasks", desc: "A task list the agent maintains, shown as a docked widget" },
  { name: "Web search", source: "/opt/piwork-suite/piwork-websearch", dir: "piwork-websearch", desc: "web_search + fetch_url (keyless, or Brave with a key)" },
  { name: "Subagents", source: "/opt/pi-subagents", dir: "pi-subagents", desc: "Delegate work to subagents. Adds ~2s to session startup." },
  { name: "Checkpoint", source: "/opt/piwork-suite/piwork-checkpoint", dir: "piwork-checkpoint", desc: "Git auto-commit before each turn (safety net)" },
];

// MCP connector presets: hosted remote MCP servers that authenticate with OAuth — click
// Add, then Connect and authorize in the browser (no tokens to paste). Powered by the baked
// pi-mcp-adapter, which handles the OAuth (incl. dynamic client registration) + token refresh.
const MCP_PRESETS: Array<{ name: string; label: string; url: string; desc: string; needsApp?: boolean }> = [
  // Slack has no dynamic client registration, so it can't be one-click: you register a Slack app
  // and provide its Client ID/Secret. `needsApp` routes it to the guided form instead of Add.
  { name: "slack", label: "Slack", url: "https://mcp.slack.com/mcp", desc: "Messages, search & canvases. Needs a Slack app you register.", needsApp: true },
  { name: "notion", label: "Notion", url: "https://mcp.notion.com/mcp", desc: "Search & edit your Notion workspace" },
  { name: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", desc: "Issues, projects & cycles" },
  { name: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp", desc: "Errors, issues & traces" },
  { name: "stripe", label: "Stripe", url: "https://mcp.stripe.com", desc: "Payments & billing data" },
];

marked.setOptions({ breaks: true, gfm: true });

export default function App() {
  const b = useBridge();
  const t = useTheme();
  const r = useResources();
  const c = useConnectors();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const [showModelAccount, setShowModelAccount] = useState(false);
  const [artWidth, setArtWidth] = useState(520);
  const [filesOpen, setFilesOpen] = useState(false); // one shared drawer state across home/folder/session
  const [openFile, setOpenFile] = useState<FileContent | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | undefined>(undefined); // anchor after a doc-link nav
  const openFileRef = useRef<FileContent | null>(null);
  openFileRef.current = openFile; // so the viewer-link listener resolves relatives against the current file
  // Connected/authorized providers = those with available models (+ the current one).
  const connectedProviders = useMemo(() => {
    const set = new Set<string>();
    if (b.currentModel?.provider) set.add(b.currentModel.provider);
    for (const m of b.models) set.add(m.provider);
    return [...set];
  }, [b.currentModel, b.models]);
  // `dropped` keeps us in the session frame after an unexpected sandbox exit (so we can
  // reconnect in place rather than bouncing to home).
  const inSession = b.connection === "connected" || b.connection === "starting" || b.dropped;
  const artifactCount = Object.keys(b.artifacts).length;
  const showArtifacts = inSession && b.artifactsOpen && (artifactCount > 0 || openFile !== null);
  const filesRoot = b.activeFolder;

  // Open a workspace file in the viewer pane. Always show the base (host-side) view
  // instantly; if a session is running and idle, also ask an extension file-renderer to
  // produce a richer view (arrives as an artifact the viewer auto-selects). Falls back to
  // the base view when no renderer matches (silent) or offline.
  const openFileAt = (p: string) => {
    window.piwork.readFile(p).then((f) => { setOpenFile(f); setPendingScroll(undefined); b.setArtifactsOpen(true); });
    if (inSession && !b.globalMode && !b.streaming && b.activeFolder && p.startsWith(b.activeFolder)) {
      const rel = p.slice(b.activeFolder.length).replace(/^\/+/, "");
      if (rel) window.piwork.send({ type: "prompt", message: `/piwork-render-file ${rel}` });
    }
  };
  // The drawer's open/closed persists across home ↔ folder ↔ session; only the previewed
  // file is context-specific, so clear it when the session context changes.
  useEffect(() => { setOpenFile(null); }, [inSession]);

  // Links clicked inside the viewer iframe post their href up here (the iframe is sandboxed and
  // can't navigate itself). External URLs open in the browser; a relative doc link (optionally
  // with a #fragment) resolves against the open file's folder and loads into the viewer.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __piworkViewerLink?: boolean; href?: string } | null;
      if (!d || !d.__piworkViewerLink || typeof d.href !== "string") return;
      if (isExternalHref(d.href)) { if (/^https?:\/\//i.test(d.href)) window.piwork.openExternal(d.href); return; }
      const cur = openFileRef.current;
      const [rel, hash] = splitHash(d.href);
      if (!cur?.path || !rel) return; // pure #anchors are handled inside the iframe
      window.piwork.readFile(resolveFrom(cur.path, rel)).then((f) => {
        if (f?.ok) { setOpenFile(f); setPendingScroll(hash || undefined); b.setArtifactsOpen(true); }
      });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The agent presented a workspace file via show_artifact → open it in the viewer, host-side.
  useEffect(() => {
    const req = b.fileOpenRequest;
    if (!req || !b.activeFolder) return;
    openFileAt(`${b.activeFolder.replace(/\/+$/, "")}/${req.rel.replace(/^\/+/, "")}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.fileOpenRequest?.nonce]);

  // Prevent a file dropped ANYWHERE outside the composer from navigating the window to it
  // (Chromium's default). The composer's own onDrop still handles attachments in its region.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => { window.removeEventListener("dragover", prevent); window.removeEventListener("drop", prevent); };
  }, []);

  // Auto-reconnect: if the sandbox dropped while we were away (Mac slept, docker connection
  // lost), resume the session the moment the window regains focus — so tabbing back "just
  // works". The reconnect banner is the manual fallback.
  useEffect(() => {
    const onFocus = () => { if (b.dropped) void b.reconnect(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [b.dropped, b.reconnect]);

  // Settings zone: shared by home & session. Model/account, Theme, and Debug all live on the rail.
  const settingsRail: RailItem[] = [
    { key: "model", iconUrl: modelsIcon, label: "Model", onClick: () => setShowModelAccount(true), title: "Model & account" },
    { key: "theme", iconUrl: themeIcon, label: "Theme", onClick: () => setShowTheme(true) },
    { key: "debug", iconUrl: debugIcon, label: "Debug", onClick: () => setShowDebug((v) => !v), title: "Debug drawer" },
  ];
  // Tools zone (in-session): the panels/viewers for the running sandbox. Scope for Skills /
  // Connect is chosen inside the modal, so one entry each does both global & project.
  const sessionTools: RailItem[] = [
    // Files: only a real workspace has files (the folderless global chat has none).
    ...(b.globalMode || !filesRoot ? [] : [{ key: "files", iconUrl: fileIcon, label: "Files", title: "Browse workspace files", active: filesOpen, onClick: () => setFilesOpen((v) => !v) } as RailItem]),
    { key: "skills", iconUrl: extensionsIcon, label: "Customise", title: "Customise the agent", onClick: () => (b.globalMode ? r.openFor("global") : b.activeFolder && r.openFor("project", b.activeFolder)) },
    { key: "connect", iconUrl: connectorsIcon, label: "Connect", title: "Manage MCP connectors (Slack, Notion, …)", onClick: () => (b.globalMode ? c.openFor("global") : b.activeFolder && c.openFor("project", b.activeFolder)) },
    { key: "rewind", iconUrl: rewindIcon, label: "Rewind", disabled: b.streaming, active: b.treeOpen, title: b.streaming ? "Rewind is available when the agent is idle" : "Jump back to an earlier point", onClick: b.openSessionTree },
  ];
  const homeTools: RailItem[] = [
    { key: "files", iconUrl: fileIcon, label: "Files", title: "Browse folders", active: filesOpen, onClick: () => setFilesOpen((v) => !v) },
    { key: "skills", iconUrl: extensionsIcon, label: "Customise", title: "Customise the agent", onClick: () => r.openFor("global") },
    { key: "connect", iconUrl: connectorsIcon, label: "Connect", title: "MCP connectors (Slack, Notion, …)", onClick: () => c.openFor("global") },
  ];
  return (
    <div className="app">
      {inSession ? (
        <div className="app-row">
        <ActivityRail tools={sessionTools} settings={settingsRail} />
        {filesOpen && filesRoot && (
          <FilesPanel initialDir={filesRoot} floor={filesRoot} openPath={openFile?.path ?? null} onOpenFile={openFileAt} refreshKey={b.turnTick} onClose={() => setFilesOpen(false)} />
        )}
        <div className="app-col">
          <TopBar
            onHome={b.endToHome}
            folderName={b.globalMode ? "Global chat" : b.activeFolder ? basename(b.activeFolder) : "Session"}
            folderPath={b.globalMode ? undefined : b.activeFolder ?? undefined}
            connection={b.connection}
            onBack={b.globalMode ? b.endToGlobalSessions : b.endToSessions}
          />
          {b.dropped && b.connection !== "connected" && b.connection !== "starting" && (
            <div className="reconnect-banner">
              <span>⚠ The sandbox stopped while the app was inactive - your conversation is saved.</span>
              <button className="primary" onClick={() => void b.reconnect()}>⟳ Reconnect</button>
            </div>
          )}
          <StatusBar statuses={b.statuses} streaming={b.streaming} activity={b.activity} onAbort={b.abort} />
          <Widgets lines={b.widgets.above} placement="above" />
          <Chat
            items={b.items}
            connection={b.connection}
            globalMode={b.globalMode}
            streamingLabel={b.streaming ? activityLabel(b.activity) : undefined}
            startError={b.startError}
            onRetry={() => (b.globalMode ? b.startGlobal() : b.activeFolder ? b.startWith(b.activeFolder) : undefined)}
          />
          <Widgets lines={b.widgets.below} placement="below" />
          <Composer taRef={composerRef} streaming={b.streaming} disabled={b.connection !== "connected"} onSubmit={b.submit} commands={b.commands} injected={b.injectedText} canAttach={!b.globalMode && !!b.activeFolder} />
        </div>
        {showArtifacts && (
          <ArtifactsPane
            artifacts={b.artifacts}
            lastKey={b.lastArtifactKey}
            openFile={openFile}
            scrollTo={pendingScroll}
            width={artWidth}
            onWidth={setArtWidth}
            onClose={() => b.setArtifactsOpen(false)}
          />
        )}
        </div>
      ) : (
        <div className="app-row">
          {/* Home has no session, so Model (list needs a session; OAuth login needs a workspace)
              is dropped here — it lives in-session. Theme/Debug stay. */}
          <ActivityRail tools={homeTools} settings={settingsRail.filter((s) => s.key !== "model")} />
          {filesOpen && (
            <FilesPanel
              initialDir={b.launcherFolder ?? ""}
              openPath={openFile?.path ?? null}
              onOpenFile={(p) => window.piwork.readFile(p).then((f) => { setOpenFile(f); setPendingScroll(undefined); })}
              onOpenFolder={(folder) => b.selectFolder(folder)}
              onClose={() => setFilesOpen(false)}
            />
          )}
          <div className="app-col">
            {/* Same TopBar frame: on the folder screen Home is leftmost (→ back to home);
                on the true home screen the slot is the Piwork brand (you're already home). */}
            <TopBar
              onHome={b.launcherFolder || b.launcherGlobal ? b.backToFolders : undefined}
              folderName={b.launcherFolder ? basename(b.launcherFolder) : b.launcherGlobal ? "Global chat" : undefined}
              folderPath={b.launcherFolder ?? undefined}
            />
            <Launcher
              recentFolders={b.recentFolders}
              folder={b.launcherFolder}
              global={b.launcherGlobal}
              sessions={b.launcherSessions}
              onPick={b.pickFolder}
              onSelectFolder={b.selectFolder}
              onStart={b.startWith}
              onSelectGlobal={b.selectGlobal}
              onStartGlobal={(s) => b.startGlobal(s)}
            />
          </div>
          {openFile && (
            <ArtifactsPane
              artifacts={{}}
              lastKey={null}
              openFile={openFile}
              scrollTo={pendingScroll}
              width={artWidth}
              onWidth={setArtWidth}
              onClose={() => setOpenFile(null)}
            />
          )}
        </div>
      )}
      <Toasts toasts={b.toasts} />
      {showTheme && <ThemeModal t={t} onClose={() => setShowTheme(false)} />}
      {showModelAccount && (
        <ModelAccountModal
          models={b.models}
          currentModel={b.currentModel}
          onPickModel={b.setModel}
          thinkingLevel={b.thinkingLevel}
          onThinking={b.setThinkingLevel}
          connected={connectedProviders}
          hello={b.hello}
          onConnect={() => { setShowModelAccount(false); b.startLogin(); }}
          onClose={() => setShowModelAccount(false)}
        />
      )}
      {r.open && <ResourcesModal r={r} inSession={inSession} projectFolder={(inSession ? b.activeFolder : b.launcherFolder) ?? undefined} systemPrompt={b.systemPrompt} onFetchSystemPrompt={b.fetchSystemPrompt} onClose={r.close} />}
      {c.open && <ConnectorsModal c={c} inSession={inSession} projectFolder={(inSession ? b.activeFolder : b.launcherFolder) ?? undefined} status={b.mcpStatus} onClose={c.close} />}
      {b.dialog && <DialogModal dialog={b.dialog} onRespond={b.respondDialog} />}
      {inSession && b.treeOpen && b.sessionTree && (
        <SessionTreePanel data={b.sessionTree} rewinding={b.rewinding} busy={b.streaming} onRewind={b.rewindTo} onClose={() => b.setTreeOpen(false)} />
      )}
      {showDebug && <DebugDrawer debugLog={b.debugLog} stderrLog={b.stderrLog} onClose={() => setShowDebug(false)} />}
      {b.login.active && (
        <LoginModal login={b.login} onChoose={b.chooseProvider} onSubmit={b.submitLoginInput} onClose={b.closeLogin} />
      )}
    </div>
  );
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
function relTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Launcher(props: {
  recentFolders: string[];
  folder: string | null;
  global?: boolean;
  sessions: SessionMeta[] | null;
  onPick: () => void;
  onSelectFolder: (folder: string) => void;
  onStart: (folder: string, session?: string) => void;
  onSelectGlobal: () => void;
  onStartGlobal: (session?: string) => void;
}) {
  // Global-chat launcher: past global chats + New chat (mirrors a folder's history view).
  if (props.global) {
    return (
      <div className="launcher">
        <div className="launcher-body">
          <div className="folder-actions">
            <button className="primary" onClick={() => props.onStartGlobal("new")}>＋ New chat</button>
          </div>
          <p className="muted">A general agent chat with no file access.</p>
          <h3>History</h3>
          {props.sessions === null ? (
            <Loading label="Loading chats…" />
          ) : props.sessions.length === 0 ? (
            <p className="muted">No past global chats yet.</p>
          ) : (
            <div className="session-list">
              {props.sessions.map((s) => (
                <button key={s.path} className="session-row" onClick={() => props.onStartGlobal(s.path)}>
                  <span className="session-first">{s.name || s.firstMessage || "(empty chat)"}</span>
                  <span className="session-meta">{s.messageCount} msg · {relTime(s.modified)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="launcher">
      {!props.folder ? (
        <div className="launcher-body">
          <h2>Work locally, stay in control</h2>
          <p className="muted">Pick a folder for the agent to work in, or start a global chat with no file access.</p>
          {props.recentFolders.length > 0 && (
            // One-click back into where you were — the sandbox closes on sleep and drops you
            // here, and this saves the folder→session hop to get back to the last session.
            <button className="resume-cta" onClick={() => props.onStart(props.recentFolders[0], "recent")} title={props.recentFolders[0]}>
              <span className="resume-main">↩ Resume previous session</span>
              <span className="resume-sub">{basename(props.recentFolders[0])}</span>
            </button>
          )}
          <div className="folder-actions">
            <button className="primary" onClick={props.onPick}>Open a folder to work in…</button>
            <button className="cta-alt" onClick={props.onSelectGlobal}>New chat</button>
          </div>
          {props.recentFolders.length > 0 && (
            <>
              <h3>Recent folders</h3>
              <div className="folder-list">
                {props.recentFolders.map((f) => (
                  <button key={f} className="folder-row" onClick={() => props.onSelectFolder(f)}>
                    <span className="folder-name">{basename(f)}</span>
                    <span className="folder-path">{f}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="launcher-body">
          <div className="folder-actions">
            <button className="primary" onClick={() => props.onStart(props.folder!, "new")}>＋ New session</button>
          </div>
          <p className="muted">The agent is sandboxed to this folder.</p>
          <h3>History</h3>
          {props.sessions === null ? (
            <Loading label="Loading sessions…" />
          ) : props.sessions.length === 0 ? (
            <p className="muted">No past sessions in this folder yet.</p>
          ) : (
            <div className="session-list">
              {props.sessions.map((s) => (
                <button key={s.path} className="session-row" onClick={() => props.onStart(props.folder!, s.path)}>
                  <span className="session-first">{s.name || s.firstMessage || "(empty session)"}</span>
                  <span className="session-meta">{s.messageCount} msg · {relTime(s.modified)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LoginModal(props: {
  login: LoginState;
  onChoose: (id: string) => void;
  onSubmit: (id: string, value: string) => void;
  onClose: () => void;
}) {
  const l = props.login;
  const [text, setText] = useState("");
  return (
    <ModalShell title="Sign in" onClose={props.onClose}>
        {l.error ? (
          <>
            <div className="modal-message" style={{ color: "var(--error)" }}>{l.error}</div>
            <div className="modal-actions"><button onClick={props.onClose}>Close</button></div>
          </>
        ) : l.needProvider && l.providers ? (
          <>
            <div className="modal-message">Choose a provider to sign in with:</div>
            <div className="options">
              {l.providers.map((p) => (
                <button key={p.id} onClick={() => props.onChoose(p.id)}>{p.name}</button>
              ))}
            </div>
          </>
        ) : l.prompt ? (
          <>
            <div className="modal-message">{l.prompt.message}</div>
            {l.prompt.kind === "select" ? (
              <div className="options">
                {(l.prompt.options ?? []).map((o) => (
                  <button key={o.id} onClick={() => props.onSubmit(l.prompt!.id, o.id)}>{o.label}</button>
                ))}
              </div>
            ) : (
              <>
                <input
                  autoFocus
                  placeholder={l.prompt.placeholder}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { props.onSubmit(l.prompt!.id, text); setText(""); }
                  }}
                />
                <div className="modal-actions">
                  <button onClick={() => { props.onSubmit(l.prompt!.id, text); setText(""); }}>Submit</button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="modal-message">{l.status ?? "Working…"}</div>
            <div className="modal-actions"><button className="secondary" onClick={props.onClose}>Cancel</button></div>
          </>
        )}
    </ModalShell>
  );
}

// Wrap artifact content in a locked-down document: an inner CSP that permits inline
// style/script + data: images, but blocks ALL network/framing (no exfiltration). Combined
// with the iframe's sandbox="allow-scripts" (opaque origin, no same-origin access), this is
// the design's CSP-locked, no-Node escape hatch.
const VIEWER_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'";
// The viewer iframe is locked down (opaque origin + `default-src 'none'`), so a plain <a> click
// would navigate it to a blocked URL and blank the pane. This tiny script intercepts clicks:
// in-page #anchors scroll locally; everything else is handed to the shell via postMessage (the
// CSP doesn't block postMessage — it's not a network fetch), which opens external URLs in the
// browser and relative doc links back into this viewer.
const VIEWER_LINK_SCRIPT = `(function(){
  function scrollToId(id){ var el=document.getElementById(id)||document.getElementsByName(id)[0]; if(el){el.scrollIntoView({block:"start"});} return !!el; }
  document.addEventListener("click",function(e){
    var a=e.target&&e.target.closest?e.target.closest("a[href]"):null; if(!a) return;
    var href=a.getAttribute("href"); if(!href) return;
    e.preventDefault();
    if(href.charAt(0)==="#"){ scrollToId(decodeURIComponent(href.slice(1))); return; }
    parent.postMessage({__piworkViewerLink:true,href:href},"*");
  });
  window.addEventListener("load",function(){ if(window.__viewerScrollTo) scrollToId(window.__viewerScrollTo); });
})();`;
function artifactSrcDoc(body: string, scrollTo?: string): string {
  const scroll = scrollTo ? `<script>window.__viewerScrollTo=${JSON.stringify(scrollTo)}</script>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}"><style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#16181d;background:#fff;margin:14px}pre{background:#f0f1f4;padding:10px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-word}img{max-width:100%}</style></head><body>${body}${scroll}<script>${VIEWER_LINK_SCRIPT}</script></body></html>`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
// A full HTML file: keep its own <head>/styles but inject our CSP so it can't reach the network.
function htmlDocWithCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + meta);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}
// Normalise a viewer document (file or artifact) into an iframe srcDoc + title. `scrollTo` is an
// anchor id to jump to once loaded (set when arriving via a doc link like `other.md#section`).
function fileSrcDoc(f: FileContent, scrollTo?: string): string {
  if (f.kind === "image") return artifactSrcDoc(`<img src="${f.content}" alt="${escapeHtml(f.name)}">`);
  if (f.kind === "html") return htmlDocWithCsp(f.content);
  if (f.kind === "markdown") return artifactSrcDoc(mdToHtml(f.content), scrollTo);
  if (f.kind === "binary") return artifactSrcDoc(`<p style="color:#8b909a">Can't preview this file type (binary).</p>`);
  const note = f.truncated ? `<p style="color:#8b909a">Showing the first part of a large file.</p>` : "";
  return artifactSrcDoc(`${note}<pre>${escapeHtml(f.content)}</pre>`);
}

// Render viewer markdown with GitHub-style heading ids, so in-doc `#anchor` links have a target
// to scroll to. (marked doesn't emit heading ids; we post-process rather than depend on a plugin.)
function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");
}
function decodeBasicEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'");
}
function mdToHtml(md: string): string {
  const html = marked.parse(md) as string;
  const seen = new Map<string, number>();
  return html.replace(/<(h[1-6])>([\s\S]*?)<\/\1>/g, (m, tag: string, inner: string) => {
    const base = headingSlug(decodeBasicEntities(inner.replace(/<[^>]*>/g, "")));
    if (!base) return m;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `<${tag} id="${n === 0 ? base : `${base}-${n}`}">${inner}</${tag}>`;
  });
}
// Split a link href into its path and (decoded) fragment. Resolve a relative link against the
// directory of the currently-open file (host paths). External links keep a scheme or start `//`.
function splitHash(href: string): [string, string] {
  const i = href.indexOf("#");
  return i >= 0 ? [href.slice(0, i), decodeURIComponent(href.slice(i + 1))] : [href, ""];
}
function isExternalHref(href: string): boolean {
  return /^[a-z][\w+.-]*:/i.test(href) || href.startsWith("//");
}
function resolveFrom(baseFile: string, rel: string): string {
  const parts = baseFile.replace(/\/[^/]*$/, "").split("/");
  for (const seg of decodeURIComponent(rel).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (parts.length > 1) parts.pop(); }
    else parts.push(seg);
  }
  return parts.join("/") || "/";
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Host-side file browser (main-process reads — no agent). Two modes from one component:
//  • in-session: floored at the workspace root (can't climb above it); click a file to view.
//  • home: no floor (browse anywhere), plus an "Open this folder" action to start a sandbox
//    there. Clicking a file still previews it. `initialDir` "" resolves to the user's home.
function FilesPanel(props: {
  initialDir: string;
  floor?: string; // don't navigate above this path (in-session = workspace root)
  onOpenFile: (path: string) => void;
  openPath: string | null;
  onOpenFolder?: (dir: string) => void; // home mode: open the current folder as a sandbox
  refreshKey?: number; // bumps when the agent finishes a turn → re-read the current folder
  onClose: () => void;
}) {
  const [dir, setDir] = useState(props.initialDir);
  const [listing, setListing] = useState<{ entries: DirEntry[]; error?: string } | null>(null);
  const lastDir = useRef(dir);
  useEffect(() => { setDir(props.initialDir); }, [props.initialDir]);
  useEffect(() => {
    let live = true;
    // Blank (show loading) only when the folder actually changed — not on a background
    // auto-refresh (refreshKey bump after a turn), so it re-reads in place without flicker.
    if (lastDir.current !== dir) { setListing(null); lastDir.current = dir; }
    window.piwork.listDir(dir || undefined).then((l) => {
      if (!live) return;
      setListing({ entries: l.entries, error: l.error });
      if (!dir && l.path) setDir(l.path); // adopt the resolved home path
    });
    return () => { live = false; };
  }, [dir, props.refreshKey]);

  // Breadcrumb from absolute segments, floored (in-session can't go above the workspace).
  const absParts = dir.split("/").filter(Boolean);
  const floorLen = props.floor ? props.floor.split("/").filter(Boolean).length : 0;
  const rootLabel = props.floor ? basename(props.floor) : "/";
  const rootDir = props.floor ?? "/";
  const tail = absParts.slice(floorLen);
  const canUp = absParts.length > floorLen;
  const goUp = () => { if (canUp) setDir("/" + absParts.slice(0, -1).join("/")); };
  return (
    <div className="files-panel">
      <header>
        <strong>Files</strong>
        <div className="spacer" />
        <button onClick={props.onClose} title="Close panel">✕</button>
      </header>
      {props.onOpenFolder && dir && (
        <button className="primary open-folder" onClick={() => props.onOpenFolder!(dir)} title={`Start an agent sandbox in ${dir}`}>
          <span className="of-main">▶ Work in this folder</span>
          <span className="of-sub">Start an agent sandbox rooted here</span>
        </button>
      )}
      {dir && (
        <div className="files-crumb">
          <button className="crumb-up" disabled={!canUp} onClick={goUp} title="Up one level">↑</button>
          <button className="link" disabled={dir === rootDir} onClick={() => setDir(rootDir)}>{rootLabel}</button>
          {tail.map((s, i) => (
            <span key={i}>
              <span className="crumb-sep">/</span>
              <button className="link" onClick={() => setDir("/" + absParts.slice(0, floorLen + i + 1).join("/"))}>{s}</button>
            </span>
          ))}
        </div>
      )}
      <div className="files-list">
        {listing === null ? (
          <Loading label="Loading…" />
        ) : listing.error ? (
          <p className="muted" style={{ padding: 12 }}>{listing.error}</p>
        ) : listing.entries.length === 0 ? (
          <p className="muted" style={{ padding: 12 }}>Empty folder.</p>
        ) : (
          listing.entries.map((e) => (
            <button
              key={e.path}
              className={`file-row${e.path === props.openPath ? " active" : ""}`}
              onClick={() => (e.isDir ? setDir(e.path) : props.onOpenFile(e.path))}
              title={e.path}
            >
              <span className="file-ico">{e.isDir ? "📁" : "📄"}</span>
              <span className="file-name">{e.name}</span>
              {!e.isDir && <span className="file-size">{humanSize(e.size)}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// A rewind point: a human message, or an end-of-turn agent message with text. Intermediate
// tool-call entries (empty assistant) and non-message entries aren't rewind targets.
function isRewindNode(n: TreeNode): boolean {
  return n.type === "message" && (n.role === "user" || (n.role === "assistant" && n.preview.trim() !== ""));
}
// The rewindable messages reachable from a set of nodes, descending THROUGH non-message
// wrappers so tool-call entries don't count as structure. This is the set of "next messages".
function nextMessages(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (isRewindNode(n)) out.push(n);
    else out.push(...nextMessages(n.children));
  }
  return out;
}

// Visual session tree. Indentation reflects BRANCHES, not message count: a linear
// conversation stays flat (a plain list), and depth only increases where the conversation
// actually forked (a message with more than one continuation, created by rewinding). Without
// this a long linear chat became an unreadable ever-deepening staircase.
function SessionTreeRows(props: { nodes: TreeNode[]; leaf: string | null; depth: number; disabled: boolean; onRewind: (id: string, prefill?: string) => void }): React.ReactElement {
  const msgs = nextMessages(props.nodes);
  return (
    <>
      {msgs.map((n) => {
        const current = n.id === props.leaf;
        const kids = nextMessages(n.children);
        // Indent the continuation only at a real fork (>1 next message); linear stays flat.
        const childDepth = kids.length > 1 ? props.depth + 1 : props.depth;
        return (
          <div key={n.id}>
            <button
              className={`tree-node ${current ? "current" : ""} ${props.depth > 0 ? "branched" : ""}`}
              style={{ paddingLeft: 8 + props.depth * 16 }}
              disabled={props.disabled || current}
              title={current ? "Current position" : n.role === "user" ? "Rewind to before this message (editable)" : "Rewind to just after this reply"}
              onClick={() => props.onRewind(n.id, n.role === "user" ? (n.text ?? n.preview) : undefined)}
            >
              <span className="tree-role">{n.role === "user" ? "You" : "Pi"}</span>
              <span className="tree-preview">{n.preview || "(empty)"}</span>
              {current && <span className="tree-here">● here</span>}
            </button>
            {kids.length > 0 && (
              <SessionTreeRows nodes={n.children} leaf={props.leaf} depth={childDepth} disabled={props.disabled} onRewind={props.onRewind} />
            )}
          </div>
        );
      })}
    </>
  );
}

function SessionTreePanel(props: { data: { tree: TreeNode[]; leaf: string | null }; rewinding: boolean; busy: boolean; onRewind: (id: string, prefill?: string) => void; onClose: () => void }) {
  const disabled = props.rewinding || props.busy;
  return (
    <div className="artifacts-drawer tree-drawer">
      <header>
        <strong>Rewind</strong>
        {props.rewinding && <span className="rewind-status"><span className="spinner" /> rewinding…</span>}
        <div className="spacer" />
        <button onClick={props.onClose}>Close</button>
      </header>
      <div className="tree-hint">
        {props.busy
          ? "Rewind is available when the agent is idle."
          : "Jump back to any point - edit one of your messages, or continue after a reply."}
      </div>
      <div className="tree-body-wrap">
        <div className={`tree-body ${disabled ? "busy" : ""}`}>
          {props.data.tree.length === 0 ? (
            <div className="muted" style={{ padding: 12 }}>No history yet.</div>
          ) : (
            <SessionTreeRows nodes={props.data.tree} leaf={props.data.leaf} depth={0} disabled={disabled} onRewind={props.onRewind} />
          )}
        </div>
        {props.rewinding && (
          <div className="tree-overlay"><span className="spinner" /> Rewinding…</div>
        )}
      </div>
    </div>
  );
}

// A resizable right-hand viewer pane (split, not overlay) that shows ONE document full-height:
// either an opened host file or an agent-pushed artifact. One surface, two sources; a selector
// switches between them.
function ArtifactsPane(props: {
  artifacts: Record<string, { title?: string; html?: string; markdown?: string }>;
  lastKey: string | null;
  openFile: FileContent | null;
  scrollTo?: string; // anchor to jump to after a doc-link navigation (`other.md#section`)
  width: number;
  onWidth: (w: number) => void;
  onClose: () => void;
}) {
  const artKeys = Object.keys(props.artifacts);
  // The open file (if any) first, then artifacts.
  const entries = [
    ...(props.openFile ? [{ id: "file", label: `📄 ${props.openFile.name}` }] : []),
    ...artKeys.map((k) => ({ id: `art:${k}`, label: props.artifacts[k].title ?? k })),
  ];
  const [sel, setSel] = useState<string>("");
  // Follow whichever source most recently produced content.
  useEffect(() => { if (props.openFile) setSel("file"); }, [props.openFile?.path]);
  useEffect(() => { if (props.lastKey) setSel(`art:${props.lastKey}`); }, [props.lastKey]);
  const active = entries.find((e) => e.id === sel)?.id ?? entries[entries.length - 1]?.id ?? "";

  let title = "Viewer";
  let srcDoc: string | null = null;
  if (active === "file" && props.openFile) {
    title = props.openFile.name;
    srcDoc = fileSrcDoc(props.openFile, props.scrollTo);
  } else if (active.startsWith("art:")) {
    const a = props.artifacts[active.slice(4)];
    if (a) { title = a.title ?? "Artifact"; srcDoc = artifactSrcDoc(a.html ?? (a.markdown ? mdToHtml(a.markdown) : "")); }
  }

  // While dragging, the iframe below must not swallow the mouse: otherwise moving the cursor
  // over it starves the window's mousemove/mouseup (a separate browsing context eats them), so
  // the drag never ends ("keeps moving after release") and gets stuck moving toward the iframe.
  // `dragging` flips the iframe to pointer-events:none so events pass through to the parent.
  const [dragging, setDragging] = useState(false);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const onMove = (ev: MouseEvent) => props.onWidth(Math.max(320, Math.min(window.innerWidth - 240, window.innerWidth - ev.clientX)));
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className={`artifacts-pane ${dragging ? "resizing" : ""}`} style={{ width: props.width }}>
      <div className="art-resizer" onMouseDown={startResize} title="Drag to resize" />
      <header>
        {entries.length > 1 ? (
          <select value={active} onChange={(e) => setSel(e.target.value)} className="art-select">
            {entries.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        ) : (
          <strong className="art-title">{title}</strong>
        )}
        {active === "file" && (
          <span className="ro-chip" title="Read-only. Start a session to make changes.">read-only</span>
        )}
        <div className="spacer" />
        <button onClick={props.onClose} title="Close panel">✕</button>
      </header>
      {srcDoc !== null ? (
        <iframe className="art-frame" title={title} sandbox="allow-scripts" srcDoc={srcDoc} />
      ) : (
        <div className="muted" style={{ padding: 16 }}>Nothing to show yet. Open a file to view it here.</div>
      )}
    </div>
  );
}

function DebugDrawer(props: { debugLog: string[]; stderrLog: string[]; onClose: () => void }) {
  const text = [
    "── bridge stream (renderer view) ──",
    ...props.debugLog,
    "",
    "── container stderr ──",
    ...props.stderrLog,
  ].join("\n");
  return (
    <div className="debug-drawer">
      <header>
        <strong>Debug</strong>
        <div className="spacer" />
        <button onClick={props.onClose}>Close</button>
      </header>
      <div className="path">Full log file: ~/.piwork/logs/piwork.log</div>
      <pre>{text}</pre>
    </div>
  );
}

// Left activity rail: an icon column with captions and active-state highlighting. Item-driven,
// so the home screen and an in-session view each compose their own set; also the dock for the
// Files panel and extension setWidget panels.
type RailItem = { key: string; iconUrl?: string; iconNode?: React.ReactNode; label: string; onClick: () => void; active?: boolean; disabled?: boolean; title?: string; badge?: number };
// Three visually-zoned groups top→bottom —
//   1. Tools (files/skills/connect/docs/rewind),
//   2. a divider, then Settings (model/account, theme, debug),
//   3. a flexible spacer, then a pinned Home/exit anchor (in-session only).
function ActivityRail(props: { tools: RailItem[]; settings: RailItem[]; anchor?: RailItem }) {
  const render = (it: RailItem) => (
    <button
      key={it.key}
      className={`rail-btn${it.active ? " active" : ""}`}
      onClick={it.onClick}
      disabled={it.disabled}
      title={it.title}
    >
      <span className="rail-ico">{it.iconUrl ? <img className="rail-img" src={it.iconUrl} alt="" /> : it.iconNode}</span>{it.label}
      {it.badge != null && it.badge > 0 && <span className="rail-badge">{it.badge}</span>}
    </button>
  );
  return (
    <div className="activity-rail">
      {props.tools.map(render)}
      <div className="rail-divider" />
      {props.settings.map(render)}
      <div className="rail-spacer" />
      {props.anchor && render(props.anchor)}
    </div>
  );
}

// One top bar for every screen — a stable status frame, not a control surface (every control
// lives on the rail): a small context label + a colored connection dot. Order (left → right):
//   Home  ·  <folder/context>  ·  live dot  ·  End session
// Home is pinned LEFTMOST so it never moves between the folder screen and a session; on the
// true home screen the slot is the "Piwork" brand instead (you're already home). The ◀ back
// sits to the RIGHT of the folder name, so the arrow points back at where it takes you (that
// folder's sessions) — and it's labelled to make clear leaving stops the sandbox. The dot +
// ◀ appear only in-session (a sandbox is running). Model/account lives on the rail.
function TopBar(props: {
  onHome?: () => void;   // present → "Home" (leftmost); absent → "Piwork" brand (home screen)
  folderName?: string;   // context label (a folder, or "Global chat")
  folderPath?: string;   // tooltip on the folder name
  connection?: string;   // present → live dot (in-session)
  onBack?: () => void;   // present → "◀ End session" (a folder-based session)
}) {
  const dotTitle =
    props.connection === "connected" ? "Sandbox running"
    : props.connection === "starting" ? "Starting sandbox…"
    : "Sandbox stopped";
  const homeTitle = props.connection ? "End the sandbox and return to the home screen" : "Back to the home screen";
  return (
    <div className="topbar">
      <div className="ctx">
        {props.onHome ? (
          <button className="ctx-home" onClick={props.onHome} title={homeTitle}>Home</button>
        ) : (
          <span className="brand">Piwork</span>
        )}
        {props.folderName && <span className="ctx-label" title={props.folderPath}>{props.folderName}</span>}
        {props.connection && <span className={`conn-dot conn-dot-${props.connection}`} title={dotTitle} />}
        {props.onBack && (
          <button className="ctx-back" onClick={props.onBack} title="End this session and go back to its list">◀ End session</button>
        )}
      </div>
      <div className="spacer" />
    </div>
  );
}

// One shared modal frame: a click-to-close backdrop, a header with the title on the LEFT
// and a Done button TOP-RIGHT (consistent everywhere), an optional header-extra slot
// (e.g. "Reload to apply"), a scrolling body, and an optional footer/actions row.
function ModalShell(props: {
  title: string;
  subtitle?: string;
  className?: string;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className={`modal ${props.className ?? ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-topbar">
          <div>
            <div className="modal-title">{props.title}</div>
            {props.subtitle && <div className="muted">{props.subtitle}</div>}
          </div>
          <div className="spacer" />
          {props.headerExtra}
          <button onClick={props.onClose}>Done</button>
        </div>
        <div className="modal-scroll">{props.children}</div>
        {props.footer && <div className="modal-actions">{props.footer}</div>}
      </div>
    </div>
  );
}

// A Global / Project segmented switch used inside the Skills & Connect modals, so scope is
// chosen in one place. Project is disabled when there's no project context.
function ScopeSwitch(props: { scope: "global" | "project"; projectFolder?: string; onGlobal: () => void; onProject: (folder: string) => void }) {
  return (
    <div className="scope-switch">
      <button className={props.scope === "global" ? "active" : ""} onClick={props.onGlobal}>Global</button>
      <button
        className={props.scope === "project" ? "active" : ""}
        disabled={!props.projectFolder}
        title={props.projectFolder ? basename(props.projectFolder) : "No project context - open a folder first"}
        onClick={() => props.projectFolder && props.onProject(props.projectFolder)}
      >
        Project{props.projectFolder ? ` · ${basename(props.projectFolder)}` : ""}
      </button>
    </div>
  );
}

// Human-readable label for the current agent phase. Tool names are trimmed to their last
// segment (MCP tools look like "mcp__notion__create_page") and de-underscored so they read.
function activityLabel(activity: Activity | null): string {
  if (!activity) return "Working…";
  switch (activity.phase) {
    case "thinking": return "Thinking…";
    case "responding": return "Responding…";
    case "toolcall": return "Writing tool call…";
    case "tool": {
      const t = activity.label ? activity.label.split("__").pop()!.replace(/_/g, " ") : "";
      return t ? `Running ${t}…` : "Running a tool…";
    }
    default: return "Working…";
  }
}

// Rough human size for streamed tool-call arguments (delta chars ≈ bytes for JSON).
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Ticks once a second so an elapsed-in-phase timer stays live (independent of events — a
// climbing number with no output is the "might be stuck" cue).
function Elapsed({ since }: { since: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [since]);
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return <span className="elapsed">{m}:{String(s).padStart(2, "0")}</span>;
}

function StatusBar(props: { statuses: Record<string, string>; streaming: boolean; activity: Activity | null; onAbort: () => void }) {
  const chips = Object.entries(props.statuses);
  if (chips.length === 0 && !props.streaming) return null;
  return (
    <div className="statusbar">
      {props.streaming && (
        <span className="chip chip-live">
          <span className="dot" /> {activityLabel(props.activity)}
          {props.activity?.phase === "toolcall" && props.activity.bytes ? (
            <span className="elapsed">{formatSize(props.activity.bytes)} ·</span>
          ) : null}
          {props.activity && <Elapsed since={props.activity.since} />}
          <button className="link" onClick={props.onAbort}>abort</button>
        </span>
      )}
      {chips.map(([k, v]) => (
        <span key={k} className="chip">{v}</span>
      ))}
    </div>
  );
}

function Widgets(props: { lines: Record<string, string[]>; placement: string }) {
  const entries = Object.entries(props.lines);
  if (entries.length === 0) return null;
  return (
    <div className={`widgets widgets-${props.placement}`}>
      {entries.map(([k, lines]) => (
        <div key={k} className="widget">
          <div className="widget-key">{k}</div>
          <pre>{lines.join("\n")}</pre>
        </div>
      ))}
    </div>
  );
}

function Chat(props: { items: ChatItem[]; connection: string; globalMode: boolean; streamingLabel?: string; startError?: string | null; onRetry?: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const isNearBottom = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  // Stick to the bottom on new content ONLY if the user is already there. If they've scrolled
  // up (e.g. to read long thinking output mid-stream), leave them be — don't yank them down on
  // every token. Scrolling back to the bottom re-arms the stick (via onScroll → atBottomRef).
  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ behavior: "auto" });
  }, [props.items]);
  // Keep the newest content pinned above the composer when the panel resizes (e.g. the
  // composer is dragged taller) — but only if the user was already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) endRef.current?.scrollIntoView({ behavior: "auto" });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => { atBottomRef.current = isNearBottom(); };

  if (props.items.length === 0) {
    return (
      <div className="chat empty" ref={scrollRef} onScroll={onScroll}>
        {props.startError ? (
          <div className="start-error">
            <h3>Can't start the sandbox</h3>
            <p>{props.startError}</p>
            {props.onRetry && <button className="primary" onClick={props.onRetry}>Try again</button>}
          </div>
        ) : props.connection === "starting" ? (
          <div className="hint">Starting sandbox…</div>
        ) : props.globalMode ? (
          <div className="empty-global">
            <h3>Global chat</h3>
            <p className="hint">A general agent chat with no file access. It can still use your connectors and skills.</p>
          </div>
        ) : (
          <div className="hint">Type a message to start.</div>
        )}
        <div ref={endRef} />
      </div>
    );
  }
  return (
    <div className="chat" ref={scrollRef} onScroll={onScroll}>
      {props.items.map((it) => (
        <Message key={it.id} item={it} streamingLabel={it.streaming ? props.streamingLabel : undefined} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

// Rich tool rendering (the "renderers" capability — shell-side, since Pi's TUI
// renderCall/renderResult can't serialize). Summarizes args in the header and shows a
// collapsible body (unified diff for edits, output for bash/others).
function toolSummary(_name?: string, args?: Record<string, unknown>): string {
  if (!args) return "";
  const a = args as Record<string, any>;
  if (a.command) return String(a.command).split("\n")[0].slice(0, 120);
  if (a.path) return String(a.path);
  if (a.file) return String(a.file);
  if (a.pattern) return String(a.pattern);
  if (a.query) return String(a.query);
  const firstStr = Object.values(a).find((v) => typeof v === "string");
  return firstStr ? String(firstStr).slice(0, 120) : "";
}

function ToolMessage({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  const icon = item.toolStatus === "running" ? "⏳" : item.toolStatus === "error" ? "✗" : "✓";
  const summary = toolSummary(item.toolName, item.toolArgs);
  const patch = (item.toolDetails as any)?.patch as string | undefined;
  const body = patch ?? item.toolResult ?? (item.toolArgs ? JSON.stringify(item.toolArgs, null, 2) : "");
  const hasBody = Boolean(body && body.trim());
  return (
    <div className={`msg tool tool-${item.toolStatus}`}>
      <button className="tool-head" disabled={!hasBody} onClick={() => setOpen((v) => !v)}>
        <span className="tool-badge">{icon}</span>
        <code className="tool-name">{item.toolName}</code>
        {summary && <span className="tool-summary">{summary}</span>}
        {hasBody && <span className="tool-caret">{open ? "▾" : "▸"}</span>}
      </button>
      {open && hasBody && (
        patch ? <DiffView patch={patch} /> : <pre className="tool-body">{body.slice(0, 20000)}</pre>
      )}
    </div>
  );
}

// A user-run `!command` — a terminal block, distinct from an agent tool call. Output is shown
// inline (not collapsed), since the user ran it to see it.
function BashMessage({ item }: { item: ChatItem }) {
  const command = String(item.toolArgs?.command ?? "");
  const output = item.toolResult ?? "";
  const running = item.toolStatus === "running";
  const exitCode = (item.toolDetails as any)?.exitCode as number | undefined;
  return (
    <div className={`msg bash bash-${item.toolStatus}`}>
      <div className="bash-cmd">
        <span className="bash-prompt">$</span> <code>{command}</code>
        {running && <span className="bash-running">running…</span>}
      </div>
      {!running && output.trim() && <pre className="bash-body">{output.slice(0, 20000)}</pre>}
      {!running && item.toolStatus === "error" && exitCode != null && <div className="bash-exit">exited {exitCode}</div>}
    </div>
  );
}

function DiffView({ patch }: { patch: string }) {
  return (
    <pre className="tool-body diff">
      {patch.split("\n").slice(0, 400).map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
        return <div key={i} className={`dl ${cls}`}>{line || " "}</div>;
      })}
    </pre>
  );
}

function Message({ item, streamingLabel }: { item: ChatItem; streamingLabel?: string }) {
  // Hooks must run unconditionally (before any early return).
  const bodyHtml = useMemo(() => (item.text ? (marked.parse(item.text) as string) : ""), [item.text]);
  const thinkingHtml = useMemo(() => (item.thinking ? (marked.parse(item.thinking) as string) : ""), [item.thinking]);

  if (item.role === "tool") return item.userBash ? <BashMessage item={item} /> : <ToolMessage item={item} />;

  return (
    <div className={`msg ${item.role} ${item.streaming ? "streaming" : ""}`}>
      <div className="role">{item.role}</div>
      {item.thinking ? (
        <details className="thinking" open={item.streaming && !item.text}>
          <summary>thinking</summary>
          <div className="thinking-body" dangerouslySetInnerHTML={{ __html: thinkingHtml }} />
        </details>
      ) : null}
      {item.text ? (
        <div className="body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      ) : item.streaming && !item.thinking ? (
        <div className="body muted">{streamingLabel ?? "…"}</div>
      ) : null}
    </div>
  );
}

const Composer = (function () {
  return function Composer(props: {
    taRef: React.RefObject<HTMLTextAreaElement>;
    streaming: boolean;
    disabled: boolean;
    onSubmit: (text: string, mode: "auto" | "steer" | "followUp", attachments?: string[]) => void;
    commands: Array<{ name: string; description?: string; source?: string }>;
    injected: { text: string; nonce: number } | null;
    canAttach: boolean; // false in global chat (no folder to copy into)
  }) {
    const [text, setText] = useState("");
    const [sel, setSel] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    // Pending attachments (host source paths) — copied into .attachments/ on send, not now,
    // so removing a chip or not sending leaves no orphan files.
    const [attachments, setAttachments] = useState<Array<{ name: string; path: string }>>([]);
    const [dragOver, setDragOver] = useState(false);
    // null = auto-grow with content (up to AUTO_MAX). A number = height the user dragged to
    // (sticky across sends), so long prompts stay big and editable; content scrolls within.
    const [dragHeight, setDragHeight] = useState<number | null>(null);
    const AUTO_MAX = 200;

    // Single source of truth for textarea height: honour a user-dragged height, else grow
    // to fit content up to the cap.
    useEffect(() => {
      const t = props.taRef.current;
      if (!t) return;
      if (dragHeight != null) { t.style.maxHeight = "none"; t.style.height = `${dragHeight}px`; }
      else { t.style.maxHeight = ""; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, AUTO_MAX)}px`; }
    }, [dragHeight, text, props.taRef]);

    // Host-injected text (e.g. rewinding to a human message prefills it for editing).
    useEffect(() => {
      if (!props.injected) return;
      setText(props.injected.text);
      props.taRef.current?.focus();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.injected?.nonce]);

    // Drag the top edge of the composer to resize it (drag up = taller).
    const startResize = (e: React.MouseEvent) => {
      e.preventDefault();
      const t = props.taRef.current;
      const startY = e.clientY;
      const startH = t ? t.getBoundingClientRect().height : 120;
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(38, Math.min(window.innerHeight * 0.6, startH + (startY - ev.clientY)));
        setDragHeight(next);
      };
      const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

    // Autocomplete when typing a slash command: "/" + partial name, no space yet.
    const match = /^\/(\S*)$/.exec(text);
    const suggestions = match
      ? props.commands
          .filter((cmd) => cmd.name.toLowerCase().startsWith(match[1].toLowerCase()))
          .slice(0, 50) // includes skills (/skill:…), not just the first handful; the menu scrolls
      : [];
    const open = suggestions.length > 0 && !dismissed;
    const clampedSel = Math.min(sel, Math.max(0, suggestions.length - 1));
    // Keep the arrow-selected item in view (the menu scrolls; without this you arrow off-screen).
    useEffect(() => {
      if (open) menuRef.current?.querySelector<HTMLElement>(".cmd-item.active")?.scrollIntoView({ block: "nearest" });
    }, [clampedSel, open]);

    const setTextAndResize = (v: string) => setText(v); // height handled by the effect
    const accept = (name: string) => {
      setTextAndResize(`/${name} `);
      setDismissed(true);
      setSel(0);
      props.taRef.current?.focus();
    };
    const addAttachments = (paths: string[]) => {
      const add = paths.filter((p) => p && !attachments.some((a) => a.path === p)).map((p) => ({ name: p.split("/").pop() || p, path: p }));
      if (add.length) setAttachments((prev) => [...prev, ...add]);
    };
    const pickAttach = async () => { addAttachments(await window.piwork.pickAttachFiles()); props.taRef.current?.focus(); };
    const removeAttachment = (path: string) => setAttachments((prev) => prev.filter((a) => a.path !== path));
    const onDrop = (e: React.DragEvent) => {
      e.preventDefault(); setDragOver(false);
      if (!props.canAttach) return;
      const paths = Array.from(e.dataTransfer.files).map((f) => window.piwork.getPathForFile(f)).filter(Boolean);
      addAttachments(paths);
    };

    const submit = (mode: "auto" | "steer" | "followUp") => {
      if (!text.trim() && attachments.length === 0) return;
      props.onSubmit(text, mode, attachments.length ? attachments.map((a) => a.path) : undefined);
      setText("");
      setAttachments([]);
      setDismissed(false);
      setSel(0);
      // keep a user-dragged height across sends; the effect resizes when it's auto
    };

    return (
      <div
        className={`composer${dragOver ? " drag-over" : ""}`}
        onDragOver={props.canAttach ? (e) => { e.preventDefault(); setDragOver(true); } : undefined}
        onDragLeave={() => setDragOver(false)}
        onDrop={props.canAttach ? onDrop : undefined}
      >
        <div className="composer-resizer" onMouseDown={startResize} title="Drag to resize the input" />
        {props.canAttach && attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((a) => (
              <span key={a.path} className="attach-chip" title={a.path}>
                {a.name}
                <button className="attach-x" onClick={() => removeAttachment(a.path)} title="Remove">✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-input">
          {open && (
            <div className="cmd-menu" ref={menuRef}>
              {suggestions.map((cmd, i) => (
                <button
                  key={cmd.name}
                  className={`cmd-item ${i === clampedSel ? "active" : ""}`}
                  onMouseDown={(e) => { e.preventDefault(); accept(cmd.name); }}
                >
                  <span className="cmd-name">/{cmd.name}</span>
                  {cmd.description && <span className="cmd-desc">{cmd.description}</span>}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={props.taRef}
            value={text}
            rows={1}
            disabled={props.disabled}
            placeholder={props.streaming ? "Enter = steer · Alt+Enter = follow-up · Shift+Enter = newline" : "Message Pi…  (/ commands · ! shell)"}
            onChange={(e) => { setTextAndResize(e.target.value); setDismissed(false); setSel(0); }}
            onKeyDown={(e) => {
              if (open) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % suggestions.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); accept(suggestions[clampedSel].name); return; }
                if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
              }
              if (e.key !== "Enter" || e.shiftKey) return;
              e.preventDefault();
              if (!props.streaming) submit("auto");
              else if (e.altKey) submit("followUp");
              else submit("steer");
            }}
          />
        </div>
        {props.canAttach && (
          <button className="secondary attach-btn" disabled={props.disabled} onClick={pickAttach} title="Attach a file (copied into the workspace)" aria-label="Attach a file">+</button>
        )}
        <button disabled={props.disabled || (!text.trim() && attachments.length === 0)} onClick={() => submit(props.streaming ? "steer" : "auto")}>
          {props.streaming ? "Steer" : "Send"}
        </button>
      </div>
    );
  };
})();

function Toasts(props: { toasts: { id: string; message: string; level: string }[] }) {
  return (
    <div className="toasts">
      {props.toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>{t.message}</div>
      ))}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return <div className="loading-row"><span className="spinner" /> {label}</div>;
}

function ScopeBadge({ scope }: { scope?: string }) {
  if (!scope) return null;
  const label = scope === "user" ? "global" : scope;
  return <span className={`scope-badge scope-${scope}`}>{label}</span>;
}

// "Customise" — how you shape the agent, in tabs under one scope switch:
//   Instructions (context + system prompt) · Extensions (code capabilities you install) ·
//   Skills (knowledge — added via a skill manager in a session; read-only here).
function ResourcesModal(props: { r: ReturnType<typeof useResources>; inSession: boolean; projectFolder?: string; systemPrompt: string | null; onFetchSystemPrompt: () => void; onClose: () => void }) {
  const { r } = props;
  const isGlobal = r.mode === "global";
  const managedScope = isGlobal ? "user" : "project";
  const [source, setSource] = useState("");
  const [tab, setTab] = useState<"instructions" | "extensions" | "skills">("instructions");
  const d: ResourceList = r.data ?? { skills: [], extensions: [], prompts: [], packages: [] };

  const managedPkgs = d.packages.filter((p) => p.scope === managedScope);
  const inheritedPkgs = isGlobal ? [] : d.packages.filter((p) => p.scope === "user");
  const managed = (items: ResourceItem[]) => items.filter((i) => i.scope === managedScope);
  const inherited = (items: ResourceItem[]) => (isGlobal ? [] : items.filter((i) => i.scope === "user"));
  const loading = r.data === null;

  // Inheritance-aware package status (project inherits global). Identity: the package dir/basename
  // (the settings source is relative, so basename is the reliable key against a preset's dir).
  const presetDirs = new Set(SUITE_PRESETS.map((p) => p.dir));
  const installedHere = new Set(managedPkgs.map((p) => basename(p.source)));
  const inheritedGlobal = new Set(inheritedPkgs.map((p) => basename(p.source)));
  const arbitraryHere = managedPkgs.filter((p) => !presetDirs.has(basename(p.source)));
  const arbitraryInherited = inheritedPkgs.filter((p) => !presetDirs.has(basename(p.source)));
  const removeScope = managedScope === "user" ? "global" : "project" as const;

  return (
    <ModalShell
      className="resources-modal"
      title="Customise"
      subtitle={isGlobal ? "Global - available in every project" : `${basename(r.workspace)} - this project only`}
      headerExtra={r.dirty && props.inSession ? <button className="primary" onClick={r.reload}>Reload to apply</button> : undefined}
      onClose={props.onClose}
    >
        <ScopeSwitch scope={r.mode} projectFolder={props.projectFolder} onGlobal={() => r.openFor("global")} onProject={(f) => r.openFor("project", f)} />
        <div className="tabs">
          <button className={tab === "instructions" ? "active" : ""} onClick={() => setTab("instructions")}>Instructions</button>
          <button className={tab === "extensions" ? "active" : ""} onClick={() => setTab("extensions")}>Extensions</button>
          <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>Skills</button>
        </div>
        {r.error && <div className="res-error">{r.error}</div>}
        {r.busy && <Loading label={r.busy} />}

        {tab === "instructions" && (
          <>
            <div className="theme-section">Current system prompt</div>
            <SystemPromptView prompt={props.systemPrompt} onFetch={props.onFetchSystemPrompt} canFetch={props.inSession} />
            <div className="theme-section">Edit instructions</div>
            <InstructionsSection scope={r.mode} folder={props.projectFolder} />
          </>
        )}

        {tab === "extensions" && (
          <>
            <div className="theme-section">Web search</div>
            <WebSearchKey braveKey={r.config.braveApiKey} onSave={r.setBraveKey} />

            <div className="theme-section">Extensions</div>
            <div className="preset-list">
              {SUITE_PRESETS.map((p) => (
                <div key={p.dir} className="res-row">
                  <div className="res-main"><span className="res-name">{p.name}</span><span className="res-desc">{p.desc}</span></div>
                  {installedHere.has(p.dir)
                    ? <button className="secondary" onClick={() => r.remove(p.source, removeScope)}>Remove</button>
                    : inheritedGlobal.has(p.dir)
                      ? <span className="muted">Global · inherited</span>
                      : <button onClick={() => r.install(p.source)}>Install</button>}
                </div>
              ))}
              {arbitraryHere.map((p) => (
                <div key={`h:${p.source}`} className="res-row">
                  <div className="res-main"><span className="res-name">{basename(p.source)}</span><span className="res-desc">{p.source}</span></div>
                  <button className="secondary" onClick={() => r.remove(p.source, removeScope)}>Remove</button>
                </div>
              ))}
              {arbitraryInherited.map((p) => (
                <div key={`i:${p.source}`} className="res-row">
                  <div className="res-main"><span className="res-name">{basename(p.source)}</span><span className="res-desc">{p.source}</span></div>
                  <span className="muted">Global · inherited</span>
                </div>
              ))}
            </div>

            <div className="theme-section">Install by source</div>
            <div className="install-row">
              <input placeholder="npm:pkg-name · git:host/user/repo · /path" value={source} onChange={(e) => setSource(e.target.value)} />
              <button disabled={!source.trim()} onClick={() => { r.install(source.trim()); setSource(""); }}>
                {isGlobal ? "Install globally" : "Install for project"}
              </button>
            </div>

            {loading
              ? <Loading label="Loading…" />
              : <ResourceGroup title="Active extensions" items={[...managed(d.extensions), ...inherited(d.extensions)]} render={(e) => e.commands?.length ? `commands: ${e.commands.join(", ")}` : ""} scoped />}
          </>
        )}

        {tab === "skills" && (() => {
          const skillItems = [...managed(d.skills), ...inherited(d.skills)];
          return (
          <>
            <div className="callout">Ask the agent to install skills with a skill manager (<b>Tessl</b>, <b>skills.sh</b>).</div>
            {loading ? (
              <Loading label="Loading…" />
            ) : (
              <>
                {skillItems.length === 0 && (
                  <p className="muted">No {isGlobal ? "global" : "project"} skills yet.</p>
                )}
                <ResourceGroup title="Active skills" items={skillItems} render={(s) => s.description ?? ""} scoped />
                <ResourceGroup title="Prompt templates" items={[...managed(d.prompts), ...inherited(d.prompts)]} render={(p) => p.description ?? ""} scoped />
                <p className="conn-hint">Git-ignored skills, or skills symlinked outside the folder, won't load.</p>
              </>
            )}
            {isGlobal && (
              <>
                <div className="theme-section">Machine-wide skills</div>
                <label className="tune-row">
                  <input type="checkbox" checked={!!r.config.shareAgentsDir} onChange={(e) => r.setShareAgents(e.target.checked)} />
                  <span>Also load from <code>~/.agents</code></span>
                </label>
              </>
            )}
          </>
          );
        })()}
    </ModalShell>
  );
}

function ResourceGroup({ title, items, render, scoped }: { title: string; items: ResourceItem[]; render: (i: ResourceItem) => string; scoped?: boolean }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <div className="theme-section">{title}</div>
      {items.map((i) => (
        <div key={`${i.scope}:${i.name}:${i.path ?? ""}`} className="res-row">
          <div className="res-main"><span className="res-name">{i.name}</span><span className="res-desc" title={render(i)}>{render(i)}</span></div>
          {scoped && <ScopeBadge scope={i.scope ?? "project"} />}
        </div>
      ))}
    </>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
}

type KV = { k: string; v: string };

// Add a connector the presets don't cover: a remote MCP URL (OAuth or a bearer/header token),
// or an advanced local stdio command.
function CustomConnectorForm(props: { onSave: (s: McpServer) => void; onCancel: () => void; initial?: { label?: string; url?: string; needsApp?: boolean } }) {
  const [label, setLabel] = useState(props.initial?.label ?? "");
  const [kind, setKind] = useState<"remote" | "local">("remote");
  const [url, setUrl] = useState(props.initial?.url ?? "");
  const [remoteAuth, setRemoteAuth] = useState<"oauth" | "token">("oauth");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("");
  const [pairs, setPairs] = useState<KV[]>([{ k: "", v: "" }]);
  const REDIRECT_URI = "http://localhost:51823/callback"; // mirrors MCP_REDIRECT_URI in main

  const setPair = (i: number, patch: Partial<KV>) => setPairs((p) => p.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addPair = () => setPairs((p) => [...p, { k: "", v: "" }]);
  const removePair = (i: number) => setPairs((p) => p.filter((_, idx) => idx !== i));

  const valid = label.trim() && (kind === "remote" ? url.trim() : command.trim());

  const save = () => {
    const name = slugify(label);
    const kv: Record<string, string> = {};
    for (const { k, v } of pairs) if (k.trim()) kv[k.trim()] = v;
    const server: McpServer = kind === "remote"
      ? {
          name, label: label.trim(), url: url.trim(), auth: remoteAuth === "oauth" ? "oauth" : "bearer",
          ...(remoteAuth === "token" && Object.keys(kv).length ? { headers: kv } : {}),
          ...(remoteAuth === "oauth" && clientId.trim() ? { oauthClientId: clientId.trim() } : {}),
          ...(remoteAuth === "oauth" && clientSecret.trim() ? { oauthClientSecret: clientSecret.trim() } : {}),
        }
      : { name, label: label.trim(), command: command.trim(), args: argsText.split(/\s+/).filter(Boolean), ...(Object.keys(kv).length ? { env: kv } : {}) };
    props.onSave(server);
  };

  return (
    <div className="connector-form">
      <label className="conn-field"><span>Name</span><input placeholder="My MCP server" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <div className="conn-transport">
        <label><input type="radio" checked={kind === "remote"} onChange={() => setKind("remote")} /> Remote server (URL)</label>
        <label><input type="radio" checked={kind === "local"} onChange={() => setKind("local")} /> Local command (advanced)</label>
      </div>
      {kind === "remote" ? (
        <>
          <label className="conn-field"><span>Server URL</span><input placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          <div className="conn-transport">
            <label><input type="radio" checked={remoteAuth === "oauth"} onChange={() => setRemoteAuth("oauth")} /> Sign in with OAuth</label>
            <label><input type="radio" checked={remoteAuth === "token"} onChange={() => setRemoteAuth("token")} /> Header token</label>
          </div>
          {remoteAuth === "token" && (
            <div className="conn-field"><span>Headers</span>
              {pairs.map((row, i) => (
                <div key={i} className="kv-row">
                  <input placeholder="Authorization" value={row.k} onChange={(e) => setPair(i, { k: e.target.value })} />
                  <input type="password" placeholder="Bearer …" value={row.v} onChange={(e) => setPair(i, { v: e.target.value })} />
                  <button className="secondary" onClick={() => removePair(i)} title="Remove">✕</button>
                </div>
              ))}
              <button className="link" onClick={addPair}>+ add</button>
            </div>
          )}
          {remoteAuth === "oauth" && (
            <div className="conn-field">
              <span>App credentials{props.initial?.needsApp ? "" : " (usually not needed)"}</span>
              <p className="conn-hint">
                Most servers register automatically — leave these blank. Some (like Slack) need an app you
                register: create one, set its redirect URL to <code>{REDIRECT_URI}</code>, then paste its
                Client ID and Secret. A secret makes this a Global-only connector.
              </p>
              <input placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
              <input type="password" placeholder="Client Secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
            </div>
          )}
        </>
      ) : (
        <>
          <label className="conn-field"><span>Command</span><input placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} /></label>
          <label className="conn-field"><span>Arguments</span><input placeholder="-y @scope/mcp-server" value={argsText} onChange={(e) => setArgsText(e.target.value)} /></label>
          <div className="conn-field"><span>Environment variables (tokens)</span>
            {pairs.map((row, i) => (
              <div key={i} className="kv-row">
                <input placeholder="SLACK_BOT_TOKEN" value={row.k} onChange={(e) => setPair(i, { k: e.target.value })} />
                <input type="password" placeholder="xoxb-…" value={row.v} onChange={(e) => setPair(i, { v: e.target.value })} />
                <button className="secondary" onClick={() => removePair(i)} title="Remove">✕</button>
              </div>
            ))}
            <button className="link" onClick={addPair}>+ add</button>
          </div>
        </>
      )}
      <div className="modal-actions">
        <button disabled={!valid} onClick={save}>Add</button>
        <button className="secondary" onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ConnectorsModal(props: { c: ReturnType<typeof useConnectors>; inSession: boolean; projectFolder?: string; status: McpStatusEntry[]; onClose: () => void }) {
  const { c } = props;
  const isGlobal = c.mode === "global";
  const [customOpen, setCustomOpen] = useState(false);
  const [customInitial, setCustomInitial] = useState<{ label?: string; url?: string; needsApp?: boolean } | undefined>(undefined);
  const statusOf = (name: string) => props.status.find((s) => s.name === name);
  // Presets exclude anything already configured here OR inherited from global (a global Notion
  // is already active in this project — don't offer to set it up again).
  const configuredNames = new Set([...c.servers, ...c.inherited].map((s) => s.name));

  // A connector row: shows connection state + Connect/Disconnect (OAuth) and Remove.
  const Row = ({ s }: { s: McpServer }) => {
    const st = statusOf(s.name);
    const isOauth = s.auth === "oauth" || (st?.oauth ?? false);
    const connected = st?.status === "authenticated";
    const expired = st?.status === "expired";
    return (
      <div className="res-row">
        <div className="res-main">
          <span className="res-name">{s.label ?? s.name}</span>
          <span className="res-desc">{s.url ?? s.command ?? ""}{isOauth ? (connected ? " · connected" : expired ? " · session expired" : " · not connected") : s.auth === "bearer" ? " · token" : ""}</span>
        </div>
        {isOauth && (connected
          ? <button className="secondary" onClick={() => c.disconnect(s.name)}>Disconnect</button>
          : <button className="primary" title="Authorize in your browser" onClick={() => c.connect(s.name)}>{expired ? "Reconnect" : "Connect"}</button>)}
        <button className="secondary" onClick={() => c.remove(s.name)}>Remove</button>
      </div>
    );
  };

  return (
    <ModalShell
      className="connectors-modal"
      title="Connectors"
      subtitle={isGlobal ? "Global - MCP servers available in every session" : `${basename(c.folder ?? "")} - this project only`}
      headerExtra={c.dirty && props.inSession ? <button className="primary" onClick={c.reload}>Reload to apply</button> : undefined}
      onClose={props.onClose}
    >
        <ScopeSwitch scope={c.mode} projectFolder={props.projectFolder} onGlobal={() => c.openFor("global")} onProject={(f) => c.openFor("project", f)} />
        {c.error && <div className="res-error">{c.error}</div>}
        {c.busy && <Loading label={c.busy} />}

        {c.servers.length > 0 && (
          <>
            <div className="theme-section">Configured</div>
            {c.servers.map((s) => <Row key={s.name} s={s} />)}
          </>
        )}

        {c.inherited.length > 0 && (
          <>
            <div className="theme-section">Inherited from global</div>
            {c.inherited.map((s) => {
              const st = statusOf(s.name);
              const connected = st?.status === "authenticated";
              return (
                <div key={s.name} className="res-row">
                  <div className="res-main">
                    <span className="res-name">{s.label ?? s.name}</span>
                    <span className="res-desc">{s.url ?? s.command ?? ""}{connected ? " · connected" : ""} · <span className="muted">available in every project</span></span>
                  </div>
                  <ScopeBadge scope="user" />
                </div>
              );
            })}
          </>
        )}

        <div className="theme-section">Add a connector</div>
        {customOpen ? (
          <CustomConnectorForm initial={customInitial} onSave={(server) => { c.add(server); setCustomOpen(false); setCustomInitial(undefined); }} onCancel={() => { setCustomOpen(false); setCustomInitial(undefined); }} />
        ) : (
          <div className="preset-list">
            {MCP_PRESETS.filter((p) => !configuredNames.has(p.name)).map((p) => (
              <div key={p.name} className="res-row">
                <div className="res-main"><span className="res-name">{p.label}</span><span className="res-desc">{p.desc}</span></div>
                {p.needsApp
                  ? <button onClick={() => { setCustomInitial({ label: p.label, url: p.url, needsApp: true }); setCustomOpen(true); }}>Set up</button>
                  : <button onClick={() => c.add({ name: p.name, label: p.label, url: p.url, auth: "oauth" })}>Add</button>}
              </div>
            ))}
            <div className="res-row">
              <div className="res-main"><span className="res-name">Custom…</span><span className="res-desc">Any MCP server - a remote URL or a local command</span></div>
              <button onClick={() => { setCustomInitial(undefined); setCustomOpen(true); }}>Add</button>
            </div>
          </div>
        )}
    </ModalShell>
  );
}

// Add a model the pinned Pi SDK doesn't list yet (e.g. a just-released Opus) — writes it into
// models.json under the chosen provider (reusing that provider's login) and reloads.
function AddModel(props: { defaultProvider: string }) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(props.defaultProvider);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [reasoning, setReasoning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!id.trim()) return;
    setBusy(true); setErr(null);
    const r = await window.piwork.addModel({ provider: provider.trim(), id: id.trim(), name: name.trim() || undefined, reasoning });
    setBusy(false);
    if (r.ok) { setId(""); setName(""); setOpen(false); } // the reload re-emits the list; the new model appears
    else setErr(r.error ?? "Couldn't add the model.");
  };
  if (!open) return <button className="link add-model-open" onClick={() => setOpen(true)}>+ Add a model Pi doesn't list yet</button>;
  return (
    <div className="add-model">
      <div className="muted">Add a model Pi doesn't list yet. Uses your existing login.</div>
      <div className="kv-row">
        <input placeholder="provider (e.g. anthropic)" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <input placeholder="model id (e.g. claude-opus-5)" value={id} onChange={(e) => setId(e.target.value)} />
      </div>
      <input placeholder="display name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="checkbox-row"><input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} /> Supports thinking</label>
      {err && <div className="res-error">{err}</div>}
      <div className="modal-actions">
        <button className="primary" disabled={!id.trim() || busy} onClick={submit}>{busy ? "Adding…" : "Add model"}</button>
        <button className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// Add a custom API-key provider (e.g. Mistral) — not a built-in OAuth login. Writes a provider
// entry (baseUrl/api/apiKey + a starter model) to models.json and reloads.
const PROVIDER_APIS = ["mistral-conversations", "openai-completions", "anthropic-messages", "google-generative-ai"];
function AddProvider() {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fillMistral = () => { setProvider("mistral"); setApi("mistral-conversations"); setBaseUrl("https://api.mistral.ai"); setModelId("mistral-large-latest"); setModelName("Mistral Large"); };
  const valid = provider.trim() && apiKey.trim() && modelId.trim();
  const submit = async () => {
    if (!valid) return;
    setBusy(true); setErr(null);
    const r = await window.piwork.addProvider({ provider: provider.trim(), api, baseUrl: baseUrl.trim() || undefined, apiKey: apiKey.trim(), modelId: modelId.trim(), modelName: modelName.trim() || undefined, reasoning });
    setBusy(false);
    if (r.ok) { setOpen(false); setApiKey(""); } else setErr(r.error ?? "Couldn't add the provider.");
  };
  if (!open) return <button className="link add-model-open" onClick={() => setOpen(true)}>+ Add a provider by API key (e.g. Mistral)</button>;
  return (
    <div className="add-model">
      <div className="muted">Add an API-key provider. Try <button className="link" onClick={fillMistral}>Fill Mistral defaults</button>, then paste your key.</div>
      <div className="kv-row">
        <input placeholder="provider id (e.g. mistral)" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <select className="model-picker" value={api} onChange={(e) => setApi(e.target.value)}>{PROVIDER_APIS.map((a) => <option key={a} value={a}>{a}</option>)}</select>
      </div>
      <input placeholder="base URL (e.g. https://api.mistral.ai)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      <input type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <div className="kv-row">
        <input placeholder="model id (e.g. mistral-large-latest)" value={modelId} onChange={(e) => setModelId(e.target.value)} />
        <input placeholder="display name (optional)" value={modelName} onChange={(e) => setModelName(e.target.value)} />
      </div>
      <label className="checkbox-row"><input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} /> Supports thinking</label>
      {err && <div className="res-error">{err}</div>}
      <div className="modal-actions">
        <button className="primary" disabled={!valid || busy} onClick={submit}>{busy ? "Adding…" : "Add provider"}</button>
        <button className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
// Merged model + provider control: ONE entry point that both picks the active model (from the
// connected providers' models, highlighting the current one) and connects/manages providers.
// Reached from the rail's Settings zone (🧠 Model).
function ModelAccountModal(props: {
  models: { provider: string; id: string }[];
  currentModel: { provider: string; id: string; reasoning?: boolean } | null;
  onPickModel: (provider: string, id: string) => void;
  thinkingLevel: string;
  onThinking: (level: string) => void;
  connected: string[];
  hello: { piVersion: string; sessionId?: string } | null;
  onConnect: () => void;
  onClose: () => void;
}) {
  const cur = props.currentModel;
  return (
    <ModalShell
      title="Model & account"
      subtitle={cur ? `${cur.provider} · ${cur.id}` : "No provider connected"}
      className="model-account-modal"
      onClose={props.onClose}
      footer={<button className="primary" onClick={props.onConnect}>{props.connected.length > 0 ? "Connect another provider…" : "Connect a provider…"}</button>}
    >
      {props.connected.length > 0 ? (
        <>
          <div className="theme-section">Model</div>
          {props.models.length > 0 ? (
            <div className="options">
              {props.models.map((m) => {
                const active = cur?.provider === m.provider && cur?.id === m.id;
                return (
                  <button
                    key={`${m.provider}/${m.id}`}
                    className={`res-row model-row${active ? " active" : ""}`}
                    onClick={() => props.onPickModel(m.provider, m.id)}
                  >
                    <div className="res-main">
                      <span className="res-name">{m.id}</span>
                      <span className="res-desc">{m.provider}</span>
                    </div>
                    {active && <span className="scope-badge scope-project">current</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="muted">No models available yet.</div>
          )}

          <div className="theme-section">Thinking</div>
          {props.currentModel?.reasoning === false ? (
            <div className="muted">Not supported by {props.currentModel.id}.</div>
          ) : (
            <div className="thinking-levels">
              {THINKING_LEVELS.map((lv) => (
                <button key={lv} className={`thinking-lv${props.thinkingLevel === lv ? " active" : ""}`} onClick={() => props.onThinking(lv)}>{lv}</button>
              ))}
            </div>
          )}

          <AddModel defaultProvider={cur?.provider ?? props.connected[0] ?? "anthropic"} />
          <AddProvider />

          <div className="theme-section">Providers</div>
          <div className="options">
            {props.connected.map((p) => (
              <div key={p} className="res-row">
                <div className="res-main">
                  <span className="res-name"><span className="conn-dot" /> {p}</span>
                </div>
                <span className="scope-badge scope-project">connected</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="modal-message">No model connected. Sign in above, or add one by API key:</div>
          <AddProvider />
        </>
      )}
      {props.hello && <div className="muted" style={{ marginTop: 14 }}>pi {props.hello.piVersion}</div>}
    </ModalShell>
  );
}

// Edit the agent's instructions / system prompt — the same files the agent can edit itself,
// with a nice editor. agents = AGENTS.md, append = APPEND_SYSTEM.md, replace = SYSTEM.md.
const INSTR_KINDS = [
  { key: "agents", label: "Instructions", hint: "Instructions and conventions for the agent (AGENTS.md)" },
  { key: "append", label: "Append to prompt", hint: "Appended to the base system prompt (APPEND_SYSTEM.md)" },
  { key: "replace", label: "Replace prompt", hint: "Replaces the base system prompt (SYSTEM.md)" },
];
// Web search config. web_search + fetch_url are built in and work with no setup (keyless
// DuckDuckGo). A free Brave Search API key makes results more reliable; it's global config and
// applies on the next session (Reload to apply).
function WebSearchKey(props: { braveKey?: string; onSave: (key: string) => void }) {
  const [val, setVal] = useState(props.braveKey ?? "");
  const dirty = val.trim() !== (props.braveKey ?? "");
  return (
    <div className="websearch-key">
      <p className="conn-hint">
        Web search works with no setup. For more reliable results, add a free{" "}
        <button className="link" onClick={() => window.piwork.openExternal("https://brave.com/search/api/")}>Brave Search API key</button>
        . Applies on the next session.
      </p>
      <div className="install-row">
        <input type="password" placeholder="Brave Search API key (optional)" value={val} onChange={(e) => setVal(e.target.value)} />
        <button disabled={!dirty} onClick={() => props.onSave(val)}>Save</button>
      </div>
    </div>
  );
}

// Instructions editor — a SECTION inside the Skills/extensions modal (it's all agent-shaping).
// scope + folder come from the modal's own scope switch.
function InstructionsSection(props: { scope: "global" | "project"; folder?: string }) {
  const [kind, setKind] = useState("agents");
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const { scope, folder } = props;
  useEffect(() => {
    setLoaded(false); setSaved(false);
    window.piwork.readInstructions(scope, folder, kind).then((res) => { setContent(res.content ?? ""); setLoaded(true); });
  }, [scope, kind, folder]);
  const save = async () => {
    setBusy(true);
    const res = await window.piwork.writeInstructions(scope, folder, kind, content);
    setBusy(false);
    if (res.ok) setSaved(true);
  };
  const active = INSTR_KINDS.find((k) => k.key === kind) ?? INSTR_KINDS[0];
  return (
    <>
      <div className="instr-kinds">
        {INSTR_KINDS.map((k) => (
          <button key={k.key} className={`thinking-lv${kind === k.key ? " active" : ""}`} onClick={() => setKind(k.key)}>{k.label}</button>
        ))}
      </div>
      <div className="muted">{active.hint} {scope === "project" ? "for this project only." : "for every project."}</div>
      <textarea
        className="instr-editor"
        value={content}
        disabled={!loaded}
        placeholder={loaded ? "Type instructions here." : "Loading…"}
        onChange={(e) => { setContent(e.target.value); setSaved(false); }}
      />
      <div className="modal-actions">
        <button className="primary" disabled={busy || !loaded} onClick={save}>{busy ? "Saving…" : saved ? "Saved ✓" : "Save"}</button>
      </div>
    </>
  );
}

// Read-only view of the agent's current composed system prompt (so you can decide what to
// append to / replace). Needs a running session (pi-host computes it).
function SystemPromptView(props: { prompt: string | null; onFetch: () => void; canFetch: boolean }) {
  const [open, setOpen] = useState(false);
  if (!props.canFetch) return <div className="muted">Start a session to view the current system prompt.</div>;
  return (
    <>
      <button className="secondary" onClick={() => { props.onFetch(); setOpen(true); }}>{open ? "↻ Refresh" : "Show current system prompt"}</button>
      {open && (props.prompt == null ? <div className="muted">Loading…</div> : <pre className="sysprompt-view">{props.prompt}</pre>)}
    </>
  );
}

function ThemeModal(props: { t: ReturnType<typeof useTheme>; onClose: () => void }) {
  const { t } = props;
  const s = t.theme;
  const resolved = resolveTheme(s);
  const vars = resolved.colors;
  const tweaked = hasTweaks(s.overrides);
  const activeUser = s.activeId.startsWith("user:") ? s.userThemes[s.activeId.slice(5)] : null;
  const userThemes = Object.values(s.userThemes);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

  const doSave = () => { t.saveAsNew(name); setName(""); setSaving(false); };

  const footer = (
    <div className="theme-actions">
      {activeUser && tweaked && <button onClick={t.saveChanges}>Save changes to “{activeUser.name}”</button>}
      {tweaked && (saving ? (
        <span className="save-as">
          <input autoFocus placeholder="Theme name" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) doSave(); if (e.key === "Escape") setSaving(false); }} />
          <button className="primary" disabled={!name.trim()} onClick={doSave}>Save</button>
          <button className="secondary" onClick={() => setSaving(false)}>Cancel</button>
        </span>
      ) : (
        <button className="primary" onClick={() => setSaving(true)}>Save as new theme…</button>
      ))}
    </div>
  );

  return (
    <ModalShell title="Theme" className="theme-modal" onClose={props.onClose} footer={tweaked ? footer : undefined}>
        <div className="theme-section">Presets</div>
        <div className="preset-grid">
          {Object.entries(PRESETS).map(([presetName, v]) => (
            <button
              key={presetName}
              className={`preset-card ${s.activeId === `preset:${presetName}` ? "active" : ""}`}
              onClick={() => t.select(`preset:${presetName}`)}
            >
              <span className="preset-swatch" style={{ background: v.bg, borderColor: v.border }}>
                <span style={{ background: v.accent }} />
                <span style={{ background: v.fg }} />
                <span style={{ background: v.panel }} />
              </span>
              <span className="preset-name">{presetName}</span>
            </button>
          ))}
        </div>

        {userThemes.length > 0 && (
          <>
            <div className="theme-section">My themes</div>
            {userThemes.map((u) => (
              <div key={u.id} className={`res-row ${s.activeId === `user:${u.id}` ? "active-theme-row" : ""}`}>
                {renameId === u.id ? (
                  <input className="theme-rename" autoFocus value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { t.rename(u.id, renameVal); setRenameId(null); } if (e.key === "Escape") setRenameId(null); }}
                    onBlur={() => { t.rename(u.id, renameVal); setRenameId(null); }} />
                ) : (
                  <button className="theme-pick" onClick={() => t.select(`user:${u.id}`)}>
                    <span className="preset-swatch sm" style={{ background: u.theme.colors.bg, borderColor: u.theme.colors.border }}>
                      <span style={{ background: u.theme.colors.accent }} />
                      <span style={{ background: u.theme.colors.fg }} />
                    </span>
                    <span className="res-name">{u.name}</span>
                  </button>
                )}
                <button className="secondary" title="Rename" onClick={() => { setRenameId(u.id); setRenameVal(u.name); }}>✎</button>
                <button className="secondary" title="Delete" onClick={() => t.remove(u.id)}>🗑</button>
              </div>
            ))}
          </>
        )}

        <div className="theme-section">
          Customize
          {tweaked && <button className="link" onClick={t.resetTweaks}>reset tweaks</button>}
        </div>

        <div className="theme-typo">
          <label className="conn-field">
            <span>Font</span>
            <select value={resolved.font} onChange={(e) => t.setFont(e.target.value)}>
              {FONT_OPTIONS.map((f) => <option key={f.key} value={f.key} style={{ fontFamily: f.stack }}>{f.label}</option>)}
            </select>
          </label>
          <label className="conn-field">
            <span>Text size · {resolved.size}px</span>
            <input type="range" min={SIZE_MIN} max={SIZE_MAX} value={resolved.size} onChange={(e) => t.setSize(Number(e.target.value))} />
          </label>
        </div>

        <div className="tune-grid">
          {THEME_TOKENS.map(({ key, label }) => (
            <label key={key} className="tune-row">
              <input type="color" value={vars[key]} onChange={(e) => t.setColor(key, e.target.value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
    </ModalShell>
  );
}

function DialogModal(props: { dialog: UiDialog; onRespond: (r: Record<string, unknown>) => void }) {
  const d = props.dialog;
  const [text, setText] = useState(d.prefill ?? "");
  const cancel = () => props.onRespond({ type: "extension_ui_response", id: d.id, cancelled: true });
  return (
    <ModalShell title={d.title} onClose={cancel}>
        {d.message && <div className="modal-message">{d.message}</div>}

        {d.method === "select" && (
          <div className="options">
            {(d.options ?? []).map((o) => (
              <button key={o} onClick={() => props.onRespond({ type: "extension_ui_response", id: d.id, value: o })}>
                {o}
              </button>
            ))}
          </div>
        )}

        {d.method === "confirm" && (
          <div className="modal-actions">
            <button onClick={() => props.onRespond({ type: "extension_ui_response", id: d.id, confirmed: true })}>Yes</button>
            <button onClick={() => props.onRespond({ type: "extension_ui_response", id: d.id, confirmed: false })}>No</button>
          </div>
        )}

        {(d.method === "input" || d.method === "editor") && (
          <>
            {d.method === "editor" ? (
              <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={8} />
            ) : (
              <input autoFocus placeholder={d.placeholder} value={text} onChange={(e) => setText(e.target.value)} />
            )}
            <div className="modal-actions">
              <button onClick={() => props.onRespond({ type: "extension_ui_response", id: d.id, value: text })}>Submit</button>
              <button className="secondary" onClick={cancel}>Cancel</button>
            </div>
          </>
        )}
    </ModalShell>
  );
}

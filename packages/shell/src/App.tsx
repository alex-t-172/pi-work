import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { useBridge } from "./useBridge.ts";
import { useTheme } from "./useTheme.ts";
import { useResources } from "./useResources.ts";
import { useConnectors } from "./useConnectors.ts";
import { PRESETS, resolveVars, THEME_TOKENS, type ThemeState, type ThemeToken } from "./theme.ts";
import type { ChatItem, ConnectorServer, LoginState, PackageItem, ResourceItem, ResourceList, SessionMeta, UiDialog } from "./types.ts";

// Curated presets installable in one click (sources are container-side suite paths).
const SUITE_PRESETS = [
  { name: "Checkpoint", source: "/opt/piwork-suite/piwork-checkpoint", dir: "piwork-checkpoint", desc: "Git auto-commit before each turn (safety net)" },
  { name: "Connectors", source: "/opt/piwork-suite/piwork-connectors", dir: "piwork-connectors", desc: "Engine for MCP connectors (Slack, Notion, …) — configure via the 🔌 button" },
  { name: "Artifacts", source: "/opt/piwork-suite/piwork-artifacts", dir: "piwork-artifacts", desc: "Auto-preview files written to .artifacts/ (HTML/Markdown/text)" },
];

// MCP connector presets: each yields a stdio server + one or more secret env fields.
const CONNECTOR_PRESETS: Array<{ id: string; label: string; command: string; args: string[]; fields: Array<{ env: string; label: string; required?: boolean; placeholder?: string }> }> = [
  { id: "notion", label: "Notion", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], fields: [{ env: "NOTION_TOKEN", label: "Notion integration token", required: true, placeholder: "ntn_…" }] },
  { id: "slack", label: "Slack", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], fields: [{ env: "SLACK_BOT_TOKEN", label: "Slack bot token", required: true, placeholder: "xoxb-…" }, { env: "SLACK_TEAM_ID", label: "Team ID (optional)", placeholder: "T…" }] },
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
  const inSession = b.connection === "connected" || b.connection === "starting";

  return (
    <div className="app">
      {inSession ? (
        <>
          <TopBar
            connection={b.connection}
            hello={b.hello}
            currentModel={b.currentModel}
            models={b.models}
            onEndSessions={b.endToSessions}
            onEndHome={b.endToHome}
            onPickModel={b.setModel}
            onToggleDebug={() => setShowDebug((v) => !v)}
            onLogin={b.startLogin}
            onTheme={() => setShowTheme(true)}
            onResources={() => b.activeFolder && r.openFor("project", b.activeFolder)}
            onConnectors={() => b.activeFolder && c.openFor("project", b.activeFolder)}
            artifactCount={Object.keys(b.artifacts).length}
            onArtifacts={() => b.setArtifactsOpen((v: boolean) => !v)}
          />
          <StatusBar statuses={b.statuses} streaming={b.streaming} onAbort={b.abort} />
          <Widgets lines={b.widgets.above} placement="above" />
          <Chat items={b.items} connection={b.connection} />
          <Widgets lines={b.widgets.below} placement="below" />
          <Composer taRef={composerRef} streaming={b.streaming} disabled={b.connection !== "connected"} onSubmit={b.submit} commands={b.commands} />
        </>
      ) : (
        <Launcher
          recentFolders={b.recentFolders}
          folder={b.launcherFolder}
          sessions={b.launcherSessions}
          onPick={b.pickFolder}
          onSelectFolder={b.selectFolder}
          onBack={b.backToFolders}
          onStart={b.startWith}
          onToggleDebug={() => setShowDebug((v) => !v)}
          onLogin={b.startLogin}
          onTheme={() => setShowTheme(true)}
          onManageGlobal={() => r.openFor("global")}
          onManageProject={(folder) => r.openFor("project", folder)}
          onConnectorsGlobal={() => c.openFor("global")}
          onConnectorsProject={(folder) => c.openFor("project", folder)}
        />
      )}
      <Toasts toasts={b.toasts} />
      {showTheme && (
        <ThemeModal theme={t.theme} onPreset={t.setPreset} onOverride={t.setOverride} onReset={t.resetTweaks} onClose={() => setShowTheme(false)} />
      )}
      {r.open && <ResourcesModal r={r} inSession={inSession} onClose={r.close} />}
      {c.open && <ConnectorsModal c={c} inSession={inSession} onClose={c.close} />}
      {b.dialog && <DialogModal dialog={b.dialog} onRespond={b.respondDialog} />}
      {inSession && b.artifactsOpen && <ArtifactsPanel artifacts={b.artifacts} onClose={() => b.setArtifactsOpen(false)} />}
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
  sessions: SessionMeta[] | null;
  onPick: () => void;
  onSelectFolder: (folder: string) => void;
  onBack: () => void;
  onStart: (folder: string, session?: string) => void;
  onToggleDebug: () => void;
  onLogin: () => void;
  onTheme: () => void;
  onManageGlobal: () => void;
  onManageProject: (folder: string) => void;
  onConnectorsGlobal: () => void;
  onConnectorsProject: (folder: string) => void;
}) {
  return (
    <div className="launcher">
      <div className="launcher-head">
        <span className="brand">Piwork</span>
        <div className="spacer" />
        <button className="secondary" onClick={props.onLogin}>Login</button>
        <button className="secondary" onClick={props.onTheme} title="Theme">🎨</button>
        <button className="secondary" onClick={props.onToggleDebug} title="Debug drawer">🐞</button>
      </div>

      {!props.folder ? (
        <div className="launcher-body">
          <h2>Open a project</h2>
          <p className="muted">Each project runs in its own sandboxed container. Choose a folder to start or resume a session.</p>
          <div className="folder-actions">
            <button className="primary" onClick={props.onPick}>Open a folder…</button>
            <button className="secondary" onClick={props.onManageGlobal}>🧩 Global extensions & skills</button>
            <button className="secondary" onClick={props.onConnectorsGlobal}>🔌 Global connectors</button>
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
          <div className="crumb">
            <button className="link" onClick={props.onBack}>← folders</button>
            <span className="folder-name">{basename(props.folder)}</span>
            <span className="folder-path">{props.folder}</span>
          </div>
          <div className="folder-actions">
            <button className="primary" onClick={() => props.onStart(props.folder!, "new")}>＋ New session</button>
            <button className="secondary" onClick={() => props.onManageProject(props.folder!)}>🧩 Project extensions & skills</button>
            <button className="secondary" onClick={() => props.onConnectorsProject(props.folder!)}>🔌 Project connectors</button>
          </div>
          <h3>History</h3>
          {props.sessions === null ? (
            <p className="muted">Loading sessions…</p>
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
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Sign in</div>

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
      </div>
    </div>
  );
}

// Wrap artifact content in a locked-down document: an inner CSP that permits inline
// style/script + data: images, but blocks ALL network/framing (no exfiltration). Combined
// with the iframe's sandbox="allow-scripts" (opaque origin, no same-origin access), this is
// the design's CSP-locked, no-Node escape hatch.
function artifactSrcDoc(body: string): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#16181d;background:#fff;margin:14px}pre{background:#f0f1f4;padding:10px;border-radius:6px;overflow:auto}</style></head><body>${body}</body></html>`;
}

function ArtifactsPanel(props: { artifacts: Record<string, { title?: string; html?: string; markdown?: string }>; onClose: () => void }) {
  const entries = Object.entries(props.artifacts);
  return (
    <div className="artifacts-drawer">
      <header>
        <strong>Artifacts</strong>
        <div className="spacer" />
        <button onClick={props.onClose}>Close</button>
      </header>
      <div className="artifacts-body">
        {entries.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>No artifacts yet.</div>
        ) : (
          entries.map(([key, a]) => {
            const body = a.html ?? (a.markdown ? (marked.parse(a.markdown) as string) : "");
            return (
              <div key={key} className="artifact">
                {a.title && <div className="artifact-title">{a.title}</div>}
                <iframe className="artifact-frame" title={a.title ?? key} sandbox="allow-scripts" srcDoc={artifactSrcDoc(body)} />
              </div>
            );
          })
        )}
      </div>
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

function TopBar(props: {
  connection: string;
  hello: { piVersion: string; sessionId?: string } | null;
  currentModel: { provider: string; id: string } | null;
  models: { provider: string; id: string }[];
  onEndSessions: () => void;
  onEndHome: () => void;
  onPickModel: (provider: string, id: string) => void;
  onToggleDebug: () => void;
  onLogin: () => void;
  onTheme: () => void;
  onResources: () => void;
  onConnectors: () => void;
  artifactCount: number;
  onArtifacts: () => void;
}) {
  const value = props.currentModel ? `${props.currentModel.provider}/${props.currentModel.id}` : "";
  return (
    <div className="topbar">
      <span className="brand">Piwork</span>
      <span className={`conn conn-${props.connection}`}>{props.connection}</span>
      {props.hello && <span className="muted">pi {props.hello.piVersion}</span>}
      <div className="spacer" />
      {props.models.length > 0 && (
        <select
          className="model-picker"
          value={value}
          onChange={(e) => {
            const [provider, ...rest] = e.target.value.split("/");
            props.onPickModel(provider, rest.join("/"));
          }}
        >
          {value === "" && <option value="">select model…</option>}
          {props.models.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
              {m.provider}/{m.id}
            </option>
          ))}
        </select>
      )}
      <button onClick={props.onEndSessions} title="End the sandbox and return to this folder's sessions">End · Sessions</button>
      <button onClick={props.onEndHome} title="End the sandbox and return to the folders home">End · Home</button>
      <button className="secondary" onClick={props.onResources} title="Manage skills, plugins & extensions">🧩</button>
      <button className="secondary" onClick={props.onConnectors} title="Manage MCP connectors (Slack, Notion, …)">🔌</button>
      {props.artifactCount > 0 && (
        <button className="secondary" onClick={props.onArtifacts} title="Artifacts">🖼 {props.artifactCount}</button>
      )}
      <button className="secondary" onClick={props.onLogin} title="Sign in to a model provider (OAuth)">Login</button>
      <button className="secondary" onClick={props.onTheme} title="Theme">🎨</button>
      <button className="secondary" onClick={props.onToggleDebug} title="Debug drawer">🐞</button>
    </div>
  );
}

function StatusBar(props: { statuses: Record<string, string>; streaming: boolean; onAbort: () => void }) {
  const chips = Object.entries(props.statuses);
  if (chips.length === 0 && !props.streaming) return null;
  return (
    <div className="statusbar">
      {props.streaming && (
        <span className="chip chip-live">
          <span className="dot" /> working…
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

function Chat(props: { items: ChatItem[]; connection: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.items]);

  if (props.items.length === 0) {
    return (
      <div className="chat empty">
        <div className="hint">
          {props.connection === "starting" ? "Starting sandbox…" : "Ready. Type a message below."}
        </div>
        <div ref={endRef} />
      </div>
    );
  }
  return (
    <div className="chat">
      {props.items.map((it) => (
        <Message key={it.id} item={it} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Message({ item }: { item: ChatItem }) {
  // Hooks must run unconditionally (before any early return).
  const bodyHtml = useMemo(() => (item.text ? (marked.parse(item.text) as string) : ""), [item.text]);
  const thinkingHtml = useMemo(() => (item.thinking ? (marked.parse(item.thinking) as string) : ""), [item.thinking]);

  if (item.role === "tool") {
    return (
      <div className={`msg tool tool-${item.toolStatus}`}>
        <span className="tool-badge">{item.toolStatus === "running" ? "⏳" : item.toolStatus === "error" ? "✗" : "✓"}</span>
        <code>{item.toolName}</code>
      </div>
    );
  }

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
        <div className="body muted">…</div>
      ) : null}
    </div>
  );
}

const Composer = (function () {
  // forwardRef without importing the symbol name churn.
  return function Composer(props: {
    taRef: React.RefObject<HTMLTextAreaElement>;
    streaming: boolean;
    disabled: boolean;
    onSubmit: (text: string, mode: "auto" | "steer" | "followUp") => void;
    commands: Array<{ name: string; description?: string; source?: string }>;
  }) {
    const [text, setText] = useState("");
    const [sel, setSel] = useState(0);
    const [dismissed, setDismissed] = useState(false);

    // Autocomplete when typing a slash command: "/" + partial name, no space yet.
    const match = /^\/(\S*)$/.exec(text);
    const suggestions = match
      ? props.commands
          .filter((cmd) => cmd.name.toLowerCase().startsWith(match[1].toLowerCase()))
          .slice(0, 8)
      : [];
    const open = suggestions.length > 0 && !dismissed;
    const clampedSel = Math.min(sel, Math.max(0, suggestions.length - 1));

    const setTextAndResize = (v: string) => {
      setText(v);
      const t = props.taRef.current;
      if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }
    };
    const accept = (name: string) => {
      setTextAndResize(`/${name} `);
      setDismissed(true);
      setSel(0);
      props.taRef.current?.focus();
    };
    const submit = (mode: "auto" | "steer" | "followUp") => {
      props.onSubmit(text, mode);
      setText("");
      setDismissed(false);
      setSel(0);
      if (props.taRef.current) props.taRef.current.style.height = "auto";
    };

    return (
      <div className="composer">
        <div className="composer-input">
          {open && (
            <div className="cmd-menu">
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
            placeholder={props.streaming ? "Enter = steer · Alt+Enter = follow-up · Shift+Enter = newline" : "Message Pi…  (/ for commands)"}
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
        <button disabled={props.disabled || !text.trim()} onClick={() => submit(props.streaming ? "steer" : "auto")}>
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

function ScopeBadge({ scope }: { scope?: string }) {
  if (!scope) return null;
  const label = scope === "user" ? "global" : scope;
  return <span className={`scope-badge scope-${scope}`}>{label}</span>;
}

function ResourcesModal(props: { r: ReturnType<typeof useResources>; inSession: boolean; onClose: () => void }) {
  const { r } = props;
  const isGlobal = r.mode === "global";
  const managedScope = isGlobal ? "user" : "project";
  const [source, setSource] = useState("");
  const d: ResourceList = r.data ?? { skills: [], extensions: [], prompts: [], packages: [] };

  const managedPkgs = d.packages.filter((p) => p.scope === managedScope);
  const inheritedPkgs = isGlobal ? [] : d.packages.filter((p) => p.scope === "user");
  const installedDirs = new Set(managedPkgs.map((p) => basename(p.source)));
  const managed = (items: ResourceItem[]) => items.filter((i) => i.scope === managedScope);
  const inherited = (items: ResourceItem[]) => (isGlobal ? [] : items.filter((i) => i.scope === "user"));

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal resources-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{isGlobal ? "Global extensions & skills" : "Project extensions & skills"}</div>
        <div className="muted" style={{ marginBottom: 12 }}>
          {isGlobal ? "Available in every project" : `${basename(r.workspace)} — this project only`}
        </div>

        {r.error && <div className="res-error">{r.error}</div>}
        {r.busy && <div className="muted">{r.busy}</div>}

        <div className="theme-section">Add a preset</div>
        <div className="preset-list">
          {SUITE_PRESETS.map((p) => (
            <div key={p.dir} className="res-row">
              <div className="res-main"><span className="res-name">{p.name}</span><span className="res-desc">{p.desc}</span></div>
              {installedDirs.has(p.dir)
                ? <span className="muted">installed</span>
                : <button onClick={() => r.install(p.source)}>Install</button>}
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

        {managedPkgs.length > 0 && (
          <>
            <div className="theme-section">Installed plugins</div>
            {managedPkgs.map((p: PackageItem) => (
              <div key={`${p.scope}:${p.source}`} className="res-row">
                <div className="res-main"><span className="res-name">{basename(p.source)}</span><span className="res-desc">{p.source}</span></div>
                <button className="secondary" onClick={() => r.remove(p.source, managedScope === "user" ? "global" : "project")}>Remove</button>
              </div>
            ))}
          </>
        )}

        <ResourceGroup title="Extensions" items={managed(d.extensions)} render={(e) => e.commands?.length ? `commands: ${e.commands.join(", ")}` : ""} />
        <ResourceGroup title="Skills" items={managed(d.skills)} render={(s) => s.description ?? ""} />
        <ResourceGroup title="Prompts" items={managed(d.prompts)} render={(p) => p.description ?? ""} />

        {!isGlobal && (inheritedPkgs.length + inherited(d.extensions).length + inherited(d.skills).length > 0) && (
          <>
            <div className="theme-section">Inherited from global <span className="muted">(manage in Home)</span></div>
            {inheritedPkgs.map((p) => (
              <div key={`g:${p.source}`} className="res-row"><div className="res-main"><span className="res-name">{basename(p.source)}</span></div><ScopeBadge scope="user" /></div>
            ))}
            {[...inherited(d.extensions), ...inherited(d.skills)].map((i) => (
              <div key={`g:${i.name}:${i.path ?? ""}`} className="res-row"><div className="res-main"><span className="res-name">{i.name}</span><span className="res-desc">{i.description ?? (i.commands?.length ? `commands: ${i.commands.join(", ")}` : "")}</span></div><ScopeBadge scope="user" /></div>
            ))}
          </>
        )}

        {isGlobal && (
          <>
            <div className="theme-section">Global skills folder</div>
            <label className="tune-row">
              <input type="checkbox" checked={!!r.config.shareAgentsDir} onChange={(e) => r.setShareAgents(e.target.checked)} />
              <span>Use my <code>~/.agents</code> skills (shared with other CLI agents)</span>
            </label>
          </>
        )}

        <div className="modal-actions">
          {r.dirty && props.inSession && <button className="primary" onClick={r.reload}>Reload session to apply</button>}
          <button onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function ResourceGroup({ title, items, render }: { title: string; items: ResourceItem[]; render: (i: ResourceItem) => string }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <div className="theme-section">{title}</div>
      {items.map((i) => (
        <div key={`${i.scope}:${i.name}:${i.path ?? ""}`} className="res-row">
          <div className="res-main"><span className="res-name">{i.name}</span><span className="res-desc">{render(i)}</span></div>
        </div>
      ))}
    </>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
}

type KV = { k: string; v: string };

function CustomConnectorForm(props: { existingIds: string[]; onSave: (s: ConnectorServer) => void; onCancel: () => void }) {
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [pairs, setPairs] = useState<KV[]>([{ k: "", v: "" }]);

  const setPair = (i: number, patch: Partial<KV>) => setPairs((p) => p.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addPair = () => setPairs((p) => [...p, { k: "", v: "" }]);
  const removePair = (i: number) => setPairs((p) => p.filter((_, idx) => idx !== i));

  const valid = label.trim() && (transport === "stdio" ? command.trim() : url.trim());

  const save = () => {
    const id = slugify(label);
    const kv: Record<string, string> = {};
    for (const { k, v } of pairs) if (k.trim()) kv[k.trim()] = v;
    const server: ConnectorServer = transport === "stdio"
      ? { id, label: label.trim(), transport: "stdio", command: command.trim(), args: argsText.split(/\s+/).filter(Boolean), env: kv, enabled: true }
      : { id, label: label.trim(), transport: "http", url: url.trim(), headers: kv, enabled: true };
    props.onSave(server);
  };

  return (
    <div className="connector-form">
      <label className="conn-field"><span>Name</span><input placeholder="My MCP server" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <div className="conn-transport">
        <label><input type="radio" checked={transport === "stdio"} onChange={() => setTransport("stdio")} /> Local command (stdio)</label>
        <label><input type="radio" checked={transport === "http"} onChange={() => setTransport("http")} /> Remote URL (HTTP)</label>
      </div>
      {transport === "stdio" ? (
        <>
          <label className="conn-field"><span>Command</span><input placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} /></label>
          <label className="conn-field"><span>Arguments</span><input placeholder="-y @scope/mcp-server" value={argsText} onChange={(e) => setArgsText(e.target.value)} /></label>
        </>
      ) : (
        <label className="conn-field"><span>Server URL</span><input placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
      )}
      <div className="conn-field"><span>{transport === "stdio" ? "Environment variables (tokens)" : "Headers"}</span>
        {pairs.map((row, i) => (
          <div key={i} className="kv-row">
            <input placeholder={transport === "stdio" ? "SOME_TOKEN" : "Authorization"} value={row.k} onChange={(e) => setPair(i, { k: e.target.value })} />
            <input type="password" placeholder="value" value={row.v} onChange={(e) => setPair(i, { v: e.target.value })} />
            <button className="secondary" onClick={() => removePair(i)} title="Remove">✕</button>
          </div>
        ))}
        <button className="link" onClick={addPair}>+ add</button>
      </div>
      <div className="modal-actions">
        <button disabled={!valid} onClick={save}>Save</button>
        <button className="secondary" onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ConnectorsModal(props: { c: ReturnType<typeof useConnectors>; inSession: boolean; onClose: () => void }) {
  const { c } = props;
  const isGlobal = c.mode === "global";
  const [adding, setAdding] = useState<string | null>(null); // preset id being configured
  const [fields, setFields] = useState<Record<string, string>>({});
  const preset = CONNECTOR_PRESETS.find((p) => p.id === adding);

  const startAdd = (id: string) => { setAdding(id); setFields({}); };
  const saveAdd = () => {
    if (!preset) return;
    const env: Record<string, string> = {};
    for (const f of preset.fields) if (fields[f.env]?.trim()) env[f.env] = fields[f.env].trim();
    const server: ConnectorServer = { id: preset.id, label: preset.label, transport: "stdio", command: preset.command, args: preset.args, env, enabled: true };
    c.upsert(server);
    setAdding(null);
    setFields({});
  };
  const missingRequired = preset ? preset.fields.some((f) => f.required && !fields[f.env]?.trim()) : false;

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal resources-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{isGlobal ? "Global connectors" : "Project connectors"}</div>
        <div className="muted" style={{ marginBottom: 12 }}>
          {isGlobal ? "MCP servers available in every project" : `${basename(c.folder ?? "")} — this project only`}
        </div>

        {c.error && <div className="res-error">{c.error}</div>}
        {c.busy && <div className="muted">{c.busy}</div>}

        {c.servers.length > 0 && (
          <>
            <div className="theme-section">Configured</div>
            {c.servers.map((s) => (
              <div key={s.id} className="res-row">
                <label className="tune-row" style={{ flex: 1 }}>
                  <input type="checkbox" checked={s.enabled !== false} onChange={() => c.toggle(s.id)} />
                  <span className="res-name">{s.label ?? s.id}</span>
                </label>
                <button className="secondary" onClick={() => c.removeServer(s.id)}>Remove</button>
              </div>
            ))}
          </>
        )}

        <div className="theme-section">Add a connector</div>
        {adding === "__custom__" ? (
          <CustomConnectorForm
            existingIds={c.servers.map((s) => s.id)}
            onSave={(server) => { c.upsert(server); setAdding(null); }}
            onCancel={() => setAdding(null)}
          />
        ) : adding ? (
          <div className="connector-form">
            <div className="res-name">{preset?.label}</div>
            {preset?.fields.map((f) => (
              <label key={f.env} className="conn-field">
                <span>{f.label}</span>
                <input type="password" placeholder={f.placeholder} value={fields[f.env] ?? ""} onChange={(e) => setFields((v) => ({ ...v, [f.env]: e.target.value }))} />
              </label>
            ))}
            <div className="modal-actions">
              <button disabled={missingRequired} onClick={saveAdd}>Save</button>
              <button className="secondary" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="preset-list">
            {CONNECTOR_PRESETS.map((p) => (
              <div key={p.id} className="res-row">
                <div className="res-main"><span className="res-name">{p.label}</span><span className="res-desc">Needs {p.fields.filter((f) => f.required).map((f) => f.label).join(", ")}</span></div>
                <button onClick={() => startAdd(p.id)}>{c.servers.some((s) => s.id === p.id) ? "Reconfigure" : "Add"}</button>
              </div>
            ))}
            <div className="res-row">
              <div className="res-main"><span className="res-name">Custom…</span><span className="res-desc">Any MCP server — a local command or a remote URL</span></div>
              <button onClick={() => setAdding("__custom__")}>Add</button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          {c.dirty && props.inSession && <button className="primary" onClick={c.reload}>Reload session to apply</button>}
          <button onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function ThemeModal(props: {
  theme: ThemeState;
  onPreset: (name: string) => void;
  onOverride: (token: ThemeToken, value: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const vars = resolveVars(props.theme);
  const hasTweaks = Object.keys(props.theme.overrides).length > 0;
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal theme-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Theme</div>

        <div className="theme-section">Presets</div>
        <div className="preset-grid">
          {Object.entries(PRESETS).map(([name, v]) => (
            <button
              key={name}
              className={`preset-card ${props.theme.preset === name ? "active" : ""}`}
              onClick={() => props.onPreset(name)}
            >
              <span className="preset-swatch" style={{ background: v.bg, borderColor: v.border }}>
                <span style={{ background: v.accent }} />
                <span style={{ background: v.fg }} />
                <span style={{ background: v.panel }} />
              </span>
              <span className="preset-name">{name}</span>
            </button>
          ))}
        </div>

        <div className="theme-section">
          Fine-tune
          {hasTweaks && <button className="link" onClick={props.onReset}>reset tweaks</button>}
        </div>
        <div className="tune-grid">
          {THEME_TOKENS.map(({ key, label }) => (
            <label key={key} className="tune-row">
              <input
                type="color"
                value={vars[key]}
                onChange={(e) => props.onOverride(key, e.target.value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="modal-actions">
          <button onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function DialogModal(props: { dialog: UiDialog; onRespond: (r: Record<string, unknown>) => void }) {
  const d = props.dialog;
  const [text, setText] = useState(d.prefill ?? "");
  const cancel = () => props.onRespond({ type: "extension_ui_response", id: d.id, cancelled: true });
  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{d.title}</div>
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
      </div>
    </div>
  );
}

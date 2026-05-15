import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HashRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { dropChat, loadChat, saveChat } from './cache';
import { Api, bootstrapToken, clearToken, getToken, setToken, wsUrl, type ProjectInfo, type TabInfo, type TimelineEntry } from './api';
import { createMessageReducer, type UiEntry } from './messages';

// HashRouter (URL fragment) instead of BrowserRouter so reload from any view
// works without server-side rewrites — the static file server (web-server.js)
// only knows /index.html, /assets/*; deep paths like /project/<id>/chat/<tabId>
// would need an SPA fallback. With #/projects/.../chat/... the path is always
// /index.html and React Router reads the fragment client-side.
//
// Routes:
//   #/                              → projects list (login if no token)
//   #/login                         → token entry
//   #/projects/:projectId           → tabs list of project
//   #/projects/:projectId/chat/:tabId  → chat view of a tab
//   #/projects/:projectId/chat/:tabId?ro=1  → read-only chat (no composer)

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/projects" element={<ProjectsRoute />} />
        <Route path="/projects/:projectId" element={<ProjectRoute />} />
        <Route path="/projects/:projectId/chat/:tabId" element={<ChatRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}

function RootRedirect() {
  return <Navigate to={bootstrapToken() ? '/projects' : '/login'} replace />;
}

function LoginRoute() {
  const navigate = useNavigate();
  return <LoginView onLogin={() => navigate('/projects', { replace: true })} />;
}

function ProjectsRoute() {
  const navigate = useNavigate();
  return (
    <ProjectsView
      onPick={(p) => navigate(`/projects/${encodeURIComponent(p.id)}`)}
      onLogout={() => { clearToken(); navigate('/login', { replace: true }); }}
    />
  );
}

function ProjectRoute() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<{ project: { id: string; name: string; path: string }; tabs: TabInfo[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await Api.listTabs(projectId);
      setData({ project: list.project, tabs: list.tabs });
    } catch (e: any) {
      setError(e?.message || 'failed to load project');
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (error) return (
    <div style={S.page}>
      <div style={{ padding: 20, color: '#f38ba8' }}>
        Failed: {error}
        <div style={{ marginTop: 12 }}>
          <button onClick={() => navigate('/projects')} style={S.primaryBtn}>Back</button>
        </div>
      </div>
    </div>
  );
  if (!data) return <div style={S.page}><div style={{ padding: 20, color: '#888' }}>Loading…</div></div>;

  return (
    <ProjectView
      project={data.project}
      tabs={data.tabs}
      onBack={() => navigate('/projects')}
      onOpenChat={(tab, opts) => {
        const ro = opts?.readOnly ? '?ro=1' : '';
        navigate(`/projects/${encodeURIComponent(projectId!)}/chat/${encodeURIComponent(tab.tabId!)}${ro}`, {
          state: { tab },
        });
      }}
      onCreated={refresh}
    />
  );
}

function ChatRoute() {
  const { projectId, tabId } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabInfo | null>(() => {
    // history.state may carry the tab object if user navigated from project view —
    // saves us a roundtrip and lets ChatView mount with full TabInfo immediately.
    const st = (window.history.state as any)?.usr?.tab;
    return st || null;
  });
  const [error, setError] = useState<string | null>(null);
  const ro = new URLSearchParams(window.location.hash.split('?')[1] || '').get('ro') === '1';

  useEffect(() => {
    // Reload-fallback: if we landed here via a deep-link (no state.tab), pull
    // tabs from the server and pick the matching one. Once we have it, render.
    if (tab || !projectId || !tabId) return;
    let cancelled = false;
    Api.listTabs(projectId)
      .then((d) => {
        if (cancelled) return;
        const found = (d.tabs || []).find((t) => t.tabId === tabId);
        if (found) setTab(found);
        else setError('Tab not found in project. It may have been closed.');
      })
      .catch((e) => { if (!cancelled) setError(e?.message || 'failed to load tab'); });
    return () => { cancelled = true; };
  }, [projectId, tabId, tab]);

  if (error) return (
    <div style={S.page}>
      <div style={{ padding: 20, color: '#f38ba8' }}>
        {error}
        <div style={{ marginTop: 12 }}>
          <button onClick={() => navigate(`/projects/${encodeURIComponent(projectId!)}`)} style={S.primaryBtn}>
            Back to project
          </button>
        </div>
      </div>
    </div>
  );
  if (!tab) return <div style={S.page}><div style={{ padding: 20, color: '#888' }}>Loading…</div></div>;

  return (
    <ChatView
      tab={tab}
      readOnly={ro}
      onBack={() => navigate(`/projects/${encodeURIComponent(projectId!)}`)}
    />
  );
}

// ────────── Long-press hook ──────────
// Telegram-style: hold finger for ~500ms while staying within ~10px of the
// initial touch point. During the hold, expose `progress` (0..1) so the row
// can render a fill/scale animation. Cancel on move-out / scroll / lift.
type LongPressState = { active: boolean; progress: number };
function useLongPress(onTrigger: () => void, opts?: { ms?: number; tolerance?: number }) {
  const ms = opts?.ms ?? 350; // ~30% faster than the iOS-default 500ms — feels snappier
  const tolerance = opts?.tolerance ?? 12;
  const [state, setState] = useState<LongPressState>({ active: false, progress: 0 });
  const startRef = useRef<{ x: number; y: number; t0: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const triggeredRef = useRef(false);

  const cleanup = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startRef.current = null;
    setState({ active: false, progress: 0 });
  };

  const tick = () => {
    const s = startRef.current;
    if (!s) return;
    const elapsed = performance.now() - s.t0;
    const p = Math.min(1, elapsed / ms);
    setState({ active: true, progress: p });
    if (p >= 1 && !triggeredRef.current) {
      triggeredRef.current = true;
      // Haptic feedback if supported
      try { if (navigator.vibrate) navigator.vibrate(15); } catch {}
      onTrigger();
      cleanup();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      // Only primary button / single touch
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      triggeredRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY, t0: performance.now() };
      setState({ active: true, progress: 0 });
      rafRef.current = requestAnimationFrame(tick);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (Math.hypot(dx, dy) > tolerance) cleanup();
    },
    onPointerUp: () => cleanup(),
    onPointerCancel: () => cleanup(),
    onPointerLeave: () => cleanup(),
    onContextMenu: (e: React.MouseEvent) => {
      // Long-press on iOS shows the system text-selection menu by default.
      // Block it so our action sheet is the only thing the user sees.
      e.preventDefault();
    },
  };

  return { state, handlers, didTrigger: () => triggeredRef.current };
}

// ────────── Action Sheet (bottom modal, iOS-style) ──────────
type SheetAction = { label: string; danger?: boolean; icon?: string; onPress: () => void };
function ActionSheet({ title, subtitle, actions, onDismiss }: {
  title: string;
  subtitle?: string;
  actions: SheetAction[];
  onDismiss: () => void;
}) {
  // Swipe-down to dismiss. Track Y delta from initial touch on the sheet body;
  // translate the sheet during drag, dismiss when delta > 80px on release.
  // Negative delta is clamped to 0 so the sheet can't be pulled UP.
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef<number | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    // Only initiate from the top of the sheet (handle area). Reading
    // currentTarget bbox keeps the threshold proportional to sheet height.
    startY.current = e.clientY;
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startY.current == null) return;
    const dy = e.clientY - startY.current;
    setDragY(Math.max(0, dy));
  };
  const onPointerUp = () => {
    if (dragY > 80) onDismiss();
    else setDragY(0);
    startY.current = null;
    setDragging(false);
  };

  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, background: `rgba(0,0,0,${0.55 - Math.min(0.4, dragY / 400)})`,
        zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        animation: dragging ? 'none' : 'noted-fade-in 0.18s ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480,
          background: '#1a1a1a', borderRadius: '18px 18px 0 0',
          padding: '8px 8px max(20px, env(safe-area-inset-bottom)) 8px',
          animation: dragging ? 'none' : 'noted-sheet-up 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? 'none' : 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            // Wider drag zone — full top of sheet, not just the visual pill.
            padding: '8px 0 4px', cursor: 'grab', touchAction: 'none',
          }}
        >
          <div style={{
            width: 36, height: 4, background: '#444', borderRadius: 999,
            margin: '0 auto 12px',
          }} />
        </div>
        {(title || subtitle) && (
          <div style={{ padding: '4px 16px 12px', borderBottom: '1px solid #232323' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{subtitle}</div>}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {actions.map((a, i) => (
            <button
              key={i}
              onClick={() => { a.onPress(); }}
              style={{
                width: '100%', padding: '14px 16px',
                background: 'transparent', border: 'none',
                borderBottom: i < actions.length - 1 ? '1px solid #232323' : 'none',
                color: a.danger ? '#f38ba8' : '#e0e0e0',
                fontSize: 15, textAlign: 'left',
                display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
              }}
            >
              {a.icon && <span style={{ fontSize: 16, color: a.danger ? '#f38ba8' : '#888' }}>{a.icon}</span>}
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ────────── Rename dialog (simple inline modal) ──────────
function RenameDialog({ initial, onSubmit, onDismiss }: {
  initial: string;
  onSubmit: (name: string) => void;
  onDismiss: () => void;
}) {
  const [v, setV] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: 360, background: '#1a1a1a',
        borderRadius: 16, padding: 16, border: '1px solid #2a2a2a',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0', marginBottom: 10 }}>Rename tab</div>
        <input
          ref={inputRef}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && v.trim()) onSubmit(v.trim());
            if (e.key === 'Escape') onDismiss();
          }}
          style={{ ...S.input, width: '100%' }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            onClick={onDismiss}
            style={{ flex: 1, padding: '10px', background: '#252525', border: 'none',
              borderRadius: 10, color: '#aaa', fontSize: 14, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={() => v.trim() && onSubmit(v.trim())}
            disabled={!v.trim() || v.trim() === initial}
            style={{ flex: 1, padding: '10px', background: '#FFB382', border: 'none',
              borderRadius: 10, color: '#1a1a1a', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────── Tab rows ──────────
function SDKTabRow({ tab, onTap, onLongPress }: { tab: TabInfo; onTap: () => void; onLongPress: () => void }) {
  const lp = useLongPress(onLongPress);
  const live = !!tab.live;
  return (
    <button
      {...lp.handlers}
      onClick={() => { if (!lp.didTrigger()) onTap(); }}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: '12px 14px', borderRadius: 12,
        marginBottom: 8,
        background: live
          ? 'linear-gradient(180deg, rgba(255,178,130,0.08) 0%, rgba(255,178,130,0.03) 100%), #181210'
          : 'linear-gradient(180deg, rgba(255,178,130,0.03) 0%, transparent 100%), #1a1715',
        border: live ? '1px solid rgba(255,178,130,0.45)' : '1px solid rgba(255,178,130,0.18)',
        color: 'inherit', position: 'relative', overflow: 'hidden',
        transform: lp.state.active ? `scale(${1 - lp.state.progress * 0.04})` : undefined,
        transition: lp.state.active ? 'none' : 'transform 0.15s',
      }}
    >
      {/* Long-press progress fill */}
      {lp.state.active && (
        <span style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at center, rgba(255,178,130,${lp.state.progress * 0.25}) 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
        <span style={{
          width: 9, height: 9, borderRadius: 999,
          background: live ? '#FFB382' : '#5a5a5a',
          boxShadow: live ? '0 0 8px rgba(255,178,130,0.7)' : 'none',
          ...(live ? { animation: 'noted-live-pulse 1.6s ease-in-out infinite' } : {}),
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 10, color: '#FFB382', textTransform: 'uppercase', letterSpacing: 0.5,
          background: 'rgba(255,178,130,0.12)', padding: '2px 6px', borderRadius: 4, fontWeight: 600,
        }}>SDK</span>
        <span style={{ flex: 1, fontSize: 14, color: '#f0e8e0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tab.name}
        </span>
        {live && <span style={{ fontSize: 10, color: '#FFB382' }}>live</span>}
        {typeof tab.timelineCount === 'number' && tab.timelineCount > 0 && (
          <span style={{
            fontSize: 11, color: '#a6e3a1',
            background: 'rgba(166,227,161,0.10)',
            padding: '2px 7px', borderRadius: 999,
            fontWeight: 500, fontVariantNumeric: 'tabular-nums',
          }}>
            {tab.timelineCount}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: '#776a60', marginTop: 4, position: 'relative' }}>
        {tab.claudeSessionId ? `${tab.claudeSessionId.slice(0, 8)}…` : 'no session yet'}
      </div>
    </button>
  );
}

function TerminalTabRow({ tab, onTap, onLongPress }: { tab: TabInfo; onTap: () => void; onLongPress: () => void }) {
  const lp = useLongPress(onLongPress);
  const isClaude = tab.commandType === 'claude' || !!tab.claudeSessionId;
  const isGemini = tab.commandType === 'gemini' || !!(tab as any).geminiSessionId;
  const isDev = tab.commandType === 'devServer';
  const accentColor = isClaude ? '#DA7756' : isGemini ? '#88c0d0' : isDev ? '#a6e3a1' : '#888';
  const labelText = isClaude ? 'CLAUDE' : isGemini ? 'GEMINI' : isDev ? 'DEV' : 'TERMINAL';

  return (
    <button
      {...lp.handlers}
      onClick={() => { if (!lp.didTrigger()) onTap(); }}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: '12px 14px', borderRadius: 12,
        marginBottom: 8,
        background: '#141414',
        border: '1px solid #232323',
        color: 'inherit', position: 'relative', overflow: 'hidden',
        transform: lp.state.active ? `scale(${1 - lp.state.progress * 0.04})` : undefined,
        transition: lp.state.active ? 'none' : 'transform 0.15s',
      }}
    >
      {lp.state.active && (
        <span style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at center, rgba(255,255,255,${lp.state.progress * 0.08}) 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
        <span style={{ width: 9, height: 9, borderRadius: 999, background: accentColor, opacity: 0.8, flexShrink: 0 }} />
        <span style={{
          fontSize: 10, color: accentColor, textTransform: 'uppercase', letterSpacing: 0.5,
          background: `${accentColor}1f`, padding: '2px 6px', borderRadius: 4, fontWeight: 600,
        }}>{labelText}</span>
        <span style={{ flex: 1, fontSize: 14, color: '#cccccc', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tab.name}
        </span>
        {typeof tab.timelineCount === 'number' && tab.timelineCount > 0 && (
          <span style={{
            fontSize: 11, color: '#a6e3a1',
            background: 'rgba(166,227,161,0.10)',
            padding: '2px 7px', borderRadius: 999,
            fontWeight: 500, fontVariantNumeric: 'tabular-nums',
          }}>
            {tab.timelineCount}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: '#555', marginTop: 4, position: 'relative' }}>
        {tab.claudeSessionId ? `${tab.claudeSessionId.slice(0, 8)}…` : (tab.cwd ? tab.cwd.split('/').slice(-2).join('/') : 'tap to view')}
      </div>
    </button>
  );
}

// ────────── Login ──────────

function LoginView({ onLogin }: { onLogin: () => void }) {
  const [token, setTokenInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setError('');
    setToken(token.trim());
    try {
      await Api.ping();
      onLogin();
    } catch (e: any) {
      setError(e.message || 'auth failed');
      setBusy(false);
    }
  };

  return (
    <div style={S.page}>
      <div style={S.loginBox}>
        <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>Noted SDK</div>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 24 }}>
          Paste the bearer token printed by Electron at startup.
        </div>
        <input
          type="text"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="bearer token"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={S.input}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        {error && <div style={{ color: '#f38ba8', fontSize: 12, marginTop: 8 }}>{error}</div>}
        <button onClick={submit} disabled={busy || !token.trim()} style={S.primaryBtn}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
        <div style={{ marginTop: 24, fontSize: 11, color: '#555' }}>
          The token is stored only in this browser (localStorage).
        </div>
      </div>
    </div>
  );
}

// ────────── Projects list ──────────

function ProjectsView({ onPick, onLogout }: { onPick: (p: ProjectInfo) => void; onLogout: () => void }) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

  // Refresh every 4s while view is mounted so live SDK / open-state stays
  // current without the user having to pull-to-refresh.
  useEffect(() => {
    let cancelled = false;
    let t: number;
    const load = () => {
      Api.listProjects()
        .then((d) => { if (!cancelled) setProjects(d.projects); })
        .catch((e) => { if (!cancelled) setError(e.message); });
    };
    load();
    t = window.setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const active = (projects || []).filter((p) => p.isOpen);
  const inactive = (projects || []).filter((p) => !p.isOpen);
  // Active projects: most-recently active (the desktop-active one) on top, rest by updatedAt.
  // updatedAt is a unix-seconds INTEGER from SQLite — sort numerically; fall back to 0 so
  // a missing value doesn't NaN the comparator.
  const ts = (p: ProjectInfo) => Number(p.updatedAt || 0);
  active.sort((a, b) => {
    if (a.isActive && !b.isActive) return -1;
    if (!a.isActive && b.isActive) return 1;
    return ts(b) - ts(a);
  });
  inactive.sort((a, b) => ts(b) - ts(a));

  return (
    <div style={S.page}>
      <Header
        title="Projects"
        subtitle={projects ? `${active.length} active · ${projects.length} total` : undefined}
        right={
          <button
            onClick={onLogout}
            title="Sign out"
            style={{
              padding: '6px 12px', borderRadius: 8,
              background: 'transparent', border: '1px solid #2a2a2a',
              color: '#888', fontSize: 11, cursor: 'pointer',
              fontWeight: 500, letterSpacing: 0.3,
            }}
          >
            Sign out
          </button>
        }
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 32px' }}>
        {error && <div style={{ padding: 16, color: '#f38ba8' }}>Error: {error}</div>}
        {!projects && !error && (
          <div style={{ padding: 32, color: '#666', fontSize: 13, textAlign: 'center' }}>Loading projects…</div>
        )}

        {projects && active.length > 0 && (
          <>
            <SectionHeader>Active</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {active.map((p) => <ProjectCard key={p.id} project={p} prominent onClick={() => onPick(p)} />)}
            </div>
          </>
        )}

        {projects && active.length === 0 && (
          <div style={{
            padding: '20px 16px', marginBottom: 16, borderRadius: 12,
            background: '#141414', border: '1px solid #1f1f1f',
            fontSize: 12, color: '#666', textAlign: 'center',
          }}>
            No projects open in desktop right now.
          </div>
        )}

        {projects && inactive.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <button
              onClick={() => setShowAll((v) => !v)}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 10,
                background: showAll ? '#161616' : 'transparent',
                border: '1px solid #1f1f1f',
                color: '#888', fontSize: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 0.5,
              }}
            >
              <span>All projects · {inactive.length}</span>
              <span style={{ fontSize: 11, transform: showAll ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
            </button>
            {showAll && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                {inactive.map((p) => <ProjectCard key={p.id} project={p} prominent={false} onClick={() => onPick(p)} />)}
              </div>
            )}
          </div>
        )}

        {projects && projects.length === 0 && (
          <div style={{ padding: 24, color: '#555', textAlign: 'center', fontSize: 13 }}>No projects yet.</div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: any }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '4px 4px 10px', fontSize: 11,
      color: '#666', textTransform: 'uppercase', letterSpacing: 0.8,
    }}>
      <span>{children}</span>
      <span style={{ flex: 1, height: 1, background: '#1f1f1f' }} />
    </div>
  );
}

function ProjectCard({ project, prominent, onClick }: { project: ProjectInfo; prominent: boolean; onClick: () => void }) {
  const hasLive = project.liveSdkCount > 0;
  // Compact (collapsed-section) variant — single line, smaller. Prominent — full card.
  if (!prominent) {
    return (
      <button onClick={onClick} style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: '10px 12px', borderRadius: 10,
        background: '#0f0f0f', border: '1px solid #181818',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        color: 'inherit',
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, color: '#cccccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {project.name}
          </div>
          <div style={{ fontSize: 10, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
            {project.path}
          </div>
        </div>
        {project.sdkTabCount > 0 && (
          <span style={{ fontSize: 10, color: '#777' }}>{project.sdkTabCount} SDK</span>
        )}
      </button>
    );
  }

  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left', cursor: 'pointer',
      padding: '14px 14px 12px', borderRadius: 14,
      background: hasLive ? 'linear-gradient(180deg, rgba(255,178,130,0.06) 0%, #131313 100%)' : '#141414',
      border: hasLive ? '1px solid rgba(255,178,130,0.35)' : '1px solid #232323',
      boxShadow: hasLive ? '0 0 0 1px rgba(255,178,130,0.08), 0 8px 24px -16px rgba(255,178,130,0.4)' : 'none',
      color: 'inherit', position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 9, height: 9, borderRadius: 999,
          background: hasLive ? '#FFB382' : '#5a8a5a',
          boxShadow: hasLive ? '0 0 8px rgba(255,178,130,0.7)' : 'none',
          flexShrink: 0,
          ...(hasLive ? { animation: 'noted-live-pulse 1.6s ease-in-out infinite' } : {}),
        }} />
        <div style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#f0f0f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.name}
        </div>
        {project.isActive && (
          <span title="Currently active in desktop" style={{ fontSize: 11, color: '#FFB382' }}>★</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: '#666', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {project.path}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 11, flexWrap: 'wrap' }}>
        {hasLive && (
          <span style={{ ...S.peachPill, background: 'rgba(255,178,130,0.18)' }}>
            ◆ {project.liveSdkCount} live
          </span>
        )}
        {project.sdkTabCount > 0 && (
          <span style={{ color: '#aaa' }}>{project.sdkTabCount} SDK</span>
        )}
        <span style={{ color: '#666' }}>{project.tabCount} {project.tabCount === 1 ? 'tab' : 'tabs'}</span>
      </div>
    </button>
  );
}

// ────────── Project tabs list ──────────

function ProjectView(props: {
  project: { id: string; name: string; path: string };
  tabs: TabInfo[];
  onBack: () => void;
  onOpenChat: (t: TabInfo, opts?: { readOnly?: boolean }) => void;
  onCreated: () => void;
}) {
  const { project, tabs, onBack, onOpenChat, onCreated } = props;
  const [creating, setCreating] = useState(false);
  const [actionTarget, setActionTarget] = useState<{ tab: TabInfo; kind: 'sdk' | 'terminal' } | null>(null);
  const [renameTarget, setRenameTarget] = useState<TabInfo | null>(null);

  const sdkTabs = tabs.filter((t) => t.tabType === 'claude-sdk' && t.tabId);
  const otherTabs = tabs.filter((t) => t.tabType !== 'claude-sdk' && t.tabId);

  const create = async () => {
    setCreating(true);
    try {
      await Api.createSDKTab(project.id);
      await onCreated();
    } catch (e: any) {
      alert('Create failed: ' + e.message);
    } finally {
      setCreating(false);
    }
  };

  const closeSheet = () => setActionTarget(null);

  const onSDKAction = async (kind: 'stop' | 'close' | 'rename') => {
    if (!actionTarget?.tab.tabId) return;
    const t = actionTarget.tab;
    if (kind === 'rename') {
      closeSheet();
      setRenameTarget(t);
      return;
    }
    closeSheet();
    try {
      if (kind === 'stop') await Api.stop(t.tabId!);
      else if (kind === 'close') await Api.close(t.tabId!);
      await onCreated();
    } catch (e: any) {
      alert('Failed: ' + e.message);
    }
  };

  const onTerminalAction = async (kind: 'fork' | 'view' | 'close') => {
    if (!actionTarget?.tab.tabId) return;
    const t = actionTarget.tab;
    closeSheet();
    try {
      if (kind === 'view') {
        onOpenChat(t, { readOnly: true });
      } else if (kind === 'fork') {
        const r = await Api.forkToSDK(t.tabId!);
        await onCreated();
        // Navigate straight into the new SDK tab
        const updatedTabs = await Api.listTabs(project.id);
        const newTab = updatedTabs.tabs.find(x => x.tabId === r.tabId);
        if (newTab) onOpenChat(newTab);
      } else if (kind === 'close') {
        await Api.close(t.tabId!);
        await onCreated();
      }
    } catch (e: any) {
      alert('Failed: ' + e.message);
    }
  };

  const submitRename = async (name: string) => {
    if (!renameTarget?.tabId) return;
    const t = renameTarget;
    setRenameTarget(null);
    try {
      await Api.rename(t.tabId!, name);
      await onCreated();
    } catch (e: any) {
      alert('Rename failed: ' + e.message);
    }
  };

  return (
    <div style={S.page}>
      <Header
        title={project.name}
        left={<button className="noted-icon" style={S.iconBtn} onClick={onBack}>←</button>}
        subtitle={project.path}
      />
      <div style={{ padding: 12 }}>
        <button onClick={create} disabled={creating} style={S.primaryBtn}>
          {creating ? 'Creating…' : '+ New SDK chat'}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 32px' }}>
        <SectionHeader>SDK tabs</SectionHeader>
        {sdkTabs.length === 0 && <Empty>No SDK chats yet — tap «+ New SDK chat» above. Long-press other tabs to fork into SDK.</Empty>}
        {sdkTabs.map((t) => (
          <SDKTabRow
            key={t.tabId}
            tab={t}
            onTap={() => onOpenChat(t)}
            onLongPress={() => setActionTarget({ tab: t, kind: 'sdk' })}
          />
        ))}

        <SectionHeader>Terminal tabs</SectionHeader>
        {otherTabs.length === 0 && <Empty>None in this project.</Empty>}
        {otherTabs.map((t) => (
          <TerminalTabRow
            key={t.tabId}
            tab={t}
            onTap={() => onOpenChat(t, { readOnly: true })}
            onLongPress={() => setActionTarget({ tab: t, kind: 'terminal' })}
          />
        ))}
      </div>

      {actionTarget && actionTarget.kind === 'sdk' && (
        <ActionSheet
          title={actionTarget.tab.name}
          subtitle={actionTarget.tab.live ? 'Streaming · session active' : 'Idle'}
          actions={[
            { label: 'Open chat', icon: '›', onPress: () => { closeSheet(); onOpenChat(actionTarget.tab); } },
            { label: 'Rename', icon: '✎', onPress: () => onSDKAction('rename') },
            ...(actionTarget.tab.live ? [{ label: 'Stop session', icon: '■', danger: true, onPress: () => onSDKAction('stop') }] : []),
            { label: 'Close tab', icon: '✕', danger: true, onPress: () => onSDKAction('close') },
          ]}
          onDismiss={closeSheet}
        />
      )}

      {actionTarget && actionTarget.kind === 'terminal' && (
        <ActionSheet
          title={actionTarget.tab.name}
          subtitle={actionTarget.tab.commandType
            ? actionTarget.tab.commandType + (actionTarget.tab.claudeSessionId ? ' · has Claude session' : '')
            : actionTarget.tab.tabType}
          actions={[
            ...(actionTarget.tab.claudeSessionId ? [{ label: 'View history (read-only)', icon: '◷', onPress: () => onTerminalAction('view') }] : []),
            ...(actionTarget.tab.claudeSessionId ? [{ label: 'Fork into SDK', icon: '⌥', onPress: () => onTerminalAction('fork') }] : []),
            { label: 'Close tab', icon: '✕', danger: true, onPress: () => onTerminalAction('close') },
          ]}
          onDismiss={closeSheet}
        />
      )}

      {renameTarget && (
        <RenameDialog
          initial={renameTarget.name}
          onSubmit={submitRename}
          onDismiss={() => setRenameTarget(null)}
        />
      )}
    </div>
  );
}

// ────────── Chat (SDK tab) ──────────

function ChatView({ tab, onBack, readOnly = false }: { tab: TabInfo; onBack: () => void; readOnly?: boolean }) {
  // Cache temporarily DISABLED — testing first-load performance from a clean
  // state. To re-enable: uncomment loadChat() and restore the read of `cached`.
  // Cache write side (saveChat in useEffect below) is also disabled for parity.
  const cached = null as { entries: UiEntry[]; timelineEntries: TimelineEntry[] | null; sessionId?: string } | null;
  const [entries, setEntries] = useState<UiEntry[]>(cached?.entries || []);
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState<boolean>(!cached && (!!tab.claudeSessionId || tab.tabType === 'claude-sdk'));
  const [sessionId, setSessionId] = useState<string | undefined>(cached?.sessionId || tab.claudeSessionId || tab.live?.sessionId);
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [text, setText] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[] | null>(cached?.timelineEntries || null);
  const [timelineExpanded, setTimelineExpanded] = useState<Set<string>>(new Set());
  const [usedTokens, setUsedTokens] = useState<number | null>(null);
  const [resolvedModel, setResolvedModel] = useState<string | null>(null);
  const [scrollOverlay, setScrollOverlay] = useState(false);
  // Windowed render: keep a SLICE of entries in DOM, not a prefix.
  // Chat opens scrolled to the END (last 30 entries) — that's where users
  // expect to be on mount, and it avoids putting 5000+ markdown blocks into
  // memory at once (Safari OOM crash → page silently reloads).
  //
  // [renderStart, renderEnd) — half-open interval over `entries`. Window grows
  // when user scrolls toward top (renderStart shrinks) or new messages arrive
  // (renderEnd grows to entries.length). GoTo shifts window to surround target.
  const INITIAL_RENDER = 30;
  const RENDER_CHUNK = 30;
  const initialEnd = cached?.entries.length || 0;
  const [renderStart, setRenderStart] = useState<number>(Math.max(0, initialEnd - INITIAL_RENDER));
  const [renderEnd, setRenderEnd] = useState<number>(initialEnd);
  // Helper to compute how much of `entries` is currently in DOM. Use in places
  // that previously read `renderedCount` linearly.
  const renderedCount = renderEnd - renderStart;
  // Whether we should auto-scroll to bottom after the initial mount paint.
  // True ONLY on first mount with non-empty cache or after history fetch lands.
  const needsBottomScrollRef = useRef(true);
  // GoTo readiness: true once renderedCount >= entries.length. Buttons disable
  // visual when chunk-render is in progress AND user might tap an unrendered
  // entry. We don't fully block — forced-render-on-tap covers that — but the
  // disabled style tells user "still loading, wait for click to feel snappy".
  const [pendingGoTo, setPendingGoTo] = useState<string | null>(null);
  // Show scroll-to-bottom button when user is more than 200px above the bottom.
  // Recomputed on every scroll event (cheap — just compares scrollTop to scrollHeight).
  const [showScrollDown, setShowScrollDown] = useState(false);
  // Tail-first loading: first fetch is `?last=200` (~1s on 5MB chats), full
  // history loads in the background. While fullLoading=true:
  //   - "Load older messages" button is disabled with a spinner
  //   - GoTo on a uuid not yet in entries shows full-screen overlay until the
  //     full set arrives (then jumps automatically)
  //   - WS messages still apply on top of tail (reducer chains by id)
  const [fullLoading, setFullLoading] = useState<boolean>(false);
  // Set when GoTo was tapped on an out-of-range uuid while fullLoading. Once
  // full arrives, we resolve this uuid and scroll to it.
  const pendingFullGoToRef = useRef<string | null>(null);
  const reducer = useRef(createMessageReducer());
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Ref to goToEntry so the full-load resolution can re-trigger a pending
  // GoTo without putting goToEntry into the deps of the load effect.
  const goToEntryRef = useRef<((uuid: string) => void) | null>(null);

  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollDown(distanceFromBottom > 200);
  }, []);

  const scrollChatToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const total = reducer.current.getEntries().length;
    // If new entries exist past the window — slide window so its tail = entries.end
    // Keep window SIZE bounded (don't grow to all-of-history): start = end - max(30, current size)
    // This protects iOS Safari from OOM crash on chats with 5000+ records.
    if (renderEnd < total) {
      const desiredSize = Math.max(INITIAL_RENDER, renderEnd - renderStart);
      const newEnd = total;
      const newStart = Math.max(0, newEnd - desiredSize);
      setRenderStart(newStart);
      setRenderEnd(newEnd);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const e = scrollRef.current;
        if (e) e.scrollTop = e.scrollHeight;
      }));
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [renderStart, renderEnd]);
  // Restore reducer's internal id-maps from cached entries so subsequent
  // streaming chunks update existing assistant/tool entries instead of pushing
  // new duplicates.
  // Reducer hydrate from cache — disabled together with cache.

  // Prefetch timeline as soon as ChatView mounts. By the time the user taps
  // the ☰ icon (a few seconds in), entries are usually already loaded.
  useEffect(() => {
    if (!tab.tabId) return;
    if (!tab.claudeSessionId && tab.tabType !== 'claude-sdk') return;
    let cancelled = false;
    Api.timeline(tab.tabId)
      .then((d) => { if (!cancelled) setTimelineEntries(d.entries || []); })
      .catch(() => { if (!cancelled) setTimelineEntries([]); });
    return () => { cancelled = true; };
  }, [tab.tabId]);

  // Refetch when a turn completes (sessionId / entries.length / busy change).
  // Uses the same `lastFetchKey` proxy the drawer used before.
  const refreshKey = `${sessionId || ''}:${entries.length}:${busy ? 1 : 0}`;
  useEffect(() => {
    if (!tab.tabId || !sessionId) return;
    // Skip first run — initial prefetch above already covers it.
    if (timelineEntries === null) return;
    let cancelled = false;
    Api.timeline(tab.tabId)
      .then((d) => { if (!cancelled) setTimelineEntries(d.entries || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const goToEntry = useCallback((uuid: string) => {
    const tStart = performance.now();
    Api.log('TimelineGoTo', 'click', { uuid: uuid.slice(0, 8) });

    // STEP 1 (synchronous, MUST happen this React commit, no batching with
    // window-shift below): close the drawer + show overlay. If we batch them
    // with the heavy setRenderStart/setRenderEnd that follows, React commits
    // all four together and the user sees nothing for 100-3000ms while the
    // huge windowed slice renders. Use flushSync so the close paints first.
    //
    // The overlay sits INSIDE the chat scroll container, not as a fixed page
    // overlay — that way the user doesn't see the chat momentarily appear
    // (with old scrollTop) before being covered.
    flushSync(() => {
      setScrollOverlay(true);
      setDrawerOpen(false);
    });

    // Find target index in entries — needed both for force-render and as
    // a guard ("doesn't exist in chat" case).
    const targetIdx = reducer.current.getEntries().findIndex(
      (e: any) => (e as any).entryUuid === uuid || (e as any).entryUuid?.startsWith(uuid.slice(0, 8))
    );
    if (targetIdx === -1) {
      // Two reasons we'd miss: (1) full-load is still in flight and the
      // target sits in the prefix we haven't received yet, OR (2) the entry
      // genuinely doesn't have a uuid we recognize. Distinguish by fullLoading.
      if (fullLoading) {
        Api.log('TimelineGoTo', 'queuedForFullLoad', { uuid: uuid.slice(0, 8) });
        pendingFullGoToRef.current = uuid;
        // Overlay STAYS visible until full history arrives — fullLoading effect
        // resolution will call goToEntry again, which will find the entry and
        // proceed normally (clearing overlay at the end).
        return;
      }
      Api.log('TimelineGoTo', 'no entry with uuid', { uuid: uuid.slice(0, 8) });
      setScrollOverlay(false);
      return;
    }

    // STEP 2 (next frame): shift the rendered window. CRITICAL — bounded slice,
    // not union with current window. If we union [tail 30] with [target=100, +60]
    // = [90, 5628] = 5538 markdown nodes one frame → 3-5s main thread block.
    // Bounded means: shrink current window AND grow toward target equally.
    const total = reducer.current.getEntries().length;
    const newStart = Math.max(0, targetIdx - 10);
    const newEnd = Math.min(total, newStart + 60);
    Api.log('TimelineGoTo', 'window', { idx: targetIdx, total, start: newStart, end: newEnd });

    requestAnimationFrame(() => {
      setRenderStart(newStart);
      setRenderEnd(newEnd);
      setPendingGoTo(uuid);

      // Wait for DOM to actually contain the anchor. We poll for up to ~1.5s
      // because force-render+layout on large pages takes multiple frames.
      let attempt = 0;
      const tryScroll = () => {
        attempt += 1;
        const root = scrollRef.current;
        if (!root) {
          if (attempt < 60) requestAnimationFrame(tryScroll);
          else { setScrollOverlay(false); setPendingGoTo(null); }
          return;
        }
        let el = root.querySelector(`[data-entry-uuid="${uuid}"]`) as HTMLElement | null;
        if (!el) {
          const all = Array.from(root.querySelectorAll('[data-entry-uuid]')) as HTMLElement[];
          el = all.find((x) => x.getAttribute('data-entry-uuid')?.startsWith(uuid.slice(0, 8))) || null;
        }
        if (!el) {
          if (attempt < 60) {
            requestAnimationFrame(tryScroll);
          } else {
            Api.log('TimelineGoTo', 'NOT FOUND after wait', {
              uuid: uuid.slice(0, 8),
              elapsedMs: Math.round(performance.now() - tStart),
              totalAnchors: root.querySelectorAll('[data-entry-uuid]').length,
            });
            setScrollOverlay(false);
            setPendingGoTo(null);
          }
          return;
        }
        let top = 0;
        let cur: HTMLElement | null = el;
        while (cur && cur !== root) {
          top += cur.offsetTop;
          cur = cur.offsetParent as HTMLElement | null;
        }
        const targetTop = Math.max(0, top - 120);
        root.scrollTop = targetTop;

        const bubble = el.querySelector('div') as HTMLElement | null;
        const target = bubble || el;
        target.style.transition = 'background 0.3s';
        const orig = target.style.background;
        target.style.background = 'rgba(255,178,130,0.22)';
        setTimeout(() => { target.style.background = orig; }, 1300);

        Api.log('TimelineGoTo', 'done', { uuid: uuid.slice(0, 8), elapsedMs: Math.round(performance.now() - tStart), attempts: attempt });
        requestAnimationFrame(() => { setScrollOverlay(false); setPendingGoTo(null); });
      };
      // Two rAFs: first for render commit, second for layout settle.
      requestAnimationFrame(() => requestAnimationFrame(tryScroll));
    });
  }, [fullLoading]);

  // Keep ref pointing at the latest goToEntry so the full-load handler can
  // call back into it without retriggering deps.
  useEffect(() => { goToEntryRef.current = goToEntry; }, [goToEntry]);

  const toggleEntryExpanded = useCallback((uuid: string) => {
    setTimelineExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid); else next.add(uuid);
      return next;
    });
  }, []);

  // Load history once on mount. If we hydrated from cache, this still runs —
  // fresh fetch replaces stale entries when it arrives. The reducer is reset
  // before re-applying so we don't mix cached and fresh entries (the JSONL is
  // source of truth — cache may be days behind if user worked on desktop).
  useEffect(() => {
    if (!tab.tabId) {
      setHistoryLoading(false);
      return;
    }
    if (!tab.claudeSessionId && tab.tabType !== 'claude-sdk') {
      setHistoryLoading(false);
      return;
    }
    let cancelled = false;
    const tabIdLocal = tab.tabId;
    const tag = tabIdLocal?.slice(-12) || '';

    // Phase 1: tail. ~200 last messages, opens chat in ~1s on heavy sessions.
    // Phase 2 (background): full history. Replaces reducer state, preserves
    // visible window so user doesn't see a jump.
    const TAIL_N = 200;
    const t0 = performance.now();

    const applyAll = async (msgs: any[]) => {
      // Reducer must be linear (assistant.id chains), can't reorder. We yield
      // every CHUNK so browser can paint loader between chunks on slow CPUs.
      const CHUNK = 500;
      reducer.current.reset();
      for (let i = 0; i < msgs.length; i += CHUNK) {
        if (cancelled) return false;
        const end = Math.min(i + CHUNK, msgs.length);
        for (let j = i; j < end; j++) reducer.current.apply(msgs[j]);
        if (end < msgs.length) {
          await new Promise<void>((r) => {
            if (typeof (window as any).requestIdleCallback === 'function') {
              (window as any).requestIdleCallback(() => r(), { timeout: 50 });
            } else {
              setTimeout(r, 0);
            }
          });
        }
      }
      return true;
    };

    Api.log('History', 'tailFetch', { tag, last: TAIL_N });
    Api.history(tabIdLocal!, { last: TAIL_N })
      .then(async (d) => {
        if (cancelled) return;
        const tNet = performance.now();
        if (!d.messages || !Array.isArray(d.messages)) return;
        Api.log('History', 'tailFetched', {
          tag, returned: d.messages.length, total: d.total, truncated: d.truncated,
          netMs: Math.round(tNet - t0),
        });

        const ok = await applyAll(d.messages);
        if (!ok || cancelled) return;
        const fresh = reducer.current.getEntries();
        setEntries(fresh);
        setRenderStart(Math.max(0, fresh.length - INITIAL_RENDER));
        setRenderEnd(fresh.length);
        needsBottomScrollRef.current = true;
        setHistoryLoading(false);

        Api.log('History', 'tailApplied', {
          tag, uiCount: fresh.length, totalMs: Math.round(performance.now() - t0),
        });

        // Phase 2 — only if server says there's more.
        if (d.truncated && (d.total || 0) > d.messages.length) {
          setFullLoading(true);
          const t1 = performance.now();
          Api.log('History', 'fullFetch', { tag });
          try {
            const full = await Api.history(tabIdLocal!);
            if (cancelled) return;
            const tFullNet = performance.now();
            Api.log('History', 'fullFetched', {
              tag, returned: full.messages?.length || 0,
              netMs: Math.round(tFullNet - t1),
            });

            // Save current scroll context so we can restore the user's view
            // after re-render. The number of entries grows from the FRONT
            // (older messages prepended), so the simplest invariant is
            // "keep the bottom-anchored visible message in view".
            const oldEntries = reducer.current.getEntries();
            const root = scrollRef.current;
            const prevScrollHeight = root?.scrollHeight || 0;
            const prevScrollTop = root?.scrollTop || 0;
            const wasAtBottom = root ? (prevScrollHeight - prevScrollTop - root.clientHeight) < 30 : true;

            const ok2 = await applyAll(full.messages || []);
            if (!ok2 || cancelled) return;
            const allEntries = reducer.current.getEntries();
            const grew = allEntries.length - oldEntries.length;

            // Window: shift by `grew` so the same logical entries stay rendered.
            // If user was at bottom — keep at bottom.
            setEntries(allEntries);
            if (wasAtBottom) {
              setRenderStart(Math.max(0, allEntries.length - INITIAL_RENDER));
              setRenderEnd(allEntries.length);
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const r = scrollRef.current;
                if (r) r.scrollTop = r.scrollHeight;
              }));
            } else {
              setRenderStart((s) => s + grew);
              setRenderEnd((e) => e + grew);
              // Preserve viewport: scrollTop adjusted by inserted-prefix height.
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const r = scrollRef.current;
                if (r) r.scrollTop = r.scrollHeight - prevScrollHeight + prevScrollTop;
              }));
            }
            Api.log('History', 'fullApplied', {
              tag, uiCount: allEntries.length, grew,
              fullMs: Math.round(performance.now() - t1),
              totalMs: Math.round(performance.now() - t0),
            });

            // Resolve any pending GoTo that was waiting on full history.
            const wantUuid = pendingFullGoToRef.current;
            if (wantUuid) {
              pendingFullGoToRef.current = null;
              // Schedule into next tick so state has committed.
              requestAnimationFrame(() => goToEntryRef.current?.(wantUuid));
            }
          } catch (e: any) {
            Api.log('History', 'fullError', { tag, msg: String(e?.message) });
          } finally {
            if (!cancelled) setFullLoading(false);
          }
        }
      })
      .catch((e) => {
        Api.log('History', 'tailError', { tag, msg: String(e?.message) });
        if (String(e?.message || '').includes('404') && tabIdLocal) dropChat(tabIdLocal);
      })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [tab.tabId]);

  // Window auto-scroll on initial mount / history-fetch completion.
  // Window starts at the tail, so scroll position must be at the bottom for the
  // user to see latest. Doing this in an effect (not inline) so it fires after
  // DOM commit when scrollHeight reflects the rendered window.
  useEffect(() => {
    if (!needsBottomScrollRef.current) return;
    if (renderEnd === 0) return;
    needsBottomScrollRef.current = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }));
  }, [renderEnd]);

  // Save to cache on unmount + page hide — DISABLED while testing first-load
  // performance. Restore by uncommenting the body when needed.
  //
  // useEffect(() => {
  //   if (!tab.tabId) return;
  //   const save = () => {
  //     if (!tab.tabId) return;
  //     const eList = reducer.current.getEntries();
  //     if (eList.length === 0) return;
  //     saveChat(tab.tabId, { entries: eList, timelineEntries, sessionId });
  //   };
  //   window.addEventListener('pagehide', save);
  //   window.addEventListener('beforeunload', save);
  //   return () => {
  //     window.removeEventListener('pagehide', save);
  //     window.removeEventListener('beforeunload', save);
  //     save();
  //   };
  // }, [tab.tabId]);

  // Open WS
  useEffect(() => {
    if (!tab.tabId) return;
    const ws = new WebSocket(wsUrl(tab.tabId));
    wsRef.current = ws;
    ws.onopen = () => setWsState('open');
    ws.onclose = () => setWsState('closed');
    ws.onerror = () => setWsState('closed');
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'snapshot') {
          if (m.sessionId) setSessionId(m.sessionId);
          setBusy(!!m.busy);
        } else if (m.type === 'busy') {
          setBusy(!!m.busy);
        } else if (m.type === 'done') {
          setBusy(false);
          if (m.sessionId) setSessionId(m.sessionId);
        } else if (m.type === 'message') {
          if (m.sessionId) setSessionId(m.sessionId);
          // Capture usage for context-percent badge: total = input + cache_read +
          // cache_creation. Same formula desktop SDK tab uses.
          const inner = m.message;
          if (inner?.message?.model) setResolvedModel(inner.message.model);
          if (inner?.message?.usage) {
            const u = inner.message.usage;
            const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            if (total > 0) setUsedTokens(total);
          }
          reducer.current.apply(m.message);
          const fresh = reducer.current.getEntries();
          setEntries(fresh);
          // New WS message lives at the tail. If user is at the bottom of the
          // window we extend renderEnd; otherwise leave the marker «N new below»
          // so they can choose to jump.
          const el = scrollRef.current;
          const atBottom = el ? (el.scrollHeight - el.scrollTop - el.clientHeight < 100) : true;
          if (atBottom) {
            setRenderEnd(fresh.length);
          }
        }
      } catch {}
    };
    return () => { try { ws.close(); } catch {} };
  }, [tab.tabId]);

  // Auto-scroll to bottom when window tail grows (renderEnd) and user was
  // at the bottom. pendingGoTo blocks during jumps. Also fires on busy=true
  // so user sees streaming response without manual scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pendingGoTo) return;
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (wasAtBottom || busy) {
      el.scrollTop = el.scrollHeight;
    }
  }, [renderEnd, busy, pendingGoTo]);

  const send = async () => {
    if (!text.trim() || !tab.tabId || busy) return;
    const prompt = text;
    setText('');
    setBusy(true);
    // No local optimistic push — main.js broadcasts a synthetic user message
    // over WS the moment sdkStartQuery fires. Pushing here too duplicates the
    // bubble. Latency is ~50-200ms, the busy spinner already gives feedback.
    try {
      await Api.send(tab.tabId, prompt);
    } catch (e: any) {
      reducer.current.apply({ type: 'result', subtype: 'error', is_error: true, result: e.message });
      setEntries(reducer.current.getEntries());
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!tab.tabId) return;
    try { await Api.stop(tab.tabId); } catch {}
    setBusy(false);
  };

  const isTerminal = tab.tabType !== 'claude-sdk';
  const canTimeline = !!(sessionId || tab.claudeSessionId);
  const canParams = !readOnly && !isTerminal && !!tab.tabId;

  // Context window per model: 1M for opus-4-7, 200K otherwise. Pulled from
  // the model id the API actually returned (not the user-selected alias) so
  // silent downgrades show the correct window.
  const contextWindow = (resolvedModel || '').includes('opus-4-7') ? 1_000_000 : 200_000;
  const contextPercent = usedTokens != null ? Math.max(0, Math.min(100, 100 - (usedTokens / contextWindow) * 100)) : null;
  const contextColor = contextPercent == null ? '#666'
    : contextPercent < 10 ? '#ef4444'
    : contextPercent < 25 ? '#f59e0b'
    : '#7a7a7a';

  return (
    <div style={S.page}>
      <div style={{ ...S.header, position: 'relative' }}>
        {/* Left: back + tab name as ONE clickable surface — easier to hit
            (Fitts: bigger target = fewer mis-taps), and matches the tab name
            being purely a "where am I" hint that should also navigate back. */}
        <button
          onClick={onBack}
          className="noted-icon"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
            flex: '0 1 auto', background: 'transparent', border: 'none',
            padding: '6px 8px', borderRadius: 8, cursor: 'pointer',
            color: 'inherit', textAlign: 'left',
          }}
          title="Back to project"
        >
          <span style={{
            ...S.iconBtn,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            ←
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0, gap: 1 }}>
            <span style={{
              fontSize: 11, color: '#888',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: 90,
            }}>
              {tab.name}
            </span>
            {contextPercent != null && (
              <span style={{
                fontSize: 10, color: contextColor, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
              }}>
                {contextPercent.toFixed(0)}%
              </span>
            )}
          </span>
        </button>

        {/* Center: viewport-centered via absolute pos. NO `transform` here —
            CSS spec says any `transform`, `filter`, `perspective`, `will-change`
            on an ancestor turns it into the containing block for fixed-position
            descendants. ParamsSheet uses position:fixed; if we transform here
            it gets clipped to this 30px-tall absolute box. Use negative-margin
            centering trick instead — works since the inner content auto-sizes
            to its children and we precompute the centerline at runtime via
            ref/measurement-free approach: just use `right:0; left:0; margin:auto`
            on a width-bounded inline-flex which centers itself. */}
        <div style={{
          position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            // Cap so a long model id can't overlap left/right groups.
            maxWidth: 'calc(100% - 200px)',
            pointerEvents: 'auto',
          }}>
            {canParams ? (
              <SDKParamsButton tabId={tab.tabId!} />
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>
                  {isTerminal ? (tab.commandType || 'terminal') : 'sdk'}
                </div>
                <div style={{ fontSize: 10, color: '#666' }}>
                  {readOnly ? 'read-only' : sessionId ? `${sessionId.slice(0, 8)}… · ${wsState}` : `no session · ${wsState}`}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right: Stop (when busy) + drawer */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: '0 0 auto', marginLeft: 'auto' }}>
          {busy && !readOnly && <button style={S.stopBtn} onClick={stop}>Stop</button>}
          {canTimeline && (
            <button className="noted-icon" style={S.iconBtn} onClick={() => setDrawerOpen(true)} title="Open timeline">☰</button>
          )}
        </div>
      </div>
      <div ref={scrollRef} onScroll={onChatScroll} style={S.chatScroll}>
        {historyLoading && entries.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginTop: 60 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
            </div>
            <div style={{ color: '#666', fontSize: 12 }}>Loading history…</div>
          </div>
        )}
        {!historyLoading && entries.length === 0 && !busy && (
          <div style={{ color: '#555', textAlign: 'center', marginTop: 60, fontSize: 13 }}>
            {readOnly && !tab.claudeSessionId
              ? 'No Claude session attached to this terminal — nothing to view.'
              : readOnly
                ? 'Empty session.'
                : 'No messages yet. Send something below.'}
          </div>
        )}
        {/* Top marker:
            - fullLoading + tail visible (renderStart=0)  → "Loading older…" spinner, disabled
            - fullLoading + window above (renderStart>0)  → same disabled spinner
            - !fullLoading + renderStart>0                → normal "Load older" button
            Goal: never let user tap into prefix that isn't there yet. */}
        {fullLoading && renderStart === 0 && (
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8,
            padding: '12px 14px', color: '#777', fontSize: 12,
          }}>
            <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
            <span style={{ marginLeft: 6 }}>Loading older messages…</span>
          </div>
        )}
        {renderStart > 0 && (
          <button
            disabled={fullLoading}
            onClick={() => {
              if (fullLoading) return;
              const root = scrollRef.current;
              const prevScrollHeight = root?.scrollHeight || 0;
              setRenderStart((s) => Math.max(0, s - RENDER_CHUNK));
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const r = scrollRef.current;
                if (r) r.scrollTop = r.scrollHeight - prevScrollHeight + r.scrollTop;
              }));
            }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              margin: '8px auto', padding: '8px 14px',
              background: fullLoading ? '#161616' : '#1a1a1a',
              border: '1px solid ' + (fullLoading ? '#222' : '#2a2a2a'),
              borderRadius: 14,
              color: fullLoading ? '#666' : '#aaa', fontSize: 12,
              cursor: fullLoading ? 'default' : 'pointer',
              opacity: fullLoading ? 0.7 : 1,
            }}
          >
            {fullLoading ? (
              <>
                <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
                <span>Loading older messages…</span>
              </>
            ) : (
              <>↑ Load older messages ({renderStart})</>
            )}
          </button>
        )}
        {entries.slice(renderStart, renderEnd).map((e) => <EntryView key={e.id} entry={e} />)}
        {/* Bottom marker: entries past renderEnd (e.g. WS stream while user is
            scrolled up in history). FAB tap will sweep up to them too. */}
        {renderEnd < entries.length && (
          <div style={{
            padding: '12px 14px', textAlign: 'center',
            color: '#555', fontSize: 11,
          }}>
            {entries.length - renderEnd} new below — tap ↓ to jump
          </div>
        )}
        {busy && !readOnly && (
          <div style={{ display: 'flex', gap: 6, padding: '8px 14px', color: '#888', fontSize: 12 }}>
            <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
          </div>
        )}
      </div>
      {/* Scroll-to-bottom — appears when user is far from the latest message.
          Right side in chat (mirrors WhatsApp/iMessage convention). Doesn't
          intercept taps when invisible because pointerEvents:none gate. */}
      <ScrollToBottomFAB visible={showScrollDown} onClick={scrollChatToBottom} side="right" />
      {!readOnly && (
        <Composer
          text={text}
          setText={setText}
          busy={busy}
          onSend={send}
          onPickPrompt={(content) => setText((prev) => prev ? `${prev}\n\n${content}` : content)}
        />
      )}
      {tab.tabId && (
        <TimelineDrawer
          open={drawerOpen}
          entries={timelineEntries}
          expanded={timelineExpanded}
          onToggle={toggleEntryExpanded}
          onGoTo={goToEntry}
          onDismiss={() => setDrawerOpen(false)}
        />
      )}
      {/* GoTo overlay — fully opaque dim covers the entire viewport (above the
          drawer at zIndex 900) the moment a goto starts. Without it the user
          sees the drawer collapse animation, then the chat at OLD scrollTop
          for 100-3000ms, then the jump. With it: tap → instant black screen
          with spinner → reveal at target. Three dots animate so the user sees
          the loader is alive even on a multi-second window shift. */}
      {scrollOverlay && (
        <div style={{
          position: 'fixed', inset: 0,
          background: '#0e0e0e',
          zIndex: 1500, pointerEvents: 'none',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 14,
          animation: 'noted-fade-in 0.08s ease-out',
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
          </div>
          <div style={{ color: '#888', fontSize: 12, letterSpacing: 1 }}>
            JUMPING…
          </div>
        </div>
      )}
    </div>
  );
}

// Center-of-header pill: shows current model + effort, click opens param sheet.
// Loads from /api/sdk-tabs/:id/params on mount; updates locally + POST on save.
// `adaptive`/`disabled` (thinking) sits as a tiny caption beneath.
// Each entry's label is the SAME string used in both the Model picker pills
// (sheet) and as the candidate header pill — single source of truth.
// `default` keeps a leading marker so the user can see they're on the alias
// rather than the explicit opus value (both resolve to opus-4.7 in API).
const SDK_MODELS = [
  { value: 'default', label: 'default · opus-4.7 [1M]' },
  { value: 'opus',    label: 'opus-4.7 [1M]' },
  { value: 'sonnet',  label: 'sonnet-4.6' },
  { value: 'haiku',   label: 'haiku-4.5' },
];
// Header shows the resolved model name even when the alias is `default`,
// so the badge reflects what the API will actually serve.
const HEADER_MODEL_LABEL: Record<string, string> = {
  default: 'opus-4.7 [1M]',
  opus:    'opus-4.7 [1M]',
  sonnet:  'sonnet-4.6',
  haiku:   'haiku-4.5',
};
const SDK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function SDKParamsButton({ tabId }: { tabId: string }) {
  const [params, setParams] = useState<{ model: string; effort: string; thinking: 'adaptive' | 'disabled' } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Api.getParams(tabId)
      .then((d) => { if (!cancelled) setParams({ model: d.model, effort: d.effort, thinking: d.thinking }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tabId]);

  if (!params) {
    return (
      <>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#666' }}>—</div>
        <div style={{ fontSize: 10, color: '#444' }}>loading</div>
      </>
    );
  }

  const apply = async (partial: Partial<typeof params>) => {
    const next = { ...params, ...partial };
    setParams(next); // optimistic
    try { await Api.setParams(tabId, partial); } catch (e: any) { alert('Failed: ' + e.message); }
  };

  // Header pill display:
  //   - model name; if `default` → suffix `[1M]` so the implicit Opus 1M-context
  //     window is visible at a glance.
  //   - effort value; if thinking is OFF → show `off` instead (since effort
  //     IS the thinking depth — disabled thinking means no effort to report).
  //   - no second-line caption (the old adaptive/disabled row is gone).
  const modelLabel = HEADER_MODEL_LABEL[params.model] || params.model;
  const thinkingOff = params.thinking === 'disabled';
  const rightLabel = thinkingOff ? 'off' : params.effort;
  const rightColor = thinkingOff ? '#666' : '#FFB382';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          background: 'transparent', border: 'none', padding: 0,
          display: 'flex', alignItems: 'center', gap: 4,
          cursor: 'pointer', color: 'inherit',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>{modelLabel}</span>
        <span style={{ color: '#666', fontSize: 13 }}>·</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: rightColor }}>{rightLabel}</span>
        <span style={{ color: '#666', fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <ParamsSheet
          params={params}
          onChange={apply}
          onDismiss={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ParamsSheet({ params, onChange, onDismiss }: {
  params: { model: string; effort: string; thinking: 'adaptive' | 'disabled' };
  onChange: (p: Partial<typeof params>) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        animation: 'noted-fade-in 0.18s ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480,
          background: '#1a1a1a', borderRadius: '18px 18px 0 0',
          padding: '8px 16px max(20px, env(safe-area-inset-bottom)) 16px',
          animation: 'noted-sheet-up 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div style={{ width: 36, height: 4, background: '#444', borderRadius: 999, margin: '4px auto 16px' }} />

        <ParamRow label="Model">
          {SDK_MODELS.map((m) => (
            <ParamPill key={m.value} active={params.model === m.value} onClick={() => onChange({ model: m.value })}>
              {m.label}
            </ParamPill>
          ))}
        </ParamRow>

        <ParamRow label="Effort">
          {SDK_EFFORTS.map((e) => (
            <ParamPill key={e} active={params.effort === e} onClick={() => onChange({ effort: e })}>
              {e}
            </ParamPill>
          ))}
        </ParamRow>

        <ParamRow label="Thinking">
          <ParamPill active={params.thinking === 'adaptive'} onClick={() => onChange({ thinking: 'adaptive' })}>
            on
          </ParamPill>
          <ParamPill active={params.thinking === 'disabled'} onClick={() => onChange({ thinking: 'disabled' })}>
            off
          </ParamPill>
        </ParamRow>

      </div>
    </div>
  );
}

// Custom scroll animator. native `behavior:'smooth'` runs at a speed that
// depends on distance — on a 200-entry chat the GoTo can take 2-3s, which
// feels broken. This is a fixed-duration rAF animator with ease-out cubic;
// regardless of distance the scroll completes in `durationMs` (default 200ms).
function smoothScrollTo(el: HTMLElement, top: number, durationMs = 200) {
  const start = el.scrollTop;
  const delta = top - start;
  if (Math.abs(delta) < 2) { el.scrollTop = top; return; }
  const t0 = performance.now();
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const tick = () => {
    const elapsed = performance.now() - t0;
    const t = Math.min(1, elapsed / durationMs);
    el.scrollTop = start + delta * easeOutCubic(t);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Floating scroll-to-bottom button. Shows up when user has scrolled away
// from the latest message. Same idea as WhatsApp/iMessage. Side selectable
// because in-chat it sits right (next to send button), in timeline-drawer
// it sits left (chevron/goto buttons live on the right of each row).
function ScrollToBottomFAB({ visible, onClick, side, bottomOffset = 110 }: {
  visible: boolean;
  onClick: () => void;
  side: 'left' | 'right';
  bottomOffset?: number;
}) {
  // Pressed state for instant tap feedback. Without this, the global button:active
  // rule competes with the inline `background` and on iOS feels delayed. We track
  // pressed locally and merge into style — guarantees background flip on first
  // touch frame, before any onClick work begins.
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      aria-label="Scroll to bottom"
      style={{
        position: 'absolute',
        // bottomOffset px above safe-area inset. Defaults to 110 (clears the
        // 2-row composer in chat). Pass 20 in drawer where no composer.
        bottom: `calc(env(safe-area-inset-bottom) + ${bottomOffset}px)`,
        [side]: 12,
        width: 40, height: 40, borderRadius: 999,
        background: pressed ? '#FFB382' : '#1a1a1a',
        border: '1px solid ' + (pressed ? '#FFB382' : '#2a2a2a'),
        color: pressed ? '#1a1a1a' : '#cccccc',
        fontSize: 18, fontWeight: pressed ? 700 : 400,
        display: visible ? 'flex' : 'none',
        alignItems: 'center', justifyContent: 'center',
        boxShadow: pressed ? '0 0 0 3px rgba(255,178,130,0.25), 0 4px 12px rgba(0,0,0,0.4)' : '0 4px 12px rgba(0,0,0,0.4)',
        cursor: 'pointer',
        transform: pressed ? 'scale(0.92)' : 'scale(1)',
        transition: 'transform 0.05s ease, background 0.05s ease',
        zIndex: 50,
      }}
    >↓</button>
  );
}

// Two-row mobile composer (Claude.app / ChatGPT mobile pattern):
//   row 1: textarea (full width, autogrow up to ~40vh)
//   row 2: [+] [🎤] ... [📚 prompts] [↑ send]
// + and 🎤 disabled — placeholders for future image-attach and voice-input.
// 40vh chosen to match Claude mobile: ~11 lines visible without keyboard,
// ~7-8 with keyboard up. Hard cap on iPhone 15 Pro is ~340px.
function Composer({ text, setText, busy, onSend, onPickPrompt }: {
  text: string;
  setText: (v: string | ((prev: string) => string)) => void;
  busy: boolean;
  onSend: () => void;
  onPickPrompt: (content: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Autogrow: set height = scrollHeight, capped at 40vh. Resets to single-row
  // baseline when text is empty (otherwise textarea sticks at last grown size).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.4);
    const next = Math.min(ta.scrollHeight, max);
    ta.style.height = next + 'px';
  }, [text]);

  return (
    <div style={{
      borderTop: '1px solid #1f1f1f',
      background: '#0e0e0e',
      padding: '8px 12px max(8px, env(safe-area-inset-bottom)) 12px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={busy ? 'Claude is replying…' : 'Message Claude…'}
        rows={1}
        style={{
          width: '100%', minHeight: 36,
          background: '#1a1a1a',
          border: '1px solid #2a2a2a',
          borderRadius: 14,
          padding: '10px 14px',
          fontSize: 15, lineHeight: 1.4,
          color: '#e0e0e0', outline: 'none',
          resize: 'none',
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* + (image attach) — disabled placeholder */}
        <ComposerIconButton disabled aria-label="Attach (coming soon)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </ComposerIconButton>
        {/* 🎤 voice — disabled placeholder */}
        <ComposerIconButton disabled aria-label="Voice (coming soon)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="13" rx="3" />
            <path d="M5 11v1a7 7 0 0 0 14 0v-1" />
            <line x1="12" y1="19" x2="12" y2="23" />
          </svg>
        </ComposerIconButton>

        <div style={{ flex: 1 }} />

        {/* Prompt library */}
        <PromptPickerInlineButton onPick={onPickPrompt} />

        {/* Send */}
        <button
          onClick={onSend}
          disabled={busy || !text.trim()}
          aria-label="Send"
          style={{
            width: 36, height: 36, borderRadius: 999,
            border: 'none',
            background: (busy || !text.trim()) ? '#2a2a2a' : '#FFB382',
            color: (busy || !text.trim()) ? '#666' : '#1a1a1a',
            fontSize: 18, fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >↑</button>
      </div>
    </div>
  );
}

function ComposerIconButton({ disabled, children, ...rest }: any) {
  return (
    <button
      disabled={disabled}
      {...rest}
      style={{
        width: 36, height: 36, borderRadius: 999,
        background: 'transparent',
        border: 'none',
        color: disabled ? '#3a3a3a' : '#888',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >{children}</button>
  );
}

// Inline variant of PromptPickerButton — same modal, but renders as a normal
// row-button (not absolutely positioned inside textarea like the previous design).
function PromptPickerInlineButton({ onPick }: { onPick: (content: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Insert prompt"
        style={{
          width: 36, height: 36, borderRadius: 999,
          background: 'transparent', border: 'none',
          color: '#888', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <circle cx="14.5" cy="9" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && <PromptPickerSheet onPick={(c) => { onPick(c); setOpen(false); }} onDismiss={() => setOpen(false)} />}
    </>
  );
}

// Composer-anchored prompt picker. The button lives inside the textarea wrapper
// (absolute, bottom-right) so it doesn't steal width from the input. Tap opens
// a sheet listing groups + ungrouped prompts; tapping a group navigates one
// level deeper to its items, tapping an item appends content to the composer.
//
// Icon: hand-drawn book/library outline SVG — fits the chat aesthetic better
// than a generic clipboard or list icon. Drawn inline so it inherits color
// and doesn't depend on a sprite/font load.
function PromptPickerButton({ onPick }: { onPick: (content: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Insert prompt"
        style={{
          position: 'absolute', right: 6, bottom: 6,
          width: 30, height: 30, borderRadius: 8,
          background: 'transparent', border: 'none',
          color: '#888', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {/* book/library — sparkle dot indicates "templates" */}
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <circle cx="14.5" cy="9" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && <PromptPickerSheet onPick={(c) => { onPick(c); setOpen(false); }} onDismiss={() => setOpen(false)} />}
    </>
  );
}

// Forever-cache key for the prompts library. Stored as one JSON blob with the
// etag so a single read+write cycle gives both the data and the revalidation
// token. Bumped if you change the schema in a backwards-incompatible way.
const PROMPTS_CACHE_KEY = 'noted-prompts-cache:v1';
type PromptsData = {
  groups: Array<{ id: number; name: string; position: number }>;
  prompts: Array<{ id: number; title: string; content: string; group_id: number | null; position: number; file_paths: string[] }>;
};
type PromptsCacheBlob = { etag: string; data: PromptsData };
function loadPromptsCache(): PromptsCacheBlob | null {
  try {
    const raw = localStorage.getItem(PROMPTS_CACHE_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw);
    if (blob && typeof blob.etag === 'string' && blob.data) return blob;
    return null;
  } catch { return null; }
}
function savePromptsCache(blob: PromptsCacheBlob) {
  try { localStorage.setItem(PROMPTS_CACHE_KEY, JSON.stringify(blob)); } catch {}
}

function PromptPickerSheet({ onPick, onDismiss }: {
  onPick: (content: string) => void;
  onDismiss: () => void;
}) {
  // Hydrate synchronously from localStorage — cached payload renders in the
  // same frame as the sheet opens. Server revalidation runs in the background
  // and rewrites state only if the etag changed.
  const cachedRef = useRef<PromptsCacheBlob | null>(loadPromptsCache());
  const [data, setData] = useState<PromptsData | null>(cachedRef.current?.data || null);
  const [error, setError] = useState<string | null>(null);
  // Two-level nav inside one sheet: null = root view, number = group id detail.
  const [groupId, setGroupId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cachedEtag = cachedRef.current?.etag;
    Api.prompts(cachedEtag)
      .then((d) => {
        if (cancelled) return;
        if (d.unchanged) {
          // Server confirms cache is still good. Nothing to do — UI already shows it.
          Api.log('Prompts', 'cacheHit', { etag: cachedEtag?.slice(0, 8) });
          return;
        }
        if (d.groups && d.prompts && d.etag) {
          const fresh: PromptsData = { groups: d.groups, prompts: d.prompts };
          setData(fresh);
          savePromptsCache({ etag: d.etag, data: fresh });
          Api.log('Prompts', 'cacheReplaced', {
            etag: d.etag.slice(0, 8),
            groups: d.groups.length, prompts: d.prompts.length,
          });
        }
      })
      .catch((e) => {
        // Network failure — if we have cache, ignore silently. If not, surface.
        if (cancelled) return;
        if (!cachedRef.current) setError(e.message);
        else Api.log('Prompts', 'revalidateError', { msg: String(e.message) });
      });
    return () => { cancelled = true; };
  }, []);

  let title = 'Insert prompt';
  let subtitle: string | undefined;
  let actions: SheetAction[] = [];

  if (data) {
    if (groupId == null) {
      // Root view — show groups first (with ›), then ungrouped prompts.
      const sorted = [...data.groups].sort((a, b) => a.position - b.position);
      const ungrouped = data.prompts.filter((p) => p.group_id == null).sort((a, b) => a.position - b.position);
      actions = [
        ...sorted.map((g) => ({
          label: `${g.name}  ›`,
          onPress: () => setGroupId(g.id),
        })),
        ...ungrouped.map((p) => ({
          label: p.title || '(untitled)',
          onPress: () => onPick(p.content),
        })),
      ];
      subtitle = `${sorted.length} groups · ${ungrouped.length} prompts`;
    } else {
      const group = data.groups.find((g) => g.id === groupId);
      const items = data.prompts.filter((p) => p.group_id === groupId).sort((a, b) => a.position - b.position);
      title = group?.name || 'Group';
      subtitle = `${items.length} prompts`;
      actions = [
        { label: '‹ Back', onPress: () => setGroupId(null) },
        ...items.map((p) => ({
          label: p.title || '(untitled)',
          onPress: () => onPick(p.content),
        })),
      ];
    }
  }

  if (!data && !error) {
    return (
      <div onClick={onDismiss} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}>
        <div onClick={(e) => e.stopPropagation()} style={{
          width: '100%', maxWidth: 480, background: '#1a1a1a',
          borderRadius: '18px 18px 0 0', padding: '24px 16px',
          color: '#888', fontSize: 13, textAlign: 'center',
        }}>
          Loading prompts…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <ActionSheet
        title="Insert prompt"
        subtitle={`Error: ${error}`}
        actions={[]}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <ActionSheet
      title={title}
      subtitle={subtitle}
      actions={actions}
      onDismiss={onDismiss}
    />
  );
}

function ParamRow({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.6,
        marginBottom: 8, paddingLeft: 4,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function ParamPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 12px', borderRadius: 10,
        background: active ? 'rgba(255,178,130,0.18)' : '#222',
        border: active ? '1px solid #FFB382' : '1px solid #2a2a2a',
        color: active ? '#FFB382' : '#bbb',
        fontSize: 13, fontWeight: 500, cursor: 'pointer',
        textAlign: 'center',
      }}
    >
      {children}
    </button>
  );
}

// Always-mounted drawer (toggled via display:none) so the inner scroll
// container preserves its position across open/close — no manual restore.
// State (entries, expanded) lives in ChatView so prefetch happens on tab open.
// Width = full viewport: on phone, opening timeline is effectively switching
// to a separate "screen" that you exit either via ✕ or via the GoTo arrow on
// any row (which also scrolls the chat to that message).
function TimelineDrawer({ open, entries, expanded, onToggle, onGoTo, onDismiss }: {
  open: boolean;
  entries: TimelineEntry[] | null;
  expanded: Set<string>;
  onToggle: (uuid: string) => void;
  onGoTo: (uuid: string) => void;
  onDismiss: () => void;
}) {
  const drawerScrollRef = useRef<HTMLDivElement>(null);
  const [showDrawerDown, setShowDrawerDown] = useState(false);
  const onDrawerScroll = () => {
    const el = drawerScrollRef.current;
    if (!el) return;
    setShowDrawerDown(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  };
  const drawerScrollDown = () => {
    const el = drawerScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 900,
        // display:none keeps inner DOM mounted so its scrollTop survives.
        // {open && ...} would unmount and reset every time.
        display: open ? 'block' : 'none',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', inset: 0,
          background: '#0e0e0e',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{
          padding: '12px 14px', borderBottom: '1px solid #1f1f1f',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          // Header doesn't scroll, but pin it for clarity
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>Timeline</div>
            <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
              {entries == null ? 'loading…' : `${entries.length} entries`}
            </div>
          </div>
          <button onClick={onDismiss} className="noted-icon" style={S.iconBtn}>✕</button>
        </div>
        <div
          ref={drawerScrollRef}
          onScroll={onDrawerScroll}
          style={{
          flex: 1, overflowY: 'auto', padding: '8px 0',
          // Tell iOS this is a vertical-scroll surface so it commits to pan
          // immediately on touch instead of waiting to disambiguate from tap.
          touchAction: 'pan-y',
          WebkitOverflowScrolling: 'touch' as any,
          position: 'relative',
        }}>
          {entries == null && (
            <div style={{ padding: 32, color: '#666', fontSize: 12, textAlign: 'center' }}>Loading timeline…</div>
          )}
          {entries && entries.length === 0 && (
            <div style={{ padding: 16, color: '#555', fontSize: 12, textAlign: 'center' }}>Empty timeline.</div>
          )}
          {entries?.map((e) => (
            <TimelineEntryRow
              key={e.uuid}
              entry={e}
              expanded={expanded.has(e.uuid)}
              onToggle={() => onToggle(e.uuid)}
              onGoTo={() => onGoTo(e.uuid)}
            />
          ))}
        </div>
        <ScrollToBottomFAB visible={showDrawerDown} onClick={drawerScrollDown} side="left" bottomOffset={20} />
      </div>
    </div>
  );
}

// Row has NO onClick on the body — iOS would debounce every touchstart trying
// to decide between tap and scroll, making vertical scroll feel sticky. All
// interactions are explicit buttons on the right column:
//   ▶ chevron toggle (collapse/expand)  — only when content is truncated
//   ↗ goto-in-chat                       — always, when goto is wired
// Buttons are stacked vertically on the right so the text column stays wide
// and the touch targets don't compete with each other for finger space.
function TimelineEntryRow({ entry, expanded, onToggle, onGoTo }: {
  entry: TimelineEntry;
  expanded: boolean;
  onToggle: () => void;
  onGoTo?: () => void;
}) {
  const { color, kind, preview, full, truncated } = entry;
  const labelByKind = kind === 'user' ? 'PROMPT' : kind === 'assistant' ? 'REPLY' : 'COMPACT';
  return (
    <div style={{
      padding: '10px 12px',
      borderLeft: `3px solid ${color}`,
      marginBottom: 6,
      background: expanded ? 'rgba(255,255,255,0.02)' : 'transparent',
      transition: 'background 0.12s',
      display: 'flex', gap: 10, alignItems: 'flex-start',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            fontSize: 9, color, fontWeight: 700, letterSpacing: 0.5,
            background: `${color}1a`, padding: '1px 5px', borderRadius: 3,
          }}>{labelByKind}</span>
          {entry.ts && (
            <span style={{ fontSize: 9, color: '#444' }}>
              {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div style={{
          fontSize: 12, color: '#cccccc', lineHeight: 1.4,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          ...(expanded ? {} : {
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical' as any,
            overflow: 'hidden',
          }),
        }}>
          {expanded ? full : preview}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        {truncated && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            style={{
              width: 32, height: 28, borderRadius: 6,
              // Persistent background so the buttons read as buttons, not as
              // free-floating glyphs that compete with the text body.
              border: '1px solid #2a2a2a', background: '#1a1a1a',
              color: '#aaa', fontSize: 12, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
              transition: 'transform 0.15s, background 0.1s',
            }}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >▶</button>
        )}
        {onGoTo && (
          <button
            onClick={(e) => { e.stopPropagation(); onGoTo(); }}
            style={{
              width: 32, height: 28, borderRadius: 6,
              border: '1px solid rgba(255,178,130,0.3)',
              background: 'rgba(255,178,130,0.10)',
              color: '#FFB382', fontSize: 14, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            aria-label="Go to message in chat"
          >↗</button>
        )}
      </div>
    </div>
  );
}

// ────────── Bits ──────────

function Header({ title, subtitle, left, right }: { title: string; subtitle?: string; left?: any; right?: any }) {
  return (
    <div style={S.header}>
      <div style={{ width: 36, display: 'flex', justifyContent: 'flex-start' }}>{left}</div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 10, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{subtitle}</div>}
      </div>
      <div style={{ width: 60, display: 'flex', justifyContent: 'flex-end' }}>{right}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: any }) {
  return <div style={{ padding: '14px 16px 6px', fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</div>;
}

function Empty({ children }: { children: any }) {
  return <div style={{ padding: '8px 16px 4px', fontSize: 12, color: '#555' }}>{children}</div>;
}

// === Entry rendering — desktop-SDK design grammar ===
// Tool calls = full cards (chevron · status · LABEL · counters), not inline
// orange pills. Edit/Write get a real git-style diff. Read previews 8 lines.
// Bash previews command + 10-line output. Thinking is a separate
// outlined-italic container with brain icon. User text > 600 chars collapses
// to 400 with "Раскрыть полностью". Nothing truncates with ellipsis — it
// collapses with toggle, so info density isn't lost.

function EntryView({ entry }: { entry: UiEntry }) {
  if (entry.kind === 'user') {
    return (
      <div
        data-entry-uuid={entry.entryUuid}
        style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 12px' }}
      >
        <div style={{
          ...S.bubble,
          background: '#1f3a5f',
          color: '#e0e6ed',
          maxWidth: '85%',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          <CollapsibleText text={entry.text} threshold={600} previewSize={400} />
        </div>
      </div>
    );
  }
  if (entry.kind === 'thinking') {
    return <ThinkingCard text={entry.text} />;
  }
  if (entry.kind === 'assistant') {
    // Assistant fills the full chat width — no bubble cap. Tools/MCP do too,
    // so the conversation has a single text column instead of a chat-bubble
    // shape that wastes the right edge for assistant content.
    return (
      <div style={{ padding: '8px 14px' }}>
        <div style={{
          color: '#cccccc',
          fontSize: 14,
          lineHeight: 1.5,
          wordBreak: 'break-word',
        }}>
          {entry.text ? <Markdown text={entry.text} /> : <span style={{ color: '#555' }}>…</span>}
        </div>
      </div>
    );
  }
  if (entry.kind === 'tool') {
    return <ToolCard entry={entry} />;
  }
  if (entry.kind === 'error') {
    return (
      <div style={{ padding: '4px 12px' }}>
        <div style={{ background: '#2a1316', color: '#f38ba8', borderRadius: 10, padding: '8px 12px', fontSize: 12 }}>{entry.text}</div>
      </div>
    );
  }
  return null;
}

// CollapsibleText — preview + toggle, never ellipsis. Same pattern as
// desktop SDK CollapsibleText (fact-claude-sdk-tab.md).
function CollapsibleText({ text, threshold, previewSize }: { text: string; threshold: number; previewSize: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= threshold) return <>{text}</>;
  const preview = open ? text : text.slice(0, previewSize) + '…';
  return (
    <>
      {preview}
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'block', marginTop: 6,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: '#FFB382', fontSize: 11, padding: 0,
        }}
      >
        {open ? 'Свернуть' : `Раскрыть полностью (${text.length} символов)`}
      </button>
    </>
  );
}

// ToolCard — chevron · status-dot · LABEL · counters · target on next line.
// Tool-specific bodies via dispatching on entry.tool name.
// Markdown renderer for assistant text + thinking. Uses react-markdown + GFM
// (tables, strikethrough, task lists). Styling lives in the .md-body CSS block
// at the top of this file — colours match the desktop SDK chat as much as
// makes sense on mobile (smaller font, looser line-height for legibility).
function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

// Thinking block — same shape as ToolCard so the chat has consistent grammar.
// Header is the click target (chevron toggle); body is italic muted text.
// Default open while there's no body yet (streaming) — collapses easily once
// the user has read it.
function ThinkingCard({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ padding: '4px 12px' }}>
      <div style={{
        background: 'rgba(40, 40, 60, 0.20)',
        border: '1px solid #2a2a3a',
        borderRadius: 10,
        overflow: 'hidden',
      }}>
        <div
          onClick={() => setOpen(!open)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', cursor: 'pointer',
            borderBottom: open ? '1px solid #232336' : 'none',
          }}
        >
          <span style={{
            color: '#666', fontSize: 11,
            transition: 'transform 0.15s',
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
          }}>▶</span>
          <span style={{ color: '#7a7aa0', fontSize: 11 }}>◆</span>
          <span style={{
            fontSize: 10, color: '#cdd6f4', fontWeight: 700, letterSpacing: 0.5,
            background: 'rgba(122, 122, 160, 0.15)', padding: '2px 7px', borderRadius: 4,
          }}>THINKING</span>
        </div>
        {open && (
          <div style={{
            padding: '10px 12px',
            fontSize: 13, color: '#9da0c0', fontStyle: 'italic',
            whiteSpace: 'pre-wrap', lineHeight: 1.45,
            wordBreak: 'break-word',
          }}>
            {text || <span style={{ color: '#555' }}>thinking…</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCard({ entry }: { entry: UiEntry & { kind: 'tool' } }) {
  const isPending = entry.result === undefined;
  const isError = entry.isError;
  const [open, setOpen] = useState(true);
  const statusColor = isError ? '#f38ba8' : isPending ? '#FFB382' : '#a6e3a1';
  const tool = entry.tool;
  const input = entry.input || {};

  // Target/path/command summary in header line under name
  let target: string | null = null;
  if (tool === 'Bash' && typeof input.command === 'string') target = input.command;
  else if ((tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'Glob' || tool === 'Grep') && typeof input.file_path === 'string') target = input.file_path;
  else if (typeof input.path === 'string') target = input.path;

  // Diff stats for Edit/Write
  let diffStats: { added: number; removed: number } | null = null;
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    diffStats = computeDiffStats(input.old_string, input.new_string);
  } else if (tool === 'Write' && typeof input.content === 'string') {
    diffStats = { added: input.content.split('\n').length, removed: 0 };
  }

  return (
    <div style={{ padding: '4px 12px' }}>
      <div style={{
        background: '#141414',
        border: '1px solid ' + (isError ? 'rgba(243,139,168,0.3)' : '#252525'),
        borderRadius: 10,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div
          onClick={() => setOpen(!open)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px',
            cursor: 'pointer',
            borderBottom: open ? '1px solid #1f1f1f' : 'none',
          }}
        >
          <span style={{ color: '#666', fontSize: 11, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
          <span style={{
            color: statusColor, fontSize: 13,
            ...(isPending ? { animation: 'noted-dot-pulse 1.4s infinite' } : {}),
          }}>●</span>
          <span style={{
            fontSize: 10, color: '#cdd6f4', fontWeight: 700, letterSpacing: 0.5,
            background: '#1f1f1f', padding: '2px 7px', borderRadius: 4,
          }}>{tool.toUpperCase()}</span>
          {diffStats && (
            <span style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
              <span style={{ color: '#a6e3a1' }}>+{diffStats.added}</span>{' '}
              <span style={{ color: '#f38ba8' }}>−{diffStats.removed}</span>
            </span>
          )}
          {isPending && <span style={{ marginLeft: 'auto', fontSize: 10, color: '#666' }}>running</span>}
          {isError && <span style={{ marginLeft: 'auto', fontSize: 10, color: '#f38ba8' }}>error</span>}
          {/* No "done" badge — successful completion is implied by the absence
              of running/error and by the green dot. The label was just visual noise. */}
        </div>

        {target && (
          <div style={{
            padding: '6px 12px',
            fontSize: 11, color: '#888',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            wordBreak: 'break-all',
            borderBottom: open ? '1px solid #1f1f1f' : 'none',
          }}>
            {target}
          </div>
        )}

        {open && (
          <div>
            {/* Tool-specific body */}
            {tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string' ? (
              <DiffView oldText={input.old_string} newText={input.new_string} />
            ) : tool === 'Write' && typeof input.content === 'string' ? (
              <CodePreview text={input.content} maxLines={24} highlightLine={() => '#a6e3a1'} prefix="+" />
            ) : null}

            {/* Result */}
            {entry.result && (
              <div style={{
                padding: '8px 12px', fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: isError ? '#f38ba8' : '#9aa0a6',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: '#0d0d0d',
                borderTop: '1px solid #1f1f1f',
                maxHeight: 240, overflow: 'auto',
              }}>
                <ResultPreview text={entry.result} maxLines={tool === 'Read' ? 8 : 10} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultPreview({ text, maxLines }: { text: string; maxLines: number }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  if (lines.length <= maxLines && text.length < 800) return <>{text}</>;
  const preview = open ? text : lines.slice(0, maxLines).join('\n');
  return (
    <>
      {preview}
      {!open && lines.length > maxLines && <div style={{ color: '#555', marginTop: 4 }}>… +{lines.length - maxLines} more lines</div>}
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        style={{
          display: 'block', marginTop: 6, background: 'transparent', border: 'none',
          color: '#FFB382', fontSize: 11, cursor: 'pointer', padding: 0,
        }}
      >
        {open ? 'Свернуть' : `Раскрыть (${lines.length} строк)`}
      </button>
    </>
  );
}

function CodePreview({ text, maxLines, prefix = '' }: { text: string; maxLines: number; prefix?: string; highlightLine?: () => string }) {
  const lines = text.split('\n');
  const showAll = lines.length <= maxLines;
  const visible = showAll ? lines : lines.slice(0, maxLines);
  return (
    <div style={{
      padding: '8px 12px', fontSize: 11,
      fontFamily: 'ui-monospace, monospace',
      background: '#0d0d0d',
      maxHeight: maxLines * 18 + 20, overflow: 'auto',
    }}>
      {visible.map((line, i) => (
        <div key={i} style={{ color: '#a6e3a1', whiteSpace: 'pre' }}>{prefix}{line}</div>
      ))}
      {!showAll && <div style={{ color: '#555', marginTop: 4 }}>… +{lines.length - maxLines} more</div>}
    </div>
  );
}

// Cheap line-level diff: just count and color whole lines that changed.
// Not a Myers diff — that's a lot of code for mobile screen real estate.
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const max = Math.min(24, Math.max(oldLines.length, newLines.length));
  const rows: Array<{ kind: '+' | '-' | '='; text: string }> = [];
  // Simple alignment: render removed block then added block. Good enough for
  // typical Edit (small replacement); Myers can come later if needed.
  for (let i = 0; i < oldLines.length && rows.length < max * 2; i++) {
    rows.push({ kind: '-', text: oldLines[i] });
  }
  for (let i = 0; i < newLines.length && rows.length < max * 2; i++) {
    rows.push({ kind: '+', text: newLines[i] });
  }
  const truncated = oldLines.length + newLines.length > rows.length;

  return (
    <div style={{
      padding: '8px 12px', fontSize: 11,
      fontFamily: 'ui-monospace, monospace',
      background: '#0d0d0d',
      maxHeight: 320, overflow: 'auto',
    }}>
      {rows.map((r, i) => (
        <div key={i} style={{
          background: r.kind === '+' ? 'rgba(166,227,161,0.10)' : r.kind === '-' ? 'rgba(243,139,168,0.10)' : 'transparent',
          color: r.kind === '+' ? '#a6e3a1' : r.kind === '-' ? '#f38ba8' : '#888',
          padding: '0 4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          <span style={{ opacity: 0.7, marginRight: 6 }}>{r.kind}</span>{r.text}
        </div>
      ))}
      {truncated && (
        <div style={{ color: '#555', marginTop: 4 }}>… diff truncated</div>
      )}
    </div>
  );
}

function computeDiffStats(oldText: string, newText: string): { added: number; removed: number } {
  // Same heuristic as desktop's quick diff stats — line counts.
  return { removed: oldText.split('\n').length, added: newText.split('\n').length };
}

// ────────── Inline styles ──────────

const S: Record<string, React.CSSProperties> = {
  page: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#0e0e0e',
    paddingTop: 'env(safe-area-inset-top)',
    paddingBottom: 'env(safe-area-inset-bottom)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 10px',
    borderBottom: '1px solid #1f1f1f',
    gap: 6,
  },
  iconBtn: {
    width: 32, height: 32, borderRadius: 8, border: 'none', background: '#1a1a1a', color: '#cccccc',
    fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  },
  loginBox: {
    margin: 'auto', maxWidth: 360, width: '90%', padding: 24,
    display: 'flex', flexDirection: 'column',
  },
  input: {
    background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8, padding: '12px 14px',
    fontSize: 14, color: '#e0e0e0', outline: 'none',
  },
  primaryBtn: {
    marginTop: 12, padding: '12px 16px', borderRadius: 8, border: 'none',
    background: '#FFB382', color: '#1a1a1a', fontWeight: 600, fontSize: 14, cursor: 'pointer',
  },
  row: {
    width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
    padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    color: 'inherit', borderBottom: '1px solid #161616', cursor: 'pointer',
  },
  rowStatic: {
    width: '100%', padding: '10px 16px', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', borderBottom: '1px solid #161616',
  },
  peachPill: {
    background: 'rgba(255,178,130,0.14)', color: '#FFB382',
    padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500,
  },
  chatScroll: {
    flex: 1, overflowY: 'auto', padding: '8px 0',
    // pan-y commits to vertical scroll on first touch instead of waiting to
    // disambiguate from a tap. WebKit smooth-momentum for iOS Safari.
    touchAction: 'pan-y',
    WebkitOverflowScrolling: 'touch' as any,
  },
  bubble: { padding: '8px 12px', borderRadius: 14, fontSize: 14, lineHeight: 1.4 },
  composer: {
    display: 'flex', alignItems: 'flex-end', gap: 8, padding: '8px 12px',
    borderTop: '1px solid #1f1f1f', background: '#0e0e0e',
  },
  textarea: {
    flex: 1, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 18,
    padding: '10px 14px', fontSize: 14, color: '#e0e0e0', outline: 'none', resize: 'none',
    minHeight: 40, maxHeight: 160,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 999, border: 'none', background: '#FFB382',
    color: '#1a1a1a', fontSize: 18, fontWeight: 700, cursor: 'pointer',
  },
  stopBtn: {
    padding: '6px 12px', borderRadius: 8, border: '1px solid #6b2a36',
    background: '#2a1316', color: '#f38ba8', fontSize: 12, cursor: 'pointer',
  },
  dot: {
    width: 6, height: 6, borderRadius: 999, background: '#888',
    animation: 'noted-dot-pulse 1.2s ease-in-out infinite',
  },
};

// Inject keyframes once (inline-style API has no @keyframes support)
if (typeof document !== 'undefined' && !document.getElementById('noted-mobile-keyframes')) {
  const style = document.createElement('style');
  style.id = 'noted-mobile-keyframes';
  style.textContent = `
@keyframes noted-dot-pulse { 0%,100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
@keyframes noted-live-pulse {
  0%,100% { box-shadow: 0 0 6px rgba(255,178,130,0.5); }
  50% { box-shadow: 0 0 14px rgba(255,178,130,0.95); }
}
@keyframes noted-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes noted-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes noted-slide-left { from { transform: translateX(100%); } to { transform: translateX(0); } }
/* Suppress iOS text-selection glow on tap & long-press for tab rows / sheet
   buttons. The system selection highlights "TERMINAL"/"SDK" badges otherwise. */
button, .noted-no-select { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
input, textarea { -webkit-user-select: auto; user-select: auto; }
/* touch-action: manipulation kills the iOS 300ms double-tap-zoom delay so
   button:active and onClick fire the moment finger lands. transition is short
   so visual feedback feels mechanical, not animated. */
button { transition: transform 0.05s ease, background-color 0.05s ease, opacity 0.08s ease; touch-action: manipulation; }
button:active { opacity: 0.55; transform: scale(0.94); }
button:disabled { opacity: 0.4; cursor: not-allowed; }
/* iconBtn pressed-state background flash so the user sees feedback even
   when an inline transform overrides scale. */
.noted-icon:active { background: #333 !important; }

/* Markdown body — matches desktop SDK chat colours. p, ul, ol, code, pre,
   blockquote handled. Headings are slightly smaller than desktop because
   mobile lines are shorter and a 1.5em h1 dominates the column. */
.md-body { color: inherit; line-height: 1.5; word-break: break-word; }
.md-body p { margin: 0 0 8px; }
.md-body p:last-child { margin-bottom: 0; }
.md-body strong { color: #ffa348; }
.md-body em { color: #69dbdb; }
.md-body code {
  background: rgba(80, 80, 80, 0.4);
  color: #50fa7b;
  padding: 1px 5px; border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  word-break: break-all;
}
.md-body pre {
  background: rgba(80, 80, 80, 0.25);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 8px 0;
  overflow-x: auto;
  font-size: 12px;
}
.md-body pre code { background: transparent; padding: 0; color: #cccccc; font-size: inherit; }
.md-body ul, .md-body ol { margin: 4px 0 8px; padding-left: 22px; }
.md-body li { margin-bottom: 4px; }
.md-body h1 { font-size: 1.25em; margin: 12px 0 6px; color: #c678dd; }
.md-body h2 { font-size: 1.15em; margin: 10px 0 6px; color: #b197fc; }
.md-body h3 { font-size: 1.05em; margin: 8px 0 4px; color: #a78bfa; }
.md-body h4, .md-body h5, .md-body h6 { font-size: 1em; margin: 6px 0 3px; color: #9775fa; font-weight: 600; }
.md-body blockquote {
  margin: 6px 0; padding: 4px 10px;
  border-left: 3px solid #444; color: #888;
}
.md-body a { color: #88c0d0; text-decoration: underline; }
.md-body hr { border: none; height: 1px; background: rgba(255,255,255,0.15); margin: 12px 0; }
.md-body table { border-collapse: collapse; margin: 8px 0; font-size: 0.92em; }
.md-body th, .md-body td { border: 1px solid #2a2a2a; padding: 4px 8px; }
.md-body th { background: #1a1a1a; color: #cdd6f4; }
::-webkit-scrollbar { width: 0; height: 0; }
`;
  document.head.appendChild(style);
}

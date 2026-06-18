import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
// Shared conversation blocks (same source as the desktop SDK tab). Mobile now
// renders tool cards / bash / diff / thinking / markdown through this package
// instead of its own divergent components — single visual canon. Collapse
// persistence (useEntryExpanded) is injected via open/onToggle. See
// packages/claude-blocks.
import {
  Markdown as CBMarkdown,
  ThinkBlock as CBThinkBlock,
  ToolCallPart as CBToolCallPart,
  ChatMessage as CBChatMessage,
  defaultOpenForTool,
  type ChatEntry as CBChatEntry,
  type CollapseController as CBCollapseController,
  type ChatRenderContext as CBChatRenderContext,
} from '@noted/claude-blocks';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
// localStorage cache (cache.ts) replaced by IndexedDB record store (idb.ts) —
// see fact-mobile-web.md::IDB record store. The cache module is kept on disk
// for now in case rollback is needed, but no longer imported.
import { Api, bootstrapToken, clearToken, getToken, setToken, eventsUrl, type AppSettings, type ProjectInfo, type TabInfo, type TimelineEntry, type StatusMarkerCfg, type ProcessBarCfg, type QueueData, type QueueCore, type QueueAiTab, type QueueOp, type PendingQuestion, type MobileQuestion } from './api';
import { createMessageReducer, type UiEntry } from './messages';
import { streamHistory, type StreamMeta } from './streamHistory';
import { readCachedHistory, writeFullHistory, dropSession, readKv, writeKv } from './idb';
import { DictationSession } from './dictation';

function hexToRgbTriplet(hex: string, fallback = '255,255,255') {
  const v = (hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return fallback;
  const n = parseInt(v, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function opacityPctToAlpha(pct: number, fallback = 55) {
  const safe = Number.isFinite(pct) ? pct : fallback;
  return Math.max(5, Math.min(100, Math.round(safe))) / 100;
}

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

type ProjectData = { project: { id: string; name: string; path: string }; tabs: TabInfo[]; statusMarker?: StatusMarkerCfg; processBar?: ProcessBarCfg };
type MobileFilePreview = { path: string; name: string; ext: string; size: number; content: string };

function ProjectRoute() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<ProjectData | null>(null);
  // `revalidating` = a background listTabs is in flight while we already show
  // cached tabs. Drives the inline loader next to the project title — the tabs
  // stay visible & tappable the whole time (no full-screen "Loading…" wall).
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // STALE: paint cached tabs immediately so the project opens instantly. The
  // network refresh below overwrites once it lands. Cache key is per-project.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    readKv<ProjectData>(`tabs:${projectId}`).then((hit) => {
      // Only apply the cache if we haven't already got fresh network data.
      if (!cancelled && hit?.payload?.tabs) {
        setData((cur) => cur ?? hit.payload);
      }
    });
    return () => { cancelled = true; };
  }, [projectId]);

  // REVALIDATE: background fetch. On success → update UI + persist snapshot.
  // Error only surfaces as a full-screen failure when we have NOTHING cached
  // to show; otherwise we keep the stale tabs and silently drop the error.
  const refresh = useCallback(async () => {
    if (!projectId) return;
    setRevalidating(true);
    try {
      const list = await Api.listTabs(projectId);
      const next: ProjectData = { project: list.project, tabs: list.tabs, statusMarker: list.statusMarker, processBar: list.processBar };
      setData(next);
      setError(null);
      writeKv(`tabs:${projectId}`, next); // fire-and-forget persist
    } catch (e: any) {
      setData((cur) => { if (!cur) setError(e?.message || 'failed to load project'); return cur; });
    } finally {
      setRevalidating(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (error && !data) return (
    <div style={S.page}>
      <div style={{ padding: 20, color: '#f38ba8' }}>
        Failed: {error}
        <div style={{ marginTop: 12 }}>
          <button onClick={() => navigate('/projects')} style={S.primaryBtn}>Back</button>
        </div>
      </div>
    </div>
  );
  // Only the very first cold open (no cache, no network yet) shows the wall.
  if (!data) return <div style={S.page}><div style={{ padding: 20, color: '#888' }}>Loading…</div></div>;

  return (
    <ProjectView
      project={data.project}
      tabs={data.tabs}
      statusMarker={data.statusMarker}
      processBar={data.processBar}
      revalidating={revalidating}
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
    // Reload-fallback: if we landed here via a deep-link (no state.tab), resolve
    // the tab. First try the SWR cache (instant — "сразу быстро зайти в чат"),
    // then confirm/refresh from the server. ChatView's own history cache then
    // paints the conversation. If the tab is genuinely gone, surface the error.
    if (tab || !projectId || !tabId) return;
    let cancelled = false;

    // STALE: cached tab snapshot → render immediately if the tab is there.
    readKv<ProjectData>(`tabs:${projectId}`).then((hit) => {
      if (cancelled || tab) return;
      const cached = hit?.payload?.tabs?.find((t) => t.tabId === tabId);
      if (cached) setTab((cur) => cur ?? cached);
    });

    // REVALIDATE: authoritative lookup. Overwrites/clears as needed.
    Api.listTabs(projectId)
      .then((d) => {
        if (cancelled) return;
        const found = (d.tabs || []).find((t) => t.tabId === tabId);
        if (found) { setTab(found); writeKv(`tabs:${projectId}`, d); }
        else setTab((cur) => { if (!cur) setError('Tab not found in project. It may have been closed.'); return cur; });
      })
      .catch((e) => { if (!cancelled) setTab((cur) => { if (!cur) setError(e?.message || 'failed to load tab'); return cur; }); });
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

function MarkdownFileSheet({ file, onDismiss }: { file: MobileFilePreview; onDismiss: () => void }) {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef<number | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    startY.current = e.clientY;
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startY.current == null) return;
    setDragY(Math.max(0, e.clientY - startY.current));
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
        position: 'fixed', inset: 0,
        background: `rgba(0,0,0,${0.58 - Math.min(0.42, dragY / 420)})`,
        zIndex: 1200,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        animation: dragging ? 'none' : 'noted-fade-in 0.18s ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 560,
          height: 'min(86vh, 760px)',
          background: '#111111',
          borderRadius: '18px 18px 0 0',
          border: '1px solid #272727',
          borderBottom: 'none',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
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
          style={{ padding: '8px 0 4px', cursor: 'grab', touchAction: 'none' }}
        >
          <div style={{ width: 36, height: 4, background: '#444', borderRadius: 999, margin: '0 auto 12px' }} />
        </div>
        <div style={{
          padding: '4px 16px 12px',
          borderBottom: '1px solid #242424',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#f0f0f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
            <div style={{ fontSize: 11, color: '#666', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file.path} · {file.size.toLocaleString()} bytes
            </div>
          </div>
          <button
            className="noted-icon"
            onClick={onDismiss}
            style={{ ...S.iconBtn, color: '#888', background: '#1b1b1b' }}
            aria-label="Close preview"
          >×</button>
        </div>
        <div style={{
          flex: 1,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          padding: '14px 16px max(22px, env(safe-area-inset-bottom))',
        }}>
          <CBMarkdown text={file.content || ' '} />
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

// Desktop TabColor → background tint. MIRRORS the desktop TAB_COLORS table +
// the SDK-claude override (TabBar.tsx) so the mobile list looks exactly like the
// desktop vertical tab list. Rows use the INACTIVE vertical background (base
// bgColor for coloured tabs, faint white for default) and have NO border — on
// desktop the border is only an active/selected indicator, inactive tabs are
// borderless. accent is the tab's brand colour (used only for the long-press fill).
const TAB_COLOR_BG: Record<string, { bg: string; accent: string }> = {
  default: { bg: 'rgba(255,255,255,0.04)', accent: '#888' },
  red:     { bg: 'rgba(239, 68, 68, 0.2)',  accent: 'rgb(239, 68, 68)' },
  yellow:  { bg: 'rgba(234, 179, 8, 0.2)',  accent: 'rgb(234, 179, 8)' },
  green:   { bg: 'rgba(34, 197, 94, 0.2)',  accent: 'rgb(34, 197, 94)' },
  blue:    { bg: 'rgba(59, 130, 246, 0.2)', accent: 'rgb(59, 130, 246)' },
  purple:  { bg: 'rgba(168, 85, 247, 0.2)', accent: 'rgb(168, 85, 247)' },
  claude:  { bg: 'rgba(218, 119, 86, 0.2)', accent: '#DA7756' },
  gemini:  { bg: 'rgba(78, 134, 248, 0.2)', accent: '#4E86F8' },
};
function tabRowStyle(tab: TabInfo): { bg: string; accent: string } {
  const color = tab.color || 'default';
  // SDK-claude override — desktop bumps alpha 0.20→0.30 so SDK reads brighter.
  if (tab.tabType === 'claude-sdk' && color === 'claude') {
    return { bg: 'rgba(210, 140, 90, 0.30)', accent: '#D28C5A' };
  }
  return TAB_COLOR_BG[color] || TAB_COLOR_BG.default;
}

// Left marker — mirrors the desktop TabBar status marker exactly: shape (dot vs
// square) + size from the desktop statusMarker config, color from the assigned
// category status (statusColor, resolved from the palette server-side). Renders
// ONLY when a category is actually assigned — no category → no marker at all
// (the desktop TabBar does the same: `sessionStatuses.find()` undefined → guard,
// nothing drawn). The type chip already identifies the row, so the slot doesn't
// need reserving. Runtime state (active/busy/inactive) is NOT encoded here — it
// lives in the loader + row background per the design.
function StatusMarker({ marker, color }: { marker: StatusMarkerCfg; color: string | null }) {
  if (!color) return null;
  return (
    <span style={{
      width: marker.sizePx, height: marker.sizePx, flexShrink: 0,
      borderRadius: marker.shape === 'square' ? Math.max(2, Math.round(marker.sizePx / 4)) : '50%',
      background: color,
    }} />
  );
}

// Process-bar STRIP — the loader. Mirrors the desktop process-bar: a thin
// vertical strip at the left OR right edge (cfg.position), colored by the
// processBar base color while the process is running. A configurable shimmer band
// sweeps down it while the AI is actually generating (busy). This is the ONLY
// running/loader indicator on the row — no right-side dot, no whole-row tint.
function ProcessBarStrip({ cfg, running, busy }: { cfg: ProcessBarCfg; running: boolean; busy: boolean }) {
  if (!running) return null;
  const side = cfg.position === 'right' ? { right: 0 } : { left: 0 };
  const radius = cfg.position === 'right'
    ? { borderTopRightRadius: 12, borderBottomRightRadius: 12 }
    : { borderTopLeftRadius: 12, borderBottomLeftRadius: 12 };
  const peakAlpha = opacityPctToAlpha(cfg.shimmerOpacityPct);
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute', top: 0, bottom: 0, width: 3, ...side, ...radius,
        backgroundColor: cfg.colorA,
        ['--mob-pbar-shimmer-rgb' as any]: hexToRgbTriplet(cfg.shimmerColor),
        ['--mob-pbar-shimmer-spacing' as any]: `${cfg.shimmerSpacingPct}%`,
        ['--mob-pbar-shimmer-alpha' as any]: peakAlpha,
        ['--mob-pbar-shimmer-edge-alpha' as any]: Math.max(0.01, peakAlpha * 0.22),
        pointerEvents: 'none', overflow: 'hidden',
      }}
    >
      {/* AI-busy shimmer band sweeping down the strip — the "loader is working"
          cue, same metaphor as desktop tab-process-bar-ai-shimmer-overlay. */}
      {busy && <span className="mob-pbar-shimmer" />}
    </span>
  );
}

function TabRow({ tab, marker, processBar, onTap, onLongPress }: { tab: TabInfo; marker: StatusMarkerCfg; processBar: ProcessBarCfg; onTap: () => void; onLongPress: () => void }) {
  const lp = useLongPress(onLongPress);
  const rowStyle = tabRowStyle(tab);
  // Runtime "is this process working right now": SDK uses the live session
  // presence; PTY+Claude uses the sessionStatus lifecycle string. running →
  // process-bar strip appears; busy → shimmer sweeps the strip.
  const live = !!tab.live;
  const busy = tab.sessionStatus === 'busy';
  const running = busy || live || tab.sessionStatus === 'active';
  // Marker color: ONLY the assigned-category color. No category → null → marker
  // renders nothing (no muted fallback dot — user explicitly didn't want it).
  const markerColor = tab.statusColor || null;
  // Reserve horizontal room for the strip on its side so text never sits under it.
  const stripPad = processBar.position === 'right' ? { paddingRight: 17 } : { paddingLeft: 17 };

  return (
    <button
      {...lp.handlers}
      onClick={() => { if (!lp.didTrigger()) onTap(); }}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: '11px 14px', ...stripPad, borderRadius: 8,
        marginBottom: 4,
        // Desktop tab background (tab.color tint). NO border — inactive desktop
        // vertical tabs are borderless; the border was a per-type artifact.
        // border/appearance reset KILLS the native 2px `outset` button frame the
        // UA draws otherwise — outset renders light-grey on top+left, which read
        // as a "серая рамка слева вверху" on the dark tab bg. Desktop has none.
        border: 'none', appearance: 'none', WebkitAppearance: 'none',
        background: rowStyle.bg,
        color: 'inherit', position: 'relative', overflow: 'hidden',
        transform: lp.state.active ? `scale(${1 - lp.state.progress * 0.04})` : undefined,
        transition: lp.state.active ? 'none' : 'transform 0.15s',
      }}
    >
      {/* Loader = process-bar strip at the configured edge. No whole-row tint. */}
      <ProcessBarStrip cfg={processBar} running={running} busy={busy} />
      {/* Awaiting-answer = rotating purple border (copied 1:1 from desktop
          .tab-awaiting-input — conic-gradient traveling segment masked to a ring).
          Claude is blocked on an AskUserQuestion in this tab. inset:0 over the
          row, radius matches the button (8px). pointer-events:none. */}
      {tab.awaiting && (
        <span className="mob-awaiting-ring" aria-hidden style={{
          position: 'absolute', inset: 0, borderRadius: 8, zIndex: 2,
        }} />
      )}
      {/* Long-press progress fill — tinted to the tab accent. */}
      {lp.state.active && (
        <span style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at center, ${rowStyle.accent}22 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, position: 'relative' }}>
        {/* Left: category status marker (shape+color mirror desktop). No type chip. */}
        <StatusMarker marker={marker} color={markerColor} />
        {/* Tab name — same string as desktop, no chip prefix. */}
        <span style={{ flex: 1, fontSize: 14, color: '#e8e4de', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
  const [settings, setSettings] = useState<AppSettings>({ streamerMode: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');

  // STALE: paint the last cached project list immediately so returning to this
  // screen is instant (no "Loading projects…" wall). Network refresh overwrites.
  useEffect(() => {
    let cancelled = false;
    readKv<ProjectInfo[]>('projects').then((hit) => {
      if (!cancelled && Array.isArray(hit?.payload)) setProjects((cur) => cur ?? hit!.payload);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Api.appSettings()
      .then((next) => { if (!cancelled) setSettings({ streamerMode: !!next.streamerMode }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const setStreamerMode = useCallback(async (next: boolean) => {
    setSettingsError('');
    setSettings((cur) => ({ ...cur, streamerMode: next }));
    setSettingsBusy(true);
    try {
      const saved = await Api.setAppSettings({ streamerMode: next });
      setSettings({ streamerMode: !!saved.streamerMode });
    } catch (e: any) {
      setSettings((cur) => ({ ...cur, streamerMode: !next }));
      setSettingsError(e?.message || 'failed to save settings');
    } finally {
      setSettingsBusy(false);
    }
  }, []);

  // REVALIDATE: refresh every 4s while view is mounted so live SDK / open-state
  // stays current without the user having to pull-to-refresh. Each fresh result
  // is persisted as the SWR snapshot for the next cold open / back-navigation.
  useEffect(() => {
    let cancelled = false;
    let t: number;
    const load = () => {
      Api.listProjects()
        .then((d) => { if (!cancelled) { setProjects(d.projects); writeKv('projects', d.projects); } })
        .catch((e) => { if (!cancelled) setError(e.message); });
    };
    load();
    t = window.setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const active = (projects || []).filter((p) => p.isOpen);
  const inactive = (projects || []).filter((p) => !p.isOpen);

  return (
    <div style={S.page}>
      <Header
        title="Projects"
        subtitle={projects ? `${active.length} active · ${projects.length} total` : undefined}
        right={
          <button
            className="noted-icon"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            style={S.iconBtn}
          >
            ⚙
          </button>
        }
      />
      {settingsOpen && (
        <MobileSettingsSheet
          settings={settings}
          busy={settingsBusy}
          error={settingsError}
          onStreamerModeChange={setStreamerMode}
          onClose={() => setSettingsOpen(false)}
          onLogout={onLogout}
        />
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 32px' }}>
        {/* Error only when we have NOTHING cached to show — otherwise keep the
            stale list visible and let the next 4s poll recover silently. */}
        {error && !projects && <div style={{ padding: 16, color: '#f38ba8' }}>Error: {error}</div>}
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
            <SectionHeader>All projects · {inactive.length}</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {inactive.map((p) => <ProjectCard key={p.id} project={p} prominent={false} onClick={() => onPick(p)} />)}
            </div>
          </div>
        )}

        {projects && projects.length === 0 && (
          <div style={{ padding: 24, color: '#555', textAlign: 'center', fontSize: 13 }}>No projects yet.</div>
        )}
      </div>
    </div>
  );
}

function MobileSettingsSheet({
  settings,
  busy,
  error,
  onStreamerModeChange,
  onClose,
  onLogout,
}: {
  settings: AppSettings;
  busy: boolean;
  error: string;
  onStreamerModeChange: (next: boolean) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.48)',
      display: 'flex', alignItems: 'flex-end',
      padding: '0 10px calc(env(safe-area-inset-bottom) + 10px)',
    }}>
      <button
        aria-label="Close settings"
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, border: 0, background: 'transparent' }}
      />
      <div style={{
        position: 'relative', width: '100%', maxWidth: 520, margin: '0 auto',
        borderRadius: 18, overflow: 'hidden',
        background: '#151515', border: '1px solid #2a2a2a',
        boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
      }}>
        <div style={{
          height: 48, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '0 14px',
          borderBottom: '1px solid #242424',
        }}>
          <div style={{ fontSize: 14, fontWeight: 650, color: '#eee' }}>Settings</div>
          <button className="noted-icon" onClick={onClose} style={S.iconBtn}>✕</button>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, padding: '12px 12px', borderRadius: 12,
            background: '#101010', border: '1px solid #252525',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#ededed', fontSize: 13, fontWeight: 600 }}>Streamer mode</div>
              <div style={{ color: '#777', fontSize: 11, marginTop: 3, lineHeight: 1.35 }}>
                Hide remote-control host and IP while sharing the screen.
              </div>
            </div>
            <MobileSwitch
              checked={settings.streamerMode}
              disabled={busy}
              onChange={onStreamerModeChange}
            />
          </div>
          {error && <div style={{ color: '#f38ba8', fontSize: 12, padding: '0 2px' }}>{error}</div>}
          <button
            onClick={onLogout}
            style={{
              height: 40, borderRadius: 10, border: '1px solid #3a2026',
              background: 'rgba(243,139,168,0.08)', color: '#f38ba8',
              fontSize: 13, fontWeight: 600,
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function MobileSwitch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative', flex: '0 0 auto',
        width: 48, height: 28, borderRadius: 999,
        border: 'none',
        background: checked ? '#34a853' : '#3a3a3a',
        boxShadow: checked ? 'inset 0 0 0 1px rgba(255,255,255,0.12)' : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
        opacity: disabled ? 0.72 : 1,
        transition: 'background 0.16s ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: checked ? 23 : 3,
        width: 22, height: 22, borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
        transition: 'left 0.16s ease',
      }} />
    </button>
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
        color: 'inherit', position: 'relative', overflow: 'hidden',
      }}>
        {project.hasAwaiting && (
          <span className="mob-awaiting-ring" aria-hidden style={{
            position: 'absolute', inset: 0, borderRadius: 10, zIndex: 2,
          }} />
        )}
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
      color: 'inherit', position: 'relative', overflow: 'hidden',
    }}>
      {/* Rotating purple ring — a claude tab in this project is awaiting an
          AskUserQuestion answer. Same conic-gradient traveling-border as desktop. */}
      {project.hasAwaiting && (
        <span className="mob-awaiting-ring" aria-hidden style={{
          position: 'absolute', inset: 0, borderRadius: 14, zIndex: 2,
        }} />
      )}
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
  statusMarker?: StatusMarkerCfg;
  processBar?: ProcessBarCfg;
  revalidating?: boolean;
  onBack: () => void;
  onOpenChat: (t: TabInfo, opts?: { readOnly?: boolean }) => void;
  onCreated: () => void;
}) {
  const { project, tabs, statusMarker, processBar, revalidating, onBack, onOpenChat, onCreated } = props;
  // Mirror desktop default (dot/8px) when the server predates statusMarker.
  const marker: StatusMarkerCfg = statusMarker || { shape: 'dot', sizePx: 8 };
  // Mirror desktop default process-bar (cyan, left) when server predates it.
  const procBar: ProcessBarCfg = {
    colorA: processBar?.colorA || '#155E75',
    shimmerColor: processBar?.shimmerColor || '#FFFFFF',
    shimmerSpacingPct: Number.isFinite(processBar?.shimmerSpacingPct) ? processBar!.shimmerSpacingPct : 50,
    shimmerOpacityPct: Number.isFinite(processBar?.shimmerOpacityPct) ? processBar!.shimmerOpacityPct : 55,
    position: processBar?.position === 'right' ? 'right' : 'left',
  };
  const [creating, setCreating] = useState(false);
  const [actionTarget, setActionTarget] = useState<{ tab: TabInfo; kind: 'sdk' | 'terminal' } | null>(null);
  const [renameTarget, setRenameTarget] = useState<TabInfo | null>(null);
  const [filePreview, setFilePreview] = useState<MobileFilePreview | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState<string | null>(null);

  // ONE flat list in DESKTOP ORDER (server returns tabs ORDER BY position) — no
  // grouping by type, no section headers. Whether a tab opens interactive (SDK /
  // Claude chat) or read-only (plain shell / Gemini / other PTY) is a per-tab
  // predicate, NOT a layout split — it only changes the onTap target + kind.
  const visibleTabs = tabs.filter((t) => t.tabId);
  const isInteractive = (t: TabInfo) => t.tabType === 'claude-sdk' || t.commandType === 'claude';

  const openFilePreview = async (tab: TabInfo) => {
    const filePath = tab.filePath || tab.cwd;
    if (!filePath || filePreviewLoading) return;
    setFilePreviewLoading(tab.tabId || filePath);
    try {
      const preview = await Api.filePreview(filePath);
      setFilePreview(preview);
    } catch (e: any) {
      alert('File preview failed: ' + (e?.message || e));
    } finally {
      setFilePreviewLoading(null);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      // Backend returns { tabId, name, cwd, projectId } — use it to navigate
      // straight into the new tab. Mobile UX: every "create" is followed by
      // "now I want to talk to it", so the extra tap on the project list was
      // pure friction. Refresh tabs list AFTER navigation so when user comes
      // back via Back button the list is fresh.
      const r = await Api.createSDKTab(project.id);
      await onCreated();
      const fresh = await Api.listTabs(project.id);
      const newTab = fresh.tabs.find(x => x.tabId === r.tabId);
      if (newTab) onOpenChat(newTab);
    } catch (e: any) {
      alert('Create failed: ' + e.message);
    } finally {
      setCreating(false);
    }
  };

  const createClaude = async () => {
    setCreating(true);
    try {
      const r = await Api.createClaudeTab(project.id);
      await onCreated();
      const fresh = await Api.listTabs(project.id);
      const newTab = fresh.tabs.find(x => x.tabId === r.tabId);
      if (newTab) onOpenChat(newTab);
    } catch (e: any) {
      alert('Create Claude terminal failed: ' + e.message);
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
        right={revalidating ? <InlineSpinner color="#666" size={12} /> : undefined}
      />
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button onClick={create} disabled={creating} style={S.primaryBtn}>
          {creating ? 'Creating…' : '+ New SDK chat'}
        </button>
        <button onClick={createClaude} disabled={creating} style={S.primaryBtn}>
          {creating ? 'Creating…' : '+ New Claude terminal'}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 32px' }}>
        {visibleTabs.length === 0 && <Empty>No tabs in this project yet.</Empty>}
        {/* Flat list, desktop order. SDK + Claude open interactive; everything
            else opens read-only. No section headers, no per-type grouping. */}
        {visibleTabs.map((t) => {
          const interactive = isInteractive(t);
          return (
            <TabRow
              key={t.tabId}
              tab={t}
              marker={marker}
              processBar={procBar}
              onTap={() => t.tabType === 'file' ? openFilePreview(t) : onOpenChat(t, interactive ? undefined : { readOnly: true })}
              onLongPress={() => setActionTarget({ tab: t, kind: t.tabType === 'claude-sdk' ? 'sdk' : 'terminal' })}
            />
          );
        })}
      </div>
      {filePreviewLoading && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 'calc(24px + env(safe-area-inset-bottom))',
          transform: 'translateX(-50%)',
          zIndex: 900,
          padding: '8px 12px',
          borderRadius: 999,
          background: '#1a1a1a',
          border: '1px solid #333',
          color: '#aaa',
          fontSize: 12,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}>
          <InlineSpinner color="#FFB382" size={12} /> Preview…
        </div>
      )}
      {filePreview && <MarkdownFileSheet file={filePreview} onDismiss={() => setFilePreview(null)} />}

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

// Paste chip — long pasted text collapses into a chip instead of flooding the
// composer. Mirror of desktop SDK (ClaudeSDKTab.tsx PasteChip + PASTE_THRESHOLD).
type PasteChip = { id: string; text: string; preview: string };
const PASTE_THRESHOLD = 500; // chars — above this, paste becomes a chip

function ChatView({ tab, onBack, readOnly = false }: { tab: TabInfo; onBack: () => void; readOnly?: boolean }) {
  // For Fork-to-SDK button (terminal tabs only) — push the user into the
  // newly-created SDK tab without making them go back to project list.
  const navigate = useNavigate();
  const [forking, setForking] = useState(false);
  const onForkToSDK = useCallback(async () => {
    if (!tab.tabId || forking) return;
    setForking(true);
    try {
      const r = await Api.forkToSDK(tab.tabId);
      // Find the parent project of this tab and navigate to the new SDK chat.
      // Backend returns { tabId, sessionId, projectId } — projectId is enough.
      if (r.projectId && r.tabId) {
        // Pre-fetch fresh tabs so deep-link landing has its TabInfo ready.
        try { await Api.listTabs(r.projectId); } catch {}
        navigate('/projects/' + encodeURIComponent(r.projectId) + '/chat/' + encodeURIComponent(r.tabId));
      }
    } catch (e: any) {
      alert('Fork failed: ' + (e?.message || e));
    } finally {
      setForking(false);
    }
  }, [tab.tabId, forking, navigate]);
  // Architecture (read top to bottom):
  //  1. Hydrate UI synchronously with cached entries from IndexedDB (records,
  //     not blobs — IDB returns live structured-cloned objects, no re-parse).
  //  2. Open WebSocket for live messages.
  //  3. Stream /history?after=<lastUuid> as NDJSON — apply each record into
  //     the reducer as it arrives, batched per animation frame.
  //  4. Render via react-virtuoso — DOM proportional to viewport (10-30 items)
  //     regardless of history length. No manual window, no scroll-restore, no
  //     OOM cap. firstItemIndex anchors when older messages are prepended.
  //  5. On stream end, write the full message list back to IDB in one tx so
  //     the next mount opens instantly.
  const [entries, setEntries] = useState<UiEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState<boolean>(!!tab.claudeSessionId || tab.tabType === 'claude-sdk' || tab.commandType === 'claude');
  const [sessionId, setSessionId] = useState<string | undefined>(tab.claudeSessionId || tab.live?.sessionId);
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [text, setText] = useState('');
  // Paste chips — long pasted text collapses into a chip instead of flooding
  // the textarea (mirror of desktop SDK composer). On send each chip is wrapped
  // in <pasted_content> so the user-bubble renderer can re-collapse it.
  const [chips, setChips] = useState<PasteChip[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[] | null>(null);
  const [timelineExpanded, setTimelineExpanded] = useState<Set<string>>(new Set());
  const [usedTokens, setUsedTokens] = useState<number | null>(null);
  const [resolvedModel, setResolvedModel] = useState<string | null>(null);
  // Streaming progress: meta.total and how many records the NDJSON loop has
  // already applied. Drives the determinate "Loading 1847/4856…" indicator.
  const [streamProgress, setStreamProgress] = useState<{ done: number; total: number } | null>(null);
  // Highlight a freshly-jumped entry by uuid for ~1.5s. Set by goToEntry, used
  // by the row renderer to apply a background-fade.
  const [flashUuid, setFlashUuid] = useState<string | null>(null);
  // ── Follow-bottom intent (NOT a distance flag) ───────────────────────────
  // The earlier design derived "stick to bottom" from the instantaneous
  // distance (scrollSize − scrollOffset − viewportSize < 120). That signal is
  // fragile under streaming: while Claude writes, the last entry grows in
  // height *below* the viewport, so distance momentarily exceeds the threshold
  // and a stray onScroll flips the flag false — killing auto-follow after the
  // very first chunk, and popping the ↓ arrow even though the user never moved.
  //
  // Intent is a REF, not state: it represents "the user wants to stay pinned"
  // and only the user can revoke it (a genuine upward drag = negative scroll
  // delta). Content growth never produces a negative delta on the tail entry,
  // so streaming can't disarm it. Re-armed automatically when the user scrolls
  // back to within REARM_PX of the bottom. See fix-mobile-scroll-teleport.md /
  // fix-virtuoso-to-virtua-migration.md for the history of this surface.
  const followBottomRef = useRef(true);
  // True while WE are programmatically scrolling (pinToBottom) so the onScroll
  // it triggers isn't misread as user input and doesn't disarm the intent.
  const programmaticScrollRef = useRef(false);
  // Last offset seen by the outer onScroll — to compute direction (delta).
  const lastFollowOffsetRef = useRef<number | null>(null);
  // FAB visibility. Hidden whenever we're following (intent true) OR at the
  // exact bottom. Shown only when the user has deliberately scrolled up to read.
  const [atTrueBottom, setAtTrueBottom] = useState<boolean>(true);
  // For PTY+Claude tabs only: lifecycle of the Claude CLI process inside the PTY.
  // null = SDK tab (status concept doesn't apply). Polled on mount + after every
  // /resume + after /stop. WS snapshot also updates it on connect.
  const [claudeStatus, setClaudeStatus] = useState<'active' | 'busy' | 'inactive' | 'starting' | null>(
    tab.commandType === 'claude' ? (tab.sessionStatus || null) : null,
  );
  const [resuming, setResuming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const isClaudePtyTab = tab.commandType === 'claude' && tab.tabType !== 'claude-sdk';

  // ── Prompt Queue ("Run after") — mobile mirror ───────────────────────────
  // We do NOT own the queue: `queue` is the live desktop core, refreshed on
  // mount and kept in sync by the `queue-update` SSE event. Every interaction
  // POSTs a mutation op; the desktop App-root runner fires the prompts. The
  // panel (RunAfter menu) opens from a header icon; while open the header icon
  // becomes a ✕ that closes both panel and editor. Only meaningful for AI tabs
  // with a turn-end edge (PTY-Claude / SDK) — bash tabs have no queue.
  const [queue, setQueue] = useState<QueueCore | null>(null);
  const [queueAiTabs, setQueueAiTabs] = useState<QueueAiTab[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  // PTY-claude ONLY — same gate as the desktop overlay. The runner fires queued
  // prompts via claude:send-command, which is a PTY-TUI paste (terminals.get) and
  // no-ops on SDK tabs; so an SDK-owned queue could never fire. SDK/gemini tabs
  // can still be PIVOT TARGETS (valid turn-end triggers) — just not queue owners.
  const canQueue = !readOnly && !!tab.tabId && isClaudePtyTab;
  const activeQueueCount = queue ? countActiveQueueItems(queue.items) : 0;

  // Fetch the queue core once when the panel is first opened (and re-fetch the
  // sibling AI-tab list, which can change). SSE keeps `queue` fresh afterward.
  const refreshQueue = useCallback(async () => {
    if (!tab.tabId) return;
    try {
      const d: QueueData = await Api.getQueue(tab.tabId);
      setQueue(d.queue);
      setQueueAiTabs(d.aiTabs || []);
    } catch { /* 409 when tab not open on desktop — leave prior state */ }
  }, [tab.tabId]);

  // Apply a mutation op with optimistic echo. The POST returns the new core; we
  // also receive a queue-update SSE shortly after (idempotent — same shape).
  const mutateQueue = useCallback(async (body: QueueOp) => {
    if (!tab.tabId) return;
    try {
      const r = await Api.queueMutate(tab.tabId, body);
      if (r?.queue) setQueue(r.queue);
    } catch (e: any) {
      Api.log('Queue', 'mutate-failed', { op: (body as any).op, err: e?.message });
    }
  }, [tab.tabId]);

  // ── AskUserQuestion (interactive question from Claude) ───────────────────
  // When Claude asks a question, it arrives via the ask-question SSE event (and
  // we fetch any already-pending one on mount). While set, a purple frame wraps
  // the chat and the composer is replaced by the QuestionCard picker. Answering
  // POSTs to /answer-question (PTY drives TUI keystrokes, SDK resolves the
  // parked Promise); question-cancelled / the busy-reconcile clears it.
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);

  // Fetch any already-pending question on mount (covers connecting mid-question,
  // before the live ask-question event fires for this client).
  useEffect(() => {
    if (!tab.tabId) return;
    let cancelled = false;
    Api.pendingQuestion(tab.tabId).then((d) => {
      if (!cancelled && d?.pendingQuestion) setPendingQuestion(d.pendingQuestion);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [tab.tabId]);

  // Submit answers (or stop) for the active question.
  const answerQuestion = useCallback(async (answers: Record<string, string>, stop: boolean) => {
    if (!tab.tabId || !pendingQuestion || answeringQuestion) return;
    setAnsweringQuestion(true);
    try {
      await Api.answerQuestion(tab.tabId, {
        source: pendingQuestion.source,
        toolUseID: pendingQuestion.toolUseID,
        questions: pendingQuestion.questions,
        answers,
        stop,
      });
      // Optimistically clear; the question-cancelled SSE / PostToolUse will
      // confirm. On stop, the turn ends → busy reconcile clears "thinking…".
      setPendingQuestion(null);
    } catch (e: any) {
      Api.log('MobQuestion', 'answer-failed', { err: e?.message });
      setAnsweringQuestion(false);
    } finally {
      // Leave answeringQuestion true until the card unmounts (cleared above on
      // success-path setPendingQuestion(null) re-render); reset on error only.
    }
  }, [tab.tabId, pendingQuestion, answeringQuestion]);

  // Fetch lazily on first open so closed panels cost nothing.
  useEffect(() => {
    if (queueOpen && canQueue && !queue) refreshQueue();
  }, [queueOpen, canQueue, queue, refreshQueue]);
  // Also fetch the armed-count badge eagerly (so the header icon shows [N] even
  // before the user opens the panel) — only for AI tabs.
  useEffect(() => {
    if (canQueue && !queue) refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canQueue]);

  // ── Authoritative status reconciliation (self-healing) ───────────────────
  // Poll claude:get-presence on mount, on sessionId change, AND every 4s while
  // the tab is open. This is the safety net that makes the live channel
  // *eventually consistent* with the desktop truth, no matter what:
  //   • a busy:false / done SSE event is lost (e.g. you DECLINE an
  //     AskUserQuestion → "Request interrupted" → the turn ends through a path
  //     that didn't _webBroadcast busy:false → mobile latched "thinking…"),
  //   • the SSE socket silently drops a frame,
  //   • a bug in THIS mobile build mis-tracks busy.
  // get-presence derives status from claudeTurnBusy (the Stop-hook pipeline —
  // the same authoritative source the desktop loader trusts), so reconciling
  // `busy` against it heals any desync within one poll interval. This is the
  // "real connection back to production" — mobile never trusts its own latched
  // busy indefinitely; the periodic authoritative read always wins.
  // See fact-mobile-claude-pty.md::Self-healing busy reconciliation.
  useEffect(() => {
    if (!isClaudePtyTab || !tab.tabId) return;
    let cancelled = false;
    const poll = () => Api.claudeStatus(tab.tabId!).then((d) => {
      if (cancelled || !d?.status) return;
      setClaudeStatus(d.status);
      // Reconcile the loader: the authoritative status says whether a turn is
      // actually in flight. Only force-correct on disagreement so we don't
      // fight an in-flight optimistic update on the same frame.
      const authoritativeBusy = d.status === 'busy';
      setBusy((cur) => (cur !== authoritativeBusy ? authoritativeBusy : cur));
    }).catch(() => {});
    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId, isClaudePtyTab, sessionId]);

  // Resume/Stop loaders are driven by the SSE-sourced claudeStatus, NOT by the
  // HTTP reply (which returns in ~20ms, long before Claude is actually up). No
  // timeouts: the loader holds until the real lifecycle event arrives.
  //   • Resume in flight → clears when status flips to active|busy (Claude TUI
  //     rendered ⏵, broadcast via clearBridgeTab/ClaudePromptReady snapshot).
  //   • Stop in flight   → clears when status flips to inactive (PTY-exit /
  //     clearBridgeTab snapshot after the process actually died).
  useEffect(() => {
    if (resuming && (claudeStatus === 'active' || claudeStatus === 'busy')) {
      Api.log('MobResume', 'loader-cleared', { tabId: (tab.tabId || '').slice(-12), status: claudeStatus });
      setResuming(false);
    }
  }, [resuming, claudeStatus, tab.tabId]);
  useEffect(() => {
    if (stopping && claudeStatus === 'inactive') {
      Api.log('MobStop', 'loader-cleared', { tabId: (tab.tabId || '').slice(-12), status: claudeStatus });
      setStopping(false);
    }
  }, [stopping, claudeStatus, tab.tabId]);

  const onResume = async () => {
    if (!tab.tabId || resuming) return;
    Api.log('MobResume', 'click', { tabId: tab.tabId.slice(-12), status: claudeStatus, ssid: (tab.claudeSessionId || sessionId || '').slice(0, 8) });
    setResuming(true);
    const t0 = performance.now();
    try {
      const r = await Api.resumeClaudeTab(tab.tabId);
      Api.log('MobResume', 'reply-ok', { tabId: tab.tabId.slice(-12), elapsedMs: Math.round(performance.now() - t0), alreadyRunning: !!r?.alreadyRunning });
      if (r?.alreadyRunning) {
        // Claude was already live (mobile's SSE-derived status was stale vs the
        // bridge's authoritative presence check). No fresh active-snapshot will
        // arrive because the status never changed — clear the loader here and
        // sync the local status, else the spinner would hang forever.
        setClaudeStatus('active');
        setResuming(false);
      }
      // Otherwise loader stays ON — cleared by the claudeStatus→active|busy
      // effect when the SSE snapshot says Claude is really up.
    } catch (e: any) {
      Api.log('MobResume', 'reply-err', { tabId: tab.tabId.slice(-12), msg: String(e?.message || e) });
      setResuming(false); // HTTP itself failed — no lifecycle event will come
      alert('Resume failed: ' + e.message);
    }
  };

  const onHeaderStop = async () => {
    if (!tab.tabId || stopping) return;
    Api.log('MobStop', 'header-click', { tabId: tab.tabId.slice(-12), busy, status: claudeStatus });
    setStopping(true);
    try {
      const r = await Api.stop(tab.tabId);
      Api.log('MobStop', 'header-reply-ok', { tabId: tab.tabId.slice(-12), stopped: !!r?.stopped });
      if (r && r.stopped === false) {
        // No live process to kill (mobile status was stale vs the real PTY —
        // Claude already exited). No inactive-snapshot will arrive because the
        // process was already gone, so clear the loader + sync status here,
        // else STOPPING would hang forever.
        setClaudeStatus('inactive');
        setStopping(false);
      }
      // Otherwise loader stays ON until the claudeStatus→inactive effect clears
      // it (driven by the real PTY-exit SSE snapshot).
    } catch (e: any) {
      Api.log('MobStop', 'header-reply-err', { tabId: tab.tabId.slice(-12), msg: String(e?.message || e) });
      setStopping(false);
      alert('Stop failed: ' + e.message);
    }
  };

  const reducer = useRef(createMessageReducer());
  const esRef = useRef<EventSource | null>(null);
  // Virtuoso handle for programmatic scroll (GoTo, "scroll-to-bottom" FAB).
  const virtuosoRef = useRef<VirtualizerHandle | null>(null);
  // Ref to the scrollable parent — virtua needs this directly (not the
  // Virtualizer ref) so that flex-spacer pattern works. virtuoso owned the
  // scroller internally; in virtua the scroller is OUR div.
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  // Last seen scrollTop — for jitter telemetry (compute delta on each scroll).
  const lastScrollTopRef = useRef<number>(0);
  // True until we've performed the one-time "scroll to last message" after
  // the initial history load. Subsequent re-renders (WS updates, scrolls)
  // don't re-trigger — virtuoso handles them via followOutput / preserve.
  const didInitialScrollRef = useRef<boolean>(false);
  // Lock + queue for the phase-2 prefix-merge race. While the lock is held,
  // any WS message that arrives goes into the deferred queue rather than into
  // reducer (because reducer.reset() is about to be called and would clobber
  // any apply done between reset and the post-reset merged-replay).
  const prefixMergeLockRef = useRef<boolean>(false);
  const wsDeferredQueueRef = useRef<any[]>([]);
  // firstItemIndex: virtuoso's stable-index anchor for prepend operations.
  // Start huge so the value can only shrink — virtuoso uses delta-between-renders
  // to know "older messages were inserted, keep visible-item visible". We
  // decrement it by N each time the front of `entries` grows by N during the
  // initial stream (when older records arrive after tail records).
  const firstItemIndexRef = useRef<number>(1_000_000_000);
  const [firstItemIndex, setFirstItemIndex] = useState<number>(firstItemIndexRef.current);
  // Snapshot of `entries.length` last paint — used to detect prepend in the
  // streaming loop (delta = entries.length - prevLength).
  const prevEntriesLenRef = useRef<number>(0);

  // ── Helpers ─────────────────────────────────────────────────────────────

  // ── Scroll-jitter instrumentation ────────────────────────────────────────
  // Every time React state of `entries` changes, virtuoso may reflow → may
  // bump scrollTop → user perceives "jerk back". We log:
  //   - flushReducer: WHO triggered it, prev/new length
  //   - followOutput: what we told virtuoso (smooth/false), at what state
  //   - atBottomStateChange: when virtuoso reports bottom-state flip
  //   - WS message arrival during scroll: tag the offending event
  // Read in dev.log via `[ScrollDiag]` grep.
  const lastScrollDiagAtRef = useRef<number>(0);
  const scrollDiag = useCallback((tag: string, data?: any) => {
    // Throttle only the noisy `scroll` tag (raw onScroll spam). Edge-events
    // (flushReducer, followOutput, atBottomStateChange, isScrolling, ws-msg,
    // scrollToIndex, height-change) bypass the throttle — they're rare and
    // we need every one to reconstruct the jitter sequence.
    if (tag === 'scroll') {
      const now = performance.now();
      const force = data?.force;
      if (!force && now - lastScrollDiagAtRef.current < 80) return;
      lastScrollDiagAtRef.current = now;
    }
    Api.log('ScrollDiag', tag, data);
  }, []);

  // Apply a fresh reducer snapshot to React state + adjust firstItemIndex
  // when the change was a PREPEND (older records inserted at the front).
  // Returns the snapshot for further use.
  const flushReducer = useCallback((reason: 'append' | 'replace' | 'prepend-aware') => {
    const fresh = reducer.current.getEntries();
    const prev = prevEntriesLenRef.current;
    // Always log — even when length didn't change. A mutating entry (same
    // count, different content/height) still triggers a re-render and can
    // bump scrollTop. We need this signal to correlate with `scroll` events.
    scrollDiag('flushReducer', { reason, prev, next: fresh.length, changed: fresh.length !== prev });
    if (reason === 'prepend-aware' && fresh.length > prev) {
      // Determine if the additional entries are at the FRONT (prepend) by
      // checking whether the last entry's id matches prev's last entry's id.
      // Reducer is linear so a true append keeps the last entry stable.
      // For our streaming use case where older records always arrive after
      // tail (via after-cursor delta), additions are always at the END;
      // prepend only happens when reducer.reset() + replay-from-zero is
      // followed by an append of cached + new records. Simpler invariant:
      // if user is at bottom, do nothing special — virtuoso follows tail.
      // If user is NOT at bottom AND length grew at the front, shift index.
      // For now the streaming path uses 'replace' which handles this.
    }
    prevEntriesLenRef.current = fresh.length;
    setEntries(fresh);
    return fresh;
  }, []);

  // ── Timeline prefetch (independent of chat data) ────────────────────────
  useEffect(() => {
    if (!tab.tabId) return;
    if (!tab.claudeSessionId && tab.tabType !== 'claude-sdk' && tab.commandType !== 'claude') return;
    let cancelled = false;
    Api.timeline(tab.tabId)
      .then((d) => { if (!cancelled) setTimelineEntries(d.entries || []); })
      .catch(() => { if (!cancelled) setTimelineEntries([]); });
    return () => { cancelled = true; };
  }, [tab.tabId]);

  // Refetch when a turn completes (sessionId / entries.length / busy change).
  const refreshKey = `${sessionId || ''}:${entries.length}:${busy ? 1 : 0}`;
  useEffect(() => {
    if (!tab.tabId || !sessionId) return;
    if (timelineEntries === null) return;
    let cancelled = false;
    Api.timeline(tab.tabId)
      .then((d) => { if (!cancelled) setTimelineEntries(d.entries || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const toggleEntryExpanded = useCallback((uuid: string) => {
    setTimelineExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid); else next.add(uuid);
      return next;
    });
  }, []);

  // Clear module-level expanded-state Map when leaving the chat. Without this
  // the Maps accumulate every entry-id ever rendered across all chats — by
  // ~50K keys JS heap noticeably bloats. The trade-off: re-opening this same
  // chat resets thinking/tool-card open state to defaults. Acceptable for
  // mobile (sessions are short) and matches what users expect from a "fresh
  // open" anyway.
  useEffect(() => {
    return () => {
      const ids = reducer.current.getEntries().map((e) => e.id);
      clearEntryExpandedForIds(ids);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId]);

  // ── GoTo: virtuoso scrollToIndex by uuid match ──────────────────────────
  const goToEntry = useCallback((uuid: string) => {
    Api.log('TimelineGoTo', 'click', { uuid: uuid.slice(0, 8) });
    const all = reducer.current.getEntries();
    const targetIdx = all.findIndex(
      (e: any) => (e as any).entryUuid === uuid || (e as any).entryUuid?.startsWith(uuid.slice(0, 8))
    );
    if (targetIdx === -1) {
      Api.log('TimelineGoTo', 'no entry with uuid', { uuid: uuid.slice(0, 8) });
      // Still close the drawer so the user can see the chat — they may want
      // to scroll manually or try a different entry.
      setDrawerOpen(false);
      return;
    }
    // Close drawer + jump in one frame. Virtuoso handles the mount/measure
    // of off-screen items synchronously — no overlay needed because rendered
    // DOM is bounded (10-30 nodes total regardless of `entries.length`).
    setDrawerOpen(false);
    requestAnimationFrame(() => {
      scrollDiag('scrollToIndex', { from: 'goToEntry', index: targetIdx, align: 'center' });
      virtuosoRef.current?.scrollToIndex(targetIdx, { align: 'center' });
      // Trigger background highlight on the target row. The row renderer
      // reads `flashUuid` and applies a 1.5s transition.
      setFlashUuid(uuid);
      setTimeout(() => setFlashUuid(null), 1500);
      Api.log('TimelineGoTo', 'done', { uuid: uuid.slice(0, 8), idx: targetIdx });
    });
  }, []);

  // ── History load: hydrate from IDB → stream NDJSON delta ────────────────
  useEffect(() => {
    if (!tab.tabId) { setHistoryLoading(false); return; }
    if (!tab.claudeSessionId && tab.tabType !== 'claude-sdk' && tab.commandType !== 'claude') {
      setHistoryLoading(false);
      return;
    }
    // PTY+Claude tab created fresh (no sessionId yet): keep "loading" banner
    // hidden until the bridge watcher delivers the first message via WS — the
    // user sees empty chat with "No messages yet" placeholder while Claude CLI
    // boots, which matches the desktop UX.
    if (tab.commandType === 'claude' && !tab.claudeSessionId) {
      setHistoryLoading(false);
      return;
    }
    let cancelled = false;
    const tabIdLocal = tab.tabId;
    const tag = tabIdLocal?.slice(-12) || '';
    let cachedLastUuid: string | null = null;
    let streamHandle: ReturnType<typeof streamHistory> | null = null;

    (async () => {
      const t0 = performance.now();
      const tokenStr = (() => { try { return getToken() || ''; } catch { return ''; } })();
      const baseUrl = '/api/terminal-tabs/' + encodeURIComponent(tabIdLocal!) + '/history';

      // ─ Phase 0: hydrate from IDB (synchronous-ish, microseconds-fast) ─
      // sessionId in IDB is the Claude session UUID (stable across SDK
      // resumes); tab.tabId can change if the user closes/reopens the tab.
      const sid = tab.claudeSessionId || tab.live?.sessionId;
      if (sid) {
        try {
          const cached = await readCachedHistory(sid);
          if (cancelled) return;
          if (cached.messages.length > 0) {
            Api.log('History', 'cacheHit', { tag, sid: sid.slice(0, 8), count: cached.messages.length });
            reducer.current.reset();
            for (const m of cached.messages) reducer.current.apply(m);
            rawHistoryBufferRef.current = cached.messages.slice();
            flushReducer('replace');
            setHistoryLoading(false);
            cachedLastUuid = cached.meta?.lastUuid || null;
          }
        } catch (e: any) {
          Api.log('History', 'cacheError', { tag, msg: String(e?.message) });
        }
      }

      // ─ One-shot streaming runner ─────────────────────────────────────
      // Both phase-1 (tail) and phase-2 (prefix) use this — they share the
      // same parsing/throttling/error path. Returns the meta of the stream so
      // the caller can decide whether to chain the next phase.
      const runStream = (
        url: string,
        opts: { isPrefix: boolean; expectMessages?: number },
      ): Promise<StreamMeta | null> => new Promise((resolveStream) => {
        Api.log('History', 'streamFetch', { tag, url, isPrefix: opts.isPrefix });
        let metaLocal: StreamMeta | null = null;
        const incoming: any[] = [];
        let pendingFlush = false;
        const tStreamStart = performance.now();
        let bytesAtMeta = 0;

        const scheduleFlush = () => {
          if (pendingFlush || cancelled) return;
          pendingFlush = true;
          requestAnimationFrame(() => {
            pendingFlush = false;
            if (cancelled) return;
            // For PHASE 1 (tail) — incoming records ARE the new tail, append.
            // For PHASE 2 (prefix) — incoming records are OLDER than what's
            //   already in the reducer. Reducer is linear (assistant id chains)
            //   so we can't just prepend objects to its internal entries array.
            //   Instead we collect them in a sidebuffer and replay everything
            //   in correct order at onDone. (Per-frame replay would be O(n²).)
            while (incoming.length) {
              const m = incoming.shift();
              if (opts.isPrefix) {
                // Don't apply yet — accumulate into the prefix buffer below.
                prefixCollect.push(m);
              } else {
                reducer.current.apply(m);
                rawHistoryBufferRef.current.push(m);
              }
            }
            if (!opts.isPrefix) flushReducer('append');
            // Update progress for visible loader (only for the tail phase —
            // prefix loads silently).
            if (!opts.isPrefix) {
              setStreamProgress((p) => p && metaLocal ? { ...p, done: reducer.current.getEntries().length } : p);
            }
          });
        };

        const prefixCollect: any[] = [];

        streamHandle = streamHistory(url, tokenStr, {
          onMeta: (meta) => {
            metaLocal = meta;
            bytesAtMeta = (performance.now() - tStreamStart) | 0;
            Api.log('History', 'streamMeta', {
              tag, isPrefix: opts.isPrefix,
              total: meta.total, returned: meta.returned, truncated: meta.truncated,
              etag: meta.etag.slice(0, 8), tFirstByte: bytesAtMeta,
            });
            // Progress only for the visible (tail) phase, and only when there's
            // more than ~100 messages — short streams flash too fast to matter.
            if (!opts.isPrefix && meta.returned > 100) {
              setStreamProgress({ done: 0, total: meta.returned });
            }
          },
          onMessage: (msg) => {
            incoming.push(msg);
            scheduleFlush();
            if (!opts.isPrefix) {
              // Capture model/usage from latest assistant for the context badge.
              if (msg && msg.message?.model) setResolvedModel(msg.message.model);
              if (msg && msg.message?.usage) {
                const u = msg.message.usage;
                const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                if (total > 0) setUsedTokens(total);
              }
            }
          },
          onDone: async (done, bytesRead) => {
            // Final flush of any unflushed records.
            await new Promise<void>((rr) => requestAnimationFrame(() => rr()));
            if (cancelled) { resolveStream(metaLocal); return; }
            while (incoming.length) {
              const m = incoming.shift();
              if (opts.isPrefix) prefixCollect.push(m);
              else { reducer.current.apply(m); rawHistoryBufferRef.current.push(m); }
            }

            if (opts.isPrefix && prefixCollect.length > 0) {
              // ── PREFIX MERGE ──────────────────────────────────────────
              // Insert prefix BEFORE current reducer state. The reducer is
              // linear (assistant ids chain), so the cheapest correct path is:
              // reset → replay (prefix + existing raw buffer) → flush.
              // For 5000 records this is ~10ms total (no markdown parsing yet,
              // just object pushes into Map+Array).
              //
              // RACE GUARD: hold prefixMergeLockRef during reset+replay so any
              // WS message that arrives during this window goes into a queue
              // (see WS onmessage). Drain the queue after merge completes so
              // the message survives.
              prefixMergeLockRef.current = true;
              const tReplay = performance.now();
              const merged = prefixCollect.concat(rawHistoryBufferRef.current);
              rawHistoryBufferRef.current = merged;
              reducer.current.reset();
              for (const m of merged) reducer.current.apply(m);
              // Drain any WS messages that arrived during the lock window.
              const deferred = wsDeferredQueueRef.current;
              wsDeferredQueueRef.current = [];
              for (const m of deferred) {
                rawHistoryBufferRef.current.push(m);
                reducer.current.apply(m);
              }
              prefixMergeLockRef.current = false;
              flushReducer('replace');
              Api.log('History', 'prefixMerged', {
                tag, prefixCount: prefixCollect.length, totalCount: merged.length,
                deferredApplied: deferred.length,
                replayMs: Math.round(performance.now() - tReplay),
              });
            } else if (!opts.isPrefix) {
              flushReducer('replace');
              setHistoryLoading(false);
              setStreamProgress(null);
            }

            Api.log('History', 'streamDone', {
              tag, isPrefix: opts.isPrefix, written: done.written, bytesRead,
              tFirstByte: bytesAtMeta,
              streamMs: Math.round(performance.now() - tStreamStart),
            });
            resolveStream(metaLocal);
          },
          onError: (err, bytesRead) => {
            if (cancelled) { resolveStream(null); return; }
            Api.log('History', 'streamError', { tag, isPrefix: opts.isPrefix, msg: err.message, bytesRead });
            if (!opts.isPrefix) {
              setHistoryLoading(false);
              setStreamProgress(null);
            }
            if (/404/.test(err.message) && sid) dropSession(sid).catch(() => {});
            resolveStream(null);
          },
        });
      });

      // ─ Branch: warm-cache delta vs cold-tail-then-prefix ───────────────
      let finalMeta: StreamMeta | null = null;
      if (cachedLastUuid) {
        // Warm cache: we already have everything up to lastUuid in reducer.
        // Just ask for the delta. Server returns 0 messages if nothing changed
        // (silent). For chats that got new turns since last visit — append.
        finalMeta = await runStream(baseUrl + '?after=' + encodeURIComponent(cachedLastUuid), { isPrefix: false });
      } else {
        // Cold open. Phase 1: tail of last 200 messages. Paint, scroll bottom,
        // user can interact within ~1 second.
        const TAIL_N = 200;
        const tailMeta = await runStream(baseUrl + '?last=' + TAIL_N, { isPrefix: false, expectMessages: TAIL_N });
        if (cancelled) return;

        // Phase 2: if there's MORE history before what we got, fetch it as
        // prefix. firstUuid is the oldest record in the tail — `?before=` will
        // return everything strictly before it.
        if (tailMeta && tailMeta.firstUuid && tailMeta.total > tailMeta.returned) {
          finalMeta = await runStream(baseUrl + '?before=' + encodeURIComponent(tailMeta.firstUuid), { isPrefix: true });
          // Even if prefix stream returned no meta (error), keep tailMeta for
          // the IDB write — partial save beats no save.
          if (!finalMeta) finalMeta = tailMeta;
          // Critical: after prefix merge, the IDB write needs the FINAL
          // server-known total/etag/lastUuid (they're the same as tail since
          // tail is still the bottom — tail's lastUuid IS the global lastUuid).
          finalMeta = {
            ...finalMeta,
            total: tailMeta.total,
            lastUuid: tailMeta.lastUuid,
            firstUuid: finalMeta?.firstUuid ?? tailMeta.firstUuid,
            // etag of the full set differs from tail-only etag — but server
            // didn't tell us the global one. Use prefix's etag if present
            // (it's at least the etag of the prefix slice). For revalidation
            // semantics this is acceptable: next mount uses lastUuid for the
            // `?after=` delta, etag is only used for the prompts cache.
            etag: finalMeta?.etag ?? tailMeta.etag,
          };
        } else {
          finalMeta = tailMeta;
        }
      }

      // ─ Persist to IDB ─────────────────────────────────────────────────
      // Whether we did warm-delta or cold-tail-then-prefix, rawHistoryBufferRef
      // now holds the FULL message list in order. One transactional write
      // replaces whatever was in IDB.
      if (sid && finalMeta) {
        try {
          const fullList = rawHistoryBufferRef.current.slice();
          await writeFullHistory(sid, fullList, finalMeta.etag, finalMeta.total, finalMeta.lastUuid);
          Api.log('History', 'idbWrote', { tag, count: fullList.length, totalMs: Math.round(performance.now() - t0) });
        } catch (e: any) {
          Api.log('History', 'idbWriteError', { tag, msg: String(e?.message) });
        }
      }
    })();

    return () => {
      cancelled = true;
      streamHandle?.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId]);

  // ── Raw message buffer for IDB persistence ──────────────────────────────
  // The reducer derives UiEntry list and discards raw SDK messages. For IDB
  // persistence we need the originals (so the next mount can re-apply them
  // through the reducer to rebuild UiEntry state). Two writers push here:
  //  - streaming `onMessage` (history fetch) — for the initial load
  //  - WebSocket `onmessage` (live messages) — for ongoing turns
  // Both writes are append-only. On a delta fetch with cache present we seed
  // this buffer from IDB during hydration so the next IDB write is complete.
  const rawHistoryBufferRef = useRef<any[]>([]);

  // ── One-time scroll-to-bottom on initial load ───────────────────────────
  // Virtuoso's `initialTopMostItemIndex` is set ONCE on first render. At that
  // moment entries=[] (history hasn't streamed yet) → it locks index=0. When
  // entries fill in (~1-3 sec later) Virtuoso doesn't auto-scroll. So we do
  // it explicitly the FIRST time entries.length > 0 after mount. After that —
  // Virtuoso's followOutput handles new tail messages, scrolls preserve.
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (entries.length === 0) return;
    didInitialScrollRef.current = true;
    // Two rAFs: first lets virtuoso commit the entries-grew render, second
    // lets it finish layout/measure of the newly-mounted last item.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollDiag('scrollToIndex', { from: 'initialLoad', index: entries.length - 1, align: 'end' });
      virtuosoRef.current?.scrollToIndex(entries.length - 1, { align: 'end' });
    }));
  }, [entries.length]);

  // Register ChatView's scroll container so collapse-toggles deep in the virtua
  // list can re-stick to bottom (stickToggle). Re-runs when the ref attaches.
  useEffect(() => {
    registerScrollContainer(scrollParentRef.current);
    return () => registerScrollContainer(null);
  });

  // Pin to the exact bottom by writing scrollTop directly on OUR scroller.
  // Why not virtua's scrollToIndex(align:'end')? That lands a few px short or
  // fires its final event mid-glide, so the FAB could never reliably hide and
  // the next chunk re-measured as "not at bottom". scrollTop = scrollHeight
  // lands at the true 0px bottom every time, no glide, no short-land. We guard
  // it with programmaticScrollRef so the resulting onScroll is not mistaken for
  // a user gesture (which would disarm follow intent).
  // NOTE: declared ABOVE the streaming-follow effect that lists it in deps —
  // a useCallback referenced in a deps array must exist before that effect runs
  // (TDZ: "Cannot access 'pinToBottom' before initialization" otherwise).
  const pinToBottom = useCallback(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    const before = el.scrollTop;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastFollowOffsetRef.current = el.scrollTop;
    // Determinism canary: log every programmatic pin with the jump size and the
    // resulting residual distance from bottom. If auto-follow ever "dies" again,
    // grep [ScrollDiag] pin — absent pins during a stream = the follow effect
    // isn't firing (intent disarmed); pins present but residual>2 = layout not
    // settled (need an extra rAF). See fix-mobile-follow-bottom-intent.md canary.
    const residual = el.scrollHeight - el.scrollTop - el.clientHeight;
    scrollDiag('pin', { from: Math.round(before), to: Math.round(el.scrollTop), residual: Math.round(residual) });
    // Release the guard after the scroll event for this write has flushed.
    requestAnimationFrame(() => { programmaticScrollRef.current = false; });
  }, [scrollDiag]);

  // STREAMING auto-scroll: virtua has NO `followOutput`, so we re-implement it.
  // On EVERY entries change while follow intent is armed — whether a new tail
  // entry arrived OR the last entry's text/height grew (flushReducer('append')
  // re-emits a fresh array each chunk) — re-pin to the exact bottom. The gate
  // is the INTENT ref, not a distance flag: streaming-driven height growth can
  // momentarily blow past any distance threshold and would (in the old design)
  // permanently kill follow after the first chunk. Intent is only revoked by a
  // real upward user drag (see the outer onScroll handler). If the user scrolled
  // up to read, followBottomRef is false → their position is left untouched.
  useEffect(() => {
    if (!followBottomRef.current || entries.length === 0) return;
    if (!didInitialScrollRef.current) return; // initial-scroll effect owns first paint
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!followBottomRef.current) return; // re-check after the rAF gap
      scrollDiag('scrollToIndex', { from: 'followOutput', index: entries.length - 1, align: 'end' });
      pinToBottom();
    }));
  }, [entries, pinToBottom]);

  // ── Live channel via SSE (EventSource) ───────────────────────────────────
  // Was WebSocket. Switched to SSE because Yandex Browser / Chrome anti-tracker
  // extensions silently block ws:// to private LAN IPs — fetch() works but the
  // WS handshake never leaves the browser (deterministically observed: HTTP
  // 200, WS stuck readyState=0 forever, server sees zero upgrades; meanwhile
  // curl to the same host gets 101). SSE rides plain HTTP GET (/api/events),
  // which those layers don't touch. EventSource also has built-in reconnect,
  // so the hand-rolled backoff/watchdog/visibility machinery is gone — the
  // browser owns recovery. The onmessage parsing below is transport-agnostic
  // (same JSON envelope as WS). See fact-mobile-web.md::SSE transport.
  useEffect(() => {
    if (!tab.tabId) return;
    const tabIdLocal = tab.tabId;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const u = eventsUrl(tabIdLocal);
      Api.log('SSE', 'connect-attempt', { tag: tabIdLocal.slice(-12), host: location.host });
      const es = new EventSource(u);
      esRef.current = es;
      es.onopen = () => {
        if (cancelled) { try { es.close(); } catch {} return; }
        setWsState('open');
        Api.log('SSE', 'open', { tag: tabIdLocal.slice(-12) });
      };
      es.onerror = () => {
        if (cancelled) return;
        // EventSource auto-reconnects (readyState CONNECTING=0). Only surface
        // 'closed' when it truly gave up (readyState CLOSED=2).
        setWsState(es.readyState === 2 ? 'closed' : 'connecting');
        Api.log('SSE', 'error', { tag: tabIdLocal.slice(-12), readyState: es.readyState });
      };
      es.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          // Diagnostic: log every WS message TYPE so we can correlate
          // arrivals with scrollTop bumps. Don't log payload — too big.
          if (m.type === 'message') {
            const inner = m.message;
            scrollDiag('ws-msg', {
              type: m.type,
              innerType: inner?.type,
              role: inner?.message?.role,
              hasContent: Array.isArray(inner?.message?.content) ? inner.message.content.length : 0,
            });
          } else if (m.type === 'busy' || m.type === 'done') {
            scrollDiag('ws-msg', { type: m.type, busy: m.busy });
          }
          if (m.type === 'snapshot') {
            Api.log('MobWS', 'snapshot', { tab: (tab.tabId || '').slice(-12), busy: !!m.busy, sessionStatus: m.sessionStatus, sid: (m.sessionId || '').slice(0, 8) });
            if (m.sessionId) setSessionId(m.sessionId);
            setBusy(!!m.busy);
            // sessionStatus is set by the CLAUDE-tab fs-watcher snapshot when
            // a PTY+Claude tab is opened — gives the phone immediate truth
            // about active/busy/inactive without waiting for the periodic poll.
            if (m.sessionStatus && isClaudePtyTab) setClaudeStatus(m.sessionStatus);
          } else if (m.type === 'bridge-update') {
            // PTY+Claude only — main mirrors statusline bridge writes (model,
            // contextPct) so the phone header pill stays in sync without
            // polling. SDK has its own usage path via assistant SSE.
            if (m.model) setResolvedModel(m.model);
            if (typeof m.contextPct === 'number' && m.contextPct > 0) {
              // The header uses usedTokens / contextWindow to compute %; we
              // already have contextPct from main, so back-derive a token
              // count. Window depends on model — opus 1M, others 200K.
              const win = (m.model || '').toLowerCase().includes('1m') ? 1_000_000 : 200_000;
              setUsedTokens(Math.round(win * m.contextPct / 100));
            }
          } else if (m.type === 'queue-update') {
            // Prompt-queue delta pushed by the desktop usePromptQueueWebSync hook
            // whenever this tab's queue core changes (locally on desktop OR from
            // another phone). Keep our mirror live without re-fetching.
            if (m.queue) setQueue(m.queue as QueueCore);
          } else if (m.type === 'ask-question') {
            // Claude asked an interactive question (PTY-terminal or SDK). Show the
            // picker; purple frame wraps the chat. source distinguishes the answer
            // path. busy stays true (a question only exists mid-turn) — that's fine,
            // the QuestionCard replaces the "thinking…" composer anyway.
            Api.log('MobQuestion', 'ask', { tab: (tab.tabId || '').slice(-12), source: m.source, qs: (m.questions || []).length });
            setPendingQuestion({ source: m.source || 'pty', toolUseID: m.toolUseID || 'pty', questions: m.questions || [] });
          } else if (m.type === 'question-cancelled') {
            // Question answered/aborted at the desktop, or the turn ended — drop
            // the picker. (Answering FROM mobile also clears it locally on success.)
            Api.log('MobQuestion', 'cancelled', { tab: (tab.tabId || '').slice(-12), source: m.source });
            setPendingQuestion(null);
            setAnsweringQuestion(false);
          } else if (m.type === 'busy') {
            Api.log('MobWS', 'busy', { tab: (tab.tabId || '').slice(-12), busy: !!m.busy });
            setBusy(!!m.busy);
            // Bridge the new busy events that main now broadcasts for PTY+Claude
            // tabs (hook-driven) into the status string the Resume-banner check
            // depends on. Otherwise the composer would stay enabled while
            // Claude is mid-turn and a Send would race the previous prompt.
            if (isClaudePtyTab) setClaudeStatus(m.busy ? 'busy' : 'active');
          } else if (m.type === 'done') {
            Api.log('MobWS', 'done', { tab: (tab.tabId || '').slice(-12), sid: (m.sessionId || '').slice(0, 8) });
            setBusy(false);
            if (m.sessionId) setSessionId(m.sessionId);
            if (isClaudePtyTab) setClaudeStatus('active');
            // Turn ended naturally — clear in-flight refs so a later stop()
            // (no-op at this point) doesn't try to restore an old prompt.
            pendingPromptRef.current = null;
            assistantStartedThisTurnRef.current = false;
          } else if (m.type === 'message') {
            if (m.sessionId) setSessionId(m.sessionId);
            const inner = m.message;
            if (inner?.message?.model) setResolvedModel(inner.message.model);
            if (inner?.message?.usage) {
              const u = inner.message.usage;
              const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
              if (total > 0) setUsedTokens(total);
            }
            // Track whether the assistant has produced VISIBLE content for
            // the in-flight turn (text/thinking/tool_use). The synthetic user
            // bubble that main broadcasts at sdkStartQuery doesn't count —
            // only assistant-typed content. Used by stop() to decide whether
            // to restore the prompt to the composer.
            if (inner?.type === 'assistant' && Array.isArray(inner?.message?.content)) {
              const hasContent = inner.message.content.some((b: any) =>
                (b?.type === 'text' && b?.text?.length > 0) ||
                (b?.type === 'thinking' && b?.thinking?.length > 0) ||
                b?.type === 'tool_use'
              );
              if (hasContent) assistantStartedThisTurnRef.current = true;
            }
            // RACE GUARD: if a phase-2 prefix-merge is in flight, defer this
            // WS message — applying it now would race with reducer.reset().
            // Either the merge completes and processes the queue, or the
            // tab unmounts before that and the message is dropped (next mount
            // will re-fetch via IDB delta).
            if (prefixMergeLockRef.current) {
              wsDeferredQueueRef.current.push(inner);
              return;
            }
            rawHistoryBufferRef.current.push(inner);
            reducer.current.apply(inner);
            flushReducer('append');
            // If user is at bottom — virtuoso auto-follows via followOutput.
            // If they're scrolled up — virtuoso preserves position, that's fine.
          }
        } catch {}
      };
    };
    connect();

    return () => {
      cancelled = true;
      try { esRef.current?.close(); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId]);

  // Modify the streaming path to ALSO push raw messages into the buffer.
  // We do this via an indirection: wrap reducer.apply inside the consumer.
  // Done inline above via incoming buffer + apply loop — see streamFetch's
  // onMessage and onDone where we push to rawHistoryBufferRef.

  // Pin to the exact bottom by writing scrollTop directly on OUR scroller.
  const scrollChatToBottom = useCallback(() => {
    scrollDiag('scrollToIndex', { from: 'scrollChatToBottom', index: entries.length - 1, align: 'end' });
    // Tapping the FAB = "take me down AND keep me there". Re-arm follow intent
    // and pin. The arrow hides immediately (driven by intent, asserted here),
    // not by waiting for a distance recompute that may never land at <=2px.
    followBottomRef.current = true;
    setAtTrueBottom(true);
    // Two rAFs: let any pending height change commit, then land exactly at end.
    requestAnimationFrame(() => requestAnimationFrame(() => pinToBottom()));
  }, [entries.length, pinToBottom]);

  // Track the prompt that's currently in flight + whether the assistant has
  // emitted any content for it yet. `pendingPromptRef` is set on send, cleared
  // when the assistant produces visible output (text/thinking/tool_use). On
  // stop: if cleared → assistant already started → keep partial; if still set
  // → assistant produced nothing → restore prompt to composer.
  const pendingPromptRef = useRef<string | null>(null);
  const assistantStartedThisTurnRef = useRef<boolean>(false);

  const send = async () => {
    // Allow send when there's typed text OR at least one chip (a bare paste
    // with no covering message is still a valid prompt — desktop does the same).
    if ((!text.trim() && chips.length === 0) || !tab.tabId || busy) return;
    // Build the full prompt: chips (wrapped in <pasted_content>) + typed text.
    // Matches desktop onNew so the user-bubble renderer re-collapses each block.
    const parts: string[] = [];
    for (const c of chips) parts.push('<pasted_content>\n' + c.text + '\n</pasted_content>');
    const typed = text.trim();
    if (typed) parts.push(typed);
    else if (parts.length > 0) parts.push('Analyze this content');
    const prompt = parts.join('\n\n');
    if (!prompt.trim()) return;
    pendingPromptRef.current = prompt;
    assistantStartedThisTurnRef.current = false;
    setText('');
    setChips([]);
    setBusy(true);
    // Local optimistic push — instant feedback. Real JSONL record arrives via
    // WS in 100-500ms with the SAME text + a uuid, but reducer dedupes by
    // matching: if the last entry is a user-bubble with identical text and
    // no entryUuid yet, the real record's apply() sets the uuid on it
    // instead of pushing a duplicate. Synthetic broadcast from main is
    // dropped at the reducer level (see messages.ts::__webSynthetic skip).
    reducer.current.apply({ type: 'user', message: { role: 'user', content: prompt }, __pendingLocal: true });
    flushReducer('append');
    try {
      await Api.send(tab.tabId, prompt);
    } catch (e: any) {
      reducer.current.apply({ type: 'result', subtype: 'error', is_error: true, result: e.message });
      flushReducer('append');
      setBusy(false);
      pendingPromptRef.current = null;
    }
  };

  const stop = async () => {
    if (!tab.tabId) return;
    // Composer Stop = SOFT interrupt of the CURRENT TURN, NOT kill the session.
    // PTY+Claude → single Esc into the TUI (Claude stops generating, stays alive
    // at the prompt); SDK → close the query stream (process warm). The navbar
    // Stop ■ (onHeaderStop) is the one that KILLS the process — these are two
    // different actions. Before this fix the composer called Api.stop → SIGTERM
    // and the whole session died on a Stop tap. See fact-mobile-claude-pty.md.
    const earlyStop = !assistantStartedThisTurnRef.current && !!pendingPromptRef.current;
    const promptToRestore = pendingPromptRef.current;
    Api.log('MobStop', 'composer-click', { tabId: tab.tabId.slice(-12), busy, status: claudeStatus, earlyStop, isClaudePty: isClaudePtyTab });
    const t0 = performance.now();
    try { await Api.interrupt(tab.tabId); Api.log('MobStop', 'interrupt-ok', { tabId: tab.tabId.slice(-12), elapsedMs: Math.round(performance.now() - t0) }); } catch (e: any) { Api.log('MobStop', 'interrupt-err', { tabId: tab.tabId.slice(-12), msg: String(e?.message || e) }); }
    setBusy(false);
    Api.log('MobStop', 'after-setBusy-false', { tabId: tab.tabId.slice(-12) });
    if (earlyStop && promptToRestore) {
      // Restore the prompt to composer so user can edit + resubmit. Same UX
      // as desktop ClaudeSDKTab.onCancel "(B) assistant emitted nothing".
      // setText accepts a value or updater — use updater so a partial typing
      // by the user (rare race: typed something between stop tap and now)
      // is preserved as a prefix.
      setText((prev) => prev ? promptToRestore + '\n\n' + prev : promptToRestore);
    }
    pendingPromptRef.current = null;
    assistantStartedThisTurnRef.current = false;
  };

  const isTerminal = tab.tabType !== 'claude-sdk';
  const canTimeline = !!(sessionId || tab.claudeSessionId);
  // Params pill (model · effort): SDK tabs always; PTY tabs only when Claude
  // is actually live in the TUI (slash commands need an active prompt to
  // route through safePasteAndSubmit's Stash flow without losing user text).
  const canParams = !readOnly && !!tab.tabId && (!isTerminal || (isClaudePtyTab && (claudeStatus === 'active' || claudeStatus === 'busy')));

  // Context window per model: 1M for Opus 4.8+ (or any [1m] variant), 200K
  // otherwise. Pulled from the model id the API actually returned (not the
  // user-selected alias) so silent downgrades show the correct window.
  //
  // Show USED %, not remaining. Old formula (100 - used/window*100) showed
  // 92% at start of chat = "92% remaining" — but users read "92%" as "92%
  // full" and got confused. New formula matches mental model: 8% near start,
  // 92% near end. Color escalates with usage:
  //   < 75% → muted grey (plenty of room)
  //   75-90% → amber (consider /compact)
  //   > 90% → red (about to overflow)
  // 1M when: explicit [1m] tag, or Opus 4.8+ (1M-by-default on the API).
  // 4.5/4.6/4.7 Opus and all Sonnet/Haiku are 200K unless the [1m] variant.
  const contextWindow = (() => {
    const m = (resolvedModel || '').toLowerCase();
    if (/\[1m\]/.test(m)) return 1_000_000;
    const ov = m.match(/opus-(\d+)[-.](\d+)/);
    if (ov) { const v = `${ov[1]}.${ov[2]}`; if (v !== '4.5' && v !== '4.6' && v !== '4.7') return 1_000_000; }
    return 200_000;
  })();
  const contextPercent = usedTokens != null ? Math.max(0, Math.min(100, (usedTokens / contextWindow) * 100)) : null;
  const contextColor = contextPercent == null ? '#666'
    : contextPercent > 90 ? '#ef4444'
    : contextPercent > 75 ? '#f59e0b'
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
            {contextPercent != null && (!isTerminal || isClaudePtyTab) && (
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

        {/* Right: drawer-open burger with iteration count.
            Stop moved to the composer (replaces send button while busy) —
            send/stop is one mental action, having Stop top-right and Send
            bottom-right meant two different muscle paths for the same idea. */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: '0 0 auto', marginLeft: 'auto' }}>
          {/* Stop — kills Claude in the PTY (Ctrl+C × 2). Shell survives so a
              Resume from this same tab brings Claude back on the same sessionId. */}
          {isClaudePtyTab && (claudeStatus === 'active' || claudeStatus === 'busy' || stopping) && !readOnly && (
            <button
              className="noted-icon"
              disabled={stopping}
              style={{
                ...S.iconBtn,
                width: 'auto', minWidth: 32, paddingLeft: 8, paddingRight: 8,
                fontSize: 13, color: '#f87171', borderColor: 'rgba(248,113,113,0.4)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              }}
              onClick={onHeaderStop}
              title={stopping ? 'Stopping Claude…' : 'Stop Claude in this tab (keeps the session, Resume to reattach)'}
            >
              {stopping ? <><InlineSpinner color="#f87171" /><span style={{ fontSize: 11 }}>STOPPING</span></> : '■'}
            </button>
          )}
          {canQueue && (
            <button
              className="noted-icon"
              style={{
                ...S.iconBtn,
                width: 'auto', minWidth: 32, paddingLeft: 8, paddingRight: 8,
                gap: 5, fontSize: 13,
                // Armed (autoRun) → violet accent; open → neutral (it's a close ✕).
                color: queueOpen ? '#e0e0e0' : (queue?.autoRun ? '#a78bfa' : '#888'),
                borderColor: queueOpen ? 'rgba(255,255,255,0.18)' : (queue?.autoRun ? 'rgba(167,139,250,0.45)' : undefined),
              }}
              onClick={() => setQueueOpen((o) => !o)}
              title={queueOpen ? 'Close Run-after menu' : 'Run after — queue prompts'}
            >
              {queueOpen ? (
                // ✕ — collapse back into the icon (closes editor too, see panel).
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              ) : (
                <>
                  {/* List/queue glyph */}
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="8" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="8" y1="18" x2="20" y2="18" />
                    <circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none" />
                  </svg>
                  {/* Armed → violet [N] count. Plain count when items but not armed. */}
                  {activeQueueCount > 0 && (
                    <span style={{ fontSize: 11, color: queue?.autoRun ? '#a78bfa' : '#888', fontVariantNumeric: 'tabular-nums' }}>
                      [{activeQueueCount}]
                    </span>
                  )}
                </>
              )}
            </button>
          )}
          {canTimeline && (
            <button
              className="noted-icon"
              style={{
                ...S.iconBtn,
                width: 'auto', minWidth: 32, paddingLeft: 8, paddingRight: 8,
                gap: 6, fontSize: 13,
              }}
              onClick={() => setDrawerOpen(true)}
              title="Open timeline"
            >
              <span>☰</span>
              {timelineEntries && timelineEntries.length > 0 && (
                <span style={{ fontSize: 11, color: '#888', fontVariantNumeric: 'tabular-nums' }}>
                  [{timelineEntries.length}]
                </span>
              )}
            </button>
          )}
        </div>
      </div>
      {/* Streaming-progress strip — only shown when initial NDJSON is in
          flight AND we have meta.total. Determinate counter beats indeterminate
          spinner for waits > 3s (NN/g 2024). On warm-cache mount this never
          appears — IDB hydrate is synchronous. */}
      {historyLoading && streamProgress && streamProgress.total > 50 && (
        <div style={{
          padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 10,
          background: '#0e0e0e', borderBottom: '1px solid #161616',
          fontSize: 11, color: '#888', fontVariantNumeric: 'tabular-nums',
        }}>
          <span style={{ flex: 1 }}>Loading messages — {streamProgress.done.toLocaleString()} / {streamProgress.total.toLocaleString()}</span>
          <span style={{
            position: 'relative', width: 80, height: 3, background: '#222', borderRadius: 2,
          }}>
            <span style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              background: '#FFB382', borderRadius: 2,
              width: `${Math.max(2, Math.min(100, (streamProgress.done / streamProgress.total) * 100))}%`,
              transition: 'width 0.18s ease-out',
            }} />
          </span>
        </div>
      )}

      {/* Virtualized chat using virtua (migrated from react-virtuoso 2026-05-28
          after 4 days of hitting the iOS scroll-teleport cascade bug — see
          fix-mobile-scroll-teleport.md). Architecture:

          - OUR div is the scroll container (virtua doesn't own it). This means
            we control overflow, padding, momentum-scroll CSS, and most
            importantly: we pass scrollRef to Virtualizer so it knows where
            to listen for scroll/resize events.
          - flex-column + flex-grow:1 spacer + Virtualizer = "bottom-anchored
            chat layout" pattern documented in virtua 0.48.0 release notes
            (replaces the removed `reverse` prop).
          - overflow-anchor: none on the scroll container disables browser
            scroll-anchoring so virtua's own jump-compensation isn't fighting
            the browser. virtua sets this internally on the viewport too, but
            we set it on the outer to be defensive.
          - onScroll on the outer scroller drives follow INTENT (a ref, not a
            distance flag) + FAB visibility. Direction (delta) revokes/re-arms
            intent; height growth never produces an upward delta so streaming
            can't disarm it.
          - followOutput equivalent: useEffect on `entries` re-pins to bottom
            whenever follow intent is armed. Same UX semantics as virtuoso's
            auto-follow, but driven by intent instead of fragile distance.
          - ScrollDiag kept: same tags as before, helps if a future regression
            happens; teleport bug needed instrumentation to diagnose, virtua
            failure modes will need the same. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {historyLoading && entries.length === 0 && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
            zIndex: 1, pointerEvents: 'none',
          }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
            </div>
            <div style={{ color: '#666', fontSize: 12 }}>Loading history…</div>
          </div>
        )}
        {!historyLoading && entries.length === 0 && !busy && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#555', textAlign: 'center', fontSize: 13, padding: 30,
          }}>
            {readOnly && !tab.claudeSessionId
              ? 'No Claude session attached to this terminal — nothing to view.'
              : readOnly
                ? 'Empty session.'
                : 'No messages yet. Send something below.'}
          </div>
        )}
        {entries.length > 0 && (
          <div
            ref={scrollParentRef}
            onScroll={(e) => {
              // Single source of truth for follow intent + FAB visibility.
              // Read geometry straight off OUR scroller (it IS the scroll
              // container in the virtua architecture) — no dependence on
              // virtua's handle, which lags a frame behind the DOM.
              const el = e.currentTarget as HTMLDivElement;
              const offset = el.scrollTop;
              const distFromBottom = el.scrollHeight - offset - el.clientHeight;
              const REARM_PX = 80;   // within this of bottom → re-arm follow
              const TRUE_PX = 2;     // sub-pixel rounding tolerance for "exact"

              const prevOffset = lastFollowOffsetRef.current;
              const delta = prevOffset == null ? 0 : offset - prevOffset;
              lastFollowOffsetRef.current = offset;

              // A programmatic pin (pinToBottom) must not be read as a gesture.
              if (!programmaticScrollRef.current) {
                if (delta < -4) {
                  // Genuine upward drag → user wants to read history. Revoke
                  // follow intent. Height growth on the tail never produces a
                  // negative delta, so streaming can't trip this.
                  if (followBottomRef.current) {
                    followBottomRef.current = false;
                    scrollDiag('followIntent', { armed: false, reason: 'user-drag-up', delta: Math.round(delta) });
                  }
                } else if (distFromBottom <= REARM_PX) {
                  // User scrolled back down to the bottom band → re-arm.
                  if (!followBottomRef.current) {
                    followBottomRef.current = true;
                    scrollDiag('followIntent', { armed: true, reason: 'user-at-bottom', dist: Math.round(distFromBottom) });
                  }
                }
              }

              // FAB: hidden while following (we're pinned / will re-pin) or at the
              // exact bottom; shown only when the user has scrolled up to read.
              const nextTrueBottom = followBottomRef.current || distFromBottom <= TRUE_PX;
              setAtTrueBottom((prev) => (prev !== nextTrueBottom ? nextTrueBottom : prev));
            }}
            style={{
              height: '100%',
              overflowY: 'auto',
              overflowAnchor: 'none',
              WebkitOverflowScrolling: 'touch',
              display: 'flex',
              flexDirection: 'column',
              overscrollBehavior: 'contain',
            }}
          >
            {/* Bottom-anchor spacer: pushes the Virtualizer to the bottom when
                content is shorter than viewport. Without it, chat would sit
                at the top with empty space below. */}
            <div style={{ flexGrow: 1 }} />
            <Virtualizer
              ref={virtuosoRef}
              scrollRef={scrollParentRef}
              onScroll={(offset) => {
                // virtua-driven onScroll fires for both user scroll and
                // programmatic scrollToIndex. Used here only to detect that
                // virtua is alive — actual offset/atBottom logic is in the
                // outer div's onScroll above (it has access to scrollSize
                // via the handle, which is needed for atBottom math).
                const last = lastScrollTopRef.current ?? offset;
                const delta = offset - last;
                lastScrollTopRef.current = offset;
                if (Math.abs(delta) > 10) {
                  scrollDiag('scroll', { top: offset, delta, force: delta < -20 });
                }
              }}
              onScrollEnd={() => scrollDiag('isScrolling', { isScrolling: false })}
            >
              {entries.map((entry, _index) => {
                const uuid = (entry as any).entryUuid;
                const key = uuid || (entry as any).id || _index;
                return (
                  <div
                    key={key}
                    data-entry-uuid={uuid || undefined}
                    style={{
                      background: flashUuid && (uuid === flashUuid || uuid?.startsWith(flashUuid.slice(0, 8)))
                        ? 'rgba(255,178,130,0.18)'
                        : 'transparent',
                      transition: 'background 0.4s ease-out',
                    }}
                  >
                    <EntryView entry={entry} />
                  </div>
                );
              })}
            </Virtualizer>
            {/* Footer spacer. The "thinking…" indicator is NOT rendered here in
                the scroll list — it's pinned just above the composer (see below)
                so it stays visible while the user scrolls up through history,
                instead of being parked at the bottom of the transcript. */}
            <div style={{ height: 12 }} />
          </div>
        )}
      </div>
      <ScrollToBottomFAB visible={!atTrueBottom && entries.length > 0} onClick={scrollChatToBottom} side="right" />
      {/* "Starting Claude…" strip — Claude process exists (bridge known) but
          the TUI hasn't drawn its prompt yet. Sending now would race the
          handshake; show a neutral progress bar instead. Auto-flips to
          composer when main broadcasts inputReady (event-driven, no polling).
          See fact-claude-tui-mechanics.md::Section 2. */}
      {!readOnly && isClaudePtyTab && claudeStatus === 'starting' && !resuming && (
        <div style={{
          borderTop: '1px solid #1f1f1f',
          background: '#0e0e0e',
          padding: '14px max(10px, env(safe-area-inset-bottom)) 14px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          color: '#888', fontSize: 13,
        }}>
          <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
          <span>Starting Claude…</span>
        </div>
      )}
      {/* Resume banner — shown while a known-session tab is inactive, OR while a
          resume we just kicked off is still coming up (resuming holds the
          banner+spinner through the inactive→starting→active transition so the
          loader doesn't blink out mid-launch). Cleared by the SSE status event. */}
      {!readOnly && isClaudePtyTab && (tab.claudeSessionId || sessionId) && (claudeStatus === 'inactive' || resuming) && (
        <div style={{
          borderTop: '1px solid #1f1f1f',
          background: '#0e0e0e',
          padding: '10px 14px max(10px, env(safe-area-inset-bottom)) 14px',
        }}>
          {wsState !== 'open' && (
            <div style={{ marginBottom: 8, padding: '6px 12px', borderRadius: 10, background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#777', fontSize: 11, textAlign: 'center' }}>
              live-канал {wsState === 'connecting' ? 'подключается…' : 'переподключается…'} — Resume сработает, статус обновится как только канал поднимется
            </div>
          )}
          <button
            onClick={onResume}
            disabled={resuming || !tab.claudeSessionId}
            style={{
              width: '100%', padding: '14px 18px',
              borderRadius: 14, border: 'none',
              background: resuming ? '#3a2218' : '#DA7756',
              color: resuming ? '#DA7756' : '#1a1a1a',
              fontSize: 15, fontWeight: 600, cursor: resuming ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              touchAction: 'manipulation',
            }}
            title={resuming ? 'Resuming Claude — waiting for it to come up' : 'Resume the Claude CLI process for this tab'}
          >
            {resuming
              ? (<><InlineSpinner color="#DA7756" /><span>RESUMING…</span></>)
              : (<>▶ Resume Claude session</>)}
          </button>
          <div style={{ marginTop: 6, fontSize: 11, color: '#666', textAlign: 'center' }}>
            {resuming ? 'launching CLI · waiting for input prompt' : 'session stopped · JSONL preserved'}
          </div>
        </div>
      )}
      {/* "thinking…" — pinned directly ABOVE the composer, transparent bg, so it
          stays in view while the user scrolls up through the transcript (the old
          spot was the bottom of the scroll list → scrolled away). Plain text +
          animated dots, no card. Renders only when a turn is in flight AND the
          composer itself is showing (not during Starting/Resume banners, which
          carry their own progress UI). */}
      {!readOnly && busy && !pendingQuestion
        && !(isClaudePtyTab && claudeStatus === 'starting' && !resuming)
        && !(isClaudePtyTab && (tab.claudeSessionId || sessionId) && (claudeStatus === 'inactive' || resuming)) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 16px 0', background: 'transparent',
          color: '#888', fontSize: 12, pointerEvents: 'none',
        }}>
          <span>thinking</span>
          <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
        </div>
      )}
      {/* AskUserQuestion picker — replaces the composer while Claude is blocked
          on a question (mirror of the desktop SDKAskQuestion / PTY Ink dialog).
          Takes priority over the composer so the user must answer or stop. */}
      {!readOnly && pendingQuestion && pendingQuestion.questions.length > 0 && (
        <QuestionCard
          pending={pendingQuestion}
          answering={answeringQuestion}
          onAnswer={(answers) => answerQuestion(answers, false)}
          onStop={() => answerQuestion({}, true)}
        />
      )}
      {!readOnly && !pendingQuestion && !(isClaudePtyTab && claudeStatus === 'starting' && !resuming) && !(isClaudePtyTab && (tab.claudeSessionId || sessionId) && (claudeStatus === 'inactive' || resuming)) && (
        <Composer
          text={text}
          setText={setText}
          busy={busy}
          onSend={send}
          onStop={stop}
          chips={chips}
          setChips={setChips}
          onPickPrompt={(content) => {
            // Long saved prompts collapse into a chip (same as a long paste);
            // short ones append inline. Mirrors desktop Opt+V picker behaviour.
            if (content.length >= PASTE_THRESHOLD) {
              setChips((prev) => [...prev, {
                id: 'chip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                text: content,
                preview: content.slice(0, 60).replace(/\n/g, ' ') + '...',
              }]);
            } else {
              setText((prev) => prev ? `${prev}\n\n${content}` : content);
            }
          }}
        />
      )}
      {readOnly && tab.claudeSessionId && tab.tabType !== 'claude-sdk' && (
        <div style={{
          borderTop: '1px solid #1f1f1f',
          background: '#0e0e0e',
          padding: '10px 14px max(10px, env(safe-area-inset-bottom)) 14px',
        }}>
          <button
            onClick={onForkToSDK}
            disabled={forking}
            style={{
              width: '100%', padding: '14px 18px',
              borderRadius: 14, border: 'none',
              background: forking ? '#2a2a2a' : '#DA7756',
              color: forking ? '#666' : '#1a1a1a',
              fontSize: 15, fontWeight: 600, cursor: forking ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              touchAction: 'manipulation',
            }}
            title="Fork this Claude session into a new SDK chat"
          >
            {forking ? (
              <>
                <span style={S.dot} /> <span style={S.dot} /> <span style={S.dot} />
                <span>Forking…</span>
              </>
            ) : (
              <>↗ Fork to SDK chat</>
            )}
          </button>
        </div>
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
      {canQueue && queueOpen && queue && (
        <QueuePanel
          queue={queue}
          aiTabs={queueAiTabs}
          busy={busy}
          mutate={mutateQueue}
          onClose={() => setQueueOpen(false)}
        />
      )}
    </div>
  );
}

// Center-of-header pill: shows current model + effort, click opens param sheet.
// Loads from /api/terminal-tabs/:id/params on mount; updates locally + POST on save.
// `adaptive`/`disabled` (thinking) sits as a tiny caption beneath.
// Each entry's label is the SAME string used in both the Model picker pills
// (sheet) and as the candidate header pill — single source of truth.
// `default` keeps a leading marker so the user can see they're on the alias
// rather than the explicit opus value (both resolve to opus-4.8 [1M] in API).
// ── AskUserQuestion picker (mobile) ──────────────────────────────────────────
// Replaces the composer while Claude is blocked on a question. Tap-driven (no
// arrow keys on a phone). Single-select: tap an option → answer that question;
// when it's the only/last question this submits immediately. Multi-question:
// each question is answered in order, a sticky "Submit" bar finalises. multiSelect:
// tap toggles options, then Submit. "Respond manually" (Stop) aborts the question
// so the user can type free text — same semantics as desktop "Type something".
const Q_PURPLE = '#a78bfa';
const Q_PURPLE_BG = 'rgba(147,51,234,0.18)';
const Q_PURPLE_BORDER = 'rgba(168,85,247,0.9)';

function QuestionCard({ pending, answering, onAnswer, onStop }: {
  pending: PendingQuestion;
  answering: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  onStop: () => void;
}) {
  const questions = pending.questions;
  const multiQ = questions.length > 1;
  // Per-question selected labels. Single-select keeps one; multiSelect keeps many.
  const [selection, setSelection] = useState<Record<number, string[]>>({});
  // Which question is shown (multi-question wizard). Single question → always 0.
  const [qIdx, setQIdx] = useState(0);

  const q = questions[qIdx];
  const isMulti = !!q?.multiSelect;
  const sel = selection[qIdx] ?? [];

  const buildAnswers = useCallback((snapshot: Record<number, string[]>) => {
    const out: Record<string, string> = {};
    questions.forEach((qq, i) => {
      const s = snapshot[i];
      if (s && s.length) out[qq.question] = s.join(', ');
    });
    return out;
  }, [questions]);

  const allAnswered = questions.every((_qq, i) => (selection[i]?.length ?? 0) > 0);

  // Pick an option. Single-select: set + advance (or submit if last). multiSelect:
  // toggle membership, stay on the question (user taps Submit/Next).
  const pick = (label: string) => {
    if (answering) return;
    if (isMulti) {
      setSelection((prev) => {
        const cur = prev[qIdx] ?? [];
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
        return { ...prev, [qIdx]: next };
      });
      return;
    }
    // single-select
    const nextSel = { ...selection, [qIdx]: [label] };
    setSelection(nextSel);
    if (!multiQ) {
      // only question → submit immediately
      onAnswer(buildAnswers(nextSel));
    } else if (qIdx < questions.length - 1) {
      setQIdx(qIdx + 1);
    }
    // else: last question of many — wait for Submit (so user can review).
  };

  return (
    <div style={{
      // Plain composer-like surface — NO purple frame/line above the question.
      // Inside the chat it's already obvious this is a question (QUESTION badge +
      // the card replacing the composer); the purple rotating ring lives ONLY on
      // the tab/project cards in the lists, per user.
      borderTop: '1px solid #1f1f1f',
      background: '#0e0e0e',
      padding: '10px 14px max(10px, env(safe-area-inset-bottom)) 14px',
      maxHeight: '60vh', overflowY: 'auto',
      animation: 'noted-fade-in 0.18s ease-out',
    }}>
      {/* Header: purple QUESTION label (UPPERCASE → OCR-reliable per CLAUDE.md) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: Q_PURPLE,
          padding: '2px 8px', borderRadius: 999, background: Q_PURPLE_BG, border: `1px solid ${Q_PURPLE_BORDER}`,
        }}>QUESTION{multiQ ? ` ${qIdx + 1}/${questions.length}` : ''}</span>
        {q?.header && <span style={{ fontSize: 12, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.header}</span>}
        <div style={{ flex: 1 }} />
        {answering && <InlineSpinner color={Q_PURPLE} size={13} />}
      </div>

      {/* Multi-question tab strip — tap to jump, ✓ marks answered. */}
      {multiQ && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {questions.map((qq, i) => {
            const answered = (selection[i]?.length ?? 0) > 0;
            const active = i === qIdx;
            return (
              <button
                key={i}
                onClick={() => setQIdx(i)}
                style={{
                  fontSize: 11, padding: '3px 8px', borderRadius: 8, cursor: 'pointer',
                  background: active ? Q_PURPLE_BG : '#1a1a1a',
                  border: `1px solid ${active ? Q_PURPLE_BORDER : '#2a2a2a'}`,
                  color: active ? '#fff' : (answered ? Q_PURPLE : '#888'),
                  whiteSpace: 'nowrap',
                }}
              >{answered ? '✓ ' : ''}{qq.header || `Q${i + 1}`}</button>
            );
          })}
        </div>
      )}

      {/* Question text */}
      <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', marginBottom: 10, lineHeight: 1.4 }}>
        {q?.question}
      </div>

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(q?.options || []).map((opt, idx) => {
          const checked = sel.includes(opt.label);
          return (
            <button
              key={idx}
              onClick={() => pick(opt.label)}
              disabled={answering}
              style={{
                textAlign: 'left', width: '100%',
                padding: '11px 12px', borderRadius: 12,
                background: checked ? Q_PURPLE_BG : '#1a1a1a',
                border: `1px solid ${checked ? Q_PURPLE_BORDER : '#2a2a2a'}`,
                color: '#e8e8e8', cursor: answering ? 'wait' : 'pointer',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: checked ? Q_PURPLE : '#666', fontSize: 14, flexShrink: 0 }}>
                  {isMulti ? (checked ? '☑' : '☐') : (checked ? '◉' : '○')}
                </span>
                <span style={{ fontWeight: checked ? 600 : 500 }}>{opt.label}</span>
              </span>
              {opt.description && (
                <span style={{ color: '#888', fontSize: 12, marginLeft: 22, lineHeight: 1.35 }}>{opt.description}</span>
              )}
              {opt.preview && (
                <pre style={{
                  margin: '4px 0 0 22px', padding: '8px 10px', borderRadius: 8,
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
                  color: '#bbb', fontSize: 11, lineHeight: 1.4, maxHeight: 160, overflow: 'auto',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{opt.preview}</pre>
              )}
            </button>
          );
        })}
      </div>

      {/* Action bar: Submit (multiSelect / multi-question) + Respond manually (stop) */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button
          onClick={onStop}
          disabled={answering}
          style={{
            padding: '10px 14px', borderRadius: 12, border: '1px solid #2a2a2a',
            background: '#1a1a1a', color: '#aaa', fontSize: 13, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >Respond manually</button>
        <div style={{ flex: 1 }} />
        {(isMulti || multiQ) && (
          <button
            onClick={() => { if (!answering && allAnswered) onAnswer(buildAnswers(selection)); }}
            disabled={answering || !allAnswered}
            style={{
              padding: '10px 20px', borderRadius: 12, border: 'none',
              background: allAnswered ? Q_PURPLE : '#2a2a2a',
              color: allAnswered ? '#1a1a1a' : '#666',
              fontSize: 14, fontWeight: 700, cursor: allAnswered && !answering ? 'pointer' : 'default',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {answering && <InlineSpinner color="#1a1a1a" size={12} />}
            {isMulti && !multiQ ? 'Submit' : `Submit${multiQ ? ` (${questions.filter((_q, i) => (selection[i]?.length ?? 0) > 0).length}/${questions.length})` : ''}`}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Prompt-Queue ("Run after") bottom sheet ──────────────────────────────────
// Mobile mirror of the desktop PromptQueueOverlay. It owns NO queue state — every
// control POSTs a mutation op to the desktop store (Api.queueMutate) and the
// desktop App-root runner does the firing; `queue` here is the live core kept
// fresh by the queue-update SSE event. Layout mirrors desktop: two setting
// columns (left = on-tab pivot + first-delay; right = Run after / Stop after /
// Post toggles), then the queue list (max ~5 rows, then it scrolls), then Add.
// Tapping a chip or Add swaps the list region for an inline editor (Mirror
// Editing) — "окно редактирования под менюшкой". The header ✕ closes the whole
// sheet, which also closes the editor.
const Q_VIOLET = '#a78bfa';   // armed / Run-after
const Q_DEEP_VIOLET = '#8b5cf6'; // Run-after pointed at another tab
const Q_ORANGE = '#DA7756';   // Stop after / Post
const Q_RED = '#ef4444';      // Close after
const Q_DISABLED_BG = 'rgba(82, 18, 48, 0.48)';
const Q_DISABLED_BG_HOVER = 'rgba(104, 24, 60, 0.56)';
const Q_DISABLED_TEXT = '#d8c5cf';
const Q_AI_KIND_COLOR: Record<QueueAiTab['kind'], string> = {
  'claude-pty': '#DA7756', 'claude-sdk': '#D28C5A', 'gemini': '#4E86F8', 'codex': '#10A37F',
};

function isQueueItemEnabled(it: { enabled?: boolean }) {
  return it.enabled !== false;
}

function countActiveQueueItems(items: { enabled?: boolean }[]) {
  return items.reduce((sum, it) => sum + (isQueueItemEnabled(it) ? 1 : 0), 0);
}

function queueItemTitle(it: { title?: string; text: string }) {
  return (it.title || '').trim() || `[${Array.from(it.text || '').length} символов]`;
}

function QueueToggle({ label, on, color, onClick, sub }: {
  label: string; on: boolean; color: string; onClick: () => void; sub?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', padding: '9px 10px', borderRadius: 10,
        background: on ? `${color}22` : '#222',
        border: `1px solid ${on ? color : '#2a2a2a'}`,
        color: on ? color : '#bbb',
        fontSize: 13, fontWeight: 500, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        textAlign: 'center',
      }}
    >
      {label}{sub}
    </button>
  );
}

function QueuePanel({ queue, aiTabs, busy, mutate, onClose }: {
  // tabId is intentionally NOT a prop — `mutate` is pre-bound to the tab by the
  // parent (ChatView). Keeping the panel tab-agnostic avoids a second source of
  // truth for "which tab".
  queue: QueueCore;
  aiTabs: QueueAiTab[];
  busy: boolean;
  mutate: (body: QueueOp) => Promise<void>;
  onClose: () => void;
}) {
  // Editor: null = list view; { id } = editing chip; { id:null } = new prompt;
  // { post:true } = editing the per-tab post-prompt body.
  const [editor, setEditor] = useState<{ id: string | null; post?: boolean } | null>(null);
  const [editorText, setEditorText] = useState('');
  const [tabPickerOpen, setTabPickerOpen] = useState(false);
  const [delayText, setDelayText] = useState(queue.firstDelaySeconds === 0 ? '' : String(queue.firstDelaySeconds));

  // Mirror external delay changes into the local input when not focused-editing.
  useEffect(() => {
    setDelayText(queue.firstDelaySeconds === 0 ? '' : String(queue.firstDelaySeconds));
  }, [queue.firstDelaySeconds]);

  const openNew = () => { setEditorText(''); setEditor({ id: null }); };
  const openEdit = (id: string, text: string) => { setEditorText(text); setEditor({ id }); };
  const openPost = () => { setEditorText(queue.postPromptText || ''); setEditor({ id: null, post: true }); };
  const closeEditor = () => { setEditor(null); setEditorText(''); };

  const saveEditor = async () => {
    if (!editor) return;
    if (editor.post) {
      await mutate({ op: 'setPostPromptText', args: { value: editorText } });
      closeEditor();
      return;
    }
    const t = editorText.trim();
    if (!t) { closeEditor(); return; }
    if (editor.id) await mutate({ op: 'update', args: { id: editor.id, text: t } });
    else await mutate({ op: 'add', args: { text: t } });
    closeEditor();
  };

  const targetTab = queue.runAfterTabId ? aiTabs.find((t) => t.id === queue.runAfterTabId) : null;
  const activeCount = countActiveQueueItems(queue.items);

  return (
    <div
      // Backdrop. Tap outside the card closes the whole sheet (and editor).
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
          padding: '8px 16px max(16px, env(safe-area-inset-bottom)) 16px',
          maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          animation: 'noted-sheet-up 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header: title + armed badge + ✕ (closes sheet & editor). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 12px' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e0' }}>Run after</span>
          {queue.autoRun && (
            <span style={{
              fontSize: 11, fontWeight: 600, color: Q_VIOLET, fontVariantNumeric: 'tabular-nums',
              padding: '1px 7px', borderRadius: 999, border: `1px solid ${Q_VIOLET}55`, background: `${Q_VIOLET}1a`,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: Q_VIOLET, animation: busy ? 'mob-mic-pulse 1.4s ease-in-out infinite' : 'none' }} />
              armed [{activeCount}]
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30, height: 30, borderRadius: 8, border: '1px solid #2a2a2a',
              background: '#222', color: '#bbb', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        {/* ── Settings: two columns ────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
          {/* LEFT col: on-tab pivot + first-delay seconds */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              onClick={() => setTabPickerOpen((o) => !o)}
              title="Wait for another tab's turn to end before firing"
              style={{
                width: '100%', padding: '9px 10px', borderRadius: 10,
                background: targetTab ? `${Q_DEEP_VIOLET}22` : '#222',
                border: `1px solid ${targetTab ? Q_DEEP_VIOLET : '#2a2a2a'}`,
                color: targetTab ? Q_DEEP_VIOLET : '#bbb',
                fontSize: 12, fontWeight: 500, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                whiteSpace: 'nowrap', overflow: 'hidden',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {targetTab ? targetTab.name : 'on tab'}
              </span>
              <span style={{ color: '#666', fontSize: 10, flexShrink: 0 }}>▾</span>
            </button>
            <input
              type="number" min={0} max={3600} inputMode="numeric"
              value={delayText}
              placeholder="delay s"
              disabled={queue.autoRun}
              onChange={(e) => setDelayText(e.target.value)}
              onBlur={() => {
                const n = Number(delayText);
                const clamped = Number.isFinite(n) && n > 0 ? Math.min(3600, Math.floor(n)) : 0;
                mutate({ op: 'setFirstDelaySeconds', args: { value: clamped } });
                setDelayText(clamped === 0 ? '' : String(clamped));
              }}
              style={{
                width: '100%', padding: '9px 10px', borderRadius: 10,
                background: '#222', border: '1px solid #2a2a2a',
                color: queue.autoRun ? '#555' : '#ddd', fontSize: 13,
                textAlign: 'center', outline: 'none', boxSizing: 'border-box',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
          </div>

          {/* RIGHT col: Run after / Stop after / Post toggles */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <QueueToggle
              label="Run after" on={queue.autoRun} color={Q_VIOLET}
              onClick={() => mutate({ op: 'setAutoRun', args: { value: !queue.autoRun } })}
              sub={<span style={{ width: 6, height: 6, borderRadius: '50%', background: queue.autoRun ? Q_VIOLET : '#555', animation: queue.autoRun && busy ? 'mob-mic-pulse 1.4s ease-in-out infinite' : 'none' }} />}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1 }}>
                <QueueToggle
                  label={queue.closeAfter ? 'Close after' : 'Stop after'}
                  on={queue.stopAfter || queue.closeAfter}
                  color={queue.closeAfter ? Q_RED : Q_ORANGE}
                  onClick={() => mutate({ op: 'setStopAfter', args: { value: !queue.stopAfter } })}
                />
              </div>
              {/* Close-after toggle (power icon) — cascades stopAfter on. */}
              <button
                onClick={() => mutate({ op: 'setCloseAfter', args: { value: !queue.closeAfter } })}
                title="Also close the tab after Claude stops"
                style={{
                  width: 38, borderRadius: 10,
                  background: queue.closeAfter ? `${Q_RED}22` : '#222',
                  border: `1px solid ${queue.closeAfter ? Q_RED : '#2a2a2a'}`,
                  color: queue.closeAfter ? Q_RED : '#888', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
                </svg>
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1 }}>
                <QueueToggle
                  label="Post" on={queue.postPromptEnabled} color={Q_ORANGE}
                  onClick={() => mutate({ op: 'setPostPromptEnabled', args: { value: !queue.postPromptEnabled } })}
                />
              </div>
              {/* Pencil — edit the post-prompt body. */}
              <button
                onClick={openPost}
                title="Edit post-prompt text (appended to every queued prompt)"
                style={{
                  width: 38, borderRadius: 10,
                  background: editor?.post ? `${Q_ORANGE}22` : '#222',
                  border: `1px solid ${editor?.post ? Q_ORANGE : '#2a2a2a'}`,
                  color: queue.postPromptEnabled || editor?.post ? Q_ORANGE : '#888', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* On-tab pivot dropdown (inline list of sibling AI tabs). */}
        {tabPickerOpen && (
          <div style={{
            marginBottom: 10, border: '1px solid #2a2a2a', borderRadius: 10,
            background: '#111', maxHeight: 180, overflowY: 'auto',
          }}>
            <button
              onClick={() => { mutate({ op: 'setRunAfterTab', args: { value: null } }); setTabPickerOpen(false); }}
              style={{ width: '100%', padding: '10px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid #1f1f1f', color: !queue.runAfterTabId ? Q_DEEP_VIOLET : '#888', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}
            >— no target (this tab) —</button>
            {aiTabs.length === 0 && (
              <div style={{ padding: '10px 12px', color: '#555', fontSize: 12 }}>no other AI tabs</div>
            )}
            {aiTabs.map((t) => {
              const sel = queue.runAfterTabId === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => { mutate({ op: 'setRunAfterTab', args: { value: sel ? null : t.id } }); setTabPickerOpen(false); }}
                  style={{ width: '100%', padding: '10px 12px', background: sel ? `${Q_DEEP_VIOLET}1a` : 'transparent', border: 'none', borderBottom: '1px solid #1f1f1f', color: sel ? Q_DEEP_VIOLET : '#ccc', fontSize: 13, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: Q_AI_KIND_COLOR[t.kind], flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* ── Body: list view OR editor (Mirror Editing) ───────────────────── */}
        {editor ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            <div style={{ fontSize: 11, color: '#888' }}>
              {editor.post ? 'Post-prompt · appended to every queued prompt' : (editor.id ? 'Edit prompt' : 'New prompt')}
            </div>
            <textarea
              autoFocus
              value={editorText}
              onChange={(e) => setEditorText(e.target.value)}
              placeholder={editor.post ? 'Text appended after each queued prompt…' : 'Type or paste a prompt…'}
              style={{
                width: '100%', boxSizing: 'border-box',
                // ~5 visible rows then scroll (≈ 22px line-height × 5 + padding).
                minHeight: 120, maxHeight: 130, overflowY: 'auto',
                background: '#0e0e0e', color: '#e0e0e0',
                border: '1px solid #FFB382', borderRadius: 12, padding: '10px 12px',
                fontSize: 14, lineHeight: 1.45, resize: 'none', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={closeEditor} style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid #2a2a2a', background: '#222', color: '#bbb', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveEditor} style={{ padding: '9px 18px', borderRadius: 10, border: 'none', background: '#FFB382', color: '#1a1a1a', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save</button>
            </div>
          </div>
        ) : (
          <>
            {/* Queue list — up to ~5 rows then scrolls. */}
            <div style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', maxHeight: 5 * 52, border: '1px solid #1f1f1f', borderRadius: 12, background: '#111' }}>
              {queue.items.length === 0 ? (
                <div style={{ padding: '18px 12px', textAlign: 'center', color: '#555', fontSize: 12 }}>
                  queue is empty — Add a prompt below
                </div>
              ) : (
                queue.items.map((it) => {
                  const title = queueItemTitle(it);
                  const enabled = isQueueItemEnabled(it);
                  return (
                    <div
                      key={it.id}
                      onClick={() => openEdit(it.id, it.text)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '11px 12px', borderBottom: '1px solid #1a1a1a',
                        background: enabled ? 'transparent' : Q_DISABLED_BG,
                        color: enabled ? '#ddd' : Q_DISABLED_TEXT,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: enabled ? '#ddd' : Q_DISABLED_TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {title}
                      </span>
                      {it.images > 0 && <span style={{ fontSize: 11, color: Q_ORANGE, flexShrink: 0 }}>📎{it.images}</span>}
                      <button
                        onClick={(e) => { e.stopPropagation(); mutate({ op: 'update', args: { id: it.id, enabled: !enabled } }); }}
                        aria-label={enabled ? 'Disable prompt in queue' : 'Enable prompt in queue'}
                        style={{
                          flexShrink: 0,
                          width: 26, height: 26, borderRadius: 7,
                          border: 'none',
                          background: enabled ? 'transparent' : Q_DISABLED_BG_HOVER,
                          color: enabled ? '#777' : Q_DISABLED_TEXT,
                          fontSize: 15,
                          cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >{enabled ? '☑' : '☐'}</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); mutate({ op: 'remove', args: { id: it.id } }); }}
                        aria-label="Remove"
                        style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', color: '#777', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      >×</button>
                    </div>
                  );
                })
              )}
            </div>

            {/* Add + clear-all row */}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                onClick={openNew}
                style={{ flex: 1, padding: '12px', borderRadius: 12, border: '1px dashed #3a3a3a', background: '#181818', color: '#ccc', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
              >+ Add prompt</button>
              {queue.items.length > 0 && (
                <button
                  onClick={() => mutate({ op: 'clear' })}
                  style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid #2a2a2a', background: '#181818', color: '#888', fontSize: 13, cursor: 'pointer' }}
                >Clear</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const SDK_MODELS = [
  { value: 'default', label: 'default · opus-4.8 [1M]' },
  { value: 'opus',    label: 'opus-4.8 [1M]' },
  { value: 'sonnet',  label: 'sonnet-4.6' },
  { value: 'haiku',   label: 'haiku-4.5' },
];
// Header shows the resolved model name even when the alias is `default`,
// so the badge reflects what the API will actually serve.
const HEADER_MODEL_LABEL: Record<string, string> = {
  default: 'opus-4.8 [1M]',
  opus:    'opus-4.8 [1M]',
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

  // Returns the in-flight promise so ParamsSheet can show a spinner on the
  // tapped pill and close the sheet only once the change has been applied.
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
  onChange: (p: Partial<typeof params>) => Promise<void> | void;
  onDismiss: () => void;
}) {
  // The pill the user just tapped, while its change is being applied. That pill
  // shows a spinner (mirrors the desktop ControlBar's in-flight loader); when
  // the apply resolves we close the whole sheet. `busy` non-null also blocks
  // further taps so a second selection can't race the first.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Run a change: mark the pill busy, await the apply, then dismiss. If apply
  // throws (alerted upstream) we still clear busy and leave the sheet open so
  // the user can retry.
  const pick = async (key: string, partial: Partial<typeof params>) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await onChange(partial);
      onDismiss();
    } catch {
      setBusyKey(null);
    }
  };

  return (
    <div
      // Dismiss ONLY when the tap lands on the backdrop itself. On iOS Safari a
      // tap on an inner <button> can retarget/bubble such that a naked
      // `onClick={onDismiss}` here fires too (stopPropagation on the card is not
      // enough — touch event retargeting + the synthetic click on the backdrop
      // both reach this handler). Guarding on `e.target === e.currentTarget`
      // makes a pill tap never reach the backdrop; the sheet then closes itself
      // AFTER the apply resolves (see pick()), not on the raw tap.
      onClick={(e) => { if (e.target === e.currentTarget && !busyKey) onDismiss(); }}
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
            <ParamPill key={m.value} active={params.model === m.value}
              busy={busyKey === 'model:' + m.value} disabled={!!busyKey}
              onClick={() => pick('model:' + m.value, { model: m.value })}>
              {m.label}
            </ParamPill>
          ))}
        </ParamRow>

        <ParamRow label="Effort">
          {SDK_EFFORTS.map((e) => (
            <ParamPill key={e} active={params.effort === e}
              busy={busyKey === 'effort:' + e} disabled={!!busyKey}
              onClick={() => pick('effort:' + e, { effort: e })}>
              {e}
            </ParamPill>
          ))}
        </ParamRow>

        <ParamRow label="Thinking">
          {/* Single toggle pill (mirrors the desktop Think button) — tap flips
              on↔off. Not two on/off pills: Think is a binary toggle, and for PTY
              tabs each change dispatches a meta+t flip, so the UI must read as
              one switch, not a 2-option selector. */}
          <ParamPill
            active={params.thinking === 'adaptive'}
            busy={busyKey === 'think'} disabled={!!busyKey}
            onClick={() => pick('think', { thinking: params.thinking === 'adaptive' ? 'disabled' : 'adaptive' })}
          >
            {params.thinking === 'adaptive' ? 'Think ON' : 'Think OFF'}
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
function Composer({ text, setText, busy, onSend, onStop, onPickPrompt, chips, setChips }: {
  text: string;
  setText: (v: string | ((prev: string) => string)) => void;
  busy: boolean;
  onSend: () => void;
  onStop: () => void;
  onPickPrompt: (content: string) => void;
  chips: PasteChip[];
  setChips: (v: PasteChip[] | ((prev: PasteChip[]) => PasteChip[])) => void;
}) {
  // Which chip's full body is expanded inline (tap chip to toggle preview).
  const [previewChipId, setPreviewChipId] = useState<string | null>(null);
  const addChip = (body: string) => {
    setChips((prev) => [...prev, {
      id: 'chip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      text: body,
      preview: body.slice(0, 60).replace(/\n/g, ' ') + '...',
    }]);
  };
  const removeChip = (id: string) => {
    setChips((prev) => prev.filter((c) => c.id !== id));
    setPreviewChipId((cur) => (cur === id ? null : cur));
  };
  const handlePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData('text/plain');
    if (pasted.length >= PASTE_THRESHOLD) {
      e.preventDefault();
      addChip(pasted);
    }
    // Short pastes fall through to the textarea's native paste.
  };
  const taRef = useRef<HTMLTextAreaElement>(null);
  // True only when textarea content overflows the 40vh cap. Used to toggle
  // overflowY: hidden|auto so a single-line input never shows a scrollbar
  // (visual noise), but a multi-line dump gets an explicit orange scroll
  // track that the user can grab. Separate from the chat-history scrollbar.
  const [hasScroll, setHasScroll] = useState(false);

  // Voice dictation (Soniox real-time). Mounts a DictationSession on click;
  // partial+final tokens stream into the textarea at the END of whatever the
  // user already typed (snapshot taken at start so we never clobber it).
  const [recording, setRecording] = useState(false);
  const [dictError, setDictError] = useState<string | null>(null);
  const dictRef = useRef<DictationSession | null>(null);
  const prefixRef = useRef('');
  const startDictation = async () => {
    if (recording) return;
    prefixRef.current = text;
    setDictError(null);
    setRecording(true);
    const session = new DictationSession({
      fetchToken: async () => {
        const r = await Api.sonioxToken();
        if (!r?.api_key) throw new Error('no api_key returned');
        return r.api_key;
      },
      onUpdate: ({ final, partial }) => {
        setText(prefixRef.current + final + partial);
      },
      onError: (msg) => { setDictError(msg); },
      onStopped: () => {
        dictRef.current = null;
        setRecording(false);
        // Refocus the textarea so the user can keep typing inline. Drop the
        // dictation prefix snapshot — next dictation session resnapshots.
        prefixRef.current = '';
        requestAnimationFrame(() => {
          const ta = taRef.current;
          if (!ta) return;
          ta.focus();
          try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
        });
      },
      languageHints: ['en', 'ru'],
    });
    dictRef.current = session;
    await session.start();
  };
  const stopDictation = () => {
    const s = dictRef.current;
    if (s) s.stop();
    else setRecording(false);
  };
  // Cleanup on unmount — don't leave the mic stream open if the chat view
  // tears down (navigation, logout).
  useEffect(() => () => { dictRef.current?.stop(); }, []);

  // Autogrow: set height = scrollHeight, capped at 40vh. Resets to single-row
  // baseline when text is empty (otherwise textarea sticks at last grown size).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.4);
    const sh = ta.scrollHeight;
    const next = Math.min(sh, max);
    ta.style.height = next + 'px';
    setHasScroll(sh > max);
  }, [text]);

  return (
    <div style={{
      borderTop: '1px solid #1f1f1f',
      background: '#0e0e0e',
      padding: '8px 12px max(8px, env(safe-area-inset-bottom)) 12px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      {/* Paste-chip bar — long pasted/picked text collapses here instead of
          flooding the textarea. Tap a chip to preview its full body; tap the ×
          to discard. Mirror of desktop SDK chip bar (blue pill grammar). */}
      {chips.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {chips.map((chip) => (
              <span
                key={chip.id}
                onClick={() => setPreviewChipId((cur) => (cur === chip.id ? null : chip.id))}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  maxWidth: '100%',
                  padding: '4px 8px', borderRadius: 8,
                  fontSize: 12,
                  background: 'rgba(107,138,255,0.15)',
                  color: '#8ba4ff',
                  border: '1px solid rgba(107,138,255,0.25)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chip.preview}</span>
                <span style={{ fontSize: 10, color: '#6679cc', flexShrink: 0 }}>{chip.text.length.toLocaleString()}</span>
                <span
                  role="button"
                  aria-label="Remove chip"
                  onClick={(e) => { e.stopPropagation(); removeChip(chip.id); }}
                  style={{
                    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 16, height: 16, borderRadius: 4,
                    color: '#8ba4ff', opacity: 0.7,
                  }}
                >✕</span>
              </span>
            ))}
          </div>
          {previewChipId && (() => {
            const pc = chips.find((c) => c.id === previewChipId);
            if (!pc) return null;
            return (
              <pre style={{
                margin: 0, padding: '8px 10px',
                fontSize: 12, lineHeight: 1.45,
                color: '#aaa',
                background: '#1a1a1a',
                border: '1px solid #333', borderRadius: 10,
                maxHeight: 200, overflowY: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>{pc.text}</pre>
            );
          })()}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={busy ? 'Claude is replying…' : 'Message Claude…'}
        rows={1}
        className={hasScroll ? 'composer-textarea composer-textarea--scroll' : 'composer-textarea'}
        style={{
          width: '100%', minHeight: 36,
          background: '#1a1a1a',
          // Permanent orange ring — user reads "this is THE input, type here"
          // at a glance, no matter where the focus currently lives (history
          // selection, off-screen, blurred by iOS keyboard close, etc.).
          // Box-shadow gives a subtle outer glow so the field reads as the
          // primary affordance without screaming.
          border: '1px solid #FFB382',
          boxShadow: '0 0 0 1px rgba(255,178,130,0.25)',
          borderRadius: 14,
          padding: '10px 14px',
          fontSize: 15, lineHeight: 1.4,
          color: '#e0e0e0', outline: 'none',
          resize: 'none',
          overflowY: hasScroll ? 'auto' : 'hidden',
        }}
        onPaste={handlePaste}
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
        {/* 🎤 voice — Soniox real-time dictation. One-click toggle: tap to
            start (mic permission prompt on first use), tap again to stop.
            While recording: orange tint + pulse, the textarea fills live. */}
        <button
          onClick={recording ? stopDictation : startDictation}
          aria-label={recording ? 'Stop dictation' : 'Start dictation'}
          title={recording ? 'Tap to stop' : 'Voice dictation'}
          style={{
            width: 36, height: 36, borderRadius: 999,
            background: recording ? 'rgba(218,119,86,0.18)' : 'transparent',
            border: recording ? '1px solid rgba(218,119,86,0.55)' : 'none',
            color: recording ? '#FF9466' : '#888',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={recording ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="13" rx="3" />
            <path d="M5 11v1a7 7 0 0 0 14 0v-1" />
            <line x1="12" y1="19" x2="12" y2="23" />
          </svg>
          {recording && (
            <span aria-hidden style={{
              position: 'absolute',
              top: 2, right: 2,
              width: 8, height: 8, borderRadius: '50%',
              background: '#ef4444',
              boxShadow: '0 0 6px rgba(239,68,68,0.85)',
              animation: 'mob-mic-pulse 1.2s ease-in-out infinite',
            }} />
          )}
        </button>
        {dictError && !recording && (
          <span style={{ fontSize: 10, color: '#f87171', marginLeft: 4, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dictError}>
            mic: {dictError}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Prompt library */}
        <PromptPickerInlineButton onPick={onPickPrompt} />

        {/* Send/Stop — same slot, swaps based on busy. Send/Stop is one
            mental action ("interact with the turn"), so one muscle path. */}
        {busy ? (
          <button
            onClick={onStop}
            aria-label="Stop"
            title="Stop generation"
            style={{
              width: 36, height: 36, borderRadius: 999,
              border: 'none',
              background: '#ef4444',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <span style={{
              display: 'inline-block', width: 12, height: 12,
              background: '#fff', borderRadius: 2,
            }} />
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!text.trim() && chips.length === 0}
            aria-label="Send"
            style={{
              width: 36, height: 36, borderRadius: 999,
              border: 'none',
              background: (!text.trim() && chips.length === 0) ? '#2a2a2a' : '#FFB382',
              color: (!text.trim() && chips.length === 0) ? '#666' : '#1a1a1a',
              fontSize: 18, fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >↑</button>
        )}
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

// Rotating ring spinner. Uses transform:rotate (not opacity) so it survives
// H.264/JPEG compression on screen recordings — per CLAUDE.md AI-Optimized UI:
// a moving border is high pixel-delta per frame, an opacity pulse is not.
// Paired with an UPPERCASE static label ("STOPPING"/"RESUMING") at call sites
// for OCR reliability.
function InlineSpinner({ color = '#FFB382', size = 12 }: { color?: string; size?: number }) {
  return (
    <span
      style={{
        display: 'inline-block', width: size, height: size,
        border: `2px solid ${color}40`, borderTopColor: color,
        borderRadius: '50%', animation: 'mob-spin 0.7s linear infinite',
      }}
    />
  );
}

function ParamPill({ active, onClick, children, busy = false, disabled = false }: {
  active: boolean; onClick: () => void; children: any; busy?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 12px', borderRadius: 10,
        background: active ? 'rgba(255,178,130,0.18)' : '#222',
        border: active ? '1px solid #FFB382' : '1px solid #2a2a2a',
        color: active ? '#FFB382' : '#bbb',
        fontSize: 13, fontWeight: 500,
        // The tapped pill spins (cursor:wait); the others dim while one applies.
        cursor: busy ? 'wait' : disabled ? 'default' : 'pointer',
        opacity: disabled && !busy ? 0.4 : 1,
        textAlign: 'center',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      }}
    >
      {busy && <InlineSpinner color={active ? '#FFB382' : '#bbb'} size={11} />}
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
  // Virtualize via Virtuoso — same reason as the chat list. On a session with
  // 5000 timeline entries the previous `entries.map(...)` rendered 5000 DOM
  // nodes synchronously, killed Safari with OOM. Virtuoso keeps ~30 mounted.
  const virtuosoRef = useRef<VirtualizerHandle | null>(null);
  // Ref to the scrollable parent — virtua needs this directly (not the
  // Virtualizer ref) so that flex-spacer pattern works. virtuoso owned the
  // scroller internally; in virtua the scroller is OUR div.
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const [drawerAtBottom, setDrawerAtBottom] = useState<boolean>(true);
  const drawerScrollDown = () => {
    if (!entries || entries.length === 0) return;
    virtuosoRef.current?.scrollToIndex(entries.length - 1, { align: 'end' });
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
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {entries == null && (
            <div style={{ padding: 32, color: '#666', fontSize: 12, textAlign: 'center' }}>Loading timeline…</div>
          )}
          {entries && entries.length === 0 && (
            <div style={{ padding: 16, color: '#555', fontSize: 12, textAlign: 'center' }}>Empty timeline.</div>
          )}
          {entries && entries.length > 0 && (
            <div
              ref={scrollParentRef}
              onScroll={() => {
                const h = virtuosoRef.current;
                if (!h) return;
                const distFromBottom = h.scrollSize - h.scrollOffset - h.viewportSize;
                setDrawerAtBottom(distFromBottom < 200);
              }}
              style={{
                height: '100%',
                overflowY: 'auto',
                overflowAnchor: 'none',
                WebkitOverflowScrolling: 'touch',
                overscrollBehavior: 'contain',
              }}
            >
              <Virtualizer ref={virtuosoRef} scrollRef={scrollParentRef}>
                {entries.map((e) => (
                  <div key={e.uuid}>
                    <TimelineEntryRow
                      entry={e}
                      expanded={expanded.has(e.uuid)}
                      onToggle={() => onToggle(e.uuid)}
                      onGoTo={() => onGoTo(e.uuid)}
                    />
                  </div>
                ))}
              </Virtualizer>
            </div>
          )}
        </div>
        <ScrollToBottomFAB visible={!drawerAtBottom && !!entries && entries.length > 0} onClick={drawerScrollDown} side="left" bottomOffset={20} />
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
//
// MODULE-LEVEL EXPANDED STATE — survives virtuoso re-mounts.
// react-virtuoso unmounts items that scroll out of viewport. Local useState
// inside ThinkingCard/ToolCard would reset every time the user scrolled away
// and back, undoing their collapse/expand action. Storing per-id in a module
// Map keeps the user choice across mounts. Default value is computed lazily
// at first render of each entry; subsequent renders read from the Map.
// Cleared automatically when ChatView unmounts (via clearEntryExpanded).
const _entryExpanded: Map<string, boolean> = new Map();
function getEntryExpanded(id: string, defaultOpen: boolean): boolean {
  const v = _entryExpanded.get(id);
  if (v === undefined) {
    _entryExpanded.set(id, defaultOpen);
    return defaultOpen;
  }
  return v;
}
function setEntryExpanded(id: string, v: boolean) { _entryExpanded.set(id, v); }
// Drop entries no longer in the active view. Called from ChatView unmount —
// without this the maps grow forever (10 chats × 5000 entries × N opens =
// ~50K keys after a few days of use). Keys for OTHER tabs that the user might
// re-open are intentionally kept; we only drop the entry-ids for the current
// chat's entries since those will get fresh defaults next mount anyway.
function clearEntryExpandedForIds(ids: Iterable<string>) {
  for (const id of ids) {
    _entryExpanded.delete(id);
    _entryToggleVersion.delete(id);
    _entryToggleListeners.delete(id);
  }
}
// Force a hook-driven re-read so toggles trigger re-render. Each card uses
// a thin wrapper hook that subscribes to a per-id counter — bumping it forces
// React to re-evaluate. This is simpler than a Zustand store for one-off
// toggle state and doesn't pull in any extra deps.
const _entryToggleVersion: Map<string, number> = new Map();
const _entryToggleListeners: Map<string, Set<() => void>> = new Map();
function useEntryExpanded(id: string, defaultOpen: boolean): [boolean, (v: boolean) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const listeners = _entryToggleListeners.get(id) ?? new Set();
    const cb = () => force((n) => n + 1);
    listeners.add(cb);
    _entryToggleListeners.set(id, listeners);
    return () => { listeners.delete(cb); };
  }, [id]);
  const open = getEntryExpanded(id, defaultOpen);
  const set = useCallback((v: boolean) => {
    setEntryExpanded(id, v);
    _entryToggleVersion.set(id, (_entryToggleVersion.get(id) ?? 0) + 1);
    _entryToggleListeners.get(id)?.forEach((cb) => cb());
  }, [id]);
  return [open, set];
}

// ── Collapse-toggle bottom-stick (mirror desktop useStableCollapseToggle's
// wasAtBottom branch) ──────────────────────────────────────────────────────
// EntryView cards live deep inside the virtua list and can't reach ChatView's
// scrollParentRef directly. ChatView registers its scroll container here once;
// any card's toggle calls stickToggle(fn) which: snapshots whether the user was
// glued to the bottom BEFORE flipping, runs the toggle, then re-sticks to the
// new bottom across two rAFs (virtua needs a frame to re-measure the grown/
// shrunk item). If the user wasn't at the bottom, position is left untouched.
// Covers thinking, tool cards, diff, user-prompt — every collapsible block.
let _scrollContainer: HTMLElement | null = null;
function registerScrollContainer(el: HTMLElement | null) { _scrollContainer = el; }
const STICK_BOTTOM_PX = 80; // a bit looser than desktop's 4px — touch scroll rounding
function stickToggle(toggle: () => void) {
  const sc = _scrollContainer;
  if (!sc) { toggle(); return; }
  const wasAtBottom = (sc.scrollHeight - sc.scrollTop - sc.clientHeight) <= STICK_BOTTOM_PX;
  toggle();
  if (!wasAtBottom) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = _scrollContainer;
    if (el) el.scrollTop = el.scrollHeight;
  }));
}

// ── Полный рендер чата теперь живёт в @noted/claude-blocks::ChatMessage ──────
// Раньше EntryView сам рисовал каждый kind (user/assistant/thinking/tool/slash/
// compact/error) — это была мобильная копия десктопной раскладки. Теперь весь
// визуал строки (расположение, бабблы, бейджи, чипы, карточки) — в пакете, а
// мобила лишь (1) маппит UiEntry → ChatEntry, (2) внедряет свой collapse-
// контроллер (persist через _entryExpanded + bottom-stick через stickToggle).
// Под капотом lifecycle (SSE/JSONL/kill) — по-прежнему у мобилы, пакет его не
// касается. Перекраска бабла под Claude-оранж (был #1f3a5f) — намеренно: «как
// в десктопе» (canon — десктопный SDK).

function uiToChatEntry(e: UiEntry): CBChatEntry {
  switch (e.kind) {
    case 'tool':
      return { kind: 'tool', id: e.id, tool: e.tool, input: e.input, result: e.result, isError: e.isError, entryUuid: (e as any).entryUuid };
    case 'compact-summary':
      return { kind: 'compact-summary', id: e.id, text: e.text, entryUuid: e.entryUuid, metrics: e.metrics };
    default:
      return e as unknown as CBChatEntry; // user/assistant/thinking/slash/error — shape совпадает
  }
}

// Глобальный re-render по любому toggle: virtua держит в DOM только видимые
// ряды, так что перерисуются лишь они. Open-state читается из _entryExpanded
// (переживает unmount при скролле), version-counter лишь дёргает React.
let _globalToggleVersion = 0;
const _globalToggleListeners = new Set<() => void>();
function bumpGlobalToggle() {
  _globalToggleVersion++;
  _globalToggleListeners.forEach((cb) => cb());
}
function useGlobalToggle() {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    _globalToggleListeners.add(cb);
    return () => { _globalToggleListeners.delete(cb); };
  }, []);
}

// Мобильный collapse-контроллер для пакета: isOpen читает persist-карту,
// toggle оборачивает запись в stickToggle (bottom-stick) + глобальный re-render.
const mobileCollapse: CBCollapseController = {
  isOpen: (id: string, defaultOpen: boolean) => getEntryExpanded(id, defaultOpen),
  toggle: (id: string, next: boolean) => {
    stickToggle(() => {
      setEntryExpanded(id, next);
      bumpGlobalToggle();
    });
  },
};
const mobileRenderCtx: CBChatRenderContext = { collapse: mobileCollapse };

function EntryView({ entry }: { entry: UiEntry }) {
  useGlobalToggle(); // re-render visible row on any collapse toggle
  return <CBChatMessage entry={uiToChatEntry(entry)} ctx={mobileRenderCtx} />;
}

// Per-kind mobile cards (CompactSummaryCard / CollapsibleText / UserText /
// Markdown / ThinkingCard / ToolCard) — УДАЛЕНЫ. Весь визуал строки чата теперь
// в @noted/claude-blocks::ChatMessage (см. EntryView выше). Раскрытие/скролл
// внедряются через mobileRenderCtx (persist + stickToggle).

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
/* @property for smooth conic-gradient angle interpolation in .mob-awaiting-ring
   (without it the angle jumps stepwise instead of rotating). Mirror of desktop
   globals.css @property --awaiting-angle. Must sit at stylesheet top level. */
@property --mob-awaiting-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
@keyframes noted-dot-pulse { 0%,100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
@keyframes noted-live-pulse {
  0%,100% { box-shadow: 0 0 6px rgba(255,178,130,0.5); }
  50% { box-shadow: 0 0 14px rgba(255,178,130,0.95); }
}
@keyframes noted-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes noted-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes noted-slide-left { from { transform: translateX(100%); } to { transform: translateX(0); } }
@keyframes mob-mic-pulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.72); }
}
@keyframes mob-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
/* "Claude is asking a question" rotating border — copied 1:1 from the desktop
   .tab-awaiting-input (globals.css). conic-gradient traveling segment + faint
   constant ring, masked (content-box XOR border-box) to a 1.2px border, angle
   animated via @property for smooth rotation (Chromium 120+ / WKWebView 16+).
   Applied to both the project-tab row (TabRow) and the chat-tab frame (ChatView).
   background-color is NOT animated — the moving bright segment carries the
   signal (high per-frame pixel delta → codec/AI-detectable). */
@keyframes mob-awaiting-spin { to { --mob-awaiting-angle: 360deg; } }
.mob-awaiting-ring {
  padding: 1.2px;
  background:
    conic-gradient(from var(--mob-awaiting-angle, 0deg),
      rgba(168, 85, 247, 0) 0deg,
      rgba(168, 85, 247, 0) 240deg,
      rgba(168, 85, 247, 0.85) 312deg,
      rgba(216, 180, 254, 1) 348deg,
      rgba(168, 85, 247, 0) 360deg),
    rgba(147, 51, 234, 0.22);
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: mob-awaiting-spin 1.6s linear infinite;
  pointer-events: none;
}
/* Process-bar STRIP loader (mirror of desktop tab-process-bar). The base edge
   strip is static while the process is alive; AI-busy adds the shimmer below. */
/* AI-busy shimmer band sweeping DOWN the strip — the "loader is generating" cue
   (same metaphor as desktop tab-process-bar-ai-shimmer-overlay). */
.mob-pbar-shimmer {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(
    to bottom,
    rgba(var(--mob-pbar-shimmer-rgb, 255,255,255), var(--mob-pbar-shimmer-edge-alpha, 0.12)) 0%,
    rgba(var(--mob-pbar-shimmer-rgb, 255,255,255), var(--mob-pbar-shimmer-alpha, 0.55)) 50%,
    rgba(var(--mob-pbar-shimmer-rgb, 255,255,255), var(--mob-pbar-shimmer-edge-alpha, 0.12)) 100%
  );
  background-size: 100% var(--mob-pbar-shimmer-spacing, 50%);
  background-repeat: repeat-y;
  animation: mob-pbar-shimmer-sweep 1.2s linear infinite;
}
@keyframes mob-pbar-shimmer-sweep {
  0%   { background-position: 0 0; }
  100% { background-position: 0 100%; }
}
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

/* Markdown rendering moved to @noted/claude-blocks (.cb-prose). The old mobile
   .md-body block was removed — visual canon is the shared package now. */
::-webkit-scrollbar { width: 0; height: 0; }

/* Composer textarea — orange scrollbar appears ONLY when content exceeds the
   40vh cap (class added in JS). Default state: zero-width scrollbar so a
   one-line input has no visual noise. Override the global ::-webkit-scrollbar
   {width:0} rule above for this specific element. */
.composer-textarea--scroll::-webkit-scrollbar {
  width: 6px;
}
.composer-textarea--scroll::-webkit-scrollbar-track {
  background: transparent;
  margin: 4px 0;
}
.composer-textarea--scroll::-webkit-scrollbar-thumb {
  background: #FFB382;
  border-radius: 3px;
}
.composer-textarea--scroll::-webkit-scrollbar-thumb:hover {
  background: #ffc59a;
}
/* Firefox */
.composer-textarea--scroll {
  scrollbar-width: thin;
  scrollbar-color: #FFB382 transparent;
}
`;
  document.head.appendChild(style);
}

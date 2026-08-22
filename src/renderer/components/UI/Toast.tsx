import React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Github } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useDictationSnapshot } from '../../utils/dictationManager';
import { isToastVisible, resolveToastHostTabId, visibleToastTabIds } from '../../utils/toastPlacement.mjs';

/** One entry of the toast list — the shape ToastCard renders. */
type ToastModel = ReturnType<typeof useUIStore.getState>['toasts'][number];

export default function ToastContainer() {
  const { toasts, removeToast } = useUIStore();
  const [expandedToastIds, setExpandedToastIds] = React.useState<Set<string>>(() => new Set());
  const animatedToastIdsRef = React.useRef<Set<string>>(new Set());
  // Toasts about a TAB are shown over that tab's own surface; global ones stay in
  // the window corner.
  //
  // Two things were wrong before, and both only became visible once the
  // workspace could show several tabs at once:
  //   • place — the container is fixed to the WINDOW's top-right, so a message
  //     about the left pane appeared over the right one;
  //   • visibility — a tab-scoped toast rendered only while its tab was the
  //     FOCUSED one, so clicking a neighbouring pane made it vanish even though
  //     its tab is still on screen.
  // Both now follow one fact: which tabs are VISIBLE, not which holds focus.
  const effectiveTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  // Fingerprint Pattern: the selector returns a STRING, never a new array.
  const paneTabKey = useWorkspaceStore((s) => s.splitPanes.map((p) => p.tabId).join('|'));
  const visibleTabIds = React.useMemo(
    () => visibleToastTabIds({
      panes: paneTabKey ? paneTabKey.split('|').map((tabId) => ({ tabId })) : [],
      effectiveTabId,
    }),
    [paneTabKey, effectiveTabId],
  );
  // В углу приложения — ТОЛЬКО общие уведомления (без вкладки).
  //
  // Раньше сюда же падало уведомление вкладки, которой не видно: считалось, что
  // потерять сообщение хуже, чем показать его не на месте. Оказалось наоборот —
  // плашка про невидимую работу вставала поверх окна, к которому не относится,
  // и человек шёл искать проблему не туда. Теперь про такую ошибку говорит сам
  // чип вкладки (красная рамка и число), а полный текст возвращается в правый
  // верх ЕЁ окна, когда вкладку показывают.
  const visibleToasts = toasts.filter((t) => isToastVisible(t, visibleTabIds) && !t.tabId);
  const liveToastIds = React.useMemo(() => new Set(toasts.map((t) => t.id)), [toasts]);

  React.useEffect(() => {
    setExpandedToastIds((current) => {
      let changed = false;
      const next = new Set<string>();
      current.forEach((id) => {
        if (liveToastIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : current;
    });
    animatedToastIdsRef.current.forEach((id) => {
      if (!liveToastIds.has(id)) animatedToastIdsRef.current.delete(id);
    });
  }, [liveToastIds]);

  const toggleToastDetails = React.useCallback((id: string) => {
    setExpandedToastIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div
      data-toast-container
      aria-live="polite"
      aria-relevant="additions text"
      style={{
        position: 'fixed',
        top: '52px',
        right: '16px',
        zIndex: 30000,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxWidth: '420px'
      }}
    >
      {visibleToasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          removeToast={removeToast}
          expanded={expandedToastIds.has(toast.id)}
          toggleToastDetails={toggleToastDetails}
          animatedToastIdsRef={animatedToastIdsRef}
        />
      ))}
      <DictationBackgroundStatus />
      {/* Tab-scoped toasts live in their own tab's anchor, not here. Rendered as
          siblings so this container keeps owning the global ones. */}
      {visibleTabIds.map((tabId) => (
        <PaneToasts
          key={tabId}
          tabId={tabId}
          toasts={toasts.filter((t) => resolveToastHostTabId(t, visibleTabIds) === tabId)}
          removeToast={removeToast}
          expandedToastIds={expandedToastIds}
          toggleToastDetails={toggleToastDetails}
          animatedToastIdsRef={animatedToastIdsRef}
        />
      ))}
    </div>
  );
}

/**
 * The toasts of ONE tab, portalled into that tab's anchor inside its pane.
 *
 * The anchor is created by TerminalArea next to every tab surface
 * (`data-toast-anchor-tab-id`), so this only has to find it. It is looked up on
 * every render rather than cached: panes mount, unmount and swap tabs, and a
 * cached node would keep pointing at a box that is no longer on screen.
 */
function PaneToasts({
  tabId,
  toasts,
  removeToast,
  expandedToastIds,
  toggleToastDetails,
  animatedToastIdsRef,
}: {
  tabId: string;
  toasts: ToastModel[];
  removeToast: (id: string) => void;
  expandedToastIds: Set<string>;
  toggleToastDetails: (id: string) => void;
  animatedToastIdsRef: React.MutableRefObject<Set<string>>;
}) {
  // Re-find the anchor whenever this tab's toasts change: on the very first toast
  // of a freshly mounted pane the node may not have existed at the previous
  // render. Cheap (one query), and it cannot go stale.
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    setAnchor(document.querySelector<HTMLElement>(`[data-toast-anchor-tab-id="${tabId}"]`));
  }, [tabId, toasts.length]);
  if (!anchor || toasts.length === 0) return null;
  return createPortal(
    <>
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          removeToast={removeToast}
          expanded={expandedToastIds.has(toast.id)}
          toggleToastDetails={toggleToastDetails}
          animatedToastIdsRef={animatedToastIdsRef}
        />
      ))}
    </>,
    anchor,
  );
}

function DictationBackgroundStatus() {
  const dictation = useDictationSnapshot();
  const ownerTabId = dictation.owner?.tabId || null;
  const appView = useWorkspaceStore((s) => s.view);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const effectiveTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  const ownerProjectId = useWorkspaceStore((s) => {
    if (!ownerTabId) return null;
    for (const [projectId, workspace] of s.openProjects) {
      if (workspace.tabs.has(ownerTabId)) return projectId;
    }
    return dictation.owner?.projectId || null;
  });
  const ownerTabName = useWorkspaceStore((s) => {
    if (!ownerTabId) return dictation.owner?.tabName || '';
    for (const [, workspace] of s.openProjects) {
      const tab = workspace.tabs.get(ownerTabId);
      if (tab) return tab.name || dictation.owner?.tabName || 'tab';
    }
    return dictation.owner?.tabName || 'tab';
  });
  const ownerProjectView = useWorkspaceStore((s) => {
    if (!ownerProjectId) return 'terminal';
    return s.openProjects.get(ownerProjectId)?.currentView || 'terminal';
  });

  const ownerVisible =
    dictation.recording &&
    appView === 'workspace' &&
    activeProjectId === ownerProjectId &&
    effectiveTabId === ownerTabId &&
    ownerProjectView === 'terminal';

  if (!dictation.recording || !ownerTabId || ownerVisible) return null;

  const shortName = ownerTabName.length > 15 ? ownerTabName.slice(0, 14) + '…' : ownerTabName;

  const goToOwnerTab = (e: React.MouseEvent) => {
    e.stopPropagation();
    const store = useWorkspaceStore.getState();
    let targetProjectId = ownerProjectId;
    if (!targetProjectId) {
      for (const [projectId, workspace] of store.openProjects) {
        if (workspace.tabs.has(ownerTabId)) {
          targetProjectId = projectId;
          break;
        }
      }
    }
    if (!targetProjectId) return;
    store.showWorkspace(targetProjectId);
    store.setViewingSubAgent(null);
    store.switchTab(targetProjectId, ownerTabId);
    store.setProjectView(targetProjectId, 'terminal');
  };

  return (
    <div
      className="pointer-events-auto flex items-center gap-2 rounded-lg shadow-lg backdrop-blur-sm animate-slide-in"
      style={{
        minHeight: 30,
        padding: '6px 10px',
        background: 'rgba(20,20,20,0.94)',
        border: '1px solid rgba(218,119,86,0.45)',
        color: '#e8e8e8',
        fontSize: 12,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          border: '2px solid rgba(218,119,86,0.25)',
          borderTopColor: '#DA7756',
          animation: 'dictation-status-spin 0.9s linear infinite',
          flexShrink: 0,
        }}
      />
      <span style={{ color: '#FF9466', fontWeight: 700, letterSpacing: 0.4, fontSize: 10 }}>
        RECORDING
      </span>
      <button
        onClick={goToOwnerTab}
        title={ownerTabName}
        style={{
          maxWidth: 128,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          background: 'transparent',
          border: 'none',
          color: '#fff',
          padding: 0,
          fontSize: 12,
          fontWeight: 650,
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationColor: 'rgba(255,255,255,0.35)',
          textUnderlineOffset: 3,
        }}
      >
        {shortName}
      </button>
      <style>{`
        @keyframes dictation-status-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

/**
 * ONE toast card. Extracted so the window corner and a pane anchor render the
 * SAME thing — two copies of this markup would drift apart detail by detail
 * (that is exactly how five copies of the tab process bar happened).
 */
function ToastCard({
  toast,
  removeToast,
  expanded: expandedProp,
  toggleToastDetails,
  animatedToastIdsRef,
}: {
  toast: ToastModel;
  removeToast: (id: string) => void;
  expanded: boolean;
  toggleToastDetails: (id: string) => void;
  animatedToastIdsRef: React.MutableRefObject<Set<string>>;
}) {
        const [copyConfirmed, setCopyConfirmed] = React.useState(false);
        const copyResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        React.useEffect(() => () => {
          if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
        }, []);
        const details = String(toast.details || '').trim();
        const hasDetails = details.length > 0;
        const expanded = hasDetails && expandedProp;
        const shouldAnimate = !animatedToastIdsRef.current.has(toast.id);
        return (
          <div
            key={toast.id}
            data-toast
            data-toast-id={toast.id}
            data-toast-type={toast.type}
            role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}
            ref={() => {
              if (!shouldAnimate) return;
              animatedToastIdsRef.current.add(toast.id);
            }}
            className={`pointer-events-auto px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm transform transition-all duration-300 ease-out ${shouldAnimate ? 'animate-slide-in' : ''} ${
              hasDetails || (!toast.persistent && !toast.onAction) ? 'cursor-pointer' : ''
            } ${
              toast.type === 'success' ? 'bg-[#22c55e]/90 text-white' :
              toast.type === 'error' ? 'bg-[#ef4444]/90 text-white' :
              toast.type === 'warning' ? 'bg-[#f59e0b]/90 text-white' :
              toast.type === 'pink' ? 'bg-[#ec4899]/90 text-white' :
              'bg-[#3b82f6]/90 text-white'
            }`}
            style={toast.persistent ? {
              borderLeft: '3px solid rgba(255,255,255,0.5)',
              paddingRight: '8px',
            } : undefined}
            onClick={() => {
              if (hasDetails) {
                toggleToastDetails(toast.id);
                return;
              }
              if (!toast.persistent && !toast.onAction) removeToast(toast.id);
            }}
          >
            <div className="flex items-start gap-2">
              {/* ✕ close button — left side for persistent toasts */}
              {toast.persistent && (
                <span
                  className="shrink-0 cursor-pointer rounded-full flex items-center justify-center transition-colors"
                  style={{
                    width: '18px',
                    height: '18px',
                    fontSize: '11px',
                    lineHeight: 1,
                    opacity: 0.95,
                    background: 'rgba(0,0,0,0.28)',
                    border: '1px solid rgba(255,255,255,0.35)',
                    color: '#fff',
                    marginTop: '1px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(0,0,0,0.5)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.7)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(0,0,0,0.28)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.35)';
                  }}
                  onClick={(e) => { e.stopPropagation(); removeToast(toast.id); }}
                >
                  ✕
                </span>
              )}
              {!toast.persistent && (
                <span className="text-sm shrink-0 leading-none" style={{ marginTop: '2px' }}>
                  {toast.type === 'success' ? '✓' :
                   toast.type === 'error' ? '✗' :
                   toast.type === 'warning' ? '⚠' :
                   toast.type === 'pink' ? '✦' : 'ℹ'}
                </span>
              )}
              <span data-toast-message className="text-xs font-medium flex-1 leading-snug">
                {toast.message}
                {toast.actionLabel && (
                  <span
                    className="cursor-pointer underline decoration-white/50 hover:decoration-white ml-1 inline-flex items-center gap-1 align-middle"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (toast.onAction) toast.onAction();
                      removeToast(toast.id);
                    }}
                  >
                    {toast.actionIcon === 'github-desktop' && (
                      <span
                        aria-hidden
                        className="inline-flex items-center justify-center"
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          background: '#6e40c9',
                          color: '#fff',
                          verticalAlign: 'middle',
                        }}
                      >
                        <Github size={11} strokeWidth={2.4} />
                      </span>
                    )}
                    {toast.actionLabel}
                  </span>
                )}
              </span>
              {hasDetails && (
                <span
                  aria-label={expanded ? 'Свернуть детали' : 'Показать детали'}
                  aria-expanded={expanded}
                  className="shrink-0 rounded flex items-center justify-center hover:bg-white/20 transition-colors"
                  style={{
                    width: '20px',
                    height: '20px',
                    border: '1px solid rgba(255,255,255,0.3)',
                    opacity: 0.86,
                  }}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              )}
              {/* Copy button — right side, only if toast has copyText */}
              {toast.copyText && (
                <span
                  className="shrink-0 cursor-pointer rounded flex items-center justify-center hover:bg-white/20 transition-colors"
                  style={{ padding: '2px 5px', fontSize: '10px', opacity: 0.7, border: '1px solid rgba(255,255,255,0.3)', borderRadius: '4px' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const { clipboard } = window.require('electron');
                    clipboard.writeText(toast.copyText!);
                    setCopyConfirmed(true);
                    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
                    copyResetTimerRef.current = setTimeout(() => {
                      copyResetTimerRef.current = null;
                      setCopyConfirmed(false);
                    }, 800);
                  }}
                >
                  {copyConfirmed ? 'ok' : 'copy'}
                </span>
              )}
            </div>
            {expanded && (
              <div
                className="mt-2 text-xs leading-snug"
                style={{
                  paddingTop: '8px',
                  borderTop: '1px solid rgba(255,255,255,0.22)',
                  color: 'rgba(255,255,255,0.92)',
                }}
              >
                {details}
              </div>
            )}
          </div>
        );
}

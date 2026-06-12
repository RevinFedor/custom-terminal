import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useDictationSnapshot } from '../../utils/dictationManager';

export default function ToastContainer() {
  const { toasts, removeToast } = useUIStore();
  // Tab-scoped toasts (toast.tabId set) only render while their tab is the
  // effective active one — switching tabs hides the toast, switching back shows
  // it again. Global toasts (no tabId) render always.
  const effectiveTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  const visibleToasts = toasts.filter((t) => !t.tabId || t.tabId === effectiveTabId);

  return (
    <div
      style={{
        position: 'fixed',
        top: '52px',
        right: '16px',
        zIndex: 9999,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxWidth: '340px'
      }}
    >
      {visibleToasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm transform transition-all duration-300 ease-out animate-slide-in ${
            toast.persistent ? '' : 'cursor-pointer'
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
          onClick={() => !toast.persistent && !toast.onAction && removeToast(toast.id)}
        >
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
          <span className="text-sm shrink-0">
            {toast.type === 'success' ? '✓' :
             toast.type === 'error' ? '✗' :
             toast.type === 'warning' ? '⚠' :
             toast.type === 'pink' ? '✦' : 'ℹ'}
          </span>
          <span className="text-xs font-medium flex-1">
            {toast.message}
            {toast.actionLabel && (
              <span
                className="cursor-pointer underline decoration-white/50 hover:decoration-white ml-1"
                onClick={(e) => {
                  e.stopPropagation();
                  if (toast.onAction) toast.onAction();
                  removeToast(toast.id);
                }}
              >
                {toast.actionLabel}
              </span>
            )}
          </span>
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
                e.currentTarget.textContent = 'ok';
                setTimeout(() => { if (e.currentTarget) e.currentTarget.textContent = 'copy'; }, 800);
              }}
            >
              copy
            </span>
          )}
        </div>
      ))}
      <DictationBackgroundStatus />
    </div>
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

import React, { useEffect, useState } from 'react';
import { Crosshair, X, FileText } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import { getTabChromeColorConfig, flattenRgbaOnTabbarPanel } from './tabChrome';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

const { ipcRenderer } = window.require('electron');

// Attach row (chips + path) is only rendered while the split is active —
// approved: «строка привязки только в сплите».
export const SPLIT_ATTACH_ROW_H = 38;

// Equal columns, v1 has no draggable divider.
export function splitPaneRectStyle(paneIndex: number, paneCount: number): React.CSSProperties {
  const w = 100 / Math.max(1, paneCount);
  return {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `${paneIndex * w}%`,
    width: `${w}%`,
  };
}

interface AttachRowProps {
  paneIndex: number;
  projectId: string;
  tabId: string;
  focused: boolean;
}

// Top strip of a split pane: [project chip][tab chip] + tiny full path line
// tight below, [⌖ Pick][✕] on the right. The tab chip reuses the shared tab
// chrome so the card language matches the sidebar.
export function SplitPaneAttachRow({ paneIndex, projectId, tabId, focused }: AttachRowProps) {
  const projectName = useProjectsStore((s) => s.projects[projectId]?.name)
    || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : null);
  const workspacePath = useWorkspaceStore((s) => s.openProjects.get(projectId)?.projectPath || '');
  const tab = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId));
  const pickArmedHere = useWorkspaceStore((s) => s.splitPickPaneIndex === paneIndex);
  const displayProjectName = projectName || workspacePath.split('/').filter(Boolean).pop() || 'Project';

  // Esc cancels an armed Pick (window-level: the next click may be anywhere).
  useEffect(() => {
    if (!pickArmedHere) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useWorkspaceStore.getState().setSplitPickPaneIndex(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pickArmedHere]);

  if (!tab) return null;
  const chrome = getTabChromeColorConfig(tab as any);
  const tabChipBg = flattenRgbaOnTabbarPanel(chrome.bgColor === 'transparent' ? 'rgba(255,255,255,0.06)' : chrome.bgColor);
  const fullPath = tab.tabType === 'file' ? (tab.filePath || '') : (tab.cwd || '');

  return (
    <div
      data-split-attach-row
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: SPLIT_ATTACH_ROW_H,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 1,
        padding: '0 8px',
        background: focused ? '#232326' : '#1d1d1f',
        borderBottom: '1px solid #333',
        boxSizing: 'border-box',
        zIndex: 3,
        userSelect: 'none',
        // Pane wrappers are pointer-events:none; every interactive surface
        // re-enables its own hits.
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {/* Project chip */}
        <span
          style={{
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: '#9a9aa0',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 4,
            padding: '1px 6px',
          }}
        >
          {displayProjectName}
        </span>
        {/* Tab chip — shared tab chrome tint */}
        <span
          style={{
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11.5,
            color: '#e8e8e8',
            background: tabChipBg,
            border: `1px solid ${chrome.borderColor}55`,
            borderRadius: 4,
            padding: '1px 7px',
          }}
        >
          {tab.tabType === 'file' && <FileText size={10} style={{ color: '#a78bfa', flexShrink: 0 }} />}
          {tab.name}
        </span>

        <span style={{ flex: 1 }} />

        {/* Pick — arm this pane, next sidebar click lands here */}
        <button
          title={pickArmedHere
            ? 'Отменить выбор (Esc)'
            : 'Следующий клик по вкладке в сайдбаре заменит вкладку этой панели'}
          onClick={(e) => {
            e.stopPropagation();
            const st = useWorkspaceStore.getState();
            st.setSplitPickPaneIndex(pickArmedHere ? null : paneIndex);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: 0.3,
            padding: '2px 7px',
            borderRadius: 4,
            cursor: 'pointer',
            background: pickArmedHere ? 'rgba(139,92,246,0.28)' : 'transparent',
            border: `1px solid ${pickArmedHere ? '#8b5cf6' : 'rgba(255,255,255,0.14)'}`,
            color: pickArmedHere ? '#d6c8ff' : '#b9b9be',
            flexShrink: 0,
          }}
        >
          <Crosshair size={11} />
          Pick
        </button>

        {/* Close pane (not the tab) */}
        <button
          title="Убрать панель из рабочей области"
          onClick={(e) => {
            e.stopPropagation();
            useWorkspaceStore.getState().removeTabFromSplit(tabId);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 4,
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            color: '#8f8f94',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.10)'; (e.currentTarget as HTMLElement).style.color = '#eee'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#8f8f94'; }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Full path — secondary info, tight under the chips, never its own
          highlighted row. Ellipsized first when width runs out. */}
      <div
        style={{
          fontSize: 10,
          lineHeight: '11px',
          color: '#6d6d73',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={fullPath}
      >
        {shortPathSafe(fullPath)}
      </div>
    </div>
  );
}

// Home prefix → ~; ellipsis is handled by CSS (the row is single-line).
const HOME_DIR = (() => {
  try { return window.require('os').homedir() as string; } catch { return ''; }
})();
function shortPathSafe(p: string): string {
  if (!p) return '';
  try { return HOME_DIR && p.startsWith(HOME_DIR) ? '~' + p.slice(HOME_DIR.length) : p; } catch { return p; }
}

// White focus frame of the focused pane; hairline separator on the others.
export function SplitPaneFocusFrame({ focused }: { focused: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 4,
        boxShadow: focused
          ? 'inset 0 0 0 2px rgba(255,255,255,0.55)'
          : 'inset -1px 0 0 rgba(255,255,255,0.08), inset 1px 0 0 rgba(255,255,255,0.08)',
      }}
    />
  );
}

// Markdown/file content INSIDE a split pane. The global FilePreview overlay
// stays the single-mode surface; a pane needs its own reader because the
// overlay is a fixed singleton covering the whole window.
export function SplitFilePane({ filePath, visible }: { filePath: string; visible: boolean }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fontSize = 13;

  useEffect(() => {
    let cancelled = false;
    if (!filePath) return undefined;
    setContent(null);
    setError(null);
    ipcRenderer.invoke('file:read', filePath).then((result: any) => {
      if (cancelled) return;
      if (result?.success) setContent(String(result.content ?? ''));
      else setError(result?.error || 'Не удалось прочитать файл');
    }).catch((e: any) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, [filePath, visible]);

  if (!visible) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#161522', overflow: 'hidden', display: 'flex', flexDirection: 'column', pointerEvents: 'auto' }}>
      {error ? (
        <div style={{ padding: 16, color: '#f87171', fontSize: 12.5 }}>{error}</div>
      ) : content === null ? (
        <div style={{ padding: 16, color: '#777', fontSize: 12.5 }}>Загрузка…</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <MarkdownEditor
            content={content}
            onChange={() => {}}
            readOnly
            fontSize={fontSize}
            showLineNumbers={false}
            compact
          />
        </div>
      )}
    </div>
  );
}

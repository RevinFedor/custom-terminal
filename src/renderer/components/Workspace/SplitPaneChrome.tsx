import React, { useEffect, useState } from 'react';
import { Columns2, FileText, History, SquareTerminal, X } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { resolveTabTerminalPrimary, useUIStore } from '../../store/useUIStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import { getTabChromeColorConfig, flattenRgbaOnTabbarPanel } from './tabChrome';
import { isEmptyPane } from '../../utils/splitPanesModel.mjs';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

const { ipcRenderer } = window.require('electron');

export const SPLIT_ATTACH_ROW_H = 26;

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
  projectId: string;
  tabId: string;
  focused: boolean;
}

// Top strip of a split pane: [project chip][tab chip] + tiny full path line
// tight below, [✕] on the right. The tab chip reuses the shared tab chrome so
// the card language matches the sidebar.
//
// There is deliberately NO "pick target pane" toggle here: clicking a pane and
// then clicking a tab already does the same thing in the same two clicks, so a
// separate armed mode was pure surface for a rare case.
export function SplitPaneAttachRow({ projectId, tabId, focused }: AttachRowProps) {
  const projectMeta = useProjectsStore((s) => s.projects[projectId]);
  const projectName = projectMeta?.name
    || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : null);
  const workspacePath = useWorkspaceStore((s) => s.openProjects.get(projectId)?.projectPath || '');
  const tab = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId));
  const splitPanes = useWorkspaceStore((s) => s.splitPanes);
  const displayProjectName = projectName || workspacePath.split('/').filter(Boolean).pop() || 'Project';
  const canSplit = splitPanes.length < 3 && !splitPanes.some(isEmptyPane);
  const inSplit = splitPanes.length > 0;
  const terminalIsPrimary = useUIStore((s) => resolveTabTerminalPrimary(s, tabId));
  const setTabTerminalIsPrimary = useUIStore((s) => s.setTabTerminalIsPrimary);

  if (!tab) return null;
  const hasAgentSurfacePair = tab.tabType !== 'claude-sdk'
    && tab.tabType !== 'browser'
    && tab.tabType !== 'file'
    && (tab.commandType === 'claude'
      || tab.commandType === 'codex'
      || !!tab.claudeSessionId
      || !!tab.codexSessionId);
  const chrome = getTabChromeColorConfig(tab as any);
  const tabChipBg = flattenRgbaOnTabbarPanel(chrome.bgColor === 'transparent' ? 'rgba(255,255,255,0.06)' : chrome.bgColor);
  return (
    <div
      data-split-attach-row
      data-focused={focused ? 'true' : undefined}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: SPLIT_ATTACH_ROW_H,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 8px',
        background: 'transparent',
        boxSizing: 'border-box',
        zIndex: 3,
        userSelect: 'none',
        // Pane wrappers are pointer-events:none; every interactive surface
        // re-enables its own hits.
        pointerEvents: 'auto',
      }}
    >
      <button
        title={workspacePath || displayProjectName}
        onClick={(e) => {
          e.stopPropagation();
          if (workspacePath) useWorkspaceStore.getState().openProject(projectId, workspacePath);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          flexShrink: 1,
          minWidth: 0,
          padding: 0,
          background: 'transparent',
          border: 'none',
          fontSize: 11,
          fontWeight: 600,
          color: '#8a8a8f',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#b4b4b8'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = '#8a8a8f'; }}
      >
        {projectMeta?.icon && (
          <img
            src={projectMeta.icon}
            alt=""
            draggable={false}
            style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.65 }}
          />
        )}
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayProjectName}
        </span>
      </button>

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

      {inSplit && hasAgentSurfacePair && (
        <button
          data-split-pane-surface-toggle
          title={terminalIsPrimary ? 'Показать транскрипт' : 'Показать терминал'}
          aria-label={terminalIsPrimary ? 'Показать транскрипт' : 'Показать терминал'}
          onClick={(e) => {
            e.stopPropagation();
            setTabTerminalIsPrimary(tabId, !terminalIsPrimary);
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
            background: !terminalIsPrimary ? 'rgba(245,158,11,0.16)' : 'transparent',
            border: 'none',
            color: !terminalIsPrimary ? '#f59e0b' : '#8f8f94',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.10)'; (e.currentTarget as HTMLElement).style.color = '#eee'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = !terminalIsPrimary ? 'rgba(245,158,11,0.16)' : 'transparent'; (e.currentTarget as HTMLElement).style.color = !terminalIsPrimary ? '#f59e0b' : '#8f8f94'; }}
        >
          {terminalIsPrimary ? <History size={12} /> : <SquareTerminal size={12} />}
        </button>
      )}

      {canSplit && (
        <button
          title="Разделить рабочую область"
          onClick={(e) => {
            e.stopPropagation();
            useWorkspaceStore.getState().addEmptySplitPane();
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
          <Columns2 size={12} />
        </button>
      )}

      {inSplit && (
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
      )}
    </div>
  );
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

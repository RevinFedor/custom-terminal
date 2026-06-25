import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

export default function FilePreview() {
  const { filePreview, closeFilePreview, showToast } = useUIStore();
  const filePreviewFontSize = useUIStore((s) => s.filePreviewFontSize);
  const setFilePreviewFontSize = useUIStore((s) => s.setFilePreviewFontSize);
  const { activeProjectId, getSidebarState, setOpenFilePath, switchTab, setProjectView } = useWorkspaceStore();
  const { sidebarOpen } = activeProjectId ? getSidebarState(activeProjectId) : { sidebarOpen: false };
  const [copied, setCopied] = useState(false);
  const [openingSublime, setOpeningSublime] = useState(false);

  const handleCopyContent = async () => {
    if (filePreview) {
      const { clipboard } = window.require('electron');
      clipboard.writeText(filePreview.content);
      setCopied(true);
      showToast('Copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleOpenInSublime = async () => {
    if (!filePreview || openingSublime) return;
    const targetPath = filePreview.path;
    setOpeningSublime(true);
    try {
      const { ipcRenderer } = window.require('electron');
      const result = await ipcRenderer.invoke('file:open-in-sublime', targetPath);
      if (!result?.success) {
        showToast(`Sublime Text: ${result?.error || 'failed to open file'}`, 'error');
      }
    } catch (error: any) {
      showToast(`Sublime Text: ${error?.message || 'failed to open file'}`, 'error');
    } finally {
      setOpeningSublime(false);
    }
  };

  const handleClose = () => {
    if (filePreview?.source === 'tab' && filePreview.sourceTabId && activeProjectId) {
      const state = useWorkspaceStore.getState();
      const workspace = state.openProjects.get(activeProjectId);
      const sourceTabId = filePreview.sourceTabId;
      const fileTab = workspace?.tabs.get(sourceTabId);
      const historyTargetId = workspace
        ? [...(workspace.tabHistory || [])].reverse().find((id) => {
            const candidate = workspace.tabs.get(id);
            return id !== sourceTabId && !!candidate && !candidate.isUtility && candidate.tabType !== 'file';
          })
        : null;
      const fallbackParentId = workspace && fileTab?.visualParentTabId && workspace.tabs.has(fileTab.visualParentTabId)
        ? fileTab.visualParentTabId
        : null;
      const fallbackTabId = workspace
        ? Array.from(workspace.tabs.values()).find((tab) => tab.id !== sourceTabId && !tab.isUtility && tab.tabType !== 'file')?.id
        : null;
      const returnTargetId = historyTargetId || fallbackParentId || fallbackTabId || null;

      if (returnTargetId) {
        switchTab(activeProjectId, returnTargetId);
        setProjectView(activeProjectId, 'terminal');
      }
      closeFilePreview();
      return;
    }
    closeFilePreview();
    if (activeProjectId) {
      setOpenFilePath(activeProjectId, null);
    }
  };

  // Get filename from path
  const fileName = filePreview?.path.split('/').pop() || '';

  if (!filePreview) return null;

  const tabbarRect = document.querySelector('[data-tabbar-vertical]')?.getBoundingClientRect();
  const tabPreviewLeft = tabbarRect?.right ?? 0;
  const tabPreviewTop = tabbarRect?.top ?? 70;
  const previewLeft = filePreview.source === 'tab'
    ? tabPreviewLeft
    : (sidebarOpen ? (useUIStore.getState().sidebarWidth || 280) : 0);
  const previewTop = filePreview.source === 'tab' ? tabPreviewTop : 36;

  return createPortal(
    <div
      data-file-preview-root
      style={{
        position: 'fixed',
        top: previewTop,
        left: previewLeft,
        right: 0,
        bottom: 0,
        zIndex: 100000,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#1a1a1a',
        border: '1px solid #333'
      }}
    >
      {/* Header */}
      <div className="h-10 bg-tab border-b border-border-main flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-sm font-bold text-white">{fileName}</span>
          <span className="text-[10px] text-[#555] truncate">{filePreview.path}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Inline font-size stepper. Mirrors the SettingsModal stepper so the user
              can adjust font size without leaving the preview; both edit the same
              filePreviewFontSize key in UIStore (persisted to localStorage). */}
          <div className="flex items-center gap-1 mr-1">
            <Tooltip content="Уменьшить шрифт">
            <button
              className="w-6 h-6 flex items-center justify-center rounded text-[#888] hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={filePreviewFontSize <= 10}
              onClick={() => setFilePreviewFontSize(filePreviewFontSize - 1)}
            >−</button>
            </Tooltip>
            <span className="text-[10px] text-[#888] font-mono tabular-nums min-w-[26px] text-center">{filePreviewFontSize}px</span>
            <Tooltip content="Увеличить шрифт">
            <button
              className="w-6 h-6 flex items-center justify-center rounded text-[#888] hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={filePreviewFontSize >= 24}
              onClick={() => setFilePreviewFontSize(filePreviewFontSize + 1)}
            >+</button>
            </Tooltip>
          </div>
          <Tooltip content="Open in Sublime Text">
          <button
            className="h-7 px-2 flex items-center gap-1.5 rounded text-xs text-[#666] hover:text-accent hover:bg-white/5 disabled:opacity-60 disabled:cursor-default transition-colors"
            disabled={openingSublime}
            onClick={handleOpenInSublime}
          >
            {openingSublime ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ExternalLink className="w-3.5 h-3.5" />
            )}
            <span>Sublime</span>
          </button>
          </Tooltip>
          <button
            className={`text-xs px-2 py-1 rounded transition-colors ${
              copied
                ? 'text-accent bg-accent/10'
                : 'text-[#666] hover:text-accent hover:bg-white/5'
            }`}
            onClick={handleCopyContent}
          >
            {copied ? '✓ Copied' : 'Copy All'}
          </button>
          <button
            className="text-[#999] hover:text-white text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-white/10"
            onClick={handleClose}
          >
            ×
          </button>
        </div>
      </div>

      {/* Content — MarkdownEditor in readOnly mode for all files */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', backgroundColor: '#1e1e2e' }}>
        <MarkdownEditor
          content={filePreview.content}
          onChange={() => {}}
          readOnly
          fontSize={filePreviewFontSize}
          wordWrap
          showLineNumbers
        />
      </div>
    </div>,
    document.body
  );
}

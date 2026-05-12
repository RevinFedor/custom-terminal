import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

export default function FilePreview() {
  const { filePreview, closeFilePreview, showToast } = useUIStore();
  const filePreviewFontSize = useUIStore((s) => s.filePreviewFontSize);
  const setFilePreviewFontSize = useUIStore((s) => s.setFilePreviewFontSize);
  const { activeProjectId, getSidebarState, setOpenFilePath } = useWorkspaceStore();
  const { sidebarOpen } = activeProjectId ? getSidebarState(activeProjectId) : { sidebarOpen: false };
  const [copied, setCopied] = useState(false);

  const handleCopyContent = async () => {
    if (filePreview) {
      const { clipboard } = window.require('electron');
      clipboard.writeText(filePreview.content);
      setCopied(true);
      showToast('Copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleClose = () => {
    closeFilePreview();
    if (activeProjectId) {
      setOpenFilePath(activeProjectId, null);
    }
  };

  // Get filename from path
  const fileName = filePreview?.path.split('/').pop() || '';

  if (!filePreview) return null;

  return createPortal(
    <div
      data-file-preview-root
      style={{
        position: 'fixed',
        top: 36,
        left: sidebarOpen ? (useUIStore.getState().sidebarWidth || 280) : 0,
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
            <button
              className="w-6 h-6 flex items-center justify-center rounded text-[#888] hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={filePreviewFontSize <= 10}
              onClick={() => setFilePreviewFontSize(filePreviewFontSize - 1)}
              title="Уменьшить шрифт"
            >−</button>
            <span className="text-[10px] text-[#888] font-mono tabular-nums min-w-[26px] text-center">{filePreviewFontSize}px</span>
            <button
              className="w-6 h-6 flex items-center justify-center rounded text-[#888] hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={filePreviewFontSize >= 24}
              onClick={() => setFilePreviewFontSize(filePreviewFontSize + 1)}
              title="Увеличить шрифт"
            >+</button>
          </div>
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
          foldStateKey={`file-preview:${filePreview.path}`}
        />
      </div>
    </div>,
    document.body
  );
}

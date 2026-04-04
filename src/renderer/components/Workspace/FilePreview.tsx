import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

export default function FilePreview() {
  const { filePreview, closeFilePreview, showToast } = useUIStore();
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
          fontSize={13}
          wordWrap
          showLineNumbers
          foldStateKey={`file-preview:${filePreview.path}`}
        />
      </div>
    </div>,
    document.body
  );
}

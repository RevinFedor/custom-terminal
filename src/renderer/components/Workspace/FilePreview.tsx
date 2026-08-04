import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import ControlHint from '../UI/ControlHint';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

export default function FilePreview({ topOffset = 0 }: { topOffset?: number }) {
  const { filePreview, closeFilePreview, showToast } = useUIStore();
  const filePreviewFontSize = useUIStore((s) => s.filePreviewFontSize);
  const setFilePreviewFontSize = useUIStore((s) => s.setFilePreviewFontSize);
  const { activeProjectId, getSidebarState, setOpenFilePath, switchTab, setProjectView } = useWorkspaceStore();
  const { sidebarOpen } = activeProjectId ? getSidebarState(activeProjectId) : { sidebarOpen: false };
  const [copied, setCopied] = useState(false);
  const [openingSublime, setOpeningSublime] = useState(false);

  // Reading position. The preview unmounts on every project switch, so the
  // offset has to leave this component to survive — it lives in the store,
  // keyed by file path, and is restored on the way back in.
  const previewPath = filePreview?.path || '';
  const scrollerRef = useRef<HTMLElement | null>(null);
  const detachScrollRef = useRef<(() => void) | null>(null);
  const restoredForPathRef = useRef<string | null>(null);
  const pendingScrollRef = useRef<{ path: string; top: number } | null>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  // While this is set, the offset is being restored, not chosen by the user.
  // The editor renders long documents lazily, so the first attempt lands short
  // of the target and the resulting scroll event would save that short value
  // over the real one — the position visibly creeps toward the top.
  const restoreTargetRef = useRef<{ path: string; top: number } | null>(null);
  const restoreTimersRef = useRef<number[]>([]);

  const cancelRestore = useCallback(() => {
    restoreTimersRef.current.forEach((id) => window.clearTimeout(id));
    restoreTimersRef.current = [];
    restoreTargetRef.current = null;
  }, []);

  // Persisting on every scroll event would mean a synchronous write per frame
  // (the store mirrors to SQLite), so writes are coalesced and flushed when the
  // file or the whole preview goes away.
  const flushScrollSave = useCallback(() => {
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (pending?.path) useUIStore.getState().setFilePreviewScrollTop(pending.path, pending.top);
  }, []);

  // Re-applies the target while the document grows: the editor renders long
  // files lazily, so the first assignment lands short of the target. The window
  // always closes on a fixed deadline — nothing may leave it open, or scrolling
  // would stop being saved for the rest of the session.
  const restoreScrollTop = useCallback((scroller: HTMLElement, path: string, top: number) => {
    cancelRestore();
    if (top <= 0) return;
    restoreTargetRef.current = { path, top };
    scroller.scrollTop = top;
    [0, 40, 120, 260, 500].forEach((delay) => {
      const id = window.setTimeout(() => {
        const target = restoreTargetRef.current;
        if (!target || target.path !== path) return;
        if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top;
      }, delay);
      restoreTimersRef.current.push(id);
    });
    const done = window.setTimeout(() => {
      restoreTargetRef.current = null;
      restoreTimersRef.current = [];
    }, 700);
    restoreTimersRef.current.push(done);
  }, [cancelRestore]);

  // The editor accepts onEditorView/initialScrollTop in its type definitions but
  // the shipped build never calls the first and ignores the second, so the
  // scroll container is located in the DOM instead. Attaching is retried while
  // the editor mounts asynchronously.
  const attachScroller = useCallback((scroller: HTMLElement) => {
    detachScrollRef.current?.();
    detachScrollRef.current = null;
    flushScrollSave();
    scrollerRef.current = scroller;

    const path = useUIStore.getState().filePreview?.path || '';
    if (path && restoredForPathRef.current !== path) {
      restoredForPathRef.current = path;
      restoreScrollTop(scroller, path, useUIStore.getState().getFilePreviewScrollTop(path));
    }

    const onScroll = () => {
      const current = useUIStore.getState().filePreview?.path || '';
      if (!current) return;
      // Scroll events fired by an in-flight restore are echoes of a value we
      // already hold — saving them is what corrupted the stored position.
      const restoring = restoreTargetRef.current;
      if (restoring && restoring.path === current) return;
      pendingScrollRef.current = { path: current, top: scroller.scrollTop };
      if (scrollSaveTimerRef.current !== null) return;
      scrollSaveTimerRef.current = window.setTimeout(() => {
        scrollSaveTimerRef.current = null;
        const pending = pendingScrollRef.current;
        pendingScrollRef.current = null;
        if (pending?.path) useUIStore.getState().setFilePreviewScrollTop(pending.path, pending.top);
      }, 200);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    detachScrollRef.current = () => scroller.removeEventListener('scroll', onScroll);
  }, [flushScrollSave, restoreScrollTop]);

  // Locate the editor's scroll container once it exists. Mounting is async and
  // a project switch remounts the whole preview, so this polls briefly rather
  // than assuming the element is there on the first pass.
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!previewPath) return;
    let cancelled = false;
    let attempts = 0;
    const tryAttach = () => {
      if (cancelled) return;
      const scroller = previewHostRef.current?.querySelector('.cm-scroller') as HTMLElement | null;
      if (scroller) {
        if (scrollerRef.current !== scroller) attachScroller(scroller);
        return;
      }
      if (attempts++ < 40) window.setTimeout(tryAttach, 25);
      else console.warn('[FilePreviewScroll] scroll container not found', { path: previewPath });
    };
    tryAttach();
    return () => { cancelled = true; };
  }, [attachScroller, previewPath]);

  useEffect(() => () => {
    detachScrollRef.current?.();
    cancelRestore();
    flushScrollSave();
  }, [cancelRestore, flushScrollSave]);

  // A different file in the same mounted preview needs its own restore pass,
  // and the outgoing file must not lose its pending offset on the way out.
  useEffect(() => {
    flushScrollSave();
    if (!previewPath) { cancelRestore(); restoredForPathRef.current = null; return; }
    const scroller = scrollerRef.current;
    if (!scroller || restoredForPathRef.current === previewPath) return;
    restoredForPathRef.current = previewPath;
    restoreScrollTop(scroller, previewPath, useUIStore.getState().getFilePreviewScrollTop(previewPath));
  }, [cancelRestore, flushScrollSave, previewPath, restoreScrollTop]);

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
            return id !== sourceTabId && !!candidate && candidate.tabType !== 'file';
          })
        : null;
      const fallbackParentId = workspace && fileTab?.visualParentTabId && workspace.tabs.has(fileTab.visualParentTabId)
        ? fileTab.visualParentTabId
        : null;
      const fallbackTabId = workspace
        ? Array.from(workspace.tabs.values()).find((tab) => tab.id !== sourceTabId && tab.tabType !== 'file')?.id
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
  const previewTop = filePreview.source === 'tab' ? tabPreviewTop + topOffset : 36;

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
            <ControlHint label="Уменьшить шрифт">
            <button
              className="w-6 h-6 flex items-center justify-center rounded text-[#888] hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={filePreviewFontSize <= 10}
              onClick={() => setFilePreviewFontSize(filePreviewFontSize - 1)}
            >−</button>
            </ControlHint>
            <span className="text-[10px] text-[#888] font-mono tabular-nums min-w-[26px] text-center">{filePreviewFontSize}px</span>
            <ControlHint label="Увеличить шрифт">
            <button
              className="w-6 h-6 flex items-center justify-center rounded text-[#888] hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={filePreviewFontSize >= 24}
              onClick={() => setFilePreviewFontSize(filePreviewFontSize + 1)}
            >+</button>
            </ControlHint>
          </div>
          <ControlHint label="Открыть в Sublime Text">
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
          </ControlHint>
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
          <ControlHint label="Закрыть превью">
            <button
              className="text-[#999] hover:text-white text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-white/10"
              onClick={handleClose}
            >
              ×
            </button>
          </ControlHint>
        </div>
      </div>

      {/* Content — MarkdownEditor in readOnly mode for all files */}
      <div ref={previewHostRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', backgroundColor: '#1e1e2e' }}>
        <MarkdownEditor
          key={filePreview.path}
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

import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MarkdownEditor } from '@anthropic/markdown-editor';
import '@anthropic/markdown-editor/styles.css';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { X } from 'lucide-react';

interface EditorViewLike {
  focus: () => void;
}

function TabNotesEditorModal() {
  const tabNotesEditorOpen = useUIStore((s) => s.tabNotesEditorOpen);
  const tabNotesEditorTabId = useUIStore((s) => s.tabNotesEditorTabId);
  const closeTabNotesEditor = useUIStore((s) => s.closeTabNotesEditor);
  const showToast = useUIStore((s) => s.showToast);
  const wordWrap = useUIStore((s) => s.wordWrap);
  const tabNotesFontSize = useUIStore((s) => s.tabNotesFontSize);

  const setTabNotes = useWorkspaceStore((s) => s.setTabNotes);
  const getTabNotes = useWorkspaceStore((s) => s.getTabNotes);

  const [content, setContent] = useState('');
  const [tabName, setTabName] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  const editorViewRef = useRef<EditorViewLike | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  // Load notes when modal opens
  useEffect(() => {
    if (tabNotesEditorOpen && tabNotesEditorTabId) {
      const notes = getTabNotes(tabNotesEditorTabId);
      setContent(notes);
      setHasChanges(false);

      // Get tab name for header
      const { openProjects } = useWorkspaceStore.getState();
      for (const [, workspace] of openProjects) {
        const tab = workspace.tabs.get(tabNotesEditorTabId);
        if (tab) {
          setTabName(tab.name);
          break;
        }
      }
    }
  }, [tabNotesEditorOpen, tabNotesEditorTabId, getTabNotes]);

  // Auto-focus editor when modal opens
  useEffect(() => {
    if (tabNotesEditorOpen && editorViewRef.current) {
      const timer = setTimeout(() => {
        editorViewRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [tabNotesEditorOpen]);

  const handleEditorView = useCallback((view: any) => {
    editorViewRef.current = view;
    if (view && tabNotesEditorOpen) {
      setTimeout(() => view.focus(), 50);
    }
  }, [tabNotesEditorOpen]);

  // Save notes
  const saveNotes = useCallback(() => {
    if (!tabNotesEditorTabId) return;
    setTabNotes(tabNotesEditorTabId, content);
    setHasChanges(false);
  }, [tabNotesEditorTabId, content, setTabNotes]);

  const handleChange = useCallback((newContent: string) => {
    setContent(newContent);
    setHasChanges(true);
  }, []);

  const handleClose = useCallback(() => {
    if (hasChanges && tabNotesEditorTabId) {
      setTabNotes(tabNotesEditorTabId, contentRef.current);
    }
    closeTabNotesEditor();
  }, [hasChanges, tabNotesEditorTabId, setTabNotes, closeTabNotesEditor]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!tabNotesEditorOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 's') {
        e.preventDefault();
        saveNotes();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabNotesEditorOpen, saveNotes, handleClose]);

  return (
    <AnimatePresence>
      {tabNotesEditorOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={handleClose}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 40,
              backgroundColor: 'rgba(0,0,0,0.75)'
            }}
          />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              top: '16px',
              left: '16px',
              right: '16px',
              bottom: '16px',
              zIndex: 50,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: '#1a1a1a',
              borderRadius: '12px',
              border: '1px solid #333',
              overflow: 'hidden',
              boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)'
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: '1px solid #333',
              backgroundColor: '#222',
              flexShrink: 0
            }}>
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-medium text-white">
                  Tab Notes
                </h2>
                <span className="text-xs text-[#888]">
                  {tabName}
                </span>
                {hasChanges && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                    Unsaved
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleClose}
                  className="p-1.5 rounded-md text-[#888] hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Editor Container */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: '#1e1e2e'
              }}
            >
              <MarkdownEditor
                content={content}
                onChange={handleChange}
                fontSize={tabNotesFontSize}
                wordWrap={wordWrap}
                foldStateKey={`tab-notes:${tabNotesEditorTabId}`}
                onEditorView={handleEditorView}
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default memo(TabNotesEditorModal);

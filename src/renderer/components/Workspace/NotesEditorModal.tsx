import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MarkdownEditor } from '@anthropic/markdown-editor';
import '@anthropic/markdown-editor/styles.css';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { X } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

// EditorView type from CodeMirror (available via MarkdownEditor's onEditorView callback)
interface EditorViewLike {
  focus: () => void;
}

function NotesEditorModal() {
  // Only subscribe to what we need - avoid unnecessary rerenders from store changes
  const notesEditorOpen = useUIStore((s) => s.notesEditorOpen);
  const notesEditorProjectId = useUIStore((s) => s.notesEditorProjectId);
  const closeNotesEditor = useUIStore((s) => s.closeNotesEditor);
  const showToast = useUIStore((s) => s.showToast);
  const wordWrap = useUIStore((s) => s.wordWrap);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const updateProject = useProjectsStore((s) => s.updateProject);

  const [content, setContent] = useState('');
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  // EditorView ref for focus management
  const editorViewRef = useRef<EditorViewLike | null>(null);

  // Refs for sync effect (to access current values without re-triggering)
  const hasChangesRef = useRef(hasChanges);
  const contentRef = useRef(content);
  hasChangesRef.current = hasChanges;
  contentRef.current = content;

  // DEBUG: Log renders
  const renderCountRef = useRef(0);
  renderCountRef.current++;
  console.log('[NotesEditor] RENDER #', renderCountRef.current, {
    notesEditorOpen,
    notesEditorProjectId,
    activeProjectId,
    hasChanges,
    contentLength: content.length
  });

  // Load notes when modal opens or project changes
  // NOTE: Only depend on notesEditorOpen and notesEditorProjectId to avoid infinite loops
  // when updateProject is called (which changes projects object)
  useEffect(() => {
    console.log('[NotesEditor] useEffect:LOAD triggered', { notesEditorOpen, notesEditorProjectId });
    if (notesEditorOpen && notesEditorProjectId) {
      // Get fresh data from stores (not from dependencies to avoid loops)
      const currentProjects = useProjectsStore.getState().projects;
      const currentOpenProjects = useWorkspaceStore.getState().openProjects;

      const workspace = currentOpenProjects.get(notesEditorProjectId);
      const project = currentProjects[notesEditorProjectId];

      if (workspace && project) {
        const notes = extractNotes(project.notes);
        console.log('[NotesEditor] Loading notes, length:', notes.length);
        setContent(notes);
        setProjectPath(project.path || workspace.projectPath || null);
        setProjectName(project.name || 'Project');
        setHasChanges(false);
      }
    }
  }, [notesEditorOpen, notesEditorProjectId]);

  // Sync editor when switching projects - switch to new project's notes
  // NOTE: Don't include updateProject/openNotesEditor in deps - use from store directly to avoid loops
  useEffect(() => {
    console.log('[NotesEditor] useEffect:SYNC triggered', {
      notesEditorOpen,
      activeProjectId,
      notesEditorProjectId,
      willSwitch: notesEditorOpen && activeProjectId && notesEditorProjectId && activeProjectId !== notesEditorProjectId
    });

    if (notesEditorOpen && activeProjectId && notesEditorProjectId && activeProjectId !== notesEditorProjectId) {
      console.log('[NotesEditor] Project switched while editor open, syncing to new project:', activeProjectId);

      // Save current changes before switching (use refs and direct store access)
      if (hasChangesRef.current && notesEditorProjectId) {
        console.log('[NotesEditor] Saving changes before switching');
        ipcRenderer.invoke('project:save-note', { projectId: notesEditorProjectId, content: contentRef.current });
        // Use direct store access to avoid dependency
        useProjectsStore.getState().updateProject(notesEditorProjectId, { notes: contentRef.current });
      }

      // Switch to new project (use direct store access)
      useUIStore.getState().openNotesEditor(activeProjectId);
    }
  }, [activeProjectId, notesEditorOpen, notesEditorProjectId]);

  // Auto-focus editor when modal opens
  useEffect(() => {
    if (notesEditorOpen && editorViewRef.current) {
      // Small delay to ensure animation is complete and editor is ready
      const timer = setTimeout(() => {
        editorViewRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [notesEditorOpen]);

  // Handle EditorView instance from MarkdownEditor
  // Using 'any' for compatibility with MarkdownEditor's EditorView type
  const handleEditorView = useCallback((view: any) => {
    editorViewRef.current = view;
    // Focus immediately if modal is already open
    if (view && notesEditorOpen) {
      setTimeout(() => view.focus(), 50);
    }
  }, [notesEditorOpen]);

  // Helper to extract notes string from potentially nested object
  const extractNotes = (notes: any): string => {
    if (!notes) return '';
    if (typeof notes === 'string') return notes;
    if (typeof notes === 'object' && notes.global) return notes.global;
    return '';
  };

  // Save notes
  const saveNotes = useCallback(async () => {
    if (!notesEditorProjectId) {
      console.warn('[NotesEditor] Cannot save: No project ID');
      return;
    }

    console.log('[NotesEditor] Saving notes for projectId:', notesEditorProjectId, 'Content length:', content.length);
    console.log('[NotesEditor] Content preview:', content.slice(0, 50));

    try {
      const result = await ipcRenderer.invoke('project:save-note', { projectId: notesEditorProjectId, content });
      console.log('[NotesEditor] Save result:', result);
      
      // Update local store to reflect changes immediately
      await updateProject(notesEditorProjectId, { notes: content });
      console.log('[NotesEditor] Local store updated');

      setHasChanges(false);
      // Toast removed as requested
    } catch (error) {
      console.error('[NotesEditor] Failed to save notes:', error);
      showToast('Ошибка сохранения', 'error');
    }
  }, [notesEditorProjectId, content, showToast, updateProject]);

  // Handle content change
  const handleChange = useCallback((newContent: string) => {
    console.log('[NotesEditor] handleChange called, newContent length:', newContent.length, 'hasNewline:', newContent.includes('\n'));
    setContent(newContent);
    setHasChanges(true);
  }, []);

  // Handle close with save prompt
  const handleClose = useCallback(() => {
    if (hasChanges) {
      saveNotes();
    }
    closeNotesEditor();
  }, [hasChanges, saveNotes, closeNotesEditor]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!notesEditorOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // CMD+S to save
      if (e.metaKey && e.key === 's') {
        e.preventDefault();
        saveNotes();
      }
      // Escape or CMD+E to close (and save)
      if (e.key === 'Escape' || (e.metaKey && e.key === 'e')) {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [notesEditorOpen, saveNotes, handleClose]);

  return (
    <AnimatePresence>
      {notesEditorOpen && (
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
                  Notes Editor
                </h2>
                <span className="text-xs text-[#888]">
                  {projectName}
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

            {/* Editor Container - CodeMirror handles its own scroll via .cm-scroller */}
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
                fontSize={14}
                wordWrap={wordWrap}
                foldStateKey={`notes:${notesEditorProjectId}`}
                onEditorView={handleEditorView}
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default memo(NotesEditorModal);

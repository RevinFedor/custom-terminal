import React, { useState, useEffect, useCallback, useRef } from 'react';
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

export default function NotesEditorModal() {
  const { notesEditorOpen, notesEditorProjectId, closeNotesEditor, showToast, wordWrap } = useUIStore();
  const { openProjects } = useWorkspaceStore();
  const { projects, updateProject } = useProjectsStore();

  const [content, setContent] = useState('');
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  // EditorView ref for focus management
  const editorViewRef = useRef<EditorViewLike | null>(null);

  // Load notes when modal opens
  useEffect(() => {
    if (notesEditorOpen && notesEditorProjectId) {
      const workspace = openProjects.get(notesEditorProjectId);
      const project = projects[notesEditorProjectId];

      if (workspace && project) {
        const notes = extractNotes(project.notes);
        setContent(notes);
        setProjectPath(project.path || workspace.projectPath || null);
        setProjectName(project.name || 'Project');
        setHasChanges(false);
      }
    }
  }, [notesEditorOpen, notesEditorProjectId, openProjects, projects]);

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
    if (!projectPath || !notesEditorProjectId) {
      console.warn('[NotesEditor] Cannot save: No project path or ID');
      return;
    }

    console.log('[NotesEditor] Saving notes for path:', projectPath, 'Content length:', content.length);
    console.log('[NotesEditor] Content preview:', content.slice(0, 50));

    try {
      const result = await ipcRenderer.invoke('project:save-note', { dirPath: projectPath, content });
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
  }, [projectPath, notesEditorProjectId, content, showToast, updateProject]);

  // Handle content change
  const handleChange = useCallback((newContent: string) => {
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

            {/* Editor Container - ensure it takes full height */}
            <div className="flex-1 overflow-hidden relative bg-[#1e1e2e]">
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

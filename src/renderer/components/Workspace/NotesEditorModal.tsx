import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MarkdownEditor } from '@anthropic/markdown-editor';
import '@anthropic/markdown-editor/styles.css';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { X } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

export default function NotesEditorModal() {
  const { notesEditorOpen, notesEditorProjectId, closeNotesEditor, showToast, wordWrap } = useUIStore();
  const { openProjects } = useWorkspaceStore();
  const { projects } = useProjectsStore();

  const [content, setContent] = useState('');
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

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

  // Helper to extract notes string from potentially nested object
  const extractNotes = (notes: any): string => {
    if (!notes) return '';
    if (typeof notes === 'string') return notes;
    if (typeof notes === 'object' && notes.global) return notes.global;
    return '';
  };

  // Save notes
  const saveNotes = useCallback(async () => {
    if (!projectPath) return;

    try {
      await ipcRenderer.invoke('project:save-note', { dirPath: projectPath, content });
      setHasChanges(false);
      showToast('Заметки сохранены', 'success');
    } catch (error) {
      console.error('Failed to save notes:', error);
      showToast('Ошибка сохранения', 'error');
    }
  }, [projectPath, content, showToast]);

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
      // Escape to close
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [notesEditorOpen, saveNotes, handleClose]);

  if (!notesEditorOpen) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[100000] flex flex-col"
        style={{ top: 36 }} // Below title bar
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={handleClose}
        />

        {/* Modal Content */}
        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 10 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="relative flex-1 flex flex-col m-4 bg-[#1e1e2e] rounded-xl border border-[#333] shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#333] bg-[#252536]">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-white">
                Заметки проекта
              </h2>
              <span className="text-xs text-[#888] font-mono">
                {projectName}
              </span>
              {hasChanges && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                  Не сохранено
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={saveNotes}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#89b4fa]/20 text-[#89b4fa] hover:bg-[#89b4fa]/30 transition-colors"
              >
                Сохранить (⌘S)
              </button>
              <button
                onClick={handleClose}
                className="p-1.5 rounded-lg text-[#888] hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-hidden">
            <MarkdownEditor
              content={content}
              onChange={handleChange}
              fontSize={14}
              wordWrap={wordWrap}
              foldStateKey={`notes:${notesEditorProjectId}`}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-[#333] bg-[#252536] text-[10px] text-[#666]">
            <span>ESC — закрыть | ⌘S — сохранить</span>
            <span>Markdown поддерживается</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

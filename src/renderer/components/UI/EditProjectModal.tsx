import React, { useState, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useBookmarksStore } from '../../store/useBookmarksStore';
import { Folder, CheckCircle2, AlertCircle, Trash2, HelpCircle } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import SmartPopover from './SmartPopover';

const { ipcRenderer } = window.require('electron');

export default function EditProjectModal() {
  const { editingProject, closeEditModal, showToast } = useUIStore();
  const { loadProjects, updateProject } = useProjectsStore();
  const { bookmarks, updateBookmark, deleteBookmark, loadBookmarks } = useBookmarksStore();
  const { openProjects, closeProject } = useWorkspaceStore();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [isPathValid, setIsPathValid] = useState<boolean | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isHoveringName, setIsHoveringName] = useState(false);

  // Robust check if we are editing a Bookmark or a Project
  const isActuallyBookmark = editingProject && bookmarks.some(b => String(b.id) === String(editingProject.id));

  useEffect(() => {
    if (editingProject) {
      setName(editingProject.name || '');
      setDescription(editingProject.description || '');
      setPath(editingProject.path || '');
      setIsPathValid(null);
    }
  }, [editingProject]);

  // Save everything when modal closes (onUnmount)
  useEffect(() => {
    return () => {
      if (editingProject) {
        handleSave(true); // Silent save on close
      }
    };
  }, [editingProject, name, description, path]);

  const validatePath = async (p: string) => {
    if (!p || !p.trim()) {
      setIsPathValid(false);
      return false;
    }
    setIsValidating(true);
    const exists = await ipcRenderer.invoke('app:check-path-exists', p.trim());
    setIsPathValid(exists);
    setIsValidating(false);
    return exists;
  };

  const handleSelectDirectory = async () => {
    const selected = await ipcRenderer.invoke('app:select-directory');
    if (selected) {
      setPath(selected);
      validatePath(selected);
      handleSave();
    }
  };

  const handleSave = async (silent = false) => {
    if (!editingProject) return;
    if (!name.trim()) return;

    if (isActuallyBookmark) {
      await updateBookmark(editingProject.id, {
        name: name.trim(),
        description: description.trim()
      });
    } else {
      // For projects, path validation is more critical
      await updateProject(editingProject.id, {
        name: name.trim(),
        description: description.trim(),
        path: path.trim()
      });
    }

    if (!silent) {
      // Notify other components (like ProjectHome) about name change
      window.dispatchEvent(new CustomEvent('project:name-sync', { 
        detail: { projectId: editingProject.id, name: name.trim() } 
      }));
    }
  };

  const handleDelete = async () => {
    if (!editingProject) return;

    if (!confirm(`Delete ${isActuallyBookmark ? 'bookmark' : 'project'} "${editingProject.name}"?`)) return;

    if (isActuallyBookmark) {
      await deleteBookmark(editingProject.id);
      showToast('Bookmark deleted', 'success');
    } else {
      if (openProjects.has(editingProject.id)) {
        await closeProject(editingProject.id);
      }
      const result = await ipcRenderer.invoke('project:delete', editingProject.id);
      if (result.success) {
        showToast('Project deleted', 'success');
        loadProjects();
      }
    }
    closeEditModal();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeEditModal();
    }
  };

  if (!editingProject) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]"
      onClick={closeEditModal}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 w-[400px] shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Right Controls */}
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <button
            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-full transition-all cursor-pointer"
            onClick={handleDelete}
            title="Delete"
          >
            <Trash2 size={16} />
          </button>
          <button
            className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-white rounded-full hover:bg-white/5 transition-all text-xl"
            onClick={closeEditModal}
          >
            ×
          </button>
        </div>

        {/* Header with SmartPopover on Name */}
        <div className="mb-6">
          <SmartPopover content={description} isOpen={isHoveringName}>
            <h2 
              className="text-lg font-bold text-white cursor-help inline-block border-b border-transparent hover:border-white/20 transition-all"
              onMouseEnter={() => setIsHoveringName(true)}
              onMouseLeave={() => setIsHoveringName(false)}
            >
              {name || (isActuallyBookmark ? 'Edit Bookmark' : 'Edit Project')}
            </h2>
          </SmartPopover>
          <p className="text-[10px] text-gray-500 uppercase tracking-widest mt-1">
            {isActuallyBookmark ? 'Reserved Directory' : 'Project Instance'}
          </p>
        </div>

        {/* Form */}
        <div className="space-y-5">
          <div>
            <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1.5 ml-1">Name</label>
            <input
              type="text"
              className="w-full bg-[#222] border border-white/5 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-accent focus:bg-[#252525] transition-all"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => handleSave()}
              placeholder="Enter name..."
              autoFocus
            />
          </div>

          {!isActuallyBookmark && (
            <div>
              <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1.5 ml-1 flex items-center gap-2">
                System Path
                {isPathValid === true && <CheckCircle2 size={12} className="text-green-500" />}
                {isPathValid === false && <AlertCircle size={12} className="text-red-500" />}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    className={`w-full bg-[#222] border ${isPathValid === false ? 'border-red-500/30' : 'border-white/5'} rounded-xl px-4 py-2 text-white text-[11px] focus:outline-none focus:border-accent transition-all font-mono`}
                    value={path}
                    onChange={(e) => {
                      setPath(e.target.value);
                      setIsPathValid(null);
                    }}
                    onBlur={(e) => {
                      validatePath(e.target.value);
                      handleSave();
                    }}
                    placeholder="/path/to/project"
                  />
                </div>
                <button
                  className="w-10 h-10 flex items-center justify-center bg-[#222] hover:bg-[#2a2a2a] text-gray-400 hover:text-white rounded-xl border border-white/5 transition-all cursor-pointer flex-shrink-0"
                  onClick={handleSelectDirectory}
                >
                  <Folder size={18} />
                </button>
              </div>
            </div>
          )}

          <div>
            <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1.5 ml-1">Description</label>
            <textarea
              className="w-full bg-[#222] border border-white/5 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-accent focus:bg-[#252525] transition-all resize-none h-28"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => handleSave()}
              placeholder="What is this project about? Hover the name above to see this description."
            />
          </div>
        </div>

        <div className="mt-8 pt-4 border-t border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2 text-gray-600">
            <div className="w-1.5 h-1.5 bg-green-500/50 rounded-full animate-pulse" />
            <span className="text-[10px] uppercase font-bold tracking-tighter">Auto-saving enabled</span>
          </div>
          <span className="text-[10px] text-gray-700 font-mono italic">ESC to close</span>
        </div>
      </div>
    </div>
  );
}

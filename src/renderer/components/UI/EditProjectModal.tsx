import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { Folder, CheckCircle2, AlertCircle, Trash2 } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

export default function EditProjectModal() {
  const { editingProject, closeEditModal, showToast } = useUIStore();
  const { loadProjects } = useProjectsStore();
  const { openProjects, closeProject } = useWorkspaceStore();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [isPathValid, setIsPathValid] = useState<boolean | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const handleDelete = async () => {
    if (!editingProject) return;

    if (!confirm(`Delete "${editingProject.name}"?`)) return;

    if (openProjects.has(editingProject.id)) {
      await closeProject(editingProject.id);
    }

    const result = await ipcRenderer.invoke('project:delete', editingProject.id);
    if (result.success) {
      showToast('Project deleted', 'success');
      loadProjects();
      closeEditModal();
    } else {
      showToast('Failed to delete', 'error');
    }
  };

  useEffect(() => {
    if (editingProject) {
      setName(editingProject.name || '');
      setDescription(editingProject.description || '');
      setPath(editingProject.path || '');
      setIsPathValid(null);
    }
  }, [editingProject]);

  const validatePath = async (p: string) => {
    if (!p.trim()) {
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
    }
  };

  const handleSave = async () => {
    if (!editingProject) return;

    if (!name.trim()) {
      showToast('Project name cannot be empty', 'error');
      return;
    }

    const isCurrentPathValid = await validatePath(path);
    if (!isCurrentPathValid) {
      if (!confirm('The specified path does not exist or is not a directory. Save anyway?')) {
        return;
      }
    }

    await ipcRenderer.invoke('project:save-metadata', {
      projectId: editingProject.id,
      metadata: {
        name: name.trim(),
        description: description.trim(),
        path: path.trim()
      }
    });

    showToast('Project saved', 'success');
    loadProjects();
    closeEditModal();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) {
      handleSave();
    } else if (e.key === 'Escape') {
      closeEditModal();
    }
  };

  if (!editingProject) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]"
      onClick={closeEditModal}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        className="bg-panel border border-border-main rounded-xl p-6 w-[450px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-white">Edit Project</h2>
            <button
              className="p-1.5 text-[#555] hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all cursor-pointer"
              onClick={handleDelete}
              title="Delete Project"
            >
              <Trash2 size={16} />
            </button>
          </div>
          <button
            className="text-[#888] hover:text-white text-2xl leading-none"
            onClick={closeEditModal}
          >
            ×
          </button>
        </div>

        {/* Form */}
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-[#888] uppercase mb-1">Name</label>
            <input
              type="text"
              className="w-full bg-[#2d2d2d] border border-[#444] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-accent transition-colors"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs text-[#888] uppercase mb-1 font-medium flex items-center gap-2">
              Directory Path
              {isPathValid === true && <CheckCircle2 size={12} className="text-green-500" />}
              {isPathValid === false && <AlertCircle size={12} className="text-red-500" />}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  className={`w-full bg-[#2d2d2d] border ${isPathValid === false ? 'border-red-500/50' : 'border-[#444]'} rounded px-3 py-2 text-white text-xs focus:outline-none focus:border-accent transition-colors`}
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value);
                    setIsPathValid(null);
                  }}
                  onBlur={(e) => validatePath(e.target.value)}
                  placeholder="/path/to/project"
                />
              </div>
              <button
                className="px-3 bg-[#333] hover:bg-[#444] text-[#aaa] hover:text-white rounded border border-[#444] transition-all flex items-center gap-2 text-xs cursor-pointer"
                onClick={handleSelectDirectory}
                title="Select folder"
              >
                <Folder size={14} />
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-[#888] uppercase mb-1 font-medium">Description</label>
            <textarea
              className="w-full bg-[#2d2d2d] border border-[#444] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-accent resize-none h-24"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-white/5">
          <button
            className="px-4 py-2 text-sm text-[#ccc] hover:text-white transition-colors cursor-pointer"
            onClick={closeEditModal}
          >
            Cancel
          </button>
          <button
            className={`px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/80 transition-colors cursor-pointer ${isValidating ? 'opacity-50' : ''}`}
            onClick={handleSave}
            disabled={isValidating}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

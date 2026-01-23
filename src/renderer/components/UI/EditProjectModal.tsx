import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';

const { ipcRenderer } = window.require('electron');

export default function EditProjectModal() {
  const { editingProject, closeEditModal, showToast } = useUIStore();
  const { loadProjects } = useProjectsStore();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (editingProject) {
      setName(editingProject.name || '');
      setDescription(editingProject.description || '');
    }
  }, [editingProject]);

  const handleSave = async () => {
    if (!editingProject) return;

    if (!name.trim()) {
      showToast('Project name cannot be empty', 'error');
      return;
    }

    await ipcRenderer.invoke('project:save-metadata', {
      dirPath: editingProject.path,
      metadata: {
        name: name.trim(),
        description: description.trim()
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
        className="bg-panel border border-border-main rounded-xl p-6 w-[400px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white">Edit Project</h2>
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
              className="w-full bg-[#2d2d2d] border border-[#444] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-accent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs text-[#888] uppercase mb-1">Description</label>
            <textarea
              className="w-full bg-[#2d2d2d] border border-[#444] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-accent resize-none h-24"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
            />
          </div>

          <div className="text-[10px] text-[#666]">
            Path: {editingProject.path}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 mt-6">
          <button
            className="px-4 py-2 text-sm text-[#ccc] hover:text-white transition-colors"
            onClick={closeEditModal}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/80 transition-colors"
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

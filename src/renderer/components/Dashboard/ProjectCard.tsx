import React, { useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

interface Project {
  id: string;
  path: string;
  name: string;
  description?: string;
}

interface TabsStats {
  total: number;
  active: number;
}

interface ProjectCardProps {
  project: Project;
  onOpen: () => void;
  tabsStats?: TabsStats;
}

export default function ProjectCard({ project, onOpen, tabsStats = { total: 0, active: 0 } }: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { openEditModal, showToast } = useUIStore();
  const { loadProjects } = useProjectsStore();
  const { openProjects, closeProject } = useWorkspaceStore();

  const handleEdit = (e: React.MouseEvent) => {
    console.log('[ProjectCard] handleEdit called');
    e.stopPropagation();
    e.preventDefault();
    setMenuOpen(false);
    console.log('[ProjectCard] Opening edit modal for:', project.name);
    // Small delay to ensure menu closes before modal opens
    setTimeout(() => {
      console.log('[ProjectCard] Calling openEditModal');
      openEditModal(project);
    }, 50);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    console.log('[ProjectCard] handleDelete called');
    e.stopPropagation();
    e.preventDefault();
    setMenuOpen(false);

    console.log('[ProjectCard] Showing confirm dialog');
    if (!confirm(`Are you sure you want to delete "${project.name}"?`)) {
      console.log('[ProjectCard] Delete cancelled');
      return;
    }

    console.log('[ProjectCard] Delete confirmed, proceeding...');

    // Close project if open
    if (openProjects.has(project.id)) {
      console.log('[ProjectCard] Closing open project');
      await closeProject(project.id);
    }

    // Delete from backend
    console.log('[ProjectCard] Calling project:delete IPC');
    const result = await ipcRenderer.invoke('project:delete', project.path);
    console.log('[ProjectCard] Delete result:', result);

    if (result.success) {
      showToast('Project deleted', 'success');
    } else {
      showToast('Failed to delete project', 'error');
    }
    loadProjects();
  };

  const handleMenuClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(!menuOpen);
  };

  return (
    <div
      className="group bg-tab border border-border-main rounded-xl p-6 cursor-pointer transition-all hover:border-accent hover:shadow-lg relative"
      onClick={onOpen}
    >
      {/* Header */}
      <div className="flex justify-between items-start mb-3">
        <div className="flex items-center gap-2 flex-1 mr-2 min-w-0">
          <h3 className="text-lg font-bold text-white truncate group-hover:text-accent transition-colors">
            {project.name}
          </h3>
          {project.description && (
            <span className="relative group/desc inline-block shrink-0">
              <span className="text-xs text-[#aaa] cursor-help hover:text-white transition-colors">ℹ️</span>
              <div className="absolute bottom-full left-0 mb-2 pointer-events-none z-50 opacity-0 group-hover/desc:opacity-100 transition-opacity">
                <div className="bg-gray-900/95 backdrop-blur-sm border border-gray-700 p-3 rounded-xl shadow-2xl w-64 whitespace-normal">
                  <p className="text-xs text-gray-300">{project.description}</p>
                </div>
              </div>
            </span>
          )}
        </div>

        {/* Menu Button */}
        <div className="relative shrink-0">
          <button
            className="opacity-0 group-hover:opacity-100 text-[#999] hover:text-white text-xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-all"
            onClick={handleMenuClick}
          >
            ⋯
          </button>

          {/* Dropdown Menu */}
          {menuOpen && (
            <>
              {/* Click outside handler - use pointer-events to not block dropdown */}
              <div
                className="fixed inset-0"
                style={{ zIndex: 50 }}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
              />
              <div
                className="absolute right-0 top-full mt-1 bg-panel border border-border-main rounded-lg shadow-xl min-w-[150px]"
                style={{ zIndex: 51 }}
              >
                <button
                  className="w-full text-left px-4 py-2 text-sm text-[#ccc] hover:bg-white/10 hover:text-white rounded-t-lg cursor-pointer transition-colors"
                  onClick={handleEdit}
                >
                  ✏️ Edit
                </button>
                <button
                  className="w-full text-left px-4 py-2 text-sm text-[#cc3333] hover:bg-[#cc3333]/20 hover:text-[#ff4444] rounded-b-lg cursor-pointer transition-colors"
                  onClick={handleDelete}
                >
                  🗑️ Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Path */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-jetbrains text-[#666] truncate flex-1">{project.path}</span>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-[#888]">
        {tabsStats.total > 0 ? (
          <span>
            {tabsStats.total} tab{tabsStats.total !== 1 ? 's' : ''}
            {tabsStats.active > 0 && (
              <span className="text-green-400 ml-1">• {tabsStats.active} active</span>
            )}
          </span>
        ) : (
          <span>No open tabs</span>
        )}
        <span className="text-accent">Click to open →</span>
      </div>
    </div>
  );
}

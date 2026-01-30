import React, { useState, useRef } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { FolderOpen, MoreHorizontal, HelpCircle } from 'lucide-react';

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
  isOpen?: boolean;
  onOpen: () => void;
  tabsStats?: TabsStats;
}

export default function ProjectCard({
  project,
  isOpen = false,
  onOpen,
  tabsStats = { total: 0, active: 0 }
}: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipLeft, setTooltipLeft] = useState(true);
  const tooltipBtnRef = useRef<HTMLButtonElement>(null);

  const { openEditModal, showToast } = useUIStore();
  const { loadProjects } = useProjectsStore();
  const { openProjects, closeProject } = useWorkspaceStore();

  const hasActiveProcesses = tabsStats.active > 0;

  const getShortPath = (fullPath: string) => {
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length <= 2) return fullPath;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    openEditModal(project);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);

    if (!confirm(`Delete "${project.name}"?`)) return;

    if (openProjects.has(project.id)) {
      await closeProject(project.id);
    }

    const result = await ipcRenderer.invoke('project:delete', project.id);
    if (result.success) {
      showToast('Project deleted', 'success');
      loadProjects();
    } else {
      showToast('Failed to delete', 'error');
    }
  };

  const handleTooltipEnter = () => {
    if (tooltipBtnRef.current) {
      const rect = tooltipBtnRef.current.getBoundingClientRect();
      setTooltipLeft(rect.left >= 280);
      setShowTooltip(true);
    }
  };

  const [pathHovered, setPathHovered] = useState(false);

  return (
    <div
      className={`
        group relative cursor-pointer rounded-lg transition-all duration-150
        ${isOpen
          ? 'bg-purple-500/5 border border-white/10 hover:bg-purple-500/10 hover:border-white/20'
          : 'bg-white/[0.03] border border-transparent hover:bg-white/[0.05] hover:border-[#444]'
        }
      `}
      onClick={onOpen}
      onMouseLeave={() => {
        setMenuOpen(false);
        setPathHovered(false);
      }}
    >
      {/* Project Name */}
      <div className="flex items-center gap-2 px-2.5 pt-3 pb-0.5">
        <FolderOpen
          size={14}
          className={`flex-shrink-0 ${hasActiveProcesses ? 'text-green-400' : 'text-[#888]'}`}
        />
        <span
          className="text-sm text-white font-medium truncate group-hover:text-accent transition-colors"
        >
          {project.name}
        </span>
      </div>

      {/* Path with Instant Tooltip */}
      <div 
        className="px-2.5 text-[10px] text-[#555] truncate group-hover:text-[#888] transition-colors relative"
        onMouseEnter={() => setPathHovered(true)}
        onMouseLeave={() => setPathHovered(false)}
      >
        {getShortPath(project.path)}

        {pathHovered && (
          <div 
            className="absolute left-0 bottom-full mb-1 z-[100] bg-[#333] text-white text-[9px] px-2 py-1 rounded shadow-xl border border-white/10 whitespace-nowrap pointer-events-none"
          >
            {project.path}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="px-2.5 pb-2">
        <span className={`text-[10px] ${hasActiveProcesses ? 'text-white' : 'text-[#666]'}`}>
          {tabsStats.total > 0 ? (
            <>
              {tabsStats.total} tab{tabsStats.total !== 1 ? 's' : ''}
              {hasActiveProcesses && (
                <span className="text-green-400 ml-1">• {tabsStats.active}</span>
              )}
            </>
          ) : (
            '—'
          )}
        </span>
      </div>

      {/* Hover Buttons - Bottom Right */}
      <div
        className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Menu */}
        <div className="relative">
          <button
            className="p-1 text-[#666] hover:text-white hover:bg-white/10 rounded transition-colors cursor-pointer"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          >
            <MoreHorizontal size={12} />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
              />
              <div className="absolute right-0 bottom-full mb-1 bg-[#252525] border border-[#444] rounded-lg shadow-xl min-w-[100px] z-50 overflow-hidden">
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] text-[#ccc] hover:bg-white/10 hover:text-white transition-colors"
                  onClick={handleEdit}
                >
                  Edit
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors"
                  onClick={handleDelete}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>

        {/* Info Tooltip */}
        {project.description && (
          <div className="relative">
            <button
              ref={tooltipBtnRef}
              className="p-1 text-[#666] hover:text-white hover:bg-white/10 rounded transition-colors cursor-pointer"
              onMouseEnter={handleTooltipEnter}
              onMouseLeave={() => setShowTooltip(false)}
            >
              <HelpCircle size={12} />
            </button>

            <div
              className={`
                absolute top-1/2 -translate-y-1/2 pointer-events-none z-50
                transition-all duration-200 ease-out
                ${showTooltip ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}
                ${tooltipLeft ? 'right-full mr-2 origin-right' : 'left-full ml-2 origin-left'}
              `}
            >
              <div className="bg-[#252525] border border-[#444] p-3 rounded-lg shadow-xl w-64">
                <p className="text-xs text-[#ccc] whitespace-pre-wrap">{project.description}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

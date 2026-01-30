import React, { useState } from 'react';
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
  isOpen?: boolean; // Project is currently open in workspace
  onOpen: () => void;
  tabsStats?: TabsStats;
}

export default function ProjectCard({ project, isOpen = false, onOpen, tabsStats = { total: 0, active: 0 } }: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { openEditModal, showToast } = useUIStore();
  const { loadProjects } = useProjectsStore();
  const { openProjects, closeProject } = useWorkspaceStore();

  // Project has running processes
  const hasActiveProcesses = tabsStats.active > 0;

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setMenuOpen(false);
    setTimeout(() => {
      openEditModal(project);
    }, 50);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setMenuOpen(false);

    if (!confirm(`Delete "${project.name}"?`)) return;

    if (openProjects.has(project.id)) {
      await closeProject(project.id);
    }

    const result = await ipcRenderer.invoke('project:delete', project.path);
    if (result.success) {
      showToast('Project deleted', 'success');
    } else {
      showToast('Failed to delete', 'error');
    }
    loadProjects();
  };

  const handleMenuClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(!menuOpen);
  };

  // Get folder name from path
  const getFolderName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  // Border color: open projects have subtle border, closed have transparent
  const borderColor = isOpen ? 'rgba(168, 85, 247, 0.3)' : 'transparent';
  const hoverBorderColor = isOpen ? 'rgba(168, 85, 247, 0.5)' : '#555';

  return (
    <div
      className="group relative cursor-pointer transition-all duration-150"
      style={{
        backgroundColor: isOpen ? 'rgba(168, 85, 247, 0.05)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${borderColor}`,
        borderRadius: '8px',
      }}
      onClick={onOpen}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = hoverBorderColor;
        e.currentTarget.style.backgroundColor = isOpen ? 'rgba(168, 85, 247, 0.08)' : 'rgba(255,255,255,0.05)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = borderColor;
        e.currentTarget.style.backgroundColor = isOpen ? 'rgba(168, 85, 247, 0.05)' : 'rgba(255,255,255,0.03)';
        setMenuOpen(false);
      }}
    >
      {/* Project Name */}
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <FolderOpen
          size={14}
          className={`flex-shrink-0 transition-colors ${hasActiveProcesses ? 'text-green-400' : 'text-[#888]'}`}
        />
        <span
          className="text-sm text-white font-medium truncate group-hover:text-accent transition-colors"
          title={project.name}
        >
          {project.name}
        </span>
      </div>

      {/* Path */}
      <div className="px-3 text-[10px] text-[#555] truncate mb-1" title={project.path}>
        {getFolderName(project.path)}
      </div>

      {/* Stats */}
      <div className="px-3 pb-2 flex items-center">
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

      {/* Buttons - absolute bottom right */}
      <div
        className="absolute bottom-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Menu Button - first (left) */}
        <div className="relative">
          <button
            className="p-1 text-[#666] hover:text-white hover:bg-white/10 rounded transition-all cursor-pointer"
            onClick={handleMenuClick}
          >
            <MoreHorizontal size={12} />
          </button>

          {/* Dropdown Menu */}
          {menuOpen && (
            <>
              <div
                className="fixed inset-0"
                style={{ zIndex: 50 }}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
              />
              <div
                className="absolute right-0 bottom-full mb-1 bg-panel border border-border-main rounded-lg shadow-xl min-w-[100px]"
                style={{ zIndex: 51 }}
              >
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] text-[#ccc] hover:bg-white/10 hover:text-white rounded-t-lg cursor-pointer transition-colors"
                  onClick={handleEdit}
                >
                  Edit
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 text-[11px] text-[#cc3333] hover:bg-[#cc3333]/20 hover:text-[#ff4444] rounded-b-lg cursor-pointer transition-colors"
                  onClick={handleDelete}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>

        {/* Info button with genie tooltip - second (right) */}
        {project.description && (
          <span
            className="relative flex items-center"
            onMouseEnter={(e) => {
              const button = e.currentTarget.querySelector('button') as HTMLElement;
              const tooltip = e.currentTarget.querySelector('.tooltip-content') as HTMLElement;
              if (!tooltip || !button) return;

              // Check if there's enough space on the left (256px = w-64)
              const buttonRect = button.getBoundingClientRect();
              const spaceLeft = buttonRect.left;
              const tooltipWidth = 256 + 8; // w-64 + pr-2

              const openLeft = spaceLeft >= tooltipWidth;

              if (openLeft) {
                // Open to the left
                tooltip.style.right = '100%';
                tooltip.style.left = 'auto';
                tooltip.style.paddingRight = '8px';
                tooltip.style.paddingLeft = '0';
                tooltip.style.transformOrigin = 'right center';
                tooltip.style.opacity = '1';
                tooltip.style.transform = 'translateY(-50%) translateX(0) scaleX(1) scaleY(1)';
              } else {
                // Open to the right
                tooltip.style.left = '100%';
                tooltip.style.right = 'auto';
                tooltip.style.paddingLeft = '8px';
                tooltip.style.paddingRight = '0';
                tooltip.style.transformOrigin = 'left center';
                tooltip.style.opacity = '1';
                tooltip.style.transform = 'translateY(-50%) translateX(0) scaleX(1) scaleY(1)';
              }
            }}
            onMouseLeave={(e) => {
              const tooltip = e.currentTarget.querySelector('.tooltip-content') as HTMLElement;
              if (tooltip) {
                tooltip.style.opacity = '0';
                // Reset to collapsed state
                const isLeft = tooltip.style.right === '100%';
                if (isLeft) {
                  tooltip.style.transform = 'translateY(-50%) translateX(1rem) scaleX(0) scaleY(0.85)';
                } else {
                  tooltip.style.transform = 'translateY(-50%) translateX(-1rem) scaleX(0) scaleY(0.85)';
                }
              }
            }}
          >
            <button
              className="p-1 text-[#666] hover:text-white hover:bg-white/10 rounded transition-all cursor-pointer"
            >
              <HelpCircle size={12} />
            </button>

            {/* Genie tooltip - direction determined dynamically */}
            <div
              className="tooltip-content absolute top-1/2 pointer-events-none z-50 transition-all duration-200 ease-out"
              style={{
                right: '100%',
                paddingRight: '8px',
                opacity: 0,
                transform: 'translateY(-50%) translateX(1rem) scaleX(0) scaleY(0.85)',
                transformOrigin: 'right center',
              }}
            >
              <div className="bg-[#252525] border border-[#444] p-3 rounded-lg shadow-xl w-64">
                <p className="text-xs text-[#ccc] whitespace-pre-wrap">{project.description}</p>
              </div>
            </div>
          </span>
        )}
      </div>
    </div>
  );
}

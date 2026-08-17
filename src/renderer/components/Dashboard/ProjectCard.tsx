import React, { useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { FolderOpen, Settings, Trash2 } from 'lucide-react';
import SmartPopover from '../UI/SmartPopover';
import ControlHint from '../UI/ControlHint';

const { ipcRenderer } = window.require('electron');

interface Project {
  id: string;
  path: string;
  name: string;
  description?: string;
  icon?: string | null;
}

interface TabsStats {
  total: number;
  active: number;
  history: number;
}

interface ProjectCardProps {
  project: Project;
  isOpen?: boolean;
  onOpen: () => void;
  onMiddleClick?: () => void;
  tabsStats?: TabsStats;
}

export default function ProjectCard({
  project,
  isOpen = false,
  onOpen,
  onMiddleClick,
  tabsStats = { total: 0, active: 0, history: 0 }
}: ProjectCardProps) {
  const [pathHovered, setPathHovered] = useState(false);
  const [isHoveringName, setIsHoveringName] = useState(false);

  const { openEditModal, showToast } = useUIStore();
  const { openProjects, closeProject } = useWorkspaceStore();
  const { loadProjects } = useProjectsStore();

  const getShortPath = (fullPath: string) => {
    if (!fullPath || fullPath.startsWith('__unset__')) return 'No path';
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length <= 2) return fullPath;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    openEditModal(project);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete project "${project.name}"?`)) return;

    if (openProjects.has(project.id)) {
      await closeProject(project.id);
    }

    const result = await ipcRenderer.invoke('project:delete', project.id);
    if (result?.success) {
      showToast('Project deleted', 'success');
      await loadProjects();
    } else {
      showToast('Failed to delete project', 'error');
    }
  };

  return (
    <div
      className={`
        group relative min-w-0 cursor-pointer rounded-md transition-all duration-150
        ${isOpen
          ? 'bg-purple-500/5 border border-white/5 hover:bg-purple-500/10 hover:border-white/10'
          : 'bg-white/[0.03] border border-transparent hover:bg-white/[0.05] hover:border-[#333]'
        }
      `}
      onClick={onOpen}
      onMouseDown={(e) => {
        if (e.button === 1 && onMiddleClick) {
          e.preventDefault();
          onMiddleClick();
        }
      }}
      onMouseLeave={() => setPathHovered(false)}
    >
      <div className="absolute top-1 right-1 z-20 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
        <ControlHint label="Удалить проект" side="bottom">
          <button
            className="p-1 text-[#777] bg-[#141414]/95 hover:text-red-400 hover:bg-red-500/15 rounded transition-colors cursor-pointer"
            onClick={handleDelete}
            title="Delete project"
          >
            <Trash2 size={12} />
          </button>
        </ControlHint>
        <ControlHint label="Настройки проекта" side="bottom">
          <button
            className="p-1 text-[#777] bg-[#141414]/95 hover:text-white hover:bg-white/10 rounded transition-colors cursor-pointer"
            onClick={handleEdit}
            title="Project settings"
          >
            <Settings size={12} />
          </button>
        </ControlHint>
      </div>

      {/* Project Name */}
      <div
        className="grid min-w-0 items-center gap-1.5 px-2 pt-1 pb-0"
        style={{ gridTemplateColumns: 'auto minmax(0, 1fr) auto' }}
      >
        {/* The project's OWN icon when one is set — same identity mark the
            titlebar card and the pane header badge carry, so the project looks
            like the same object everywhere. Folder stays the fallback. */}
        {project.icon ? (
          <img
            src={project.icon}
            alt=""
            draggable={false}
            className="flex-shrink-0"
            style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover' }}
          />
        ) : (
          <FolderOpen
            size={12}
            className="flex-shrink-0 text-[#888]"
          />
        )}
        <div className="min-w-0 overflow-hidden">
          <SmartPopover content={project.description || ''} isOpen={isHoveringName}>
            <span
              className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-4 text-white font-medium group-hover:text-accent transition-colors cursor-help"
              onMouseEnter={() => setIsHoveringName(true)}
              onMouseLeave={() => setIsHoveringName(false)}
            >
              {project.name}
            </span>
          </SmartPopover>
        </div>
        <span
          className="inline-flex flex-shrink-0 items-center gap-1 text-[10px] leading-4 text-[#d6d6d6]"
          title={`${tabsStats.active} active / ${tabsStats.total} total tabs`}
        >
          <span className="text-[8px] leading-4 text-[#d6d6d6]">•</span>
          <span>
            {tabsStats.total}
          </span>
        </span>
      </div>

      {/* Path with Custom Tooltip */}
      <div className="-mt-0.5 px-2 pb-1 leading-[12px]">
        <div 
          className="relative inline-block max-w-full group/path"
          onMouseEnter={() => setPathHovered(true)}
          onMouseLeave={() => setPathHovered(false)}
        >
          <div className="text-[10px] text-[#9a9a9a] truncate group-hover/path:text-[#b0b0b0] transition-colors">
            {getShortPath(project.path)}
          </div>

          {pathHovered && !project.path.startsWith('__unset__') && (
            <div className="absolute bottom-full left-0 mb-1 z-[100] pointer-events-none">
              <div className="bg-[#1a1a1a] border border-[#333] px-1.5 py-0.5 rounded shadow-2xl whitespace-nowrap">
                <span className="text-[10px] text-[#ccc]">{project.path}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

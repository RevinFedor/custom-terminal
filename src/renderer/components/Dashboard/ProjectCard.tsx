import React, { useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { FolderOpen, Settings } from 'lucide-react';

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
  const [pathHovered, setPathHovered] = useState(false);

  const { openEditModal } = useUIStore();
  const { openProjects } = useWorkspaceStore();

  const hasActiveProcesses = tabsStats.active > 0;

  const getShortPath = (fullPath: string) => {
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length <= 2) return fullPath;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    openEditModal(project);
  };

  return (
    <div
      className={`
        group relative cursor-pointer rounded-lg transition-all duration-150
        ${isOpen
          ? 'bg-purple-500/5 border border-white/5 hover:bg-purple-500/10 hover:border-white/10'
          : 'bg-white/[0.03] border border-transparent hover:bg-white/[0.05] hover:border-[#333]'
        }
      `}
      onClick={onOpen}
      onMouseLeave={() => setPathHovered(false)}
    >
      {/* Project Name */}
      <div className="flex items-center gap-2 px-2.5 pt-2 pb-0">
        <FolderOpen
          size={13}
          className={`flex-shrink-0 ${hasActiveProcesses ? 'text-green-400' : 'text-[#888]'}`}
        />
        <span
          className="text-[13px] text-white font-medium truncate group-hover:text-accent transition-colors"
        >
          {project.name}
        </span>
      </div>

      {/* Path with Custom Tooltip */}
      <div className="px-2.5 leading-tight">
        <div 
          className="relative inline-block max-w-full group/path"
          onMouseEnter={() => setPathHovered(true)}
          onMouseLeave={() => setPathHovered(false)}
        >
          <div className="text-[10px] text-[#555] truncate group-hover/path:text-[#888] transition-colors">
            {getShortPath(project.path)}
          </div>

          {pathHovered && (
            <div className="absolute bottom-full left-0 mb-1 z-[100] pointer-events-none">
              <div className="bg-[#1a1a1a] border border-[#333] px-1.5 py-0.5 rounded shadow-2xl whitespace-nowrap">
                <span className="text-[10px] text-[#ccc]">{project.path}</span>
              </div>
            </div>
          )}
        </div>
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

      {/* Settings Button - Bottom Right */}
      <button
        className="absolute bottom-1.5 right-1.5 p-1 text-[#555] hover:text-white hover:bg-white/10 rounded opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
        onClick={handleEdit}
      >
        <Settings size={12} />
      </button>
    </div>
  );
}

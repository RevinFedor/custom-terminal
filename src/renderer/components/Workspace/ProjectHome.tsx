import React from 'react';
import { useWorkspaceStore, TabColor } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { Terminal, FolderOpen, Plus } from 'lucide-react';

interface ProjectHomeProps {
  projectId: string;
}

// Color configs matching TabBar
const TAB_COLORS: Record<TabColor, { bgColor: string; borderColor: string }> = {
  default: { bgColor: 'rgba(255,255,255,0.05)', borderColor: '#666' },
  red: { bgColor: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgb(239, 68, 68)' },
  yellow: { bgColor: 'rgba(234, 179, 8, 0.2)', borderColor: 'rgb(234, 179, 8)' },
  green: { bgColor: 'rgba(34, 197, 94, 0.2)', borderColor: 'rgb(34, 197, 94)' },
  blue: { bgColor: 'rgba(59, 130, 246, 0.2)', borderColor: 'rgb(59, 130, 246)' },
  purple: { bgColor: 'rgba(168, 85, 247, 0.2)', borderColor: 'rgb(168, 85, 247)' },
  claude: { bgColor: 'rgba(218, 119, 86, 0.2)', borderColor: '#DA7756' },
  gemini: { bgColor: 'rgba(78, 134, 248, 0.2)', borderColor: '#4E86F8' },
};

export default function ProjectHome({ projectId }: ProjectHomeProps) {
  const { openProjects, switchTab, createTab } = useWorkspaceStore();
  const { projects } = useProjectsStore();
  const { setCurrentView } = useUIStore();

  const workspace = openProjects.get(projectId);
  const project = projects[projectId];

  const handleCreateTab = async () => {
    if (project) {
      await createTab(projectId, undefined, project.path);
      setCurrentView('terminal');
    }
  };

  if (!workspace || !project) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
        Project not found
      </div>
    );
  }

  const tabs = Array.from(workspace.tabs.values());

  const handleTabClick = (tabId: string) => {
    switchTab(projectId, tabId);
    setCurrentView('terminal');
  };

  // Get folder name from path
  const getFolderName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  return (
    <div className="flex-1 bg-bg-main p-6 overflow-y-auto">
      {/* Project Header */}
      <div className="mb-6">
        <h1 className="text-xl text-white font-medium mb-1">{project.name}</h1>
        <div className="flex items-center gap-2 text-[#666] text-sm">
          <FolderOpen size={14} />
          <span>{project.path}</span>
        </div>
      </div>

      {/* Tabs Grid */}
      <div className="mb-4 overflow-hidden">
        <h2 className="text-sm text-[#888] mb-3">Active Tabs ({tabs.length})</h2>
        <div className="flex flex-wrap gap-3 w-full">
          {tabs.map((tab) => {
            const colorConfig = TAB_COLORS[tab.color || 'default'];
            const isActive = workspace.activeTabId === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab.id)}
                className="group cursor-pointer transition-all duration-150"
                style={{
                  maxWidth: '150px',
                  maxHeight: '50px',
                  minWidth: '100px',
                  padding: '8px 12px',
                  backgroundColor: colorConfig.bgColor,
                  border: `1px solid ${isActive ? colorConfig.borderColor : 'transparent'}`,
                  borderRadius: '6px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '2px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = colorConfig.borderColor;
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.borderColor = 'transparent';
                  }
                }}
              >
                {/* Tab Name */}
                <div className="flex items-center gap-2 w-full">
                  <Terminal size={12} className="text-[#888] flex-shrink-0" />
                  <span
                    className="text-sm text-white truncate"
                    style={{ maxWidth: '110px' }}
                    title={tab.name}
                  >
                    {tab.name}
                  </span>
                </div>

                {/* CWD */}
                <span
                  className="text-[10px] text-[#666] truncate w-full"
                  title={tab.cwd}
                >
                  {getFolderName(tab.cwd)}
                </span>
              </button>
            );
          })}

          {/* New Tab Button */}
          <button
            onClick={handleCreateTab}
            className="cursor-pointer transition-all duration-150 hover:border-[#666]"
            style={{
              maxWidth: '150px',
              maxHeight: '50px',
              minWidth: '100px',
              padding: '8px 12px',
              backgroundColor: 'transparent',
              border: '1px dashed #444',
              borderRadius: '6px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
            }}
          >
            <Plus size={16} className="text-[#666]" />
            <span className="text-[11px] text-[#666]">New Tab</span>
          </button>
        </div>
      </div>
    </div>
  );
}

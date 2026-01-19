import React, { useState, useEffect } from 'react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import ProjectCard from './ProjectCard';
import SettingsPanel from './SettingsPanel';

const { ipcRenderer } = window.require('electron');

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<'projects' | 'settings'>('projects');
  const { projects, loadProjects } = useProjectsStore();
  const { openProject, openProjects } = useWorkspaceStore();

  useEffect(() => {
    loadProjects();
  }, []);

  const handleOpenProject = async () => {
    const result = await ipcRenderer.invoke('project:select-directory');
    if (result) {
      await loadProjects();
    }
  };

  const handleOpenProjectWorkspace = (projectId: string) => {
    openProject(projectId, projects[projectId].path);
  };

  // Filter out system directories
  const excludedNames = ['Fedor', 'Desktop', 'Documents', 'Downloads', 'Applications'];
  const projectsList = Object.values(projects).filter(proj => {
    if (!proj.name || proj.name.trim() === '') return false;
    if (excludedNames.includes(proj.name)) return false;

    const isSystemDir = proj.path === '/' ||
      proj.path === '/Users/fedor' ||
      proj.path === '/Users' ||
      proj.path === '/Users/fedor/Desktop';
    if (isSystemDir) return false;

    return true;
  });

  // Get active tabs count for each project
  const getActiveTabsCount = (projectId: string) => {
    const projectData = openProjects.get(projectId);
    return projectData ? projectData.tabs.size : 0;
  };

  return (
    <div className="flex-1 flex flex-col bg-bg-main overflow-hidden">
      {/* Header with tabs */}
      <div className="dash-global-header flex justify-center py-2 border-b border-border-main bg-panel">
        <div className="dash-nav-tabs relative flex bg-[#111] rounded-full p-1 w-[280px]">
          <div
            className="absolute top-1 bottom-1 bg-accent rounded-full transition-all duration-300 z-0"
            style={{
              left: activeTab === 'projects' ? '4px' : '50%',
              right: activeTab === 'projects' ? '50%' : '4px'
            }}
          />

          <button
            className={`flex-1 relative z-10 bg-transparent border-none py-1 px-4 text-[13px] cursor-pointer rounded-full font-medium ${
              activeTab === 'projects' ? 'text-white' : 'text-[#888] hover:text-[#ccc]'
            }`}
            onClick={() => setActiveTab('projects')}
          >
            Projects
          </button>
          <button
            className={`flex-1 relative z-10 bg-transparent border-none py-1 px-4 text-[13px] cursor-pointer rounded-full font-medium ${
              activeTab === 'settings' ? 'text-white' : 'text-[#888] hover:text-[#ccc]'
            }`}
            onClick={() => setActiveTab('settings')}
          >
            Settings
          </button>
        </div>
      </div>

      {/* Content */}
      {activeTab === 'projects' && (
        <div className="flex-1 overflow-hidden">
          <div className="dashboard-container w-full h-full p-10 overflow-y-auto">
            <div className="max-w-[1400px] mx-auto">
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-2xl font-bold">Your Projects</h2>
                <button
                  onClick={handleOpenProject}
                  className="bg-accent hover:bg-accent/80 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  + Open Project
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {projectsList.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    onOpen={() => handleOpenProjectWorkspace(project.id)}
                    activeTabsCount={getActiveTabsCount(project.id)}
                  />
                ))}

                {/* Add New Project Card */}
                <div
                  className="bg-transparent border-2 border-dashed border-[#555] p-6 rounded-xl cursor-pointer transition-all opacity-70 hover:opacity-100 hover:border-accent flex items-center justify-center min-h-[200px]"
                  onClick={handleOpenProject}
                >
                  <span className="text-xl">+ New Project</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'settings' && <SettingsPanel />}
    </div>
  );
}

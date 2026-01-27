import React, { useState, useEffect, useCallback } from 'react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import ProjectCard from './ProjectCard';

const { ipcRenderer } = window.require('electron');

// Polling interval for process status
const PROCESS_STATUS_POLL_INTERVAL = 2000;

export default function Dashboard() {
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  const { projects, loadProjects } = useProjectsStore();
  const { openProject, openProjects } = useWorkspaceStore();

  useEffect(() => {
    loadProjects();
  }, []);

  // Poll for running processes in all open project tabs
  const checkProcessStatus = useCallback(async () => {
    const newStatus = new Map<string, boolean>();

    for (const [, workspace] of openProjects) {
      const tabIds = Array.from(workspace.tabs.keys());
      await Promise.all(
        tabIds.map(async (tabId) => {
          try {
            const result = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);
            newStatus.set(tabId, result.hasProcess);
          } catch {
            newStatus.set(tabId, false);
          }
        })
      );
    }

    setProcessStatus(newStatus);
  }, [openProjects]);

  // Polling effect
  useEffect(() => {
    checkProcessStatus();
    const interval = setInterval(checkProcessStatus, PROCESS_STATUS_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkProcessStatus]);

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

  // Get tabs stats for each project: total tabs and active processes
  const getTabsStats = (projectId: string) => {
    const projectData = openProjects.get(projectId);
    if (!projectData) return { total: 0, active: 0 };

    const total = projectData.tabs.size;
    let active = 0;

    for (const tabId of projectData.tabs.keys()) {
      if (processStatus.get(tabId)) {
        active++;
      }
    }

    return { total, active };
  };

  return (
    <div className="flex-1 flex flex-col bg-bg-main overflow-hidden">
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
                  tabsStats={getTabsStats(project.id)}
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
    </div>
  );
}

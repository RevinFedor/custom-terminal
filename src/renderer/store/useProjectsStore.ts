import { create } from 'zustand';

const { ipcRenderer } = window.require('electron');

interface Project {
  id: string;
  path: string;
  name: string;
  description?: string;
  notes?: string;
  quickActions?: any[];
  tabs?: any[];
}

interface ProjectsStore {
  projects: Record<string, Project>;
  selectedProject: Project | null;

  loadProjects: () => Promise<void>;
  selectProject: (project: Project | null) => void;
  openProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<Project>) => Promise<void>;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: {},
  selectedProject: null,

  loadProjects: async () => {
    const projectsList = await ipcRenderer.invoke('project:list');
    const projectsMap: Record<string, Project> = {};
    projectsList.forEach((proj: Project) => {
      projectsMap[proj.id] = proj;
    });
    set({ projects: projectsMap });
  },

  selectProject: (project) => {
    set({ selectedProject: project });
  },

  openProject: (projectId) => {
    const { projects } = get();
    const project = projects[projectId];
    if (project) {
      // Trigger workspace view
      const event = new CustomEvent('openProject', { detail: project });
      window.dispatchEvent(event);
    }
  },

  updateProject: async (projectId, updates) => {
    const { projects } = get();
    const project = projects[projectId];
    if (project) {
      const updated = { ...project, ...updates };
      set({ projects: { ...projects, [projectId]: updated } });

      // Persist to backend
      if (updates.name || updates.description) {
        await ipcRenderer.invoke('project:save-metadata', {
          dirPath: project.path,
          metadata: { name: updates.name, description: updates.description }
        });
      }
    }
  }
}));

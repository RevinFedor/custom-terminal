import { create } from 'zustand';
import { isInboxProjectId } from '../constants/systemProjects';

const { ipcRenderer } = window.require('electron');

interface Project {
  id: string;
  path: string;
  name: string;
  description?: string;
  icon?: string | null;
  /** Показывать в шапке только значок, без подписи; без raster используется цветная папка. */
  hideName?: boolean;
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
    if (isInboxProjectId(projectId)) return;
    const { projects } = get();
    const project = projects[projectId];
    if (project) {
      const updated = { ...project, ...updates };
      set({ projects: { ...projects, [projectId]: updated } });

      // Persist to backend
      if (
        updates.name !== undefined ||
        updates.description !== undefined ||
        updates.path !== undefined ||
        updates.icon !== undefined ||
        updates.hideName !== undefined
      ) {
        await ipcRenderer.invoke('project:save-metadata', {
          projectId: project.id,
          metadata: {
            name: updates.name,
            description: updates.description,
            path: updates.path,
            icon: updates.icon,
            hideName: updates.hideName,
          }
        });
      }
    }
  }
}));

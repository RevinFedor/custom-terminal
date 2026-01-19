import { create } from 'zustand';

const { ipcRenderer } = window.require('electron');

interface Tab {
  id: string;
  name: string;
  cwd: string;
  pid?: number;
}

interface ProjectWorkspace {
  projectId: string;
  projectPath: string;
  tabs: Map<string, Tab>;
  activeTabId: string | null;
  tabCounter: number;
}

interface SessionState {
  openProjects: { projectId: string; projectPath: string; activeTabIndex: number }[];
  activeProjectId: string | null;
}

interface WorkspaceStore {
  view: 'dashboard' | 'workspace';
  activeProjectId: string | null;
  openProjects: Map<string, ProjectWorkspace>;
  isRestoring: boolean;

  // Session
  restoreSession: () => Promise<void>;
  saveSession: () => void;

  // View control
  showDashboard: () => Promise<void>;
  showWorkspace: (projectId: string) => void;

  // Project management
  openProject: (projectId: string, projectPath: string) => void;
  closeProject: (projectId: string) => Promise<void>;

  // Tab management
  createTab: (projectId: string, name?: string, cwd?: string) => Promise<string>;
  closeTab: (projectId: string, tabId: string) => void;
  switchTab: (projectId: string, tabId: string) => void;
  renameTab: (projectId: string, tabId: string, newName: string) => void;

  // Reorder tabs
  reorderTabs: (projectId: string, oldIndex: number, newIndex: number) => void;

  // Update tab cwd
  updateTabCwd: (projectId: string, tabId: string, newCwd: string) => void;
  syncAllTabsCwd: (projectId: string) => Promise<void>;

  // Helpers
  getActiveTab: (projectId: string) => Tab | null;
  getActiveProject: () => ProjectWorkspace | null;
}

const SESSION_KEY = 'terminal-session-state';

// Helper to save tabs to database
const saveTabs = async (projectPath: string, tabs: Map<string, Tab>) => {
  const tabsArray = Array.from(tabs.values()).map((tab) => ({
    name: tab.name,
    cwd: tab.cwd
  }));
  console.log('[Workspace] Saving tabs to DB:', tabsArray);
  await ipcRenderer.invoke('project:save-tabs', { dirPath: projectPath, tabs: tabsArray });
};

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  view: 'dashboard',
  activeProjectId: null,
  openProjects: new Map(),
  isRestoring: false,

  saveSession: () => {
    const { openProjects, activeProjectId, isRestoring } = get();
    if (isRestoring) return; // Don't save while restoring

    const sessionState: SessionState = {
      openProjects: Array.from(openProjects.values()).map((workspace) => {
        const tabsArray = Array.from(workspace.tabs.keys());
        const activeTabIndex = workspace.activeTabId
          ? tabsArray.indexOf(workspace.activeTabId)
          : 0;
        return {
          projectId: workspace.projectId,
          projectPath: workspace.projectPath,
          activeTabIndex: Math.max(0, activeTabIndex)
        };
      }),
      activeProjectId
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionState));
  },

  restoreSession: async () => {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return;

    try {
      const sessionState: SessionState = JSON.parse(stored);
      const { openProject } = get();

      set({ isRestoring: true });

      // Restore all open projects
      for (const proj of sessionState.openProjects) {
        await openProject(proj.projectId, proj.projectPath);

        // Set active tab by index
        const workspace = get().openProjects.get(proj.projectId);
        if (workspace && proj.activeTabIndex >= 0) {
          const tabsArray = Array.from(workspace.tabs.keys());
          if (tabsArray[proj.activeTabIndex]) {
            workspace.activeTabId = tabsArray[proj.activeTabIndex];
          }
        }
      }

      // Set active project
      if (sessionState.activeProjectId && get().openProjects.has(sessionState.activeProjectId)) {
        set({
          activeProjectId: sessionState.activeProjectId,
          view: 'workspace',
          isRestoring: false
        });
      } else {
        set({ isRestoring: false });
      }
    } catch (e) {
      console.error('[Session] Failed to restore:', e);
      set({ isRestoring: false });
    }
  },

  showDashboard: async () => {
    console.log('[Workspace] showDashboard called');
    console.log('[Workspace] Current state:', { view: get().view, activeProjectId: get().activeProjectId });

    // Sync cwd for active project before leaving
    const { activeProjectId, syncAllTabsCwd } = get();
    if (activeProjectId) {
      await syncAllTabsCwd(activeProjectId);
    }

    set({ view: 'dashboard', activeProjectId: null });
    console.log('[Workspace] New state:', { view: get().view, activeProjectId: get().activeProjectId });
    get().saveSession();
  },

  showWorkspace: (projectId) => {
    set({ view: 'workspace', activeProjectId: projectId });
    get().saveSession();
  },

  openProject: async (projectId, projectPath) => {
    const { openProjects, createTab, saveSession } = get();

    if (!openProjects.has(projectId)) {
      // Load saved tabs from database
      console.log('[Workspace] ========== OPENING PROJECT ==========');
      console.log('[Workspace] Project:', projectId);
      console.log('[Workspace] Path:', projectPath);

      const projectData = await ipcRenderer.invoke('project:get', projectPath);
      const savedTabs = projectData?.tabs || [];

      console.log('[Workspace] Loaded from DB - savedTabs:', savedTabs);

      const newWorkspace: ProjectWorkspace = {
        projectId,
        projectPath,
        tabs: new Map(),
        activeTabId: null,
        tabCounter: savedTabs.length
      };
      openProjects.set(projectId, newWorkspace);
      set({ openProjects: new Map(openProjects), activeProjectId: projectId, view: 'workspace' });

      // Restore saved tabs or create default one
      if (savedTabs.length > 0) {
        for (const savedTab of savedTabs) {
          console.log('[Workspace] Restoring tab:', savedTab.name, 'with cwd:', savedTab.cwd);
          await createTab(projectId, savedTab.name, savedTab.cwd);
        }
      } else {
        // Create default tab
        console.log('[Workspace] No saved tabs, creating default');
        await createTab(projectId, 'Terminal 1', projectPath);
      }
      console.log('[Workspace] ========== PROJECT OPENED ==========');

      saveSession();
    } else {
      set({ activeProjectId: projectId, view: 'workspace' });
      saveSession();
    }
  },

  closeProject: async (projectId) => {
    const { openProjects, activeProjectId, saveSession, syncAllTabsCwd } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      // Sync cwd for all tabs before closing
      await syncAllTabsCwd(projectId);

      // Save tabs before closing
      saveTabs(workspace.projectPath, workspace.tabs);

      // Kill all terminals
      workspace.tabs.forEach((tab) => {
        ipcRenderer.send('terminal:kill', tab.id);
      });

      openProjects.delete(projectId);
      set({
        openProjects: new Map(openProjects),
        activeProjectId: activeProjectId === projectId ? null : activeProjectId,
        view: activeProjectId === projectId ? 'dashboard' : 'workspace'
      });

      saveSession();
    }
  },

  createTab: async (projectId, name, cwd) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return '';

    const tabId = `${projectId}-tab-${workspace.tabCounter}`;
    workspace.tabCounter++;

    const newTab: Tab = {
      id: tabId,
      name: name || `Tab ${workspace.tabCounter}`,
      cwd: cwd || workspace.projectPath || process.env.HOME || '~'
    };

    // Create terminal
    const { pid } = await ipcRenderer.invoke('terminal:create', {
      tabId,
      cwd: newTab.cwd,
      rows: 24,
      cols: 80
    });

    newTab.pid = pid;
    workspace.tabs.set(tabId, newTab);
    workspace.activeTabId = tabId;

    set({ openProjects: new Map(openProjects) });

    // Save tabs
    saveTabs(workspace.projectPath, workspace.tabs);

    return tabId;
  },

  closeTab: (projectId, tabId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return;

    ipcRenderer.send('terminal:kill', tabId);
    workspace.tabs.delete(tabId);

    if (workspace.activeTabId === tabId) {
      const remainingTabs = Array.from(workspace.tabs.keys());
      workspace.activeTabId = remainingTabs.length > 0 ? remainingTabs[0] : null;
    }

    set({ openProjects: new Map(openProjects) });

    // Save tabs
    saveTabs(workspace.projectPath, workspace.tabs);
  },

  switchTab: (projectId, tabId) => {
    const { openProjects, saveSession } = get();
    const workspace = openProjects.get(projectId);

    if (workspace && workspace.tabs.has(tabId)) {
      workspace.activeTabId = tabId;
      set({ openProjects: new Map(openProjects) });
      saveSession();
    }
  },

  renameTab: (projectId, tabId, newName) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.name = newName;
        set({ openProjects: new Map(openProjects) });

        // Save tabs
        saveTabs(workspace.projectPath, workspace.tabs);
      }
    }
  },

  reorderTabs: (projectId, oldIndex, newIndex) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return;

    // Convert Map to array, reorder, then back to Map
    const tabsArray = Array.from(workspace.tabs.entries());
    const [movedTab] = tabsArray.splice(oldIndex, 1);
    tabsArray.splice(newIndex, 0, movedTab);

    // Rebuild Map with new order
    workspace.tabs = new Map(tabsArray);
    set({ openProjects: new Map(openProjects) });

    // Save tabs
    saveTabs(workspace.projectPath, workspace.tabs);
  },

  updateTabCwd: (projectId, tabId, newCwd) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      const tab = workspace.tabs.get(tabId);
      if (tab && tab.cwd !== newCwd) {
        console.log('[Workspace] Updating tab cwd:', tabId, newCwd);
        tab.cwd = newCwd;
        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectPath, workspace.tabs);
      }
    }
  },

  syncAllTabsCwd: async (projectId) => {
    const { openProjects, updateTabCwd } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) {
      console.log('[Workspace] syncAllTabsCwd: workspace not found for', projectId);
      return;
    }

    console.log('[Workspace] ========== SYNC CWD ==========');
    console.log('[Workspace] Project:', projectId);
    console.log('[Workspace] Tabs count:', workspace.tabs.size);

    for (const [tabId, tab] of workspace.tabs) {
      console.log('[Workspace] Checking tab:', tabId, 'current cwd:', tab.cwd);
      try {
        const currentCwd = await ipcRenderer.invoke('terminal:getCwd', tabId);
        console.log('[Workspace] Got cwd from PTY:', currentCwd);
        if (currentCwd && currentCwd !== tab.cwd) {
          console.log('[Workspace] ✅ Updating cwd:', tab.cwd, '->', currentCwd);
          updateTabCwd(projectId, tabId, currentCwd);
        } else {
          console.log('[Workspace] No change needed');
        }
      } catch (e) {
        console.error('[Workspace] ❌ Failed to get cwd for tab:', tabId, e);
      }
    }
    console.log('[Workspace] ========== SYNC DONE ==========');
  },

  getActiveTab: (projectId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace || !workspace.activeTabId) return null;
    return workspace.tabs.get(workspace.activeTabId) || null;
  },

  getActiveProject: () => {
    const { openProjects, activeProjectId } = get();
    if (!activeProjectId) return null;
    return openProjects.get(activeProjectId) || null;
  }
}));

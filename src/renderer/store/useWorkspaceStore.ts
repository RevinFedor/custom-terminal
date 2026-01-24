import { create } from 'zustand';
import { startTransition } from 'react';
import { log } from '../utils/logger';

const { ipcRenderer } = window.require('electron');

export type TabColor = 'default' | 'red' | 'yellow' | 'green' | 'blue' | 'purple' | 'claude' | 'gemini';

export type CommandType = 'generic' | 'devServer' | 'claude' | 'gemini';

// Typed pending action - executed after terminal is ready
export interface PendingAction {
  type: 'claude-fork' | 'claude-continue' | 'shell-command';
  sessionId?: string;    // For claude-fork, claude-continue
  command?: string;      // For shell-command
}

interface Tab {
  id: string;
  name: string;
  cwd: string;
  pid?: number;
  color?: TabColor;
  colorSetManually?: boolean; // True if user changed color manually - prevents auto-color override
  commandType?: CommandType; // Type of running command (for restart button visibility)
  isUtility?: boolean;
  claudeSessionId?: string; // Active Claude Code session UUID (detected from terminal output)
  pendingAction?: PendingAction; // Action to execute when terminal is ready
  wasInterrupted?: boolean; // True if tab was closed with active Claude session (show resume overlay)
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
  view: 'dashboard' | 'workspace';
}

interface WorkspaceStore {
  view: 'dashboard' | 'workspace';
  activeProjectId: string | null;
  openProjects: Map<string, ProjectWorkspace>;
  isRestoring: boolean;

  // Terminal buffer serialization (for preserving history on unmount/remount)
  terminalBuffers: Map<string, string>;
  saveTerminalBuffer: (tabId: string, buffer: string) => void;
  getTerminalBuffer: (tabId: string) => string | null;
  clearTerminalBuffer: (tabId: string) => void;

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
  createTab: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; isUtility?: boolean; pendingAction?: PendingAction; claudeSessionId?: string; wasInterrupted?: boolean }) => Promise<string>;
  createTabAfterCurrent: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; isUtility?: boolean; pendingAction?: PendingAction; claudeSessionId?: string; wasInterrupted?: boolean }) => Promise<string>;
  closeTab: (projectId: string, tabId: string) => Promise<void>;
  switchTab: (projectId: string, tabId: string) => void;
  renameTab: (projectId: string, tabId: string, newName: string) => void;

  // Reorder tabs
  reorderTabs: (projectId: string, oldIndex: number, newIndex: number) => void;

  // Tab color and utility
  setTabColor: (projectId: string, tabId: string, color: TabColor, manual?: boolean) => void;
  setTabCommandType: (tabId: string, commandType: CommandType) => void; // Also sets auto-color on first run
  toggleTabUtility: (projectId: string, tabId: string) => void;

  // Advanced drag & drop
  reorderInZone: (projectId: string, zone: 'main' | 'utility', orderedIds: string[]) => void;
  moveTabToZone: (projectId: string, tabId: string, toUtility: boolean, atIndex: number) => void;

  // Update tab cwd
  updateTabCwd: (projectId: string, tabId: string, newCwd: string) => void;
  syncAllTabsCwd: (projectId: string) => Promise<void>;

  // Claude session tracking
  setClaudeSessionId: (tabId: string, sessionId: string) => void;
  clearClaudeSession: (tabId: string) => void; // Clear both claudeSessionId and wasInterrupted
  getClaudeSessionId: (tabId: string) => string | null;

  // Interrupted session handling
  clearInterruptedState: (tabId: string) => void;
  dismissInterruptedSession: (tabId: string) => void;
  markAllSessionsInterrupted: () => void;

  // Immediate save (for shutdown)
  saveSessionImmediate: () => void;

  // Helpers
  getActiveTab: (projectId: string) => Tab | null;
  getActiveProject: () => ProjectWorkspace | null;
}

const SESSION_KEY = 'workspace-session';

/**
 * Find the next available name for a tab based on existing tabs.
 * - First of type: "tab-1", "run-dev", "claude", "gemini"
 * - Subsequent: "tab-2", "run-dev-02", "claude-02", etc. (finds first free number)
 */
const getNextAvailableName = (baseName: string, existingNames: string[]): string => {
  // For generic tabs: tab-1, tab-2, etc.
  if (baseName === 'tab') {
    let num = 1;
    while (existingNames.includes(`tab-${num}`)) {
      num++;
    }
    return `tab-${num}`;
  }

  // For commands (run-dev, claude, gemini): first without number, then -02, -03, etc.
  if (!existingNames.includes(baseName)) {
    return baseName;
  }

  // Find first available number starting from 02
  let num = 2;
  while (existingNames.includes(`${baseName}-${num.toString().padStart(2, '0')}`)) {
    num++;
  }
  return `${baseName}-${num.toString().padStart(2, '0')}`;
};

// Debounce timers (outside store to persist across calls)
let saveSessionTimer: NodeJS.Timeout | null = null;
let saveTabsTimers: Map<string, NodeJS.Timeout> = new Map();

// Helper to save tabs to database (debounced)
const saveTabs = (projectPath: string, tabs: Map<string, Tab>, immediate = false) => {
  // Clear existing timer for this project
  const existingTimer = saveTabsTimers.get(projectPath);
  if (existingTimer) clearTimeout(existingTimer);

  const doSave = async () => {
    const tabsArray = Array.from(tabs.values()).map((tab) => ({
      name: tab.name,
      cwd: tab.cwd,
      color: tab.color,
      isUtility: tab.isUtility,
      claudeSessionId: tab.claudeSessionId, // Persist Claude session ID
      wasInterrupted: tab.wasInterrupted // Persist interrupted state
    }));
    await ipcRenderer.invoke('project:save-tabs', { dirPath: projectPath, tabs: tabsArray });
    saveTabsTimers.delete(projectPath);
  };

  if (immediate) {
    // Save immediately (for shutdown scenarios)
    doSave();
  } else {
    // Debounce: save after 500ms of inactivity
    const timer = setTimeout(doSave, 500);
    saveTabsTimers.set(projectPath, timer);
  }
};

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  view: 'dashboard',
  activeProjectId: null,
  openProjects: new Map(),
  isRestoring: false,

  // Terminal buffer serialization
  terminalBuffers: new Map(),
  saveTerminalBuffer: (tabId, buffer) => {
    const { terminalBuffers } = get();
    terminalBuffers.set(tabId, buffer);
    // No need to trigger re-render - this is just storage
  },
  getTerminalBuffer: (tabId) => {
    return get().terminalBuffers.get(tabId) || null;
  },
  clearTerminalBuffer: (tabId) => {
    const { terminalBuffers } = get();
    terminalBuffers.delete(tabId);
  },

  saveSession: () => {
    const { openProjects, activeProjectId, view, isRestoring } = get();
    if (isRestoring) return; // Don't save while restoring

    // Debounce: save after 300ms of inactivity
    if (saveSessionTimer) clearTimeout(saveSessionTimer);

    saveSessionTimer = setTimeout(async () => {
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
        activeProjectId,
        view
      };

      // Save to database
      await ipcRenderer.invoke('app:setState', { key: SESSION_KEY, value: sessionState });
      saveSessionTimer = null;
    }, 300);
  },

  restoreSession: async () => {
    // Load from database
    const sessionState = await ipcRenderer.invoke('app:getState', SESSION_KEY) as SessionState | null;
    if (!sessionState) {
      return;
    }

    try {
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

      // Set active project and view
      const savedView = sessionState.view || 'dashboard';
      if (savedView === 'workspace' && sessionState.activeProjectId && get().openProjects.has(sessionState.activeProjectId)) {
        set({
          activeProjectId: sessionState.activeProjectId,
          view: 'workspace',
          isRestoring: false
        });
      } else {
        // Stay on dashboard or fallback
        set({
          view: 'dashboard',
          activeProjectId: null,
          isRestoring: false
        });
      }
    } catch (e) {
      console.error('[Session] Failed to restore:', e);
      set({ isRestoring: false });
    }
  },

  showDashboard: async () => {

    // Sync cwd for active project before leaving
    const { activeProjectId, syncAllTabsCwd } = get();
    if (activeProjectId) {
      await syncAllTabsCwd(activeProjectId);
    }

    set({ view: 'dashboard', activeProjectId: null });
    get().saveSession();
  },

  showWorkspace: (projectId) => {
    // Use startTransition for smooth project switching
    startTransition(() => {
      set({ view: 'workspace', activeProjectId: projectId });
    });
    get().saveSession();
  },

  openProject: async (projectId, projectPath) => {
    const { openProjects, createTab, saveSession } = get();

    if (!openProjects.has(projectId)) {
      // Load saved tabs from database

      const projectData = await ipcRenderer.invoke('project:get', projectPath);
      const savedTabs = projectData?.tabs || [];


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
          console.log('[Store] Restoring tab with claudeSessionId:', savedTab.claudeSessionId, 'wasInterrupted:', savedTab.wasInterrupted);
          await createTab(projectId, savedTab.name, savedTab.cwd, {
            color: savedTab.color,
            isUtility: savedTab.isUtility,
            claudeSessionId: savedTab.claudeSessionId, // Restore Claude session ID
            wasInterrupted: savedTab.wasInterrupted // Restore interrupted state
          });
        }
      } else {
        // Create default tab
        await createTab(projectId, 'Terminal 1', projectPath);
      }

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

      // Save tabs before closing (manual close = NOT interrupted)
      saveTabs(workspace.projectPath, workspace.tabs, true);

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

  createTab: async (projectId, name, cwd, options) => {
    log.tabs('createTab called:', { projectId, name, cwd, options });
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) {
      log.tabs('createTab: No workspace for projectId:', projectId);
      return '';
    }

    const tabId = `${projectId}-tab-${workspace.tabCounter}`;
    log.tabs('createTab: Generated tabId:', tabId, 'counter:', workspace.tabCounter);
    workspace.tabCounter++;

    // Smart naming: find next available name if not provided
    const existingNames = Array.from(workspace.tabs.values()).map(t => t.name);
    const tabName = name || getNextAvailableName('tab', existingNames);
    log.tabs('createTab: Using name:', tabName);

    const newTab: Tab = {
      id: tabId,
      name: tabName,
      cwd: cwd || workspace.projectPath || process.env.HOME || '~',
      color: options?.color,
      isUtility: options?.isUtility,
      pendingAction: options?.pendingAction,
      claudeSessionId: options?.claudeSessionId,
      wasInterrupted: options?.wasInterrupted
    };

    console.log('[Store] createTab: Creating PTY terminal for:', tabId, 'cwd:', newTab.cwd);
    // Only pass initialCommand for shell-command type, not for internal commands
    const initialCommand = options?.pendingAction?.type === 'shell-command'
      ? options.pendingAction.command
      : undefined;

    const { pid } = await ipcRenderer.invoke('terminal:create', {
      tabId,
      cwd: newTab.cwd,
      rows: 24,
      cols: 80,
      initialCommand
    });

    console.log('[Store] createTab: PTY created with pid:', pid);
    newTab.pid = pid;
    workspace.tabs.set(tabId, newTab);
    workspace.activeTabId = tabId;

    console.log('[Store] createTab: Setting state, tabs count:', workspace.tabs.size);
    set({ openProjects: new Map(openProjects) });

    // Save tabs
    saveTabs(workspace.projectPath, workspace.tabs);

    console.log('[Store] createTab: Done, returning tabId:', tabId);
    return tabId;
  },

  createTabAfterCurrent: async (projectId, name, cwd, options) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) {
      return '';
    }

    const tabId = `${projectId}-tab-${workspace.tabCounter}`;
    workspace.tabCounter++;

    // Smart naming: find next available name if not provided
    const existingNames = Array.from(workspace.tabs.values()).map(t => t.name);
    const tabName = name || getNextAvailableName('tab', existingNames);

    const newTab: Tab = {
      id: tabId,
      name: tabName,
      cwd: cwd || workspace.projectPath || process.env.HOME || '~',
      color: options?.color,
      isUtility: options?.isUtility,
      pendingAction: options?.pendingAction,
      claudeSessionId: options?.claudeSessionId,
      wasInterrupted: options?.wasInterrupted
    };

    // Only pass initialCommand for shell-command type, not for internal commands
    const initialCommand = options?.pendingAction?.type === 'shell-command'
      ? options.pendingAction.command
      : undefined;

    console.log('[Store:createTabAfterCurrent] Creating terminal with:', {
      tabId,
      cwd: newTab.cwd,
      pendingAction: options?.pendingAction,
      initialCommand
    });

    const { pid } = await ipcRenderer.invoke('terminal:create', {
      tabId,
      cwd: newTab.cwd,
      rows: 24,
      cols: 80,
      initialCommand
    });

    console.log('[Store:createTabAfterCurrent] Terminal created with pid:', pid);
    newTab.pid = pid;

    // Insert after current tab (or at end if no active tab)
    const currentActiveTabId = workspace.activeTabId;
    const tabsArray = Array.from(workspace.tabs.entries());
    const isUtility = options?.isUtility || false;

    // Find position: after current tab in same zone, or at end of zone
    let insertIndex = tabsArray.length;

    if (currentActiveTabId && !isUtility) {
      // Find current active tab index
      const currentIndex = tabsArray.findIndex(([id]) => id === currentActiveTabId);
      if (currentIndex !== -1) {
        // Find the first utility tab to know where main zone ends
        const firstUtilityIndex = tabsArray.findIndex(([_, tab]) => tab.isUtility);
        if (firstUtilityIndex === -1) {
          // No utility tabs, insert right after current
          insertIndex = currentIndex + 1;
        } else if (currentIndex < firstUtilityIndex) {
          // Current is in main zone, insert after it but before utility zone
          insertIndex = Math.min(currentIndex + 1, firstUtilityIndex);
        }
      }
    } else if (currentActiveTabId && isUtility) {
      // Insert after current utility tab
      const currentIndex = tabsArray.findIndex(([id]) => id === currentActiveTabId);
      if (currentIndex !== -1 && tabsArray[currentIndex]?.[1]?.isUtility) {
        insertIndex = currentIndex + 1;
      }
    }

    // Insert tab at calculated position
    tabsArray.splice(insertIndex, 0, [tabId, newTab]);
    workspace.tabs = new Map(tabsArray);

    workspace.activeTabId = tabId;

    set({ openProjects: new Map(openProjects) });

    // Save tabs
    saveTabs(workspace.projectPath, workspace.tabs);

    return tabId;
  },

  closeTab: async (projectId, tabId) => {
    const { openProjects, clearTerminalBuffer } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return;

    const tab = workspace.tabs.get(tabId);

    // Check if terminal has running process
    const { hasProcess, processName } = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);

    if (hasProcess) {
      const confirmed = window.confirm(
        `Terminal has a running process: "${processName}"\n\nAre you sure you want to close this tab?`
      );
      if (!confirmed) return;
    }

    // Check if tab has saved Claude session
    if (tab?.claudeSessionId && !hasProcess) {
      const confirmed = window.confirm(
        `Эта вкладка содержит Claude сессию:\n${tab.claudeSessionId}\n\nПри закрытии вы потеряете привязку к этой сессии. Продолжить?`
      );
      if (!confirmed) return;
    }

    ipcRenderer.send('terminal:kill', tabId);
    workspace.tabs.delete(tabId);
    clearTerminalBuffer(tabId); // Clean up serialized buffer

    if (workspace.activeTabId === tabId) {
      // Only switch to Main tabs (not utility) - get last Main tab
      const mainTabs = Array.from(workspace.tabs.values()).filter(t => !t.isUtility);
      if (mainTabs.length > 0) {
        // Switch to last Main tab
        workspace.activeTabId = mainTabs[mainTabs.length - 1].id;
      } else {
        // No Main tabs left - set to null (show placeholder, don't auto-switch to Utils)
        workspace.activeTabId = null;
      }
    }

    // Use startTransition to prevent UI blocking
    startTransition(() => {
      set({ openProjects: new Map(openProjects) });
    });

    // Save tabs
    saveTabs(workspace.projectPath, workspace.tabs);
  },

  switchTab: (projectId, tabId) => {
    const { openProjects, saveSession } = get();
    const workspace = openProjects.get(projectId);

    if (workspace && workspace.tabs.has(tabId)) {
      workspace.activeTabId = tabId;
      // Use startTransition to prevent UI blocking during re-render
      startTransition(() => {
        set({ openProjects: new Map(openProjects) });
      });
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

  setTabColor: (projectId, tabId, color, manual = true) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.color = color;
        if (manual) {
          tab.colorSetManually = true; // User changed color - prevent auto-override
        }
        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectPath, workspace.tabs);
      }
    }
  },

  setTabCommandType: (tabId, commandType) => {
    const { openProjects } = get();
    log.tabs('setTabCommandType called: tabId=%s, commandType=%s', tabId, commandType);

    // Find tab across all projects
    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        log.tabs('Found tab, current state: name=%s, color=%s, colorSetManually=%s', tab.name, tab.color, tab.colorSetManually);

        // Only set commandType and rename if not already set (first run only)
        const isFirstRun = !tab.commandType;
        tab.commandType = commandType;

        // Auto-rename on first run
        if (isFirstRun) {
          const existingNames = Array.from(workspace.tabs.values()).map(t => t.name);
          let baseName = '';

          if (commandType === 'claude') {
            baseName = 'claude';
          } else if (commandType === 'gemini') {
            baseName = 'gemini';
          } else if (commandType === 'devServer') {
            baseName = 'run-dev';
          }

          if (baseName) {
            const newName = getNextAvailableName(baseName, existingNames);
            log.tabs('Auto-renaming tab from %s to %s', tab.name, newName);
            tab.name = newName;
          }
        }

        // Auto-color on first run (if not manually set)
        const shouldAutoColor = !tab.colorSetManually && (tab.color === 'default' || !tab.color);
        log.tabs('shouldAutoColor: %s', shouldAutoColor);

        if (shouldAutoColor) {
          if (commandType === 'claude') {
            log.tabs('Setting color to claude');
            tab.color = 'claude';
          } else if (commandType === 'gemini') {
            log.tabs('Setting color to gemini');
            tab.color = 'gemini';
          } else if (commandType === 'devServer') {
            log.tabs('Setting color to green');
            tab.color = 'green';
          }
        } else {
          log.tabs('Skipping auto-color (manually set or already colored)');
        }

        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectPath, workspace.tabs);
        break;
      }
    }
  },

  toggleTabUtility: (projectId, tabId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.isUtility = !tab.isUtility;
        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectPath, workspace.tabs);
      }
    }
  },

  reorderInZone: (projectId, zone, orderedIds) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return;

    // Get all tabs
    const allTabs = Array.from(workspace.tabs.entries());
    const isUtilityZone = zone === 'utility';

    // Separate tabs by zone
    const zoneTabs = allTabs.filter(([_, tab]) => !!tab.isUtility === isUtilityZone);
    const otherTabs = allTabs.filter(([_, tab]) => !!tab.isUtility !== isUtilityZone);

    // Reorder zone tabs according to orderedIds
    const reorderedZoneTabs = orderedIds
      .map(id => zoneTabs.find(([tabId]) => tabId === id))
      .filter(Boolean) as [string, any][];

    // Rebuild Map: utility tabs first, then main tabs (or vice versa based on preference)
    // We'll keep utility tabs at the end of the Map
    const newTabs = new Map<string, any>();

    if (isUtilityZone) {
      // Main tabs first, then reordered utility
      otherTabs.forEach(([id, tab]) => newTabs.set(id, tab));
      reorderedZoneTabs.forEach(([id, tab]) => newTabs.set(id, tab));
    } else {
      // Reordered main tabs first, then utility
      reorderedZoneTabs.forEach(([id, tab]) => newTabs.set(id, tab));
      otherTabs.forEach(([id, tab]) => newTabs.set(id, tab));
    }

    workspace.tabs = newTabs;
    set({ openProjects: new Map(openProjects) });
    saveTabs(workspace.projectPath, workspace.tabs);
  },

  moveTabToZone: (projectId, tabId, toUtility, atIndex) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return;

    const tab = workspace.tabs.get(tabId);
    if (!tab) return;

    // Change utility flag
    tab.isUtility = toUtility;

    // Get tabs of target zone (after flag change)
    const allTabs = Array.from(workspace.tabs.entries());
    const targetZoneTabs = allTabs.filter(([_, t]) => !!t.isUtility === toUtility);
    const otherZoneTabs = allTabs.filter(([_, t]) => !!t.isUtility !== toUtility);

    // Remove tab from its current position in target zone list
    const tabIndex = targetZoneTabs.findIndex(([id]) => id === tabId);
    if (tabIndex !== -1) {
      targetZoneTabs.splice(tabIndex, 1);
    }

    // Insert at new position
    const insertIndex = Math.min(atIndex, targetZoneTabs.length);
    targetZoneTabs.splice(insertIndex, 0, [tabId, tab]);

    // Rebuild Map
    const newTabs = new Map<string, any>();

    if (toUtility) {
      // Main tabs first, then utility (with moved tab)
      otherZoneTabs.forEach(([id, t]) => newTabs.set(id, t));
      targetZoneTabs.forEach(([id, t]) => newTabs.set(id, t));
    } else {
      // Main tabs (with moved tab) first, then utility
      targetZoneTabs.forEach(([id, t]) => newTabs.set(id, t));
      otherZoneTabs.forEach(([id, t]) => newTabs.set(id, t));
    }

    workspace.tabs = newTabs;
    set({ openProjects: new Map(openProjects) });
    saveTabs(workspace.projectPath, workspace.tabs);
  },

  updateTabCwd: (projectId, tabId, newCwd) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      const tab = workspace.tabs.get(tabId);
      if (tab && tab.cwd !== newCwd) {
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
      return;
    }


    for (const [tabId, tab] of workspace.tabs) {
      try {
        const currentCwd = await ipcRenderer.invoke('terminal:getCwd', tabId);
        if (currentCwd && currentCwd !== tab.cwd) {
          updateTabCwd(projectId, tabId, currentCwd);
        } else {
        }
      } catch (e) {
        console.error('[Workspace] ❌ Failed to get cwd for tab:', tabId, e);
      }
    }
  },

  // Claude session tracking (detected from terminal output)
  setClaudeSessionId: (tabId, sessionId) => {
    const { openProjects } = get();

    // Find tab across all projects
    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.claudeSessionId = sessionId;
        console.log(`[Workspace] Claude session set for tab ${tabId}: ${sessionId}`);
        // Save to database so session persists across restarts
        saveTabs(workspace.projectPath, workspace.tabs);
        // NOTE: Not calling set() here to avoid re-render that breaks terminal
        return;
      }
    }
  },

  // Clear Claude session completely (when process exits normally)
  clearClaudeSession: (tabId) => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab && (tab.claudeSessionId || tab.wasInterrupted)) {
        console.log(`[Workspace] Clearing Claude session for tab ${tabId}`);
        tab.claudeSessionId = undefined;
        tab.wasInterrupted = false;
        // Save to database
        saveTabs(workspace.projectPath, workspace.tabs);
        // Don't trigger re-render to avoid terminal issues
        return;
      }
    }
  },

  getClaudeSessionId: (tabId) => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        console.log('[Store] getClaudeSessionId for tab', tabId, ':', tab.claudeSessionId);
        return tab.claudeSessionId || null;
      }
    }
    console.log('[Store] getClaudeSessionId: tab not found', tabId);
    return null;
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
  },

  // Clear interrupted state for a tab (when user dismisses overlay or continues session)
  clearInterruptedState: (tabId) => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab && tab.wasInterrupted) {
        tab.wasInterrupted = false;
        console.log('[Store] Cleared interrupted state for tab:', tabId);
        // Save to persist the change
        saveTabs(workspace.projectPath, workspace.tabs);
        // Trigger re-render so overlay disappears
        set({ openProjects: new Map(openProjects) });
        return;
      }
    }
  },

  // Dismiss interrupted session (Clear interrupted state but KEEP session ID so it appears in lists)
  dismissInterruptedSession: (tabId) => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        console.log('[Store] Dismissing interrupted overlay for tab (keeping session):', tabId);
        // Only clear the interruption flag, keep the session ID so it's not "lost"
        tab.wasInterrupted = false;
        // Save to database
        saveTabs(workspace.projectPath, workspace.tabs);
        // Trigger re-render
        set({ openProjects: new Map(openProjects) });
        return;
      }
    }
  },

  // Mark all tabs with active Claude sessions as interrupted (called on shutdown)
  markAllSessionsInterrupted: () => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      let changed = false;
      for (const [tabId, tab] of workspace.tabs) {
        if (tab.claudeSessionId && !tab.wasInterrupted) {
          tab.wasInterrupted = true;
          changed = true;
          console.log('[Store] Marking tab as interrupted:', tabId, tab.claudeSessionId);
        }
      }
      if (changed) {
        // Save immediately (shutdown scenario)
        saveTabs(workspace.projectPath, workspace.tabs, true);
      }
    }
  },

  // Save session immediately without debounce (for shutdown)
  // Note: This uses synchronous XHR workaround for beforeunload
  saveSessionImmediate: () => {
    const { openProjects, activeProjectId, view } = get();

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
      activeProjectId,
      view
    };

    // Use sendSync for immediate save during shutdown
    ipcRenderer.sendSync('app:setStateSync', { key: SESSION_KEY, value: sessionState });
    console.log('[Store] Session saved immediately:', sessionState);
  }
}));

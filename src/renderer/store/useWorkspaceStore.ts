import { create } from 'zustand';
import { startTransition } from 'react';
import { log } from '../utils/logger';

const { ipcRenderer } = window.require('electron');

export type TabColor = 'default' | 'red' | 'yellow' | 'green' | 'blue' | 'purple' | 'claude' | 'gemini';

export type CommandType = 'generic' | 'devServer' | 'claude' | 'gemini';

export type TabType = 'terminal' | 'browser';

// Helper: Check if tab has an interrupted AI session that can be resumed
export const isTabInterrupted = (tab: { wasInterrupted?: boolean; claudeSessionId?: string; geminiSessionId?: string }): boolean => {
  return !!(tab.wasInterrupted && (tab.claudeSessionId || tab.geminiSessionId));
};

// Typed pending action - executed after terminal is ready
export interface PendingAction {
  type: 'claude-fork' | 'claude-continue' | 'claude-new' | 'gemini-fork' | 'gemini-continue' | 'gemini-new' | 'shell-command';
  sessionId?: string;    // For claude-fork, claude-continue, gemini-fork, gemini-continue
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
  tabType?: TabType; // Terminal or browser tab
  url?: string; // URL for browser tabs
  terminalId?: string; // Terminal ID for browser tabs (linked terminal)
  terminalName?: string; // Terminal name for browser tabs
  activeView?: 'browser' | 'terminal'; // Which view is active in the tab
  createdAt?: number; // Timestamp when tab was created
  claudeSessionId?: string; // Active Claude Code session UUID (detected from terminal output)
  geminiSessionId?: string; // Active Gemini CLI session ID (detected via Sniper Watcher)
  pendingAction?: PendingAction; // Action to execute when terminal is ready
  wasInterrupted?: boolean; // True if tab was closed with active AI session (show resume overlay)
  overlayDismissed?: boolean; // True if user dismissed the interrupted overlay (don't show again)
  notes?: string; // Tab-specific notes
  isCollapsed?: boolean; // Collapsed tab — icon-only, for archiving completed sessions
}

interface ProjectWorkspace {
  projectId: string;
  projectPath: string;
  tabs: Map<string, Tab>;
  activeTabId: string | null;
  selectedTabIds: string[]; // List of selected tab IDs for multi-action
  tabCounter: number;
  sidebarOpen: boolean;
  openFilePath: string | null;
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
  projectHistory: string[]; // Stack of project IDs in order of activation
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
  createTab: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; isUtility?: boolean; commandType?: CommandType; pendingAction?: PendingAction; claudeSessionId?: string; geminiSessionId?: string; wasInterrupted?: boolean; overlayDismissed?: boolean; notes?: string; tabType?: TabType; url?: string }) => Promise<string>;
  createTabAfterCurrent: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; isUtility?: boolean; commandType?: CommandType; pendingAction?: PendingAction; claudeSessionId?: string; geminiSessionId?: string; wasInterrupted?: boolean; overlayDismissed?: boolean; notes?: string; tabType?: TabType; url?: string }) => Promise<string>;
  closeTab: (projectId: string, tabId: string) => Promise<void>;
  switchTab: (projectId: string, tabId: string) => void;
  renameTab: (projectId: string, tabId: string, newName: string) => void;

  // Selection
  toggleTabSelection: (projectId: string, tabId: string, multi?: boolean) => void;
  selectTabRange: (projectId: string, tabId: string) => void;
  clearSelection: (projectId: string) => void;
  getSelectedTabs: (projectId: string) => Tab[];

  // Reorder tabs
  reorderTabs: (projectId: string, oldIndex: number, newIndex: number) => void;

  // Tab color and utility
  setTabColor: (projectId: string, tabId: string, color: TabColor, manual?: boolean) => void;
  setTabCommandType: (tabId: string, commandType: CommandType) => void; // Also sets auto-color on first run
  toggleTabUtility: (projectId: string, tabId: string) => void;
  toggleTabCollapsed: (projectId: string, tabId: string) => void;

  // Advanced drag & drop
  reorderInZone: (projectId: string, zone: 'main' | 'utility', orderedIds: string[]) => void;
  moveTabToZone: (projectId: string, tabId: string, toUtility: boolean, atIndex: number) => void;
  moveTabToProject: (sourceProjectId: string, tabId: string, targetProjectId: string) => void;
  moveTabsToProject: (sourceProjectId: string, tabIds: string[], targetProjectId: string) => void;

  // Update tab cwd
  updateTabCwd: (projectId: string, tabId: string, newCwd: string) => void;
  syncAllTabsCwd: (projectId: string) => Promise<void>;

  // Claude session tracking
  setClaudeSessionId: (tabId: string, sessionId: string) => void;
  getClaudeSessionId: (tabId: string) => string | null;

  // Gemini session tracking
  setGeminiSessionId: (tabId: string, sessionId: string) => void;
  getGeminiSessionId: (tabId: string) => string | null;

  // Tab notes
  setTabNotes: (tabId: string, notes: string) => void;
  getTabNotes: (tabId: string) => string;

  // Interrupted session handling
  clearInterruptedState: (tabId: string) => void;
  dismissInterruptedSession: (tabId: string) => void;
  markAllSessionsInterrupted: () => void;

  // Immediate save (for shutdown)
  saveSessionImmediate: () => void;

  // Reorder projects (for drag-and-drop)
  reorderProjects: (orderedProjectIds: string[]) => void;

  // Helpers
  getActiveTab: (projectId: string) => Tab | null;
  getActiveProject: () => ProjectWorkspace | null;

  // Sidebar state (per-project)
  setSidebarOpen: (projectId: string, open: boolean) => void;
  setOpenFilePath: (projectId: string, filePath: string | null) => void;
  getSidebarState: (projectId: string) => { sidebarOpen: boolean; openFilePath: string | null };
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

// Debounce timer for session saving
let saveSessionTimer: NodeJS.Timeout | null = null;

// Helper to save tabs to database (immediate, no debounce)
const saveTabs = (projectId: string, tabs: Map<string, Tab>) => {
  const tabsArray = Array.from(tabs.values()).map((tab) => ({
    name: tab.name,
    cwd: tab.cwd,
    color: tab.color,
    isUtility: tab.isUtility,
    commandType: tab.commandType, // Preserve to prevent auto-rename on resume
    claudeSessionId: tab.claudeSessionId,
    geminiSessionId: tab.geminiSessionId,
    wasInterrupted: tab.wasInterrupted,
    overlayDismissed: tab.overlayDismissed,
    notes: tab.notes,
    tabType: tab.tabType,
    url: tab.url,
    terminalId: tab.terminalId,
    terminalName: tab.terminalName,
    activeView: tab.activeView,
    createdAt: tab.createdAt,
    isCollapsed: tab.isCollapsed
  }));
  ipcRenderer.invoke('project:save-tabs', { projectId, tabs: tabsArray });
};

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  view: 'dashboard',
  activeProjectId: null,
  openProjects: new Map(),
  projectHistory: [],
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
    const { openProjects, activeProjectId, view, isRestoring, projectHistory } = get();
    if (isRestoring) return; // Don't save while restoring

    // Debounce: save after 300ms of inactivity
    if (saveSessionTimer) clearTimeout(saveSessionTimer);

    saveSessionTimer = setTimeout(async () => {
      const sessionState: SessionState & { projectHistory?: string[] } = {
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
        view,
        projectHistory
      };

      // Save to database
      await ipcRenderer.invoke('app:setState', { key: SESSION_KEY, value: sessionState });
      saveSessionTimer = null;
    }, 300);
  },

  restoreSession: async () => {
    // Load from database
    const sessionState = await ipcRenderer.invoke('app:getState', SESSION_KEY) as (SessionState & { projectHistory?: string[] }) | null;
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

      // Set active project and view (also trigger re-render with updated openProjects to reflect activeTabId changes)
      const savedView = sessionState.view || 'dashboard';
      const currentOpenProjects = get().openProjects;
      const restoredHistory = sessionState.projectHistory || [];

      if (savedView === 'workspace' && sessionState.activeProjectId && currentOpenProjects.has(sessionState.activeProjectId)) {
        set({
          activeProjectId: sessionState.activeProjectId,
          view: 'workspace',
          isRestoring: false,
          openProjects: new Map(currentOpenProjects),
          projectHistory: restoredHistory
        });
      } else {
        // Stay on dashboard or fallback
        set({
          view: 'dashboard',
          activeProjectId: null,
          isRestoring: false,
          openProjects: new Map(currentOpenProjects),
          projectHistory: restoredHistory
        });
      }
    } catch (e) {
      console.error('[Session] Failed to restore:', e);
      set({ isRestoring: false });
    }
  },

  showDashboard: async () => {
    const { activeProjectId, syncAllTabsCwd } = get();

    // Switch view IMMEDIATELY — don't block on sync
    set({ view: 'dashboard', activeProjectId: null });

    // Sync cwd in background (lsof is slow when Claude is active)
    if (activeProjectId) {
      syncAllTabsCwd(activeProjectId).then(() => {
        get().saveSession();
      });
    } else {
      get().saveSession();
    }
  },

  toggleTabSelection: (projectId, tabId, multi = false) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    let newSelected: string[];
    if (multi) {
      // Toggle individual tab in selection
      if (workspace.selectedTabIds.includes(tabId)) {
        newSelected = workspace.selectedTabIds.filter(id => id !== tabId);
      } else {
        newSelected = [...workspace.selectedTabIds, tabId];
      }
    } else {
      // Single selection: clear others and set this one
      newSelected = [tabId];
    }

    workspace.selectedTabIds = newSelected;
    set({ openProjects: new Map(openProjects) });
  },

  selectTabRange: (projectId, tabId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace || !workspace.activeTabId) return;

    const allTabIds = Array.from(workspace.tabs.keys());
    const startIndex = allTabIds.indexOf(workspace.activeTabId);
    const endIndex = allTabIds.indexOf(tabId);

    if (startIndex === -1 || endIndex === -1) return;

    const [start, end] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    const rangeIds = allTabIds.slice(start, end + 1);

    workspace.selectedTabIds = Array.from(new Set([...workspace.selectedTabIds, ...rangeIds]));
    set({ openProjects: new Map(openProjects) });
  },

  clearSelection: (projectId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (workspace) {
      workspace.selectedTabIds = [];
      set({ openProjects: new Map(openProjects) });
    }
  },

  getSelectedTabs: (projectId) => {
    const workspace = get().openProjects.get(projectId);
    if (!workspace) return [];
    return workspace.selectedTabIds
      .map(id => workspace.tabs.get(id))
      .filter(Boolean) as Tab[];
  },

  showWorkspace: (projectId) => {
    const { projectHistory } = get();
    // Move to end of history (max 20)
    const newHistory = [...projectHistory.filter(id => id !== projectId), projectId].slice(-20);

    // Use startTransition for smooth project switching
    startTransition(() => {
      set({ 
        view: 'workspace', 
        activeProjectId: projectId,
        projectHistory: newHistory 
      });
    });
    get().saveSession();
  },

  openProject: async (projectId, projectPath) => {
    console.log('[Store] openProject called:', { projectId, projectPath });
    const { openProjects, createTab, saveSession, projectHistory } = get();

    // Update history
    const newHistory = [...projectHistory.filter(id => id !== projectId), projectId].slice(-20);

    if (!openProjects.has(projectId)) {
      console.log('[Store] Project not in openProjects, loading from DB...');
      // Load saved tabs from database - use getById to get correct project (not just any with same path)

      const projectData = await ipcRenderer.invoke('project:getById', projectId);
      console.log('[Store] project:getById returned:', projectData);
      const savedTabs = projectData?.tabs || [];
      console.log('[Store] savedTabs:', savedTabs);

      const newWorkspace: ProjectWorkspace = {
        projectId,
        projectPath,
        tabs: new Map(),
        activeTabId: null,
        selectedTabIds: [],
        tabCounter: 0, // Start from 0 for new projects
        sidebarOpen: projectData?.sidebarOpen || false,
        openFilePath: projectData?.openFilePath || null
      };
      openProjects.set(projectId, newWorkspace);
      
      console.log('[Store] Preparing project tabs before switching view...');
      set({ isRestoring: true });

      // Restore saved tabs or create default one
      if (savedTabs.length > 0) {
        newWorkspace.tabCounter = savedTabs.length;
        for (const savedTab of savedTabs) {
          await createTab(projectId, savedTab.name, savedTab.cwd, {
            color: savedTab.color,
            isUtility: savedTab.isUtility,
            commandType: savedTab.commandType,
            claudeSessionId: savedTab.claudeSessionId,
            geminiSessionId: savedTab.geminiSessionId,
            wasInterrupted: savedTab.wasInterrupted,
            overlayDismissed: savedTab.overlayDismissed,
            notes: savedTab.notes,
            tabType: savedTab.tabType,
            url: savedTab.url,
            createdAt: savedTab.createdAt,
            isCollapsed: savedTab.isCollapsed
          } as any);
        }
      } else {
        // Create default tab
        await createTab(projectId, 'Terminal 1', projectPath);
      }

      console.log('[Store] Tabs prepared, switching to workspace view');
      set({ 
        openProjects: new Map(openProjects), 
        activeProjectId: projectId, 
        view: 'workspace',
        isRestoring: false,
        projectHistory: newHistory
      });

      saveSession();
    } else {
      set({ 
        activeProjectId: projectId, 
        view: 'workspace',
        projectHistory: newHistory 
      });
      saveSession();
    }
  },

  closeProject: async (projectId) => {
    const { openProjects, activeProjectId, view, saveSession, syncAllTabsCwd, projectHistory } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      // Sync cwd for all tabs before closing
      await syncAllTabsCwd(projectId);

      // Save tabs before closing (manual close = NOT interrupted)
      saveTabs(workspace.projectId, workspace.tabs);

      // Kill all terminals
      workspace.tabs.forEach((tab) => {
        ipcRenderer.send('terminal:kill', tab.id);
      });

      openProjects.delete(projectId);
      
      // Update history: remove closed project
      const newHistory = projectHistory.filter(id => id !== projectId);
      
      const isClosingActive = activeProjectId === projectId;
      let nextActiveId = activeProjectId;

      if (isClosingActive) {
        // Find next best project from history that is still open
        nextActiveId = null;
        for (let i = newHistory.length - 1; i >= 0; i--) {
          if (openProjects.has(newHistory[i])) {
            nextActiveId = newHistory[i];
            break;
          }
        }
      }
      
      set({
        openProjects: new Map(openProjects),
        activeProjectId: nextActiveId,
        projectHistory: newHistory,
        // If we closed the active project and no projects are left in history -> dashboard
        view: (isClosingActive && !nextActiveId && view === 'workspace') ? 'dashboard' : view
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
      commandType: options?.commandType,
      pendingAction: options?.pendingAction,
      claudeSessionId: options?.claudeSessionId,
      geminiSessionId: options?.geminiSessionId,
      wasInterrupted: options?.wasInterrupted,
      overlayDismissed: options?.overlayDismissed,
      notes: options?.notes,
      tabType: options?.tabType || 'terminal',
      url: options?.url,
      createdAt: (options as any)?.createdAt || Math.floor(Date.now() / 1000),
      isCollapsed: (options as any)?.isCollapsed
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

    // Don't switch activeTabId during session restore to avoid UI flickering
    const { isRestoring } = get();
    if (!isRestoring) {
      workspace.activeTabId = tabId;
    }

    console.log('[Store] createTab: Setting state, tabs count:', workspace.tabs.size, 'isRestoring:', isRestoring);
    set({ openProjects: new Map(openProjects) });

    // Save tabs
    saveTabs(workspace.projectId, workspace.tabs);

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
      commandType: options?.commandType,
      pendingAction: options?.pendingAction,
      claudeSessionId: options?.claudeSessionId,
      geminiSessionId: options?.geminiSessionId,
      wasInterrupted: options?.wasInterrupted,
      overlayDismissed: options?.overlayDismissed,
      notes: options?.notes,
      tabType: options?.tabType || 'terminal',
      url: options?.url,
      createdAt: (options as any)?.createdAt || Math.floor(Date.now() / 1000)
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
    saveTabs(workspace.projectId, workspace.tabs);

    return tabId;
  },

  closeTab: async (projectId, tabId) => {
    const { openProjects, clearTerminalBuffer } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return;

    const tab = workspace.tabs.get(tabId);

    // Check if terminal has running process via OSC 133 state (fast, no syscalls)
    const commandState = await ipcRenderer.invoke('terminal:getCommandState', tabId);

    if (commandState.isRunning) {
      // Only call hasRunningProcess to get process name (single syscall, not polling)
      const { processName } = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);
      const confirmed = window.confirm(
        `Terminal has a running process: "${processName || 'unknown'}"\n\nAre you sure you want to close this tab?`
      );
      if (!confirmed) return;
    }

    // Check if tab has saved Claude session
    if (tab?.claudeSessionId && !commandState.isRunning) {
      const confirmed = window.confirm(
        `Эта вкладка содержит Claude сессию:\n${tab.claudeSessionId}\n\nПри закрытии вы потеряете привязку к этой сессии. Продолжить?`
      );
      if (!confirmed) return;
    }

    ipcRenderer.send('terminal:kill', tabId);
    clearTerminalBuffer(tabId); // Clean up serialized buffer

    // Archive tab to history (fire-and-forget)
    if (tab) {
      ipcRenderer.invoke('project:archive-tab', {
        projectId,
        tab: {
          name: tab.name,
          cwd: tab.cwd,
          color: tab.color,
          notes: tab.notes,
          commandType: tab.commandType,
          tabType: tab.tabType,
          url: tab.url,
          createdAt: tab.createdAt,
          claudeSessionId: tab.claudeSessionId,
          geminiSessionId: tab.geminiSessionId
        }
      }).catch(() => {});
    }

    workspace.tabs.delete(tabId);

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
    saveTabs(workspace.projectId, workspace.tabs);
  },

  switchTab: (projectId, tabId) => {
    const { openProjects, saveSession } = get();
    const workspace = openProjects.get(projectId);

    if (workspace && workspace.tabs.has(tabId)) {
      workspace.activeTabId = tabId;
      workspace.selectedTabIds = [tabId]; // Update selection on direct switch
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
        saveTabs(workspace.projectId, workspace.tabs);
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
    saveTabs(workspace.projectId, workspace.tabs);
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
        saveTabs(workspace.projectId, workspace.tabs);
      }
    }
  },

  setTabCommandType: (tabId, commandType) => {
    const { openProjects } = get();

    // Find tab across all projects
    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
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
        saveTabs(workspace.projectId, workspace.tabs);
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
        saveTabs(workspace.projectId, workspace.tabs);
      }
    }
  },

  toggleTabCollapsed: (projectId, tabId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.isCollapsed = !tab.isCollapsed;
        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectId, workspace.tabs);
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
    saveTabs(workspace.projectId, workspace.tabs);
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
    saveTabs(workspace.projectId, workspace.tabs);
  },

  moveTabToProject: (sourceProjectId, tabId, targetProjectId) => {
    if (sourceProjectId === targetProjectId) return;

    const { openProjects } = get();
    const sourceWorkspace = openProjects.get(sourceProjectId);
    const targetWorkspace = openProjects.get(targetProjectId);

    if (!sourceWorkspace || !targetWorkspace) return;

    const tab = sourceWorkspace.tabs.get(tabId);
    if (!tab) return;

    // Remove from source project
    sourceWorkspace.tabs.delete(tabId);

    // If this was the active tab in source, switch to another
    if (sourceWorkspace.activeTabId === tabId) {
      const remainingTabs = Array.from(sourceWorkspace.tabs.keys());
      sourceWorkspace.activeTabId = remainingTabs.length > 0 ? remainingTabs[0] : null;
    }

    // Add to target project (as main tab, not utility)
    tab.isUtility = false;
    targetWorkspace.tabs.set(tabId, tab);

    // Make it active in target project
    targetWorkspace.activeTabId = tabId;

    // Update state
    set({ openProjects: new Map(openProjects) });

    // Save both projects
    saveTabs(sourceWorkspace.projectId, sourceWorkspace.tabs);
    saveTabs(targetWorkspace.projectId, targetWorkspace.tabs);

    log.tabs(`[moveTabToProject] Moved tab ${tabId} from ${sourceProjectId} to ${targetProjectId}`);
  },

  moveTabsToProject: (sourceProjectId, tabIds, targetProjectId) => {
    if (sourceProjectId === targetProjectId || tabIds.length === 0) return;

    const { openProjects } = get();
    const src = openProjects.get(sourceProjectId);
    const tgt = openProjects.get(targetProjectId);
    if (!src || !tgt) return;

    let lastId: string | null = null;
    for (const tabId of tabIds) {
      const tab = src.tabs.get(tabId);
      if (!tab) continue;
      src.tabs.delete(tabId);
      tab.isUtility = false;
      tgt.tabs.set(tabId, tab);
      lastId = tabId;
    }

    // Fix active tab in source
    if (src.activeTabId && !src.tabs.has(src.activeTabId)) {
      const remaining = Array.from(src.tabs.keys());
      src.activeTabId = remaining[0] || null;
    }
    // Clear selection in source
    src.selectedTabIds = src.selectedTabIds.filter(id => src.tabs.has(id));
    // Active in target
    if (lastId) tgt.activeTabId = lastId;

    set({ openProjects: new Map(openProjects) });
    saveTabs(src.projectId, src.tabs);
    saveTabs(tgt.projectId, tgt.tabs);

    log.tabs(`[moveTabsToProject] Moved ${tabIds.length} tabs from ${sourceProjectId} to ${targetProjectId}`);
  },

  updateTabCwd: (projectId, tabId, newCwd) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      const tab = workspace.tabs.get(tabId);
      if (tab && tab.cwd !== newCwd) {
        tab.cwd = newCwd;
        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectId, workspace.tabs);
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
        // Reset overlay flags when new session starts (so overlay shows again if interrupted)
        tab.wasInterrupted = false;
        tab.overlayDismissed = false;
        console.log(`[Workspace] Claude session set for tab ${tabId}: ${sessionId} (reset overlay flags)`);
        // Save to database so session persists across restarts
        saveTabs(workspace.projectId, workspace.tabs);
        // NOTE: Not calling set() here to avoid re-render that breaks terminal
        return;
      }
    }
  },

  // Clear Claude session completely (when process exits normally)
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

  // Gemini session tracking (detected via Sniper Watcher on ~/.gemini/tmp/<hash>/chats/)
  setGeminiSessionId: (tabId, sessionId) => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.geminiSessionId = sessionId;
        // Reset overlay flags when new session starts (so overlay shows again if interrupted)
        tab.wasInterrupted = false;
        tab.overlayDismissed = false;
        console.log(`[Workspace] Gemini session set for tab ${tabId}: ${sessionId} (reset overlay flags)`);
        saveTabs(workspace.projectId, workspace.tabs);
        return;
      }
    }
  },

  getGeminiSessionId: (tabId) => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        return tab.geminiSessionId || null;
      }
    }
    return null;
  },

  // Tab notes
  setTabNotes: (tabId, notes) => {
    const { openProjects } = get();

    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.notes = notes;
        saveTabs(workspace.projectId, workspace.tabs);
        return;
      }
    }
  },

  getTabNotes: (tabId) => {
    const { openProjects } = get();

    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        return tab.notes || '';
      }
    }
    return '';
  },

  // Reorder projects (drag-and-drop)
  reorderProjects: (orderedProjectIds) => {
    const { openProjects, saveSession } = get();

    // Create new Map with correct order
    const newOpenProjects = new Map<string, ProjectWorkspace>();
    for (const projectId of orderedProjectIds) {
      const workspace = openProjects.get(projectId);
      if (workspace) {
        newOpenProjects.set(projectId, workspace);
      }
    }

    set({ openProjects: newOpenProjects });
    saveSession();
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

  // Clear interrupted state for a tab (when user continues session)
  clearInterruptedState: (tabId) => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab && tab.wasInterrupted) {
        tab.wasInterrupted = false;
        // Reset overlayDismissed so overlay shows again if session is interrupted again
        tab.overlayDismissed = false;
        console.log('[Store] Cleared interrupted state for tab:', tabId);
        // Save to persist the change
        saveTabs(workspace.projectId, workspace.tabs);
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
        // Mark as dismissed so it won't be re-marked on shutdown
        tab.overlayDismissed = true;
        // Save to database
        saveTabs(workspace.projectId, workspace.tabs);
        // Trigger re-render
        set({ openProjects: new Map(openProjects) });
        return;
      }
    }
  },

  // Mark all tabs with active AI sessions as interrupted (called on shutdown)
  markAllSessionsInterrupted: () => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      let changed = false;
      for (const [tabId, tab] of workspace.tabs) {
        // Check both Claude and Gemini sessions
        // Skip if user already dismissed the overlay (don't show again)
        if ((tab.claudeSessionId || tab.geminiSessionId) && !tab.wasInterrupted && !tab.overlayDismissed) {
          tab.wasInterrupted = true;
          changed = true;
          console.log('[Store] Marking tab as interrupted:', tabId, 'claude:', tab.claudeSessionId, 'gemini:', tab.geminiSessionId);
        }
      }
      if (changed) {
        // Save immediately (shutdown scenario)
        saveTabs(workspace.projectId, workspace.tabs);
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
  },

  // Sidebar state (per-project)
  setSidebarOpen: (projectId, open) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (workspace) {
      workspace.sidebarOpen = open;
      set({ openProjects: new Map(openProjects) });
      // Save to database
      ipcRenderer.invoke('project:save-sidebar-state', {
        projectId,
        sidebarOpen: open,
        openFilePath: workspace.openFilePath
      });
    }
  },

  setOpenFilePath: (projectId, filePath) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (workspace) {
      workspace.openFilePath = filePath;
      set({ openProjects: new Map(openProjects) });
      // Save to database
      ipcRenderer.invoke('project:save-sidebar-state', {
        projectId,
        sidebarOpen: workspace.sidebarOpen,
        openFilePath: filePath
      });
    }
  },

  getSidebarState: (projectId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (workspace) {
      return {
        sidebarOpen: workspace.sidebarOpen,
        openFilePath: workspace.openFilePath
      };
    }
    return { sidebarOpen: false, openFilePath: null };
  }
}));

if (typeof window !== 'undefined') {
  (window as any).useWorkspaceStore = useWorkspaceStore;
}

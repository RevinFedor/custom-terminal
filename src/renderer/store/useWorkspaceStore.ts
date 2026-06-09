import { create } from 'zustand';
import { startTransition } from 'react';
import { log } from '../utils/logger';
import { setPrefetched } from '../utils/sdkHistoryPrefetch';

const { ipcRenderer } = window.require('electron');

export type TabColor = 'default' | 'red' | 'yellow' | 'green' | 'blue' | 'purple' | 'claude' | 'gemini';

export type CommandType = 'generic' | 'devServer' | 'claude' | 'gemini';

export type TabType = 'terminal' | 'browser' | 'claude-sdk';

/**
 * Tag for the source that wrote `tab.claudeSessionId`. Used for diagnostics
 * and rendered in the "revert session" history modal so the user knows which
 * subsystem set each previous value.
 *   bridge          — SessionBridge `processFile` → claude:session-detected IPC
 *   autoResume      — App.tsx AutoResume effect after Electron restart
 *   userIntercept   — terminal:input matched `claude --resume <id>`
 *   userManual      — InfoPanel ✎ modal direct entry
 *   timelineChain   — Timeline.tsx Clear-Context chain resolver
 *   fork            — claude:fork-session-file IPC
 *   restoredFromDb  — restoreSession at startup
 *   userRevert      — tab context-menu revert from history
 *   unknown         — default when caller did not specify (legacy paths)
 */
export type SessionWriteReason =
  | 'bridge'
  | 'autoResume'
  | 'userIntercept'
  | 'userManual'
  | 'timelineChain'
  | 'fork'
  | 'restoredFromDb'
  | 'userRevert'
  | 'unknown';

export interface SessionHistoryEntry {
  sessionId: string;
  reason: SessionWriteReason;
  at: number; // Date.now() millis
}

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
  nameSetManually?: boolean; // True if user renamed tab manually - prevents auto-rename on commandType detection
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
  /**
   * Recent sessionId rotation log (most-recent-first, capped at 5 entries).
   * Used as a safety-net for accidental overwrites — user can revert via the
   * tab context menu when an automated subsystem (bridge watcher, AutoResume,
   * timeline chain resolver) wrote the wrong session.
   * Persisted in tabs.claude_session_history (JSON).
   * Schema: { sessionId, reason, at } where reason is the cause-tag declared
   * by the caller of setClaudeSessionId.
   * See docs/knowledge/fix-bridge-stale-takeover.md.
   */
  claudeSessionHistory?: SessionHistoryEntry[];
  /**
   * User-assigned semantic status of the session. Independent of runtime type
   * (claude/sdk/gemini/dev) and busy state. Set via right-click context menu.
   * Rendered as a colored SVG marker on the left of the tab in vertical mode.
   *   dev       — идёт разработка (активная работа)
   *   bugfix    — отложенный багфикс (не решено сейчас, ждёт)
   *   knowledge — отложенные знания (нужно записать в md)
   * Absence (undefined) = без статуса, маркер не показывается.
   * Тип string — юзер может создавать/удалять статусы в Settings → Системные.
   * Default seed id'ы — 'dev'|'bugfix'|'knowledge', но любой custom id допустим.
   * Если id больше нет в useUIStore.sessionStatuses → маркер не рендерится
   * (graceful degrade), значение в БД сохраняется.
   */
  sessionStatus?: string;
  isCollapsed?: boolean; // Collapsed tab — icon-only, for archiving completed sessions
  claudeAgentSessionId?: string; // Claude Agent SDK session ID (for @claude:...@end orchestration)
  claudeAgentStatus?: 'idle' | 'running' | 'done' | 'error' | 'summarizing'; // Claude Agent current status
  claudeActive?: boolean; // True if Claude CLI is running inside PTY (not just shell alive)
  claudeBusy?: boolean; // True if Claude CLI spinner is active (from claude:busy-state)
  claudeTaskCount?: number; // Number of completed MCP tasks (delegate/continue)
  parentTabId?: string; // If this is a MCP sub-agent tab, points to parent (Gemini) tab
  mcpTaskId?: string; // MCP task UUID assigned when delegate_to_claude created this sub-agent
  interceptorState?: 'armed' | 'disarmed' | null; // Interceptor state for MCP response delivery
  // Claude SDK tab state
  // SDK turn-state. Splits the «loader is up» window into deterministic phases:
  //   fetching   — onNew fired, no SDK event yet (network + warm-up). Юзер видит «Connecting…»
  //   thinking   — first chunk arrived, no text yet (only thinking / system:init). Лоадер активен.
  //   typing     — assistant chunk with TEXT received → лоадер УХОДИТ, content streams into bubble.
  //                Note: typing isn't a "loading" state; we track it so callers can distinguish
  //                "actively producing tokens" from "idle". UI hides loader for both typing AND idle.
  //   tool_use   — Claude вызвал tool, ждём result. Лоадер: «Running <name>…»
  //   error/idle — окончание turn'а.
  sdkState?: 'idle' | 'fetching' | 'thinking' | 'typing' | 'tool_use' | 'error';
  // Process-alive flag for SDK tabs (single source for the control-bar process
  // indicator AND the tab activity plate). true once a query exists; stays true
  // between turns (soft interrupt parks the session); false only on hard kill /
  // natural end / tab close. Distinct from sdkState (per-turn) and from busy
  // (token streaming): a process can be alive+idle («Активен») with no busy.
  sdkProcessAlive?: boolean;
  sdkMessages?: Array<{ role: string; type: string; content: string; timestamp: number; toolName?: string; toolStatus?: string }>; // In-memory messages for chat UI
  sdkModel?: string; // Model for next SDK query
  sdkEffort?: string; // Effort level for next SDK query
  sdkThinking?: boolean; // Thinking enabled for next SDK query
  /**
   * Live mid-stream type-ahead queue for this SDK tab. Kept here (not in
   * ClaudeSDKTab local ref) so that switching projects doesn't unmount the
   * pending state. The main-process JSONL watcher keeps running tied to the
   * tabId; when the user returns the chip is re-rendered from this array.
   * Each entry: text user pushed + push timestamp + lifecycle state.
   * NOT persisted to SQLite — lives only during a session.
   */
  sdkMidstreamPending?: Array<{ text: string; ts: number; state: 'queued' | 'sent' }>;
  /**
   * Per-tab provider/model selection for the Claude proxy. Persisted via SQLite
   * (tabs.provider_state JSON). Authoritative writer is main process — it owns
   * `providerStates` Map and writes the row directly through DB on every
   * provider:switch / provider:set-options. This field on the Tab is the
   * cached projection: read on tabs load, updated via `provider:state-changed`
   * IPC broadcast from main. Renderer never writes it back via saveTabs.
   * Default (undefined / {type:'anthropic'} with no extras) means "subscription
   * Claude API, model picked by Claude TUI itself".
   */
  providerState?: { type: string; model?: string; effort?: string; thinking?: string };
  // Background tasks: live state for Agent/Bash subagents and background bash
  // commands that have been moved off the foreground turn. Populated from SDK
  // task_started / task_progress / task_updated / task_notification events.
  // NOT persisted: rebuilt from JSONL on next session open via getSubagentMessages.
  bgTasks?: BgTask[];
}

// 'workflow' = a dynamic-workflow orchestration (SDK task_type 'local_workflow').
// GROUND TRUTH (captured from a real run, NOT the .d.ts which omits this): the
// workflow does NOT emit a task_started per child agent. It emits ONE
// task_started (the workflow) + a stream of task_progress whose UNDOCUMENTED
// `workflow_progress[]` array carries the full tree — phases and agents with
// label/model/state/tokens/toolCalls/promptPreview/resultPreview. So we embed
// phases+agents ON the single workflow BgTask (below), not as separate entries.
export type BgTaskKind = 'agent' | 'bash' | 'workflow';
// 'paused' added in SDK 0.3.156 (SDKTaskUpdatedMessage.patch.status) — a
// workflow/agent can be paused (`p` hotkey) and resumed.
export type BgTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'paused';

// One phase of a dynamic workflow (workflow_progress entry type 'workflow_phase').
export interface WorkflowPhase {
  index: number;   // 1-based phase order
  title: string;   // e.g. 'Fan-out', 'Synthesize'
}
// One agent of a dynamic workflow (workflow_progress entry type 'workflow_agent').
// Merged by `index` across successive task_progress events (each event may carry
// only the agents whose state changed, and 'done' adds resultPreview).
export interface WorkflowAgent {
  index: number;            // stable key across events
  label: string;            // 'ask:colors' / 'synthesize'
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;         // assigned once the agent starts running
  model?: string;           // 'claude-opus-4-8[1m]'
  state: 'start' | 'progress' | 'done' | 'error';
  tokens?: number;          // per-agent token count
  toolCalls?: number;       // per-agent tool-call count
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;   // appears in 'done'
  durationMs?: number;
  startedAt?: number;
  attempt?: number;
}
export interface BgTask {
  taskId: string;          // SDK task_id (stable across task_started→task_notification)
  toolUseId?: string;       // The tool_use block that started this task (Agent / Bash)
  kind: BgTaskKind;
  name: string;            // Display name: subagent_type for agents, command head for bash
  description?: string;    // For agents: task description from task_started
  initialPrompt?: string;  // For agents: full prompt the parent gave to the subagent (rendered as the first user-bubble in the pane mini-thread)
  status: BgTaskStatus;
  startedAt: number;       // ms timestamp from first task_started
  endedAt?: number;
  lastToolName?: string;   // From task_progress.last_tool_name (agents)
  summary?: string;        // From task_progress.summary (agents, agentProgressSummaries:true)
  agentSessionId?: string;  // Subagent JSONL agentId (== task_id in current SDK)
  outputFile?: string;     // For bash: path from task_notification.output_file
  finalSummary?: string;   // From task_notification.summary (final assistant text / bash tail)
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  isError?: boolean;
  // ---- Workflow (SDK 0.3.156 local_workflow) ----
  // For kind==='workflow' ONLY. The phases + agents are parsed out of every
  // task_progress.workflow_progress[] and merged here by index (events are
  // partial — they carry only changed agents). The WorkflowPanel renders
  // straight off these two arrays; there are no separate per-agent BgTasks.
  workflowName?: string;   // task_started.workflow_name (meta.name of the script)
  phases?: WorkflowPhase[];
  agents?: WorkflowAgent[];
  activity?: string[];     // Rolling tool-call log, cap ~12 (non-workflow agent tasks)
  toolCallTotal?: number;  // Monotonic count of tool calls seen
}

interface ProjectWorkspace {
  projectId: string;
  projectPath: string;
  tabs: Map<string, Tab>;
  activeTabId: string | null;
  selectedTabIds: string[]; // List of selected tab IDs for multi-action
  tabHistory: string[]; // LRU stack of tab IDs (max 20) for navigation on close
  tabCounter: number;
  sidebarOpen: boolean;
  openFilePath: string | null;
  sidebarExpandedDirs: Record<string, boolean> | null;
  currentView: 'terminal' | 'home'; // Per-project view state (Home vs Terminal)
  viewingSubAgentTabId: string | null; // When viewing a sub-agent, points to the Claude sub-agent tab
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
  pendingEditTabId: string | null; // Set after createTab to trigger inline rename; consumed once by TabBar

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
  openProject: (projectId: string, projectPath: string, options?: { background?: boolean; draft?: boolean }) => void;
  closeProject: (projectId: string) => Promise<void>;

  // Tab management
  createTab: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; isUtility?: boolean; commandType?: CommandType; pendingAction?: PendingAction; claudeSessionId?: string; geminiSessionId?: string; wasInterrupted?: boolean; overlayDismissed?: boolean; notes?: string; tabType?: TabType; url?: string; background?: boolean; sessionStatus?: string }) => Promise<string>;
  createTabAfterCurrent: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; isUtility?: boolean; commandType?: CommandType; pendingAction?: PendingAction; claudeSessionId?: string; geminiSessionId?: string; wasInterrupted?: boolean; overlayDismissed?: boolean; notes?: string; tabType?: TabType; url?: string; afterTabId?: string; nameSetManually?: boolean; background?: boolean }) => Promise<string>;
  closeTab: (projectId: string, tabId: string, options?: { skipProcessCheck?: boolean; forceCleanup?: boolean }) => Promise<void>;
  reopenLastClosedTab: (projectId: string) => Promise<{ tabId: string | null; reason?: 'empty' | 'error' }>;
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
  setTabSessionStatus: (projectId: string, tabId: string, status: string | null) => void;
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
  // `reason` documents who is writing — bubbles into claudeSessionHistory so
  // the user can revert mistaken overwrites from the tab context menu.
  setClaudeSessionId: (tabId: string, sessionId: string, reason?: SessionWriteReason) => void;
  getClaudeSessionId: (tabId: string) => string | null;

  // Gemini session tracking
  setGeminiSessionId: (tabId: string, sessionId: string) => void;
  getGeminiSessionId: (tabId: string) => string | null;

  // Claude Agent orchestration
  setClaudeAgentStatus: (tabId: string, status: 'idle' | 'running' | 'done' | 'error' | 'summarizing', sessionId?: string) => void;
  setClaudeActive: (tabId: string, alive: boolean) => void;
  setClaudeBusy: (tabId: string, busy: boolean) => void;
  setSdkProcessAlive: (tabId: string, alive: boolean) => void;
  setInterceptorState: (tabId: string, state: 'armed' | 'disarmed' | null) => void;

  // MCP sub-agent tab management
  setTabParent: (tabId: string, parentTabId: string | undefined) => void;
  getSubAgentTabs: (parentTabId: string) => Tab[];
  setViewingSubAgent: (tabId: string | null) => void;
  getEffectiveTabId: () => string | null;

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

  // Browser tabs
  createBrowserTab: (projectId: string) => Promise<string>;
  updateTabUrl: (tabId: string, url: string) => void;
  setBrowserActiveView: (tabId: string, view: 'browser' | 'terminal') => void;

  // Claude SDK tabs
  createSDKTab: (projectId: string, name?: string) => Promise<string>;
  convertToSDKTab: (tabId: string) => void;
  updateSDKState: (tabId: string, state: Partial<Pick<Tab, 'sdkState' | 'sdkMessages' | 'claudeSessionId' | 'sdkModel' | 'sdkEffort' | 'sdkThinking' | 'sdkMidstreamPending'>>) => void;
  // Merge a partial BgTask patch by taskId. Creates the entry if missing.
  // status terminal transition ('completed'|'failed'|'stopped') also sets endedAt.
  upsertBgTask: (tabId: string, taskId: string, patch: Partial<BgTask>) => void;
  removeBgTask: (tabId: string, taskId: string) => void;

  // Helpers
  getActiveTab: (projectId: string) => Tab | null;
  getActiveProject: () => ProjectWorkspace | null;

  // Per-project view (Home vs Terminal)
  setProjectView: (projectId: string, view: 'terminal' | 'home') => void;

  // Sidebar state (per-project)
  setSidebarOpen: (projectId: string, open: boolean) => void;
  setOpenFilePath: (projectId: string, filePath: string | null) => void;
  setSidebarExpandedDirs: (projectId: string, expandedDirs: Record<string, boolean>) => void;
  getSidebarState: (projectId: string) => { sidebarOpen: boolean; openFilePath: string | null; sidebarExpandedDirs: Record<string, boolean> | null };
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
// forceCleanup: bypass safety guard when reduction is intentional (batch move/close)
const saveTabs = (projectId: string, tabs: Map<string, Tab>, forceCleanup = false) => {
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
    isCollapsed: tab.isCollapsed,
    sessionStatus: tab.sessionStatus,
    nameSetManually: tab.nameSetManually,
    parentTabId: tab.parentTabId,
    mcpTaskId: tab.mcpTaskId,
    claudeTaskCount: tab.claudeTaskCount || 0,
    tabId: tab.id
  }));
  ipcRenderer.invoke('project:save-tabs', { projectId, tabs: tabsArray, forceCleanup });
};

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  view: 'dashboard',
  activeProjectId: null,
  openProjects: new Map(),
  projectHistory: [],
  isRestoring: false,
  pendingEditTabId: null,

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
      const { openProjects, createTab } = get();

      set({ isRestoring: true });

      // Load ALL projects and their tabs WITHOUT calling set() per project.
      // Old approach: openProject() in a loop → each call does set({openProjects: new Map()})
      // → 5 projects = 5 set() calls = 5 Workspace remounts = black screen flicker.
      // New approach: load data inline, mutate openProjects map directly, single set() at end.
      for (const proj of sessionState.openProjects) {
        if (openProjects.has(proj.projectId)) continue;

        const projectData = await ipcRenderer.invoke('project:getById', proj.projectId);
        const savedTabs = projectData?.tabs || [];

        const newWorkspace: ProjectWorkspace = {
          projectId: proj.projectId,
          projectPath: proj.projectPath,
          tabs: new Map(),
          activeTabId: null,
          selectedTabIds: [],
          tabHistory: [],
          tabCounter: 0,
          sidebarOpen: projectData?.sidebarOpen || false,
          openFilePath: projectData?.openFilePath || null,
          sidebarExpandedDirs: projectData?.sidebarExpandedDirs || null,
          currentView: 'terminal',
          viewingSubAgentTabId: null
        };
        openProjects.set(proj.projectId, newWorkspace);

        if (savedTabs.length > 0) {
          let maxTabNum = savedTabs.length;
          for (const st of savedTabs) {
            if (st.tabId) {
              const m = st.tabId.match(/-tab-(\d+)$/);
              if (m) maxTabNum = Math.max(maxTabNum, parseInt(m[1]) + 1);
            }
          }
          newWorkspace.tabCounter = maxTabNum;
          for (const savedTab of savedTabs) {
            await createTab(proj.projectId, savedTab.name, savedTab.cwd, {
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
              isCollapsed: savedTab.isCollapsed,
              sessionStatus: savedTab.sessionStatus,
              nameSetManually: savedTab.nameSetManually,
              parentTabId: savedTab.parentTabId,
              mcpTaskId: savedTab.mcpTaskId,
              claudeTaskCount: savedTab.claudeTaskCount || 0,
              restoreId: savedTab.tabId
            } as any);
          }
          for (const [, tab] of newWorkspace.tabs) {
            if (tab.parentTabId) {
              tab.claudeAgentStatus = 'done';
              tab.claudeActive = false;
            }
          }
        } else {
          await createTab(proj.projectId, 'Terminal 1', proj.projectPath);
        }

        // Set active tab by saved index
        if (proj.activeTabIndex >= 0) {
          const tabsArray = Array.from(newWorkspace.tabs.keys());
          if (tabsArray[proj.activeTabIndex]) {
            newWorkspace.activeTabId = tabsArray[proj.activeTabIndex];
          }
        }
      }

      // SDK history pre-fetch: load JSONL for every SDK tab in parallel BEFORE
      // dropping the RestoreLoader. The 13.6MB session parses in ~80ms server-
      // side, IPC roundtrip ~150-300ms — running 3-4 in parallel keeps total
      // wait under 500ms. Without this the loader hides → SDK tabs mount →
      // each one fires its own loadHistory → user stares at empty chat until
      // the IPC returns. Prefetch lives in a module-level map; ClaudeSDKTab's
      // loadHistory drains it on first call, then falls back to fresh IPC.
      const sdkPrefetchTasks: Array<Promise<void>> = [];
      const cwdByProject = new Map<string, string>();
      for (const ws of openProjects.values()) {
        cwdByProject.set(ws.projectId, ws.projectPath);
        for (const [, tab] of ws.tabs) {
          if (tab.tabType === 'claude-sdk' && tab.claudeSessionId) {
            const sessionId = tab.claudeSessionId;
            const tabId = tab.id;
            const cwd = tab.cwd || ws.projectPath;
            sdkPrefetchTasks.push(
              ipcRenderer
                .invoke('claude-sdk:active-branch-messages', { sessionId, cwd })
                .then((result: any) => {
                  if (result?.success && Array.isArray(result.messages)) {
                    setPrefetched(tabId, sessionId, result.messages);
                  }
                })
                .catch((e: any) => {
                  console.warn('[Restore] SDK prefetch failed for tab=' + tabId.slice(-12), e?.message || e);
                })
            );
          }
        }
      }
      if (sdkPrefetchTasks.length > 0) {
        console.warn('[Restore] SDK prefetch starting count=' + sdkPrefetchTasks.length);
        const t0 = Date.now();
        await Promise.all(sdkPrefetchTasks);
        console.warn('[Restore] SDK prefetch done count=' + sdkPrefetchTasks.length + ' durMs=' + (Date.now() - t0));
      }

      // SINGLE set() for all projects — one Workspace mount instead of N
      const savedView = sessionState.view || 'dashboard';
      const restoredHistory = sessionState.projectHistory || [];
      const restoredActiveId = sessionState.activeProjectId && openProjects.has(sessionState.activeProjectId)
        ? sessionState.activeProjectId
        : null;

      set({
        activeProjectId: restoredActiveId,
        view: savedView === 'workspace' && restoredActiveId ? 'workspace' : 'dashboard',
        isRestoring: false,
        openProjects: new Map(openProjects),
        projectHistory: restoredHistory
      });

      get().saveSession();
    } catch (e) {
      console.error('[Session] Failed to restore:', e);
      set({ isRestoring: false });
    }
  },

  showDashboard: async () => {
    const { activeProjectId, syncAllTabsCwd } = get();

    // Switch view IMMEDIATELY — don't block on sync
    // NOTE: Keep activeProjectId! Nulling it causes Workspace early return → TerminalArea unmount → all terminals destroyed
    // Workspace stays mounted but hidden (CSS) to preserve terminal instances
    set({ view: 'dashboard' });

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

  openProject: async (projectId, projectPath, options) => {
    const background = options?.background ?? false;
    const draft = options?.draft ?? false;
    console.log('[Store] openProject called:', { projectId, projectPath, background, draft });
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
        tabHistory: [],
        tabCounter: 0, // Start from 0 for new projects
        sidebarOpen: projectData?.sidebarOpen || false,
        openFilePath: projectData?.openFilePath || null,
        sidebarExpandedDirs: projectData?.sidebarExpandedDirs || null,
        currentView: draft ? 'home' : 'terminal',
        viewingSubAgentTabId: null
      };
      openProjects.set(projectId, newWorkspace);

      if (!background && !draft) {
        console.log('[Store] Preparing project tabs before switching view...');
        set({ isRestoring: true });
      }

      // In draft mode, skip tab creation — user hasn't confirmed project yet
      if (!draft) {
        // Restore saved tabs or create default one
        if (savedTabs.length > 0) {
          // Set tabCounter higher than any restored tab number to avoid ID collisions
          let maxTabNum = savedTabs.length;
          for (const st of savedTabs) {
            if (st.tabId) {
              const m = st.tabId.match(/-tab-(\d+)$/);
              if (m) maxTabNum = Math.max(maxTabNum, parseInt(m[1]) + 1);
            }
          }
          newWorkspace.tabCounter = maxTabNum;
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
              isCollapsed: savedTab.isCollapsed,
              sessionStatus: savedTab.sessionStatus,
              nameSetManually: savedTab.nameSetManually,
              parentTabId: savedTab.parentTabId,
              mcpTaskId: savedTab.mcpTaskId,
              claudeTaskCount: savedTab.claudeTaskCount || 0,
              restoreId: savedTab.tabId
            } as any);
          }
          // After restore: set claudeAgentStatus for sub-agent tabs (not persisted in DB)
          for (const [, tab] of newWorkspace.tabs) {
            if (tab.parentTabId) {
              tab.claudeAgentStatus = 'done';
              tab.claudeActive = false; // Claude CLI not running after restore
            }
          }
        } else {
          // Create default tab
          await createTab(projectId, 'Terminal 1', projectPath);
        }
      }

      if (background) {
        console.log('[Store] Tabs prepared (background mode, staying on dashboard)');
        set({
          openProjects: new Map(openProjects),
          projectHistory: newHistory
        });
      } else {
        console.log('[Store] Tabs prepared, switching to workspace view');
        set({
          openProjects: new Map(openProjects),
          activeProjectId: projectId,
          view: 'workspace',
          isRestoring: false,
          projectHistory: newHistory
        });
      }

      saveSession();
    } else if (!background) {
      // PERF (2026-04-21): instrument the hot switch path. Time-to-next-frame tells
      // us how long React takes to paint after we flip activeProjectId.
      // Target after the Apr refactor: <50ms. Regression signal: durMs > 200.
      const prevActiveId = get().activeProjectId;
      const _t0 = performance.now();
      set({
        activeProjectId: projectId,
        view: 'workspace',
        projectHistory: newHistory
      });
      requestAnimationFrame(() => {
        const durMs = (performance.now() - _t0).toFixed(1);
        const tabCount = Array.from(get().openProjects.values())
          .reduce((acc, ws) => acc + ws.tabs.size, 0);
        console.warn(`[Perf:ProjectSwitch] from=${String(prevActiveId).slice(-12)} to=${projectId.slice(-12)} durMs=${durMs} totalTabs=${tabCount}`);
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

    const tabId = (options as any)?.restoreId || `${projectId}-tab-${workspace.tabCounter}`;
    log.tabs('createTab: tabId:', tabId, 'counter:', workspace.tabCounter, 'restored:', !!(options as any)?.restoreId);
    workspace.tabCounter++;

    // Smart naming: find next available name if not provided
    const existingNames = Array.from(workspace.tabs.values()).map(t => t.name);
    const tabName = name || getNextAvailableName('tab', existingNames);
    log.tabs('createTab: Using name:', tabName);

    const newTab: Tab = {
      id: tabId,
      name: tabName,
      cwd: cwd || (workspace.projectPath?.startsWith('__unset__') ? '' : workspace.projectPath) || process.env.HOME || '~',
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
      isCollapsed: (options as any)?.isCollapsed,
      nameSetManually: (options as any)?.nameSetManually,
      parentTabId: (options as any)?.parentTabId,
      mcpTaskId: (options as any)?.mcpTaskId,
      claudeTaskCount: (options as any)?.claudeTaskCount || 0,
      sessionStatus: (options as any)?.sessionStatus
    };

    // Claude SDK tabs don't need a PTY process
    if (newTab.tabType === 'claude-sdk') {
      console.log('[Store] createTab: SDK tab, skipping PTY for:', tabId);
    } else {
      console.log('[Store] createTab: Creating PTY terminal for:', tabId, 'cwd:', newTab.cwd);
      // Only pass initialCommand for shell-command type, not for internal commands
      const initialCommand = options?.pendingAction?.type === 'shell-command'
        ? options.pendingAction.command
        : undefined;

      const { pid } = await ipcRenderer.invoke('terminal:create', {
        tabId,
        projectId,
        cwd: newTab.cwd,
        rows: 24,
        cols: 80,
        initialCommand
      });

      console.log('[Store] createTab: PTY created with pid:', pid);
      newTab.pid = pid;
    }
    workspace.tabs.set(tabId, newTab);

    // Don't switch activeTabId during session restore or background creation
    const { isRestoring } = get();
    if (!isRestoring && !options?.background) {
      workspace.activeTabId = tabId;
      workspace.viewingSubAgentTabId = null;
      // Push to tab history (LRU, max 20)
      workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
    }

    console.log('[Store] createTab: Setting state, tabs count:', workspace.tabs.size, 'isRestoring:', isRestoring);

    // During restore, skip per-tab state updates and DB writes — openProject will batch them at the end
    if (!isRestoring) {
      // Only trigger rename for user-initiated tab creation without an explicit name
      const shouldEdit = !options?.background && !name;
      set({
        openProjects: new Map(openProjects),
        pendingEditTabId: shouldEdit ? tabId : null,
      });
      saveTabs(workspace.projectId, workspace.tabs);
    }

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
      cwd: cwd || (workspace.projectPath?.startsWith('__unset__') ? '' : workspace.projectPath) || process.env.HOME || '~',
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
      nameSetManually: (options as any)?.nameSetManually,
      createdAt: (options as any)?.createdAt || Math.floor(Date.now() / 1000)
    };

    // Only pass initialCommand for shell-command type, not for internal commands
    const initialCommand = options?.pendingAction?.type === 'shell-command'
      ? options.pendingAction.command
      : undefined;

    // Claude SDK tabs don't need a PTY process — mirror createTab's guard.
    // Without it, routing SDK fork through this function would spawn an unused
    // PTY (waste + потенциальные phantom lifecycle-сигналы для SDK-таба).
    if (newTab.tabType === 'claude-sdk') {
      console.log('[Store:createTabAfterCurrent] SDK tab, skipping PTY for:', tabId);
    } else {
      console.log('[Store:createTabAfterCurrent] Creating terminal with:', {
        tabId,
        cwd: newTab.cwd,
        pendingAction: options?.pendingAction,
        initialCommand
      });

      const { pid } = await ipcRenderer.invoke('terminal:create', {
        tabId,
        projectId,
        cwd: newTab.cwd,
        rows: 24,
        cols: 80,
        initialCommand
      });

      console.log('[Store:createTabAfterCurrent] Terminal created with pid:', pid);
      newTab.pid = pid;
    }

    // Insert after specified tab or current active tab (or at end if no active tab)
    const referenceTabId = options?.afterTabId || workspace.activeTabId;
    const tabsArray = Array.from(workspace.tabs.entries());
    const isUtility = options?.isUtility || false;

    // Find position: after reference tab in same zone, or at end of zone
    let insertIndex = tabsArray.length;

    if (referenceTabId && !isUtility) {
      // Find reference tab index
      const currentIndex = tabsArray.findIndex(([id]) => id === referenceTabId);
      if (currentIndex !== -1) {
        // Find the first utility tab to know where main zone ends
        const firstUtilityIndex = tabsArray.findIndex(([_, tab]) => tab.isUtility);
        if (firstUtilityIndex === -1) {
          // No utility tabs, insert right after reference
          insertIndex = currentIndex + 1;
        } else if (currentIndex < firstUtilityIndex) {
          // Reference is in main zone, insert after it but before utility zone
          insertIndex = Math.min(currentIndex + 1, firstUtilityIndex);
        }
      }
    } else if (referenceTabId && isUtility) {
      // Insert after reference utility tab
      const currentIndex = tabsArray.findIndex(([id]) => id === referenceTabId);
      if (currentIndex !== -1 && tabsArray[currentIndex]?.[1]?.isUtility) {
        insertIndex = currentIndex + 1;
      }
    }

    // Insert tab at calculated position
    tabsArray.splice(insertIndex, 0, [tabId, newTab]);
    workspace.tabs = new Map(tabsArray);

    if (!options?.background) {
      workspace.activeTabId = tabId;
      // Push to tab history (LRU, max 20)
      workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
    }

    // Only trigger rename for user-initiated tab creation without an explicit name
    const shouldEdit = !options?.background && !name && !options?.nameSetManually;
    set({
      openProjects: new Map(openProjects),
      pendingEditTabId: shouldEdit ? tabId : null,
    });

    // Save tabs
    saveTabs(workspace.projectId, workspace.tabs);

    return tabId;
  },

  closeTab: async (projectId, tabId, options) => {
    const { openProjects, clearTerminalBuffer } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return;

    const tab = workspace.tabs.get(tabId);
    const skipProcessCheck = options?.skipProcessCheck || false;
    // OSC 133 process state — captured before potential confirm() dialog so we
    // can persist whether the tab had a live CLI for Shift+Cmd+T reopen logic.
    let processWasRunning = false;

    if (!skipProcessCheck && tab?.tabType !== 'claude-sdk') {
      // Check if terminal has running process via OSC 133 state (fast, no syscalls)
      const commandState = await ipcRenderer.invoke('terminal:getCommandState', tabId);
      processWasRunning = !!commandState?.isRunning;

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
    } else if (tab?.tabType !== 'claude-sdk') {
      // skipProcessCheck path (programmatic close) — still need processWasRunning
      // for archive, so we read OSC 133 state without prompting.
      try {
        const cs = await ipcRenderer.invoke('terminal:getCommandState', tabId);
        processWasRunning = !!cs?.isRunning;
      } catch {}
    }
    // For SDK tabs, "running" means the SDK turn is mid-stream — we infer it
    // from claudeBusy which is the same signal SessionActionChip watches.
    if (tab?.tabType === 'claude-sdk') {
      processWasRunning = !!(tab as any).claudeBusy;
    }

    // Compute TabBar position at close time (excluding sub-agent / utility
    // tabs — they don't take a slot in the bar). Used as a placement hint by
    // reopenLastClosedTab.
    const orderedMainTabs = Array.from(workspace.tabs.values())
      .filter(t => !t.parentTabId && !t.isUtility);
    const closedPosition = orderedMainTabs.findIndex(t => t.id === tabId);

    // Stop SDK session if this is a claude-sdk tab + clear busy state.
    // HARD kill — closing the tab must fully terminate the process and all its
    // background agents (no orphans). A soft interrupt would leave the parked
    // session + bg workers alive with no UI to control them.
    if (tab?.tabType === 'claude-sdk') {
      ipcRenderer.invoke('claude-sdk:stop', { tabId, hard: true }).catch(() => {});
      ipcRenderer.send('claude-sdk:busy-state', { tabId, busy: false });
    }

    if (tab?.tabType !== 'claude-sdk') {
      ipcRenderer.send('terminal:kill', tabId);
    }
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
          geminiSessionId: tab.geminiSessionId,
          sessionStatus: tab.sessionStatus,
          position: closedPosition >= 0 ? closedPosition : null,
          processWasRunning,
        }
      }).catch(() => {});
    }

    workspace.tabs.delete(tabId);
    // Remove closed tab from history
    workspace.tabHistory = workspace.tabHistory.filter(id => id !== tabId);

    if (workspace.activeTabId === tabId) {
      // Find next tab from history (LRU: last visited that still exists and is not utility)
      let nextTabId: string | null = null;
      for (let i = workspace.tabHistory.length - 1; i >= 0; i--) {
        const candidateId = workspace.tabHistory[i];
        const candidate = workspace.tabs.get(candidateId);
        if (candidate && !candidate.isUtility) {
          nextTabId = candidateId;
          break;
        }
      }
      // Fallback: last Main tab if history didn't help
      if (!nextTabId) {
        const mainTabs = Array.from(workspace.tabs.values()).filter(t => !t.isUtility);
        if (mainTabs.length > 0) {
          nextTabId = mainTabs[mainTabs.length - 1].id;
        }
      }
      workspace.activeTabId = nextTabId;
    }

    // Use startTransition to prevent UI blocking
    startTransition(() => {
      set({ openProjects: new Map(openProjects) });
    });

    // Save tabs (forceCleanup when called from batch close)
    saveTabs(workspace.projectId, workspace.tabs, options?.forceCleanup);
  },

  // Shift+Cmd+T — pop the latest entry from tab_history for this project and
  // recreate it. Position is restored as a hint (clamped if surrounding tabs
  // changed). Claude/Gemini sessions auto-continue iff the underlying CLI was
  // still alive at close time; if the user had already stopped the process
  // before closing the tab, the restored tab just opens without firing claude-c.
  reopenLastClosedTab: async (projectId) => {
    const { openProjects, createTab, switchTab } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return { tabId: null, reason: 'error' };

    let resp: any;
    try {
      resp = await ipcRenderer.invoke('project:reopen-last-closed-tab', { projectId });
    } catch (err) {
      console.warn('[Reopen] IPC failed:', err);
      return { tabId: null, reason: 'error' };
    }
    const entry = resp?.entry;
    if (!entry) return { tabId: null, reason: 'empty' };

    // Decide pendingAction: only auto-continue when the process was actually
    // alive at close. Otherwise just open the tab in idle state — user can
    // press Continue manually from InfoPanel if they want to resume.
    const wasRunning = !!entry.process_was_running;
    let pendingAction: PendingAction | undefined;
    if (wasRunning) {
      if (entry.command_type === 'claude' && entry.claude_session_id) {
        pendingAction = { type: 'claude-continue', sessionId: entry.claude_session_id };
      } else if (entry.command_type === 'gemini' && entry.gemini_session_id) {
        pendingAction = { type: 'gemini-continue', sessionId: entry.gemini_session_id };
      } else if (entry.command_type === 'claude') {
        pendingAction = { type: 'claude-new' };
      } else if (entry.command_type === 'gemini') {
        pendingAction = { type: 'gemini-new' };
      }
    }

    // Compute insertion index using the saved position as a hint. Sub-agent /
    // utility tabs don't take a TabBar slot, so the index is over main tabs
    // only — same projection used in closeTab when we recorded the position.
    const mainTabIds = Array.from(workspace.tabs.values())
      .filter(t => !t.parentTabId && !t.isUtility)
      .map(t => t.id);
    const hinted = typeof entry.position === 'number' ? entry.position : mainTabIds.length;
    const targetIndex = Math.max(0, Math.min(mainTabIds.length, hinted));

    // createTab appends at the end of main zone — we then shuffle the new tab
    // into the saved slot by rebuilding the Map in the right order. This avoids
    // touching createTab itself, which has many call sites.
    const newTabId = await createTab(projectId, entry.name, entry.cwd, {
      color: (entry.color || undefined) as TabColor | undefined,
      notes: entry.notes || undefined,
      commandType: (entry.command_type || undefined) as CommandType | undefined,
      tabType: (entry.tab_type || 'terminal') as TabType,
      url: entry.url || undefined,
      pendingAction,
      claudeSessionId: entry.claude_session_id || undefined,
      geminiSessionId: entry.gemini_session_id || undefined,
      sessionStatus: entry.session_status || undefined,
    });

    // Re-order: pull the freshly-created tab out and splice it at targetIndex
    // inside the main zone (utility tabs always stay after main).
    const after = openProjects.get(projectId);
    if (after && newTabId) {
      const entries = Array.from(after.tabs.entries());
      const newEntryIdx = entries.findIndex(([id]) => id === newTabId);
      if (newEntryIdx !== -1) {
        const newEntry = entries[newEntryIdx];
        entries.splice(newEntryIdx, 1);

        // Find where the main zone ends (first utility tab) in the
        // post-removal array to clamp targetIndex inside it.
        const utilStart = entries.findIndex(([, t]) => t.isUtility);
        const mainEnd = utilStart === -1 ? entries.length : utilStart;
        const clamped = Math.min(targetIndex, mainEnd);
        entries.splice(clamped, 0, newEntry);
        after.tabs = new Map(entries);
        set({ openProjects: new Map(openProjects) });
        saveTabs(after.projectId, after.tabs);
      }
      switchTab(projectId, newTabId);
    }
    return { tabId: newTabId || null };
  },

  switchTab: (projectId, tabId) => {
    const { openProjects, saveSession } = get();
    const workspace = openProjects.get(projectId);

    if (workspace && workspace.tabs.has(tabId)) {
      // PERF (2026-04-21): instrument within-project tab switch. After the Apr
      // refactor the TerminalArea useMemo should NOT recalculate here — child
      // Terminals flip active state via their own store subscription.
      // Regression: durMs > 150 or [TerminalArea:useMemo RECALCULATING] on a
      // within-project switch means fingerprint regressed.
      const _t0 = performance.now();
      const prevActiveId = workspace.activeTabId;
      workspace.activeTabId = tabId;
      // Don't reset viewingSubAgentTabId here — it persists across tab switches.
      // User dismisses it explicitly via SubAgentBar "← Back" button or clicking the active chip.
      workspace.selectedTabIds = [tabId]; // Update selection on direct switch
      // Push to tab history (LRU, max 20)
      workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
      // Use startTransition to prevent UI blocking during re-render
      startTransition(() => {
        set({ openProjects: new Map(openProjects) });
      });
      requestAnimationFrame(() => {
        const durMs = (performance.now() - _t0).toFixed(1);
        console.warn(`[Perf:TabSwitch] project=${projectId.slice(-12)} from=${String(prevActiveId).slice(-12)} to=${tabId.slice(-12)} durMs=${durMs}`);
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
        tab.nameSetManually = true;
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

  setTabSessionStatus: (projectId, tabId, status) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;
    const tab = workspace.tabs.get(tabId);
    if (!tab) return;
    if (status === null) {
      delete tab.sessionStatus;
    } else {
      tab.sessionStatus = status;
    }
    set({ openProjects: new Map(openProjects) });
    saveTabs(workspace.projectId, workspace.tabs);
  },

  setTabCommandType: (tabId, commandType) => {
    const { openProjects } = get();

    // Find tab across all projects
    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        const prev = tab.commandType || 'null';
        const claudeSess = tab.claudeSessionId ? tab.claudeSessionId.slice(0, 8) : 'null';
        const geminiSess = tab.geminiSessionId ? tab.geminiSessionId.slice(0, 8) : 'null';
        const callerLine = (new Error().stack || '').split('\n').slice(2, 5).join(' | ');
        console.warn('[Store:setTabCommandType] tab=' + tabId.slice(-8) + ' ' + prev + ' → ' + commandType + ' | claude=' + claudeSess + ' gemini=' + geminiSess + ' | caller=' + callerLine);
        // Only set commandType and rename if not already set (first run only)
        const isFirstRun = !tab.commandType;
        tab.commandType = commandType;

        // Auto-rename on first run (skip if user renamed tab manually)
        if (isFirstRun && !tab.nameSetManually) {
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
    saveTabs(src.projectId, src.tabs, true);  // forceCleanup: intentional batch move
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
  setClaudeSessionId: (tabId, sessionId, reason = 'unknown') => {
    const { openProjects } = get();

    // Find tab across all projects
    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        // Skip if session ID unchanged (Bridge polls repeatedly with same ID)
        if (tab.claudeSessionId === sessionId) return;

        // Guard against TRUNCATED session IDs clobbering a good one. The
        // `userIntercept` path scrapes `claude --resume <id>` off the xterm
        // screen buffer; when the line wraps/renders partially it can capture a
        // prefix like "00581613-b3" (11 chars) instead of the full 36-char
        // UUID. Writing that corrupts tab.claudeSessionId — Timeline still
        // prefix-matches the JSONL so it "works", but the copy-session-id button
        // yields a broken id and /resume elsewhere fails. Empty string is a
        // legitimate CLEAR (timelineChain), so only validate non-empty values.
        // Reject anything that isn't a full UUID, and especially refuse to
        // replace an existing FULL uuid with a prefix of itself.
        if (sessionId) {
          const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!FULL_UUID.test(sessionId)) {
            const prev = tab.claudeSessionId || '';
            const isPrefixOfExisting = prev && prev.startsWith(sessionId);
            console.warn(
              '[Store:setClaudeSessionId] REJECT malformed sessionId "' + sessionId +
              '" (len=' + sessionId.length + ', reason=' + reason + ', tab=' + tabId.slice(-8) +
              ', prev=' + (prev ? prev.slice(0, 8) + '…' : 'null') +
              (isPrefixOfExisting ? ', is-prefix-of-existing' : '') + ') — not a full UUID, ignoring'
            );
            return;
          }
        }

        const caller = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
        const logEntry = { ts: Date.now(), tabId, from: (tab.claudeSessionId || 'null').substring(0, 8), to: sessionId.substring(0, 8), reason, caller };
        // Ring buffer: always available even if DevTools was closed
        const buf = ((window as any).__sessionLog = (window as any).__sessionLog || []);
        buf.push(logEntry);
        if (buf.length > 100) buf.shift();
        console.warn('[Store:setClaudeSessionId] ' + logEntry.from + ' -> ' + logEntry.to + ' | reason=' + reason + ' | tabId=' + tabId + ' | caller=' + caller);

        // History: push the OUTGOING id (the one we are overwriting). The
        // current value the user is moving TO is already in tab.claudeSessionId
        // after the assignment below — no point recording it twice. History is
        // capped at 5; older entries are dropped. Persisted in SQLite.
        const prev = tab.claudeSessionId;
        if (prev) {
          const hist = tab.claudeSessionHistory ? [...tab.claudeSessionHistory] : [];
          hist.unshift({ sessionId: prev, reason, at: Date.now() });
          tab.claudeSessionHistory = hist.slice(0, 5);
        }

        tab.claudeSessionId = sessionId;
        // Reset overlay flags when new session starts (so overlay shows again if interrupted)
        tab.wasInterrupted = false;
        tab.overlayDismissed = false;
        // Save to database so session persists across restarts
        saveTabs(workspace.projectId, workspace.tabs);
        // Trigger Zustand re-render so Workspace/Timeline pick up the new sessionId.
        // Guard above ensures this only fires on actual changes, not repeated Bridge polls.
        set({});
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
        // Guard: skip if unchanged (Sniper Watcher may fire with same ID)
        if (tab.geminiSessionId === sessionId) return;
        tab.geminiSessionId = sessionId;
        // Reset overlay flags when new session starts (so overlay shows again if interrupted)
        tab.wasInterrupted = false;
        tab.overlayDismissed = false;
        console.log(`[Workspace] Gemini session set for tab ${tabId}: ${sessionId} (reset overlay flags)`);
        saveTabs(workspace.projectId, workspace.tabs);
        set({});
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

  // MCP sub-agent tab management
  setTabParent: (tabId, parentTabId) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        // Detach: undefined or empty string both clear the parent
        tab.parentTabId = parentTabId || undefined;
        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectId, workspace.tabs);
        return;
      }
    }
  },

  getSubAgentTabs: (parentTabId) => {
    const { openProjects, activeProjectId } = get();
    // Scope to active project only — don't return sub-agents from other projects
    const workspace = activeProjectId ? openProjects.get(activeProjectId) : null;
    if (!workspace) return [];
    const result: Tab[] = [];
    for (const [, tab] of workspace.tabs) {
      if (tab.parentTabId === parentTabId) {
        result.push(tab);
      }
    }
    return result;
  },

  setViewingSubAgent: (tabId) => {
    const { openProjects, activeProjectId } = get();
    const workspace = activeProjectId ? openProjects.get(activeProjectId) : null;
    if (!workspace) return;
    if (workspace.viewingSubAgentTabId === tabId) return;
    workspace.viewingSubAgentTabId = tabId;
    set({ openProjects: new Map(openProjects) });
  },

  getEffectiveTabId: () => {
    const { openProjects, activeProjectId } = get();
    const workspace = activeProjectId ? openProjects.get(activeProjectId) : null;
    if (!workspace) return null;
    if (workspace.viewingSubAgentTabId) {
      const subTab = workspace.tabs.get(workspace.viewingSubAgentTabId);
      if (subTab) return workspace.viewingSubAgentTabId;
    }
    return workspace.activeTabId;
  },

  // Claude Agent orchestration status
  setClaudeAgentStatus: (tabId, status, sessionId) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.claudeAgentStatus = status;
        if (sessionId) tab.claudeAgentSessionId = sessionId;
        // Increment task counter on terminal states
        if (status === 'done' || status === 'error') {
          tab.claudeTaskCount = (tab.claudeTaskCount || 0) + 1;
        }
        set({ openProjects: new Map(openProjects) });
        return;
      }
    }
  },

  setClaudeActive: (tabId, alive) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.claudeActive = alive;
        set({ openProjects: new Map(openProjects) });
        return;
      }
    }
  },

  setClaudeBusy: (tabId, busy) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.claudeBusy = busy;
        set({ openProjects: new Map(openProjects) });
        return;
      }
    }
  },

  setSdkProcessAlive: (tabId, alive) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        if (tab.sdkProcessAlive === alive) return; // guard: no re-render if unchanged
        tab.sdkProcessAlive = alive;
        set({ openProjects: new Map(openProjects) });
        return;
      }
    }
  },

  setInterceptorState: (tabId: string, state: 'armed' | 'disarmed' | null) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        if (tab.interceptorState === state) return; // Guard: no re-render if unchanged
        tab.interceptorState = state;
        set({ openProjects: new Map(openProjects) });
        return;
      }
    }
  },

  // Tab notes
  setTabNotes: (tabId, notes) => {
    const { openProjects } = get();

    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        // Guard: skip if unchanged
        if (tab.notes === notes) return;
        tab.notes = notes;
        saveTabs(workspace.projectId, workspace.tabs);
        set({});
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

  // Browser tabs
  createBrowserTab: async (projectId) => {
    const { openProjects, createTab } = get();
    const workspace = openProjects.get(projectId);
    const projectPath = workspace?.projectPath;
    const cwd = (projectPath && !projectPath.startsWith('__unset__')) ? projectPath : (process.env.HOME || '~');
    return createTab(projectId, 'Browser', cwd, { tabType: 'browser', url: 'http://localhost:3000' });
  },

  updateTabUrl: (tabId, url) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        // Guard: skip if unchanged
        if (tab.url === url) return;
        tab.url = url;
        saveTabs(workspace.projectId, workspace.tabs);
        set({});
        return;
      }
    }
  },

  setBrowserActiveView: (tabId, view) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        tab.activeView = view;
        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectId, workspace.tabs);
        return;
      }
    }
  },

  // Claude SDK tabs
  createSDKTab: async (projectId, name) => {
    const { openProjects, createTabAfterCurrent } = get();
    const workspace = openProjects.get(projectId);
    const projectPath = workspace?.projectPath;
    const cwd = (projectPath && !projectPath.startsWith('__unset__')) ? projectPath : (process.env.HOME || '~');
    // Use the same naming scheme as PTY claude tabs ("claude", "claude-02", ...)
    // so SDK tabs are visually indistinguishable by name from regular ones; the
    // visual differentiation is the peach colour + missing RestartZone.
    // `name` override используется fork-операцией, чтобы скопировать имя
    // исходного таба + `_fork` (тот же договор, что forkToTab для PTY).
    const existingNames = workspace ? Array.from(workspace.tabs.values()).map(t => t.name) : [];
    const tabName = name || getNextAvailableName('claude', existingNames);
    // Insert AFTER the active tab (same convention as PTY fork via
    // createTabAfterCurrent) — раньше дёргали createTab, который пихал SDK-форк
    // в самый конец списка, и юзер был вынужден прокручивать сайдбар, чтобы
    // найти только что созданный таб. Юзер: «он должен создаваться не в конце,
    // а снизу от той сессии, которая сейчас активна».
    return createTabAfterCurrent(projectId, tabName, cwd, {
      tabType: 'claude-sdk',
      color: 'claude',
      commandType: 'claude',
      nameSetManually: true, // lock the auto-rename loop in setTabCommandType
    });
  },

  convertToSDKTab: (tabId) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        // Kill PTY
        ipcRenderer.send('terminal:kill', tabId);
        // Convert — keep the tab's existing name (it's already "claude" or "claude-02"
        // for PTY claude tabs; renaming it to "Claude SDK" creates an inconsistent
        // visual that fights the peach-tint differentiation). Only flip the type/color.
        tab.tabType = 'claude-sdk';
        tab.color = 'claude';
        tab.nameSetManually = true;
        tab.sdkState = 'idle';
        set({ openProjects: new Map(openProjects) });
        saveTabs(workspace.projectId, workspace.tabs);
        return;
      }
    }
  },

  updateSDKState: (tabId, state) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        // Guard: skip if all values unchanged (prevents polling spam re-renders)
        let changed = false;
        let sidChanged = false;
        for (const key of Object.keys(state) as (keyof typeof state)[]) {
          if ((tab as any)[key] !== state[key]) {
            changed = true;
            if (key === 'claudeSessionId') sidChanged = true;
          }
        }
        if (!changed) return;

        console.warn('[Store:updateSDKState] tabId=' + tabId + ' keys=' + Object.keys(state).join(',') + ' claudeSessionId=' + (state as any).claudeSessionId + ' sdkState=' + (state as any).sdkState);
        Object.assign(tab, state);
        // Persist sid to SQLite — without this an SDK tab loses its session
        // mapping on Electron restart (UI shows "Waiting for session" even
        // though JSONL exists on disk). Mirrors setClaudeSessionId; ephemeral
        // state (sdkState / sdkMessages) skip the disk write.
        if (sidChanged) saveTabs(workspace.projectId, workspace.tabs);
        set({}); // Trigger Zustand notify — primitive selectors detect change
        return;
      }
    }
    console.warn('[Store:updateSDKState] TAB NOT FOUND tabId=' + tabId);
  },

  upsertBgTask: (tabId, taskId, patch) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      const list = tab.bgTasks ? [...tab.bgTasks] : [];
      const idx = list.findIndex(t => t.taskId === taskId);
      const isTerminal = patch.status === 'completed' || patch.status === 'failed' || patch.status === 'stopped';
      if (idx === -1) {
        list.push({
          taskId,
          kind: patch.kind || 'agent',
          name: patch.name || taskId.slice(0, 8),
          status: patch.status || 'running',
          startedAt: patch.startedAt || Date.now(),
          ...patch,
          ...(isTerminal && !patch.endedAt ? { endedAt: Date.now() } : {}),
        } as BgTask);
      } else {
        list[idx] = {
          ...list[idx],
          ...patch,
          ...(isTerminal && !list[idx].endedAt && !patch.endedAt ? { endedAt: Date.now() } : {}),
        };
      }
      tab.bgTasks = list;
      set({}); // Notify primitive selectors
      return;
    }
  },

  removeBgTask: (tabId, taskId) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab || !tab.bgTasks) continue;
      tab.bgTasks = tab.bgTasks.filter(t => t.taskId !== taskId);
      set({});
      return;
    }
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

  // Clear stale interrupted states on shutdown (called via beforeunload).
  // ONLY clears — never marks. Marking is done by main process before-quit
  // which has access to claudeCliActive (actual running processes).
  // Renderer doesn't know which tabs are actively running vs just having commandType='claude'.
  markAllSessionsInterrupted: () => {
    const { openProjects } = get();
    let anyChanged = false;

    for (const [projectId, workspace] of openProjects) {
      let changed = false;
      for (const [tabId, tab] of workspace.tabs) {
        if (tab.wasInterrupted && !tab.overlayDismissed) {
          // CLEAR stale: was in "blue mode", user never clicked Continue
          tab.wasInterrupted = false;
          changed = true;
          anyChanged = true;
        }
      }
      if (changed) {
        // Save synchronously — saveTabs uses async invoke() which won't complete during pkill
        const tabsArray = Array.from(workspace.tabs.values()).map((tab) => ({
          name: tab.name, cwd: tab.cwd, color: tab.color, isUtility: tab.isUtility,
          commandType: tab.commandType, claudeSessionId: tab.claudeSessionId,
          geminiSessionId: tab.geminiSessionId, wasInterrupted: tab.wasInterrupted,
          overlayDismissed: tab.overlayDismissed, notes: tab.notes, tabType: tab.tabType,
          url: tab.url, terminalId: tab.terminalId, terminalName: tab.terminalName,
          activeView: tab.activeView, createdAt: tab.createdAt, isCollapsed: tab.isCollapsed,
          nameSetManually: tab.nameSetManually, parentTabId: tab.parentTabId,
          mcpTaskId: tab.mcpTaskId, claudeTaskCount: tab.claudeTaskCount || 0, tabId: tab.id
        }));
        ipcRenderer.sendSync('project:save-tabs-sync', { projectId: workspace.projectId, tabs: tabsArray });
      }
    }
    // Notify subscribers (future-proof: currently called at shutdown, but may be used elsewhere)
    if (anyChanged) set({});
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

  // Per-project view (Home vs Terminal)
  setProjectView: (projectId, view) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (workspace) {
      workspace.currentView = view;
      set({ openProjects: new Map(openProjects) });
    }
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

  setSidebarExpandedDirs: (projectId, expandedDirs) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (workspace) {
      workspace.sidebarExpandedDirs = expandedDirs;
      ipcRenderer.invoke('project:save-sidebar-expanded-dirs', {
        projectId,
        expandedDirs
      });
    }
  },

  getSidebarState: (projectId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (workspace) {
      return {
        sidebarOpen: workspace.sidebarOpen,
        openFilePath: workspace.openFilePath,
        sidebarExpandedDirs: workspace.sidebarExpandedDirs
      };
    }
    return { sidebarOpen: false, openFilePath: null, sidebarExpandedDirs: null };
  }
}));

if (typeof window !== 'undefined') {
  (window as any).useWorkspaceStore = useWorkspaceStore;
}

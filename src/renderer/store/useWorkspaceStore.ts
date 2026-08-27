import { create } from 'zustand';
import { startTransition } from 'react';
import { log } from '../utils/logger';
import { setPrefetched } from '../utils/sdkHistoryPrefetch';
import { hasPendingPromptQueueContinuation, usePromptQueueStore } from './usePromptQueueStore';
import { isOrchestrationCompletionBlocked } from './useOrchestrationStore';
import { shouldDeferTabCompletionNotification } from '../utils/tabCompletionDeferral.mjs';
import { useUIStore, type HistoryPromptDraftChip } from './useUIStore';
import { getInboxProjectPath, isInboxProjectId } from '../constants/systemProjects';
import { isNaturalAgentTurnEndReason } from '../utils/agentCompletionOutcome.mjs';
import { isAiForegroundProcess } from '../utils/aiForegroundProcess.mjs';
import { markRendererActivity } from '../utils/rendererActivityTrail';
import { setStartupRestoreProgress } from '../utils/startupRestoreProgress.mjs';
import {
  commitArchiveWithStopRetry,
  isDurableSaveTabsAck,
} from '../utils/tabPersistenceTransactions.mjs';
import {
  planCarriedCodexSettingsProofApplication,
  projectCodexSettingsProofOwner,
} from '../utils/codexSessionAdoption.mjs';
import {
  stopAiBeforeTerminalKill,
} from '../utils/terminalCloseLifecycle.mjs';
import {
  dropFromMru,
  dropProjectFromMru,
  touchMru,
  rebuildGlobalTabMru,
} from '../utils/tabSwitcherModel.mjs';
import { resolveSiblingInsertionIndex, resolveTabInsertionIndex } from '../utils/tabInsertionModel.mjs';
import {
  addEmptyPane,
  addEmptyPaneVertical,
  restorePanePreviousTab,
  addPane,
  isEmptyPane,
  removePaneAt,
  removePaneByTab,
  removePanesByProject,
  resolveSplitActivation,
  sanitizePanes,
  paneWithHistoryFrom,
  dropTabFromAllPaneHistories,
  dropTabFromAllPaneDetachedTabs,
  emptyPaneByClosedTab,
  rememberPaneDetachedTab,
  restorePaneDetachedTab,
  packSplitSizes,
  paneTabs,
  addTabToPane,
  moveTabsToPane,
  reorderPaneTab,
  replacePaneShownTab,
  dropTabFromAllPaneStrips,
  paneIndexHoldingTab,
  reprojectPaneTabs,
  insertIntoStrip,
  replaceInStrip,
  removeFromStrip,
  arrangePanes,
  swapPanes,
  allPaneTabIds,
  collapseLonePane,
} from '../utils/splitPanesModel.mjs';
import { moveEntriesToIndex } from '../utils/horizontalReorder.mjs';
import {
  addSpace,
  captureSpaceLayout,
  removeSpace as removeSpaceFromList,
  renameSpace as renameSpaceInList,
  reorderSpaces as reorderSpacesInList,
  restoreSpaces,
  spaceIndexHoldingTab,
  spaceTabCount,
  spaceTabIds,
  spaceBusyTabCount,
  switchSpace as switchSpaceInList,
  emptySpaceLayout,
  dropTabsFromOtherSpaces,
  reprojectTabsInSpaces,
  updateSpaceMetadata,
} from '../utils/workspaceSpacesModel.mjs';
import {
  CENTER_PANE_INDEX,
  PLACEMENT_ADD_HERE,
  PLACEMENT_DEFAULT,
  placementWorldFromState,
  resolveTabPlacement,
} from '../utils/tabPlacementResolver.mjs';
import {
  recoverWorkspaceSpaces as recoverWorkspaceSpacesModel,
  spacesWithLiveLayout,
  workspaceSpacesFingerprint,
} from '../utils/workspaceSpaceRecovery.mjs';
import { swapWorkspaceLayoutWindows } from '../utils/workspaceWindowSwapModel.mjs';
import {
  describeWorkspaceWindowTargets,
  resolveWorkspaceWindowTarget,
} from '../utils/workspaceWindowTarget.mjs';
import {
  applyWorkspaceWindowMutation as applyWorkspaceWindowMutationModel,
  dropTabsFromWorkspaceLayout,
} from '../utils/workspaceWindowMutation.mjs';
import { isVisitWorthRecording } from '../utils/tabVisitHistoryRule.mjs';
import { buildSessionSnapshot } from '../utils/sessionSnapshot.mjs';
import { resolvePtyAgentOwner } from '../utils/ptyAgentOwner.mjs';
import { createProjectTabSaveQueue } from '../utils/projectTabSaveQueue.mjs';
import { commitCreatedTabSnapshot } from '../utils/tabCreationCommit.mjs';

const { ipcRenderer } = window.require('electron');
let tabGroupSaveSeq = 0;
const SIDEBAR_SCROLL_SAVE_INTERVAL_MS = 150;
type SidebarScrollSaveState = {
  value: number;
  dirty: boolean;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};
// One throttle machine, two independent scroll surfaces (file sidebar and the
// tab list). Keyed by channel so a tab-list scroll never coalesces with a file
// tree scroll of the same project.
const scrollSaveStates = new Map<string, SidebarScrollSaveState>();

const SCROLL_SAVE_CHANNELS = {
  sidebar: 'project:save-sidebar-scroll-top',
  tabList: 'project:save-tab-list-scroll-top',
} as const;
type ScrollSaveSurface = keyof typeof SCROLL_SAVE_CHANNELS;

const scrollSaveKey = (surface: ScrollSaveSurface, projectId: string) => `${surface}:${projectId}`;

const flushScrollSave = (surface: ScrollSaveSurface, projectId: string) => {
  const state = scrollSaveStates.get(scrollSaveKey(surface, projectId));
  if (!state?.dirty) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.dirty = false;
  state.lastSentAt = Date.now();
  void ipcRenderer.invoke(SCROLL_SAVE_CHANNELS[surface], {
    projectId,
    scrollTop: state.value,
  }).catch((error: unknown) => {
    console.error('[Store] Failed to save scroll position:', { surface, projectId, error });
  });
};

const scheduleScrollSave = (surface: ScrollSaveSurface, projectId: string, scrollTop: number) => {
  const normalized = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const key = scrollSaveKey(surface, projectId);
  const state = scrollSaveStates.get(key) || {
    value: normalized,
    dirty: false,
    lastSentAt: 0,
    timer: null,
  };
  state.value = normalized;
  state.dirty = true;
  scrollSaveStates.set(key, state);

  const remaining = SIDEBAR_SCROLL_SAVE_INTERVAL_MS - (Date.now() - state.lastSentAt);
  if (remaining <= 0 && !state.timer) {
    flushScrollSave(surface, projectId);
    return;
  }
  if (!state.timer) {
    state.timer = setTimeout(() => flushScrollSave(surface, projectId), Math.max(0, remaining));
  }
};

const scheduleSidebarScrollSave = (projectId: string, scrollTop: number) =>
  scheduleScrollSave('sidebar', projectId, scrollTop);

// Shutdown flush. The throttle above keeps the last scroll position in memory
// for up to SIDEBAR_SCROLL_SAVE_INTERVAL_MS; on quit that pending write would
// be lost, so the sidebar reopened after restart at a stale offset. Async
// invoke() does not survive beforeunload — the pending values go out through
// the same synchronous channel the tab save uses.
export const flushScrollSavesSync = (): void => {
  for (const [key, state] of scrollSaveStates) {
    if (!state.dirty) continue;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.dirty = false;
    const separator = key.indexOf(':');
    const surface = key.slice(0, separator) as ScrollSaveSurface;
    const projectId = key.slice(separator + 1);
    if (!SCROLL_SAVE_CHANNELS[surface] || !projectId) continue;
    try {
      ipcRenderer.sendSync('project:save-scroll-top-sync', {
        surface,
        projectId,
        scrollTop: state.value,
      });
    } catch (error) {
      console.error('[Store] Failed to flush scroll position on shutdown:', { surface, projectId, error });
    }
  }
};

const restoreShortId = (id: unknown): string => String(id ?? 'null').slice(-12);
const restoreTabsSummary = (tabs: any[]): string => {
  const items = tabs.slice(0, 20).map((tab) => {
    const id = restoreShortId(tab?.tabId || tab?.id);
    const name = String(tab?.name || '').replace(/\s+/g, ' ').slice(0, 24);
    const type = tab?.tabType || 'terminal';
    const command = tab?.commandType || 'generic';
    return `${id}:${name}:${type}:${command}`;
  });
  return items.join(',') + (tabs.length > items.length ? `,+${tabs.length - items.length}` : '');
};

export type TabColor = 'default' | 'red' | 'yellow' | 'green' | 'blue' | 'purple' | 'claude' | 'gemini' | 'codex';

export type CommandType = 'generic' | 'devServer' | 'claude' | 'gemini' | 'codex';

// 'browser' убран 2026-08-17 вместе со встроенным браузером. В базе у старых
// вкладок это значение ещё может лежать — при загрузке оно приводится к
// 'terminal' (см. database.js), поэтому здесь его быть уже не должно.
export type TabType = 'terminal' | 'claude-sdk' | 'file';

export interface TabTaskPlanSubtask {
  id: string;
  title: string;
}

export interface TabTaskPlanItem {
  id: string;
  title: string;
  statusId?: string;
  subtasks: TabTaskPlanSubtask[];
}

export interface TabTaskPlanArchivedItem extends TabTaskPlanItem {
  archivedAt: number;
}

export interface TabTaskPlanHistoryEntry {
  items: TabTaskPlanItem[];
  archivedItems: TabTaskPlanArchivedItem[];
  at: number;
  source: string;
}

export interface TabTaskPlanDocument {
  version: 1;
  revision: number;
  items: TabTaskPlanItem[];
  archivedItems: TabTaskPlanArchivedItem[];
  history: {
    past: TabTaskPlanHistoryEntry[];
    future: TabTaskPlanHistoryEntry[];
  };
  updatedAt: number | null;
  updatedBy: string | null;
}

export type TabTaskPlanOperation =
  | { type: 'replace_plan'; tasks: Array<Partial<TabTaskPlanItem> & { title: string }> }
  | { type: 'add_task'; id?: string; title: string; statusId?: string | null; subtasks?: Array<Partial<TabTaskPlanSubtask> & { title: string }>; afterTaskId?: string }
  | { type: 'update_task'; taskId: string; title?: string; statusId?: string | null }
  | { type: 'remove_task'; taskId: string }
  | { type: 'archive_task'; taskId: string }
  | { type: 'restore_task'; taskId: string }
  | { type: 'add_subtask'; taskId: string; id?: string; title: string; afterSubtaskId?: string }
  | { type: 'update_subtask'; taskId: string; subtaskId: string; title: string }
  | { type: 'remove_subtask'; taskId: string; subtaskId: string };

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
  | 'historyContext'
  | 'restoredFromDb'
  | 'userRevert'
  | 'unknown';

export type CodexSessionWriteReason =
  | 'detected'
  | 'userIntercept'
  | 'editRange'
  | 'deleteRange'
  | 'historyContext'
  | 'unknown';

export interface CodexSessionAdoptionOptions {
  carryCodexSettingsProof?: boolean;
  codexSettingsProof?: {
    model: string;
    effort: string;
    proofAt: number;
    fast?: boolean;
  } | null;
  codexSettingsProofInvalid?: boolean;
}

export interface SessionHistoryEntry {
  sessionId: string;
  reason: SessionWriteReason;
  at: number; // Date.now() millis
}

export interface TabGroup {
  id: string;
  name: string;
  createdAt: number;
  anchorTabId?: string;
  collapsed?: boolean;
  color?: TabColor;
  sessionStatus?: string;
}

const dndShortId = (id: unknown): string => {
  const text = String(id ?? 'null');
  return text.length > 12 ? text.slice(-12) : text;
};

const reprojectCenterStripOwners = (
  strips: Record<string, Array<{ projectId: string; tabId: string }>>,
  moved: (tabId: string) => boolean,
  projectId: string,
) => Object.fromEntries(Object.entries(strips || {}).map(([key, entries]) => [
  key,
  (entries || []).map((entry) => moved(entry.tabId) ? { projectId, tabId: entry.tabId } : entry),
]));

const dndShortValue = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return dndShortId(value);
};

const summarizeDndIds = (ids: unknown[]): string =>
  ids.map(dndShortId).join('>') || '-';

const summarizeDndAssignments = (assignments: Record<string, string | null | undefined>): string => {
  const entries = Object.entries(assignments);
  if (entries.length === 0) return '-';
  return entries
    .map(([id, value]) => `${dndShortId(id)}=${dndShortValue(value)}`)
    .join(',');
};

const summarizeDndGroupMembers = (membersByGroup: Map<string, string[]>): string => {
  const entries = Array.from(membersByGroup.entries());
  if (entries.length === 0) return '-';
  return entries
    .map(([groupId, ids]) => `${dndShortId(groupId)}[${summarizeDndIds(ids)}]`)
    .join(';');
};

const summarizeDndGroups = (groups: TabGroup[]): string => {
  if (groups.length === 0) return '-';
  return groups
    .map(group => `${dndShortId(group.id)}(anchor=${dndShortValue(group.anchorTabId)},c=${group.collapsed ? 1 : 0})`)
    .join(';');
};

export interface AiLaunchSnapshot {
  sessionType: 'claude' | 'codex';
  autoTitleEligible?: boolean;
  autoTitleMode?: AutoTabTitleMode;
  autoTitleSourceSessionId?: string;
  commandType?: CommandType;
  name: string;
  color?: TabColor;
  colorSetManually?: boolean;
  nameSetManually?: boolean;
  claudeSessionId?: string;
  geminiSessionId?: string;
  codexSessionId?: string;
  wasInterrupted?: boolean;
  overlayDismissed?: boolean;
  at: number;
}

export type AutoTabTitleTool = 'claude' | 'codex';
export type AutoTabTitleMode = 'fresh' | 'fork';

export interface PendingAutoTabTitle {
  toolType: AutoTabTitleTool;
  sessionId: string;
  mode: AutoTabTitleMode;
  sourceSessionId?: string;
  at: number;
}

interface AutoTabTitleIntent {
  toolType: AutoTabTitleTool;
  mode: AutoTabTitleMode;
  sourceSessionId?: string;
  at: number;
}

const aiLaunchSnapshots = new Map<string, AiLaunchSnapshot>();
const pendingAutoTabTitles = new Map<string, PendingAutoTabTitle>();
const autoTabTitleIntents = new Map<string, AutoTabTitleIntent>();

export interface PendingAutoTabTitleRegistration extends PendingAutoTabTitle {
  tabId: string;
}

type PendingAutoTabTitleListener = (pending: PendingAutoTabTitleRegistration[]) => void;
const pendingAutoTabTitleListeners = new Set<PendingAutoTabTitleListener>();
let pendingAutoTabTitleNotifyQueued = false;

const pendingAutoTabTitleSnapshot = (): PendingAutoTabTitleRegistration[] => (
  Array.from(pendingAutoTabTitles, ([tabId, pending]) => ({ tabId, ...pending }))
);

const notifyPendingAutoTabTitleListeners = (): void => {
  // Arm happens before setClaude/CodexSessionId finishes its store write. A
  // synchronous listener would inspect the old tab binding and clear the new
  // registration as a mismatch. One coalesced microtask observes the committed
  // session id without introducing a timer or polling loop.
  if (pendingAutoTabTitleNotifyQueued) return;
  pendingAutoTabTitleNotifyQueued = true;
  queueMicrotask(() => {
    pendingAutoTabTitleNotifyQueued = false;
    const snapshot = pendingAutoTabTitleSnapshot();
    pendingAutoTabTitleListeners.forEach((listener) => listener(snapshot));
  });
};

export const subscribePendingAutoTabTitles = (listener: PendingAutoTabTitleListener): (() => void) => {
  pendingAutoTabTitleListeners.add(listener);
  listener(pendingAutoTabTitleSnapshot());
  return () => pendingAutoTabTitleListeners.delete(listener);
};

const setAutoTabTitleIntent = (
  tabId: string,
  toolType: AutoTabTitleTool,
  mode: AutoTabTitleMode,
  sourceSessionId?: string
): void => {
  autoTabTitleIntents.set(tabId, {
    toolType,
    mode,
    sourceSessionId,
    at: Date.now(),
  });
  console.warn(
    '[Store:AutoTabTitleIntent] set tab=' + tabId.slice(-8) +
    ' type=' + toolType +
    ' mode=' + mode +
    (sourceSessionId ? ' source=' + sourceSessionId.slice(0, 8) : '')
  );
};

const getAutoTabTitleIntent = (tabId: string, toolType: AutoTabTitleTool): AutoTabTitleIntent | null => {
  const intent = autoTabTitleIntents.get(tabId);
  if (!intent) return null;

  if (intent.toolType !== toolType) return null;
  return intent;
};

const clearPendingAutoTabTitle = (tabId: string, reason: string): void => {
  const pending = pendingAutoTabTitles.get(tabId);
  if (!pending) return;
  pendingAutoTabTitles.delete(tabId);
  notifyPendingAutoTabTitleListeners();
  console.warn(
    '[Store:AutoTabTitle] clear tab=' + tabId.slice(-8) +
    ' type=' + pending.toolType +
    ' sid=' + pending.sessionId.slice(0, 8) +
    ' mode=' + pending.mode +
    ' reason=' + reason
  );
};

const armPendingAutoTabTitle = (
  tabId: string,
  toolType: AutoTabTitleTool,
  sessionId: string,
  options: { mode?: AutoTabTitleMode; sourceSessionId?: string } = {}
): void => {
  const mode = options.mode || 'fresh';
  pendingAutoTabTitles.set(tabId, {
    toolType,
    sessionId,
    mode,
    sourceSessionId: options.sourceSessionId,
    at: Date.now(),
  });
  notifyPendingAutoTabTitleListeners();
  console.warn(
    '[Store:AutoTabTitle] arm tab=' + tabId.slice(-8) +
    ' type=' + toolType +
    ' sid=' + sessionId.slice(0, 8) +
    ' mode=' + mode +
    (options.sourceSessionId ? ' source=' + options.sourceSessionId.slice(0, 8) : '')
  );
};

const getAutoTabTitleArmSkipReason = (
  tabId: string,
  toolType: AutoTabTitleTool,
  prevSessionId: string | undefined,
  nextSessionId: string
): string | null => {
  if (!nextSessionId) return 'empty-session';
  if (prevSessionId) return 'existing-session';
  const snapshot = aiLaunchSnapshots.get(tabId);
  if (!snapshot) return 'no-snapshot';
  if (snapshot.sessionType !== toolType) return 'snapshot-type-' + snapshot.sessionType;
  if (snapshot.autoTitleEligible !== true) return 'not-eligible';
  if (snapshot.nameSetManually) return 'manual-name';
  return null;
};

const logAutoTabTitleArmSkip = (
  tabId: string,
  toolType: AutoTabTitleTool,
  prevSessionId: string | undefined,
  nextSessionId: string,
  reason: string
): void => {
  const snapshot = aiLaunchSnapshots.get(tabId);
  console.warn(
    '[Store:AutoTabTitle] skip-arm tab=' + tabId.slice(-8) +
    ' type=' + toolType +
    ' sid=' + (nextSessionId ? nextSessionId.slice(0, 8) : 'null') +
    ' reason=' + reason +
    ' prev=' + (prevSessionId ? prevSessionId.slice(0, 8) : 'null') +
    ' snapshot=' + (snapshot
      ? JSON.stringify({
          type: snapshot.sessionType,
          eligible: snapshot.autoTitleEligible === true,
          manual: snapshot.nameSetManually === true,
          name: snapshot.name,
        })
      : 'null')
  );
};

const shouldAttemptAutoTabTitleArmForSessionWrite = (reason: string): boolean => {
  return ![
    'autoResume',
    'userIntercept',
    'userManual',
    'timelineChain',
    'restoredFromDb',
    'userRevert',
    'editRange',
    'deleteRange',
    'api-edit-range',
    'api-delete-range',
  ].includes(reason);
};

const maybeArmPendingAutoTabTitle = (
  tabId: string,
  toolType: AutoTabTitleTool,
  prevSessionId: string | undefined,
  nextSessionId: string,
  tabNameSetManually: boolean,
  reason: string
): void => {
  if (!shouldAttemptAutoTabTitleArmForSessionWrite(reason)) return;

  const snapshot = aiLaunchSnapshots.get(tabId);
  const intent = getAutoTabTitleIntent(tabId, toolType);
  if ((!snapshot || snapshot.sessionType !== toolType) && !intent) return;

  const armSkipReason = getAutoTabTitleArmSkipReason(tabId, toolType, prevSessionId, nextSessionId);
  if (armSkipReason === null) {
    armPendingAutoTabTitle(tabId, toolType, nextSessionId, {
      mode: snapshot?.autoTitleMode || 'fresh',
      sourceSessionId: snapshot?.autoTitleSourceSessionId,
    });
    console.warn(
      '[Store:AutoTabTitle] arm-via-session-write tab=' + tabId.slice(-8) +
      ' type=' + toolType +
      ' sid=' + nextSessionId.slice(0, 8) +
      ' reason=' + reason
    );
    return;
  }

  if ((armSkipReason === 'no-snapshot' || armSkipReason === 'not-eligible')
      && intent
      && !prevSessionId
      && !tabNameSetManually) {
    armPendingAutoTabTitle(tabId, toolType, nextSessionId, {
      mode: intent.mode,
      sourceSessionId: intent.sourceSessionId,
    });
    console.warn(
      '[Store:AutoTabTitle] arm-via-intent tab=' + tabId.slice(-8) +
      ' type=' + toolType +
      ' sid=' + nextSessionId.slice(0, 8) +
      ' mode=' + intent.mode +
      (intent.sourceSessionId ? ' source=' + intent.sourceSessionId.slice(0, 8) : '') +
      ' originalSkip=' + armSkipReason +
      ' reason=' + reason
    );
    return;
  }

  logAutoTabTitleArmSkip(tabId, toolType, prevSessionId, nextSessionId, armSkipReason + ':session-write-' + reason);
};

const getPendingAutoTabTitle = (tabId: string, toolType: AutoTabTitleTool, sessionId: string): PendingAutoTabTitle | null => {
  const pending = pendingAutoTabTitles.get(tabId);
  if (!pending) return null;

  if (pending.toolType !== toolType || pending.sessionId !== sessionId) {
    clearPendingAutoTabTitle(tabId, 'mismatch');
    return null;
  }

  return pending;
};

const consumePendingAutoTabTitle = (tabId: string, toolType: AutoTabTitleTool, sessionId: string): boolean => {
  const pending = getPendingAutoTabTitle(tabId, toolType, sessionId);
  if (!pending) return false;

  pendingAutoTabTitles.delete(tabId);
  autoTabTitleIntents.delete(tabId);
  notifyPendingAutoTabTitleListeners();
  console.warn(
    '[Store:AutoTabTitle] consume tab=' + tabId.slice(-8) +
    ' type=' + toolType +
    ' sid=' + sessionId.slice(0, 8) +
    ' mode=' + pending.mode
  );
  return true;
};

const isPendingAiForkLaunch = (commandType: CommandType, pendingAction?: PendingAction): boolean => {
  if (!pendingAction) return false;
  return (commandType === 'claude'
      && (pendingAction.type === 'claude-fork' || pendingAction.type === 'claude-compact-fork'))
    || (commandType === 'codex'
      && (pendingAction.type === 'codex-fork' || pendingAction.type === 'codex-compact-fork'));
};

// Helper: Check if tab has an interrupted AI session that can be resumed
export const isTabInterrupted = (tab: { wasInterrupted?: boolean; claudeSessionId?: string; geminiSessionId?: string; codexSessionId?: string }): boolean => {
  return !!(tab.wasInterrupted && (tab.claudeSessionId || tab.geminiSessionId || tab.codexSessionId));
};

// Typed pending action - executed after terminal is ready
export interface PendingAction {
  type: 'claude-fork' | 'claude-compact-fork' | 'claude-continue' | 'claude-new' | 'gemini-fork' | 'gemini-continue' | 'gemini-new' | 'codex-fork' | 'codex-compact-fork' | 'codex-continue' | 'codex-new' | 'shell-command';
  sessionId?: string;    // For AI fork/continue actions
  sourceSessionId?: string; // Original branch for pre-created compact forks
  command?: string;      // For shell-command
  developerInstructions?: string; // Codex external-run launch config
}

export interface TabHistoryRestoreEntry {
  id: number;
  project_id: string;
  tab_id?: string | null;
  name: string;
  name_set_manually?: number | null;
  cwd: string;
  color?: string | null;
  notes?: string | null;
  task_plan?: string | null;
  command_type?: string | null;
  tab_type?: string | null;
  file_path?: string | null;
  claude_session_id?: string | null;
  gemini_session_id?: string | null;
  codex_session_id?: string | null;
  codex_model?: string | null;
  codex_effort?: string | null;
  codex_settings_proof_at?: number | null;
  codex_settings_proof_session_id?: string | null;
  codex_model_migration_pending?: number | boolean | null;
  codex_model_migration_restore_default_model?: number | boolean | null;
  codex_model_migration_restore_default_effort?: number | boolean | null;
  codex_model_migration_source_model?: string | null;
  codex_model_migration_source_effort?: string | null;
  codex_model_migration_target_model?: string | null;
  codex_model_migration_config_path?: string | null;
  codex_model_migration_config_fingerprint?: string | null;
  codex_model_migration_config_already_target?: number | boolean | null;
  position?: number | null;
  process_was_running?: number | boolean | null;
  session_status?: string | null;
  group_id?: string | null;
  window_scoped?: number | boolean | null;
}

export interface TabHistoryRestoreResult {
  tabId: string | null;
  historyId?: number;
  reason?: 'empty' | 'busy' | 'cancelled' | 'error';
  message?: string;
  cwd?: string;
  fallbackFrom?: string;
  historyDeleteFailed?: boolean;
}

interface TabHistoryRestoreOptions {
  background?: boolean;
  restorePosition?: boolean;
  resumePolicy?: 'never' | 'always' | 'if-process-was-running';
  expectedTabId?: string;
  requireExactCwd?: boolean;
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
  isUtility?: boolean; // Legacy persistence field; restored and saved as false.
  tabType?: TabType; // Terminal, Claude SDK, or linked file tab
  filePath?: string; // Absolute file path for linked file tabs
  createdAt?: number; // Timestamp when tab was created
  /**
   * When this tab was last ACTIVATED (ms epoch). Durable recency for the
   * Ctrl+Tab / Cmd+P switcher: that order is global across projects, so it
   * cannot live in a per-project visit array that restore rebuilds empty.
   * Persisted in tabs.last_activated_at with never-downgrade semantics.
   */
  lastActivatedAt?: number;
  claudeSessionId?: string; // Active Claude Code session UUID (detected from terminal output)
  geminiSessionId?: string; // Active Gemini CLI session ID (detected via Sniper Watcher)
  codexSessionId?: string; // Active Codex CLI session ID (detected from ~/.codex/sessions JSONL)
  codexModel?: string; // Per-tab Codex model selection for ControlBar launches
  codexEffort?: string; // Per-tab Codex reasoning effort selection for ControlBar launches
  codexLiveModel?: string; // Transient current-conversation model; never persisted
  codexLiveEffort?: string; // Ultra is conversation-only and lives here
  codexLiveSettingsSessionId?: string; // Exact writer that owns the transient pair
  codexLiveServiceTier?: string; // Exact live tier; never read from mutable global config
  codexLiveServiceTierSessionId?: string; // Exact launch generation or rollout that owns the proof
  codexLiveServiceTierSource?: string; // Verified composer footer or exact /fast acknowledgement
  codexSettingsProofAt?: number; // Time of latest launch/picker/turn_context proof
  codexSettingsProofSessionId?: string; // Session that owns the settings proof
  codexModelMigrationPending?: boolean; // Old launch pair was invalidated before native migration Enter
  codexModelMigrationRestoreDefaultModel?: boolean; // Durable provenance for crash recovery
  codexModelMigrationRestoreDefaultEffort?: boolean;
  codexModelMigrationSourceModel?: string;
  codexModelMigrationSourceEffort?: string;
  codexModelMigrationTargetModel?: string;
  codexModelMigrationConfigPath?: string;
  codexModelMigrationConfigFingerprint?: string;
  codexModelMigrationConfigAlreadyTarget?: boolean;
  externalRun?: {
    runId?: string;
    provider?: 'codex' | 'claude' | 'gemini' | string;
    source?: string;
    conversationKey?: string;
    status?: string;
    startedAt?: number;
    completedAt?: number;
    autoStopAt?: number | null;
    autoStopMs?: number | null;
    autoCloseAt?: number | null;
    autoCloseMs?: number | null;
    collapsed?: boolean;
    sessionId?: string | null;
  };
  pendingAction?: PendingAction; // Action to execute when terminal is ready
  wasInterrupted?: boolean; // True if tab was closed with active AI session (show resume overlay)
  overlayDismissed?: boolean; // True if user dismissed the interrupted overlay (don't show again)
  notes?: string; // Tab-specific notes
  taskPlan?: TabTaskPlanDocument; // Structured two-level plan shown above the terminal
  restoreError?: {
    type: 'working_directory_missing' | 'terminal_create_failed';
    message: string;
    cwd?: string;
    at: number;
  };
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
  /**
   * Completion notification state for right-click "bell" on a tab.
   * persistent is saved to SQLite; armed/fired are runtime-only so an app
   * restart never resurrects stale "waiting" or "completed" frames.
   */
  completionNotificationPersistent?: boolean;
  completionNotificationArmed?: boolean;
  completionNotificationFired?: boolean;
  completionNotificationFiredAt?: number;
  /**
   * Restart-after AI triggers for ordinary terminal tabs.
   * restartAfterTabIds is the multi-select trigger list; restartAfterTabId is
   * kept as a legacy first-trigger mirror for older persisted rows and main-side
   * compatibility. Target list and command survive restarts. paused keeps the
   * selection visible but disables the side effect; armed/persistent are legacy
   * bell-mode fields cleaned up when touched.
   */
  restartAfterTabId?: string;
  restartAfterTabIds?: string[];
  restartAfterCommand?: string;
  restartAfterPaused?: boolean;
  restartAfterPersistent?: boolean;
  restartAfterArmed?: boolean;
  groupId?: string; // One-level TabBar group membership. Separate from parentTabId (sub-agents).
  visualParentTabId?: string; // Visual-only tab nesting in TabBar. Never use for MCP sub-agents.
  /**
   * Created by a gesture inside a pane/centre strip. That window strip is the
   * primary navigation surface, so the sidebar may hide this tab while it
   * still has a window placement. Durable so restart does not duplicate it in
   * the sidebar again.
   */
  windowScoped?: boolean;
  isCollapsed?: boolean; // Collapsed tab — icon-only, for archiving completed sessions
  claudeActive?: boolean; // True if Claude CLI is running inside PTY (not just shell alive)
  claudeBusy?: boolean; // True if Claude CLI spinner is active (from claude:busy-state)
  aiBusy?: boolean; // True when this AI tab is actively streaming/thinking (Claude/SDK/Gemini/Codex)
  aiClosing?: boolean; // Short-lived UI state while close waits for graceful AI stop
  /**
   * Долгая операция НАД вкладкой, пока её результата ещё не видно.
   *
   * Подменяет название карточки на подпись и крутит тот же кружок, что при
   * закрытии. Существует потому, что «форк» и «компакт» из меню сначала копируют
   * файл переписки — секунды на большой сессии — и всё это время не происходит
   * ничего видимого: юзер: *«до момента появления новой вкладки нужен лоадер…
   * название заменять на надпись, типа „делается форк"»*.
   *
   * Хранится на ИСХОДНОЙ вкладке: новой ещё нет, а спрашивают именно с той, по
   * которой кликнули. Не сохраняется в базу — операция короче жизни приложения,
   * и восстановленная «делается форк» была бы ложью.
   */
  pendingOperation?: string;
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
  sdkMidstreamPending?: Array<{
    text: string;
    ts: number;
    state: 'queued' | 'sent';
    rawText?: string;
    chips?: HistoryPromptDraftChip[];
  }>;
  /**
   * Authoring-only prompt/paste chips for the SDK composer. This stays outside
   * assistant-ui's transport text so temporary footer replacements and project
   * switches cannot flatten or discard the draft.
   */
  sdkComposerChips?: HistoryPromptDraftChip[];
  /**
   * Per-tab provider/model selection for the Claude proxy. Persisted via SQLite
   * (tabs.provider_state JSON). Authoritative writer is main process — it owns
   * `providerStates` Map and writes the row directly through DB on every
   * provider:switch / provider:set-options. This field on the Tab is the
   * cached projection: read on tabs load. Full saveTabs writes preserve the
   * newer main-owned DB value, so this potentially stale projection cannot
   * roll back a point-write.
   * Default (undefined / {type:'anthropic'} with no extras) means "subscription
   * Claude API, model picked by Claude TUI itself".
   */
  providerState?: {
    type: string;
    model?: string;
    effort?: string;
    thinking?: string;
    startupModel?: string;
    startupEffort?: string;
  };
  // Background tasks: live state for Agent/Bash subagents and background bash
  // commands that have been moved off the foreground turn. Populated from SDK
  // task_started / task_progress / task_updated / task_notification events.
  // NOT persisted: rebuilt from JSONL on next session open via getSubagentMessages.
  bgTasks?: BgTask[];
}

const getRestartAfterTriggerIds = (tab: Pick<Tab, 'id' | 'restartAfterTabId' | 'restartAfterTabIds'> | null | undefined): string[] => {
  if (!tab) return [];
  const out: string[] = [];
  const push = (value: unknown) => {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id === tab.id || out.includes(id)) return;
    out.push(id);
  };
  if (Array.isArray(tab.restartAfterTabIds)) {
    for (const id of tab.restartAfterTabIds) push(id);
  }
  push(tab.restartAfterTabId);
  return out;
};

const logRestartAfterState = (
  action: 'target' | 'command' | 'paused',
  projectId: string,
  tab: Pick<Tab, 'id' | 'restartAfterTabId' | 'restartAfterTabIds' | 'restartAfterCommand' | 'restartAfterPaused'>,
) => {
  console.info(
    '[RestartAfter:Store] action=' + action
    + ' project=' + projectId
    + ' target=' + String(tab.id || '').slice(-8)
    + ' triggers=' + JSON.stringify(getRestartAfterTriggerIds(tab).map((id) => id.slice(-8)))
    + ' paused=' + (tab.restartAfterPaused === true)
    + ' command=' + JSON.stringify(tab.restartAfterCommand || '')
  );
};

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
  tabGroups: TabGroup[];
  activeTabId: string | null;
  activeGroupId: string | null;
  selectedTabIds: string[]; // List of selected tab IDs for multi-action
  tabHistory: string[]; // LRU stack of tab IDs (max 20) for navigation on close
  tabCounter: number;
  sidebarOpen: boolean;
  openFilePath: string | null;
  sidebarExpandedDirs: Record<string, boolean> | null;
  sidebarScrollTop: number;
  tabListScrollTop: number; // Vertical scroll of the tab list, per project
  currentView: 'terminal' | 'home'; // Per-project view state (Home vs Terminal)
  viewingSubAgentTabId: string | null; // When viewing a sub-agent, points to the Claude sub-agent tab
}

const restoreTabOptions = (savedTab: any) => ({
  color: savedTab.color,
  isUtility: false,
  commandType: savedTab.commandType,
  claudeSessionId: savedTab.claudeSessionId,
  geminiSessionId: savedTab.geminiSessionId,
  codexSessionId: savedTab.codexSessionId,
  codexModel: savedTab.codexModel,
  codexEffort: savedTab.codexEffort,
  codexSettingsProofAt: savedTab.codexSettingsProofAt,
  codexSettingsProofSessionId: savedTab.codexSettingsProofSessionId,
  codexModelMigrationPending: savedTab.codexModelMigrationPending,
  codexModelMigrationRestoreDefaultModel: savedTab.codexModelMigrationRestoreDefaultModel,
  codexModelMigrationRestoreDefaultEffort: savedTab.codexModelMigrationRestoreDefaultEffort,
  codexModelMigrationSourceModel: savedTab.codexModelMigrationSourceModel,
  codexModelMigrationSourceEffort: savedTab.codexModelMigrationSourceEffort,
  codexModelMigrationTargetModel: savedTab.codexModelMigrationTargetModel,
  codexModelMigrationConfigPath: savedTab.codexModelMigrationConfigPath,
  codexModelMigrationConfigFingerprint: savedTab.codexModelMigrationConfigFingerprint,
  codexModelMigrationConfigAlreadyTarget: savedTab.codexModelMigrationConfigAlreadyTarget,
  externalRun: savedTab.externalRun,
  wasInterrupted: savedTab.wasInterrupted,
  overlayDismissed: savedTab.overlayDismissed,
  notes: savedTab.notes,
  taskPlan: savedTab.taskPlan,
  tabType: savedTab.tabType,
  filePath: savedTab.filePath,
  createdAt: savedTab.createdAt,
  isCollapsed: savedTab.isCollapsed,
  groupId: savedTab.groupId,
  visualParentTabId: savedTab.visualParentTabId,
  windowScoped: savedTab.windowScoped,
  sessionStatus: savedTab.sessionStatus,
  completionNotificationPersistent: savedTab.completionNotificationPersistent,
  restartAfterTabId: savedTab.restartAfterTabId,
  restartAfterTabIds: savedTab.restartAfterTabIds,
  restartAfterCommand: savedTab.restartAfterCommand,
  restartAfterPaused: savedTab.restartAfterPaused,
  restartAfterPersistent: savedTab.restartAfterPersistent,
  restartAfterArmed: savedTab.restartAfterArmed,
  nameSetManually: savedTab.nameSetManually,
  // Carried through restore so the switcher can rebuild the visit order from
  // the tabs themselves. Dropping it here would leave every restored tab
  // unstamped and put us straight back to "only the current project is ranked".
  lastActivatedAt: savedTab.lastActivatedAt,
  // The tab's session-id history, so "Revert Session" still has something to
  // offer after a restart. A restart is exactly when it is needed most: a
  // hijacked session id survives one, and until now the way back did not.
  claudeSessionHistory: savedTab.claudeSessionHistory,
  restoreId: savedTab.tabId
} as any);

const parseRestoreError = (err: any, fallbackCwd?: string) => {
  const raw = String(err?.message || err?.stack || err || '');
  const missingMatch = raw.match(/working_directory_missing:([^\n]+)/);
  if (missingMatch) {
    return {
      type: 'working_directory_missing' as const,
      message: 'Working directory no longer exists',
      cwd: missingMatch[1].trim() || fallbackCwd,
      at: Date.now(),
    };
  }
  return {
    type: 'terminal_create_failed' as const,
    message: raw.slice(0, 300) || 'Terminal restore failed',
    cwd: fallbackCwd,
    at: Date.now(),
  };
};

const isPlaceholderProjectPath = (projectPath?: string | null) => {
  return !projectPath || projectPath.startsWith('__unset__');
};

const projectPathExists = async (projectPath?: string | null) => {
  if (isPlaceholderProjectPath(projectPath)) return true;
  return ipcRenderer.invoke('app:check-path-exists', projectPath).catch(() => false);
};

const createBrokenRestoredTab = (workspace: ProjectWorkspace, savedTab: any, err: any): Tab => {
  const tabId = savedTab.tabId || `${workspace.projectId}-tab-${workspace.tabCounter++}`;
  return {
    id: tabId,
    name: savedTab.name || 'Restore failed',
    cwd: savedTab.cwd || workspace.projectPath || '',
    color: savedTab.color,
    isUtility: false,
    commandType: savedTab.commandType,
    claudeSessionId: savedTab.claudeSessionId,
    geminiSessionId: savedTab.geminiSessionId,
    codexSessionId: savedTab.codexSessionId,
    codexModel: savedTab.codexModel,
    codexEffort: savedTab.codexEffort,
    codexSettingsProofAt: savedTab.codexSettingsProofAt,
    codexSettingsProofSessionId: savedTab.codexSettingsProofSessionId,
    codexModelMigrationPending: savedTab.codexModelMigrationPending,
    codexModelMigrationRestoreDefaultModel: savedTab.codexModelMigrationRestoreDefaultModel,
    codexModelMigrationRestoreDefaultEffort: savedTab.codexModelMigrationRestoreDefaultEffort,
    codexModelMigrationSourceModel: savedTab.codexModelMigrationSourceModel,
    codexModelMigrationSourceEffort: savedTab.codexModelMigrationSourceEffort,
    codexModelMigrationTargetModel: savedTab.codexModelMigrationTargetModel,
    codexModelMigrationConfigPath: savedTab.codexModelMigrationConfigPath,
    codexModelMigrationConfigFingerprint: savedTab.codexModelMigrationConfigFingerprint,
    codexModelMigrationConfigAlreadyTarget: savedTab.codexModelMigrationConfigAlreadyTarget,
    externalRun: savedTab.externalRun,
    wasInterrupted: savedTab.wasInterrupted,
    overlayDismissed: savedTab.overlayDismissed,
    notes: savedTab.notes,
    taskPlan: savedTab.taskPlan,
    tabType: savedTab.tabType || 'terminal',
    filePath: savedTab.filePath,
    createdAt: savedTab.createdAt || Math.floor(Date.now() / 1000),
    isCollapsed: savedTab.isCollapsed,
    groupId: savedTab.groupId,
    visualParentTabId: savedTab.visualParentTabId,
    windowScoped: savedTab.windowScoped,
    nameSetManually: savedTab.nameSetManually,
    sessionStatus: savedTab.sessionStatus,
    completionNotificationPersistent: savedTab.completionNotificationPersistent || undefined,
    restartAfterTabId: savedTab.restartAfterTabId || undefined,
    restartAfterTabIds: Array.isArray(savedTab.restartAfterTabIds) ? savedTab.restartAfterTabIds : undefined,
    restartAfterCommand: savedTab.restartAfterCommand || undefined,
    restartAfterPaused: savedTab.restartAfterPaused || undefined,
    restartAfterPersistent: savedTab.restartAfterPersistent || undefined,
    restartAfterArmed: savedTab.restartAfterArmed || undefined,
    restoreError: parseRestoreError(err, savedTab.cwd || workspace.projectPath),
  };
};

const resolveExistingTabGroupId = (workspace: ProjectWorkspace | undefined, rawGroupId: unknown): string | undefined => {
  const groupId = typeof rawGroupId === 'string' && rawGroupId ? rawGroupId : undefined;
  if (!groupId || !workspace?.tabGroups?.some(group => group.id === groupId)) return undefined;
  return groupId;
};

const reopenLastClosedQueues = new Map<string, Promise<TabHistoryRestoreResult>>();

const buildHistoryPendingAction = (
  entry: TabHistoryRestoreEntry,
  policy: TabHistoryRestoreOptions['resumePolicy'] = 'always'
): PendingAction | undefined => {
  if (policy === 'never') return undefined;
  if (policy === 'if-process-was-running' && !entry.process_was_running) return undefined;

  if (entry.command_type === 'claude') {
    return entry.claude_session_id
      ? { type: 'claude-continue', sessionId: entry.claude_session_id }
      : { type: 'claude-new' };
  }
  if (entry.command_type === 'gemini') {
    return entry.gemini_session_id
      ? { type: 'gemini-continue', sessionId: entry.gemini_session_id }
      : { type: 'gemini-new' };
  }
  if (entry.command_type === 'codex') {
    return entry.codex_session_id
      ? { type: 'codex-continue', sessionId: entry.codex_session_id }
      : { type: 'codex-new' };
  }
  return undefined;
};

const parseHistoryTaskPlan = (raw: string | null | undefined): TabTaskPlanDocument | undefined => {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as TabTaskPlanDocument; }
  catch { return undefined; }
};

const formatHistoryRestoreError = (entry: TabHistoryRestoreEntry, err: unknown): string => {
  const raw = String((err as any)?.message || (err as any)?.stack || err || '');
  const missing = raw.match(/working_directory_missing:([^\n]+)/);
  if (missing) {
    return `Папка вкладки больше не существует: ${missing[1].trim() || entry.cwd}`;
  }
  return 'Не удалось восстановить вкладку';
};

const normalizeComparablePath = (value: string | null | undefined): string => {
  const clean = String(value || '').trim();
  if (clean === '/') return clean;
  return clean.replace(/\/+$/, '');
};

const resolveHistoryRestoreCwd = async (
  entry: TabHistoryRestoreEntry,
  projectPath: string
): Promise<{
  cwd: string;
  fallbackFrom?: string;
  requiresConfirmation?: boolean;
  confirmationReason?: 'project-name-prefix' | 'nearest-existing-parent';
}> => {
  const originalCwd = entry.cwd || projectPath || '/';
  if (entry.command_type !== 'codex') return { cwd: originalCwd };

  try {
    const nearest = await ipcRenderer.invoke('app:nearest-existing-directory', originalCwd);
    if (nearest?.path && nearest.exact !== false) return { cwd: nearest.path };

    const original = normalizeComparablePath(originalCwd);
    const project = normalizeComparablePath(projectPath);
    const originalSlash = original.lastIndexOf('/');
    const projectSlash = project.lastIndexOf('/');
    const originalParent = originalSlash > 0 ? original.slice(0, originalSlash) : '/';
    const projectParent = projectSlash > 0 ? project.slice(0, projectSlash) : '/';
    const originalBase = originalSlash >= 0 ? original.slice(originalSlash + 1) : original;
    const projectBase = projectSlash >= 0 ? project.slice(projectSlash + 1) : project;
    const looksLikeTruncatedProjectName = originalParent === projectParent
      && originalBase.length >= 3
      && projectBase.startsWith(originalBase);
    const projectExists = !!project
      && await ipcRenderer.invoke('app:check-path-exists', projectPath).catch(() => false);
    const originalWasInsideProject = !!project && !!original && (
      project === original || original.startsWith(project + '/')
    );
    if (projectExists && originalWasInsideProject) {
      return { cwd: projectPath, fallbackFrom: originalCwd };
    }
    if (projectExists && looksLikeTruncatedProjectName) {
      return {
        cwd: projectPath,
        fallbackFrom: originalCwd,
        requiresConfirmation: true,
        confirmationReason: 'project-name-prefix',
      };
    }

    if (nearest?.path) {
      return {
        cwd: nearest.path,
        fallbackFrom: originalCwd,
        requiresConfirmation: true,
        confirmationReason: 'nearest-existing-parent',
      };
    }
    return { cwd: originalCwd };
  } catch (err: any) {
    console.warn(
      '[TabHistoryRestore] cwd preflight failed historyId=' + entry.id +
      ' cwd=' + originalCwd +
      ' err=' + (err?.message || String(err))
    );
    return { cwd: originalCwd };
  }
};

const isAiRuntimeTab = (tab?: Pick<Tab,
  'commandType' | 'tabType' | 'claudeSessionId' | 'codexSessionId'> | null): boolean => {
  return !!tab && (
    tab.tabType === 'claude-sdk'
    || tab.commandType === 'gemini'
    || !!tab.claudeSessionId
    || !!tab.codexSessionId
    || resolvePtyAgentOwner(tab) !== null
  );
};

const isSdkBusyState = (tab?: Pick<Tab, 'sdkState'> | null): boolean => {
  return tab?.sdkState === 'fetching' || tab?.sdkState === 'thinking' || tab?.sdkState === 'tool_use';
};

const isAiBusyTab = (tab?: Pick<Tab, 'aiBusy' | 'claudeBusy' | 'sdkState'> | null, override?: boolean): boolean => {
  if (typeof override === 'boolean') return override;
  return !!(tab?.aiBusy || tab?.claudeBusy || isSdkBusyState(tab));
};

// Native macOS sheet instead of window.confirm: the latter blocks the renderer
// thread, so terminal output and the closing loader freeze behind the prompt.
// Fails closed — an undeliverable dialog must never authorize the close.
const confirmDestructiveClose = async (options: {
  message: string;
  detail?: string;
}): Promise<boolean> => {
  try {
    const result = await ipcRenderer.invoke('ui:confirm-destructive', {
      message: options.message,
      detail: options.detail,
      confirmLabel: 'Закрыть вкладку',
      cancelLabel: 'Отмена',
    });
    return result?.confirmed === true;
  } catch (error: any) {
    console.warn('[CloseTab] confirm dialog failed: ' + (error?.message || error));
    return false;
  }
};

const makeDefaultSavedTab = (workspace: ProjectWorkspace, cwd?: string | null, tabId?: string) => ({
  tabId: tabId || `${workspace.projectId}-tab-${workspace.tabCounter++}`,
  name: 'Terminal 1',
  cwd: cwd || workspace.projectPath || '',
  tabType: 'terminal',
  commandType: undefined,
});

type TabCompletionNotificationDetail = {
  projectId: string;
  tabId: string;
  tabName: string;
  fired?: boolean;
  firedAt?: number;
  persistent?: boolean;
};

const emitTabCompletionNotification = (detail: TabCompletionNotificationDetail) => {
  try {
    ipcRenderer.send('tab-notification:completed', detail);
  } catch {}
  try {
    if (detail.fired) ipcRenderer.send('tab-notification:fired', detail);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tab-completion-notification', { detail }));
  } catch {}
};

const emitTabCompletionNotificationCleared = (detail: { projectId: string; tabId: string }) => {
  try {
    ipcRenderer.send('tab-notification:cleared', detail);
  } catch {}
};

// Does this tab still owe the user queued work? Reads the SAME predicate the
// runner and the queue UI use, so "the bell thinks the job is done" and "the
// queue thinks the job is done" cannot drift apart.
const tabHasPendingQueueContinuation = (tabId: string): boolean => {
  try {
    return hasPendingPromptQueueContinuation(usePromptQueueStore.getState().getQueue(tabId));
  } catch {
    return false;
  }
};

// One gate for both completion paths (own turn end + orchestration release).
// Returns a defer reason, or null when the bell may settle now.
const tabCompletionDeferralReason = (tabId: string, successful: boolean): string | null =>
  shouldDeferTabCompletionNotification({
    successful,
    orchestrationBlocked: isOrchestrationCompletionBlocked(tabId),
    queueContinuationPending: tabHasPendingQueueContinuation(tabId),
  });

const settleTabCompletionNotification = ({
  tab,
  workspace,
  activeProjectId,
  tabId,
  successful,
}: {
  tab: Tab;
  workspace: ProjectWorkspace;
  activeProjectId: string | null;
  tabId: string;
  successful: boolean;
}): { changed: boolean; detail: TabCompletionNotificationDetail | null } => {
  if (!tab.completionNotificationArmed && !tab.completionNotificationPersistent) {
    return { changed: false, detail: null };
  }

  delete tab.completionNotificationArmed;
  delete tab.completionNotificationFired;
  delete tab.completionNotificationFiredAt;
  if (!successful) return { changed: true, detail: null };

  const isVisibleTarget =
    activeProjectId === workspace.projectId &&
    workspace.activeTabId === tabId &&
    workspace.currentView === 'terminal';
  const firedAt = Date.now();
  const detail: TabCompletionNotificationDetail = {
    projectId: workspace.projectId,
    tabId,
    tabName: tab.name || 'Terminal',
    persistent: !!tab.completionNotificationPersistent,
    fired: !isVisibleTarget,
    firedAt,
  };
  if (!isVisibleTarget) {
    tab.completionNotificationFired = true;
    tab.completionNotificationFiredAt = firedAt;
  }
  return { changed: true, detail };
};

// Shared with App.tsx and TabBar.tsx — three copies of this predicate silently
// disagreed once and left Codex tabs asking for confirmation while Claude tabs
// closed cleanly. See utils/aiForegroundProcess.mjs.

interface SessionState {
  openProjects: { projectId: string; projectPath: string; activeTabIndex: number }[];
  activeProjectId: string | null;
  view: 'dashboard' | 'workspace';
}

// One entry of the cross-project tab MRU (most-recent-first). Powers the
// Ctrl+Tab / Cmd+P switcher ordering and its initial "previous tab" highlight.
export interface GlobalTabMruEntry {
  projectId: string;
  tabId: string;
}

// One column of the split workspace. Empty array = single mode. Panes may
// belong to different projects. An empty pane ({projectId:'',tabId:''}) is a
// placeholder opened by the split button: focusable, waiting for the next tab
// activation to fill it.
//
// TAB ≠ PROJECT: activating a tab (sidebar click, Ctrl+Tab, Cmd+P, pane
// focus) moves only the CENTER — activeProjectId keeps following the center
// tab so every tab-owned surface (control bar, History, Timeline, hotkeys)
// works unchanged. The SIDEBAR/toolbar/titlebar live on focusedProjectId,
// which moves ONLY on an explicit project click (titlebar chip, dashboard,
// project chip in the attach row). This is what stops "смена вкладки утащила
// меня в чужой проект".
export interface SplitPane {
  /** Project of the SHOWN tab. Follows `tabId` — see below. */
  projectId: string;
  /** The tab currently SHOWN here. One of `tabs`, when that list exists. */
  tabId: string;
  /**
   * The pane's STRIP: every tab whose chip is drawn in this window's header,
   * left to right, in the order the user built.
   *
   * Absent on a single-tab pane — including every session saved before strips
   * existed — where the strip is simply `[{projectId, tabId}]`. Same
   * all-or-nothing storage rule as `column`, and the same reason: a legacy
   * layout must restore byte-identical. Read it through `paneTabs()`, never
   * directly: "absent" means "one", not "none".
   *
   * Order is the USER'S (append on double-click, drag to reorder) — never
   * recency. A strip is a map you build; a map that reshuffles itself cannot be
   * read, which is what killed the pane header's old recent-list.
   */
  tabs?: Array<{ projectId: string; tabId: string }>;
  /**
   * Which COLUMN this pane belongs to; panes in the same column stack
   * vertically, top to bottom in array order.
   *
   * Absent on every purely horizontal layout — including every session saved
   * before vertical splitting existed — where a pane is simply its own column
   * at its array position. It is written only once a layout actually stacks,
   * and then on every pane at once. See splitPanesModel.mjs for the rules.
   */
  column?: number;
  /**
   * What THIS pane showed before its current tab, most recent first. Feeds the
   * per-pane Ctrl+Tab list and the file middle-click step-back — "what was in
   * this slot" is a different question from the global "which tab did I visit".
   *
   * Absent when the pane has no past. Sessions saved before the list existed
   * carry the one-step `prevProjectId`/`prevTabId` pair instead; paneHistory()
   * reads both shapes, so restore keeps its memory.
   */
  history?: Array<{ projectId: string; tabId: string }>;
  /** Explicitly removed chips, newest first; Shift+Cmd+T undoes this per pane. */
  detachedTabs?: Array<{ projectId: string; tabId: string }>;
  /** @deprecated one-step predecessor of `history`; read-only via paneHistory(). */
  prevProjectId?: string;
  /** @deprecated see prevProjectId */
  prevTabId?: string;
}

// Divider positions of the split workspace, as FRACTIONS: cols[c] is column
// c's share of the width, rows[c][j] is row j's share of column c's height.
// Lives BESIDE the panes, not on them: a column's width belongs to the column,
// and pane objects are rebuilt wholesale on every activation. null = every
// dimension is an equal split (the default is absent, same as `column`).
// Readers normalize against the CURRENT pane structure at read time, so no
// pane writer needs to know this field exists. See splitPanesModel.mjs.
export interface SplitSizes {
  cols: number[];
  rows: number[][];
}

export interface TerminalBufferCheckpoint {
  serialized: string;
  headlessWriteSeq: number | null;
  headlessGeneration: string | null;
  headlessGenerationOrdinal: number | null;
  promptBoundaries: Array<{ seq: number; line: number }>;
  cols: number;
  rows: number;
}

interface WorkspaceStore {
  view: 'dashboard' | 'workspace';
  // Project of the CENTER tab. Follows every tab activation (sidebar click,
  // Ctrl+Tab, pane focus) so all tab-owned surfaces (control bar, History,
  // Timeline, hotkeys, effective-tab selectors) keep reading it unchanged.
  activeProjectId: string | null;
  // Project of the SIDEBAR/toolbar/git/titlebar highlight. Moves ONLY on an
  // explicit project click (titlebar chip, dashboard, project chip in the
  // attach row, Cmd+arrows). null → falls back to activeProjectId
  // (selectFocusedProjectId), so old sessions restore without migration.
  focusedProjectId: string | null;
  getFocusedProjectId: () => string | null;
  openProjects: Map<string, ProjectWorkspace>;
  projectHistory: string[]; // Stack of project IDs in order of activation
  // Cross-project tab MRU (most-recent-first, cap 60). Written on every tab
  // activation (switchTab / createTab / openProject focus), pruned on close.
  // Persisted inside the session state so Ctrl+Tab keeps its order across
  // restarts.
  globalTabMru: GlobalTabMruEntry[];
  /**
   * Record a VISIT: this tab was just focused, so it is the freshest thing the
   * user worked in. Called by every activation path — being already on screen
   * does not exempt it (that question belongs to the switcher's own list).
   */
  touchGlobalTabMru: (projectId: string, tabId: string) => void;
  /**
   * "Forget this row" — middle-click in a tab list. Removes the tab from the
   * GLOBAL visit order without touching the tab itself: it stays open, it just
   * stops being offered as somewhere to go back to.
   *
   * The durable per-tab stamp is cleared too, or the next restart would rebuild
   * the order from it and the entry would come back.
   */
  forgetGlobalTabVisit: (projectId: string, tabId: string) => void;
  // Split workspace (up to 3 side-by-side panes, cross-project). Empty =
  // single mode. Persisted in the session state. Focused pane index kept in
  // sync with activeProjectId/activeTabId by activateCenterTab.
  splitPanes: SplitPane[];
  splitFocusedIndex: number;
  /**
   * Divider positions as fractions; null = equal split everywhere. Persisted
   * with the layout. Readers normalize against the current pane structure, so
   * pane add/remove needs no bookkeeping here — a dimension whose stored count
   * no longer matches simply reads as equal.
   */
  splitSizes: SplitSizes | null;
  /**
   * ONE write per finished drag (mouseup / divider double-click), not one per
   * mousemove: the live drag repositions the pane wrappers directly in the
   * DOM, and a store write per move would rebuild the whole terminals memo at
   * pointer speed. Packs against the current panes (equal split stores null).
   */
  commitSplitSizes: (sizes: SplitSizes | null) => void;
  addTabToSplit: (projectId: string, tabId: string) => boolean;
  /**
   * «Убрать вкладку из окна»: the pane STAYS and becomes an empty placeholder.
   * The tab is not closed — it keeps living in the sidebar list. Closing the
   * pane itself is a separate gesture (the placeholder's ✕).
   */
  clearTabFromSplitPane: (tabId: string) => boolean;
  /**
   * Cmd+W while a workspace window owns keyboard focus: remove the tab from
   * that window only. The durable project row and its process/session stay
   * alive. In single mode the centre becomes one explicit empty window, so a
   * second Cmd+W is a no-op instead of falling through to the sidebar.
   */
  detachTabFromWindow: (projectId: string, tabId: string, paneIndex: number | null) => boolean;
  removeTabFromSplit: (tabId: string) => void;
  // Split button in the attach row: open an EMPTY pane (focused, waiting for
  // the next tab activation to fill it). Single mode → [center, empty].
  addEmptySplitPane: (anchorPaneIndex?: number | null, side?: 'left' | 'right') => boolean;
  /** Right-click on the split button: open a placeholder ABOVE/BELOW a pane. */
  addVerticalSplitPane: (atPaneIndex: number | null, side: 'above' | 'below') => boolean;
  /** Middle-click on a file pane: bring back what that pane showed before. */
  restoreSplitPanePreviousTab: (tabId: string) => boolean;
  /** Reinsert the newest chip explicitly removed from this pane. */
  restoreLastDetachedTabToSplitPane: (paneIndex: number) => boolean;
  /**
   * Double-click on the header's empty space: a brand-new tab joins THIS
   * window's strip as one more chip, shown immediately.
   *
   * Its own action rather than "create + activate", because ordinary activation
   * deliberately REPLACES the shown chip (see resolveSplitActivation): growing a
   * strip is a separate intention and must have a separate gesture.
   */
  addTabToSplitPaneStrip: (paneIndex: number, projectId: string, tabId: string) => void;
  /** Exact drag/drop placement into a pane strip or the single centre strip. */
  moveTabsToWindowStrip: (
    paneIndex: number | null,
    entries: Array<{ projectId: string; tabId: string }>,
    at?: number | null,
    shownTabId?: string | null,
  ) => boolean;
  /** Move tabs out of every workflow window while keeping the tab records alive. */
  detachTabsFromWorkspaceWindows: (tabIds: string[]) => boolean;
  /** Drag a chip within its own window's strip. */
  reorderSplitPaneTab: (paneIndex: number, tabId: string, toIndex: number) => void;
  /** Поменять местами содержимое двух окон целиком. */
  swapSplitPanes: (from: number, to: number) => void;
  /**
   * Поменять местами два окна целиком между workflow, не активируя целевой
   * workflow. null адресует одиночный центр, number — pane split-раскладки.
   */
  swapWorkspaceWindows: (
    sourceSpaceId: string,
    sourcePaneIndex: number | null,
    targetSpaceId: string,
    targetPaneIndex: number | null,
  ) => boolean;
  /**
   * The single-mode centre's strip, keyed by project.
   *
   * Without a split there is no pane object to carry it, and the centre shows a
   * different project's tabs as the user moves between projects — one shared
   * list would follow them across and read as somebody else's tabs. Empty or
   * one-element strips are not stored: a project the user never built a strip in
   * behaves exactly as it did before strips existed.
   */
  centerStrips: Record<string, Array<{ projectId: string; tabId: string }>>;
  /**
   * Рабочие пространства — ВИДЫ на раскладку окон.
   *
   * Вкладки им не принадлежат: те живут в списке проекта, а пространство помнит
   * только, как они разложены. Поля раскладки (`splitPanes`, `splitSizes`,
   * `centerStrips`, оба указателя проекта) остаются на верхнем уровне стора —
   * их читают десятки мест, и заворачивать каждое чтение в «раскладку текущего
   * пространства» значило бы переписать их все ради одного нового слоя.
   * Пространство при переключении СНИМАЕТ их себе и КЛАДЁТ обратно.
   */
  spaces: Array<{
    id: string;
    name: string;
    /** Цветная SVG/PNG-иконка workflow. undefined бывает только у legacy-записи. */
    icon?: string | null;
    /** Упорядоченные проекты workflow; первый — default для пустой раскладки. */
    projectIds: string[];
    layout: Record<string, any>;
  }>;
  /** Вкладка, которую показывал центр этого пространства (проект + id). */
  activeSpaceTab: { projectId: string; tabId: string } | null;
  activeSpaceId: string;
  addWorkspaceSpace: (options?: { activate?: boolean; name?: string }) => string | null;
  removeWorkspaceSpace: (id: string) => void;
  renameWorkspaceSpace: (id: string, name: string) => void;
  reorderWorkspaceSpaces: (orderedIds: string[]) => boolean;
  updateWorkspaceSpaceMetadata: (
    id: string,
    updates: { icon?: string | null; projectIds?: string[] },
  ) => boolean;
  switchWorkspaceSpace: (id: string) => void;
  /**
   * Evidence-backed repair path used by the authenticated workspace API.
   * Merges named workflow layouts, validates every project/tab against the
   * live store, and commits the result synchronously so API success is durable.
   */
  recoverWorkspaceSpaces: (request: {
    candidates: Array<Record<string, any>>;
    overwriteExistingIds?: string[];
    expectedFingerprint?: string;
    reassignProjects?: boolean;
    dryRun?: boolean;
    /** Durable DB proof for projects not currently mounted in openProjects. */
    knownProjectTabs?: Record<string, string[]>;
  }) => Record<string, any>;
  /** Сколько РАЗНЫХ вкладок разложено в пространстве — число рядом с именем. */
  workspaceSpaceTabCount: (id: string) => number;
  /** Сколько вкладок пространства сейчас заняты работой (второе число в чипе). */
  workspaceSpaceBusyTabCount: (id: string) => number;
  /** IDs вкладок workflow; current workflow читается из live layout. */
  workspaceSpaceTabIds: (id: string) => string[];
  /** Номер пространства, где лежит вкладка, или -1. Для карточки в списке. */
  workspaceSpaceIndexOfTab: (tabId: string) => number;
  /** Вкладка реально присутствует хотя бы в одной pane/centre strip. */
  isTabPlacedInWorkspace: (tabId: string) => boolean;
  /**
   * Under WHICH key the centre's strip lives — the project whose tab the centre
   * is showing, not the project of the tab being talked about. The two differ as
   * soon as a strip holds another project's tab (strips are cross-project, like
   * windows), and a chip asking by its own project would address a second strip
   * nobody is looking at. One resolver so "add" and "remove" cannot disagree.
   */
  centerStripKey: () => string | null;
  /** Double-click on the centre header's empty space (single mode). */
  addTabToCenterStrip: (projectId: string, tabId: string) => void;
  /** Drag a chip in the centre's strip (single mode). */
  reorderCenterStripTab: (projectId: string, tabId: string, toIndex: number) => void;
  /** Middle-click on a centre chip: take it out of the strip. */
  removeTabFromCenterStrip: (projectId: string, tabId: string) => void;
  /**
   * Arrange several tabs into windows in ONE step — the API path.
   *
   * Every other split action is a gesture: one click's worth of change. An API
   * caller states an arrangement instead («эти две справа, каждая своим окном»),
   * and composing that out of gestures is four calls that can each half-fail —
   * plus the "one placeholder at a time" guard, which refuses the second one.
   * So this applies the whole layout or none of it.
   */
  arrangeSplitPanes: (spec: {
    anchorIndex?: number;
    side?: 'right' | 'left' | 'above' | 'below';
    divide?: 'columns' | 'rows';
    windows: Array<Array<{ projectId: string; tabId: string }>>;
  }) => { placedIndices: number[]; focusedIndex: number } | null;
  /**
   * One app-owned mutation for Terminal MCP and Project API window intents.
   * Resolves source/space/window against one revision, updates active or
   * dormant workflow layout, and never depends on the user's current click.
   */
  commitWorkspaceWindowAction: (request: {
    sourceTabId?: string;
    target?: Record<string, any>;
    entries?: Array<{ projectId: string; tabId: string }>;
    windows?: Array<Array<{ projectId: string; tabId: string }>>;
    show?: boolean;
    focus?: boolean;
    reveal?: boolean;
    createEmptyWindow?: boolean;
    moveExisting?: boolean;
  }) => Record<string, any>;
  // ✕ / Escape on an empty placeholder pane (real panes close by tabId).
  removeEmptySplitPane: (paneIndex: number) => void;
  // `keepSidebar` — «прицелиться в окно, не съезжая из чужого проекта».
  // Обычный клик по окну переводит и центр, и боковое меню на проект окна:
  // это правильный ответ на «я работаю здесь». Но у человека бывает обратный
  // порядок — он уже стоит в чужом проекте и выбирает, КУДА оттуда положить
  // вкладку. См. комментарий у реализации.
  focusSplitPane: (paneIndex: number, options?: { keepSidebar?: boolean }) => void;
  // ONE entry point for "user activated tab X of project P" (sidebar click,
  // switcher commit, pane focus, cross-tab jumps). Activation moves BOTH
  // pointers — the centre AND the sidebar (activationFollowPatch inside
  // switchTab): the sidebar is the map of "where I am", so it always shows the
  // active tab's project. An explicit project click (showWorkspace) can still
  // park the sidebar elsewhere until the next activation.
  activateCenterTab: (projectId: string, tabId: string) => void;
  /**
   * ОДИН путь «человек выбрал вкладку» для бокового списка, `Ctrl+Tab`/`Cmd+P`,
   * меню оркестрации и любого другого меню, открывающего вкладку.
   *
   * Обычный режим ведёт К ВКЛАДКЕ: если у неё уже есть место — своё окно, пусть
   * даже в другом пространстве, — переходим туда. В текущее окно её не
   * переносим: живой терминал один, и «перенести» значит молча разобрать
   * раскладку, которую собрал человек. Места нет — тогда показывает текущее.
   *
   * `mode: 'add-here'` — явный жест (Shift, средний клик по строке
   * переключателя): вкладка снимается со старого места и добавляется ПОСЛЕДНИМ
   * чипом текущего окна, становясь показанной.
   *
   * Решение принимает чистый резолвер (`utils/tabPlacementResolver.mjs`), здесь
   * только запись.
   */
  placeTab: (projectId: string, tabId: string, options?: { mode?: 'default' | 'add-here' }) => void;
  // Transient "reveal this tab in the sidebar list" request. Set by explicit
  // activations (Ctrl+Tab / Cmd+P commit, split pane focus) so TabBar scrolls
  // the row into view instantly — including right after a cross-project
  // switch, where it wins over the per-project saved-scroll restore.
  tabListRevealRequest: { projectId: string; tabId: string; seq: number } | null;
  requestTabListReveal: (projectId: string, tabId: string) => void;
  isRestoring: boolean;
  pendingEditTabId: string | null; // Set after createTab to trigger inline rename; consumed once by TabBar
  tabTitleNamingIds: Set<string>; // Transient UI-only loader while Gemini generates a tab title

  // Terminal buffer serialization (for preserving history on unmount/remount)
  terminalBuffers: Map<string, TerminalBufferCheckpoint | string>;
  saveTerminalBuffer: (tabId: string, buffer: TerminalBufferCheckpoint) => void;
  getTerminalBuffer: (tabId: string) => TerminalBufferCheckpoint | string | null;
  clearTerminalBuffer: (tabId: string) => void;

  // Session
  restoreSession: () => Promise<void>;
  saveSession: () => void;

  // View control
  showDashboard: () => Promise<void>;
  showWorkspace: (projectId: string) => void;

  // Project management
  openProject: (projectId: string, projectPath: string, options?: { background?: boolean; draft?: boolean }) => Promise<void>;
  closeProject: (projectId: string) => Promise<void>;

  // Tab management
  createTab: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; commandType?: CommandType; pendingAction?: PendingAction; claudeSessionId?: string; geminiSessionId?: string; codexSessionId?: string; codexModel?: string; codexEffort?: string; codexSettingsProofAt?: number; codexSettingsProofSessionId?: string; codexModelMigrationPending?: boolean; codexModelMigrationRestoreDefaultModel?: boolean; codexModelMigrationRestoreDefaultEffort?: boolean; codexModelMigrationSourceModel?: string; codexModelMigrationSourceEffort?: string; codexModelMigrationTargetModel?: string; codexModelMigrationConfigPath?: string; codexModelMigrationConfigFingerprint?: string; codexModelMigrationConfigAlreadyTarget?: boolean; externalRun?: Tab['externalRun']; wasInterrupted?: boolean; overlayDismissed?: boolean; notes?: string; taskPlan?: TabTaskPlanDocument; tabType?: TabType; filePath?: string; nameSetManually?: boolean; background?: boolean; skipInitialRename?: boolean; sessionStatus?: string; completionNotificationPersistent?: boolean; restartAfterTabId?: string; restartAfterTabIds?: string[]; restartAfterCommand?: string; restartAfterPaused?: boolean; restartAfterPersistent?: boolean; restartAfterArmed?: boolean; groupId?: string; visualParentTabId?: string; windowScoped?: boolean; restoreId?: string }) => Promise<string>;
  createTabAfterCurrent: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; commandType?: CommandType; pendingAction?: PendingAction; claudeSessionId?: string; geminiSessionId?: string; codexSessionId?: string; codexModel?: string; codexEffort?: string; codexSettingsProofAt?: number; codexSettingsProofSessionId?: string; codexModelMigrationPending?: boolean; codexModelMigrationRestoreDefaultModel?: boolean; codexModelMigrationRestoreDefaultEffort?: boolean; codexModelMigrationSourceModel?: string; codexModelMigrationSourceEffort?: string; codexModelMigrationTargetModel?: string; codexModelMigrationConfigPath?: string; codexModelMigrationConfigFingerprint?: string; codexModelMigrationConfigAlreadyTarget?: boolean; wasInterrupted?: boolean; overlayDismissed?: boolean; notes?: string; taskPlan?: TabTaskPlanDocument; tabType?: TabType; filePath?: string; afterTabId?: string; afterVisualSubtree?: boolean; appendToEnd?: boolean; nameSetManually?: boolean; background?: boolean; skipInitialRename?: boolean; completionNotificationPersistent?: boolean; restartAfterTabId?: string; restartAfterTabIds?: string[]; restartAfterCommand?: string; restartAfterPaused?: boolean; restartAfterPersistent?: boolean; restartAfterArmed?: boolean; groupId?: string; visualParentTabId?: string; windowScoped?: boolean; restoreId?: string }) => Promise<string>;
  closeTab: (projectId: string, tabId: string, options?: { skipProcessCheck?: boolean; forceCleanup?: boolean; aiBusyOverride?: boolean; archive?: boolean; preserveFocusedEmptyPane?: boolean }) => Promise<boolean>;
  restoreTabHistoryEntry: (projectId: string, historyId?: number, options?: TabHistoryRestoreOptions) => Promise<TabHistoryRestoreResult>;
  reopenLastClosedTab: (projectId: string, options?: { targetPaneIndex?: number }) => Promise<TabHistoryRestoreResult>;
  switchTab: (projectId: string, tabId: string) => void;
  setActiveTabGroup: (projectId: string, groupId: string | null) => void;
  renameTab: (projectId: string, tabId: string, newName: string) => void;
  autoRenameTab: (tabId: string, newName: string, options?: { toolType?: 'claude' | 'gemini' | 'codex'; sessionId?: string; overrideManualName?: boolean; markNameSetManually?: boolean }) => boolean;
  setTabTitleNaming: (tabId: string, naming: boolean) => void;
  getPendingAutoTabTitle: (tabId: string, toolType: AutoTabTitleTool, sessionId: string) => PendingAutoTabTitle | null;
  consumePendingAutoTabTitle: (tabId: string, toolType: AutoTabTitleTool, sessionId: string) => boolean;
  clearPendingAutoTabTitle: (tabId: string, reason: string) => void;
  recoverPendingAutoTabTitle: (tabId: string, toolType: AutoTabTitleTool, sessionId: string, mode: AutoTabTitleMode) => boolean;

  // Selection
  toggleTabSelection: (projectId: string, tabId: string, multi?: boolean) => void;
  selectTabRange: (projectId: string, tabId: string) => void;
  clearSelection: (projectId: string) => void;
  getSelectedTabs: (projectId: string) => Tab[];

  // Reorder tabs
  reorderTabs: (projectId: string, oldIndex: number, newIndex: number) => void;

  // Tab color and status
  setTabColor: (projectId: string, tabId: string, color: TabColor, manual?: boolean) => void;
  setTabSessionStatus: (projectId: string, tabId: string, status: string | null) => void;
  setTabCompletionNotificationArmed: (projectId: string, tabId: string, armed: boolean) => void;
  setTabCompletionNotificationPersistent: (projectId: string, tabId: string, persistent: boolean) => void;
  clearTabCompletionNotification: (projectId: string, tabId: string, options?: { keepPersistent?: boolean }) => void;
  applyTabCompletionOrchestrationState: (tabId: string, phase: 'active' | 'success' | 'abnormal') => void;
  setTabRestartAfterTarget: (projectId: string, tabId: string, triggerTabId: string | null) => void;
  setTabRestartAfterCommand: (projectId: string, tabId: string, command: string | null) => void;
  setTabRestartAfterPaused: (projectId: string, tabId: string, paused: boolean) => void;
  consumeRestartAfterTriggerIdle: (triggerTabId: string, naturalEnd: boolean) => Array<{ tabId: string; command?: string }>;
  setTabCommandType: (tabId: string, commandType: CommandType) => void; // Also sets auto-color on first run
  markAiLaunchAutoTitle: (tabId: string, toolType: AutoTabTitleTool) => void;
  markAiForkAutoTitle: (tabId: string, toolType: AutoTabTitleTool, sourceSessionId: string) => void;
  getAiLaunchSnapshot: (tabId: string) => AiLaunchSnapshot | null;
  clearAiLaunchSnapshot: (tabId: string, reason?: string) => void;
  restoreRejectedAiLaunchSnapshot: (tabId: string, toolType: AutoTabTitleTool, reason?: string) => boolean;
  discardUnmaterializedAiLaunchSession: (tabId: string, reason: string) => Promise<boolean>;
  toggleTabCollapsed: (projectId: string, tabId: string) => void;

  // Advanced drag & drop
  reorderInZone: (projectId: string, zone: 'main', orderedIds: string[]) => void;
  moveTabToProject: (sourceProjectId: string, tabId: string, targetProjectId: string) => Promise<boolean>;
  moveTabsToProject: (sourceProjectId: string, tabIds: string[], targetProjectId: string) => Promise<boolean>;
  moveTabGroupToProject: (sourceProjectId: string, groupId: string, targetProjectId: string) => Promise<boolean>;
  createTabGroup: (projectId: string, name?: string) => string;
  renameTabGroup: (projectId: string, groupId: string, name: string) => void;
  toggleTabGroupCollapsed: (projectId: string, groupId: string) => void;
  setTabGroupColor: (projectId: string, groupId: string, color: TabColor) => void;
  setTabGroupSessionStatus: (projectId: string, groupId: string, status: string | null) => void;
  deleteTabGroup: (projectId: string, groupId: string) => void;
  setTabVisualParent: (projectId: string, tabId: string, parentTabId: string | undefined) => void;
  /** Показать/убрать подпись долгой операции на карточке вкладки. */
  setTabPendingOperation: (projectId: string, tabId: string, label: string | null) => void;
  applyTabLayout: (
    projectId: string,
    orderedIds: string[],
    groupAssignments?: Record<string, string | null | undefined>,
    visualParentAssignments?: Record<string, string | null | undefined>,
    groupAnchorAssignments?: Record<string, string | null | undefined>
  ) => void;

  // Update tab cwd
  updateTabCwd: (projectId: string, tabId: string, newCwd: string) => Promise<boolean>;
  syncAllTabsCwd: (projectId: string) => Promise<void>;

  // Claude session tracking
  // `reason` documents who is writing — bubbles into claudeSessionHistory so
  // the user can revert mistaken overwrites from the tab context menu.
  setClaudeSessionId: (tabId: string, sessionId: string, reason?: SessionWriteReason) => void;
  getClaudeSessionId: (tabId: string) => string | null;

  // Gemini session tracking
  setGeminiSessionId: (tabId: string, sessionId: string) => void;
  getGeminiSessionId: (tabId: string) => string | null;

  // Codex session tracking
  setCodexSessionId: (
    tabId: string,
    sessionId: string,
    reason?: CodexSessionWriteReason,
    options?: CodexSessionAdoptionOptions,
  ) => Promise<boolean>;
  getCodexSessionId: (tabId: string) => string | null;
  updateCodexState: (tabId: string, state: Partial<Pick<Tab, 'codexModel' | 'codexEffort' | 'codexSettingsProofAt' | 'codexSettingsProofSessionId' | 'codexModelMigrationPending' | 'codexModelMigrationRestoreDefaultModel' | 'codexModelMigrationRestoreDefaultEffort' | 'codexModelMigrationSourceModel' | 'codexModelMigrationSourceEffort' | 'codexModelMigrationTargetModel' | 'codexModelMigrationConfigPath' | 'codexModelMigrationConfigFingerprint' | 'codexModelMigrationConfigAlreadyTarget'>>) => void;
  updateCodexLiveState: (tabId: string, state: Pick<Tab, 'codexLiveModel' | 'codexLiveEffort' | 'codexLiveSettingsSessionId'>) => void;
  updateCodexLiveServiceTier: (tabId: string, state: Pick<Tab, 'codexLiveServiceTier' | 'codexLiveServiceTierSessionId' | 'codexLiveServiceTierSource'>) => void;
  updateExternalRunMeta: (tabId: string, meta: Partial<NonNullable<Tab['externalRun']>>) => void;

  setClaudeActive: (tabId: string, alive: boolean) => void;
  setClaudeBusy: (tabId: string, busy: boolean) => void;
  setAiBusy: (tabId: string, busy: boolean, reason?: string) => void;
  setSdkProcessAlive: (tabId: string, alive: boolean) => void;

  setViewingSubAgent: (tabId: string | null) => void;
  getEffectiveTabId: () => string | null;

  // Tab notes
  setTabNotes: (tabId: string, notes: string) => void;
  getTabNotes: (tabId: string) => string;

  // Structured per-tab task plan. Main process owns validation + history so
  // renderer edits and Terminal MCP edits share the same undo/redo chain.
  applyTabTaskPlanOperations: (tabId: string, operations: TabTaskPlanOperation[]) => Promise<TabTaskPlanDocument | null>;
  undoTabTaskPlan: (tabId: string) => Promise<TabTaskPlanDocument | null>;
  redoTabTaskPlan: (tabId: string) => Promise<TabTaskPlanDocument | null>;
  receiveTabTaskPlan: (tabId: string, document: TabTaskPlanDocument) => void;

  // Interrupted session handling
  clearInterruptedState: (tabId: string) => void;
  dismissInterruptedSession: (tabId: string) => void;
  markAllSessionsInterrupted: () => void;

  // Immediate save (for shutdown)
  saveSessionImmediate: (options?: {
    reason?: string;
    source?: string;
    allowWorkspaceSpaceRemoval?: boolean;
  }) => void;

  // Reorder projects (for drag-and-drop)
  reorderProjects: (orderedProjectIds: string[]) => void;

  // Claude SDK tabs
  createSDKTab: (projectId: string, name?: string, options?: { afterTabId?: string; afterVisualSubtree?: boolean; groupId?: string; visualParentTabId?: string; background?: boolean; windowScoped?: boolean }) => Promise<string>;
  convertToSDKTab: (tabId: string) => void;
  updateSDKState: (tabId: string, state: Partial<Pick<Tab, 'sdkState' | 'sdkMessages' | 'claudeSessionId' | 'sdkModel' | 'sdkEffort' | 'sdkThinking' | 'sdkMidstreamPending' | 'sdkComposerChips'>>) => void;
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
  rewriteFilePathReferences: (oldPath: string, newPath: string) => void;
  setSidebarExpandedDirs: (projectId: string, expandedDirs: Record<string, boolean>) => void;
  setSidebarScrollTop: (projectId: string, scrollTop: number) => void;
  setTabListScrollTop: (projectId: string, scrollTop: number) => void;
  getTabListScrollTop: (projectId: string) => number;
  getSidebarState: (projectId: string) => {
    sidebarOpen: boolean;
    openFilePath: string | null;
    sidebarExpandedDirs: Record<string, boolean> | null;
    sidebarScrollTop: number;
  };
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

const normalizeGeneratedTabName = (name: string): string => {
  let clean = String(name || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[`"'“”«»]+|[`"'“”«».:;!?]+$/g, '')
    .trim();
  const chars = Array.from(clean);
  if (chars.length > 64) {
    clean = chars.slice(0, 64).join('').trim();
  }
  return clean;
};

// Debounce timer for session saving
let saveSessionTimer: NodeJS.Timeout | null = null;
const projectTabSaveQueue = createProjectTabSaveQueue();
const projectTabCreationQueue = createProjectTabSaveQueue();
const projectTabSaveRevisions = new Map<string, number>();

// Helper to save tabs to database (immediate, no debounce)
// forceCleanup: bypass safety guard when reduction is intentional (batch move/close)
const saveTabs = (
  projectId: string,
  tabs: Map<string, Tab>,
  forceCleanup = false,
  expectedTabIds: string[] | null = null,
) => {
  const persistenceRevision = (projectTabSaveRevisions.get(projectId) || 0) + 1;
  projectTabSaveRevisions.set(projectId, persistenceRevision);
  const tabsArray = Array.from(tabs.values()).map((tab) => ({
    name: tab.name,
    cwd: tab.cwd,
    color: tab.color,
    isUtility: false,
    commandType: tab.commandType, // Preserve to prevent auto-rename on resume
    claudeSessionId: tab.claudeSessionId,
    geminiSessionId: tab.geminiSessionId,
    codexSessionId: tab.codexSessionId,
    codexModel: tab.codexModel,
    codexEffort: tab.codexEffort,
    codexSettingsProofAt: tab.codexSettingsProofAt,
    codexSettingsProofSessionId: tab.codexSettingsProofSessionId,
    codexModelMigrationPending: tab.codexModelMigrationPending,
    codexModelMigrationRestoreDefaultModel: tab.codexModelMigrationRestoreDefaultModel,
    codexModelMigrationRestoreDefaultEffort: tab.codexModelMigrationRestoreDefaultEffort,
    codexModelMigrationSourceModel: tab.codexModelMigrationSourceModel,
    codexModelMigrationSourceEffort: tab.codexModelMigrationSourceEffort,
    codexModelMigrationTargetModel: tab.codexModelMigrationTargetModel,
    codexModelMigrationConfigPath: tab.codexModelMigrationConfigPath,
    codexModelMigrationConfigFingerprint: tab.codexModelMigrationConfigFingerprint,
    codexModelMigrationConfigAlreadyTarget: tab.codexModelMigrationConfigAlreadyTarget,
    externalRun: tab.externalRun,
    wasInterrupted: tab.wasInterrupted,
    overlayDismissed: tab.overlayDismissed,
    notes: tab.notes,
    taskPlan: tab.taskPlan,
    tabType: tab.tabType,
    filePath: tab.filePath,
    createdAt: tab.createdAt,
    // Durable tab-visit time. Main applies never-downgrade, so payloads that
    // omit it (rename, colour, reorder — most of them) keep the stored value.
    lastActivatedAt: tab.lastActivatedAt,
    isCollapsed: tab.isCollapsed,
    sessionStatus: tab.sessionStatus,
    completionNotificationPersistent: tab.completionNotificationPersistent,
    restartAfterTabId: tab.restartAfterTabId,
    restartAfterTabIds: tab.restartAfterTabIds,
    restartAfterCommand: tab.restartAfterCommand,
    restartAfterPaused: tab.restartAfterPaused,
    restartAfterPersistent: tab.restartAfterPersistent,
    restartAfterArmed: tab.restartAfterArmed,
    groupId: tab.groupId,
    visualParentTabId: tab.visualParentTabId,
    windowScoped: tab.windowScoped,
    nameSetManually: tab.nameSetManually,
    // Which session ids this tab has carried, and who wrote each one. This is
    // what the "Revert Session" menu offers — the last line of defence when the
    // bridge watcher stamps a dead session onto a live tab
    // (fix-bridge-stale-takeover.md). It was collected in memory and never sent
    // here, so the database column was NULL on every row and the menu never
    // appeared: the whole safety net existed only until the next restart.
    claudeSessionHistory: tab.claudeSessionHistory,
    tabId: tab.id
  }));
  return projectTabSaveQueue.enqueue(projectId, () => (
    ipcRenderer.invoke('project:save-tabs', {
      projectId,
      tabs: tabsArray,
      forceCleanup,
      expectedTabIds,
    })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[Store:saveTabs] failed project=' + dndShortId(projectId) + ' error=' + message);
        return { success: false, error: message };
      })
  )).then((result: any) => ({ ...(result || {}), persistenceRevision }));
};

const notifyProjectLayoutChanged = (projectId: string, reason: string) => {
  ipcRenderer.invoke('project:layout-changed', { projectId, reason }).catch(() => {});
};

const notifyProjectOrderChanged = (reason: string) => {
  ipcRenderer.invoke('project:order-changed', { reason }).catch(() => {});
};

const saveTabsThenNotifyProjectLayoutChanged = (
  projectId: string,
  tabs: Map<string, Tab>,
  reason: string,
  forceCleanup = false,
  expectedTabIds: string[] | null = null,
) => {
  return saveTabs(projectId, tabs, forceCleanup, expectedTabIds).then((result: any) => {
    if (result?.success !== false) notifyProjectLayoutChanged(projectId, reason);
    return result;
  });
};

const rollbackUnmaterializedCreatedTab = (projectId: string, tabId: string) => {
  const persistenceRevision = (projectTabSaveRevisions.get(projectId) || 0) + 1;
  projectTabSaveRevisions.set(projectId, persistenceRevision);
  return projectTabSaveQueue.enqueue(projectId, () => (
    ipcRenderer.invoke('tab:rollback-unmaterialized-create', { projectId, tabId })
      .catch((error: unknown) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }))
  ));
};

const commitCodexSessionId = async (
  projectId: string,
  tabId: string,
  sessionId: string | null,
  expectedSessionId: string | null,
  reason: string,
): Promise<any> => {
  const result = await ipcRenderer.invoke('tab:set-codex-session-id', {
    projectId,
    tabId,
    sessionId,
    expectedSessionId,
    reason,
  });
  if (result?.success === false) {
    const error: any = new Error(result.error || 'codex_session_point_write_failed');
    error.result = result;
    throw error;
  }
  return result;
};

const saveTabGroups = (projectId: string, groups: TabGroup[]) => {
  const seq = ++tabGroupSaveSeq;
  const start = performance.now();
  console.warn(
    '[TabGroupCollapse:save]' +
    ' phase=start' +
    ` seq=${seq}` +
    ` project=${dndShortId(projectId)}` +
    ` groups=${summarizeDndGroups(groups)}` +
    ` t=${Math.round(start)}`
  );
  return ipcRenderer.invoke('project:save-tab-groups', { projectId, groups })
    .then((result: any) => {
      console.warn(
        '[TabGroupCollapse:save]' +
        ' phase=done' +
        ` seq=${seq}` +
        ` project=${dndShortId(projectId)}` +
        ` durMs=${Math.round(performance.now() - start)}` +
        ` groups=${summarizeDndGroups(groups)}`
      );
      if (result?.success !== false) notifyProjectLayoutChanged(projectId, 'tab-groups');
      return result;
    })
    .catch((error: unknown) => {
      console.warn(
        '[TabGroupCollapse:save]' +
        ' phase=error' +
        ` seq=${seq}` +
        ` project=${dndShortId(projectId)}` +
        ` durMs=${Math.round(performance.now() - start)}` +
        ` error=${error instanceof Error ? JSON.stringify(error.message) : JSON.stringify(String(error))}`
      );
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    });
};

// Center follows the activated tab's project; the sidebar does not. Before
// the first cross-project divergence focusedProjectId is null (legacy
// sessions) — pin it to the previous center so the sidebar visibly stays.
// Tab activation moves BOTH pointers: the centre (activeProjectId) and the
// sidebar (focusedProjectId). One-pointer model (2026-08-17): activating a tab
// means the sidebar shows that tab's project — the user reads the sidebar as
// the map of "where I am", and with cross-project panes the old rule («смена
// вкладки ≠ смена проекта») left them working in a project whose tabs the
// sidebar did not show at all.
//
// The sidebar can still be PARKED on another project by an explicit project
// click (showWorkspace) — that parking holds until the next tab activation,
// which is exactly this patch.
const activationFollowPatch = (
  st: { activeProjectId: string | null; focusedProjectId: string | null },
  projectId: string,
): Partial<Pick<WorkspaceStore, 'activeProjectId' | 'focusedProjectId'>> => (
  st.activeProjectId === projectId && st.focusedProjectId === projectId
    ? {}
    : { activeProjectId: projectId, focusedProjectId: projectId }
);

// Selector helper for project-owned surfaces (sidebar, toolbar, titlebar,
// git, project home): the explicitly chosen project, falling back to the
// center's project until the two ever diverge.
export const selectFocusedProjectId = (
  s: { focusedProjectId: string | null; activeProjectId: string | null },
): string | null => s.focusedProjectId || s.activeProjectId;

// Идентификаторы вкладок одной РАСКЛАДКИ (окна + полосы центра) — то же
// множество, которым пространство считает свои вкладки (spaceTabIds), но для
// уже извлечённой раскладки. Нужен switchWorkspaceSpace: «осталась ли
// сохранённая вкладка в этом пространстве» обязано отвечаться тем же правилом.
const tabIdsOfPanesInLayout = (layout: any): Set<string> => {
  const ids = new Set<string>(allPaneTabIds(layout?.splitPanes || []));
  Object.values(layout?.centerStrips || {}).forEach((strip: any) => {
    (Array.isArray(strip) ? strip : []).forEach((e: any) => { if (e?.tabId) ids.add(e.tabId); });
  });
  return ids;
};

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  view: 'dashboard',
  activeProjectId: null,
  focusedProjectId: null,
  getFocusedProjectId: () => get().focusedProjectId || get().activeProjectId,
  openProjects: new Map(),
  projectHistory: [],
  globalTabMru: [],
  touchGlobalTabMru: (projectId, tabId) => {
    const { globalTabMru, isRestoring, openProjects } = get();
    if (isRestoring) return; // restore replays activations; keep the saved order
    // FRESHNESS FOLLOWS FOCUS — every activation, including one onto a tab that
    // was already on screen in another pane. Being visible is a separate
    // question, and it is asked by the switcher about its own rows, not here.
    //
    // This used to be gated on "did the tab APPEAR", which froze the rank of any
    // tab living in a pane: it could be worked in all day without one recorded
    // event, because it never appeared — it was already there — and leaving the
    // screen is not an event either. Every unrelated activation then pushed it
    // one place down. Reported live: *«вкладка отходит всё назад и назад»* — the
    // tab just worked in showed up tenth in Ctrl+Tab. See tabVisitHistoryRule.
    if (!isVisitWorthRecording({ tabId })) return;
    const isAlreadyFreshest = globalTabMru[0]?.tabId === tabId;
    // Durable half of the same event: stamp the tab itself, so the visit order
    // survives a restart even for projects whose in-session list is empty.
    // Written here — the one place every activation path already funnels
    // through — rather than at each call site, which is how the per-project
    // list and the global list drifted apart in the first place.
    //
    // Skipped when the tab is ALREADY the freshest: re-focusing it cannot change
    // any relative order, and each stamp costs a full tab-list write. The
    // `!tab.lastActivatedAt` half is not optional — a restored tab can head the
    // list with no stamp at all (ranked by the saved fallback order), and
    // skipping it would leave it unstamped forever, sinking it below every
    // stamped tab on the next restart.
    const workspace = openProjects.get(projectId);
    const tab = workspace?.tabs.get(tabId);
    if (tab && (!isAlreadyFreshest || !tab.lastActivatedAt)) {
      tab.lastActivatedAt = Date.now();
      // Persist through the normal tab writer. Callers below already re-set
      // openProjects and call saveSession; this one write is what makes the
      // stamp durable.
      saveTabs(projectId, workspace!.tabs);
    }
    if (isAlreadyFreshest) return; // no-op → no re-render
    set({ globalTabMru: touchMru(globalTabMru, projectId, tabId) });
  },

  forgetGlobalTabVisit: (projectId, tabId) => {
    if (!tabId) return;
    const { globalTabMru, openProjects } = get();
    // BOTH halves, or the removal does not survive a restart: restore derives
    // the order from each tab's durable stamp and uses the saved array only for
    // unstamped tabs, so clearing the array alone would let the entry come back
    // on the next launch (the same asymmetry that once made the saved list
    // shrink irreversibly — see rebuildGlobalTabMru).
    const workspace = openProjects.get(projectId);
    const tab = workspace?.tabs.get(tabId);
    if (tab && tab.lastActivatedAt) {
      delete tab.lastActivatedAt;
      saveTabs(projectId, workspace!.tabs);
    }
    const next = dropFromMru(globalTabMru, tabId);
    if (next.length !== globalTabMru.length) set({ globalTabMru: next });
    console.log('[TabHistory] forget-global tab=' + tabId.slice(-12));
    get().saveSession();
  },

  // ── Split workspace ──────────────────────────────────────────────────────
  splitPanes: [],
  splitFocusedIndex: 0,
  splitSizes: null,
  commitSplitSizes: (sizes) => {
    // Pack at the write: an equal split stores null, and sizes for a structure
    // that no longer matches self-clean instead of shadowing the next layout.
    const packed = packSplitSizes(get().splitPanes, sizes);
    const prev = get().splitSizes;
    if (packed === null && prev === null) return;
    set({ splitSizes: packed });
    console.log('[Split] sizes ' + (packed
      ? 'cols=' + packed.cols.map((f) => f.toFixed(3)).join('/')
      : 'reset-to-equal'));
    get().saveSession();
  },
  addTabToSplit: (projectId, tabId) => {
    const { splitPanes, splitFocusedIndex, activeProjectId, openProjects } = get();
    const activeWs = activeProjectId ? openProjects.get(activeProjectId) : null;
    const current = activeProjectId && activeWs?.activeTabId
      ? { projectId: activeProjectId, tabId: activeWs.activeTabId }
      : null;
    const res = addPane(splitPanes, splitFocusedIndex, current, { projectId, tabId });
    if (!res) return false;
    // A split STARTED from single mode is a NEW layout and opens equal. The
    // read-time drift rule cannot catch this case: sizes of a dead 2-column
    // layout still COUNT-match a fresh 2-column one, so without the explicit
    // clear, closing a 65/35 split and later splitting two unrelated tabs
    // would reopen at 65/35. (Add/remove within a living split stays covered
    // by the drift rule — a brief third pane comes and goes, and the stored
    // 2-column fractions correctly return when the shape returns.)
    set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex, ...(splitPanes.length === 0 ? { splitSizes: null } : {}) });
    console.log('[Split] addTab tab=' + tabId.slice(-12) + ' panes=' + res.panes.length + ' focus=' + res.focusedIndex);
    // Focus follows the newly added pane → its tab becomes the center tab, and
    // activation records the visit. No separate touch here: freshness follows
    // focus now, so a tab that lands on screen and takes focus is recorded by
    // the one path every activation already goes through.
    get().activateCenterTab(projectId, tabId);
    get().saveSession();
    return true;
  },

  clearTabFromSplitPane: (tabId) => {
    // «Убрать вкладку из окна», не «закрыть окно» и не «закрыть вкладку»: the
    // tab keeps living in the sidebar, the pane keeps its place and waits for
    // the next tab. Closing the pane is the placeholder's own ✕.
    //
    // With strips this removes ONE CHIP: the neighbouring chip takes over, and
    // the window goes empty only when the last chip leaves. Same sentence as
    // before, one level finer.
    const { splitPanes, splitFocusedIndex } = get();
    const detachedPaneIndex = paneIndexHoldingTab(splitPanes, tabId);
    const detachedEntry = detachedPaneIndex >= 0
      ? paneTabs(splitPanes[detachedPaneIndex]).find((entry) => entry.tabId === tabId) || null
      : null;
    const res = emptyPaneByClosedTab(splitPanes, splitFocusedIndex, tabId);
    if (!res) return false;
    const remembered = detachedEntry
      ? rememberPaneDetachedTab(res.panes, detachedPaneIndex, detachedEntry)
      : null;
    const panesAfter = remembered?.panes || res.panes;
    set({ splitPanes: panesAfter, splitFocusedIndex: res.focusedIndex });
    console.log('[Split] clearPane tab=' + tabId.slice(-12)
      + (res.emptiedIndex !== undefined ? ' emptied=' + res.emptiedIndex : ' collapsed')
      + ' panes=' + res.panes.length);
    // Removing the LAST chip does not mean "work in another window". Keep the
    // focus ring on this empty slot so Cmd+T fills it and Shift+Cmd+T can undo
    // this exact removal. The old fallback activated a survivor, which silently
    // moved splitFocusedIndex and made the very next shortcut target another
    // pane. If this pane still has a chip, activate that replacement normally.
    const keepFocusedEmpty = detachedPaneIndex === splitFocusedIndex
      && isEmptyPane(panesAfter[res.focusedIndex]);
    const focusedAfter = panesAfter[res.focusedIndex];
    const next = (focusedAfter && focusedAfter.tabId ? focusedAfter : null)
      || res.survivor
      || panesAfter.find((p) => p.tabId)
      || null;
    if (keepFocusedEmpty) {
      if (get().activeSpaceTab?.tabId === tabId) set({ activeSpaceTab: null });
    } else if (next && next.tabId) get().activateCenterTab(next.projectId, next.tabId);
    else if (get().activeSpaceTab?.tabId === tabId) set({ activeSpaceTab: null });
    get().saveSession();
    return true;
  },

  detachTabFromWindow: (projectId, tabId, paneIndex) => {
    const st = get();
    if (!st.openProjects.get(projectId)?.tabs.has(tabId)) return false;

    if (Number.isInteger(paneIndex) && (paneIndex as number) >= 0) {
      const pane = st.splitPanes[paneIndex as number];
      if (!pane || pane.tabId !== tabId) return false;
      // Same visible result as middle-click on the shown chip: return to the
      // exact previous owner when the pane knows one; otherwise remove this
      // chip and leave the window itself in place.
      if (get().restoreSplitPanePreviousTab(tabId)) {
        const remembered = rememberPaneDetachedTab(get().splitPanes, paneIndex as number, { projectId, tabId });
        if (remembered) set({ splitPanes: remembered.panes });
        get().saveSession();
        return true;
      }
      return get().clearTabFromSplitPane(tabId);
    }

    // Single mode can still have a multi-chip centre strip. Removing one chip
    // keeps the remaining strip and lets its own visit history choose what is
    // shown next.
    const centerKey = st.centerStripKey();
    const centerStrip = centerKey ? (st.centerStrips[centerKey] || []) : [];
    if (centerStrip.some((entry) => entry.tabId === tabId)) {
      get().removeTabFromCenterStrip(projectId, tabId);
      return true;
    }

    if (st.splitPanes.length > 0 || st.getEffectiveTabId() !== tabId) return false;

    // `splitPanes: []` means "single centre" and therefore can never express
    // an empty window. Materialise one empty placeholder instead. The sidebar
    // pointers deliberately stay where they are: the tab still exists there,
    // while `activeSpaceTab` is cleared because this workflow no longer shows
    // it in a window.
    set({
      splitPanes: [{ projectId: '', tabId: '' }],
      splitFocusedIndex: 0,
      splitSizes: null,
      activeSpaceTab: null,
    });
    console.log('[Split] detachCenter tab=' + tabId.slice(-12) + ' empty=1');
    get().saveSession();
    return true;
  },

  removeTabFromSplit: (tabId) => {
    const { splitPanes, splitFocusedIndex } = get();
    const res = removePaneByTab(splitPanes, splitFocusedIndex, tabId);
    if (!res) return;
    set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex });
    console.log('[Split] removeTab tab=' + tabId.slice(-12) + ' panes=' + res.panes.length);
    // Keep the center on a still-visible pane's tab. When the split COLLAPSES
    // there is no pane list left to read that from, so the model names the
    // survivor: single mode shows one tab, and it must be the one that stayed
    // on screen. Reading res.panes[0] here silently did nothing on collapse and
    // left the center on the tab that had just been taken off screen.
    const next = res.panes[res.focusedIndex] || res.survivor;
    if (next && next.tabId) get().activateCenterTab(next.projectId, next.tabId);
    get().saveSession();
  },

  addEmptySplitPane: (anchorPaneIndex, side = 'right') => {
    const st = get();
    const activeWs = st.activeProjectId ? st.openProjects.get(st.activeProjectId) : null;
    // Single mode: the current CENTER tab becomes pane 0. In split mode the
    // placeholder opens immediately to the RIGHT of the pane whose split
    // button was pressed (afterPaneIndex), not at the far end.
    const current = st.activeProjectId && activeWs?.activeTabId
      ? { projectId: st.activeProjectId, tabId: activeWs.activeTabId }
      : null;
    const res = addEmptyPane(
      st.splitPanes,
      st.splitFocusedIndex,
      current,
      anchorPaneIndex ?? null,
      side,
    );
    if (!res) return false;
    // New layout from single mode opens equal — see addTabToSplit.
    set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex, ...(st.splitPanes.length === 0 ? { splitSizes: null } : {}) });
    console.log('[Split] addEmptyPane side=' + side + ' panes=' + res.panes.length + ' focus=' + res.focusedIndex);
    // Placeholder is session-transient (sanitizePanes drops it on restore),
    // but persisting the REAL panes' new geometry keeps restart honest.
    get().saveSession();
    return true;
  },

  addVerticalSplitPane: (atPaneIndex, side) => {
    const st = get();
    const activeWs = st.activeProjectId ? st.openProjects.get(st.activeProjectId) : null;
    const current = st.activeProjectId && activeWs?.activeTabId
      ? { projectId: st.activeProjectId, tabId: activeWs.activeTabId }
      : null;
    const res = addEmptyPaneVertical(
      st.splitPanes,
      st.splitFocusedIndex,
      current,
      atPaneIndex ?? null,
      side,
    );
    if (!res) return false;
    // New layout from single mode opens equal — see addTabToSplit.
    set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex, ...(st.splitPanes.length === 0 ? { splitSizes: null } : {}) });
    console.log('[Split] addVerticalPane side=' + side
      + ' panes=' + res.panes.length + ' focus=' + res.focusedIndex);
    get().saveSession();
    return true;
  },

  // Здесь был `setSplitPaneTab` — «показать вкладку В ЭТОЙ панели, не переходя
  // на неё». Единственным его вызовом был список недавних по наведению в шапке
  // панели, удалённый 2026-08-17 вместе с ним. Если сценарий «подготовить
  // соседнее окно, не уходя из своего» вернётся, восстанавливать нужно вместе
  // с двумя правилами, которые здесь стоили крови: пересборка панели ТОЛЬКО
  // через `paneWithHistoryFrom` (иначе теряется история и колонка панели) и
  // явная отметка посещения с ДО-записи снимком экрана (иначе появление
  // вкладки не попадает в общую историю).

  restoreSplitPanePreviousTab: (tabId) => {
    const st = get();
    // Middle-click means "remove what I just brought here and go back" for
    // EVERY tab type. This matters most after explicit MOVE HERE: the displaced
    // tab is no longer a chip anywhere (one-placement invariant), but it is the
    // newest valid entry in this pane's history and remains a durable sidebar
    // tab. Gating step-back on `tabType === file` left a normal moved tab's pane
    // empty even though the exact previous owner was known.
    const paneOwner = st.splitPanes.find((pane) => pane.tabId === tabId);
    if (!paneOwner) return false;
    const res = restorePanePreviousTab(
      st.splitPanes,
      st.splitFocusedIndex,
      tabId,
      (projectId, candidateId) => !!st.openProjects.get(projectId)?.tabs.get(candidateId),
    );
    if (!res) return false;
    set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex });
    const restored = res.panes[res.restoredIndex];
    console.log('[Split] restorePrevTab pane=' + res.restoredIndex
      + ' tab=' + String(restored?.tabId || '').slice(-12));
    // The pane the user acted on becomes the focused one, and the center
    // follows it — same rule as clicking that pane.
    if (restored?.tabId) get().activateCenterTab(restored.projectId, restored.tabId);
    get().saveSession();
    return true;
  },

  restoreLastDetachedTabToSplitPane: (paneIndex) => {
    const st = get();
    if (!Number.isInteger(paneIndex) || paneIndex < 0 || !st.splitPanes[paneIndex]) return false;
    const restored = restorePaneDetachedTab(
      st.splitPanes,
      paneIndex,
      (projectId, tabId) => !!st.openProjects.get(projectId)?.tabs.has(tabId),
    );
    if (!restored) return false;
    set({ splitPanes: restored.panes, splitFocusedIndex: paneIndex });
    console.log('[Split] restoreDetached pane=' + paneIndex
      + ' tab=' + restored.restored.tabId.slice(-12));
    get().activateCenterTab(restored.restored.projectId, restored.restored.tabId);
    get().saveSession();
    return true;
  },

  centerStrips: {},

  // ── Рабочие пространства ────────────────────────────────────────────────
  //
  // Одно пространство есть ВСЕГДА: состояния «ни одного» не существует, поэтому
  // приложению не нужен экран, которого больше нигде нет. До первого
  // восстановления это то самое единственное, и его раскладка — та, что уже
  // лежит в сторе.
  spaces: [{ id: 'space-1', name: 'main', icon: null, projectIds: [], layout: {} }],
  activeSpaceTab: null,
  activeSpaceId: 'space-1',

  addWorkspaceSpace: (options) => {
    const st = get();
    const id = 'space-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const activate = options?.activate !== false;
    const res = addSpace(st.spaces, st.activeSpaceId, id, options?.name, { icon: null, projectIds: [] });
    if (!res) return null;
    // Settings создаёт workflow В ФОНЕ: добавление записи не должно выбрасывать
    // человека из текущих окон в новую пустую раскладку. Двойной клик по самой
    // полосе сохраняет прежний контракт и активирует созданное пространство.
    if (!activate) {
      set({ spaces: res.spaces });
      console.log('[Spaces] add-background id=' + id + ' total=' + res.spaces.length);
      get().saveSession();
      return id;
    }
    // Уходящее пространство обязано забрать свою раскладку С СОБОЙ, иначе
    // следующее переключение затрёт её пустой: раскладка живёт в общем
    // состоянии, а не внутри пространства.
    const saved = res.spaces.map((space: any) => (
      space.id === st.activeSpaceId ? { ...space, layout: captureSpaceLayout(st) } : space
    ));
    set({
      spaces: saved,
      activeSpaceId: res.activeSpaceId,
      // Новое пространство — ОДНО ПУСТОЕ ОКНО, а не «окон нет».
      //
      // Разница видна сразу: «окон нет» в этом приложении означает одиночный
      // режим, а он всегда показывает вкладку центра — ту самую, на которой
      // человек стоял. Со стороны это читается как «моя вкладка переехала в
      // новое пространство», хотя переезжать ей туда незачем: пространство
      // создают, чтобы разложить вкладки самому. Юзер: *«мы создали новое
      // пространство, я потом буду туда по отдельности тыкать какие-то
      // вкладки… у меня будет пустое окно»*.
      //
      // Пустое окно — уже существующее состояние с кнопками запуска и двойным
      // кликом, поэтому новых экранов не появляется. Как только в него кладут
      // вкладку, раскладка сама схлопывается в одиночный режим
      // (resolveSplitActivation): одно окно с вкладкой и есть одиночный режим.
      //
      // Указатели проектов остаются на месте — пустому окну надо знать, где
      // запускать.
      splitPanes: [{ projectId: '', tabId: '' }],
      splitFocusedIndex: 0,
      splitSizes: null,
      centerStrips: {},
    });
    console.log('[Spaces] add id=' + res.activeSpaceId + ' total=' + saved.length);
    get().saveSession();
    return id;
  },

  removeWorkspaceSpace: (id) => {
    const st = get();
    const res = removeSpaceFromList(st.spaces, st.activeSpaceId, id);
    if (!res) return; // последнее не удаляется
    // Удаляют РАСКЛАДКУ: вкладки остаются в списке проекта, процессы живут.
    // Поэтому подтверждения нет — цена ошибки здесь ниже, чем у закрытой
    // вкладки, а вернуться можно, разложив окна заново.
    const movingAway = st.activeSpaceId === id;
    const target = res.spaces.find((space: any) => space.id === res.activeSpaceId);
    set({
      spaces: res.spaces,
      activeSpaceId: res.activeSpaceId,
      // Уходим из удаляемого — показываем раскладку наследника. `emptySpaceLayout`
      // подстилает поля, которых в старом снимке могло не быть.
      ...(movingAway ? { ...emptySpaceLayout(), ...(target?.layout || {}) } : {}),
    });
    console.log('[Spaces] remove id=' + id + ' active=' + res.activeSpaceId + ' left=' + res.spaces.length);
    // This is the ONE legitimate path that makes the workflow-id set smaller.
    // Persist immediately with explicit intent so main can reject every other
    // disappearing-id snapshot (especially shutdown during partial restore).
    get().saveSessionImmediate({
      reason: 'workspace-space-remove',
      source: 'renderer',
      allowWorkspaceSpaceRemoval: true,
    });
  },

  renameWorkspaceSpace: (id, name) => {
    const res = renameSpaceInList(get().spaces, id, name);
    if (!res) return;
    set({ spaces: res.spaces });
    get().saveSession();
  },

  reorderWorkspaceSpaces: (orderedIds) => {
    const result = reorderSpacesInList(get().spaces, orderedIds);
    if (!result) return false;
    set({ spaces: result.spaces });
    console.log('[Spaces] reorder ids=' + orderedIds.join(','));
    get().saveSession();
    return true;
  },

  updateWorkspaceSpaceMetadata: (id, updates) => {
    const st = get();
    // Inbox — системная рабочая поверхность, не directory-project и не ребёнок
    // пользовательского workflow. Legacy layout мог вывести его из active
    // project; на входе metadata отсекаем его ещё раз как boundary-инвариант.
    const safeUpdates = Object.prototype.hasOwnProperty.call(updates, 'projectIds')
      ? { ...updates, projectIds: (updates.projectIds || []).filter((projectId) => !isInboxProjectId(projectId)) }
      : updates;
    const res = updateSpaceMetadata(st.spaces, id, safeUpdates);
    if (!res) return false;

    let spaces = res.spaces;
    if (Object.prototype.hasOwnProperty.call(safeUpdates, 'projectIds')) {
      // Settings рисует настоящее дерево, не теги: у проекта один workflow-
      // родитель. Переназначение переносит project-chip целиком и не оставляет
      // дубликат, который потом дважды посчитал бы один процесс в двух badge.
      const claimed = new Set(res.space.projectIds || []);
      if (claimed.size > 0) {
        spaces = spaces.map((space: any) => (
          space.id === id
            ? space
            : {
              ...space,
              projectIds: (space.projectIds || []).filter((projectId: string) => !claimed.has(projectId)),
            }
        ));
      }
    }
    const defaultProjectId = res.space.projectIds?.[0] || null;
    const topLevel: Record<string, any> = {};
    // Первый выбранный проект становится default только для действительно
    // пустого workflow. Уже разложенные окна/текущий проект не двигаем:
    // настройка связи не имеет права перестраивать рабочее место.
    if (defaultProjectId) {
      const isActive = id === st.activeSpaceId;
      const sourceLayout = isActive ? st : (res.space.layout || {});
      const hasProjectContext = !!sourceLayout.activeProjectId || !!sourceLayout.focusedProjectId;
      if (!hasProjectContext) {
        if (isActive) {
          topLevel.activeProjectId = defaultProjectId;
          topLevel.focusedProjectId = defaultProjectId;
        } else {
          spaces = spaces.map((space: any) => (
            space.id === id
              ? {
                ...space,
                layout: {
                  ...emptySpaceLayout(),
                  ...(space.layout || {}),
                  activeProjectId: defaultProjectId,
                  focusedProjectId: defaultProjectId,
                },
              }
              : space
          ));
        }
      }
    }

    set({ spaces, ...topLevel });
    get().saveSession();
    return true;
  },

  switchWorkspaceSpace: (id) => {
    const switchStartedAt = performance.now();
    const st = get();
    const res = switchSpaceInList(st.spaces, st.activeSpaceId, id, captureSpaceLayout(st));
    if (!res) return;
    const previousSpaceId = st.activeSpaceId;
    const endSwitchMark = markRendererActivity('workflow-switch:' + id.slice(-8));
    // Приходящая раскладка чистится ЗДЕСЬ, а не при восстановлении сессии: пока
    // в пространство не вернулись, его окна могут указывать на вкладки, которые
    // за это время закрыли, — а вкладки проектов, ещё не открытых в этом
    // запуске, на старте вообще неизвестны. Момент возврата — первый, когда
    // ответ «жива ли эта вкладка» становится достоверным.
    const alive = (projectId: string, tabId: string) => (
      !!get().openProjects.get(projectId)?.tabs.has(tabId)
    );
    const layout: any = { ...res.layout };
    const scrubbed = sanitizePanes(layout.splitPanes || [], layout.splitFocusedIndex ?? 0, alive);
    layout.splitPanes = scrubbed.panes;
    layout.splitFocusedIndex = scrubbed.focusedIndex;
    layout.splitSizes = packSplitSizes(scrubbed.panes, layout.splitSizes ?? null);
    const strips: Record<string, Array<{ projectId: string; tabId: string }>> = {};
    Object.entries(layout.centerStrips || {}).forEach(([pid, raw]) => {
      const kept = (Array.isArray(raw) ? raw : [])
        .filter((e: any) => e && e.tabId && alive(e.projectId, e.tabId));
      if (kept.length > 1) strips[pid] = kept as Array<{ projectId: string; tabId: string }>;
    });
    layout.centerStrips = strips;
    // Вкладка пространства проверяется той же меркой, что и его окна: пока
    // сюда не возвращались, её могли закрыть.
    const savedTab = layout.activeSpaceTab;
    let tabAlive = !!savedTab?.tabId && alive(savedTab.projectId, savedTab.tabId);
    // …и ещё одной: осталась ли она ВООБЩЕ в этом пространстве. Вкладку могли
    // увести в окно другого пространства; восстановление тогда активировало бы
    // её, а правило «вкладка живёт там, где разложена» немедленно увело бы из
    // пространства, в которое человек только что кликнул, — «кликаю на
    // пространство, перекидывает обратно». Уехавшую вкладку не восстанавливаем:
    // пространство показывает свою раскладку, а не гонится за беглянкой.
    if (tabAlive && savedTab) {
      const inThisLayout = tabIdsOfPanesInLayout(layout).has(savedTab.tabId);
      if (!inThisLayout) {
        const heldElsewhere = spaceIndexHoldingTab(
          res.spaces.filter((s: any) => s.id !== res.activeSpaceId),
          savedTab.tabId,
          allPaneTabIds,
        ) >= 0;
        if (heldElsewhere) tabAlive = false;
      }
    }
    if (!tabAlive) layout.activeSpaceTab = null;
    const planDoneAt = performance.now();
    set({ spaces: res.spaces, activeSpaceId: res.activeSpaceId, ...layout });
    const storeSetDoneAt = performance.now();
    // Возврат в пространство — это возврат и к вкладке, на которой человек
    // стоял: раскладка без неё показывала бы центр от соседнего пространства.
    // Если её ещё надо показать — используем обычную активацию. Если сохранённая
    // раскладка уже показывает её, layout не трогаем, но отдельно записываем
    // визит: показ и свежесть — два разных факта.
    let activationMs = 0;
    if (tabAlive && savedTab) {
      const focusedPane = layout.splitPanes?.[layout.splitFocusedIndex ?? 0];
      const alreadyShown = focusedPane
        ? focusedPane.tabId === savedTab.tabId
        : get().openProjects.get(savedTab.projectId)?.activeTabId === savedTab.tabId;
      if (!alreadyShown) {
        const activationStartedAt = performance.now();
        get().activateCenterTab(savedTab.projectId, savedTab.tabId);
        activationMs = performance.now() - activationStartedAt;
      } else {
        // Returning to a workflow is still a VISIT even when its saved tab is
        // already drawn in the focused window. Skipping the whole activation
        // correctly avoids a redundant layout write, but must not skip the
        // independent navigation fact: if the user immediately replaces this
        // tab and presses Ctrl+Tab, this is the tab they expect to get back.
        //
        // Live failure (2026-08-25): workflow → saved tab A (already shown) →
        // sidebar tab B replaces A → Ctrl+Tab jumped to another workflow,
        // because A had never become the freshest off-screen visit.
        const activationStartedAt = performance.now();
        get().touchGlobalTabMru(savedTab.projectId, savedTab.tabId);
        activationMs = performance.now() - activationStartedAt;
      }
    }
    console.log('[Spaces] switch to=' + id
      + ' panes=' + (res.layout.splitPanes?.length || 0)
      + ' tab=' + (tabAlive ? String(savedTab.tabId).slice(-12) : 'none'));
    const saveStartedAt = performance.now();
    get().saveSession();
    const syncDoneAt = performance.now();
    console.warn('[Perf:WorkflowSwitchStart] from=' + previousSpaceId
      + ' to=' + id
      + ' panes=' + layout.splitPanes.length
      + ' planMs=' + (planDoneAt - switchStartedAt).toFixed(1)
      + ' setMs=' + (storeSetDoneAt - planDoneAt).toFixed(1)
      + ' activationMs=' + activationMs.toFixed(1)
      + ' saveScheduleMs=' + (syncDoneAt - saveStartedAt).toFixed(1)
      + ' syncMs=' + (syncDoneAt - switchStartedAt).toFixed(1)
      + ' startAbs=' + (performance.timeOrigin + switchStartedAt).toFixed(1));
    requestAnimationFrame(() => {
      endSwitchMark();
      console.warn('[Perf:WorkflowSwitch] from=' + previousSpaceId
        + ' to=' + id
        + ' panes=' + layout.splitPanes.length
        + ' durMs=' + (performance.now() - switchStartedAt).toFixed(1));
      requestAnimationFrame(() => {
        console.warn('[Perf:WorkflowSwitchFrame2] from=' + previousSpaceId
          + ' to=' + id
          + ' panes=' + layout.splitPanes.length
          + ' durMs=' + (performance.now() - switchStartedAt).toFixed(1));
      });
    });
  },

  recoverWorkspaceSpaces: (request) => {
    const st = get();
    const knownProjectTabs = new Map<string, Set<string>>(
      Object.entries(request?.knownProjectTabs || {}).map(([projectId, tabIds]) => [
        projectId,
        new Set(Array.isArray(tabIds) ? tabIds : []),
      ]),
    );
    const result = recoverWorkspaceSpacesModel({
      spaces: st.spaces,
      activeSpaceId: st.activeSpaceId,
      liveState: st,
      candidates: request?.candidates,
      overwriteExistingIds: request?.overwriteExistingIds,
      expectedFingerprint: request?.expectedFingerprint,
      reassignProjects: request?.reassignProjects === true,
      projectExists: (projectId: string) => (
        st.openProjects.has(projectId) || knownProjectTabs.has(projectId)
      ),
      tabExists: (projectId: string, tabId: string) => (
        !!st.openProjects.get(projectId)?.tabs.has(tabId)
        || knownProjectTabs.get(projectId)?.has(tabId) === true
      ),
      isSystemProject: isInboxProjectId,
    });
    if (!result.ok) return result;

    if (request?.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        addedIds: result.addedIds,
        replacedIds: result.replacedIds,
        skippedIds: result.skippedIds,
        missingTabs: result.missingTabs,
        fingerprintBefore: result.fingerprintBefore,
        fingerprintAfter: result.fingerprintAfter,
      };
    }

    const activeLayoutReplaced = result.replacedIds.includes(st.activeSpaceId);
    set({
      spaces: result.spaces,
      activeSpaceId: result.activeSpaceId,
      ...(activeLayoutReplaced ? result.activeLayout : {}),
    });
    // Recovery is an explicit API transaction, not ordinary UI churn. Return
    // success only after the repaired snapshot is in SQLite; otherwise a crash
    // in the debounce window could report success and lose it again.
    get().saveSessionImmediate({
      reason: 'workspace-space-recovery',
      source: 'workspace-api',
    });
    console.warn('[Spaces:Recovery] added=' + result.addedIds.join(',')
      + ' replaced=' + result.replacedIds.join(',')
      + ' missingTabs=' + result.missingTabs.length
      + ' before=' + result.fingerprintBefore
      + ' after=' + result.fingerprintAfter);
    return {
      ok: true,
      addedIds: result.addedIds,
      replacedIds: result.replacedIds,
      skippedIds: result.skippedIds,
      missingTabs: result.missingTabs,
      fingerprintBefore: result.fingerprintBefore,
      fingerprintAfter: result.fingerprintAfter,
    };
  },

  workspaceSpaceTabCount: (id) => {
    const st = get();
    const space = st.spaces.find((s: any) => s.id === id);
    if (!space) return 0;
    // Текущее пространство считается по ЖИВОМУ состоянию, а не по снимку: снимок
    // у него старше на одно переключение, и число отставало бы от того, что
    // человек прямо сейчас видит на экране.
    const layout = id === st.activeSpaceId ? captureSpaceLayout(st) : space.layout;
    return spaceTabCount({ ...space, layout }, allPaneTabIds);
  },

  workspaceSpaceBusyTabCount: (id) => {
    const st = get();
    const space = st.spaces.find((s: any) => s.id === id);
    if (!space) return 0;
    // Текущее пространство — по ЖИВОМУ состоянию (его снимок старше на одно
    // переключение), как и общее число рядом.
    const layout = id === st.activeSpaceId ? captureSpaceLayout(st) : space.layout;
    // «Занята» = агент этой вкладки сейчас отвечает. Тот же признак, по
    // которому сама вкладка показывает свой индикатор (`isAiBusyTab`), —
    // иначе число в чипе и полоски в списке спорили бы между собой.
    const isBusy = (tabId: string) => {
      for (const [, workspace] of st.openProjects) {
        const tab = workspace.tabs.get(tabId);
        if (tab) return isAiBusyTab(tab);
      }
      return false;
    };
    return spaceBusyTabCount({ ...space, layout }, allPaneTabIds, isBusy);
  },

  workspaceSpaceTabIds: (id) => {
    const st = get();
    const space = st.spaces.find((candidate: any) => candidate.id === id);
    if (!space) return [];
    const layout = id === st.activeSpaceId ? captureSpaceLayout(st) : space.layout;
    return Array.from(spaceTabIds({ ...space, layout }, allPaneTabIds));
  },

  workspaceSpaceIndexOfTab: (tabId) => {
    const st = get();
    const withLive = st.spaces.map((space: any) => (
      space.id === st.activeSpaceId ? { ...space, layout: captureSpaceLayout(st) } : space
    ));
    return spaceIndexHoldingTab(withLive, tabId, allPaneTabIds, st.activeSpaceId);
  },

  isTabPlacedInWorkspace: (tabId) => {
    if (!tabId) return false;
    const st = get();
    const layoutHasTab = (layout: any) => {
      // A lone pane collapses to the single centre and intentionally stops
      // storing a one-item strip. `activeSpaceTab` is the durable placement for
      // that shape; without it a just-created window tab would immediately
      // reappear in the sidebar after the collapse.
      if (layout?.activeSpaceTab?.tabId === tabId) return true;
      if ((layout?.splitPanes || []).some((pane: any) => (
        paneTabs(pane).some((entry: any) => entry?.tabId === tabId)
      ))) return true;
      return Object.values(layout?.centerStrips || {}).some((raw: any) => (
        (Array.isArray(raw) ? raw : []).some((entry: any) => entry?.tabId === tabId)
      ));
    };
    // Active space lives in top-level state; its saved snapshot is one switch
    // behind and must never decide sidebar visibility.
    if (layoutHasTab(st)) return true;
    return st.spaces.some((space: any) => (
      space.id !== st.activeSpaceId && layoutHasTab(space.layout)
    ));
  },

  // ПОД КАКИМ КЛЮЧОМ лежит полоса одиночного центра.
  //
  // Ключ — проект, чью вкладку центр СЕЙЧАС показывает, а не проект вкладки, о
  // которой идёт речь. Эти двое расходятся, как только в полосу попадает вкладка
  // чужого проекта (а полосы, как и окна, межпроектные), и чип потом просил бы
  // операцию по СВОЕМУ проекту — то есть по несуществующей второй полосе.
  // Один резолвер на всех, чтобы «положить» и «убрать» не могли разойтись.
  centerStripKey: () => get().activeProjectId || null,

  addTabToCenterStrip: (projectId, tabId) => {
    const st = get();
    // The strip is keyed by the project whose tab the centre is SHOWING, not by
    // the project of the tab being added: the two differ whenever a tab is added
    // from another project's list, and keying by the newcomer would start a
    // second strip that nobody is looking at.
    const centerProjectId = st.activeProjectId;
    if (!centerProjectId) return;
    const shown = st.openProjects.get(centerProjectId)?.activeTabId || '';
    const current = st.centerStrips[centerProjectId] || [];
    // A strip that did not exist starts from what the centre is showing: the
    // chip already on screen is the first one, otherwise the new tab would look
    // like it replaced something that quietly vanished.
    const base = current.length > 0
      ? current
      : (shown ? [{ projectId: centerProjectId, tabId: shown }] : []);
    if (base.length === 0) return; // нечего расширять: центр пуст
    const next = insertIntoStrip(base, projectId, tabId);
    if (next === base && current.length > 0) return;
    set({ centerStrips: { ...st.centerStrips, [centerProjectId]: next } });
    get().activateCenterTab(projectId, tabId);
    get().saveSession();
  },

  reorderCenterStripTab: (_projectId, tabId, toIndex) => {
    const st = get();
    const key = st.centerStripKey();
    if (!key) return;
    const strip = st.centerStrips[key] || [];
    const from = strip.findIndex((e) => e.tabId === tabId);
    if (from === -1) return;
    const to = Math.max(0, Math.min(strip.length - 1, toIndex | 0));
    if (to === from) return;
    const next = strip.slice();
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry);
    set({ centerStrips: { ...st.centerStrips, [key]: next } });
    get().saveSession();
  },

  removeTabFromCenterStrip: (_projectId, tabId) => {
    const st = get();
    const key = st.centerStripKey();
    if (!key) return;
    const strip = st.centerStrips[key] || [];
    const at = strip.findIndex((e) => e.tabId === tabId);
    if (at === -1) return;
    const rest = removeFromStrip(strip, tabId);
    const nextStrips = { ...st.centerStrips };
    // One chip left is not a strip: drop the record so the project goes back to
    // behaving exactly as it did before a strip was ever built here.
    if (rest.length > 1) nextStrips[key] = rest;
    else delete nextStrips[key];
    set({ centerStrips: nextStrips });
    // Центр обязан что-то показывать. Правило то же, что у окна: возвращаемся к
    // ПРЕДЫДУЩЕЙ показанной вкладке, а не к геометрическому соседу. У центра нет
    // своей истории — её роль играет история посещений проекта; берём первую
    // запись, которая ещё лежит в полосе, иначе показ пришлось бы дать вкладке
    // без чипа. Не нашли — прежнее правило соседа, чтобы жест не остался без
    // ответа.
    const workspaceOfKey = st.openProjects.get(key);
    const shown = workspaceOfKey?.activeTabId;
    if (shown === tabId && rest.length > 0) {
      const previous = [...(workspaceOfKey?.tabHistory || [])]
        .reverse()
        .find((id) => id !== tabId && rest.some((e) => e.tabId === id));
      const heir = previous
        ? rest.find((e) => e.tabId === previous)!
        : rest[Math.min(at, rest.length - 1)];
      get().activateCenterTab(heir.projectId, heir.tabId);
    }
    get().saveSession();
  },

  arrangeSplitPanes: (spec) => {
    const st = get();
    // The centre, for the single-mode case: «справа от того, на что я смотрю»
    // needs something to be to the right OF.
    const centerTabId = st.activeProjectId
      ? st.openProjects.get(st.activeProjectId)?.activeTabId || ''
      : '';
    const current = st.activeProjectId && centerTabId
      ? { projectId: st.activeProjectId, tabId: centerTabId }
      : null;
    // Only tabs that actually exist: a caller naming a closed tab would
    // otherwise get a window showing nothing.
    const windows = (spec.windows || [])
      .map((strip) => (strip || []).filter((e) => (
        e && e.tabId && st.openProjects.get(e.projectId)?.tabs.has(e.tabId)
      )))
      .filter((strip) => strip.length > 0);
    if (windows.length === 0) return null;
    const res = arrangePanes(st.splitPanes, st.splitFocusedIndex, { ...spec, windows }, current);
    if (!res) return null;
    set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex });
    console.log('[Split] arrange windows=' + windows.length
      + ' side=' + (spec.side || 'right')
      + ' divide=' + (spec.divide || 'columns')
      + ' panes=' + res.panes.length);
    // The centre follows the first window placed — the same rule as clicking it.
    const focused = res.panes[res.focusedIndex];
    if (focused?.tabId) get().activateCenterTab(focused.projectId, focused.tabId);
    get().saveSession();
    return { placedIndices: res.placedIndices, focusedIndex: res.focusedIndex };
  },

  commitWorkspaceWindowAction: (request) => {
    const st = get();
    const fingerprintBefore = workspaceSpacesFingerprint(st.spaces, st.activeSpaceId, st);
    const materialized = spacesWithLiveLayout(st.spaces, st.activeSpaceId, st);
    const tabInfo = (projectId: string, tabId: string) => {
      const tab = st.openProjects.get(projectId)?.tabs.get(tabId);
      return tab ? { name: tab.name, cwd: tab.cwd || null } : null;
    };
    const described = describeWorkspaceWindowTargets({
      spaces: materialized,
      activeSpaceId: st.activeSpaceId,
      fingerprint: fingerprintBefore,
      tabInfo,
    });
    const target = resolveWorkspaceWindowTarget({
      describedSpaces: described,
      activeSpaceId: st.activeSpaceId,
      sourceTabId: request?.sourceTabId || '',
      fingerprint: fingerprintBefore,
      target: request?.target || {},
    });
    if (!target.ok) return target;

    const entries: Array<{ projectId: string; tabId: string }> = [];
    const seen = new Set<string>();
    const rawEntries = [
      ...(request?.entries || []),
      ...((request?.windows || []).flat()),
    ];
    for (const entry of rawEntries) {
      if (!entry?.projectId || !entry?.tabId || seen.has(entry.tabId)) continue;
      if (!st.openProjects.get(entry.projectId)?.tabs.has(entry.tabId)) {
        return { ok: false, reason: 'tab_not_found', projectId: entry.projectId, tabId: entry.tabId };
      }
      seen.add(entry.tabId);
      entries.push({ projectId: entry.projectId, tabId: entry.tabId });
    }
    if (!request?.createEmptyWindow && entries.length === 0) {
      return { ok: false, reason: 'tabs_required' };
    }

    const movingIds = request?.moveExisting === false ? [] : entries.map((entry) => entry.tabId);
    const targetSpace = materialized.find((space: any) => space.id === target.spaceId);
    if (!targetSpace) return { ok: false, reason: 'space_not_found', spaceId: target.spaceId };
    const mutation = applyWorkspaceWindowMutationModel({
      layout: targetSpace.layout,
      target,
      entries,
      windows: request?.windows || [],
      show: request?.show === true || request?.reveal === true,
      focus: request?.focus === true || request?.reveal === true,
      createEmptyWindow: request?.createEmptyWindow === true,
    });
    if (!mutation.ok) return mutation;

    const nextSpaces = materialized.map((space: any) => {
      if (space.id === target.spaceId) return { ...space, layout: mutation.layout };
      return movingIds.length > 0
        ? { ...space, layout: dropTabsFromWorkspaceLayout(space.layout, movingIds) }
        : space;
    });
    const activeSpace = nextSpaces.find((space: any) => space.id === st.activeSpaceId);
    const activeLayout: any = { ...emptySpaceLayout(), ...(activeSpace?.layout || {}) };
    set({
      spaces: nextSpaces,
      splitPanes: activeLayout.splitPanes || [],
      splitFocusedIndex: activeLayout.splitFocusedIndex || 0,
      splitSizes: activeLayout.splitSizes || null,
      centerStrips: activeLayout.centerStrips || {},
      activeProjectId: activeLayout.activeProjectId || st.activeProjectId,
      focusedProjectId: activeLayout.focusedProjectId || st.focusedProjectId,
      activeSpaceTab: activeLayout.activeSpaceTab || null,
    });

    if (request?.reveal === true && target.spaceId !== st.activeSpaceId) {
      get().switchWorkspaceSpace(target.spaceId);
    }
    const shown = entries.find((entry) => entry.tabId === mutation.shownTabId) || entries[0] || null;
    const targetIsVisible = target.spaceId === get().activeSpaceId;
    if ((request?.show === true || request?.reveal === true) && shown && targetIsVisible) {
      get().activateCenterTab(shown.projectId, shown.tabId);
    }
    get().saveSession();
    const after = get();
    const fingerprintAfter = workspaceSpacesFingerprint(after.spaces, after.activeSpaceId, after);
    const describedAfter = describeWorkspaceWindowTargets({
      spaces: spacesWithLiveLayout(after.spaces, after.activeSpaceId, after),
      activeSpaceId: after.activeSpaceId,
      fingerprint: fingerprintAfter,
      tabInfo: (projectId: string, tabId: string) => {
        const tab = after.openProjects.get(projectId)?.tabs.get(tabId);
        return tab ? { name: tab.name, cwd: tab.cwd || null } : null;
      },
    });
    const placedSpace = describedAfter.find((space: any) => space.id === target.spaceId);
    const placedWindow = placedSpace?.windows?.find((window: any) => (
      window.paneIndex === mutation.paneIndex
      || (!!mutation.shownTabId && window.shownTabId === mutation.shownTabId)
    )) || null;
    console.log('[WorkspaceWindowAction] source=' + String(request?.sourceTabId || '').slice(-12)
      + ' space=' + target.spaceId
      + ' mode=' + target.mode
      + ' side=' + target.side
      + ' tabs=' + entries.map((entry) => entry.tabId.slice(-12)).join(',')
      + ' reveal=' + (request?.reveal === true ? '1' : '0'));
    return {
      ok: true,
      spaceId: target.spaceId,
      paneIndex: mutation.paneIndex,
      windowRef: placedWindow?.windowRef || null,
      insertedAt: mutation.insertedAt ?? null,
      shownTabId: mutation.shownTabId || null,
      placedIndices: mutation.placedIndices || null,
      fingerprintBefore,
      fingerprintAfter,
    };
  },

  addTabToSplitPaneStrip: (paneIndex, projectId, tabId) => {
    const st = get();
    const res = addTabToPane(st.splitPanes, paneIndex, projectId, tabId);
    if (!res) return;
    // Одно окно с вкладкой — это одиночный режим. Случай приходит из нового
    // рабочего пространства: оно открывается одним ПУСТЫМ окном, и вкладка,
    // положенная сюда из меню окон, его заполняет. Правило общее — оно же
    // работает при активации и при удалении окон.
    if (collapseLonePane(res.panes)) {
      set({ splitPanes: [], splitFocusedIndex: 0, splitSizes: null });
      get().activateCenterTab(projectId, tabId);
      get().saveSession();
      return;
    }
    set({ splitPanes: res.panes });
    console.log('[Split] stripAdd pane=' + paneIndex
      + ' tab=' + String(tabId).slice(-12)
      + ' chips=' + paneTabs(res.panes[paneIndex]).length
      // Откуда вкладка ушла: чип переезжает, а не копируется. Пустой список —
      // вкладка не лежала ни в одном окне (обычный случай новой вкладки).
      + (res.emptied && res.emptied.length ? ' emptiedPanes=' + res.emptied.join(',') : ''));
    // The window the chip landed in takes focus, and the centre follows — the
    // same rule as clicking that window. Runs through activateCenterTab so
    // freshness, the sidebar pointer and the reveal all happen exactly once.
    if (st.splitFocusedIndex !== paneIndex) set({ splitFocusedIndex: paneIndex });
    get().activateCenterTab(projectId, tabId);
    get().saveSession();
  },

  moveTabsToWindowStrip: (paneIndex, rawEntries, at = null, shownTabId = null) => {
    const st = get();
    const entries: Array<{ projectId: string; tabId: string }> = [];
    const seen = new Set<string>();
    (rawEntries || []).forEach((entry) => {
      if (!entry?.tabId || !entry?.projectId || seen.has(entry.tabId)) return;
      if (!st.openProjects.get(entry.projectId)?.tabs.has(entry.tabId)) return;
      seen.add(entry.tabId);
      entries.push({ projectId: entry.projectId, tabId: entry.tabId });
    });
    if (entries.length === 0) return false;
    const movedTabIds = entries.map((entry) => entry.tabId);
    const hiddenSpacePurge = dropTabsFromOtherSpaces(
      st.spaces,
      st.activeSpaceId,
      movedTabIds,
      dropTabFromAllPaneStrips,
    );
    const incomingRootTabId = entries[0].tabId;
    const incomingRoot = entries[0];

    if (paneIndex === null || paneIndex === undefined) {
      const key = st.centerStripKey();
      if (!key) return false;
      const shown = st.activeProjectId
        ? st.openProjects.get(st.activeProjectId)?.activeTabId || ''
        : '';
      const current = st.centerStrips[key] || [];
      const base = current.length > 0
        ? current
        : (shown ? [{ projectId: st.activeProjectId || incomingRoot.projectId, tabId: shown }] : []);
      const next = moveEntriesToIndex(base, entries, at);
      const finalShownTabId = shownTabId && next.some((entry) => entry.tabId === shownTabId)
        ? shownTabId
        : incomingRootTabId;
      const finalShown = next.find((entry) => entry.tabId === finalShownTabId) || incomingRoot;
      const nextStrips = { ...st.centerStrips };
      if (next.length > 1) nextStrips[key] = next;
      else delete nextStrips[key];
      if (next !== base || current.length !== next.length || hiddenSpacePurge) {
        set({
          centerStrips: nextStrips,
          ...(hiddenSpacePurge ? { spaces: hiddenSpacePurge.spaces } : {}),
        });
      }
      console.log('[PaneTabDnd:commit] pane=center tabs=' + entries.map((entry) => entry.tabId.slice(-12)).join(',')
        + ' at=' + (Number.isFinite(at) ? at : 'end') + ' shown=' + finalShownTabId.slice(-12));
      get().activateCenterTab(finalShown.projectId, finalShownTabId);
      get().saveSession();
      return true;
    }

    const result = moveTabsToPane(st.splitPanes, paneIndex, entries, at, shownTabId || incomingRootTabId);
    if (!result) return false;
    const finalShown = paneTabs(result.panes[paneIndex])
      .find((entry) => entry.tabId === result.shownTabId) || incomingRoot;
    if (collapseLonePane(result.panes)) {
      set({
        splitPanes: [],
        splitFocusedIndex: 0,
        splitSizes: null,
        ...(hiddenSpacePurge ? { spaces: hiddenSpacePurge.spaces } : {}),
      });
      get().activateCenterTab(finalShown.projectId, result.shownTabId);
      get().saveSession();
      return true;
    }
    set({
      splitPanes: result.panes,
      splitFocusedIndex: paneIndex,
      ...(hiddenSpacePurge ? { spaces: hiddenSpacePurge.spaces } : {}),
    });
    console.log('[PaneTabDnd:commit] pane=' + paneIndex
      + ' tabs=' + entries.map((entry) => entry.tabId.slice(-12)).join(',')
      + ' at=' + result.insertedAt + ' shown=' + result.shownTabId.slice(-12)
      + (result.emptied.length ? ' emptied=' + result.emptied.join(',') : ''));
    get().activateCenterTab(finalShown.projectId, result.shownTabId);
    get().saveSession();
    return true;
  },

  detachTabsFromWorkspaceWindows: (rawTabIds) => {
    const st = get();
    const tabIds = Array.from(new Set((rawTabIds || []).filter(Boolean)));
    if (tabIds.length === 0) return false;
    const doomed = new Set(tabIds);
    let panes = st.splitPanes;
    let panesChanged = false;
    tabIds.forEach((tabId) => {
      const result = dropTabFromAllPaneStrips(panes, tabId);
      if (!result) return;
      panes = result.panes;
      panesChanged = true;
    });

    let stripsChanged = false;
    const centerStrips: typeof st.centerStrips = {};
    Object.entries(st.centerStrips).forEach(([key, raw]) => {
      const before = raw || [];
      const kept = before.filter((entry) => !doomed.has(entry.tabId));
      if (kept.length !== before.length) stripsChanged = true;
      if (kept.length > 1) centerStrips[key] = kept;
    });
    const spacesPurge = dropTabsFromOtherSpaces(
      st.spaces,
      // Top-level fields above clean the active LIVE layout. Its entry inside
      // `spaces` is still a physical snapshot and must be cleaned too, otherwise
      // save-before-next-switch can resurrect the chip. Empty id skips none.
      '',
      tabIds,
      dropTabFromAllPaneStrips,
    );
    const activeSpaceTab = st.activeSpaceTab?.tabId && doomed.has(st.activeSpaceTab.tabId)
      ? null
      : st.activeSpaceTab;

    if (!panesChanged && !stripsChanged && !spacesPurge && activeSpaceTab === st.activeSpaceTab) return false;
    set({
      ...(panesChanged ? { splitPanes: panes } : {}),
      ...(stripsChanged ? { centerStrips } : {}),
      ...(spacesPurge ? { spaces: spacesPurge.spaces } : {}),
      ...(activeSpaceTab !== st.activeSpaceTab ? { activeSpaceTab } : {}),
    });
    console.log('[PaneTabDnd:detach-sidebar] tabs=' + tabIds.map((tabId) => tabId.slice(-12)).join(','));
    get().saveSession();
    return true;
  },

  swapSplitPanes: (from, to) => {
    const st = get();
    const res = swapPanes(st.splitPanes, st.splitFocusedIndex, from, to);
    if (!res) return;
    set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex });
    console.log('[Split] swapPanes ' + from + '<->' + to + ' focused=' + res.focusedIndex);
    // Центр идёт за содержимым: человек назвал два окна и ждёт свои вкладки на
    // новом месте — там же должна оказаться и показанная вкладка.
    const focused = res.panes[res.focusedIndex];
    if (focused?.tabId) get().activateCenterTab(focused.projectId, focused.tabId);
    get().saveSession();
  },

  swapWorkspaceWindows: (sourceSpaceId, sourcePaneIndex, targetSpaceId, targetPaneIndex) => {
    const st = get();
    if (!sourceSpaceId || !targetSpaceId || st.activeSpaceId !== sourceSpaceId) return false;

    if (sourceSpaceId === targetSpaceId) {
      if (sourcePaneIndex === null || targetPaneIndex === null) return false;
      const res = swapPanes(st.splitPanes, st.splitFocusedIndex, sourcePaneIndex, targetPaneIndex);
      if (!res) return false;
      set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex });
      const focused = res.panes[res.focusedIndex];
      if (focused?.tabId) get().activateCenterTab(focused.projectId, focused.tabId);
      get().saveSession();
      return true;
    }

    const sourceSpace = st.spaces.find((space) => space.id === sourceSpaceId);
    const targetSpace = st.spaces.find((space) => space.id === targetSpaceId);
    if (!sourceSpace || !targetSpace) return false;
    const sourceLayout = captureSpaceLayout(st);
    const targetLayout = { ...emptySpaceLayout(), ...(targetSpace.layout || {}) };
    const sourceAddress = st.splitPanes.length > 0 ? sourcePaneIndex : null;
    const targetAddress = Array.isArray(targetLayout.splitPanes) && targetLayout.splitPanes.length > 0
      ? targetPaneIndex
      : null;
    const swapped = swapWorkspaceLayoutWindows({
      sourceLayout,
      sourcePaneIndex: sourceAddress,
      targetLayout,
      targetPaneIndex: targetAddress,
    });
    if (!swapped) return false;

    // The source workflow remains visible. Persist both halves in the same
    // store commit, then project the source half back onto the live top-level
    // fields. No temporary workflow switch and no second placement truth.
    const focusedSourceLayout = {
      ...swapped.sourceLayout,
      splitFocusedIndex: Array.isArray(swapped.sourceLayout.splitPanes)
        && swapped.sourceLayout.splitPanes.length > 0
        && sourceAddress !== null
          ? sourceAddress
          : 0,
    };
    const spaces = st.spaces.map((space) => {
      if (space.id === sourceSpaceId) return { ...space, layout: focusedSourceLayout };
      if (space.id === targetSpaceId) return { ...space, layout: swapped.targetLayout };
      return space;
    });
    set({
      spaces,
      splitPanes: focusedSourceLayout.splitPanes || [],
      splitFocusedIndex: focusedSourceLayout.splitFocusedIndex || 0,
      splitSizes: focusedSourceLayout.splitSizes || null,
      centerStrips: focusedSourceLayout.centerStrips || {},
      activeProjectId: focusedSourceLayout.activeProjectId || st.activeProjectId,
      focusedProjectId: focusedSourceLayout.focusedProjectId || st.focusedProjectId,
      activeSpaceTab: focusedSourceLayout.activeSpaceTab || null,
    });
    console.log('[Spaces] swapWindows source=' + sourceSpaceId + ':' + (sourceAddress ?? 'center')
      + ' target=' + targetSpaceId + ':' + (targetAddress ?? 'center'));
    if (swapped.sourceShown?.tabId) {
      get().activateCenterTab(swapped.sourceShown.projectId, swapped.sourceShown.tabId);
    }
    get().saveSession();
    return true;
  },

  reorderSplitPaneTab: (paneIndex, tabId, toIndex) => {
    const res = reorderPaneTab(get().splitPanes, paneIndex, tabId, toIndex);
    if (!res) return;
    set({ splitPanes: res.panes });
    get().saveSession();
  },

  removeEmptySplitPane: (paneIndex) => {
    const { splitPanes, splitFocusedIndex } = get();
    if (!isEmptyPane(splitPanes[paneIndex])) return; // real panes close by tabId
    const res = removePaneAt(splitPanes, splitFocusedIndex, paneIndex);
    if (!res) return;
    set({ splitPanes: res.panes, splitFocusedIndex: res.focusedIndex });
    console.log('[Split] removeEmptyPane panes=' + res.panes.length);
    const focused = res.panes[res.focusedIndex];
    if (focused && focused.tabId) get().activateCenterTab(focused.projectId, focused.tabId);
    get().saveSession();
  },

  focusSplitPane: (paneIndex, options) => {
    const { splitPanes, splitFocusedIndex } = get();
    const pane = splitPanes[paneIndex];
    if (!pane) return;
    // «Прицелиться в окно, оставшись в чужом проекте».
    //
    // Обычный клик по окну — это «я работаю здесь», и он двигает оба
    // указателя: центр и боковое меню. Но есть обратный порядок, в котором
    // правило мешает: человек уже припарковал боковое меню на другом проекте,
    // видит там нужную вкладку и хочет положить её в КОНКРЕТНОЕ окно. Чтобы
    // назвать окно, надо по нему кликнуть — и парковка тут же слетает вместе
    // со списком, из которого он собирался выбрать. Юзер: *«мне нужно сначала
    // кликнуть по этому окну, но тогда сменится проект, и надо переходить
    // обратно»*.
    //
    // Поэтому у жеста есть тихий вариант: ⌘-клик двигает ТОЛЬКО рамку фокуса.
    // Центр остаётся на прежней вкладке — окно, у которого нет активной
    // вкладки, ничего показать не может, а «выбранное окно» и «показанная
    // вкладка» здесь и должны разойтись: следующая активация вкладки положит
    // её именно сюда.
    if (options?.keepSidebar) {
      if (splitFocusedIndex !== paneIndex) {
        set({ splitFocusedIndex: paneIndex });
        get().saveSession();
      }
      return;
    }
    if (isEmptyPane(pane)) {
      // Placeholder has no tab — only the focus ring moves; the center keeps
      // showing the previous pane's tab until an activation fills this slot.
      if (splitFocusedIndex !== paneIndex) {
        set({ splitFocusedIndex: paneIndex });
        get().saveSession();
      }
      return;
    }
    get().activateCenterTab(pane.projectId, pane.tabId);
  },

  tabListRevealRequest: null,
  requestTabListReveal: (projectId, tabId) => {
    const prev = get().tabListRevealRequest;
    set({ tabListRevealRequest: { projectId, tabId, seq: (prev?.seq || 0) + 1 } });
  },

  activateCenterTab: (projectId, tabId) => {
    // Split rules live inside switchTab (the single activation choke point),
    // and so does the sidebar follow-through: switchTab writes BOTH pointers
    // via activationFollowPatch. showWorkspace (explicit project navigation,
    // with its project-history reshuffle) is deliberately NOT called here.
    const st = get();
    st.switchTab(projectId, tabId);
    st.setProjectView(projectId, 'terminal');
    if (get().view !== 'workspace') {
      // Dashboard → workspace is view navigation, not project navigation.
      set({ view: 'workspace' });
    }
    // Reveal the row in the sidebar list — the sidebar now shows this project
    // (activation moved it). Instant, wins over saved-scroll restore.
    if (get().getFocusedProjectId() === projectId) {
      get().requestTabListReveal(projectId, tabId);
    }
  },

  placeTab: (projectId, tabId, options) => {
    const st = get();
    if (!st.openProjects.get(projectId)?.tabs.has(tabId)) return;
    const mode = options?.mode === 'add-here' ? PLACEMENT_ADD_HERE : PLACEMENT_DEFAULT;
    const plan = resolveTabPlacement({ tabId, mode, ...placementWorldFromState(st) });
    console.log('[Placement] tab=' + String(tabId).slice(-12)
      + ' mode=' + mode
      + ' plan=' + plan.kind
      + (plan.kind === 'reveal' ? ' pane=' + plan.paneIndex + ' cross=' + plan.crossSpace : '')
      + (plan.kind === 'move' || plan.kind === 'append'
        ? ' pane=' + plan.paneIndex + ' detach=' + plan.detach
        : ''));

    if (plan.kind === 'noop') {
      // Показана там, куда бы её отправил жест. Раскладку не трогаем, но центр
      // и боковой список всё равно должны указывать на неё: «ничего не менять»
      // относится к окнам, а не к тому, где сейчас человек.
      get().activateCenterTab(projectId, tabId);
      return;
    }

    if (plan.kind === 'reveal') {
      // Место у вкладки уже есть. Переход в пространство — ПЕРЕД активацией:
      // `switchTab` сам умеет это делать, но там правило спрятано внутри общего
      // пути, а здесь оно должно быть видимым решением резолвера.
      if (plan.crossSpace && plan.spaceId && plan.spaceId !== get().activeSpaceId) {
        get().switchWorkspaceSpace(plan.spaceId);
      }
      // Дальше — обычная активация: у вкладки есть чип, и правило окон внутри
      // `switchTab` сфокусирует именно её окно (resolveSplitActivation ведёт
      // К ВКЛАДКЕ, а не тащит её к фокусу).
      get().activateCenterTab(projectId, tabId);
      return;
    }

    if (plan.kind === 'append') {
      const targetCenterKey = plan.paneIndex === CENTER_PANE_INDEX
        ? get().centerStripKey()
        : null;
      if (plan.detach) {
        // Явное добавление: сначала снять чип со старого места — в текущем
        // пространстве и в снимках остальных. Без этого один живой терминал имел
        // бы два чипа, а вернувшись в старое пространство человек нашёл бы окно,
        // которое ничего не рисует.
        // Окно-получатель исключено: жест «добавь сюда» по чипу ЭТОГО же окна
        // иначе выдернул бы его из полосы и вернул в конец — то есть переставил
        // бы карту, которую человек собрал, вместо того чтобы просто показать.
        const dropped = dropTabFromAllPaneStrips(get().splitPanes, tabId, {
          keepPaneIndex: plan.paneIndex,
        });
        if (dropped) set({ splitPanes: dropped.panes });
        {
          const before = get().centerStrips;
          let changed = false;
          const next: typeof before = {};
          Object.entries(before).forEach(([key, strip]) => {
            if (!strip.some((e) => e.tabId === tabId)) { next[key] = strip; return; }
            if (key === targetCenterKey) { next[key] = strip; return; }
            changed = true;
            const rest = removeFromStrip(strip, tabId);
            if (rest.length > 1) next[key] = rest;
          });
          if (changed) set({ centerStrips: next });
        }
        const spacesAfter = dropTabsFromOtherSpaces(
          get().spaces,
          get().activeSpaceId,
          [tabId],
          dropTabFromAllPaneStrips,
        );
        if (spacesAfter) set({ spaces: spacesAfter.spaces });
      }
      if (plan.paneIndex === CENTER_PANE_INDEX) {
        const latest = get();
        const key = latest.centerStripKey();
        const strip = key ? (latest.centerStrips[key] || []) : [];
        if (strip.some((entry) => entry.tabId === tabId)) {
          latest.activateCenterTab(projectId, tabId);
        } else {
          latest.addTabToCenterStrip(projectId, tabId);
        }
        return;
      }
      const targetPane = get().splitPanes[plan.paneIndex];
      if (paneTabs(targetPane).some((entry) => entry.tabId === tabId)) {
        get().activateCenterTab(projectId, tabId);
      } else {
        get().addTabToSplitPaneStrip(plan.paneIndex, projectId, tabId);
      }
      return;
    }

    // plan.kind === 'move': an ordinary click on a tab with no prior place
    // replaces what the focused window shows. Shift takes the append branch
    // above, so the two gestures never collapse into the same result.
    if (plan.paneIndex === CENTER_PANE_INDEX) {
      get().activateCenterTab(projectId, tabId);
      return;
    }
    // Разделённый вид: ЗАМЕНА показанной вкладки этого окна, не добавление в
    // конец. Полоса — карта, которую собрал человек; жест отвечает про показ.
    const replaced = replacePaneShownTab(get().splitPanes, plan.paneIndex, projectId, tabId);
    if (!replaced) { get().activateCenterTab(projectId, tabId); return; }
    set({ splitPanes: replaced.panes, splitFocusedIndex: plan.paneIndex });
    get().activateCenterTab(projectId, tabId);
    get().saveSession();
  },

  isRestoring: false,
  pendingEditTabId: null,
  tabTitleNamingIds: new Set(),

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
    if (get().isRestoring) return; // Don't save while restoring

    // Debounce: save after 300ms of inactivity
    if (saveSessionTimer) clearTimeout(saveSessionTimer);

    saveSessionTimer = setTimeout(async () => {
      // Read the state AT WRITE TIME, not at schedule time: 300ms of debounce
      // is exactly the window in which the layout can change again, and the
      // captured-early version would save the older one.
      const sessionState = buildSessionSnapshot(get());

      // Save to database
      const result = await ipcRenderer.invoke('app:setState', {
        key: SESSION_KEY,
        value: sessionState,
        reason: 'debounced-workspace-save',
        source: 'renderer',
      });
      if (result?.success === false) {
        console.warn('[Store] Session save rejected error=' + result.error
          + ' missingSpaces=' + (result.missingSpaceIds || []).join(','));
      }
      saveSessionTimer = null;
    }, 300);
  },

  restoreSession: async () => {
    // The startup screen starts before the DB read. Previously `isRestoring`
    // flipped only after this await, so a slow state read looked like a dead
    // application with no explanation.
    setStartupRestoreProgress({
      phase: 'projects',
      label: 'Читаем сохранённую рабочую область…',
      detail: 'Проекты, вкладки и расположение окон',
      current: 0,
      total: 0,
      failed: 0,
    });
    set({ isRestoring: true });
    let sessionState: (SessionState & { projectHistory?: string[]; globalTabMru?: GlobalTabMruEntry[]; splitPanes?: SplitPane[]; splitFocusedIndex?: number }) | null = null;
    try {
      sessionState = await ipcRenderer.invoke('app:getState', SESSION_KEY);
    } catch (error: any) {
      console.error('[RestoreSession] state read failed:', error?.message || error);
      set({ isRestoring: false });
      setStartupRestoreProgress({
        phase: 'layout',
        label: 'Не удалось прочитать сохранённую рабочую область',
        detail: error?.message || String(error),
        failed: 1,
      });
      return;
    }
    if (!sessionState) {
      console.warn('[RestoreSession] no saved session state');
      setStartupRestoreProgress({
        phase: 'layout',
        label: 'Создаём новую рабочую область…',
        detail: 'Сохранённых вкладок нет',
        current: 1,
        total: 1,
      });
      set({ isRestoring: false });
      return;
    }

    try {
      const restoreStart = performance.now();
      const { openProjects, createTab } = get();

      console.warn(
        `[RestoreSession] start projects=${sessionState.openProjects.length}` +
        ` active=${restoreShortId(sessionState.activeProjectId)}` +
        ` view=${sessionState.view || 'unset'}` +
        ` currentOpen=${Array.from(openProjects.keys()).map(restoreShortId).join(',') || 'none'}`
      );

      // Load ALL projects and their tabs WITHOUT calling set() per project.
      // Old approach: openProject() in a loop → each call does set({openProjects: new Map()})
      // → 5 projects = 5 set() calls = 5 Workspace remounts = black screen flicker.
      // New approach: load data inline, mutate openProjects map directly, single set() at end.
      let restoreProjectIndex = 0;
      const restoreProjectTotal = sessionState.openProjects.length;
      for (const proj of sessionState.openProjects) {
        restoreProjectIndex += 1;
        setStartupRestoreProgress({
          phase: 'projects',
          label: 'Восстанавливаем проекты…',
          detail: `Проект ${restoreProjectIndex} из ${restoreProjectTotal}`,
          current: restoreProjectIndex,
          total: restoreProjectTotal,
        });
        if (openProjects.has(proj.projectId)) {
          const existing = openProjects.get(proj.projectId);
          console.warn(
            `[RestoreSession] projectSkipAlreadyOpen project=${restoreShortId(proj.projectId)}` +
            ` tabs=${existing?.tabs.size ?? -1}`
          );
          continue;
        }

        const projectStart = performance.now();
        console.warn(
          `[RestoreSession] projectStart project=${restoreShortId(proj.projectId)}` +
          ` path=${proj.projectPath || 'unset'}` +
          ` activeIndex=${proj.activeTabIndex}`
        );
        const isInbox = isInboxProjectId(proj.projectId);
        const projectData = await ipcRenderer.invoke('project:getById', proj.projectId);
        const savedTabs = projectData?.tabs || [];
        const restoredProjectPath = isInbox ? getInboxProjectPath() : (projectData?.path || proj.projectPath);
        const restoredProjectPathExists = isInbox || await projectPathExists(restoredProjectPath);
        console.warn(
          `[RestoreSession] projectData project=${restoreShortId(proj.projectId)}` +
          ` found=${!!projectData}` +
          ` dbPath=${projectData?.path || 'unset'}` +
          ` sessionPath=${proj.projectPath || 'unset'}` +
          ` pathExists=${restoredProjectPathExists ? '1' : '0'}` +
          ` savedTabs=${savedTabs.length}` +
          ` groups=${projectData?.tabGroups?.length || 0}` +
          ` tabIds=${restoreTabsSummary(savedTabs)}`
        );

        if (!projectData && !restoredProjectPathExists) {
          console.warn(
            `[RestoreSession] projectSkipMissingPath project=${restoreShortId(proj.projectId)}` +
            ` path=${restoredProjectPath || 'unset'} reason=missing-db-row-and-cwd`
          );
          openProjects.delete(proj.projectId);
          continue;
        }

        const newWorkspace: ProjectWorkspace = {
          projectId: proj.projectId,
          projectPath: restoredProjectPath,
          tabs: new Map(),
          tabGroups: projectData?.tabGroups || [],
          activeTabId: null,
          activeGroupId: null,
          selectedTabIds: [],
          tabHistory: [],
          tabCounter: 0,
          sidebarOpen: isInbox ? false : (projectData?.sidebarOpen || false),
          openFilePath: isInbox ? null : (projectData?.openFilePath || null),
          sidebarExpandedDirs: isInbox ? null : (projectData?.sidebarExpandedDirs || null),
          sidebarScrollTop: isInbox ? 0 : Math.max(0, Number(projectData?.sidebarScrollTop) || 0),
          tabListScrollTop: Math.max(0, Number(projectData?.tabListScrollTop) || 0),
          currentView: isInbox && savedTabs.length === 0 ? 'home' : 'terminal',
          viewingSubAgentTabId: null
        };
        openProjects.set(proj.projectId, newWorkspace);
        const liveOpenProjects = get().openProjects;
        if (liveOpenProjects !== openProjects && !liveOpenProjects.has(proj.projectId)) {
          liveOpenProjects.set(proj.projectId, newWorkspace);
          console.warn(
            `[RestoreSession] liveMapPatched project=${restoreShortId(proj.projectId)}` +
            ` capturedProjects=${Array.from(openProjects.keys()).map(restoreShortId).join(',')}` +
            ` liveProjects=${Array.from(liveOpenProjects.keys()).map(restoreShortId).join(',')}`
          );
        }
        console.warn(
          `[RestoreSession] workspaceCreated project=${restoreShortId(proj.projectId)}` +
          ` openProjects=${Array.from(openProjects.keys()).map(restoreShortId).join(',')}` +
          ` tabGroups=${newWorkspace.tabGroups.length}`
        );

        if (savedTabs.length > 0) {
          let maxTabNum = savedTabs.length;
          for (const st of savedTabs) {
            if (st.tabId) {
              const m = st.tabId.match(/-tab-(\d+)$/);
              if (m) maxTabNum = Math.max(maxTabNum, parseInt(m[1]) + 1);
            }
          }
          newWorkspace.tabCounter = maxTabNum;
          console.warn(
            `[RestoreSession] tabCounter project=${restoreShortId(proj.projectId)}` +
            ` counter=${newWorkspace.tabCounter} savedTabs=${savedTabs.length}`
          );
          for (let i = 0; i < savedTabs.length; i++) {
            const savedTab = savedTabs[i];
            // Updating a global progress card is cheap but still wakes every
            // external-store subscriber. Show useful movement without adding
            // another 129-event burst to the restore we are diagnosing.
            if (i === 0 || i + 1 === savedTabs.length || i % 4 === 0) {
              setStartupRestoreProgress({
                phase: 'tabs',
                label: 'Запускаем сохранённые терминалы…',
                detail: `Проект ${restoreProjectIndex}/${restoreProjectTotal} · вкладка ${i + 1}/${savedTabs.length}`,
                current: i + 1,
                total: savedTabs.length,
              });
            }
            console.warn(
              `[RestoreSession] tabRestoreStart project=${restoreShortId(proj.projectId)}` +
              ` idx=${i + 1}/${savedTabs.length}` +
              ` tab=${restoreShortId(savedTab.tabId)}` +
              ` name=${String(savedTab.name || '').replace(/\s+/g, ' ').slice(0, 40)}` +
              ` type=${savedTab.tabType || 'terminal'}` +
              ` command=${savedTab.commandType || 'generic'}` +
              ` cwd=${savedTab.cwd || 'unset'}`
            );
            let createdTabId = '';
            try {
              createdTabId = await createTab(proj.projectId, savedTab.name, savedTab.cwd, restoreTabOptions(savedTab));
            } catch (err: any) {
              const brokenTab = createBrokenRestoredTab(newWorkspace, savedTab, err);
              newWorkspace.tabs.set(brokenTab.id, brokenTab);
              const liveWorkspace = get().openProjects.get(proj.projectId);
              if (liveWorkspace && liveWorkspace !== newWorkspace) {
                liveWorkspace.tabs.set(brokenTab.id, brokenTab);
              }
              createdTabId = brokenTab.id;
              console.error(
                `[RestoreSession] tabRestoreFailed project=${restoreShortId(proj.projectId)}` +
                ` idx=${i + 1}/${savedTabs.length}` +
                ` tab=${restoreShortId(savedTab.tabId)}` +
                ` cwd=${savedTab.cwd || 'unset'}` +
                ` errorType=${brokenTab.restoreError?.type}` +
                ` errorCwd=${brokenTab.restoreError?.cwd || 'unset'}`,
                err?.stack || err?.message || err
              );
            }
            const stateWorkspace = get().openProjects.get(proj.projectId);
            console.warn(
              `[RestoreSession] tabRestoreEnd project=${restoreShortId(proj.projectId)}` +
              ` idx=${i + 1}/${savedTabs.length}` +
              ` requested=${restoreShortId(savedTab.tabId)}` +
              ` returned=${restoreShortId(createdTabId)}` +
              ` workspaceTabs=${newWorkspace.tabs.size}` +
              ` stateWorkspaceTabs=${stateWorkspace?.tabs.size ?? -1}`
            );
          }
        } else if (!isInbox) {
          console.warn(`[RestoreSession] noSavedTabs project=${restoreShortId(proj.projectId)} creatingDefault=true`);
          let createdTabId = '';
          try {
            createdTabId = await createTab(proj.projectId, 'Terminal 1', restoredProjectPath);
          } catch (err: any) {
            const fallbackTabId = `${proj.projectId}-tab-${Math.max(0, newWorkspace.tabCounter - 1)}`;
            const brokenTab = createBrokenRestoredTab(newWorkspace, makeDefaultSavedTab(newWorkspace, restoredProjectPath, fallbackTabId), err);
            newWorkspace.tabs.set(brokenTab.id, brokenTab);
            const liveWorkspace = get().openProjects.get(proj.projectId);
            if (liveWorkspace && liveWorkspace !== newWorkspace) {
              liveWorkspace.tabs.set(brokenTab.id, brokenTab);
            }
            createdTabId = brokenTab.id;
            console.error(
              `[RestoreSession] defaultTabFailed project=${restoreShortId(proj.projectId)}` +
              ` cwd=${restoredProjectPath || 'unset'}` +
              ` errorType=${brokenTab.restoreError?.type}` +
              ` errorCwd=${brokenTab.restoreError?.cwd || 'unset'}`,
              err?.stack || err?.message || err
            );
          }
          console.warn(
            `[RestoreSession] defaultTabEnd project=${restoreShortId(proj.projectId)}` +
            ` returned=${restoreShortId(createdTabId)}` +
            ` workspaceTabs=${newWorkspace.tabs.size}`
          );
        } else {
          console.warn(`[RestoreSession] noSavedTabs project=${restoreShortId(proj.projectId)} inboxEmpty=true`);
        }

        // Set active tab by saved index
        if (proj.activeTabIndex >= 0) {
          const tabsArray = Array.from(newWorkspace.tabs.keys());
          if (tabsArray[proj.activeTabIndex]) {
            newWorkspace.activeTabId = tabsArray[proj.activeTabIndex];
          }
        }
        console.warn(
          `[RestoreSession] projectDone project=${restoreShortId(proj.projectId)}` +
          ` tabs=${newWorkspace.tabs.size}` +
          ` active=${restoreShortId(newWorkspace.activeTabId)}` +
          ` durMs=${(performance.now() - projectStart).toFixed(1)}`
        );
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
        setStartupRestoreProgress({
          phase: 'tabs',
          label: 'Подготавливаем сохранённые переписки…',
          detail: `SDK-сессий: ${sdkPrefetchTasks.length}`,
          current: 0,
          total: sdkPrefetchTasks.length,
        });
        console.warn('[Restore] SDK prefetch starting count=' + sdkPrefetchTasks.length);
        const t0 = Date.now();
        await Promise.all(sdkPrefetchTasks);
        console.warn('[Restore] SDK prefetch done count=' + sdkPrefetchTasks.length + ' durMs=' + (Date.now() - t0));
      }

      // SINGLE set() for all projects — one Workspace mount instead of N
      const savedView = sessionState.view || 'dashboard';
      const restoredHistory = sessionState.projectHistory || [];
      // Tab-visit order is REBUILT from the per-tab durable timestamps, with the
      // saved array used only for tabs that have none (written before the
      // column existed). Two bugs die here:
      //   • the saved array was filtered to surviving tabs and then written back
      //     filtered, so every restart shaved it a little further and the loss
      //     was unrecoverable — observed live at 6 entries for 10 projects;
      //   • per-project visit lists start empty after a restart, so nothing but
      //     this array ranked tabs, and it ranked almost none of them.
      // Deriving from the timestamps makes both impossible by construction: the
      // array is now a cache of something durable, not the source of truth.
      const restoredGlobalMru = rebuildGlobalTabMru(
        Array.from(openProjects.entries()).flatMap(([projectId, workspace]) => (
          Array.from(workspace.tabs.values()).map((tab) => ({
            projectId,
            tabId: tab.id,
            lastActivatedAt: tab.lastActivatedAt,
          }))
        )),
        sessionState.globalTabMru || [],
      );
      // Split survives restart; panes whose tab failed to restore are dropped,
      // <2 live panes collapse to single mode.
      const restoredSplit = sanitizePanes(
        sessionState.splitPanes || [],
        sessionState.splitFocusedIndex ?? 0,
        (projectId: string, tabId: string) => !!openProjects.get(projectId)?.tabs.has(tabId),
      );
      // Single-mode centre strips: same scrub as the panes — a chip whose tab
      // did not come back must not restore as a row pointing at nothing, and a
      // project left with one chip has no strip at all.
      const restoredCenterStrips: Record<string, Array<{ projectId: string; tabId: string }>> = {};
      Object.entries((sessionState as any).centerStrips || {}).forEach(([pid, raw]) => {
        const kept = (Array.isArray(raw) ? raw : [])
          .filter((e: any) => e && e.tabId && openProjects.get(e.projectId)?.tabs.has(e.tabId));
        if (kept.length > 1) restoredCenterStrips[pid] = kept as Array<{ projectId: string; tabId: string }>;
      });
      const restoredActiveId = sessionState.activeProjectId && openProjects.has(sessionState.activeProjectId)
        ? sessionState.activeProjectId
        : null;

      setStartupRestoreProgress({
        phase: 'layout',
        label: 'Восстанавливаем workflow и окна…',
        detail: `Пространств: ${Array.isArray((sessionState as any).spaces) ? (sessionState as any).spaces.length : 1}`,
        current: 1,
        total: 1,
      });

      console.warn(
        `[RestoreSession] beforeSet restoredActive=${restoreShortId(restoredActiveId)}` +
        ` savedView=${savedView}` +
        ` projects=${Array.from(openProjects.values()).map((ws) => `${restoreShortId(ws.projectId)}:${ws.tabs.size}`).join(',') || 'none'}`
      );
      const restoredFocusedId = (sessionState as any).focusedProjectId
        && openProjects.has((sessionState as any).focusedProjectId)
        ? (sessionState as any).focusedProjectId as string
        : null;
      // Рабочие пространства. Раскладка, сохранённая ДО появления фичи, лежит на
      // верхнем уровне записи — она и становится первым пространством: человек
      // закрыл приложение с разложенными окнами и обязан увидеть их же, а не
      // пустое «main». Чистка мёртвых вкладок применяется только к текущему:
      // окна остальных проверяются в момент переключения, потому что вкладки
      // проектов, ещё не открытых в этом запуске, до тех пор просто неизвестны.
      const restoredLayout = {
        splitPanes: restoredSplit.panes,
        splitFocusedIndex: restoredSplit.focusedIndex,
        splitSizes: packSplitSizes(restoredSplit.panes, (sessionState as any).splitSizes ?? null),
        centerStrips: restoredCenterStrips,
        activeProjectId: restoredActiveId,
        focusedProjectId: restoredFocusedId,
      };
      const restoredSpacesRaw = restoreSpaces(sessionState as any, restoredLayout);
      // Текущему пространству кладём ВЫЧИЩЕННУЮ раскладку, а не сохранённую как
      // есть: обе описывают одно и то же, но мёртвые вкладки убраны только в
      // первой. Без этого первый же уход и возврат воскресил бы чипы, указывающие
      // в никуда, — на верхнем уровне их уже нет, а в снимке пространства ещё да.
      const restoredSpaces = {
        ...restoredSpacesRaw,
        spaces: restoredSpacesRaw.spaces.map((space: any) => (
          space.id === restoredSpacesRaw.activeSpaceId
            ? {
              ...space,
              projectIds: (space.projectIds || []).filter((projectId: string) => !isInboxProjectId(projectId)),
              layout: { ...space.layout, ...restoredLayout },
            }
            : {
              ...space,
              projectIds: (space.projectIds || []).filter((projectId: string) => !isInboxProjectId(projectId)),
            }
        )),
      };
      set({
        spaces: restoredSpaces.spaces,
        activeSpaceId: restoredSpaces.activeSpaceId,
        activeProjectId: restoredActiveId,
        focusedProjectId: restoredFocusedId,
        view: savedView === 'workspace' && restoredActiveId ? 'workspace' : 'dashboard',
        isRestoring: false,
        openProjects: new Map(openProjects),
        projectHistory: restoredHistory,
        globalTabMru: restoredGlobalMru,
        splitPanes: restoredSplit.panes,
        splitFocusedIndex: restoredSplit.focusedIndex,
        // Divider positions ride along; packing against the SANITIZED panes
        // drops sizes whose structure did not survive (a pane's tab is gone →
        // that dimension reads as equal anyway, so store nothing for it).
        splitSizes: packSplitSizes(restoredSplit.panes, (sessionState as any).splitSizes ?? null),
        centerStrips: restoredCenterStrips,
      });
      setStartupRestoreProgress({
        phase: 'agents',
        label: 'Проверяем прерванные AI-сессии…',
        detail: 'Запуск начнётся только после доказательства свободного терминала',
        current: 0,
        total: 0,
      });
      console.warn(
        `[RestoreSession] done durMs=${(performance.now() - restoreStart).toFixed(1)}` +
        ` stateProjects=${Array.from(get().openProjects.values()).map((ws) => `${restoreShortId(ws.projectId)}:${ws.tabs.size}`).join(',') || 'none'}` +
        ` active=${restoreShortId(get().activeProjectId)}` +
        ` view=${get().view}`
      );

      get().saveSession();
    } catch (e) {
      console.error(
        '[Session] Failed to restore:',
        e,
        'stateProjects=',
        Array.from(get().openProjects.values()).map((ws) => `${restoreShortId(ws.projectId)}:${ws.tabs.size}`).join(',') || 'none'
      );
      set({ isRestoring: false });
      setStartupRestoreProgress({
        phase: 'agents',
        label: 'Структура восстановлена; проверяем AI-сессии…',
        detail: 'Вкладки с ошибками останутся доступными для ручного повтора',
        failed: 1,
      });
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
    const { projectHistory, openProjects, activeProjectId } = get();
    // Move to end of history (max 20)
    const newHistory = [...projectHistory.filter(id => id !== projectId), projectId].slice(-20);

    // Explicit project navigation moves ONLY the sidebar pointer. The center
    // keeps showing whatever tab it showed — clicking a project must never
    // swap the visible tab (approved rule: even with a single tab, "смена
    // проекта не меняет текущую активную вкладку"). The center follows only
    // tab activation (switchTab). Sole exception: no live center yet (fresh
    // start / center's project closed) — then the center has nothing to keep.
    const centerAlive = !!activeProjectId && openProjects.has(activeProjectId);
    startTransition(() => {
      set({
        view: 'workspace',
        focusedProjectId: projectId,
        projectHistory: newHistory,
        ...(centerAlive ? {} : { activeProjectId: projectId }),
      });
    });
    get().saveSession();
  },

  openProject: async (projectId, projectPath, options) => {
    const isInbox = isInboxProjectId(projectId);
    const background = options?.background ?? false;
    const draft = options?.draft ?? false;
    const effectiveProjectPath = isInbox ? getInboxProjectPath() : projectPath;
    console.log('[Store] openProject called:', { projectId, projectPath: effectiveProjectPath, background, draft });
    const { openProjects, createTab, saveSession, projectHistory } = get();

    // Update history
    const newHistory = [...projectHistory.filter(id => id !== projectId), projectId].slice(-20);

    if (!openProjects.has(projectId)) {
      console.log('[Store] Project not in openProjects, loading from DB...');
      // Load saved tabs from database - use getById to get correct project (not just any with same path)

      const projectData = await ipcRenderer.invoke('project:getById', projectId);
      console.log('[Store] project:getById returned:', projectData);
      const savedTabs = projectData?.tabs || [];
      const workspaceProjectPath = isInbox ? getInboxProjectPath() : (projectData?.path || effectiveProjectPath);
      console.log('[Store] savedTabs:', savedTabs);

      const newWorkspace: ProjectWorkspace = {
        projectId,
        projectPath: workspaceProjectPath,
        tabs: new Map(),
        tabGroups: projectData?.tabGroups || [],
        activeTabId: null,
        activeGroupId: null,
        selectedTabIds: [],
        tabHistory: [],
        tabCounter: 0, // Start from 0 for new projects
        sidebarOpen: isInbox ? false : (projectData?.sidebarOpen || false),
        openFilePath: isInbox ? null : (projectData?.openFilePath || null),
        sidebarExpandedDirs: isInbox ? null : (projectData?.sidebarExpandedDirs || null),
        sidebarScrollTop: isInbox ? 0 : Math.max(0, Number(projectData?.sidebarScrollTop) || 0),
        tabListScrollTop: Math.max(0, Number(projectData?.tabListScrollTop) || 0),
        currentView: draft || isInbox ? 'home' : 'terminal',
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
            try {
              await createTab(projectId, savedTab.name, savedTab.cwd, restoreTabOptions(savedTab));
            } catch (err: any) {
              const brokenTab = createBrokenRestoredTab(newWorkspace, savedTab, err);
              newWorkspace.tabs.set(brokenTab.id, brokenTab);
              console.error(
                `[OpenProject] tabRestoreFailed project=${restoreShortId(projectId)}` +
                ` tab=${restoreShortId(savedTab.tabId)}` +
                ` cwd=${savedTab.cwd || 'unset'}` +
                ` errorType=${brokenTab.restoreError?.type}` +
                ` errorCwd=${brokenTab.restoreError?.cwd || 'unset'}`,
                err?.stack || err?.message || err
              );
            }
          }
        } else if (!isInbox) {
          // Create default tab
          try {
            await createTab(projectId, 'Terminal 1', workspaceProjectPath);
          } catch (err: any) {
            const fallbackTabId = `${projectId}-tab-${Math.max(0, newWorkspace.tabCounter - 1)}`;
            const brokenTab = createBrokenRestoredTab(newWorkspace, makeDefaultSavedTab(newWorkspace, workspaceProjectPath, fallbackTabId), err);
            newWorkspace.tabs.set(brokenTab.id, brokenTab);
            console.error(
              `[OpenProject] defaultTabFailed project=${restoreShortId(projectId)}` +
              ` cwd=${workspaceProjectPath || 'unset'}` +
              ` errorType=${brokenTab.restoreError?.type}` +
              ` errorCwd=${brokenTab.restoreError?.cwd || 'unset'}`,
              err?.stack || err?.message || err
            );
          }
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
        // Project navigation moves the SIDEBAR pointer only; the center keeps
        // its tab. The center is claimed only when there is none to keep.
        const centerAlive = !!get().activeProjectId && openProjects.has(get().activeProjectId!);
        set({
          openProjects: new Map(openProjects),
          focusedProjectId: projectId,
          ...(centerAlive ? {} : { activeProjectId: projectId }),
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
      // Names any main-thread freeze that overlaps the switch (see
      // markRendererActivity — the platform's own longtask attribution is
      // always "unknown" for our own code).
      const endSwitchMark = markRendererActivity('project-switch:' + projectId.slice(-12));
      // Same rule as showWorkspace: project navigation moves only the sidebar
      // pointer; the center keeps its tab unless there is no center to keep.
      const centerAlive = !!prevActiveId && openProjects.has(prevActiveId);
      set({
        focusedProjectId: projectId,
        ...(centerAlive ? {} : { activeProjectId: projectId }),
        view: 'workspace',
        projectHistory: newHistory,
      });
      requestAnimationFrame(() => {
        endSwitchMark();
        const durMs = (performance.now() - _t0).toFixed(1);
        const tabCount = Array.from(get().openProjects.values())
          .reduce((acc, ws) => acc + ws.tabs.size, 0);
        console.warn(`[Perf:ProjectSwitch] from=${String(prevActiveId).slice(-12)} to=${projectId.slice(-12)} durMs=${durMs} totalTabs=${tabCount}`);
      });
      saveSession();
    }
  },

  closeProject: async (projectId) => {
    if (isInboxProjectId(projectId)) {
      const { openProjects, saveSession } = get();
      const workspace = openProjects.get(projectId);
      if (workspace) {
        workspace.sidebarOpen = false;
        workspace.openFilePath = null;
        set({ openProjects: new Map(openProjects) });
        saveSession();
      }
      return;
    }

    const { openProjects, activeProjectId, view, saveSession, projectHistory } = get();
    const workspace = openProjects.get(projectId);

    if (workspace) {
      const startedAt = performance.now();
      const startedAbs = performance.timeOrigin + startedAt;
      const tabsToKill = Array.from(workspace.tabs.keys());
      console.warn(
        '[Perf:CloseProject] start' +
        ' project=' + projectId.slice(-12) +
        ' active=' + (activeProjectId === projectId ? '1' : '0') +
        ' view=' + view +
        ' tabs=' + workspace.tabs.size +
        ' totalProjects=' + openProjects.size +
        ' startAbs=' + startedAbs.toFixed(1)
      );
      // Save tabs before closing (manual close = NOT interrupted)
      saveTabs(workspace.projectId, workspace.tabs);

      const nextOpenProjects = new Map(openProjects);
      nextOpenProjects.delete(projectId);

      // Update history: remove closed project
      const newHistory = projectHistory.filter(id => id !== projectId);
      
      const isClosingActive = activeProjectId === projectId;
      let nextActiveId = activeProjectId;

      if (isClosingActive) {
        // Find next best project from history that is still open
        nextActiveId = null;
        for (let i = newHistory.length - 1; i >= 0; i--) {
          if (nextOpenProjects.has(newHistory[i])) {
            nextActiveId = newHistory[i];
            break;
          }
        }
      }

      const splitAfterClose = removePanesByProject(get().splitPanes, get().splitFocusedIndex, projectId);
      // Чипы закрытого проекта уходят и из окон ОСТАЛЬНЫХ пространств: их
      // раскладка лежит в снимках, обычные пути её не видят, и вкладки закрытого
      // проекта дожили бы там до возврата.
      const spacesAfterClose = (() => {
        const st = get();
        const doomed = Array.from(workspace?.tabs.keys() || []);
        return dropTabsFromOtherSpaces(st.spaces, st.activeSpaceId, doomed, dropTabFromAllPaneStrips);
      })();
      // Sidebar owner: dropped with its project; otherwise untouched (it may
      // legitimately differ from the center's project).
      const prevFocusedId = get().focusedProjectId;
      startTransition(() => set({
        openProjects: nextOpenProjects,
        activeProjectId: nextActiveId,
        focusedProjectId: prevFocusedId === projectId ? nextActiveId : prevFocusedId,
        projectHistory: newHistory,
        globalTabMru: dropProjectFromMru(get().globalTabMru, projectId),
        ...(splitAfterClose ? { splitPanes: splitAfterClose.panes, splitFocusedIndex: splitAfterClose.focusedIndex } : {}),
        ...(spacesAfterClose ? { spaces: spacesAfterClose.spaces } : {}),
        // If we closed the active project and no projects are left in history -> dashboard
        view: (isClosingActive && !nextActiveId && view === 'workspace') ? 'dashboard' : view
      }));

      saveSession();
      console.warn(
        '[Perf:CloseProject] state-updated' +
        ' project=' + projectId.slice(-12) +
        ' nextActive=' + (nextActiveId ? nextActiveId.slice(-12) : 'none') +
        ' remainingProjects=' + nextOpenProjects.size +
        ' tabsKilled=' + tabsToKill.length +
        ' durMs=' + (performance.now() - startedAt).toFixed(1)
      );

      // PTY shutdown may involve process checks and graceful Ctrl+C. Keep it off the
      // critical UI path so closing a project cannot look like a global freeze.
      tabsToKill.forEach((tabId) => {
        usePromptQueueStore.getState().cleanupClosedTab(tabId);
        ipcRenderer.send('terminal:kill', tabId);
      });
      console.warn(
        '[Perf:CloseProject] kill-sent' +
        ' project=' + projectId.slice(-12) +
        ' tabsKilled=' + tabsToKill.length +
        ' durMs=' + (performance.now() - startedAt).toFixed(1)
      );
    }
  },

  createTab: async (projectId, name, cwd, options) => {
    log.tabs('createTab called:', { projectId, name, cwd, options });
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) {
      console.error(
        `[Store:createTabMissingWorkspace] project=${restoreShortId(projectId)}` +
        ` name=${String(name || '').replace(/\s+/g, ' ').slice(0, 40)}` +
        ` restoreId=${restoreShortId((options as any)?.restoreId)}` +
        ` isRestoring=${get().isRestoring}` +
        ` openProjects=${Array.from(openProjects.keys()).map(restoreShortId).join(',') || 'none'}`
      );
      log.tabs('createTab: No workspace for projectId:', projectId);
      return '';
    }

    const tabId = (options as any)?.restoreId || `${projectId}-tab-${workspace.tabCounter}`;
    log.tabs('createTab: tabId:', tabId, 'counter:', workspace.tabCounter, 'restored:', !!(options as any)?.restoreId);
    workspace.tabCounter++;

    // Materialize the current default onto the tab at creation time. The
    // resolver still has a fallback for legacy/restored data, but changing the
    // default later must not reshape tabs that are already open.
    const uiState = useUIStore.getState();
    const terminalPrimaryDefault = uiState.newTabPrimarySurface === 'terminal';

    // Smart naming: find next available name if not provided
    const existingNames = Array.from(workspace.tabs.values()).map(t => t.name);
    const tabName = name || getNextAvailableName('tab', existingNames);
    log.tabs('createTab: Using name:', tabName);

    const newTab: Tab = {
      id: tabId,
      name: tabName,
      cwd: cwd || (workspace.projectPath?.startsWith('__unset__') ? '' : workspace.projectPath) || process.env.HOME || '~',
      color: options?.color,
      isUtility: false,
      commandType: options?.commandType,
      pendingAction: options?.pendingAction,
      claudeSessionId: options?.claudeSessionId,
      geminiSessionId: options?.geminiSessionId,
      codexSessionId: options?.codexSessionId,
      codexModel: options?.codexModel,
      codexEffort: options?.codexEffort,
      codexSettingsProofAt: (options as any)?.codexSettingsProofAt,
      codexSettingsProofSessionId: (options as any)?.codexSettingsProofSessionId,
      codexModelMigrationPending: (options as any)?.codexModelMigrationPending,
      codexModelMigrationRestoreDefaultModel: (options as any)?.codexModelMigrationRestoreDefaultModel,
      codexModelMigrationRestoreDefaultEffort: (options as any)?.codexModelMigrationRestoreDefaultEffort,
      codexModelMigrationSourceModel: (options as any)?.codexModelMigrationSourceModel,
      codexModelMigrationSourceEffort: (options as any)?.codexModelMigrationSourceEffort,
      codexModelMigrationTargetModel: (options as any)?.codexModelMigrationTargetModel,
      codexModelMigrationConfigPath: (options as any)?.codexModelMigrationConfigPath,
      codexModelMigrationConfigFingerprint: (options as any)?.codexModelMigrationConfigFingerprint,
      codexModelMigrationConfigAlreadyTarget: (options as any)?.codexModelMigrationConfigAlreadyTarget,
      externalRun: options?.externalRun,
      wasInterrupted: options?.wasInterrupted,
      overlayDismissed: options?.overlayDismissed,
      notes: options?.notes,
      taskPlan: options?.taskPlan,
      tabType: options?.tabType || 'terminal',
      filePath: (options as any)?.filePath,
      createdAt: (options as any)?.createdAt || Math.floor(Date.now() / 1000),
      // Restore carries the durable visit stamp; a brand-new tab has none until
      // its first activation stamps it.
      lastActivatedAt: (options as any)?.lastActivatedAt,
      // Same for the session-id history behind "Revert Session": a restored tab
      // keeps the way back, a brand-new one has nothing to revert to yet.
      claudeSessionHistory: (options as any)?.claudeSessionHistory,
      isCollapsed: (options as any)?.isCollapsed,
      groupId: options?.groupId,
      visualParentTabId: (options as any)?.visualParentTabId,
      windowScoped: (options as any)?.windowScoped === true || undefined,
      nameSetManually: (options as any)?.nameSetManually,
      sessionStatus: (options as any)?.sessionStatus,
      completionNotificationPersistent: (options as any)?.completionNotificationPersistent || undefined,
      restartAfterTabId: (options as any)?.restartAfterTabId || undefined,
      restartAfterTabIds: Array.isArray((options as any)?.restartAfterTabIds) ? (options as any).restartAfterTabIds : undefined,
      restartAfterCommand: (options as any)?.restartAfterCommand || undefined,
      restartAfterPaused: (options as any)?.restartAfterPaused || undefined,
      restartAfterPersistent: (options as any)?.restartAfterPersistent || undefined,
      restartAfterArmed: (options as any)?.restartAfterArmed || undefined
    };

    // Claude SDK and linked file tabs don't need a PTY process.
    if (newTab.tabType === 'claude-sdk' || newTab.tabType === 'file') {
      console.log('[Store] createTab: non-PTY tab, skipping terminal for:', tabId, 'type:', newTab.tabType);
    } else {
      console.log('[Store] createTab: Creating PTY terminal for:', tabId, 'cwd:', newTab.cwd);
      // Only pass initialCommand for shell-command type, not for internal commands
      const initialCommand = options?.pendingAction?.type === 'shell-command'
        ? options.pendingAction.command
        : undefined;

      let pid: number;
      try {
        console.warn(
          `[Store:createTabTerminalStart] project=${restoreShortId(projectId)}` +
          ` tab=${restoreShortId(tabId)}` +
          ` restore=${!!(options as any)?.restoreId}` +
          ` cwd=${newTab.cwd}`
        );
        const result = await ipcRenderer.invoke('terminal:create', {
          tabId,
          projectId,
          cwd: newTab.cwd,
          rows: 24,
          cols: 80,
          initialCommand
        });
        pid = result.pid;
        console.warn(
          `[Store:createTabTerminalEnd] project=${restoreShortId(projectId)}` +
          ` tab=${restoreShortId(tabId)}` +
          ` pid=${pid}`
        );
      } catch (err: any) {
        console.error(
          `[Store:createTabTerminalError] project=${restoreShortId(projectId)}` +
          ` tab=${restoreShortId(tabId)}` +
          ` restore=${!!(options as any)?.restoreId}` +
          ` cwd=${newTab.cwd}`,
          err?.stack || err?.message || err
        );
        throw err;
      }

      console.log('[Store] createTab: PTY created with pid:', pid);
      newTab.pid = pid;
    }
    const { isRestoring } = get();
    if (isRestoring) {
      workspace.tabs.set(tabId, newTab);
      if (uiState.terminalIsPrimaryTabs[tabId] === undefined) {
        uiState.setTabTerminalIsPrimary(tabId, terminalPrimaryDefault);
      }
    } else {
      const shouldEdit = !options?.background && !name && !options?.nameSetManually && !options?.skipInitialRename;
      const creationSnapshot = await commitCreatedTabSnapshot({
        queue: projectTabCreationQueue,
        projectId,
        isWorkspaceCurrent: () => get().openProjects.get(projectId) === workspace,
        getCurrentTabs: () => workspace.tabs,
        getPersistenceRevision: () => projectTabSaveRevisions.get(projectId) || 0,
        buildCandidateTabs: (currentTabs) => new Map([...currentTabs, [tabId, newTab]]),
        persist: (candidateTabs) => {
          console.log('[Store] createTab: Persisting tab, tabs count:', candidateTabs.size);
          return saveTabsThenNotifyProjectLayoutChanged(
            workspace.projectId,
            candidateTabs,
            'tab-created',
          );
        },
        publish: (candidateTabs) => {
          workspace.tabs = candidateTabs;
          if (uiState.terminalIsPrimaryTabs[tabId] === undefined) {
            uiState.setTabTerminalIsPrimary(tabId, terminalPrimaryDefault);
          }
          if (!options?.background) {
            workspace.activeTabId = tabId;
            workspace.activeGroupId = newTab.groupId || null;
            workspace.viewingSubAgentTabId = null;
            workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
            get().touchGlobalTabMru(workspace.projectId, tabId);
          }
          set({
            openProjects: new Map(get().openProjects),
            pendingEditTabId: shouldEdit ? tabId : null,
          });
        },
      });
      if (creationSnapshot?.success === false) {
        const rollback = await rollbackUnmaterializedCreatedTab(projectId, tabId);
        if (newTab.tabType !== 'claude-sdk' && newTab.tabType !== 'file') {
          ipcRenderer.send('terminal:kill', tabId);
        }
        get().clearTerminalBuffer(tabId);
        const error: any = new Error(rollback?.success === false
          ? `tab_creation_rollback_failed:${rollback.error || 'delete_failed'}`
          : (creationSnapshot.error || 'tab_persistence_failed'));
        error.code = 'tab_persistence_failed';
        error.tabId = tabId;
        throw error;
      }
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

    const tabId = (options as any)?.restoreId || `${projectId}-tab-${workspace.tabCounter}`;
    workspace.tabCounter++;

    const uiState = useUIStore.getState();
    const terminalPrimaryDefault = uiState.newTabPrimarySurface === 'terminal';

    // Smart naming: find next available name if not provided
    const existingNames = Array.from(workspace.tabs.values()).map(t => t.name);
    const tabName = name || getNextAvailableName('tab', existingNames);

    const explicitGroupId = resolveExistingTabGroupId(workspace, options?.groupId);
    const activeGroupId = resolveExistingTabGroupId(workspace, workspace.activeGroupId);
    const referenceTabForGroup = options?.afterTabId || workspace.activeTabId || undefined;
    const referenceTab = referenceTabForGroup ? workspace.tabs.get(referenceTabForGroup) : undefined;
    // Наследование «визуального родителя» — правило для вкладки, созданной ОТ
    // другой вкладки. Жест «дай мне ещё одну вкладку ЗДЕСЬ» (двойной клик по
    // шапке окна или по полосе центра) наследовать не должен: унаследованная
    // вкладка прячется внутрь чужой карточки, и в списке слева её будто нет.
    // Пустая строка = явный отказ от наследования; `undefined` по-прежнему
    // означает «решай по общему правилу».
    const rejectsInheritedParent = options?.visualParentTabId === '';
    const inheritedVisualParentId = !activeGroupId && !rejectsInheritedParent
      ? referenceTab?.visualParentTabId
      : undefined;
    const requestedVisualParentId = options?.visualParentTabId || inheritedVisualParentId;
    const visualParentTab = requestedVisualParentId ? workspace.tabs.get(requestedVisualParentId) : undefined;
    const visualParentTabId = visualParentTab && !visualParentTab.parentTabId
      ? requestedVisualParentId
      : undefined;
    const referenceGroupId = referenceTabForGroup
      ? resolveExistingTabGroupId(workspace, referenceTab?.groupId)
      : undefined;
    const visualParentGroupId = resolveExistingTabGroupId(workspace, visualParentTab?.groupId);
    const targetGroupId = explicitGroupId || activeGroupId || referenceGroupId || visualParentGroupId;

    const newTab: Tab = {
      id: tabId,
      name: tabName,
      cwd: cwd || (workspace.projectPath?.startsWith('__unset__') ? '' : workspace.projectPath) || process.env.HOME || '~',
      color: options?.color,
      isUtility: false,
      commandType: options?.commandType,
      pendingAction: options?.pendingAction,
      claudeSessionId: options?.claudeSessionId,
      geminiSessionId: options?.geminiSessionId,
      codexSessionId: options?.codexSessionId,
      codexModel: options?.codexModel,
      codexEffort: options?.codexEffort,
      codexSettingsProofAt: (options as any)?.codexSettingsProofAt,
      codexSettingsProofSessionId: (options as any)?.codexSettingsProofSessionId,
      codexModelMigrationPending: (options as any)?.codexModelMigrationPending,
      codexModelMigrationRestoreDefaultModel: (options as any)?.codexModelMigrationRestoreDefaultModel,
      codexModelMigrationRestoreDefaultEffort: (options as any)?.codexModelMigrationRestoreDefaultEffort,
      codexModelMigrationSourceModel: (options as any)?.codexModelMigrationSourceModel,
      codexModelMigrationSourceEffort: (options as any)?.codexModelMigrationSourceEffort,
      codexModelMigrationTargetModel: (options as any)?.codexModelMigrationTargetModel,
      codexModelMigrationConfigPath: (options as any)?.codexModelMigrationConfigPath,
      codexModelMigrationConfigFingerprint: (options as any)?.codexModelMigrationConfigFingerprint,
      codexModelMigrationConfigAlreadyTarget: (options as any)?.codexModelMigrationConfigAlreadyTarget,
      wasInterrupted: options?.wasInterrupted,
      overlayDismissed: options?.overlayDismissed,
      notes: options?.notes,
      taskPlan: options?.taskPlan,
      tabType: options?.tabType || 'terminal',
      filePath: (options as any)?.filePath,
      nameSetManually: (options as any)?.nameSetManually,
      groupId: targetGroupId,
      visualParentTabId,
      windowScoped: (options as any)?.windowScoped === true || undefined,
      createdAt: (options as any)?.createdAt || Math.floor(Date.now() / 1000),
      lastActivatedAt: (options as any)?.lastActivatedAt,
      restartAfterTabId: (options as any)?.restartAfterTabId || undefined,
      restartAfterTabIds: Array.isArray((options as any)?.restartAfterTabIds) ? (options as any).restartAfterTabIds : undefined,
      restartAfterCommand: (options as any)?.restartAfterCommand || undefined,
      restartAfterPaused: (options as any)?.restartAfterPaused || undefined,
      restartAfterPersistent: (options as any)?.restartAfterPersistent || undefined,
      restartAfterArmed: (options as any)?.restartAfterArmed || undefined
    };

    // Only pass initialCommand for shell-command type, not for internal commands
    const initialCommand = options?.pendingAction?.type === 'shell-command'
      ? options.pendingAction.command
      : undefined;

    // Claude SDK and linked file tabs don't need a PTY process — mirror createTab's guard.
    // Without it, non-terminal tabs spawn unused shells and enter process lifecycle by accident.
    if (newTab.tabType === 'claude-sdk' || newTab.tabType === 'file') {
      console.log('[Store:createTabAfterCurrent] non-PTY tab, skipping terminal for:', tabId, 'type:', newTab.tabType);
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

    const shouldEdit = !options?.background && !name && !options?.nameSetManually && !options?.skipInitialRename;
    const creationSnapshot = await commitCreatedTabSnapshot({
      queue: projectTabCreationQueue,
      projectId,
      isWorkspaceCurrent: () => get().openProjects.get(projectId) === workspace,
      getCurrentTabs: () => workspace.tabs,
      getPersistenceRevision: () => projectTabSaveRevisions.get(projectId) || 0,
      // Build placement from the latest committed Map inside the same-project
      // creation lane. Two concurrent creates therefore cannot overwrite or
      // prematurely publish each other.
      buildCandidateTabs: (currentTabs) => {
        const tabsArray = Array.from(currentTabs.entries());
        const groupMemberIds = targetGroupId
          ? tabsArray
            .filter(([, tab]) => !tab.parentTabId && tab.groupId === targetGroupId)
            .map(([id]) => id)
          : [];
        const referenceTabId = targetGroupId && !options?.afterTabId
          ? (groupMemberIds[groupMemberIds.length - 1] || undefined)
          : (options?.afterTabId || workspace.activeTabId);
        const targetGroup = targetGroupId
          ? workspace.tabGroups.find(group => group.id === targetGroupId)
          : undefined;
        const afterVisualSubtreePlacement = (rejectsInheritedParent || options?.afterVisualSubtree === true)
          && options?.appendToEnd !== true
          && !!referenceTabId;
        const insertIndex = afterVisualSubtreePlacement
          ? resolveSiblingInsertionIndex({
            tabIds: tabsArray.map(([id]) => id),
            referenceTabId: referenceTabId as string,
            parentOf: Object.fromEntries(
              tabsArray.map(([id, candidate]) => [id, candidate.visualParentTabId]),
            ),
          })
          : resolveTabInsertionIndex({
            tabIds: tabsArray.map(([id]) => id),
            appendToEnd: options?.appendToEnd === true,
            referenceTabId,
            groupAnchorTabId: targetGroup?.anchorTabId,
          });
        tabsArray.splice(insertIndex, 0, [tabId, newTab]);
        return new Map(tabsArray);
      },
      persist: (candidateTabs) => saveTabsThenNotifyProjectLayoutChanged(
        workspace.projectId,
        candidateTabs,
        'tab-created',
      ),
      publish: (candidateTabs) => {
        workspace.tabs = candidateTabs;
        if (uiState.terminalIsPrimaryTabs[tabId] === undefined) {
          uiState.setTabTerminalIsPrimary(tabId, terminalPrimaryDefault);
        }
        if (!options?.background) {
          workspace.activeTabId = tabId;
          workspace.activeGroupId = targetGroupId || null;
          workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
          get().touchGlobalTabMru(workspace.projectId, tabId);
        }
        set({
          openProjects: new Map(get().openProjects),
          pendingEditTabId: shouldEdit ? tabId : null,
        });
      },
    });
    if (creationSnapshot?.success === false) {
      const rollback = await rollbackUnmaterializedCreatedTab(projectId, tabId);
      if (newTab.tabType !== 'claude-sdk' && newTab.tabType !== 'file') {
        ipcRenderer.send('terminal:kill', tabId);
      }
      get().clearTerminalBuffer(tabId);
      const error: any = new Error(rollback?.success === false
        ? `tab_creation_rollback_failed:${rollback.error || 'delete_failed'}`
        : (creationSnapshot.error || 'tab_persistence_failed'));
      error.code = 'tab_persistence_failed';
      error.tabId = tabId;
      throw error;
    }

    return tabId;
  },

  closeTab: async (projectId, tabId, options) => {
    const closeStartedAt = Date.now();
    const { openProjects, clearTerminalBuffer } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return false;

    const tab = workspace.tabs.get(tabId);
    if (!tab) return false;
    const expectedTabIdsBeforeClose = Array.from(workspace.tabs.keys());
    const skipProcessCheck = options?.skipProcessCheck || false;
    const ptyAgentOwner = resolvePtyAgentOwner(tab);
    const hasAmbiguousPtyBindings = !!tab.claudeSessionId && !!tab.codexSessionId;
    const effectiveCommandType = ptyAgentOwner
      || (hasAmbiguousPtyBindings ? null : tab.commandType);
    const isAiTab = isAiRuntimeTab(tab);
    const aiBusyAtClose = isAiBusyTab(tab, options?.aiBusyOverride);
    console.log('[CloseTab] start project=' + projectId.slice(-12) +
      ' tab=' + tabId.slice(-12) +
      ' name=' + JSON.stringify(tab?.name || '') +
      ' cmd=' + (tab?.commandType || 'none') +
      ' type=' + (tab?.tabType || 'terminal') +
      ' ai=' + isAiTab +
      ' aiBusy=' + aiBusyAtClose +
      ' skip=' + !!options?.skipProcessCheck +
      ' forceCleanup=' + !!options?.forceCleanup);
    // OSC 133 process state — captured before potential confirm() dialog so we
    // can persist whether the tab had a live CLI for Shift+Cmd+T reopen logic.
    let processWasRunning = false;
    let commandState: any = null;
    let runningProcessInfo: any = null;
    let foregroundAiProcess = false;

    if (tab.tabType !== 'claude-sdk' && tab.tabType !== 'file') {
      // Check if terminal has running process via OSC 133 state (fast, no syscalls)
      commandState = await ipcRenderer.invoke('terminal:getCommandState', tabId);
      processWasRunning = !!commandState?.isRunning;
      console.log('[CloseTab] command-state tab=' + tabId.slice(-12) +
        ' running=' + processWasRunning +
        ' durMs=' + (Date.now() - closeStartedAt));
      if (processWasRunning) {
        runningProcessInfo = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId).catch(() => null);
        foregroundAiProcess = isAiForegroundProcess(runningProcessInfo);
      }

      if (!skipProcessCheck && commandState.isRunning) {
        if (isAiTab && (foregroundAiProcess || !runningProcessInfo?.hasProcess)) {
          // A live agent session is not a reason to ask — only an agent that is
          // mid-answer is, because closing then discards work in flight. An idle
          // session means history/Continue, not risk.
          if (aiBusyAtClose) {
            const confirmed = await confirmDestructiveClose({
              message: 'Хотите закрыть вкладку? Активный процесс',
              detail: 'AI-сессия сейчас отвечает. Вкладка закроется, ответ будет прерван.',
            });
            if (!confirmed) return false;
          }
        } else {
          const confirmed = await confirmDestructiveClose({
            message: 'Хотите закрыть вкладку? Активный процесс',
            detail: 'В терминале выполняется «' + (runningProcessInfo?.processName || 'неизвестный процесс') + '». Он будет остановлен.',
          });
          if (!confirmed) return false;
        }
      }
    }
    // For SDK tabs, "running" means the SDK turn is mid-stream — we infer it
    // from claudeBusy which is the same signal SessionActionChip watches.
    if (tab.tabType === 'claude-sdk') {
      processWasRunning = aiBusyAtClose;
      if (!skipProcessCheck && aiBusyAtClose) {
        const confirmed = await confirmDestructiveClose({
          message: 'Хотите закрыть вкладку? Активный процесс',
          detail: 'Claude SDK сейчас отвечает. Вкладка закроется, ответ будет прерван.',
        });
        if (!confirmed) return false;
      }
    }

    const closePreflight = await ipcRenderer.invoke('project:validate-tab-snapshot', {
      projectId: workspace.projectId,
      expectedTabIds: expectedTabIdsBeforeClose,
    }).catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (closePreflight?.success === false) {
      useUIStore.getState().showToast(
        'Вкладка не закрыта: список вкладок изменился, повторите действие',
        'error',
        5000,
      );
      return false;
    }

    const shouldStopAiProcess = isAiTab
      && (aiBusyAtClose || (processWasRunning && (foregroundAiProcess || !runningProcessInfo?.hasProcess)));

    // Compute TabBar position at close time (excluding sub-agent tabs, which
    // don't take a slot in the bar). Used as a placement hint by
    // reopenLastClosedTab.
    const orderedMainTabs = Array.from(workspace.tabs.values())
      .filter(t => !t.parentTabId);
    const closedPosition = orderedMainTabs.findIndex(t => t.id === tabId);

    // File tabs are linked document previews, not restorable terminal/AI sessions.
    const shouldArchiveToHistory = tab.tabType !== 'file' && options?.archive !== false;
    // Loader BEFORE the archive, not after it. The Codex path can legitimately
    // spend time here (writer proof + a possible stop-and-retry below), and a
    // click that visibly does nothing for that long was reported as "middle
    // click does not work". Cleared on every return-false path below.
    const showsPreArchiveLoader = isAiTab || processWasRunning;
    if (showsPreArchiveLoader) {
      tab.aiClosing = true;
      startTransition(() => {
        set({ openProjects: new Map(openProjects) });
      });
    }
    const clearClosingLoader = () => {
      if (!tab.aiClosing) return;
      tab.aiClosing = false;
      startTransition(() => {
        set({ openProjects: new Map(openProjects) });
      });
    };
    const archiveCommit = await commitArchiveWithStopRetry({
      shouldArchive: shouldArchiveToHistory,
      commandType: effectiveCommandType,
      // The unproven-writer refusal only: stop the live Codex first, then
      // retry the History write — the exact sequence the user performed by
      // hand (right-click → Стоп → close). Confirmation stays as-is: it was
      // already asked above when the agent is mid-answer.
      stopProcess: () => ipcRenderer.invoke('terminal:stop-ai-process', {
        tabId,
        toolType: effectiveCommandType,
        reason: 'close-tab-archive-retry',
      }),
      archive: () => ipcRenderer.invoke('project:archive-tab', {
        projectId,
        tab: {
          tabId,
          name: tab.name,
          cwd: tab.cwd,
          color: tab.color,
          notes: tab.notes,
          taskPlan: tab.taskPlan,
          commandType: effectiveCommandType,
          tabType: tab.tabType,
          filePath: tab.filePath,
          createdAt: tab.createdAt,
          claudeSessionId: tab.claudeSessionId,
          geminiSessionId: tab.geminiSessionId,
          codexSessionId: tab.codexSessionId,
          codexModel: tab.codexModel,
          codexEffort: tab.codexEffort,
          codexSettingsProofAt: tab.codexSettingsProofAt,
          codexSettingsProofSessionId: tab.codexSettingsProofSessionId,
          codexModelMigrationPending: tab.codexModelMigrationPending,
          codexModelMigrationRestoreDefaultModel: tab.codexModelMigrationRestoreDefaultModel,
          codexModelMigrationRestoreDefaultEffort: tab.codexModelMigrationRestoreDefaultEffort,
          codexModelMigrationSourceModel: tab.codexModelMigrationSourceModel,
          codexModelMigrationSourceEffort: tab.codexModelMigrationSourceEffort,
          codexModelMigrationTargetModel: tab.codexModelMigrationTargetModel,
          codexModelMigrationConfigPath: tab.codexModelMigrationConfigPath,
          codexModelMigrationConfigFingerprint: tab.codexModelMigrationConfigFingerprint,
          codexModelMigrationConfigAlreadyTarget: tab.codexModelMigrationConfigAlreadyTarget,
          sessionStatus: tab.sessionStatus,
          groupId: tab.groupId,
          windowScoped: tab.windowScoped,
          position: closedPosition >= 0 ? closedPosition : null,
          processWasRunning,
        }
      }),
    });
    if (!archiveCommit.ok) {
      clearClosingLoader();
      console.warn('[CloseTab] archive not committed; keeping tab and process tab=' + tabId.slice(-12)
        + ' reason=' + (archiveCommit.reason || 'unknown')
        + ' stoppedForRetry=' + (archiveCommit.stoppedForRetry === true)
        + ' error=' + (archiveCommit.error instanceof Error ? archiveCommit.error.message : 'none'));
      // A silent no-op click is the bug this whole path fixes — if the close
      // still cannot proceed, SAY why instead of leaving the tab to just sit
      // there. (The stop-and-retry already resolved the common Codex case; what
      // remains is genuinely unknown state worth a message.)
      useUIStore.getState().showToast(
        'Вкладка не закрыта: не удалось записать её в историю (' + (archiveCommit.reason || 'unknown') + ')',
        'error',
        5000,
      );
      return false;
    }
    if (!archiveCommit.skipped) {
      console.log('[CloseTab] archive committed tab=' + tabId.slice(-12) +
        ' historyId=' + (archiveCommit.result?.historyId ?? 'none') +
        ' stoppedForRetry=' + (archiveCommit.stoppedForRetry === true) +
        ' durMs=' + (Date.now() - closeStartedAt));
    } else if (tab.tabType === 'file') {
      console.log('[CloseTab] archive skipped file tab=' + tabId.slice(-12));
    }

    // Nothing below this point may run until a requested History row is
    // durably committed. On archive failure the live process and tab stay
    // intact, so the user can retry instead of losing the only copy.
    //
    // Any close that has to terminate something takes measurable time (graceful
    // Ctrl+C plus flush is up to ~1.2s for a busy agent). Show the shutdown
    // loader in place of the tab title for the whole of it — a tab that just
    // sits there after the click reads as "the close did not work", which is
    // exactly how the broken Codex path was reported. (The loader may already
    // be up from the pre-archive block; this only widens it to the stop phase.)
    const showsClosingLoader = shouldStopAiProcess || processWasRunning;
    if (showsClosingLoader && !tab.aiClosing) {
      tab.aiClosing = true;
      startTransition(() => {
        set({ openProjects: new Map(openProjects) });
      });
    }
    if (shouldStopAiProcess) {
      try {
        if (tab.tabType === 'claude-sdk') {
          await Promise.race([
            ipcRenderer.invoke('claude-sdk:stop', { tabId, hard: true }),
            new Promise(resolve => setTimeout(resolve, 2500)),
          ]);
        }
      } catch (err: any) {
        console.warn('[CloseTab] graceful AI stop failed tab=' + tabId.slice(-12) + ': ' + (err?.message || err));
      }
    }

    // HARD kill — closing an SDK tab must fully terminate the process and all
    // background agents (no orphans). A soft interrupt would leave a parked
    // session with no UI to control it.
    if (tab.tabType === 'claude-sdk') {
      if (!shouldStopAiProcess) {
        ipcRenderer.invoke('claude-sdk:stop', { tabId, hard: true }).catch(() => {});
      }
      ipcRenderer.send('claude-sdk:busy-state', { tabId, busy: false, reason: 'close' });
    }

    if (tab.tabType !== 'claude-sdk' && tab.tabType !== 'file') {
      const closeRuntime = await stopAiBeforeTerminalKill({
        shouldStopAiProcess,
        stopAiProcess: () => ipcRenderer.invoke('terminal:stop-ai-process', {
          tabId,
          toolType: effectiveCommandType,
          reason: 'close-tab',
        }),
        killTerminal: () => ipcRenderer.send('terminal:kill', tabId),
      });
      if (closeRuntime.stopError) {
        const error = closeRuntime.stopError;
        console.warn('[CloseTab] structured AI stop failed before terminal kill tab='
          + tabId.slice(-12)
          + ': ' + (error instanceof Error ? error.message : String(error)));
      }
      if (!closeRuntime.terminalKilled) {
        tab.aiClosing = false;
        startTransition(() => {
          set({ openProjects: new Map(openProjects) });
        });
        const stopFailure = closeRuntime.stopResult?.error
          || (closeRuntime.stopError instanceof Error
            ? closeRuntime.stopError.message
            : String(closeRuntime.stopError || 'stop_not_confirmed'));
        const historyId = archiveCommit.result?.historyId;
        if (historyId !== null && historyId !== undefined) {
          const rollback = await ipcRenderer.invoke('project:delete-tab-history-entry', {
            id: historyId,
          }).catch((error: any) => ({
            success: false,
            error: error?.message || String(error),
          }));
          console.warn('[CloseTab] archive rolled back after Stop refusal tab='
            + tabId.slice(-12)
            + ' historyId=' + historyId
            + ' success=' + (rollback?.success === true)
            + ' error=' + (rollback?.error || '-'));
        }
        console.warn('[CloseTab] keeping tab and PTY because Stop was not proven tab='
          + tabId.slice(-12)
          + ' error=' + stopFailure);
        return false;
      }
      console.log('[CloseTab] terminal:kill sent tab=' + tabId.slice(-12) +
        ' durMs=' + (Date.now() - closeStartedAt));
    }
    const closeCandidateTabs = new Map(workspace.tabs);
    closeCandidateTabs.delete(tabId);
    for (const remainingTab of closeCandidateTabs.values()) {
      if (remainingTab.visualParentTabId === tabId) remainingTab.visualParentTabId = undefined;
    }
    const closeSnapshot = await saveTabsThenNotifyProjectLayoutChanged(
      workspace.projectId,
      closeCandidateTabs,
      'tab-closed',
      options?.forceCleanup || closeCandidateTabs.size === 0,
      expectedTabIdsBeforeClose,
    );
    if (closeSnapshot?.success === false) {
      clearClosingLoader();
      const historyId = archiveCommit.result?.historyId;
      if (historyId !== null && historyId !== undefined) {
        await ipcRenderer.invoke('project:delete-tab-history-entry', { id: historyId }).catch(() => null);
      }
      useUIStore.getState().showToast(
        'Вкладка не закрыта: состояние проекта изменилось, повторите действие',
        'error',
        5000,
      );
      console.warn('[CloseTab] snapshot rejected before renderer removal tab=' + tabId.slice(-12)
        + ' error=' + (closeSnapshot?.error || 'unknown'));
      return false;
    }

    workspace.tabs = closeCandidateTabs;
    clearTerminalBuffer(tabId);
    clearPendingAutoTabTitle(tabId, 'tab-closed');
    autoTabTitleIntents.delete(tabId);
    usePromptQueueStore.getState().cleanupClosedTab(tabId);
    // Remove closed tab from history
    workspace.tabHistory = workspace.tabHistory.filter(id => id !== tabId);
    set({ globalTabMru: dropFromMru(get().globalTabMru, tabId) });
    // …and from every pane's own visit history: a closed tab must not be
    // offered as a step-back target, and a dead entry would survive into the
    // saved session wasting the cap.
    {
      const purge = dropTabFromAllPaneHistories(get().splitPanes, tabId);
      if (purge) set({ splitPanes: purge.panes });
      const detachedPurge = dropTabFromAllPaneDetachedTabs(get().splitPanes, tabId);
      if (detachedPurge) set({ splitPanes: detachedPurge.panes });
    }
    // …и из окон ОСТАЛЬНЫХ пространств. Их раскладка лежит в снимках и обычными
    // путями не правится вовсе: чип, указывающий на закрытую вкладку, дожил бы
    // до возврата в то пространство и нарисовался бы там окном без разметки.
    {
      const st = get();
      const purge = dropTabsFromOtherSpaces(st.spaces, st.activeSpaceId, [tabId], dropTabFromAllPaneStrips);
      if (purge) set({ spaces: purge.spaces });
    }
    // «Что показывало ЭТО пространство» — тоже размещение, и оно тоже переживало
    // свою вкладку: запись оставалась на закрытой, и любой вопрос «где эта
    // вкладка лежит» отвечал «здесь», хотя её уже нет.
    if (get().activeSpaceTab?.tabId === tabId) set({ activeSpaceTab: null });
    // Closing a TAB is not "remove this pane from the workspace": the slot the
    // user built is not part of what they deleted. The pane stays and becomes
    // an empty placeholder; only a two-pane split collapses, because a split of
    // one is single mode with extra steps. (Reported live: closing a tab from
    // the sidebar took its whole column with it.)
    // The surviving pane inherits global focus AFTER the workspace cleanup
    // below (otherwise this project's own LRU fallback would win and the
    // user would land on a tab that is not even on screen).
    let splitSurvivor: SplitPane | null = null;
    {
      const { splitPanes, splitFocusedIndex } = get();
      const splitRes = emptyPaneByClosedTab(splitPanes, splitFocusedIndex, tabId);
      if (splitRes) {
        // Same question as removeTabFromSplit — "which pane stayed on screen" —
        // so it reads the same answer. This used to re-derive it locally by
        // scanning for any pane that is not the closed one, which also matched
        // an empty placeholder and then quietly activated nothing.
        // A pane that just became a PLACEHOLDER is not a survivor: it has no
        // tab to activate, and naming it would leave the centre on nothing.
        const preserveFocusedEmptyPane = options?.preserveFocusedEmptyPane === true
          && splitRes.emptiedIndex === splitRes.focusedIndex;
        const focusedAfter = splitRes.panes[splitRes.focusedIndex];
        splitSurvivor = preserveFocusedEmptyPane
          ? null
          : ((focusedAfter && focusedAfter.tabId ? focusedAfter : null)
            || (splitRes as { survivor?: SplitPane | null }).survivor
            || splitRes.panes.find((p) => p.tabId) || null);
        set({ splitPanes: splitRes.panes, splitFocusedIndex: splitRes.focusedIndex });
        console.log('[Split] tab-closed tab=' + tabId.slice(-12)
          + ' panes=' + splitRes.panes.length
          + (splitRes.emptiedIndex !== undefined ? ' emptied=' + splitRes.emptiedIndex : ' collapsed')
          + (preserveFocusedEmptyPane ? ' preserveFocus=1' : ''));
      }
      // …and out of any OTHER window that merely held its chip. The call above
      // acts on the one window that was SHOWING it; a chip sitting unshown
      // elsewhere would otherwise survive its own tab and restore as a row
      // pointing at nothing.
      const strips = dropTabFromAllPaneStrips(get().splitPanes, tabId);
      if (strips) set({ splitPanes: strips.panes });
      // Same for the single-mode centre's strips — ALL of them, not just this
      // tab's own project: strips are cross-project, so a tab can sit as a chip
      // in a strip belonging to a project it does not come from.
      {
        const before = get().centerStrips;
        let changed = false;
        const nextStrips: typeof before = {};
        Object.entries(before).forEach(([key, strip]) => {
          if (!strip.some((e) => e.tabId === tabId)) { nextStrips[key] = strip; return; }
          changed = true;
          const rest = removeFromStrip(strip, tabId);
          // One chip left is not a strip: the project goes back to behaving
          // exactly as it did before a strip was ever built there.
          if (rest.length > 1) nextStrips[key] = rest;
        });
        if (changed) set({ centerStrips: nextStrips });
      }
    }

    if (workspace.activeTabId === tabId) {
      // Find next tab from history (LRU: last visited that still exists).
      let nextTabId: string | null = null;
      for (let i = workspace.tabHistory.length - 1; i >= 0; i--) {
        const candidateId = workspace.tabHistory[i];
        const candidate = workspace.tabs.get(candidateId);
        if (candidate) {
          nextTabId = candidateId;
          break;
        }
      }
      // Fallback: last tab if history didn't help.
      if (!nextTabId) {
        const mainTabs = Array.from(workspace.tabs.values());
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

    console.log('[CloseTab] snapshot-committed tab=' + tabId.slice(-12)
      + ' success=' + (closeSnapshot?.success !== false)
      + ' remaining=' + workspace.tabs.size
      + ' durMs=' + (Date.now() - closeStartedAt));
    await ipcRenderer.invoke('orchestration:tab-closed', {
      tabId,
      projectId: workspace.projectId,
    }).catch((error: any) => {
      console.warn('[CloseTab] orchestration cleanup failed tab=' + tabId.slice(-12) + ': ' + (error?.message || error));
    });
    console.log('[CloseTab] state-updated tab=' + tabId.slice(-12) +
      ' remaining=' + workspace.tabs.size +
      ' active=' + (workspace.activeTabId ? workspace.activeTabId.slice(-12) : 'none') +
      ' durMs=' + (Date.now() - closeStartedAt));
    // Split focus follow-through: the surviving pane's tab takes over, even
    // when it belongs to another project.
    if (splitSurvivor && get().openProjects.get(splitSurvivor.projectId)?.tabs.has(splitSurvivor.tabId)) {
      get().activateCenterTab(splitSurvivor.projectId, splitSurvivor.tabId);
    }
    return true;
  },

  restoreTabHistoryEntry: async (projectId, historyId, options = {}) => {
    const workspace = get().openProjects.get(projectId);
    if (!workspace) {
      return { tabId: null, reason: 'error', message: 'Проект не открыт' };
    }

    let lease: any;
    try {
      lease = await ipcRenderer.invoke('project:begin-tab-history-restore', {
        projectId,
        id: historyId,
      });
    } catch (error) {
      console.warn('[TabHistoryRestore] begin IPC failed', { projectId, historyId, error });
      return { tabId: null, reason: 'error', message: 'Не удалось прочитать историю вкладок' };
    }

    if (!lease?.ok) {
      const reason = lease?.reason === 'busy'
        ? 'busy'
        : (lease?.reason === 'not_found' ? 'empty' : 'error');
      return {
        tabId: null,
        reason,
        historyId: lease?.id ?? historyId,
        message: reason === 'busy'
          ? 'Эта вкладка уже восстанавливается'
          : (reason === 'empty' ? 'Нет закрытых вкладок' : 'Не удалось начать восстановление вкладки'),
      };
    }

    const entry = lease.entry as TabHistoryRestoreEntry;
    const finishLease = async (commit: boolean) => {
      try {
        return await ipcRenderer.invoke('project:finish-tab-history-restore', {
          projectId,
          id: entry.id,
          token: lease.token,
          commit,
        });
      } catch (error) {
        console.warn('[TabHistoryRestore] finish IPC failed', {
          projectId,
          historyId: entry.id,
          commit,
          error,
        });
        return { ok: false, reason: 'ipc_failed' };
      }
    };
    const expectedTabId = typeof options.expectedTabId === 'string'
      ? options.expectedTabId.trim()
      : '';
    if (expectedTabId && entry.tab_id !== expectedTabId) {
      await finishLease(false);
      return {
        tabId: null,
        historyId: entry.id,
        reason: 'error',
        message: 'Архивная запись не принадлежит запрошенной вкладке',
      };
    }
    if (expectedTabId && workspace.tabs.has(expectedTabId)) {
      await finishLease(false);
      return {
        tabId: null,
        historyId: entry.id,
        reason: 'busy',
        message: 'Вкладка уже открыта',
      };
    }
    const background = options.background === true;
    const mainTabIds = Array.from(workspace.tabs.values())
      .filter(tab => !tab.parentTabId)
      .map(tab => tab.id);
    const hintedPosition = typeof entry.position === 'number' ? entry.position : mainTabIds.length;
    const targetIndex = Math.max(0, Math.min(mainTabIds.length, hintedPosition));
    const restoredGroupId = resolveExistingTabGroupId(workspace, entry.group_id);

    const restoreCwd = await resolveHistoryRestoreCwd(entry, workspace.projectPath);
    if (options.requireExactCwd === true
      && normalizeComparablePath(restoreCwd.cwd) !== normalizeComparablePath(entry.cwd)) {
      await finishLease(false);
      return {
        tabId: null,
        historyId: entry.id,
        reason: 'error',
        message: 'Сохранённая рабочая папка вкладки больше недоступна',
        cwd: restoreCwd.cwd,
        fallbackFrom: restoreCwd.fallbackFrom,
      };
    }
    if (restoreCwd.requiresConfirmation) {
      let confirmed = false;
      if (normalizeComparablePath(restoreCwd.cwd) === '/') {
        const selected = await ipcRenderer.invoke('app:select-directory').catch(() => null);
        if (typeof selected === 'string' && selected.trim()) {
          restoreCwd.cwd = selected;
          confirmed = true;
        }
      } else {
        const explanation = restoreCwd.confirmationReason === 'project-name-prefix'
          ? 'Путь похож на обрезанное имя проекта, но это нельзя доказать автоматически.'
          : 'Будет использована ближайшая существующая родительская папка.';
        confirmed = window.confirm(
          `Сохранённая папка Codex больше не существует:\n${entry.cwd}\n\n` +
          `${explanation}\nПродолжить сессию в:\n${restoreCwd.cwd}?`
        );
      }
      if (!confirmed) {
        await finishLease(false);
        return {
          tabId: null,
          historyId: entry.id,
          reason: 'cancelled',
          message: 'Восстановление отменено: запись истории сохранена',
          cwd: restoreCwd.cwd,
          fallbackFrom: restoreCwd.fallbackFrom,
        };
      }
    }

    let newTabId = '';
    try {
      newTabId = await get().createTab(projectId, entry.name, restoreCwd.cwd, {
        color: (entry.color || undefined) as TabColor | undefined,
        notes: entry.notes || undefined,
        taskPlan: parseHistoryTaskPlan(entry.task_plan),
        commandType: (entry.command_type || undefined) as CommandType | undefined,
        // 'browser' в старых записях истории читаем как обычный терминал:
        // такой вкладки больше нет, а восстанавливать её нечем.
        tabType: (entry.tab_type === 'file' ? 'file' : entry.tab_type === 'claude-sdk' ? 'claude-sdk' : 'terminal') as TabType,
        filePath: entry.file_path || undefined,
        pendingAction: buildHistoryPendingAction(entry, options.resumePolicy),
        claudeSessionId: entry.claude_session_id || undefined,
        geminiSessionId: entry.gemini_session_id || undefined,
        codexSessionId: entry.codex_session_id || undefined,
        codexModel: entry.codex_model || undefined,
        codexEffort: entry.codex_effort || undefined,
        codexSettingsProofAt: Number(entry.codex_settings_proof_at) || undefined,
        codexSettingsProofSessionId: entry.codex_settings_proof_session_id || undefined,
        codexModelMigrationPending: entry.codex_model_migration_pending === 1 || entry.codex_model_migration_pending === true || undefined,
        codexModelMigrationRestoreDefaultModel: entry.codex_model_migration_restore_default_model === 1 || entry.codex_model_migration_restore_default_model === true || undefined,
        codexModelMigrationRestoreDefaultEffort: entry.codex_model_migration_restore_default_effort === 1 || entry.codex_model_migration_restore_default_effort === true || undefined,
        codexModelMigrationSourceModel: entry.codex_model_migration_source_model || undefined,
        codexModelMigrationSourceEffort: entry.codex_model_migration_source_effort || undefined,
        codexModelMigrationTargetModel: entry.codex_model_migration_target_model || undefined,
        codexModelMigrationConfigPath: entry.codex_model_migration_config_path || undefined,
        codexModelMigrationConfigFingerprint: entry.codex_model_migration_config_fingerprint || undefined,
        codexModelMigrationConfigAlreadyTarget: entry.codex_model_migration_config_already_target === 1 || entry.codex_model_migration_config_already_target === true || undefined,
        sessionStatus: entry.session_status || undefined,
        nameSetManually: entry.name_set_manually === 1,
        groupId: restoredGroupId,
        windowScoped: entry.window_scoped === 1 || undefined,
        background,
        restoreId: expectedTabId || undefined,
      });
      if (!newTabId) throw new Error('create_tab_returned_empty');
    } catch (error) {
      await finishLease(false);
      console.error('[TabHistoryRestore] create failed', {
        projectId,
        historyId: entry.id,
        cwd: restoreCwd.cwd,
        error,
      });
      return {
        tabId: null,
        historyId: entry.id,
        reason: 'error',
        message: formatHistoryRestoreError(entry, error),
        cwd: restoreCwd.cwd,
        fallbackFrom: restoreCwd.fallbackFrom,
      };
    }

    const currentState = get();
    const after = currentState.openProjects.get(projectId);
    if (after && options.restorePosition) {
      const entries = Array.from(after.tabs.entries());
      const newEntryIndex = entries.findIndex(([id]) => id === newTabId);
      if (newEntryIndex !== -1) {
        const [newEntry] = entries.splice(newEntryIndex, 1);
        entries.splice(Math.min(targetIndex, entries.length), 0, newEntry);
        after.tabs = new Map(entries);
        set({ openProjects: new Map(currentState.openProjects) });
      }
    }

    // createTab schedules its normal persistence asynchronously. Restore needs
    // a stronger durability boundary: await a save of the final (reordered)
    // state before consuming the only history record.
    const finalWorkspace = get().openProjects.get(projectId);
    const persisted = finalWorkspace
      ? await saveTabs(projectId, finalWorkspace.tabs)
      : { success: false };
    if (!isDurableSaveTabsAck(persisted)) {
      await finishLease(false);
      console.warn('[TabHistoryRestore] replacement is live but not durably saved; history retained', {
        projectId,
        historyId: entry.id,
        tabId: newTabId,
      });
      if (!background) {
        get().switchTab(projectId, newTabId);
        get().setProjectView(projectId, 'terminal');
      }
      return {
        tabId: newTabId,
        historyId: entry.id,
        cwd: restoreCwd.cwd,
        fallbackFrom: restoreCwd.fallbackFrom,
        historyDeleteFailed: true,
        message: 'Вкладка открыта, но не сохранена в базе. Запись истории оставлена',
      };
    }
    notifyProjectLayoutChanged(projectId, 'tab-reopened');

    const committed = await finishLease(true);
    const historyDeleteFailed = !committed?.ok || committed?.committed !== true;
    if (historyDeleteFailed) {
      console.warn('[TabHistoryRestore] replacement saved but history cleanup failed', {
        projectId,
        historyId: entry.id,
        tabId: newTabId,
        reason: committed?.reason || 'unknown',
      });
    }

    if (!background) {
      get().switchTab(projectId, newTabId);
      get().setProjectView(projectId, 'terminal');
    }
    return {
      tabId: newTabId,
      historyId: entry.id,
      cwd: restoreCwd.cwd,
      fallbackFrom: restoreCwd.fallbackFrom,
      historyDeleteFailed,
      message: historyDeleteFailed
        ? 'Вкладка восстановлена, но запись истории не удалось удалить'
        : undefined,
    };
  },

  // Shift+Cmd+T restores the latest row serially per project. Rapid repeated
  // key presses walk backwards through History instead of racing on one row.
  reopenLastClosedTab: (projectId, options) => {
    // Capture the pane named by the gesture, not whatever happens to be focused
    // after the async history/PTY work completes.
    const requestedPaneIndex = Number.isInteger(options?.targetPaneIndex)
      ? Number(options?.targetPaneIndex)
      : -1;
    const previous = reopenLastClosedQueues.get(projectId)
      || Promise.resolve<TabHistoryRestoreResult>({ tabId: null });
    const restore = previous
      .catch((): TabHistoryRestoreResult => ({ tabId: null }))
      .then((previousResult): Promise<TabHistoryRestoreResult> => {
        // If the preceding queued operation did not consume its row, the same
        // row is still latest. Do not turn a rapid second keypress into a
        // duplicate live tab; a later deliberate keypress may retry it.
        if (previousResult.historyId && (!previousResult.tabId || previousResult.historyDeleteFailed)) {
          return Promise.resolve({
            tabId: null,
            historyId: previousResult.historyId,
            reason: 'busy',
            message: 'Предыдущее восстановление не завершено; повтор остановлен',
          });
        }
        const paneTargetExists = requestedPaneIndex >= 0 && !!get().splitPanes[requestedPaneIndex];
        return get().restoreTabHistoryEntry(projectId, undefined, {
          // Keep createTab from selecting a project-wide active tab before the
          // pane slot exists. Placement below is the visible commit.
          background: paneTargetExists,
          restorePosition: true,
          resumePolicy: 'if-process-was-running',
        }).then((result) => {
          if (!result.tabId || !paneTargetExists) return result;
          const current = get();
          if (current.splitPanes[requestedPaneIndex]) {
            current.addTabToSplitPaneStrip(requestedPaneIndex, projectId, result.tabId);
          } else {
            // The pane disappeared while PTY creation was in flight. Preserve
            // access to the restored tab instead of silently losing the action.
            current.activateCenterTab(projectId, result.tabId);
          }
          return result;
        });
      });
    reopenLastClosedQueues.set(projectId, restore);
    const cleanup = () => {
      if (reopenLastClosedQueues.get(projectId) === restore) {
        reopenLastClosedQueues.delete(projectId);
      }
    };
    void restore.then(cleanup, cleanup);
    return restore;
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
      const _startAbs = performance.timeOrigin + _t0;
      let _phaseAt = _t0;
      let _notificationMs = 0;
      let _activePointerMs = 0;
      let _mruMs = 0;
      let _spaceRouteMs = 0;
      let _placementMs = 0;
      let _finalSetMs = 0;
      const prevActiveId = workspace.activeTabId;
      const currentView = workspace.currentView;
      const totalTabs = Array.from(openProjects.values()).reduce((acc, ws) => acc + ws.tabs.size, 0);
      const targetTab = workspace.tabs.get(tabId);
      // Opening a tab ACKNOWLEDGES a notification that already fired; it must
      // not cancel a one-shot bell that is still waiting for this turn to end.
      // Conflating those states made the orange/red ring disappear merely from
      // focus, then reappear on the next busy edge although the menu still
      // described the bell as enabled.
      if (targetTab?.completionNotificationFired) {
        delete targetTab.completionNotificationFired;
        delete targetTab.completionNotificationFiredAt;
        emitTabCompletionNotificationCleared({ projectId, tabId });
        console.warn('[TabNotification] acknowledged tab=' + tabId.slice(-12)
          + ' source=tab-activation'
          + ' armed=' + (targetTab.completionNotificationArmed ? '1' : '0')
          + ' persistent=' + (targetTab.completionNotificationPersistent ? '1' : '0'));
      }
      _notificationMs = performance.now() - _phaseAt;
      _phaseAt = performance.now();
      workspace.activeTabId = tabId;
      workspace.activeGroupId = null;
      // Что показывает ЭТО пространство. Пишется на каждой активации, потому
      // что «последняя вкладка пространства» — это просто последняя активация,
      // случившаяся пока оно было на экране.
      set({ activeSpaceTab: { projectId, tabId } });
      _activePointerMs = performance.now() - _phaseAt;
      _phaseAt = performance.now();
      // Don't reset viewingSubAgentTabId here — it persists across tab switches.
      // User dismisses it explicitly via SubAgentBar "← Back" button or clicking the active chip.
      workspace.selectedTabIds = [tabId]; // Update selection on direct switch
      // Push to tab history (LRU, max 20)
      workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
      get().touchGlobalTabMru(projectId, tabId);
      _mruMs = performance.now() - _phaseAt;
      _phaseAt = performance.now();
      // Split rule at the single activation choke point: visible tab → focus
      // its pane; hidden tab → replace the focused pane's slot (an empty
      // placeholder pane in focus gets filled the same way). Runs for every
      // caller (sidebar click, switcher, project click).
      {
        // ПЕРЕД правилом окон — правило пространств. Вкладка, разложенная в
        // другом пространстве, уже имеет своё место; открыть её здесь значило бы
        // завести ей второе, а человек в этот момент просит показать её — то
        // самое окно, которое обещала карта в списке. Поэтому сначала переходим
        // туда, и правило окон ниже отрабатывает уже в нужной раскладке, где
        // вкладка «видна» и просто получает фокус своего окна.
        //
        // Но если вкладка разложена И ЗДЕСЬ — здесь и остаёмся. Раскладки
        // пространств независимы, и одна вкладка может лежать в нескольких
        // (человек: «можно, чтобы она одновременно отображалась в двух»).
        // Без этой оговорки переключение пространств зацикливалось: возврат
        // пространства к своей последней вкладке снова находил её в СТАРОМ
        // пространстве и уводил обратно — «кликаю на пространство 2,
        // перекидывает в 1», парные [Spaces] switch в логе с разницей в 1мс.
        const holder = get().workspaceSpaceIndexOfTab(tabId);
        const holderId = holder >= 0 ? get().spaces[holder]?.id : null;
        const heldHereToo = (() => {
          const st2 = get();
          // «Лежит ли вкладка в ТЕКУЩЕМ пространстве» — по живой раскладке.
          const inPanes = st2.splitPanes.some((pn: any) => (
            pn.tabId === tabId || (pn.tabs || []).some((e2: any) => e2?.tabId === tabId)
          ));
          if (inPanes) return true;
          return Object.values(st2.centerStrips || {}).some((strip: any) => (
            (Array.isArray(strip) ? strip : []).some((e2: any) => e2?.tabId === tabId)
          ));
        })();
        if (holderId && holderId !== get().activeSpaceId && !heldHereToo) {
          get().switchWorkspaceSpace(holderId);
        }
      }
      _spaceRouteMs = performance.now() - _phaseAt;
      _phaseAt = performance.now();
      {
        const { splitPanes, splitFocusedIndex } = get();
        if (splitPanes.length > 0) {
          const splitRes = resolveSplitActivation(splitPanes, splitFocusedIndex, projectId, tabId);
          if (splitRes.panes !== splitPanes || splitRes.focusedIndex !== splitFocusedIndex) {
            set({ splitPanes: splitRes.panes, splitFocusedIndex: splitRes.focusedIndex });
          }
        } else {
          // Single mode: the centre's strip follows the same rule as a window's
          // — a tab that is not in the strip JOINS it, at the end. A tab that
          // already has a chip is simply shown (nothing to write here: the chip
          // stays where the user put it, and the centre's active tab is what
          // moved).
          //
          // Keyed by the project the centre was showing BEFORE this switch: the
          // strip belongs to that centre, and the incoming tab may come from a
          // different project (strips are cross-project). Projects without a
          // strip are untouched — for them this is a lookup that finds nothing.
          const key = get().activeProjectId || projectId;
          const strip = get().centerStrips[key];
          if (strip && strip.length > 0) {
            // ЗАМЕНА показанного чипа, не добавление в конец — то же правило,
            // что у окон в разделённом виде (resolveSplitActivation): обычный
            // клик МЕНЯЕТ текущее окно, в конец кладут явные жесты (двойной
            // клик, «Move to window»), а новое окно открывает ⌘-клик.
            const shownBefore = key === projectId
              ? prevActiveId
              : (openProjects.get(key)?.activeTabId ?? null);
            const next = replaceInStrip(strip, shownBefore || '', projectId, tabId);
            if (next !== strip) set({ centerStrips: { ...get().centerStrips, [key]: next } });
          }
        }
      }
      _placementMs = performance.now() - _phaseAt;
      _phaseAt = performance.now();
      // Names any main-thread block overlapping the urgent switch frame — the
      // 100-134ms "none-marked" tasks right after every tab click are this.
      const endTabSwitchMark = markRendererActivity('tab-switch:' + tabId.slice(-8));
      // Use startTransition to prevent UI blocking during re-render
      startTransition(() => {
        // BOTH pointers follow the activated tab: the centre (every tab-owned
        // surface — control bar, History, Timeline, hotkeys) and the sidebar
        // (the map the user navigates by). An explicit project click can still
        // park the sidebar elsewhere — until the next activation lands here.
        set({ openProjects: new Map(openProjects), ...activationFollowPatch(get(), projectId) });
      });
      _finalSetMs = performance.now() - _phaseAt;
      const syncMs = performance.now() - _t0;
      console.warn(
        `[Perf:TabSwitchStart] project=${projectId.slice(-12)} from=${String(prevActiveId).slice(-12)}` +
        ` startAbs=${_startAbs.toFixed(1)}` +
        ` endAbs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` to=${tabId.slice(-12)} currentView=${currentView} tabs=${workspace.tabs.size}` +
        ` totalTabs=${totalTabs} syncMs=${syncMs.toFixed(1)}` +
        ` notifyMs=${_notificationMs.toFixed(1)}` +
        ` activePointerMs=${_activePointerMs.toFixed(1)}` +
        ` mruMs=${_mruMs.toFixed(1)}` +
        ` spaceRouteMs=${_spaceRouteMs.toFixed(1)}` +
        ` placementMs=${_placementMs.toFixed(1)}` +
        ` finalSetMs=${_finalSetMs.toFixed(1)}`
      );
      requestAnimationFrame(() => {
        endTabSwitchMark();
        const durMs = (performance.now() - _t0).toFixed(1);
        console.warn(
          `[Perf:TabSwitch] project=${projectId.slice(-12)} from=${String(prevActiveId).slice(-12)}` +
          ` to=${tabId.slice(-12)} frameAbs=${(performance.timeOrigin + performance.now()).toFixed(1)} durMs=${durMs}`
        );
        requestAnimationFrame(() => {
          const state = get();
          const wsNow = state.openProjects.get(projectId);
          const dur2Ms = (performance.now() - _t0).toFixed(1);
          console.warn(
            `[Perf:TabSwitchFrame2] project=${projectId.slice(-12)} from=${String(prevActiveId).slice(-12)}` +
            ` to=${tabId.slice(-12)} durMs=${dur2Ms}` +
            ` frameAbs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
            ` currentView=${wsNow?.currentView || 'missing'} activeNow=${String(wsNow?.activeTabId).slice(-12)}`
          );
        });
      });
      saveSession();
    }
  },

  setActiveTabGroup: (projectId, groupId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    const nextGroupId = groupId && workspace.tabGroups.some(group => group.id === groupId)
      ? groupId
      : null;
    if (workspace.activeGroupId === nextGroupId) return;

    workspace.activeGroupId = nextGroupId;
    if (nextGroupId) workspace.selectedTabIds = [];
    set({ openProjects: new Map(openProjects) });
  },

  renameTab: (projectId, tabId, newName) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    const cleanName = newName.trim();
    if (!cleanName) return;

    if (workspace) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        if (tab.name === cleanName) {
          console.warn('[Store:renameTab] noop unchanged tab=' + tabId.slice(-8) + ' name=' + JSON.stringify(cleanName));
          return;
        }
        tab.name = cleanName;
        tab.nameSetManually = true;
        clearPendingAutoTabTitle(tabId, 'manual-name');
        autoTabTitleIntents.delete(tabId);
        set({ openProjects: new Map(openProjects) });

        // Save tabs
        saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'tab-rename');
      }
    }
  },

  autoRenameTab: (tabId, newName, options = {}) => {
    const cleanName = normalizeGeneratedTabName(newName);
    if (!cleanName) return false;

    const { openProjects } = get();
    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      if (tab.nameSetManually && !options.overrideManualName) {
        console.warn('[Store:autoRenameTab] skip tab=' + tabId.slice(-8) + ' reason=manual-name');
        return false;
      }
      if (options.toolType && tab.commandType && tab.commandType !== options.toolType && !options.overrideManualName) {
        console.warn('[Store:autoRenameTab] skip tab=' + tabId.slice(-8) + ' reason=tool-mismatch expected=' + options.toolType + ' actual=' + tab.commandType);
        return false;
      }
      if (options.sessionId) {
        const currentSessionId = options.toolType === 'codex'
          ? tab.codexSessionId
          : options.toolType === 'gemini'
            ? tab.geminiSessionId
            : tab.claudeSessionId;
        if (currentSessionId !== options.sessionId) {
          console.warn('[Store:autoRenameTab] skip tab=' + tabId.slice(-8) + ' reason=session-changed expected=' + options.sessionId.slice(0, 8) + ' actual=' + (currentSessionId ? currentSessionId.slice(0, 8) : 'null'));
          return false;
        }
      }

      const existingNames = Array.from(workspace.tabs.values())
        .filter(t => t.id !== tabId)
        .map(t => t.name);
      const uniqueName = getNextAvailableName(cleanName, existingNames);
      if (tab.name === uniqueName) {
        if (options.markNameSetManually && !tab.nameSetManually) {
          tab.nameSetManually = true;
          clearPendingAutoTabTitle(tabId, 'explicit-title-refresh');
          autoTabTitleIntents.delete(tabId);
          set({ openProjects: new Map(openProjects) });
          saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'tab-rename');
          console.warn('[Store:autoRenameTab] tab=' + tabId.slice(-8) + ' unchanged but marked manual ' + JSON.stringify(uniqueName));
          return true;
        }
        return false;
      }

      const prevName = tab.name;
      tab.name = uniqueName;
      if (options.markNameSetManually) {
        tab.nameSetManually = true;
        clearPendingAutoTabTitle(tabId, 'explicit-title-refresh');
        autoTabTitleIntents.delete(tabId);
      }
      // Automatic generated names remain auto-owned. Explicit context-menu
      // refresh can opt into nameSetManually so future automatic launch naming
      // still respects the user's intentional action.
      set({ openProjects: new Map(openProjects) });
      saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'tab-rename');
      console.warn('[Store:autoRenameTab] tab=' + tabId.slice(-8) + ' ' + JSON.stringify(prevName) + ' → ' + JSON.stringify(uniqueName));
      return true;
    }
    return false;
  },

  setTabTitleNaming: (tabId, naming) => {
    const { tabTitleNamingIds } = get();
    const has = tabTitleNamingIds.has(tabId);
    if (has === naming) return;
    const next = new Set(tabTitleNamingIds);
    if (naming) next.add(tabId);
    else next.delete(tabId);
    set({ tabTitleNamingIds: next });
    console.warn(
      '[Store:TabTitleNaming]' +
      ' tab=' + tabId.slice(-8) +
      ' naming=' + naming +
      ' before=' + has +
      ' activeCount=' + next.size
    );
  },

  getPendingAutoTabTitle: (tabId, toolType, sessionId) => {
    return getPendingAutoTabTitle(tabId, toolType, sessionId);
  },

  consumePendingAutoTabTitle: (tabId, toolType, sessionId) => {
    return consumePendingAutoTabTitle(tabId, toolType, sessionId);
  },

  clearPendingAutoTabTitle: (tabId, reason) => {
    clearPendingAutoTabTitle(tabId, reason);
    autoTabTitleIntents.delete(tabId);
  },

  recoverPendingAutoTabTitle: (tabId, toolType, sessionId, mode) => {
    if (!tabId || !sessionId || pendingAutoTabTitles.has(tabId)) return false;
    armPendingAutoTabTitle(tabId, toolType, sessionId, { mode });
    console.warn(
      '[Store:AutoTabTitle] recover tab=' + tabId.slice(-8) +
      ' type=' + toolType +
      ' sid=' + sessionId.slice(0, 8) +
      ' mode=' + mode
    );
    return true;
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
        saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'tab-color');
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
    notifyProjectLayoutChanged(workspace.projectId, 'tab-status');
  },

  setTabCompletionNotificationArmed: (projectId, tabId, armed) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;
    const tab = workspace.tabs.get(tabId);
    if (!tab) return;
    if (armed) {
      tab.completionNotificationArmed = true;
      delete tab.completionNotificationFired;
      delete tab.completionNotificationFiredAt;
      emitTabCompletionNotificationCleared({ projectId, tabId });
    } else {
      delete tab.completionNotificationArmed;
      delete tab.completionNotificationFired;
      delete tab.completionNotificationFiredAt;
      emitTabCompletionNotificationCleared({ projectId, tabId });
    }
    set({ openProjects: new Map(openProjects) });
    console.warn('[TabNotification] one-shot tab=' + tabId.slice(-12)
      + ' armed=' + (armed ? '1' : '0')
      + ' persistent=' + (tab.completionNotificationPersistent ? '1' : '0'));
  },

  setTabCompletionNotificationPersistent: (projectId, tabId, persistent) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;
    const tab = workspace.tabs.get(tabId);
    if (!tab) return;
    if (persistent) {
      tab.completionNotificationPersistent = true;
      tab.completionNotificationArmed = true;
      delete tab.completionNotificationFired;
      delete tab.completionNotificationFiredAt;
      emitTabCompletionNotificationCleared({ projectId, tabId });
    } else {
      delete tab.completionNotificationPersistent;
    }
    set({ openProjects: new Map(openProjects) });
    console.warn('[TabNotification] persistent tab=' + tabId.slice(-12)
      + ' enabled=' + (persistent ? '1' : '0')
      + ' armed=' + (tab.completionNotificationArmed ? '1' : '0'));
    logRestartAfterState('target', workspace.projectId, tab);
    saveTabs(workspace.projectId, workspace.tabs);
  },

  clearTabCompletionNotification: (projectId, tabId, options) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;
    const tab = workspace.tabs.get(tabId);
    if (!tab) return;
    const hadPersistent = !!tab.completionNotificationPersistent;
    delete tab.completionNotificationArmed;
    delete tab.completionNotificationFired;
    delete tab.completionNotificationFiredAt;
    if (!options?.keepPersistent) delete tab.completionNotificationPersistent;
    emitTabCompletionNotificationCleared({ projectId, tabId });
    set({ openProjects: new Map(openProjects) });
    if (!options?.keepPersistent && hadPersistent) saveTabs(workspace.projectId, workspace.tabs);
  },

  applyTabCompletionOrchestrationState: (tabId, phase) => {
    const { openProjects, activeProjectId } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;

      if (phase === 'active') {
        let changed = false;
        if (tab.completionNotificationPersistent && !tab.completionNotificationArmed) {
          tab.completionNotificationArmed = true;
          changed = true;
        }
        if (tab.completionNotificationFired) {
          delete tab.completionNotificationFired;
          delete tab.completionNotificationFiredAt;
          emitTabCompletionNotificationCleared({ projectId: workspace.projectId, tabId });
          changed = true;
        }
        if (changed) set({ openProjects: new Map(openProjects) });
        return;
      }

      // A real parent turn owns the final notification once it starts. The
      // orchestration release only settles a bell while the parent itself is idle
      // and owes no queued work — an armed Run after will end its own last turn.
      if (tab.aiBusy) return;
      const deferReason = tabCompletionDeferralReason(tabId, phase === 'success');
      if (deferReason) {
        console.warn('[TabNotification] orchestration release deferred tab=' + tabId.slice(-12)
          + ' outcome=' + phase + ' reason=' + deferReason);
        return;
      }
      const settled = settleTabCompletionNotification({
        tab,
        workspace,
        activeProjectId,
        tabId,
        successful: phase === 'success',
      });
      if (!settled.changed) return;
      set({ openProjects: new Map(openProjects) });
      if (settled.detail) emitTabCompletionNotification(settled.detail);
      console.warn('[TabNotification] orchestration release tab=' + tabId.slice(-12)
        + ' outcome=' + phase
        + ' emitted=' + !!settled.detail);
      return;
    }
  },

  setTabRestartAfterTarget: (projectId, tabId, triggerTabId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;
    const tab = workspace.tabs.get(tabId);
    if (!tab) return;
    const value = typeof triggerTabId === 'string' && triggerTabId.trim() && triggerTabId !== tabId
      ? triggerTabId.trim()
      : null;
    if (value) {
      const prevIds = getRestartAfterTriggerIds(tab);
      const nextIds = prevIds.includes(value)
        ? prevIds.filter((id) => id !== value)
        : [...prevIds, value];
      if (nextIds.length > 0) {
        tab.restartAfterTabIds = nextIds;
        tab.restartAfterTabId = nextIds[0];
      } else {
        delete tab.restartAfterTabIds;
        delete tab.restartAfterTabId;
        delete tab.restartAfterCommand;
        delete tab.restartAfterPaused;
      }
      delete tab.restartAfterArmed;
      delete tab.restartAfterPersistent;
    } else {
      delete tab.restartAfterTabIds;
      delete tab.restartAfterTabId;
      delete tab.restartAfterCommand;
      delete tab.restartAfterPaused;
      delete tab.restartAfterArmed;
      delete tab.restartAfterPersistent;
    }
    set({ openProjects: new Map(openProjects) });
    logRestartAfterState('target', workspace.projectId, tab);
    saveTabs(workspace.projectId, workspace.tabs);
  },

  setTabRestartAfterCommand: (projectId, tabId, command) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;
    const tab = workspace.tabs.get(tabId);
    if (!tab || getRestartAfterTriggerIds(tab).length === 0) return;
    const nextCommand = command?.trim();
    if (nextCommand) {
      tab.restartAfterCommand = nextCommand;
    } else {
      delete tab.restartAfterCommand;
    }
    set({ openProjects: new Map(openProjects) });
    logRestartAfterState('command', workspace.projectId, tab);
    saveTabs(workspace.projectId, workspace.tabs);
  },

  setTabRestartAfterPaused: (projectId, tabId, paused) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;
    const tab = workspace.tabs.get(tabId);
    if (!tab || getRestartAfterTriggerIds(tab).length === 0) return;
    if (paused) {
      tab.restartAfterPaused = true;
    } else {
      delete tab.restartAfterPaused;
    }
    set({ openProjects: new Map(openProjects) });
    logRestartAfterState('paused', workspace.projectId, tab);
    saveTabs(workspace.projectId, workspace.tabs);
  },

  consumeRestartAfterTriggerIdle: (triggerTabId, naturalEnd) => {
    // Abnormal idle (error, abort, manual stop, unknown catch-up) is only a
    // liveness update. Keep the persistent subscription armed for the next
    // successful turn instead of consuming it on the failure.
    if (!naturalEnd) return [];
    const { openProjects } = get();
    const restartTargets: Array<{ tabId: string; command?: string }> = [];
    let changed = false;
    const changedProjectIds = new Set<string>();
    for (const [, workspace] of openProjects) {
      for (const tab of workspace.tabs.values()) {
        if (!getRestartAfterTriggerIds(tab).includes(triggerTabId)) continue;
        if (tab.restartAfterPaused) continue;
        restartTargets.push({ tabId: tab.id, command: tab.restartAfterCommand });
        if (tab.restartAfterArmed || tab.restartAfterPersistent) {
          delete tab.restartAfterArmed;
          delete tab.restartAfterPersistent;
          changed = true;
          changedProjectIds.add(workspace.projectId);
        }
      }
    }
    if (changed) {
      set({ openProjects: new Map(openProjects) });
      for (const projectId of changedProjectIds) {
        const workspace = openProjects.get(projectId);
        if (workspace) saveTabs(workspace.projectId, workspace.tabs);
      }
    }
    return restartTargets;
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
        const codexSess = tab.codexSessionId ? tab.codexSessionId.slice(0, 8) : 'null';
        const callerLine = (new Error().stack || '').split('\n').slice(2, 5).join(' | ');
        console.warn('[Store:setTabCommandType] tab=' + tabId.slice(-8) + ' ' + prev + ' → ' + commandType + ' | claude=' + claudeSess + ' gemini=' + geminiSess + ' codex=' + codexSess + ' | caller=' + callerLine);
        const hasClaudeBinding = !!tab.claudeSessionId;
        const hasCodexBinding = !!tab.codexSessionId;
        const requestedPtyOwner = commandType === 'claude' || commandType === 'codex'
          ? commandType
          : null;
        const boundPtyOwner = hasClaudeBinding !== hasCodexBinding
          ? (hasClaudeBinding ? 'claude' : 'codex')
          : null;
        if (
          requestedPtyOwner
          && (
            (hasClaudeBinding && hasCodexBinding)
            || (boundPtyOwner && boundPtyOwner !== requestedPtyOwner)
          )
        ) {
          console.error('[Store:setTabCommandType] rejected owner mutation tab=' + tabId.slice(-8)
            + ' requested=' + requestedPtyOwner
            + ' bound=' + (boundPtyOwner || 'ambiguous')
            + ' action=keep-committed-owner');
          return;
        }
        if ((commandType === 'claude' || commandType === 'codex') && !aiLaunchSnapshots.has(tabId)) {
          const hasSessionForLaunch = commandType === 'claude' ? !!tab.claudeSessionId : !!tab.codexSessionId;
          if (!hasSessionForLaunch) {
            aiLaunchSnapshots.set(tabId, {
              sessionType: commandType,
              commandType: tab.commandType,
              name: tab.name,
              color: tab.color,
              colorSetManually: tab.colorSetManually,
              nameSetManually: tab.nameSetManually,
              claudeSessionId: tab.claudeSessionId,
              geminiSessionId: tab.geminiSessionId,
              codexSessionId: tab.codexSessionId,
              wasInterrupted: tab.wasInterrupted,
              overlayDismissed: tab.overlayDismissed,
              at: Date.now(),
            });
            console.warn('[Store:AiLaunchSnapshot] capture tab=' + tabId.slice(-8) + ' type=' + commandType + ' prevCommand=' + (tab.commandType || 'null') + ' name=' + JSON.stringify(tab.name) + ' color=' + (tab.color || 'null') + ' manualName=' + (tab.nameSetManually === true));
          }
        }

        // Only set commandType and rename if not already set (first run only)
        const isFirstRun = !tab.commandType;
        tab.commandType = commandType;

        // Auto-rename on first run (skip if user renamed tab manually)
        if (isFirstRun && !tab.nameSetManually && !isPendingAiForkLaunch(commandType, tab.pendingAction)) {
          const existingNames = Array.from(workspace.tabs.values()).map(t => t.name);
          let baseName = '';

          if (commandType === 'claude') {
            baseName = 'claude';
          } else if (commandType === 'gemini') {
            baseName = 'gemini';
          } else if (commandType === 'codex') {
            baseName = 'codex';
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
          } else if (commandType === 'codex') {
            log.tabs('Setting color to codex');
            tab.color = 'codex';
          } else if (commandType === 'devServer') {
            log.tabs('Setting color to green');
            tab.color = 'green';
          }
        } else {
          log.tabs('Skipping auto-color (manually set or already colored)');
        }

        set({ openProjects: new Map(openProjects) });
        saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'tab-command-type');
        break;
      }
    }
  },

  getAiLaunchSnapshot: (tabId) => {
    return aiLaunchSnapshots.get(tabId) || null;
  },

  markAiLaunchAutoTitle: (tabId, toolType) => {
    setAutoTabTitleIntent(tabId, toolType, 'fresh');
    const snap = aiLaunchSnapshots.get(tabId);
    if (!snap || snap.sessionType !== toolType) {
      console.warn('[Store:AiLaunchSnapshot] auto-title-skip tab=' + tabId.slice(-8) + ' type=' + toolType + ' reason=no-matching-snapshot');
      return;
    }
    snap.autoTitleEligible = true;
    snap.autoTitleMode = 'fresh';
    delete snap.autoTitleSourceSessionId;
    console.warn('[Store:AiLaunchSnapshot] auto-title-eligible tab=' + tabId.slice(-8) + ' type=' + toolType + ' mode=fresh');
  },

  markAiForkAutoTitle: (tabId, toolType, sourceSessionId) => {
    setAutoTabTitleIntent(tabId, toolType, 'fork', sourceSessionId);
    const snap = aiLaunchSnapshots.get(tabId);
    if (!snap || snap.sessionType !== toolType) {
      console.warn('[Store:AiLaunchSnapshot] fork-auto-title-skip tab=' + tabId.slice(-8) + ' type=' + toolType + ' reason=no-matching-snapshot');
      return;
    }
    snap.autoTitleEligible = true;
    snap.autoTitleMode = 'fork';
    snap.autoTitleSourceSessionId = sourceSessionId;
    console.warn(
      '[Store:AiLaunchSnapshot] auto-title-eligible tab=' + tabId.slice(-8) +
      ' type=' + toolType +
      ' mode=fork source=' + sourceSessionId.slice(0, 8)
    );
  },

  clearAiLaunchSnapshot: (tabId, reason = 'materialized') => {
    const snap = aiLaunchSnapshots.get(tabId);
    if (!snap) return;
    aiLaunchSnapshots.delete(tabId);
    console.warn('[Store:AiLaunchSnapshot] clear tab=' + tabId.slice(-8) + ' type=' + snap.sessionType + ' reason=' + reason);
  },

  restoreRejectedAiLaunchSnapshot: (tabId, toolType, reason = 'launch-rejected') => {
    const snap = aiLaunchSnapshots.get(tabId);
    if (!snap || snap.sessionType !== toolType) return false;

    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab || tab.commandType !== toolType) return false;
      const currentAttemptSession = toolType === 'claude'
        ? tab.claudeSessionId
        : tab.codexSessionId;
      const snapshotAttemptSession = toolType === 'claude'
        ? snap.claudeSessionId
        : snap.codexSessionId;
      if ((currentAttemptSession || null) !== (snapshotAttemptSession || null)) {
        console.warn('[Store:AiLaunchSnapshot] stale rejection ignored tab=' + tabId.slice(-8)
          + ' attempted=' + toolType
          + ' reason=newer-session-materialized');
        return false;
      }

      // A rejected main-side launch cannot own this tab. Restore the exact
      // pre-launch presentation/binding transaction instead of leaving a
      // provider label that no running process ever accepted.
      if (snap.commandType) tab.commandType = snap.commandType;
      else delete tab.commandType;
      tab.name = snap.name;
      tab.color = snap.color;
      tab.colorSetManually = snap.colorSetManually;
      tab.nameSetManually = snap.nameSetManually;
      tab.claudeSessionId = snap.claudeSessionId;
      tab.geminiSessionId = snap.geminiSessionId;
      tab.codexSessionId = snap.codexSessionId;
      tab.wasInterrupted = snap.wasInterrupted;
      tab.overlayDismissed = snap.overlayDismissed;

      aiLaunchSnapshots.delete(tabId);
      clearPendingAutoTabTitle(tabId, 'launch-rejected');
      autoTabTitleIntents.delete(tabId);
      console.warn('[Store:AiLaunchSnapshot] restore tab=' + tabId.slice(-8)
        + ' attempted=' + toolType
        + ' command=' + (tab.commandType || 'none')
        + ' reason=' + reason);
      set({ openProjects: new Map(openProjects) });
      saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'ai-launch-rejected');
      return true;
    }

    aiLaunchSnapshots.delete(tabId);
    autoTabTitleIntents.delete(tabId);
    return false;
  },

  discardUnmaterializedAiLaunchSession: async (tabId, reason) => {
    const snap = aiLaunchSnapshots.get(tabId);
    if (!snap) {
      console.warn('[Store:AiLaunchDiscard] skip tab=' + tabId.slice(-8) + ' reason=' + reason + ' no-snapshot');
      return false;
    }

    const { openProjects } = get();
    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;

      // A launched AI runtime remains a Claude/Codex tab even if the provider
      // never materialized a resumable conversation. Clear only the stale
      // session artifact; do not restore the old bash identity/name/color.
      if (!tab.commandType) tab.commandType = snap.sessionType;
      if (snap.sessionType === 'claude') {
        delete tab.claudeSessionId;
      } else if (snap.sessionType === 'codex') {
        const expectedSessionId = tab.codexSessionId || null;
        try {
          await commitCodexSessionId(projectId, tabId, null, expectedSessionId, 'discard-unmaterialized');
        } catch (error) {
          console.warn('[Store:AiLaunchDiscard] Codex clear rejected tab=' + tabId.slice(-8)
            + ' reason=' + reason
            + ' error=' + (error instanceof Error ? error.message : String(error))
            + ' action=keep-binding');
          return false;
        }
        delete tab.codexSessionId;
      }

      clearPendingAutoTabTitle(tabId, 'ai-launch-discard');
      autoTabTitleIntents.delete(tabId);
      tab.wasInterrupted = false;
      tab.overlayDismissed = false;

      aiLaunchSnapshots.delete(tabId);
      console.warn('[Store:AiLaunchDiscard] tab=' + tabId.slice(-8) + ' type=' + snap.sessionType + ' reason=' + reason + ' keepCommand=' + (tab.commandType || 'null') + ' clearSessionArtifact=true');

      set({ openProjects: new Map(openProjects) });
      const saveResult = await saveTabs(workspace.projectId, workspace.tabs);
      if (saveResult?.success !== false) {
        notifyProjectLayoutChanged(workspace.projectId, 'ai-launch-unmaterialized');
      }
      return true;
    }

    console.warn('[Store:AiLaunchDiscard] skip tab=' + tabId.slice(-8) + ' reason=' + reason + ' tab-not-found');
    aiLaunchSnapshots.delete(tabId);
    autoTabTitleIntents.delete(tabId);
    return false;
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

    if (!workspace || zone !== 'main') return;

    const orderedSet = new Set(orderedIds);
    const newTabs = new Map<string, Tab>();
    for (const id of orderedIds) {
      const tab = workspace.tabs.get(id);
      if (tab) newTabs.set(id, tab);
    }
    // Preserve non-rendered children and any concurrently-created tabs. A
    // reorder projection only owns the IDs it explicitly lists.
    for (const [id, tab] of workspace.tabs) {
      if (!orderedSet.has(id)) newTabs.set(id, tab);
    }

    workspace.tabs = newTabs;
    set({ openProjects: new Map(openProjects) });
    saveTabs(workspace.projectId, workspace.tabs);
  },

  moveTabToProject: async (sourceProjectId, tabId, targetProjectId) => {
    if (sourceProjectId === targetProjectId) return false;

    const { openProjects } = get();
    const sourceWorkspace = openProjects.get(sourceProjectId);
    const targetWorkspace = openProjects.get(targetProjectId);

    if (!sourceWorkspace || !targetWorkspace) return false;

    const tab = sourceWorkspace.tabs.get(tabId);
    if (!tab || targetWorkspace.tabs.has(tabId)) return false;

    // A newly-created tab becomes visible before its background save promise
    // necessarily settles.  The main-side transfer deliberately requires an
    // existing source row, so establish that durable precondition here instead
    // of relying on IPC ordering between an earlier invoke() and this sendSync.
    const sourcePersisted = await saveTabs(sourceWorkspace.projectId, sourceWorkspace.tabs);
    if (!isDurableSaveTabsAck(sourcePersisted)) {
      console.warn('[moveTabToProject] source snapshot not durable tab=' + dndShortId(tabId)
        + ' error=' + (sourcePersisted?.error || 'save_failed'));
      return false;
    }

    let transfer: any;
    try {
      transfer = ipcRenderer.sendSync('terminal:transfer-project-ownership-sync', {
        sourceProjectId,
        targetProjectId,
        tabIds: [tabId],
      });
    } catch (error) {
      console.warn('[moveTabToProject] ownership commit failed tab=' + dndShortId(tabId)
        + ' error=' + (error instanceof Error ? error.message : String(error)));
      return false;
    }
    if (transfer?.success !== true) {
      console.warn('[moveTabToProject] ownership commit rejected tab=' + dndShortId(tabId)
        + ' error=' + (transfer?.error || 'unknown'));
      return false;
    }

    // Remove from source project
    sourceWorkspace.tabs.delete(tabId);
    for (const candidate of sourceWorkspace.tabs.values()) {
      if (candidate.visualParentTabId === tabId) candidate.visualParentTabId = undefined;
    }

    // If this was the active tab in source, switch to another
    if (sourceWorkspace.activeTabId === tabId) {
      const remainingTabs = Array.from(sourceWorkspace.tabs.keys());
      sourceWorkspace.activeTabId = remainingTabs.length > 0 ? remainingTabs[0] : null;
    }
    sourceWorkspace.selectedTabIds = sourceWorkspace.selectedTabIds.filter(id => id !== tabId);
    let sourceGroupsChanged = false;
    sourceWorkspace.tabGroups = sourceWorkspace.tabGroups.map((group) => {
      if (group.anchorTabId !== tabId) return group;
      sourceGroupsChanged = true;
      return { ...group, anchorTabId: undefined };
    });

    // Add to target project (as main tab, not utility)
    tab.isUtility = false;
    tab.groupId = undefined;
    tab.visualParentTabId = undefined;
    targetWorkspace.tabs.set(tabId, tab);

    // Make it active in target project
    targetWorkspace.activeTabId = tabId;

    // Update state (+ keep the cross-project MRU/split pointing at the new owner)
    const movedTab = (id: string) => id === tabId;
    set({
      openProjects: new Map(openProjects),
      globalTabMru: get().globalTabMru.map((e) => e.tabId === tabId ? { ...e, projectId: targetProjectId } : e),
      splitPanes: reprojectPaneTabs(get().splitPanes, movedTab, targetProjectId),
      centerStrips: reprojectCenterStripOwners(get().centerStrips, movedTab, targetProjectId),
      spaces: reprojectTabsInSpaces(get().spaces, movedTab, targetProjectId, reprojectPaneTabs),
      activeSpaceTab: get().activeSpaceTab?.tabId === tabId
        ? { projectId: targetProjectId, tabId }
        : get().activeSpaceTab,
    });

    // Save both projects
    saveTabs(
      sourceWorkspace.projectId,
      sourceWorkspace.tabs,
      true,
      Array.from(sourceWorkspace.tabs.keys()),
    );
    saveTabs(targetWorkspace.projectId, targetWorkspace.tabs);
    if (sourceGroupsChanged) saveTabGroups(sourceWorkspace.projectId, sourceWorkspace.tabGroups);

    log.tabs(`[moveTabToProject] Moved tab ${tabId} from ${sourceProjectId} to ${targetProjectId}`);
    return true;
  },

  moveTabsToProject: async (sourceProjectId, tabIds, targetProjectId) => {
    if (sourceProjectId === targetProjectId || tabIds.length === 0) return false;

    const { openProjects } = get();
    const src = openProjects.get(sourceProjectId);
    const tgt = openProjects.get(targetProjectId);
    if (!src || !tgt) return false;

    const movingIds = Array.from(new Set(tabIds.filter((tabId) => src.tabs.has(tabId))));
    if (movingIds.length === 0 || movingIds.some((tabId) => tgt.tabs.has(tabId))) return false;

    // Same create→immediate-drag edge as the single-tab path: transfer owns
    // rows, not an optimistic renderer snapshot, so prove every source row is
    // durable before asking main to move ownership atomically.
    const sourcePersisted = await saveTabs(src.projectId, src.tabs);
    if (!isDurableSaveTabsAck(sourcePersisted)) {
      console.warn('[moveTabsToProject] source snapshot not durable tabs=' + movingIds.length
        + ' error=' + (sourcePersisted?.error || 'save_failed'));
      return false;
    }
    let transfer: any;
    try {
      transfer = ipcRenderer.sendSync('terminal:transfer-project-ownership-sync', {
        sourceProjectId,
        targetProjectId,
        tabIds: movingIds,
      });
    } catch (error) {
      console.warn('[moveTabsToProject] ownership commit failed tabs=' + movingIds.length
        + ' error=' + (error instanceof Error ? error.message : String(error)));
      return false;
    }
    if (transfer?.success !== true) {
      console.warn('[moveTabsToProject] ownership commit rejected tabs=' + movingIds.length
        + ' error=' + (transfer?.error || 'unknown'));
      return false;
    }

    const movingSet = new Set(movingIds);
    let lastId: string | null = null;
    for (const tabId of movingIds) {
      const tab = src.tabs.get(tabId);
      if (!tab) continue;
      src.tabs.delete(tabId);
      tab.isUtility = false;
      tab.groupId = undefined;
      if (!tab.visualParentTabId || !movingSet.has(tab.visualParentTabId)) {
        tab.visualParentTabId = undefined;
      }
      tgt.tabs.set(tabId, tab);
      lastId = tabId;
    }
    for (const candidate of src.tabs.values()) {
      if (candidate.visualParentTabId && !src.tabs.has(candidate.visualParentTabId)) {
        candidate.visualParentTabId = undefined;
      }
    }

    // Fix active tab in source
    if (src.activeTabId && !src.tabs.has(src.activeTabId)) {
      const remaining = Array.from(src.tabs.keys());
      src.activeTabId = remaining[0] || null;
    }
    // Clear selection in source
    src.selectedTabIds = src.selectedTabIds.filter(id => src.tabs.has(id));
    let sourceGroupsChanged = false;
    src.tabGroups = src.tabGroups.map((group) => {
      if (!group.anchorTabId || !movingSet.has(group.anchorTabId)) return group;
      sourceGroupsChanged = true;
      return { ...group, anchorTabId: undefined };
    });
    // Active in target
    if (lastId) tgt.activeTabId = lastId;

    const movedTab = (id: string) => movingSet.has(id);
    set({
      openProjects: new Map(openProjects),
      globalTabMru: get().globalTabMru.map((e) => movingSet.has(e.tabId) ? { ...e, projectId: targetProjectId } : e),
      splitPanes: reprojectPaneTabs(get().splitPanes, movedTab, targetProjectId),
      centerStrips: reprojectCenterStripOwners(get().centerStrips, movedTab, targetProjectId),
      spaces: reprojectTabsInSpaces(get().spaces, movedTab, targetProjectId, reprojectPaneTabs),
      activeSpaceTab: get().activeSpaceTab?.tabId && movingSet.has(get().activeSpaceTab!.tabId)
        ? { projectId: targetProjectId, tabId: get().activeSpaceTab!.tabId }
        : get().activeSpaceTab,
    });
    saveTabs(
      src.projectId,
      src.tabs,
      true,
      Array.from(src.tabs.keys()),
    ); // forceCleanup: intentional batch move
    saveTabs(tgt.projectId, tgt.tabs);
    if (sourceGroupsChanged) saveTabGroups(src.projectId, src.tabGroups);

    log.tabs(`[moveTabsToProject] Moved ${movingIds.length} tabs from ${sourceProjectId} to ${targetProjectId}`);
    return true;
  },

  moveTabGroupToProject: async (sourceProjectId, groupId, targetProjectId) => {
    if (sourceProjectId === targetProjectId) return false;

    const { openProjects } = get();
    const source = openProjects.get(sourceProjectId);
    const target = openProjects.get(targetProjectId);
    if (!source || !target) return false;

    const group = source.tabGroups.find((candidate) => candidate.id === groupId);
    if (!group) return false;
    const movingEntries = Array.from(source.tabs.entries()).filter(([, tab]) => tab.groupId === groupId);
    const movingIds = movingEntries.map(([tabId]) => tabId);
    if (movingIds.some((tabId) => target.tabs.has(tabId))) return false;

    let targetGroupId = `${targetProjectId}-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    while (target.tabGroups.some((candidate) => candidate.id === targetGroupId)) {
      targetGroupId = `${targetProjectId}-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    }

    const sourceTabsAck = await saveTabs(source.projectId, source.tabs);
    const targetTabsAck = await saveTabs(target.projectId, target.tabs);
    const sourceGroupsAck = await saveTabGroups(source.projectId, source.tabGroups);
    const targetGroupsAck = await saveTabGroups(target.projectId, target.tabGroups);
    if (
      !isDurableSaveTabsAck(sourceTabsAck)
      || !isDurableSaveTabsAck(targetTabsAck)
      || sourceGroupsAck?.success !== true
      || targetGroupsAck?.success !== true
    ) {
      console.warn('[moveTabGroupToProject] durable snapshot failed group=' + dndShortId(groupId));
      return false;
    }

    // The durable preflight can itself trigger a project-layout broadcast.
    // Re-read Zustand after those awaits so a late reload cannot make this
    // transaction apply to stale workspace objects.
    const currentOpenProjects = get().openProjects;
    const currentSource = currentOpenProjects.get(sourceProjectId);
    const currentTarget = currentOpenProjects.get(targetProjectId);
    const currentGroup = currentSource?.tabGroups.find((candidate) => candidate.id === groupId);
    const currentMovingEntries = currentSource
      ? Array.from(currentSource.tabs.entries()).filter(([, tab]) => tab.groupId === groupId)
      : [];
    const currentMovingIds = currentMovingEntries.map(([tabId]) => tabId);
    const expectedMovingSet = new Set(movingIds);
    if (
      !currentSource
      || !currentTarget
      || !currentGroup
      || currentMovingIds.length !== movingIds.length
      || currentMovingIds.some((tabId) => !expectedMovingSet.has(tabId))
      || currentMovingIds.some((tabId) => currentTarget.tabs.has(tabId))
      || currentTarget.tabGroups.some((candidate) => candidate.id === targetGroupId)
    ) {
      console.warn('[moveTabGroupToProject] state changed during preflight group=' + dndShortId(groupId));
      return false;
    }

    let transfer: any;
    try {
      transfer = ipcRenderer.sendSync('terminal:transfer-tab-group-ownership-sync', {
        sourceProjectId,
        targetProjectId,
        groupId,
        targetGroupId,
        tabIds: currentMovingIds,
      });
    } catch (error) {
      console.warn('[moveTabGroupToProject] ownership commit failed group=' + dndShortId(groupId)
        + ' error=' + (error instanceof Error ? error.message : String(error)));
      return false;
    }
    if (transfer?.success !== true) {
      console.warn('[moveTabGroupToProject] ownership commit rejected group=' + dndShortId(groupId)
        + ' error=' + (transfer?.error || 'unknown'));
      return false;
    }

    const movingSet = new Set(currentMovingIds);
    for (const [tabId, tab] of currentMovingEntries) {
      currentSource.tabs.delete(tabId);
      tab.isUtility = false;
      tab.groupId = targetGroupId;
      if (!tab.visualParentTabId || !movingSet.has(tab.visualParentTabId)) {
        tab.visualParentTabId = undefined;
      }
      currentTarget.tabs.set(tabId, tab);
    }
    for (const tab of currentSource.tabs.values()) {
      if (tab.visualParentTabId && movingSet.has(tab.visualParentTabId)) {
        tab.visualParentTabId = undefined;
      }
    }

    currentSource.tabGroups = currentSource.tabGroups.filter((candidate) => candidate.id !== groupId);
    const { anchorTabId: _sourceAnchor, ...groupWithoutAnchor } = currentGroup;
    currentTarget.tabGroups = [...currentTarget.tabGroups, { ...groupWithoutAnchor, id: targetGroupId }];

    const movedActiveTabId = currentSource.activeTabId && movingSet.has(currentSource.activeTabId)
      ? currentSource.activeTabId
      : null;
    if (movedActiveTabId) currentSource.activeTabId = Array.from(currentSource.tabs.keys())[0] || null;
    currentSource.selectedTabIds = currentSource.selectedTabIds.filter((tabId) => !movingSet.has(tabId));
    if (currentSource.activeGroupId === groupId) currentSource.activeGroupId = null;

    const preferredTargetTab = movedActiveTabId || currentMovingIds[0] || null;
    if (preferredTargetTab) currentTarget.activeTabId = preferredTargetTab;
    currentTarget.activeGroupId = targetGroupId;
    currentTarget.selectedTabIds = [];

    const movedTab = (id: string) => movingSet.has(id);
    set({
      openProjects: new Map(currentOpenProjects),
      globalTabMru: get().globalTabMru.map((e) => movingSet.has(e.tabId) ? { ...e, projectId: targetProjectId } : e),
      splitPanes: reprojectPaneTabs(get().splitPanes, movedTab, targetProjectId),
      centerStrips: reprojectCenterStripOwners(get().centerStrips, movedTab, targetProjectId),
      spaces: reprojectTabsInSpaces(get().spaces, movedTab, targetProjectId, reprojectPaneTabs),
      activeSpaceTab: get().activeSpaceTab?.tabId && movingSet.has(get().activeSpaceTab!.tabId)
        ? { projectId: targetProjectId, tabId: get().activeSpaceTab!.tabId }
        : get().activeSpaceTab,
    });
    notifyProjectLayoutChanged(sourceProjectId, 'tab-group-project-transfer');
    notifyProjectLayoutChanged(targetProjectId, 'tab-group-project-transfer');
    log.tabs(
      `[moveTabGroupToProject] Moved group ${groupId} (${currentMovingIds.length} tabs)`
      + ` from ${sourceProjectId} to ${targetProjectId}`
    );
    return true;
  },

  createTabGroup: (projectId, name) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return '';

    const existingNames = workspace.tabGroups.map(g => g.name);
    const groupName = name || getNextAvailableName('group', existingNames);
    const groupId = `${projectId}-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const group: TabGroup = { id: groupId, name: groupName, createdAt: Date.now() };

    workspace.tabGroups = [...workspace.tabGroups, group];
    set({ openProjects: new Map(openProjects) });
    saveTabGroups(projectId, workspace.tabGroups);
    return groupId;
  },

  renameTabGroup: (projectId, groupId, name) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    const next = name.trim();
    if (!next) return;
    workspace.tabGroups = workspace.tabGroups.map(group =>
      group.id === groupId ? { ...group, name: next } : group
    );
    set({ openProjects: new Map(openProjects) });
    saveTabGroups(projectId, workspace.tabGroups);
  },

  toggleTabGroupCollapsed: (projectId, groupId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) {
      console.warn('[TabGroupCollapse:store] phase=skip reason=no-workspace project=' + dndShortId(projectId) + ' group=' + dndShortId(groupId));
      return;
    }

    const targetGroup = workspace.tabGroups.find(group => group.id === groupId);
    if (!targetGroup) {
      console.warn('[TabGroupCollapse:store] phase=skip reason=no-group project=' + dndShortId(projectId) + ' group=' + dndShortId(groupId));
      return;
    }

    const beforeCollapsed = !!targetGroup.collapsed;
    const memberIds = Array.from(workspace.tabs.values())
      .filter(tab => tab.groupId === groupId)
      .map(tab => tab.id);
    const start = performance.now();
    console.warn(
      '[TabGroupCollapse:store]' +
      ' phase=toggle' +
      ` project=${dndShortId(projectId)}` +
      ` group=${dndShortId(groupId)}` +
      ` from=${beforeCollapsed ? 1 : 0}` +
      ` to=${beforeCollapsed ? 0 : 1}` +
      ` members=${memberIds.length}:${summarizeDndIds(memberIds)}` +
      ` activeGroup=${dndShortValue(workspace.activeGroupId)}` +
      ` selected=${workspace.selectedTabIds?.length || 0}` +
      ` groupsBefore=${summarizeDndGroups(workspace.tabGroups)}` +
      ` t=${Math.round(start)}`
    );

    workspace.tabGroups = workspace.tabGroups.map(group =>
      group.id === groupId ? { ...group, collapsed: !group.collapsed } : group
    );
    set({ openProjects: new Map(openProjects) });
    console.warn(
      '[TabGroupCollapse:store]' +
      ' phase=set' +
      ` project=${dndShortId(projectId)}` +
      ` group=${dndShortId(groupId)}` +
      ` durMs=${Math.round(performance.now() - start)}` +
      ` groupsAfter=${summarizeDndGroups(workspace.tabGroups)}`
    );
    saveTabGroups(projectId, workspace.tabGroups);
  },

  setTabGroupColor: (projectId, groupId, color) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    workspace.tabGroups = workspace.tabGroups.map(group =>
      group.id === groupId ? { ...group, color } : group
    );
    set({ openProjects: new Map(openProjects) });
    saveTabGroups(projectId, workspace.tabGroups);
  },

  setTabGroupSessionStatus: (projectId, groupId, status) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    workspace.tabGroups = workspace.tabGroups.map(group =>
      group.id === groupId ? { ...group, sessionStatus: status || undefined } : group
    );
    set({ openProjects: new Map(openProjects) });
    saveTabGroups(projectId, workspace.tabGroups);
  },

  deleteTabGroup: (projectId, groupId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    workspace.tabGroups = workspace.tabGroups.filter(group => group.id !== groupId);
    if (workspace.activeGroupId === groupId) workspace.activeGroupId = null;
    let touchedTabs = false;
    for (const tab of workspace.tabs.values()) {
      if (tab.groupId !== groupId) continue;
      tab.groupId = undefined;
      touchedTabs = true;
    }

    set({ openProjects: new Map(openProjects) });
    saveTabGroups(projectId, workspace.tabGroups);
    if (touchedTabs) saveTabs(workspace.projectId, workspace.tabs);
  },

  setTabPendingOperation: (projectId, tabId, label) => {
    const { openProjects } = get();
    const tab = openProjects.get(projectId)?.tabs.get(tabId);
    if (!tab) return;
    const next = label || undefined;
    if (tab.pendingOperation === next) return;
    tab.pendingOperation = next;
    // Не через saveTabs: подпись живёт минуты и не должна пережить перезапуск —
    // восстановленное «делается форк» было бы ложью о работе, которой нет.
    set({ openProjects: new Map(openProjects) });
  },

  setTabVisualParent: (projectId, tabId, parentTabId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    const tab = workspace.tabs.get(tabId);
    if (!tab || tab.parentTabId) return;

    const nextParentId = parentTabId || undefined;
    if (!nextParentId) {
      tab.visualParentTabId = undefined;
      set({ openProjects: new Map(openProjects) });
      saveTabs(workspace.projectId, workspace.tabs);
      return;
    }

    if (nextParentId === tabId) return;
    const parent = workspace.tabs.get(nextParentId);
    if (!parent || parent.parentTabId) return;

    let cursor: string | undefined = nextParentId;
    const seen = new Set<string>([tabId]);
    while (cursor) {
      if (seen.has(cursor)) return;
      seen.add(cursor);
      cursor = workspace.tabs.get(cursor)?.visualParentTabId;
    }

    tab.visualParentTabId = nextParentId;
    // Keep visual parent/child inside one existing tab group. Cross-group
    // nesting creates ambiguous rendering because groups already own a body.
    tab.groupId = parent.groupId;
    set({ openProjects: new Map(openProjects) });
    saveTabs(workspace.projectId, workspace.tabs);
  },

  applyTabLayout: (projectId, orderedIds, groupAssignments = {}, visualParentAssignments = {}, groupAnchorAssignments = {}) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    const existing = workspace.tabs;
    const previousMainOrder = Array.from(existing.values())
      .filter(tab => !tab.parentTabId)
      .map(tab => tab.id);
    const previousMembersByGroup = new Map<string, string[]>();
    for (const tab of existing.values()) {
      tab.isUtility = false;
      if (tab.parentTabId || !tab.groupId) continue;
      const members = previousMembersByGroup.get(tab.groupId) || [];
      members.push(tab.id);
      previousMembersByGroup.set(tab.groupId, members);
    }
    const orderedSet = new Set(orderedIds);
    const nextTabs = new Map<string, Tab>();

    for (const id of orderedIds) {
      const tab = existing.get(id);
      if (!tab) continue;
      if (Object.prototype.hasOwnProperty.call(groupAssignments, id)) {
        const nextGroup = groupAssignments[id];
        tab.groupId = nextGroup || undefined;
      }
      if (Object.prototype.hasOwnProperty.call(visualParentAssignments, id)) {
        tab.visualParentTabId = visualParentAssignments[id] || undefined;
      }
      nextTabs.set(id, tab);
    }

    for (const [id, tab] of existing) {
      if (orderedSet.has(id)) continue;
      if (Object.prototype.hasOwnProperty.call(groupAssignments, id)) {
        const nextGroup = groupAssignments[id];
        tab.groupId = nextGroup || undefined;
      }
      if (Object.prototype.hasOwnProperty.call(visualParentAssignments, id)) {
        tab.visualParentTabId = visualParentAssignments[id] || undefined;
      }
      nextTabs.set(id, tab);
    }

    workspace.tabs = nextTabs;
    for (const tab of workspace.tabs.values()) {
      const parentId = tab.visualParentTabId;
      if (!parentId) continue;
      const parent = workspace.tabs.get(parentId);
      if (!parent || parent === tab || parent.parentTabId || parent.groupId !== tab.groupId) {
        tab.visualParentTabId = undefined;
        continue;
      }
      const seen = new Set<string>([tab.id]);
      let cursor: Tab | undefined = parent;
      while (cursor?.visualParentTabId) {
        if (seen.has(cursor.id)) {
          tab.visualParentTabId = undefined;
          break;
        }
        seen.add(cursor.id);
        cursor = workspace.tabs.get(cursor.visualParentTabId);
      }
    }
    const nextMembersByGroup = new Map<string, string[]>();
    for (const tab of workspace.tabs.values()) {
      if (tab.parentTabId || !tab.groupId) continue;
      const members = nextMembersByGroup.get(tab.groupId) || [];
      members.push(tab.id);
      nextMembersByGroup.set(tab.groupId, members);
    }
    const resolvedGroupAnchorAssignments: Record<string, string | null | undefined> = { ...groupAnchorAssignments };
    for (const group of workspace.tabGroups) {
      if (Object.prototype.hasOwnProperty.call(resolvedGroupAnchorAssignments, group.id)) continue;
      const previousMembers = previousMembersByGroup.get(group.id) || [];
      if (previousMembers.length === 0) continue;
      const nextMembers = nextMembersByGroup.get(group.id) || [];
      if (nextMembers.length > 0) continue;

      const previousMemberSet = new Set(previousMembers);
      const previousIndexes = previousMembers
        .map(id => previousMainOrder.indexOf(id))
        .filter(index => index >= 0);
      if (previousIndexes.length === 0) continue;
      const lastPreviousIndex = Math.max(...previousIndexes);
      const anchorTabId = previousMainOrder
        .slice(lastPreviousIndex + 1)
        .find(id => !previousMemberSet.has(id) && workspace.tabs.has(id));
      resolvedGroupAnchorAssignments[group.id] = anchorTabId || null;
    }
    let touchedGroups = false;
    if (Object.keys(resolvedGroupAnchorAssignments).length > 0) {
      const mainTabIds = new Set(
        Array.from(workspace.tabs.values())
          .filter(tab => !tab.parentTabId)
          .map(tab => tab.id)
      );
      workspace.tabGroups = workspace.tabGroups.map(group => {
        if (!Object.prototype.hasOwnProperty.call(resolvedGroupAnchorAssignments, group.id)) return group;
        const requestedAnchor = resolvedGroupAnchorAssignments[group.id];
        const anchorTabId = requestedAnchor && mainTabIds.has(requestedAnchor)
          ? requestedAnchor
          : undefined;
        if (group.anchorTabId === anchorTabId) return group;
        touchedGroups = true;
        return { ...group, anchorTabId };
      });
    }
    const nextMainOrder = Array.from(workspace.tabs.values())
      .filter(tab => !tab.parentTabId)
      .map(tab => tab.id);
    console.log(
      `[TabDnd:apply] project=${dndShortId(projectId)}` +
      ` prev=${summarizeDndIds(previousMainOrder)}` +
      ` requested=${summarizeDndIds(orderedIds)}` +
      ` next=${summarizeDndIds(nextMainOrder)}` +
      ` groupAssign=${summarizeDndAssignments(groupAssignments)}` +
      ` visual=${summarizeDndAssignments(visualParentAssignments)}` +
      ` anchorsReq=${summarizeDndAssignments(groupAnchorAssignments)}` +
      ` anchorsResolved=${summarizeDndAssignments(resolvedGroupAnchorAssignments)}` +
      ` prevMembers=${summarizeDndGroupMembers(previousMembersByGroup)}` +
      ` nextMembers=${summarizeDndGroupMembers(nextMembersByGroup)}` +
      ` groups=${summarizeDndGroups(workspace.tabGroups)}` +
      ` touchedGroups=${touchedGroups ? 1 : 0}`
    );
    set({ openProjects: new Map(openProjects) });
    saveTabs(workspace.projectId, workspace.tabs);
    if (touchedGroups) saveTabGroups(workspace.projectId, workspace.tabGroups);
    notifyProjectLayoutChanged(workspace.projectId, 'tab-layout');
  },

  updateTabCwd: async (projectId, tabId, newCwd) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return false;
    const tab = workspace.tabs.get(tabId);
    if (!tab) return false;
    if (tab.cwd !== newCwd) {
      tab.cwd = newCwd;
      set({ openProjects: new Map(openProjects) });
    }
    const result = await saveTabs(workspace.projectId, workspace.tabs);
    return result?.success !== false;
  },

  rewriteFilePathReferences: (oldPath, newPath) => {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const rewrite = (value?: string | null) => {
      if (!value || (value !== oldPath && !value.startsWith(oldPath + '/'))) return value;
      return newPath + value.slice(oldPath.length);
    };
    const { openProjects } = get();
    const nextOpenProjects = new Map(openProjects);
    let changed = false;

    for (const [projectId, workspace] of openProjects) {
      let tabsChanged = false;
      const nextTabs = new Map(workspace.tabs);
      for (const [tabId, tab] of workspace.tabs) {
        if (tab.tabType !== 'file') continue;
        const nextFilePath = rewrite(tab.filePath);
        if (nextFilePath === tab.filePath) continue;
        nextTabs.set(tabId, { ...tab, filePath: nextFilePath || undefined });
        tabsChanged = true;
      }

      const nextOpenFilePath = rewrite(workspace.openFilePath) || null;
      const sidebarPathChanged = nextOpenFilePath !== workspace.openFilePath;
      if (!tabsChanged && !sidebarPathChanged) continue;

      nextOpenProjects.set(projectId, {
        ...workspace,
        tabs: tabsChanged ? nextTabs : workspace.tabs,
        openFilePath: nextOpenFilePath,
      });
      if (tabsChanged) saveTabs(workspace.projectId, nextTabs);
      if (sidebarPathChanged) {
        ipcRenderer.invoke('project:save-sidebar-state', {
          projectId,
          sidebarOpen: workspace.sidebarOpen,
          openFilePath: nextOpenFilePath,
        });
      }
      changed = true;
    }

    if (changed) set({ openProjects: nextOpenProjects });
  },

  syncAllTabsCwd: async (projectId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) {
      return;
    }

    const tabEntries = Array.from(workspace.tabs.entries());
    const updates: Array<[string, string]> = [];
    let cursor = 0;
    const workerCount = Math.min(6, tabEntries.length);

    const worker = async () => {
      while (cursor < tabEntries.length) {
        const [tabId, tab] = tabEntries[cursor++];
        try {
          const currentCwd = await ipcRenderer.invoke('terminal:getCwd', tabId);
          if (currentCwd && currentCwd !== tab.cwd) {
            updates.push([tabId, currentCwd]);
          }
        } catch (e) {
          console.error('[Workspace] ❌ Failed to get cwd for tab:', tabId, e);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));

    if (updates.length === 0) {
      return;
    }

    const latestOpenProjects = get().openProjects;
    const latestWorkspace = latestOpenProjects.get(projectId);
    if (!latestWorkspace) {
      return;
    }

    let changed = false;
    for (const [tabId, currentCwd] of updates) {
      const tab = latestWorkspace.tabs.get(tabId);
      if (tab && tab.cwd !== currentCwd) {
        tab.cwd = currentCwd;
        changed = true;
      }
    }

    if (changed) {
      set({ openProjects: new Map(latestOpenProjects) });
      saveTabs(latestWorkspace.projectId, latestWorkspace.tabs);
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

        maybeArmPendingAutoTabTitle(tabId, 'claude', prev, sessionId, tab.nameSetManually === true, reason);
        if (!sessionId || (prev && prev !== sessionId)) {
          clearPendingAutoTabTitle(tabId, !sessionId ? 'claude-session-cleared' : 'claude-session-changed');
        }

        tab.claudeSessionId = sessionId;
        // Reset overlay flags when new session starts (so overlay shows again if interrupted)
        tab.wasInterrupted = false;
        tab.overlayDismissed = false;
        // Point-write this tab's id FIRST, then the usual full save. The full
        // save carries the whole tab array and could otherwise roll back a
        // sibling tab's id that the bridge assigned while this array was being
        // assembled; main's snapshot guard now protects existing rows, and this
        // targeted write is what actually commits the new value.
        void ipcRenderer.invoke('claude:persist-session-id', {
          tabId,
          sessionId,
          expectedSessionId: prev || null,
        }).then((result: any) => {
          if (result?.success === false) {
            console.warn('[Store:setClaudeSessionId] point-write rejected tab=' + tabId.slice(-8)
              + ' error=' + (result?.error || 'unknown')
              + ' current=' + (result?.currentSessionId ? String(result.currentSessionId).slice(0, 8) : 'none'));
          }
        }).catch(() => {});
        // Save to database so session persists across restarts and native
        // clients reload tab-level Resume/Copy capabilities.
        saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'claude-session-id');
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
        saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'gemini-session-id');
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

  // Codex session tracking (detected from ~/.codex/sessions JSONL)
  setCodexSessionId: async (tabId, sessionId, reason = 'detected', options = {}) => {
    const { openProjects } = get();

    for (const [projectId, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        const carriedSettingsPlan = options.codexSettingsProofInvalid === true
          ? { allowed: false, reason: 'carried-codex-settings-proof-invalid' }
          : options.codexSettingsProof
            ? planCarriedCodexSettingsProofApplication({
              proof: options.codexSettingsProof,
              nextSessionId: sessionId,
              currentPersistentEffort: tab.codexEffort,
            })
            : null;
        const applyCarriedSettings = () => {
          if (!carriedSettingsPlan?.allowed) return false;
          Object.assign(tab, carriedSettingsPlan.persistentPatch, carriedSettingsPlan.livePatch);
          return true;
        };
        const projectedSettingsProofOwner = projectCodexSettingsProofOwner({
          currentProofAt: tab.codexSettingsProofAt,
          currentProofSessionId: tab.codexSettingsProofSessionId,
          nextSessionId: sessionId,
          carryCodexSettingsProof: options.carryCodexSettingsProof === true,
        });
        const carriesLiveSettings = projectedSettingsProofOwner === sessionId
          && tab.codexSettingsProofSessionId !== sessionId;
        if (tab.codexSessionId === sessionId) {
          const carriedSettingsApplied = applyCarriedSettings();
          if ((carriesLiveSettings || carriedSettingsApplied)
            && tab.codexSettingsProofAt) {
            if (!carriedSettingsApplied) {
              tab.codexSettingsProofSessionId = projectedSettingsProofOwner;
            }
            saveTabsThenNotifyProjectLayoutChanged(
              workspace.projectId,
              workspace.tabs,
              'codex-settings-owner-handoff',
            );
            set({});
          }
          return true;
        }
        const prev = tab.codexSessionId;
        const persistentHistoryMutation = ['editRange', 'deleteRange', 'historyContext', 'api-edit-range', 'api-delete-range'].includes(reason);
        if (persistentHistoryMutation) {
          // CAS is the admission gate, not a best-effort background write. Do
          // not mutate renderer memory or launch Resume until main confirms the
          // stopped historical binding still equals the expected source.
          await commitCodexSessionId(projectId, tabId, sessionId, prev || null, reason);
        }
        maybeArmPendingAutoTabTitle(tabId, 'codex', prev, sessionId, tab.nameSetManually === true, reason);
        if (!sessionId || (prev && prev !== sessionId)) {
          clearPendingAutoTabTitle(tabId, !sessionId ? 'codex-session-cleared' : 'codex-session-changed');
        }
        tab.codexSessionId = sessionId;
        if (tab.codexLiveSettingsSessionId && tab.codexLiveSettingsSessionId !== sessionId) {
          if (carriesLiveSettings && tab.codexLiveSettingsSessionId === prev) {
            tab.codexLiveSettingsSessionId = sessionId;
          } else {
            tab.codexLiveModel = undefined;
            tab.codexLiveEffort = undefined;
            tab.codexLiveSettingsSessionId = undefined;
          }
        }
        if (tab.codexLiveServiceTierSessionId
          && tab.codexLiveServiceTierSessionId !== sessionId) {
          if (carriesLiveSettings && tab.codexLiveServiceTierSessionId === prev) {
            tab.codexLiveServiceTierSessionId = sessionId;
          } else {
            tab.codexLiveServiceTier = undefined;
            tab.codexLiveServiceTierSessionId = undefined;
            tab.codexLiveServiceTierSource = undefined;
          }
        }
        if (carriesLiveSettings && tab.codexSettingsProofAt) {
          // Native Rewind keeps the same live Codex process/settings while its
          // rollout writer moves from the source to the proven child.
          tab.codexSettingsProofSessionId = projectedSettingsProofOwner;
        }
        const carriedSettingsApplied = applyCarriedSettings();
        if (options.codexSettingsProofInvalid === true) {
          console.warn('[CodexSettingsProof:R] exact carried settings rejected tab=' + String(tabId).slice(-12)
            + ' writer=' + String(sessionId).slice(0, 8));
        }
        tab.wasInterrupted = false;
        tab.overlayDismissed = false;
        console.log(`[Workspace] Codex session set for tab ${tabId}: ${sessionId} (reason=${reason}, reset overlay flags, carriedSettings=${carriedSettingsApplied})`);
        if (persistentHistoryMutation) {
          const saveResult = await saveTabs(workspace.projectId, workspace.tabs);
          if (saveResult?.success !== false) notifyProjectLayoutChanged(workspace.projectId, reason);
        } else {
          // Main already point-wrote a process-proven writer. Renderer adopts it
          // in memory only; generic saveTabs preserves the DB-owned identity and
          // cannot race an A→B writer handoff with a late A response.
          saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'codex-session-memory-adopt');
        }
        set({});
        return true;
      }
    }
    return false;
  },

  getCodexSessionId: (tabId) => {
    const { openProjects } = get();

    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        return tab.codexSessionId || null;
      }
    }
    return null;
  },

  updateCodexState: (tabId, state) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      const changesSettings = 'codexModel' in state || 'codexEffort' in state;
      const nextState = {
        ...state,
        ...(changesSettings
          ? {
            codexLiveModel: undefined,
            codexLiveEffort: undefined,
            codexLiveSettingsSessionId: undefined,
          }
          : {}),
        ...(changesSettings
          && !('codexSettingsProofAt' in state)
          ? { codexSettingsProofAt: Date.now() }
          : {}),
        ...(changesSettings
          && !('codexSettingsProofSessionId' in state)
          && tab.codexSessionId
          ? { codexSettingsProofSessionId: tab.codexSessionId }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationPending' in state)
          ? { codexModelMigrationPending: false }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationRestoreDefaultModel' in state)
          ? { codexModelMigrationRestoreDefaultModel: false }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationRestoreDefaultEffort' in state)
          ? { codexModelMigrationRestoreDefaultEffort: false }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationSourceModel' in state)
          ? { codexModelMigrationSourceModel: undefined }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationSourceEffort' in state)
          ? { codexModelMigrationSourceEffort: undefined }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationTargetModel' in state)
          ? { codexModelMigrationTargetModel: undefined }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationConfigPath' in state)
          ? { codexModelMigrationConfigPath: undefined }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationConfigFingerprint' in state)
          ? { codexModelMigrationConfigFingerprint: undefined }
          : {}),
        ...(changesSettings
          && !('codexModelMigrationConfigAlreadyTarget' in state)
          ? { codexModelMigrationConfigAlreadyTarget: undefined }
          : {}),
      };

      let changed = false;
      for (const key of Object.keys(nextState) as (keyof typeof nextState)[]) {
        if ((tab as any)[key] !== nextState[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;

      Object.assign(tab, nextState);
      saveTabs(workspace.projectId, workspace.tabs);
      set({});
      return;
    }
  },

  updateCodexLiveState: (tabId, state) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      if (
        tab.codexLiveModel === state.codexLiveModel
        && tab.codexLiveEffort === state.codexLiveEffort
        && tab.codexLiveSettingsSessionId === state.codexLiveSettingsSessionId
      ) {
        return;
      }
      tab.codexLiveModel = state.codexLiveModel;
      tab.codexLiveEffort = state.codexLiveEffort;
      tab.codexLiveSettingsSessionId = state.codexLiveSettingsSessionId;
      // Deliberately no saveTabs: this state describes one live writer only.
      set({});
      return;
    }
  },

  updateCodexLiveServiceTier: (tabId, state) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      if (
        tab.codexLiveServiceTier === state.codexLiveServiceTier
        && tab.codexLiveServiceTierSessionId === state.codexLiveServiceTierSessionId
        && tab.codexLiveServiceTierSource === state.codexLiveServiceTierSource
      ) {
        return;
      }
      tab.codexLiveServiceTier = state.codexLiveServiceTier;
      tab.codexLiveServiceTierSessionId = state.codexLiveServiceTierSessionId;
      tab.codexLiveServiceTierSource = state.codexLiveServiceTierSource;
      // Deliberately no saveTabs: this proof belongs to the current PTY
      // generation and is rebuilt from Codex's own footer/acknowledgement.
      set({});
      return;
    }
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

  setAiBusy: (tabId, busy, reason) => {
    const { openProjects, activeProjectId } = get();
    let notificationDetail: { projectId: string; tabId: string; tabName: string } | null = null;
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        const wasBusy = !!tab.aiBusy;
        if (wasBusy === busy) return;
        tab.aiBusy = busy;
        if (busy) {
          if (tab.completionNotificationPersistent) {
            tab.completionNotificationArmed = true;
          }
          if (tab.completionNotificationFired) {
            delete tab.completionNotificationFired;
            delete tab.completionNotificationFiredAt;
            emitTabCompletionNotificationCleared({ projectId: workspace.projectId, tabId });
          }
        } else if (wasBusy && (tab.completionNotificationArmed || tab.completionNotificationPersistent)) {
          const successful = isNaturalAgentTurnEndReason(reason);
          // Deferring leaves the bell ARMED: the queue's own last item ends a
          // turn with nothing pending, and that turn rings once for the whole
          // Run after run instead of once per item.
          const deferReason = tabCompletionDeferralReason(tabId, successful);
          if (deferReason) {
            console.warn('[TabNotification] completion deferred tab=' + tabId.slice(-12)
              + ' reason=' + deferReason);
          } else {
            const settled = settleTabCompletionNotification({
              tab,
              workspace,
              activeProjectId,
              tabId,
              successful,
            });
            notificationDetail = settled.detail;
            if (settled.changed) {
              console.warn('[TabNotification] completion settled tab=' + tabId.slice(-12)
                + ' successful=' + (successful ? '1' : '0')
                + ' fired=' + (settled.detail?.fired ? '1' : '0')
                + ' persistent=' + (tab.completionNotificationPersistent ? '1' : '0'));
            }
          }
        }
        set({ openProjects: new Map(openProjects) });
        if (notificationDetail) emitTabCompletionNotification(notificationDetail);
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

  receiveTabTaskPlan: (tabId, document) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      const currentRevision = tab.taskPlan?.revision ?? -1;
      if (currentRevision > document.revision) return;
      tab.taskPlan = document;
      set({ openProjects: new Map(openProjects) });
      return;
    }
  },

  applyTabTaskPlanOperations: async (tabId, operations) => {
    try {
      const result = await ipcRenderer.invoke('tab-task-plan:apply', {
        tabId,
        operations,
        source: 'user',
      });
      if (!result?.success || !result.document) throw new Error(result?.error || 'task_plan_apply_failed');
      get().receiveTabTaskPlan(tabId, result.document);
      return result.document;
    } catch (error: any) {
      console.warn('[TaskPlan] apply failed tab=' + restoreShortId(tabId) + ': ' + (error?.message || error));
      return null;
    }
  },

  undoTabTaskPlan: async (tabId) => {
    try {
      const result = await ipcRenderer.invoke('tab-task-plan:undo', { tabId, source: 'user' });
      if (!result?.success || !result.document) throw new Error(result?.error || 'task_plan_undo_failed');
      get().receiveTabTaskPlan(tabId, result.document);
      return result.document;
    } catch (error: any) {
      console.warn('[TaskPlan] undo failed tab=' + restoreShortId(tabId) + ': ' + (error?.message || error));
      return null;
    }
  },

  redoTabTaskPlan: async (tabId) => {
    try {
      const result = await ipcRenderer.invoke('tab-task-plan:redo', { tabId, source: 'user' });
      if (!result?.success || !result.document) throw new Error(result?.error || 'task_plan_redo_failed');
      get().receiveTabTaskPlan(tabId, result.document);
      return result.document;
    } catch (error: any) {
      console.warn('[TaskPlan] redo failed tab=' + restoreShortId(tabId) + ': ' + (error?.message || error));
      return null;
    }
  },

  // Reorder projects (drag-and-drop)
  reorderProjects: (orderedProjectIds) => {
    const { openProjects, saveSession } = get();

    // Create new Map with correct order
    const newOpenProjects = new Map<string, ProjectWorkspace>();
    const orderedSet = new Set(orderedProjectIds);
    for (const projectId of orderedProjectIds) {
      const workspace = openProjects.get(projectId);
      if (workspace) {
        newOpenProjects.set(projectId, workspace);
      }
    }
    for (const [projectId, workspace] of openProjects) {
      if (!orderedSet.has(projectId)) {
        newOpenProjects.set(projectId, workspace);
      }
    }

    set({ openProjects: newOpenProjects });
    saveSession();
    notifyProjectOrderChanged('project-order');
  },

  // Здесь жили действия browser-вкладки: создать её, запомнить адрес страницы и
  // переключить её внутренний вид (страница/терминал). Вкладка целиком удалена
  // 2026-08-17 — встроенным браузером не пользовались, а живой браузер у нас
  // снаружи и управляется через MCP.

  // Claude SDK tabs
  createSDKTab: async (projectId, name, options) => {
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
      afterTabId: options?.afterTabId,
      afterVisualSubtree: options?.afterVisualSubtree,
      groupId: options?.groupId,
      visualParentTabId: options?.visualParentTabId,
      background: options?.background,
      windowScoped: options?.windowScoped,
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
        if (sidChanged) saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'sdk-session-id');
        set({}); // Trigger Zustand notify — primitive selectors detect change
        return;
      }
    }
    console.warn('[Store:updateSDKState] TAB NOT FOUND tabId=' + tabId);
  },

  updateExternalRunMeta: (tabId, meta) => {
    const { openProjects } = get();
    for (const [, workspace] of openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      tab.externalRun = { ...(tab.externalRun || {}), ...(meta || {}) };
      set({ openProjects: new Map(openProjects) });
      saveTabs(workspace.projectId, workspace.tabs);
      return;
    }
    console.warn('[Store:updateExternalRunMeta] TAB NOT FOUND tabId=' + tabId);
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
          name: tab.name, cwd: tab.cwd, color: tab.color, isUtility: false,
          commandType: tab.commandType, claudeSessionId: tab.claudeSessionId,
          geminiSessionId: tab.geminiSessionId, codexSessionId: tab.codexSessionId,
          codexModel: tab.codexModel, codexEffort: tab.codexEffort, codexSettingsProofAt: tab.codexSettingsProofAt, codexSettingsProofSessionId: tab.codexSettingsProofSessionId, codexModelMigrationPending: tab.codexModelMigrationPending, codexModelMigrationRestoreDefaultModel: tab.codexModelMigrationRestoreDefaultModel, codexModelMigrationRestoreDefaultEffort: tab.codexModelMigrationRestoreDefaultEffort, codexModelMigrationSourceModel: tab.codexModelMigrationSourceModel, codexModelMigrationSourceEffort: tab.codexModelMigrationSourceEffort, codexModelMigrationTargetModel: tab.codexModelMigrationTargetModel, codexModelMigrationConfigPath: tab.codexModelMigrationConfigPath, codexModelMigrationConfigFingerprint: tab.codexModelMigrationConfigFingerprint, codexModelMigrationConfigAlreadyTarget: tab.codexModelMigrationConfigAlreadyTarget, externalRun: tab.externalRun, sessionStatus: tab.sessionStatus, wasInterrupted: tab.wasInterrupted,
          overlayDismissed: tab.overlayDismissed, notes: tab.notes, taskPlan: tab.taskPlan, tabType: tab.tabType,
          filePath: tab.filePath, createdAt: tab.createdAt, isCollapsed: tab.isCollapsed,
          groupId: tab.groupId, visualParentTabId: tab.visualParentTabId,
          windowScoped: tab.windowScoped,
          completionNotificationPersistent: tab.completionNotificationPersistent,
          restartAfterTabId: tab.restartAfterTabId,
          restartAfterTabIds: tab.restartAfterTabIds,
          restartAfterCommand: tab.restartAfterCommand,
          restartAfterPaused: tab.restartAfterPaused,
          restartAfterPersistent: tab.restartAfterPersistent,
          restartAfterArmed: tab.restartAfterArmed,
          nameSetManually: tab.nameSetManually, tabId: tab.id
        }));
        ipcRenderer.sendSync('project:save-tabs-sync', { projectId: workspace.projectId, tabs: tabsArray });
      }
    }
    // Notify subscribers (future-proof: currently called at shutdown, but may be used elsewhere)
    if (anyChanged) set({});
  },

  // Save session immediately without debounce (for shutdown).
  //
  // This is the LAST write before the app dies, so whatever it omits is what
  // the next launch has lost. It used to build its own, shorter record —
  // projects + active project + view — and thereby erased the split layout,
  // the focused pane, the tab-visit order, the project order and the sidebar's
  // project on every single close. Now it saves the SAME record as the normal
  // save (buildSessionSnapshot), so "closing the app" can no longer mean
  // "forgetting part of the workspace".
  saveSessionImmediate: (options) => {
    const state = get();
    // A partially restored store is NOT a user workspace. Keeping the previous
    // durable snapshot is the only lossless choice: project-loop completion
    // later installs spaces and panes in one final set(), but a close in the
    // middle used to persist the initial one-space/zero-pane skeleton.
    if (state.isRestoring) {
      console.warn('[Store] Session immediate save skipped: restore-in-progress'
        + ' reason=' + (options?.reason || 'immediate-workspace-save'));
      return;
    }
    const sessionState = buildSessionSnapshot(state);

    // Use sendSync for immediate save during shutdown
    const result = ipcRenderer.sendSync('app:setStateSync', {
      key: SESSION_KEY,
      value: sessionState,
      reason: options?.reason || 'immediate-workspace-save',
      source: options?.source || 'renderer-sync',
      allowWorkspaceSpaceRemoval: options?.allowWorkspaceSpaceRemoval === true,
    });
    if (result?.success === false) {
      console.warn('[Store] Session immediate save rejected error=' + result.error
        + ' missingSpaces=' + (result.missingSpaceIds || []).join(','));
      return;
    }
    console.log('[Store] Session saved immediately:'
      + ' projects=' + sessionState.openProjects.length
      + ' panes=' + sessionState.splitPanes.length
      + ' focusedPane=' + sessionState.splitFocusedIndex
      + ' view=' + sessionState.view);
  },

  // Per-project view (Home vs Terminal)
  setProjectView: (projectId, view) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace || workspace.currentView === view) return;
    const _t0 = performance.now();
    const _startAbs = performance.timeOrigin + _t0;
    const previousView = workspace.currentView;
    const totalTabs = Array.from(openProjects.values()).reduce((acc, ws) => acc + ws.tabs.size, 0);
    workspace.currentView = view;
    console.warn(
      `[Perf:ProjectView] project=${projectId.slice(-12)} ${previousView}->${view}` +
      ` startAbs=${_startAbs.toFixed(1)}` +
      ` endAbs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
      ` tabs=${workspace.tabs.size} totalTabs=${totalTabs}`
    );
    startTransition(() => set({ openProjects: new Map(openProjects) }));
    requestAnimationFrame(() => {
      console.warn(
        `[Perf:ProjectViewFrame] project=${projectId.slice(-12)} ${previousView}->${view}` +
        ` frameAbs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` durMs=${(performance.now() - _t0).toFixed(1)} tabs=${workspace.tabs.size} totalTabs=${totalTabs}`
      );
    });
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
      if (!open) flushScrollSave('sidebar', projectId);
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

  setSidebarScrollTop: (projectId, scrollTop) => {
    const workspace = get().openProjects.get(projectId);
    if (!workspace) return;
    const normalized = Number.isFinite(Number(scrollTop)) ? Math.max(0, Number(scrollTop)) : 0;
    workspace.sidebarScrollTop = normalized;
    scheduleSidebarScrollSave(projectId, normalized);
  },

  // Tab list scroll follows the file sidebar contract: mutate the workspace in
  // place (no set() — scrolling must not re-render every subscriber) and let the
  // throttle write to SQLite. Read back through getTabListScrollTop on mount.
  setTabListScrollTop: (projectId, scrollTop) => {
    const workspace = get().openProjects.get(projectId);
    if (!workspace) return;
    const normalized = Number.isFinite(Number(scrollTop)) ? Math.max(0, Number(scrollTop)) : 0;
    if (workspace.tabListScrollTop === normalized) return;
    workspace.tabListScrollTop = normalized;
    scheduleScrollSave('tabList', projectId, normalized);
  },

  getTabListScrollTop: (projectId) => {
    const workspace = get().openProjects.get(projectId);
    return Math.max(0, Number(workspace?.tabListScrollTop) || 0);
  },

  getSidebarState: (projectId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (workspace) {
      return {
        sidebarOpen: workspace.sidebarOpen,
        openFilePath: workspace.openFilePath,
        sidebarExpandedDirs: workspace.sidebarExpandedDirs,
        sidebarScrollTop: workspace.sidebarScrollTop
      };
    }
    return { sidebarOpen: false, openFilePath: null, sidebarExpandedDirs: null, sidebarScrollTop: 0 };
  }
}));

const taskPlanUpdatedListener = (_event: unknown, payload: { tabId?: string; document?: TabTaskPlanDocument }) => {
  if (!payload?.tabId || !payload.document) return;
  useWorkspaceStore.getState().receiveTabTaskPlan(payload.tabId, payload.document);
};

if (typeof window !== 'undefined') {
  const listenerKey = '__notedTaskPlanUpdatedListener';
  const previousListener = (window as any)[listenerKey];
  if (previousListener) ipcRenderer.removeListener('tab-task-plan:updated', previousListener);
  (window as any)[listenerKey] = taskPlanUpdatedListener;
  ipcRenderer.on('tab-task-plan:updated', taskPlanUpdatedListener);
  (window as any).useWorkspaceStore = useWorkspaceStore;
}

import { create } from 'zustand';
import { startTransition } from 'react';
import { log } from '../utils/logger';
import { setPrefetched } from '../utils/sdkHistoryPrefetch';
import { usePromptQueueStore } from './usePromptQueueStore';
import type { HistoryPromptDraftChip } from './useUIStore';
import { getInboxProjectPath, isInboxProjectId } from '../constants/systemProjects';
import { isNaturalAgentTurnEndReason } from '../utils/agentCompletionOutcome.mjs';
import {
  commitArchiveBeforeClose,
  isDurableSaveTabsAck,
} from '../utils/tabPersistenceTransactions.mjs';
import {
  planCarriedCodexSettingsProofApplication,
  projectCodexSettingsProofOwner,
} from '../utils/codexSessionAdoption.mjs';
import {
  stopAiBeforeTerminalKill,
} from '../utils/terminalCloseLifecycle.mjs';

const { ipcRenderer } = window.require('electron');
let tabGroupSaveSeq = 0;
const SIDEBAR_SCROLL_SAVE_INTERVAL_MS = 150;
type SidebarScrollSaveState = {
  value: number;
  dirty: boolean;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};
const sidebarScrollSaves = new Map<string, SidebarScrollSaveState>();

const flushSidebarScrollSave = (projectId: string) => {
  const state = sidebarScrollSaves.get(projectId);
  if (!state?.dirty) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.dirty = false;
  state.lastSentAt = Date.now();
  void ipcRenderer.invoke('project:save-sidebar-scroll-top', {
    projectId,
    scrollTop: state.value,
  }).catch((error: unknown) => {
    console.error('[Store] Failed to save sidebar scroll:', { projectId, error });
  });
};

const scheduleSidebarScrollSave = (projectId: string, scrollTop: number) => {
  const normalized = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const state = sidebarScrollSaves.get(projectId) || {
    value: normalized,
    dirty: false,
    lastSentAt: 0,
    timer: null,
  };
  state.value = normalized;
  state.dirty = true;
  sidebarScrollSaves.set(projectId, state);

  const remaining = SIDEBAR_SCROLL_SAVE_INTERVAL_MS - (Date.now() - state.lastSentAt);
  if (remaining <= 0 && !state.timer) {
    flushSidebarScrollSave(projectId);
    return;
  }
  if (!state.timer) {
    state.timer = setTimeout(() => flushSidebarScrollSave(projectId), Math.max(0, remaining));
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

export type TabType = 'terminal' | 'browser' | 'claude-sdk' | 'file';

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
  | 'restoredFromDb'
  | 'userRevert'
  | 'unknown';

export type CodexSessionWriteReason =
  | 'detected'
  | 'userIntercept'
  | 'editRange'
  | 'deleteRange'
  | 'unknown';

export interface CodexSessionAdoptionOptions {
  carryCodexSettingsProof?: boolean;
  codexSettingsProof?: {
    model: string;
    effort: string;
    proofAt: number;
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
const AUTO_TAB_TITLE_PENDING_TTL_MS = 10 * 60 * 1000;

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

  if (Date.now() - intent.at > AUTO_TAB_TITLE_PENDING_TTL_MS) {
    autoTabTitleIntents.delete(tabId);
    console.warn(
      '[Store:AutoTabTitleIntent] expire tab=' + tabId.slice(-8) +
      ' type=' + intent.toolType +
      ' mode=' + intent.mode
    );
    return null;
  }

  if (intent.toolType !== toolType) return null;
  return intent;
};

const clearPendingAutoTabTitle = (tabId: string, reason: string): void => {
  const pending = pendingAutoTabTitles.get(tabId);
  if (!pending) return;
  pendingAutoTabTitles.delete(tabId);
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

  if (Date.now() - pending.at > AUTO_TAB_TITLE_PENDING_TTL_MS) {
    clearPendingAutoTabTitle(tabId, 'expired');
    return null;
  }

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
  name: string;
  name_set_manually?: number | null;
  cwd: string;
  color?: string | null;
  notes?: string | null;
  task_plan?: string | null;
  command_type?: string | null;
  tab_type?: string | null;
  url?: string | null;
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
  resumePolicy?: 'always' | 'if-process-was-running';
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
  filePath?: string; // Absolute file path for linked file tabs
  terminalId?: string; // Terminal ID for browser tabs (linked terminal)
  terminalName?: string; // Terminal name for browser tabs
  activeView?: 'browser' | 'terminal'; // Which view is active in the tab
  createdAt?: number; // Timestamp when tab was created
  claudeSessionId?: string; // Active Claude Code session UUID (detected from terminal output)
  geminiSessionId?: string; // Active Gemini CLI session ID (detected via Sniper Watcher)
  codexSessionId?: string; // Active Codex CLI session ID (detected from ~/.codex/sessions JSONL)
  codexModel?: string; // Per-tab Codex model selection for ControlBar launches
  codexEffort?: string; // Per-tab Codex reasoning effort selection for ControlBar launches
  codexLiveModel?: string; // Transient current-conversation model; never persisted
  codexLiveEffort?: string; // Ultra is conversation-only and lives here
  codexLiveSettingsSessionId?: string; // Exact writer that owns the transient pair
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
  isCollapsed?: boolean; // Collapsed tab — icon-only, for archiving completed sessions
  claudeActive?: boolean; // True if Claude CLI is running inside PTY (not just shell alive)
  claudeBusy?: boolean; // True if Claude CLI spinner is active (from claude:busy-state)
  aiBusy?: boolean; // True when this AI tab is actively streaming/thinking (Claude/SDK/Gemini/Codex)
  aiClosing?: boolean; // Short-lived UI state while close waits for graceful AI stop
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
  currentView: 'terminal' | 'home'; // Per-project view state (Home vs Terminal)
  viewingSubAgentTabId: string | null; // When viewing a sub-agent, points to the Claude sub-agent tab
}

const restoreTabOptions = (savedTab: any) => ({
  color: savedTab.color,
  isUtility: savedTab.isUtility,
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
  url: savedTab.url,
  filePath: savedTab.filePath,
  createdAt: savedTab.createdAt,
  isCollapsed: savedTab.isCollapsed,
  groupId: savedTab.groupId,
  visualParentTabId: savedTab.visualParentTabId,
  sessionStatus: savedTab.sessionStatus,
  completionNotificationPersistent: savedTab.completionNotificationPersistent,
  restartAfterTabId: savedTab.restartAfterTabId,
  restartAfterTabIds: savedTab.restartAfterTabIds,
  restartAfterCommand: savedTab.restartAfterCommand,
  restartAfterPaused: savedTab.restartAfterPaused,
  restartAfterPersistent: savedTab.restartAfterPersistent,
  restartAfterArmed: savedTab.restartAfterArmed,
  nameSetManually: savedTab.nameSetManually,
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
    isUtility: savedTab.isUtility,
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
    url: savedTab.url,
    filePath: savedTab.filePath,
    createdAt: savedTab.createdAt || Math.floor(Date.now() / 1000),
    isCollapsed: savedTab.isCollapsed,
    groupId: savedTab.isUtility ? undefined : savedTab.groupId,
    visualParentTabId: savedTab.isUtility ? undefined : savedTab.visualParentTabId,
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

const isAiRuntimeTab = (tab?: Pick<Tab, 'commandType' | 'tabType'> | null): boolean => {
  return !!tab && (tab.tabType === 'claude-sdk' || tab.commandType === 'claude' || tab.commandType === 'gemini' || tab.commandType === 'codex');
};

const isSdkBusyState = (tab?: Pick<Tab, 'sdkState'> | null): boolean => {
  return tab?.sdkState === 'fetching' || tab?.sdkState === 'thinking' || tab?.sdkState === 'tool_use';
};

const isAiBusyTab = (tab?: Pick<Tab, 'aiBusy' | 'claudeBusy' | 'sdkState'> | null, override?: boolean): boolean => {
  if (typeof override === 'boolean') return override;
  return !!(tab?.aiBusy || tab?.claudeBusy || isSdkBusyState(tab));
};

const makeDefaultSavedTab = (workspace: ProjectWorkspace, cwd?: string | null, tabId?: string) => ({
  tabId: tabId || `${workspace.projectId}-tab-${workspace.tabCounter++}`,
  name: 'Terminal 1',
  cwd: cwd || workspace.projectPath || '',
  tabType: 'terminal',
  commandType: undefined,
});

const emitTabCompletionNotification = (detail: { projectId: string; tabId: string; tabName: string; fired?: boolean; firedAt?: number; persistent?: boolean }) => {
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

const isAiForegroundProcess = (info?: { hasProcess?: boolean; processName?: string; command?: string } | null): boolean => {
  if (!info?.hasProcess) return false;
  const text = `${info.processName || ''} ${info.command || ''}`.toLowerCase();
  return /\b(claude|gemini|codex)\b/.test(text) || text.includes('@openai/codex');
};

interface SessionState {
  openProjects: { projectId: string; projectPath: string; activeTabIndex: number }[];
  activeProjectId: string | null;
  view: 'dashboard' | 'workspace';
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
  activeProjectId: string | null;
  openProjects: Map<string, ProjectWorkspace>;
  projectHistory: string[]; // Stack of project IDs in order of activation
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
  createTab: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; isUtility?: boolean; commandType?: CommandType; pendingAction?: PendingAction; claudeSessionId?: string; geminiSessionId?: string; codexSessionId?: string; codexModel?: string; codexEffort?: string; codexSettingsProofAt?: number; codexSettingsProofSessionId?: string; codexModelMigrationPending?: boolean; codexModelMigrationRestoreDefaultModel?: boolean; codexModelMigrationRestoreDefaultEffort?: boolean; codexModelMigrationSourceModel?: string; codexModelMigrationSourceEffort?: string; codexModelMigrationTargetModel?: string; codexModelMigrationConfigPath?: string; codexModelMigrationConfigFingerprint?: string; codexModelMigrationConfigAlreadyTarget?: boolean; externalRun?: Tab['externalRun']; wasInterrupted?: boolean; overlayDismissed?: boolean; notes?: string; taskPlan?: TabTaskPlanDocument; tabType?: TabType; url?: string; filePath?: string; nameSetManually?: boolean; background?: boolean; skipInitialRename?: boolean; sessionStatus?: string; completionNotificationPersistent?: boolean; restartAfterTabId?: string; restartAfterTabIds?: string[]; restartAfterCommand?: string; restartAfterPaused?: boolean; restartAfterPersistent?: boolean; restartAfterArmed?: boolean; groupId?: string; visualParentTabId?: string }) => Promise<string>;
  createTabAfterCurrent: (projectId: string, name?: string, cwd?: string, options?: { color?: TabColor; isUtility?: boolean; commandType?: CommandType; pendingAction?: PendingAction; claudeSessionId?: string; geminiSessionId?: string; codexSessionId?: string; codexModel?: string; codexEffort?: string; codexSettingsProofAt?: number; codexSettingsProofSessionId?: string; codexModelMigrationPending?: boolean; codexModelMigrationRestoreDefaultModel?: boolean; codexModelMigrationRestoreDefaultEffort?: boolean; codexModelMigrationSourceModel?: string; codexModelMigrationSourceEffort?: string; codexModelMigrationTargetModel?: string; codexModelMigrationConfigPath?: string; codexModelMigrationConfigFingerprint?: string; codexModelMigrationConfigAlreadyTarget?: boolean; wasInterrupted?: boolean; overlayDismissed?: boolean; notes?: string; taskPlan?: TabTaskPlanDocument; tabType?: TabType; url?: string; filePath?: string; afterTabId?: string; nameSetManually?: boolean; background?: boolean; skipInitialRename?: boolean; completionNotificationPersistent?: boolean; restartAfterTabId?: string; restartAfterTabIds?: string[]; restartAfterCommand?: string; restartAfterPaused?: boolean; restartAfterPersistent?: boolean; restartAfterArmed?: boolean; groupId?: string; visualParentTabId?: string }) => Promise<string>;
  closeTab: (projectId: string, tabId: string, options?: { skipProcessCheck?: boolean; forceCleanup?: boolean; aiBusyOverride?: boolean; archive?: boolean }) => Promise<boolean>;
  restoreTabHistoryEntry: (projectId: string, historyId?: number, options?: TabHistoryRestoreOptions) => Promise<TabHistoryRestoreResult>;
  reopenLastClosedTab: (projectId: string) => Promise<TabHistoryRestoreResult>;
  switchTab: (projectId: string, tabId: string) => void;
  setActiveTabGroup: (projectId: string, groupId: string | null) => void;
  renameTab: (projectId: string, tabId: string, newName: string) => void;
  autoRenameTab: (tabId: string, newName: string, options?: { toolType?: 'claude' | 'gemini' | 'codex'; sessionId?: string; overrideManualName?: boolean; markNameSetManually?: boolean }) => boolean;
  setTabTitleNaming: (tabId: string, naming: boolean) => void;
  getPendingAutoTabTitle: (tabId: string, toolType: AutoTabTitleTool, sessionId: string) => PendingAutoTabTitle | null;
  consumePendingAutoTabTitle: (tabId: string, toolType: AutoTabTitleTool, sessionId: string) => boolean;

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
  setTabCompletionNotificationArmed: (projectId: string, tabId: string, armed: boolean) => void;
  setTabCompletionNotificationPersistent: (projectId: string, tabId: string, persistent: boolean) => void;
  clearTabCompletionNotification: (projectId: string, tabId: string, options?: { keepPersistent?: boolean }) => void;
  setTabRestartAfterTarget: (projectId: string, tabId: string, triggerTabId: string | null) => void;
  setTabRestartAfterCommand: (projectId: string, tabId: string, command: string | null) => void;
  setTabRestartAfterPaused: (projectId: string, tabId: string, paused: boolean) => void;
  consumeRestartAfterTriggerIdle: (triggerTabId: string, naturalEnd: boolean) => Array<{ tabId: string; command?: string }>;
  setTabCommandType: (tabId: string, commandType: CommandType) => void; // Also sets auto-color on first run
  markAiLaunchAutoTitle: (tabId: string, toolType: AutoTabTitleTool) => void;
  markAiForkAutoTitle: (tabId: string, toolType: AutoTabTitleTool, sourceSessionId: string) => void;
  getAiLaunchSnapshot: (tabId: string) => AiLaunchSnapshot | null;
  clearAiLaunchSnapshot: (tabId: string, reason?: string) => void;
  discardUnmaterializedAiLaunchSession: (tabId: string, reason: string) => Promise<boolean>;
  toggleTabUtility: (projectId: string, tabId: string) => void;
  toggleTabCollapsed: (projectId: string, tabId: string) => void;

  // Advanced drag & drop
  reorderInZone: (projectId: string, zone: 'main' | 'utility', orderedIds: string[]) => void;
  moveTabToZone: (projectId: string, tabId: string, toUtility: boolean, atIndex: number, sourceIds?: string[]) => void;
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
  saveSessionImmediate: () => void;

  // Reorder projects (for drag-and-drop)
  reorderProjects: (orderedProjectIds: string[]) => void;

  // Browser tabs
  createBrowserTab: (projectId: string) => Promise<string>;
  updateTabUrl: (tabId: string, url: string) => void;
  setBrowserActiveView: (tabId: string, view: 'browser' | 'terminal') => void;

  // Claude SDK tabs
  createSDKTab: (projectId: string, name?: string, options?: { afterTabId?: string; groupId?: string; visualParentTabId?: string; background?: boolean }) => Promise<string>;
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
    url: tab.url,
    filePath: tab.filePath,
    terminalId: tab.terminalId,
    terminalName: tab.terminalName,
    activeView: tab.activeView,
    createdAt: tab.createdAt,
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
    nameSetManually: tab.nameSetManually,
    tabId: tab.id
  }));
  return ipcRenderer.invoke('project:save-tabs', { projectId, tabs: tabsArray, forceCleanup })
    .catch((error: unknown) => {
      console.warn('[Store:saveTabs] failed project=' + dndShortId(projectId) + ' error=' + (error instanceof Error ? error.message : String(error)));
      return { success: false };
    });
};

const notifyProjectLayoutChanged = (projectId: string, reason: string) => {
  ipcRenderer.invoke('project:layout-changed', { projectId, reason }).catch(() => {});
};

const notifyProjectOrderChanged = (reason: string) => {
  ipcRenderer.invoke('project:order-changed', { reason }).catch(() => {});
};

const saveTabsThenNotifyProjectLayoutChanged = (projectId: string, tabs: Map<string, Tab>, reason: string, forceCleanup = false) => {
  saveTabs(projectId, tabs, forceCleanup).then((result: any) => {
    if (result?.success !== false) notifyProjectLayoutChanged(projectId, reason);
  });
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

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  view: 'dashboard',
  activeProjectId: null,
  openProjects: new Map(),
  projectHistory: [],
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
      console.warn('[RestoreSession] no saved session state');
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

      set({ isRestoring: true });

      // Load ALL projects and their tabs WITHOUT calling set() per project.
      // Old approach: openProject() in a loop → each call does set({openProjects: new Map()})
      // → 5 projects = 5 set() calls = 5 Workspace remounts = black screen flicker.
      // New approach: load data inline, mutate openProjects map directly, single set() at end.
      for (const proj of sessionState.openProjects) {
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

      console.warn(
        `[RestoreSession] beforeSet restoredActive=${restoreShortId(restoredActiveId)}` +
        ` savedView=${savedView}` +
        ` projects=${Array.from(openProjects.values()).map((ws) => `${restoreShortId(ws.projectId)}:${ws.tabs.size}`).join(',') || 'none'}`
      );
      set({
        activeProjectId: restoredActiveId,
        view: savedView === 'workspace' && restoredActiveId ? 'workspace' : 'dashboard',
        isRestoring: false,
        openProjects: new Map(openProjects),
        projectHistory: restoredHistory
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
    const { projectHistory, openProjects } = get();
    // Move to end of history (max 20)
    const newHistory = [...projectHistory.filter(id => id !== projectId), projectId].slice(-20);
    const workspace = openProjects.get(projectId);
    const activeTab = workspace?.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
    const clearedNotification = !!(activeTab?.completionNotificationArmed || activeTab?.completionNotificationFired);
    if (activeTab && clearedNotification) {
      delete activeTab.completionNotificationArmed;
      delete activeTab.completionNotificationFired;
      delete activeTab.completionNotificationFiredAt;
      emitTabCompletionNotificationCleared({ projectId, tabId: activeTab.id });
    }

    // Use startTransition for smooth project switching
    startTransition(() => {
      set({
        view: 'workspace', 
        activeProjectId: projectId,
        projectHistory: newHistory,
        ...(clearedNotification ? { openProjects: new Map(openProjects) } : {})
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
      const workspace = openProjects.get(projectId);
      const activeTab = workspace?.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
      const clearedNotification = !!(activeTab?.completionNotificationArmed || activeTab?.completionNotificationFired);
      if (activeTab && clearedNotification) {
        delete activeTab.completionNotificationArmed;
        delete activeTab.completionNotificationFired;
        delete activeTab.completionNotificationFiredAt;
        emitTabCompletionNotificationCleared({ projectId, tabId: activeTab.id });
      }
      set({
        activeProjectId: projectId,
        view: 'workspace',
        projectHistory: newHistory,
        ...(clearedNotification ? { openProjects: new Map(openProjects) } : {})
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

      startTransition(() => set({
        openProjects: nextOpenProjects,
        activeProjectId: nextActiveId,
        projectHistory: newHistory,
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
      url: options?.url,
      filePath: (options as any)?.filePath,
      createdAt: (options as any)?.createdAt || Math.floor(Date.now() / 1000),
      isCollapsed: (options as any)?.isCollapsed,
      groupId: options?.isUtility ? undefined : options?.groupId,
      visualParentTabId: options?.isUtility ? undefined : (options as any)?.visualParentTabId,
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
    workspace.tabs.set(tabId, newTab);

    // Don't switch activeTabId during session restore or background creation
    const { isRestoring } = get();
    if (!isRestoring && !options?.background) {
      workspace.activeTabId = tabId;
      workspace.activeGroupId = newTab.groupId || null;
      workspace.viewingSubAgentTabId = null;
      // Push to tab history (LRU, max 20)
      workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
    }

    console.log('[Store] createTab: Setting state, tabs count:', workspace.tabs.size, 'isRestoring:', isRestoring);

    // During restore, skip per-tab state updates and DB writes — openProject will batch them at the end
    if (!isRestoring) {
      // Only trigger rename for direct user creation without an explicit name.
      const shouldEdit = !options?.background && !name && !options?.nameSetManually && !options?.skipInitialRename;
      set({
        openProjects: new Map(openProjects),
        pendingEditTabId: shouldEdit ? tabId : null,
      });
      saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'tab-created');
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

    const explicitGroupId = resolveExistingTabGroupId(workspace, options?.groupId);
    const activeGroupId = !options?.isUtility ? resolveExistingTabGroupId(workspace, workspace.activeGroupId) : undefined;
    const referenceTabForGroup = options?.afterTabId || workspace.activeTabId || undefined;
    const referenceTab = referenceTabForGroup ? workspace.tabs.get(referenceTabForGroup) : undefined;
    const inheritedVisualParentId = !options?.isUtility && !activeGroupId
      ? referenceTab?.visualParentTabId
      : undefined;
    const requestedVisualParentId = options?.isUtility
      ? undefined
      : (options?.visualParentTabId || inheritedVisualParentId);
    const visualParentTab = requestedVisualParentId ? workspace.tabs.get(requestedVisualParentId) : undefined;
    const visualParentTabId = visualParentTab && !visualParentTab.isUtility && !visualParentTab.parentTabId
      ? requestedVisualParentId
      : undefined;
    const referenceGroupId = referenceTabForGroup
      ? resolveExistingTabGroupId(workspace, referenceTab?.groupId)
      : undefined;
    const visualParentGroupId = resolveExistingTabGroupId(workspace, visualParentTab?.groupId);
    const targetGroupId = options?.isUtility
      ? undefined
      : (explicitGroupId || activeGroupId || referenceGroupId || visualParentGroupId);

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
      url: options?.url,
      filePath: (options as any)?.filePath,
      nameSetManually: (options as any)?.nameSetManually,
      groupId: targetGroupId,
      visualParentTabId,
      createdAt: (options as any)?.createdAt || Math.floor(Date.now() / 1000),
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

    // Insert after specified tab/current tab. When a group-row owns logical focus,
    // Cmd+T/add-new should append inside that group, not after the stale active tab.
    const tabsArray = Array.from(workspace.tabs.entries());
    const isUtility = options?.isUtility || false;
    const groupMemberIds = targetGroupId && !isUtility
      ? tabsArray
        .filter(([, tab]) => !tab.parentTabId && !tab.isUtility && tab.groupId === targetGroupId)
        .map(([id]) => id)
      : [];
    const referenceTabId = !isUtility && targetGroupId && !options?.afterTabId
      ? (groupMemberIds[groupMemberIds.length - 1] || undefined)
      : (options?.afterTabId || workspace.activeTabId);

    // Find position: after reference tab in same zone, or at end of zone
    let insertIndex = tabsArray.length;

    if (!isUtility && targetGroupId && !referenceTabId) {
      const targetGroup = workspace.tabGroups.find(group => group.id === targetGroupId);
      const anchorIndex = targetGroup?.anchorTabId
        ? tabsArray.findIndex(([id, tab]) => id === targetGroup.anchorTabId && !tab.isUtility)
        : -1;
      if (anchorIndex >= 0) {
        insertIndex = anchorIndex;
      } else {
        const firstUtilityIndex = tabsArray.findIndex(([_, tab]) => tab.isUtility);
        insertIndex = firstUtilityIndex === -1 ? tabsArray.length : firstUtilityIndex;
      }
    } else if (referenceTabId && !isUtility) {
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
      workspace.activeGroupId = targetGroupId || null;
      // Push to tab history (LRU, max 20)
      workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
    }

    // Only trigger rename for direct user creation without an explicit name.
    const shouldEdit = !options?.background && !name && !options?.nameSetManually && !options?.skipInitialRename;
    set({
      openProjects: new Map(openProjects),
      pendingEditTabId: shouldEdit ? tabId : null,
    });

    // Save tabs
    saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'tab-created');

    return tabId;
  },

  closeTab: async (projectId, tabId, options) => {
    const closeStartedAt = Date.now();
    const { openProjects, clearTerminalBuffer } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return false;

    const tab = workspace.tabs.get(tabId);
    if (!tab) return false;
    const skipProcessCheck = options?.skipProcessCheck || false;
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
          if (aiBusyAtClose) {
            const confirmed = window.confirm(
              'AI-сессия сейчас отвечает. Остановить её и закрыть вкладку?'
            );
            if (!confirmed) return false;
          }
        } else {
          const confirmed = window.confirm(
            `Terminal has a running process: "${runningProcessInfo?.processName || 'unknown'}"\n\nAre you sure you want to close this tab?`
          );
          if (!confirmed) return false;
        }
      }
    }
    // For SDK tabs, "running" means the SDK turn is mid-stream — we infer it
    // from claudeBusy which is the same signal SessionActionChip watches.
    if (tab.tabType === 'claude-sdk') {
      processWasRunning = aiBusyAtClose;
      if (!skipProcessCheck && aiBusyAtClose) {
        const confirmed = window.confirm(
          'Claude SDK сейчас отвечает. Остановить сессию и закрыть вкладку?'
        );
        if (!confirmed) return false;
      }
    }

    const shouldStopAiProcess = isAiTab
      && (aiBusyAtClose || (processWasRunning && (foregroundAiProcess || !runningProcessInfo?.hasProcess)));

    // Compute TabBar position at close time (excluding sub-agent / utility
    // tabs — they don't take a slot in the bar). Used as a placement hint by
    // reopenLastClosedTab.
    const orderedMainTabs = Array.from(workspace.tabs.values())
      .filter(t => !t.parentTabId && !t.isUtility);
    const closedPosition = orderedMainTabs.findIndex(t => t.id === tabId);

    // File tabs are linked document previews, not restorable terminal/AI sessions.
    const shouldArchiveToHistory = tab.tabType !== 'file' && options?.archive !== false;
    const archiveCommit = await commitArchiveBeforeClose({
      shouldArchive: shouldArchiveToHistory,
      archive: () => ipcRenderer.invoke('project:archive-tab', {
        projectId,
        tab: {
          tabId,
          name: tab.name,
          cwd: tab.cwd,
          color: tab.color,
          notes: tab.notes,
          taskPlan: tab.taskPlan,
          commandType: tab.commandType,
          tabType: tab.tabType,
          url: tab.url,
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
          position: closedPosition >= 0 ? closedPosition : null,
          processWasRunning,
        }
      }),
    });
    if (!archiveCommit.ok) {
      console.warn('[CloseTab] archive not committed; keeping tab and process tab=' + tabId.slice(-12)
        + ' reason=' + (archiveCommit.reason || 'unknown')
        + ' error=' + (archiveCommit.error instanceof Error ? archiveCommit.error.message : 'none'));
      return false;
    }
    if (!archiveCommit.skipped) {
      console.log('[CloseTab] archive committed tab=' + tabId.slice(-12) +
        ' historyId=' + (archiveCommit.result?.historyId ?? 'none') +
        ' durMs=' + (Date.now() - closeStartedAt));
    } else if (tab.tabType === 'file') {
      console.log('[CloseTab] archive skipped file tab=' + tabId.slice(-12));
    }

    // Nothing below this point may run until a requested History row is
    // durably committed. On archive failure the live process and tab stay
    // intact, so the user can retry instead of losing the only copy.
    if (shouldStopAiProcess) {
      tab.aiClosing = true;
      startTransition(() => {
        set({ openProjects: new Map(openProjects) });
      });
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
          toolType: tab.commandType,
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
    clearTerminalBuffer(tabId); // Clean up serialized buffer

    workspace.tabs.delete(tabId);
    for (const remainingTab of workspace.tabs.values()) {
      if (remainingTab.visualParentTabId === tabId) remainingTab.visualParentTabId = undefined;
    }
    usePromptQueueStore.getState().cleanupClosedTab(tabId);
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

    // Save tabs (forceCleanup when called from batch close, and when the last
    // tab is intentionally closed so SQLite removes the final persisted row).
    saveTabsThenNotifyProjectLayoutChanged(workspace.projectId, workspace.tabs, 'tab-closed', options?.forceCleanup || workspace.tabs.size === 0);
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
    const background = options.background === true;
    const mainTabIds = Array.from(workspace.tabs.values())
      .filter(tab => !tab.parentTabId && !tab.isUtility)
      .map(tab => tab.id);
    const hintedPosition = typeof entry.position === 'number' ? entry.position : mainTabIds.length;
    const targetIndex = Math.max(0, Math.min(mainTabIds.length, hintedPosition));
    const restoredGroupId = resolveExistingTabGroupId(workspace, entry.group_id);

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

    const restoreCwd = await resolveHistoryRestoreCwd(entry, workspace.projectPath);
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
        tabType: (entry.tab_type || 'terminal') as TabType,
        url: entry.url || undefined,
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
        background,
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
        const utilityStart = entries.findIndex(([, tab]) => tab.isUtility);
        const mainEnd = utilityStart === -1 ? entries.length : utilityStart;
        entries.splice(Math.min(targetIndex, mainEnd), 0, newEntry);
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
  reopenLastClosedTab: (projectId) => {
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
        return get().restoreTabHistoryEntry(projectId, undefined, {
          restorePosition: true,
          resumePolicy: 'if-process-was-running',
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
      const prevActiveId = workspace.activeTabId;
      const currentView = workspace.currentView;
      const totalTabs = Array.from(openProjects.values()).reduce((acc, ws) => acc + ws.tabs.size, 0);
      const targetTab = workspace.tabs.get(tabId);
      if (targetTab?.completionNotificationArmed || targetTab?.completionNotificationFired) {
        delete targetTab.completionNotificationArmed;
        delete targetTab.completionNotificationFired;
        delete targetTab.completionNotificationFiredAt;
        emitTabCompletionNotificationCleared({ projectId, tabId });
      }
      workspace.activeTabId = tabId;
      workspace.activeGroupId = null;
      // Don't reset viewingSubAgentTabId here — it persists across tab switches.
      // User dismisses it explicitly via SubAgentBar "← Back" button or clicking the active chip.
      workspace.selectedTabIds = [tabId]; // Update selection on direct switch
      // Push to tab history (LRU, max 20)
      workspace.tabHistory = [...workspace.tabHistory.filter(id => id !== tabId), tabId].slice(-20);
      // Use startTransition to prevent UI blocking during re-render
      startTransition(() => {
        set({ openProjects: new Map(openProjects) });
      });
      const syncMs = performance.now() - _t0;
      console.warn(
        `[Perf:TabSwitchStart] project=${projectId.slice(-12)} from=${String(prevActiveId).slice(-12)}` +
        ` startAbs=${_startAbs.toFixed(1)}` +
        ` endAbs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` to=${tabId.slice(-12)} currentView=${currentView} tabs=${workspace.tabs.size}` +
        ` totalTabs=${totalTabs} syncMs=${syncMs.toFixed(1)}`
      );
      requestAnimationFrame(() => {
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

  moveTabToZone: (projectId, tabId, toUtility, atIndex, sourceIds) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);

    if (!workspace) return;

    const tab = workspace.tabs.get(tabId);
    if (!tab) return;

    const requestedIds = sourceIds?.length ? sourceIds : [tabId];
    const movingIds = new Set(requestedIds.filter(id => workspace.tabs.has(id)));
    const queue = [...movingIds];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const candidate of workspace.tabs.values()) {
        if (candidate.visualParentTabId !== parentId || movingIds.has(candidate.id)) continue;
        movingIds.add(candidate.id);
        queue.push(candidate.id);
      }
    }
    if (!movingIds.has(tabId)) movingIds.add(tabId);

    const allTabs = Array.from(workspace.tabs.entries());
    const movingTabs = allTabs.filter(([id]) => movingIds.has(id));
    for (const [id, movingTab] of movingTabs) {
      movingTab.isUtility = toUtility;
      movingTab.groupId = undefined;
      if (!movingTab.visualParentTabId || movingIds.has(movingTab.visualParentTabId)) continue;
      movingTab.visualParentTabId = undefined;
    }

    const stationaryTabs = allTabs.filter(([id]) => !movingIds.has(id));
    const targetZoneTabs = stationaryTabs.filter(([_, candidate]) => !!candidate.isUtility === toUtility);
    const otherZoneTabs = stationaryTabs.filter(([_, candidate]) => !!candidate.isUtility !== toUtility);
    const insertIndex = Math.max(0, Math.min(atIndex, targetZoneTabs.length));
    targetZoneTabs.splice(insertIndex, 0, ...movingTabs);

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
    console.log(
      `[TabDnd:zone-apply] project=${dndShortId(projectId)}` +
      ` source=${dndShortId(tabId)} zone=${toUtility ? 'utility' : 'main'}` +
      ` insertIndex=${insertIndex} ids=${summarizeDndIds(movingTabs.map(([id]) => id))}`
    );
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

    // Update state
    set({ openProjects: new Map(openProjects) });

    // Save both projects
    saveTabs(sourceWorkspace.projectId, sourceWorkspace.tabs, true);
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

    set({ openProjects: new Map(openProjects) });
    saveTabs(src.projectId, src.tabs, true);  // forceCleanup: intentional batch move
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

    set({ openProjects: new Map(currentOpenProjects) });
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

  setTabVisualParent: (projectId, tabId, parentTabId) => {
    const { openProjects } = get();
    const workspace = openProjects.get(projectId);
    if (!workspace) return;

    const tab = workspace.tabs.get(tabId);
    if (!tab || tab.parentTabId || tab.isUtility) return;

    const nextParentId = parentTabId || undefined;
    if (!nextParentId) {
      tab.visualParentTabId = undefined;
      set({ openProjects: new Map(openProjects) });
      saveTabs(workspace.projectId, workspace.tabs);
      return;
    }

    if (nextParentId === tabId) return;
    const parent = workspace.tabs.get(nextParentId);
    if (!parent || parent.parentTabId || parent.isUtility) return;

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
      .filter(tab => !tab.parentTabId && !tab.isUtility)
      .map(tab => tab.id);
    const previousMembersByGroup = new Map<string, string[]>();
    for (const tab of existing.values()) {
      if (tab.parentTabId || tab.isUtility || !tab.groupId) continue;
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
      if (!parent || parent === tab || parent.parentTabId || parent.isUtility || parent.groupId !== tab.groupId) {
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
      if (tab.parentTabId || tab.isUtility || !tab.groupId) continue;
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
          .filter(tab => !tab.parentTabId && !tab.isUtility)
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
      .filter(tab => !tab.parentTabId && !tab.isUtility)
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
        const persistentHistoryMutation = ['editRange', 'deleteRange', 'api-edit-range', 'api-delete-range'].includes(reason);
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
          const isVisibleTarget =
            activeProjectId === workspace.projectId &&
            workspace.activeTabId === tabId &&
            workspace.currentView === 'terminal';
          delete tab.completionNotificationArmed;
          delete tab.completionNotificationFired;
          delete tab.completionNotificationFiredAt;
          if (isNaturalAgentTurnEndReason(reason)) {
            const firedAt = Date.now();
            notificationDetail = {
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
      groupId: options?.groupId,
      visualParentTabId: options?.visualParentTabId,
      background: options?.background,
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
          name: tab.name, cwd: tab.cwd, color: tab.color, isUtility: tab.isUtility,
          commandType: tab.commandType, claudeSessionId: tab.claudeSessionId,
          geminiSessionId: tab.geminiSessionId, codexSessionId: tab.codexSessionId,
          codexModel: tab.codexModel, codexEffort: tab.codexEffort, codexSettingsProofAt: tab.codexSettingsProofAt, codexSettingsProofSessionId: tab.codexSettingsProofSessionId, codexModelMigrationPending: tab.codexModelMigrationPending, codexModelMigrationRestoreDefaultModel: tab.codexModelMigrationRestoreDefaultModel, codexModelMigrationRestoreDefaultEffort: tab.codexModelMigrationRestoreDefaultEffort, codexModelMigrationSourceModel: tab.codexModelMigrationSourceModel, codexModelMigrationSourceEffort: tab.codexModelMigrationSourceEffort, codexModelMigrationTargetModel: tab.codexModelMigrationTargetModel, codexModelMigrationConfigPath: tab.codexModelMigrationConfigPath, codexModelMigrationConfigFingerprint: tab.codexModelMigrationConfigFingerprint, codexModelMigrationConfigAlreadyTarget: tab.codexModelMigrationConfigAlreadyTarget, externalRun: tab.externalRun, sessionStatus: tab.sessionStatus, wasInterrupted: tab.wasInterrupted,
          overlayDismissed: tab.overlayDismissed, notes: tab.notes, taskPlan: tab.taskPlan, tabType: tab.tabType,
          url: tab.url, filePath: tab.filePath, terminalId: tab.terminalId, terminalName: tab.terminalName,
          activeView: tab.activeView, createdAt: tab.createdAt, isCollapsed: tab.isCollapsed,
          groupId: tab.groupId, visualParentTabId: tab.visualParentTabId,
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
      if (!open) flushSidebarScrollSave(projectId);
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

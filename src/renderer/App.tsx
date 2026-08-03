import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, memo } from 'react';
import { useWorkspaceStore, isTabInterrupted, flushScrollSavesSync, selectFocusedProjectId } from './store/useWorkspaceStore';
import { isAiForegroundProcess } from './utils/aiForegroundProcess.mjs';
import { useProjectsStore } from './store/useProjectsStore';
import { syncDefaultCodexSettingsMirror, useUIStore } from './store/useUIStore';
import { usePromptsStore } from './store/usePromptsStore';
import Dashboard from './components/Dashboard/Dashboard';
import Workspace from './components/Workspace/Workspace';
import StatusBar from './components/StatusBar';
import ToastContainer from './components/UI/Toast';
import ShutdownOverlay from './components/UI/ShutdownOverlay';
import EditProjectModal from './components/UI/EditProjectModal';
import SessionInputModal from './components/UI/SessionInputModal';
import SettingsModal from './components/UI/SettingsModal';
import HelpModal from './components/UI/HelpModal';
import HelpButton from './components/UI/HelpButton';
import ControlHint from './components/UI/ControlHint';
import Tooltip from './components/UI/Tooltip';
import PromptPickerOverlay from './components/Workspace/PromptPickerOverlay';
import TabSwitcherOverlay from './components/Workspace/TabSwitcherOverlay';
// Drag and drop
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';

// Initialize debug logger (exposes `debug` helper in console)
import './utils/logger';
import { usePromptQueueRunner } from './hooks/usePromptQueueRunner';
import { useGitRunAfterRunner } from './hooks/useGitRunAfterRunner';
import { clearPendingResume, markPendingResume } from './utils/pendingResume';
import {
  applyClaudePtySetting,
  getClaudePtyPresence,
  interruptClaudePtyTurn,
  resumeClaudePtySession,
  sendClaudePtyPrompt,
  stopClaudePtyProcess,
} from './utils/claudePtyActions';
import { hydratePromptQueueStore, usePromptQueueStore, serializePromptQueueCore, flushPromptQueueStoreSync } from './store/usePromptQueueStore';
import { usePromptQueueWebSync } from './hooks/usePromptQueueWebSync';
import { useMirrorStatusStore } from './store/useMirrorStatusStore';
import {
  initializeOrchestrationStore,
  subscribeOrchestrationRunChanges,
  useOrchestrationStore,
} from './store/useOrchestrationStore';
import { buildCodexRunPayload } from './utils/codexLaunch';
import {
  getCodexDisplaySessionId,
  getConfirmedCodexWriterSessionId,
  requireCodexSurfaceSessionId,
  resolveCodexSurfaceSession,
  type CodexRuntimeSessionSnapshot,
} from './utils/codexWriterIdentity';
import { getCodexRuntimeReadSessionId } from './utils/codexPtyPresence.mjs';
import { getHistoryAgentRuntime, type AgentHistoryTool } from './utils/historyAgentRuntimes';
import {
  isCompleteCodexSettingsRequest,
  planCodexHistorySettings,
  resolveCodexSettingsRuntimeProof,
} from './utils/codexHistorySettingsPlan.mjs';
import { codexSessionAdoptionOptionsFromEvent } from './utils/codexSessionAdoption.mjs';
import {
  planCodexPickerStateApplication,
  resolveCodexEffectiveSettings,
} from './utils/codexEffectiveSettings.mjs';
import {
  grabAgentDraftScenario,
  inspectAgentDraftScenario,
  interruptAgentTurnScenario,
  rewindAgentTimelineScenario,
  sendAgentPromptScenario,
  stopAgentProcessScenario,
} from './utils/agentScenarios';
import { runHistoryPromptHandoff } from './utils/historyPromptHandoffs';
import { terminalRegistry } from './utils/terminalRegistry';
import { waitForClaudeStartupDefaultsReadyWithVisibleFallback } from './utils/claudeStartupDefaultsReady';
import { getClaudeStartupDefaultsGateSnapshot } from './utils/claudeStartupDefaultsGate';
import { DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_MODEL } from './constants/codexSettings';
import { INBOX_PROJECT_ID, INBOX_PROJECT_NAME, getInboxProjectPath, isInboxProjectId } from './constants/systemProjects';
import { generateTabTitleFromSession } from './utils/generateTabTitle';
import { linkFileTab } from './utils/linkFileTab';
import { resolveDockBusyBadgeState } from './utils/dockBusyBadgeState.mjs';
import { shouldNavigateProjectsWithArrow } from './utils/projectArrowNavigation.mjs';

const { ipcRenderer } = window.require('electron');

const CLAUDE_SPINNER_VISUAL_IDLE_GRACE_MS = 300;
const COMPLETION_NOTIFICATION_DISMISS_MS = 420;
type AgentRuntimeStatus = 'active' | 'busy' | 'inactive' | 'starting' | 'stopping' | 'unknown';

function projectClaudeStatusThroughStartupDefaults(
  tabId: string,
  status: AgentRuntimeStatus | null,
  inputReady: boolean | null,
  lastNotReady: any,
  startupFailed: boolean,
  startupError: string | null,
) {
  const gate = getClaudeStartupDefaultsGateSnapshot(tabId);
  const baseStatus: AgentRuntimeStatus = status || 'inactive';
  const result = {
    status: baseStatus,
    inputReady: inputReady === true,
    lastNotReady,
    startupFailed,
    startupError,
    startupDefaultsPending: false,
    startupDefaultsReady: gate?.status === 'ready',
    startupDefaultsError: gate?.status === 'failed' ? (gate.error || gate.reason || 'startup-defaults-failed') : null,
  };

  if (gate?.status === 'pending') {
    const blockers = Array.isArray(lastNotReady?.blockers) ? [...lastNotReady.blockers] : [];
    if (!blockers.includes('startup-defaults')) blockers.push('startup-defaults');
    return {
      ...result,
      status: baseStatus === 'stopping' || baseStatus === 'inactive' ? baseStatus : 'starting' as AgentRuntimeStatus,
      inputReady: false,
      lastNotReady: {
        ...(lastNotReady || {}),
        reason: 'startup-defaults',
        blockers,
        gateReason: gate.reason,
      },
      startupDefaultsPending: true,
    };
  }

  if (gate?.status === 'failed') {
    return {
      ...result,
      startupFailed: true,
      startupError: gate.error || startupError || 'startup-defaults-failed',
    };
  }

  return result;
}

function hexToRgbTriplet(hex: string, fallback = '255, 255, 255') {
  const v = (hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return fallback;
  const n = parseInt(v, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function opacityPctToAlpha(pct: number, fallback = 55) {
  const safe = Number.isFinite(pct) ? pct : fallback;
  return Math.max(5, Math.min(100, Math.round(safe))) / 100;
}

const DOCK_BUSY_ICON_SIZE = 512;
const DOCK_BUSY_BADGE_SIZE = 154;
let dockBaseIconDataUrlPromise: Promise<string | null> | null = null;
let dockBaseIconImagePromise: Promise<HTMLImageElement | null> | null = null;
const dockBusyIconCache = new Map<string, Promise<string | null>>();

function loadDockBaseIconDataUrl() {
  if (!dockBaseIconDataUrlPromise) {
    dockBaseIconDataUrlPromise = ipcRenderer.invoke('dock:get-base-icon-data-url')
      .then((result: any) => result?.success && typeof result.dataUrl === 'string' ? result.dataUrl : null)
      .catch(() => null);
  }
  return dockBaseIconDataUrlPromise;
}

function loadDockBaseIconImage() {
  if (!dockBaseIconImagePromise) {
    dockBaseIconImagePromise = loadDockBaseIconDataUrl().then((dataUrl) => new Promise<HTMLImageElement | null>((resolve) => {
      if (!dataUrl) return resolve(null);
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = dataUrl;
    }));
  }
  return dockBaseIconImagePromise;
}

function drawDockBusyIcon(
  baseImage: HTMLImageElement,
  displayCount: string,
  badgeColor: string,
  kind: 'active' | 'inherited',
) {
  const canvas = document.createElement('canvas');
  canvas.width = DOCK_BUSY_ICON_SIZE;
  canvas.height = DOCK_BUSY_ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, DOCK_BUSY_ICON_SIZE, DOCK_BUSY_ICON_SIZE);
  ctx.drawImage(baseImage, 0, 0, DOCK_BUSY_ICON_SIZE, DOCK_BUSY_ICON_SIZE);

  const radius = DOCK_BUSY_BADGE_SIZE / 2;
  const cx = DOCK_BUSY_ICON_SIZE - radius - 26;
  const cy = DOCK_BUSY_ICON_SIZE - radius - 24;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = badgeColor;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 9;
  ctx.strokeStyle = kind === 'inherited' ? 'rgba(59, 7, 100, 0.28)' : 'rgba(5, 46, 22, 0.28)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#052e16';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${displayCount.length >= 3 ? 54 : displayCount.length === 2 ? 68 : 82}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
  ctx.fillText(displayCount, cx, cy + 3);

  return canvas.toDataURL('image/png');
}

async function getDockBusyIconDataUrl(count: number, kind: 'active' | 'inherited', inheritedColor: string) {
  const displayCount = count > 99 ? '99+' : String(Math.max(0, Math.floor(count)));
  const badgeColor = kind === 'inherited' ? inheritedColor : '#4ade80';
  const cacheKey = `${kind}:${badgeColor}:${displayCount}`;
  const cached = dockBusyIconCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const baseImage = await loadDockBaseIconImage();
    if (!baseImage) return null;

    return drawDockBusyIcon(baseImage, displayCount, badgeColor, kind);
  })();

  dockBusyIconCache.set(cacheKey, promise);
  return promise;
}

// Shared predicate — see utils/aiForegroundProcess.mjs for why the match must
// tolerate a path prefix (`node /opt/homebrew/bin/codex`).

function isAiRuntimeTabLike(tab?: { commandType?: string; tabType?: string } | null): boolean {
  return !!tab && (tab.tabType === 'claude-sdk' || tab.commandType === 'claude' || tab.commandType === 'gemini' || tab.commandType === 'codex');
}

function isSdkBusyStateLike(tab?: { sdkState?: string } | null): boolean {
  return tab?.sdkState === 'fetching' || tab?.sdkState === 'thinking' || tab?.sdkState === 'tool_use';
}

function cleanDefaultSetting(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') return undefined;
  return trimmed;
}

function getTimelineCopyFlagsFromStore() {
  const s = useUIStore.getState();
  return {
    includeEditing: s.copyIncludeEditing,
    includeReading: s.copyIncludeReading,
    includeUser: s.copyIncludeUser,
    includeClaude: s.copyIncludeClaude,
    includeText: s.copyIncludeText,
    includeThinking: s.copyIncludeThinking,
    includeBash: s.copyIncludeBash,
    includeTools: s.copyIncludeTools,
    includeWebSearch: s.copyIncludeWebSearch,
    includeToolSearch: s.copyIncludeToolSearch,
    includeOtherTools: s.copyIncludeOtherTools,
    includeSubagentResult: s.copyIncludeSubagentResult,
    includeSubagentHistory: s.copyIncludeSubagentHistory,
  };
}

async function buildMobileAiRewindText(args: {
  toolType: AgentHistoryTool;
  sessionId: string;
  cwd?: string;
  startUuid?: string;
  endUuid?: string;
  additionalPrompt?: string;
}) {
  const { toolType, sessionId, cwd, startUuid, endUuid, additionalPrompt } = args;
  if (!startUuid || !endUuid) throw new Error('AI Rewind range ids required');

  const copyRangeChannel = toolType === 'codex' ? 'codex:copy-range' : 'claude:copy-range';
  const rangeResult = await ipcRenderer.invoke(copyRangeChannel, {
    sessionId,
    cwd,
    startUuid,
    endUuid,
    ...getTimelineCopyFlagsFromStore(),
  });
  if (!rangeResult?.success || !rangeResult.content) {
    throw new Error(rangeResult?.error || 'Copy range failed');
  }

  let promptState = usePromptsStore.getState();
  if (!promptState.isLoaded) {
    await promptState.loadPrompts();
    promptState = usePromptsStore.getState();
  }

  const promptConfig = promptState.getPromptById(promptState.rewindPromptId);
  if (!promptConfig) throw new Error('No Rewind prompt configured');

  let fileContentsBlock = '';
  const filePaths = promptConfig.filePaths || [];
  if (filePaths.length > 0) {
    const filesResult = await ipcRenderer.invoke('ai-prompts:read-files', filePaths);
    if (filesResult.success && filesResult.data.length > 0) {
      fileContentsBlock = '\n\n' + filesResult.data.map((f: { path: string; content: string }) =>
        `--- File: ${f.path} ---\n${f.content}`
      ).join('\n\n');
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const model = promptConfig.model;
  const promptPrefix = additionalPrompt
    ? `ПРИОРИТЕТНАЯ ИНСТРУКЦИЯ (выполнить в первую очередь):\n${additionalPrompt}\n\n---\nОСНОВНОЙ ПРОМПТ:\n`
    : '';
  const fullPrompt = promptPrefix + promptConfig.content + fileContentsBlock + rangeResult.content;

  const requestBody: any = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    ...(model.includes('gemini-3') || model.includes('gemini-2.5') ? {
      tools: [{ googleSearch: {} }]
    } : {})
  };

  if (model.includes('gemini-3') && promptConfig.thinkingLevel !== 'NONE') {
    requestBody.generationConfig = {
      thinkingConfig: { thinkingLevel: promptConfig.thinkingLevel }
    };
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }
  );
  const data = await response.json();
  const compactText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!compactText.trim()) {
    throw new Error(response.status >= 400
      ? `Gemini ${response.status}: ${data.error?.message || data.error?.status || 'error'}`
      : 'Gemini returned empty response');
  }
  return compactText;
}

type TabCompletionNotificationDetail = {
  projectId: string;
  tabId: string;
  tabName: string;
  fired?: boolean;
  firedAt?: number;
  persistent?: boolean;
};

// Drop Indicator Line for project tabs
const ProjectDropIndicator = memo(({ edge }: { edge: 'left' | 'right' }) => {
  const positionClass = edge === 'left'
    ? 'left-0 -translate-x-1/2'
    : 'right-0 translate-x-1/2';

  return (
    <div
      className={`absolute top-0 bottom-0 bg-white pointer-events-none ${positionClass}`}
      style={{ zIndex: 99999, width: '2px' }}
    />
  );
});

const STRUCTURED_PROJECT_DROP_EVENT = 'structured-tab-project-target';

// Draggable Project Tab
interface ProjectTabItemProps {
  projectId: string;
  projectName: string;
  projectIcon?: string | null;
  index: number;
  isActive: boolean;
  fontSize: number;
  forceRightIndicator?: boolean;
  activeProcessCount?: number; // Count of running processes in project
  interruptedCount?: number; // Count of interrupted (paused) sessions in project
  completionNotificationCount?: number; // Count of completed tabs with armed notification
  isProjectBusy?: boolean; // Any tab in project has Claude/Gemini thinking
  isProjectInheritedBusy?: boolean; // A source tab is waiting for a Terminal MCP child
  isProjectAwaiting?: boolean; // Any tab in project blocked on AskUserQuestion (needs answer)
  isEditing: boolean;
  editValue: string;
  onEditChange: (val: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onMiddleClick: () => void;
  onDoubleClick: () => void;
  onTabDrop?: (tabId: string, sourceProjectId: string, selectedTabIds?: string[]) => void; // For dropping terminal tabs
  isAreaActive?: boolean;
  isProjectLoading?: boolean; // API request in progress (Update API, Research, etc.)
  isPinnedSystem?: boolean;
}

const ProjectTabItem = memo(({
  projectId,
  projectName,
  projectIcon,
  index,
  isActive,
  fontSize,
  forceRightIndicator = false,
  activeProcessCount = 0,
  interruptedCount = 0,
  completionNotificationCount = 0,
  isEditing,
  editValue,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onClick,
  onContextMenu,
  onMiddleClick,
  onDoubleClick,
  onTabDrop,
  isAreaActive,
  isProjectBusy = false,
  isProjectInheritedBusy = false,
  isProjectAwaiting = false,
  isProjectLoading = false,
  isPinnedSystem = false
}: ProjectTabItemProps) => {
  const ref = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isTabDropTarget, setIsTabDropTarget] = useState(false); // Highlight when terminal tab is over
  const [isTabDropBlocked, setIsTabDropBlocked] = useState(false);
  const [structuredDropState, setStructuredDropState] = useState<'allowed' | 'blocked' | null>(null);
  const hasCompletionNotification = completionNotificationCount > 0;
  const [completionNotificationDismissing, setCompletionNotificationDismissing] = useState(false);
  const completionNotificationWasVisibleRef = useRef(hasCompletionNotification);
  const completionNotificationDismissTimerRef = useRef<number | null>(null);

  // Settings → Размеры → ТАБЫ → Проекты. Padding x/y чипа проекта в TitleBar.
  const projectTabGeometry = useUIStore((s) => s.projectTabGeometry);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useLayoutEffect(() => {
    if (completionNotificationDismissTimerRef.current !== null) {
      window.clearTimeout(completionNotificationDismissTimerRef.current);
      completionNotificationDismissTimerRef.current = null;
    }

    if (hasCompletionNotification) {
      setCompletionNotificationDismissing(false);
    } else if (completionNotificationWasVisibleRef.current) {
      setCompletionNotificationDismissing(true);
      completionNotificationDismissTimerRef.current = window.setTimeout(() => {
        setCompletionNotificationDismissing(false);
        completionNotificationDismissTimerRef.current = null;
      }, COMPLETION_NOTIFICATION_DISMISS_MS);
    }

    completionNotificationWasVisibleRef.current = hasCompletionNotification;

    return () => {
      if (completionNotificationDismissTimerRef.current !== null) {
        window.clearTimeout(completionNotificationDismissTimerRef.current);
        completionNotificationDismissTimerRef.current = null;
      }
    };
  }, [hasCompletionNotification]);

  useEffect(() => {
    const handleStructuredProjectTarget = (event: Event) => {
      const detail = (event as CustomEvent<{
        projectId?: string;
        state?: 'allowed' | 'blocked';
      } | null>).detail;
      setStructuredDropState(
        detail?.projectId === projectId && detail.state
          ? detail.state
          : null
      );
    };
    window.addEventListener(STRUCTURED_PROJECT_DROP_EVENT, handleStructuredProjectTarget);
    return () => window.removeEventListener(STRUCTURED_PROJECT_DROP_EVENT, handleStructuredProjectTarget);
  }, [projectId]);

  useEffect(() => {
    const element = ref.current;
    if (!element || isEditing) return;

    const dndBehaviors = [
      dropTargetForElements({
        element,
        getData: ({ input, element }) => {
          return attachClosestEdge(
            { type: 'PROJECT_TAB', id: projectId, index },
            { element, input, allowedEdges: ['left', 'right'] }
          );
        },
        canDrop: ({ source }) => {
          if (source.data.type === 'TAB') return true;
          return !isPinnedSystem && source.data.type === 'PROJECT_TAB';
        },
        onDragEnter: ({ source, self }) => {
          if (source.data.type === 'TAB') {
            const blocked = source.data.projectId === projectId;
            setIsTabDropTarget(!blocked);
            setIsTabDropBlocked(blocked);
            return;
          }
          if (isPinnedSystem || source.data.id === projectId) return;
          setClosestEdge(extractClosestEdge(self.data) as Edge | null);
        },
        onDrag: ({ source, self }) => {
          if (source.data.type === 'TAB') {
            const blocked = source.data.projectId === projectId;
            setIsTabDropTarget(!blocked);
            setIsTabDropBlocked(blocked);
            return;
          }
          if (isPinnedSystem || source.data.id === projectId) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(extractClosestEdge(self.data) as Edge | null);
        },
        onDragLeave: () => {
          setClosestEdge(null);
          setIsTabDropTarget(false);
          setIsTabDropBlocked(false);
        },
        onDrop: ({ source }) => {
          setClosestEdge(null);
          setIsTabDropTarget(false);
          setIsTabDropBlocked(false);
          // Handle terminal tab drop
          if (source.data.type === 'TAB' && onTabDrop) {
            const tabData = source.data as { id: string; projectId?: string; selectedTabIds?: string[] };
            if (tabData.projectId && tabData.projectId !== projectId) {
              onTabDrop(tabData.id, tabData.projectId, tabData.selectedTabIds);
            }
          }
        },
      }),
    ];

    if (!isPinnedSystem) {
      dndBehaviors.unshift(draggable({
        element,
        getInitialData: () => ({ type: 'PROJECT_TAB', id: projectId, index }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }));
    }

    return combine(...dndBehaviors);
  }, [projectId, index, onTabDrop, isEditing, isPinnedSystem]);

  // Text color: active (selected) = black, has processes = white, idle = gray
  const textColor = isActive
    ? 'text-black'
    : activeProcessCount > 0 || isProjectBusy
      ? 'text-white'
      : 'text-gray-400 hover:text-white';
  const dropState = structuredDropState
    || (isTabDropBlocked ? 'blocked' : isTabDropTarget ? 'allowed' : null);

  return (
    <button
      ref={ref}
      data-workspace-navigation
      data-project-navigation
      data-structured-project-drop-target
      data-project-id={projectId}
      className={`relative inline-flex items-center text-sm font-medium cursor-pointer transition-colors rounded-sm overflow-visible ${
        isActive && isAreaActive ? 'ring-1 ring-white/50 shadow-[0_0_10px_rgba(255,255,255,0.1)]' : ''
      } ${textColor}`}
      style={{
        // padding x/y из Settings (раньше был хардкод px-3 py-1.5 = 12px 6px).
        padding: `${projectTabGeometry.paddingY}px ${projectTabGeometry.paddingX}px`,
        fontSize: `${fontSize}px`,
        lineHeight: '16px',
        height: `${Math.max(20, 16 + projectTabGeometry.paddingY * 2)}px`,
        opacity: isDragging ? 0.5 : 1,
        outline: dropState === 'allowed'
          ? '2px solid #4ade80'
          : dropState === 'blocked'
            ? '2px solid #737373'
            : 'none',
        outlineOffset: '-2px',
        borderRadius: dropState ? '4px' : '2px', // Consistency with rounded-sm
      }}
      onClick={onClick}
      onDoubleClick={isPinnedSystem ? undefined : onDoubleClick}
      onContextMenu={isPinnedSystem ? undefined : onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1 && !isPinnedSystem) {
          e.preventDefault();
          onMiddleClick();
        }
      }}
    >
      {isActive && (
        <div className="absolute inset-0 bg-white rounded-sm" />
      )}
      {/* Awaiting-user-input — project has a tab blocked on AskUserQuestion.
          Purple wash pulses over the whole project tab (above the active-white
          bg, below the z-10 text) so it's visible whether or not the project is
          active. Same signal/keyframe as the per-tab glow. */}
      {isProjectAwaiting && (
        <div className="tab-awaiting-input absolute inset-0 rounded-sm" style={{ zIndex: 8 }} aria-hidden />
      )}
      {(hasCompletionNotification || completionNotificationDismissing) && (
        <div
          className={`tab-completion-notification-alert absolute inset-0 rounded-sm ${
            completionNotificationDismissing && !hasCompletionNotification
              ? 'tab-completion-notification-alert--dismiss'
              : ''
          }`}
          style={{ zIndex: 9 }}
          aria-hidden
        />
      )}
      <span className="relative z-10 flex items-center gap-1 leading-none">
        {isEditing ? (
          <input
            ref={inputRef}
            className="bg-[#333] border border-accent rounded px-1.5 py-0 text-white outline-none w-[100px] text-xs font-normal"
            value={editValue}
            onChange={(e) => {
              const val = e.target.value;
              onEditChange(val);
              // Real-time sync with ProjectHome
              if (val.trim()) {
                window.dispatchEvent(new CustomEvent('project:name-sync', {
                  detail: { projectId, name: val.trim(), source: 'titlebar' }
                }));
              }
            }}
            onBlur={onEditSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onEditSubmit();
              if (e.key === 'Escape') onEditCancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            {projectIcon ? (
              <img
                src={projectIcon}
                alt=""
                className="w-4 h-4 rounded-[3px] object-cover flex-shrink-0"
                draggable={false}
              />
            ) : isPinnedSystem ? (
              <span
                className="w-4 h-4 rounded-[3px] border border-dashed flex-shrink-0"
                style={{
                  borderColor: isActive ? 'rgba(0,0,0,0.45)' : 'rgba(148,163,184,0.8)',
                  background: isActive ? 'rgba(0,0,0,0.08)' : 'rgba(148,163,184,0.08)',
                }}
                aria-hidden
              />
            ) : null}
            <span className="max-w-[120px] truncate">{projectName}</span>
          </>
        )}
        {(activeProcessCount > 0 || isProjectBusy || isProjectLoading) && !isEditing && (
          <span
            className="relative flex items-center justify-center text-[10px] font-medium rounded-full"
            style={{
              minWidth: '16px',
              height: '16px',
              padding: '0 4px',
              backgroundColor: isProjectInheritedBusy
                ? 'color-mix(in srgb, var(--process-bar-inherited-color, #A855F7) 24%, transparent)'
                : (isActive ? 'rgba(74, 222, 128, 0.3)' : 'rgba(74, 222, 128, 0.2)'),
              color: isProjectInheritedBusy ? 'var(--process-bar-inherited-color, #A855F7)' : (isActive ? '#166534' : '#4ade80'),
              boxSizing: 'border-box',
            }}
          >
            {(isProjectBusy || isProjectLoading) && (
              <span
                className="absolute inset-0 rounded-full"
                style={{
                  border: isProjectInheritedBusy
                    ? '2px solid color-mix(in srgb, var(--process-bar-inherited-color, #A855F7) 20%, transparent)'
                    : '2px solid rgba(74, 222, 128, 0.2)',
                  borderTopColor: isProjectInheritedBusy ? 'var(--process-bar-inherited-color, #A855F7)' : '#4ade80',
                  boxSizing: 'border-box',
                  animation: 'tab-dot-spin 0.8s linear infinite',
                }}
              />
            )}
            {activeProcessCount > 0 ? activeProcessCount : null}
          </span>
        )}
        {completionNotificationCount > 0 && !isEditing && (
          <Tooltip content="Tab completion notification ready">
            <span
              className="relative flex items-center justify-center text-[10px] font-semibold rounded-full"
              style={{
                minWidth: '16px',
                height: '16px',
                padding: '0 4px',
                backgroundColor: isActive ? 'rgba(239, 68, 68, 0.32)' : 'rgba(239, 68, 68, 0.22)',
                color: isActive ? '#7f1d1d' : '#f87171',
                boxSizing: 'border-box',
              }}
            >
              {completionNotificationCount}
            </span>
          </Tooltip>
        )}
        {interruptedCount > 0 && !isEditing && (
          <Tooltip content="Interrupted sessions - click tab to resume">
            <span
              className="flex items-center justify-center text-[10px] font-medium rounded-full"
              style={{
                minWidth: '16px',
                height: '16px',
                padding: '0 4px',
                backgroundColor: isActive ? 'rgba(59, 130, 246, 0.3)' : 'rgba(59, 130, 246, 0.2)',
                color: isActive ? '#1e40af' : '#3b82f6',
              }}
            >
              {interruptedCount}
            </span>
          </Tooltip>
        )}
      </span>
      {closestEdge && <ProjectDropIndicator edge={closestEdge as 'left' | 'right'} />}
      {forceRightIndicator && !closestEdge && <ProjectDropIndicator edge="right" />}
    </button>
  );
});

// Empty area drop zone for projects - for dropping at the end
// This area allows window dragging when not in a drag-drop operation
const ProjectEmptyDropZone = memo(({ onDrop, onHoverChange, onDoubleClick, onMouseDown }: {
  onDrop: (projectId: string) => void;
  onHoverChange: (isOver: boolean) => void;
  onDoubleClick: () => void;
  onMouseDown: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragActive, setIsDragActive] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ type: 'PROJECT_EMPTY_ZONE' }),
      canDrop: ({ source }) => source.data.type === 'PROJECT_TAB',
      onDragEnter: () => {
        setIsDragActive(true);
        onHoverChange(true);
      },
      onDragLeave: () => {
        setIsDragActive(false);
        onHoverChange(false);
      },
      onDrop: ({ source }) => {
        const data = source.data as { id: string };
        onDrop(data.id);
        setIsDragActive(false);
        onHoverChange(false);
      },
    });
  }, [onDrop, onHoverChange]);

  return (
    <div
      ref={ref}
      className="flex-1 h-full min-w-[30px] transition-colors"
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onMouseDown();
      }}
      style={{
        // Crucial: no-drag allows JS to catch events, but we keep it transparent
        WebkitAppRegion: 'no-drag'
      } as any}
    />
  );
});

// Global loading screen during structural session restore only.
const RestoreLoader = memo(({
  label = 'Restoring session...',
  detail,
}: {
  label?: string;
  detail?: string;
}) => {
  useEffect(() => {
    console.warn('[RestoreLoader] show label=' + label + ' detail=' + (detail || '-'));
    return () => {
      console.warn('[RestoreLoader] hide label=' + label + ' detail=' + (detail || '-'));
    };
  }, [label, detail]);

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-bg-main text-white">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
        <span className="text-sm text-[#888]">{label}</span>
        {detail ? <span className="text-xs text-[#666]">{detail}</span> : null}
      </div>
    </div>
  );
});

function App() {
  // Mount the prompt-queue auto-runner at app root. It's a tab-independent listener
  // for claude:busy-state IPC + queue-state subscription, so it survives the user
  // switching away from the Claude tab (which would otherwise unmount the overlay
  // and kill the runner). See hooks/usePromptQueueRunner.ts comment for the bug
  // it fixes (auto-run silently breaking the moment user goes to another tab).
  usePromptQueueRunner();

  // Git Run-after is project-scoped but must keep listening while the user is
  // viewing another project or Dashboard. The App-root runner owns that lifetime.
  useGitRunAfterRunner();

  // Broadcast per-tab queue deltas to any connected phone (queue-update SSE).
  // Pure mirror — fires only when a connected mobile cares; no-op otherwise.
  usePromptQueueWebSync();

  // Hydrate persisted queues from SQLite once at boot. Fire-and-forget — the
  // runner above tolerates queue items appearing after mount (subscribes to
  // store deltas), so this doesn't need to block render.
  useEffect(() => { hydratePromptQueueStore(); }, []);
  useEffect(() => {
    const unsubscribe = subscribeOrchestrationRunChanges((change) => {
      const workspace = useWorkspaceStore.getState();
      if (!change.wasCompletionBlocked && change.completionBlocked) {
        workspace.applyTabCompletionOrchestrationState(change.sourceTabId, 'active');
      } else if (change.releaseKind === 'success') {
        workspace.applyTabCompletionOrchestrationState(change.sourceTabId, 'success');
      } else if (change.releaseKind === 'abnormal') {
        workspace.applyTabCompletionOrchestrationState(change.sourceTabId, 'abnormal');
      }
    });
    void initializeOrchestrationStore();
    return unsubscribe;
  }, []);

  // Individual selectors — only re-render when specific values change (not on every store mutation)
  const view = useWorkspaceStore((s) => s.view);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const focusedProjectId = useWorkspaceStore(selectFocusedProjectId);
  const openProjects = useWorkspaceStore((s) => s.openProjects);
  const isRestoring = useWorkspaceStore((s) => s.isRestoring);
  // Functions are stable references in Zustand — selecting them individually avoids re-renders
  const showDashboard = useWorkspaceStore((s) => s.showDashboard);
  const showWorkspace = useWorkspaceStore((s) => s.showWorkspace);
  const openProject = useWorkspaceStore((s) => s.openProject);
  const closeProject = useWorkspaceStore((s) => s.closeProject);
  const createTab = useWorkspaceStore((s) => s.createTab);
  const createTabAfterCurrent = useWorkspaceStore((s) => s.createTabAfterCurrent);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const getActiveProject = useWorkspaceStore((s) => s.getActiveProject);
  const getEffectiveTabId = useWorkspaceStore((s) => s.getEffectiveTabId);
  const restoreSession = useWorkspaceStore((s) => s.restoreSession);
  const reorderProjects = useWorkspaceStore((s) => s.reorderProjects);
  const moveTabToProject = useWorkspaceStore((s) => s.moveTabToProject);
  const moveTabsToProject = useWorkspaceStore((s) => s.moveTabsToProject);
  const getSidebarState = useWorkspaceStore((s) => s.getSidebarState);
  const setSidebarOpen = useWorkspaceStore((s) => s.setSidebarOpen);
  const setOpenFilePath = useWorkspaceStore((s) => s.setOpenFilePath);
  const { projects, loadProjects, updateProject } = useProjectsStore();
  const { closeFilePreview, filePreview, showToast, incrementAllFontSizes, decrementAllFontSizes, activeArea, setActiveArea, dragAreaWidth, setDragAreaWidth } = useUIStore();
  const projectTabsFontSize = useUIStore((s) => s.projectTabsFontSize);
  const inheritedBusyProjectKey = useOrchestrationStore((s) => (
    Array.from(s.inheritedBusyProjectIds).sort().join('\u0000')
  ));
  const inheritedBusyTabKey = useOrchestrationStore((s) => (
    Array.from(s.inheritedBusyTabIds).sort().join('\u0000')
  ));
  const inheritedBusyProjectIds = useMemo(
    () => new Set(inheritedBusyProjectKey ? inheritedBusyProjectKey.split('\u0000') : []),
    [inheritedBusyProjectKey],
  );
  const inheritedBusyTabIds = useMemo(
    () => new Set(inheritedBusyTabKey ? inheritedBusyTabKey.split('\u0000') : []),
    [inheritedBusyTabKey],
  );
  const notificationInheritedBusyRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const previous = notificationInheritedBusyRef.current;
    const workspace = useWorkspaceStore.getState();
    for (const tabId of inheritedBusyTabIds) {
      if (!previous.has(tabId)) workspace.applyTabCompletionOrchestrationState(tabId, 'active');
    }
    notificationInheritedBusyRef.current = new Set(inheritedBusyTabIds);
  }, [inheritedBusyTabKey, inheritedBusyTabIds]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Запрошенный начальный таб для SettingsModal — выставляется через
  // window CustomEvent 'settings:open' { detail: { tab } } (например,
  // ПКМ на SemanticIndexButton → tab='colors'/«Системные»). null означает
  // обычное открытие через Cmd+, или StatusBar — модалка покажет lastActiveTab.
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | null>(null);

  // Sync processBar settings → CSS variables on :root.
  // Base strip color + shimmer color/spacing/opacity are renderer-wide CSS vars; Settings
  // updates land in useUIStore and the visible TabBar picks them up immediately.
  const processBar = useUIStore((s) => s.processBar);
  useEffect(() => {
    const root = document.documentElement;
    const peakAlpha = opacityPctToAlpha(processBar.shimmerOpacityPct);
    root.style.setProperty('--process-bar-color-a', processBar.colorA);
    root.style.setProperty('--process-bar-shimmer-rgb', hexToRgbTriplet(processBar.shimmerColor));
    root.style.setProperty('--process-bar-inherited-color', processBar.inheritedColor);
    // Inherited activity changes the strip color, not the loader highlight.
    // Using the same RGB for both makes the animated overlay pixel-identical.
    root.style.setProperty('--process-bar-inherited-shimmer-rgb', hexToRgbTriplet(processBar.shimmerColor));
    root.style.setProperty('--process-bar-shimmer-spacing', `${processBar.shimmerSpacingPct}%`);
    root.style.setProperty('--process-bar-shimmer-alpha', String(peakAlpha));
    root.style.setProperty('--process-bar-shimmer-edge-alpha', String(Math.max(0.01, peakAlpha * 0.22)));
    console.warn(
      '[App:ProcessBarVars]' +
      ' colorA=' + processBar.colorA +
      ' shimmerColor=' + processBar.shimmerColor +
      ' inheritedColor=' + processBar.inheritedColor +
      ' rgb=' + hexToRgbTriplet(processBar.shimmerColor) +
      ' spacingPct=' + processBar.shimmerSpacingPct +
      ' opacityPct=' + processBar.shimmerOpacityPct +
      ' peakAlpha=' + peakAlpha.toFixed(3) +
      ' edgeAlpha=' + Math.max(0.01, peakAlpha * 0.22).toFixed(3)
    );
  }, [processBar.colorA, processBar.shimmerColor, processBar.inheritedColor, processBar.shimmerSpacingPct, processBar.shimmerOpacityPct]);

  useEffect(() => {
    const showNativeNotification = async (detail: TabCompletionNotificationDetail) => {
      if (!('Notification' in window)) return;
      const show = () => {
        try {
          new Notification('Вкладка завершилась', {
            body: detail.tabName,
            silent: true,
          });
        } catch {}
      };

      if (Notification.permission === 'granted') {
        show();
        return;
      }
      if (Notification.permission === 'denied') return;
      try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') show();
      } catch {}
    };

    const handleTabCompletionNotification = (event: Event) => {
      const detail = (event as CustomEvent<TabCompletionNotificationDetail>).detail;
      if (!detail?.tabId) return;
      if (useUIStore.getState().tabCompletionNotificationSound) {
        ipcRenderer.send('tab-notification:play-sound');
      }
      void showNativeNotification(detail);
    };

    window.addEventListener('tab-completion-notification', handleTabCompletionNotification);
    return () => window.removeEventListener('tab-completion-notification', handleTabCompletionNotification);
  }, []);

  // AIPulse (whole-tab background pulse) was removed — its :root var sync
  // (--ai-pulse-*) went with it. The loader is the process-bar shimmer strip,
  // configured via --process-bar-* above. See fact-process-bar.md::AIPulse removed.

  useEffect(() => {
    const onSettingsOpen = (e: Event) => {
      const ce = e as CustomEvent<{ tab?: string }>;
      const tab = ce.detail?.tab || null;
      setSettingsInitialTab(tab);
      setSettingsOpen(true);
      window.dispatchEvent(new CustomEvent('settings:opened'));
    };
    window.addEventListener('settings:open', onSettingsOpen);

    // Bridge: main process can ask us to open Settings on a specific tab via
    // IPC 'open-settings'. Used by Global Dictation's menu "Open App" button.
    const onOpenSettingsIpc = (_e: any, payload: { tab?: string } | undefined) => {
      const tab = payload?.tab || null;
      setSettingsInitialTab(tab);
      setSettingsOpen(true);
    };
    // Boot-time AutoRepair summary — main process scans all session JSONLs at
    // startup, patches dangling parentUuid that would have truncated Claude TUI
    // history on next resume. Surface to user so they know background recovery
    // ran and what it covered.
    const onAutoRepairSummary = (
      _e: any,
      payload: { sessionsFixed?: number; totalRepaired?: number; scanned?: number } | undefined,
    ) => {
      const sf = payload?.sessionsFixed || 0;
      const tr = payload?.totalRepaired || 0;
      if (sf <= 0) return;
      showToast(
        `Auto-repair при старте: починили ${tr} orphan parentUuid в ${sf} сесси${sf === 1 ? 'и' : 'ях'}. Без этого Claude обрезал бы историю при resume.`,
        'info',
        10000,
        false,
      );
    };
    // Anti-arrow-mash guard fired in main — uniform run of arrow escape codes
    // from xterm.js was blocked (likely stuck physical key or accessibility
    // helper). Surface a brief warning so user knows a keystroke didn't go
    // through and can release the key / unplug the device.
    const onArrowMashBlocked = (
      _e: any,
      payload: { count?: number; arrowName?: string } | undefined,
    ) => {
      const n = payload?.count || 0;
      const arrow = payload?.arrowName || '?';
      showToast(
        `Заблокирован поток из ${n} стрелок ${arrow} от клавиатуры — возможно залипла клавиша.`,
        'warning',
        6000,
        false,
      );
    };
    try {
      const { ipcRenderer } = (window as any).require('electron');
      ipcRenderer.on('open-settings', onOpenSettingsIpc);
      ipcRenderer.on('jsonl-auto-repair:summary', onAutoRepairSummary);
      ipcRenderer.on('arrow-mash:blocked', onArrowMashBlocked);
      return () => {
        window.removeEventListener('settings:open', onSettingsOpen);
        try { ipcRenderer.removeListener('open-settings', onOpenSettingsIpc); } catch {}
        try { ipcRenderer.removeListener('jsonl-auto-repair:summary', onAutoRepairSummary); } catch {}
        try { ipcRenderer.removeListener('arrow-mash:blocked', onArrowMashBlocked); } catch {}
      };
    } catch {
      return () => window.removeEventListener('settings:open', onSettingsOpen);
    }
  }, []);

  // Auto-close markdown-editor overlays (Cmd+/ palette, AI-paste indicator) on
  // mousedown outside their DOM. The editor's own listener uses 'click' on
  // `document`, but xterm canvas swallows pointer events before they bubble.
  // We use CAPTURE phase on `window` — fires before any DOM target eats it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const palette = document.querySelector('[data-command-palette]');
      const ctxMenu = document.querySelector('[data-context-menu]');
      const aiPaste = document.querySelector('[data-ai-paste-indicator]');
      if (palette && !palette.contains(target)) palette.remove();
      if (ctxMenu && !ctxMenu.contains(target)) ctxMenu.remove();
      if (aiPaste && !aiPaste.contains(target)) {
        const cancel = aiPaste.querySelector('.cm-ai-paste-cancel') as HTMLElement | null;
        if (cancel) cancel.click();
        else aiPaste.remove();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, []);

  const [projectContextMenu, setProjectContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [projectEmptyZoneHovered, setProjectEmptyZoneHovered] = useState(false);
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map()); // tabId -> isRunning
  const [busyTabs, setBusyTabs] = useState<Map<string, boolean>>(new Map()); // tabId -> isBusy (Claude/Gemini thinking)
  const [pasteBusyTabs, setPasteBusyTabs] = useState<Map<string, boolean>>(new Map()); // tabId -> safePasteAndSubmit in flight
  // Live turn-busy snapshot for close paths. Kept in a ref because the hotkey
  // listener is registered once: reading the state directly would capture the
  // map from the render that installed it and go stale mid-session.
  const liveTurnBusyRef = useRef<{ busy: Map<string, boolean>; paste: Map<string, boolean> }>({
    busy: new Map(),
    paste: new Map(),
  });
  liveTurnBusyRef.current.busy = busyTabs;
  liveTurnBusyRef.current.paste = pasteBusyTabs;
  // One definition of "this tab is mid-answer" for Cmd+W and the context menu.
  // Covers Claude/Gemini/Codex/SDK streaming plus an in-flight paste handoff;
  // the tab's own stored fields miss the latter.
  const readLiveTabTurnBusy = useCallback((tabId: string): boolean => {
    const { busy, paste } = liveTurnBusyRef.current;
    if (busy.get(tabId) === true || paste.get(tabId) === true) return true;
    for (const workspace of useWorkspaceStore.getState().openProjects.values()) {
      const tab: any = workspace.tabs.get(tabId);
      if (!tab) continue;
      return !!(tab.aiBusy || tab.claudeBusy
        || tab.sdkState === 'fetching' || tab.sdkState === 'thinking' || tab.sdkState === 'tool_use');
    }
    return false;
  }, []);
  const claudeSpinnerVisualIdleTimersRef = useRef<Map<string, number>>(new Map());
  // tabId -> awaiting (Claude blocked on AskUserQuestion, waiting for human answer).
  // Feeds the project-tab purple glow. Bracketed by claude:awaiting-input (main.js).
  const [awaitingTabs, setAwaitingTabs] = useState<Map<string, boolean>>(new Map());
  const [apiLoadingProjects, setApiLoadingProjects] = useState<Set<string>>(new Set()); // projectIds with active API requests

  const getProjectStopTargetIds = useCallback((projectId: string) => {
    const workspace = useWorkspaceStore.getState().openProjects.get(projectId) || openProjects.get(projectId);
    if (!workspace) return [];
    return Array.from(workspace.tabs.entries())
      .filter(([tabId, tab]: [string, any]) => {
        if (!tab || tab.tabType === 'file') return false;
        if (tab.tabType === 'claude-sdk') {
          return !!(busyTabs.get(tabId) || tab.sdkProcessAlive || isSdkBusyStateLike(tab));
        }
        return !!processStatus.get(tabId);
      })
      .map(([tabId]) => tabId);
  }, [openProjects, processStatus, busyTabs]);

  const stopProjectRunningTabs = useCallback(async (projectId: string) => {
    const tabIds = getProjectStopTargetIds(projectId);
    if (tabIds.length === 0) return;
    const startedAt = performance.now();
    console.warn(
      '[Perf:StopProjectTabsBatch] start' +
      ' project=' + projectId.slice(-12) +
      ' count=' + tabIds.length +
      ' source=project-context-menu' +
      ' startAbs=' + (performance.timeOrigin + startedAt).toFixed(1)
    );

    await Promise.all(tabIds.map(async (id) => {
      const latestWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
      const tab = latestWorkspace?.tabs.get(id) as any;
      if (!tab) return null;

      if (tab.tabType === 'claude-sdk') {
        window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId: id } }));
        return ipcRenderer.invoke('claude-sdk:stop', { tabId: id });
      }

      if (isAiRuntimeTabLike(tab)) {
        return ipcRenderer.invoke('terminal:stop-ai-process', { tabId: id, toolType: tab.commandType || null });
      }

      return ipcRenderer.invoke('terminal:deterministic-stop', { tabId: id, restart: false });
    }));

    console.warn(
      '[Perf:StopProjectTabsBatch] done' +
      ' project=' + projectId.slice(-12) +
      ' count=' + tabIds.length +
      ' durMs=' + (performance.now() - startedAt).toFixed(1)
    );
  }, [getProjectStopTargetIds]);

  // Listen for project API loading events from ActionsPanel
  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId, loading } = (e as CustomEvent).detail;
      setApiLoadingProjects(prev => {
        const next = new Set(prev);
        if (loading) next.add(projectId);
        else next.delete(projectId);
        return next;
      });
    };
    window.addEventListener('project:api-loading', handler);
    return () => window.removeEventListener('project:api-loading', handler);
  }, []);

  // Drag area resize
  const isResizingDragArea = useRef(false);

  const handleDragAreaResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingDragArea.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isResizingDragArea.current) return;
      const newWidth = window.innerWidth - ev.clientX;
      setDragAreaWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizingDragArea.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [setDragAreaWidth]);

  // Renaming projects in tabs
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectEditValue, setProjectEditValue] = useState('');
  const [lastCreatedProjectId, setLastCreatedProjectId] = useState<string | null>(null);
  const [previousProjectId, setPreviousProjectId] = useState<string | null>(null);

  const handleStartEditingProject = (projectId: string, currentName: string) => {
    setEditingProjectId(projectId);
    setProjectEditValue(currentName);
  };

  const handleSubmitProjectRename = async () => {
    const isNewAndUnchanged = editingProjectId === lastCreatedProjectId && projectEditValue.trim() === 'Новый проект';
    const isDraft = editingProjectId === lastCreatedProjectId;

    if (editingProjectId && projectEditValue.trim() && !isNewAndUnchanged) {
      await updateProject(editingProjectId, { name: projectEditValue.trim() });

      if (isDraft) {
        // Draft mode: also create Terminal 1 now that project is confirmed
        const { openProjects: op, createTab: ct, setProjectView: spv } = useWorkspaceStore.getState();
        const ws = op.get(editingProjectId);
        if (ws && ws.tabs.size === 0) {
          const cwd = ws.projectPath?.startsWith('__unset__') ? undefined : ws.projectPath;
          await ct(editingProjectId, 'Terminal 1', cwd);
          spv(editingProjectId, 'terminal');
        }
      }

      setEditingProjectId(null);
      setLastCreatedProjectId(null);
      setPreviousProjectId(null);
    } else if (editingProjectId) {
      handleCancelProjectRename();
    }
  };

  const handleCancelProjectRename = async (draftProjectId?: string) => {
    const idToCancel = draftProjectId || editingProjectId;
    const isDraftCancel = idToCancel === lastCreatedProjectId;

    if (isDraftCancel && idToCancel) {
      const idToRestore = previousProjectId;

      // VSCode behavior: if we cancel creating a new project, delete it
      setEditingProjectId(null);
      setLastCreatedProjectId(null);
      setPreviousProjectId(null);

      await closeProject(idToCancel);
      await ipcRenderer.invoke('project:delete', idToCancel);
      await loadProjects(); // Refresh global projects list

      // Return to previous project if it exists
      if (idToRestore && openProjects.has(idToRestore)) {
        const prevProj = openProjects.get(idToRestore);
        if (prevProj) {
          openProject(idToRestore, prevProj.projectPath);
        }
      }

      showToast('Project creation cancelled', 'info');
    } else {
      setEditingProjectId(null);
      setLastCreatedProjectId(null);
      setPreviousProjectId(null);
    }
  };

  const handleCreateNewProject = async () => {
    try {
      // Remember where we are before switching
      setPreviousProjectId(activeProjectId);

      const newProject = await ipcRenderer.invoke('project:create-empty', { name: 'Новый проект' });
      if (newProject) {
        // 1. Reload projects in store to include the new one
        await loadProjects();

        // 2. Calculate new order: insert after current or at start
        const currentOrder = Array.from(openProjects.keys());
        let insertIndex = 0;

        if (view === 'workspace' && activeProjectId) {
          const currentIndex = currentOrder.indexOf(activeProjectId);
          if (currentIndex !== -1) {
            insertIndex = currentIndex + 1;
          }
        }

        const newOrder = [...currentOrder];
        newOrder.splice(insertIndex, 0, newProject.id);

        // 3. Apply new order and open in draft mode (Home view, no terminal)
        reorderProjects(newOrder);
        openProject(newProject.id, newProject.path, { draft: true });

        // 4. Set area focus
        setActiveArea('projects');
        // 5. Mark as draft — ProjectHome owns the input, title bar shows synced text
        setLastCreatedProjectId(newProject.id);
        setEditingProjectId(null);
        setProjectEditValue(newProject.name);

        // 6. Signal ProjectHome to enter draft mode (deferred so component is mounted)
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('project:draft-init', {
            detail: { projectId: newProject.id, name: newProject.name }
          }));
        }, 50);
      }
    } catch (err) {
      console.error('Failed to create project:', err);
      showToast('Failed to create project', 'error');
    }
  };

  // Load projects, AI prompts, and restore session ONCE on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadProjects();
      await restoreSession();
      if (!cancelled) {
        const state = useWorkspaceStore.getState();
        if (!state.openProjects.has(INBOX_PROJECT_ID)) {
          await state.openProject(INBOX_PROJECT_ID, getInboxProjectPath(), { background: true });
        }
      }
      usePromptsStore.getState().loadPrompts();
    })();
    return () => { cancelled = true; };
  }, []); // Empty deps = only on mount

  // Sync apiSettings + docPrompt to main process (for MCP update_docs tool)
  useEffect(() => {
    const syncToMain = () => {
      const { apiSettings, docPrompt } = useUIStore.getState();
      ipcRenderer.invoke('docs:sync-settings', { apiSettings, docPrompt });
    };

    // Sync on mount
    syncToMain();

    // Sync on changes
    let prev = JSON.stringify({ a: useUIStore.getState().apiSettings, d: useUIStore.getState().docPrompt });
    const unsub = useUIStore.subscribe((state) => {
      const curr = JSON.stringify({ a: state.apiSettings, d: state.docPrompt });
      if (curr !== prev) {
        prev = curr;
        ipcRenderer.invoke('docs:sync-settings', { apiSettings: state.apiSettings, docPrompt: state.docPrompt });
      }
    });
    return unsub;
  }, []);

  // Listen for draft project events from ProjectHome
  useEffect(() => {
    const handleDraftSubmit = async (e: any) => {
      const { projectId, name, path } = e.detail;
      if (projectId !== lastCreatedProjectId) return;

      // Update project in DB
      const updates: any = {};
      if (name) updates.name = name;
      if (path) updates.path = path;
      await updateProject(projectId, updates);

      setLastCreatedProjectId(null);
      setPreviousProjectId(null);
      setEditingProjectId(null);

      // Create Terminal 1 now that project is confirmed
      const { openProjects: op, createTab: ct, setProjectView: spv } = useWorkspaceStore.getState();
      const ws = op.get(projectId);
      if (ws && ws.tabs.size === 0) {
        // Don't pass __unset__ paths — createTab will fallback to HOME
        const cwd = path || (ws.projectPath?.startsWith('__unset__') ? undefined : ws.projectPath);
        await ct(projectId, 'Terminal 1', cwd);
        spv(projectId, 'terminal');
      }
    };

    const handleDraftCancel = (e: any) => {
      const { projectId } = e.detail;
      if (projectId !== lastCreatedProjectId) return;
      handleCancelProjectRename(projectId);
    };

    // Bidirectional name sync: when ProjectHome changes name, update title bar display/edit value
    const handleNameSync = (e: any) => {
      const id = e.detail.projectId;
      if (e.detail.source === 'titlebar') return;
      // Update title bar edit value if editing this project
      if (id === editingProjectId) {
        setProjectEditValue(e.detail.name);
      }
      // Update title bar display name if this is a draft project
      if (id === lastCreatedProjectId) {
        setProjectEditValue(e.detail.name);
      }
    };

    // Start editing from ProjectHome pencil → also enable title bar input
    const handleEditStart = (e: any) => {
      const { projectId, name } = e.detail;
      setEditingProjectId(projectId);
      setProjectEditValue(name);
    };

    // End editing from ProjectHome → also disable title bar input
    const handleEditEnd = (e: any) => {
      const { projectId } = e.detail;
      if (editingProjectId === projectId) {
        setEditingProjectId(null);
      }
    };

    window.addEventListener('project:draft-submit', handleDraftSubmit);
    window.addEventListener('project:draft-cancel', handleDraftCancel);
    window.addEventListener('project:name-sync', handleNameSync);
    window.addEventListener('project:edit-start', handleEditStart);
    window.addEventListener('project:edit-end', handleEditEnd);
    return () => {
      window.removeEventListener('project:draft-submit', handleDraftSubmit);
      window.removeEventListener('project:draft-cancel', handleDraftCancel);
      window.removeEventListener('project:name-sync', handleNameSync);
      window.removeEventListener('project:edit-start', handleEditStart);
      window.removeEventListener('project:edit-end', handleEditEnd);
    };
  }, [lastCreatedProjectId, editingProjectId]);

  // Track process status via OSC 133 events
  useEffect(() => {
    let disposed = false;
    // Initial load: get state for all tabs
    const initProcessStatus = async () => {
      const allTabs: Array<{ tabId: string; commandType?: string }> = [];
      openProjects.forEach((workspace) => {
        workspace.tabs.forEach((tab: any, tabId) => {
          allTabs.push({ tabId, commandType: tab?.commandType });
        });
      });

      const newStatus = new Map<string, boolean>();
      await Promise.all(
        allTabs.map(async ({ tabId, commandType }) => {
          try {
            const state = await ipcRenderer.invoke('terminal:getCommandState', {
              tabId,
              caller: 'App.processStatusInit',
              expectedProcess: 'codex',
              allowProcessTreeLookup: commandType === 'codex',
            });
            newStatus.set(tabId, state?.isRunning || false);
          } catch {
            newStatus.set(tabId, false);
          }
        })
      );
      setProcessStatus(newStatus);
    };
    initProcessStatus();

    const syncCodexTurnBusy = async () => {
      const codexTabIds: string[] = [];
      openProjects.forEach((workspace) => {
        workspace.tabs.forEach((tab: any, tabId) => {
          if (tab?.commandType === 'codex' || tab?.codexSessionId) codexTabIds.push(tabId);
        });
      });
      await Promise.all(codexTabIds.map(async (tabId) => {
        const res = await ipcRenderer.invoke('codex:get-turn-state', tabId).catch(() => null);
        if (disposed || !res?.hasWatcher) return;
        if (res.catchUpPending) return;
        const busy = res.busy === true;
        const reason = busy
          ? 'task_started'
          : (res.outcomeKnown && res.lastOutcomeReason
            ? res.lastOutcomeReason
            : 'codex-outcome-unknown');
        useWorkspaceStore.getState().setAiBusy(tabId, busy, reason);
        setBusyTabs(prev => {
          const next = new Map(prev);
          if (busy) next.set(tabId, true);
          else next.delete(tabId);
          return next;
        });
      }));
    };
    syncCodexTurnBusy();

    // Listen for command start/finish
    const handleCommandStarted = (
      _: any,
      { tabId, commandType }: { tabId: string; commandType?: string },
    ) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, true);
        return next;
      });
      if (commandType === 'codex') {
        // A launch starts a new PTY/process generation. Any previous live
        // writer/launch settings are volatile and cannot cross this boundary.
        useWorkspaceStore.getState().updateCodexLiveState(tabId, {
          codexLiveModel: undefined,
          codexLiveEffort: undefined,
          codexLiveSettingsSessionId: undefined,
        });
        useWorkspaceStore.getState().updateCodexLiveServiceTier(tabId, {
          codexLiveServiceTier: undefined,
          codexLiveServiceTierSessionId: undefined,
          codexLiveServiceTierSource: undefined,
        });
      }
    };

    const handleCommandFinished = (
      _: any,
      { tabId, commandType }: { tabId: string; commandType?: string },
    ) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, false);
        return next;
      });
      const workspaceState = useWorkspaceStore.getState();
      let codexTabFinished = commandType === 'codex';
      if (!codexTabFinished) {
        for (const [, workspace] of workspaceState.openProjects) {
          const tab = workspace.tabs.get(tabId);
          if (tab) {
            codexTabFinished = tab.commandType === 'codex';
            break;
          }
        }
      }
      if (codexTabFinished) {
        workspaceState.updateCodexLiveState(tabId, {
          codexLiveModel: undefined,
          codexLiveEffort: undefined,
          codexLiveSettingsSessionId: undefined,
        });
      }
    };

    // PTY exit → Claude CLI is dead
    const handleTerminalExit = (_: any, tabId: string) => {
      const state = useWorkspaceStore.getState();
      state.setClaudeActive(tabId, false);
    };

    const applyClaudeVisualBusy = (tabId: string, busy: boolean, reason?: string) => {
      const state = useWorkspaceStore.getState();
      state.setClaudeBusy(tabId, busy);
      state.setAiBusy(tabId, busy, reason);
      setBusyTabs(prev => { const n = new Map(prev); if (busy) n.set(tabId, true); else n.delete(tabId); return n; });
    };

    const isNonClaudePtyAiTab = (tabId: string): boolean => {
      const state = useWorkspaceStore.getState();
      for (const ws of state.openProjects.values()) {
        const tab = ws.tabs.get(tabId);
        if (!tab) continue;
        return tab.commandType === 'codex' || tab.commandType === 'gemini';
      }
      return false;
    };

    // Claude CLI spinner busy/idle → track on sub-agent tab + project badge.
    // reason:'spinner' is a PTY-frame heuristic. Delay its false edge so the
    // visual shimmer is not unmounted during 30-90ms gaps between spinner frames;
    // RunAfter still consumes the raw IPC edge and ignores it separately.
    const handleClaudeBusyState = (_: any, data: { tabId: string; busy: boolean; reason?: string }) => {
      console.warn('[App:BusyState] tabId=' + data.tabId.slice(-8) + ' busy=' + data.busy + (data.reason ? ' reason=' + data.reason : ''));
      if (data.reason === 'spinner' && isNonClaudePtyAiTab(data.tabId)) {
        console.warn('[App:BusyState] ignore claude spinner for non-claude AI tabId=' + data.tabId.slice(-8));
        return;
      }
      const timers = claudeSpinnerVisualIdleTimersRef.current;
      const pendingTimer = timers.get(data.tabId);
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer);
        timers.delete(data.tabId);
      }

      if (!data.busy && data.reason === 'spinner') {
        const timer = window.setTimeout(() => {
          timers.delete(data.tabId);
          applyClaudeVisualBusy(data.tabId, false, data.reason);
        }, CLAUDE_SPINNER_VISUAL_IDLE_GRACE_MS);
        timers.set(data.tabId, timer);
        return;
      }

      applyClaudeVisualBusy(data.tabId, data.busy, data.reason);
      // Safety net for awaiting ⊆ busy: any turn-end clears a lingering awaiting flag
      // (user pressed Esc to cancel the whole turn instead of answering the question).
      if (!data.busy && data.reason !== 'spinner') {
        setAwaitingTabs(prev => { if (!prev.get(data.tabId)) return prev; const n = new Map(prev); n.delete(data.tabId); return n; });
      }
    };

    // AskUserQuestion bracket → project-tab purple glow. awaiting=true on PreToolUse,
    // false on PostToolUse/PostToolUseFailure. See fact-claude-awaiting-input.md.
    const handleAwaitingInput = (_: any, data: { tabId: string; awaiting: boolean }) => {
      setAwaitingTabs(prev => {
        if ((prev.get(data.tabId) || false) === data.awaiting) return prev;
        const n = new Map(prev);
        if (data.awaiting) n.set(data.tabId, true); else n.delete(data.tabId);
        return n;
      });
    };
    ipcRenderer.on('claude:awaiting-input', handleAwaitingInput);

    // SDK process-alive signal (single source for the control-bar indicator AND
    // the tab activity plate). Lives here (always-mounted) so the tab plate
    // updates even when the SDK tab component is unmounted (inactive tab).
    const handleSdkProcessState = (_: any, data: { tabId: string; alive: boolean }) => {
      useWorkspaceStore.getState().setSdkProcessAlive(data.tabId, data.alive);
    };

    // Resolve projectId by walking openProjects.tabs.has(tabId). Used by
    // PTY-respawn paths that only have tabId+cwd (no projectId hint).
    const findProjectIdByTabId = (tabId: string): string | null => {
      const state = useWorkspaceStore.getState();
      for (const [pid, ws] of state.openProjects) {
        if (ws.tabs.has(tabId)) return pid;
      }
      return null;
    };

    // Terminal MCP: restart a terminal (re-create PTY with same tabId)
    const handleMcpRestart = (_: any, data: { tabId: string; cwd: string; initialCommand?: string }) => {
      console.warn('[MCP:Terminal] Restarting PTY for tab:', data.tabId, 'cmd:', data.initialCommand || '(shell)');
      ipcRenderer.invoke('terminal:create', {
        tabId: data.tabId,
        projectId: findProjectIdByTabId(data.tabId),
        cwd: data.cwd,
        rows: 24,
        cols: 80,
        initialCommand: data.initialCommand || undefined,
      });
    };

    // Terminal MCP: create a new tab with optional command
    //
    // Routing priority:
    //   1. data.parentProjectId — authoritative project id propagated from
    //      Claude's PTY env (NOTED_PARENT_PROJECT_ID). Wins unconditionally.
    //   2. cwd longest-prefix match against open projects' projectPath. Old
    //      cwd-based fallback for callers without parent id.
    //   3. activeProjectId fallback only when nothing else owns the cwd —
    //      covers helper scripts/cwds outside any open project.
    // Без (1) сценарий: юзер смотрит на проект A, Claude бежит в B (внутри
    // того же инстанса), MCP create_tab отправляется → таб уходит в A (по
    // activeProjectId) или вообще в Default, потому что cwd может совпадать.
    const handleMcpCreate = async (_: any, data: { name?: string; cwd: string; command?: string; color?: string; parentProjectId?: string; background?: boolean }) => {
      const openInBackground = data.background !== false;
      console.warn('[MCP:Terminal] Creating new tab:', data.name || 'auto', 'cwd:', data.cwd, 'parentProjectId:', data.parentProjectId || '-', 'background:', openInBackground);
      const state = useWorkspaceStore.getState();
      let targetProjectId: string | null = null;

      if (data.parentProjectId) {
        if (state.openProjects.has(data.parentProjectId)) {
          targetProjectId = data.parentProjectId;
        } else {
          console.warn('[MCP:Terminal] parentProjectId=' + data.parentProjectId + ' not in openProjects, falling back to cwd routing');
        }
      }

      if (!targetProjectId) {
        let bestMatchLen = -1;
        for (const [pid, ws] of state.openProjects) {
          const p = (ws as any).projectPath;
          if (typeof p !== 'string' || !p || p.startsWith('__unset__')) continue;
          // exact or prefix match (data.cwd inside this open project)
          if (data.cwd === p || data.cwd.startsWith(p + '/')) {
            if (p.length > bestMatchLen) {
              bestMatchLen = p.length;
              targetProjectId = pid;
            }
          }
        }
      }

      // Fallback to activeProjectId only when no open project owns this cwd —
      // covers free-form cwds (helper scripts, /tmp work) that don't belong to any tab.
      if (!targetProjectId) targetProjectId = state.activeProjectId;
      if (!targetProjectId) return;

      const rawCommand = (data.command || '').trim();
      let pendingAction: any = undefined;
      let commandType: any = undefined;
      let sessionPatch: any = {};
      const sessionPattern = '([0-9a-fA-F-]{8,})';
      const codexForkMatch = rawCommand.match(new RegExp('^codex-f\\s+' + sessionPattern + '$', 'i'));
      const codexContinueMatch = rawCommand.match(new RegExp('^(?:codex-c|codex\\s+(?:resume|--resume))\\s+' + sessionPattern + '$', 'i'));
      const claudeForkMatch = rawCommand.match(new RegExp('^claude-f\\s+' + sessionPattern + '$', 'i'));
      const claudeContinueMatch = rawCommand.match(new RegExp('^(?:claude-c|claude\\s+--resume)\\s+' + sessionPattern + '$', 'i'));

      if (codexForkMatch) {
        pendingAction = { type: 'codex-fork', sessionId: codexForkMatch[1] };
        commandType = 'codex';
      } else if (codexContinueMatch) {
        pendingAction = { type: 'codex-continue', sessionId: codexContinueMatch[1] };
        commandType = 'codex';
        // Keep the resume source in pendingAction only. Codex may materialize a
        // linked child, so the active tab binding waits for writer proof.
      } else if (rawCommand === 'codex') {
        pendingAction = { type: 'codex-new' };
        commandType = 'codex';
      } else if (claudeForkMatch) {
        pendingAction = { type: 'claude-fork', sessionId: claudeForkMatch[1] };
        commandType = 'claude';
      } else if (claudeContinueMatch) {
        pendingAction = { type: 'claude-continue', sessionId: claudeContinueMatch[1] };
        commandType = 'claude';
        sessionPatch.claudeSessionId = claudeContinueMatch[1];
      } else if (rawCommand === 'claude' || rawCommand === 'claude-d') {
        pendingAction = { type: 'claude-new' };
        commandType = 'claude';
      } else if (rawCommand) {
        pendingAction = { type: 'shell-command' as const, command: rawCommand };
        commandType = 'devServer';
      }

      await state.createTab(targetProjectId, data.name, data.cwd, {
        commandType,
        color: (data.color || (commandType === 'codex' ? 'codex' : commandType === 'claude' ? 'claude' : rawCommand ? 'green' : undefined)) as any,
        pendingAction,
        nameSetManually: !!data.name,
        background: openInBackground,
        ...sessionPatch,
      } as any);
    };

    const handleMcpAiTab = (_: any, data: { tabId: string; engine: 'claude' | 'codex' | 'gemini'; sessionId?: string; reason?: string; writerProven?: boolean; writerProof?: string; previousSessionId?: string | null; writerGeneration?: string | null; carryCodexSettingsProof?: boolean; requiresExactCodexSettingsProof?: boolean; codexSettingsProof?: { model?: string; effort?: string; proofAt?: number; fast?: boolean } | null }) => {
      if (!data?.tabId || !data?.engine) return;
      const store = useWorkspaceStore.getState();
      if (data.engine === 'codex') {
        if (data.sessionId && data.writerProven === true) {
          const reason = data.reason || 'unknown';
          const currentSessionId = store.getCodexSessionId(data.tabId);
          if (data.previousSessionId
            && currentSessionId !== data.previousSessionId
            && currentSessionId !== data.sessionId) {
            console.warn('[CodexSessionGuard:R] ignore stale writer event tab=' + String(data.tabId).slice(-12)
              + ' source=' + data.previousSessionId.slice(0, 8)
              + ' session=' + data.sessionId.slice(0, 8)
              + ' current=' + String(currentSessionId || 'none').slice(0, 8)
              + ' generation=' + (data.writerGeneration || '-'));
            return;
          }
          // Adopt the proven writer before setTabCommandType triggers its generic
          // full-tab save, so that save cannot carry the renderer's stale source.
          store.setCodexSessionId(
            data.tabId,
            data.sessionId,
            reason as any,
            codexSessionAdoptionOptionsFromEvent(data),
          );
        } else if (data.sessionId) {
          console.warn('[CodexSessionGuard:R] ignore unproven session event tab=' + String(data.tabId).slice(-12)
            + ' session=' + data.sessionId.slice(0, 8)
            + ' reason=' + (data.reason || 'unknown')
            + ' proof=' + (data.writerProof || 'none'));
        }
        store.setTabCommandType(data.tabId, data.engine as any);
        return;
      }

      store.setTabCommandType(data.tabId, data.engine as any);
      if (data.engine === 'claude' && data.sessionId) {
        store.setClaudeSessionId(data.tabId, data.sessionId, 'unknown');
      }
    };

    const handleCodexModelMigrationPending = (
      _: any,
      data: {
        tabId?: string;
        launchId?: string;
        enteredAt?: number;
        clearDefaultModel?: boolean;
        clearDefaultEffort?: boolean;
        expectedDefaultModel?: string;
        expectedDefaultEffort?: string;
        sourceModel?: string;
        sourceEffort?: string;
        targetModel?: string;
        configPath?: string;
        configFingerprint?: string;
        configAlreadyTarget?: boolean;
      },
    ) => {
      if (!data?.tabId) return;
      // The launch pair that triggered the native migration is no longer a
      // valid description of the live TUI. Keep it unknown until main observes
      // Codex's exact post-Enter acknowledgement.
      useWorkspaceStore.getState().updateCodexState(data.tabId, {
        codexModel: undefined,
        codexEffort: undefined,
        codexSettingsProofAt: Number(data.enteredAt) || Date.now(),
        codexSettingsProofSessionId: undefined,
        codexModelMigrationPending: true,
        codexModelMigrationRestoreDefaultModel: data.clearDefaultModel === true,
        codexModelMigrationRestoreDefaultEffort: data.clearDefaultEffort === true,
        codexModelMigrationSourceModel: data.sourceModel || undefined,
        codexModelMigrationSourceEffort: data.sourceEffort || undefined,
        codexModelMigrationTargetModel: data.targetModel || undefined,
        codexModelMigrationConfigPath: data.configPath || undefined,
        codexModelMigrationConfigFingerprint: data.configFingerprint || undefined,
        codexModelMigrationConfigAlreadyTarget: data.configAlreadyTarget === true,
      });
      syncDefaultCodexSettingsMirror({
        ...(data.clearDefaultModel === true ? { model: 'none' } : {}),
        ...(data.clearDefaultEffort === true ? { effort: 'none' } : {}),
        ...(data.clearDefaultModel === true
          ? { expectedModel: data.expectedDefaultModel }
          : {}),
        ...(data.clearDefaultEffort === true
          ? { expectedEffort: data.expectedDefaultEffort }
          : {}),
      });
      console.warn('[CodexModelMigration:R] settings pending tab='
        + String(data.tabId).slice(-12)
        + ' launch=' + (data.launchId || '-'));
    };

    const handleCodexModelMigrationApplied = (
      _: any,
      data: {
        tabId?: string;
        launchId?: string;
        model?: string;
        effort?: string;
        proofAt?: number;
        proofSessionId?: string | null;
        updateDefaultModel?: boolean;
        updateDefaultEffort?: boolean;
        expectedDefaultModel?: string;
        expectedDefaultEffort?: string;
      },
    ) => {
      if (!data?.tabId || !data.model || !Number.isFinite(Number(data.proofAt))) {
        return;
      }
      useWorkspaceStore.getState().updateCodexState(data.tabId, {
        codexModel: data.model,
        ...(data.effort ? { codexEffort: data.effort } : {}),
        codexSettingsProofAt: Number(data.proofAt),
        // Explicit undefined is important here: before the first rollout the
        // saved resume source is not proof-owner for the new live process.
        codexSettingsProofSessionId: data.proofSessionId || undefined,
        codexModelMigrationPending: false,
        codexModelMigrationRestoreDefaultModel: false,
        codexModelMigrationRestoreDefaultEffort: false,
        codexModelMigrationSourceModel: undefined,
        codexModelMigrationSourceEffort: undefined,
        codexModelMigrationTargetModel: undefined,
        codexModelMigrationConfigPath: undefined,
        codexModelMigrationConfigFingerprint: undefined,
        codexModelMigrationConfigAlreadyTarget: undefined,
      });
      syncDefaultCodexSettingsMirror({
        ...(data.updateDefaultModel === true ? { model: data.model } : {}),
        ...(data.updateDefaultEffort === true && data.effort ? { effort: data.effort } : {}),
        ...(data.updateDefaultModel === true
          ? { expectedModel: data.expectedDefaultModel || 'none' }
          : {}),
        ...(data.updateDefaultEffort === true && data.effort
          ? { expectedEffort: data.expectedDefaultEffort || 'none' }
          : {}),
      });
      console.warn('[CodexModelMigration:R] settings applied tab='
        + String(data.tabId).slice(-12)
        + ' launch=' + (data.launchId || '-')
        + ' model=' + data.model
        + ' effort=' + (data.effort || 'unchanged')
        + ' owner=' + (data.proofSessionId ? data.proofSessionId.slice(0, 8) : 'pending-writer'));
    };

    ipcRenderer.on('terminal:mcp-restart', handleMcpRestart);
    ipcRenderer.on('terminal:mcp-create', handleMcpCreate);
    ipcRenderer.on('terminal:mcp-ai-tab', handleMcpAiTab);
    ipcRenderer.on('codex:model-migration-settings-pending', handleCodexModelMigrationPending);
    ipcRenderer.on('codex:model-migration-settings-applied', handleCodexModelMigrationApplied);

    // Mobile-web bridge: main process asks renderer to perform UI-state actions
    // (create SDK tab, send message via the renderer's selected model/effort,
    // load session history). Reply with same requestId so the HTTP handler in
    // web-server.js can resolve its bridgeRequest promise.
    const handleWebBridge = async (_: any, { requestId, action, payload }: { requestId: string; action: string; payload: any }) => {
      const startedAt = Date.now();
      console.log('[BridgeDiag:R] RECV rid=' + requestId + ' action=' + action);
      const reply = (ok: boolean, data?: any, error?: string) => {
        const elapsed = Date.now() - startedAt;
        console.log('[BridgeDiag:R] REPLY rid=' + requestId + ' action=' + action + ' ok=' + ok + ' elapsedMs=' + elapsed + ' err=' + (error || '-'));
        ipcRenderer.send('web:bridge-reply', { requestId, ok, data, error });
      };
      try {
        const state = useWorkspaceStore.getState();
        const findTab = (tabId?: string, projectId?: string | null): any | null => {
          if (!tabId) return null;
          if (projectId) {
            const scoped = state.openProjects.get(projectId)?.tabs.get(tabId);
            if (scoped) return scoped;
          }
          for (const ws of state.openProjects.values()) {
            const t = ws.tabs.get(tabId);
            if (t) return t;
          }
          return null;
        };
        const toolForTab = (tab: any | null): AgentHistoryTool | null => {
          if (!tab || tab.tabType === 'claude-sdk') return null;
          if (tab.commandType === 'codex') return 'codex';
          if (tab.commandType === 'claude') return 'claude';
          return null;
        };
        const sessionIdForTab = (tab: any | null, toolType: AgentHistoryTool | null): string | null => {
          if (!tab || !toolType) return null;
          return toolType === 'codex' ? (tab.codexSessionId || null) : (tab.claudeSessionId || null);
        };
        const waitForAgentLaunchAccepted = async (tabId: string, toolType: 'claude' | 'codex') => {
          return ipcRenderer.invoke('agent:get-launch-accepted', {
            tabId,
            toolType,
            timeoutMs: 5000,
            reason: 'web:createAgentTab',
          }).catch((err: any) => ({
            success: false,
            accepted: false,
            error: String(err?.message || err),
          }));
        };
        const describeAgentTab = (tabId?: string, projectId?: string | null) => {
          const tab = findTab(tabId, projectId);
          const toolType = toolForTab(tab);
          const runtime = toolType ? getHistoryAgentRuntime(toolType) : null;
          const sessionId = sessionIdForTab(tab, toolType);
          return { tab, toolType, runtime, sessionId };
        };
        const readClaudeMaterialization = async (tab: any | null) => {
          const sessionId = tab?.claudeSessionId || null;
          if (!sessionId) {
            return {
              materialized: false,
              conversationMaterialized: false,
              timelineCount: 0,
              canCopySessionId: false,
              materializationReason: 'no-session-id',
            };
          }
          try {
            const result = await ipcRenderer.invoke('claude:session-materialization', {
              sessionId,
              cwd: tab?.cwd || undefined,
            });
            const materialized = result?.materialized === true || result?.conversationMaterialized === true;
            return {
              ...(result || {}),
              materialized,
              conversationMaterialized: materialized,
              timelineCount: typeof result?.timelineCount === 'number' ? result.timelineCount : null,
              canCopySessionId: materialized,
              materializationReason: result?.reason || null,
            };
          } catch (e: any) {
            return {
              materialized: false,
              conversationMaterialized: false,
              timelineCount: null,
              canCopySessionId: false,
              materializationReason: 'materialization-check-failed',
              error: String(e?.message || e),
            };
          }
        };
        const maybeAutoTitleAfterMobileSend = (tabId: string, toolType: AgentHistoryTool, cwd?: string | null) => {
          const delays = [0, 700, 1800, 4000];
          const attempt = async (index: number) => {
            const latestStore = useWorkspaceStore.getState();
            let latestTab: any = null;
            for (const ws of latestStore.openProjects.values()) {
              const candidate = ws.tabs.get(tabId);
              if (candidate) {
                latestTab = candidate;
                break;
              }
            }
            if (!latestTab || latestTab.nameSetManually) return;
            const latestSessionId = toolType === 'codex' ? latestTab.codexSessionId : latestTab.claudeSessionId;
            if (!latestSessionId) {
              if (index + 1 < delays.length) window.setTimeout(() => void attempt(index + 1), delays[index + 1]);
              return;
            }
            const pending = latestStore.getPendingAutoTabTitle(tabId, toolType, latestSessionId);
            if (!pending) return;
            const result = await generateTabTitleFromSession({
              toolType,
              sessionId: latestSessionId,
              cwd: latestTab.cwd || cwd || undefined,
              tabId,
              source: 'mobile-send-auto-title',
              reason: 'mobile-send',
            });
            if (result.ok && result.title) {
              latestStore.autoRenameTab(tabId, result.title, { toolType, sessionId: latestSessionId });
              latestStore.consumePendingAutoTabTitle(tabId, toolType, latestSessionId);
              return;
            }
            if ((result.reason === 'no-user-prompt' || result.reason === 'timeline-error') && index + 1 < delays.length) {
              window.setTimeout(() => void attempt(index + 1), delays[index + 1]);
            }
          };
          void attempt(0);
        };
        const ensureProjectWorkspace = async (projectId?: string) => {
          if (!projectId) return null;
          let projectData: any = null;
          try {
            projectData = await ipcRenderer.invoke('project:getById', projectId);
          } catch {}
          let ws = useWorkspaceStore.getState().openProjects.get(projectId);
          if (!ws) {
            const projectsState = useProjectsStore.getState();
            if (!projectsState.projects?.[projectId]) {
              await projectsState.loadProjects();
            }
            const projectPath = projectData?.path || projectsState.projects?.[projectId]?.path;
            if (!projectPath) return null;
            await useWorkspaceStore.getState().openProject(projectId, projectPath, { background: true });
            ws = useWorkspaceStore.getState().openProjects.get(projectId) || null;
          }
          const dbPath = projectData?.path;
          if (ws && dbPath && ws.projectPath !== dbPath) {
            console.warn(
              '[BridgeDiag:R] refresh project path project=' + projectId.slice(-12) +
              ' old=' + (ws.projectPath || 'unset') +
              ' db=' + dbPath
            );
            ws.projectPath = dbPath;
            useWorkspaceStore.setState({
              openProjects: new Map(useWorkspaceStore.getState().openProjects)
            });
          }
          return useWorkspaceStore.getState().openProjects.get(projectId) || null;
        };
        const findTabProject = (tabId?: string): { projectId: string; tab: any } | null => {
          if (!tabId) return null;
          for (const [projectId, ws] of useWorkspaceStore.getState().openProjects) {
            const tab = ws.tabs.get(tabId);
            if (tab) return { projectId, tab };
          }
          return null;
        };
        if (action === 'getAppSettings') {
          const uiState = useUIStore.getState();
          return reply(true, { streamerMode: !!uiState.streamerMode });
        }
        if (action === 'setAppSettings') {
          const { streamerMode } = payload || {};
          const uiState = useUIStore.getState();
          if (typeof streamerMode === 'boolean') {
            uiState.setStreamerMode(streamerMode);
          }
          return reply(true, { streamerMode: !!useUIStore.getState().streamerMode });
        }
        if (action === 'ensureInboxProject') {
          const projectsState = useProjectsStore.getState();
          if (!projectsState.projects?.[INBOX_PROJECT_ID]) {
            await projectsState.loadProjects();
          }
          const latest = useWorkspaceStore.getState();
          if (!latest.openProjects.has(INBOX_PROJECT_ID)) {
            await latest.openProject(
              INBOX_PROJECT_ID,
              projectsState.projects?.[INBOX_PROJECT_ID]?.path || getInboxProjectPath(),
              { background: true }
            );
          }
          const inbox = useWorkspaceStore.getState().openProjects.get(INBOX_PROJECT_ID);
          return reply(true, {
            projectId: INBOX_PROJECT_ID,
            path: inbox?.projectPath || getInboxProjectPath(),
            isOpen: !!inbox,
          });
        }
        if (action === 'getOpenProjectIds') {
          // Live snapshot of which projects are currently open in the desktop UI.
          // Used by /api/projects to split the mobile list into Active vs Other.
          // awaitingIds = projects with ≥1 claude tab blocked on AskUserQuestion —
          // drives the rotating purple ring on the mobile project card.
          const awaitingIds: string[] = [];
          const completionNotificationCounts: Record<string, number> = {};
          for (const [projId, ws] of state.openProjects) {
            let anyAwaiting = false;
            let completionCount = 0;
            for (const t of ws.tabs.values()) {
              if ((t as any).completionNotificationFired) completionCount++;
              if (t.commandType !== 'claude') continue;
              try {
                const p = await ipcRenderer.invoke('claude:get-presence', t.tabId);
                if (p?.awaiting) anyAwaiting = true;
              } catch {}
            }
            if (anyAwaiting) awaitingIds.push(projId);
            if (completionCount > 0) completionNotificationCounts[projId] = completionCount;
          }
          return reply(true, {
            ids: Array.from(state.openProjects.keys()),
            activeProjectId: state.activeProjectId || null,
            awaitingIds,
            completionNotificationCounts,
          });
        }
        if (action === 'getProjectTabsLive') {
          // Live tabs from an open project in renderer Zustand. Used by
          // /api/projects/:id/tabs as a primary source (or fallback when
          // SQLite doesn't have the project — e.g. unsaved draft projects).
          const { projectId } = payload || {};
          if (!projectId) return reply(false, null, 'projectId required');
          const ws = state.openProjects.get(projectId);
          if (!ws) return reply(false, null, 'project not open in UI');
          const projectMeta = useProjectsStore.getState().projects?.[projectId];
          // Resolve the configurable status-marker palette once per call so each
          // tab can carry its assigned-category COLOR (not just the id) — mobile
          // has no access to useUIStore where the palette lives.
          const uiState = useUIStore.getState();
          const statusPalette = uiState.sessionStatuses || [];
          const statusColor = (statusId?: string | null) =>
            statusId ? (statusPalette.find((s: any) => s.id === statusId)?.color || null) : null;
          const tabs = await Promise.all(Array.from(ws.tabs.values()).map(async (t: any) => {
            let sessionStatus: AgentRuntimeStatus | null = null;
            let awaiting = false;
            let inputReady: boolean | null = null;
            let lastNotReady: any = null;
            let effectiveCodexSessionId = t.codexSessionId;
            let effectiveCodexReadSessionId: string | null = null;
            let codexWriterConfirmed = false;
            let codexWriterUsableForMutation = false;
            let codexConversationMaterialized = !!t.codexSessionId;
            let startupFailed = false;
	            let startupError: string | null = null;
	            const toolType = toolForTab(t);
	            const claudeMaterialization = toolType === 'claude'
	              ? await readClaudeMaterialization(t)
	              : null;
	            if (toolType) {
	              try {
	                const p = await getHistoryAgentRuntime(toolType).getPresence(t.tabId, projectId);
	                sessionStatus = p?.status || 'inactive';
                awaiting = toolType === 'claude' && !!p?.awaiting;
                inputReady = typeof p?.inputReady === 'boolean' ? p.inputReady : null;
                lastNotReady = (p as any)?.lastNotReady || null;
	                startupFailed = (p as any)?.startupFailed === true;
	                startupError = (p as any)?.startupError || null;
	                if (toolType === 'claude' && claudeMaterialization && (p as any)?.conversationMaterialized === true) {
	                  claudeMaterialization.conversationMaterialized = true;
	                  claudeMaterialization.materialized = true;
	                }
	                if (toolType === 'codex') {
	                  // Presence and identity must come from the same main-owned
	                  // process snapshot. A second IPC read can cross a writer
	                  // handoff and combine lifecycle generation N with identity
	                  // generation N+1 in one Project API response.
	                  const runtimeSession = (p as any)?.runtimeSnapshot as CodexRuntimeSessionSnapshot | null;
	                  const provenWriterSessionId = getConfirmedCodexWriterSessionId(runtimeSession);
                  effectiveCodexReadSessionId = getCodexRuntimeReadSessionId(runtimeSession);
                  const displaySessionId = getCodexDisplaySessionId(runtimeSession);
                  codexWriterConfirmed = !!provenWriterSessionId;
                  codexWriterUsableForMutation = !!provenWriterSessionId
                    && runtimeSession?.writerUsableForMutation === true;
                  codexConversationMaterialized = !!displaySessionId;
                  // Keep writer/display identity separate from the read-only
                  // Resume source carried above. A live tab publishes a writer
                  // here only after main has adopted it.
                  effectiveCodexSessionId = sessionStatus === 'inactive'
                    ? displaySessionId
                    : provenWriterSessionId;
                }
              } catch {
                sessionStatus = 'unknown';
                inputReady = false;
                if (toolType === 'codex') {
                  effectiveCodexSessionId = null;
                  effectiveCodexReadSessionId = null;
                  codexWriterConfirmed = false;
                  codexWriterUsableForMutation = false;
                }
              }
            }
            let startupDefaultsPending = false;
            let startupDefaultsReady = toolType !== 'claude';
            let startupDefaultsError: string | null = null;
            if (toolType === 'claude') {
              const projected = projectClaudeStatusThroughStartupDefaults(
                t.tabId,
                sessionStatus,
                inputReady,
                lastNotReady,
                startupFailed,
                startupError,
              );
              sessionStatus = projected.status;
              inputReady = projected.inputReady;
              lastNotReady = projected.lastNotReady;
              startupFailed = projected.startupFailed;
              startupError = projected.startupError;
              startupDefaultsPending = projected.startupDefaultsPending;
              startupDefaultsReady = projected.startupDefaultsReady;
              startupDefaultsError = projected.startupDefaultsError;
            }
            // Assigned category status (dev/bugfix/knowledge/custom) — id stored
            // on the tab, color looked up in the palette. Distinct from the
            // runtime sessionStatus above (which drives the loader/background).
            const statusId = t.sessionStatus || null;
            const statusMeta = statusId ? statusPalette.find((s: any) => s.id === statusId) : null;
            return {
              tabId: t.tabId,
              name: t.name,
              tabType: t.tabType || 'terminal',
              commandType: t.commandType,
              color: t.color || null,   // desktop TabColor — drives row bg on mobile
              cwd: t.cwd,
              filePath: t.filePath || null,
              claudeSessionId: t.claudeSessionId,
              codexSessionId: effectiveCodexSessionId,
              codexReadSessionId: effectiveCodexReadSessionId,
              codexWriterConfirmed,
              codexWriterUsableForMutation,
              geminiSessionId: t.geminiSessionId,
              conversationMaterialized: toolType === 'claude'
                ? claudeMaterialization?.conversationMaterialized === true
                : toolType === 'codex'
                  ? codexConversationMaterialized
                  : !!t.geminiSessionId,
              canResume: toolType === 'claude'
                ? sessionStatus === 'inactive' && claudeMaterialization?.conversationMaterialized === true
                : toolType === 'codex'
                  ? sessionStatus === 'inactive' && !!effectiveCodexSessionId
                  : false,
              canCopySessionId: toolType === 'claude'
                ? claudeMaterialization?.conversationMaterialized === true
                : toolType === 'codex'
                  ? !!effectiveCodexReadSessionId
                  : !!t.geminiSessionId,
              timelineCount: toolType === 'claude' ? claudeMaterialization?.timelineCount ?? null : null,
              materializationReason: toolType === 'claude'
                ? claudeMaterialization?.materializationReason || claudeMaterialization?.reason || null
                : toolType === 'codex'
                  ? (effectiveCodexSessionId ? 'codex-session-id' : 'no-session-id')
                  : null,
              sessionStatus,
              starting: sessionStatus === 'starting',
              stopping: sessionStatus === 'stopping',
              inputReady,
              lastNotReady,
              startupFailed,
              startupError,
              startupDefaultsPending,
              startupDefaultsReady,
              startupDefaultsError,
              awaiting,
              statusId,
              statusColor: statusMeta?.color || null,
              completionNotificationPersistent: !!t.completionNotificationPersistent,
              completionNotificationArmed: !!t.completionNotificationArmed,
              completionNotificationFired: !!t.completionNotificationFired,
              completionNotificationFiredAt: t.completionNotificationFiredAt || null,
              groupId: t.groupId || null,
              visualParentTabId: t.visualParentTabId || null,
              // Seed last-known context % so the native/web header pill shows a
              // value on open (parity with the SQLite path in web-server.js).
              contextPct: (typeof t.contextPct === 'number' && isFinite(t.contextPct)) ? t.contextPct : null,
            };
          }));
          const groups = (ws.tabGroups || []).map((g: any) => ({
            id: g.id,
            name: g.name,
            createdAt: g.createdAt || null,
            anchorTabId: g.anchorTabId || null,
            collapsed: !!g.collapsed,
            color: g.color || null,
            sessionStatus: g.sessionStatus || null,
            statusColor: statusColor(g.sessionStatus),
          }));
          return reply(true, {
            project: {
              id: projectId,
              name: projectMeta?.name || ws.projectPath?.split('/').pop() || projectId,
              path: projectMeta?.path || ws.projectPath,
              icon: projectMeta?.icon || null,
            },
            tabs,
            groups,
            statusMarker: { shape: uiState.statusMarker.shape, sizePx: uiState.statusMarker.sizePx },
            statuses: statusPalette.map((s: any) => ({ id: s.id, color: s.color, label: s.label })),
            streamerMode: !!uiState.streamerMode,
            processBar: {
              colorA: uiState.processBar.colorA,
              shimmerColor: uiState.processBar.shimmerColor,
              inheritedColor: uiState.processBar.inheritedColor,
              shimmerSpacingPct: uiState.processBar.shimmerSpacingPct,
              shimmerOpacityPct: uiState.processBar.shimmerOpacityPct,
              position: uiState.processBar.position,
            },
          });
        }
        if (action === 'getProjectCompletionNotifications') {
          const { projectId } = payload || {};
          if (!projectId) return reply(false, null, 'projectId required');
          const ws = state.openProjects.get(projectId);
          if (!ws) return reply(true, { tabs: {}, count: 0 });
          const tabs: Record<string, any> = {};
          let count = 0;
          for (const t of ws.tabs.values()) {
            const info = {
              completionNotificationPersistent: !!t.completionNotificationPersistent,
              completionNotificationArmed: !!t.completionNotificationArmed,
              completionNotificationFired: !!t.completionNotificationFired,
              completionNotificationFiredAt: t.completionNotificationFiredAt || null,
            };
            if (info.completionNotificationFired) count++;
            tabs[t.tabId || t.id] = info;
          }
          return reply(true, { tabs, count });
        }
        if (action === 'clearTabCompletionNotification') {
          const { tabId, keepPersistent = true } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          for (const [projectId, ws] of state.openProjects) {
            if (ws.tabs.has(tabId)) {
              state.clearTabCompletionNotification(projectId, tabId, { keepPersistent: keepPersistent !== false });
              return reply(true, { projectId, tabId });
            }
          }
          return reply(true, { tabId, notFound: true });
        }
        if (action === 'getStatusMarkerConfig') {
          // Mobile-web reads the desktop's status-marker palette + shape/size AND
          // the process-bar config (position/base color/shimmer) so it can render the
          // SAME left marker (category color + square/dot) AND the SAME loader
          // strip (переливающаяся полоска left/right edge) the desktop TabBar
          // draws. Source of truth is useUIStore (localStorage); there is no
          // second config — mobile is a pure mirror.
          const uiState = useUIStore.getState();
          return reply(true, {
            shape: uiState.statusMarker.shape,
            sizePx: uiState.statusMarker.sizePx,
            statuses: (uiState.sessionStatuses || []).map((s: any) => ({ id: s.id, color: s.color, label: s.label })),
            streamerMode: !!uiState.streamerMode,
            processBar: {
              colorA: uiState.processBar.colorA,
              shimmerColor: uiState.processBar.shimmerColor,
              inheritedColor: uiState.processBar.inheritedColor,
              shimmerSpacingPct: uiState.processBar.shimmerSpacingPct,
              shimmerOpacityPct: uiState.processBar.shimmerOpacityPct,
              position: uiState.processBar.position,
            },
          });
        }
        if (action === 'sendSDKMessage') {
          const { tabId, prompt, model, effort, thinking, cwd } = payload || {};
          if (!tabId || !prompt) return reply(false, null, 'tabId+prompt required');
          // Find the tab to pull defaults if caller didn't supply them
          let tab: any = null;
          for (const ws of state.openProjects.values()) {
            const t = ws.tabs.get(tabId);
            if (t) { tab = t; break; }
          }
          const sendCwd = cwd || tab?.cwd;
          const sendModel = model ?? tab?.sdkModel;
          const sendEffort = effort ?? tab?.sdkEffort ?? 'high';
          const sendThinking = thinking ?? (tab?.sdkThinking === false ? 'disabled' : 'adaptive');
          // Tell the SDK tab UI a prompt is incoming from outside so it pushes
          // its own user-bubble (the SDK doesn't always echo the user-message
          // back through claude-sdk:message immediately, and onNew is only
          // invoked when the LOCAL composer is the source of the prompt).
          window.dispatchEvent(new CustomEvent('claude-sdk:external-prompt', {
            detail: { tabId, text: prompt, source: 'web' },
          }));
          // resumeSessionId from the store — without this main reads its
          // in-memory sdkSessions Map which is wiped between turns, every
          // mobile prompt would start a fresh sessionId and lose all context.
          // See knowledge/fix-sdk-session-amnesia.md.
          const result = await ipcRenderer.invoke('claude-sdk:send-message', {
            tabId, cwd: sendCwd, prompt, model: sendModel, effort: sendEffort, thinking: sendThinking,
            resumeSessionId: tab?.claudeSessionId || null,
          });
          return reply(!!result?.success, result, result?.error);
        }
        if (action === 'renameTab') {
          const { tabId, name } = payload || {};
          if (!tabId || !name) return reply(false, null, 'tabId+name required');
          for (const [projectId, ws] of state.openProjects) {
            if (ws.tabs.has(tabId)) {
              state.renameTab(projectId, tabId, name);
              return reply(true, { tabId, name });
            }
          }
          return reply(false, null, 'tab not in any open project');
        }
        if (action === 'linkFileToTab') {
          const { tabId, filePath } = payload || {};
          if (!tabId || !filePath) return reply(false, null, 'tabId+filePath required');
          const result = await linkFileTab(filePath, tabId);
          return reply(true, result);
        }
        if (action === 'renameProject') {
          const { projectId, name } = payload || {};
          if (!projectId || !name) return reply(false, null, 'projectId+name required');
          const projectsState = useProjectsStore.getState();
          if (!projectsState.projects?.[projectId]) {
            return reply(false, null, 'project not found');
          }
          // updateProject persists {name} via project:save-metadata (SQLite) and
          // updates the in-memory map the desktop UI + /api/projects read from.
          await projectsState.updateProject(projectId, { name });
          return reply(true, { projectId, name });
        }
        if (action === 'createTabGroup') {
          const { projectId, name } = payload || {};
          if (!projectId) return reply(false, null, 'projectId required');
          const current = useWorkspaceStore.getState();
          const groupId = current.createTabGroup(projectId, name);
          if (!groupId) return reply(false, null, 'project not open in UI');
          const group = current.openProjects.get(projectId)?.tabGroups.find((g: any) => g.id === groupId) || null;
          return reply(true, { projectId, groupId, group });
        }
        if (action === 'renameTabGroup') {
          const { projectId, groupId, name } = payload || {};
          if (!projectId || !groupId || !name) return reply(false, null, 'projectId+groupId+name required');
          useWorkspaceStore.getState().renameTabGroup(projectId, groupId, name);
          return reply(true, { projectId, groupId, name });
        }
        if (action === 'toggleTabGroupCollapsed') {
          const { projectId, groupId } = payload || {};
          if (!projectId || !groupId) return reply(false, null, 'projectId+groupId required');
          useWorkspaceStore.getState().toggleTabGroupCollapsed(projectId, groupId);
          const group = useWorkspaceStore.getState().openProjects.get(projectId)?.tabGroups.find((g: any) => g.id === groupId) || null;
          return reply(true, { projectId, groupId, collapsed: !!group?.collapsed });
        }
        if (action === 'setTabGroupSessionStatus') {
          const { projectId, groupId, status } = payload || {};
          if (!projectId || !groupId) return reply(false, null, 'projectId+groupId required');
          useWorkspaceStore.getState().setTabGroupSessionStatus(projectId, groupId, status || null);
          return reply(true, { projectId, groupId, status: status || null });
        }
        if (action === 'deleteTabGroup') {
          const { projectId, groupId } = payload || {};
          if (!projectId || !groupId) return reply(false, null, 'projectId+groupId required');
          useWorkspaceStore.getState().deleteTabGroup(projectId, groupId);
          return reply(true, { projectId, groupId });
        }
        if (action === 'setTabSessionStatus') {
          const { tabId, status } = payload || {};
          const found = findTabProject(tabId);
          if (!found) return reply(false, null, 'tab not in any open project');
          useWorkspaceStore.getState().setTabSessionStatus(found.projectId, tabId, status || null);
          return reply(true, { tabId, status: status || null });
        }
        if (action === 'setCodexSessionId') {
          const { tabId, sessionId, reason } = payload || {};
          if (!tabId || !sessionId) return reply(false, null, 'tabId+sessionId required');
          const found = findTabProject(tabId);
          if (!found) return reply(false, null, 'tab not in any open project');
          if (found.tab?.commandType !== 'codex') return reply(false, null, 'tab is not Codex');
          const committed = await useWorkspaceStore.getState().setCodexSessionId(tabId, sessionId, reason || 'api-edit-range');
          if (!committed) return reply(false, null, 'Codex session binding could not be committed');
          return reply(true, { tabId, sessionId });
        }
        if (action === 'applyTabLayout') {
          const { projectId, orderedIds, groupAssignments, visualParentAssignments, groupAnchorAssignments } = payload || {};
          if (!projectId || !Array.isArray(orderedIds)) return reply(false, null, 'projectId+orderedIds required');
          useWorkspaceStore.getState().applyTabLayout(
            projectId,
            orderedIds,
            groupAssignments || {},
            visualParentAssignments || {},
            groupAnchorAssignments || {}
          );
          return reply(true, { projectId });
        }
        if (action === 'getSDKParams') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          for (const ws of state.openProjects.values()) {
            const t = ws.tabs.get(tabId);
            if (!t) continue;
            // PTY+Claude: current-session model/effort come from the same
            // confirmed active JSONL branch as the desktop ControlBar. The
            // renderer sentinels are only dedupe locks and miss manual terminal
            // commands; StatusBar defaults describe future launches, not this
            // conversation.
            // Thinking is always "adaptive" on PTY — controlled by claude:toggle-thinking,
            // not surfaced as a separate param in the mobile UI here.
            if (t.commandType === 'claude' && t.tabType !== 'claude-sdk') {
              let model = 'default';
              let confirmedEffort: string | null = null;
              try {
                const confirmed = await ipcRenderer.invoke('claude:get-confirmed-settings', {
                  tabId,
                  sessionId: t.claudeSessionId,
                  cwd: t.cwd,
                });
                if (
                  confirmed?.success === true
                  && confirmed.sessionId === t.claudeSessionId
                ) {
                  if (confirmed.model) model = confirmed.model;
                  confirmedEffort = confirmed.effort || null;
                }
              } catch {}
              try {
                const meta = await ipcRenderer.invoke('claude:get-bridge-metadata', tabId);
                const rawModel = (meta?.model || '').toLowerCase();
                if (!model || model === 'default') {
                  if (rawModel.includes('1m')) model = 'default';
                  else if (rawModel.includes('opus')) model = 'opus';
                  else if (rawModel.includes('sonnet')) model = 'sonnet';
                  else if (rawModel.includes('haiku')) model = 'haiku';
                }
              } catch {}
              // Think state: same invisible-intent model. Tracked in a shared
              // window map written by the desktop ControlBar's toggleThink AND
              // mobile setSDKParams below. Default ON (Claude boots with
              // alwaysThinkingEnabled:true), so absent → 'adaptive'.
              const thinkMap = (window as any).__thinkStateForTab as Map<string, boolean> | undefined;
              const thinkOn = thinkMap?.has(tabId) ? thinkMap.get(tabId)! : true;
              // Context % travels in the SAME params bundle as model/effort so the
              // native client gets a COMPLETE runtime snapshot in one on-open fetch
              // — no more "model shows instantly, % appears ~30s later when the
              // next bridge-update happens to fire". Live value from bridgeMetadata,
              // last-known fallback from SQLite (same seed the desktop meter uses).
              let contextPct: number | null = null;
              try {
                const meta = await ipcRenderer.invoke('claude:get-bridge-metadata', tabId);
                if (typeof meta?.contextPct === 'number' && meta.contextPct > 0) contextPct = meta.contextPct;
              } catch {}
              if (contextPct == null) {
                try {
                  const r = await ipcRenderer.invoke('tab:get-context-pct', { tabId });
                  if (typeof r?.pct === 'number' && r.pct > 0) contextPct = r.pct;
                } catch {}
              }
              return reply(true, {
                tabId,
                model,
                effort: confirmedEffort || '?',
                thinking: thinkOn ? 'adaptive' : 'disabled',
                contextPct,
              });
            }
            if (t.commandType === 'codex' && t.tabType !== 'claude-sdk') {
              // Codex has no bridge metadata; last-known % lives in SQLite (written
              // by emitCodexContextPct's persist path). Same on-open seed contract.
              let contextPct: number | null = null;
              try {
                const r = await ipcRenderer.invoke('tab:get-context-pct', { tabId });
                if (typeof r?.pct === 'number' && r.pct > 0) contextPct = r.pct;
              } catch {}
              const ui = useUIStore.getState();
              const defaultModel = cleanDefaultSetting(ui.defaultCodexModel) || DEFAULT_CODEX_MODEL;
              const defaultEffort = cleanDefaultSetting(ui.defaultCodexEffort) || DEFAULT_CODEX_EFFORT;
              const effective = resolveCodexEffectiveSettings({
                codexSessionId: t.codexSessionId,
                codexModel: t.codexModel || defaultModel,
                codexEffort: t.codexEffort || defaultEffort,
                codexLiveModel: t.codexLiveModel,
                codexLiveEffort: t.codexLiveEffort,
                codexLiveSettingsSessionId: t.codexLiveSettingsSessionId,
              });
              return reply(true, {
                tabId,
                model: effective.model || defaultModel,
                effort: effective.effort || defaultEffort,
                thinking: 'disabled',
                contextPct,
              });
            }
            // SDK path
            return reply(true, {
              tabId,
              model: t.sdkModel || 'default',
              effort: t.sdkEffort || 'high',
              thinking: t.sdkThinking === false ? 'disabled' : 'adaptive',
              contextPct: (typeof t.contextPct === 'number' && t.contextPct > 0) ? t.contextPct : null,
            });
          }
          return reply(false, null, 'tab not open');
        }
        if (action === 'sendCodexFast') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const found = findTabProject(tabId);
          if (!found) return reply(false, null, 'tab not open');
          const tab: any = found.tab;
          if (tab.commandType !== 'codex' || tab.tabType === 'claude-sdk') {
            return reply(false, null, 'tab is not Codex PTY');
          }

          const turnState = await ipcRenderer.invoke('codex:get-turn-state', tabId).catch(() => null);
          const processInfo = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId).catch(() => null);
          const processText = `${processInfo?.processName || ''} ${processInfo?.command || ''}`;
          const hasLiveCodexProcess = processInfo?.hasProcess === true && /(\bcodex\b|@openai\/codex)/i.test(processText);
          const hasLiveWatcher = turnState?.hasWatcher === true || hasLiveCodexProcess;
          if (!hasLiveWatcher) {
            return reply(false, null, 'codex /fast requires a live Codex process');
          }

          const draftState = await ipcRenderer.invoke('codex:get-draft-state', tabId, {
            reason: 'mobile-codex-fast',
            timeoutMs: 700,
          }).catch((error: any) => {
            console.warn('[MobileBridge] codex-fast draft probe failed tab=' + String(tabId).slice(-12) + ': ' + (error?.message || String(error)));
            return terminalRegistry.getCodexDraftState(tabId);
          });
          console.log('[MobileBridge] codex-fast live tab=' + String(tabId).slice(-12) + ' hasDraft=' + draftState.hasDraft + ' source=' + draftState.source + ' turnBusy=' + (turnState?.busy === true));
          if (turnState?.busy === true && draftState.hasDraft === true) {
            return reply(false, null, 'codex /fast blocked while busy composer has draft');
          }
          if (draftState.hasDraft === null) {
            return reply(false, null, 'codex input state unknown: ' + draftState.source);
          }

          const result = await ipcRenderer.invoke('codex:send-live-slash-command', {
            tabId,
            command: '/fast',
            hasDraft: draftState.hasDraft,
            draftSource: 'mobile:' + draftState.source,
            draftPreview: draftState.preview,
            visualHasDraft: draftState.hasDraft,
            visualSource: draftState.source,
            visualPreview: draftState.preview,
            turnBusy: turnState?.busy === true,
          });
          console.log('[MobileBridge] codex-fast result tab=' + String(tabId).slice(-12) + ' result=' + JSON.stringify(result || null));
          if (!result?.success) {
            return reply(false, null, result?.error || 'codex /fast failed');
          }
          return reply(true, {
            tabId,
            applied: true,
            serviceTier: result.serviceTier || null,
            serviceTierSource: result.serviceTierSource || null,
            notice: result.notice || null,
          });
        }
        if (action === 'setSDKParams') {
          const { tabId, model, effort, thinking } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          let tab: any = null;
          for (const ws of state.openProjects.values()) {
            const t = ws.tabs.get(tabId);
            if (t) { tab = t; break; }
          }
          if (!tab) return reply(false, null, 'tab not open');
          // PTY+Claude: dispatch slash commands. /model X works any time;
          // /effort Y only takes effect when Claude is at the prompt — but
          // safePasteAndSubmit serialises via its per-term mutex, so even
          // during a turn the command queues correctly.
          if (tab.commandType === 'claude' && tab.tabType !== 'claude-sdk') {
            if (model !== undefined) {
              const modelSentinel = (window as any).__modelSentForTab as Map<string, { at: number; via: string; model: string }> | undefined;
              const previousModelSentinel = modelSentinel?.get(tabId);
              if (modelSentinel) modelSentinel.set(tabId, { at: Date.now(), via: 'mobile-click', model });
              try {
                await applyClaudePtySetting({
                  tabId,
                  kind: 'model',
                  value: model,
                  source: 'mobile:set-model',
                });
              } catch (error: any) {
                if (modelSentinel) {
                  if (previousModelSentinel) modelSentinel.set(tabId, previousModelSentinel);
                  else modelSentinel.delete(tabId);
                }
                return reply(false, null, 'Claude model was not confirmed: ' + String(error?.message || error));
              }
            }
            if (effort !== undefined) {
              // Update the cross-client sentinel so a subsequent getParams (desktop
              // ControlBar or another phone) reads the value we just applied —
              // same map the auto-inject paths write. Mirrors desktop manual-click.
              const sentinel = (window as any).__effortSentForTab as Map<string, { at: number; via: string; level: string }> | undefined;
              const previousEffortSentinel = sentinel?.get(tabId);
              if (sentinel) sentinel.set(tabId, { at: Date.now(), via: 'mobile-click', level: effort });
              try {
                await applyClaudePtySetting({
                  tabId,
                  kind: 'effort',
                  value: effort,
                  source: 'mobile:set-effort',
                });
              } catch (error: any) {
                if (sentinel) {
                  if (previousEffortSentinel) sentinel.set(tabId, previousEffortSentinel);
                  else sentinel.delete(tabId);
                }
                return reply(false, null, 'Claude effort was not confirmed: ' + String(error?.message || error));
              }
            }
            // Think toggle for PTY: claude:toggle-thinking FLIPS the meta+t
            // picker and returns the new absolute state. We only fire it when the
            // requested state differs from what we last tracked, so re-selecting
            // the same value is a no-op (the picker is a toggle, not a setter).
            if (thinking !== undefined) {
              const want = thinking !== 'disabled';
              const thinkMap: Map<string, boolean> = (window as any).__thinkStateForTab
                || ((window as any).__thinkStateForTab = new Map());
              const cur = thinkMap.has(tabId) ? thinkMap.get(tabId)! : true; // default ON
              if (cur !== want) {
                try {
                  const r = await ipcRenderer.invoke('claude:toggle-thinking', tabId);
                  // Trust the reconciled state if the handler reports it.
                  if (r?.success && typeof r.thinking === 'boolean') thinkMap.set(tabId, r.thinking);
                  else thinkMap.set(tabId, want);
                } catch { thinkMap.set(tabId, want); }
              }
            }
            return reply(true, { tabId, model, effort, thinking });
          }
          if (tab.commandType === 'codex' && tab.tabType !== 'claude-sdk') {
            const ui = useUIStore.getState();
            const defaultModel = cleanDefaultSetting(ui.defaultCodexModel) || DEFAULT_CODEX_MODEL;
            const defaultEffort = cleanDefaultSetting(ui.defaultCodexEffort) || DEFAULT_CODEX_EFFORT;

            const runtimeSnapshot = await ipcRenderer.invoke('codex:get-runtime-session', { tabId })
              .catch((error: any) => {
                console.warn('[MobileBridge] codex-set-params runtime owner lookup failed tab='
                  + String(tabId).slice(-12)
                  + ': ' + (error?.message || String(error)));
                return null;
              });
            const {
              runtimeState: codexRuntimeState,
              activeWriterSessionId,
            } = resolveCodexSettingsRuntimeProof(runtimeSnapshot);
            // Unknown process state is not proof that Codex stopped. Keep it on
            // the live/fail-closed path so a transient lookup failure cannot turn
            // a partial request into future config for the wrong conversation.
            const shouldUseLivePicker = codexRuntimeState !== 'stopped';
            const effectiveSettings = resolveCodexEffectiveSettings({
              codexSessionId: tab.codexSessionId,
              codexModel: cleanDefaultSetting(tab.codexModel)
                || (codexRuntimeState === 'stopped' ? defaultModel : undefined),
              codexEffort: cleanDefaultSetting(tab.codexEffort)
                || (codexRuntimeState === 'stopped' ? defaultEffort : undefined),
              codexLiveModel: tab.codexLiveModel,
              codexLiveEffort: tab.codexLiveEffort,
              codexLiveSettingsSessionId: tab.codexLiveSettingsSessionId,
            });
            const currentModel = effectiveSettings.model;
            const currentEffort = effectiveSettings.effort;
            const settingsPlan = planCodexHistorySettings({
              requestedModel: model,
              requestedEffort: effort,
              currentModel,
              currentEffort,
              currentProofSessionId: effectiveSettings.liveOwned
                ? tab.codexLiveSettingsSessionId
                : tab.codexSettingsProofSessionId,
              runtimeSnapshot,
              statusAtSend: runtimeSnapshot?.busy === true ? 'busy' : 'active',
              queue: false,
            });
            if (settingsPlan.blocked) {
              const error = settingsPlan.code === 'codex_settings_change_requires_idle'
                ? 'Codex model/effort cannot change while a turn is busy'
                : settingsPlan.error;
              return reply(false, { code: settingsPlan.code }, error);
            }
            const requestedModel = settingsPlan.model;
            const requestedEffort = settingsPlan.effort;

            // `thinking` is not a Codex PTY setting. Do not reopen `/model`
            // merely because a generic client sent that field alone.
            if (!settingsPlan.hasRequestedSettings) {
              return reply(true, {
                tabId,
                model: currentModel || '?',
                effort: currentEffort || '?',
                thinking: 'disabled',
                applied: false,
              });
            }

            if (shouldUseLivePicker) {
              const draftState = await ipcRenderer.invoke('codex:get-draft-state', tabId, {
                reason: 'mobile-codex-set-params',
                timeoutMs: 700,
              }).catch((error: any) => {
                console.warn('[MobileBridge] codex-set-params draft probe failed tab=' + String(tabId).slice(-12) + ': ' + (error?.message || String(error)));
                return terminalRegistry.getCodexDraftState(tabId);
              });
              console.log('[MobileBridge] codex-set-params live tab=' + String(tabId).slice(-12) + ' model=' + requestedModel + ' effort=' + requestedEffort + ' hasDraft=' + draftState.hasDraft + ' source=' + draftState.source);
              if (draftState.hasDraft === null) {
                return reply(false, null, 'codex input state unknown: ' + draftState.source);
              }
              const result = await ipcRenderer.invoke('codex:select-model-effort', {
                tabId,
                model: requestedModel,
                effort: requestedEffort,
                expectedWriterSessionId: isCompleteCodexSettingsRequest({
                  requestedModel: model,
                  requestedEffort: effort,
                })
                  ? undefined
                  : activeWriterSessionId,
                allowTurnBusy: false,
                hasDraft: draftState.hasDraft,
                draftSource: 'mobile:' + draftState.source,
                draftPreview: draftState.preview,
                visualHasDraft: draftState.hasDraft,
                visualSource: draftState.source,
                visualPreview: draftState.preview,
              });
              console.log('[MobileBridge] codex-set-params result tab=' + String(tabId).slice(-12) + ' result=' + JSON.stringify(result || null));
              const appliedWithProof = result?.applied === true
                && !!(result?.applicationProofSource || result?.configProofSource);
              if (!result?.success && !appliedWithProof) {
                return reply(false, null, result?.error || 'codex picker failed');
              }
              const appliedPlan = planCodexPickerStateApplication({
                result,
                requestedModel,
                requestedEffort,
                liveSessionId: result?.codexSettingsProofSessionId
                  || activeWriterSessionId
                  || tab.codexSessionId,
                currentPersistentModel: tab.codexModel,
                currentPersistentEffort: tab.codexEffort,
              });
              if (!appliedPlan.allowed) {
                return reply(false, {
                  code: appliedPlan.code,
                }, 'Codex did not prove which live session owns these settings');
              }
              if (Object.keys(appliedPlan.persistentPatch || {}).length > 0) {
                state.updateCodexState(tabId, appliedPlan.persistentPatch);
              }
              state.updateCodexLiveState(tabId, appliedPlan.livePatch);
              if (!result?.success) {
                return reply(false, {
                  tabId,
                  model: appliedPlan.model ?? currentModel,
                  effort: appliedPlan.effort ?? currentEffort,
                  thinking: 'disabled',
                  applied: true,
                }, result?.error || 'Codex settings changed, but the input text could not be restored');
              }
              return reply(true, {
                tabId,
                model: appliedPlan.model ?? currentModel,
                effort: appliedPlan.effort ?? currentEffort,
                thinking: 'disabled',
                applied: true,
              });
            }

            // No live process: persist the complete pair for the next launch.
            // A later global-default edit must not silently change the inherited
            // half of this explicit per-tab choice.
            if (requestedEffort === 'ultra') {
              return reply(
                false,
                { code: 'codex_ultra_requires_live_conversation' },
                'Codex Ultra can only be applied to a running conversation',
              );
            }
            const futurePatch = {
              codexModel: requestedModel,
              codexEffort: requestedEffort,
            };
            state.updateCodexState(tabId, futurePatch);
            return reply(true, {
              tabId,
              model: futurePatch.codexModel,
              effort: futurePatch.codexEffort,
              thinking: 'disabled',
              applied: false,
            });
          }
          // SDK path
          const partial: any = {};
          if (model !== undefined) partial.sdkModel = model;
          if (effort !== undefined) partial.sdkEffort = effort;
          if (thinking !== undefined) partial.sdkThinking = thinking !== 'disabled';
          state.updateSDKState(tabId, partial);
          return reply(true, { tabId, ...partial });
        }
        const getPromptQueueAiTabs = (ownerTabId: string) => {
          let ownerProjectId: string | null = null;
          for (const [projectId, ws] of state.openProjects) {
            if (ws.tabs.has(ownerTabId)) {
              ownerProjectId = projectId;
              break;
            }
          }

          const projectLabel = (projectPath: string | undefined, projectId: string): string => {
            const clean = (projectPath || '').replace(/[\\/]+$/, '');
            return clean.split(/[\\/]/).filter(Boolean).pop() || projectId.slice(-8);
          };

          const aiTabs: Array<{
            id: string;
            name: string;
            kind: 'claude-pty' | 'claude-sdk' | 'gemini' | 'codex';
            projectId: string;
            projectName: string;
            isOwnerProject: boolean;
          }> = [];

          for (const [projectId, ws] of state.openProjects) {
            for (const t of ws.tabs.values()) {
              if (t.parentTabId) continue;
              if (t.id === ownerTabId) continue;
              const isSDK = t.tabType === 'claude-sdk';
              const isClaudePTY = !isSDK && t.commandType === 'claude' && !!t.claudeSessionId;
              const isCodex = !isSDK && t.commandType === 'codex' && !!t.codexSessionId;
              const isGemini = !isSDK && t.commandType === 'gemini' && !!t.geminiSessionId;
              let kind: 'claude-pty' | 'claude-sdk' | 'gemini' | 'codex' | null = null;
              if (isSDK) kind = 'claude-sdk';
              else if (isClaudePTY) kind = 'claude-pty';
              else if (isCodex) kind = 'codex';
              else if (isGemini) kind = 'gemini';
              if (!kind) continue;
              aiTabs.push({
                id: t.id,
                name: t.name || t.id.slice(-6),
                kind,
                projectId,
                projectName: projectLabel(ws.projectPath, projectId),
                isOwnerProject: projectId === ownerProjectId,
              });
            }
          }

          return aiTabs;
        };

        if (action === 'getPromptQueue') {
          // Mobile mirror of the desktop Prompt Queue ("Run after"). Mobile does
          // NOT own a queue — it reads the live desktop store and pushes mutations
          // back here; the App-root usePromptQueueRunner does all firing. So this
          // returns the same PromptQueueCore the desktop overlay renders from, plus
          // the list of sibling AI-tabs (for the "on tab" pivot picker) in the same
          // order/kind the desktop RunAfterTabPicker shows.
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const q = usePromptQueueStore.getState().getQueue(tabId);
          const core = serializePromptQueueCore(q);
          return reply(true, { tabId, queue: core, aiTabs: getPromptQueueAiTabs(tabId) });
        }
        if (action === 'mutatePromptQueue') {
          // Apply ONE mutation op to the desktop queue store. Every op maps to an
          // existing store method so cascade rules (closeAfter⟹stopAfter, hint
          // arming, SQLite persistence, auto-disarm) stay identical to desktop —
          // we never reimplement the queue logic, only remote-invoke it. The
          // App-root runner then fires on the next busy→idle edge exactly as if
          // the desktop overlay had made the change.
          const { tabId, op, args } = payload || {};
          if (!tabId || !op) return reply(false, null, 'tabId+op required');
          const s = usePromptQueueStore.getState();
          const a = args || {};
          try {
            switch (op) {
              case 'add':            s.addPrompt(tabId, String(a.text || ''), undefined, undefined, typeof a.title === 'string' ? a.title : undefined); break;
              case 'remove':         s.removePrompt(tabId, String(a.id)); break;
              case 'update':         s.updatePrompt(tabId, String(a.id), {
                text: typeof a.text === 'string' ? a.text : undefined,
                title: typeof a.title === 'string' ? a.title : undefined,
                titleManual: typeof a.titleManual === 'boolean' ? a.titleManual : undefined,
                enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined,
              }); break;
              case 'reorder':        s.reorderPrompt(tabId, Number(a.fromIndex), Number(a.toIndex)); break;
              case 'clear':          for (const it of s.getQueue(tabId).items) s.removePrompt(tabId, it.id); break;
              case 'setAutoRun':     s.setAutoRun(tabId, !!a.value); break;
              case 'setStopAfter':   s.setStopAfter(tabId, !!a.value); break;
              case 'setCloseAfter':  s.setCloseAfter(tabId, !!a.value); break;
              case 'setRunAfterTab': s.setRunAfterTab(tabId, a.value == null ? null : String(a.value)); break;
              case 'setFirstDelaySeconds': s.setFirstDelaySeconds(tabId, Number(a.value) || 0); break;
              case 'setPostPromptEnabled': s.setPostPromptEnabled(tabId, !!a.value); break;
              case 'setPostPromptText':    s.setPostPromptText(tabId, String(a.value ?? '')); break;
              case 'setLoopPromptEnabled': s.setLoopPromptEnabled(tabId, !!a.value); break;
              case 'setLoopPromptText':    s.setLoopPromptText(tabId, String(a.value ?? '')); break;
              default: return reply(false, null, 'unknown op: ' + op);
            }
          } catch (e: any) {
            return reply(false, null, 'mutate failed: ' + String(e?.message || e));
          }
          // Echo the new core so the caller can render immediately without a
          // round-trip; the queue-update SSE event will also fan-out shortly.
          return reply(true, {
            tabId,
            queue: serializePromptQueueCore(usePromptQueueStore.getState().getQueue(tabId)),
            aiTabs: getPromptQueueAiTabs(tabId),
          });
        }
        if (action === 'getTabSessionInfo') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { tab, toolType, sessionId } = describeAgentTab(tabId);
          if (tab) {
            const codexResolution = toolType === 'codex'
              ? await resolveCodexSurfaceSession({
                tabId,
                operation: 'Получить информацию о сессии',
              })
              : null;
            const effectiveSessionId = toolType === 'codex'
              ? codexResolution?.sessionId || null
              : sessionId;
            return reply(true, {
              tabId,
              toolType,
              commandType: tab.commandType || null,
              sessionId: effectiveSessionId,
              claudeSessionId: tab.claudeSessionId || null,
              codexSessionId: toolType === 'codex' ? effectiveSessionId : null,
              codexLiveLifecycle: codexResolution?.liveLifecycle ?? null,
              codexWriterConfirmed: codexResolution?.writerConfirmed ?? false,
              codexSessionSource: codexResolution?.source || null,
              geminiSessionId: tab.geminiSessionId || null,
              cwd: tab.cwd,
            });
          }
          return reply(true, {
            tabId,
            toolType: null,
            commandType: null,
            sessionId: null,
            claudeSessionId: null,
            codexSessionId: null,
            geminiSessionId: null,
            cwd: null,
          });
        }
        if (action === 'truncateHistory') {
          const { tabId, targetUuid } = payload || {};
          if (!tabId || !targetUuid) return reply(false, null, 'tabId+targetUuid required');
          let sid: string | undefined, tabCwd: string | undefined;
          for (const ws of state.openProjects.values()) {
            const t = ws.tabs.get(tabId);
            if (t) { sid = t.claudeSessionId; tabCwd = t.cwd; break; }
          }
          if (!sid) return reply(false, null, 'no session for tab');
          const result = await ipcRenderer.invoke('claude-sdk:truncate-history', {
            sessionId: sid, cwd: tabCwd, targetUuid,
          });
          return reply(!!result?.success, result, result?.error);
        }
        if (action === 'forkToTab') {
          const { tabId: srcTabId } = payload || {};
          if (!srcTabId) return reply(false, null, 'tabId required');
          let srcTab: any = null;
          let projectId: string | null = null;
          for (const [pid, ws] of state.openProjects) {
            const t = ws.tabs.get(srcTabId);
            if (t) { srcTab = t; projectId = pid; break; }
          }
          if (!srcTab || !projectId) return reply(false, null, 'source tab not open');

          const declaredType = String(srcTab.commandType || srcTab.toolType || '').toLowerCase();
          const sessionType = declaredType.includes('codex') || (!!srcTab.codexSessionId && !declaredType.includes('claude'))
            ? 'codex'
            : declaredType.includes('claude') || srcTab.tabType === 'claude-sdk' || !!srcTab.claudeSessionId
              ? 'claude'
              : null;
          let sessionId = sessionType === 'codex' ? srcTab.codexSessionId : srcTab.claudeSessionId;
          if (sessionType === 'codex') {
            sessionId = await requireCodexSurfaceSessionId({
              tabId: srcTabId,
              operation: 'Создать fork',
              requireMutationSafe: true,
            });
          }
          if (!sessionType || !sessionId) return reply(false, null, 'source tab has no forkable Claude/Codex session');

          if (sessionType === 'claude' && srcTab.tabType !== 'claude-sdk') {
            const materialization = await ipcRenderer.invoke('claude:session-materialization', {
              sessionId,
              cwd: srcTab.cwd,
            }).catch(() => null);
            if (materialization?.materialized !== true && materialization?.conversationMaterialized !== true) {
              return reply(false, null, 'source tab has no saved Claude conversation');
            }
          }

          const forkName = srcTab.name ? `${srcTab.name}_fork` : undefined;
          const newTabId = await state.createTabAfterCurrent(projectId, forkName, srcTab.cwd || '', {
            pendingAction: { type: sessionType === 'claude' ? 'claude-fork' : 'codex-fork', sessionId },
            nameSetManually: false,
            afterTabId: srcTab.id,
            visualParentTabId: srcTab.id,
          });
          return reply(true, {
            tabId: newTabId,
            sourceTabId: srcTabId,
            sessionId,
            projectId,
            name: forkName || null,
            sessionType,
          });
        }
        if (action === 'forkToSDK') {
          const { tabId: srcTabId } = payload || {};
          if (!srcTabId) return reply(false, null, 'tabId required');
          // Find source tab
          let srcTab: any = null;
          let projectId: string | null = null;
          for (const [pid, ws] of state.openProjects) {
            const t = ws.tabs.get(srcTabId);
            if (t) { srcTab = t; projectId = pid; break; }
          }
          if (!srcTab || !projectId) return reply(false, null, 'source tab not open');
          if (!srcTab.claudeSessionId) return reply(false, null, 'source tab has no Claude session');
          // Fork the JSONL into a new sessionId, then point a fresh SDK tab at it.
          const fork = await ipcRenderer.invoke('claude-sdk:fork-from-session', {
            sessionId: srcTab.claudeSessionId, cwd: srcTab.cwd,
          });
          if (!fork?.success) return reply(false, null, fork?.error || 'fork failed');
          const newTabId = await state.createSDKTab(projectId, undefined, {
            afterTabId: srcTab.id,
            visualParentTabId: srcTab.id,
          });
          state.updateSDKState(newTabId, { claudeSessionId: fork.newSessionId });
          // Carry source tab name → new SDK tab. User explicitly asked: "fork
          // creates same name, only background indicates SDK". The 'CLAUDE'
          // pill on the row already signals SDK-ness; copying the name keeps
          // mental continuity ("same convo, just SDK now").
          if (srcTab?.name && typeof srcTab.name === 'string') {
            try { await state.renameTab(projectId, newTabId, srcTab.name); } catch {}
          }
          return reply(true, { tabId: newTabId, sessionId: fork.newSessionId, projectId, name: srcTab?.name });
        }
        if (action === 'closeTab') {
          const { tabId, aiBusyOverride } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          for (const [projectId, ws] of state.openProjects) {
            if (ws.tabs.has(tabId)) {
              // skipProcessCheck so phone-driven close doesn't trigger desktop confirm dialog
              await state.closeTab(projectId, tabId, {
                skipProcessCheck: true,
                aiBusyOverride: typeof aiBusyOverride === 'boolean' ? aiBusyOverride : undefined
              });
              return reply(true, { tabId, closed: true });
            }
          }
          return reply(true, { tabId, closed: false, reason: 'already-closed' });
        }
        if (action === 'createClaudeTab') {
          // Create new PTY terminal tab with pendingAction='claude-new' — the
          // Terminal.tsx component handles spawning the Claude CLI itself on
          // first mount (same as desktop "+ New tab → claude" flow). We don't
          // call claude:spawn-with-watcher here because that would race with
          // Terminal.tsx and start Claude twice in the same PTY.
          const { projectId } = payload || {};
          if (!projectId) return reply(false, null, 'projectId required');
          const ws = await ensureProjectWorkspace(projectId);
          if (!ws) return reply(false, null, 'project not open');
          const cwd = ws.projectPath && !ws.projectPath.startsWith('__unset__') ? ws.projectPath : undefined;
          const tabId = await state.createTab(projectId, undefined, cwd, {
            commandType: 'claude',
            pendingAction: { type: 'claude-new' },
            skipInitialRename: true,
          });
          const tab = ws.tabs.get(tabId);
          return reply(true, { tabId, name: tab?.name, cwd: tab?.cwd, projectId });
        }
        if (action === 'restoreClosedAgentTab') {
          const { projectId, historyId, expectedTabId } = payload || {};
          if (!projectId || !Number.isFinite(Number(historyId)) || !expectedTabId) {
            return reply(false, null, 'projectId+historyId+expectedTabId required');
          }
          const ws = await ensureProjectWorkspace(projectId);
          if (!ws) return reply(false, null, 'project not open');
          if (ws.tabs.has(expectedTabId)) {
            return reply(true, { tabId: expectedTabId, projectId, alreadyOpen: true });
          }
          const restored = await useWorkspaceStore.getState().restoreTabHistoryEntry(
            projectId,
            Number(historyId),
            {
              background: true,
              restorePosition: true,
              // The shared send scenario owns resume/start. Auto-running a
              // pending action here would create a second launch path.
              resumePolicy: 'never',
              expectedTabId,
              requireExactCwd: true,
            },
          );
          if (!restored.tabId || restored.tabId !== expectedTabId) {
            return reply(false, restored, restored.message || restored.reason || 'closed tab restore failed');
          }
          return reply(true, { ...restored, projectId, restored: true });
        }
        if (action === 'createAgentTab') {
          const {
            projectId,
            toolType,
            name,
            externalRun,
            codexDeveloperInstructions,
            codexModel,
            codexEffort,
            startNow,
            background,
            visualParentTabId,
            afterTabId,
            reservedTabId,
          } = payload || {};
          if (!projectId) return reply(false, null, 'projectId required');
          const agent: AgentHistoryTool = toolType === 'codex' ? 'codex' : 'claude';
          const ws = await ensureProjectWorkspace(projectId);
          if (!ws) return reply(false, null, 'project not open');
          const requestedVisualParentId = typeof visualParentTabId === 'string' && visualParentTabId.trim()
            ? visualParentTabId.trim()
            : undefined;
          if (requestedVisualParentId && !ws.tabs.has(requestedVisualParentId)) {
            return reply(false, null, 'visual parent tab is not open in target project');
          }
          const requestedReservedTabId = typeof reservedTabId === 'string' && reservedTabId.trim()
            ? reservedTabId.trim()
            : undefined;
          if (requestedReservedTabId && ws.tabs.has(requestedReservedTabId)) {
            return reply(false, null, 'reserved target tab already exists');
          }
          const cwd = ws.projectPath && !ws.projectPath.startsWith('__unset__') ? ws.projectPath : undefined;
          const pendingAction: any = { type: agent === 'codex' ? 'codex-new' : 'claude-new' };
          if (agent === 'codex' && typeof codexDeveloperInstructions === 'string' && codexDeveloperInstructions.trim()) {
            pendingAction.developerInstructions = codexDeveloperInstructions.trim();
          }
          const shouldStartNow = startNow === true;
          const explicitName = typeof name === 'string' && name.trim() ? name.trim() : undefined;
          const createOptions = {
            commandType: agent,
            color: agent,
            pendingAction: shouldStartNow ? undefined : pendingAction,
            nameSetManually: !!explicitName,
            skipInitialRename: true,
            codexModel: typeof codexModel === 'string' ? codexModel : undefined,
            codexEffort: typeof codexEffort === 'string' ? codexEffort : undefined,
            externalRun: externalRun && typeof externalRun === 'object' ? externalRun : undefined,
            background: background === true,
            restoreId: requestedReservedTabId,
            // Project API sessions keep their visual parent, but must not
            // displace tabs the user has already ordered near that parent.
            appendToEnd: true,
            ...(requestedVisualParentId
              ? {
                afterTabId: typeof afterTabId === 'string' && afterTabId.trim()
                  ? afterTabId.trim()
                  : requestedVisualParentId,
                visualParentTabId: requestedVisualParentId,
              }
              : {}),
          } as any;
          const tabId = requestedVisualParentId
            ? await state.createTabAfterCurrent(projectId, explicitName, cwd, createOptions)
            : await state.createTab(projectId, explicitName, cwd, createOptions);
          const tab = ws.tabs.get(tabId);
          let launchAccepted: any = null;
          if (shouldStartNow) {
            state.setTabCommandType(tabId, agent);
            state.markAiLaunchAutoTitle(tabId, agent);
            if (agent === 'codex') {
              const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
                tabId,
                command: 'codex',
                cwd: tab?.cwd || cwd,
                developerInstructions: typeof codexDeveloperInstructions === 'string' ? codexDeveloperInstructions.trim() : undefined,
              })).catch((err: any) => ({ success: false, error: String(err?.message || err) }));
              if (runResult?.success === false || runResult?.accepted === false) {
                await state.closeTab(projectId, tabId, { skipProcessCheck: true, forceCleanup: true, archive: false } as any).catch(() => false);
                return reply(false, null, runResult.error || 'Codex start failed');
              }
              launchAccepted = runResult;
            } else {
              const runResult = await ipcRenderer.invoke('claude:run-command', { tabId, command: 'claude' })
                .catch((err: any) => ({ success: false, accepted: false, error: String(err?.message || err) }));
              if (runResult?.success === false || runResult?.accepted === false) {
                await state.closeTab(projectId, tabId, { skipProcessCheck: true, forceCleanup: true, archive: false } as any).catch(() => false);
                return reply(false, null, runResult?.error || runResult?.reason || 'Claude start failed');
              }
              launchAccepted = await waitForAgentLaunchAccepted(tabId, 'claude');
              if (!launchAccepted?.accepted) {
                await state.closeTab(projectId, tabId, { skipProcessCheck: true, forceCleanup: true, archive: false } as any).catch(() => false);
                return reply(false, null, launchAccepted?.error || launchAccepted?.reason || 'Claude start failed');
              }
            }
          }
          return reply(true, {
            tabId,
            name: tab?.name,
            cwd: tab?.cwd,
            projectId,
            toolType: agent,
            commandType: agent,
            color: tab?.color || agent,
            visualParentTabId: tab?.visualParentTabId || null,
            sessionStatus: shouldStartNow ? 'starting' : 'inactive',
            inputReady: false,
            conversationMaterialized: false,
            canResume: false,
            canCopySessionId: false,
            timelineCount: 0,
            materializationReason: shouldStartNow ? 'launch-pending' : 'not-started',
            startupDefaultsPending: false,
            startupDefaultsReady: agent !== 'claude',
            startupDefaultsError: null,
            starting: shouldStartNow,
            launchAccepted: shouldStartNow ? (launchAccepted?.accepted ?? null) : undefined,
            acceptancePending: shouldStartNow ? launchAccepted?.acceptancePending === true : undefined,
            launchId: launchAccepted?.launchId || null,
            pid: launchAccepted?.pid || null,
          });
        }
        if (action === 'setExternalRunMeta') {
          const { tabId, meta } = payload || {};
          if (!tabId || !meta || typeof meta !== 'object') return reply(false, null, 'tabId+meta required');
          useWorkspaceStore.getState().updateExternalRunMeta(tabId, meta);
          for (const [projectId, ws] of useWorkspaceStore.getState().openProjects) {
            const tab = ws.tabs.get(tabId) as any;
            if (tab) return reply(true, { tabId, projectId, externalRun: tab.externalRun });
          }
          return reply(false, null, 'tab not open');
        }
        if (action === 'resumeClaudeTab') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
		          const { tab, toolType, runtime, sessionId } = describeAgentTab(tabId);
		          if (!tab || !runtime || !toolType) return reply(false, null, 'tab not open or not a PTY agent');
	          let resumeSessionId = sessionId;
	          if (toolType === 'codex') {
	            const codexRuntime = await ipcRenderer.invoke('codex:get-runtime-session', tabId).catch(() => null) as CodexRuntimeSessionSnapshot | null;
	            if (!codexRuntime || codexRuntime.liveLifecycle !== false || codexRuntime.sessionStatus !== 'inactive') {
	              return reply(false, {
	                success: false,
	                ok: false,
	                tabId,
	                toolType,
	                sessionId: null,
	                status: codexRuntime?.sessionStatus || 'unknown',
	                liveLifecycle: codexRuntime?.liveLifecycle ?? null,
	                error: 'codex_resume_requires_proven_inactive_runtime',
	              }, 'codex_resume_requires_proven_inactive_runtime');
	            }
	            resumeSessionId = codexRuntime.sessionId || null;
	          }
	          if (!resumeSessionId) return reply(false, null, 'no session to resume');
	          if (toolType === 'claude') {
	            const materialization = await readClaudeMaterialization(tab);
	            if (materialization.conversationMaterialized !== true) {
	              console.warn('[MobResume:Bridge] blocked-empty-session tab=' + String(tabId).slice(-12)
	                + ' sid=' + String(sessionId).slice(0, 8)
	                + ' reason=' + (materialization.materializationReason || materialization.reason || '-')
	                + ' timelineCount=' + (materialization.timelineCount ?? 'null'));
	              return reply(true, {
	                success: false,
	                ok: false,
	                tabId,
	                toolType,
	                sessionId,
	                conversationMaterialized: false,
	                canResume: false,
	                canCopySessionId: false,
	                timelineCount: materialization.timelineCount ?? null,
	                materializationReason: materialization.materializationReason || materialization.reason || null,
	                error: 'session_not_materialized',
	              });
	            }
	          }
	          console.log('[MobResume:Bridge] resumeAgentTab begin tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' sid=' + String(resumeSessionId).slice(0, 8));
          try {
            const result = await runtime.resume({ tabId, sessionId: resumeSessionId, cwd: tab.cwd });
            console.log('[MobResume:Bridge] resumeAgentTab done tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' result=' + JSON.stringify(result));
            return reply(!!result.success, { tabId, toolType, sessionId: resumeSessionId, ...result }, result.error);
          } catch (e: any) {
            console.log('[MobResume:Bridge] resumeAgentTab err tab=' + String(tabId).slice(-12) + ' ' + (e?.message || e));
	            return reply(false, null, String(e?.message || e));
	          }
	        }
        if (action === 'startAgentTab') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { tab, toolType, sessionId } = describeAgentTab(tabId);
          if (!tab || !toolType) return reply(false, null, 'tab not open or not a PTY agent');
          let codexRuntime: CodexRuntimeSessionSnapshot | null = null;
          if (toolType === 'codex') {
            codexRuntime = await ipcRenderer.invoke('codex:get-runtime-session', tabId).catch(() => null) as CodexRuntimeSessionSnapshot | null;
            if (!codexRuntime) {
              return reply(false, {
                tabId,
                toolType,
                sessionId: null,
                success: false,
                ok: false,
                status: 'unknown',
                inputReady: false,
                conversationMaterialized: !!sessionId,
                canResume: false,
                canCopySessionId: false,
                error: 'codex_runtime_unknown',
              }, 'codex_runtime_unknown');
            }
            if (codexRuntime.liveLifecycle !== false) {
              return reply(false, {
                tabId,
                toolType,
                sessionId: codexRuntime.provenWriterSessionId || null,
                success: false,
                ok: false,
                status: codexRuntime.sessionStatus || 'unknown',
                inputReady: codexRuntime.inputReady === true,
                conversationMaterialized: !!codexRuntime.savedSessionId,
                canResume: false,
                canCopySessionId: codexRuntime.canCopySessionId === true,
                error: 'codex_runtime_not_stopped',
              }, 'codex_runtime_not_stopped');
            }
          }
          const stoppedCodexSessionId = toolType === 'codex' ? (codexRuntime?.sessionId || null) : null;
          if (toolType === 'codex' && stoppedCodexSessionId) {
            console.warn('[MobStart:Bridge] blocked resumable Codex tab=' + String(tabId).slice(-12)
              + ' oldSession=' + String(stoppedCodexSessionId).slice(0, 8));
            return reply(false, {
              tabId,
              toolType,
              sessionId: stoppedCodexSessionId,
              success: false,
              ok: false,
              status: 'inactive',
              inputReady: false,
              conversationMaterialized: true,
              canResume: true,
              canCopySessionId: true,
              timelineCount: null,
              materializationReason: 'codex-session-bound',
              error: 'tab_has_resumable_session',
            }, 'tab_has_resumable_session');
          }
          if (toolType === 'claude' && sessionId) {
            const materialization = await readClaudeMaterialization(tab);
            if (materialization.conversationMaterialized === true) {
              console.warn('[MobStart:Bridge] blocked resumable Claude tab=' + String(tabId).slice(-12)
                + ' oldSession=' + String(sessionId).slice(0, 8));
              return reply(false, {
                tabId,
                toolType,
                sessionId,
                success: false,
                ok: false,
                status: 'inactive',
                inputReady: false,
                conversationMaterialized: true,
                canResume: true,
                canCopySessionId: true,
                timelineCount: materialization.timelineCount ?? null,
                materializationReason: materialization.materializationReason || materialization.reason || 'timeline-has-entries',
                error: 'tab_has_resumable_session',
              }, 'tab_has_resumable_session');
            }
          }
          console.log('[MobStart:Bridge] startAgentTab begin tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' oldSession=' + (sessionId ? String(sessionId).slice(0, 8) : 'none'));
          try {
            state.setTabCommandType(tabId, toolType);
            state.markAiLaunchAutoTitle(tabId, toolType);
            let launchAccepted: any = null;
            if (toolType === 'codex') {
              const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
                tabId,
                command: 'codex',
                cwd: tab.cwd,
              })).catch((err: any) => ({ success: false, error: String(err?.message || err) }));
              if (runResult?.success === false || runResult?.accepted === false) {
                return reply(false, null, runResult.error || 'Codex start failed');
              }
              launchAccepted = runResult;
            } else {
              const runResult = await ipcRenderer.invoke('claude:run-command', { tabId, command: 'claude' })
                .catch((err: any) => ({ success: false, accepted: false, error: String(err?.message || err) }));
              if (runResult?.success === false || runResult?.accepted === false) {
                return reply(false, null, runResult?.error || runResult?.reason || 'Claude start failed');
              }
              launchAccepted = await waitForAgentLaunchAccepted(tabId, 'claude');
              if (!launchAccepted?.accepted) {
                return reply(false, null, launchAccepted?.error || launchAccepted?.reason || 'Claude start failed');
              }
            }
            console.log('[MobStart:Bridge] startAgentTab accepted tool=' + toolType + ' tab=' + String(tabId).slice(-12));
            return reply(true, {
              tabId,
              toolType,
              success: true,
              ok: true,
              status: 'starting',
              inputReady: false,
              conversationMaterialized: false,
              canResume: false,
              canCopySessionId: false,
              timelineCount: 0,
              materializationReason: 'launch-pending',
              startupDefaultsPending: toolType === 'claude',
              startupDefaultsReady: toolType !== 'claude',
              startupDefaultsError: null,
              launchAccepted: launchAccepted?.accepted ?? null,
              acceptancePending: launchAccepted?.acceptancePending === true,
              launchId: launchAccepted?.launchId || null,
              pid: launchAccepted?.pid || null,
            });
          } catch (e: any) {
            console.log('[MobStart:Bridge] startAgentTab err tab=' + String(tabId).slice(-12) + ' ' + (e?.message || e));
            return reply(false, null, String(e?.message || e));
          }
        }
        if (action === 'waitAgentStartupDefaultsReady') {
          const { tabId, timeoutMs } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { toolType } = describeAgentTab(tabId);
          try {
            if (toolType === 'claude') {
              await waitForClaudeStartupDefaultsReadyWithVisibleFallback(tabId, Number(timeoutMs) || 15000, 'web-bridge');
            }
            return reply(true, { tabId, toolType, defaultsReady: true });
          } catch (e: any) {
            return reply(false, null, String(e?.message || e));
          }
        }
        if (action === 'stopClaudeTab' || action === 'stopAgentProcessScenario') {
          const { tabId, reason, authority } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { toolType, runtime } = describeAgentTab(tabId);
          if (!runtime || !toolType) return reply(false, null, 'tab not open or not a PTY agent');
          console.log('[MobStop:Bridge] stopAgentTab begin tool=' + toolType + ' tab=' + String(tabId).slice(-12));
          try {
            const r = await stopAgentProcessScenario({
              tabId,
              toolType,
              runtime,
              reason: typeof reason === 'string' ? reason : null,
              authority: authority && typeof authority === 'object' ? authority : null,
            });
            console.log('[MobStop:Bridge] stopAgentTab done tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' result=' + JSON.stringify(r));
            // The renderer/main transport succeeded even when process lookup
            // could not prove FOUND or ABSENT. Preserve that structured domain
            // result for Project API instead of flattening it into a generic
            // bridge exception that used to be mislabeled as "no session".
            return reply(true, r);
          } catch (e: any) {
            console.log('[MobStop:Bridge] stopAgentTab err tab=' + String(tabId).slice(-12) + ' ' + (e?.message || e));
            return reply(false, null, String(e?.message || e));
          }
        }
        if (action === 'interruptClaudeTurn' || action === 'interruptAgentTurnScenario') {
          const { tabId, busy } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { toolType, runtime } = describeAgentTab(tabId);
          if (!runtime || !toolType) return reply(false, null, 'tab not open or not a PTY agent');
          console.log('[MobInterrupt:Bridge] interruptAgentTurn tool=' + toolType + ' tab=' + String(tabId).slice(-12));
          try {
            const result = interruptAgentTurnScenario({
              tabId,
              toolType,
              runtime,
              busy: typeof busy === 'boolean' ? busy : undefined,
            });
            return reply(true, result);
          } catch (e: any) {
            console.log('[MobInterrupt:Bridge] err tab=' + String(tabId).slice(-12) + ' ' + (e?.message || e));
            return reply(false, null, String(e?.message || e));
          }
        }
        if (action === 'grabAgentDraft' || action === 'grabAgentDraftScenario') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { toolType, runtime } = describeAgentTab(tabId);
          if (!runtime || !toolType) return reply(false, null, 'tab not open or not a PTY agent');
          console.log('[MobDraft:Bridge] grabAgentDraft tool=' + toolType + ' tab=' + String(tabId).slice(-12));
          try {
            const result = await grabAgentDraftScenario({ tabId, toolType, runtime });
            const ok = result?.success !== false;
            return reply(ok, result, ok ? undefined : result?.error);
          } catch (e: any) {
            console.log('[MobDraft:Bridge] err tab=' + String(tabId).slice(-12) + ' ' + (e?.message || e));
            return reply(false, null, String(e?.message || e));
          }
        }
        if (action === 'inspectAgentDraft' || action === 'inspectAgentDraftScenario') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { toolType, runtime } = describeAgentTab(tabId);
          if (!runtime || !toolType) return reply(false, null, 'tab not open or not a PTY agent');
          try {
            const result = inspectAgentDraftScenario({ tabId, toolType, runtime });
            return reply(true, result);
          } catch (e: any) {
            console.log('[MobDraft:Bridge] inspect err tab=' + String(tabId).slice(-12) + ' ' + (e?.message || e));
            return reply(false, null, String(e?.message || e));
          }
        }
        if (action === 'rewindAgentTimeline' || action === 'rewindAgentTimelineScenario') {
          const {
            tabId,
            targetIndex,
            targetText,
            targetFullText,
            rewindableCount,
            skipDuplicates,
            mode,
            startUuid,
            endUuid,
            additionalPrompt,
          } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { tab, toolType, runtime, sessionId } = describeAgentTab(tabId);
          if (!runtime || !toolType) return reply(false, null, 'tab not open or not a PTY agent');
          if (toolType !== 'claude' && toolType !== 'codex') return reply(false, null, 'rewind unsupported for tool');
          if (!sessionId) return reply(false, null, 'no session to rewind');
          try {
            const result = await rewindAgentTimelineScenario({
              tabId,
              tab,
              toolType,
              runtime,
              sessionId,
              mode,
              targetIndex,
              targetText,
              targetFullText,
              rewindableCount,
              skipDuplicates,
              startUuid,
              endUuid,
              additionalPrompt,
              buildAiRewindText: buildMobileAiRewindText,
            });
            const ok = result?.success !== false;
            return reply(ok, result, ok ? undefined : result?.error);
          } catch (e: any) {
            console.log('[MobRewind:Bridge] err tab=' + String(tabId).slice(-12) + ' ' + (e?.message || e));
            return reply(false, null, String(e?.message || e));
          }
        }
        if (action === 'sendMessageAuto' || action === 'sendAgentPromptScenario') {
          // Single dispatch entry for agent send. `sendMessageAuto` is the old
          // bridge name kept for route compatibility; the implementation is now
          // the shared scenario used by Project API and Inbox API.
          const { tabId, prompt, model, effort, thinking, cwd, handoffId, source, statusAtSend, queue, returnDraftOnConflict, presentationSnapshot } = payload || {};
          if (!tabId || !prompt) return reply(false, null, 'tabId+prompt required');
          const { tab, toolType, runtime, sessionId } = describeAgentTab(tabId);
          if (runtime && toolType) {
            const promptSource = source
              || (action === 'sendMessageAuto' ? 'mobile-native' : 'project-api');
            const result = await runHistoryPromptHandoff({
              tabId,
              toolType,
              sessionIdHint: sessionId,
              text: prompt,
              promptChips: presentationSnapshot?.promptChips || [],
              imagePaths: presentationSnapshot?.imagePaths || [],
              handoffId,
              source: promptSource,
              statusAtSend,
              send: (resolvedHandoffId) => sendAgentPromptScenario({
                tabId,
                toolType,
                runtime,
                sessionId,
                cwd: cwd || tab?.cwd,
                prompt,
                handoffId: resolvedHandoffId,
                source: promptSource,
                statusAtSend,
                queue,
                model,
                effort,
                thinking,
                returnDraftOnConflict,
                presentationSnapshot: {
                  historySessionId: sessionId,
                  promptChips: presentationSnapshot?.promptChips || [],
                  imagePaths: presentationSnapshot?.imagePaths || [],
                  semanticTags: presentationSnapshot?.semanticTags || [],
                },
              }),
            });
            if (result?.success !== false) {
              maybeAutoTitleAfterMobileSend(tabId, toolType, cwd || tab?.cwd);
            }
            return reply(true, { tabId, toolType, ...(result || {}) });
          }
          // MCP ai-prompt requests were already engine-proven in main against
          // the live PTY. If the workspace store cannot resolve the tab yet
          // (startup hydration race), falling through to the SDK path would
          // start a Claude SDK session in a PTY tab — for Codex that is the
          // wrong agent entirely. Fail explicitly; the client retries later.
          if (source === 'mcp-ai-prompt' || source === 'codex-mcp-ai-prompt') {
            return reply(false, null, 'tab not resolved in workspace store yet (hydration); retry after the app finishes loading');
          }
          // SDK path (default)
          const sendCwd = cwd || tab?.cwd;
          const sendModel = model ?? tab?.sdkModel;
          const sendEffort = effort ?? tab?.sdkEffort ?? 'high';
          const sendThinking = thinking ?? (tab?.sdkThinking === false ? 'disabled' : 'adaptive');
          window.dispatchEvent(new CustomEvent('claude-sdk:external-prompt', {
            detail: { tabId, text: prompt, source: 'web' },
          }));
          const result = await ipcRenderer.invoke('claude-sdk:send-message', {
            tabId, cwd: sendCwd, prompt, model: sendModel, effort: sendEffort, thinking: sendThinking,
            resumeSessionId: tab?.claudeSessionId || null,
          });
          return reply(!!result?.success, result, result?.error);
        }
        if (action === 'sendClaudeMessage') {
          const { tabId, prompt } = payload || {};
          if (!tabId || !prompt) return reply(false, null, 'tabId+prompt required');
          const { tab, toolType, runtime, sessionId } = describeAgentTab(tabId);
          if (!runtime || !toolType) return reply(false, null, 'tab not open or not a PTY agent');
          const result = await sendAgentPromptScenario({
            tabId,
            toolType,
            runtime,
            sessionId,
            cwd: tab?.cwd,
            prompt,
            source: 'legacy-sendClaudeMessage',
          });
          const ok = result?.success !== false;
          return reply(ok, result || { tabId }, ok ? undefined : result?.error);
        }
        if (action === 'getClaudeTabStatusBatch') {
          const { tabIds, projectId = null } = payload || {};
          if (!Array.isArray(tabIds)) return reply(false, null, 'tabIds required');
          const statuses: Record<string, AgentRuntimeStatus> = {};
          const inputReady: Record<string, boolean> = {};
          const lastNotReady: Record<string, any> = {};
          const sessions: Record<string, string | null> = {};
          const startupFailed: Record<string, boolean> = {};
	          const startupError: Record<string, string | null> = {};
	          const startupDefaultsPending: Record<string, boolean> = {};
	          const startupDefaultsReady: Record<string, boolean> = {};
	          const startupDefaultsError: Record<string, string | null> = {};
	          const manualActionRequired: Record<string, boolean> = {};
	          const manualActionType: Record<string, string | null> = {};
	          const conversationMaterialized: Record<string, boolean> = {};
	          const timelineCount: Record<string, number | null> = {};
	          const canResume: Record<string, boolean> = {};
	          const canCopySessionId: Record<string, boolean> = {};
	          const readSessions: Record<string, string | null> = {};
	          const materializationReason: Record<string, string | null> = {};
	          const codexWriterConfirmed: Record<string, boolean> = {};
	          const codexWriterUsableForMutation: Record<string, boolean> = {};
	          // awaiting (Claude blocked on AskUserQuestion) per tab — drives the
          // mobile tab-list purple dot. Same presence call, extra field.
          const awaiting: Record<string, boolean> = {};
          for (const tid of tabIds) {
            try {
              const { toolType, runtime } = describeAgentTab(tid, projectId);
              const p = runtime ? await runtime.getPresence(tid, projectId) : null;
              let status = (p?.status || 'unknown') as AgentRuntimeStatus;
              let ready = !!p?.inputReady;
              let notReady = (p as any)?.lastNotReady || null;
              let failed = (p as any)?.startupFailed === true;
              let failedError = (p as any)?.startupError || null;
              if (toolType === 'claude') {
                const projected = projectClaudeStatusThroughStartupDefaults(tid, status, ready, notReady, failed, failedError);
                status = projected.status;
                ready = projected.inputReady;
                notReady = projected.lastNotReady;
                failed = projected.startupFailed;
                failedError = projected.startupError;
                startupDefaultsPending[tid] = projected.startupDefaultsPending;
                startupDefaultsReady[tid] = projected.startupDefaultsReady;
                startupDefaultsError[tid] = projected.startupDefaultsError;
              } else {
                startupDefaultsPending[tid] = false;
                startupDefaultsReady[tid] = true;
                startupDefaultsError[tid] = null;
              }
              statuses[tid] = status;
              inputReady[tid] = ready;
              if (notReady) lastNotReady[tid] = notReady;
              if (failed) startupFailed[tid] = true;
              if (failedError) startupError[tid] = failedError;
              if ((p as any)?.manualActionRequired) manualActionRequired[tid] = true;
              if ((p as any)?.manualActionType) manualActionType[tid] = (p as any).manualActionType;
              if (toolType === 'claude') {
                const tab = findTab(tid);
                const materialization = await readClaudeMaterialization(tab);
                conversationMaterialized[tid] = materialization.conversationMaterialized === true;
                timelineCount[tid] = materialization.timelineCount ?? null;
                canResume[tid] = statuses[tid] === 'inactive' && materialization.conversationMaterialized === true;
                canCopySessionId[tid] = materialization.conversationMaterialized === true;
                materializationReason[tid] = materialization.materializationReason || materialization.reason || null;
                if (p?.awaiting) awaiting[tid] = true;
              }
              if (toolType === 'codex') {
                // Reuse the exact main snapshot that produced status/inputReady.
                // A second read can cross a process generation and manufacture
                // impossible combinations such as inactive + live writer ID.
                const runtimeSession = (p as any)?.runtimeSnapshot as CodexRuntimeSessionSnapshot | null;
                const provenWriterSessionId = getConfirmedCodexWriterSessionId(runtimeSession);
                const readSessionId = getCodexRuntimeReadSessionId(runtimeSession);
                const historicalSessionId = getCodexDisplaySessionId(runtimeSession);
                codexWriterConfirmed[tid] = !!provenWriterSessionId;
                codexWriterUsableForMutation[tid] = !!provenWriterSessionId
                  && runtimeSession?.writerUsableForMutation === true;
                const codexSessionId = statuses[tid] === 'inactive'
                  ? historicalSessionId
                  : provenWriterSessionId;
                if (codexSessionId) sessions[tid] = codexSessionId;
                if (readSessionId) readSessions[tid] = readSessionId;
                conversationMaterialized[tid] = !!historicalSessionId;
                canResume[tid] = statuses[tid] === 'inactive' && !!codexSessionId;
                canCopySessionId[tid] = !!readSessionId;
                timelineCount[tid] = null;
                materializationReason[tid] = historicalSessionId ? 'codex-session-id' : 'no-session-id';
              }
            } catch {
              statuses[tid] = 'unknown';
              inputReady[tid] = false;
              delete sessions[tid];
              codexWriterConfirmed[tid] = false;
              codexWriterUsableForMutation[tid] = false;
              canResume[tid] = false;
              canCopySessionId[tid] = false;
              delete readSessions[tid];
            }
          }
          return reply(true, { statuses, inputReady, lastNotReady, awaiting, sessions, readSessions, codexWriterConfirmed, codexWriterUsableForMutation, startupFailed, startupError, startupDefaultsPending, startupDefaultsReady, startupDefaultsError, manualActionRequired, manualActionType, conversationMaterialized, timelineCount, canResume, canCopySessionId, materializationReason });
        }
        if (action === 'getClaudeTabStatus') {
          const { tabId, projectId = null } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { tab, toolType, runtime, sessionId } = describeAgentTab(tabId, projectId);
          if (!tab) return reply(true, { tabId, status: 'unknown', commandType: null, toolType: null, sessionId: null });
          let status: AgentRuntimeStatus = 'inactive';
          let inputReady = false;
          let lastNotReady: any = null;
          let startupFailed = false;
          let startupError: string | null = null;
	          let manualActionRequired = false;
	          let manualActionType: string | null = null;
	          let effectiveSessionId = sessionId;
	          let effectiveCodexSessionId = tab.codexSessionId || null;
	          let codexWriterConfirmed = false;
	          let codexWriterUsableForMutation = false;
	          let codexConversationMaterialized = !!tab.codexSessionId;
	          let materialization: any = null;
	          let codexRuntimeSnapshot: CodexRuntimeSessionSnapshot | null = null;
          let codexReadSessionId: string | null = null;
	          if (runtime) {
	            try {
	              const p = await runtime.getPresence(tabId, projectId);
              status = p?.status || 'inactive';
              inputReady = !!p?.inputReady;
              lastNotReady = (p as any)?.lastNotReady || null;
              startupFailed = (p as any)?.startupFailed === true;
              startupError = (p as any)?.startupError || null;
	              manualActionRequired = (p as any)?.manualActionRequired === true;
	              manualActionType = (p as any)?.manualActionType || null;
	              if (toolType === 'codex') {
	                codexRuntimeSnapshot = (p as any)?.runtimeSnapshot || null;
	              }
	            } catch { status = 'unknown'; }
	          }
	          if (toolType === 'claude') {
	            materialization = await readClaudeMaterialization(tab);
	            const projected = projectClaudeStatusThroughStartupDefaults(
	              tabId,
	              status,
	              inputReady,
	              lastNotReady,
	              startupFailed,
	              startupError,
	            );
	            status = projected.status;
	            inputReady = projected.inputReady;
	            lastNotReady = projected.lastNotReady;
	            startupFailed = projected.startupFailed;
	            startupError = projected.startupError;
	            (materialization ||= {}).startupDefaultsPending = projected.startupDefaultsPending;
	            materialization.startupDefaultsReady = projected.startupDefaultsReady;
	            materialization.startupDefaultsError = projected.startupDefaultsError;
	          }
	          if (toolType === 'codex') {
            const runtimeSession = codexRuntimeSnapshot;
            const displaySessionId = getCodexDisplaySessionId(runtimeSession);
            const provenWriterSessionId = getConfirmedCodexWriterSessionId(runtimeSession);
            codexReadSessionId = getCodexRuntimeReadSessionId(runtimeSession);
            codexWriterConfirmed = !!provenWriterSessionId;
            codexWriterUsableForMutation = !!provenWriterSessionId
              && runtimeSession?.writerUsableForMutation === true;
            codexConversationMaterialized = !!displaySessionId;
            const effectiveCodexIdentity = status === 'inactive'
              ? displaySessionId
              : provenWriterSessionId;
            effectiveSessionId = effectiveCodexIdentity;
            effectiveCodexSessionId = effectiveCodexIdentity;
            if (provenWriterSessionId && tab.codexSessionId !== provenWriterSessionId) {
              useWorkspaceStore.getState().setCodexSessionId(tabId, provenWriterSessionId, 'detected');
            }
          }
          return reply(true, {
            tabId,
            status,
            starting: status === 'starting',
            stopping: status === 'stopping',
            inputReady,
            lastNotReady,
            startupFailed,
            startupError,
            startupDefaultsPending: toolType === 'claude' ? materialization?.startupDefaultsPending === true : false,
            startupDefaultsReady: toolType === 'claude' ? materialization?.startupDefaultsReady === true : true,
            startupDefaultsError: toolType === 'claude' ? materialization?.startupDefaultsError || null : null,
            manualActionRequired,
            manualActionType,
            toolType,
            commandType: tab.commandType || null,
	            sessionId: effectiveSessionId,
	            claudeSessionId: tab.claudeSessionId || null,
	            codexSessionId: effectiveCodexSessionId,
            codexReadSessionId,
	            codexWriterConfirmed,
	            codexWriterUsableForMutation,
	            conversationMaterialized: toolType === 'claude'
                ? materialization?.conversationMaterialized === true
                : toolType === 'codex'
                  ? codexConversationMaterialized
                  : !!effectiveSessionId,
	            canResume: toolType === 'claude' ? (status === 'inactive' && materialization?.conversationMaterialized === true) : (status === 'inactive' && !!effectiveSessionId),
	            canCopySessionId: toolType === 'claude'
                ? materialization?.conversationMaterialized === true
                : toolType === 'codex'
                  ? !!codexReadSessionId
                  : !!effectiveSessionId,
	            timelineCount: toolType === 'claude' ? materialization?.timelineCount ?? null : null,
	            materializationReason: toolType === 'claude' ? materialization?.materializationReason || materialization?.reason || null : null,
	            cwd: tab.cwd,
	          });
        }
        if (action === 'loadSDKHistory') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          let tab: any = null;
          for (const ws of state.openProjects.values()) {
            const t = ws.tabs.get(tabId);
            if (t) { tab = t; break; }
          }
          if (!tab?.claudeSessionId) return reply(true, { messages: [] });
          // Use active-branch handler — uuids align with timeline (so GoTo
          // anchors work), AND it returns ALL types (user/assistant/tool_use/
          // tool_result) which the mobile reducer needs to compose tool cards
          // with statuses. Anthropic SDK's getSessionMessages skips records
          // outside its idea of "the session" and reuses different uuids.
          const result = await ipcRenderer.invoke('claude-sdk:active-branch-messages', {
            sessionId: tab.claudeSessionId, cwd: tab.cwd,
          });
          return reply(true, result);
        }
        if (action === 'loadAgentFullHistory') {
          const { tabId } = payload || {};
          if (!tabId) return reply(false, null, 'tabId required');
          const { tab, toolType, sessionId: storedSessionId } = describeAgentTab(tabId);
          if (!tab || !toolType) {
            return reply(true, { entries: [], sessionId: null, toolType: toolType || null });
          }
          const sessionId = toolType === 'codex'
            ? await requireCodexSurfaceSessionId({
              tabId,
              operation: 'Загрузить полную историю',
            })
            : storedSessionId;
          if (!sessionId) {
            return reply(true, { entries: [], sessionId: null, toolType });
          }
          const ipcChannel = toolType === 'codex' ? 'codex:get-full-history' : 'claude:get-full-history';
          const result = await ipcRenderer.invoke(ipcChannel, { sessionId, cwd: tab.cwd, tabId });
          return reply(!!result?.success, {
            ...(result || {}),
            toolType,
            commandType: tab.commandType || null,
            sessionId,
          }, result?.error);
        }
        return reply(false, null, 'unknown action: ' + action);
      } catch (err: any) {
        return reply(false, null, String(err?.message || err));
      }
    };
    ipcRenderer.on('web:bridge-request', handleWebBridge);

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);
    ipcRenderer.on('terminal:exit', handleTerminalExit);
    ipcRenderer.on('claude:busy-state', handleClaudeBusyState);
    ipcRenderer.on('claude-sdk:process-state', handleSdkProcessState);

    // Gemini busy state → project badge spinner
    const handleGeminiBusy = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      useWorkspaceStore.getState().setAiBusy(tabId, busy, reason);
      setBusyTabs(prev => { const n = new Map(prev); if (busy) n.set(tabId, true); else n.delete(tabId); return n; });
    };
    ipcRenderer.on('gemini:busy-state', handleGeminiBusy);

    // Codex busy-state must feed the same project-level signal as the per-tab
    // process strip. Otherwise Codex can shimmer in the sidebar while the project
    // tab stays visually idle.
    const handleCodexBusy = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      useWorkspaceStore.getState().setAiBusy(tabId, busy, reason);
      setBusyTabs(prev => { const n = new Map(prev); if (busy) n.set(tabId, true); else n.delete(tabId); return n; });
    };
    ipcRenderer.on('codex:busy-state', handleCodexBusy);

    const handleCodexTuiReady = (_: any, data: any) => {
      const owner = String(data?.codexProvisionalSettingsOwnerId || '').trim();
      const model = String(data?.codexProvisionalModel || '').trim();
      const effort = String(data?.codexProvisionalEffort || '').trim().toLowerCase();
      if (!data?.tabId || !owner.startsWith('launch:') || !model || !effort) return;
      const state = useWorkspaceStore.getState();
      state.updateCodexLiveState(data.tabId, {
        codexLiveModel: model,
        codexLiveEffort: effort,
        codexLiveSettingsSessionId: owner,
      });
      if (typeof data?.codexProvisionalFast === 'boolean') {
        state.updateCodexLiveServiceTier(data.tabId, {
          codexLiveServiceTier: data.codexProvisionalFast ? 'priority' : 'default',
          codexLiveServiceTierSessionId: owner,
          codexLiveServiceTierSource: data.codexProvisionalSettingsProofSource
            || 'verified-composer-footer',
        });
      }
    };
    const handleCodexServiceTierProof = (_: any, data: any) => {
      const tabId = String(data?.tabId || '').trim();
      if (!tabId) return;
      if (data?.cleared === true) {
        useWorkspaceStore.getState().updateCodexLiveServiceTier(tabId, {
          codexLiveServiceTier: undefined,
          codexLiveServiceTierSessionId: undefined,
          codexLiveServiceTierSource: undefined,
        });
        return;
      }
      const ownerId = String(data?.ownerId || '').trim();
      const serviceTier = String(data?.serviceTier || '').trim().toLowerCase();
      if (!ownerId || !['priority', 'default'].includes(serviceTier)) return;
      useWorkspaceStore.getState().updateCodexLiveServiceTier(tabId, {
        codexLiveServiceTier: serviceTier,
        codexLiveServiceTierSessionId: ownerId,
        codexLiveServiceTierSource: String(data?.source || 'tui'),
      });
    };
    ipcRenderer.on('codex:tui-ready', handleCodexTuiReady);
    ipcRenderer.on('codex:service-tier-proof', handleCodexServiceTierProof);

    // safePasteAndSubmit emits a short pre-turn loader before the agent's own
    // busy-state edge. Mirror it at project level whenever a tab strip shows it.
    const handlePasteBusy = (_: any, { tabId, busy }: { tabId: string; busy: boolean }) => {
      setPasteBusyTabs(prev => { const n = new Map(prev); if (busy) n.set(tabId, true); else n.delete(tabId); return n; });
    };
    ipcRenderer.on('claude:paste-busy', handlePasteBusy);

    const handleTerminalVisibleBufferRequest = async (_: any, payload: { requestId?: string; tabId?: string; reason?: string }) => {
      const requestId = payload?.requestId;
      const tabId = payload?.tabId;
      if (!requestId || !tabId) return;
      if (String(payload?.reason || '').startsWith('codex-rewind-')) {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
        });
      }
      const snapshot = terminalRegistry.getVisibleSnapshot(tabId);
      ipcRenderer.send('terminal:visible-buffer-response', {
        requestId,
        tabId,
        reason: payload?.reason || '',
        ...snapshot,
      });
    };
    ipcRenderer.on('terminal:visible-buffer-request', handleTerminalVisibleBufferRequest);

    const handleTerminalCodexDraftStateRequest = async (_: any, payload: { requestId?: string; tabId?: string; reason?: string; waitFor?: boolean; waitOnUnknownOnly?: boolean; timeoutMs?: number }) => {
      const requestId = payload?.requestId;
      const tabId = payload?.tabId;
      if (!requestId || !tabId) return;
      const immediateState = terminalRegistry.getCodexDraftState(tabId);
      const shouldWait = typeof payload?.waitFor === 'boolean'
        && !(
          payload.waitOnUnknownOnly === true
          && (immediateState.hasDraft === true || immediateState.hasDraft === false)
        );
      const state = shouldWait
        ? await terminalRegistry.waitForCodexDraftState(tabId, payload.waitFor!, Math.max(100, Math.min(Number(payload.timeoutMs) || 900, 2500)))
        : immediateState;
      ipcRenderer.send('terminal:codex-draft-state-response', {
        requestId,
        tabId,
        reason: payload?.reason || '',
        success: true,
        ...state,
      });
    };
    ipcRenderer.on('terminal:codex-draft-state-request', handleTerminalCodexDraftStateRequest);

    // Cmd+Tab refocus: main process fires this on every BrowserWindow 'focus'
    // event. We re-broadcast it as a DOM CustomEvent so per-tab components
    // (Terminal.tsx, ClaudeSDKTab.tsx) can listen via window.addEventListener
    // and refocus their own ref (xterm / textarea) without coupling them to
    // ipcRenderer or the store. Each component decides itself whether it's
    // the active one (via its existing `active` / `isVisible` prop).
    const handleWindowRefocus = () => {
      try { window.dispatchEvent(new CustomEvent('nt:window-refocus-active')); } catch {}
    };
    ipcRenderer.on('window:refocus-active', handleWindowRefocus);

    // Cmd+V intra-window refocus. Cmd+Tab path covers "window just became
    // frontmost"; this covers "window was already frontmost but DOM focus
    // sits on a button/sidebar/Stop chip" — happens whenever the user
    // clicked any UI control before triggering Voice Record. Without a
    // refocus, the synthesised Cmd+V from cgpaste lands on that button
    // and silently no-ops. We listen on capture so the refocus happens
    // BEFORE the keydown bubbles to whatever element currently holds
    // focus, giving xterm/textarea one tick to take over before the
    // browser actually processes the paste. Inputs and textareas inside
    // our own UI (SettingsModal, search box, contenteditable) are skipped
    // — those are legitimate paste targets in their own right.
    const handlePasteRefocus = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.code !== 'KeyV' && e.key !== 'v' && e.key !== 'V') return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      try { window.dispatchEvent(new CustomEvent('nt:window-refocus-active')); } catch {}
    };
    window.addEventListener('keydown', handlePasteRefocus, true);

    return () => {
      disposed = true;
      ipcRenderer.removeListener('terminal:mcp-restart', handleMcpRestart);
      ipcRenderer.removeListener('terminal:mcp-create', handleMcpCreate);
      ipcRenderer.removeListener('terminal:mcp-ai-tab', handleMcpAiTab);
      ipcRenderer.removeListener('codex:model-migration-settings-pending', handleCodexModelMigrationPending);
      ipcRenderer.removeListener('codex:model-migration-settings-applied', handleCodexModelMigrationApplied);
      ipcRenderer.removeListener('web:bridge-request', handleWebBridge);
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
      ipcRenderer.removeListener('terminal:exit', handleTerminalExit);
      ipcRenderer.removeListener('claude:busy-state', handleClaudeBusyState);
      ipcRenderer.removeListener('claude-sdk:process-state', handleSdkProcessState);
      ipcRenderer.removeListener('gemini:busy-state', handleGeminiBusy);
      claudeSpinnerVisualIdleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      claudeSpinnerVisualIdleTimersRef.current.clear();
      ipcRenderer.removeListener('codex:busy-state', handleCodexBusy);
      ipcRenderer.removeListener('codex:tui-ready', handleCodexTuiReady);
      ipcRenderer.removeListener('codex:service-tier-proof', handleCodexServiceTierProof);
      ipcRenderer.removeListener('claude:paste-busy', handlePasteBusy);
      ipcRenderer.removeListener('terminal:visible-buffer-request', handleTerminalVisibleBufferRequest);
      ipcRenderer.removeListener('terminal:codex-draft-state-request', handleTerminalCodexDraftStateRequest);
      ipcRenderer.removeListener('claude:awaiting-input', handleAwaitingInput);
      ipcRenderer.removeListener('window:refocus-active', handleWindowRefocus);
      window.removeEventListener('keydown', handlePasteRefocus, true);
    };
  }, [openProjects.size]); // Re-init when projects change

  // Save session; main process marks live AI sessions as interrupted when app closes
  useEffect(() => {
    const handleBeforeUnload = () => {
      const state = useWorkspaceStore.getState();
      // Save session immediately (without debounce)
      // NOTE: interrupted state is NOT managed here — main process will-quit handler
      // sets wasInterrupted AFTER this save completes, avoiding race conditions.
      state.saveSessionImmediate();
      flushScrollSavesSync();
      flushPromptQueueStoreSync();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Auto-resume interrupted sessions — Zustand subscribe instead of useEffect.
  // Problem: React batches set({isRestoring:true}) + set({isRestoring:false}) from
  // restoreSession() into one update — useEffect never sees isRestoring=true.
  // subscribe() fires synchronously on each set(), catching both transitions.
  useEffect(() => {
    let sawTrue = false;
    let triggered = false;
    const unsub = useWorkspaceStore.subscribe((state, prev) => {
      if (state.isRestoring && !prev.isRestoring) {
        sawTrue = true;
        console.warn('[AutoResume] isRestoring → true');
      }
      if (sawTrue && !state.isRestoring && prev.isRestoring && !triggered) {
        triggered = true;
        console.warn('[AutoResume] isRestoring → false, triggering');
        (async () => {
          try {
            const autoResume = await ipcRenderer.invoke('app:getState', 'auto_resume_sessions');
            if (autoResume !== true && autoResume !== 'true') {
              console.warn('[AutoResume] Disabled in settings');
              return;
            }
            const s = useWorkspaceStore.getState();
            const tabs: { tabId: string; sessionId: string; engine: 'claude' | 'codex'; cwd?: string }[] = [];
            for (const [, ws] of s.openProjects) {
              for (const [tabId, tab] of ws.tabs) {
                if (tab.wasInterrupted && tab.claudeSessionId && !tab.overlayDismissed &&
                    (tab.commandType === 'claude' || tab.color === 'claude')) {
                  tabs.push({ tabId, sessionId: tab.claudeSessionId, engine: 'claude', cwd: tab.cwd });
                } else if (tab.wasInterrupted && tab.codexSessionId && !tab.overlayDismissed &&
                           tab.commandType === 'codex') {
                  tabs.push({ tabId, sessionId: tab.codexSessionId, engine: 'codex', cwd: tab.cwd });
                }
              }
            }
            if (tabs.length === 0) { console.warn('[AutoResume] No interrupted tabs'); return; }
            console.warn('[AutoResume] Starting ' + tabs.length + ' sessions concurrently; per-tab command state is the loader source');

            const startOne = async (item: { tabId: string; sessionId: string; engine: 'claude' | 'codex'; cwd?: string }) => {
              const { tabId, sessionId, engine, cwd } = item;
              try {
                s.setTabCommandType(tabId, engine);
                if (engine === 'codex') {
                  const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
                    tabId,
                    command: 'codex-c',
                    sessionId,
                    cwd,
                    launchSource: 'auto-resume',
                  })).catch((err: any) => ({ success: false, accepted: false, error: String(err?.message || err) }));
                  if (runResult?.suppressed === true) {
                    s.clearInterruptedState(tabId);
                    console.warn('[AutoResume] Codex intentionally not restored tab=' + tabId.slice(-12)
                      + ' reason=' + (runResult?.reason || 'orchestration-auto-stop-pending'));
                    return { ok: true, suppressed: true, item };
                  }
                  if (runResult?.success === false || runResult?.accepted === false) {
                    console.warn('[AutoResume] Codex launch rejected tab=' + tabId.slice(-12)
                      + ' sid=' + sessionId.substring(0, 8)
                      + ' error=' + (runResult?.error || runResult?.reason || 'unknown'));
                    return { ok: false, item, error: runResult?.error || runResult?.reason || 'Codex start failed' };
                  }
                  s.clearInterruptedState(tabId);
                  console.warn('[AutoResume] Resumed codex pending=' + (runResult?.acceptancePending === true), tabId, sessionId.substring(0, 8));
                  return { ok: true, item };
                }
                // Main owns the complete Resume transaction now: exact bridge
                // ownership, tail trim, JSONL chain repair, final shell proof,
                // and the PTY write.  Keeping those steps in one transaction is
                // what lets the UI show a re-queryable preparation state instead
                // of leaving the tab as "interrupted" during the repair.
                markPendingResume(tabId, sessionId);
                const runResult = await ipcRenderer.invoke('claude:run-command', {
                  tabId,
                  command: 'claude-c',
                  sessionId,
                  launchSource: 'auto-resume',
                  ...(cwd ? { cdTo: cwd } : {}),
                });
                if (runResult?.suppressed === true) {
                  clearPendingResume(tabId);
                  s.clearInterruptedState(tabId);
                  console.warn('[AutoResume] Claude intentionally not restored tab=' + tabId.slice(-12)
                    + ' reason=' + (runResult?.reason || 'orchestration-auto-stop-pending'));
                  return { ok: true, suppressed: true, item };
                }
                if (runResult?.success === false || runResult?.accepted === false) {
                  clearPendingResume(tabId);
                  return { ok: false, item, error: runResult.error || runResult.reason || 'Claude start failed' };
                }
                const fixedCount = Number(runResult?.repaired || 0);
                if (fixedCount > 0) {
                  showToast(
                    `Перед открытием сессии починили ${fixedCount} orphan${fixedCount === 1 ? '' : 's'} parentUuid — без этого Claude обрезал бы историю.`,
                    'info',
                    8000,
                    false,
                    undefined,
                    undefined,
                    undefined,
                    tabId
                  );
                }
                s.clearInterruptedState(tabId);
                console.warn('[AutoResume] Resumed claude', tabId, sessionId.substring(0, 8));
                return { ok: true, item };
              } catch (e: any) {
                if (engine === 'claude') clearPendingResume(tabId);
                console.warn('[AutoResume] start failed tab=' + tabId.slice(-12) + ' engine=' + engine + ' error=' + (e?.message || String(e)));
                return { ok: false, item, error: e?.message || String(e) };
              }
            };

            const startResults = await Promise.all(tabs.map(startOne));
            const startedCount = startResults.filter((r) => r.ok).length;
            console.warn('[AutoResume] launch pass done started=' + startedCount + '/' + tabs.length +
              ' failed=' + (tabs.length - startedCount));
          } catch (e: any) {
            console.warn('[AutoResume] Error:', e?.message || String(e));
          }
        })();
      }
    });
    return () => unsub();
  }, []);

  // Semantic index watchers — start/stop per open project.
  // Subscribe to openProjects keys (not full Map ref) so we only react to add/remove,
  // not to internal tab mutations.
  useEffect(() => {
    const tracked = new Set<string>();

    const sync = () => {
      const state = useWorkspaceStore.getState();
      const { projects: projectsMap } = useProjectsStore.getState();
      const currentIds = new Set(state.openProjects.keys());

      // Start watching newly opened projects
      for (const projectId of currentIds) {
        if (tracked.has(projectId)) continue;
        const proj = projectsMap[projectId];
        if (!proj?.path) continue;
        ipcRenderer.invoke('semantic-index:watch', { projectId, projectPath: proj.path }).catch(() => {});
        tracked.add(projectId);
      }

      // Stop watching closed projects
      for (const projectId of Array.from(tracked)) {
        if (!currentIds.has(projectId)) {
          ipcRenderer.invoke('semantic-index:unwatch', { projectId }).catch(() => {});
          tracked.delete(projectId);
        }
      }
    };

    // Initial run (after project list loads)
    sync();

    const unsubWs = useWorkspaceStore.subscribe(sync);
    const unsubProj = useProjectsStore.subscribe(sync);

    return () => {
      unsubWs();
      unsubProj();
      for (const projectId of tracked) {
        ipcRenderer.invoke('semantic-index:unwatch', { projectId }).catch(() => {});
      }
    };
  }, []);

  // CLAUDE.md mirror watchers — same lifecycle as semantic-index above. Two
  // separate IPC channels (mirror:watch / mirror:unwatch). Watch on every open
  // project, not just active — Settings panel pulls status from useMirrorStatusStore
  // and we need fresh data the moment the user opens it.
  useEffect(() => {
    const tracked = new Set<string>();

    const sync = () => {
      const state = useWorkspaceStore.getState();
      const { projects: projectsMap } = useProjectsStore.getState();
      const currentIds = new Set(state.openProjects.keys());

      for (const projectId of currentIds) {
        if (tracked.has(projectId)) continue;
        const proj = projectsMap[projectId];
        if (!proj?.path) continue;
        ipcRenderer.invoke('mirror:watch', { projectId, projectPath: proj.path }).catch(() => {});
        tracked.add(projectId);
      }

      for (const projectId of Array.from(tracked)) {
        if (!currentIds.has(projectId)) {
          ipcRenderer.invoke('mirror:unwatch', { projectId }).catch(() => {});
          useMirrorStatusStore.getState().clearStatus(projectId);
          tracked.delete(projectId);
        }
      }
    };

    sync();

    const unsubWs = useWorkspaceStore.subscribe(sync);
    const unsubProj = useProjectsStore.subscribe(sync);

    const onStatus = (_evt: unknown, payload: { projectId: string } & any) => {
      if (!payload?.projectId) return;
      const { projectId, ...status } = payload;
      useMirrorStatusStore.getState().setStatus(projectId, status as any);
    };
    ipcRenderer.on('mirror:status', onStatus);

    return () => {
      unsubWs();
      unsubProj();
      ipcRenderer.removeListener('mirror:status', onStatus);
      for (const projectId of tracked) {
        ipcRenderer.invoke('mirror:unwatch', { projectId }).catch(() => {});
      }
    };
  }, []);

  // Tell main process which projects are currently open in this instance so the
  // standalone MCP server (terminal-server.mjs) can route requests by parentProjectId
  // (preferred) or CLAUDE_PROJECT_DIR (fallback) to the right instance. Without this,
  // dev + prod copies both write port files and MCP picks whichever was modified last —
  // calls land in the wrong window.
  useEffect(() => {
    const collect = () => {
      const seenPaths = new Set<string>();
      const paths: string[] = [];
      const projects: Array<{ id: string; path: string; name: string }> = [];
      const projectsStore = useProjectsStore.getState();
      for (const [pid, ws] of useWorkspaceStore.getState().openProjects) {
        const p = (ws as any).projectPath;
        if (typeof p === 'string' && p && !p.startsWith('__unset__') && !seenPaths.has(p)) {
          seenPaths.add(p);
          paths.push(p);
        }
        // Always include the project entry by id+path even if path is placeholder.
        // MCP needs id-routing for projects that exist but have no real cwd.
        const proj = (projectsStore.projects as any)[pid];
        projects.push({
          id: pid,
          path: typeof p === 'string' ? p : '',
          name: proj?.name || '',
        });
      }
      return { paths, projects };
    };
    let lastKey = '';
    const push = () => {
      const { paths, projects } = collect();
      const key = paths.join('|') + '#' + projects.map(p => p.id + ':' + p.path).join('|');
      if (key === lastKey) return;
      lastKey = key;
      // Legacy receiver expects array; new receiver reads { paths, projects } from second arg.
      ipcRenderer.send('mcp:open-project-paths', paths, { projects });
    };
    push();
    const unsubA = useWorkspaceStore.subscribe(push);
    const unsubB = useProjectsStore.subscribe(push);
    return () => { unsubA(); unsubB(); };
  }, []);

  // Monitor drag-and-drop for project tabs reordering
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'PROJECT_TAB',
      onDrop({ source, location }) {
        const target = location.current.dropTargets[0];
        if (!target) return;

        const sourceData = source.data as { type: string; id: string; index: number };
        const targetData = target.data as { type: string; id: string; index: number };

        if (targetData.type !== 'PROJECT_TAB') return;
        if (sourceData.id === targetData.id) return;

        // Get current project order
        const currentOrder = Array.from(useWorkspaceStore.getState().openProjects.keys());
        const sourceIndex = currentOrder.indexOf(sourceData.id);
        const targetIndex = currentOrder.indexOf(targetData.id);

        if (sourceIndex === -1 || targetIndex === -1) return;

        // Calculate insertion index based on edge
        const edge = extractClosestEdge(targetData);
        let insertIndex = targetIndex;
        if (edge === 'right') {
          insertIndex = targetIndex + 1;
        }

        // Adjust if moving forward
        if (sourceIndex < insertIndex) {
          insertIndex--;
        }

        // Create new order
        const newOrder = [...currentOrder];
        newOrder.splice(sourceIndex, 1);
        newOrder.splice(insertIndex, 0, sourceData.id);

        reorderProjects(newOrder);
      },
    });
  }, [reorderProjects]);

  useEffect(() => {

    // Listen for openProject events
    const handleOpenProject = (e: any) => {
      const project = e.detail;
      openProject(project.id, project.path);
    };

    window.addEventListener('openProject', handleOpenProject);

    // Global Hotkeys
    const handleKeyDown = (e: KeyboardEvent) => {
      // Debug: log all Cmd+key combinations
      if (e.metaKey) {
        console.log('[Hotkey] Cmd +', e.code, e.key, 'view:', view);
      }

      // Cmd+B - Toggle file explorer (legacy, also available via Cmd+E in Workspace)
      const isCmdB = e.code === 'KeyB';
      if (e.metaKey && isCmdB) {
        e.preventDefault();
        if (view === 'workspace' && activeProjectId && !isInboxProjectId(activeProjectId)) {
          if (filePreview && filePreview.source !== 'tab') {
            closeFilePreview();
            setOpenFilePath(activeProjectId, null);
          }
          const { sidebarOpen } = getSidebarState(activeProjectId);
          setSidebarOpen(activeProjectId, !sidebarOpen);
        }
        return;
      }

      // Escape - Close file preview or clear area focus
      if (e.code === 'Escape') {
        if (filePreview) {
          e.preventDefault();
          if (filePreview.source === 'tab' && filePreview.sourceTabId && activeProjectId) {
            closeFilePreview();
            closeTab(activeProjectId, filePreview.sourceTabId, { skipProcessCheck: true });
            return;
          }
          closeFilePreview();
          if (activeProjectId) {
            setOpenFilePath(activeProjectId, null);
          }
          return;
        }
        if (activeArea === 'projects') {
          setActiveArea('workspace');
          return;
        }
      }

      // Cmd+T - New Tab or New Project
      if (e.metaKey && e.code === 'KeyT') {
        e.preventDefault();
        if (activeArea === 'projects') {
          handleCreateNewProject();
          return;
        }

        if (view === 'workspace' && activeProjectId) {
          useWorkspaceStore.getState().clearSelection(activeProjectId);
          const activeProject = getActiveProject();
          const currentProject = projects[activeProjectId];
          const effectiveId = getEffectiveTabId();
          // CWD priority: project.path (если привязан) → cwd активного таба
          // → HOME (createTab сам подставит при пустой строке). Юзер: «новая
          // вкладка автоматически в той директории, к которой привязан проект».
          const boundProjectPath = currentProject?.path && !currentProject.path.startsWith('__unset__') ? currentProject.path : '';
          if (currentProject && (effectiveId || activeProject?.activeGroupId)) {
            const currentTab = effectiveId ? activeProject?.tabs.get(effectiveId) : undefined;
            const cwd = boundProjectPath || currentTab?.cwd || '';
            createTabAfterCurrent(activeProjectId, undefined, cwd);
          } else if (currentProject) {
            createTab(activeProjectId, undefined, boundProjectPath);
          }
          // Switch to terminal view if on Home (per-project)
          const ws = useWorkspaceStore.getState().openProjects.get(activeProjectId);
          if (ws && ws.currentView !== 'terminal') {
            useWorkspaceStore.getState().setProjectView(activeProjectId, 'terminal');
          }
        }
        return;
      }

      // Arrow keys for project navigation (only when projects area is focused)
      if (activeArea === 'projects') {
        if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
          // activeArea is remembered navigation state, not proof that this
          // keystroke came from the project rail.
          if (!shouldNavigateProjectsWithArrow(e, activeArea, editingProjectId)) return;

          e.preventDefault();
          const projectIds = Array.from(openProjects.keys());
          if (projectIds.length === 0) return;

          const currentIndex = activeProjectId ? projectIds.indexOf(activeProjectId) : -1;
          let nextIndex = 0;

          if (e.code === 'ArrowRight') {
            nextIndex = (currentIndex + 1) % projectIds.length;
          } else {
            nextIndex = (currentIndex - 1 + projectIds.length) % projectIds.length;
          }

          const nextProjectId = projectIds[nextIndex];
          const nextProject = openProjects.get(nextProjectId);
          if (nextProject) {
            openProject(nextProjectId, nextProject.projectPath);
          }
        }
      }

      // Cmd+W - Close Tab/Project (context-aware)
      if (e.metaKey && e.code === 'KeyW') {
        e.preventDefault();
        if (view === 'workspace') {
          const activeProject = getActiveProject();
          // If viewing a sub-agent, close that sub-agent tab (same as regular tab)
          if (activeProject?.viewingSubAgentTabId) {
            const subTabId = activeProject.viewingSubAgentTabId;
            useWorkspaceStore.getState().setViewingSubAgent(null);
            closeTab(activeProjectId!, subTabId, {
              aiBusyOverride: readLiveTabTurnBusy(subTabId),
            });
          } else if (activeProject && activeProject.activeTabId) {
            const selected = activeProject.selectedTabIds;
            if (selected.length > 1) {
              // Multi-select: close all selected tabs. Confirm only for real
              // risk: non-AI running process, or AI tab currently streaming.
              (async () => {
                const running: { id: string; name: string }[] = [];
                const busyAi: { id: string; name: string }[] = [];
                for (const id of selected) {
                  const tab = activeProject.tabs.get(id) as any;
                  const isAiTab = tab?.tabType === 'claude-sdk' || tab?.commandType === 'claude' || tab?.commandType === 'gemini' || tab?.commandType === 'codex';
                  const aiBusy = readLiveTabTurnBusy(id);
                  if (isAiTab && aiBusy) {
                    busyAi.push({ id, name: tab?.name || 'AI' });
                    continue;
                  }
                  if (tab?.tabType === 'claude-sdk') continue;
                  const state = await ipcRenderer.invoke('terminal:getCommandState', id);
                  if (state.isRunning) {
                    const info = await ipcRenderer.invoke('terminal:hasRunningProcess', id).catch(() => null);
                    if (isAiTab && (!info?.hasProcess || isAiForegroundProcess(info))) continue;
                    running.push({ id, name: info?.processName || tab?.name || 'unknown' });
                  }
                }

                const warnings: string[] = [];
                if (busyAi.length > 0) {
                  warnings.push(`${busyAi.length} AI-вкладк(и) сейчас отвечают:\n${busyAi.map(t => `• ${t.name}`).join('\n')}`);
                }
                if (running.length > 0) {
                  warnings.push(`${running.length} вкладк(и) с обычными процессами:\n${running.map(r => `• ${r.name}`).join('\n')}`);
                }

                const confirmed = warnings.length === 0
                  ? true
                  : (await ipcRenderer.invoke('ui:confirm-destructive', {
                      message: 'Хотите закрыть ' + selected.length + ' вкладк(и)? Активный процесс',
                      detail: warnings.join('\n\n'),
                      confirmLabel: 'Закрыть вкладки',
                      cancelLabel: 'Отмена',
                    }).catch(() => ({ confirmed: false })))?.confirmed === true;

                if (confirmed) {
                  for (const id of selected) {
                    await closeTab(activeProjectId!, id, {
                      skipProcessCheck: true,
                      forceCleanup: true,
                      aiBusyOverride: readLiveTabTurnBusy(id),
                    });
                  }
                }
              })();
            } else {
              // Same close path as the context menu item, including the live
              // busy snapshot: without it Cmd+W closed a mid-answer Codex tab
              // with no confirmation while the menu asked, because the store's
              // own tab fields miss paste/background-work activity.
              closeTab(activeProjectId!, activeProject.activeTabId, {
                aiBusyOverride: readLiveTabTurnBusy(activeProject.activeTabId),
              });
            }
          }
        } else {
          // On dashboard - close active project chip
          if (activeProjectId) {
            closeProject(activeProjectId);
          }
        }
        return;
      }

      // Cmd+, - Toggle Settings Modal
      if (e.metaKey && e.code === 'Comma') {
        e.preventDefault();
        setSettingsOpen(prev => {
          // Broadcast open transitions so floating surfaces can dismiss themselves.
          if (!prev) window.dispatchEvent(new CustomEvent('settings:opened'));
          return !prev;
        });
        return;
      }

      // Cmd+= (plus) - Increase ALL font sizes (gt-editor style)
      if (e.metaKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
        e.preventDefault();
        incrementAllFontSizes();
        return;
      }

      // Cmd+- (minus) - Decrease ALL font sizes (gt-editor style)
      if (e.metaKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        decrementAllFontSizes();
        return;
      }

    };

    window.addEventListener('keydown', handleKeyDown);

    // Opt+V — open the custom prompt picker (two-column flyout).
    // Layout-agnostic via e.code, so works on Cyrillic / QWERTY / Dvorak.
    // Registered as CAPTURE so it fires before xterm's customKeyEventHandler
    // and before assistant-ui's composer textarea (both of which see Opt+V first
    // and would otherwise emit `√` on Mac).
    // Cmd+E больше НЕ открывает picker — слот перенесён на toggle slide-out
    // заметок (Workspace.tsx, см. fact-notes.md). Раньше Cmd+E был алиасом.
    const handlePickerOpenCapture = (e: KeyboardEvent) => {
      if (view !== 'workspace') return;
      const isOptV = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyV';
      if (!isOptV) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof (e as any).stopImmediatePropagation === 'function') {
        (e as any).stopImmediatePropagation();
      }
      const cur = useUIStore.getState().promptPickerOpen;
      useUIStore.getState().setPromptPickerOpen(!cur);
    };
    window.addEventListener('keydown', handlePickerOpenCapture, true);

    // Shift+Cmd+T — reopen last closed tab in active project (VS Code-style).
    // Same capture-phase pattern as Opt+V: layout-agnostic via e.code, so the
    // shortcut works on Cyrillic / QWERTY / Dvorak; stops propagation before
    // xterm's customKeyEventHandler sees it (otherwise the literal `T` would
    // land in the active terminal's PTY).
    const handleReopenLastClosedCapture = (e: KeyboardEvent) => {
      if (view !== 'workspace') return;
      if (!(e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyT')) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof (e as any).stopImmediatePropagation === 'function') {
        (e as any).stopImmediatePropagation();
      }
      const ws = useWorkspaceStore.getState();
      const activeProjectId = ws.activeProjectId;
      if (!activeProjectId) return;
      // Fire pulse SYNCHRONOUSLY before IPC — the user sees TabBar flash within
      // the same frame as the keypress, even though createTab + claude-c resume
      // can take 300-800ms. Without this, the hotkey feels deaf during the gap.
      useUIStore.getState().triggerReopenPulse();
      ws.reopenLastClosedTab(activeProjectId).then((res) => {
        if (!res.tabId) {
          if (res.reason === 'empty') showToast('Нет закрытых вкладок', 'info');
          else if (res.reason === 'busy' || res.reason === 'cancelled') showToast(res.message || 'Восстановление отменено', 'info');
          else showToast(res.message || 'Не удалось восстановить вкладку', 'error');
          return;
        }
        if (res.historyDeleteFailed) {
          showToast(res.message || 'Вкладка открыта, но запись истории сохранена', 'warning');
        }
        if (res.fallbackFrom) {
          showToast(`Оригинальная папка удалена. Открыто в ${res.cwd}`, 'warning');
        }
      }).catch((err) => {
        console.warn('[Reopen] failed:', err);
        showToast('Не удалось восстановить вкладку', 'error');
      });
    };
    window.addEventListener('keydown', handleReopenLastClosedCapture, true);

    // Handle Context Menu commands from main process
    const handleContextMenuCommand = (_: any, cmd: string, data?: any) => {
      console.log('[ContextMenu] Command received:', cmd);
      if (cmd === 'insert-prompt') {
        // Insert prompt text + file attachments into effective terminal (sub-agent aware)
        const effectiveId = getEffectiveTabId();
        const { content, filePaths } = data as { content: string; filePaths: string[] };
        console.warn('[ContextMenu] insert-prompt: tabId=' + effectiveId + ' contentLen=' + (content?.length || 0) + ' files=' + (filePaths?.length || 0));
        if (effectiveId) {
          // 1. Prompt text — typed as keyboard input
          ipcRenderer.send('terminal:input', effectiveId, content);
          // 2. File contents — pasted via bracketed paste (shows as [Pasted text #N] in Claude TUI)
          if (filePaths && filePaths.length > 0) {
            (async () => {
              const filesResult = await ipcRenderer.invoke('ai-prompts:read-files', filePaths);
              if (filesResult.success) {
                for (const f of filesResult.data) {
                  await ipcRenderer.invoke('terminal:paste', { tabId: effectiveId, content: f.content, submit: false });
                }
              }
            })();
          }
        }
      } else if (cmd === 'add-to-favorites-from-terminal') {
        const { tabId: favTabId, projectId: favProjectId } = data || {};
        if (favTabId && favProjectId) {
          const ws = useWorkspaceStore.getState().openProjects.get(favProjectId);
          const tab = ws?.tabs.get(favTabId);
          if (tab) {
            ipcRenderer.invoke('project:add-favorite', {
              projectId: favProjectId,
              tab: {
                name: tab.name,
                cwd: tab.cwd,
                color: tab.color || null,
                notes: tab.notes || null,
                commandType: tab.commandType || null,
                tabType: tab.tabType || 'terminal',
                url: tab.url || null,
                claudeSessionId: tab.claudeSessionId || null,
                geminiSessionId: tab.geminiSessionId || null,
              }
            });
            showToast(`"${tab.name}" added to favorites`, 'success');
          }
        }
      } else if (cmd === 'run-script') {
        // Run npm script or .sh file from terminal context menu.
        // Same kill-ports prefix logic as TabBar's tab-context-menu path —
        // if "kill dev-ports" toggle is on, prepend `lsof | kill -9; ` to the line.
        //
        // Mirror TabBar's auto-color: any dev-like script name (`dev`, `start`,
        // `serve`, `watch` prefix; `npm run X`, `yarn dev`, `./watch.sh` all
        // qualify) sets commandType=devServer so the tab turns green and the
        // RestartZone activates. Without this, ПКМ внутри терминала → Scripts
        // doesn't recolor (only ПКМ по табу did, since the xterm keydown Enter
        // handler is bypassed when the command comes from IPC).
        const { tabId, command } = data || {};
        if (!tabId || !command) return;
        // Strip leading kill-ports prefix and trailing \r, then check if the
        // last script name in the chain matches dev-like prefix.
        const scriptName = String(command)
          .replace(/^.*?(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?/i, '')
          .replace(/^\.\//, '')
          .replace(/\.sh\b.*$/i, '')
          .trim();
        const isDevScript = /^(dev|start|serve|watch)/i.test(scriptName);
        if (isDevScript) {
          useWorkspaceStore.getState().setTabCommandType(tabId, 'devServer');
        }
        const runIt = (prefix: string) => {
          ipcRenderer.send('terminal:input', tabId, `${prefix}${command}`);
        };
        if (useUIStore.getState().freePortsBeforeStart) {
          // Look up tab cwd in workspace store to scan project ports.
          let cwd: string | undefined;
          for (const [, ws] of useWorkspaceStore.getState().openProjects) {
            const t = ws.tabs.get(tabId);
            if (t) { cwd = t.cwd; break; }
          }
          if (cwd) {
            ipcRenderer.invoke('system:detect-project-ports', cwd).then((res: any) => {
              const ports: number[] = res?.ports || [];
              const prefix = ports.length ? `lsof -ti:${ports.join(',')} 2>/dev/null | xargs -r kill -9 2>/dev/null; ` : '';
              runIt(prefix);
            }).catch(() => runIt(''));
          } else runIt('');
        } else runIt('');
      }
    };

    ipcRenderer.on('context-menu-command', handleContextMenuCommand);

    return () => {
      window.removeEventListener('openProject', handleOpenProject);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handlePickerOpenCapture, true);
      window.removeEventListener('keydown', handleReopenLastClosedCapture, true);
      ipcRenderer.removeListener('context-menu-command', handleContextMenuCommand);
    };
  }, [view, activeProjectId, filePreview, incrementAllFontSizes, decrementAllFontSizes, activeArea, openProjects, setActiveArea]);

  const openProjectsList = Array.from(openProjects.entries()).filter(([projectId]) => !isInboxProjectId(projectId));
  const projectContextStopCount = projectContextMenu ? getProjectStopTargetIds(projectContextMenu.projectId).length : 0;
  const inboxWorkspace = openProjects.get(INBOX_PROJECT_ID);
  const getProjectTabIndicators = (projectId: string, workspace?: any) => {
    let activeCount = 0;
    let hasBusyTab = false;
    let hasPasteBusyTab = false;
    let hasAwaitingTab = false;
    let completionNotificationCount = 0;
    let interruptedCount = 0;

    workspace?.tabs?.forEach((tab: any, tabId: string) => {
      const hasLiveProcess = !!processStatus.get(tabId) || !!tab.sdkProcessAlive;
      if (hasLiveProcess) activeCount++;
      if (busyTabs.get(tabId)) hasBusyTab = true;
      if (pasteBusyTabs.get(tabId)) hasPasteBusyTab = true;
      if (awaitingTabs.get(tabId)) hasAwaitingTab = true;
      if (tab.completionNotificationFired) completionNotificationCount++;
      if (isTabInterrupted(tab)) interruptedCount++;
    });

    const isProjectLoading = apiLoadingProjects.has(projectId);
    const hasInheritedBusyTab = inheritedBusyProjectIds.has(projectId);
    return {
      activeCount,
      hasAwaitingTab,
      completionNotificationCount,
      interruptedCount,
      isProjectLoading,
      hasProjectInheritedShimmer: hasInheritedBusyTab && !hasBusyTab && !hasPasteBusyTab && !isProjectLoading,
      hasProjectShimmer: hasBusyTab || hasPasteBusyTab || hasInheritedBusyTab || isProjectLoading,
    };
  };
  const inboxIndicators = getProjectTabIndicators(INBOX_PROJECT_ID, inboxWorkspace);
  const dockBusyState = useMemo(() => {
    const normalBusyTabIds = new Set<string>();
    const visibleInheritedBusyTabIds = new Set<string>();
    openProjects.forEach((workspace: any) => {
      workspace?.tabs?.forEach((tab: any, tabId: string) => {
        if (!tab || tab.tabType === 'file') return;
        if (busyTabs.get(tabId) || pasteBusyTabs.get(tabId)) normalBusyTabIds.add(tabId);
        if (inheritedBusyTabIds.has(tabId)) visibleInheritedBusyTabIds.add(tabId);
      });
    });
    return resolveDockBusyBadgeState(normalBusyTabIds, visibleInheritedBusyTabIds) as {
      count: number;
      kind: 'active' | 'inherited';
    };
  }, [openProjects, busyTabs, pasteBusyTabs, inheritedBusyTabIds]);

  useEffect(() => {
    const isMacDock = /Mac/i.test(navigator.platform || '');
    if (!isMacDock) return () => {};

    let disposed = false;

    const stopCustomDockBadge = async (reason: string) => {
      console.warn('[DockBusyBadge] custom icon unavailable; clearing dock badge reason=' + reason);
      await ipcRenderer.invoke('dock:reset-icon').catch(() => {});
    };

    const reset = () => {
      ipcRenderer.invoke('dock:reset-icon').catch(() => {});
    };

    if (dockBusyState.count <= 0) {
      reset();
      return () => {};
    }

    (async () => {
      try {
        const dataUrl = await getDockBusyIconDataUrl(
          dockBusyState.count,
          dockBusyState.kind,
          processBar.inheritedColor,
        );
        if (disposed) return;
        if (dataUrl) {
          const result = await ipcRenderer.invoke('dock:set-icon-data-url', {
            dataUrl,
            count: dockBusyState.count,
            kind: dockBusyState.kind,
          });
          if (result?.success === false) await stopCustomDockBadge(result?.error || 'set-icon-failed');
        } else {
          await stopCustomDockBadge('draw-failed');
        }
      } catch {
        if (!disposed) await stopCustomDockBadge('paint-exception');
      }
    })();

    return () => {
      disposed = true;
    };
  }, [dockBusyState.count, dockBusyState.kind, processBar.inheritedColor]);

  // Show loading screen while restoring session
  if (isRestoring) {
    return <RestoreLoader />;
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-bg-main text-white">
      {/* Title Bar */}
      <div
        className={`title-bar h-[40px] transition-all duration-300 flex items-center select-none border-b ${
          activeArea === 'projects' 
            ? 'bg-white/[0.05] border-white/20 ring-1 ring-white/10 shadow-[inset_0_0_20px_rgba(255,255,255,0.02)]' 
            : 'bg-tab border-border-main'
        }`}
        style={{
          WebkitAppRegion: 'drag', // Window can be dragged by clicking any empty space
          paddingLeft: 'env(titlebar-area-x, 85px)'
        } as any}
      >
        {/* Project Tabs - portfolio style */}
        <div
          className="flex items-center gap-1 px-2 h-full"
          style={{ WebkitAppRegion: 'no-drag' } as any}
          onMouseDown={() => setActiveArea('projects')} // Focus projects when clicking this container
          onDoubleClick={(e) => {
            if (e.target === e.currentTarget) {
              handleCreateNewProject();
            }
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setActiveArea('projects');
            }
          }}
        >
          <HelpButton onOpenHelp={() => setHelpOpen(true)} />

          {/* Home / DEV indicator */}
          {window.location.hostname === 'localhost' ? (
            <ControlHint label={view === 'dashboard' ? 'Вернуться в рабочий проект' : 'Открыть Dashboard'} side="bottom">
              <button
                data-workspace-navigation
                data-project-navigation
                className="relative px-4 py-1.5 text-sm font-bold cursor-pointer transition-colors"
                style={{
                  fontSize: `${projectTabsFontSize}px`,
                  color: view === 'dashboard' ? '#fff' : '#9b59b6'
                }}
                onMouseEnter={(e) => { if (view !== 'dashboard') e.currentTarget.style.color = '#c084fc'; }}
                onMouseLeave={(e) => { if (view !== 'dashboard') e.currentTarget.style.color = '#9b59b6'; }}
                onClick={() => view === 'dashboard' && activeProjectId ? showWorkspace(activeProjectId) : showDashboard()}
              >
                {view === 'dashboard' && (
                  <div className="absolute inset-0 rounded" style={{ backgroundColor: '#9b59b6' }} />
                )}
                <span className="relative z-10">[DEV]</span>
              </button>
            </ControlHint>
          ) : (
            <ControlHint label={view === 'dashboard' ? 'Вернуться в рабочий проект' : 'Открыть Dashboard'} side="bottom">
              <button
                data-workspace-navigation
                data-project-navigation
                className={`relative px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors ${
                  view === 'dashboard'
                    ? 'text-black'
                    : 'text-gray-400 hover:text-white'
                }`}
                style={{ fontSize: `${projectTabsFontSize}px` }}
                onClick={() => view === 'dashboard' && activeProjectId ? showWorkspace(activeProjectId) : showDashboard()}
              >
                {view === 'dashboard' && (
                  <div className="absolute inset-0 bg-white rounded" />
                )}
                <span className="relative z-10">🏠</span>
              </button>
            </ControlHint>
          )}

          {/* Pinned Inbox workspace */}
          <ProjectTabItem
            key={INBOX_PROJECT_ID}
            projectId={INBOX_PROJECT_ID}
            projectName={projects[INBOX_PROJECT_ID]?.name || INBOX_PROJECT_NAME}
            projectIcon={projects[INBOX_PROJECT_ID]?.icon || null}
            index={-1}
            isActive={view === 'workspace' && focusedProjectId === INBOX_PROJECT_ID}
            fontSize={projectTabsFontSize}
            activeProcessCount={inboxIndicators.activeCount}
            interruptedCount={inboxIndicators.interruptedCount}
            completionNotificationCount={inboxIndicators.completionNotificationCount}
            isProjectBusy={inboxIndicators.hasProjectShimmer}
            isProjectInheritedBusy={inboxIndicators.hasProjectInheritedShimmer}
            isProjectAwaiting={inboxIndicators.hasAwaitingTab}
            isProjectLoading={inboxIndicators.isProjectLoading}
            isEditing={false}
            editValue=""
            onEditChange={() => {}}
            onEditSubmit={() => {}}
            onEditCancel={() => {}}
            isAreaActive={activeArea === 'projects'}
            isPinnedSystem
            onClick={() => {
              openProject(INBOX_PROJECT_ID, projects[INBOX_PROJECT_ID]?.path || getInboxProjectPath());
            }}
            onDoubleClick={() => {}}
            onContextMenu={() => {}}
            onMiddleClick={() => {}}
            onTabDrop={async (tabId, sourceProjectId, selectedTabIds) => {
              const ids = selectedTabIds && selectedTabIds.length > 1 ? selectedTabIds : [tabId];
              const moved = await moveTabsToProject(sourceProjectId, ids, INBOX_PROJECT_ID);
              if (moved) {
                openProject(INBOX_PROJECT_ID, projects[INBOX_PROJECT_ID]?.path || getInboxProjectPath());
              }
            }}
          />

          {/* Separator */}
          {openProjectsList.length > 0 && (
            <div className="h-5 w-px bg-[#444] mx-1" />
          )}

          {/* Open Projects (draggable) */}
          {openProjectsList.map(([projectId, workspace], index) => {
            const project = projects[projectId];
            if (!project) return null;
            
            // Project is active only if:
            // 1. We are in workspace view (not dashboard)
            // 2. It matches the explicitly focused sidebar project
            const isActive = view === 'workspace' && focusedProjectId === projectId;
            const isLast = index === openProjectsList.length - 1;

            const indicators = getProjectTabIndicators(projectId, workspace);

            return (
              <ProjectTabItem
                key={projectId}
                projectId={projectId}
                projectName={lastCreatedProjectId === projectId ? projectEditValue : project.name}
                projectIcon={project.icon}
                index={index}
                isActive={isActive}
                fontSize={projectTabsFontSize}
                forceRightIndicator={isLast && projectEmptyZoneHovered}
                activeProcessCount={indicators.activeCount}
                interruptedCount={indicators.interruptedCount}
                completionNotificationCount={indicators.completionNotificationCount}
                isProjectBusy={indicators.hasProjectShimmer}
                isProjectInheritedBusy={indicators.hasProjectInheritedShimmer}
                isProjectAwaiting={indicators.hasAwaitingTab}
                isEditing={editingProjectId === projectId}
                editValue={projectEditValue}
                onEditChange={setProjectEditValue}
                onEditSubmit={handleSubmitProjectRename}
                onEditCancel={handleCancelProjectRename}
                isAreaActive={activeArea === 'projects'}
                isProjectLoading={indicators.isProjectLoading}
                onClick={() => {
                  openProject(projectId, project.path);
                }}
                onDoubleClick={() => handleStartEditingProject(projectId, project.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setProjectContextMenu({ projectId, x: e.clientX, y: e.clientY });
                }}
                onMiddleClick={() => {
                  // Only warn if there are running processes (not just open terminals)
                  if (indicators.activeCount > 0) {
                    if (confirm(`Close "${project.name}"?\n\n${indicators.activeCount} running process(es) will be terminated.`)) {
                      closeProject(projectId);
                    }
                  } else {
                    closeProject(projectId);
                  }
                }}
                onTabDrop={async (tabId, sourceProjectId, selectedTabIds) => {
                  const ids = selectedTabIds && selectedTabIds.length > 1 ? selectedTabIds : [tabId];
                  const moved = await moveTabsToProject(sourceProjectId, ids, projectId);
                  if (moved) openProject(projectId, project.path);
                }}
              />
            );
          })}
        </div>

        {/* Drag area + Empty drop zone for reordering */}
        <div className="flex flex-1 h-full items-center">
          <ProjectEmptyDropZone
            onMouseDown={() => setActiveArea('projects')}
            onDrop={(id) => {
              const currentOrder = openProjectsList.map(([id]) => id);
              const sourceIndex = currentOrder.indexOf(id);
              if (sourceIndex !== -1) {
                const newOrder = [...currentOrder];
                newOrder.splice(sourceIndex, 1);
                newOrder.push(id);
                reorderProjects(newOrder);
              }
            }}
            onHoverChange={setProjectEmptyZoneHovered}
            onDoubleClick={handleCreateNewProject}
          />
          
          {/* Resizable Window Drag Area */}
          <div className="relative h-full flex-shrink-0 flex" style={{ width: dragAreaWidth }}>
            {/* Resize handle */}
            <div
              className="w-[4px] h-full cursor-col-resize hover:bg-white/20 transition-colors flex-shrink-0"
              style={{ WebkitAppRegion: 'no-drag' } as any}
              onMouseDown={handleDragAreaResizeStart}
            />
            {/* Drag area */}
            <Tooltip content="Drag window">
              <div
                className="flex-1 h-full cursor-default bg-white/[0.01] hover:bg-white/[0.03] transition-colors border-l border-white/5"
                style={{ WebkitAppRegion: 'drag' } as any}
                onMouseDown={() => setActiveArea('projects')}
              />
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Content Area — Both rendered, CSS toggle preserves terminal instances */}
      <div
        className="flex-1 relative overflow-hidden flex flex-col"
        onMouseDown={() => setActiveArea(view === 'dashboard' ? 'projects' : 'workspace')}
      >
        {/* Dashboard — conditional render (no heavy state to preserve) */}
        {view === 'dashboard' && <Dashboard />}

        {/* Workspace — ALWAYS mounted, hidden via CSS to preserve xterm.js instances */}
        {/* visibility:hidden keeps container dimensions (prevents xterm 0x0 collapse) */}
        <div
          className="flex-1 flex flex-col min-h-0"
          style={{
            visibility: view === 'workspace' ? 'visible' : 'hidden',
            position: view === 'workspace' ? 'relative' : 'absolute',
            ...(view !== 'workspace' ? { inset: 0, pointerEvents: 'none' as const } : {}),
          }}
        >
          <Workspace />
        </div>
      </div>

      {/* VSCode-style status bar — full width across terminal + sidebar */}
      <StatusBar onOpenSettings={() => setSettingsOpen(true)} />

      {/* Global UI Components */}
      <ShutdownOverlay />
      <ToastContainer />
      <EditProjectModal />
      <SessionInputModal />
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSettingsInitialTab(null); }}
        initialTab={settingsInitialTab}
      />
      <HelpModal isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
      <PromptPickerOverlay />
      {/* Ctrl+Tab / Cmd+P cross-project tab switcher. Busy/process maps are the
          same visual-state sources the TabBar reads, so the switcher rows show
          the exact same loaders. */}
      <TabSwitcherOverlay
        processStatus={processStatus}
        busyTabs={busyTabs}
        pasteBusyTabs={pasteBusyTabs}
      />

      {/* Project Context Menu */}
      {projectContextMenu && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[10000]"
            onClick={() => setProjectContextMenu(null)}
          />
          {/* Menu */}
          <div
            className="fixed bg-[#252526] border border-[#444] rounded-lg shadow-xl py-1 min-w-[140px] z-[10001]"
            style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
          >
            <button
              className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-white/10 cursor-pointer"
              onClick={() => {
                const workspace = openProjects.get(projectContextMenu.projectId);
                const project = projects[projectContextMenu.projectId];
                // Count running processes in this project
                let runningCount = 0;
                workspace?.tabs.forEach((_, tabId) => {
                  if (processStatus.get(tabId)) runningCount++;
                });
                // Only warn if there are running processes
                if (runningCount > 0) {
                  if (confirm(`Close "${project?.name}"?\n\n${runningCount} running process(es) will be terminated.`)) {
                    closeProject(projectContextMenu.projectId);
                  }
                } else {
                  closeProject(projectContextMenu.projectId);
                }
                setProjectContextMenu(null);
              }}
            >
              Close Project
            </button>
            <button
              className="w-full text-left px-4 py-2 text-sm text-[#ccc] hover:bg-white/10 cursor-pointer"
              onClick={() => {
                setProjectContextMenu(null);
                setSettingsInitialTab('projects');
                setSettingsOpen(true);
              }}
            >
              Иконка проекта
            </button>
            <button
              className="w-full text-left px-4 py-2 text-sm text-[#ccc] hover:bg-white/10 cursor-pointer"
              onClick={() => {
                // Same as the tab-row "Copy ID/Path" — Electron clipboard, not
                // navigator.clipboard (the latter silently no-ops in the renderer
                // without HTTPS/permissions). See CLAUDE.md anti-pattern.
                const project = projects[projectContextMenu.projectId];
                if (project?.path) {
                  try { window.require('electron').clipboard.writeText(project.path); } catch {}
                }
                setProjectContextMenu(null);
              }}
            >
              Copy Path
            </button>
            <button
              disabled={projectContextStopCount === 0}
              className={`w-full px-4 py-2 text-sm border-t border-[#3a3a3a] flex items-center justify-end gap-2 ${
                projectContextStopCount === 0
                  ? 'text-[#666] cursor-not-allowed'
                  : 'text-[#10A37F] hover:bg-[#10A37F]/15 cursor-pointer'
              }`}
              onClick={() => {
                if (!projectContextMenu || projectContextStopCount === 0) return;
                const projectId = projectContextMenu.projectId;
                setProjectContextMenu(null);
                void stopProjectRunningTabs(projectId);
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  backgroundColor: projectContextStopCount === 0 ? '#444' : '#10A37F',
                  display: 'inline-block',
                }}
              />
              {projectContextStopCount > 0 ? `Stop ${projectContextStopCount}` : 'Stop'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default App;

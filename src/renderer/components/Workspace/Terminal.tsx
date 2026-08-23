import React, { useEffect, useRef, useState, memo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  createXtermWritePump,
  digestTerminalVisibleText,
  waitForXtermPresentationAfterDrain,
} from '../../utils/xtermWritePump';
import ControlHint from '../UI/ControlHint';
import SideSurfaceToggleButton from './SideSurfaceToggleButton';

const { shell } = window.require('electron');

const isHttpUrl = (uri: string) => /^https?:\/\//i.test(uri);

const suppressLinkEvent = (event: MouseEvent) => {
  event.preventDefault();
  // Do not stop propagation here: xterm's selection service clears its
  // mouse-down drag state from a document-level mouseup listener.
};

const isLinkActivationEvent = (event: MouseEvent) => event.metaKey;

const openExternalUrl = (uri: string) => {
  console.log('[Link] Opening URL in browser:', uri);
  shell.openExternal(uri).catch((err: Error) => {
    console.error('[Link] Failed to open external URL:', err);
  });
};

// Helper: open URL in browser or file in preview
const handleLinkActivation = (
  event: MouseEvent,
  uri: string,
  onLinkClick?: (url: string) => void,
  term?: XTerminal | null
) => {
  if (!isLinkActivationEvent(event)) {
    return;
  }

  suppressLinkEvent(event);
  try { term?.clearSelection(); } catch {}
  try { term?.focus(); } catch {}

  if (isHttpUrl(uri)) {
    if (onLinkClick) {
      console.log('[Link] Opening URL via contextual handler:', uri);
      onLinkClick(uri);
    } else {
      openExternalUrl(uri);
    }
    return;
  }

  // If it looks like a file path, try to open in preview
  // This handles paths like /Users/fedor/file.ts or ./src/file.ts
  if (uri.startsWith('/') || uri.startsWith('./') || uri.startsWith('../')) {
    console.log('[Link] Opening file in preview:', uri);
    // Use ipcRenderer to open file preview
    ipcRenderer.invoke('file:read', uri).then((result: any) => {
      if (result.success) {
        const ext = uri.split('.').pop()?.toLowerCase() || '';
        const languageMap: Record<string, string> = {
          'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
          'json': 'json', 'md': 'markdown', 'css': 'css', 'html': 'html',
          'py': 'python', 'go': 'go', 'rs': 'rust', 'sh': 'bash', 'yaml': 'yaml', 'yml': 'yaml'
        };
        useUIStore.getState().openFilePreview({
          path: uri,
          content: result.content,
          language: languageMap[ext] || null,
          source: 'terminal-link'
        });
        const { activeProjectId } = useWorkspaceStore.getState();
        if (activeProjectId) {
          useWorkspaceStore.getState().setOpenFilePath(activeProjectId, uri);
        }
      }
    }).catch((err: any) => {
      console.error('[Link] Failed to read file:', err);
    });
  }
};
import { SerializeAddon } from '@xterm/addon-serialize';
import { SearchAddon } from '@xterm/addon-search';
import { resolveTabTerminalPrimary, useUIStore } from '../../store/useUIStore';
import {
  useWorkspaceStore,
  type AiLaunchSnapshot,
  type PendingAction,
  type TerminalBufferCheckpoint,
} from '../../store/useWorkspaceStore';
import { PromptQueueOverlay } from './PromptQueueOverlay';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { resolveCenterRightInset, resolveTimelineInset } from '../../utils/surfaceInsets.mjs';
import {
  resolvePtyAgentOwner,
  shouldInterpretPtyScreenAsShellCommand,
} from '../../utils/ptyAgentOwner.mjs';
import { canTerminalClaimFocus } from '../../utils/terminalFocusClaim.mjs';
import { isEmptyTab } from '../../utils/emptyTab.mjs';
import {
  setEmptyTabLaunchHost,
  releaseEmptyTabLaunchHost,
} from '../../utils/emptyTabLaunchHost.mjs';
import { measureTerminalViewportIntersection } from '../../utils/terminalViewportIntersection.mjs';
import { resolveTerminalGeometry } from '../../utils/terminalMinimumGeometry.mjs';
import { log } from '../../utils/logger';
import { markRendererActivity } from '../../utils/rendererActivityTrail';
import { markPendingResume, clearPendingResume, isStaleAgainstPending, getPendingResume } from '../../utils/pendingResume';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { startFreshCodexSession } from '../../utils/historyAgentRuntimes';
import {
  isCodexSettingsPickerVisible,
  parseCodexModelChangeAcknowledgement,
  planCodexPickerStateApplication,
} from '../../utils/codexEffectiveSettings.mjs';
import { codexSessionAdoptionOptionsFromEvent } from '../../utils/codexSessionAdoption.mjs';
import {
  appendTerminalHydrationChunk,
  beginTerminalHydration,
  createTerminalHydrationActivity,
  createTerminalHydrationBuffer,
  decideTerminalHydrationGeneration,
  isTerminalHydrationActive,
  shouldPreferSavedTerminalCheckpoint,
  takeTerminalHydrationChunks,
} from '../../utils/terminalHydrationBuffer';

const TERMINAL_THEME = {
  background: '#1a1a1a',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5'
};

type XtermInputOrigin = 'user' | 'terminal-response' | 'unknown';

// xterm's public onData event mixes actual user input with terminal-protocol
// replies (focus reports, cursor position, colors, device attributes, etc.).
// Internally xterm fires onUserInput immediately before onData only for the
// former. Preserve that provenance across IPC so main-process automation does
// not mistake a terminal reply for the user taking control of a startup menu.
// If xterm changes its internal shape, return `unknown`: main treats that as
// user-owned (fail-safe) instead of granting an automatic Enter.
function createXtermInputOriginTracker(term: XTerminal): () => XtermInputOrigin {
  let nextDataWasUserInput = false;
  try {
    const coreService = (term as any)._core?.coreService;
    if (typeof coreService?.onUserInput !== 'function') {
      return () => 'unknown';
    }
    coreService.onUserInput(() => {
      nextDataWasUserInput = true;
    });
    return () => {
      const origin: XtermInputOrigin = nextDataWasUserInput ? 'user' : 'terminal-response';
      nextDataWasUserInput = false;
      return origin;
    };
  } catch {
    return () => 'unknown';
  }
}

// ============================================================================
// EffortInject TUI-readiness diagnostic instrumentation (temporary, May 2026)
// ============================================================================
// Tracks the first 5 seconds of PTY output after `claude:process-started` so we
// can see exactly when Claude TUI signals readiness (sync markers \x1b[?2026l,
// bracketed-paste mode \x1b[?2004h, prompt boundary chars `╰` / `⏵`) RELATIVE
// to when our /effort inject would fire. Goal: determine the right deterministic
// gate for inject so race-conditions with TUI init disappear.
//
// Logs are printed via console with CSS styling — bright red background so they
// stand out in DevTools when scrolling through hundreds of lines.
//
// Remove after diagnosis is complete (search for "EffortDiag" callers).
// ============================================================================
const _effortDiagStart = new Map<string, number>();   // tabId → process-started ts
const _effortDiagSeen = new Map<string, Set<string>>(); // tabId → set of markers already logged
const _effortHandlerCalls = new Map<string, number>(); // [EffortDiag2026-05] handler invocation counter per tab — distinguishes "handler fired twice" from "handler fired once, log delayed"
const _effortInjectCalls = new Map<string, number>(); // [EffortDiag2026-05] invoke-fire counter — must equal handler-call counter; if not, second sender exists

// Renderer-side mirror of explicit /effort choices, exposed for ControlBar and
// mobile presentation. It is not the startup owner: main keeps its own
// launch-scoped claims and the confirmed wrapper→stdout pair on the active
// JSONL branch remains the source of truth.
const _effortSentForTab = new Map<string, { at: number; via: string; level: string }>();
(window as any).__effortSentForTab = _effortSentForTab;

// Same presentation mirror for explicit /model choices.
const _modelSentForTab = new Map<string, { at: number; via: string; model: string }>();
(window as any).__modelSentForTab = _modelSentForTab;

const _claudeBridgeModelByTab = new Map<string, { model: string; at: number }>();

function _bridgeModelMatchesTarget(targetModel: string, bridgeModel: string | null | undefined): boolean {
  const target = String(targetModel || '').trim().toLowerCase();
  const live = String(bridgeModel || '').trim().toLowerCase();
  if (!target || target === 'none') return true;
  if (!live || live === 'unknown') return false;
  if (target === 'default') return live.includes('1m context');
  if (target === 'opus' && live.includes('1m context')) return false;

  const option = useUIStore.getState().claudeCodeSettings.models.find((m) => m.id.toLowerCase() === target);
  const needles = [target, option?.label?.toLowerCase()]
    .filter((v): v is string => !!v && v !== 'default');
  return needles.some((needle) => live.includes(needle));
}

function _effortDiag(tabId: string, label: string, extra?: string) {
  const start = _effortDiagStart.get(tabId);
  if (start === undefined) return;
  const elapsed = Date.now() - start;
  if (elapsed > 5000) return; // window closed
  console.log(
    '%c[EffortDiag]%c ' + label + ' %c+' + elapsed + 'ms%c tab=' + tabId.slice(-8) + (extra ? ' · ' + extra : ''),
    'background:#c0392b;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold;',
    'color:#e74c3c;font-weight:bold;',
    'background:#f39c12;color:#000;padding:1px 5px;border-radius:2px;font-weight:bold;',
    'color:#888;'
  );
}

function _effortDiagOnce(tabId: string, key: string, label: string, extra?: string) {
  let seen = _effortDiagSeen.get(tabId);
  if (!seen) { seen = new Set(); _effortDiagSeen.set(tabId, seen); }
  if (seen.has(key)) return;
  seen.add(key);
  _effortDiag(tabId, label, extra);
}

function _effortDiagScan(tabId: string, data: string) {
  if (!_effortDiagStart.has(tabId)) return;
  // \x1b[?2026l — sync output end (Ink frame rendered)
  if (data.indexOf('\x1b[?2026l') !== -1) {
    _effortDiagOnce(tabId, 'sync-end-first', '🟢 FIRST sync-marker \\x1b[?2026l (TUI frame rendered)');
  }
  // \x1b[?2004h — bracketed paste mode ON
  if (data.indexOf('\x1b[?2004h') !== -1) {
    _effortDiagOnce(tabId, 'bracketed-on', '🟢 bracketed-paste ON (\\x1b[?2004h)');
  }
  // \x1b[?2004l — bracketed paste mode OFF (regression case)
  if (data.indexOf('\x1b[?2004l') !== -1) {
    _effortDiag(tabId, '🔴 bracketed-paste OFF (\\x1b[?2004l) — DEC 2004 dropped');
  }
  // Prompt-ready box chars
  if (data.indexOf('╰') !== -1) {
    _effortDiagOnce(tabId, 'box-bottom', '🟢 box-bottom `╰` seen (prompt input ready)');
  }
  if (data.indexOf('⏵') !== -1) {
    _effortDiagOnce(tabId, 'prompt-arrow', '🟢 prompt-arrow `⏵` seen');
  }
  // OSC 133 A — shell prompt ready
  if (data.indexOf('\x1b]133;A') !== -1) {
    _effortDiagOnce(tabId, 'osc133a', '🟢 OSC 133 A (shell prompt ready)');
  }
}

const CODEX_OVERLAY_STYLE_LOG_KEYS = new Set(['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter']);

function isCodexTabForStyleProbe(tabId: string): boolean {
  const state = useWorkspaceStore.getState();
  for (const workspace of state.openProjects.values()) {
    const tab = workspace.tabs.get(tabId);
    if (!tab) continue;
    return resolvePtyAgentOwner(tab) === 'codex';
  }
  return false;
}

function scheduleCodexOverlayStyleProbe(tabId: string, event: KeyboardEvent, source: string): void {
  if (event.type !== 'keydown') return;
  if (!CODEX_OVERLAY_STYLE_LOG_KEYS.has(event.key)) return;
  if (!isCodexTabForStyleProbe(tabId)) return;
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      terminalRegistry.logCodexOverlayStyleSnapshot(tabId, source + ':key=' + event.key);
    }, 80);
  });
}

// Guard for the AUTOMATIC (deferred) terminal focus calls fired after a tab
// mounts/activates: setTimeout(100)/rAF in the init + activate effects. These
// must NOT steal focus from a real UI text field. The canonical victim is the
// inline tab-rename <input> (TabBar) that opens automatically on Cmd+T / new
// tab — the terminal mounts in the same tick, then its deferred focus() yanks
// focus out of the input → blur → rename auto-submits → "edit mode flashes for
// ~0.5s then resets" (user-reported). The xterm helper textarea is fair game
// (it IS the terminal); only bail when a NON-terminal editable element holds
// focus. Manual focus (handleClick) intentionally skips this guard.
function isExternalEditableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  // xterm's own input surface — focusing it is the whole point, never defer.
  if (el.classList.contains('xterm-helper-textarea')) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

// Split workspace shows several ACTIVE terminals at once; only the one whose
// tab is the app's globally active tab may grab keyboard focus on activation.
// Single mode: exactly one active terminal → always true for it.
function isGloballyActiveTab(tabId: string): boolean {
  const st = useWorkspaceStore.getState();
  const ws = st.activeProjectId ? st.openProjects.get(st.activeProjectId) : null;
  return ws?.activeTabId === tabId;
}

// Get buffer management functions outside of component to avoid re-renders
const getBufferActions = () => ({
  save: useWorkspaceStore.getState().saveTerminalBuffer,
  get: useWorkspaceStore.getState().getTerminalBuffer,
  clear: useWorkspaceStore.getState().clearTerminalBuffer
});

const normalizeTerminalBufferCheckpoint = (
  value: TerminalBufferCheckpoint | string | null,
): TerminalBufferCheckpoint | null => {
  if (!value) return null;
  if (typeof value === 'string') {
    return {
      serialized: value,
      headlessWriteSeq: null,
      headlessGeneration: null,
      headlessGenerationOrdinal: null,
      promptBoundaries: [],
      cols: 0,
      rows: 0,
    };
  }
  return value;
};

// Get Claude session setter/getter outside of component
const getSetClaudeSessionId = () => useWorkspaceStore.getState().setClaudeSessionId;
const getClaudeSessionId = (tabId: string) => useWorkspaceStore.getState().getClaudeSessionId(tabId);

// Get Gemini session setter/getter outside of component
const getSetGeminiSessionId = () => useWorkspaceStore.getState().setGeminiSessionId;
const getGeminiSessionId = (tabId: string) => useWorkspaceStore.getState().getGeminiSessionId(tabId);

// Get Codex session setter/getter outside of component
const getSetCodexSessionId = () => useWorkspaceStore.getState().setCodexSessionId;
const getCodexSessionId = (tabId: string) => useWorkspaceStore.getState().getCodexSessionId(tabId);

// Get setTabCommandType for auto-color and restart button visibility
const getSetTabCommandType = () => useWorkspaceStore.getState().setTabCommandType;

// Get updateTabCwd for OSC 7 handler (shell reports cwd changes)
const getUpdateTabCwd = () => {
  return async (tabId: string, newCwd: string): Promise<boolean> => {
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      if (workspace.tabs.has(tabId)) {
        return state.updateTabCwd(projectId, tabId, newCwd);
      }
    }
    return false;
  };
};

type OscCwdCandidateState = {
  running: boolean;
  pending?: string;
};

const oscCwdCandidateStates = new Map<string, OscCwdCandidateState>();

// OSC 7 is terminal output, not filesystem truth. Codex/TUI output can contain
// an OSC-looking byte sequence, so renderer state is updated only after main
// verifies the candidate against the live PTY process cwd. Bursts are
// coalesced per tab so a noisy TUI cannot build an unbounded IPC queue.
const submitOscCwdCandidate = (tabId: string, candidate: string): void => {
  const state = oscCwdCandidateStates.get(tabId) || { running: false };
  state.pending = candidate;
  oscCwdCandidateStates.set(tabId, state);
  if (state.running) return;

  state.running = true;
  void (async () => {
    try {
      while (state.pending !== undefined) {
        const next = state.pending;
        delete state.pending;
        try {
          const result = await ipcRenderer.invoke('terminal:updateCwd', { tabId, cwd: next });
          if (result?.accepted && typeof result.cwd === 'string') {
            const rendererSaved = await getUpdateTabCwd()(tabId, result.cwd);
            if (!rendererSaved && result.persisted !== true) {
              console.warn('[Terminal:CwdProof] accepted cwd could not be persisted', {
                tabId,
                cwd: result.cwd,
              });
            }
          } else {
            console.warn('[Terminal:CwdProof] rejected', {
              tabId,
              candidate: next,
              reason: result?.reason || 'unknown',
              observedCwd: result?.observedCwd || null,
              retainedCwd: result?.retainedCwd || null,
            });
          }
        } catch (error) {
          console.warn('[Terminal:CwdProof] IPC failed', { tabId, candidate: next, error });
        }
      }
    } finally {
      state.running = false;
      if (state.pending !== undefined) {
        submitOscCwdCandidate(tabId, state.pending);
      } else if (oscCwdCandidateStates.get(tabId) === state) {
        oscCwdCandidateStates.delete(tabId);
      }
    }
  })();
};

const handleOscCwdCandidate = (tabId: string, data: string): void => {
  try {
    const newCwd = data.startsWith('file://')
      ? decodeURIComponent(new URL(data).pathname)
      : data;
    if (newCwd && newCwd.startsWith('/')) {
      console.log('[Terminal] OSC 7 cwd candidate:', newCwd);
      submitOscCwdCandidate(tabId, newCwd);
    }
  } catch (error) {
    console.error('[Terminal] OSC 7 parse error:', error);
  }
};

// Get pending action for a tab (used for fork, continue, etc.)
const getTabPendingAction = (tabId: string): PendingAction | undefined => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      console.log('[RESTORE] 10. getTabPendingAction:', { tabId, pendingAction: tab.pendingAction });
      return tab.pendingAction;
    }
  }
  console.log('[RESTORE] 10. getTabPendingAction: TAB NOT FOUND in any workspace, tabId:', tabId);
  return undefined;
};

// Clear pending action after execution
const clearTabPendingAction = (tabId: string) => {
  const state = useWorkspaceStore.getState();
  for (const [projectId, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab && tab.pendingAction) {
      console.log('[RESTORE] 13. clearTabPendingAction:', { tabId, pendingAction: tab.pendingAction });
      tab.pendingAction = undefined;
      state.openProjects.set(projectId, { ...workspace });
      useWorkspaceStore.setState({ openProjects: new Map(state.openProjects) });
      return;
    }
  }
};

// Get tab cwd for fork commands
const getTabCwd = (tabId: string): string | undefined => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      return tab.cwd;
    }
  }
  return undefined;
};

const pendingAgentActionLaunches = new Set<string>();

const launchPendingAgentAction = async (
  tabId: string,
  actionType: PendingAction['type'],
  channel: 'claude:run-command' | 'codex:run-command',
  payload: any,
  pendingClaudeSessionId?: string | null,
) => {
  if (pendingAgentActionLaunches.has(tabId)) {
    console.warn('[RESTORE] Pending agent action already launching:', { tabId, actionType });
    return;
  }
  pendingAgentActionLaunches.add(tabId);
  try {
    const result = await invokePtyAgentLaunch(channel, payload, pendingClaudeSessionId);
    if (result?.success !== false && result?.accepted !== false) {
      // A restored one-shot action belongs to the launch transaction. Keep it
      // persisted when main rejects admission so a transient process-lookup or
      // non-idle shell cannot silently consume the user's requested restore.
      clearTabPendingAction(tabId);
    } else {
      console.warn('[RESTORE] Pending agent action retained after rejected launch:', {
        tabId,
        actionType,
        reason: result?.reason || result?.error || 'launch rejected',
      });
    }
  } finally {
    pendingAgentActionLaunches.delete(tabId);
  }
};

// Execute pending action after terminal is ready
const executePendingAction = (tabId: string, pendingAction: PendingAction) => {
  console.log('[RESTORE] 11. executePendingAction:', { tabId, type: pendingAction.type, sessionId: (pendingAction as any).sessionId });

  switch (pendingAction.type) {
    case 'claude-fork':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'claude');
        useWorkspaceStore.getState().markAiForkAutoTitle(tabId, 'claude', pendingAction.sessionId);
        console.log('[RESTORE] 12. Sending IPC claude:run-command { command: "claude-f", forkSessionId:', pendingAction.sessionId, '}');
        void launchPendingAgentAction(tabId, pendingAction.type, 'claude:run-command', {
          tabId,
          command: 'claude-f',
          forkSessionId: pendingAction.sessionId
        });
      } else {
        clearTabPendingAction(tabId);
      }
      break;

    case 'claude-continue':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'claude');
        console.log('[RESTORE] 12. Sending IPC claude:run-command { command: "claude-c", sessionId:', pendingAction.sessionId, '}');
        markPendingResume(tabId, pendingAction.sessionId);
        void launchPendingAgentAction(tabId, pendingAction.type, 'claude:run-command', {
          tabId,
          command: 'claude-c',
          sessionId: pendingAction.sessionId
        }, pendingAction.sessionId);
      } else {
        clearTabPendingAction(tabId);
      }
      break;

    case 'claude-compact-fork':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'claude');
        useWorkspaceStore.getState().markAiForkAutoTitle(
          tabId,
          'claude',
          pendingAction.sourceSessionId || pendingAction.sessionId,
        );
        markPendingResume(tabId, pendingAction.sessionId);
        void launchPendingAgentAction(tabId, pendingAction.type, 'claude:run-command', {
          tabId,
          command: 'claude-c',
          sessionId: pendingAction.sessionId,
        }, pendingAction.sessionId);
      } else {
        clearTabPendingAction(tabId);
      }
      break;

    case 'claude-new': {
      const store = useWorkspaceStore.getState();
      store.setTabCommandType(tabId, 'claude');
      store.markAiLaunchAutoTitle(tabId, 'claude');
      console.log('[RESTORE] 12. Sending IPC claude:run-command { command: "claude", tabId:', tabId, '}');
      void launchPendingAgentAction(
        tabId,
        pendingAction.type,
        'claude:run-command',
        { tabId, command: 'claude' },
      );
      break;
    }

    case 'gemini-fork':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'gemini');
        const cwd = getTabCwd(tabId);
        console.log('[RESTORE] 12. Sending IPC gemini:run-command { command: "gemini-f" }');
        ipcRenderer.send('gemini:run-command', {
          tabId,
          command: 'gemini-f',
          sessionId: pendingAction.sessionId,
          cwd
        });
      }
      break;

    case 'gemini-continue':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'gemini');
        getSetGeminiSessionId()(tabId, pendingAction.sessionId);
        console.log('[RESTORE] 12. Sending IPC gemini:run-command { command: "gemini-c" }');
        ipcRenderer.send('gemini:run-command', {
          tabId,
          command: 'gemini-c',
          sessionId: pendingAction.sessionId
        });
      }
      break;

    case 'gemini-new': {
      getSetTabCommandType()(tabId, 'gemini');
      const geminiCwd = getTabCwd(tabId);
      console.log('[RESTORE] 12. Sending IPC gemini:spawn-with-watcher { cwd:', geminiCwd, '}');
      ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd: geminiCwd, yesMode: true });
      break;
    }

    case 'codex-fork':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'codex');
        useWorkspaceStore.getState().markAiForkAutoTitle(tabId, 'codex', pendingAction.sessionId);
        const cwd = getTabCwd(tabId);
        console.log('[RESTORE] 12. Sending IPC codex:run-command { command: "codex-f" }');
        void launchPendingAgentAction(tabId, pendingAction.type, 'codex:run-command', buildCodexRunPayload({
          tabId,
          command: 'codex-f',
          sessionId: pendingAction.sessionId,
          cwd
        }));
      } else {
        clearTabPendingAction(tabId);
      }
      break;

    case 'codex-continue':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'codex');
        // pendingAction.sessionId is a resume target, not active-writer proof.
        console.log('[RESTORE] 12. Sending IPC codex:run-command { command: "codex-c" }');
        void launchPendingAgentAction(tabId, pendingAction.type, 'codex:run-command', buildCodexRunPayload({
          tabId,
          command: 'codex-c',
          sessionId: pendingAction.sessionId
        }));
      } else {
        clearTabPendingAction(tabId);
      }
      break;

    case 'codex-compact-fork':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'codex');
        useWorkspaceStore.getState().markAiForkAutoTitle(
          tabId,
          'codex',
          pendingAction.sourceSessionId || pendingAction.sessionId,
        );
        void launchPendingAgentAction(tabId, pendingAction.type, 'codex:run-command', buildCodexRunPayload({
          tabId,
          command: 'codex-c',
          sessionId: pendingAction.sessionId,
        }));
      } else {
        clearTabPendingAction(tabId);
      }
      break;

    case 'codex-new': {
      const store = useWorkspaceStore.getState();
      store.setTabCommandType(tabId, 'codex');
      store.markAiLaunchAutoTitle(tabId, 'codex');
      const codexCwd = getTabCwd(tabId);
      console.log('[RESTORE] 12. Materializing fresh Codex session before Resume');
      if (!pendingAgentActionLaunches.has(tabId)) {
        pendingAgentActionLaunches.add(tabId);
        void startFreshCodexSession({
          tabId,
          cwd: codexCwd,
          developerInstructions: pendingAction.developerInstructions,
        }).then((result) => {
          if (result.success) clearTabPendingAction(tabId);
          else console.warn('[RESTORE] Pending Codex start retained:', result.error);
        }).finally(() => pendingAgentActionLaunches.delete(tabId));
      }
      break;
    }

    case 'shell-command':
      console.log('[RESTORE] 12. shell-command — handled via initialCommand, nothing to do');
      break;
  }

  if (!pendingAction.type.startsWith('claude-') && !pendingAction.type.startsWith('codex-')) {
    clearTabPendingAction(tabId);
  }
};

// Regex to detect Claude session ID from terminal output
// Matches only "Session ID: <uuid>" - the most reliable and final pattern
const CLAUDE_SESSION_REGEX = /Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Debounce for session detection (saves only the last detected ID after 300ms)
let sessionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Helper: Get current command from xterm buffer (handles wrapped lines)
// When a long command wraps to multiple visual lines, we need to walk up
// and concatenate all wrapped line segments
// NOTE: When Enter is pressed, cursor already moved to next line, so we start from cursorY - 1
function getCurrentCommand(term: XTerminal): string {
  const buffer = term.buffer.active;
  let cursorY = buffer.cursorY;

  // When Enter is pressed, cursor is already on the NEW line (empty)
  // We need to look at the previous line where the command was typed
  if (cursorY > 0) {
    const currentLine = buffer.getLine(cursorY);
    if (currentLine && currentLine.translateToString(true).trim() === '') {
      cursorY--; // Go back to the command line
    }
  }

  let currentLineObj = buffer.getLine(cursorY);
  if (!currentLineObj) return '';

  // Collect line segments (walk up while lines are wrapped)
  let logicalLine = currentLineObj.translateToString(true);

  // While current line is marked as wrapped, the command starts above
  while (currentLineObj.isWrapped && cursorY > 0) {
    cursorY--;
    currentLineObj = buffer.getLine(cursorY);
    if (currentLineObj) {
      // Prepend the upper part of the command
      logicalLine = currentLineObj.translateToString(true) + logicalLine;
    }
  }

  return logicalLine;
}

const { ipcRenderer, clipboard } = window.require('electron');
const ptyAgentLaunchAttemptSeq = new Map<string, number>();

const invokePtyAgentLaunch = async (
  channel: 'claude:run-command' | 'codex:run-command',
  payload: any,
  pendingClaudeSessionId?: string | null,
) => {
  const attemptedToolType = channel.startsWith('codex') ? 'codex' : 'claude';
  const tabId = String(payload?.tabId || '');
  const attemptSeq = (ptyAgentLaunchAttemptSeq.get(tabId) || 0) + 1;
  ptyAgentLaunchAttemptSeq.set(tabId, attemptSeq);
  const isCurrentAttempt = () => ptyAgentLaunchAttemptSeq.get(tabId) === attemptSeq;
  try {
    const result = await ipcRenderer.invoke(channel, payload);
    if (result?.success === false || result?.accepted === false) {
      if (pendingClaudeSessionId) clearPendingResume(payload?.tabId);
      const message = result?.error || result?.reason || 'launch rejected';
      if (isCurrentAttempt()) {
        useWorkspaceStore.getState().restoreRejectedAiLaunchSnapshot(
          tabId,
          attemptedToolType,
          message,
        );
      }
      console.warn('[Terminal:AgentLaunch] rejected channel=' + channel
        + ' tab=' + String(payload?.tabId || '').slice(-12)
        + ' error=' + message);
      useUIStore.getState().showToast(
        `${channel.startsWith('codex') ? 'Codex' : 'Claude'} не запущен: ${message}`,
        'error',
      );
    }
    return result;
  } catch (error: any) {
    if (pendingClaudeSessionId) clearPendingResume(payload?.tabId);
    const message = error?.message || String(error);
    if (isCurrentAttempt()) {
      useWorkspaceStore.getState().restoreRejectedAiLaunchSnapshot(
        tabId,
        attemptedToolType,
        'invoke-failed:' + message,
      );
    }
    console.warn('[Terminal:AgentLaunch] invoke failed channel=' + channel
      + ' tab=' + String(payload?.tabId || '').slice(-12)
      + ' error=' + message);
    useUIStore.getState().showToast(
      `${channel.startsWith('codex') ? 'Codex' : 'Claude'} не запущен: ${message}`,
      'error',
    );
    return { success: false, accepted: false, error: message };
  } finally {
    if (isCurrentAttempt()) ptyAgentLaunchAttemptSeq.delete(tabId);
  }
};

const invokeTypedClaudeFork = async (
  tabId: string,
  sourceSessionId: string,
  cwd?: string,
) => {
  getSetTabCommandType()(tabId, 'claude');
  useWorkspaceStore.getState().markAiForkAutoTitle(tabId, 'claude', sourceSessionId);
  const result = await invokePtyAgentLaunch('claude:run-command', {
    tabId,
    command: 'claude-f',
    forkSessionId: sourceSessionId,
    cwd,
  });
  if (result?.success !== false && result?.accepted !== false && result?.sessionId) {
    // Main creates the fork only inside the proven-idle launch transaction.
    // The session-detected event normally binds this first; this idempotent
    // write also covers a renderer listener that mounted one tick late.
    getSetClaudeSessionId()(tabId, result.sessionId, 'fork');
  }
  return result;
};

let lastVisibleSetInvariantLogAt = 0;

type TerminalLayerSnapshot = {
  tabId: string;
  ownerProjectId: string;
  active: string;
  visibility: string;
  opacity: string;
  zIndex: string;
  pointerEvents: string;
  display: string;
  rect: string;
  intersectsViewport: boolean;
};

const collectTerminalLayerSnapshots = (): TerminalLayerSnapshot[] => {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-layer-tab-id]')).map((el) => {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const viewport = measureTerminalViewportIntersection({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    return {
      tabId: el.dataset.terminalLayerTabId || '',
      ownerProjectId: el.dataset.terminalLayerOwnerProject || '',
      active: el.dataset.terminalLayerActive || '',
      visibility: cs.visibility,
      opacity: cs.opacity,
      zIndex: cs.zIndex,
      pointerEvents: cs.pointerEvents,
      display: cs.display,
      rect: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
      intersectsViewport: viewport.intersectsViewport,
    };
  });
};

const isPaintedTerminalLayer = (layer: TerminalLayerSnapshot): boolean => {
  const opacity = Number.parseFloat(layer.opacity || '1');
  return layer.display !== 'none'
    && layer.visibility !== 'hidden'
    && opacity > 0.01
    && !layer.rect.startsWith('0x0@')
    && layer.intersectsViewport;
};

const rememberDetectedShellCommand = (tabId: string, fullLine: string, claudeAlive: boolean) => {
  if (claudeAlive) return;
  const command = fullLine.trim();
  if (!command) return;
  ipcRenderer.send('terminal:remember-detected-command', { tabId, command });
};

const formatCodexImagePasteError = (value: unknown): string => {
  const raw = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' && 'message' in value)
      ? String((value as { message?: unknown }).message)
      : String(value || 'unknown');
  return raw
    .replace(/[\r\n\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'unknown';
};

const CODEX_LOCAL_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const CODEX_LOCAL_IMAGE_EXT_BOUNDARY_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)(?=$|\s+(?:file:\/\/|\/))/ig;

const isCodexImagePathStart = (value: string, index: number): boolean => (
  value[index] === '/' || value.slice(index, index + 7).toLowerCase() === 'file://'
);

const skipCodexPathWhitespace = (value: string, index: number): number => {
  let i = index;
  while (i < value.length && /\s/.test(value[i])) i += 1;
  return i;
};

const normalizeLocalImagePathToken = (token: string): string | null => {
  const trimmed = token.trim();
  if (!trimmed) return null;
  let pathText = trimmed;
  if (trimmed.toLowerCase().startsWith('file://')) {
    try {
      pathText = decodeURIComponent(trimmed.replace(/^file:\/\//i, ''));
    } catch {
      pathText = trimmed.replace(/^file:\/\//i, '');
    }
  }
  return /^\/.+\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(pathText) ? pathText : null;
};

const readUnquotedLocalImagePathToken = (value: string, start: number): { token: string; end: number } | null => {
  CODEX_LOCAL_IMAGE_EXT_BOUNDARY_RE.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = CODEX_LOCAL_IMAGE_EXT_BOUNDARY_RE.exec(value)) !== null) {
    const end = CODEX_LOCAL_IMAGE_EXT_BOUNDARY_RE.lastIndex;
    const next = skipCodexPathWhitespace(value, end);
    if (next >= value.length || isCodexImagePathStart(value, next)) {
      return { token: value.slice(start, end), end };
    }
  }
  return null;
};

const normalizeLocalImagePathTexts = (text: string): string[] => {
  const value = text.trim();
  if (!value) return [];

  const paths: string[] = [];
  let index = 0;
  while (index < value.length) {
    index = skipCodexPathWhitespace(value, index);
    if (index >= value.length) break;

    const quote = value[index];
    let token = '';
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, index + 1);
      if (end < 0) return [];
      token = value.slice(index + 1, end);
      index = end + 1;
    } else {
      if (!isCodexImagePathStart(value, index)) return [];
      const read = readUnquotedLocalImagePathToken(value, index);
      if (!read) return [];
      token = read.token;
      index = read.end;
    }

    const normalized = normalizeLocalImagePathToken(token);
    if (!normalized || !CODEX_LOCAL_IMAGE_EXT_RE.test(normalized)) return [];
    paths.push(normalized);
  }

  return paths;
};

// Claude startup settings are orchestrated entirely in Electron main. This
// renderer intentionally has no send/prove/retry implementation: it only
// observes the durable gate snapshot published by main.
const terminalWarmQueue = new Map<string, () => void>();
let terminalWarmScheduled: any = null;

function scheduleTerminalWarmQueue() {
  if (terminalWarmScheduled !== null) return;
  const runNext = () => {
    terminalWarmScheduled = null;
    const next = terminalWarmQueue.entries().next();
    if (next.done) return;
    const [tabId, init] = next.value;
    terminalWarmQueue.delete(tabId);
    init();
    if (terminalWarmQueue.size > 0) {
      scheduleTerminalWarmQueue();
    }
  };
  const win = window as any;
  if (typeof win.requestIdleCallback === 'function') {
    terminalWarmScheduled = win.requestIdleCallback(runNext, { timeout: 1000 });
  } else {
    terminalWarmScheduled = window.setTimeout(runNext, 80);
  }
}

function scheduleTerminalWarmInit(tabId: string, init: () => void) {
  terminalWarmQueue.set(tabId, init);
  scheduleTerminalWarmQueue();
}

function cancelTerminalWarmInit(tabId: string) {
  terminalWarmQueue.delete(tabId);
}

async function finalizeAiLaunchSnapshot(tabId: string) {
  const store = useWorkspaceStore.getState();
  const snapshot: AiLaunchSnapshot | null = store.getAiLaunchSnapshot(tabId);
  if (!snapshot) return;

  let tabInfo: { cwd?: string; sessionId?: string } | null = null;
  for (const [, workspace] of store.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (!tab) continue;
    tabInfo = {
      cwd: tab.cwd,
      sessionId: snapshot.sessionType === 'claude' ? tab.claudeSessionId : tab.codexSessionId,
    };
    break;
  }

  if (!tabInfo) {
    store.clearAiLaunchSnapshot(tabId, 'tab-not-found-after-finish');
    return;
  }

  if (!tabInfo.sessionId) {
    if (snapshot.autoTitleMode === 'fork') {
      console.warn('[AiLaunchFinalize] tab=' + tabId.slice(-8) + ' type=' + snapshot.sessionType + ' result=no-session-id mode=fork → keep (bridge/watcher may detect forked session later)');
      return;
    }
    if (snapshot.sessionType === 'codex') {
      console.warn('[AiLaunchFinalize] tab=' + tabId.slice(-8) + ' type=codex result=no-session-id → keep (watcher may still detect rollout)');
      return;
    }
    console.warn('[AiLaunchFinalize] tab=' + tabId.slice(-8) + ' type=' + snapshot.sessionType + ' result=no-session-id → discard session artifact');
    await store.discardUnmaterializedAiLaunchSession(tabId, 'no-session-id-after-finish');
    return;
  }

  const channel = snapshot.sessionType === 'claude' ? 'claude:get-timeline' : 'codex:get-timeline';
  try {
    const result = await ipcRenderer.invoke(channel, {
      sessionId: tabInfo.sessionId,
      cwd: tabInfo.cwd,
      source: 'Terminal.finalizeAiLaunchSnapshot',
      reason: 'ai-launch-finalize',
      tabId,
      visible: null,
    });
    const entries = Array.isArray(result?.entries) ? result.entries.length : -1;
    console.warn('[AiLaunchFinalize] tab=' + tabId.slice(-8) + ' type=' + snapshot.sessionType + ' sid=' + tabInfo.sessionId.slice(0, 8) + ' success=' + !!result?.success + ' entries=' + entries + (result?.error ? ' error=' + result.error : ''));
    if (result?.success && entries === 0) {
      console.warn('[AiLaunchFinalize] tab=' + tabId.slice(-8) + ' type=' + snapshot.sessionType + ' result=empty-timeline → discard session artifact');
      await store.discardUnmaterializedAiLaunchSession(tabId, 'empty-timeline-after-finish');
    } else {
      store.clearAiLaunchSnapshot(tabId, 'timeline-entries=' + entries);
    }
  } catch (e: any) {
    console.warn('[AiLaunchFinalize] tab=' + tabId.slice(-8) + ' type=' + snapshot.sessionType + ' check-failed=' + (e?.message || String(e)) + ' → keep');
  }
}

interface TerminalProps {
  tabId: string;
  cwd: string;
  active?: boolean;
  isActiveProject?: boolean; // For lazy init optimization
  ownerProjectId?: string;
  onLinkClick?: (url: string) => void; // Override link handler (no caller today: the embedded browser tab that used it is gone)
  presented?: boolean;
  promptQueuePortalHostId?: string;
  hidePromptQueueHistoryToggle?: boolean;
  promptQueueInputSurface?: 'terminal' | 'history';
  // Pane-owned Run after lives in a persistent portal host. Keep its component
  // mounted while the pane's outer wrapper is visibility:hidden so a space
  // switch does not tear down/recreate the whole queue editor subtree.
  keepPromptQueueMounted?: boolean;
}

function Terminal({
  tabId,
  cwd,
  active: activeProp,
  isActiveProject: isActiveProjectProp,
  ownerProjectId,
  onLinkClick,
  presented: presentedProp = true,
  promptQueuePortalHostId,
  hidePromptQueueHistoryToggle = false,
  promptQueueInputSurface = 'terminal',
  keepPromptQueueMounted = false,
}: TerminalProps) {
  const activeFromStore = useWorkspaceStore((state) => {
    if (!ownerProjectId) return false;
    const workspace = state.openProjects.get(ownerProjectId);
    if (!workspace || state.activeProjectId !== ownerProjectId) return false;

    // MCP sub-agent viewport: show sub-agent instead of its parent Gemini tab.
    if (workspace.viewingSubAgentTabId) {
      const viewedTab = workspace.tabs.get(workspace.viewingSubAgentTabId);
      if (viewedTab && viewedTab.parentTabId === workspace.activeTabId) {
        return tabId === workspace.viewingSubAgentTabId;
      }
    }

    return workspace.activeTabId === tabId;
  });
  const isActiveProjectFromStore = useWorkspaceStore((state) => {
    return ownerProjectId ? state.activeProjectId === ownerProjectId : true;
  });
  const active = activeProp ?? activeFromStore;
  const isActiveProject = isActiveProjectProp ?? isActiveProjectFromStore;
  const terminalPid = useWorkspaceStore((state): number | null => {
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return Number.isFinite(tab.pid) ? Number(tab.pid) : null;
    }
    return null;
  });
  const terminalPidRef = useRef<number | null>(terminalPid);
  terminalPidRef.current = terminalPid;

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const isInitialized = useRef(false);
  const isMounted = useRef(true);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const isReadyRef = useRef(false); // Track if first fit completed
  const hasBeenActive = useRef(false); // Track if tab was ever active (for lazy init)
  const isCreatingRef = useRef(false); // Lock to prevent double initialization
  const activeRef = useRef(active); // Track current active state for ResizeObserver closure
  const pendingBuffer = useRef(createTerminalHydrationBuffer()); // Sequence-aware PTY tail while renderer xterm is cold
  const hydrationActivity = useRef(createTerminalHydrationActivity()); // Nested generation retries share one active lifetime
  const rendererFlushedHeadlessWriteSeq = useRef<number | null>(null);
  const rendererFlushedHeadlessGeneration = useRef<string | null>(null);
  const rendererFlushedHeadlessGenerationOrdinal = useRef<number | null>(null);
  const rendererBoundPtyPid = useRef<number | null>(terminalPid);
  const terminalWritePumpRef = useRef<{ term: XTerminal; pump: any } | null>(null);
  const [isVisible, setIsVisible] = useState(false); // Hide until ready
  // Терминалу не хватило места, и он вылез за край окна — об этом говорим
  // вслух, иначе уехавшая под границу строка читается как поломка.
  const [terminalClipped, setTerminalClipped] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false); // Show "scroll to bottom" button
  const savedScrollPosition = useRef<number | null>(null); // Save scroll position when tab becomes inactive
  const wasAtBottom = useRef<boolean>(true); // Track if terminal was at bottom when deactivated
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const claudeSessionDetected = useRef<string | null>(null); // Track detected Claude session UUID
  const pendingActionExecuted = useRef(false); // Track if pendingAction was executed
  const pinnedTimelineSettleRafRef = useRef<number | null>(null);

  const writeTerminalData = (term: XTerminal, data: string) => new Promise<void>((resolve) => {
    if (!data) {
      resolve();
      return;
    }
    term.write(data, resolve);
  });

  const markRendererHeadlessWriteFlushed = (
    writeSeq?: number | null,
    generation?: string | null,
    generationOrdinal?: number | null,
    rendererTerminal?: XTerminal | null,
  ) => {
    if (!Number.isFinite(writeSeq)) return;
    const seq = Number(writeSeq);
    const ordinal = Number.isFinite(generationOrdinal) ? Number(generationOrdinal) : null;
    const currentOrdinal = rendererFlushedHeadlessGenerationOrdinal.current;

    if (
      ordinal !== null
      && (currentOrdinal === null || ordinal > currentOrdinal)
    ) {
      rendererFlushedHeadlessGeneration.current = generation || null;
      rendererFlushedHeadlessGenerationOrdinal.current = ordinal;
      rendererFlushedHeadlessWriteSeq.current = seq;
      const terminalForBoundary = rendererTerminal || xtermInstance.current;
      if (terminalForBoundary) {
        terminalRegistry.markRendererWriteFlushed(tabId, terminalForBoundary, {
          writeSeq: seq,
          generation: generation || null,
          generationOrdinal: ordinal,
        });
      }
      return;
    }
    if (
      ordinal !== null
      && currentOrdinal !== null
      && ordinal < currentOrdinal
    ) {
      return;
    }
    if (
      generation
      && rendererFlushedHeadlessGeneration.current
      && generation !== rendererFlushedHeadlessGeneration.current
    ) {
      return;
    }
    rendererFlushedHeadlessGeneration.current = generation || rendererFlushedHeadlessGeneration.current;
    rendererFlushedHeadlessGenerationOrdinal.current = ordinal ?? currentOrdinal;
    rendererFlushedHeadlessWriteSeq.current = Math.max(
      rendererFlushedHeadlessWriteSeq.current || 0,
      seq,
    );
    const terminalForBoundary = rendererTerminal || xtermInstance.current;
    if (terminalForBoundary) {
      terminalRegistry.markRendererWriteFlushed(tabId, terminalForBoundary, {
        writeSeq: rendererFlushedHeadlessWriteSeq.current,
        generation: rendererFlushedHeadlessGeneration.current,
        generationOrdinal: rendererFlushedHeadlessGenerationOrdinal.current,
      });
    }
  };

  const ensureTerminalWritePump = (term: XTerminal) => {
    if (terminalWritePumpRef.current?.term === term) {
      return terminalWritePumpRef.current.pump;
    }
    try { terminalWritePumpRef.current?.pump?.dispose?.(); } catch {}
    const pump = createXtermWritePump(
      (data: string, done: () => void) => term.write(data, done),
      {
        beforeWrite: (meta: any) => {
          const nextGeneration = typeof meta?.generation === 'string'
            ? meta.generation
            : null;
          const nextOrdinal = Number.isFinite(meta?.generationOrdinal)
            ? Number(meta.generationOrdinal)
            : null;
          const currentGeneration = rendererFlushedHeadlessGeneration.current;
          const currentOrdinal = rendererFlushedHeadlessGenerationOrdinal.current;
          const generationAdvanced = nextOrdinal !== null
            && currentOrdinal !== null
            && nextOrdinal > currentOrdinal;
          const generationChangedAtSameOrdinal = !!(
            nextGeneration
            && currentGeneration
            && nextGeneration !== currentGeneration
            && (nextOrdinal === null || currentOrdinal === null || nextOrdinal === currentOrdinal)
          );
          if (!generationAdvanced && !generationChangedAtSameOrdinal) return;

          // Reset only when the first batch from the replacement PTY reaches
          // the head of the physical write queue. An eager reset would let a
          // late old-generation write repaint over the new TUI.
          term.reset();
          terminalRegistry.clearPromptBoundaries(tabId);
          getBufferActions().clear(tabId);
          savedScrollPosition.current = null;
          wasAtBottom.current = true;
          console.warn('[Terminal:GENERATION_RESET] tab=' + tabId.slice(-12)
            + ' old=' + (currentGeneration ? currentGeneration.slice(0, 8) : '-')
            + '/' + (currentOrdinal ?? '-')
            + ' new=' + (nextGeneration ? nextGeneration.slice(0, 8) : '-')
            + '/' + (nextOrdinal ?? '-'));
        },
        onFlushed: (meta: any) => {
          markRendererHeadlessWriteFlushed(
            meta?.writeSeq,
            meta?.generation,
            meta?.generationOrdinal,
          );
        },
        onError: (error: Error) => {
          console.error('[Terminal:WRITE_PUMP] tab=' + tabId.slice(-12)
            + ' error=' + (error?.message || String(error)));
        },
      },
    );
    terminalWritePumpRef.current = { term, pump };
    return pump;
  };

  const enqueueTerminalChunk = (
    data: string,
    metadata: {
      writeSeq?: number | null;
      generation?: string | null;
      generationOrdinal?: number | null;
    } = {},
  ) => {
    if (!data) return;
    const term = xtermInstance.current;
    const buffering = !term || isTerminalHydrationActive(hydrationActivity.current);
    if (buffering) {
      appendTerminalHydrationChunk(
        pendingBuffer.current,
        data,
        metadata.writeSeq,
        metadata.generation,
        metadata.generationOrdinal,
        isTerminalHydrationActive(hydrationActivity.current)
          ? Number.POSITIVE_INFINITY
          : undefined,
      );
      return;
    }
    ensureTerminalWritePump(term).push(data, metadata);
  };

  const hydrateTerminalBuffer = async (term: XTerminal): Promise<boolean> => {
    const endHydration = beginTerminalHydration(hydrationActivity.current);
    // Freeze attribution: xterm snapshot replay + tail drain runs inside the
    // tab-switch frame cluster; without its own mark this work was billed to
    // whatever else (History owner-mount) overlapped the same long task.
    const endSwapMark = markRendererActivity('terminal-hydrate:' + tabId.slice(-8));
    try {
      let snapshot: any = null;
      try {
        snapshot = await ipcRenderer.invoke('terminal:get-headless-buffer-snapshot', { tabId });
      } catch (error: any) {
        snapshot = { success: false, error: error?.message || String(error) };
      }

      if (!isMounted.current) {
        try { term.dispose(); } catch {}
        return false;
      }

      let snapshotWriteSeq: number | null = null;
      let snapshotGeneration: string | null = null;
      let snapshotGenerationOrdinal: number | null = null;
      let source = 'renderer-fallback';
      let snapshotChars = 0;
      let restoredPromptBoundaries = 0;
      const savedCheckpoint = normalizeTerminalBufferCheckpoint(getBufferActions().get(tabId));

      if (snapshot?.success === true && typeof snapshot.serialized === 'string') {
        const mainCheckpoint = {
          serialized: snapshot.serialized,
          headlessWriteSeq: Number.isFinite(snapshot.writeSeq) ? Number(snapshot.writeSeq) : null,
          headlessGeneration: typeof snapshot.generation === 'string'
            ? snapshot.generation
            : null,
          headlessGenerationOrdinal: Number.isFinite(snapshot.generationOrdinal)
            ? Number(snapshot.generationOrdinal)
            : null,
          cols: Number.isFinite(snapshot.cols) ? Number(snapshot.cols) : null,
          rows: Number.isFinite(snapshot.rows) ? Number(snapshot.rows) : null,
        };
        if (decideTerminalHydrationGeneration(
          pendingBuffer.current,
          mainCheckpoint.headlessGenerationOrdinal,
          true,
        ) === 'retry-authoritative-snapshot') {
          console.warn('[Terminal:HYDRATE] newer mirror generation arrived before snapshot replay tab='
            + tabId.slice(-12)
            + ' snapshotGeneration=' + (mainCheckpoint.headlessGeneration || '-'));
          return hydrateTerminalBuffer(term);
        }
        const useSavedCheckpoint = shouldPreferSavedTerminalCheckpoint(
          savedCheckpoint,
          mainCheckpoint,
        );
        const selectedSerialized = useSavedCheckpoint
          ? savedCheckpoint!.serialized
          : snapshot.serialized;
        const selectedBoundaries = useSavedCheckpoint
          ? savedCheckpoint!.promptBoundaries
          : snapshot.promptBoundaries;
        const snapshotCols = Number(useSavedCheckpoint ? savedCheckpoint!.cols : snapshot.cols);
        const snapshotRows = Number(useSavedCheckpoint ? savedCheckpoint!.rows : snapshot.rows);
        if (
          Number.isFinite(snapshotCols)
          && Number.isFinite(snapshotRows)
          && snapshotCols >= 2
          && snapshotRows >= 2
          && (term.cols !== snapshotCols || term.rows !== snapshotRows)
        ) {
          term.resize(snapshotCols, snapshotRows);
        }
        snapshotWriteSeq = mainCheckpoint.headlessWriteSeq;
        snapshotGeneration = mainCheckpoint.headlessGeneration;
        snapshotGenerationOrdinal = mainCheckpoint.headlessGenerationOrdinal;
        snapshotChars = selectedSerialized.length;
        source = useSavedCheckpoint ? 'renderer-saved-current' : 'headless-main';
        await writeTerminalData(term, selectedSerialized);
        if (decideTerminalHydrationGeneration(
          pendingBuffer.current,
          snapshotGenerationOrdinal,
          true,
        ) === 'retry-authoritative-snapshot') {
          console.warn('[Terminal:HYDRATE] mirror generation changed during snapshot replay tab='
            + tabId.slice(-12)
            + ' snapshotGeneration=' + (snapshotGeneration || '-'));
          term.reset();
          return hydrateTerminalBuffer(term);
        }
        markRendererHeadlessWriteFlushed(
          snapshotWriteSeq,
          snapshotGeneration,
          snapshotGenerationOrdinal,
          term,
        );
        restoredPromptBoundaries = terminalRegistry.restorePromptBoundaries(
          tabId,
          term,
          selectedBoundaries,
        );
        getBufferActions().clear(tabId);
      } else if (savedCheckpoint) {
        // Main/headless is the normal authority. The renderer snapshot remains a
        // compatibility fallback for a missing mirror/addon, not a competing
        // source that can overwrite a successful main hydration.
        const savedCols = Number(savedCheckpoint.cols);
        const savedRows = Number(savedCheckpoint.rows);
        if (
          Number.isFinite(savedCols)
          && Number.isFinite(savedRows)
          && savedCols >= 2
          && savedRows >= 2
          && (term.cols !== savedCols || term.rows !== savedRows)
        ) {
          term.resize(savedCols, savedRows);
        }
        snapshotWriteSeq = Number.isFinite(savedCheckpoint.headlessWriteSeq)
          ? Number(savedCheckpoint.headlessWriteSeq)
          : null;
        snapshotGeneration = savedCheckpoint.headlessGeneration || null;
        snapshotGenerationOrdinal = Number.isFinite(savedCheckpoint.headlessGenerationOrdinal)
          ? Number(savedCheckpoint.headlessGenerationOrdinal)
          : null;
        snapshotChars = savedCheckpoint.serialized.length;
        source = 'renderer-saved';
        await writeTerminalData(term, savedCheckpoint.serialized);
        if (decideTerminalHydrationGeneration(
          pendingBuffer.current,
          snapshotGenerationOrdinal,
          false,
        ) === 'preserve-and-retry-later') {
          console.error('[Terminal:HYDRATE] authority unavailable for newer mirror generation tab='
            + tabId.slice(-12)
            + ' savedGeneration=' + (snapshotGeneration || '-')
            + ' action=preserve-pending-and-retry-on-next-open');
          isCreatingRef.current = false;
          try { term.dispose(); } catch {}
          return false;
        }
        markRendererHeadlessWriteFlushed(
          snapshotWriteSeq,
          snapshotGeneration,
          snapshotGenerationOrdinal,
          term,
        );
        restoredPromptBoundaries = terminalRegistry.restorePromptBoundaries(
          tabId,
          term,
          savedCheckpoint.promptBoundaries,
        );
        getBufferActions().clear(tabId);
      }

      if (!isMounted.current) {
        try { term.dispose(); } catch {}
        return false;
      }

      // Single-threaded handoff: drain everything newer than the serialized
      // main boundary, publish the live xterm reference, then enqueue that tail.
      // Any later terminal:data event sees xtermInstance and is queued after it.
      const tailChunks = takeTerminalHydrationChunks(
        pendingBuffer.current,
        snapshotWriteSeq,
        snapshotGeneration,
      );
      const tailChars = tailChunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
      const writePump = ensureTerminalWritePump(term);
      xtermInstance.current = term;
      for (const chunk of tailChunks) {
        writePump.push(chunk.data, {
          writeSeq: chunk.writeSeq,
          generation: chunk.generation,
          generationOrdinal: chunk.generationOrdinal,
        });
      }

      const snapshotAccepted = source !== 'renderer-fallback';
      console.warn(
        '[Terminal:HYDRATE] tab=' + tabId.slice(-12)
        + ' source=' + source
        + ' snapshotAccepted=' + snapshotAccepted
        + ' generation=' + (snapshotGeneration ? snapshotGeneration.slice(0, 8) : '-')
        + ' snapshotSeq=' + (snapshotWriteSeq ?? '-')
        + ' snapshotChars=' + snapshotChars
        + ' tailChars=' + tailChars
        + ' tailItems=' + tailChunks.length
        + ' promptBoundaries=' + restoredPromptBoundaries
        + ' error=' + (snapshotAccepted ? '-' : (snapshot?.error || 'unknown')),
      );
      const proofGeneration = snapshotGeneration;
      const proofWriteSeq = snapshotWriteSeq;
      const proofPid = rendererBoundPtyPid.current;
      const proofStartedAt = performance.now();
      void waitForXtermPresentationAfterDrain({
        drain: () => writePump.drain(),
        requestFrame: (callback) => requestAnimationFrame(callback),
        isCurrent: () => (
          isMounted.current
          && xtermInstance.current === term
          && rendererBoundPtyPid.current === proofPid
          && (!proofGeneration
            || rendererFlushedHeadlessGeneration.current === proofGeneration)
        ),
      }).then((proof) => {
        if (!proof.presented) {
          console.warn('[Terminal:SURFACE_PRESENTED] tab=' + tabId.slice(-12)
            + ' presented=false'
            + ' reason=' + proof.reason
            + ' pid=' + (proofPid ?? '-')
            + ' generation=' + (proofGeneration ? proofGeneration.slice(0, 8) : '-')
            + ' snapshotSeq=' + (proofWriteSeq ?? '-')
            + ' tailChars=' + tailChars
            + ' tailItems=' + tailChunks.length
            + ' durMs=' + (performance.now() - proofStartedAt).toFixed(1));
          return;
        }
        const buffer = term.buffer.active;
        const visibleRows: string[] = [];
        const firstRow = buffer.viewportY;
        const lastRow = Math.min(buffer.length, firstRow + term.rows);
        for (let row = firstRow; row < lastRow; row += 1) {
          visibleRows.push(buffer.getLine(row)?.translateToString(true) || '');
        }
        console.warn('[Terminal:SURFACE_PRESENTED] tab=' + tabId.slice(-12)
          + ' presented=true'
          + ' snapshotAccepted=' + snapshotAccepted
          + ' tailFlushed=true'
          + ' pid=' + (proofPid ?? '-')
          + ' generation=' + (proofGeneration ? proofGeneration.slice(0, 8) : '-')
          + ' snapshotSeq=' + (proofWriteSeq ?? '-')
          + ' tailChars=' + tailChars
          + ' tailItems=' + tailChunks.length
          + ' viewportY=' + buffer.viewportY
          + ' baseY=' + buffer.baseY
          + ' cursor=' + buffer.cursorX + ',' + buffer.cursorY
          + ' rowsDigest=' + digestTerminalVisibleText(visibleRows.join('\n'))
          + ' durMs=' + (performance.now() - proofStartedAt).toFixed(1));
      }).catch((error: any) => {
        console.warn('[Terminal:SURFACE_PRESENTED] tab=' + tabId.slice(-12)
          + ' presented=false'
          + ' reason=probe-error'
          + ' error=' + (error?.message || String(error)));
      });
      return true;
    } finally {
      endHydration();
      endSwapMark();
    }
  };

  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const historyPanelOpen = useUIStore((state) => state.historyPanelOpenTabs[tabId] ?? false);
  const historyPinnedSetting = useUIStore((state) => state.historyPinned);
  // Which of the two surfaces holds the centre for THIS tab. The terminal used
  // not to know: it always measured its right edge as if it were the centre,
  // which is wrong exactly when the transcript holds the centre and the
  // terminal is the panel docked beside it.
  const isTerminalCentre = useUIStore((state) => resolveTabTerminalPrimary(state, tabId));
  const selectedPromptQueueInputSurface = useUIStore((state) => (
    promptQueueInputSurface === 'history'
      ? (presentedProp ? (state.promptQueueInputSurfaceTabs[tabId] ?? 'history') : 'history')
      : 'terminal'
  ));
  const setPromptQueueInputSurface = useUIStore((state) => state.setPromptQueueInputSurface);
  const timelineTreeMode = useUIStore((state) => state.timelineTreeModeTabs[tabId] ?? false);
  const timelineWidth = useUIStore((state) => state.timelineWidth);
  const timelinePinned = useUIStore((state) => state.timelinePinned);
  // Right inset = how far Run after must step LEFT so nothing covers it.
  //
  // Both right-edge surfaces push it, and they stack: the expanded Timeline and
  // the Cmd+] side panel (transcript OR terminal — the same slot, so its width
  // is whichever one is showing). Run after ALWAYS moves; the pin toggle only
  // decides whether the CENTER surface also gives up space, which is a separate
  // question. Previously only the Timeline counted, so opening the side panel
  // left the strip behind it.
  const sideTerminalWidth = useUIStore((state) => state.sideTerminalWidth);
  const historyPanelWidth = useUIStore((state) => state.historyPanelWidth);
  const sideTerminalOpen = useUIStore((state) => state.sideTerminalOpenTabs[tabId] ?? false);
  // Which side panel is open depends on the layout: transcript-primary docks
  // the TERMINAL to the right, terminal-primary docks the TRANSCRIPT. Shared
  // arithmetic (surfaceInsets) — the Run after strip and BOTH scroll-to-bottom
  // arrows sit in this same box and must dodge the same obstacles by the same
  // amount.
  // WHOSE right edge is this? The inset exists to keep things clear of a panel
  // docked at the CENTRE's right edge. When this terminal is itself that
  // panel, it has no such obstacle — its own right edge is the panel's edge.
  //
  // Missing this produced the reported bug in both directions: as the side
  // panel the terminal shifted its arrow left by its OWN width, pushing it out
  // of the panel entirely (the user saw no arrow in the side terminal, while
  // the centre showed one); and the shift used the STORED panel width, so
  // dragging the panel did not move the strip with it.
  // TWO numbers, because there are two boxes — and conflating them is what made
  // the strip stop moving.
  //
  // The scroll arrow is drawn INSIDE this terminal, so it measures against the
  // terminal's own right edge. The Run after strip is portalled OUT to a host
  // that spans the whole centre column (see Workspace: promptQueuePortalHostId),
  // so it measures against the CENTRE's right edge. In transcript-primary those
  // edges are different things: the terminal is the docked side panel and has
  // nothing to dodge, while the strip still has to step left by that same panel's
  // width. One shared value answered the terminal's question and therefore froze
  // the strip in place — exactly the reported "Cmd+] and Run after does not move".
  const sharedInsetArgs = {
    treeMode: timelineTreeMode,
    pinned: timelinePinned,
    width: timelineWidth,
    sideTerminalOpen: promptQueueInputSurface === 'history' && sideTerminalOpen,
    sideTerminalWidth,
    // The transcript is only an OBSTACLE while it is docked BESIDE the centre —
    // i.e. in terminal-primary. When it holds the centre itself (the terminal is
    // then the side panel), "open" says nothing about the right edge: the
    // transcript IS the surface underneath, so there is nothing to dodge.
    //
    // Reading the bare open-flag inset the strip by a transcript width in the
    // exact layout the user reported: transcript centred, side terminal CLOSED,
    // and Run after nevertheless parked ~580px inside as though a panel were
    // there. Opening the side terminal then swapped the strip onto the terminal's
    // own inset and it appeared to vanish.
    sideHistoryOpen: historyPanelOpen && isTerminalCentre,
    sideHistoryWidth: historyPanelWidth,
    // A pinned panel is a column: the centre already ends before it.
    sidePanelPinned: historyPinnedSetting,
  };
  // Run after больше НЕ отходит от бокового окна (2026-08-17).
  //
  // Полоска уезжала влево, когда справа открывалось боковое окно — терминал или
  // переписка, — чтобы не оказаться под ним. Плата за это: полоска меняла место
  // при каждом ⌘] / ⌘-переключении поверхностей, а сдвиг был заметно больше её
  // самой. Отступать ей и не нужно: у неё есть свёрнутый вид, в котором она и
  // так почти ничего не занимает. Юзер: *«он не должен сдвигаться влево, я решил
  // эту фичу убрать, так как у нас уже доступен свёрнутый режим»*.
  //
  // От РАЗВЁРНУТОГО Timeline полоска отступает по-прежнему: это не окно, которое
  // можно закрыть одной клавишей, а колонка, поверх которой полоска была бы
  // просто не видна. Поэтому здесь именно ширина Timeline, а не общий отступ.
  //
  // Кнопки, привязанные к САМОМУ терминалу (стрелка вниз, кнопка второй
  // поверхности), отступают как раньше — они живут в другой коробке, и её правый
  // край боковое окно действительно закрывает.
  const promptQueueRightInset = resolveTimelineInset(sharedInsetArgs);
  // Anchored to THIS terminal → when the terminal IS the docked panel, its own
  // right edge is already clear and insetting would push the arrow out of itself.
  const terminalArrowRightInset = resolveCenterRightInset({
    ...sharedInsetArgs,
    isSidePanel: promptQueueInputSurface === 'history' && sideTerminalOpen && !isTerminalCentre,
  });
  const workspaceView = useWorkspaceStore((state) => state.view);

  // Prompt-queue overlay needs to know two things:
  //  - is this a supported AI tab? (Claude/Codex owners can receive queued prompts)
  //  - is the agent busy? (so the Run-queue UI can pulse correctly).
  // Granular selectors per `fix-performance-lags.md` — never subscribe to whole openProjects Map.
  const promptQueueAgent = useWorkspaceStore((state): 'claude' | 'codex' | null => {
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return resolvePtyAgentOwner(tab);
    }
    return null;
  });
  const storedCommandType = useWorkspaceStore((state) => {
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return tab.commandType || null;
    }
    return null;
  });
  const promptQueueAgentRef = useRef<'claude' | 'codex' | null>(promptQueueAgent);
  useEffect(() => {
    promptQueueAgentRef.current = promptQueueAgent;
  }, [promptQueueAgent]);
  useEffect(() => {
    if (!promptQueueAgent || storedCommandType === promptQueueAgent) return;
    console.warn('[Terminal:AgentOwnerRepair] tab=' + tabId.slice(-8)
      + ' stale=' + (storedCommandType || 'none')
      + ' owner=' + promptQueueAgent);
    useWorkspaceStore.getState().setTabCommandType(tabId, promptQueueAgent);
  }, [promptQueueAgent, storedCommandType, tabId]);
  const agentBusy = useWorkspaceStore((state) => {
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return !!(tab.aiBusy || tab.claudeBusy);
    }
    return false;
  });
  // Session/process state is diagnostic only. Run After is persistent
  // configuration for an AI-typed tab, so it must remain available before the
  // first launch and after Stop. Runtime readiness is enforced by the always-on
  // queue runner immediately before a queued prompt is sent.
  const hasPromptQueueSession = useWorkspaceStore((state) => {
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      const owner = resolvePtyAgentOwner(tab);
      if (owner === 'codex') return !!tab.codexSessionId;
      if (owner === 'claude') return !!tab.claudeSessionId;
      return false;
    }
    return false;
  });
  const allowCodexProcessLookup = useWorkspaceStore((state) => {
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      return resolvePtyAgentOwner(tab) === 'codex' || !!tab.codexSessionId;
    }
    return false;
  });
  const [claudeProcessAlive, setClaudeProcessAlive] = useState(false);
  // Synchronous mirror for use inside the xterm key handler (which captures a
  // stale closure). Tells command-type auto-detection "a foreground program is
  // running" → getCurrentCommand() reads PROGRAM OUTPUT, not a shell command,
  // so devServer/gemini regex matches (e.g. Claude rendering `⏺ Bash(npm run
  // dev…)`) must NOT downgrade the tab type. See fix #2 / fact-tabs.md.
  const claudeProcessAliveRef = useRef(false);
  const foregroundProcessKnownRef = useRef(false);
  useEffect(() => {
    const onStarted = (_: any, data: { tabId: string }) => {
      if (data.tabId === tabId) {
        foregroundProcessKnownRef.current = true;
        console.warn('[QueueGate:proc] tab=' + tabId.slice(-8) + ' command-started → alive=true');
        claudeProcessAliveRef.current = true;
        setClaudeProcessAlive(true);
      }
    };
    const onFinished = (_: any, data: { tabId: string }) => {
      if (data.tabId === tabId) {
        foregroundProcessKnownRef.current = true;
        const wasAlive = claudeProcessAliveRef.current;
        const launchSnapshot = useWorkspaceStore.getState().getAiLaunchSnapshot(tabId);
        if (!wasAlive && launchSnapshot) {
          console.warn('[QueueGate:proc] tab=' + tabId.slice(-8) + ' command-finished ignored before alive for launch snapshot type=' + launchSnapshot.sessionType);
          return;
        }
        console.warn('[QueueGate:proc] tab=' + tabId.slice(-8) + ' command-finished → alive=false');
        claudeProcessAliveRef.current = false;
        setClaudeProcessAlive(false);
        // These renderer maps mirror explicit user choices for ControlBar and
        // mobile presentation only. Main clears its own launch-scoped startup
        // claims from the same OSC 133 D lifecycle edge.
        _effortSentForTab.delete(tabId);
        _modelSentForTab.delete(tabId);
        _claudeBridgeModelByTab.delete(tabId);
        finalizeAiLaunchSnapshot(tabId);
      }
    };
    ipcRenderer.on('terminal:command-started', onStarted);
    ipcRenderer.on('terminal:command-finished', onFinished);
    // Initial sync — main keeps per-tab state we can poll once.
    ipcRenderer.invoke('terminal:getCommandState', {
      tabId,
      caller: 'Terminal.initialSync',
      expectedProcess: 'codex',
      allowProcessTreeLookup: allowCodexProcessLookup,
    }).then((s: any) => {
      foregroundProcessKnownRef.current = true;
      console.warn('[QueueGate:proc] tab=' + tabId.slice(-8) + ' initial-sync isRunning=' + !!s?.isRunning);
      if (s?.isRunning) { claudeProcessAliveRef.current = true; setClaudeProcessAlive(true); }
    }).catch(() => {});
    return () => {
      ipcRenderer.removeListener('terminal:command-started', onStarted);
      ipcRenderer.removeListener('terminal:command-finished', onFinished);
    };
  }, [tabId, allowCodexProcessLookup]);

  // Per-project currentView: find which project owns this tab and read its currentView
  const projectCurrentView = useWorkspaceStore((state) => {
    if (ownerProjectId) {
      return state.openProjects.get(ownerProjectId)?.currentView || 'terminal';
    }
    for (const [, workspace] of state.openProjects) {
      if (workspace.tabs.has(tabId)) {
        return workspace.currentView || 'terminal';
      }
    }
    return 'terminal';
  });

  // Effective active = tab is active AND we're in terminal view AND workspace is visible (not Dashboard)
  // This prevents focus/fit/repaint when terminals are hidden behind Dashboard or ProjectHome
  const effectiveActive = active && projectCurrentView === 'terminal' && workspaceView === 'workspace';
  const effectivePresented = effectiveActive && presentedProp;
  // "On screen" and "may swallow the keyboard" are different questions. A CLOSED
  // side terminal stays mounted and active on purpose (PTY, buffer and
  // scrollback survive so opening it is instant) — but nothing about it is
  // visible, so a keystroke it takes is a keystroke that disappears. Shared rule
  // so all four focus-grab sites below answer identically.
  const mayClaimFocus = canTerminalClaimFocus({
    active: effectiveActive,
    presented: presentedProp,
    terminalIsCentre: isTerminalCentre,
    sideTerminalOpen,
    hasSurfacePair: promptQueueInputSurface === 'history',
  });
  const mayClaimFocusRef = useRef(mayClaimFocus);
  useEffect(() => { mayClaimFocusRef.current = mayClaimFocus; }, [mayClaimFocus]);
  const [promptQueuePortalHost, setPromptQueuePortalHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!promptQueuePortalHostId) {
      setPromptQueuePortalHost(null);
      return;
    }
    setPromptQueuePortalHost(document.getElementById(promptQueuePortalHostId));
  }, [promptQueuePortalHostId]);

  // «Пустая вкладка»: пока в ней ничего не запущено, терминал отдаёт место в
  // своей середине под кнопки запуска. Признак читается из тех же полей
  // вкладки, что и везде — это описание, а не отдельное состояние
  // (см. emptyTab.mjs). Селектор возвращает булево, не объект вкладки.
  const isEmptyTabHere = useWorkspaceStore((s) => {
    // Свой проект известен — ищем прямо в нём. Обход всех открытых проектов
    // выполнялся бы на КАЖДУЮ запись в состояние, у каждого терминала.
    const own = ownerProjectId ? s.openProjects.get(ownerProjectId)?.tabs.get(tabId) : null;
    if (own) return isEmptyTab(own);
    for (const workspace of s.openProjects.values()) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return isEmptyTab(tab);
    }
    return false;
  });
  const emptyLaunchSlotRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Публикуем узел ПОСЛЕ отрисовки — до неё ref пуст, и подписчик получил бы
    // «места нет» ровно в тот кадр, когда место появилось.
    const node = isEmptyTabHere ? emptyLaunchSlotRef.current : null;
    setEmptyTabLaunchHost(tabId, node);
    return () => releaseEmptyTabLaunchHost(tabId, node);
  }, [tabId, isEmptyTabHere]);

  useEffect(() => {
    if (!effectivePresented || !isVisible) return;

    const frameId = requestAnimationFrame(() => {
      const layers = collectTerminalLayerSnapshots();
      const painted = layers.filter(isPaintedTerminalLayer);
      // Split workspace legitimately paints one terminal PER PANE; the
      // invariant then is "painted set == pane set", not "exactly one".
      const splitPanes = useWorkspaceStore.getState().splitPanes;
      if (splitPanes.length > 0) {
        const paneTabIds = new Set(splitPanes.map((p) => p.tabId));
        const paintedOk = painted.length <= paneTabIds.size
          && painted.every((l) => paneTabIds.has(l.tabId));
        if (paintedOk) return;
      }
      const ok = painted.length === 1 && painted[0]?.tabId === tabId;
      if (ok) return;

      const now = Date.now();
      if (now - lastVisibleSetInvariantLogAt < 1000) return;
      lastVisibleSetInvariantLogAt = now;

      console.warn('[Terminal:VisibleSetInvariant] count=' + painted.length
        + ' expected=' + tabId.slice(-12)
        + ' VIOLATION '
        + JSON.stringify({
          ownerProjectId: ownerProjectId || null,
          painted,
          sample: layers.slice(0, 16),
        }));
    });

    return () => cancelAnimationFrame(frameId);
  }, [effectivePresented, isVisible, ownerProjectId, tabId]);

  // Keep activeRef in sync for ResizeObserver closure
  useEffect(() => {
    activeRef.current = effectivePresented;
  }, [effectivePresented]);

  // Cmd+Tab focus restore: when our window becomes frontmost via Cmd+Tab,
  // macOS does NOT restore DOM focus to any element — Chromium's NSEvent
  // monitor sees Cmd+V but routes it to nowhere, so paste from external
  // dictation apps silently drops. Per-tab refocus on this event.
  useEffect(() => {
    if (!effectivePresented) return;  // only the currently-presented terminal grabs focus
    const onRefocus = () => {
      // Split mode presents several terminals; only the globally active one
      // may take the window-refocus grab.
      if (!isGloballyActiveTab(tabId)) return;
      // …and only a terminal the user can actually SEE. This event fires on every
      // window focus, so a closed side terminal used to grab the keyboard here
      // and the next paste went into it instead of the transcript composer.
      if (!mayClaimFocusRef.current) return;
      const term = terminalRegistry.get(tabId);
      if (term) {
        try { term.focus(); } catch {}
      }
    };
    window.addEventListener('nt:window-refocus-active', onRefocus);
    return () => window.removeEventListener('nt:window-refocus-active', onRefocus);
  }, [tabId, effectivePresented]);

  // Diagnostic: log overlay-gate transitions for this prompt-queue tab.
  // Fires ONLY on transitions (not every render) by tracking prev tuple in a ref.
  // Order: effectiveActive, agent, hasSession, processAlive. Only the first two
  // are presentation gates; session/alive explain why execution is waiting.
  // When user reports "overlay disappeared" — grep for this tab's last [QueueGate:flip] line
  // to see which of the 4 flags flipped to false.
  const queueGatePrevRef = useRef<string>('');
  useEffect(() => {
    if (!promptQueueAgent) return;
    const tuple = `act=${effectiveActive} agent=${promptQueueAgent} sess=${hasPromptQueueSession} alive=${claudeProcessAlive}`;
    if (queueGatePrevRef.current === tuple) return;
    const all = effectiveActive && !!promptQueueAgent;
    console.warn('[QueueGate:flip] tab=' + tabId.slice(-8) + ' ' + tuple + ' → overlay=' + (all ? 'SHOWN' : 'HIDDEN'));
    queueGatePrevRef.current = tuple;
  }, [tabId, effectiveActive, promptQueueAgent, hasPromptQueueSession, claudeProcessAlive]);

  const shouldInterceptCodexClipboardImagePaste = useCallback((event: KeyboardEvent): boolean => {
    if (event.type !== 'keydown' || event.code !== 'KeyV') return false;
    const logPrefix = '[CodexImagePaste:keydown] tab=' + tabId.slice(-12)
      + ' key=' + event.key
      + ' code=' + event.code
      + ' meta=' + event.metaKey
      + ' ctrl=' + event.ctrlKey
      + ' alt=' + event.altKey
      + ' shift=' + event.shiftKey
      + ' agent=' + (promptQueueAgentRef.current || 'none')
      + ' alive=' + claudeProcessAliveRef.current;
    if (event.altKey || event.shiftKey) {
      console.warn(logPrefix + ' decision=skip-modifier');
      return false;
    }
    const pasteModifier = (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey);
    if (!pasteModifier) {
      console.warn(logPrefix + ' decision=skip-no-paste-modifier');
      return false;
    }
    if (promptQueueAgentRef.current !== 'codex') {
      console.warn(logPrefix + ' decision=skip-agent');
      return false;
    }
    if (!claudeProcessAliveRef.current) {
      console.warn(logPrefix + ' decision=skip-not-alive');
      return false;
    }

    try {
      const text = clipboard.readText();
      const textPaths = typeof text === 'string' ? normalizeLocalImagePathTexts(text) : [];
      if (textPaths.length > 0) {
        console.warn(logPrefix + ' decision=intercept-text-path textLen=' + text.length + ' paths=' + textPaths.length + ' first=' + textPaths[0]);
        return true;
      }
      const image = clipboard.readImage();
      const imageEmpty = !image || image.isEmpty();
      console.warn(logPrefix + ' decision=' + (imageEmpty ? 'skip-no-image' : 'intercept-bitmap') + ' textLen=' + (typeof text === 'string' ? text.length : -1) + ' imageEmpty=' + imageEmpty);
      return !imageEmpty;
    } catch (error) {
      console.warn('[CodexImagePaste] clipboard probe failed:', error);
      return false;
    }
  }, []);

  const pasteCodexClipboardImageFromClipboard = useCallback(async () => {
    let payload = '';
    let source = 'unknown';
    let stageToken: string | null = null;
    try {
      const textPaths = normalizeLocalImagePathTexts(clipboard.readText() || '');
      if (textPaths.length > 0) {
        const staged = textPaths.length === 1
          ? await ipcRenderer.invoke('codex:stage-image-path', { tabId, filePath: textPaths[0] })
          : await ipcRenderer.invoke('codex:stage-image-paths', { tabId, filePaths: textPaths });
        const stagedPayloads = textPaths.length === 1
          ? [staged?.success && typeof staged.inputPath === 'string'
              ? staged.inputPath
              : `[imageError: ${formatCodexImagePasteError(staged?.error || 'stage_failed')}]`]
          : (Array.isArray(staged?.results)
            ? staged.results.map((entry: { success?: unknown; inputPath?: unknown; error?: unknown }) => (
                entry?.success && typeof entry.inputPath === 'string'
                  ? entry.inputPath
                  : `[imageError: ${formatCodexImagePasteError(entry?.error || 'stage_failed')}]`
              ))
            : [`[imageError: ${formatCodexImagePasteError(staged?.error || 'stage_failed')}]`]);
        payload = stagedPayloads.join(textPaths.length > 1 ? '\n' : '');
        stageToken = typeof staged?.stageToken === 'string' ? staged.stageToken : null;
        source = textPaths.length > 1 ? 'text-paths' : 'text-path';
      } else {
        const saved = await ipcRenderer.invoke('codex:save-clipboard-image', { tabId });
        if (saved?.success && typeof saved.inputPath === 'string' && saved.inputPath.length > 0) {
          payload = saved.inputPath;
          stageToken = typeof saved.stageToken === 'string' ? saved.stageToken : null;
          source = 'saved-bitmap';
        } else {
          payload = `[imageError: ${formatCodexImagePasteError(saved?.error || 'save_failed')}]`;
          source = 'save-error';
        }
      }
    } catch (error) {
      payload = `[imageError: ${formatCodexImagePasteError(error)}]`;
      source = 'exception';
    }

    // Raw bare path on purpose: Codex rewrites local image paths to its native
    // [Image #N] composer chip. We stage the path in main so +grab/Run after can
    // still recover the real file later if external-editor returns only the chip.
    console.warn('[CodexImagePaste:inject] tab=' + tabId.slice(-12) + ' source=' + source + ' len=' + payload.length + ' payload=' + payload);
    ipcRenderer.send('terminal:input', tabId, payload, stageToken ? { codexImageStageToken: stageToken } : null);
  }, [tabId]);

  // Check if terminal is scrolled up (not at bottom)
  // ALL callers go through rAF debounce — never call this synchronously during term.write()
  const lastScrollButtonState = useRef(false);
  const lastViewportY = useRef<number>(-1);
  const checkScrollPosition = useCallback(() => {
    const term = xtermInstance.current;
    if (!term) return;

    const buffer = term.buffer.active;
    const isAtBottom = buffer.viewportY >= buffer.baseY;

    // Diagnostic: detect scroll jumps
    const prevY = lastViewportY.current;
    if (prevY !== -1) {
      const delta = Math.abs(buffer.viewportY - prevY);
      if (delta > 50) {
        console.warn(`[ScrollDiag] JUMP viewportY: ${prevY} → ${buffer.viewportY} (delta=${delta}) baseY=${buffer.baseY} isAtBottom=${isAtBottom}`);
      }
    }
    lastViewportY.current = buffer.viewportY;

    const shouldShow = !isAtBottom;
    if (shouldShow !== lastScrollButtonState.current) {
      lastScrollButtonState.current = shouldShow;
      setShowScrollButton(shouldShow);
    }

    // Sync viewport position with registry for Timeline (no React overhead)
    terminalRegistry.updateViewport(
      tabId,
      buffer.viewportY,
      buffer.viewportY + term.rows,
      buffer.baseY + term.rows
    );
  }, [tabId]);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    const term = xtermInstance.current;
    if (!term) return;
    term.scrollToBottom();
    lastScrollButtonState.current = false;
    setShowScrollButton(false);
  }, []);

  // Single rAF gate for ALL scroll sources — collapses N events per frame into one check
  const pendingScrollCheckRef = useRef<number | null>(null);
  const rafCheckScroll = useCallback(() => {
    if (pendingScrollCheckRef.current !== null) return; // already scheduled
    pendingScrollCheckRef.current = requestAnimationFrame(() => {
      pendingScrollCheckRef.current = null;
      checkScrollPosition();
    });
  }, [checkScrollPosition]);

  // Attach scroll listeners - called AFTER term.open() when DOM is guaranteed to exist.
  // Все три listener'а ведут к одному rAF-debounced check: показывать ли "scroll to bottom"
  // кнопку + обновить terminalRegistry.updateViewport для Timeline.
  const attachScrollListeners = useCallback((term: XTerminal, container: HTMLDivElement) => {
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    if (viewport) {
      viewport.addEventListener('scroll', rafCheckScroll, { passive: true });
    }
    term.onScroll(rafCheckScroll);          // programmatic scroll, buffer changes
    term.onWriteParsed(rafCheckScroll);     // auto-scroll down on new output
  }, [rafCheckScroll]);

  // Write buffer refs to batch PTY output and prevent jitter

  const safeFit = () => {
    if (!isMounted.current) return;
    try {
      const term = xtermInstance.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return;
      if ((term as any)._isDisposed) return;
      if (!term.element) return;
      if (!term.options || term.cols === 0 || term.rows === 0) return;

      const colsBefore = term.cols;
      const rowsBefore = term.rows;

      // [FocusDiag2026-05] focus snapshot BEFORE fit
      const focusBefore = (() => {
        try {
          const el = document.activeElement;
          const tag = el?.tagName || 'NULL';
          const cls = (el?.className || '').toString().slice(0, 60);
          return tag + (cls ? '.' + cls : '');
        } catch { return 'ERR'; }
      })();

      // СВОЙ минимум вместо пола измерителя.
      //
      // Раскладку человек кроит как хочет, и окно может оказаться уже/ниже
      // того, во что TUI-агент вообще умеет рисоваться: измеритель зажимает
      // всего 2 колонки и 1 строку, и терминал в таком «окне» перестаёт быть
      // рабочим. Ограничивать сами окна нельзя (юзер: «ограничивать ширину
      // окон я не хочу»), поэтому терминал берёт свой минимум и, если места не
      // дали, ВЫХОДИТ за край окна и обрезается им. Обрезка не молчаливая:
      // рядом появляется пометка (см. data-terminal-clipped ниже).
      const geometry = resolveTerminalGeometry(fit.proposeDimensions());
      if (geometry.cols !== term.cols || geometry.rows !== term.rows) {
        // Чистка рендерера ПЕРЕД сменой размера — ровно то, что делал сам
        // fit-адаптер: без неё на канве остаются пиксели прежней сетки.
        try { (term as any)._core?._renderService?.clear(); } catch {}
        term.resize(geometry.cols, geometry.rows);
      }
      setTerminalClipped(geometry.clipped);

      const colsAfter = term.cols;
      const rowsAfter = term.rows;
      const dimsChanged = colsBefore !== colsAfter || rowsBefore !== rowsAfter;

      if (dimsChanged) {
        console.warn(`[safeFit] tabId=${tabId} RESIZED ${colsBefore}x${rowsBefore} → ${colsAfter}x${rowsAfter}, sending resize to PTY`);
        // [FocusDiag2026-05] focus snapshot AFTER fit when dims changed — catches
        // the moment Prompt-queue overlay mount triggers a fit that shrinks the
        // terminal, possibly stealing focus during layout reflow.
        const focusAfter = (() => {
          try {
            const el = document.activeElement;
            const tag = el?.tagName || 'NULL';
            const cls = (el?.className || '').toString().slice(0, 60);
            return tag + (cls ? '.' + cls : '');
          } catch { return 'ERR'; }
        })();
        console.warn('[FocusDiag2026-05][safeFit-resize] tab=' + tabId.slice(-12) + ' before=' + focusBefore + ' after=' + focusAfter + ' dims=' + colsBefore + 'x' + rowsBefore + '→' + colsAfter + 'x' + rowsAfter + ' ts=' + Date.now());
        ipcRenderer.send('terminal:resize', {
          tabId,
          // fit() already measured AND applied this exact snapshot to xterm.
          // A second proposeDimensions() can observe the post-resize layout
          // and return a different answer, leaving PTY and canvas wrapped at
          // different columns.
          cols: colsAfter,
          rows: rowsAfter,
          expectedPid: rendererBoundPtyPid.current ?? terminalPidRef.current,
        });
      }
    } catch (e) {
      console.warn('[safeFit] ERROR:', e);
    }
  };

  useEffect(() => {
    const handlePinnedTimelineLayoutSettled = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId !== tabId) return;
      if (!activeRef.current || !xtermInstance.current) return;

      if (pinnedTimelineSettleRafRef.current !== null) {
        cancelAnimationFrame(pinnedTimelineSettleRafRef.current);
      }
      pinnedTimelineSettleRafRef.current = requestAnimationFrame(() => {
        safeFit();
        pinnedTimelineSettleRafRef.current = requestAnimationFrame(() => {
          pinnedTimelineSettleRafRef.current = null;
          safeFit();
          scrollToBottom();
        });
      });
    };

    window.addEventListener('timeline:pinned-layout-settled', handlePinnedTimelineLayoutSettled);
    return () => {
      window.removeEventListener('timeline:pinned-layout-settled', handlePinnedTimelineLayoutSettled);
      if (pinnedTimelineSettleRafRef.current !== null) {
        cancelAnimationFrame(pinnedTimelineSettleRafRef.current);
        pinnedTimelineSettleRafRef.current = null;
      }
    };
  }, [scrollToBottom, tabId]);

  // Both the eager and lazy xterm initializers feed the same live PTY. Keep
  // native Codex picker proof at component scope so the first lazy onData
  // cannot call a function that only exists inside the eager-init effect.
  const nativeCodexPickerProofRef = useRef<{
    expiresAt: number;
    output: string;
    sessionId: string;
  } | null>(null);

  const armNativeCodexPickerProof = useCallback((
    term: XTerminal,
    data: string,
    origin: XtermInputOrigin,
  ) => {
    if (origin === 'terminal-response' || !/[\r\n]/.test(data)) return;
    const currentTab = (() => {
      for (const [, workspace] of useWorkspaceStore.getState().openProjects) {
        const candidate = workspace.tabs.get(tabId);
        if (candidate) return candidate;
      }
      return null;
    })();
    if (currentTab?.commandType !== 'codex') return;
    const visible = terminalRegistry.getVisibleText(tabId);
    if (!isCodexSettingsPickerVisible(visible)) return;
    if (!currentTab.codexSessionId) return;
    nativeCodexPickerProofRef.current = {
      expiresAt: Date.now() + 10_000,
      output: '',
      sessionId: currentTab.codexSessionId,
    };
    console.warn('[CodexEffectiveState] armed native picker proof tab=' + tabId.slice(-12));
  }, [tabId]);

  const reconcileNativeCodexPickerOutput = useCallback((data: string) => {
    const proof = nativeCodexPickerProofRef.current;
    if (!proof) return;
    if (Date.now() > proof.expiresAt) {
      nativeCodexPickerProofRef.current = null;
      return;
    }
    proof.output = (proof.output + data).slice(-16_000);
    const applied = parseCodexModelChangeAcknowledgement(proof.output);
    if (!applied) return;

    const state = useWorkspaceStore.getState();
    if (state.getCodexSessionId(tabId) !== proof.sessionId) {
      nativeCodexPickerProofRef.current = null;
      return;
    }
    const plan = planCodexPickerStateApplication({
      result: {
        ...applied,
        codexSettingsProofSessionId: proof.sessionId,
      },
      requestedModel: applied.model,
      requestedEffort: applied.effort,
      liveSessionId: proof.sessionId,
    });
    if (!plan.allowed) return;
    if (Object.keys(plan.persistentPatch || {}).length > 0) {
      state.updateCodexState(tabId, plan.persistentPatch);
    }
    state.updateCodexLiveState(tabId, plan.livePatch);
    if (applied.applicationMode === 'conversation-only') {
      const livePatch = plan.livePatch;
      void ipcRenderer.invoke('codex:get-persistent-model-effort-proof', { tabId })
        .then((fallback: any) => {
          const latest = useWorkspaceStore.getState();
          if (
            fallback?.success !== true
            || latest.getCodexSessionId(tabId) !== proof.sessionId
            || (
              fallback.codexSettingsProofSessionId
              && fallback.codexSettingsProofSessionId !== proof.sessionId
            )
          ) {
            return;
          }
          latest.updateCodexState(tabId, {
            codexModel: fallback.model,
            codexEffort: fallback.effort,
            codexSettingsProofSessionId: undefined,
          });
          latest.updateCodexLiveState(tabId, livePatch);
        })
        .catch(() => {});
    }
    nativeCodexPickerProofRef.current = null;
    console.warn(
      '[CodexEffectiveState] native picker applied tab=' + tabId.slice(-12)
      + ' model=' + applied.model
      + ' effort=' + (applied.effort || 'unchanged')
      + ' mode=' + applied.applicationMode
      + ' proof=' + applied.proof,
    );
  }, [tabId]);

  useEffect(() => {
    if (isInitialized.current || !terminalRef.current) {
      return;
    }
    isInitialized.current = true;
    console.warn(`[Terminal:MOUNT] tabId=${tabId} active=${active} isActiveProject=${isActiveProject}`);

    const containerRef = terminalRef.current;
    const executePendingActionAtShellPrompt = () => {
      if (pendingActionExecuted.current) return;
      const pendingAction = getTabPendingAction(tabId);
      if (!pendingAction) return;
      pendingActionExecuted.current = true;
      console.log('[Terminal] OSC 133 A shell prompt ready, executing pendingAction');
      executePendingAction(tabId, pendingAction);
    };
    const handleShellPromptReady = (
      _event: any,
      readyTabId: string,
      readiness?: { ready?: boolean },
    ) => {
      if (readyTabId !== tabId || readiness?.ready === false) return;
      executePendingActionAtShellPrompt();
    };

    // IPC: Receive data from PTY (with write buffer to prevent jitter)
    const handleData = (_: any, payload: {
      pid?: number | null;
      tabId: string;
      data: string;
      headlessWriteSeq?: number | null;
      headlessGeneration?: string | null;
      headlessGenerationOrdinal?: number | null;
    }) => {
      if (payload.tabId !== tabId) return;
      if (Number.isFinite(payload.pid)) {
        rendererBoundPtyPid.current = Number(payload.pid);
      }

      // EffortDiag: scan first 5s of PTY output for TUI-readiness markers.
      _effortDiagScan(tabId, payload.data);
      reconcileNativeCodexPickerOutput(payload.data);

      // A cold terminal and a presentation barrier both buffer the exact PTY
      // tail. The latter keeps SIGWINCH/repaint from interleaving with xterm's
      // already queued writes when a long-running hidden terminal is shown.
      // Direct write — Claude Code v2.1.101+ перестал слать CSI 3J на full
      // resets, ради чего раньше был sync-frame splitter с накоплением. Splitter
      // ломался когда BSU/ESU markers разрезались между PTY-чанками (особенно
      // у субагентов с быстрыми мелкими стримами): хвост от BSU попадал в xterm
      // как normal data, frame data применялся без атомарности → каша символов.
      // Подробности и история: docs/knowledge/fix-terminal-jitter.md::Upstream fix v2.1.101.
      enqueueTerminalChunk(payload.data, {
        writeSeq: Number.isFinite(payload.headlessWriteSeq)
          ? Number(payload.headlessWriteSeq)
          : null,
        generation: payload.headlessGeneration || null,
        generationOrdinal: Number.isFinite(payload.headlessGenerationOrdinal)
          ? Number(payload.headlessGenerationOrdinal)
          : null,
      });
    };

    const handleExit = (_: any, exitedTabId: string) => {
      if (exitedTabId === tabId) {
        enqueueTerminalChunk('\r\n\r\n[Process completed]');
      }
      // Reset the /effort once-per-process sentinel on PTY exit so the next
      // fresh Claude spawn in this tab starts clean.
      if (exitedTabId === tabId) {
        _effortSentForTab.delete(tabId);
        _modelSentForTab.delete(tabId);
        _claudeBridgeModelByTab.delete(tabId);
      }
    };

    // Session Bridge: receive session ID from StatusLine bridge watcher.
    //
    // pendingResume guard (see utils/pendingResume.ts and
    // docs/knowledge/fix-bridge-stale-takeover.md):
    // If this tab just sent `claude --resume <X>` and the bridge is now offering
    // a DIFFERENT sessionId, that bridge event almost certainly comes from a
    // stale ~/.claude/bridge/*.json that survived from a long-dead process
    // (Claude CLI never deletes those). Drop it — the real resumed process will
    // write its own bridge file within seconds and we'll pick that one up.
    const handleSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      if (data.tabId !== tabId) return;
      if (isStaleAgainstPending(tabId, data.sessionId)) {
        console.warn('[Terminal:Bridge] IGNORE stale session for tab', tabId.slice(-12), ': bridge offered', data.sessionId.substring(0, 8), 'but resume in flight to a different id');
        return;
      }
      const currentId = getClaudeSessionId(tabId);
      if (currentId !== data.sessionId) {
        console.warn('[Terminal:Bridge] OVERWRITE session for tab', tabId, ':', (currentId || 'null').substring(0, 8), '→', data.sessionId.substring(0, 8));
      }
      getSetClaudeSessionId()(tabId, data.sessionId, 'bridge');
      // Resume confirmed — clear pending flag.
      clearPendingResume(tabId);
      // Bridge sees a live Claude session in this tab → the tab IS a Claude tab,
      // regardless of how it was launched (typed `claude` in a green devServer
      // tab, restored on boot, etc). Promote commandType so the Run-after
      // overlay (gated on commandType==='claude') and tab color are correct.
      // Без этого зелёная вкладка с запущенным внутри Claude оставалась
      // commandType='devServer' и оверлей не показывался. См. fact-tabs.md fix #2.
      // GUARD: session-detected fires on EVERY bridge sync (~1-2s). setTabCommandType
      // unconditionally does set(new Map)+saveTabs (SQLite write), so calling it
      // every sync = re-render+I/O storm (CLAUDE.md Zustand anti-pattern). Only
      // call when it would actually change the type.
      {
        const curType = useWorkspaceStore.getState().openProjects;
        let needsPromote = false;
        for (const [, ws] of curType) {
          const t = ws.tabs.get(tabId);
          if (t) { needsPromote = t.commandType !== 'claude'; break; }
        }
        if (needsPromote) getSetTabCommandType()(tabId, 'claude');
      }
      // Bridge sees a live session in this tab → Claude IS running, even if we
      // missed the OSC 133 command-started (process restored on boot, launched
      // in a background tab, or resumed without the claude-c hotkey). Assert
      // alive so the Run-after overlay shows. Без этого overlay висел HIDDEN
      // пока юзер не передёрнет Stop+continue. См. fact-prompt-queue.md.
      // Functional updater + prev-guard avoids stale-closure read (effect deps
      // are [tabId], so a captured `claudeProcessAlive` would always be false).
      claudeProcessAliveRef.current = true;
      setClaudeProcessAlive((prev) => {
        if (!prev) console.warn('[QueueGate:proc] tab=' + tabId.slice(-8) + ' bridge session-detected → alive=true (OSC B may have been missed)');
        return true;
      });
    };

    // Fresh Claude process started for this tab (new PID seen in bridge cache).
    // Fires once per real spawn — unlike session-detected which re-syncs on every
    // bridge update of the same session. Fallback path for startup defaults;
    // tui-ready is the primary signal because it fires when the input prompt is
    // actually ready.
    //
    // Startup-default policy:
    // - default model !== 'none' → apply `/model N` before any `/effort`
    // - effort === 'none' → skip only `/effort`
    // - this is a --resume (pendingResume marker active) → do nothing on this
    //     fallback path. 2026-05-21 incident traced a race where Bridge:Fresh
    //     fired during resume handshake and safePasteAndSubmit's Ctrl+S stash
    //     collided with old input. tui-ready applies defaults safely after the
    //     prompt is rendered.
    // - claude TUI is fresh start → inject `/model N` then `/effort N`
    const handleProcessStarted = async (_: any, data: { tabId: string; sessionId: string; claudePid: number; launchGeneration?: string }) => {
      if (data.tabId !== tabId) return;
      // Note: NO sentinel reset here. tui-ready fires BEFORE Bridge:Fresh
      // (process-started), so resetting here would clobber the tui-ready
      // mark and let Bridge:Fresh send a second /effort — exactly the bug
      // we're fixing. Sentinel is cleared only on PTY exit (handleExit).
      // [EffortDiag2026-05] handler entry counter — written to log BEFORE any
      // early-return / async work. If the file shows N≥2 calls per fresh tab,
      // main emitted process-started multiple times (Bridge:Fresh ran twice).
      // If only N=1 yet two send-command lines appear in main log, the second
      // sender lives outside handleProcessStarted.
      const hCount = (_effortHandlerCalls.get(tabId) || 0) + 1;
      _effortHandlerCalls.set(tabId, hCount);
      console.warn('[EffortDiag2026-05][HANDLER-ENTRY] tab=' + tabId.slice(-12) + ' callN=' + hCount + ' pid=' + data.claudePid + ' sessionId=' + (data.sessionId || 'null').substring(0, 8) + ' ts=' + Date.now());

      // [FocusDiag2026-05] periodic focus snapshot — first 3 seconds after fresh
      // Claude spawn, every 200ms. If the user sees focus disappear ~1s after
      // launch, the log shows exactly when activeElement stops being the xterm
      // canvas. Pair the timestamp with the closest preceding [safeFit] or
      // [Overlay:MOUNT] line in the same log file.
      const _focusStart = Date.now();
      const _focusSampler = setInterval(() => {
        const elapsed = Date.now() - _focusStart;
        if (elapsed > 3000) { clearInterval(_focusSampler); return; }
        try {
          const el = document.activeElement;
          const tag = el?.tagName || 'NULL';
          const cls = (el?.className || '').toString().slice(0, 60);
          console.warn('[FocusDiag2026-05][sample] tab=' + tabId.slice(-12) + ' t+' + elapsed + 'ms active=' + tag + (cls ? '.' + cls : '') + ' ts=' + Date.now());
        } catch (e) { console.warn('[FocusDiag2026-05][sample-err] ' + String(e)); }
      }, 200);
      // Fresh Claude PID for this tab → unambiguously alive. Assert it before
      // the effort-inject early-returns below so the Run-after overlay gate is
      // correct even when the OSC 133 command-started was missed (restore /
      // background-tab launch). Idempotent with the OSC-driven path. Functional
      // updater avoids stale-closure read (effect deps are [tabId]).
      // Also promote commandType → 'claude' (fresh PID = Claude owns this tab)
      // and sync the alive-ref so command-type auto-detection is suppressed.
      // Guard against redundant set()+saveTabs (see handleSessionDetected).
      {
        let needsPromote = false;
        for (const [, ws] of useWorkspaceStore.getState().openProjects) {
          const t = ws.tabs.get(tabId);
          if (t) { needsPromote = t.commandType !== 'claude'; break; }
        }
        if (needsPromote) getSetTabCommandType()(tabId, 'claude');
      }
      claudeProcessAliveRef.current = true;
      setClaudeProcessAlive((prev) => {
        if (!prev) console.warn('[QueueGate:proc] tab=' + tabId.slice(-8) + ' process-started → alive=true');
        return true;
      });
      // Main owns startup settings. Renderer keeps only the presentation-side
      // liveness/focus work above and observes the resulting gate snapshot.
      _effortDiag(
        tabId,
        '⚡ PROCESS-STARTED',
        'pid=' + data.claudePid + ' gen=' + (data.launchGeneration || '-'),
      );
    };

    // Main already consumed this readiness signal and owns the settings
    // transaction. Renderer keeps the listener only for diagnostics.
    const handleTuiReady = (_: any, data: { tabId: string; ts: number; launchGeneration?: string }) => {
      if (data.tabId !== tabId) return;
      _effortDiag(
        tabId,
        '⚡ TUI-READY',
        'gen=' + (data.launchGeneration || '-') + ' ts=' + (Number(data.ts) || '-'),
      );
    };

    // /status interception: update session ID if not yet captured (no toast)
    const handleStatusSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      if (data.tabId !== tabId) return;
      const currentId = getClaudeSessionId(tabId);
      if (!currentId) {
        getSetClaudeSessionId()(tabId, data.sessionId, 'bridge');
      }
    };

    const handleBridgeUpdate = (_: any, data: { tabId: string; model?: string }) => {
      if (data.tabId !== tabId) return;
      const liveModel = data.model || 'unknown';
      _claudeBridgeModelByTab.set(tabId, { model: liveModel, at: Date.now() });
    };

    // Gemini Sniper Watcher: receive session ID when Gemini creates it
    const handleGeminiSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      if (data.tabId !== tabId) return;
      console.log('[Terminal] Sniper caught Gemini session:', data.sessionId);
      getSetGeminiSessionId()(tabId, data.sessionId);
      // Ensure commandType is 'gemini' — spawn-with-watcher bypasses the Enter key handler
      getSetTabCommandType()(tabId, 'gemini');
    };

    const handleCodexSessionDetected = (_: any, data: { tabId: string; sessionId: string; writerProven?: boolean; writerProof?: string; previousSessionId?: string | null; writerGeneration?: string | null; carryCodexSettingsProof?: boolean; requiresExactCodexSettingsProof?: boolean; codexSettingsProof?: { model?: string; effort?: string; proofAt?: number } | null }) => {
      if (data.tabId !== tabId) return;
      if (data.writerProven !== true) {
        console.warn('[Terminal] Ignoring unproven Codex session detection:', data.sessionId, 'proof:', data.writerProof || 'none');
        return;
      }
      const currentSessionId = useWorkspaceStore.getState().getCodexSessionId(tabId);
      if (data.previousSessionId
        && currentSessionId !== data.previousSessionId
        && currentSessionId !== data.sessionId) {
        console.warn('[Terminal] Ignoring stale Codex writer generation:', data.writerGeneration || '-',
          'source:', data.previousSessionId,
          'session:', data.sessionId,
          'current:', currentSessionId || 'none');
        return;
      }
      console.log('[Terminal] Codex session detected:', data.sessionId);
      getSetCodexSessionId()(
        tabId,
        data.sessionId,
        'detected',
        codexSessionAdoptionOptionsFromEvent(data),
      );
      getSetTabCommandType()(tabId, 'codex');
      // Same reason as Claude bridge/session detection: Codex can be restored or
      // launched through a path where the OSC command-started marker was missed.
      // A fresh codex session id means this PTY is AI-owned and the queue overlay
      // should be allowed to show immediately.
      claudeProcessAliveRef.current = true;
      setClaudeProcessAlive((prev) => {
        if (!prev) console.warn('[QueueGate:proc] tab=' + tabId.slice(-8) + ' codex session-detected → alive=true (OSC B may have been missed)');
        return true;
      });
    };

    const handleClaudePromptBoundary = (_: any, data: { tabId: string; seq: number }) => {
      if (data?.tabId !== tabId) return;
      const seq = Number(data.seq);
      console.warn('[Terminal:PromptBoundary] direct tab=' + tabId.slice(-12) + ' seq=' + seq);
      terminalRegistry.registerPromptBoundary(tabId, seq);
      ipcRenderer.send('claude:prompt-boundary-ack', { tabId, seq });
    };

    // Register IPC listeners synchronously
    ipcRenderer.on('terminal:prompt-ready', handleShellPromptReady);
    ipcRenderer.on('terminal:data', handleData);
    ipcRenderer.on('terminal:exit', handleExit);
    ipcRenderer.on('claude:session-detected', handleSessionDetected);
    ipcRenderer.on('claude:process-started', handleProcessStarted);
    ipcRenderer.on('claude:tui-ready', handleTuiReady);
    ipcRenderer.on('claude:prompt-boundary', handleClaudePromptBoundary);
    ipcRenderer.on('claude:status-session-detected', handleStatusSessionDetected);
    ipcRenderer.on('claude:bridge-update', handleBridgeUpdate);
    ipcRenderer.on('gemini:session-detected', handleGeminiSessionDetected);
    ipcRenderer.on('codex:session-detected', handleCodexSessionDetected);
    void ipcRenderer.invoke('terminal:get-shell-prompt-readiness', tabId)
      .then((readiness: { ready?: boolean } | null) => {
        if (readiness?.ready === true) executePendingActionAtShellPrompt();
      })
      .catch((error: unknown) => {
        console.warn('[Terminal] shell prompt readiness query failed tab='
          + tabId.slice(-12)
          + ' error=' + (error instanceof Error ? error.message : String(error)));
      });

    // Resize observer with Guard Clause (prevents WebGL accordion effect)
    const resizeObserver = new ResizeObserver((entries) => {
      // Guard: If container is hidden (0x0), DON'T let xterm reset to 12x6
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) {
        return;
      }

      // Only fit if active (use ref to get current value, not stale closure)
      if (activeRef.current) {
        window.requestAnimationFrame(() => {
          safeFit();
        });
      }
    });
    resizeObserver.observe(containerRef);

    // Async terminal initialization (waits for fonts)
    const initTerminal = async () => {
      // Wait for fonts to load before creating terminal (prevents metric issues)
      await document.fonts.ready;

      // Double-check our specific font is loaded
      const fontFamily = "'JetBrains Mono', 'JetBrainsMono NF'";
      if (!document.fonts.check(`13px ${fontFamily}`)) {
        try {
          await document.fonts.load(`13px ${fontFamily}`);
        } catch (e) {
          // Font may not be available, proceed with fallback
        }
      }

      if (!isMounted.current || !containerRef) return;

      // Get current fontSize from store
      const currentFontSize = useUIStore.getState().terminalFontSize;

      const term = new XTerminal({
        theme: TERMINAL_THEME,
        fontFamily: "'JetBrains Mono', 'JetBrainsMono NF', Menlo, Monaco, monospace",
        fontSize: currentFontSize,
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        drawBoldTextInBrightColors: false, // Prevents bright colors from being bold
        cursorBlink: true,
        cursorStyle: 'block',
        allowTransparency: false,
        allowProposedApi: true, // Required for SearchAddon
        linkHandler: {
          activate: (event: MouseEvent, uri: string) => {
            handleLinkActivation(event, uri, onLinkClickRef.current, xtermInstance.current);
          },
          allowNonHttpProtocols: false,
        },
        scrollback: 10000
      });

      // Monkey-patch: defer Viewport._sync() during DEC 2026 synchronized output.
      // Equivalent to xterm.js PR #5770 (merged in 6.x, not available in 5.x).
      // Prevents scrollTop/scrollHeight DOM updates while Ink is mid-frame rewrite.
      // Monkey-patch will be applied AFTER term.open() — viewport is created there

      const fitAddon = new FitAddon();
      const serializeAddon = new SerializeAddon();
      const searchAddon = new SearchAddon();
      fitAddonRef.current = fitAddon;
      serializeAddonRef.current = serializeAddon;
      searchAddonRef.current = searchAddon;

      term.loadAddon(fitAddon);
      term.loadAddon(serializeAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(new WebLinksAddon((event, uri) => {
        handleLinkActivation(event, uri, onLinkClickRef.current, xtermInstance.current);
      }));

      term.open(containerRef);

      // OSC 7 handler - shell reports current working directory
      // Format: file://hostname/path or just /path
      term.parser.registerOscHandler(7, (data: string) => {
        handleOscCwdCandidate(tabId, data);
        return true;
      });

      // OSC 7777 handler - marker registration from main.js PTY middleware
      // Formats: entry:<uuid>  |  prompt:<seq>
      term.parser.registerOscHandler(7777, (data: string) => {
        if (data.startsWith('entry:')) {
          const uuid = data.slice(6);
          console.log('[Terminal] OSC 7777 entry marker:', uuid);
          terminalRegistry.registerEntryMarker(tabId, uuid);
        } else if (data.startsWith('prompt:')) {
          const seq = parseInt(data.slice(7), 10);
          if (!isNaN(seq)) {
            terminalRegistry.registerPromptBoundaryForTerminal(tabId, term, seq);
          }
        }
        return true;
      });

      const hydrated = await hydrateTerminalBuffer(term);
      if (!hydrated) return;
      hasBeenActive.current = true; // Mark as active AFTER xterm is created to prevent race condition

      // Attach scroll listeners (native + xterm events)
      attachScrollListeners(term, containerRef);

      // Register terminal in global registry for selection access and search
      terminalRegistry.register(tabId, term, searchAddon);

      // Fit after opening, then reveal terminal
      setTimeout(() => {
        safeFit();
        term.scrollToBottom();
        isReadyRef.current = true;
        setIsVisible(true); // Reveal after first fit to prevent jitter
      if (activeRef.current && !isExternalEditableFocused() && isGloballyActiveTab(tabId)
        && mayClaimFocusRef.current) {
        term.focus();
      }

        // NOTE: Pending command execution moved to handleData
        // It now waits for first PTY output (= shell ready) instead of arbitrary timeout
      }, 100);

      // IPC: Send input to PTY. xterm's built-in `scrollOnUserInput: true`
      // (дефолт) сам прижимает viewport к низу при keystroke.
      const takeXtermInputOrigin = createXtermInputOriginTracker(term);
      term.onData((data) => {
        // Paste diagnostics — large input only. Reads xterm's internal
        // bracketedPasteMode flag so we know whether xterm.js itself wrapped
        // this paste in \x1b[200~/\x1b[201~ or just passed clipboard raw.
        // When this flag is false but data is huge, that means Claude TUI
        // didn't have DEC 2004 active at paste time → single-chip rendering
        // in Claude depends on whether the kernel keeps the bytes contiguous.
        if (data.length > 1000) {
          let bp: any = 'unknown';
          try {
            // xterm 5.5 internal path. Wrapped in try/catch in case the
            // internal shape changes — falls back to 'unknown' which still
            // shows up in dev.log.
            bp = (term as any)._core?.coreService?.decPrivateModes?.bracketedPasteMode;
          } catch {}
          const startsWithB = data.startsWith('\x1b[200~');
          const endsWithB = data.endsWith('\x1b[201~');
          console.warn('[PasteDiag:renderer] tab=' + tabId + ' len=' + data.length
            + ' bracketedPasteMode=' + bp
            + ' startsWith200=' + startsWithB
            + ' endsWith201=' + endsWithB
            + ' head=' + JSON.stringify(data.substring(0, 30))
            + ' tail=' + JSON.stringify(data.substring(Math.max(0, data.length - 30))));
        }
        const xtermInputOrigin = takeXtermInputOrigin();
        armNativeCodexPickerProof(term, data, xtermInputOrigin);
        ipcRenderer.send('terminal:input', tabId, data, { xtermInputOrigin });
      });

      // === INPUT INTERCEPTION for Claude Commands ===
      // Intercept Enter key to replace claude/claude-c/claude-f with explicit --resume
      // Commands: claude (new), claude-c (continue), claude-f (fork)
      term.attachCustomKeyEventHandler((event) => {
        scheduleCodexOverlayStyleProbe(tabId, event, 'initTerminal');
        // Cmd+ArrowDown — scroll terminal to the most recent output. Handled here
        // (not in the global window listener) so xterm.js consumes the event and
        // doesn't pass the Down-arrow byte to the PTY (which would feed it as
        // history navigation in zsh/Claude TUI).
        if (event.metaKey && event.type === 'keydown' && event.key === 'ArrowDown') {
          event.preventDefault();
          scrollToBottom();
          return false;
        }
        // Opt+V — global prompt picker. Swallow here so xterm doesn't forward
        // the Alt-encoded sequence to the PTY (would type ◊/√/etc. into Claude
        // input). The App-level keydown listener handles the actual open. Match
        // by event.code so it's keyboard-layout-agnostic.
        if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
            && event.type === 'keydown' && event.code === 'KeyV') {
          return false;
        }
        // Shift+Cmd+T — reopen last closed tab. Same rationale: xterm would
        // otherwise emit the literal `T` into Claude TUI input.
        if (event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey
            && event.type === 'keydown' && event.code === 'KeyT') {
          return false;
        }
        // Ctrl+Tab / Ctrl+Shift+Tab — global tab switcher (TabSwitcherOverlay).
        // Swallow so xterm doesn't forward \t to the PTY while the modal cycles.
        if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
          return false;
        }
        // Ctrl+Q — workflow switcher (WorkflowSwitcherOverlay). This one MUST be
        // swallowed rather than merely handled elsewhere: Ctrl+Q is XOFF, and
        // leaking it to the PTY freezes the terminal's output until Ctrl+S — a
        // hang that reads as "the app broke", with no visible cause.
        // event.code, so a RU layout (Ctrl+Й) behaves identically.
        if (event.ctrlKey && !event.metaKey && !event.altKey
            && event.type === 'keydown' && event.code === 'KeyQ') {
          return false;
        }
        // Cmd+P / Ctrl+P — tab search switcher. Layout-agnostic via event.code.
        // Both modifiers open the same panel, so both must be kept out of the
        // PTY (Ctrl+P is readline "previous line" — leaking it would edit the
        // user's command line while the switcher opens).
        if ((event.metaKey !== event.ctrlKey) && !event.altKey && !event.shiftKey
            && event.type === 'keydown' && event.code === 'KeyP') {
          return false;
        }
        if (shouldInterceptCodexClipboardImagePaste(event)) {
          event.preventDefault();
          void pasteCodexClipboardImageFromClipboard();
          return false;
        }
        // When the picker is open, swallow arrow/Enter/Esc so they navigate
        // the picker (handled by App-level capture listener) and don't reach
        // shell history / Claude TUI input.
        if (event.type === 'keydown'
            && (event.key === 'ArrowUp' || event.key === 'ArrowDown'
                || event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                || event.key === 'Enter' || event.key === 'Escape')
            && useUIStore.getState().promptPickerOpen) {
          return false;
        }
        // Skip xterm.js processing for app-level Meta (Cmd) shortcuts.
        // Prevents Cmd+, (Settings), Cmd+T (new tab), etc. from leaking characters to PTY.
        // Preserve: Cmd+C (copy/SIGINT), Cmd+V (paste), Cmd+A (selectAll), Cmd+X (cut)
        if (event.metaKey && !['c', 'v', 'a', 'x'].includes(event.key.toLowerCase())) {
          return false;
        }

        // Only intercept Enter key on keydown
        if (event.key !== 'Enter' || event.type !== 'keydown') {
          return true; // Allow default handling
        }

        // Screen text is not a shell command while a foreground process owns
        // the PTY. Codex deliberately runs in the normal buffer, so checking
        // only xterm's alternate buffer let rendered TUI prose ending in
        // "claude" relabel a live Codex tab and swallow manual Enter.
        const foregroundProcessState = claudeProcessAliveRef.current
          ? true
          : foregroundProcessKnownRef.current
            ? false
            : undefined;
        if (!shouldInterpretPtyScreenAsShellCommand({
          foregroundProcessAlive: foregroundProcessState,
          bufferType: term.buffer.active.type,
        })) {
          return true;
        }

        // Get full command (handles wrapped lines)
        const fullLine = getCurrentCommand(term).trim();
        log.commands('Enter pressed, command: %s', fullLine);

        // --- Detect command type for auto-color and restart button ---
        // npm/npx/yarn/pnpm/bun → devServer (green, show restart)
        // gemini → gemini (blue, hide restart)
        // claude → handled below with explicit interception
        // Note: fullLine includes shell prompt, so don't use ^ anchor
        const devServerMatch = fullLine.match(/\b(npm|npx|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i);
        const geminiMatch = fullLine.match(/\bgemini(\s|$)/i);
        const codexMatch = fullLine.match(/\bcodex(\s|$)/i);
        const detectedCommandType = codexMatch ? 'codex' : geminiMatch ? 'gemini' : devServerMatch ? 'devServer' : null;

        // Suppress devServer/gemini auto-detection while a Claude process is
        // alive in this tab. When Claude holds the foreground, getCurrentCommand()
        // reads CLAUDE'S OWN OUTPUT (e.g. it renders `⏺ Bash(npm run dev …)` for a
        // Bash tool call) — the regex below would match that and wrongly downgrade
        // commandType claude→devServer, killing the Run-after overlay + tab color.
        // claudeProcessAliveRef is the synchronous liveness signal. See fix #2.
        const claudeAliveNow = claudeProcessAliveRef.current;
        if (detectedCommandType) {
          const claudeSess = getClaudeSessionId(tabId);
          const preview = fullLine.length > 80 ? fullLine.slice(0, 80) + '…' : fullLine;
          console.warn('[CmdDetect:initTerminal] tab=' + tabId.slice(-8) + ' match=' + detectedCommandType + ' bufType=' + term.buffer.active.type + ' claudeAlive=' + claudeAliveNow + ' claudeSess=' + (claudeSess ? claudeSess.slice(0, 8) : 'null') + ' fullLine="' + preview.replace(/"/g, '\\"') + '"');
        }
        rememberDetectedShellCommand(tabId, fullLine, claudeAliveNow);

        if (!claudeAliveNow) {
          if (detectedCommandType === 'codex') {
            getSetTabCommandType()(tabId, 'codex');
          } else if (detectedCommandType === 'gemini') {
            getSetTabCommandType()(tabId, 'gemini');
          } else if (detectedCommandType === 'devServer') {
            getSetTabCommandType()(tabId, 'devServer');
          }
        }

        // --- CASE 1: claude (new session) - must end with exactly "claude" ---
        if (fullLine.endsWith(' claude') || fullLine === 'claude') {
          log.claude('Detected claude command in terminal');
          getSetTabCommandType()(tabId, 'claude');
          event.preventDefault();

          // Check if ANY session already exists (Claude OR Gemini) - one session per tab
          const existingClaudeId = getClaudeSessionId(tabId);
          const existingGeminiId = getGeminiSessionId(tabId);

          if (existingClaudeId) {
            log.claude('Blocking: Claude session already exists: %s', existingClaudeId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Claude сессия: ' + existingClaudeId + '. Используйте claude-c"\r');
            return false;
          }
          if (existingGeminiId) {
            log.claude('Blocking: Gemini session exists, cannot start Claude: %s', existingGeminiId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Gemini сессия. Откройте новую вкладку для Claude."\r');
            return false;
          }
          useWorkspaceStore.getState().markAiLaunchAutoTitle(tabId, 'claude');

          // Main owns the proven-idle shell clear and the launch write.
          log.claude('Invoking centralized Claude launch (Bridge handles session detection)');
          void invokePtyAgentLaunch('claude:run-command', { tabId, command: 'claude', cwd });
          return false;
        }

        // --- CASE 2: claude-c (continue session) ---
        if (fullLine.endsWith(' claude-c') || fullLine === 'claude-c') {
          getSetTabCommandType()(tabId, 'claude');
          const existingSessionId = getClaudeSessionId(tabId);
          console.log('[Claude-c] tabId:', tabId);
          console.log('[Claude-c] existingSessionId from store:', existingSessionId);
          if (existingSessionId) {
            event.preventDefault();
            console.log('[Claude-c] Sending command: claude --resume', existingSessionId);
            markPendingResume(tabId, existingSessionId);
            void invokePtyAgentLaunch(
              'claude:run-command',
              { tabId, command: 'claude-c', sessionId: existingSessionId },
              existingSessionId,
            );
            return false;
          } else {
            event.preventDefault();
            console.log('[Claude Intercept] No session to continue, showing error');
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ No Claude session saved for this tab"\r');
            return false;
          }
        }

                            // --- CASE 3: claude-f <ID> (fork session by ID) ---
                            // Creates a COPY of the session file with new ID
                            console.log('[Claude Intercept] Checking for claude-f pattern in:', fullLine);
                            const forkWithIdMatch = fullLine.match(/claude-f\s+([a-f0-9-]{8,})$/i);
                            console.log('[Claude Intercept] Fork match result:', forkWithIdMatch);
                            if (forkWithIdMatch) {
                              event.preventDefault();
                              const sourceSessionId = forkWithIdMatch[1];

                              // Check if session already exists - prevent accidental overwrite
                              const existingId = getClaudeSessionId(tabId);
                              if (existingId) {
                                console.log('[Claude Intercept] Session exists, blocking fork:', existingId);
                                ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Откройте новый таб для claude-f"\r');
                                return false;
                              }

                              console.log('[Claude Intercept] Fork from session:', sourceSessionId);

                              // Fork preparation and shell launch are one main-side
                              // transaction. A rejected final admission must not leave
                              // an orphan JSONL or bind this tab to an unlaunched fork.
                              void invokeTypedClaudeFork(tabId, sourceSessionId, cwd);

                              return false;
                            }        // claude-f without ID - show error
        if (fullLine.endsWith(' claude-f') || fullLine === 'claude-f') {
          event.preventDefault();
          ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Укажите ID: claude-f <session-id>"\r');
          return false;
        }

        // --- CASE 4: claude-d (alias for claude) ---
        if (fullLine.endsWith(' claude-d') || fullLine === 'claude-d') {
          getSetTabCommandType()(tabId, 'claude');
          event.preventDefault();

          const existingId = getClaudeSessionId(tabId);
          if (existingId) {
            console.log('[Claude Intercept] Session exists, blocking new:', existingId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
            return false;
          }

          useWorkspaceStore.getState().markAiLaunchAutoTitle(tabId, 'claude');
          console.log('[Claude Intercept] Launching Claude');
          void invokePtyAgentLaunch('claude:run-command', { tabId, command: 'claude', cwd });
          return false;
        }

        // --- CASE 5: claude --resume <ID> (direct resume command) ---
        // Require a FULL 36-char UUID, not `{8,}`. fullLine is scraped off the
        // xterm screen buffer (getCurrentCommand); a long resume command can
        // wrap across visual rows or be read mid-render, leaving a prefix like
        // "00581613-b3". The old `{8,}` floor happily matched that partial and
        // userIntercept persisted a truncated id, clobbering the full UUID the
        // bridge had. Full-UUID anchor → a partial line just doesn't match, and
        // we fall back to the bridge's authoritative capture. See
        // fact-session-capture.md::Truncated --resume scrape.
        console.log('[Claude Intercept] Checking for --resume pattern in:', fullLine);
        const resumeMatch = fullLine.match(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
        console.log('[Claude Intercept] Resume match result:', resumeMatch);
        if (resumeMatch) {
          const sessionId = resumeMatch[1];
          console.log('[Claude Intercept] Direct --resume detected, sessionId:', sessionId);
          getSetTabCommandType()(tabId, 'claude');
          getSetClaudeSessionId()(tabId, sessionId, 'userIntercept');
          // Tell the Bridge handler to reject any stale ~/.claude/bridge/*.json
          // that resolves to this tab with a DIFFERENT sessionId during the next
          // 15s. Without this, ancient stale bridge files (Claude CLI never
          // cleans them up) can stomp the user's resume target right after they
          // hit Enter. See utils/pendingResume.ts.
          markPendingResume(tabId, sessionId);
          // Let the command pass through, but set commandType for Timeline
          // Don't preventDefault - let it run normally
        }

        // ========== CODEX INPUT INTERCEPTION ==========

        // --- CASE: codex (new session) ---
        if (fullLine.endsWith(' codex') || fullLine === 'codex') {
          getSetTabCommandType()(tabId, 'codex');
          event.preventDefault();

          const existingCodexId = getCodexSessionId(tabId);
          const existingClaudeId = getClaudeSessionId(tabId);
          const existingGeminiId = getGeminiSessionId(tabId);
          if (existingCodexId) {
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Codex сессия: ' + existingCodexId + '. Используйте codex-c"\r');
            return false;
          }
          if (existingClaudeId || existingGeminiId) {
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ В этой вкладке уже есть AI сессия. Откройте новую вкладку для Codex."\r');
            return false;
          }

          useWorkspaceStore.getState().markAiLaunchAutoTitle(tabId, 'codex');
          void startFreshCodexSession({ tabId, cwd });
          return false;
        }

        const codexResumeMatch = fullLine.match(/\bcodex\s+(?:.*\s)?resume\s+([a-z0-9-]{8,})\s*$/i);
        if (codexResumeMatch) {
          const resumeId = codexResumeMatch[1];
          getSetTabCommandType()(tabId, 'codex');
          event.preventDefault();
          const existingId = getCodexSessionId(tabId);
          if (existingId && existingId !== resumeId) {
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Codex сессия: ' + existingId + '"\r');
            return false;
          }
          // The typed ID remains launch intent until main proves the open rollout.
          void invokePtyAgentLaunch('codex:run-command', buildCodexRunPayload({ tabId, command: 'codex-c', sessionId: resumeId, cwd }));
          return false;
        }

        if (fullLine.endsWith(' codex-c') || fullLine === 'codex-c') {
          getSetTabCommandType()(tabId, 'codex');
          event.preventDefault();
          const existingSessionId = getCodexSessionId(tabId);
          if (existingSessionId) {
            void invokePtyAgentLaunch('codex:run-command', buildCodexRunPayload({ tabId, command: 'codex-c', sessionId: existingSessionId, cwd }));
          } else {
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ No Codex session saved for this tab"\r');
          }
          return false;
        }

        const codexForkMatch = fullLine.match(/\bcodex-f\s+([a-z0-9-]{8,})\s*$/i);
        if (codexForkMatch) {
          getSetTabCommandType()(tabId, 'codex');
          event.preventDefault();
          const sourceSessionId = codexForkMatch[1];
          const existingId = getCodexSessionId(tabId);
          if (existingId) {
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Codex сессия: ' + existingId + '. Откройте новый таб для codex-f"\r');
            return false;
          }
          useWorkspaceStore.getState().markAiForkAutoTitle(tabId, 'codex', sourceSessionId);
          void invokePtyAgentLaunch('codex:run-command', buildCodexRunPayload({ tabId, command: 'codex-f', sessionId: sourceSessionId, cwd }));
          return false;
        }

        if (fullLine.endsWith(' codex-f') || fullLine === 'codex-f') {
          event.preventDefault();
          ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Укажите ID: codex-f <session-id>"\r');
          return false;
        }

        // ========== GEMINI INPUT INTERCEPTION ==========

        // --- CASE: gemini (new session) - must end with exactly "gemini" ---
        if (fullLine.endsWith(' gemini') || fullLine === 'gemini') {
          log.gemini('Detected gemini command in terminal');
          log.gemini('TabId: %s, CWD: %s', tabId, cwd);
          getSetTabCommandType()(tabId, 'gemini');
          event.preventDefault();

          // Check if ANY session already exists (Claude OR Gemini) - one session per tab
          const existingGeminiId = getGeminiSessionId(tabId);
          const existingClaudeId = getClaudeSessionId(tabId);

          if (existingGeminiId) {
            log.gemini('Blocking: Gemini session already exists: %s', existingGeminiId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Gemini сессия: ' + existingGeminiId + '. Используйте gemini-c"\r');
            return false;
          }
          if (existingClaudeId) {
            log.gemini('Blocking: Claude session exists, cannot start Gemini: %s', existingClaudeId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Claude сессия. Откройте новую вкладку для Gemini."\r');
            return false;
          }

          // Clear line, start watcher, then launch gemini -y
          ipcRenderer.send('terminal:input', tabId, '\x15');
          log.gemini('Sending gemini:spawn-with-watcher IPC to main process');
          // Main process will: 1) start fs.watch 2) write 'gemini -y\r' to PTY
          ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd, yesMode: true });
          return false;
        }

        // --- CASE: gemini -r [uuid] (resume session) ---
        const geminiResumeMatch = fullLine.match(/\bgemini\s+-r(?:\s+([a-f0-9-]+))?\s*$/);
        if (geminiResumeMatch) {
          const resumeId = geminiResumeMatch[1] || null; // null if bare "gemini -r"
          log.gemini('Detected gemini -r command, resumeId: %s', resumeId);
          getSetTabCommandType()(tabId, 'gemini');
          event.preventDefault();

          const existingGeminiId = getGeminiSessionId(tabId);
          const existingClaudeId = getClaudeSessionId(tabId);
          if (existingGeminiId) {
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Gemini сессия: ' + existingGeminiId + '"\r');
            return false;
          }
          if (existingClaudeId) {
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Claude сессия. Откройте новую вкладку."\r');
            return false;
          }

          ipcRenderer.send('terminal:input', tabId, '\x15');
          if (resumeId) {
            // Known session ID — set it directly and let command through
            getSetGeminiSessionId()(tabId, resumeId);
            log.gemini('Set geminiSessionId from -r flag: %s', resumeId);
            ipcRenderer.send('terminal:input', tabId, 'gemini -r ' + resumeId + '\r');
          } else {
            // Bare "gemini -r" — Gemini picks last session, Sniper catches by mtime
            ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd, bareResume: true });
          }
          return false;
        }

        // --- CASE: gemini-c (continue session) ---
        if (fullLine.endsWith(' gemini-c') || fullLine === 'gemini-c') {
          getSetTabCommandType()(tabId, 'gemini');
          const existingSessionId = getGeminiSessionId(tabId);
          log.gemini('gemini-c command, tabId: %s, sessionId: %s', tabId, existingSessionId);
          if (existingSessionId) {
            event.preventDefault();
            log.gemini('Sending: gemini -r %s', existingSessionId);
            ipcRenderer.send('terminal:input', tabId, '\x15gemini -r ' + existingSessionId + '\r');
            return false;
          } else {
            event.preventDefault();
            log.gemini('No Gemini session to continue');
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ No Gemini session saved for this tab"\r');
            return false;
          }
        }

        return true; // Allow default handling for other commands
      });
    };

    // Initialize the visible terminal immediately. Warm inactive terminals from
    // the active project one-by-one in idle time, so switching back from Home or
    // another tab does not pay the full xterm cold-start cost on click.
    if (active && isActiveProject) {
      // Lock: prevent double initialization
      if (isCreatingRef.current) {
        return;
      }
      isCreatingRef.current = true; // Set lock
      initTerminal();
    } else if (isActiveProject) {
      scheduleTerminalWarmInit(tabId, () => {
        if (!isMounted.current || !terminalRef.current || xtermInstance.current || isCreatingRef.current) return;
        console.warn(`[Terminal:WARM_INIT] tabId=${tabId} — idle warm init`);
        isCreatingRef.current = true;
        initTerminal();
      });
    }

    return () => {
      cancelTerminalWarmInit(tabId);
      isMounted.current = false;
      resizeObserver.disconnect();
      ipcRenderer.removeListener('terminal:prompt-ready', handleShellPromptReady);
      ipcRenderer.removeListener('terminal:data', handleData);
      ipcRenderer.removeListener('terminal:exit', handleExit);
      ipcRenderer.removeListener('claude:session-detected', handleSessionDetected);
      ipcRenderer.removeListener('claude:process-started', handleProcessStarted);
      ipcRenderer.removeListener('claude:tui-ready', handleTuiReady);
      ipcRenderer.removeListener('claude:prompt-boundary', handleClaudePromptBoundary);
      ipcRenderer.removeListener('claude:status-session-detected', handleStatusSessionDetected);
      ipcRenderer.removeListener('claude:bridge-update', handleBridgeUpdate);
      ipcRenderer.removeListener('gemini:session-detected', handleGeminiSessionDetected);
      ipcRenderer.removeListener('codex:session-detected', handleCodexSessionDetected);
      // Gemini watcher is renderer-owned. Codex session/turn watchers are
      // main-process runtime state and must survive an xterm component unmount;
      // terminal kill/process exit owns their cleanup.
      ipcRenderer.send('gemini:close-watcher', { tabId });

      // Serialize terminal buffer before unmount (for restoration after remount)
      const term = xtermInstance.current;
      const serializeAddon = serializeAddonRef.current;
      if (term && serializeAddon) {
        try {
          const serialized = serializeAddon.serialize();
          if (serialized) {
            getBufferActions().save(tabId, {
              serialized,
              headlessWriteSeq: rendererFlushedHeadlessWriteSeq.current,
              headlessGeneration: rendererFlushedHeadlessGeneration.current,
              headlessGenerationOrdinal: rendererFlushedHeadlessGenerationOrdinal.current,
              promptBoundaries: terminalRegistry.getPromptBoundarySnapshot(tabId),
              cols: term.cols,
              rows: term.rows,
            });
          }
        } catch (e) {
          // Ignore serialization errors
        }
      }

      // Unregister from global registry
      terminalRegistry.unregister(tabId);

      try { webglAddonRef.current?.dispose(); } catch {}
      try { terminalWritePumpRef.current?.pump?.dispose?.(); } catch {}
      terminalWritePumpRef.current = null;
      const termToDispose = xtermInstance.current;
      xtermInstance.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      webglAddonRef.current = null;

      console.warn(`[Terminal:DISPOSE] tabId=${tabId} — terminal disposed (useEffect[tabId] cleanup)`);

      try {
        termToDispose?.dispose();
      } catch (e) {
        // Ignore dispose errors
      }
      nativeCodexPickerProofRef.current = null;
    };
  }, [armNativeCodexPickerProof, reconcileNativeCodexPickerOutput, tabId]);

  // Focus and fit when becoming active (with rAF to let browser paint first)
  // Also handles lazy initialization on first activation
  // Uses effectiveActive (active && currentView==='terminal') to prevent unmount/remount on view switch
  useEffect(() => {
    if (!effectiveActive || !isActiveProject) {
      // Диагностика перехода вкладки в неактивное состояние.
      if (!effectiveActive) {
        console.warn(`[Terminal:deactivate] tabId=${tabId}`, {
          active,
          effectiveActive,
          projectCurrentView,
          isActiveProject,
        });
      }
      return;
    }

    // Lazy init: if this is first activation and xterm not created yet
    if (!hasBeenActive.current && !xtermInstance.current && terminalRef.current) {
      console.warn(`[Terminal:LAZY_INIT] tabId=${tabId} — terminal not created yet, initializing from scratch`);
      // Lock: prevent double initialization
      if (isCreatingRef.current) {
        console.warn(`[Terminal:LAZY_INIT] tabId=${tabId} — SKIPPED (isCreatingRef lock)`);
        return;
      }
      isCreatingRef.current = true; // Set lock

      // Need to initialize terminal now (reuse same logic as initTerminal)
      const initLazy = async () => {
        await document.fonts.ready;

        if (!isMounted.current || !terminalRef.current) return;

        const currentFontSize = useUIStore.getState().terminalFontSize;
        const term = new XTerminal({
          theme: TERMINAL_THEME,
          fontFamily: "'JetBrains Mono', 'JetBrainsMono NF', Menlo, Monaco, monospace",
          fontSize: currentFontSize,
          fontWeight: 'normal',
          fontWeightBold: 'bold',
          drawBoldTextInBrightColors: false, // Prevents bright colors from being bold
          cursorBlink: true,
          cursorStyle: 'block',
          allowTransparency: false,
          allowProposedApi: true, // Required for SearchAddon
          linkHandler: {
            activate: (event: MouseEvent, uri: string) => {
              handleLinkActivation(event, uri, onLinkClickRef.current, xtermInstance.current);
            },
            allowNonHttpProtocols: false,
          },
          scrollback: 50000
        });

        const fitAddon = new FitAddon();
        const serializeAddon = new SerializeAddon();
        const searchAddon = new SearchAddon();
        fitAddonRef.current = fitAddon;
        serializeAddonRef.current = serializeAddon;
        searchAddonRef.current = searchAddon;

        term.loadAddon(fitAddon);
        term.loadAddon(serializeAddon);
        term.loadAddon(searchAddon);
        term.loadAddon(new WebLinksAddon((event, uri) => {
          handleLinkActivation(event, uri, onLinkClickRef.current, xtermInstance.current);
        }));

        term.open(terminalRef.current);

        // OSC 7 handler - shell reports current working directory
        term.parser.registerOscHandler(7, (data: string) => {
          handleOscCwdCandidate(tabId, data);
          return true;
        });

        // Keep lazy/cold hydration behavior identical to the primary init.
        // Snapshot metadata restores historical boundaries; this handler owns
        // any OSC boundary that arrives in the live tail during handoff.
        term.parser.registerOscHandler(7777, (data: string) => {
          if (data.startsWith('entry:')) {
            terminalRegistry.registerEntryMarker(tabId, data.slice(6));
          } else if (data.startsWith('prompt:')) {
            const seq = parseInt(data.slice(7), 10);
            if (!Number.isNaN(seq)) {
              terminalRegistry.registerPromptBoundaryForTerminal(tabId, term, seq);
            }
          }
          return true;
        });

        const hydrated = await hydrateTerminalBuffer(term);
        if (!hydrated) return;
        hasBeenActive.current = true; // Mark as active AFTER xterm is created

        // Attach scroll listeners (native + xterm events)
        attachScrollListeners(term, terminalRef.current);

        terminalRegistry.register(tabId, term, searchAddon);

        // Setup handlers
        const takeXtermInputOrigin = createXtermInputOriginTracker(term);
        term.onData((data) => {
          const xtermInputOrigin = takeXtermInputOrigin();
          armNativeCodexPickerProof(term, data, xtermInputOrigin);
          ipcRenderer.send('terminal:input', tabId, data, { xtermInputOrigin });
        });

        // === INPUT INTERCEPTION for Claude Commands (same as initTerminal) ===
        term.attachCustomKeyEventHandler((event) => {
          scheduleCodexOverlayStyleProbe(tabId, event, 'reattach');
          // Cmd+ArrowDown — scroll-to-bottom (mirrors the primary handler above).
          if (event.metaKey && event.type === 'keydown' && event.key === 'ArrowDown') {
            event.preventDefault();
            scrollToBottom();
            return false;
          }
          // Opt+V — global prompt picker. Swallow here so xterm doesn't forward
          // the Alt-encoded sequence to the PTY. Layout-agnostic via event.code.
          if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
              && event.type === 'keydown' && event.code === 'KeyV') {
            return false;
          }
          // Shift+Cmd+T — reopen last closed tab (VS Code-style). Layout-agnostic.
          if (event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey
              && event.type === 'keydown' && event.code === 'KeyT') {
            return false;
          }
          // Ctrl+Tab / Ctrl+Shift+Tab — global tab switcher (mirrors primary handler).
          if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
            return false;
          }
          // Ctrl+Q — project switcher (mirrors primary handler). XOFF: leaking
          // it would freeze the PTY's output until Ctrl+S.
          if (event.ctrlKey && !event.metaKey && !event.altKey
              && event.type === 'keydown' && event.code === 'KeyQ') {
            return false;
          }
          // Cmd+P / Ctrl+P — tab search switcher. Layout-agnostic via event.code.
          // Both modifiers open the same panel, so both must be kept out of the
          // PTY (Ctrl+P is readline "previous line" — leaking it would edit the
          // user's command line while the switcher opens).
          if ((event.metaKey !== event.ctrlKey) && !event.altKey && !event.shiftKey
              && event.type === 'keydown' && event.code === 'KeyP') {
            return false;
          }
          if (shouldInterceptCodexClipboardImagePaste(event)) {
            event.preventDefault();
            void pasteCodexClipboardImageFromClipboard();
            return false;
          }
          // When the picker is open, swallow arrow/Enter/Esc so they navigate
          // the picker and don't reach shell history / Claude TUI.
          if (event.type === 'keydown'
              && (event.key === 'ArrowUp' || event.key === 'ArrowDown'
                  || event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                  || event.key === 'Enter' || event.key === 'Escape')
              && useUIStore.getState().promptPickerOpen) {
            return false;
          }
          // Skip xterm.js processing for app-level Meta (Cmd) shortcuts.
          // Prevents Cmd+, (Settings), Cmd+T (new tab), etc. from leaking characters to PTY.
          // Preserve: Cmd+C (copy/SIGINT), Cmd+V (paste), Cmd+A (selectAll), Cmd+X (cut)
          if (event.metaKey && !['c', 'v', 'a', 'x'].includes(event.key.toLowerCase())) {
            return false;
          }

          if (event.key !== 'Enter' || event.type !== 'keydown') {
            return true;
          }

          const foregroundProcessState = claudeProcessAliveRef.current
            ? true
            : foregroundProcessKnownRef.current
              ? false
              : undefined;
          if (!shouldInterpretPtyScreenAsShellCommand({
            foregroundProcessAlive: foregroundProcessState,
            bufferType: term.buffer.active.type,
          })) {
            return true;
          }

          // Get full command (handles wrapped lines)
          const fullLine = getCurrentCommand(term).trim();

          // --- Detect command type for auto-color and restart button ---
          // Note: fullLine includes shell prompt, so don't use ^ anchor
          const devServerMatch = fullLine.match(/\b(npm|npx|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i);
          const geminiMatch = fullLine.match(/\bgemini(\s|$)/i);
          const codexMatch = fullLine.match(/\bcodex(\s|$)/i);
          const detectedCommandType = codexMatch ? 'codex' : geminiMatch ? 'gemini' : devServerMatch ? 'devServer' : null;

          // Same guard as initTerminal block: don't let Claude's rendered
          // output (`⏺ Bash(npm run dev …)`) downgrade commandType while a
          // Claude process is alive. See fix #2 / fact-tabs.md.
          const claudeAliveNow = claudeProcessAliveRef.current;
          if (detectedCommandType) {
            const claudeSess = getClaudeSessionId(tabId);
            const preview = fullLine.length > 80 ? fullLine.slice(0, 80) + '…' : fullLine;
            console.warn('[CmdDetect:reattach] tab=' + tabId.slice(-8) + ' match=' + detectedCommandType + ' bufType=' + term.buffer.active.type + ' claudeAlive=' + claudeAliveNow + ' claudeSess=' + (claudeSess ? claudeSess.slice(0, 8) : 'null') + ' fullLine="' + preview.replace(/"/g, '\\"') + '"');
          }
          rememberDetectedShellCommand(tabId, fullLine, claudeAliveNow);

          if (!claudeAliveNow) {
            if (detectedCommandType === 'codex') {
              log.commands('Detected codex command, setting commandType');
              getSetTabCommandType()(tabId, 'codex');
            } else if (detectedCommandType === 'gemini') {
              log.commands('Detected gemini command, setting commandType');
              getSetTabCommandType()(tabId, 'gemini');
            } else if (detectedCommandType === 'devServer') {
              log.commands('Detected devServer command, setting commandType');
              getSetTabCommandType()(tabId, 'devServer');
            }
          }

          // --- Gemini interception (mirrors initTerminal logic) ---
          if (fullLine.endsWith(' gemini') || fullLine === 'gemini') {
            getSetTabCommandType()(tabId, 'gemini');
            event.preventDefault();
            const existingGeminiId = getGeminiSessionId(tabId);
            const existingClaudeId = getClaudeSessionId(tabId);
            if (existingGeminiId) {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Gemini сессия: ' + existingGeminiId + '"\r');
              return false;
            }
            if (existingClaudeId) {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Claude сессия. Откройте новую вкладку."\r');
              return false;
            }
            ipcRenderer.send('terminal:input', tabId, '\x15');
            const cwd2 = getTabCwd(tabId);
            ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd: cwd2, yesMode: true });
            return false;
          }

          const geminiResumeMatch2 = fullLine.match(/\bgemini\s+-r(?:\s+([a-f0-9-]+))?\s*$/);
          if (geminiResumeMatch2) {
            const resumeId = geminiResumeMatch2[1] || null;
            getSetTabCommandType()(tabId, 'gemini');
            event.preventDefault();
            const existingGeminiId = getGeminiSessionId(tabId);
            const existingClaudeId = getClaudeSessionId(tabId);
            if (existingGeminiId) {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Gemini сессия: ' + existingGeminiId + '"\r');
              return false;
            }
            if (existingClaudeId) {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Claude сессия. Откройте новую вкладку."\r');
              return false;
            }
            ipcRenderer.send('terminal:input', tabId, '\x15');
            if (resumeId) {
              getSetGeminiSessionId()(tabId, resumeId);
              ipcRenderer.send('terminal:input', tabId, 'gemini -r ' + resumeId + '\r');
            } else {
              const cwd2 = getTabCwd(tabId);
              ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd: cwd2, bareResume: true });
            }
            return false;
          }

          // --- Codex interception (mirrors initTerminal logic) ---
          if (fullLine.endsWith(' codex') || fullLine === 'codex') {
            getSetTabCommandType()(tabId, 'codex');
            event.preventDefault();
            const existingCodexId = getCodexSessionId(tabId);
            const existingClaudeId = getClaudeSessionId(tabId);
            const existingGeminiId = getGeminiSessionId(tabId);
            if (existingCodexId) {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Codex сессия: ' + existingCodexId + '. Используйте codex-c"\r');
              return false;
            }
            if (existingClaudeId || existingGeminiId) {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ В этой вкладке уже есть AI сессия. Откройте новую вкладку для Codex."\r');
              return false;
            }
            useWorkspaceStore.getState().markAiLaunchAutoTitle(tabId, 'codex');
            const cwd2 = getTabCwd(tabId);
            void startFreshCodexSession({ tabId, cwd: cwd2 });
            return false;
          }

          const codexResumeMatch2 = fullLine.match(/\bcodex\s+(?:.*\s)?resume\s+([a-z0-9-]{8,})\s*$/i);
          if (codexResumeMatch2) {
            const resumeId = codexResumeMatch2[1];
            getSetTabCommandType()(tabId, 'codex');
            event.preventDefault();
            const existingId = getCodexSessionId(tabId);
            if (existingId && existingId !== resumeId) {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Codex сессия: ' + existingId + '"\r');
              return false;
            }
            // The typed ID remains launch intent until main proves the open rollout.
            const cwd2 = getTabCwd(tabId);
            void invokePtyAgentLaunch('codex:run-command', buildCodexRunPayload({ tabId, command: 'codex-c', sessionId: resumeId, cwd: cwd2 }));
            return false;
          }

          if (fullLine.endsWith(' codex-c') || fullLine === 'codex-c') {
            getSetTabCommandType()(tabId, 'codex');
            event.preventDefault();
            const existingSessionId = getCodexSessionId(tabId);
            if (existingSessionId) {
              const cwd2 = getTabCwd(tabId);
              void invokePtyAgentLaunch('codex:run-command', buildCodexRunPayload({ tabId, command: 'codex-c', sessionId: existingSessionId, cwd: cwd2 }));
            } else {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ No Codex session saved for this tab"\r');
            }
            return false;
          }

          const codexForkMatch2 = fullLine.match(/\bcodex-f\s+([a-z0-9-]{8,})\s*$/i);
          if (codexForkMatch2) {
            getSetTabCommandType()(tabId, 'codex');
            event.preventDefault();
            const sourceSessionId = codexForkMatch2[1];
            const existingId = getCodexSessionId(tabId);
            if (existingId) {
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Codex сессия: ' + existingId + '. Откройте новый таб для codex-f"\r');
              return false;
            }
            const cwd2 = getTabCwd(tabId);
            useWorkspaceStore.getState().markAiForkAutoTitle(tabId, 'codex', sourceSessionId);
            void invokePtyAgentLaunch('codex:run-command', buildCodexRunPayload({ tabId, command: 'codex-f', sessionId: sourceSessionId, cwd: cwd2 }));
            return false;
          }

          if (fullLine.endsWith(' codex-f') || fullLine === 'codex-f') {
            event.preventDefault();
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Укажите ID: codex-f <session-id>"\r');
            return false;
          }

          if (fullLine.endsWith(' claude') || fullLine === 'claude') {
            getSetTabCommandType()(tabId, 'claude');
            event.preventDefault();

            // Check if session already exists
            const existingId = getClaudeSessionId(tabId);
            if (existingId) {
              console.log('[Claude Intercept] Session exists, blocking new:', existingId);
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
              return false;
            }

            useWorkspaceStore.getState().markAiLaunchAutoTitle(tabId, 'claude');
            console.log('[Claude Intercept] Launching Claude');
            void invokePtyAgentLaunch('claude:run-command', { tabId, command: 'claude', cwd });
            return false;
          }

          if (fullLine.endsWith(' claude-c') || fullLine === 'claude-c') {
            getSetTabCommandType()(tabId, 'claude');
            const existingSessionId = getClaudeSessionId(tabId);
            console.log('[Claude-c] tabId:', tabId);
            console.log('[Claude-c] existingSessionId from store:', existingSessionId);
            if (existingSessionId) {
              event.preventDefault();
              console.log('[Claude-c] Sending command: claude --resume', existingSessionId);
              markPendingResume(tabId, existingSessionId);
              void invokePtyAgentLaunch(
                'claude:run-command',
                { tabId, command: 'claude-c', sessionId: existingSessionId },
                existingSessionId,
              );
              return false;
            } else {
              event.preventDefault();
              console.log('[Claude Intercept] No session to continue');
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ No Claude session saved for this tab"\r');
              return false;
            }
          }

          // --- CASE 3: claude-f <ID> (fork session by ID) ---
          console.log('[Claude Intercept] Checking for claude-f pattern in:', fullLine);
          const forkWithIdMatch = fullLine.match(/claude-f\s+([a-f0-9-]{8,})$/i);
          console.log('[Claude Intercept] Fork match result:', forkWithIdMatch);
          if (forkWithIdMatch) {
            event.preventDefault();
            const sourceSessionId = forkWithIdMatch[1];

            // Check if session already exists
            const existingId = getClaudeSessionId(tabId);
            if (existingId) {
              console.log('[Claude Intercept] Session exists, blocking fork:', existingId);
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Откройте новый таб для claude-f"\r');
              return false;
            }

            console.log('[Claude Intercept] Fork from session:', sourceSessionId);

            // Main owns both the fork artifact and the proven-idle shell write.
            void invokeTypedClaudeFork(tabId, sourceSessionId, cwd);

            return false;
          }
          // claude-f without ID - show error
          if (fullLine.endsWith(' claude-f') || fullLine === 'claude-f') {
            event.preventDefault();
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Укажите ID: claude-f <session-id>"\r');
            return false;
          }

          // --- CASE 4: claude-d (alias for claude) ---
          if (fullLine.endsWith(' claude-d') || fullLine === 'claude-d') {
            getSetTabCommandType()(tabId, 'claude');
            event.preventDefault();

            const existingId = getClaudeSessionId(tabId);
            if (existingId) {
              console.log('[Claude Intercept] Session exists, blocking new:', existingId);
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
              return false;
            }

            useWorkspaceStore.getState().markAiLaunchAutoTitle(tabId, 'claude');
            console.log('[Claude Intercept] Launching Claude');
            void invokePtyAgentLaunch('claude:run-command', { tabId, command: 'claude', cwd });
            return false;
          }

          // --- CASE 5: claude --resume <ID> (direct resume command) ---
          // Full-UUID anchor (see CASE 5 in the sibling handler above) — guards
          // against truncated screen-buffer scrapes persisting a partial id.
          console.log('[Claude Intercept 2] Checking for --resume pattern in:', fullLine);
          const resumeMatch = fullLine.match(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
          console.log('[Claude Intercept 2] Resume match result:', resumeMatch);
          if (resumeMatch) {
            const sessionId = resumeMatch[1];
            console.log('[Claude Intercept 2] Direct --resume detected, sessionId:', sessionId);
            getSetTabCommandType()(tabId, 'claude');
            getSetClaudeSessionId()(tabId, sessionId, 'userIntercept');
            markPendingResume(tabId, sessionId);
            // Let the command pass through, but set commandType for Timeline
          }

          return true;
        });

        setTimeout(() => {
          safeFit();
          isReadyRef.current = true;
          setIsVisible(true);
          // Don't steal focus from an open tab-rename input (Cmd+T / new tab
          // auto-opens it in this same tick). See isExternalEditableFocused.
          if (activeRef.current && !isExternalEditableFocused() && isGloballyActiveTab(tabId)
            && mayClaimFocusRef.current) {
            term.focus();
          }

          // NOTE: Pending command execution moved to handleData
          // It now waits for first PTY output (= shell ready) instead of arbitrary timeout
        }, 100);
      };

      initLazy();
      return;
    }

    if (!xtermInstance.current) {
      return;
    }
    if (!effectivePresented) {
      return;
    }

    // Give browser 1 frame to recalculate CSS before calling fit
    let cancelled = false;
    const frameId = requestAnimationFrame(() => {
      void (async () => {
        const term = xtermInstance.current;
        if (!term) return;
        const endPresentationBarrier = beginTerminalHydration(hydrationActivity.current);
        const writePump = ensureTerminalWritePump(term);
        const beforeDrain = writePump.getStatus();
        try {
          // Stop accepting new physical writes, then wait for the finite xterm
          // queue that existed at presentation time. This preserves parser,
          // saved-cursor and private-mode state; a SerializeAddon reset here is
          // not continuation-safe when an ANSI sequence spans the boundary.
          await writePump.drain();
          if (cancelled || !isMounted.current || xtermInstance.current !== term) return;

          const fit = fitAddonRef.current;
          const colsBefore = term.cols;
          const rowsBefore = term.rows;
          const dimsBefore = fit?.proposeDimensions();
          const container = terminalRef.current;
          const containerRect = container?.getBoundingClientRect();

          console.warn(`[Terminal:activate] tabId=${tabId} BEFORE safeFit:`, {
            'term.cols': colsBefore,
            'term.rows': rowsBefore,
            'proposed': dimsBefore ? `${dimsBefore.cols}x${dimsBefore.rows}` : 'null',
            'container': containerRect ? `${Math.round(containerRect.width)}x${Math.round(containerRect.height)}` : 'null',
            'visibility': container?.style.visibility,
            'cursorHidden': (term as any)._core?.buffer?.isCursorHidden,
            'cursorX': term.buffer.active.cursorX,
            'cursorY': term.buffer.active.cursorY,
            'drainedChars': beforeDrain.inFlightChars + beforeDrain.queuedChars,
            'drainedItems': beforeDrain.inFlightItems + beforeDrain.queuedItems,
          });

          safeFit();

          const colsAfter = term.cols;
          const rowsAfter = term.rows;
          console.warn(`[Terminal:activate] AFTER safeFit:`, {
            'term.cols': colsAfter,
            'term.rows': rowsAfter,
            'changed': colsBefore !== colsAfter || rowsBefore !== rowsAfter,
            'cursorX': term.buffer.active.cursorX,
            'cursorY': term.buffer.active.cursorY,
          });

          // Force Canvas renderer to repaint after returning from
          // visibility:hidden. fit.fit() is a no-op if dimensions did not
          // change, leaving the old canvas pixels on screen.
          try {
            const core = (term as any)._core;
            if (core?._renderService) {
              core._renderService.clear();
              console.warn('[Terminal:activate] _renderService.clear() called');
              term.refresh(0, term.rows - 1);
            }
          } catch (e) {
            console.warn('[Terminal:activate] _renderService.clear() ERROR:', e);
          }

          if (!isExternalEditableFocused() && isGloballyActiveTab(tabId)
            && mayClaimFocusRef.current) {
            term.focus();
          }

          const savedWasAtBottom = wasAtBottom.current;
          const savedPos = savedScrollPosition.current;
          const buffer = term.buffer.active;

          console.warn('[Terminal:activate] scroll restore:', {
            savedWasAtBottom,
            savedPos,
            'buffer.baseY': buffer.baseY,
            'buffer.viewportY': buffer.viewportY,
          });

          requestAnimationFrame(() => {
            if (cancelled || xtermInstance.current !== term) return;
            if (savedWasAtBottom) {
              term.scrollToBottom();
            } else if (savedPos !== null) {
              term.scrollToLine(savedPos);
            } else {
              term.scrollToBottom();
            }
            savedScrollPosition.current = null;
            wasAtBottom.current = true;

            console.warn('[Terminal:activate] scroll restored, final:', {
              'buffer.viewportY': term.buffer.active.viewportY,
              'buffer.baseY': term.buffer.active.baseY,
            });
          });
        } finally {
          // Release all PTY chunks captured while the old xterm queue was
          // draining. Push each metadata-bearing chunk through the same pump;
          // it coalesces same-generation tails without crossing PTY ownership.
          const captured = takeTerminalHydrationChunks(pendingBuffer.current);
          for (const chunk of captured) {
            writePump.push(chunk.data, {
              writeSeq: chunk.writeSeq,
              generation: chunk.generation,
              generationOrdinal: chunk.generationOrdinal,
            });
          }
          endPresentationBarrier();
        }
      })();
    });

    // Cleanup: save scroll position when tab becomes inactive
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      const term = xtermInstance.current;
      if (term && active) {
        // Tab is being deactivated - save current scroll position AND wasAtBottom flag
        const buffer = term.buffer.active;
        savedScrollPosition.current = buffer.viewportY;
        wasAtBottom.current = buffer.viewportY >= buffer.baseY;
      }
    };
  }, [armNativeCodexPickerProof, effectiveActive, isActiveProject, presentedProp, tabId, terminalPid]);

  // React to font size changes
  useEffect(() => {
    const term = xtermInstance.current;
    if (!term) return;
    if ((term as any)._isDisposed) return;

    term.options.fontSize = terminalFontSize;

    const repaint = () => {
      try {
        const core = (term as any)._core;
        core?._charSizeService?.measure?.();
        core?._renderService?.clear?.();
        if (term.rows > 0) {
          term.refresh(0, term.rows - 1);
        }
      } catch (e) {
        console.warn('[Terminal:font-size] repaint failed:', e);
      }
    };

    repaint();
    requestAnimationFrame(() => {
      safeFit();
      repaint();
      requestAnimationFrame(() => {
        safeFit();
        repaint();
      });
    });
  }, [terminalFontSize]);

  // Handle click to focus
  const handleClick = () => {
    if (promptQueueInputSurface === 'history') {
      setPromptQueueInputSurface(tabId, 'terminal');
    }
    if (xtermInstance.current) {
      xtermInstance.current.focus();
    }
  };

  // Open native terminal context menu (used by right-click).
  // Electron Menu.popup() without explicit coords pops at the current OS cursor
  // position; positioningItem (passed when focusInsertPrompt=true) puts Insert
  // Prompt under the cursor so it's keyboard-focused immediately.
  const openTerminalContextMenu = async (focusInsertPrompt = false) => {
    const hasSelection = xtermInstance.current?.hasSelection() || false;
    const promptsResult = await ipcRenderer.invoke('prompts:get');
    const prompts = promptsResult.success ? promptsResult.data : [];

    let currentProjectId: string | undefined;
    const state = useWorkspaceStore.getState();
    for (const [projId, workspace] of state.openProjects) {
      if (workspace.tabs.has(tabId)) { currentProjectId = projId; break; }
    }
    const termCwd = await ipcRenderer.invoke('terminal:getCwd', tabId);
    ipcRenderer.send('show-terminal-context-menu', {
      hasSelection, prompts, tabId,
      projectId: currentProjectId,
      cwd: termCwd || cwd,
      focusInsertPrompt,
    });
  };

  // Handle context menu (right click)
  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    await openTerminalContextMenu(false);
  };

  // CSS: visibility:hidden preserves geometry, prevents WebGL context loss
  // (unlike display:none which collapses to 0x0 and kills WebGL textures)
  // opacity:0 initially to prevent jitter during first fit

  return (
    <>
      <div
        className="absolute inset-0"
        data-terminal-layer-tab-id={tabId}
        data-terminal-layer-owner-project={ownerProjectId || ''}
        data-terminal-layer-active={effectiveActive ? '1' : '0'}
        data-terminal-layer-presented={effectivePresented ? '1' : '0'}
        style={{
          zIndex: effectiveActive ? 1 : 0,
          isolation: 'isolate',
          visibility: effectivePresented ? 'inherit' : 'hidden',
          opacity: effectivePresented && isVisible ? 1 : 0,
          pointerEvents: effectivePresented ? 'auto' : 'none',
          transition: effectivePresented ? 'opacity 0.05s ease-in' : 'none',
        }}
      >

        {/* Layer 1: Terminal (Lower) */}
        <div
          ref={terminalRef}
          className="terminal-instance w-full h-full"
          style={{
            visibility: 'inherit',
          }}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        />

        {/* Терминал не поместился в окно.
            Он намеренно нарисован БОЛЬШЕ окна и обрезан его краем — это цена
            за то, чтобы в маленьком окне он остался рабочим, а не свернулся в
            нечитаемую сетку. Молчать об этом нельзя: строка, уехавшая под
            границу, читается как поломка, поэтому обрезка названа словами.
            Пометка мелкая, в углу и кликов не ловит — сообщение, не орган
            управления. */}
        {effectivePresented && terminalClipped && (
          <div
            data-terminal-clipped={tabId}
            title="Окну не хватает места — терминал нарисован целиком и обрезан краем. Раздвиньте окно перегородкой."
            style={{
              position: 'absolute',
              right: 6,
              bottom: 6,
              zIndex: 45,
              pointerEvents: 'none',
              padding: '2px 6px',
              borderRadius: 5,
              background: 'rgba(22,22,22,0.86)',
              border: '1px solid rgba(255,255,255,0.10)',
              color: '#9a9aa0',
              fontSize: 10.5,
              lineHeight: 1.2,
              letterSpacing: 0.2,
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            терминал не помещается
          </div>
        )}

        {/* Вкладка без агента — место ВНИЗУ терминала, куда панель управления
            рисует свою полосу запуска, пока здесь ничего не запущено. Кнопки при
            этом не переезжают и не дублируются: сюда порталом приходит та же
            самая полоса, вместе со всеми защитами запуска.
            См. emptyTabLaunchHost.mjs.

            Внизу, а не по центру: под плашкой живой shell, и печатает он сверху
            вниз. Плашка в середине экрана садится ровно на ту строку, где вот-вот
            появится вывод команды, — то есть на работу человека. Юзер:
            *«можешь расположить, сука, снизу»*. Внизу же стоит и полоса запуска
            в самой панели управления, так что кнопки не меняют высоту, когда
            вкладка перестаёт быть пустой.

            Слот пропускает клики насквозь — под ним живой shell, и человек,
            которому нужна просто команда, её и печатает. Свои клики ловит только
            сама полоса (она в pointerEvents:auto внутри). */}
        {isEmptyTabHere && (
          <div
            aria-hidden={false}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              padding: '0 12px 12px',
              boxSizing: 'border-box',
              pointerEvents: 'none',
              zIndex: 40,
            }}
          >
            <div
              data-empty-tab-launch-slot={tabId}
              ref={emptyLaunchSlotRef}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                flexWrap: 'wrap',
                // Только сама плашка ловит клики; всё вокруг остаётся терминалом.
                pointerEvents: 'auto',
                padding: '10px 14px',
                borderRadius: 10,
                // Тихая подложка, а не окно поверх терминала: она группирует
                // кнопки, но не притворяется отдельной поверхностью.
                background: 'rgba(22,22,22,0.82)',
                border: '1px solid rgba(255,255,255,0.07)',
              }}
            />
          </div>
        )}

      </div>

      {/* Prompt Queue overlay — outside isolation:isolate so it can sit above
          HistoryPanel. `rightInset` only shifts it left for expanded Timeline. */}
      {(effectiveActive || keepPromptQueueMounted) && promptQueueAgent && (() => {
        const overlay = <PromptQueueOverlay
          tabId={tabId}
          sessionType={promptQueueAgent}
          agentBusy={agentBusy}
          rightInset={promptQueueRightInset}
          hideHistoryToggle={hidePromptQueueHistoryToggle}
          inputSurface={selectedPromptQueueInputSurface}
        />;
        return promptQueuePortalHost ? createPortal(overlay, promptQueuePortalHost) : overlay;
      })()}

      {/* «Выдвинуть вторую поверхность» — та же кнопка, что над полем History, и
          тот же компонент: развилка «что выдвигать» одна на оба режима. Стоит
          только когда терминал ДЕРЖИТ ЦЕНТР: у панели, приткнутой сбоку, эта
          кнопка принадлежит центральной поверхности, иначе на экране оказались бы
          две кнопки для одного переключателя. */}
      {active && presentedProp && isTerminalCentre && (
        <div
          data-terminal-side-surface-toggle
          className="pointer-events-auto"
          style={{
            position: 'absolute',
            bottom: 16,
            right: terminalArrowRightInset + 16,
            zIndex: 10001,
          }}
        >
          <SideSurfaceToggleButton tabId={tabId} size={28} />
        </div>
      )}
      {/* Scroll-to-bottom button — OUTSIDE isolation:isolate wrapper so its z-index
          participates in root stacking context (above Timeline tooltip portal z:10000) */}
      {active && presentedProp && showScrollButton && (
        <ControlHint label="Прокрутить терминал вниз">
        <button
          onClick={scrollToBottom}
          className="pointer-events-auto flex items-center justify-center cursor-pointer transition-all duration-200 ease-out hover:scale-105"
	          style={{
	            position: 'absolute',
	            bottom: '16px',
	            // Always at the right edge, shifted left by whatever covers it —
	            // the same number the Run after strip uses, so the two never end
	            // up on opposite sides of the same panel. Previously this jumped
	            // to the LEFT edge when the transcript opened, which read as a
	            // different button appearing somewhere else.
	            //
	            // Слева от кнопки раскладки, в 2px, когда та есть — пара читается
	            // как один блок из двух кнопок.
	            right: terminalArrowRightInset + 16 + (isTerminalCentre ? 28 + 2 : 0),
	            // 28px, как у стрелки History: раньше здесь было 36 и та же по
	            // смыслу кнопка выглядела в двух поверхностях по-разному.
	            width: '28px',
            height: '28px',
            borderRadius: '6px',
            backgroundColor: 'rgba(60, 60, 60, 0.85)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            color: 'rgba(255, 255, 255, 0.8)',
            fontSize: '15px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            zIndex: 10001
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(80, 80, 80, 0.95)';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 1)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(60, 60, 60, 0.85)';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
          }}
        >
          ↓
        </button>
        </ControlHint>
      )}
    </>
  );
}

// Wrap in memo to prevent re-renders when other terminals' state changes
export default memo(Terminal);

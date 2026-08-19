import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { waitForClaudeStartupDefaultsReadyWithVisibleFallback } from './claudeStartupDefaultsReady';
import { getCodexRuntimeReadSessionId } from './codexPtyPresence.mjs';
import type {
  AgentHistoryTool,
  AgentPtyPresence,
  HistoryAgentRuntime,
} from './historyAgentRuntimes';

export type AgentHistorySessionAuthority = 'live-writer' | 'history-hint' | 'fresh';

export interface AgentHistorySessionResolution {
  sessionId: string | null;
  authority: AgentHistorySessionAuthority;
}

export interface AgentSendProviderContract {
  toolType: AgentHistoryTool;
  /** Hidden renderer is not a blocker when main/PTY owns the send proof. */
  allowUnmountedActiveComposer: boolean;
  /** Exact empty-editor evidence is carried across the settings transaction. */
  carriesExactEmptyEvidence: boolean;
  /** One newer committed frame may invalidate and refresh an exact capture. */
  retryExactCaptureAfterCommittedFrame: boolean;
  /** Provider transport must observe cancellation between its own sub-steps. */
  passCancellationGuardToTransport: boolean;
  classifySubmitCapability(
    presence: AgentPtyPresence | null,
  ): 'direct' | 'queue' | 'blocked' | 'unknown';
  startupGateOwnsComposer(presence: AgentPtyPresence | null): boolean;
  waitForStartupGate(tabId: string, purpose: string): Promise<void>;
  resolveHistorySession(
    presence: AgentPtyPresence,
    sessionHint?: string | null,
  ): AgentHistorySessionResolution;
  adoptHistorySession(tabId: string, sessionId: string): Promise<boolean>;
}

const isLivePresence = (presence: AgentPtyPresence) => (
  presence.status === 'active'
  || presence.status === 'busy'
  || presence.status === 'starting'
);

const CLAUDE_SEND_CONTRACT: AgentSendProviderContract = {
  toolType: 'claude',
  allowUnmountedActiveComposer: false,
  carriesExactEmptyEvidence: true,
  retryExactCaptureAfterCommittedFrame: true,
  passCancellationGuardToTransport: true,
  classifySubmitCapability(presence) {
    if (!presence || presence.status === 'unknown') return 'unknown';
    if (presence.status === 'busy') return 'queue';
    if (presence.status === 'active' && presence.inputReady === true) return 'direct';
    return 'blocked';
  },
  startupGateOwnsComposer: (presence) => presence?.status === 'starting',
  waitForStartupGate: (tabId, purpose) => (
    waitForClaudeStartupDefaultsReadyWithVisibleFallback(tabId, 15000, purpose)
  ),
  resolveHistorySession(presence, sessionHint) {
    let sessionId = sessionHint || null;
    let authority: AgentHistorySessionAuthority = sessionId ? 'history-hint' : 'fresh';

    if (isLivePresence(presence)) {
      const liveSessionId = presence.sessionId || null;
      if (liveSessionId) {
        sessionId = liveSessionId;
        authority = 'live-writer';
      } else if (!sessionHint || presence.conversationMaterialized === false) {
        sessionId = null;
        authority = 'fresh';
      } else {
        throw new Error('Claude live writer session could not be verified before recording context');
      }
    }

    if (sessionId) {
      const conversationMaterialized = presence.conversationMaterialized === true
        || presence.canResume === true;
      const conversationProvenFresh = presence.conversationMaterialized === false
        && presence.canResume !== true;
      if (!conversationMaterialized && !conversationProvenFresh) {
        throw new Error('Claude conversation state could not be verified before recording context');
      }
      if (!conversationMaterialized) {
        sessionId = null;
        authority = 'fresh';
      }
    }

    return { sessionId, authority };
  },
  async adoptHistorySession(tabId, sessionId) {
    useWorkspaceStore.getState().setClaudeSessionId(tabId, sessionId, 'historyContext');
    return true;
  },
};

const CODEX_SEND_CONTRACT: AgentSendProviderContract = {
  toolType: 'codex',
  allowUnmountedActiveComposer: true,
  carriesExactEmptyEvidence: false,
  retryExactCaptureAfterCommittedFrame: false,
  passCancellationGuardToTransport: false,
  classifySubmitCapability(presence) {
    if (!presence || presence.status === 'unknown') return 'unknown';
    if (presence.status === 'busy') return 'queue';
    if ((presence.status === 'active' || presence.status === 'starting')
      && presence.inputReady === true) return 'direct';
    return 'blocked';
  },
  startupGateOwnsComposer: () => false,
  async waitForStartupGate() {},
  resolveHistorySession(presence, sessionHint) {
    let sessionId = sessionHint || null;
    let authority: AgentHistorySessionAuthority = sessionId ? 'history-hint' : 'fresh';

    if (isLivePresence(presence)) {
      const liveSessionId = presence.sessionId
        || getCodexRuntimeReadSessionId(presence.runtimeSnapshot)
        || null;
      if (liveSessionId) {
        sessionId = liveSessionId;
        authority = 'live-writer';
      } else if (!sessionHint) {
        sessionId = null;
        authority = 'fresh';
      } else {
        throw new Error('Codex live writer session could not be verified before recording context');
      }
    }

    return { sessionId, authority };
  },
  async adoptHistorySession(tabId, sessionId) {
    return useWorkspaceStore.getState().setCodexSessionId(
      tabId,
      sessionId,
      'historyContext',
    );
  },
};

export function getAgentSendProviderContract(
  toolType: AgentHistoryTool,
  runtime: HistoryAgentRuntime,
): AgentSendProviderContract {
  if (runtime.toolType !== toolType) {
    throw new Error('Agent send runtime/provider mismatch');
  }
  return toolType === 'codex' ? CODEX_SEND_CONTRACT : CLAUDE_SEND_CONTRACT;
}

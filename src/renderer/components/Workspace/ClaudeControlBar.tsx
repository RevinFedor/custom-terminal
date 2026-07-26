import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SquareTerminal } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { clearPendingResume, markPendingResume, isStaleAgainstPending } from '../../utils/pendingResume';
import {
  DEEPSEEK_EFFORT_LEVELS,
  claudeEffortsForModel,
  resolveClaudeEffortForModel,
} from '../../constants/claudeLevels';
import {
  CODEX_EFFORT_LEVELS,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  mergeCodexModelOptions,
  resolveCodexEffortForModel,
  type CodexModelOption,
} from '../../constants/codexSettings';
import CenteredUpwardPopover from '../UI/CenteredUpwardPopover';
import ControlHint from '../UI/ControlHint';
import { PROVIDER_CATALOG } from './providerCatalog';
import SessionActionChip from './SessionActionChip';
import MicButton from './MicButton';
import {
  DICTATION_DELIVERED_EVENT,
  DICTATION_STOP_AND_DELIVER_EVENT,
  type DictationMode,
  useDictationSnapshot,
} from '../../utils/dictationManager';
import { useCmdKey } from '../../hooks/useCmdHoverPopover';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { getHistoryAgentRuntime, type AgentPtyStatus } from '../../utils/historyAgentRuntimes';
import { requireCodexSurfaceSessionId } from '../../utils/codexWriterIdentity';
import { readCodexDraftAuthority } from '../../utils/codexDraftAuthority.mjs';
import { isCodexRuntimeForkReady } from '../../utils/codexPtyPresence.mjs';
import {
  planCodexLaunchSettingsPersistence,
  planCodexPickerStateApplication,
  planCodexPickerWriterPrecondition,
  planCodexSettingsControlAvailability,
  resolveCodexEffectiveSettings,
} from '../../utils/codexEffectiveSettings.mjs';
import { applyClaudePtySetting } from '../../utils/claudePtyActions';

const { ipcRenderer } = window.require('electron');

interface Props {
  tabId: string;
  projectId: string;
  /** Normal Claude/Codex PTY tab is presented through History, not xterm. */
  historyIsPrimary?: boolean;
  // Session info — supplied by Workspace.tsx via effective* selectors.
  claudeSessionId: string | null;
  geminiSessionId: string | null;
  codexSessionId: string | null;
  commandType: string | null;     // 'claude' | 'gemini' | etc — used to label SessionActionChip
  isCommandRunning: boolean;
  projectPath?: string;
}

// ============================================================================
// CacheCooldownChip — twin of the context meter, lives in the right cluster.
// ============================================================================
// Shows minutes left until Anthropic's prompt cache cools down (1h TTL that
// refreshes on every turn — so the countdown only ticks while the session is
// idle; an active turn re-anchors it). Main figure = minutes; secondary = the
// billing ratio (what fraction of full price this turn cost — cache_read pays
// 0.1×, so a warm cache lands ~10%). Hover → breakdown card, fixed width.
//
// Lives as its own component so its 1/min setInterval re-renders only the chip,
// not the whole bar. Hidden entirely when not Anthropic (DeepSeek/Zen have no
// cache → parent passes show=false) or when no turn has touched the cache yet.
const CACHE_TTL_MIN = 60; // server-side 1h TTL (see fact-provider-proxy.md)
type PtyTransitionEngine = 'claude' | 'codex';
type SessionActionBlockedStatus = Extract<AgentPtyStatus, 'starting' | 'stopping'> | null;
// Upper bound for an inline chip action (fork, clipboard fork). Generous
// enough for a real fork of a large session, short enough that a stuck
// operation reports instead of spinning for the rest of the session.
const INLINE_ACTION_DEADLINE_MS = 90_000;
type InlineAsyncActionKey =
  | 'fork-to-pty'
  | 'fork-to-sdk'
  | 'fork-from-clipboard-claude'
  | 'fork-from-clipboard-sdk'
  | 'fork-from-clipboard-codex';

function InlineActionContent({
  loading,
  children,
}: {
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Keep the original label in layout while loading. Replacing it with the
          spinner would shrink every fork chip to a different width and move the
          neighbouring controls at the exact moment the user clicks. */}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          visibility: loading ? 'hidden' : 'visible',
        }}
      >
        {children}
      </span>
      {loading && (
        <span
          aria-hidden
          className="animate-spin"
          style={{
            position: 'absolute',
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '1.5px solid rgba(255,255,255,0.28)',
            borderTopColor: 'currentColor',
            pointerEvents: 'none',
          }}
        />
      )}
    </span>
  );
}

function TerminalSourceMark({ size = 10 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        flexShrink: 0,
      }}
    >
      <SquareTerminal size={size} strokeWidth={1.8} />
      <span>→</span>
    </span>
  );
}

function CacheCooldownChip({
  data,
  busy,
}: {
  data: { cacheRead: number; cacheCreate: number; input: number; ts: number };
  busy: boolean;
}) {
  const [hover, setHover] = useState(false);
  // Re-render once a minute so the countdown stays current while idle. When a
  // turn is in flight (busy) the countdown is meaningless (cache re-anchors on
  // this very turn) — we show a live dot instead, no need to tick.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (busy) return;
    const id = setInterval(() => forceTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, [busy, data.ts]);

  const ageMin = (Date.now() - data.ts) / 60000;
  const leftMin = Math.max(0, CACHE_TTL_MIN - ageMin);
  const cold = leftMin <= 0;
  const soon = !cold && leftMin <= 10;

  // Billing ratio: cache_read bills 0.1×, cache_creation + fresh input bill 1×.
  // ratio = paid / (paid if everything were full-price). Lower = better.
  const billed = data.cacheRead * 0.1 + data.cacheCreate + data.input;
  const fullPrice = data.cacheRead + data.cacheCreate + data.input;
  const ratioPct = fullPrice > 0 ? Math.round((billed / fullPrice) * 100) : 100;
  const saveFactor = billed > 0 ? fullPrice / billed : 1;

  // Color: warm green, cooling-soon amber, cold grey.
  const color = cold ? '#777' : soon ? '#f59e0b' : '#4ade80';

  // Main figure = minutes (per user). Busy → dot (countdown frozen/re-anchoring).
  // Cold → snowflake glyph, no number. Secondary = billing %.
  const mainLabel = cold ? '❄' : busy ? '●' : `${Math.round(leftMin)}м`;

  const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : `${n}`;

  return (
    <span
      style={{ position: 'relative', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 12, color, fontVariantNumeric: 'tabular-nums',
          cursor: 'default', whiteSpace: 'nowrap',
        }}
      >
        {/* Cache/snapshot glyph — a clock-with-arrow (cooldown timer). Inherits
            currentColor so it tracks the warm/amber/cold state. Only the minutes
            are shown inline; the billing % lives in the hover card. */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ opacity: 0.85, flexShrink: 0 }} aria-hidden>
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <polyline points="21 3 21 9 15 9" />
          <polyline points="12 8 12 12 14.5 13.5" />
        </svg>
        <span style={{ fontWeight: 500 }}>{mainLabel}</span>
      </span>

      {hover && (
        <div
          style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', right: 0,
            width: 232, padding: '10px 12px',
            backgroundColor: '#1c1c1c', border: '1px solid #333', borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)', zIndex: 50,
            fontSize: 12, lineHeight: 1.5, color: '#ddd', cursor: 'default',
          }}
        >
          {cold ? (
            <>
              <div style={{ fontWeight: 600, color: '#aaa', marginBottom: 4 }}>Кэш остыл</div>
              <div style={{ color: '#999' }}>
                Следующий ход пересчитает весь контекст заново — полная цена.
                Любой ход снова прогреет кэш на час.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600, color, marginBottom: 4 }}>
                {busy ? 'Кэш активен' : 'Кэш тёплый'}
              </div>
              <div style={{ color: '#999', marginBottom: 8 }}>
                {busy ? 'Отсчёт продлевается этим ходом' : `Остынет через ${Math.round(leftMin)} мин`}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>из кэша</span>
                <span style={{ color: '#4ade80', fontVariantNumeric: 'tabular-nums' }}>{fmtK(data.cacheRead)} · ×0.1</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>пересчитано</span>
                <span style={{ color: '#bbb', fontVariantNumeric: 'tabular-nums' }}>{fmtK(data.cacheCreate + data.input)}</span>
              </div>
              <div style={{ borderTop: '1px solid #2e2e2e', marginTop: 8, paddingTop: 6, color: '#999' }}>
                Заплатил ~{ratioPct}% от полной цены
                {saveFactor >= 1.5 && <> · экономия ≈ ×{saveFactor.toFixed(saveFactor >= 10 ? 0 : 1)}</>}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}

// Bottom-anchored Claude control strip rendered under the Terminal column for
// both PTY and SDK Claude tabs. Replaces the inline Provider/Model/Effort/Think
// section that used to live in the right-side InfoPanel.
//
// Layout: [Ctx % + bar]  …  [Provider] [Model ▾] [Effort ▾] [Think]
//          left flex                                      right cluster
//
// Dropdowns open upward (bottom: 100%) as flat horizontal pill rows — one
// click on the trigger reveals the list, one click on a pill picks the value
// and closes. Click-outside closes without a pick.
export default function ClaudeControlBar({
  tabId,
  projectId,
  historyIsPrimary = false,
  claudeSessionId,
  geminiSessionId,
  codexSessionId,
  commandType,
  isCommandRunning,
  projectPath,
}: Props) {
  const showToast = useUIStore((s) => s.showToast);
  // The active agent follows the process-promoted command type first. A tab
  // can retain an older Claude/Codex transcript while a different agent is
  // already running in its PTY; letting the older id win would route controls
  // to the wrong TUI and render both quick-switch variants. Session ids are a
  // fallback only for tabs whose current command has no AI type yet.
  const savedSessionType: 'claude' | 'gemini' | 'codex' = claudeSessionId
    ? 'claude'
    : geminiSessionId ? 'gemini'
    : codexSessionId ? 'codex'
    : 'claude';
  const sessionType: 'claude' | 'gemini' | 'codex' = commandType === 'gemini'
    ? 'gemini'
    : commandType === 'codex'
      ? 'codex'
      : commandType === 'claude'
        ? 'claude'
        : savedSessionType;
  const sessionId = sessionType === 'claude'
    ? claudeSessionId
    : sessionType === 'gemini'
      ? geminiSessionId
      : codexSessionId;
  const [sessionCopied, setSessionCopied] = useState(false);
  const [sessionCopyHover, setSessionCopyHover] = useState(false);
  const [sessionCopyRect, setSessionCopyRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // Per-field primitive selectors. A single composite-object selector returned a
  // fresh `{}` on every render → Zustand fires re-renders forever → Maximum
  // update depth. Anti-pattern documented in CLAUDE.md ("Zustand: Не подписывайся
  // на Map целиком" / fingerprint pattern).
  const tabType = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.tabType;
    }
    return undefined;
  });
  const sdkModel = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.sdkModel || 'default';
    }
    return 'default';
  });
  const sdkEffort = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.sdkEffort || 'high';
    }
    return 'high';
  });
  const codexTabModel = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.codexModel;
    }
    return undefined;
  });
  const codexTabEffort = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.codexEffort;
    }
    return undefined;
  });
  const codexLiveModel = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.codexLiveModel;
    }
    return undefined;
  });
  const codexLiveEffort = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.codexLiveEffort;
    }
    return undefined;
  });
  const codexLiveSettingsSessionId = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.codexLiveSettingsSessionId;
    }
    return undefined;
  });
  const codexSettingsProofSessionId = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.codexSettingsProofSessionId;
    }
    return undefined;
  });
  const currentTabCwd = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.cwd;
    }
    return undefined;
  });
  const launchCwd = currentTabCwd || projectPath;
  const defaultCodexModel = useUIStore((s) => s.defaultCodexModel);
  const defaultCodexEffort = useUIStore((s) => s.defaultCodexEffort);
  const persistentCodexModel = codexTabModel || (defaultCodexModel !== 'none' ? defaultCodexModel : DEFAULT_CODEX_MODEL);
  const persistentCodexEffort = codexTabEffort || (defaultCodexEffort !== 'none' ? defaultCodexEffort : DEFAULT_CODEX_EFFORT);
  const effectiveCodexSettings = resolveCodexEffectiveSettings({
    codexSessionId,
    codexModel: persistentCodexModel,
    codexEffort: persistentCodexEffort,
    codexLiveModel,
    codexLiveEffort,
    codexLiveSettingsSessionId,
  });
  const codexModel = effectiveCodexSettings.model || persistentCodexModel;
  const codexEffort = effectiveCodexSettings.effort || persistentCodexEffort;
  const codexEffectiveProofSessionId = effectiveCodexSettings.liveOwned
    ? codexLiveSettingsSessionId
    : codexSettingsProofSessionId;
  const sdkThinking = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.sdkThinking !== false;
    }
    return true;
  });
  // Process-alive flag (granular primitive selector — Fingerprint pattern, no
  // Map subscription). Drives the process indicator's 3 states together with sdkBusy.
  const sdkProcessAlive = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return !!t.sdkProcessAlive;
    }
    return false;
  });
  const tabAiBusy = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return !!t.aiBusy;
    }
    return false;
  });
  const isSDKTab = tabType === 'claude-sdk';
  const isCodex = sessionType === 'codex';
  const codexTurnBusy = isCodex && tabAiBusy;
  const historyCanSend = useUIStore(
    (s) => s.historyComposerAvailability[tabId]?.canSend === true,
  );
  const historyCanAcceptSubmitIntent = useUIStore(
    (s) => s.historyComposerAvailability[tabId]?.canAcceptSubmitIntent === true,
  );
  const historyCanInterruptTurn = useUIStore(
    (s) => s.historyComposerAvailability[tabId]?.canInterruptTurn === true,
  );
  const historyCanPullDraft = useUIStore(
    (s) => s.historyComposerAvailability[tabId]?.canPullDraft === true,
  );
  const isClaudePtySession = sessionType === 'claude' && !isSDKTab;
  // Confirmed current-session settings. Unlike StatusBar defaults, these are
  // reconstructed from the active JSONL branch and therefore survive renderer
  // restart, follow native Rewind, and include commands typed in the terminal.
  const [claudeModel, setClaudeModel] = useState<string | null>(null);
  const [effortLocal, setEffortLocal] = useState<string | undefined>(undefined);
  const claudeSettingsRequestRef = useRef(0);
  const [claudeMaterialization, setClaudeMaterialization] = useState<{
    sessionId: string | null;
    conversationMaterialized: boolean | null;
    timelineCount: number | null;
    reason: string | null;
  }>({ sessionId: null, conversationMaterialized: null, timelineCount: null, reason: null });
  const claudeMaterializationRequestRef = useRef(0);

  const refreshClaudeConfirmedSettings = useCallback(async (checkReason: string) => {
    if (!isClaudePtySession || !claudeSessionId) {
      claudeSettingsRequestRef.current += 1;
      setClaudeModel(null);
      setEffortLocal(undefined);
      return null;
    }
    const requestSeq = ++claudeSettingsRequestRef.current;
    try {
      const result = await ipcRenderer.invoke('claude:get-confirmed-settings', {
        tabId,
        sessionId: claudeSessionId,
        cwd: launchCwd,
      });
      if (requestSeq !== claudeSettingsRequestRef.current) return null;
      if (result?.success !== true || result.sessionId !== claudeSessionId) {
        console.warn(
          '[ClaudeControlBar:ConfirmedSettings] ignored tab=' + tabId.slice(-12)
          + ' sid=' + claudeSessionId.slice(0, 8)
          + ' check=' + checkReason
          + ' reason=' + (result?.reason || 'unconfirmed')
        );
        return null;
      }
      if (result.model) setClaudeModel(result.model);
      setEffortLocal(result.effort || undefined);
      console.warn(
        '[ClaudeControlBar:ConfirmedSettings] tab=' + tabId.slice(-12)
        + ' sid=' + claudeSessionId.slice(0, 8)
        + ' model=' + (result.model || 'bridge/default')
        + ' effort=' + (result.effort || 'unset')
        + ' check=' + checkReason
      );
      return result;
    } catch (error: any) {
      if (requestSeq !== claudeSettingsRequestRef.current) return null;
      console.warn(
        '[ClaudeControlBar:ConfirmedSettings] failed tab=' + tabId.slice(-12)
        + ' sid=' + claudeSessionId.slice(0, 8)
        + ' check=' + checkReason
        + ' error=' + String(error?.message || error)
      );
      return null;
    }
  }, [claudeSessionId, isClaudePtySession, launchCwd, tabId]);

  const refreshClaudeMaterialization = useCallback(async (
    checkReason: string,
    options: { markChecking?: boolean } = {},
  ) => {
    if (!isClaudePtySession || !claudeSessionId) {
      claudeMaterializationRequestRef.current += 1;
      setClaudeMaterialization({ sessionId: null, conversationMaterialized: null, timelineCount: null, reason: null });
      return null;
    }

    const requestSeq = ++claudeMaterializationRequestRef.current;
    if (options.markChecking) {
      setClaudeMaterialization({ sessionId: claudeSessionId, conversationMaterialized: null, timelineCount: null, reason: 'checking' });
    }

    try {
      const result = await ipcRenderer.invoke('claude:session-materialization', { sessionId: claudeSessionId, cwd: launchCwd });
      if (requestSeq !== claudeMaterializationRequestRef.current) return null;
      const materialized = result?.materialized === true || result?.conversationMaterialized === true;
      const timelineCount = typeof result?.timelineCount === 'number' ? result.timelineCount : null;
      const reason = result?.reason || result?.materializationReason || null;
      console.log('[ClaudeControlBar:Materialization] tab=' + tabId.slice(-12)
        + ' sid=' + claudeSessionId.slice(0, 8)
        + ' materialized=' + materialized
        + ' timelineCount=' + (timelineCount ?? 'null')
        + ' reason=' + (reason || '-')
        + ' check=' + checkReason);
      const snapshot = { sessionId: claudeSessionId, conversationMaterialized: materialized, timelineCount, reason };
      setClaudeMaterialization(snapshot);
      return snapshot;
    } catch (e: any) {
      if (requestSeq !== claudeMaterializationRequestRef.current) return null;
      console.warn('[ClaudeControlBar:Materialization] failed tab=' + tabId.slice(-12)
        + ' sid=' + claudeSessionId.slice(0, 8)
        + ' check=' + checkReason
        + ': ' + String(e?.message || e));
      const snapshot = { sessionId: claudeSessionId, conversationMaterialized: false, timelineCount: null, reason: 'materialization-check-failed' };
      setClaudeMaterialization(snapshot);
      return snapshot;
    }
  }, [claudeSessionId, isClaudePtySession, launchCwd, tabId]);

  useEffect(() => {
    void refreshClaudeMaterialization('initial', { markChecking: true });
  }, [refreshClaudeMaterialization]);

  useEffect(() => {
    setClaudeModel(null);
    setEffortLocal(undefined);
    void refreshClaudeConfirmedSettings('session-change');
  }, [claudeSessionId, refreshClaudeConfirmedSettings]);

  useEffect(() => {
    if (!isClaudePtySession || !claudeSessionId) return;

    const consumerId = 'controlbar-materialization:' + tabId;
    let disposed = false;
    let refreshQueued = false;
    const queueRefresh = (reason: string) => {
      if (refreshQueued || disposed) return;
      refreshQueued = true;
      requestAnimationFrame(() => {
        refreshQueued = false;
        if (disposed) return;
        void refreshClaudeMaterialization(reason);
        void refreshClaudeConfirmedSettings(reason);
      });
    };

    const onTranscriptChanged = (_event: any, detail: any) => {
      if (detail?.sessionId !== claudeSessionId) return;
      if (detail?.toolType && detail.toolType !== 'claude') return;
      queueRefresh(detail?.reason || 'transcript-change');
    };

    ipcRenderer.on('agent-transcript:changed', onTranscriptChanged);
    ipcRenderer.invoke('agent-transcript:subscribe', {
      consumerId,
      tabId,
      toolType: 'claude',
      sessionId: claudeSessionId,
      cwd: launchCwd,
    }).then((result: any) => {
      console.log('[ClaudeControlBar:TranscriptSubscribe] tab=' + tabId.slice(-12)
        + ' sid=' + claudeSessionId.slice(0, 8)
        + ' success=' + (result?.success ? '1' : '0')
        + ' file=' + (result?.filePath ? '1' : '0'));
    }).catch((e: any) => {
      console.warn('[ClaudeControlBar:TranscriptSubscribe] failed tab=' + tabId.slice(-12)
        + ' sid=' + claudeSessionId.slice(0, 8)
        + ' error=' + String(e?.message || e));
    });

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      ipcRenderer.invoke('agent-transcript:refresh', {
        tabId,
        toolType: 'claude',
        sessionId: claudeSessionId,
        cwd: launchCwd,
        reason: 'controlbar-visibility-resume',
      }).catch(() => {});
      queueRefresh('visibility-resume');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      ipcRenderer.removeListener('agent-transcript:changed', onTranscriptChanged);
      ipcRenderer.invoke('agent-transcript:unsubscribe', { consumerId }).catch(() => {});
    };
  }, [
    claudeSessionId,
    isClaudePtySession,
    launchCwd,
    refreshClaudeConfirmedSettings,
    refreshClaudeMaterialization,
    tabId,
  ]);

  const claudeConversationMaterialized =
    !isClaudePtySession
      ? true
      : !!claudeSessionId
        && claudeMaterialization.sessionId === claudeSessionId
        && claudeMaterialization.conversationMaterialized === true;
  const hasArtifactSession = !!sessionId && (!isClaudePtySession || claudeConversationMaterialized);
  const hasAnySession = hasArtifactSession || (!!sessionId && isCommandRunning);

  const ensureClaudeArtifactSession = async (reason: string): Promise<boolean> => {
    if (!isClaudePtySession || !claudeSessionId) return true;
    if (claudeConversationMaterialized) return true;
    try {
      const result = await ipcRenderer.invoke('claude:session-materialization', { sessionId: claudeSessionId, cwd: launchCwd });
      const materialized = result?.materialized === true || result?.conversationMaterialized === true;
      const timelineCount = typeof result?.timelineCount === 'number' ? result.timelineCount : null;
      const materializationReason = result?.reason || result?.materializationReason || null;
      setClaudeMaterialization({ sessionId: claudeSessionId, conversationMaterialized: materialized, timelineCount, reason: materializationReason });
      if (materialized) return true;
      console.warn('[ClaudeControlBar:Materialization] blocked ' + reason
        + ' tab=' + tabId.slice(-12)
        + ' sid=' + claudeSessionId.slice(0, 8)
        + ' timelineCount=' + (timelineCount ?? 'null')
        + ' reason=' + (materializationReason || '-'));
    } catch (e: any) {
      setClaudeMaterialization({ sessionId: claudeSessionId, conversationMaterialized: false, timelineCount: null, reason: 'materialization-check-failed' });
      console.warn('[ClaudeControlBar:Materialization] blocked ' + reason
        + ' tab=' + tabId.slice(-12)
        + ' sid=' + claudeSessionId.slice(0, 8)
        + ' error=' + String(e?.message || e));
    }
    showToast('У этой вкладки ещё нет сохранённой беседы Claude', 'warning');
    return false;
  };

  const requireCodexActionSessionId = async (
    operation: string,
    requireMutationSafe = false,
  ): Promise<string | null> => {
    try {
      return await requireCodexSurfaceSessionId({
        tabId,
        historicalSessionId: codexSessionId,
        operation,
        requireMutationSafe,
      });
    } catch (error: any) {
      showToast(error?.message || `Не удалось проверить Codex-сессию перед действием «${operation}»`, 'warning');
      return null;
    }
  };

  const copySessionId = async () => {
    const actionSessionId = sessionType === 'codex'
      ? await requireCodexActionSessionId('скопировать ID сессии')
      : sessionId;
    if (!actionSessionId) return;
    if (!(await ensureClaudeArtifactSession('copy-session-id'))) return;
    // Electron clipboard, не navigator.clipboard — последний в renderer тихо
    // отваливается без HTTPS/permissions, юзер видит как «даже логов нет».
    // См. CLAUDE.md anti-pattern «Не используй navigator.clipboard в renderer».
    try {
      const { clipboard } = window.require('electron');
      clipboard.writeText(actionSessionId);
      setSessionCopied(true);
      setTimeout(() => setSessionCopied(false), 1000);
    } catch (e) {
      console.error('[ClaudeControlBar] copySessionId failed:', e);
    }
  };

  // Live bridge data (PTY only): context %, plus a model fallback for sessions
  // that have no confirmed /model command in their active history.
  const [contextPct, setContextPct] = useState<number>(0);
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const claudeCodeSettings = useUIStore((s) => s.claudeCodeSettings);
  const codexSettings = useUIStore((s) => s.codexSettings);
  const quickClaudeReturnRef = useRef<{ model: string; effort: string } | null>(null);
  const [quickClaudeApplied, setQuickClaudeApplied] = useState(false);
  const quickCodexReturnRef = useRef<{ model: string; effort: string } | null>(null);
  const [quickCodexApplied, setQuickCodexApplied] = useState(false);
  const [quickPresetHover, setQuickPresetHover] = useState(false);
  const [quickPresetRect, setQuickPresetRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const quickPresetButtonRef = useRef<HTMLButtonElement | null>(null);
  // Cache cooldown chip data: split + the timestamp this turn touched the cache.
  // Anthropic's prompt cache uses a 1h TTL that REFRESHES on every use, so `ts`
  // is the cooldown anchor — countdown = 60min − (now − ts). PTY arrives via
  // claude:cache-update IPC (proxy taps message_start); SDK via sdk-cache-update
  // window event (SDK bypasses the proxy). Null = no turn yet this session →
  // chip hidden. Not persisted: freshness is a live metric, stale ts would lie.
  const [cacheData, setCacheData] = useState<{ cacheRead: number; cacheCreate: number; input: number; ts: number } | null>(null);
  // Last whole-percent we persisted. The bridge/SDK report % many times per
  // turn; we only hit the DB when the rounded value actually moves, so the
  // single-column UPDATE fires a few dozen times a session, not per tick.
  const lastPersistedPctRef = useRef<number>(-1);
  const persistContextPct = (pct: number) => {
    if (typeof pct !== 'number' || pct <= 0) return;
    const rounded = Math.round(pct);
    if (rounded === lastPersistedPctRef.current) return;
    lastPersistedPctRef.current = rounded;
    ipcRenderer.invoke('tab:persist-context-pct', { tabId, pct }).catch(() => {});
  };

  useEffect(() => {
    if (sessionType !== 'codex') return;
    let cancelled = false;
    ipcRenderer.invoke('codex:list-models').then((res: any) => {
      if (cancelled) return;
      const models = mergeCodexModelOptions(res?.models, codexSettings.models, codexSettings.removedModelIds);
      if (models.length === 0) return;
      setCodexModels(models);

      const state = useWorkspaceStore.getState();
      let currentModel = defaultCodexModel !== 'none' ? defaultCodexModel : DEFAULT_CODEX_MODEL;
      let currentEffort = defaultCodexEffort !== 'none' ? defaultCodexEffort : DEFAULT_CODEX_EFFORT;
      let hasTabCodexState = false;
      let hasOwnedLiveCodexState = false;
      for (const [, ws] of state.openProjects) {
        const tab = ws.tabs.get(tabId);
        if (tab) {
          hasTabCodexState = !!tab.codexModel || !!tab.codexEffort;
          const effective = resolveCodexEffectiveSettings({
            codexSessionId: tab.codexSessionId,
            codexModel: tab.codexModel || currentModel,
            codexEffort: tab.codexEffort || currentEffort,
            codexLiveModel: tab.codexLiveModel,
            codexLiveEffort: tab.codexLiveEffort,
            codexLiveSettingsSessionId: tab.codexLiveSettingsSessionId,
          });
          hasOwnedLiveCodexState = effective.liveOwned;
          currentModel = effective.model || currentModel;
          currentEffort = effective.effort || currentEffort;
          break;
        }
      }

      const nextModel = models.some((m: any) => m.id === currentModel)
        ? currentModel
        : (models.some((m: any) => m.id === DEFAULT_CODEX_MODEL) ? DEFAULT_CODEX_MODEL : models[0].id);
      const active = models.find((m: any) => m.id === nextModel) || models[0];
      const efforts = active?.efforts || [...CODEX_EFFORT_LEVELS];
      const nextEffort = efforts.includes(currentEffort)
        ? currentEffort
        : (efforts.includes(DEFAULT_CODEX_EFFORT) ? DEFAULT_CODEX_EFFORT : (active?.defaultEffort || efforts[0] || DEFAULT_CODEX_EFFORT));
      if (
        hasTabCodexState
        && !hasOwnedLiveCodexState
        && (nextModel !== currentModel || nextEffort !== currentEffort)
      ) {
        state.updateCodexState(tabId, { codexModel: nextModel, codexEffort: nextEffort });
      }
    }).catch((e: any) => console.warn('[CodexControlBar] model list failed:', e));
    return () => { cancelled = true; };
  }, [sessionType, tabId, defaultCodexModel, defaultCodexEffort, codexSettings.models, codexSettings.removedModelIds]);

  useEffect(() => {
    if (sessionType !== 'codex') return;
    let cancelled = false;
    ipcRenderer.invoke('codex:get-runtime-session', { tabId, projectId })
      .then((snapshot: any) => {
        if (cancelled) return;
        const owner = String(snapshot?.codexProvisionalSettingsOwnerId || '').trim();
        const model = String(snapshot?.codexProvisionalModel || '').trim();
        const effort = String(snapshot?.codexProvisionalEffort || '').trim().toLowerCase();
        if (
          snapshot?.liveLifecycle !== true
          || snapshot?.provenWriterSessionId
          || !owner.startsWith('launch:')
          || !model
          || !effort
        ) {
          return;
        }
        useWorkspaceStore.getState().updateCodexLiveState(tabId, {
          codexLiveModel: model,
          codexLiveEffort: effort,
          codexLiveSettingsSessionId: owner,
        });
      })
      .catch((error: any) => {
        console.warn('[CodexControlBar] provisional settings restore failed tab='
          + tabId.slice(-12)
          + ' error=' + String(error?.message || error));
      });
    return () => { cancelled = true; };
  }, [sessionType, tabId, projectId]);

  // Seed the meter from the last value persisted for THIS tab, so it shows the
  // last-known context fill even when no Claude process is running (CLI exited
  // or not launched yet). Guard against a live tick that already landed: only
  // apply the seed if the meter is still at 0.
  useEffect(() => {
    setClaudeModel(null);
    setContextPct(0);
    setCacheData(null);
    lastPersistedPctRef.current = -1;
    let cancelled = false;
    ipcRenderer.invoke('tab:get-context-pct', { tabId }).then((r: any) => {
      const seeded = r?.pct;
      if (cancelled || typeof seeded !== 'number' || seeded <= 0) return;
      setContextPct(prev => (prev === 0 ? seeded : prev));
      lastPersistedPctRef.current = Math.round(seeded);
    }).catch(() => {});

    const handler = (_: any, data: { tabId: string; sessionId?: string; model: string; contextPct: number }) => {
      if (data.tabId !== tabId) return;
      // Once the tab has a durable binding, a live status-line frame belongs to
      // this ControlBar only when it names that exact session. Pending-resume
      // checks cover the handoff window; this equality guard also rejects a
      // delayed bridge frame that arrives after the handoff already completed.
      if (claudeSessionId && data.sessionId !== claudeSessionId) {
        console.warn(
          '[ClaudeControlBar:Bridge] ignored foreign session tab=' + tabId.slice(-12)
          + ' current=' + claudeSessionId.slice(0, 8)
          + ' incoming=' + String(data.sessionId || 'missing').slice(0, 8)
        );
        return;
      }
      // Same stale-bridge guard Terminal.tsx applies to sessionId writes: during a
      // resume (PID-reuse race) a foreign/dead session's bridge can fire first. We
      // must not stamp — and especially not PERSIST — its model/%/cache onto this
      // tab. Terminal.tsx already rejects the foreign sessionId write; mirror that
      // here so the meter doesn't show another session's number. See
      // fix-bridge-stale-takeover.md + pty-streaming audit.
      if (data.sessionId && isStaleAgainstPending(tabId, data.sessionId)) return;
      setClaudeModel(data.model);
      // Symmetric with persistContextPct's `pct <= 0` guard: a live frame of 0
      // (sub-1% floored by statusline-bridge's `cut -d. -f1`, or a missing
      // .used_percentage where jq returns the `// 0` fallback) must NOT wipe a
      // known non-zero meter — the render guard hides at 0, so an unconditional
      // setContextPct(0) made the % vanish mid-session / right after a SQLite seed.
      // Keep the last-known value until a real positive number arrives.
      if (typeof data.contextPct === 'number' && data.contextPct > 0) {
        setContextPct(data.contextPct);
        persistContextPct(data.contextPct);
      }
    };
    ipcRenderer.on('claude:bridge-update', handler);
    return () => { cancelled = true; ipcRenderer.removeListener('claude:bridge-update', handler); };
  }, [claudeSessionId, tabId]);

  // SDK tab: context % lives in ClaudeSDKTab local state. It re-emits a window
  // CustomEvent('sdk-context-update', {tabId, contextPct, model}) on every
  // assistant SSE — same pattern as the existing 'history-panel:loading' event.
  // No setContextPct(0) reset here — the effect above already seeded from the
  // persisted value; zeroing would wipe the last-known % on every tab switch.
  useEffect(() => {
    if (!isSDKTab) return;
    const handler = (e: Event) => {
      const { tabId: t, contextPct: c, model: m } = (e as CustomEvent).detail || {};
      if (t !== tabId) return;
      if (typeof c === 'number') { setContextPct(c); persistContextPct(c); }
      if (m) setClaudeModel(m);
    };
    window.addEventListener('sdk-context-update', handler);
    return () => window.removeEventListener('sdk-context-update', handler);
  }, [tabId, isSDKTab]);

  // Codex tab: context % comes via codex:context-update IPC, emitted by the
  // rollout turn watcher (main) on every token_count event. The number is
  // Codex's own — last_token_usage.total_tokens / model_context_window — not our
  // recompute (see emitCodexContextPct + fact-codex.md::Timeline). Same
  // contextPct state + SQLite seed/persist as Claude/SDK, so the chip renders,
  // colors and survives restart identically. Stale-bridge guard mirrors the
  // claude:bridge-update handler: during a resume/PID-reuse race a dead session's
  // tail could fire first; don't stamp another session's % onto this tab.
  useEffect(() => {
    if (!isCodex) return;
    const handler = (_: any, data: { tabId: string; sessionId?: string; contextPct: number }) => {
      if (data.tabId !== tabId) return;
      if (data.sessionId && isStaleAgainstPending(tabId, data.sessionId)) return;
      if (typeof data.contextPct === 'number' && data.contextPct > 0) {
        setContextPct(data.contextPct);
        persistContextPct(data.contextPct);
      }
    };
    ipcRenderer.on('codex:context-update', handler);
    return () => ipcRenderer.removeListener('codex:context-update', handler);
  }, [tabId, isCodex]);

  // Cache cooldown data — two channels, same shape, mutually exclusive by tab type.
  // PTY: claude:cache-update IPC (proxy parsed message_start, only fires for
  // anthropic mode → DeepSeek/Zen never emit → chip stays hidden for them).
  // SDK: sdk-cache-update window event (SDK runs direct to Anthropic, no proxy).
  //
  // Persisted per-tab in SQLite: ts is a wall-clock anchor (server cache TTL is
  // wall-clock), so the "cools down in N min" countdown stays accurate after a
  // tab switch or restart. Without this the chip vanished on every navigation
  // (it only existed between a live turn and the next remount). Seed on mount
  // from the stored value; live events overwrite + re-persist.
  const persistCacheStats = (s: { cacheRead: number; cacheCreate: number; input: number; ts: number }) => {
    ipcRenderer.invoke('tab:persist-cache-stats', { tabId, stats: s }).catch(() => {});
  };
  useEffect(() => {
    let cancelled = false;
    ipcRenderer.invoke('tab:get-cache-stats', { tabId }).then((r: any) => {
      const s = r?.stats;
      if (cancelled || !s || typeof s.ts !== 'number') return;
      // Don't clobber a live event that already landed during the async round-trip.
      setCacheData(prev => prev ?? { cacheRead: s.cacheRead || 0, cacheCreate: s.cacheCreate || 0, input: s.input || 0, ts: s.ts });
    }).catch(() => {});

    const ptyHandler = (_: any, data: { tabId: string; cacheRead: number; cacheCreate: number; input: number; ts: number }) => {
      if (data.tabId !== tabId) return;
      const s = { cacheRead: data.cacheRead, cacheCreate: data.cacheCreate, input: data.input, ts: data.ts };
      setCacheData(s);
      persistCacheStats(s);
    };
    const sdkHandler = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.tabId !== tabId) return;
      const s = { cacheRead: d.cacheRead, cacheCreate: d.cacheCreate, input: d.input, ts: d.ts };
      setCacheData(s);
      persistCacheStats(s);
    };
    ipcRenderer.on('claude:cache-update', ptyHandler);
    window.addEventListener('sdk-cache-update', sdkHandler);
    return () => {
      cancelled = true;
      ipcRenderer.removeListener('claude:cache-update', ptyHandler);
      window.removeEventListener('sdk-cache-update', sdkHandler);
    };
  }, [tabId]);

  // Provider state (PTY only — SDK runs directly against Anthropic).
  const [providerState, setProviderState] = useState<{ type: string; model?: string; effort?: string }>({ type: 'anthropic' });
  const providerMemoryRef = useRef<Record<string, string | null>>({ anthropic: null, zen: 'minimax-m2.7', deepseek: 'deepseek-v4-flash' });
  useEffect(() => {
    if (isSDKTab) return;
    ipcRenderer.invoke('provider:get-status', { tabId }).then((s: any) => { if (s) setProviderState(s); }).catch(() => {});
    const handler = (_: any, data: { tabId: string; state: any }) => {
      if (data.tabId === tabId && data.state) setProviderState(data.state);
    };
    ipcRenderer.on('provider:state-changed', handler);
    return () => { ipcRenderer.removeListener('provider:state-changed', handler); };
  }, [tabId, isSDKTab]);

  // PTY think is process-local. Model/effort above are session-history state.
  const [thinkLocal, setThinkLocal] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (isSDKTab) return;
    const onFinished = (_: any, data: { tabId: string }) => {
      if (data.tabId !== tabId) return;
      setThinkLocal(undefined);
    };
    ipcRenderer.on('terminal:command-finished', onFinished);
    return () => {
      ipcRenderer.removeListener('terminal:command-finished', onFinished);
    };
  }, [tabId, isSDKTab]);

  // The settings-owned model rows are the UI contract for available effort
  // levels. The SDK capability probe remains available to other surfaces, but
  // this control bar deliberately follows the user's configured list.

  // Paste/control busy mirror — disables all writes while another caller mid-paste.
  const [isPasteBusy, setIsPasteBusy] = useState(false);
  const [isLocalBusy, setIsLocalBusy] = useState(false);
  const isBusy = isPasteBusy || isLocalBusy;
  const busySnapshotRef = useRef({ paste: false, local: false });
  const localBusyReasonRef = useRef<string | null>(null);
  const controlActionInFlightRef = useRef<string | null>(null);
  // Fork actions live outside the provider/model busy overlay, so they need
  // their own immediate, in-place feedback. Keep identity in the state because
  // this component instance is reused across tab switches: an old tab's async
  // `finally` must never clear a newer tab/action loader.
  const inlineActionSeqRef = useRef(0);
  const inlineActionRef = useRef<{ tabId: string; key: InlineAsyncActionKey; seq: number } | null>(null);
  const [inlineAction, setInlineAction] = useState<{ tabId: string; key: InlineAsyncActionKey; seq: number } | null>(null);
  const runInlineAction = useCallback(async (
    key: InlineAsyncActionKey,
    action: () => void | Promise<void>,
  ) => {
    const existing = inlineActionRef.current;
    if (existing?.tabId === tabId) return;

    const identity = { tabId, key, seq: ++inlineActionSeqRef.current };
    inlineActionRef.current = identity;
    setInlineAction(identity);
    // Terminal guarantee. `finally` already covers resolve and throw, but an
    // operation that never settles at all (a promise that stays pending —
    // dropped IPC reply, an await on an event that will not arrive) left the
    // spinner running forever, clearable only by switching tabs and back. A
    // loader must have a terminal condition it cannot avoid, so a bounded
    // deadline reports the timeout instead of spinning silently.
    const deadline = window.setTimeout(() => {
      const current = inlineActionRef.current;
      if (current?.seq !== identity.seq) return;
      console.warn('[InlineAction] cleared tab=' + identity.tabId.slice(-12)
        + ' key=' + identity.key + ' seq=' + identity.seq + ' reason=deadline');
      inlineActionRef.current = null;
      setInlineAction((visible) => (visible?.seq === identity.seq ? null : visible));
      showToast('Действие не завершилось — попробуйте ещё раз', 'error');
    }, INLINE_ACTION_DEADLINE_MS);
    try {
      await action();
    } catch (error: any) {
      console.error('[ControlBarInlineAction] failed tab=' + tabId.slice(-12)
        + ' action=' + key + ' error=' + String(error?.message || error));
      showToast('Действие не выполнено: ' + String(error?.message || error), 'error');
    } finally {
      window.clearTimeout(deadline);
      const current = inlineActionRef.current;
      if (
        current?.tabId === identity.tabId
        && current.key === identity.key
        && current.seq === identity.seq
      ) {
        console.warn('[InlineAction] cleared tab=' + identity.tabId.slice(-12)
          + ' key=' + identity.key + ' seq=' + identity.seq + ' reason=settled');
        inlineActionRef.current = null;
        setInlineAction((visible) => (
          visible?.tabId === identity.tabId
          && visible.key === identity.key
          && visible.seq === identity.seq
            ? null
            : visible
        ));
      }
    }
  }, [showToast, tabId]);
  const isInlineActionLoading = (key: InlineAsyncActionKey) => (
    inlineAction?.tabId === tabId && inlineAction.key === key
  );
  useEffect(() => {
    // Invalidate the previous binding synchronously for all future completions.
    // The render guard above already hides its loader on the first new-tab frame.
    inlineActionSeqRef.current += 1;
    inlineActionRef.current = null;
    setInlineAction(null);
  }, [tabId]);
  const ptyTransitionEngine = useMemo<PtyTransitionEngine | null>(() => {
    if (isSDKTab) return null;
    if (commandType === 'codex' || codexSessionId) return 'codex';
    if (commandType === 'claude' || claudeSessionId) return 'claude';
    return null;
  }, [claudeSessionId, codexSessionId, commandType, isSDKTab]);
  const [sessionActionBlockedStatus, setSessionActionBlockedStatus] = useState<SessionActionBlockedStatus>(null);
  const [codexForkProof, setCodexForkProof] = useState<{
    tabId: string;
    ready: boolean;
    probeFailed?: boolean;
  } | null>(null);
  const codexForkWriterReady = codexForkProof?.tabId === tabId && codexForkProof.ready;
  const codexForkProbeFailed = codexForkProof?.tabId === tabId
    && codexForkProof.probeFailed === true;
  const codexForkWaitingForHistory = sessionType === 'codex' && !codexForkWriterReady;
  const sessionActionProbeSeqRef = useRef(0);
  const setSessionActionBlockedStatusIfChanged = useCallback((next: SessionActionBlockedStatus, reason: string) => {
    setSessionActionBlockedStatus((prev) => {
      if (prev === next) return prev;
      console.log('[SessionActionChip] blocked-status tab=' + tabId.slice(-12) + ' type=' + sessionType + ' ' + (prev || 'none') + '→' + (next || 'none') + ' reason=' + reason);
      return next;
    });
  }, [sessionType, tabId]);
  const refreshSessionActionBlockedStatus = useCallback(async (reason: string) => {
    const engine = ptyTransitionEngine;
    const seq = ++sessionActionProbeSeqRef.current;
    if (!engine || !tabId) {
      setSessionActionBlockedStatusIfChanged(null, reason + ':no-engine');
      setCodexForkProof(null);
      return;
    }
    try {
      const presence = await getHistoryAgentRuntime(engine).getPresence(tabId, projectId);
      if (seq !== sessionActionProbeSeqRef.current) return;
      if (engine === 'codex') {
        const snapshot = presence.runtimeSnapshot;
        setCodexForkProof({
          tabId,
          ready: isCodexRuntimeForkReady(snapshot),
          probeFailed: false,
        });
      } else {
        setCodexForkProof(null);
      }
      const next: SessionActionBlockedStatus =
        presence.status === 'starting' || presence.status === 'stopping'
          ? presence.status
          : null;
      setSessionActionBlockedStatusIfChanged(next, reason + ':' + presence.status);
    } catch (e: any) {
      if (seq !== sessionActionProbeSeqRef.current) return;
      if (engine === 'codex') {
        setCodexForkProof({ tabId, ready: false, probeFailed: true });
      }
      console.warn('[SessionActionChip] presence failed tab=' + tabId.slice(-12) + ' type=' + (engine || '-') + ' reason=' + reason + ' error=' + String(e?.message || e));
    }
  }, [projectId, ptyTransitionEngine, setSessionActionBlockedStatusIfChanged, tabId]);
  const setLocalBusy = (busy: boolean, reason: string) => {
    console.log('[ControlBarLoader] local-set tab=' + tabId.slice(-12) + ' type=' + sessionType + ' reason=' + reason + ' busy=' + busy + ' paste=' + isPasteBusy + ' local=' + isLocalBusy + ' commandRunning=' + isCommandRunning + ' turnBusy=' + codexTurnBusy + ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none'));
    localBusyReasonRef.current = busy ? reason : null;
    setIsLocalBusy(busy);
  };
  const beginControlAction = (reason: string) => {
    const existing = controlActionInFlightRef.current;
    if (existing || isBusy) {
      console.warn('[ControlBarAction] blocked tab=' + tabId.slice(-12) + ' type=' + sessionType + ' reason=' + reason + ' existing=' + (existing || 'none') + ' busy=' + isBusy);
      return false;
    }
    controlActionInFlightRef.current = reason;
    console.log('[ControlBarAction] begin tab=' + tabId.slice(-12) + ' type=' + sessionType + ' reason=' + reason);
    return true;
  };
  const endControlAction = (reason: string) => {
    const existing = controlActionInFlightRef.current;
    if (existing === reason) controlActionInFlightRef.current = null;
    else if (existing) console.warn('[ControlBarAction] end-mismatch tab=' + tabId.slice(-12) + ' reason=' + reason + ' existing=' + existing);
    console.log('[ControlBarAction] end tab=' + tabId.slice(-12) + ' type=' + sessionType + ' reason=' + reason);
  };
  const beginSessionLifecycleAction = (reason: string) => {
    if (!beginControlAction(reason)) return false;
    setLocalBusy(true, reason);
    return true;
  };
  const clearSessionLifecycleAction = (reason: string) => {
    setLocalBusy(false, reason);
    endControlAction(reason.replace(/:clear$/, ''));
  };
  useEffect(() => {
    if (!ptyTransitionEngine) {
      sessionActionProbeSeqRef.current += 1;
      setSessionActionBlockedStatusIfChanged(null, 'bind:no-engine');
      setCodexForkProof(null);
      return;
    }
    void refreshSessionActionBlockedStatus('bind');
  }, [ptyTransitionEngine, refreshSessionActionBlockedStatus, setSessionActionBlockedStatusIfChanged]);

  useEffect(() => {
    if (!ptyTransitionEngine) return;
    const eventBelongsHere = (eventTabId?: string, eventType?: string | null) => {
      if (eventTabId !== tabId) return false;
      return !eventType || eventType === ptyTransitionEngine;
    };
    const onCommandStarted = (_: any, data: { tabId?: string; commandType?: string | null }) => {
      if (!eventBelongsHere(data?.tabId, data?.commandType || null)) return;
      if (ptyTransitionEngine === 'codex') setCodexForkProof({ tabId, ready: false });
      setSessionActionBlockedStatusIfChanged('starting', 'command-started');
      void refreshSessionActionBlockedStatus('command-started');
    };
    const onCommandFinished = (_: any, data: { tabId?: string }) => {
      if (data?.tabId !== tabId) return;
      setSessionActionBlockedStatusIfChanged(null, 'command-finished');
      void refreshSessionActionBlockedStatus('command-finished');
    };
    const onClaudeReady = (_: any, data: { tabId?: string }) => {
      if (ptyTransitionEngine !== 'claude' || data?.tabId !== tabId) return;
      setSessionActionBlockedStatusIfChanged(null, 'claude-ready');
      void refreshSessionActionBlockedStatus('claude-ready');
    };
    const onCodexReady = (_: any, data: { tabId?: string }) => {
      if (ptyTransitionEngine !== 'codex' || data?.tabId !== tabId) return;
      setSessionActionBlockedStatusIfChanged(null, 'codex-ready');
      void refreshSessionActionBlockedStatus('codex-ready');
    };
    const onAgentBusy = (_: any, data: { tabId?: string; busy?: boolean }) => {
      if (data?.tabId !== tabId || data?.busy !== true) return;
      setSessionActionBlockedStatusIfChanged(null, ptyTransitionEngine + '-busy');
      if (ptyTransitionEngine === 'codex') {
        void refreshSessionActionBlockedStatus('codex-busy');
      }
    };
    const onCodexSessionDetected = (_: any, data: { tabId?: string }) => {
      if (ptyTransitionEngine !== 'codex' || data?.tabId !== tabId) return;
      void refreshSessionActionBlockedStatus('codex-session-detected');
    };
    // Writer re-proof with the SAME session id (proof invalidated by a
    // process-unknown outage, then re-proven) never emits session-detected.
    // Without this wire the fork gate stays ready=false until a manual
    // spinner click — the confirmed "infinite fork loader" path.
    const onCodexWriterReproven = (_: any, data: { tabId?: string; engine?: string; writerProven?: boolean }) => {
      if (ptyTransitionEngine !== 'codex' || data?.tabId !== tabId) return;
      if (data?.engine !== 'codex' || data?.writerProven !== true) return;
      void refreshSessionActionBlockedStatus('codex-writer-reproven');
    };
    const onCodexNotReady = (_: any, data: { tabId?: string; reason?: string | null }) => {
      if (ptyTransitionEngine !== 'codex' || data?.tabId !== tabId) return;
      void refreshSessionActionBlockedStatus('codex-not-ready:' + (data.reason || '-'));
    };
    const onCodexManualAction = (_: any, data: { tabId?: string }) => {
      if (ptyTransitionEngine !== 'codex' || data?.tabId !== tabId) return;
      void refreshSessionActionBlockedStatus('codex-manual-action');
    };
    const onAgentStopping = (_: any, data: { tabId?: string; toolType?: string | null; stopping?: boolean }) => {
      if (!eventBelongsHere(data?.tabId, data?.toolType || null)) return;
      if (data?.stopping) {
        setSessionActionBlockedStatusIfChanged('stopping', 'agent-stopping');
      } else {
        void refreshSessionActionBlockedStatus('agent-stopping-clear');
      }
    };
    ipcRenderer.on('terminal:command-started', onCommandStarted);
    ipcRenderer.on('terminal:command-finished', onCommandFinished);
    ipcRenderer.on('claude:tui-ready', onClaudeReady);
    ipcRenderer.on('codex:tui-ready', onCodexReady);
    ipcRenderer.on('claude:busy-state', onAgentBusy);
    ipcRenderer.on('codex:busy-state', onAgentBusy);
    ipcRenderer.on('codex:session-detected', onCodexSessionDetected);
    ipcRenderer.on('terminal:mcp-ai-tab', onCodexWriterReproven);
    ipcRenderer.on('codex:tui-not-ready', onCodexNotReady);
    ipcRenderer.on('codex:tui-manual-action-required', onCodexManualAction);
    ipcRenderer.on('agent:stopping-state', onAgentStopping);
    return () => {
      ipcRenderer.removeListener('terminal:command-started', onCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', onCommandFinished);
      ipcRenderer.removeListener('claude:tui-ready', onClaudeReady);
      ipcRenderer.removeListener('codex:tui-ready', onCodexReady);
      ipcRenderer.removeListener('claude:busy-state', onAgentBusy);
      ipcRenderer.removeListener('codex:busy-state', onAgentBusy);
      ipcRenderer.removeListener('codex:session-detected', onCodexSessionDetected);
      ipcRenderer.removeListener('terminal:mcp-ai-tab', onCodexWriterReproven);
      ipcRenderer.removeListener('codex:tui-not-ready', onCodexNotReady);
      ipcRenderer.removeListener('codex:tui-manual-action-required', onCodexManualAction);
      ipcRenderer.removeListener('agent:stopping-state', onAgentStopping);
    };
  }, [ptyTransitionEngine, refreshSessionActionBlockedStatus, setSessionActionBlockedStatusIfChanged, tabId]);
  useEffect(() => {
    busySnapshotRef.current = { paste: isPasteBusy, local: isLocalBusy };
    console.log('[ControlBarLoader] state tab=' + tabId.slice(-12) + ' type=' + sessionType + ' paste=' + isPasteBusy + ' local=' + isLocalBusy + ' busy=' + isBusy + ' commandRunning=' + isCommandRunning + ' turnBusy=' + codexTurnBusy + ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none'));
  }, [tabId, sessionType, isPasteBusy, isLocalBusy, isBusy, isCommandRunning, codexTurnBusy, sessionId]);
  // CRITICAL: this component is mounted WITHOUT a `key` (Workspace.tsx) so React
  // REUSES the same instance across tab switches — only the `tabId` prop changes,
  // the instance never remounts. Therefore `useState` busy flags do NOT reset on
  // their own when the user switches tabs. Two prod bugs come straight out of that
  // (session ea2ae02c / tab-283, 2026-06-03 ~22:07 MSK):
  //   • LEAK: busy=true captured for tab A still shows the shimmer when the user
  //     switches to tab B (state carried over).
  //   • STUCK FOREVER: the matching emitBusy(false) for tab A is broadcast with
  //     {tabId: A}, but by the time it lands the listener below filters on the
  //     NEW tabId (B) → A≠B → the false is DROPPED → loader never clears, even
  //     after the user reloads the tab or kills the Claude process.
  // Fix: on every tabId change, hard-reset both flags so a freshly-bound tab
  // starts clean; the live listener then reflects only THIS tab's paste state.
  // Also clear on the process/readiness lifecycle edges (fresh spawn, TUI ready,
  // process death) — once the agent input is ready, a Start/Continue action is
  // complete even though the long-lived agent process keeps running. Waiting only
  // for command-finished left Codex Start/Continue stuck on the right-cluster
  // shimmer until manual reset. This is what makes "я убил процесс клода, а
  // лоудер не сбросился" recover. See
  // fact-claude-control-bar.md::Busy-state tab binding.
  useEffect(() => {
    // Reset synchronously on bind to a new tab — never inherit the previous
    // tab's busy state.
    console.log('[ControlBarLoader] bind-reset tab=' + tabId.slice(-12) + ' type=' + sessionType + ' paste=' + isPasteBusy + ' local=' + isLocalBusy + ' commandRunning=' + isCommandRunning + ' turnBusy=' + codexTurnBusy + ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none'));
    busySnapshotRef.current = { paste: false, local: false };
    localBusyReasonRef.current = null;
    controlActionInFlightRef.current = null;
    setIsPasteBusy(false);
    setIsLocalBusy(false);
    const handler = (_: any, data: { tabId: string; busy: boolean }) => {
      const match = data.tabId === tabId;
      const before = busySnapshotRef.current;
      console.log('[ControlBarLoader] paste-event active=' + tabId.slice(-12) + ' event=' + String(data.tabId || '').slice(-12) + ' match=' + match + ' busy=' + data.busy + ' beforePaste=' + before.paste + ' beforeLocal=' + before.local);
      if (match) setIsPasteBusy(data.busy);
    };
    const isSessionLifecycleLocalBusy = () => {
      const reason = localBusyReasonRef.current || controlActionInFlightRef.current || '';
      return reason.startsWith('session-start:') || reason.startsWith('session-continue:');
    };
    const clearOnLifecycle = (
      reason: string,
      options: { onlySessionLifecycle?: boolean } = {},
    ) => (_: any, data: { tabId: string }) => {
      const match = data.tabId === tabId;
      const before = busySnapshotRef.current;
      const localReason = localBusyReasonRef.current || 'none';
      console.log('[ControlBarLoader] lifecycle-clear active=' + tabId.slice(-12) + ' event=' + String(data.tabId || '').slice(-12) + ' match=' + match + ' reason=' + reason + ' beforePaste=' + before.paste + ' beforeLocal=' + before.local + ' localReason=' + localReason);
      if (match) {
        if (options.onlySessionLifecycle && !isSessionLifecycleLocalBusy()) {
          console.log('[ControlBarLoader] lifecycle-clear skipped active=' + tabId.slice(-12) + ' reason=' + reason + ' localReason=' + localReason + ' gate=session-lifecycle-only');
          return;
        }
        localBusyReasonRef.current = null;
        controlActionInFlightRef.current = null;
        setIsPasteBusy(false);
        setIsLocalBusy(false);
      }
    };
    ipcRenderer.on('claude:paste-busy', handler);
    const clearOnStarted = clearOnLifecycle('process-started');
    const clearOnClaudeReady = clearOnLifecycle('claude-tui-ready', { onlySessionLifecycle: true });
    const clearOnCodexReady = clearOnLifecycle('codex-tui-ready', { onlySessionLifecycle: true });
    const clearOnFinished = clearOnLifecycle('command-finished');
    ipcRenderer.on('claude:process-started', clearOnStarted);
    ipcRenderer.on('claude:tui-ready', clearOnClaudeReady);
    ipcRenderer.on('codex:tui-ready', clearOnCodexReady);
    ipcRenderer.on('terminal:command-finished', clearOnFinished);
    return () => {
      ipcRenderer.removeListener('claude:paste-busy', handler);
      ipcRenderer.removeListener('claude:process-started', clearOnStarted);
      ipcRenderer.removeListener('claude:tui-ready', clearOnClaudeReady);
      ipcRenderer.removeListener('codex:tui-ready', clearOnCodexReady);
      ipcRenderer.removeListener('terminal:command-finished', clearOnFinished);
    };
  }, [tabId]);

  // SDK busy mirror — для SDK таба нет OSC 133, isCommandRunning из Workspace
  // всегда false. Подписываемся на claude:busy-state (main.js forward'ит сюда
  // claude-sdk:busy-state через 10810). Используется чтобы SessionActionChip
  // правильно показывал Stop на hover'е во время живого SDK turn'а.
  const [sdkBusy, setSdkBusy] = useState(false);
  useEffect(() => {
    if (!isSDKTab) return;
    const handler = (_: any, data: { tabId: string; busy: boolean }) => {
      if (data.tabId === tabId) {
        setSdkBusy(data.busy);
        if (data.busy) setSdkStopping(false); // new turn started → clear the stopping cue
      }
    };
    ipcRenderer.on('claude:busy-state', handler);
    return () => { ipcRenderer.removeListener('claude:busy-state', handler); };
  }, [tabId, isSDKTab]);

  // Transient "останавливаю процесс…" cue while Edit/Repeat hard-kills the live
  // session before rewriting history. Fired by ClaudeSDKTab right before the
  // hard kill; auto-clears after 1.2s or as soon as the new turn goes busy.
  const [sdkStopping, setSdkStopping] = useState(false);
  useEffect(() => {
    if (!isSDKTab) return;
    const handler = (e: Event) => {
      const { tabId: t } = (e as CustomEvent).detail || {};
      if (t !== tabId) return;
      setSdkStopping(true);
      setTimeout(() => setSdkStopping(false), 1200);
    };
    window.addEventListener('claude-sdk:stopping', handler);
    return () => window.removeEventListener('claude-sdk:stopping', handler);
  }, [tabId, isSDKTab]);

  const focusTerminal = () => {
    terminalRegistry.get(tabId)?.focus();
    requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());
  };

  const describeActiveElement = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return 'none';
    const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.')
      : '';
    return tag + cls;
  };

  const updateCodexState = (state: {
    codexModel?: string;
    codexEffort?: string;
    codexSettingsProofSessionId?: string;
  }) => {
    useWorkspaceStore.getState().updateCodexState(tabId, state);
  };
  const applyCodexPickerResult = (
    result: any,
    requestedModel: string,
    requestedEffort: string,
  ) => {
    const plan = planCodexPickerStateApplication({
      result,
      requestedModel,
      requestedEffort,
      liveSessionId: result?.codexSettingsProofSessionId || codexSessionId,
      currentPersistentModel: codexTabModel,
      currentPersistentEffort: codexTabEffort,
    });
    if (!plan.allowed) return plan;
    const state = useWorkspaceStore.getState();
    if (Object.keys(plan.persistentPatch || {}).length > 0) {
      state.updateCodexState(tabId, plan.persistentPatch);
    }
    state.updateCodexLiveState(tabId, plan.livePatch);
    return plan;
  };
  const rejectCodexLivePickerWithoutStateChange = (
    state: { codexModel?: string; codexEffort?: string },
    reason: string,
  ) => {
    console.warn('[CodexControlBar] live picker rejected tab=' + tabId.slice(-12) + ' reason=' + reason + ' requestedState=' + JSON.stringify(state) + ' currentState=' + JSON.stringify({ codexModel, codexEffort }) + ' commandRunning=' + isCommandRunning + ' turnBusy=' + codexTurnBusy + ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none'));
    focusTerminal();
  };
  const codexRunPayload = (base: { tabId: string; command: string; sessionId?: string; cwd?: string }) => {
    const payload: { tabId: string; command: string; sessionId?: string; cwd?: string; model?: string; effort?: string } = { ...base };
    return buildCodexRunPayload(payload);
  };
  const runCodexCommand = async (
    base: { tabId: string; command: string; sessionId?: string; cwd?: string },
  ) => {
    const payload = codexRunPayload(base);
    const result = await ipcRenderer.invoke('codex:run-command', payload);
    // Fresh launch consumes the requested tab/global pair. Continue/Fork do
    // not: main resolves their exact model+effort from the source rollout and
    // publishes that pair later with writer ownership proof. Persisting this
    // renderer payload for codex-c/codex-f creates a false state window and can
    // survive a crash before the authoritative writer event repairs it.
    const applied = planCodexLaunchSettingsPersistence({
      command: base.command,
      result,
      payload,
    });
    if (applied) updateCodexState(applied);
    return result;
  };

  // ===== derived state =====
  const activeProvider = useMemo(
    () => PROVIDER_CATALOG.find(p => p.id === providerState.type) || PROVIDER_CATALOG[0],
    [providerState.type]
  );
  const isAnthropicPTY = !isSDKTab && providerState.type === 'anthropic';
  const isDeepSeekPTY = !isSDKTab && providerState.type === 'deepseek';
  const supportsKnobs = isSDKTab || isAnthropicPTY || isDeepSeekPTY || isCodex;
  // Codex permits `/model` while it streams. The native picker changes the
  // session setting for subsequent work; the response already in flight keeps
  // its original params. Effort uses the same native picker path, so it follows
  // the same availability contract as Model.
  const codexEffectiveSettingsKnown = (
    !!codexTabModel
    && !!codexTabEffort
    && !!codexSessionId
    && codexSettingsProofSessionId === codexSessionId
  ) || (
      effectiveCodexSettings.liveOwned
      && !!effectiveCodexSettings.model
      && !!effectiveCodexSettings.effort
    );
  const codexControlAvailability = planCodexSettingsControlAvailability({
    isCodex,
    isCommandRunning,
    effectiveSettingsKnown: codexEffectiveSettingsKnown,
  });
  const codexModelMenuDisabled = codexControlAvailability.modelMenuDisabled;
  const codexModelDisabled = codexControlAvailability.partialSettingDisabled;
  const codexEffortDisabled = codexControlAvailability.partialSettingDisabled;
  const codexExplicitPairDisabled = codexControlAvailability.explicitPairDisabled;
  const codexQuickDisabled = codexControlAvailability.quickDisabled;
  const claudeQuickDisabled = !isSDKTab && (!isAnthropicPTY || !isCommandRunning);
  const codexFastDisabled = isCodex && !isCommandRunning;

  // Cache cooldown chip: Claude only (Anthropic PTY or SDK). DeepSeek/Zen have
  // no prompt cache, so the chip is meaningless there — hide entirely. Also
  // needs at least one cache-bearing turn captured this session.
  const showCacheChip = !isCodex && (isSDKTab || isAnthropicPTY) && cacheData != null;
  const showRightCluster = supportsKnobs && (isSDKTab || hasAnySession || isCommandRunning);
  const isPrimaryHistoryAgent = historyIsPrimary
    && (sessionType === 'claude' || sessionType === 'codex')
    && !isSDKTab;
  const showLivePtyInputActions = (sessionType === 'claude' || sessionType === 'codex')
    && !isSDKTab
    && isCommandRunning;
  // Primary History owns authoring even while its CLI process is stopped. Keep
  // Mic/Enter visible so the lower bar does not change shape across
  // Start/Resume; History itself remains the authority for whether a submit is
  // currently accepted. Legacy terminal tabs retain the old live-PTY guard.
  const showComposerInputActions = isPrimaryHistoryAgent || showLivePtyInputActions;
  const [enterPending, setEnterPending] = useState(false);
  const cancelPendingEnterRef = useRef(false);
  const dictationSnapshot = useDictationSnapshot();
  const dictationState = dictationSnapshot.owner?.tabId === tabId
    ? { recording: dictationSnapshot.recording, stopping: dictationSnapshot.stopping }
    : { recording: false, stopping: false };
  const historySubmitButtonEnabled = historyCanSend
    || (
      historyCanAcceptSubmitIntent
      && (dictationState.recording || dictationState.stopping)
    );
  // Turn-level busy, NOT process-level. `sdkBusy` is fed by claude:busy-state,
  // which main emits for BOTH SDK and PTY Claude (spinner + stop-hook), filtered
  // by tabId — so it goes false between turns on both. Using isCommandRunning
  // here was the PTY bug: it tracks the Claude PROCESS lifetime (OSC 133 B→D),
  // so it stayed true the whole session → the chip was frozen on the busy `●`
  // dot and never showed the "60м" countdown the SDK chip shows.
  const cacheBusy = sdkBusy;
  const sessionActionName = sessionType === 'codex' ? 'Codex' : sessionType === 'gemini' ? 'Gemini' : 'Claude';
  const sessionActionDisabled = !isSDKTab && (isBusy || sessionActionBlockedStatus != null);
  const sessionActionDisabledTitle = sessionActionBlockedStatus === 'starting'
    ? `${sessionActionName} запускается — дождитесь готовности терминала`
    : sessionActionBlockedStatus === 'stopping'
      ? `${sessionActionName} останавливается — дождитесь завершения`
      : isBusy
        ? 'Другое действие панели ещё выполняется'
        : undefined;

  useEffect(() => {
    cancelPendingEnterRef.current = false;
    setEnterPending(false);
  }, [tabId]);

  const activeCodexModel = codexModels.find(m => m.id === codexModel) || codexModels[0];
  const visibleCodexModels = useMemo(() => {
    const visible = codexModels.filter((model) => model.visible !== false);
    // Keep the control usable if every row was unchecked in Settings. The
    // currently active model remains as the only escape route back to Settings.
    return visible.length > 0 ? visible : codexModels.filter((model) => model.id === codexModel);
  }, [codexModel, codexModels]);
  const quickCodexModel = codexModels.find((model) => model.id === codexSettings.quickModel)
    || codexSettings.models.find((model) => model.id === codexSettings.quickModel);
  const quickCodexEffort = quickCodexModel
    ? resolveCodexEffortForModel(quickCodexModel, codexSettings.quickEffort)
    : null;
  const hasQuickCodexPreset = !!quickCodexModel && !!quickCodexEffort;
  const quickCodexMatchesCurrent = hasQuickCodexPreset
    && codexModel === quickCodexModel!.id
    && codexEffort === quickCodexEffort;
  const claudeCodeModels = claudeCodeSettings.models;

  // Model active id
  const lm = claudeModel?.toLowerCase() || '';
  const modelActiveId: string = (() => {
    if (isCodex) return codexModel;
    if (isSDKTab) return sdkModel || 'default';
    if (isAnthropicPTY) {
      if (lm.includes('1m context')) return 'default';
      const dynamic = claudeCodeModels.find((m) => {
        if (m.id === 'default') return false;
        const id = m.id.toLowerCase();
        const label = m.label.toLowerCase();
        return (id && lm.includes(id)) || (label && lm.includes(label));
      });
      if (dynamic) return dynamic.id;
      return 'default';
    }
    return providerState.model || activeProvider.models[0]?.id || '';
  })();

  const activeClaudeModel = claudeCodeModels.find((model) => model.id === modelActiveId)
    || claudeCodeModels[0];
  const visibleClaudeModels = useMemo(() => {
    const visible = claudeCodeModels.filter((model) => model.visible !== false);
    // A hidden current model must remain an escape route back to Settings when
    // every row has been unchecked, mirroring the Codex picker behaviour.
    return visible.length > 0 ? visible : claudeCodeModels.filter((model) => model.id === modelActiveId);
  }, [claudeCodeModels, modelActiveId]);
  const effortLevels = isCodex
    ? (activeCodexModel?.efforts && activeCodexModel.efforts.length > 0 ? activeCodexModel.efforts : [...CODEX_EFFORT_LEVELS])
    : isDeepSeekPTY ? DEEPSEEK_EFFORT_LEVELS : claudeEffortsForModel(activeClaudeModel);

  const effortActive: string | undefined = (() => {
    if (isCodex) return codexEffort;
    if (isSDKTab) return sdkEffort;
    if (isDeepSeekPTY) return providerState.effort || 'medium';
    return effortLocal;
  })();

  const quickClaudeModel = claudeCodeModels.find((model) => model.id === claudeCodeSettings.quickModel);
  const quickClaudeEffort = quickClaudeModel
    ? resolveClaudeEffortForModel(quickClaudeModel, claudeCodeSettings.quickEffort)
    : null;
  const hasQuickClaudePreset = !!quickClaudeModel && !!quickClaudeEffort;
  const quickClaudeMatchesCurrent = hasQuickClaudePreset
    && modelActiveId === quickClaudeModel!.id
    && effortActive === quickClaudeEffort;

  const thinkActive: boolean = (() => {
    if (isCodex) return true;
    if (isSDKTab) return sdkThinking;
    return thinkLocal ?? true;
  })();

  const clearQuickCodexToggle = () => {
    quickCodexReturnRef.current = null;
    setQuickCodexApplied(false);
  };

  const clearQuickClaudeToggle = () => {
    quickClaudeReturnRef.current = null;
    setQuickClaudeApplied(false);
  };

  useEffect(() => {
    clearQuickClaudeToggle();
  }, [
    tabId,
    claudeSessionId,
    claudeCodeSettings.quickModel,
    quickClaudeEffort,
  ]);

  useEffect(() => {
    if (quickClaudeApplied && (!hasQuickClaudePreset || !quickClaudeMatchesCurrent)) {
      clearQuickClaudeToggle();
    }
  }, [hasQuickClaudePreset, quickClaudeApplied, quickClaudeMatchesCurrent]);

  useEffect(() => {
    clearQuickCodexToggle();
  }, [
    tabId,
    sessionId,
    codexEffectiveProofSessionId,
    codexSettings.quickModel,
    quickCodexEffort,
  ]);

  useEffect(() => {
    if (quickCodexApplied && (!hasQuickCodexPreset || !quickCodexMatchesCurrent)) {
      clearQuickCodexToggle();
    }
  }, [hasQuickCodexPreset, quickCodexApplied, quickCodexMatchesCurrent]);

  // ===== popup state =====
  // Hover opens a temporary menu. Click upgrades it to a pinned state with an
  // explicit white frame; click-outside and Escape are the dismissal paths.
  type PopupKey = 'provider' | 'model' | 'effort';
  const [pinnedPopup, setPinnedPopup] = useState<PopupKey | null>(null);
  const [hoveredTrigger, setHoveredTrigger] = useState<PopupKey | null>(null);
  const [hoveredPopup, setHoveredPopup] = useState<PopupKey | null>(null);
  const [hoveredModelMenuModel, setHoveredModelMenuModel] = useState<string | null>(null);
  const [hoveredModelMenuAnchor, setHoveredModelMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const isCmdPressed = useCmdKey();
  const showSessionIdTooltip = isCmdPressed && sessionCopyHover && hasArtifactSession && !!sessionCopyRect;
  // The selected agent type is promoted from the live agent process.  Keep one
  // quick-switch affordance: an untouched Anthropic provider default must not
  // create a second Claude button while the same PTY is running Codex.
  const quickPresetIsCodex = isCodex;
  const isClaudeQuickSession = isSDKTab || (sessionType === 'claude' && isAnthropicPTY);
  const showQuickPresetControl = quickPresetIsCodex || isClaudeQuickSession;
  const quickPresetModel = quickPresetIsCodex ? quickCodexModel : quickClaudeModel;
  const quickPresetEffort = quickPresetIsCodex ? quickCodexEffort : quickClaudeEffort;
  const hasQuickPreset = quickPresetIsCodex ? hasQuickCodexPreset : hasQuickClaudePreset;
  const quickPresetApplied = quickPresetIsCodex ? quickCodexApplied : quickClaudeApplied;
  const quickPresetMatchesCurrent = quickPresetIsCodex ? quickCodexMatchesCurrent : quickClaudeMatchesCurrent;
  const quickPresetDisabled = quickPresetIsCodex ? codexQuickDisabled : claudeQuickDisabled;
  const showQuickPresetTooltip = showQuickPresetControl
    && isCmdPressed && quickPresetHover && hasQuickPreset && !!quickPresetRect;

  useEffect(() => {
    if (!codexModelMenuDisabled) return;
    setPinnedPopup(null);
    setHoveredTrigger(null);
    setHoveredPopup(null);
    setHoveredModelMenuModel(null);
    setHoveredModelMenuAnchor(null);
  }, [codexModelMenuDisabled]);

  // Derived: какой popup сейчас визуально открыт.
  const openPopup: PopupKey | null =
    pinnedPopup
    ?? hoveredTrigger
    ?? hoveredPopup;

  const rootRef = useRef<HTMLDivElement>(null);
  // Refs на каждый trigger + popup для geometric bridge (mousemove hit-test).
  const triggerRefs = useRef<Record<PopupKey, HTMLButtonElement | null>>({ provider: null, model: null, effort: null });
  const popupRefs = useRef<Record<PopupKey, HTMLDivElement | null>>({ provider: null, model: null, effort: null });
  const modelEffortPopupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (openPopup === 'model') return;
    setHoveredModelMenuModel(null);
    setHoveredModelMenuAnchor(null);
  }, [openPopup]);

  // Click-outside закрывает только pinned popup (CMD-hover закрывается по
  // отпусканию CMD сам).
  useEffect(() => {
    if (!pinnedPopup) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inRoot = !!rootRef.current?.contains(target);
      const inPopup = !!popupRefs.current[pinnedPopup]?.contains(target);
      const inModelEffortPopup = pinnedPopup === 'model' && !!modelEffortPopupRef.current?.contains(target);
      if (!inRoot && !inPopup && !inModelEffortPopup) setPinnedPopup(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pinnedPopup]);

  useEffect(() => {
    if (!pinnedPopup) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPinnedPopup(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pinnedPopup]);

  // Geometric bridge: пока popup открыт, mousemove пересчитывает hoveredTrigger
  // и hoveredPopup по реальным координатам курсора. Это покрывает 4px-зазор
  // между chip и popup'ом — иначе CMD-hover popup схлопывается, когда курсор
  // едет к нему через gap (см. `methodology/design-bugs.md::1.2 Hover-bridge`).
  useEffect(() => {
    if (!openPopup) return;
    const onMove = (e: MouseEvent) => {
      const { clientX: x, clientY: y } = e;
      let newTrigger: PopupKey | null = null;
      let newPopup: PopupKey | null = null;
      (['provider', 'model', 'effort'] as PopupKey[]).forEach((key) => {
        const t = triggerRefs.current[key]?.getBoundingClientRect();
        const p = popupRefs.current[key]?.getBoundingClientRect();
        const secondary = key === 'model' ? modelEffortPopupRef.current?.getBoundingClientRect() : null;
        if (t && x >= t.left && x <= t.right && y >= t.top && y <= t.bottom) {
          newTrigger = key;
        }
        if (p && x >= p.left && x <= p.right && y >= p.top && y <= p.bottom) {
          newPopup = key;
        }
        if (secondary && x >= secondary.left && x <= secondary.right && y >= secondary.top && y <= secondary.bottom) {
          newPopup = key;
        }
        // Bridge corridor: popup is ABOVE trigger, корридор между нижним краем
        // popup'а и верхним краем trigger'а (горизонтально по объединению).
        if (t && p) {
          const inBridge =
            x >= Math.min(p.left, t.left) - 8 &&
            x <= Math.max(p.right, t.right) + 8 &&
            y >= p.bottom &&
            y <= t.top;
          if (inBridge) newPopup = key;
        }
      });
      setHoveredTrigger(newTrigger);
      setHoveredPopup(newPopup);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [openPopup]);

  // A click pins the menu. Repeating it leaves the pin intact; click-outside is
  // the single mouse gesture for dismissing a pinned menu.
  const togglePinned = (key: PopupKey) => {
    setPinnedPopup(key);
  };

  const triggerProps = (key: PopupKey) => ({
    ref: (el: HTMLButtonElement | null) => { triggerRefs.current[key] = el; },
    onClick: () => togglePinned(key),
    onMouseEnter: () => setHoveredTrigger(key),
    onMouseLeave: () => setHoveredTrigger((cur) => (cur === key ? null : cur)),
  });

  const popupHoverProps = (key: PopupKey) => ({
    ref: (el: HTMLDivElement | null) => { popupRefs.current[key] = el; },
    onMouseEnter: () => setHoveredPopup(key),
    onMouseLeave: (event: React.MouseEvent<HTMLDivElement>) => {
      const related = event.relatedTarget;
      if (
        key === 'model'
        && related instanceof Node
        && modelEffortPopupRef.current?.contains(related)
      ) {
        setHoveredPopup('model');
        return;
      }
      setHoveredPopup((cur) => (cur === key ? null : cur));
      if (key === 'model') {
        setHoveredModelMenuModel(null);
        setHoveredModelMenuAnchor(null);
      }
    },
  });

  const syncCodexPickerOptions = (result: any) => {
    const options = Array.isArray(result?.modelOptions)
      ? result.modelOptions
        .map((value: unknown) => String(value || '').trim())
        .filter((value: string, index: number, all: string[]) => (
          !!value
          && value !== 'all-models'
          && all.indexOf(value) === index
        ))
      : [];
    const selectedModel = typeof result?.model === 'string' ? result.model : null;
    const selectedEfforts = Array.isArray(result?.effortOptions) && result.effortOptions.length > 0
      ? result.effortOptions
        .map((value: unknown) => String(value || '').trim())
        .filter((value: string, index: number, all: string[]) => (
          !!value
          && value !== 'more-reasoning'
          && all.indexOf(value) === index
        ))
      : null;
    const confirmedSelectedEfforts = selectedEfforts
      || (
        typeof result?.effort === 'string' && result.effort.trim()
          ? [result.effort.trim()]
          : []
      );

    // A native picker frame is only a window into the account catalog:
    // `/model` initially shows quick auto presets, while specific models live
    // under "All models" and Max/Ultra under "More reasoning…". Never replace
    // the full catalog with whichever partial popup happened to be visible.
    setCodexModels((prev) => {
      const merged = [...prev];
      for (const id of options) {
        if (!merged.some((model) => model.id === id)) {
          // A row in one session's top picker proves only that this session
          // can see the preset. It does not prove the preset's default or its
          // complete effort matrix. Add an unknown row only when this exact
          // model+effort pair was already confirmed by the native picker.
          if (id !== selectedModel || confirmedSelectedEfforts.length === 0) {
            continue;
          }
          merged.push({
            id,
            label: id,
            defaultEffort: confirmedSelectedEfforts[0],
            efforts: [...confirmedSelectedEfforts],
          });
        }
      }

      if (!selectedModel || !selectedEfforts) return merged;
      const selectedIndex = merged.findIndex((model) => model.id === selectedModel);
      if (selectedIndex < 0) return merged;
      const knownEfforts = merged[selectedIndex].efforts || [];
      const observed = new Set([...knownEfforts, ...selectedEfforts]);
      const ordered = [
        ...CODEX_EFFORT_LEVELS.filter((level) => observed.has(level)),
        ...Array.from(observed).filter((level) => !CODEX_EFFORT_LEVELS.includes(level as any)),
      ];
      merged[selectedIndex] = { ...merged[selectedIndex], efforts: ordered };
      return merged;
    });

    // The native picker is session-local, while `codex debug models` is the
    // authoritative metadata source for labels/defaults/capabilities. Refresh
    // after a proven selection so a newly visible preset replaces the narrow
    // exact-pair placeholder as soon as the live catalog exposes it.
    void ipcRenderer.invoke('codex:list-models').then((res: any) => {
      if (!Array.isArray(res?.models) || res.models.length === 0) return;
      setCodexModels((prev) => mergeCodexModelOptions(res.models, prev, codexSettings.removedModelIds));
    }).catch(() => {});
  };

  const getCodexDraftStateForPicker = async () => {
    const visualState = terminalRegistry.getCodexDraftState(tabId);
    const probeDebug = visualState.debug
      ? ' debug=' + visualState.debug
      : '';
    console.warn('[CodexControlBar] draft visual-probe tab=' + tabId.slice(-12) + ' hasDraft=' + visualState.hasDraft + ' source=' + visualState.source + ' active=' + describeActiveElement() + ' preview=' + JSON.stringify(visualState.preview) + probeDebug);
    const resolved = await readCodexDraftAuthority({
      invoke: ipcRenderer.invoke.bind(ipcRenderer),
      tabId,
      reason: 'controlbar-picker-preflight',
      timeoutMs: 700,
      visualState,
    });
    console.warn('[CodexControlBar] draft authoritative-probe tab=' + tabId.slice(-12)
      + ' hasDraft=' + resolved.hasDraft
      + ' authority=' + resolved.authority
      + ' source=' + resolved.source
      + ' visual=' + resolved.visualHasDraft + ':' + resolved.visualSource
      + ' preview=' + JSON.stringify(resolved.preview)
      + (resolved.debug ? ' debug=' + resolved.debug : ''));
    return resolved;
  };

  const canOpenCodexPicker = (
    draftState: Awaited<ReturnType<typeof getCodexDraftStateForPicker>>,
    actionLabel = 'picker',
  ) => {
    if (draftState.hasDraft === false) return true;
    if (draftState.hasDraft === true) {
      console.warn('[CodexControlBar] ' + actionLabel + ' will stash composer draft tab=' + tabId.slice(-12) + ' source=' + draftState.source + ' preview=' + JSON.stringify(draftState.preview));
      return true;
    }
    console.warn('[CodexControlBar] ' + actionLabel + ' blocked because composer state is unknown tab=' + tabId.slice(-12) + ' source=' + draftState.source + ' preview=' + JSON.stringify(draftState.preview));
    return false;
  };

  // ===== handlers =====
  const setEffortOnPTY = async (
    level: string,
    source = 'controlbar:effort',
    sentinelVia = 'manual-click',
  ): Promise<boolean> => {
    // Mark this tab as "effort sent" so the tui-ready and Bridge:Fresh auto-inject
    // paths in Terminal.tsx see it and skip. Without this, the user's frustration
    // click while waiting for tui-ready would race the auto-inject and produce
    // two /effort lines (forensic: 2026-05 tab-2933 incident).
    const sentinelMap = (window as any).__effortSentForTab as Map<string, { at: number; via: string; level: string }> | undefined;
    const previousSentinel = sentinelMap?.get(tabId);
    if (sentinelMap) sentinelMap.set(tabId, { at: Date.now(), via: sentinelVia, level });
    console.warn('[EffortDiag2026-05][CONTROLBAR-CLICK] tab=' + tabId.slice(-12) + ' level=' + level + ' ts=' + Date.now());
    setLocalBusy(true, 'claude-effort:' + level);
    try {
      await applyClaudePtySetting({
        tabId,
        kind: 'effort',
        value: level,
        source,
      });
      setEffortLocal(level);
      return true;
    } catch (error: any) {
      if (sentinelMap) {
        if (previousSentinel) sentinelMap.set(tabId, previousSentinel);
        else sentinelMap.delete(tabId);
      }
      console.error('[ClaudeControlBar] effort change failed:', error);
      showToast('Claude не подтвердил effort: ' + String(error?.message || error), 'error');
      return false;
    } finally {
      setLocalBusy(false, 'claude-effort:' + level + ':finally');
      focusTerminal();
    }
  };

  const applyClaudeModelAndEffort = async (
    model: string,
    effort: string,
    source: 'quick' | 'pair',
  ): Promise<boolean> => {
    if (isSDKTab) {
      useWorkspaceStore.getState().updateSDKState(tabId, { sdkModel: model, sdkEffort: effort });
      focusTerminal();
      return true;
    }
    if (!isAnthropicPTY) return false;

    const actionReason = `claude-${source}:${model}/${effort}`;
    const sentinelVia = source === 'quick' ? 'quick-preset' : 'model-effort';
    const modelSentinelMap = (window as any).__modelSentForTab as Map<string, { at: number; via: string; model: string }> | undefined;
    const effortSentinelMap = (window as any).__effortSentForTab as Map<string, { at: number; via: string; level: string }> | undefined;
    const previousModelSentinel = modelSentinelMap?.get(tabId);
    const previousEffortSentinel = effortSentinelMap?.get(tabId);
    if (modelSentinelMap) modelSentinelMap.set(tabId, { at: Date.now(), via: sentinelVia, model });
    if (effortSentinelMap) effortSentinelMap.set(tabId, { at: Date.now(), via: sentinelVia, level: effort });
    let modelApplied = false;
    setLocalBusy(true, actionReason);
    try {
      await applyClaudePtySetting({ tabId, kind: 'model', value: model, source: `controlbar:${source}-model` });
      modelApplied = true;
      setClaudeModel(model);
      await applyClaudePtySetting({ tabId, kind: 'effort', value: effort, source: `controlbar:${source}-effort` });
      setEffortLocal(effort);
      return true;
    } catch (error: any) {
      if (!modelApplied && modelSentinelMap) {
        if (previousModelSentinel) modelSentinelMap.set(tabId, previousModelSentinel);
        else modelSentinelMap.delete(tabId);
      }
      if (effortSentinelMap) {
        if (previousEffortSentinel) effortSentinelMap.set(tabId, previousEffortSentinel);
        else effortSentinelMap.delete(tabId);
      }
      console.error('[ClaudeControlBar] model/effort pair failed:', error);
      showToast(
        source === 'quick'
          ? 'Claude не подтвердил быстрый переход: ' + String(error?.message || error)
          : 'Claude не подтвердил выбранные model и effort: ' + String(error?.message || error),
        'error',
      );
      return false;
    } finally {
      setLocalBusy(false, actionReason + ':finally');
      focusTerminal();
    }
  };

  const setEffortOnDeepSeek = async (level: string) => {
    setLocalBusy(true, 'deepseek-effort:' + level);
    try {
      const r = await ipcRenderer.invoke('provider:set-options', { tabId, effort: level });
      if (r) setProviderState(r);
    } finally { setLocalBusy(false, 'deepseek-effort:' + level + ':finally'); focusTerminal(); }
  };

  const applyCodexModelAndEffort = async (
    model: string,
    effort: string,
    source: 'model' | 'effort' | 'pair' | 'quick',
  ) => {
    const requestedState = { codexModel: model, codexEffort: effort };
    if (!isCommandRunning) {
      if (effort === 'ultra') {
        useUIStore.getState().showToast(
          'Ultra применяется только к уже запущенной сессии Codex',
          'info',
          4500,
        );
        focusTerminal();
        return { success: false, model, effort: null };
      }
      updateCodexState(requestedState);
      focusTerminal();
      return { success: true, model, effort };
    }
    const writerPrecondition = planCodexPickerWriterPrecondition({
      source,
      currentProofSessionId: codexEffectiveProofSessionId,
    });
    if (!writerPrecondition.allowed) {
      rejectCodexLivePickerWithoutStateChange(
        requestedState,
        `settings-proof-owner-unknown:${source}`,
      );
      return { success: false, model, effort: null };
    }
    // Availability and action execution must use the same effective pair.
    // A live conversation can own a proven model+effort even when the legacy
    // persistent tab fields are empty (for example immediately after Resume).
    // The writer CAS above still prevents inheriting settings from another
    // rollout/session.
    if (source !== 'pair' && !codexEffectiveSettingsKnown) {
      rejectCodexLivePickerWithoutStateChange(
        requestedState,
        'effective-settings-unknown',
      );
      return { success: false, model, effort: null };
    }

    const busyReason = `codex-${source}:${model}/${effort}`;
    setLocalBusy(true, busyReason);
    try {
      const draftState = await getCodexDraftStateForPicker();
      if (!canOpenCodexPicker(draftState, source)) {
        rejectCodexLivePickerWithoutStateChange(requestedState, `unsafe-input:${source}:${draftState.source}`);
        return { success: false, model, effort: null };
      }
      const result = await ipcRenderer.invoke('codex:select-model-effort', {
        tabId,
        model,
        effort,
        expectedWriterSessionId: writerPrecondition.expectedWriterSessionId,
        // Native Codex explicitly supports changing the settings for subsequent
        // work while a response streams. External History/API sends use the
        // stricter idle-only boundary.
        allowTurnBusy: true,
        hasDraft: draftState.hasDraft,
        draftSource: draftState.source,
        draftPreview: draftState.preview,
        visualHasDraft: draftState.visualHasDraft,
        visualSource: draftState.visualSource,
        visualPreview: draftState.visualPreview,
      });
      console.log('[ControlBarLoader] codex-' + source + '-result tab=' + tabId.slice(-12) + ' model=' + model + ' effort=' + effort + ' result=' + JSON.stringify(result || null));
      if (!result?.success) {
        if (
          result?.applied === true
          && (result?.applicationProofSource || result?.configProofSource)
        ) {
          // The native picker already changed Codex and the saved config proves
          // the persistent value, or Codex emitted the dedicated Ultra
          // acknowledgement for this conversation. A later draft-restore
          // failure must not leave our controls claiming that the previous
          // model/effort is still active.
          syncCodexPickerOptions(result);
          const appliedPlan = applyCodexPickerResult(result, model, effort);
          if (!appliedPlan.allowed) {
            rejectCodexLivePickerWithoutStateChange(
              requestedState,
              `picker-proof-invalid:${source}:${appliedPlan.code}`,
            );
            return { success: false, model, effort: null };
          }
          useUIStore.getState().showToast(
            result.error || 'Codex settings changed, but the input text could not be restored',
            'error',
            6000,
          );
          return {
            success: false,
            applied: true,
            model: appliedPlan.model,
            effort: appliedPlan.effort,
          };
        }
        rejectCodexLivePickerWithoutStateChange(requestedState, `picker-failed:${source}:${result?.error || 'unknown'}`);
        return { success: false, model, effort: null };
      }
      syncCodexPickerOptions(result);
      const appliedPlan = applyCodexPickerResult(result, model, effort);
      if (!appliedPlan.allowed) {
        rejectCodexLivePickerWithoutStateChange(
          requestedState,
          `picker-proof-invalid:${source}:${appliedPlan.code}`,
        );
        return { success: false, model, effort: null };
      }
      return { success: true, model: appliedPlan.model, effort: appliedPlan.effort || null };
    } finally {
      setLocalBusy(false, busyReason + ':finally');
      focusTerminal();
    }
  };

  const pickModel = async (mid: string) => {
    setPinnedPopup(null); setHoveredTrigger(null); setHoveredPopup(null); setHoveredModelMenuModel(null);
    const actionReason = 'model:' + mid;
    if (!beginControlAction(actionReason)) return;
    try {
    if (isCodex) {
      const nextModel = codexModels.find((model) => model.id === mid);
      const supportedEfforts = nextModel?.efforts?.length
        ? nextModel.efforts
        : [...CODEX_EFFORT_LEVELS];
      const nextEffort = supportedEfforts.includes(codexEffort)
        ? codexEffort
        : null;
      if (!nextEffort) {
        useUIStore.getState().showToast(
          'Для этой модели выберите model и effort вместе в соседнем меню',
          'info',
          4000,
        );
        return;
      }
      const result = await applyCodexModelAndEffort(mid, nextEffort, 'model');
      if (result.success) clearQuickCodexToggle();
      return;
    }
    if (isSDKTab) {
      const nextModel = claudeCodeModels.find((model) => model.id === mid);
      const nextEffort = resolveClaudeEffortForModel(nextModel, sdkEffort);
      useWorkspaceStore.getState().updateSDKState(tabId, {
        sdkModel: mid,
        ...(nextEffort && nextEffort !== sdkEffort ? { sdkEffort: nextEffort } : {}),
      });
      if (nextEffort && nextEffort !== sdkEffort) {
        showToast(`Для ${nextModel?.label || mid} выбран совместимый effort: ${nextEffort}`, 'info');
      }
      focusTerminal();
      return;
    }
    if (activeProvider.id === 'anthropic') {
      const nextModel = claudeCodeModels.find((model) => model.id === mid);
      const nextEffort = effortLocal && !claudeEffortsForModel(nextModel).includes(effortLocal)
        ? resolveClaudeEffortForModel(nextModel, effortLocal)
        : null;
      setLocalBusy(true, 'claude-model:' + mid);
      const modelSentinelMap = (window as any).__modelSentForTab as Map<string, { at: number; via: string; model: string }> | undefined;
      const previousSentinel = modelSentinelMap?.get(tabId);
      if (modelSentinelMap) modelSentinelMap.set(tabId, { at: Date.now(), via: 'manual-click', model: mid });
      try {
        await applyClaudePtySetting({
          tabId,
          kind: 'model',
          value: mid,
          source: 'controlbar:model',
        });
        setClaudeModel(mid);
        if (nextEffort) {
          const effortApplied = await setEffortOnPTY(
            nextEffort,
            'controlbar:model-compatible-effort',
            'model-change',
          );
          if (effortApplied) {
            showToast(`Для ${nextModel?.label || mid} выбран совместимый effort: ${nextEffort}`, 'info');
          }
        }
      } catch (error: any) {
        if (modelSentinelMap) {
          if (previousSentinel) modelSentinelMap.set(tabId, previousSentinel);
          else modelSentinelMap.delete(tabId);
        }
        console.error('[ClaudeControlBar] model change failed:', error);
        showToast('Claude не подтвердил модель: ' + String(error?.message || error), 'error');
      } finally {
        setLocalBusy(false, 'claude-model:' + mid + ':finally');
        focusTerminal();
      }
    } else {
      setLocalBusy(true, 'provider-model:' + activeProvider.id + ':' + mid);
      providerMemoryRef.current[activeProvider.id] = mid;
      try {
        const r = await ipcRenderer.invoke('provider:switch', { tabId, type: activeProvider.id, model: mid });
        if (r) setProviderState(r);
      } finally { setLocalBusy(false, 'provider-model:' + activeProvider.id + ':' + mid + ':finally'); focusTerminal(); }
    }
    } finally {
      endControlAction(actionReason);
    }
  };

  const pickEffort = async (level: string) => {
    setPinnedPopup(null); setHoveredTrigger(null); setHoveredPopup(null); setHoveredModelMenuModel(null);
    const actionReason = 'effort:' + level;
    if (!beginControlAction(actionReason)) return;
    try {
    if (isCodex) {
      const result = await applyCodexModelAndEffort(codexModel, level, 'effort');
      if (result.success) clearQuickCodexToggle();
    } else if (isSDKTab) {
      useWorkspaceStore.getState().updateSDKState(tabId, { sdkEffort: level });
      focusTerminal();
    } else if (isDeepSeekPTY) {
      await setEffortOnDeepSeek(level);
    } else {
      await setEffortOnPTY(level);
    }
    } finally {
      endControlAction(actionReason);
    }
  };

  const pickClaudeModelEffort = async (model: string, effort: string) => {
    setPinnedPopup(null); setHoveredTrigger(null); setHoveredPopup(null); setHoveredModelMenuModel(null);
    const actionReason = `model-effort:${model}/${effort}`;
    if (!beginControlAction(actionReason)) return;
    try {
      const success = await applyClaudeModelAndEffort(model, effort, 'pair');
      if (success) clearQuickClaudeToggle();
    } finally {
      endControlAction(actionReason);
    }
  };

  const pickCodexModelEffort = async (model: string, effort: string) => {
    setPinnedPopup(null); setHoveredTrigger(null); setHoveredPopup(null); setHoveredModelMenuModel(null);
    const actionReason = `model-effort:${model}/${effort}`;
    if (!beginControlAction(actionReason)) return;
    try {
      const result = await applyCodexModelAndEffort(model, effort, 'pair');
      if (result.success) clearQuickCodexToggle();
    } finally {
      endControlAction(actionReason);
    }
  };

  const toggleQuickClaudePreset = async () => {
    if ((!isSDKTab && !isAnthropicPTY) || !quickClaudeModel || !quickClaudeEffort) return;

    const restore = quickClaudeApplied && quickClaudeMatchesCurrent
      ? quickClaudeReturnRef.current
      : null;
    if (!restore && quickClaudeMatchesCurrent) {
      clearQuickClaudeToggle();
      return;
    }

    const target = restore || { model: quickClaudeModel.id, effort: quickClaudeEffort };
    const actionReason = restore ? 'claude-quick-restore' : 'claude-quick-apply';
    if (!beginControlAction(actionReason)) return;
    try {
      const success = await applyClaudeModelAndEffort(target.model, target.effort, 'quick');
      if (!success) return;

      if (restore) {
        clearQuickClaudeToggle();
        return;
      }

      quickClaudeReturnRef.current = {
        model: modelActiveId,
        effort: effortActive || resolveClaudeEffortForModel(activeClaudeModel, 'medium') || quickClaudeEffort,
      };
      setQuickClaudeApplied(true);
    } finally {
      endControlAction(actionReason);
    }
  };

  const toggleQuickCodexPreset = async () => {
    if (!isCodex || !quickCodexModel || !quickCodexEffort) return;

    const restore = quickCodexApplied && quickCodexMatchesCurrent
      ? quickCodexReturnRef.current
      : null;
    if (!restore && quickCodexMatchesCurrent) {
      clearQuickCodexToggle();
      return;
    }

    const target = restore || { model: quickCodexModel.id, effort: quickCodexEffort };
    const actionReason = restore ? 'codex-quick-restore' : 'codex-quick-apply';
    if (!beginControlAction(actionReason)) return;
    try {
      const result = await applyCodexModelAndEffort(target.model, target.effort, 'quick');
      if (!result.success) return;

      if (restore) {
        clearQuickCodexToggle();
        return;
      }

      if (result.model === quickCodexModel.id && result.effort === quickCodexEffort) {
        quickCodexReturnRef.current = { model: codexModel, effort: codexEffort };
        setQuickCodexApplied(true);
      } else {
        clearQuickCodexToggle();
      }
    } finally {
      endControlAction(actionReason);
    }
  };

  const sendCodexFast = async () => {
    if (!isCodex) return;
    if (!isCommandRunning) {
      console.warn('[CodexControlBar] /fast skipped tab=' + tabId.slice(-12) + ' reason=no-live-process');
      focusTerminal();
      return;
    }
    const actionReason = 'codex-fast';
    if (!beginControlAction(actionReason)) return;
    setLocalBusy(true, actionReason);
    try {
      const draftState = await getCodexDraftStateForPicker();
      if (codexTurnBusy && draftState.hasDraft === true) {
        console.warn('[CodexControlBar] /fast skipped tab=' + tabId.slice(-12) + ' reason=busy-draft-unsafe source=' + draftState.source + ' preview=' + JSON.stringify(draftState.preview) + ' commandRunning=' + isCommandRunning + ' turnBusy=' + codexTurnBusy + ' session=' + (sessionId ? sessionId.slice(0, 8) : 'none'));
        return;
      }
      if (!canOpenCodexPicker(draftState, '/fast')) {
        console.warn('[CodexControlBar] /fast skipped tab=' + tabId.slice(-12) + ' reason=unsafe-input:' + draftState.source + ' preview=' + JSON.stringify(draftState.preview));
        return;
      }
      const result = await ipcRenderer.invoke('codex:send-live-slash-command', {
        tabId,
        command: '/fast',
        hasDraft: draftState.hasDraft,
        draftSource: draftState.source,
        draftPreview: draftState.preview,
        visualHasDraft: draftState.visualHasDraft,
        visualSource: draftState.visualSource,
        visualPreview: draftState.visualPreview,
        turnBusy: codexTurnBusy,
      });
      console.log('[CodexControlBar] /fast result tab=' + tabId.slice(-12) + ' result=' + JSON.stringify(result || null));
      if (result?.success === false) {
        if (result?.error === 'codex_busy_with_draft') {
          console.warn('[CodexControlBar] /fast skipped tab=' + tabId.slice(-12) + ' reason=busy-draft-at-write-boundary');
          return;
        }
        throw new Error(result?.error || 'Codex /fast failed');
      }
    } catch (e: any) {
      console.warn('[CodexControlBar] /fast failed tab=' + tabId.slice(-12) + ': ' + String(e?.message || e));
      showToast('Codex /fast failed: ' + String(e?.message || e), 'error');
    } finally {
      setLocalBusy(false, actionReason + ':finally');
      focusTerminal();
      endControlAction(actionReason);
    }
  };

  const pickProvider = async (pid: string) => {
    setPinnedPopup(null); setHoveredTrigger(null); setHoveredPopup(null);
    const actionReason = 'provider:' + pid;
    if (isSDKTab || !beginControlAction(actionReason)) return;
    setLocalBusy(true, 'provider:' + pid);
    try {
      if (pid === 'anthropic') {
        const r = await ipcRenderer.invoke('provider:switch', { tabId, type: 'anthropic' });
        if (r) setProviderState(r);
      } else {
        const remembered = providerMemoryRef.current[pid] || PROVIDER_CATALOG.find(p => p.id === pid)?.models[0]?.id;
        const r = await ipcRenderer.invoke('provider:switch', { tabId, type: pid, model: remembered });
        if (r) setProviderState(r);
      }
    } finally { setLocalBusy(false, 'provider:' + pid + ':finally'); focusTerminal(); endControlAction(actionReason); }
  };

  const toggleThink = async () => {
    const actionReason = 'think-toggle';
    if (!beginControlAction(actionReason)) return;
    if (isSDKTab) {
      const cur = sdkThinking;
      useWorkspaceStore.getState().updateSDKState(tabId, { sdkThinking: !cur });
      focusTerminal();
      endControlAction(actionReason);
      return;
    }
    setLocalBusy(true, 'think-toggle');
    const next = !thinkActive;
    setThinkLocal(next);
    // Mirror the resolved think state into the cross-client map so the mobile
    // ParamsSheet (which reads __thinkStateForTab via getSDKParams) shows the
    // same on/off the desktop just applied. Same pattern as __effortSentForTab.
    const thinkMap: Map<string, boolean> = (window as any).__thinkStateForTab
      || ((window as any).__thinkStateForTab = new Map());
    thinkMap.set(tabId, next);
    try {
      const r = await ipcRenderer.invoke('claude:toggle-thinking', tabId);
      if (r?.success && typeof r.thinking === 'boolean') { setThinkLocal(r.thinking); thinkMap.set(tabId, r.thinking); }
    } finally { setLocalBusy(false, 'think-toggle:finally'); focusTerminal(); endControlAction(actionReason); }
  };

  // ===== Session lifecycle handlers (Start / Continue / Stop / Refresh / Fork) =====

  // Spawn a fresh Claude (or Gemini) process in this tab. Used when there's
  // no session yet — replaces the old "click chip → copy empty id" no-op.
  // SDK tabs already have an in-app composer, so we just focus it instead.
  const onStart = async () => {
    if (!tabId) return;
    if (isSDKTab) {
      window.dispatchEvent(new CustomEvent('claude-sdk:focus-composer', { detail: { tabId } }));
      return;
    }
    const actionReason = 'session-start:' + sessionType;
    if (!beginSessionLifecycleAction(actionReason)) return;
    const store = useWorkspaceStore.getState();
    try {
      terminalRegistry.get(tabId)?.scrollToBottom();
      focusTerminal();
      if (sessionType === 'codex') {
        store.setTabCommandType(tabId, 'codex');
        store.markAiLaunchAutoTitle(tabId, 'codex');
        const runResult = await runCodexCommand({ tabId, command: 'codex', cwd: launchCwd });
        if (runResult?.success === false || runResult?.accepted === false) {
          clearSessionLifecycleAction(actionReason + ':launch-rejected');
        }
      } else if (sessionType === 'gemini') {
        store.setTabCommandType(tabId, 'gemini');
        ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd: launchCwd, yesMode: true });
      } else {
        store.setTabCommandType(tabId, 'claude');
        store.markAiLaunchAutoTitle(tabId, 'claude');
        const runResult = await ipcRenderer.invoke('claude:run-command', { tabId, command: 'claude' });
        if (runResult?.success === false) {
          clearSessionLifecycleAction(actionReason + ':launch-rejected');
        }
      }
    } catch (e) {
      clearSessionLifecycleAction(actionReason + ':clear');
      throw e;
    }
  };

  const onContinue = async () => {
    if (!tabId) return;
    if (isSDKTab) {
      window.dispatchEvent(new CustomEvent('claude-sdk:focus-composer', { detail: { tabId } }));
      return;
    }
    const codexContinueSessionId = sessionType === 'codex'
      ? await requireCodexActionSessionId('продолжить Codex-сессию')
      : null;
    if (sessionType === 'codex' && !codexContinueSessionId) return;
    const actionReason = 'session-continue:' + sessionType;
    if (!beginSessionLifecycleAction(actionReason)) return;
    const store = useWorkspaceStore.getState();
    try {
      if (sessionType === 'claude') {
        if (!(await ensureClaudeArtifactSession('continue-session'))) {
          clearSessionLifecycleAction(actionReason + ':clear');
          return;
        }
        store.setTabCommandType(tabId, 'claude');
        terminalRegistry.get(tabId)?.scrollToBottom();
        focusTerminal();
        window.dispatchEvent(new CustomEvent('timeline:scroll-to-bottom', { detail: { tabId } }));
        // Arm the 15s stale-bridge guard BEFORE writing resume — без этого протухший
        // ~/.claude/bridge/*.json (PID reuse) перезапишет sessionId таба на мёртвый
        // UUID в окне resume. Contract: любой путь, пишущий `claude --resume`, обязан
        // вызвать markPendingResume. См. fix-bridge-stale-takeover.md layer 4/5.
        if (claudeSessionId) markPendingResume(tabId, claudeSessionId);
        const runResult = await ipcRenderer.invoke('claude:run-command', { tabId, command: 'claude-c', sessionId: claudeSessionId });
        if (runResult?.success === false) {
          clearPendingResume(tabId);
          clearSessionLifecycleAction(actionReason + ':launch-rejected');
          return;
        }
      } else if (sessionType === 'gemini') {
        store.setTabCommandType(tabId, 'gemini');
        terminalRegistry.get(tabId)?.scrollToBottom();
        focusTerminal();
        window.dispatchEvent(new CustomEvent('timeline:scroll-to-bottom', { detail: { tabId } }));
        ipcRenderer.send('gemini:run-command', { tabId, command: 'gemini-c', sessionId: geminiSessionId });
      } else if (sessionType === 'codex') {
        store.setTabCommandType(tabId, 'codex');
        terminalRegistry.get(tabId)?.scrollToBottom();
        focusTerminal();
        window.dispatchEvent(new CustomEvent('timeline:scroll-to-bottom', { detail: { tabId } }));
        const runResult = await runCodexCommand({ tabId, command: 'codex-c', sessionId: codexContinueSessionId || undefined, cwd: launchCwd });
        if (runResult?.success === false || runResult?.accepted === false) {
          clearSessionLifecycleAction(actionReason + ':launch-rejected');
        }
      }
    } catch (e) {
      clearSessionLifecycleAction(actionReason + ':clear');
      throw e;
    }
  };

  const onStop = async () => {
    if (!tabId) return;
    if (isSDKTab) {
      // SOFT interrupt of the current turn (default). sdkBusy guard: only when a
      // turn is actually streaming. Process + session + bg agents stay alive.
      if (!sdkBusy) return;
      try {
        await ipcRenderer.invoke('claude-sdk:stop', { tabId });
        window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId } }));
      } catch (e: any) { console.error('[SDKStop] error', e); }
      return;
    }
    const actionReason = 'session-stop:' + sessionType;
    if (!beginSessionLifecycleAction(actionReason)) return;
    try {
      const res = await ipcRenderer.invoke('terminal:stop-ai-process', tabId);
      if (!res?.success) {
        console.warn('[SessionStop] failed:', res?.error);
        clearSessionLifecycleAction(actionReason + ':clear');
      }
    } catch (e: any) {
      clearSessionLifecycleAction(actionReason + ':clear');
      console.error('[SessionStop] error', e);
    }
  };

  // HARD kill — terminate the SDK process AND all its background agents. Bound
  // to the process indicator click when the process is alive. Immediate, no
  // confirm (per UX decision). The next message auto-revives a fresh process.
  const onKillProcess = async () => {
    if (!tabId || !isSDKTab) return;
    try {
      await ipcRenderer.invoke('claude-sdk:stop', { tabId, hard: true });
      window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId } }));
    } catch (e: any) { console.error('[SDKKill] error', e); }
  };

  // WARM-START — boot the SDK process idle so the chip flips ОСТАНОВЛЕН→АКТИВЕН
  // on click, without sending a message. Passes the tab's sessionId as resume so
  // the warm process keeps full memory. Also focus the composer so the user can
  // immediately type. The process-state alive:true from main flips the chip.
  const onWarmStart = () => {
    if (!tabId || !isSDKTab) return;
    ipcRenderer.invoke('claude-sdk:warm-start', {
      tabId,
      cwd: launchCwd,
      model: sdkModel || undefined,
      effort: sdkEffort,
      thinking: sdkThinking ? 'adaptive' : 'disabled',
      resumeSessionId: claudeSessionId || undefined,
    }).catch((e: any) => console.error('[SDKWarmStart] error', e));
    window.dispatchEvent(new CustomEvent('claude-sdk:focus-composer', { detail: { tabId } }));
  };

  const refreshTimeline = () => {
    window.dispatchEvent(new CustomEvent('timeline:force-refresh', { detail: { tabId } }));
  };

  // Manual escape hatch for a STUCK local-control indicator. The right cluster's
  // shimmer is driven only by isLocalBusy; isPasteBusy remains a silent write
  // lock. If a local command never confirms (for example, /effort was manually
  // aborted), the cluster would otherwise shimmer forever. Clicking the cluster
  // clears only the local-control flag; it does not cancel or unlock a genuine
  // main-side paste. Юзер: «сделать эту область кликабельной, при наведении
  // красное СТОП на весь loader, переклик сбрасывает состояние».
  const forceResetBusy = () => {
    console.warn('[ControlBar] manual local-busy reset by user for tab ' + tabId.slice(-12));
    setLocalBusy(false, 'manual-reset');
    focusTerminal();
  };

  const sendRawEnterToPty = () => {
    focusTerminal();
    ipcRenderer.send('terminal:input', tabId, '\r');
  };

  const focusHistoryComposer = () => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      `textarea[data-history-composer-tab-id="${CSS.escape(tabId)}"]`,
    );
    textarea?.focus();
  };

  const sendStopCurrentTurn = () => {
    if (!showComposerInputActions) return;
    if (isPrimaryHistoryAgent && !historyCanInterruptTurn) return;
    cancelPendingEnterRef.current = true;
    if (enterPending) setEnterPending(false);
    if (isPrimaryHistoryAgent) {
      window.dispatchEvent(new CustomEvent('history-panel:interrupt-turn', {
        detail: { tabId, source: 'control-bar' },
      }));
      focusHistoryComposer();
      return;
    }
    focusTerminal();
    ipcRenderer.send('terminal:input', tabId, '\x03');
  };

  const waitForDictationDelivery = () => {
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise<{ ok: boolean; mode?: DictationMode }>((resolve) => {
      let settled = false;
      const cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener(DICTATION_DELIVERED_EVENT, handler);
      };
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail || {};
        if (detail.tabId !== tabId || detail.requestId !== requestId) return;
        if (settled) return;
        settled = true;
        cleanup();
        if (detail.success === false) {
          showToast('Dictation delivery failed — Enter cancelled', 'error');
          resolve({ ok: false });
          return;
        }
        resolve({ ok: true, mode: detail.mode });
      };
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        showToast('Dictation did not finish — Enter cancelled', 'error');
        resolve({ ok: false });
      }, 30_000);
      window.addEventListener(DICTATION_DELIVERED_EVENT, handler);
      window.dispatchEvent(new CustomEvent(DICTATION_STOP_AND_DELIVER_EVENT, {
        detail: { tabId, requestId },
      }));
    });
  };

  const sendComposerInput = async () => {
    if (!showComposerInputActions || enterPending) return;
    if (
      isPrimaryHistoryAgent
      && !historyCanSend
      && !(
        historyCanAcceptSubmitIntent
        && (dictationState.recording || dictationState.stopping)
      )
    ) return;
    if (isPrimaryHistoryAgent) focusHistoryComposer();
    else focusTerminal();
    if (dictationState.recording || dictationState.stopping) {
      cancelPendingEnterRef.current = false;
      setEnterPending(true);
      try {
        const delivery = await waitForDictationDelivery();
        if (delivery.ok && !cancelPendingEnterRef.current) {
          if (isPrimaryHistoryAgent || delivery.mode === 'history') {
            // Dictation is now delivered into the History composer for normal
            // Claude/Codex tabs. Sending a raw CR here would submit the hidden
            // xterm instead of the text the user can see. Route the intent to
            // History's canonical send action; HistoryPanel owns readiness,
            // images, rollback and the actual agent submit.
            window.dispatchEvent(new CustomEvent('history-panel:submit-composer', {
              detail: { tabId, source: 'dictation-enter' },
            }));
          } else {
            sendRawEnterToPty();
          }
        }
      } finally {
        cancelPendingEnterRef.current = false;
        setEnterPending(false);
      }
      return;
    }
    if (isPrimaryHistoryAgent) {
      window.dispatchEvent(new CustomEvent('history-panel:submit-composer', {
        detail: { tabId, source: 'control-bar-enter' },
      }));
      focusHistoryComposer();
      return;
    }
    sendRawEnterToPty();
  };

  // Fork current session into a PTY tab. This button is visible only when the
  // current tab already has a session, so it is a branch action FROM this tab,
  // never a launch target. Always create a neighbour tab; in-place reuse is only
  // valid for clipboard `*-F` chips on a pristine PTY tab.
  const forkToTab = async () => {
    if (!tabId || !sessionType) return;
    const actionSessionId = sessionType === 'codex'
      ? await requireCodexActionSessionId('создать fork Codex-сессии', true)
      : sessionId;
    if (!actionSessionId) return;
    if (!(await ensureClaudeArtifactSession('fork-to-tab'))) return;
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      const currentCwd = tab.cwd || projectPath || '';
      const forkName = tab.name ? `${tab.name}_fork` : undefined;
      await state.createTabAfterCurrent(projectId, forkName, currentCwd, {
        pendingAction: { type: sessionType === 'claude' ? 'claude-fork' : sessionType === 'codex' ? 'codex-fork' : 'gemini-fork', sessionId: actionSessionId },
        nameSetManually: sessionType === 'gemini' ? !!forkName : false,
        afterTabId: tab.id,
        visualParentTabId: tab.id,
      });
      showToast(`Fork ${sessionType === 'claude' ? 'Claude' : sessionType === 'codex' ? 'Codex' : 'Gemini'} → ${forkName || 'новая вкладка'}`, 'success');
      break;
    }
  };

  // Pull a UUID out of clipboard text. The clipboard might hold raw whitespace
  // ("  uuid \n"), a TUI bracketed-paste echo, or "/resume <uuid>" — strip and
  // validate with the canonical UUID v4 regex. Returns null on no/invalid uuid.
  const readSessionFromClipboard = (): string | null => {
    try {
      const { clipboard } = window.require('electron');
      const raw = String(clipboard.readText() || '').trim();
      const m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return m ? m[0] : null;
    } catch {
      return null;
    }
  };

  const canUseCurrentEmptyPtyForFork = (tab: any) => {
    return tab?.tabType !== 'claude-sdk'
      && !isCommandRunning
      && !tab?.claudeSessionId
      && !tab?.geminiSessionId
      && !tab?.codexSessionId;
  };

  // Fork from the sessionId currently in clipboard. On an empty PTY tab, reuse
  // the current tab; otherwise preserve the current conversation and open a
  // neighbour tab. This is intentionally different from current-session
  // `forkToTab`, which always branches into a neighbour.
  const forkFromClipboardClaude = async () => {
    if (!tabId) return;
    const clipSid = readSessionFromClipboard();
    if (!clipSid) {
      showToast('В буфере нет session ID (UUID)', 'warning');
      return;
    }
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        const currentCwd = tab.cwd || projectPath || '';
        if (canUseCurrentEmptyPtyForFork(tab)) {
          state.setTabCommandType(tabId, 'claude');
          state.markAiForkAutoTitle(tabId, 'claude', clipSid);
          terminalRegistry.get(tabId)?.scrollToBottom();
          focusTerminal();
          const runResult = await ipcRenderer.invoke('claude:run-command', { tabId, command: 'claude-f', forkSessionId: clipSid, cwd: currentCwd })
            .catch((error: any) => ({ success: false, accepted: false, error: error?.message || String(error) }));
          if (runResult?.success === false || runResult?.accepted === false) {
            showToast('Claude fork не запущен: ' + (runResult?.error || runResult?.reason || 'launch rejected'), 'error');
            return;
          }
          showToast(`Claude fork (в этой вкладке) ← ${clipSid.slice(0, 8)}`, 'success');
          return;
        }
        const forkName = `${clipSid.slice(0, 8)}_fork`;
        await state.createTabAfterCurrent(projectId, forkName, currentCwd, {
          pendingAction: { type: 'claude-fork', sessionId: clipSid },
          nameSetManually: false,
        });
        showToast(`Claude fork ← ${clipSid.slice(0, 8)}`, 'success');
        return;
      }
    }
  };

  // Same idea for SDK: invoke claude:fork-session-file (rewrites JSONL with
  // new sessionId) and attach the result to the current empty PTY tab when
  // possible, otherwise to a new SDK tab. Current-session `forkToSDK` is stricter:
  // it always creates a neighbour because the current tab already has history.
  const forkFromClipboardSDK = async () => {
    if (!tabId) return;
    const clipSid = readSessionFromClipboard();
    if (!clipSid) {
      showToast('В буфере нет session ID (UUID)', 'warning');
      return;
    }
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        const currentCwd = tab.cwd || projectPath || '';
        const forkResult = await ipcRenderer.invoke('claude:fork-session-file', { sourceSessionId: clipSid, cwd: currentCwd, skipChainResolve: true });
        if (!forkResult.success) {
          showToast('Fork failed: ' + forkResult.error, 'error');
          return;
        }
        if (canUseCurrentEmptyPtyForFork(tab)) {
          try {
            state.convertToSDKTab(tabId);
          } catch (e: any) {
            showToast('Не удалось конвертировать в SDK: ' + (e?.message || e), 'error');
            return;
          }
          state.updateSDKState(tabId, { claudeSessionId: forkResult.newSessionId });
          showToast(`SDK fork (в этой вкладке) ← ${clipSid.slice(0, 8)}`, 'success');
          return;
        }
        const forkName = `${clipSid.slice(0, 8)}_fork`;
        const sdkTabId = await state.createSDKTab(projectId, forkName);
        state.updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
        showToast(`SDK fork ← ${clipSid.slice(0, 8)}`, 'success');
        return;
      }
    }
  };

  const forkFromClipboardCodex = async () => {
    if (!tabId) return;
    const clipSid = readSessionFromClipboard();
    if (!clipSid) {
      showToast('В буфере нет session ID (UUID)', 'warning');
      return;
    }
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        const currentCwd = tab.cwd || projectPath || '';
        if (canUseCurrentEmptyPtyForFork(tab)) {
          state.setTabCommandType(tabId, 'codex');
          state.markAiForkAutoTitle(tabId, 'codex', clipSid);
          terminalRegistry.get(tabId)?.scrollToBottom();
          focusTerminal();
          const runResult = await runCodexCommand({ tabId, command: 'codex-f', sessionId: clipSid, cwd: currentCwd })
            .catch((error: any) => ({ success: false, accepted: false, error: error?.message || String(error) }));
          if (runResult?.success === false || runResult?.accepted === false) {
            showToast('Codex fork не запущен: ' + (runResult?.error || runResult?.reason || 'launch rejected'), 'error');
            return;
          }
          showToast(`Codex fork (в этой вкладке) ← ${clipSid.slice(0, 8)}`, 'success');
          return;
        }
        const forkName = `${clipSid.slice(0, 8)}_codex`;
        await state.createTabAfterCurrent(projectId, forkName, currentCwd, {
          pendingAction: { type: 'codex-fork', sessionId: clipSid },
          nameSetManually: false,
        });
        showToast(`Codex fork ← ${clipSid.slice(0, 8)}`, 'success');
        return;
      }
    }
  };

  // Convert the CURRENT empty PTY tab into an SDK tab in-place — same as the
  // `convertToSDKTab` IPC behind the scenes. Юзер: «она должна в текущем
  // терминале именно создавать». Альтернатива (`createSDKTab` → новый таб)
  // нарушает связку «я нахожусь в этой вкладке и хочу её превратить в SDK»,
  // а заодно плодит лишние табы при каждом нажатии.
  const startNewSDKTab = () => {
    if (!tabId) return;
    try {
      useWorkspaceStore.getState().convertToSDKTab(tabId);
      showToast('Вкладка переключена в Claude SDK', 'success');
    } catch (e: any) {
      showToast('Не удалось открыть SDK: ' + (e?.message || e), 'error');
    }
  };

  const startCodexTab = async () => {
    if (!tabId) return;
    const actionReason = 'session-start:codex';
    if (!beginSessionLifecycleAction(actionReason)) return;
    const store = useWorkspaceStore.getState();
    try {
      store.setTabCommandType(tabId, 'codex');
      store.markAiLaunchAutoTitle(tabId, 'codex');
      terminalRegistry.get(tabId)?.scrollToBottom();
      focusTerminal();
      const runResult = await runCodexCommand({ tabId, command: 'codex', cwd: launchCwd });
      if (runResult?.success === false || runResult?.accepted === false) {
        clearSessionLifecycleAction(actionReason + ':launch-rejected');
      }
    } catch (e) {
      clearSessionLifecycleAction(actionReason + ':clear');
      throw e;
    }
  };

  // Fork current Claude session into SDK. This is a branch action FROM a tab
  // that already has Claude history, so it always creates a neighbour SDK tab.
  // In-place PTY→SDK conversion is reserved for clipboard `SDK-F` on a pristine
  // PTY target.
  const forkToSDK = async () => {
    if (!sessionId || !tabId || sessionType !== 'claude') return;
    if (!(await ensureClaudeArtifactSession('fork-to-sdk'))) return;
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (!tab) continue;
      const currentCwd = tab.cwd || projectPath || '';
      const forkResult = await ipcRenderer.invoke('claude:fork-session-file', { sourceSessionId: sessionId, cwd: currentCwd, skipChainResolve: true });
      if (!forkResult.success) { showToast('Fork failed: ' + forkResult.error, 'error'); return; }
      const forkName = tab.name ? `${tab.name}_fork` : undefined;
      const sdkTabId = await state.createSDKTab(projectId, forkName, {
        afterTabId: tab.id,
        visualParentTabId: tab.id,
      });
      state.updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
      showToast(`SDK fork → ${forkName || 'новая вкладка'}`, 'success');
      break;
    }
  };

  // ===== Prompt copy / clear (Claude/Codex PTY — Gemini has no equivalent IPC). =====
  // clearAfter=true uses claude:grab-input (atomic copy+truncate in one Ctrl+G round,
  // helper truncates the tempfile before sending text back to socket — see
  // ~/.claude/hooks/noted-code-grab.js mode='grab' path). Why not the older two-step
  // copy-input + clear-input: two separate Ctrl+G round-trips race each other.
  // The second Ctrl+G arrives while Claude is still in external-editor cycle from
  // the first — falls into the input buffer as a literal ^G character, never reaches
  // chat:externalEditor binding. Plus claude:clear-input had a claudeTurnBusy guard
  // that copy-input did not have → asymmetric "Copied" succeeds, "+ clear" silently
  // dropped when Claude was mid-turn. grab-input fires once and is the same path the
  // PromptQueue uses, no asymmetry.
  const handleCopyPrompt = async (clearAfter: boolean) => {
    if (!tabId || (sessionType !== 'claude' && sessionType !== 'codex')) return;
    try {
      const ipcPrefix = sessionType === 'codex' ? 'codex' : 'claude';
      const agentLabel = sessionType === 'codex' ? 'Codex' : 'Claude';
      const ipcName = clearAfter ? `${ipcPrefix}:grab-input` : `${ipcPrefix}:copy-input`;
      console.log('[ControlBar:CopyPrompt] tab=' + tabId.slice(-12) + ' agent=' + sessionType + ' clear=' + clearAfter + ' running=' + isCommandRunning + ' sessionId=' + (sessionId ? sessionId.slice(0, 8) : 'none') + ' ipc=' + ipcName);
      const res = await ipcRenderer.invoke(ipcName, tabId);
      if (res?.success && typeof res.text === 'string') {
        const t = res.text;
        if (!t.trim()) { showToast(`${agentLabel} input is empty`, 'warning'); return; }
        const { clipboard } = window.require('electron');
        const annotated = res.images > 0 ? t + `\n\n[note: ${res.images} image(s) not copied]` : t;
        clipboard.writeText(annotated);
        const oneLine = t.replace(/\s+/g, ' ').trim();
        const preview = oneLine.length > 20 ? oneLine.slice(0, 20) + '…' : oneLine;
        const verb = clearAfter ? 'Copied + cleared' : 'Copied';
        showToast(`${verb}: "${preview}"${res.images ? ` · ${res.images} 📎` : ''}`, 'success', 1800);
        if (clearAfter) {
          // Refocus so Claude re-reads the now-empty tempfile in the next frame
          // (without focus, the visual input keeps showing old text until user
          // clicks back into the terminal — same gotcha as PromptQueue's +grab).
          focusTerminal();
        }
      } else {
        const code = res?.error || 'timeout';
        const msgs: Record<string, string> = {
          no_claude_session: 'No Claude session',
          no_codex_session: 'No Codex session',
          claude_busy: 'Claude is busy — wait for response',
          codex_ctrl_g_noop: 'Codex did not open editor on Ctrl+G',
          wrong_editor: `Restart ${agentLabel} in this tab (editor not wired)`,
          stale_pid: `${agentLabel} was restarted in shell — close & reopen this tab`,
          editor_not_wired: 'Helper not reachable',
        };
        showToast(msgs[code] || `Copy failed: ${code}`, 'error');
      }
    } catch (e: any) {
      showToast(`Copy failed: ${e?.message || e}`, 'error');
    }
  };

  // ===== render helpers =====
  const meterColor = contextPct > 80 ? '#ef4444' : contextPct > 50 ? '#f59e0b' : '#4ade80';

  // Visible label on a trigger pill
  const modelLabel = (() => {
    if (isCodex) {
      const m = codexModels.find(m => m.id === modelActiveId);
      return m?.label || modelActiveId || '—';
    }
    const modelOptions = isAnthropicPTY ? claudeCodeModels : activeProvider.models;
    const m = modelOptions.find(m => m.id === modelActiveId);
    return m?.label || modelActiveId || '—';
  })();
  const effortLabel = (effortActive === 'medium' ? 'med' : effortActive === 'xhigh' ? 'xhi' : effortActive === 'ultracode' ? 'ultra' : (effortActive || '—'));

  // ===== styles =====
  // Triggers сами не меняют opacity при busy — лоадер реализован overlay'ем на
  // обёртке кластера (см. `<div className="control-bar-busy-overlay">` ниже).
  // Это сохраняет ширину блока (раньше opacity 0.5 + текст разной длины менял
  // визуальную ширину, плюс «серая» подсветка читалась как «мёртвое» состояние).
  const triggerStyle: React.CSSProperties = {
    height: 22,
    padding: '0 8px',
    fontSize: 11,
    color: '#bbb',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 4,
    cursor: isBusy ? 'default' : 'pointer',
    transition: 'background-color 0.12s, color 0.12s, border-color 0.12s',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
  };

  // The portal wrapper is flush with the trigger and owns the 4px invisible
  // bridge. Its horizontal position is measured after mount, so the card stays
  // centered over the trigger yet clamps before the Timeline/window edge.
  const popupCardStyle: React.CSSProperties = {
    display: 'flex',
    gap: 4,
    padding: 4,
    backgroundColor: '#1f1f1f',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    whiteSpace: 'nowrap',
    flexWrap: 'wrap',
    maxWidth: '100%',
  };
  const renderControlPopup = (key: PopupKey, children: React.ReactNode) => {
    if (!triggerRefs.current[key]) return null;
    return createPortal(
      <CenteredUpwardPopover
        {...popupHoverProps(key)}
        getAnchorRect={() => triggerRefs.current[key]?.getBoundingClientRect() || null}
        zIndex={10050}
      >
        <div style={popupCardStyle}>{children}</div>
      </CenteredUpwardPopover>,
      document.body,
    );
  };

  const pillStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    height: 20,
    padding: '0 8px',
    fontSize: 11,
    fontWeight: active ? 500 : 400,
    color: disabled ? '#555' : active ? '#fff' : '#aaa',
    backgroundColor: active ? '#DA7756' : disabled ? '#222' : '#2d2d2d',
    borderWidth: 0,
    borderStyle: 'none',
    borderColor: 'transparent',
    borderRadius: 3,
    cursor: disabled ? 'not-allowed' : 'pointer',
  });

  // ============================================================================
  // ===== render =====
  // ============================================================================
  //
  // КАРТА ВИДИМОСТИ КНОПОК — по двум осям: tabType (PTY vs SDK) и состояние
  // (hasArtifactSession / isCommandRunning / isSDKTab / sessionId). Если меняешь
  // ЛЮБОЙ guard ниже — обнови эту таблицу, чтобы следующий разработчик мог
  // понять без чтения 1000 строк JSX.
  //
  //                              | PTY new | PTY running | PTY idle    | SDK new | SDK running | SDK idle
  //                              | (нет    | (claude     | (сессия в   | (нет    | (query      | (между
  //                              | session)| process)    | БД, claude  | session)| активен)    | turn'ами)
  //                              |         |             | мёртв)      |         |             |
  // -----------------------------+---------+-------------+-------------+---------+-------------+----------
  // ⎘ copy-session-id            | -       | + если saved| + saved     | -       | + (если sid)| + (если sid)
  // SessionActionChip            | "Start" | "Stop" hover| "Continue"  | "Claude"| "Stop" hover| "Claude"
  //   transition/loader          | disabled during PTY starting/stopping and local control-action in-flight
  // ↻ refresh-timeline           | -       | + saved     | + saved     | -       | +           | +
  // ⑂→▭ forkToTab (PTY)          | -       | + saved     | + saved     | -       | +           | +
  // ⑂→SDK forkToSDK              | -       | + saved     | + saved     | -       | -           | -
  // SDK startNewSDKTab           | + 1)    | -           | -           | -       | -           | -
  // Claude-F (from clipboard)    | + 1)    | -           | -           | -       | -           | -
  // SDK-F (from clipboard)       | + 1)    | -           | -           | -       | -           | -
  // Codex startCodexTab          | + 1)    | -           | -           | -       | -           | -
  // ⑂ Codex-F (from clipboard)   | + 1)    | -           | -           | -       | -           | -
  // terminal→ prompt | + clear   | -       | + Claude/   | -           | -       | -           | -
  //   (PTY only)                 |         |   Codex     |   Codex     |         |             |
  // 🎤 mic | Enter | ^C          | History | + Claude/   | History     | -       | -           | -
  //   primary History            | Mic +   |   Codex:    | Mic +       |         |             |
  //                              | Enter   | Mic/Enter;  | Enter;      |         |             |
  //                              | follows | ^C follows  | ^C follows  |         |             |
  //                              | History | canonical   | canonical   |         |             |
  //                              | canSend | availability| availability|         |             |
  //   legacy PTY presentation    | -       | raw Mic / Enter / ^C     | -       | -           | -
  // terminal → History draft     | disabled| + semantic pull+clear    | disabled| -       | -           | -
  // Right cluster Provider/Model | hidden  | enabled     | dimmed      | enabled | shimmer     | enabled
  //   /Effort/Think              |         |             |             |         |             |
  //
  // 1) Claude-F / SDK / SDK-F / Codex / Codex-F появляются ТОЛЬКО когда нет сохранённой сессии И нет
  //    живого процесса (`!hasAnySession && !isSDKTab && !isCommandRunning`).
  //    Раньше guard был `!hasAnySession && !isSDKTab` — кнопки показывались
  //    в окне «процесс стартанул, sessionId ещё не записался в Tab». Юзер
  //    видел Claude-F/SDK-F одновременно с живым claude процессом.
  //
  // ВЕТКИ И ИХ ИСТОЧНИКИ:
  //
  //   isSDKTab — `tabType === 'claude-sdk'`. SDK таб не имеет PTY, поэтому
  //              isCommandRunning от Workspace всегда false для него.
  //              SDK-busy получаем отдельно через subscriber на
  //              claude:busy-state (forward'ится main'ом из claude-sdk:busy-state).
  //
  //   hasArtifactSession — для Claude PTY это не `!!sessionId`, а
  //              materialized JSONL: user-visible Timeline entries уже есть.
  //              Технический UUID pre-prompt Claude-процесса не включает
  //              Copy/Resume/Fork. Для SDK/Codex/Gemini sessionId остаётся
  //              артефактом сессии.
  //
  //   isCommandRunning — OSC 133 D/B от PTY shell. Для SDK всегда false.
  //
  //   sdkBusy — claude-sdk:busy-state из ClaudeSDKTab (isRunning эффект).
  //
  //   historyIsPrimary — normal Claude/Codex tabs author through History.
  //              Mic/Enter stay mounted in this lower bar even when the PTY
  //              process is stopped, so Start/Resume does not reflow it.
  //              Enter dispatches `history-panel:submit-composer`; ^C dispatches
  //              semantic `history-panel:interrupt-turn` and never writes a raw
  //              control byte into the hidden xterm. Legacy PTY presentation
  //              keeps its old live-process-only raw-input behavior.
  //
  // АНТИПАТТЕРН (не повторять):
  //   — Для in-flight control-команд (`/model`, `/effort`, provider switch)
  //     не ставь `disabled + opacity` на каждый trigger: блок визуально
  //     съёживается. Используй .control-bar-busy-overlay (shimmer ::after) —
  //     см. fact-claude-control-bar.md::Busy-overlay. Semantic unavailable
  //     states (PTY idle, Codex streaming) — отдельный случай: там кнопки
  //     действительно недоступны, а не "команда уже применяется".
  //   — Композитный селектор Zustand `state => ({ a, b, c })` → новая ссылка
  //     каждый рендер → infinite re-render. Используй отдельные primitive
  //     селекторы (см. начало компонента, `tabType` / `sdkModel` etc).
  //
  // ============================================================================
  return (
    <div
      ref={rootRef}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '4px 10px',
        height: 30,
        borderTop: '1px solid #2a2a2a',
        backgroundColor: '#161616',
        flexShrink: 0,
      }}
    >
      {/* LEFT: session controls + context meter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        {/* ── [⎘ session-id-copy | SessionActionChip | ↻ refresh-timeline] ──
            Container border видим только при наличии sessionId. Содержимое
            заходит в один rounded-3-pill блок. Copy/Refresh скрыты на
            новой вкладке (нечего копировать / нечего обновлять). */}
        <div
          className="inline-flex items-center rounded overflow-hidden"
          style={{
            gap: 0,
            border: hasArtifactSession ? '1px solid rgba(255,255,255,0.10)' : 'none',
            flexShrink: 0,
          }}
        >
          {hasArtifactSession && (
            <span
              className="cursor-pointer flex-shrink-0 inline-flex items-center justify-center transition-colors"
              style={{
                color: sessionCopied ? '#4ade80' : '#aaa',
                fontSize: 13,
                lineHeight: 1,
                width: 22,
                height: 18,
                backgroundColor: 'transparent',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                setSessionCopyHover(true);
                const rect = e.currentTarget.getBoundingClientRect();
                setSessionCopyRect({
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                });
                if (sessionCopied) return;
                const el = e.currentTarget as HTMLSpanElement;
                el.style.color = '#fff';
                el.style.backgroundColor = 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                setSessionCopyHover(false);
                setSessionCopyRect(null);
                if (sessionCopied) return;
                const el = e.currentTarget as HTMLSpanElement;
                el.style.color = '#aaa';
                el.style.backgroundColor = 'transparent';
              }}
              onClick={copySessionId}
              title="Copy session ID"
            >
              {sessionCopied ? '✓' : '⎘'}
            </span>
          )}
          {/* PTY mode: 3-state матрица (Start/Continue/Stop). SDK mode: 2-state
              (idle / running) — там Continue/Start не имеют семантики, таб
              существует — query запустится первым же сообщением. См. headed
              comment в SessionActionChip.tsx. isCommandRunning для SDK — это
              sdkBusy (claude-sdk:busy-state forward'ится через claude:busy-state). */}
          {isSDKTab ? (
            // SDK: the middle "chip" slot shows the PROCESS state (РАБОТАЕТ /
            // АКТИВЕН / ОСТАНОВЛЕН) and is the HARD-kill button — same states /
            // dot / text as the standalone indicator, but using the chip's font
            // (text-xs font-medium) and living inside the session pill. Soft
            // interrupt of the turn stays on Escape; this button kills the whole
            // process + bg agents. 4 states: stopping > running > active > stopped.
            (() => {
              const alive = sdkProcessAlive && !sdkStopping;
              const label = sdkStopping ? 'останавливаю…'
                : sdkProcessAlive ? (sdkBusy ? 'работает' : 'активен')
                : 'остановлен';
              // Always clickable: alive → HARD kill the process; stopped →
              // WARM-START (boot the process idle → flips to АКТИВЕН) + focus the
              // composer. During the transient stopping cue it's inert.
              const clickable = !sdkStopping;
              const onClick = !clickable ? undefined : (alive ? onKillProcess : onWarmStart);
              const title = sdkStopping ? 'Останавливаю процесс…'
                : alive ? 'Процесс активен — нажмите, чтобы полностью остановить'
                : 'Процесс остановлен — нажмите, чтобы запустить';
              return (
                <ControlHint label={sdkStopping ? 'Останавливаю SDK-процесс…' : alive ? 'Полностью остановить SDK-процесс' : 'Запустить SDK-процесс'}>
                <span
                  onClick={onClick}
                  title={title}
                  className="text-xs font-medium relative inline-flex items-center justify-center gap-1.5"
                  style={{
                    height: 18,
                    padding: '0 8px',
                    cursor: clickable ? 'pointer' : 'default',
                    color: alive ? '#d97706' : '#666',
                    backgroundColor: alive ? 'rgba(217,119,6,0.12)' : 'transparent',
                    transition: 'background-color 0.12s, color 0.12s',
                    userSelect: 'none',
                  }}
                  onMouseEnter={(e) => { if (clickable) (e.currentTarget as HTMLSpanElement).style.backgroundColor = alive ? 'rgba(217,119,6,0.22)' : 'rgba(255,255,255,0.06)'; }}
                  onMouseLeave={(e) => { if (clickable) (e.currentTarget as HTMLSpanElement).style.backgroundColor = alive ? 'rgba(217,119,6,0.12)' : 'transparent'; }}
                >
                  <span
                    aria-hidden
                    className={alive && sdkBusy ? 'animate-glow-yellow' : undefined}
                    style={{ width: 7, height: 7, borderRadius: 2, flexShrink: 0, backgroundColor: alive ? '#d97706' : '#555' }}
                  />
                  {label}
                </span>
                </ControlHint>
              );
            })()
          ) : (
            <SessionActionChip
              sessionType={sessionType}
              mode="pty"
              idleLabel={isPrimaryHistoryAgent ? 'Resume' : 'Continue'}
              isCommandRunning={isCommandRunning}
              hasAnySession={hasAnySession}
              disabled={sessionActionDisabled}
              disabledTitle={sessionActionDisabledTitle}
              onStart={onStart}
              onContinue={onContinue}
              onStop={onStop}
            />
          )}
          {hasArtifactSession && (
            <ControlHint label="Обновить Timeline">
            <button
              className="flex-shrink-0 inline-flex items-center justify-center cursor-pointer transition-colors"
              style={{
                color: '#aaa',
                fontSize: 13,
                lineHeight: 1,
                width: 22,
                height: 18,
                padding: 0,
                background: 'transparent',
                border: 'none',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.color = '#fff';
                el.style.background = 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.color = '#aaa';
                el.style.background = 'transparent';
              }}
              onClick={refreshTimeline}
              title="Refresh timeline"
            >↻</button>
            </ControlHint>
          )}
        </div>
        {showSessionIdTooltip && sessionCopyRect && sessionId && (
          <div
            data-session-id-tooltip
            style={{
              position: 'fixed',
              left: sessionCopyRect.left + sessionCopyRect.width / 2,
              top: Math.max(8, sessionCopyRect.top - 8),
              transform: 'translate(-50%, -100%)',
              zIndex: 10000,
              pointerEvents: 'none',
              maxWidth: 'calc(100vw - 16px)',
              padding: '5px 8px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.14)',
              background: '#101010',
              color: '#d4d4d4',
              boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
              fontSize: 11,
              lineHeight: 1.2,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              whiteSpace: 'nowrap',
            }}
          >
            {sessionId}
          </div>
        )}

        {/* Forks: session-origin actions into a new PTY tab
            (⑂→▭) and a new SDK tab (⑂→SDK).
            SDK fork only for Claude sessions — SDK doesn't run Gemini.
            Без активной сессии форкать нечего, поэтому обе fork-кнопки
            скрываются и заменяются на одну `+ SDK` (создать новый SDK таб)
            — единственное осмысленное действие в этом слоте при пустой
            сессии. На SDK-табе вариант «открыть SDK» не показываем — юзер
            уже в SDK. */}
        {hasArtifactSession && (
          <ControlHint
            label={codexForkProbeFailed
              ? 'Не удалось проверить активную историю Codex — нажмите, чтобы повторить'
              : codexForkWaitingForHistory
              ? 'После Resume ветка Codex подтвердится вашим первым сообщением — до этого форк недоступен'
              : 'Создать fork сессии в новой PTY-вкладке'}
          >
          <button
            type="button"
            aria-busy={isInlineActionLoading('fork-to-pty')}
            aria-disabled={inlineAction?.tabId === tabId || codexForkWaitingForHistory}
            className="text-[10px] px-1.5 py-0.5 rounded text-[#999] hover:text-white cursor-pointer leading-none flex items-center gap-0.5 transition-colors"
            style={{
              backgroundColor: 'transparent',
              border: '1px solid rgba(255,255,255,0.10)',
              flexShrink: 0,
              cursor: codexForkWaitingForHistory ? 'not-allowed' : 'pointer',
              opacity: codexForkWaitingForHistory ? 0.72 : 1,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
            onClick={() => {
              if (codexForkWaitingForHistory) {
                void refreshSessionActionBlockedStatus('fork-chip-click');
                return;
              }
              void runInlineAction('fork-to-pty', forkToTab);
            }}
            title={codexForkProbeFailed
              ? 'Проверить активную историю Codex ещё раз'
              : codexForkWaitingForHistory
              ? 'Активная история Codex ещё подтверждается'
              : 'Fork в новую вкладку'}
          >
            {/* A spinner promises "this finishes on its own". In the Codex
                provisional window it does not: the writer is confirmed by the
                user's FIRST MESSAGE, so the chip used to spin indefinitely with
                the real reason hidden in a hover title. Waiting-for-writer is a
                static state (dimmed label + hint), and the spinner is reserved
                for an actual in-flight fork. */}
            <InlineActionContent loading={isInlineActionLoading('fork-to-pty')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                <span>⑂→</span>
                <span style={{ fontSize: '11px' }}>▭</span>
                {codexForkWaitingForHistory && (
                  <span style={{ fontSize: '9px', opacity: 0.75, marginLeft: 2 }}>
                    ждёт 1-е сообщение
                  </span>
                )}
              </span>
            </InlineActionContent>
          </button>
          </ControlHint>
        )}
        {sessionType === 'claude' && sessionId && hasArtifactSession && (
          <ControlHint label="Создать fork Claude-сессии в SDK-вкладке">
          <button
            type="button"
            aria-busy={isInlineActionLoading('fork-to-sdk')}
            aria-disabled={inlineAction?.tabId === tabId}
            className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer leading-none transition-colors"
            style={{
              color: '#DA7756',
              backgroundColor: 'transparent',
              border: '1px solid rgba(218,119,86,0.30)',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218,119,86,0.15)'; (e.currentTarget as HTMLButtonElement).style.color = '#FF9466'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#DA7756'; }}
            onClick={() => void runInlineAction('fork-to-sdk', forkToSDK)}
            title="Fork в новый SDK таб"
          >
            <InlineActionContent loading={isInlineActionLoading('fork-to-sdk')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                <span>⑂→SDK</span>
              </span>
            </InlineActionContent>
          </button>
          </ControlHint>
        )}
        {/* Pristine-PTY guard: видно только в новой PTY-вкладке (нет сохранённой
            сессии И нет живого процесса). hasAnySession false + isCommandRunning true
            = окно «процесс стартанул, но беседа ещё не материализована» — там
            Claude-F/SDK/SDK-F/Codex/Codex-F НЕ показываем, иначе юзер видит
            fork/start-кнопки одновременно с живым claude/codex процессом. */}
        {/* Clipboard fork chips — видны только на пустом PTY-табе (новая вкладка).
            Логика: юзер скопировал sessionId из любого места (Timeline, чужая
            JSONL, чат) → одна кнопка форкает в PTY-claude, вторая в SDK.
            UUID извлекается regex'ом, не парсится строго — clipboard может
            содержать «/resume <uuid>» / whitespace / brackets. Пустой PTY-таб
            используется как цель запуска; соседний таб создаётся только если
            текущий уже занят сессией или живым процессом.
            Тот же `!isCommandRunning` guard что выше — fork-from-clipboard
            не имеет смысла когда процесс уже запущен: визуально кнопки на
            «занятой» вкладке выглядели как «процесс работает, но почему-то
            предлагают форкнуть из буфера». */}
        {!hasAnySession && !isSDKTab && !isCommandRunning && (
          <>
            <ControlHint label="Создать Claude fork из session ID в буфере">
            <button
              type="button"
              aria-busy={isInlineActionLoading('fork-from-clipboard-claude')}
              aria-disabled={inlineAction?.tabId === tabId}
              className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer leading-none flex items-center gap-0.5 transition-colors"
              style={{
                color: '#DA7756',
                backgroundColor: 'transparent',
                border: '1px solid rgba(218,119,86,0.30)',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218,119,86,0.15)'; (e.currentTarget as HTMLButtonElement).style.color = '#FF9466'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#DA7756'; }}
              onClick={() => void runInlineAction('fork-from-clipboard-claude', forkFromClipboardClaude)}
              title="Форк Claude из session ID в буфере обмена"
            >
              <InlineActionContent loading={isInlineActionLoading('fork-from-clipboard-claude')}>
                Claude-F
              </InlineActionContent>
            </button>
            </ControlHint>
            <ControlHint label="Открыть новую Claude SDK-вкладку">
            <button
              className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer leading-none flex items-center gap-0.5 transition-colors"
              style={{
                color: '#DA7756',
                backgroundColor: 'transparent',
                border: '1px solid rgba(218,119,86,0.30)',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218,119,86,0.15)'; (e.currentTarget as HTMLButtonElement).style.color = '#FF9466'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#DA7756'; }}
              onClick={startNewSDKTab}
              title="Открыть новый Claude SDK таб"
            >SDK</button>
            </ControlHint>
            <ControlHint label="Создать SDK fork из session ID в буфере">
            <button
              type="button"
              aria-busy={isInlineActionLoading('fork-from-clipboard-sdk')}
              aria-disabled={inlineAction?.tabId === tabId}
              className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer leading-none flex items-center gap-0.5 transition-colors"
              style={{
                color: '#DA7756',
                backgroundColor: 'transparent',
                border: '1px solid rgba(218,119,86,0.30)',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218,119,86,0.15)'; (e.currentTarget as HTMLButtonElement).style.color = '#FF9466'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#DA7756'; }}
              onClick={() => void runInlineAction('fork-from-clipboard-sdk', forkFromClipboardSDK)}
              title="Форк SDK из session ID в буфере обмена"
            >
              <InlineActionContent loading={isInlineActionLoading('fork-from-clipboard-sdk')}>
                SDK-F
              </InlineActionContent>
            </button>
            </ControlHint>
            <SessionActionChip
              sessionType="codex"
              mode="pty"
              isCommandRunning={false}
              hasAnySession={false}
              disabled={sessionActionDisabled}
              disabledTitle={sessionActionDisabledTitle}
              onStart={startCodexTab}
              onContinue={startCodexTab}
              onStop={() => {}}
            />
            <ControlHint label="Создать Codex fork из session ID в буфере">
            <button
              type="button"
              aria-busy={isInlineActionLoading('fork-from-clipboard-codex')}
              aria-disabled={inlineAction?.tabId === tabId}
              className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer leading-none flex items-center gap-0.5 transition-colors"
              style={{
                color: '#10A37F',
                backgroundColor: 'transparent',
                border: '1px solid rgba(16,163,127,0.35)',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(16,163,127,0.14)'; (e.currentTarget as HTMLButtonElement).style.color = '#34d399'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#10A37F'; }}
              onClick={() => void runInlineAction('fork-from-clipboard-codex', forkFromClipboardCodex)}
              title="Форк Codex из session ID в буфере обмена"
            >
              <InlineActionContent loading={isInlineActionLoading('fork-from-clipboard-codex')}>
                Codex-F
              </InlineActionContent>
            </button>
            </ControlHint>
          </>
        )}

        {/* terminal→ prompt | terminal→ + clear — Claude/Codex PTY only.
            Copies the live TUI input; the SDK composer has no equivalent grab,
            so these actions stay hidden for SDK tabs. */}
        {showLivePtyInputActions && (
          <div
            className="inline-flex items-stretch rounded select-none overflow-hidden"
            style={{
              height: 22,
              border: '1px solid rgba(255,255,255,0.12)',
              backgroundColor: 'rgba(255,255,255,0.03)',
              color: '#bbb',
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            <ControlHint
              label="Скопировать ввод из терминала"
              shortcut="Терминальный ввод останется на месте"
            >
            <button
              onClick={() => handleCopyPrompt(false)}
              className="inline-flex items-center gap-1 cursor-pointer hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition-colors"
              style={{ padding: '0 8px', background: 'transparent', border: 'none', color: 'inherit' }}
              aria-label={`Copy live ${sessionType === 'codex' ? 'Codex' : 'Claude'} terminal input`}
              title={`Copy live ${sessionType === 'codex' ? 'Codex' : 'Claude'} terminal input`}
            >
              <TerminalSourceMark />
              <span style={{ fontSize: 12, lineHeight: 1 }}>⎘</span>
              <span>prompt</span>
            </button>
            </ControlHint>
            <span style={{ width: 1, alignSelf: 'center', height: '70%', backgroundColor: 'rgba(255,255,255,0.12)' }} />
            <ControlHint
              label="Скопировать и очистить ввод терминала"
              shortcut="Копирование и очистка выполняются атомарно"
            >
            <button
              onClick={() => handleCopyPrompt(true)}
              className="inline-flex items-center gap-0.5 cursor-pointer hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition-colors"
              style={{ padding: '0 8px', background: 'transparent', border: 'none', color: 'inherit' }}
              aria-label={`Copy and clear live ${sessionType === 'codex' ? 'Codex' : 'Claude'} terminal input`}
              title={`Copy and clear live ${sessionType === 'codex' ? 'Codex' : 'Claude'} terminal input`}
            >
              <TerminalSourceMark />
              <span>+</span>
              <span>clear</span>
            </button>
            </ControlHint>
          </div>
        )}
        {isPrimaryHistoryAgent && (
          <ControlHint
            label="Перенести черновик из терминала в History input"
            shortcut="Терминальный ввод очищается атомарно"
            disabled={!historyCanPullDraft}
          >
            <button
              type="button"
              aria-label={`Move ${sessionType === 'codex' ? 'Codex' : 'Claude'} terminal draft to History input`}
              disabled={!historyCanPullDraft}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                window.dispatchEvent(new CustomEvent('history-panel:pull-terminal-draft', {
                  detail: { tabId, source: 'control-bar' },
                }));
                focusHistoryComposer();
              }}
              className={`inline-flex items-center justify-center gap-1 transition-colors ${historyCanPullDraft ? 'cursor-pointer hover:bg-[rgba(255,255,255,0.06)] hover:text-white' : ''}`}
              style={{
                height: 22,
                minWidth: 38,
                padding: '0 7px',
                background: 'transparent',
                border: '1px solid rgba(167,139,250,0.30)',
                borderRadius: 4,
                color: historyCanPullDraft ? '#a78bfa' : '#555',
                cursor: historyCanPullDraft ? 'pointer' : 'default',
                fontSize: 11,
                lineHeight: 1,
                flexShrink: 0,
              }}
              title="Move terminal draft → visible History input"
            >
              <SquareTerminal size={11} strokeWidth={1.8} aria-hidden />
              <span aria-hidden>→</span>
              <span aria-hidden style={{ fontSize: 10 }}>input</span>
            </button>
          </ControlHint>
        )}

        {/* Live AI input actions. Mic delivery follows the tab's visible owner:
            normal Claude/Codex tabs append to the primary History composer,
            while legacy PTY modes retain their raw-terminal delivery path.
            In primary History, Enter and ^C are semantic requests handled by
            HistoryPanel (send visible draft / interrupt current turn); they
            never submit or cancel the hidden xterm composer. */}
        {showComposerInputActions && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            <MicButton tabId={tabId} sessionType={sessionType} />
            <ControlHint label={enterPending ? 'Жду доставку диктовки…' : 'Отправить текущий ввод'}>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={sendComposerInput}
              disabled={enterPending || (isPrimaryHistoryAgent && !historySubmitButtonEnabled)}
              aria-busy={enterPending}
              className={`inline-flex items-center justify-center transition-colors ${enterPending || (isPrimaryHistoryAgent && !historySubmitButtonEnabled) ? '' : 'cursor-pointer hover:bg-[rgba(255,255,255,0.06)] hover:text-white'}`}
              style={{
                height: 22,
                minWidth: 50,
                padding: '0 8px',
                background: enterPending ? 'rgba(218,119,86,0.12)' : 'transparent',
                border: `1px solid ${enterPending ? 'rgba(218,119,86,0.45)' : 'rgba(255,255,255,0.12)'}`,
                borderRadius: 4,
                color: enterPending
                  ? '#FF9466'
                  : isPrimaryHistoryAgent && !historySubmitButtonEnabled ? '#666' : '#bbb',
                cursor: enterPending || (isPrimaryHistoryAgent && !historySubmitButtonEnabled) ? 'default' : 'pointer',
                fontSize: 11,
                fontWeight: 500,
                lineHeight: 1,
                flexShrink: 0,
              }}
              title={enterPending
                ? 'Waiting for dictation delivery…'
                : isPrimaryHistoryAgent
                  ? `Send visible History input to ${sessionType === 'codex' ? 'Codex' : 'Claude'}`
                  : `Send Enter to ${sessionType === 'codex' ? 'Codex' : 'Claude'}`}
            >
              {enterPending ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"
                     style={{ animation: 'mic-spin 0.7s linear infinite' }}
                     aria-hidden>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : 'Enter'}
            </button>
            </ControlHint>
            <ControlHint
              label={isPrimaryHistoryAgent ? 'Остановить текущий ответ' : 'Отправить Ctrl+C в живой CLI'}
              shortcut={isPrimaryHistoryAgent ? 'Процесс останется запущен' : 'Результат зависит от текущего экрана'}
              disabled={isPrimaryHistoryAgent && !historyCanInterruptTurn}
            >
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={sendStopCurrentTurn}
              disabled={isPrimaryHistoryAgent && !historyCanInterruptTurn}
              aria-label={isPrimaryHistoryAgent
                ? `Stop current ${sessionType === 'codex' ? 'Codex' : 'Claude'} response`
                : `Send Ctrl+C to ${sessionType === 'codex' ? 'Codex' : 'Claude'}`}
              className={`inline-flex items-center justify-center gap-1 transition-colors ${isPrimaryHistoryAgent && !historyCanInterruptTurn ? '' : 'cursor-pointer'}`}
              style={{
                height: 22,
                minWidth: 34,
                padding: '0 7px',
                background: 'transparent',
                border: '1px solid rgba(248,113,113,0.30)',
                borderRadius: 4,
                color: isPrimaryHistoryAgent && !historyCanInterruptTurn ? '#5f4545' : '#f87171',
                cursor: isPrimaryHistoryAgent && !historyCanInterruptTurn ? 'default' : 'pointer',
                fontSize: 11,
                fontWeight: 650,
                lineHeight: 1,
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                if (isPrimaryHistoryAgent && !historyCanInterruptTurn) return;
                const el = e.currentTarget as HTMLButtonElement;
                el.style.backgroundColor = 'rgba(248,113,113,0.12)';
                el.style.borderColor = 'rgba(248,113,113,0.58)';
                el.style.color = '#fecaca';
              }}
              onMouseLeave={(e) => {
                if (isPrimaryHistoryAgent && !historyCanInterruptTurn) return;
                const el = e.currentTarget as HTMLButtonElement;
                el.style.backgroundColor = 'transparent';
                el.style.borderColor = 'rgba(248,113,113,0.30)';
                el.style.color = '#f87171';
              }}
              title={isPrimaryHistoryAgent
                ? (historyCanInterruptTurn ? 'Stop the current response' : 'No interruptible response')
                : `Send Ctrl+C to ${sessionType === 'codex' ? 'Codex' : 'Claude'} - clears input first if it is not empty`}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  backgroundColor: 'currentColor',
                  display: 'inline-block',
                }}
              />
              <span>^C</span>
            </button>
            </ControlHint>
          </div>
        )}

        {/* Context meter — pushes to far right of LEFT cluster via flex spacer.
            Полоска убрана: места мало (control bar 30px, юзеру важна цифра, а
            не визуальный объём). Только цветной процент: цвет даёт градиент
            здоровья (зелёный → амбер → красный), сама цифра — точное значение. */}
        <div style={{ flex: 1 }} />
        {showCacheChip && <CacheCooldownChip data={cacheData!} busy={cacheBusy} />}
        {/* Vertical divider — only when BOTH chip and context% are present, so a
            lone separator never floats next to a single value. Same hairline
            style as the session-pill divider above. */}
        {showCacheChip && contextPct > 0 && (
          <span style={{ width: 1, alignSelf: 'center', height: '70%', backgroundColor: 'rgba(255,255,255,0.12)', flexShrink: 0 }} />
        )}
        {contextPct > 0 ? (
          <ControlHint label={`Использовано ${contextPct.toFixed(0)}% контекстного окна`}>
          <span
            style={{ fontSize: 11, color: meterColor, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
            title="Context usage"
          >
            {contextPct.toFixed(0)}%
          </span>
          </ControlHint>
        ) : null}
      </div>

      {/* RIGHT: dropdowns. Два блокирующих состояния:
          • isLocalBusy → shimmer-overlay через ::after для локальной операции
            с настройками/управлением.
          • isBusy → write lock для локальной операции или prompt paste.
          • PTY new: нет sessionId и нет живого процесса → кластер скрыт целиком,
            чтобы новая вкладка не показывала дефолтные Claude-модели перед выбором
            Claude/Codex.
          • PTY idle with session: !isCommandRunning → opacity 0.4. Provider/Model/Effort/Think
            применяются slash-командами в живой TUI; когда процесс убит, БД
            хранит session row, но TUI нет — команды улетят в мёртвый shell
            и потеряются. SessionActionChip справа от этого кластера
            ориентируется на тот же сигнал (показывает Continue вместо Stop).
          • SDK: **всегда enabled**. SDK таб не имеет PTY — model/effort/
            think применяются параметром при следующем `query()` вызове
            (см. fact-claude-sdk-tab.md). Юзер может выбрать модель ДО
            первого сообщения; настройки персистятся в Tab.sdk* полях.
            Привязывать к hasAnySession неправильно: новый SDK таб без
            session_id всё равно должен позволять выбрать модель — иначе
            юзер видит disabled кнопки и видит хвостовой «Start» на чипе,
            хотя SDK уже готов принять prompt.
          • Codex: `/model` нативно разрешён во время streaming и меняет
            настройку сессии для следующей работы. Отдельный Effort остаётся
            disabled: модельный picker выбирает совместимый effort атомарно.
            `/fast` — отдельная live-команда, которую Codex не принимает во
            время streaming, поэтому она disabled до завершения turn. */}
      {showRightCluster && (() => {
        const canControl = isSDKTab ? true : isCommandRunning;
        const modelOptions = isCodex ? visibleCodexModels : (isSDKTab || isAnthropicPTY) ? visibleClaudeModels : activeProvider.models;
        const supportsModelEffortPair = isCodex || isSDKTab || (sessionType === 'claude' && isAnthropicPTY);
        return (
        <div
          className={isLocalBusy ? 'control-bar-busy-overlay' : undefined}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            pointerEvents: (isBusy || !canControl) ? 'none' : 'auto',
            opacity: !canControl ? 0.4 : 1,
            transition: 'opacity 0.15s',
          }}
          aria-busy={isLocalBusy}
        >
          {/* Click-to-reset escape hatch — covers the WHOLE cluster only while a
              local settings/control operation is busy. Parent sets
              pointer-events:none; this re-enables itself (CSS) and sits above
              the shimmer. Hover = red "СБРОС", click force-clears a stuck
              local-control loader. See forceResetBusy + fact-claude-control-bar.md. */}
          {isLocalBusy && (
            <div
              className="control-bar-busy-reset"
              onClick={forceResetBusy}
              title="Сбросить зависший индикатор (loader не сбросился сам)"
            >
              СБРОС
            </div>
          )}
          {/* Provider — only for PTY tabs */}
          {!isSDKTab && !isCodex && (
            <div style={{ position: 'relative' }}>
              <button
                {...triggerProps('provider')}
                style={{
                  ...triggerStyle,
                  color: activeProvider.tint,
                  borderColor: `${activeProvider.tint}66`,
                  backgroundColor: `${activeProvider.tint}1F`,
                  padding: '0 6px',
                  gap: 3,
                }}
                title={`Provider: ${activeProvider.label} (клик закрепит, ⌘+наведение откроет временно)`}
              >
                <activeProvider.Icon size={12} color={activeProvider.tint} />
                <span style={{ opacity: 0.6, fontSize: 9 }}>▴</span>
              </button>
              {openPopup === 'provider' && renderControlPopup('provider',
                PROVIDER_CATALOG.map(p => {
                      const active = p.id === providerState.type;
                      return (
                        <button
                          key={p.id}
                          style={{
                            ...pillStyle(active, false),
                            color: active ? '#fff' : p.tint,
                            backgroundColor: active ? p.tint : 'transparent',
                            borderWidth: 1,
                            borderStyle: 'solid',
                            borderColor: active ? p.tint : 'rgba(255,255,255,0.08)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                          onClick={() => pickProvider(p.id)}
                        >
                          <p.Icon size={11} color={active ? '#fff' : p.tint} />
                          <span>{p.label}</span>
                        </button>
                      );
                    })
              )}
            </div>
          )}

          {showQuickPresetControl && (
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                ref={quickPresetButtonRef}
                type="button"
                disabled={quickPresetDisabled || !hasQuickPreset}
                onClick={quickPresetIsCodex ? toggleQuickCodexPreset : toggleQuickClaudePreset}
                onMouseEnter={(event) => {
                  setQuickPresetHover(true);
                  const rect = event.currentTarget.getBoundingClientRect();
                  setQuickPresetRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
                }}
                onMouseLeave={() => {
                  setQuickPresetHover(false);
                  setQuickPresetRect(null);
                }}
                aria-label={`Быстро переключить модель ${quickPresetIsCodex ? 'Codex' : 'Claude'}`}
                title={quickPresetDisabled
                  ? (quickPresetIsCodex
                    ? (isCommandRunning
                      ? 'Быстрое переключение станет доступно после подтверждения текущих model и effort'
                      : 'Быстрое переключение доступно только при живом Codex')
                    : (isCommandRunning
                      ? 'Быстрое переключение доступно только для Claude'
                      : 'Быстрое переключение станет доступно после запуска Claude'))
                  : !hasQuickPreset
                    ? 'Задайте модель и effort для быстрого переключения в Настройках'
                    : quickPresetApplied && quickPresetMatchesCurrent
                      ? 'Вернуть прежнюю модель и effort'
                      : `Переключить на ${quickPresetModel?.label} / ${quickPresetEffort}`}
                style={{
                  ...triggerStyle,
                  width: 22,
                  padding: 0,
                  justifyContent: 'center',
                  color: quickPresetDisabled || !hasQuickPreset ? '#555' : quickPresetApplied && quickPresetMatchesCurrent ? '#fff' : quickPresetIsCodex ? '#9ce8c4' : '#f0b098',
                  borderColor: quickPresetApplied && quickPresetMatchesCurrent ? '#fff' : quickPresetIsCodex ? 'rgba(52,211,153,0.48)' : 'rgba(218,119,86,0.5)',
                  backgroundColor: quickPresetApplied && quickPresetMatchesCurrent ? (quickPresetIsCodex ? 'rgba(52,211,153,0.24)' : 'rgba(218,119,86,0.25)') : 'transparent',
                  cursor: quickPresetDisabled || !hasQuickPreset ? 'not-allowed' : 'pointer',
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M17 3l4 4-4 4" />
                  <path d="M3 7h18" />
                  <path d="M7 21l-4-4 4-4" />
                  <path d="M21 17H3" />
                </svg>
              </button>
              {showQuickPresetTooltip && quickPresetButtonRef.current && createPortal(
                <CenteredUpwardPopover
                  getAnchorRect={() => quickPresetButtonRef.current?.getBoundingClientRect() || null}
                  zIndex={10060}
                  style={{ pointerEvents: 'none' }}
                >
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 5, border: `1px solid ${quickPresetIsCodex ? 'rgba(52,211,153,0.4)' : 'rgba(218,119,86,0.4)'}`, background: '#101010', color: quickPresetIsCodex ? '#dcffe9' : '#ffe3d7', boxShadow: '0 8px 24px rgba(0,0,0,0.45)', fontSize: 11, whiteSpace: 'nowrap' }}>
                    <span>{quickPresetModel?.label}</span>
                    <span style={{ color: quickPresetIsCodex ? '#34D399' : '#DA7756', fontWeight: 700 }}>{quickPresetEffort === 'medium' ? 'med' : quickPresetEffort === 'xhigh' ? 'xhi' : quickPresetEffort === 'ultracode' ? 'ultra' : quickPresetEffort}</span>
                  </div>
                </CenteredUpwardPopover>,
                document.body,
              )}
            </div>
          )}

          {/* Model */}
          <div style={{ position: 'relative' }}>
            <button
              {...triggerProps('model')}
              disabled={codexModelMenuDisabled}
              style={{
                ...triggerStyle,
                ...(pinnedPopup === 'model' && !codexModelMenuDisabled ? {
                  borderColor: '#fff',
                  boxShadow: '0 0 0 1px rgba(255,255,255,0.14)',
                } : {}),
                ...(codexModelMenuDisabled ? {
                  color: '#555',
                  borderColor: 'rgba(255,255,255,0.08)',
                  backgroundColor: '#222',
                  cursor: 'not-allowed',
                } : {}),
              }}
              title={codexModelMenuDisabled
                ? 'Model доступен только при живом Codex'
                : codexModelDisabled
                  ? 'Текущая пара не подтверждена: наведите на модель и выберите model + effort вместе'
                : codexTurnBusy
                  ? 'Model можно сменить во время streaming; выбор применяется к следующей работе сессии'
                  : 'Наведите для выбора; клик закрепит меню'}
            >
              <span style={{ color: codexModelMenuDisabled ? '#666' : '#fff' }}>{modelLabel}</span>
              <span style={{ opacity: codexModelMenuDisabled ? 0.25 : 0.6 }}>▴</span>
            </button>
            {openPopup === 'model' && renderControlPopup('model',
              supportsModelEffortPair ? (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {modelOptions.map((model) => {
                    const active = model.id === modelActiveId;
                    const modelPairDisabled = isCodex && codexModelDisabled;
                    return (
                      <button
                        key={model.id}
                        disabled={isCodex && codexModelMenuDisabled}
                        aria-disabled={modelPairDisabled}
                        style={pillStyle(active, modelPairDisabled)}
                        onMouseEnter={(event) => {
                          setHoveredModelMenuModel(model.id);
                          setHoveredModelMenuAnchor(event.currentTarget);
                        }}
                        onClick={() => {
                          if (!modelPairDisabled) pickModel(model.id);
                        }}
                        title={modelPairDisabled
                          ? `Наведите и выберите ${model.label} вместе с effort`
                          : `Наведите и выберите ${model.label} с effort`}
                      >{model.label}</button>
                    );
                  })}
                </div>
              ) : modelOptions.map((model) => {
                const active = model.id === modelActiveId;
                return (
                  <button
                    key={model.id}
                    disabled={codexModelDisabled}
                    style={pillStyle(active, codexModelDisabled)}
                    onClick={() => pickModel(model.id)}
                  >{model.label}</button>
                );
              })
            )}
            {supportsModelEffortPair && openPopup === 'model' && hoveredModelMenuAnchor && (() => {
              const hoveredCodexModel = codexModels.find((model) => model.id === hoveredModelMenuModel);
              const hoveredClaudeModel = claudeCodeModels.find((model) => model.id === hoveredModelMenuModel);
              const hoveredModel = isCodex ? hoveredCodexModel : hoveredClaudeModel;
              const hoveredEfforts = isCodex
                ? (hoveredCodexModel?.efforts || [])
                : claudeEffortsForModel(hoveredClaudeModel);
              const modelEffortPairDisabled = isCodex && codexExplicitPairDisabled;
              if (!hoveredModel || hoveredEfforts.length === 0) return null;
              return createPortal(
                <CenteredUpwardPopover
                  ref={(node) => { modelEffortPopupRef.current = node; }}
                  getAnchorRect={() => hoveredModelMenuAnchor.getBoundingClientRect()}
                  horizontalAlign="end"
                  gap={4}
                  zIndex={10055}
                  style={{ width: 'max-content' }}
                  onMouseEnter={() => setHoveredPopup('model')}
                  onMouseLeave={(event) => {
                    const related = event.relatedTarget;
                    if (
                      related instanceof Node
                      && popupRefs.current.model?.contains(related)
                    ) {
                      setHoveredPopup('model');
                      return;
                    }
                    setHoveredPopup((current) => (current === 'model' ? null : current));
                    setHoveredModelMenuModel(null);
                    setHoveredModelMenuAnchor(null);
                  }}
                >
                  <div
                    aria-label={`Effort для ${hoveredModel.label}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      width: 'max-content',
                      maxWidth: '100%',
                      padding: 4,
                      backgroundColor: '#1f1f1f',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 4,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {hoveredEfforts.map((effort) => (
                      <button
                        key={effort}
                        type="button"
                        disabled={modelEffortPairDisabled}
                        onClick={() => isCodex
                          ? pickCodexModelEffort(hoveredModel.id, effort)
                          : pickClaudeModelEffort(hoveredModel.id, effort)}
                        style={pillStyle(hoveredModel.id === modelActiveId && effort === effortActive, modelEffortPairDisabled)}
                        title={`Выбрать ${hoveredModel.label} / ${effort}`}
                      >
                        {effort === 'medium' ? 'med' : effort === 'xhigh' ? 'xhi' : effort}
                      </button>
                    ))}
                  </div>
                </CenteredUpwardPopover>,
                document.body,
              );
            })()}
          </div>

          {/* Effort. Dimmed (but still clickable) when Think is OFF — effort
              only takes effect during reasoning, so visually telegraphing that
              the value won't matter right now. Не disabled: юзер может пресет-
              нуть Effort заранее, потом включить Think. */}
          {/* Effort — inline pill row instead of a dropdown. The configured
              model decides which levels appear here; changing model chooses a
              compatible level when the previous one is unavailable. */}
          <ControlHint
            label="Выбрать глубину рассуждения"
            shortcut={!thinkActive ? 'Применяется, когда Think включён' : undefined}
            disabled={codexEffortDisabled}
          >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              opacity: !thinkActive ? 0.4 : 1,
              transition: 'opacity 0.12s',
            }}
            title={!thinkActive
              ? 'Effort применяется только когда Think включён'
              : 'Effort level'}
          >
            {effortLevels.map(level => {
              const active = effortActive === level;
              const isUltra = level === 'ultracode' || (isCodex && level === 'ultra');
              const label = isUltra ? 'ultra'
                : level === 'medium' ? 'med'
                : level === 'xhigh' ? 'xhi'
                : level;
              const title = isUltra
                ? isCodex
                  ? 'ultra — максимальное размышление и проактивная работа с несколькими агентами; расход может быстро вырасти.'
                  : 'ultracode — xhigh + авто dynamic-workflows на всю сессию (Claude сам решает когда запускать workflow). Дорого по токенам; сбрасывается в начале новой сессии.'
                : level;
              // ultracode pill: purple accent (matches workflow chip), separated
              // from the plain levels by a thin divider so it reads as a mode.
              const ultraStyle = isUltra ? {
                ...pillStyle(active, false),
                ...(active
                  ? { backgroundColor: '#7c5cd6', borderColor: '#a78bfa', color: '#fff' }
                  : { color: '#a78bfa', borderColor: 'rgba(167,139,250,0.4)' }),
              } : pillStyle(active, false);
              return (
                <React.Fragment key={level}>
                  {isUltra && <span aria-hidden style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.12)', margin: '2px 2px' }} />}
                  <button
                    disabled={codexEffortDisabled}
                    style={isUltra ? {
                      ...ultraStyle,
                      ...(codexEffortDisabled ? { color: '#555', backgroundColor: '#222', borderColor: 'rgba(255,255,255,0.08)', cursor: 'not-allowed' } : {}),
                    } : {
                      ...pillStyle(active, codexEffortDisabled),
                      ...(codexEffortDisabled ? { color: '#555', backgroundColor: '#222', cursor: 'not-allowed' } : {}),
                    }}
                    title={title}
                    onClick={() => pickEffort(level)}
                  >{label}</button>
                </React.Fragment>
              );
            })}
          </div>
          </ControlHint>

          {isCodex && (
            <ControlHint label="Переключить быстрый режим Codex" disabled={codexFastDisabled}>
            <button
              type="button"
              aria-label="Send /fast to Codex"
              title={!isCommandRunning
                ? '/fast доступен только при живом Codex'
                : 'Send /fast to Codex'}
              disabled={codexFastDisabled}
              onClick={sendCodexFast}
              style={{
                ...triggerStyle,
                width: 24,
                padding: 0,
                justifyContent: 'center',
                color: codexFastDisabled ? '#555' : '#bbb',
                borderColor: codexFastDisabled ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.12)',
                backgroundColor: 'transparent',
                cursor: codexFastDisabled ? 'not-allowed' : triggerStyle.cursor,
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M13 2 4 14h7l-1 8 10-13h-7l0-7Z" />
              </svg>
            </button>
            </ControlHint>
          )}

	          {/* Think — single toggle, no dropdown */}
          {!isDeepSeekPTY && !isCodex && (
            <ControlHint label={thinkActive ? 'Выключить Think' : 'Включить Think'}>
            <button
              style={{
                ...triggerStyle,
                color: thinkActive ? '#fff' : '#888',
                borderColor: thinkActive ? '#DA7756' : 'rgba(255,255,255,0.08)',
                backgroundColor: thinkActive ? 'rgba(218,119,86,0.18)' : 'transparent',
              }}
              onClick={toggleThink}
              title="Think mode"
            >
              Think
            </button>
            </ControlHint>
          )}
        </div>
        );
      })()}

    </div>
  );
}

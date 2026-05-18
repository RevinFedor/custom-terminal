import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import {
  CLAUDE_EFFORT_LEVELS,
  DEEPSEEK_EFFORT_LEVELS,
} from '../../constants/claudeLevels';
import { PROVIDER_CATALOG, getSupportedEffortsForAlias } from './providerCatalog';
import SessionActionChip from './SessionActionChip';
import { useCmdKey } from '../../hooks/useCmdHoverPopover';

const { ipcRenderer } = window.require('electron');

interface Props {
  tabId: string;
  // Session info — supplied by Workspace.tsx via effective* selectors.
  claudeSessionId: string | null;
  geminiSessionId: string | null;
  commandType: string | null;     // 'claude' | 'gemini' | etc — used to label SessionActionChip
  isCommandRunning: boolean;
  projectPath?: string;
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
  claudeSessionId,
  geminiSessionId,
  commandType,
  isCommandRunning,
  projectPath,
}: Props) {
  const showToast = useUIStore((s) => s.showToast);
  // sessionType is never null — when there's no session yet we use commandType
  // (or default 'claude' for SDK / fresh tabs) so the chip can still render
  // "Start Claude" / "Start Gemini" and spawn the right process on click.
  const sessionType: 'claude' | 'gemini' = claudeSessionId
    ? 'claude'
    : geminiSessionId ? 'gemini'
    : commandType === 'gemini' ? 'gemini'
    : 'claude';
  const sessionId = claudeSessionId || geminiSessionId;
  const hasAnySession = !!sessionId;
  const [sessionCopied, setSessionCopied] = useState(false);
  const copySessionId = () => {
    if (!sessionId) return;
    navigator.clipboard.writeText(sessionId);
    setSessionCopied(true);
    setTimeout(() => setSessionCopied(false), 1000);
  };
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
  const sdkThinking = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.sdkThinking !== false;
    }
    return true;
  });
  const isSDKTab = tabType === 'claude-sdk';

  // Live bridge data (PTY only): model name + context %.
  const [claudeModel, setClaudeModel] = useState<string | null>(null);
  const [contextPct, setContextPct] = useState<number>(0);
  useEffect(() => {
    setClaudeModel(null);
    setContextPct(0);
    const handler = (_: any, data: { tabId: string; model: string; contextPct: number }) => {
      if (data.tabId !== tabId) return;
      setClaudeModel(data.model);
      setContextPct(data.contextPct);
    };
    ipcRenderer.on('claude:bridge-update', handler);
    return () => { ipcRenderer.removeListener('claude:bridge-update', handler); };
  }, [tabId]);

  // SDK tab: context % lives in ClaudeSDKTab local state. It re-emits a window
  // CustomEvent('sdk-context-update', {tabId, contextPct, model}) on every
  // assistant SSE — same pattern as the existing 'history-panel:loading' event.
  // Keeps Tab interface untouched (no SQLite schema bump).
  useEffect(() => {
    if (!isSDKTab) return;
    const handler = (e: Event) => {
      const { tabId: t, contextPct: c, model: m } = (e as CustomEvent).detail || {};
      if (t !== tabId) return;
      if (typeof c === 'number') setContextPct(c);
      if (m) setClaudeModel(m);
    };
    window.addEventListener('sdk-context-update', handler);
    return () => window.removeEventListener('sdk-context-update', handler);
  }, [tabId, isSDKTab]);

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

  // PTY effort/think — local UI mirror that follows auto-inject + finish events.
  const [effortLocal, setEffortLocal] = useState<string | undefined>(undefined);
  const [thinkLocal, setThinkLocal] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (isSDKTab) return;
    const onStarted = (_: any, data: { tabId: string }) => {
      if (data.tabId !== tabId) return;
      const eff = useUIStore.getState().defaultClaudeEffort;
      if (eff && eff !== 'none') setEffortLocal(eff);
    };
    const onFinished = (_: any, data: { tabId: string }) => {
      if (data.tabId !== tabId) return;
      setEffortLocal(undefined);
      setThinkLocal(undefined);
    };
    ipcRenderer.on('claude:process-started', onStarted);
    ipcRenderer.on('terminal:command-finished', onFinished);
    return () => {
      ipcRenderer.removeListener('claude:process-started', onStarted);
      ipcRenderer.removeListener('terminal:command-finished', onFinished);
    };
  }, [tabId, isSDKTab]);

  // SDK model caps — gates effort pills per-model. Fetch once per mount when
  // the tab is an SDK tab; main process caches the result for the Electron
  // lifetime so it's a fast no-op on repeat calls.
  //
  // IMPORTANT: `sdkModelCaps` MUST NOT be a dep here. If main returns
  // `{success:true, caps:{}}`, setSdkModelCaps({}) bumps the ref → effect
  // re-fires → another invoke → new {} → infinite loop. Confirmed via
  // [CB:R] render counter.
  const [sdkModelCaps, setSdkModelCaps] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!isSDKTab) return;
    ipcRenderer.invoke('claude-sdk:get-model-caps').then((r: any) => {
      if (r?.success && r.caps && Object.keys(r.caps).length > 0) setSdkModelCaps(r.caps);
    }).catch(() => {});
  }, [isSDKTab]);

  // Paste/control busy mirror — disables all writes while another caller mid-paste.
  const [isPasteBusy, setIsPasteBusy] = useState(false);
  const [isLocalBusy, setIsLocalBusy] = useState(false);
  const isBusy = isPasteBusy || isLocalBusy;
  useEffect(() => {
    const handler = (_: any, data: { tabId: string; busy: boolean }) => {
      if (data.tabId === tabId) setIsPasteBusy(data.busy);
    };
    ipcRenderer.on('claude:paste-busy', handler);
    return () => { ipcRenderer.removeListener('claude:paste-busy', handler); };
  }, [tabId]);

  const focusTerminal = () => {
    requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());
  };

  // ===== derived state =====
  const activeProvider = useMemo(
    () => PROVIDER_CATALOG.find(p => p.id === providerState.type) || PROVIDER_CATALOG[0],
    [providerState.type]
  );
  const isAnthropicPTY = !isSDKTab && providerState.type === 'anthropic';
  const isDeepSeekPTY = !isSDKTab && providerState.type === 'deepseek';
  const supportsKnobs = isSDKTab || isAnthropicPTY || isDeepSeekPTY;

  const effortLevels = isDeepSeekPTY ? DEEPSEEK_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;

  const sdkSupportedEfforts = isSDKTab
    ? getSupportedEffortsForAlias(sdkModel, sdkModelCaps)
    : null;

  // Model active id
  const lm = claudeModel?.toLowerCase() || '';
  const modelActiveId: string = (() => {
    if (isSDKTab) return sdkModel || 'default';
    if (isAnthropicPTY) {
      if (lm.includes('1m context')) return 'default';
      if (lm.includes('opus')) return 'opus';
      if (lm.includes('sonnet')) return 'sonnet';
      if (lm.includes('haiku')) return 'haiku';
      return 'default';
    }
    return providerState.model || activeProvider.models[0]?.id || '';
  })();

  const effortActive: string | undefined = (() => {
    if (isSDKTab) return sdkEffort;
    if (isDeepSeekPTY) return providerState.effort || 'medium';
    return effortLocal;
  })();

  const thinkActive: boolean = (() => {
    if (isSDKTab) return sdkThinking;
    return thinkLocal ?? true;
  })();

  // ===== popup state — tri-mode trigger =====
  // Popup может открыться тремя путями (см. `EffortSelector` в StatusBar.tsx,
  // тот же паттерн):
  //   • Click по chip → pinnedPopup, закрывается click-outside.
  //   • CMD + hover на chip → tempPopup, закрывается отпусканием CMD + увод курсора.
  //   • Курсор на popup'е → popupHover, держит открытым после отпускания CMD.
  // Один popup за раз: переход CMD-hover с одного триггера на другой переключает.
  type PopupKey = 'provider' | 'model' | 'effort';
  const [pinnedPopup, setPinnedPopup] = useState<PopupKey | null>(null);
  const [hoveredTrigger, setHoveredTrigger] = useState<PopupKey | null>(null);
  const [hoveredPopup, setHoveredPopup] = useState<PopupKey | null>(null);
  const isCmdPressed = useCmdKey();

  // Derived: какой popup сейчас визуально открыт.
  const openPopup: PopupKey | null =
    pinnedPopup
    ?? (isCmdPressed && hoveredTrigger ? hoveredTrigger : null)
    ?? hoveredPopup;

  const rootRef = useRef<HTMLDivElement>(null);
  // Refs на каждый trigger + popup для geometric bridge (mousemove hit-test).
  const triggerRefs = useRef<Record<PopupKey, HTMLButtonElement | null>>({ provider: null, model: null, effort: null });
  const popupRefs = useRef<Record<PopupKey, HTMLDivElement | null>>({ provider: null, model: null, effort: null });

  // Click-outside закрывает только pinned popup (CMD-hover закрывается по
  // отпусканию CMD сам).
  useEffect(() => {
    if (!pinnedPopup) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPinnedPopup(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
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
        if (t && x >= t.left && x <= t.right && y >= t.top && y <= t.bottom) {
          newTrigger = key;
        }
        if (p && x >= p.left && x <= p.right && y >= p.top && y <= p.bottom) {
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

  // Click на trigger toggle'ит pinned-state. Если popup был открыт через
  // CMD-hover — клик его «закрепляет» (становится pinned, остаётся открытым
  // после отпускания CMD). Если был уже pinned тот же — закрывает.
  const togglePinned = (key: PopupKey) => {
    setPinnedPopup((cur) => (cur === key ? null : key));
  };

  // ===== handlers =====
  const setEffortOnPTY = async (level: string) => {
    setIsLocalBusy(true);
    setEffortLocal(level);
    try { await ipcRenderer.invoke('claude:send-command', tabId, '/effort ' + level); }
    finally { setIsLocalBusy(false); focusTerminal(); }
  };

  const setEffortOnDeepSeek = async (level: string) => {
    setIsLocalBusy(true);
    try {
      const r = await ipcRenderer.invoke('provider:set-options', { tabId, effort: level });
      if (r) setProviderState(r);
    } finally { setIsLocalBusy(false); focusTerminal(); }
  };

  const pickModel = async (mid: string) => {
    setOpenPopup(null);
    if (isBusy) return;
    if (isSDKTab) {
      const store = useWorkspaceStore.getState();
      store.updateSDKState(tabId, { sdkModel: mid });
      const supported = getSupportedEffortsForAlias(mid, sdkModelCaps);
      const cur = sdkEffort || 'high';
      if (supported && !supported.has(cur)) {
        const fallback = ['xhigh', 'high', 'medium', 'low'].find(e => supported.has(e)) || 'high';
        store.updateSDKState(tabId, { sdkEffort: fallback });
      }
      focusTerminal();
      return;
    }
    if (activeProvider.id === 'anthropic') {
      setIsLocalBusy(true);
      try { await ipcRenderer.invoke('claude:send-command', tabId, '/model ' + mid); }
      finally { setIsLocalBusy(false); focusTerminal(); }
    } else {
      setIsLocalBusy(true);
      providerMemoryRef.current[activeProvider.id] = mid;
      try {
        const r = await ipcRenderer.invoke('provider:switch', { tabId, type: activeProvider.id, model: mid });
        if (r) setProviderState(r);
      } finally { setIsLocalBusy(false); focusTerminal(); }
    }
  };

  const pickEffort = async (level: string) => {
    setOpenPopup(null);
    if (isBusy) return;
    if (isSDKTab) {
      useWorkspaceStore.getState().updateSDKState(tabId, { sdkEffort: level });
      focusTerminal();
    } else if (isDeepSeekPTY) {
      await setEffortOnDeepSeek(level);
    } else {
      await setEffortOnPTY(level);
    }
  };

  const pickProvider = async (pid: string) => {
    setOpenPopup(null);
    if (isBusy || isSDKTab) return;
    setIsLocalBusy(true);
    try {
      if (pid === 'anthropic') {
        const r = await ipcRenderer.invoke('provider:switch', { tabId, type: 'anthropic' });
        if (r) setProviderState(r);
      } else {
        const remembered = providerMemoryRef.current[pid] || PROVIDER_CATALOG.find(p => p.id === pid)?.models[0]?.id;
        const r = await ipcRenderer.invoke('provider:switch', { tabId, type: pid, model: remembered });
        if (r) setProviderState(r);
      }
    } finally { setIsLocalBusy(false); focusTerminal(); }
  };

  const toggleThink = async () => {
    if (isBusy) return;
    if (isSDKTab) {
      const cur = sdkThinking;
      useWorkspaceStore.getState().updateSDKState(tabId, { sdkThinking: !cur });
      focusTerminal();
      return;
    }
    setIsLocalBusy(true);
    const next = !thinkActive;
    setThinkLocal(next);
    try {
      const r = await ipcRenderer.invoke('claude:toggle-thinking', tabId);
      if (r?.success && typeof r.thinking === 'boolean') setThinkLocal(r.thinking);
    } finally { setIsLocalBusy(false); focusTerminal(); }
  };

  // ===== Session lifecycle handlers (Start / Continue / Stop / Refresh / Fork) =====

  // Spawn a fresh Claude (or Gemini) process in this tab. Used when there's
  // no session yet — replaces the old "click chip → copy empty id" no-op.
  // SDK tabs already have an in-app composer, so we just focus it instead.
  const onStart = () => {
    if (!tabId) return;
    if (isSDKTab) {
      window.dispatchEvent(new CustomEvent('claude-sdk:focus-composer', { detail: { tabId } }));
      return;
    }
    const store = useWorkspaceStore.getState();
    terminalRegistry.get(tabId)?.scrollToBottom();
    if (sessionType === 'gemini') {
      store.setTabCommandType(tabId, 'gemini');
      ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd: projectPath, yesMode: true });
    } else {
      store.setTabCommandType(tabId, 'claude');
      ipcRenderer.send('claude:run-command', { tabId, command: 'claude' });
    }
  };

  const onContinue = () => {
    if (!tabId) return;
    if (isSDKTab) {
      window.dispatchEvent(new CustomEvent('claude-sdk:focus-composer', { detail: { tabId } }));
      return;
    }
    const store = useWorkspaceStore.getState();
    if (sessionType === 'claude') {
      store.setTabCommandType(tabId, 'claude');
      terminalRegistry.get(tabId)?.scrollToBottom();
      window.dispatchEvent(new CustomEvent('timeline:scroll-to-bottom', { detail: { tabId } }));
      ipcRenderer.send('claude:run-command', { tabId, command: 'claude-c', sessionId: claudeSessionId });
    } else if (sessionType === 'gemini') {
      store.setTabCommandType(tabId, 'gemini');
      terminalRegistry.get(tabId)?.scrollToBottom();
      window.dispatchEvent(new CustomEvent('timeline:scroll-to-bottom', { detail: { tabId } }));
      ipcRenderer.send('gemini:run-command', { tabId, command: 'gemini-c', sessionId: geminiSessionId });
    }
  };

  const onStop = async () => {
    if (!tabId) return;
    if (isSDKTab) {
      try {
        await ipcRenderer.invoke('claude-sdk:stop', { tabId });
        window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId } }));
      } catch (e: any) { console.error('[SDKStop] error', e); }
      return;
    }
    try {
      const res = await ipcRenderer.invoke('terminal:stop-ai-process', tabId);
      if (!res?.success) console.warn('[SessionStop] failed:', res?.error);
    } catch (e: any) { console.error('[SessionStop] error', e); }
  };

  const refreshTimeline = () => {
    window.dispatchEvent(new CustomEvent('timeline:force-refresh', { detail: { tabId } }));
  };

  const forkToTab = async () => {
    if (!sessionId || !tabId || !sessionType) return;
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        const currentCwd = tab.cwd || projectPath || '';
        const forkName = tab.name ? `${tab.name}_fork` : undefined;
        await state.createTabAfterCurrent(projectId, forkName, currentCwd, {
          pendingAction: { type: sessionType === 'claude' ? 'claude-fork' : 'gemini-fork', sessionId },
          nameSetManually: !!forkName,
        });
        showToast(`Fork ${sessionType === 'claude' ? 'Claude' : 'Gemini'} → ${forkName || 'новая вкладка'}`, 'success');
        break;
      }
    }
  };

  const forkToSDK = async () => {
    if (!sessionId || !tabId || sessionType !== 'claude') return;
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) {
        const currentCwd = tab.cwd || projectPath || '';
        const forkResult = await ipcRenderer.invoke('claude:fork-session-file', { sourceSessionId: sessionId, cwd: currentCwd, skipChainResolve: true });
        if (!forkResult.success) { showToast('Fork failed: ' + forkResult.error, 'error'); return; }
        const sdkTabId = await state.createSDKTab(projectId);
        state.updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
        showToast('SDK fork ← ' + sessionId.slice(0, 8), 'success');
        break;
      }
    }
  };

  // ===== Prompt copy / clear (Claude only — Gemini has no equivalent IPC). =====
  const handleCopyPrompt = async (clearAfter: boolean) => {
    if (!tabId || sessionType !== 'claude') return;
    try {
      const res = await ipcRenderer.invoke('claude:copy-input', tabId);
      if (res?.success && typeof res.text === 'string') {
        const t = res.text;
        if (!t.trim()) { showToast('Claude input is empty', 'warning'); return; }
        const { clipboard } = window.require('electron');
        const annotated = res.images > 0 ? t + `\n\n[note: ${res.images} image(s) not copied]` : t;
        clipboard.writeText(annotated);
        const oneLine = t.replace(/\s+/g, ' ').trim();
        const preview = oneLine.length > 20 ? oneLine.slice(0, 20) + '…' : oneLine;
        const verb = clearAfter ? 'Copied + cleared' : 'Copied';
        showToast(`${verb}: "${preview}"${res.images ? ` · ${res.images} 📎` : ''}`, 'success', 1800);
        if (clearAfter) {
          focusTerminal();
          ipcRenderer.invoke('claude:clear-input', tabId).catch(() => {});
        }
      } else {
        const code = res?.error || 'timeout';
        const msgs: Record<string, string> = {
          no_claude_session: 'No Claude session',
          claude_busy: 'Claude is busy — wait for response',
          wrong_editor: 'Restart Claude in this tab (editor not wired)',
          stale_pid: 'Claude was restarted in shell — close & reopen this tab',
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
    const m = activeProvider.models.find(m => m.id === modelActiveId);
    return m?.label || modelActiveId || '—';
  })();
  const effortLabel = (effortActive === 'medium' ? 'med' : effortActive === 'xhigh' ? 'xhi' : (effortActive || '—'));

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
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 4,
    cursor: isBusy ? 'wait' : 'pointer',
    transition: 'background-color 0.12s, color 0.12s, border-color 0.12s',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
  };

  // Right-anchored: pills grow leftwards from the trigger's right edge so they
  // stay inside the viewport. Provider/Model/Effort all live in the right
  // cluster of the control bar — left-anchored popups (left: 0) clipped off
  // the right edge of the window for Effort which sits closest to the corner.
  const popupStyle: React.CSSProperties = {
    position: 'absolute',
    right: 0,
    bottom: 'calc(100% + 4px)',
    display: 'flex',
    gap: 4,
    padding: 4,
    backgroundColor: '#1f1f1f',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    whiteSpace: 'nowrap',
    zIndex: 100,
  };

  const pillStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    height: 20,
    padding: '0 8px',
    fontSize: 11,
    fontWeight: active ? 500 : 400,
    color: disabled ? '#555' : active ? '#fff' : '#aaa',
    backgroundColor: active ? '#DA7756' : disabled ? '#222' : '#2d2d2d',
    border: 'none',
    borderRadius: 3,
    cursor: disabled ? 'not-allowed' : 'pointer',
  });

  // ===== render =====
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
        {/* [⎘ Continue/Stop/Start ↻] — copy session id + lifecycle chip + force-refresh.
            Chip всегда виден (даже без сессии — тогда он Start). Copy и Refresh
            прячутся когда сессии нет: «копировать пустой id» и «refresh пустой
            таймлайн» — мёртвые операции, не дезайблнутые но просто отсутствуют. */}
        <div
          className="inline-flex items-center rounded overflow-hidden"
          style={{
            gap: 0,
            border: hasAnySession ? '1px solid rgba(255,255,255,0.10)' : 'none',
            flexShrink: 0,
          }}
        >
          {hasAnySession && (
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
                if (sessionCopied) return;
                const el = e.currentTarget as HTMLSpanElement;
                el.style.color = '#fff';
                el.style.backgroundColor = 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
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
          <SessionActionChip
            sessionType={sessionType}
            isCommandRunning={isCommandRunning}
            hasAnySession={hasAnySession}
            onStart={onStart}
            onContinue={onContinue}
            onStop={onStop}
          />
          {hasAnySession && (
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
          )}
        </div>

        {/* Forks: into new PTY tab (⑂→▭) and into new SDK tab (⑂→SDK).
            SDK fork only for Claude sessions — SDK doesn't run Gemini. */}
        {hasAnySession && (
          <button
            className="text-[10px] px-1.5 py-0.5 rounded text-[#999] hover:text-white cursor-pointer leading-none flex items-center gap-0.5 transition-colors"
            style={{
              backgroundColor: 'transparent',
              border: '1px solid rgba(255,255,255,0.10)',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
            onClick={forkToTab}
            title="Fork в новую вкладку"
          >⑂→<span style={{ fontSize: '11px' }}>▭</span></button>
        )}
        {sessionType === 'claude' && sessionId && (
          <button
            className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer leading-none transition-colors"
            style={{
              color: '#DA7756',
              backgroundColor: 'transparent',
              border: '1px solid rgba(218,119,86,0.30)',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(218,119,86,0.15)'; (e.currentTarget as HTMLButtonElement).style.color = '#FF9466'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = '#DA7756'; }}
            onClick={forkToSDK}
            title="Fork в новый SDK таб"
          >⑂→SDK</button>
        )}

        {/* ⎘ prompt | + clear split-pill — Claude only. Copy current input,
            optionally clear it. Lives in the bar because user wants the input
            actions near other Claude-control affordances, not in the right panel. */}
        {sessionType === 'claude' && tabId && (
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
            <button
              onClick={() => handleCopyPrompt(false)}
              className="inline-flex items-center gap-1 cursor-pointer hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition-colors"
              style={{ padding: '0 8px', background: 'transparent', border: 'none', color: 'inherit' }}
              title="Copy current Claude input"
            >
              <span style={{ fontSize: 12, lineHeight: 1 }}>⎘</span>
              <span>prompt</span>
            </button>
            <span style={{ width: 1, alignSelf: 'center', height: '70%', backgroundColor: 'rgba(255,255,255,0.12)' }} />
            <button
              onClick={() => handleCopyPrompt(true)}
              className="inline-flex items-center gap-0.5 cursor-pointer hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition-colors"
              style={{ padding: '0 8px', background: 'transparent', border: 'none', color: 'inherit' }}
              title="Copy + clear Claude input"
            >
              <span>+</span>
              <span>clear</span>
            </button>
          </div>
        )}

        {/* Context meter — pushes to far right of LEFT cluster via flex spacer.
            Полоска убрана: места мало (control bar 30px, юзеру важна цифра, а
            не визуальный объём). Только цветной процент: цвет даёт градиент
            здоровья (зелёный → амбер → красный), сама цифра — точное значение. */}
        <div style={{ flex: 1 }} />
        {contextPct > 0 ? (
          <span
            style={{ fontSize: 11, color: meterColor, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
            title="Context usage"
          >
            {contextPct.toFixed(0)}%
          </span>
        ) : null}
      </div>

      {/* RIGHT: dropdowns. Два блокирующих состояния:
          • isBusy → shimmer-overlay через ::after (in-flight command).
          • !hasAnySession → opacity 0.4 (юзеру нечего настраивать пока
            процесса нет; провайдер/модель/effort применяются командами в
            живой TUI — без процесса они просто провалятся в shell). Сам
            кластер виден чтобы пользователь видел будущий контекст, но
            клики блокированы pointer-events:none. */}
      {supportsKnobs && (
        <div
          className={isBusy ? 'control-bar-busy-overlay' : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            pointerEvents: (isBusy || !hasAnySession) ? 'none' : 'auto',
            opacity: !hasAnySession ? 0.4 : 1,
            transition: 'opacity 0.15s',
          }}
          aria-busy={isBusy}
        >
          {/* Provider — only for PTY tabs */}
          {!isSDKTab && (
            <div style={{ position: 'relative' }}>
              <button
                style={{
                  ...triggerStyle,
                  color: activeProvider.tint,
                  borderColor: `${activeProvider.tint}66`,
                  backgroundColor: `${activeProvider.tint}1F`,
                }}
                onClick={() => setOpenPopup(openPopup === 'provider' ? null : 'provider')}
              >
                <activeProvider.Icon size={11} color={activeProvider.tint} />
                <span>{activeProvider.label}</span>
                <span style={{ opacity: 0.6 }}>▴</span>
              </button>
              {openPopup === 'provider' && (
                <div style={popupStyle}>
                  {PROVIDER_CATALOG.map(p => {
                    const active = p.id === providerState.type;
                    return (
                      <button
                        key={p.id}
                        style={{
                          ...pillStyle(active, false),
                          color: active ? '#fff' : p.tint,
                          backgroundColor: active ? p.tint : 'transparent',
                          border: `1px solid ${active ? p.tint : 'rgba(255,255,255,0.08)'}`,
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
                  })}
                </div>
              )}
            </div>
          )}

          {/* Model */}
          <div style={{ position: 'relative' }}>
            <button
              style={triggerStyle}
              onClick={() => setOpenPopup(openPopup === 'model' ? null : 'model')}
            >
              <span style={{ color: '#777', fontSize: 10 }}>Model</span>
              <span style={{ color: '#fff' }}>{modelLabel}</span>
              <span style={{ opacity: 0.6 }}>▴</span>
            </button>
            {openPopup === 'model' && (
              <div style={popupStyle}>
                {activeProvider.models.map(m => {
                  const active = m.id === modelActiveId;
                  return (
                    <button
                      key={m.id}
                      style={pillStyle(active, false)}
                      onClick={() => pickModel(m.id)}
                    >{m.label}</button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Effort. Dimmed (but still clickable) when Think is OFF — effort
              only takes effect during reasoning, so visually telegraphing that
              the value won't matter right now. Не disabled: юзер может пресет-
              нуть Effort заранее, потом включить Think. */}
          <div style={{ position: 'relative' }}>
            <button
              style={{ ...triggerStyle, opacity: !thinkActive ? 0.4 : 1 }}
              title={!thinkActive ? 'Effort применяется только когда Think включён' : undefined}
              onClick={() => setOpenPopup(openPopup === 'effort' ? null : 'effort')}
            >
              <span style={{ color: '#777', fontSize: 10 }}>Effort</span>
              <span style={{ color: '#fff' }}>{effortLabel}</span>
              <span style={{ opacity: 0.6 }}>▴</span>
            </button>
            {openPopup === 'effort' && (
              <div style={popupStyle}>
                {effortLevels.map(level => {
                  const active = effortActive === level;
                  const isUnsupported = isSDKTab && sdkSupportedEfforts != null && !sdkSupportedEfforts.has(level);
                  const label = level === 'medium' ? 'med' : level === 'xhigh' ? 'xhi' : level;
                  return (
                    <button
                      key={level}
                      style={pillStyle(active, isUnsupported)}
                      disabled={isUnsupported}
                      title={isUnsupported ? `${level} не поддерживается моделью ${sdkModel}` : undefined}
                      onClick={() => !isUnsupported && pickEffort(level)}
                    >{label}</button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Think — single toggle, no dropdown */}
          {!isDeepSeekPTY && (
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
          )}
        </div>
      )}
    </div>
  );
}

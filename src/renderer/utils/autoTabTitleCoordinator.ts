import { TAB_TITLE_PROMPT_ID, usePromptsStore } from '../store/usePromptsStore';
import {
  subscribePendingAutoTabTitles,
  useWorkspaceStore,
  type PendingAutoTabTitleRegistration,
} from '../store/useWorkspaceStore';
import {
  generateTabTitleFromPrompt,
  readTabTitlePromptFromSession,
} from './generateTabTitle';

const { ipcRenderer } = window.require('electron');

type TabMatch = {
  tab: any;
};

type ActiveSubscription = {
  consumerId: string;
  cwd: string;
};

const pendingKey = (pending: PendingAutoTabTitleRegistration): string => (
  `${pending.tabId}:${pending.toolType}:${pending.sessionId}`
);

const findTab = (tabId: string): TabMatch | null => {
  for (const [, workspace] of useWorkspaceStore.getState().openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) return { tab };
  }
  return null;
};

const currentSessionId = (tab: any, toolType: 'claude' | 'codex'): string => (
  String(toolType === 'codex' ? tab?.codexSessionId || '' : tab?.claudeSessionId || '')
);

let retainCount = 0;
let generation = 0;
let unsubscribePending: (() => void) | null = null;
const activeSubscriptions = new Map<string, ActiveSubscription>();
const pendingByKey = new Map<string, PendingAutoTabTitleRegistration>();
const inFlight = new Set<string>();
const rerunAfterFlight = new Set<string>();

const unsubscribeConsumer = (subscription: ActiveSubscription): void => {
  void ipcRenderer.invoke('agent-transcript:unsubscribe', {
    consumerId: subscription.consumerId,
  }).catch(() => {});
};

const finishPending = (
  pending: PendingAutoTabTitleRegistration,
  reason: string,
): void => {
  const store = useWorkspaceStore.getState();
  if (!store.consumePendingAutoTabTitle(
    pending.tabId,
    pending.toolType,
    pending.sessionId,
  )) {
    store.clearPendingAutoTabTitle(pending.tabId, reason);
  }
};

const attemptAutoTitle = async (key: string, reason: string): Promise<void> => {
  const pending = pendingByKey.get(key);
  if (!pending) return;
  if (inFlight.has(key)) {
    rerunAfterFlight.add(key);
    return;
  }

  const initialMatch = findTab(pending.tabId);
  if (!initialMatch) {
    useWorkspaceStore.getState().clearPendingAutoTabTitle(pending.tabId, 'tab-missing');
    return;
  }
  if (initialMatch.tab.nameSetManually) {
    finishPending(pending, 'manual-name');
    return;
  }
  if (currentSessionId(initialMatch.tab, pending.toolType) !== pending.sessionId) {
    useWorkspaceStore.getState().clearPendingAutoTabTitle(pending.tabId, 'session-mismatch');
    return;
  }
  if (!useWorkspaceStore.getState().getPendingAutoTabTitle(
    pending.tabId,
    pending.toolType,
    pending.sessionId,
  )) return;

  inFlight.add(key);
  let namingVisible = false;
  try {
    const source = await readTabTitlePromptFromSession({
      toolType: pending.toolType,
      sessionId: pending.sessionId,
      cwd: initialMatch.tab.cwd,
      tabId: pending.tabId,
      mode: pending.mode,
      sourceSessionId: pending.sourceSessionId,
      source: 'AutoTabTitleCoordinator',
      reason,
    });
    if (!source.ok || !source.sourcePrompt) {
      // No prompt and a temporary transcript error are both non-terminal: the
      // exact subscription stays armed and the next durable file change tries
      // again. A generation failure is handled below, after a real candidate.
      if (source.reason !== 'no-user-prompt') {
        console.warn(
          '[AutoTabTitleCoordinator] source-unavailable' +
          ' tab=' + pending.tabId.slice(-8) +
          ' tool=' + pending.toolType +
          ' session=' + pending.sessionId.slice(0, 8) +
          ' reason=' + (source.reason || 'unknown') +
          ' error=' + (source.error || '-')
        );
      }
      return;
    }

    // Revalidate after the headless read: the user can rename the tab or a
    // newer session can take ownership while the file is being parsed.
    const beforeGenerate = findTab(pending.tabId);
    if (!beforeGenerate) {
      useWorkspaceStore.getState().clearPendingAutoTabTitle(pending.tabId, 'tab-missing-after-read');
      return;
    }
    if (beforeGenerate.tab.nameSetManually) {
      finishPending(pending, 'manual-name-after-read');
      return;
    }
    if (currentSessionId(beforeGenerate.tab, pending.toolType) !== pending.sessionId) {
      useWorkspaceStore.getState().clearPendingAutoTabTitle(pending.tabId, 'session-changed-after-read');
      return;
    }

    console.warn(
      '[AutoTabTitleCoordinator] candidate' +
      ' tab=' + pending.tabId.slice(-8) +
      ' tool=' + pending.toolType +
      ' session=' + pending.sessionId.slice(0, 8) +
      ' mode=' + pending.mode +
      ' promptChars=' + source.sourcePrompt.length
    );
    useWorkspaceStore.getState().setTabTitleNaming(pending.tabId, true);
    namingVisible = true;
    const promptConfig = usePromptsStore.getState().getPromptById(TAB_TITLE_PROMPT_ID);
    const title = await generateTabTitleFromPrompt(source.sourcePrompt, promptConfig);

    const beforeRename = findTab(pending.tabId);
    if (!beforeRename) {
      useWorkspaceStore.getState().clearPendingAutoTabTitle(pending.tabId, 'tab-missing-after-generate');
      return;
    }
    if (beforeRename.tab.nameSetManually) {
      finishPending(pending, 'manual-name-after-generate');
      return;
    }
    if (currentSessionId(beforeRename.tab, pending.toolType) !== pending.sessionId) {
      useWorkspaceStore.getState().clearPendingAutoTabTitle(pending.tabId, 'session-changed-after-generate');
      return;
    }

    if (!title) {
      console.warn(
        '[AutoTabTitleCoordinator] generated-null' +
        ' tab=' + pending.tabId.slice(-8) +
        ' tool=' + pending.toolType +
        ' session=' + pending.sessionId.slice(0, 8)
      );
      finishPending(pending, 'generated-null');
      return;
    }

    const renamed = useWorkspaceStore.getState().autoRenameTab(pending.tabId, title, {
      toolType: pending.toolType,
      sessionId: pending.sessionId,
    });
    console.warn(
      '[AutoTabTitleCoordinator] terminal' +
      ' tab=' + pending.tabId.slice(-8) +
      ' tool=' + pending.toolType +
      ' session=' + pending.sessionId.slice(0, 8) +
      ' result=' + (renamed ? 'renamed' : 'rename-skipped') +
      ' title=' + JSON.stringify(title)
    );
    finishPending(pending, renamed ? 'renamed' : 'rename-skipped');
  } catch (error: any) {
    // Keep the registration: a later durable change can retry a transient
    // parser/API failure. `generateTabTitleFromPrompt` already provides a
    // local fallback for ordinary Gemini failures, so throws are exceptional.
    console.warn(
      '[AutoTabTitleCoordinator] error' +
      ' tab=' + pending.tabId.slice(-8) +
      ' tool=' + pending.toolType +
      ' session=' + pending.sessionId.slice(0, 8) +
      ' message=' + (error?.message || error)
    );
  } finally {
    if (namingVisible) useWorkspaceStore.getState().setTabTitleNaming(pending.tabId, false);
    inFlight.delete(key);
    if (rerunAfterFlight.delete(key) && pendingByKey.has(key)) {
      void attemptAutoTitle(key, 'trailing-transcript-change');
    }
  }
};

const reconcilePending = (
  registrations: PendingAutoTabTitleRegistration[],
  runGeneration: number,
): void => {
  if (runGeneration !== generation || retainCount === 0) return;
  const desired = new Map(registrations.map((pending) => [pendingKey(pending), pending]));
  pendingByKey.clear();
  desired.forEach((pending, key) => pendingByKey.set(key, pending));

  for (const [key, subscription] of activeSubscriptions) {
    if (desired.has(key)) continue;
    activeSubscriptions.delete(key);
    unsubscribeConsumer(subscription);
  }

  for (const [key, pending] of desired) {
    if (activeSubscriptions.has(key)) continue;
    const match = findTab(pending.tabId);
    if (!match) {
      useWorkspaceStore.getState().clearPendingAutoTabTitle(pending.tabId, 'tab-missing-before-subscribe');
      continue;
    }
    if (match.tab.nameSetManually) {
      finishPending(pending, 'manual-name-before-subscribe');
      continue;
    }
    if (currentSessionId(match.tab, pending.toolType) !== pending.sessionId) {
      useWorkspaceStore.getState().clearPendingAutoTabTitle(pending.tabId, 'session-mismatch-before-subscribe');
      continue;
    }

    const subscription: ActiveSubscription = {
      // Generation is part of identity: React StrictMode start→stop→start can
      // leave the first subscribe promise resolving after the second run has
      // registered the same tab. A stale unsubscribe must not remove the new
      // run's consumer.
      consumerId: `auto-title:${runGeneration}:${pending.tabId}:${pending.toolType}:${pending.sessionId}`,
      cwd: match.tab.cwd || '',
    };
    activeSubscriptions.set(key, subscription);
    void ipcRenderer.invoke('agent-transcript:subscribe', {
      consumerId: subscription.consumerId,
      tabId: pending.tabId,
      toolType: pending.toolType,
      sessionId: pending.sessionId,
      cwd: subscription.cwd,
    }).then((result: any) => {
      if (runGeneration !== generation || !pendingByKey.has(key)) {
        unsubscribeConsumer(subscription);
        return;
      }
      if (!result?.success) {
        console.warn(
          '[AutoTabTitleCoordinator] subscribe-failed' +
          ' tab=' + pending.tabId.slice(-8) +
          ' tool=' + pending.toolType +
          ' session=' + pending.sessionId.slice(0, 8) +
          ' error=' + (result?.error || 'unknown')
        );
      }
      // The first prompt may predate subscription (bridge materialized after
      // the write), so always reconcile once from durable history immediately.
      void attemptAutoTitle(key, 'subscription-ready');
    }).catch((error: any) => {
      console.warn('[AutoTabTitleCoordinator] subscribe-error tab=' + pending.tabId.slice(-8)
        + ' message=' + (error?.message || error));
      void attemptAutoTitle(key, 'subscription-error-reconcile');
    });
  }
};

const onTranscriptChanged = (_event: any, detail: any): void => {
  for (const [key, pending] of pendingByKey) {
    if (detail?.sessionId !== pending.sessionId) continue;
    if (detail?.toolType && detail.toolType !== pending.toolType) continue;
    void attemptAutoTitle(key, detail?.reason || 'transcript-change');
  }
};

/** Starts the one renderer-global, presentation-independent coordinator. */
export const startAutoTabTitleCoordinator = (): (() => void) => {
  retainCount += 1;
  if (retainCount === 1) {
    generation += 1;
    const runGeneration = generation;
    ipcRenderer.on('agent-transcript:changed', onTranscriptChanged);
    unsubscribePending = subscribePendingAutoTabTitles((pending) => {
      reconcilePending(pending, runGeneration);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount > 0) return;
    generation += 1;
    unsubscribePending?.();
    unsubscribePending = null;
    ipcRenderer.removeListener('agent-transcript:changed', onTranscriptChanged);
    activeSubscriptions.forEach(unsubscribeConsumer);
    activeSubscriptions.clear();
    pendingByKey.clear();
    inFlight.clear();
    rerunAfterFlight.clear();
  };
};

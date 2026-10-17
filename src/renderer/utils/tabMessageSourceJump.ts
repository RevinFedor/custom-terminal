import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useUIStore } from '../store/useUIStore';
import { tabNavigationLocation } from './tabNavigationLocation.mjs';
import { createTabMessageSourceNavigation } from './tabMessageSourceNavigation.mjs';
import { normalizeTerminalMessageSnapshot, normalizeTerminalMessageTarget } from '../../shared/terminal-message-reference.mjs';

const { ipcRenderer } = window.require('electron');

const navigation = createTabMessageSourceNavigation({
  open: source => useWorkspaceStore.getState().openTabById(source.sourceTabId, {
    projectId: source.sourceProjectId, reason: 'tab-message-source-call',
  }),
  placement: () => tabNavigationLocation(useWorkspaceStore.getState()),
  subscribePlacement: changed => useWorkspaceStore.subscribe(changed),
  subscribeIntent: cancel => {
    const wheel = (event: WheelEvent) => { if (event.isTrusted) cancel(); };
    const key = (event: KeyboardEvent) => {
      if (event.isTrusted && ['Escape', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
    };
    window.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('wheel', wheel, true);
      window.removeEventListener('keydown', key, true);
    };
  },
  locate: (messageId, source) => source.referenceTarget
    ? Promise.resolve({ success: true, location: {
      messageId, tabId: source.sourceTabId, entryUuid: messageId,
      readSessionId: source.referenceTarget.viewOwnerSessionId || source.referenceTarget.sessionId,
      messageReference: source.referenceTarget,
    } })
    : ipcRenderer.invoke('tab-messages:source-location', { messageId }),
  requestId: source => {
    const requestId = crypto.randomUUID();
    if (source.referenceId) console.log('[MessageReference] seek id=' + source.referenceId + ' request=' + requestId);
    return requestId;
  },
  reveal: tabId => {
    const ui = useUIStore.getState();
    ui.setTabTerminalIsPrimary(tabId, false);
    ui.setHistoryPanelOpen(tabId, true);
    ui.setSideTerminalOpen(tabId, false);
  },
  scroll: (location, requestId) => {
    useUIStore.getState().setHistoryScrollToUuid(location.entryUuid, location.tabId, {
      toolUseId: location.toolUseId, readSessionId: location.readSessionId, requestId,
      messageReference: location.messageReference,
    });
    return useUIStore.getState().historyScrollRequestGeneration;
  },
  cancelScroll: generation => useUIStore.getState().cancelHistoryScrollRequest(generation),
  waitForScroll: requestId => {
    let finish: (result: any) => void;
    const promise = new Promise(resolve => { finish = resolve; });
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.requestId === requestId) complete(detail);
    };
    const complete = (result: any) => {
      clearTimeout(timer);
      window.removeEventListener('history-panel:scrolled-to', listener);
      finish(result);
    };
    // A bound for a missing panel/failed load, never a signal to start flashing.
    const timer = setTimeout(() => complete({ found: false, reason: 'source-scroll-timeout' }), 30_000);
    window.addEventListener('history-panel:scrolled-to', listener);
    return { promise, cancel: () => complete({ found: false, reason: 'source-scroll-cancelled' }) };
  },
});

export const cancelTabMessageSourceJump = () => navigation.cancel();
export const jumpToTabMessageSource = source => navigation.jump(source);
export const jumpToTerminalMessageReference = snapshot => {
  const reference = normalizeTerminalMessageSnapshot(snapshot);
  if (!reference) throw Error('message_reference_invalid');
  return jumpToTerminalMessageTarget(reference.source, reference.referenceId);
};
export const jumpToTerminalMessageTarget = (value, referenceId) => {
  const target = normalizeTerminalMessageTarget(value);
  if (!target) throw Error('message_reference_invalid');
  console.log('[MessageReference] open id=' + referenceId + ' tab=' + target.tabId);
  return navigation.jump({ messageId: target.messageId, sourceTabId: target.tabId, referenceTarget: target, referenceId }).then(found => {
    console.log('[MessageReference] jump id=' + referenceId + ' found=' + found);
    return found;
  });
};

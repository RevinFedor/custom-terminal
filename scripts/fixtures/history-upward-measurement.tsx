// Actual History/Virtuoso with many never-measured short rows above the reader.
// Optional captured API entries stay in the private test directory only.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { captureHistoryResizeAnchor, measureHistoryResizeAnchor } from '../../src/renderer/utils/historyResizeAnchor.mjs';
import { searchHistoryEntries } from '../../src/shared/history-search.mjs';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/blocks.css';

const { ipcRenderer } = window.require('electron');
const config = JSON.parse(window.require('fs').readFileSync(window.require('path').join(window.require('process').cwd(), 'fixture-input.json'), 'utf8'));
const sessionId = 'private-upward-history', tabId = 'private-upward-history-tab', projectId = 'private-upward-history-project';
const state: any = { ready: false, observing: false, phase: 'setup', frames: [], wheels: [], scrollEvents: [], writers: [], calls: [], searches: [], unknown: [], forbidden: [], tallMounts: [] };
const fixture: any = (window as any).historyUpwardFixture = { state, config, tabId, sessionId };
fixture.captureReader = () => {
  fixture.reader = captureHistoryResizeAnchor(document.querySelector('[data-virtuoso-scroller]'), false);
  return fixture.reader;
};
fixture.measureReader = () => measureHistoryResizeAnchor(document.querySelector('[data-virtuoso-scroller]'), fixture.reader);
const entry = (id: string, role: string, content: string, offset: number) => ({
  uuid: id, role, content, sessionId, sourceIdentity: 'source-' + id,
  timestamp: new Date(1700000000000 + offset * 1000).toISOString(),
});
const entries = Array.from({ length: 1700 }, (_, index) => entry('prior-' + index, index % 13 === 0 ? 'user' : 'assistant',
  'ROW ' + String(index).padStart(4, '0') + ' / ' + (Math.imul(index + 1, 2654435761) >>> 0).toString(36).padStart(7, '0') + ' / ' + (Math.imul(index + 13, 1597334677) >>> 0).toString(36).padStart(7, '0') + '. ' + 'Stable historical text. '.repeat(index % 13 === 0 ? 12 : index % 7 === 0 ? 7 : 1), index));
if (config.entries) {
  entries.push(...config.entries.map((item: any) => ({ ...item, sessionId,
    uuid: item.uuid.endsWith('-6526') ? 'tall-user-6526' : item.uuid.endsWith('-6635') ? 'final-answer-6635' : item.uuid })));
} else {
  entries.push({ ...entry('tall-user-6526', 'user', 'Small recent user prompt.', 350),
    semanticTags: undefined });
  for (let index = 0; index < 6; index++) entries.push(entry('small-after-' + index, 'assistant',
    'RECENT SMALL ROW ' + index + '\n\n' + 'A short answer after the research result. '.repeat(2), 351 + index));
  entries.push(entry('final-answer-6635', 'assistant', Array.from({ length: config.tailLines }, (_, index) =>
    'TAIL READING LINE ' + String(index).padStart(2, '0') + ' — this final answer must remain visible.').join('\n\n'), 357));
}

const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel: string, ...args: any[]) => {
  state.calls.push({ channel, at: performance.now() });
  const payload = args[0] || {};
  if (channel === 'agent-transcript:search-history') return { success: true, ...searchHistoryEntries(entries, payload) };
  if (channel === 'agent-transcript:get-history') return { success: true, entries: structuredClone(entries),
    payloadGeneration: 'fixture:unmeasured-tall-row', revision: { sources: [{ sessionId,
      fileIdentity: 'fixture-tall-rows', filePath: '/synthetic-tall-history', linkKind: 'end' }] } };
  if (channel === 'agent-session:get-availability-batch') return { success: true, results: (payload.sessions || []).map((s: any) =>
    ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
  if (['agent-transcript:subscribe', 'agent-transcript:unsubscribe'].includes(channel)) return { success: true };
  if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
  if (channel === 'agent-activity:get-tab-timing') return { success: true, timing: null };
  if (channel === 'agent:get-send-receipts' || channel === 'agent:list-send-receipts') return { success: true, records: [] };
  if (channel === 'tab-work-context:get') return { success: true, updates: [] };
  return originalInvoke(channel, ...args);
};
useUIStore.setState({ terminalHistoryStreamingEnabled: false, historyFontSize: config.fontSize,
  historyLetterSpacing: 0, promptSummaryGlobalAuto: false, historyGroupActionsEnabled: true } as any);
useWorkspaceStore.setState({ activeProjectId: projectId, openProjects: new Map([[projectId, {
  projectId, projectPath: '/synthetic-tall-history', activeTabId: tabId, currentView: 'terminal',
  selectedTabIds: [], tabGroups: [], tabOrder: [tabId], tabHistory: [tabId],
  tabs: new Map([[tabId, { id: tabId, name: 'Private upward History', cwd: '/synthetic-tall-history',
    commandType: 'codex', tabType: 'file', aiBusy: false, codexSessionId: sessionId }]]),
}]]) } as any);

const rowRect = (node: HTMLElement, origin: number) => {
  const rect = node.getBoundingClientRect();
  return { uuid: node.dataset.uuid, top: rect.top - origin, bottom: rect.bottom - origin,
    height: rect.height, index: node.closest<HTMLElement>('[data-item-index]')?.dataset.itemIndex,
    known: node.closest<HTMLElement>('[data-known-size]')?.dataset.knownSize };
};
fixture.sample = () => {
  const s = document.querySelector<HTMLElement>('[data-virtuoso-scroller]');
  if (!s) return null;
  const box = s.getBoundingClientRect();
  const rows = [...s.querySelectorAll<HTMLElement>('[data-history-row-real][data-uuid]')].map(node => rowRect(node, box.top));
  return { at: performance.now(), abs: performance.timeOrigin + performance.now(), phase: state.phase,
    top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight,
    box: { x: box.x, y: box.y, width: box.width, height: box.height }, rows,
    visible: rows.filter(row => row.bottom > 0 && row.top < s.clientHeight).map(row => row.uuid),
    tail: rows.find(row => row.uuid === 'final-answer-6635'), tall: rows.find(row => row.uuid === 'tall-user-6526'),
    ready: !!document.querySelector('[data-history-viewport-ready="1"]'),
    seek: s.querySelectorAll('[data-history-seek-placeholder]').length,
    shells: s.querySelectorAll('[data-history-mount-shell]').length,
    bridge: s.getAttribute('data-history-geometry-bridge'),
  };
};
fixture.observe = (phase: string) => {
  state.phase = phase; state.observing = true;
  const frame = () => {
    if (!state.observing) return;
    const sample = fixture.sample();
    if (sample) { sample.frame = state.frames.length; state.frames.push(sample); ipcRenderer.send('fixture:sample', sample); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};
for (const method of ['scrollTo', 'scrollBy'] as const) {
  const native = Element.prototype[method];
  Element.prototype[method] = function (...args: any[]) {
    if (this.hasAttribute?.('data-virtuoso-scroller')) state.writers.push({ method, at: performance.now(),
      abs: performance.timeOrigin + performance.now(), top: this.scrollTop, args,
      stack: new Error().stack, phase: state.phase });
    return native.apply(this, args as any);
  } as any;
}
const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
if (scrollTopDescriptor?.set) Object.defineProperty(Element.prototype, 'scrollTop', {
  ...scrollTopDescriptor,
  set(value) {
    if (this.hasAttribute?.('data-virtuoso-scroller')) state.writers.push({ method: 'scrollTop=',
      at: performance.now(), abs: performance.timeOrigin + performance.now(), top: this.scrollTop,
      args: [value], stack: new Error().stack, phase: state.phase });
    scrollTopDescriptor.set!.call(this, value);
  },
});
document.addEventListener('scroll', event => {
  const target = event.target as HTMLElement;
  if (target.hasAttribute?.('data-virtuoso-scroller')) state.scrollEvents.push({
    at: performance.now(), abs: performance.timeOrigin + performance.now(), top: target.scrollTop,
    trusted: event.isTrusted, phase: state.phase });
}, true);
document.addEventListener('wheel', event => {
  if ((event.target as HTMLElement).closest?.('[data-virtuoso-scroller]')) state.wheels.push({
    at: performance.now(), eventTs: event.timeStamp, deltaY: event.deltaY,
    deltaMode: event.deltaMode, trusted: event.isTrusted, phase: state.phase });
}, { capture: true, passive: true });
const mountedTallNodes = new WeakSet();
new MutationObserver(() => {
  const node = document.querySelector('[data-history-row-real][data-uuid="tall-user-6526"]');
  if (node && !mountedTallNodes.has(node)) {
    mountedTallNodes.add(node); state.tallMounts.push({ at: performance.now(), phase: state.phase,
      known: node.closest<HTMLElement>('[data-known-size]')?.dataset.knownSize });
  }
}).observe(document.getElementById('root')!, { childList: true, subtree: true });

function Fixture() {
  const [shown, setShown] = useState(true);
  const [width, setWidth] = useState(config.width);
  return <><header style={{ height: 32, font: '14px sans-serif', background: '#242424', color: '#ddd' }}>
    Private upward reading — no provider or terminal
    <button data-toggle-shown onClick={() => setShown(value => !value)} style={{ marginLeft: 12 }}>{shown ? 'Hide' : 'Show'}</button>
    <button data-narrow onClick={() => setWidth(Math.min(config.width, 760))}>Narrow</button>
    <button data-wide onClick={() => setWidth(config.width)}>Wide</button>
  </header><div style={{ position: 'relative', width, height: config.viewportHeight, opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none' }}>
    <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd="/synthetic-tall-history"
      width={width} notesPanelWidth={0} isOpen embedded embeddedFill mainSurface toolType="codex"
      presented={shown} preservePresentationGeometry onInitialSourceSignal={detail => {
        if (detail.phase === 'load' && detail.status === 'success') state.ready = true;
      }} />
  </div></>;
}
fixture.appendTail = () => {
  entries.push(entry('new-tail-1', 'assistant', 'NEW LIVE TAIL\n\n' + Array.from({ length: 6 }, (_, index) =>
    'Additional response line ' + index + '.').join('\n\n'), 358));
  ipcRenderer.emit('agent-transcript:changed', {}, { tabId, toolType: 'codex', sessionId,
    fileIdentity: 'fixture-tall-rows', reason: 'fixture-append' });
};
createRoot(document.getElementById('root')!).render(<Fixture />);

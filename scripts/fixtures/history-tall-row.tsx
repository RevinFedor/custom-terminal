// Actual HistoryPanel/Virtuoso with an unmeasured, very tall user row.
// All data and IPC are private. Optional captured body lives only in TMPDIR.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { saveHistoryMeasuredLayout } from '../../src/renderer/utils/historyMeasuredLayout';
import { makeHistorySnapshotKey } from '../../src/renderer/utils/historySnapshotCache';
import { historyLivePresentationKey } from '../../src/renderer/utils/historyLiveProjection.mjs';
import { buildHistoryDisplayUnitsCached, isGroupUnit } from '../../src/renderer/utils/historyDisplayUnits.mjs';
import { searchHistoryEntries } from '../../src/shared/history-search.mjs';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/blocks.css';

const { ipcRenderer } = window.require('electron');
const config = JSON.parse(window.require('fs').readFileSync(window.require('path').join(window.require('process').cwd(), 'fixture-input.json'), 'utf8'));
const sessionId = 'private-tall-history', tabId = 'private-tall-history-tab', projectId = 'private-tall-history-project';
const state: any = { ready: false, observing: false, phase: 'setup', frames: [], wheels: [], scrollEvents: [], writers: [], calls: [], searches: [], unknown: [], forbidden: [], tallMounts: [] };
const fixture: any = (window as any).tallRowFixture = { state, config, tabId, sessionId };
const nativeMicrotask = window.queueMicrotask.bind(window);
const heldMeasurements: Array<() => void> = [];
state.heldMeasurements = 0; state.holdMeasurements = false;
window.queueMicrotask = (callback: VoidFunction) => {
  const text = Function.prototype.toString.call(callback);
  if (state.holdMeasurements && text.includes('getOwnerToken()') && text.includes('ScrollEvent')) {
    heldMeasurements.push(callback); state.heldMeasurements = heldMeasurements.length;
  } else nativeMicrotask(callback);
};
fixture.releaseMeasurements = () => {
  state.holdMeasurements = false;
  const callbacks = heldMeasurements.splice(0); state.heldMeasurements = 0;
  callbacks.forEach(callback => callback()); return callbacks.length;
};
const entry = (id: string, role: string, content: string, offset: number) => ({
  uuid: id, role, content, sessionId, sourceIdentity: 'source-' + id,
  timestamp: new Date(1700000000000 + offset * 1000).toISOString(),
});
const searchQuery = config.searchQuery || 'Ответ';
const syntheticBody = Array.from({ length: 170 }, (_, index) =>
  ((index === 0 ? searchQuery + '. ' : '') + 'RESEARCH SECTION ' + index + ': ' + 'A reproducible explanation with a stable reading anchor. '.repeat(4)).slice(0, index < 17 ? 133 : 132)).join('\n');
const syntheticTags = [{ kind: 'orchestration', id: 'private-service-tag', runId: 'private-tall-result',
  phase: 'completion', runKind: 'external-research', targetTabName: 'Private research fixture',
  envelopeStart: 0, envelopeText: '', bodyStart: 0, bodyEnd: syntheticBody.length,
  bodyProjectionHash: window.require('node:crypto').createHash('sha256').update(syntheticBody, 'utf8').digest('hex') }];
state.syntheticBody = !config.body && !config.entries ? { chars: syntheticBody.length, lines: 170,
  sha256: syntheticTags[0].bodyProjectionHash, searchQuery } : null;
const entries = Array.from({ length: 350 }, (_, index) => entry('prior-' + index, 'assistant',
  'Prior record ' + index + '.\n\n' + 'A short historical explanation. '.repeat(8), index));
if (config.entries) {
  entries.push(...config.entries.map((item: any) => ({ ...item, sessionId,
    uuid: item.uuid.endsWith('-6526') ? 'tall-user-6526' : item.uuid.endsWith('-6635') ? 'final-answer-6635' : item.uuid })));
} else {
  entries.push({ ...entry('tall-user-6526', 'user', config.body || syntheticBody, 350),
    semanticTags: config.semanticTags || (!config.body ? syntheticTags : undefined) });
  for (let index = 0; index < 6; index++) entries.push(entry('small-after-' + index, 'assistant',
    'RECENT SMALL ROW ' + index + '\n\n' + 'A short answer after the research result. '.repeat(2), 351 + index));
  entries.push(entry('final-answer-6635', 'assistant', Array.from({ length: config.tailLines }, (_, index) =>
    'TAIL READING LINE ' + String(index).padStart(2, '0') + ' — this final answer must remain visible.').join('\n\n'), 357));
}

// Incident begins in an already prepared tail, with the preceding large row
// still estimated at 197px. This is input geometry, not a scroll/resize mock.
// No nodes or itemSize/ResizeObserver callbacks are replaced by the fixture.
if (config.seedLayout) {
  const tailSize = config.seedTailHeight;
  const units = buildHistoryDisplayUnitsCached(entries, { enabled: true, threshold: 2, expandedKeys: new Set() });
  const last = units.length - 1;
  const ranges = config.entries ? [{ startIndex: 0, endIndex: last - 1, size: 197 },
    { startIndex: last, endIndex: last, size: tailSize }] : [{ startIndex: 0, endIndex: 350, size: 197 },
    { startIndex: 351, endIndex: 356, size: 140 }, { startIndex: 357, endIndex: 357, size: tailSize }];
  const keys = units.map((unit: any) => isGroupUnit(unit)
    ? ['group', unit.key, unit.expanded ? 'open' : 'closed', unit.entries.length,
      unit.entries.at(-1)?.rewriteLayoutUuid || unit.entries.at(-1)?.uuid || '', unit.parentGroup?.key || ''].join('|')
    : ['entry', historyLivePresentationKey(unit.entry), unit.entry.content?.length || 0, '', 'full',
      unit.entry.promptChips?.length || 0, unit.entry.imagePaths?.length || 0,
      unit.expandedGroup?.key || '', unit.expandedSubgroup?.key || ''].join('|'));
  const scrollTop = ranges.reduce((sum, r) => sum + (r.endIndex - r.startIndex + 1) * r.size, 0) - config.viewportHeight;
  state.seededLayout = saveHistoryMeasuredLayout(makeHistorySnapshotKey({ tabId, toolType: 'codex', sessionId,
    cwd: '/synthetic-tall-history' }), { ranges, scrollTop }, keys);
}

const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel: string, ...args: any[]) => {
  state.calls.push({ channel, at: performance.now() });
  const payload = args[0] || {};
  if (channel === 'agent-transcript:search-history') {
    // Real search projection expands matching user rows. An older match is
    // outside this bounded History window, so merely opening search does not
    // first visit/measure our giant row. No search/scroll handler is replaced.
    const omitted = entry('outside-current-window', 'user', searchQuery + ' из более ранней части истории', -1);
    const result = searchHistoryEntries([omitted, ...entries], payload);
    state.searches.push({ query: payload.query, total: result.total, at: performance.now() });
    return { success: true, ...result };
  }
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
  tabs: new Map([[tabId, { id: tabId, name: 'Private tall History', cwd: '/synthetic-tall-history',
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
    at: performance.now(), deltaY: event.deltaY, trusted: event.isTrusted, phase: state.phase });
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
  return <><header style={{ height: 32, font: '14px sans-serif', background: '#242424', color: '#ddd' }}>
    Private tall-row measurement — no provider or terminal
    <button data-toggle-shown onClick={() => setShown(value => !value)} style={{ marginLeft: 12 }}>{shown ? 'Hide' : 'Show'}</button>
  </header><div style={{ position: 'relative', width: config.width, height: config.viewportHeight, visibility: shown ? 'visible' : 'hidden' }}>
    <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd="/synthetic-tall-history"
      width={config.width} notesPanelWidth={0} isOpen embedded embeddedFill mainSurface toolType="codex"
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

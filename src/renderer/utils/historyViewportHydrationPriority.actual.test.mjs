import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ordinaryHistoryDeltaFillsViewport } from './historyOrdinaryHydrationWindow.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('visibleHydrationDelta: () => boundedHydrationDelta');
const end = source.indexOf(',\n          changedCount:', start);
assert(start > 0 && end > start);
const actual = '(' + source.slice(start + 'visibleHydrationDelta: '.length, end) + ')';
const stub = uuid => ({ uuid, rowStub: true, hasContent: true });

test('current visible missing caption is demand; hidden group members and unrelated bodies are not', () => {
  const units = [{ kind: 'entry', entry: stub('outside') }, { kind: 'group', key: 'g',
    captionEntry: stub('caption'), entries: [stub('hidden-tool')], expanded: false }];
  const fills = rows => ordinaryHistoryDeltaFillsViewport(units, { start: 1, end: 1 }, new Map(), rows);
  assert.equal(fills([{ uuid: 'caption', content: 'full Ω🙂\ncaption' }]), true);
  for (const rows of [[stub('caption')], [{ uuid: 'hidden-tool' }], [{ uuid: 'outside' }], []]) assert.equal(fills(rows), false);
  units[1].expanded = true; assert.equal(fills([{ uuid: 'caption' }]), false);
  units[1].expanded = false; units[1].captionEntry = { uuid: 'caption', content: 'already loaded' };
  assert.equal(fills([{ uuid: 'caption', content: 'new' }]), false);
});

test('actual Panel admission refuses stale visit/request, hidden/root/cancelled owners and another interaction', () => {
  const make = () => {
    const c = { boundedHydrationDelta: true, ordinaryHydrationAtStart: { sequence: 5, visit: 7 },
      signal: { aborted: false }, isCurrentOwner: () => true, primaryRootRef: { current: null },
      historyPresentationProofRef: { current: { presented: true, visit: 7 } },
      hydrationRequestSeqRef: { current: 5 }, hydrationRequestInFlightRef: { current: true },
      historyForegroundPriority: { interactionCount: () => 0, hasPendingInput: () => false, active: () => true, owner: () => 'own' }, tabId: 'own',
      displayUnitsRef: { current: [{ kind: 'entry', entry: stub('visible') }] }, visibleRangeRef: { current: { start: 0, end: 0 } },
      groupCaptionSelectionsRef: { current: new Map() }, priorityChangedEntries: [{ uuid: 'visible', content: 'full' }],
      ordinaryHistoryDeltaFillsViewport };
    return { c, qualifies: vm.runInNewContext(actual, c) };
  };
  assert.equal(make().qualifies(), true);
  for (const revoke of [c => { c.boundedHydrationDelta = false; }, c => { c.ordinaryHydrationAtStart = null; },
    c => { c.signal.aborted = true; }, c => { c.isCurrentOwner = () => false; },
    c => { c.primaryRootRef.current = {}; }, c => { c.historyPresentationProofRef.current.presented = false; },
    c => { c.historyPresentationProofRef.current.visit++; }, c => { c.hydrationRequestSeqRef.current++; },
    c => { c.hydrationRequestInFlightRef.current = false; }, c => { c.historyForegroundPriority.interactionCount = () => 1; },
    c => { c.historyForegroundPriority.hasPendingInput = () => true; },
    c => { c.historyForegroundPriority.owner = () => 'other'; }, c => { c.priorityChangedEntries = [{ uuid: 'other' }]; }]) {
    const h = make(); revoke(h.c); assert.equal(h.qualifies(), false);
  }
});

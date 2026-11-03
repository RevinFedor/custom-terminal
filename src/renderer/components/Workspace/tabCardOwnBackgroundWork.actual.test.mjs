// A tab with a running subagent must LOOK busy on its card.
//
// Reported 02.11.2026 against the window strip: a tab showed no loader at all,
// yet its Auto-stop timer stood still and the next Run After step never fired.
// Both of those are correct — main refuses to stop or advance a tab whose own
// subagents are running (`getCombinedTabBackgroundWorkCount`). The card simply
// never said so, so the user saw a frozen timer on an apparently idle tab with
// nothing explaining the hold.
//
// Why it only affected this surface: main ends the PARENT turn
// (`claudeTurnBusy = false`) as soon as the agent's own answer completes, even
// while its async children run; the live count rides along as a separate
// `backgroundWorkCount` field. TabBar.tsx mixed that count into its loader,
// `useTabActivitySignals` — the source for the pane/strip chip — did not.
//
// These cases execute the REAL hook body sliced out of TabSignals.tsx with the
// REAL projection module behind it. React hooks, the store and IPC are finite
// controlled ports; nothing is mounted or painted.
//
// Run: node --test src/renderer/components/Workspace/tabCardOwnBackgroundWork.actual.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

import {
  resetTabOwnBackgroundWorkForTest,
  restoreTabOwnBackgroundWork,
  subscribeTabBackgroundWorkPresentation,
  tabOwnBackgroundWorkBlocks,
} from '../../utils/tabOwnBackgroundWork.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'TabSignals.tsx'), 'utf8');
const from = source.indexOf('export function useTabActivitySignals(');
assert.ok(from > 0, 'the hook must exist');
const to = source.indexOf('\n}', source.indexOf('    inheritedBusy: orchestrationBusy && !effectiveBusy,', from));
assert.ok(to > from, 'the hook must be sliceable');
const code = ts.transpileModule(source.slice(from, to + 2).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

test.beforeEach(() => resetTabOwnBackgroundWorkForTest());

// Finite React-hook substitute: state slots plus effects that run on dependency
// change, which is all this hook uses.
// Records are delivered the way production delivers them: through the main
// broadcast the projection module subscribes to. Calling the apply function
// directly would skip the notification step and test nothing about the wiring
// that actually lights the card.
function mount(tabId, { storeBusy = false, restoreRecords = null } = {}) {
  const requested = [];
  let deliver = null;
  const moduleChannel = {
    on: (channel, handler) => { if (channel === 'tab:background-work') deliver = handler; },
    removeListener() {},
    invoke: (_name, args) => {
      requested.push(args?.tabIds);
      return Promise.resolve(restoreRecords ? { records: restoreRecords } : null);
    },
  };
  global.window = { require: () => ({ ipcRenderer: moduleChannel }) };
  const slots = [];
  let cursor = 0;
  let result = null;
  const effects = [];
  let rendering = false;
  const useState = (initial) => {
    const i = cursor++;
    slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slots[i].value, (next) => {
      const value = typeof next === 'function' ? next(slots[i].value) : next;
      if (Object.is(value, slots[i].value)) return;
      slots[i].value = value;
      if (!rendering) render();
    }];
  };
  const useEffect = (fn, deps) => {
    const i = cursor++;
    const previous = slots[i];
    if (!previous || !previous.deps || deps.some((value, k) => value !== previous.deps[k])) {
      effects.push(() => {
        previous?.cleanup?.();
        slots[i] = { deps, cleanup: fn() };
      });
      slots[i] = { ...previous, deps };
    }
  };
  const context = vm.createContext({
    useState, useEffect,
    tabOwnBackgroundWorkBlocks, subscribeTabBackgroundWorkPresentation, restoreTabOwnBackgroundWork,
    useOrchestrationStore: (selector) => selector({ inheritedBusyTabIds: new Set() }),
    useAgentSendPending: () => false,
    useWorkspaceStore: (selector) => selector({
      openProjects: new Map([['P', { tabs: new Map([[tabId, { aiBusy: storeBusy }]]) }]]),
    }),
    resolveAgentBusyPresentation: (data) => data?.busy === true,
    // The hook's own busy/process channel, separate from the projection
    // module's broadcast above.
    ipcRenderer: { on() {}, removeListener() {}, invoke: () => Promise.resolve(null) },
    console,
  });
  vm.runInContext(code + '\nglobalThis.hook = useTabActivitySignals;', context);
  let lastShared = null;
  function render(shared = lastShared) {
    lastShared = shared;
    rendering = true;
    cursor = 0;
    result = context.hook(tabId, shared);
    rendering = false;
    while (effects.length) effects.shift()();
    return result;
  }
  const shared = {
    processStatus: new Map([[tabId, true]]),
    busyTabs: new Map(),
    pasteBusyTabs: new Map(),
  };
  render(shared);
  return {
    shared, requested,
    get busy() { return result.busy; },
    get hasProcess() { return result.hasProcess; },
    rerender: () => render(shared),
    publish: (record) => { assert.ok(deliver, 'the module must subscribe to the broadcast'); deliver(null, record); },
    teardown: () => { for (const slot of slots) slot?.cleanup?.(); delete global.window; },
  };
}

test('a tab whose own subagent is running shows the loader after its turn ended', () => {
  // The reported state exactly: the parent turn is over (busy maps empty),
  // one child still runs.
  const card = mount('tab-a');
  assert.equal(card.busy, false, 'an idle tab stays idle');

  card.publish({ tabId: 'tab-a', count: 1, revision: 1 });
  assert.equal(card.busy, true, 'a live own subagent must light the card');

  card.publish({ tabId: 'tab-a', count: 0, revision: 2 });
  assert.equal(card.busy, false, 'the last child exiting releases it');
  card.teardown();
});

test('a card mounted mid-work does not wait for the child to exit to light up', async () => {
  // The channel carries transitions only. Without the restore read, a card
  // that appeared after the subagent started would stay dark for minutes —
  // the same "mounted after the turn began" class this file already fixed for
  // the parent turn.
  const card = mount('tab-late', { restoreRecords: [{ tabId: 'tab-late', count: 2, revision: 7 }] });
  assert.equal(card.busy, false, 'nothing known yet');
  await restoreTabOwnBackgroundWork('tab-late');
  card.rerender();
  assert.equal(card.busy, true, 'the restore read supplies work that started earlier');
  assert.deepEqual(card.requested, [['tab-late']], 'a card asks about ITS tab only');
  card.teardown();
});

test('a neighbour tab subagent never lights this card', () => {
  const card = mount('tab-a');
  card.publish({ tabId: 'tab-b', count: 3, revision: 1 });
  assert.equal(card.busy, false);
  card.teardown();
});

test('a background shell does not hold the card, an explicitly held one does', () => {
  // Main's boundary, reused rather than re-decided here: `taskCount` is
  // excluded so a forgotten `npm run dev` cannot pin its tab forever, while a
  // shell held through `hold_background_work` arrives inside `count`.
  const card = mount('tab-a');
  card.publish({ tabId: 'tab-a', count: 0, taskCount: 4, revision: 1 });
  assert.equal(card.busy, false, 'a detached shell must not hold the tab');
  card.publish({ tabId: 'tab-a', count: 1, taskCount: 4, revision: 2 });
  assert.equal(card.busy, true, 'an explicitly held shell counts like a subagent');
  card.teardown();
});

test('an ordinary busy turn is unaffected by this signal', () => {
  const card = mount('tab-a', { storeBusy: true });
  card.shared.busyTabs.set('tab-a', true);
  assert.equal(card.rerender().busy, true);
  card.shared.busyTabs.delete('tab-a');
  assert.equal(card.rerender().busy, false, 'no background work → plain idle');
  card.teardown();
});

test('a stale record cannot clear a card that is still working', () => {
  const card = mount('tab-a');
  card.publish({ tabId: 'tab-a', count: 1, revision: 5 });
  assert.equal(card.busy, true);
  card.publish({ tabId: 'tab-a', count: 0, revision: 3 });
  assert.equal(card.busy, true, 'an older snapshot must not switch the loader off');
  card.teardown();
});

test('both surfaces read the same main-owned count', () => {
  // The whole point of the repair: TabBar and this hook must not each decide
  // what "busy" means for the same tab in two windows.
  const tabBar = fs.readFileSync(path.join(here, 'TabBar.tsx'), 'utf8');
  assert.match(tabBar, /const backgroundWork = backgroundWorkMap\.get\(tab\.id\) \|\| false;/);
  assert.match(tabBar, /ipcRenderer\.on\('tab:background-work'/);
  assert.match(source, /from '\.\.\/\.\.\/utils\/tabOwnBackgroundWork\.mjs'/);
  assert.match(source, /sendPending \|\| ownBackgroundWork/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';
import { createAgentSendVisualActivity } from './agentSendVisualActivity.mjs';
import { resolveWorkflowActivityCounts } from './workflowActivityCounts.mjs';
import { resolveDockBusyBadgeState } from './dockBusyBadgeState.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '../../..');
const read = (relative) => fs.readFileSync(path.join(root, 'src', relative), 'utf8');
const loadTs = (source, mocks) => {
  const module = { exports: {} };
  const compiled = transformSync(source, { loader: 'tsx', format: 'cjs', target: 'node18' }).code;
  new Function('module', 'exports', 'require', 'window', compiled)(module, module.exports,
    (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), mocks.window);
  return module.exports;
};

test('real bridge subscribes before initial read; newer receipt event wins across renderer reload', async () => {
  const ipc = new EventEmitter();
  let resolveRead;
  ipc.invoke = (channel) => {
    assert.equal(channel, 'agent:get-send-activity');
    return new Promise((resolve) => { resolveRead = resolve; });
  };
  let action, scenario;
  const hook = loadTs(read('renderer/hooks/useAgentSendActivity.ts'), {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    '../utils/agentSendVisualActivity.mjs': { createAgentSendVisualActivity },
    '../utils/agentSendSequencer.mjs': { subscribeAgentSendScenarios(cb) { scenario = cb; return () => {}; } },
    '../utils/agentActionCoordinator.mjs': {
      getCoordinatedAgentActions: () => [],
      subscribeCoordinatedAgentActions(cb) { action = cb; return () => {}; },
    },
    window: { require: () => ({ ipcRenderer: ipc }) },
  });
  const stop = hook.startAgentSendActivity();
  ipc.emit('agent:send-activity', null, { generation: 'G', revision: 2, pendingTabIds: ['T'] });
  resolveRead({ generation: 'G', revision: 1, pendingTabIds: [] });
  await Promise.resolve();
  assert.equal(hook.useAgentSendPending('T'), true);
  action({ tabId: 'T', state: { phase: 'sending' } });
  ipc.emit('agent:send-activity', null, { generation: 'G', revision: 3, pendingTabIds: [] });
  assert.equal(hook.useAgentSendPending('T'), true, 'local accepted click still owns activity');
  scenario({ tabId: 'T', pending: 1 });
  action({ tabId: 'T', state: null });
  assert.equal(hook.useAgentSendPending('T'), true);
  scenario({ tabId: 'T', pending: 0 });
  assert.equal(hook.useAgentSendPending('T'), false);
  stop();
  assert.equal(ipc.listenerCount('agent:send-activity'), 0);
});

test('real workflow badge displays preparation or provider activity and disappears when both finish', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { default: Badges } = loadTs(read('renderer/components/Workspace/WorkflowActivityBadges.tsx'), {
    './TabSignals': { useTabCompletionNotificationDismissing: () => false },
  });
  const frames = [
    { sendPending: true },
    { sendPending: true, pasteBusy: true },
    { sendPending: true, pasteBusy: false },
    { sendPending: true, busy: true },
    { sendPending: false, busy: true },
    { sendPending: false, busy: false },
  ];
  for (const [index, frame] of frames.entries()) {
    const counts = resolveWorkflowActivityCounts([{ tabId: 'T', processAlive: true, ...frame }]);
    const html = renderToStaticMarkup(React.createElement(Badges, { ...counts, active: false }));
    assert.equal(html.includes('data-workflow-busy-count'), index < frames.length - 1);
    assert.equal(html.includes('data-workflow-active-count'), true, 'process liveness stays separate');
    const ids = new Set(frame.busy || frame.pasteBusy || frame.sendPending ? ['T'] : []);
    assert.equal(resolveDockBusyBadgeState(ids, new Set()).count, counts.busyCount);
  }
});

test('real hook releases local composer/scenario for the exact passive handoff before their promises return', async () => {
  const ipc = new EventEmitter();
  ipc.invoke = async () => ({ generation: 'G', revision: 0, pendingTabIds: [], observingHandoffs: [] });
  let action, scenario;
  const hook = loadTs(read('renderer/hooks/useAgentSendActivity.ts'), {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    '../utils/agentSendVisualActivity.mjs': { createAgentSendVisualActivity },
    '../utils/agentSendSequencer.mjs': { subscribeAgentSendScenarios(cb) { scenario = cb; return () => {}; } },
    '../utils/agentActionCoordinator.mjs': {
      getCoordinatedAgentActions: () => [],
      subscribeCoordinatedAgentActions(cb) { action = cb; return () => {}; },
    },
    window: { require: () => ({ ipcRenderer: ipc }) },
  });
  const stop = hook.startAgentSendActivity();
  await Promise.resolve();
  action({ tabId: 'T', state: { handoffId: 'A', phase: 'sending' } });
  scenario({ tabId: 'T', pending: 1, handoffIds: ['A'] });
  assert.equal(hook.useAgentSendPending('T'), true);
  ipc.emit('agent:send-activity', null, { generation: 'G', revision: 1, pendingTabIds: [],
    observingHandoffs: [{ tabId: 'T', handoffId: 'A', active: false }] });
  assert.equal(hook.useAgentSendPending('T'), false);
  action({ tabId: 'T', state: { handoffId: 'B', phase: 'sending' } });
  assert.equal(hook.useAgentSendPending('T'), true, 'new unsubmitted draft keeps feedback');
  ipc.emit('agent:send-activity', null, { generation: 'G', revision: 2, pendingTabIds: [],
    observingHandoffs: [], lastOperation: { tabId: 'T', handoffId: 'A', active: false } });
  assert.equal(hook.useAgentSendPending('T'), true, 'old confirmation does not settle B');
  action({ tabId: 'T', state: null });
  assert.equal(hook.useAgentSendPending('T'), false, 'A remains passive after its receipt was removed');
  action({ tabId: 'T', state: { handoffId: 'A', phase: 'stopping' } });
  assert.equal(hook.useAgentSendPending('T'), true, 'an actual pending Stop retains its own progress');
  action({ tabId: 'T', state: null });
  scenario({ tabId: 'T', pending: 0, handoffIds: [] });
  stop();
});

test('all chrome consumes send activity without changing real busy, input or Stop authority', () => {
  const app = read('renderer/App.tsx');
  const space = read('renderer/components/Workspace/SpaceStrip.tsx');
  const tab = read('renderer/components/Workspace/TabBar.tsx');
  const signals = read('renderer/components/Workspace/TabSignals.tsx');
  assert.match(app, /useEffect\(\(\) => startAgentSendActivity\(\), \[\]\)/);
  assert.match(app, /if \(busyTabs\.get\(tabId\) \|\| pasteBusyTabs\.get\(tabId\) \|\| sendPendingTabs\.has\(tabId\)\)/);
  assert.match(space, /sendPending: sendPendingTabs\.has\(tabId\)/);
  assert.match(tab, /const verticalIsAiBusy = isBusy \|\| isSendPending;/);
  assert.match(signals, /const effectiveBusy = \(hasSharedBusy \? sharedBusy : busy\) \|\| sendPending;/);
  const turnBusy = tab.slice(tab.indexOf('const isTabTurnBusy ='), tab.indexOf('const isSharedOrLocalBusy ='));
  assert.doesNotMatch(turnBusy, /sendPending|isSendPending/);
  const hook = read('renderer/hooks/useAgentSendActivity.ts');
  assert.doesNotMatch(hook, /setAiBusy|paste-busy|busy-state|setTimeout|setInterval/);
  assert.match(app, /case 'sendAgentPromptScenario':|action === 'sendAgentPromptScenario'/);
  assert.match(app, /send: \(resolvedHandoffId\) => sendAgentPromptScenario\(\{/);
});

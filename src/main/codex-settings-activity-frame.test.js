const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { classifyCodexManualEnterFrame } = require('./codex-model-picker');
const { createAgentSettingsActivity } = require('./agent-settings-activity');
const { parseCodexVerifiedComposerFooter, inspectCodexInputReadyTextCore, selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const part = name => {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}\n', start) + 3;
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end);
};

test('manual model picker activity waits for the committed model/effort footer, not empty input', () => {
  let generation = 'G1';
  const mirror = {};
  const activity = createAgentSettingsActivity();
  const api = vm.runInNewContext([
    part('codexInputControlFromCommittedSnapshot'), part('observeCodexSettingsActivityFrame'),
    '({ observe: observeCodexSettingsActivityFrame })',
  ].join('\n'), {
    classifyCodexManualEnterFrame, parseCodexVerifiedComposerFooter,
    codexInputControlFrameCache: new WeakMap(),
    getHeadlessTerminalMirror: () => mirror,
    getTerminalLifecycleGeneration: () => generation,
    getLiveAiRuntimeOwners: () => ['codex'],
    hasCodexEstablishedComposerLifecycle: () => true,
    terminalCommandState: new Map([['T', { isRunning: true }]]),
    agentSettingsActivity: activity,
    beginAgentSettingsActivity: (tabId, toolType, target) => activity.begin({ tabId, toolType, target }),
    inspectCodexInputReadyVisibleText: (_text, sourceName, { lines }) => {
      const text = selectCodexCurrentInteractiveFrameText(lines);
      return { ...inspectCodexInputReadyTextCore(text, '', { requireSyncMarker: false, requireInitializedComposer: true, source: sourceName }), sampleText: text };
    },
  });
  const frame = lines => {
    const snapshot = { success: true, authoritativeFrameCommitted: true, lines: lines.map(text => ({ text })) };
    mirror.lastCommittedVisibleSnapshot = snapshot;
    api.observe('T', mirror, snapshot);
  };
  const menu = ['Select Model', '› 1. gpt-5.6-luna (current)', '  2. All models Choose a specific model', 'Press enter to confirm or esc to go back'];
  frame(menu);
  assert.equal(activity.read('T').busy, true);
  const before = activity.read('T').sequence;
  frame(menu);
  assert.equal(activity.read('T').sequence, before, 'redraw cannot add another operation');
  frame(['› Ask Codex to do anything']);
  assert.equal(activity.read('T').busy, true);
  frame(['› Ask Codex to do anything', 'gpt-5.6-luna medium · Full Access']);
  assert.equal(activity.read('T').busy, false);
  const app = activity.begin({ tabId: 'T', target: 'effort', toolType: 'codex' });
  frame(menu);
  assert.equal(activity.read('T').target, 'effort', 'native submenu does not replace the clicked effort indicator');
  activity.end(app);
  frame(menu);
  generation = 'G2';
  frame(['new launch']);
  assert.equal(activity.read('T').busy, false, 'old generation cannot retain a loader');
});

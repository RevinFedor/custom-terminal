const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { inspectCodexInputReadyTextCore, selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const begin = source.indexOf('function observeCodexStartupComposerCommittedFrame(');
const end = source.indexOf('\n}\n', begin) + 3;
assert.ok(begin > 0 && end > begin);

test('a Goal-started turn wakes the existing verifier from the assembled frame, not raw spinner chunks', async () => {
  const mirror = {}, calls = [];
  let release;
  const watchers = new Map([['T', { busy: true, currentTurnId: 'goal-turn' }]]);
  const context = { console, codexTurnWatchers: watchers, codexTuiReadyTabs: new Set(),
    getHeadlessTerminalMirror: () => mirror, getLiveAiRuntimeOwners: () => ['codex'],
    inspectCodexInputReadyVisibleText: (_text, source, { lines }) => inspectCodexInputReadyTextCore(
      selectCodexCurrentInteractiveFrameText(lines), '', { requireSyncMarker: false, requireInitializedComposer: true, source }),
    markCodexTuiReadyAfterVerifiedComposer: (...args) => { calls.push(args); return new Promise(resolve => { release = resolve; }); } };
  const observe = vm.runInNewContext(source.slice(begin, end) + '\nobserveCodexStartupComposerCommittedFrame', context);
  const paint = texts => { const frame = { authoritativeFrameCommitted: true, lines: texts.map(text => ({ text })) };
    mirror.lastCommittedVisibleSnapshot = frame; observe('T', mirror, frame); return frame; };
  paint(['Resume paused goal?', '› 1. Resume goal', '2. Leave paused', 'Press enter to confirm']);
  assert.equal(calls.length, 0, 'an actual modal never becomes ready');
  const frame = paint(['• Working (35s • esc to interrupt)', '', '› Ask Codex to do anything',
    '', 'gpt-5.6-sol max · Context 44% · Goal active (/goal pause)']);
  assert.equal(calls.length, 1);
  observe('T', mirror, frame);
  assert.equal(calls.length, 1, 'one verifier in flight, not a request per frame');
  release(true); await new Promise(resolve => setImmediate(resolve));
  watchers.set('T', { busy: false, currentTurnId: null });
  observe('T', mirror, frame);
  assert.equal(calls.length, 1, 'old composer without a live turn does not authorize startup');
});

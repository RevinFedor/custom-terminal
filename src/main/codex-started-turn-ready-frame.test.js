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
    codexLastRunCommandPayload: new Map(), terminalCommandState: new Map(),
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

for (const [name, composer] of [
  ['animated', ['⠁ ⠄ ⢀', '⠐ ›⠁Ask Codex to do anything', '⠈ ⠂ ⡀ gpt-6-astra max']],
  ['d10d3862 warning', ['» Ask Codex to do anything', ' ',
    '  GPT-6-Astra ultra                                ⚠ 1 warning · f2 to view']],
]) {
test(`idle Resume with ${name} composer wakes readiness before any submitted turn`, async () => {
  const mirror = {}, calls = [];
  const launches = new Map([['T', { launchId: 'L', startedAt: 100 }]]);
  const command = new Map([['T', { isRunning: true }]]);
  const context = { console, codexTurnWatchers: new Map([['T', { busy: false }]]),
    codexTuiReadyTabs: new Set(), codexLastRunCommandPayload: launches, terminalCommandState: command,
    getHeadlessTerminalMirror: () => mirror, getLiveAiRuntimeOwners: () => ['codex'],
    inspectCodexInputReadyVisibleText: (_text, source, { lines }) => inspectCodexInputReadyTextCore(
      selectCodexCurrentInteractiveFrameText(lines), '', { requireSyncMarker: false, requireInitializedComposer: true, source }),
    markCodexTuiReadyAfterVerifiedComposer: async (...args) => { calls.push(args); } };
  const observe = vm.runInNewContext(source.slice(begin, end) + '\nobserveCodexStartupComposerCommittedFrame', context);
  const paint = (lines, extra = {}) => {
    const frame = { authoritativeFrameCommitted: true, lines: lines.map(text => ({ text })), ...extra };
    mirror.lastCommittedVisibleSnapshot = frame; observe('T', mirror, frame); return frame;
  };
  paint(['Resuming session…', '› Ask Codex to do anything', '? for shortcuts']);
  assert.equal(calls.length, 0, 'StartupDraft still cannot submit');
  paint(composer, { liveSynchronizedOutputOpen: true });
  assert.equal(calls.length, 0, 'open redraw never grants ready');
  const frame = paint(composer);
  assert.equal(calls.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  command.set('T', { isRunning: false });
  observe('T', mirror, frame);
  assert.equal(calls.length, 1, 'stopped process cannot be woken by stale animation');
  command.set('T', { isRunning: true }); launches.clear();
  observe('T', mirror, frame);
  assert.equal(calls.length, 1, 'no current launch or turn, no startup wake');
});
}

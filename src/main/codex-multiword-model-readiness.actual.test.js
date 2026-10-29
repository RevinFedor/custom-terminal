'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseCodexVerifiedComposerFooter, inspectCodexInputReadyTextCore,
  selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');
const { waitForAgentReadyTransition } = require('./agent-ready-wait');
const { createCodexLiveSettingsObserver } = require('./codex-live-settings');
const { inspectCodexModelCapacityFrame } = require('./codex-model-capacity-state');
const { parseCodexModelChangeAcknowledgement } = require('../shared/codex-native-picker-proof.cjs');
const { parseCodexVerifiedLaunchCardSettings, codexModelEffortAppliedMessageCount,
  isCodexModelEffortAppliedMessage, parseCodexModelMigrationAcknowledgement,
  decideCodexModelMigrationAcknowledgement, inspectCodexModelMigrationPrompt,
  decideCodexModelMigrationAutoEnter } = require('./codex-model-picker');

// Minimal, non-user-data reproduction of the committed frame captured on
// 27 Oct at 00:29:30 UTC. No live PTY, account, transcript or provider call.
const terra = '› Ask Codex to do anything\nGPT-6.1 Terra max fast · Context 27% used ⚠ 1 warning · f2 to view';
const future = '› Ask Codex to do anything\nGPT-7.2 Artemis high · Context 4% used';
const catalog = [{ id: 'gpt-7.2-artemis', label: 'GPT-7.2 Artemis' }];
const opts = { requireSyncMarker: false, requireInitializedComposer: true, source: 'private-fixture' };
const inspect = (text, extra = {}) => inspectCodexInputReadyTextCore(
  selectCodexCurrentInteractiveFrameText(text), '', { ...opts, ...extra });

test('observed Terra display footer proves current composer and its exact known identity offline', () => {
  assert.equal(inspect(terra).ready, true);
  assert.deepEqual(parseCodexVerifiedComposerFooter(terra), { model: 'gpt-6.1-terra', effort: 'max', fast: true,
    proof: 'verified-composer-footer' });
});

test('future multiword GPT footer can prove input readiness without inventing a model ID', () => {
  assert.equal(inspect(future).ready, true);
  assert.equal(parseCodexVerifiedComposerFooter(future), null);
  assert.deepEqual(parseCodexVerifiedComposerFooter(future, catalog), { model: 'gpt-7.2-artemis', effort: 'high',
    fast: false, proof: 'verified-composer-footer' });
  const ambiguous = [...catalog, { id: 'gpt-7.2-other', label: 'GPT-7.2 Artemis' }];
  assert.equal(parseCodexVerifiedComposerFooter(future, ambiguous), null);
  assert.equal(inspect(future, { modelCatalog: ambiguous }).ready, true, 'unknown identity is not unknown composer');
  const longLabel = 'GPT-7.2 Artemis Extended Reasoning Preview';
  const longFrame = `› Ask Codex to do anything\n${longLabel} high · Context 4% used`;
  assert.equal(inspect(longFrame).ready, true);
  assert.equal(parseCodexVerifiedComposerFooter(longFrame), null);
  assert.equal(parseCodexVerifiedComposerFooter(longFrame, [{ id: 'gpt-7.2-artemis', label: longLabel }]).model,
    'gpt-7.2-artemis');
  for (const [label, colliding] of [
    ['Luna Reserve', [{ id: 'gpt-reserve', label: 'Luna Reserve' }, { id: 'other', label: 'Luna Reserve' }]],
    ['gpt-7.2', [{ id: 'gpt-7.2', label: 'One' }, { id: 'other', label: 'gpt-7.2' }]],
  ]) {
    const frame = `› Ask Codex to do anything\n${label} high · Context 4% used`;
    assert.equal(parseCodexVerifiedComposerFooter(frame, colliding), null);
    assert.equal(inspect(frame, { modelCatalog: colliding }).ready, true, 'identity collision cannot erase the composer');
  }
});

test('multiword readiness still requires a current initialized composer and respects blockers', () => {
  for (const blocker of ['auth-required', 'resume-goal', 'trust-directory']) {
    assert.equal(inspect(terra, { blockers: [blocker] }).ready, false, blocker);
  }
  assert.equal(inspect('GPT-6.1 Terra max · Context 27% used').ready, false, 'footer alone is not input');
  assert.equal(inspect('› Ask Codex to do anything\n? for shortcuts').ready, false, 'StartupDraft is not ready');
  assert.equal(inspect('› Ask Codex to do anything\nrandom story max · not a model').ready, false);
  const stale = 'GPT-6.1 Terra max · Context 27% used\nunrelated output\n› Ask Codex to do anything\n? for shortcuts';
  assert.equal(inspect(stale).ready, false, 'old status cannot initialize a newer composer');
});

test('the existing AutoResume readiness waiter accepts the same owned committed frame', async () => {
  const bus = new EventEmitter(); let displayed = '› Ask Codex to do anything\n? for shortcuts';
  const readStatus = async () => ({ status: 'active', toolType: 'codex', inputReady: inspect(displayed).ready,
    launchId: 'L1', lifecycleGeneration: 'G1' });
  const pending = waitForAgentReadyTransition({ tabId: 'T', readStatus, eventBus: bus, timeoutMs: 1000,
    expectedOwner: { launchId: 'L1', lifecycleGeneration: 'G1' } });
  await new Promise(resolve => setImmediate(resolve));
  displayed = terra;
  bus.emit('agent:readiness-changed-internal', null, { tabId: 'T', status: 'ready' });
  assert.equal((await pending).inputReady, true);
  assert.equal(bus.listenerCount('agent:readiness-changed-internal'), 0);
});

test('current-frame settings observer resolves exact catalog labels without publishing an ambiguous ID', () => {
  const owner = { live: true, terminal: {}, lifecycleGeneration: 'G1', runSeq: 1, ownerId: 'S1', sessionId: 'S1' };
  let rows = catalog;
  const published = [], invalidated = [], observer = createCodexLiveSettingsObserver({ capture: () => ({ ...owner }),
    readModelCatalog: () => rows, publish: (_tab, proof) => published.push(proof),
    invalidate: (_tab, prior) => invalidated.push(prior) });
  observer.observe('T', { valid: true, seq: 1, text: future });
  assert.equal(observer.read('T').model, 'gpt-7.2-artemis');
  rows = [...catalog, { id: 'gpt-7.2-other', label: 'GPT-7.2 Artemis' }];
  observer.observe('T', { valid: true, seq: 2, text: future });
  assert.equal(published.length, 1, 'ambiguous new frame cannot publish an invented identity');
  assert.equal(observer.read('T'), null, 'the earlier model is not current proof after an unresolved newer footer');
  assert.equal(invalidated.length, 1); assert.equal(invalidated[0].ownerId, 'S1');
  observer.observe('T', { valid: true, seq: 2, text: future });
  assert.equal(invalidated.length, 1, 'duplicate frame does not repeat invalidation');
  rows = catalog; observer.observe('T', { valid: true, seq: 3, text: future });
  assert.equal(observer.read('T').model, 'gpt-7.2-artemis'); assert.equal(published.length, 2);
});

test('launch card uses the same exact display identity without accepting foreign or ambiguous labels', () => {
  assert.deepEqual(parseCodexVerifiedLaunchCardSettings('│ model: GPT-6.1 Terra max fast /model to change │'), {
    model: 'gpt-6.1-terra', effort: 'max', fast: true, proof: 'verified-launch-card' });
  const futureCard = '│ model: GPT-7.2 Artemis high /model to change │';
  assert.equal(parseCodexVerifiedLaunchCardSettings(futureCard), null);
  assert.equal(parseCodexVerifiedLaunchCardSettings(futureCard, catalog)?.model, 'gpt-7.2-artemis');
  assert.equal(parseCodexVerifiedLaunchCardSettings(futureCard,
    [...catalog, { id: 'gpt-7.2-other', label: 'GPT-7.2 Artemis' }]), null);
  assert.equal(parseCodexVerifiedLaunchCardSettings(
    '│ model: gpt-6.1-sol max /model to change │\n' + futureCard), null, 'a newer unknown card cannot reuse older proof');
  assert.equal(parseCodexVerifiedLaunchCardSettings(
    '│ model: gpt-6.1-sol max /model to change │\n│ model: loading /model to change │'), null,
  'a later loading card invalidates earlier launch settings');
  assert.equal(parseCodexVerifiedLaunchCardSettings('model: GPT-6.1 Terra max /model to change'), null);
});

test('capacity detection retains the committed composer with a multiword model label', () => {
  const snapshot = { success: true, authoritativeFrameCommitted: true, liveSynchronizedOutputOpen: false,
    writeSeq: 12, flushedSeq: 12, lines: [
      { row: 1, text: '⚠ Selected model is at capacity. Please try a different model.', hasNonDefaultFg: true },
      { row: 2, text: '› Ask Codex to do anything' },
      { row: 3, text: 'GPT-7.2 Artemis high · Context 4% used' },
    ] };
  assert.equal(inspectCodexModelCapacityFrame(snapshot).capacity, true);
  assert.equal(inspectCodexModelCapacityFrame({ ...snapshot, authoritativeFrameCommitted: false }).capacity, false);
});

test('a multiword ACK cannot be misread as its first token', () => {
  assert.equal(parseCodexModelChangeAcknowledgement('• Model changed to GPT-7.2 Artemis high'), null);
  assert.deepEqual(parseCodexModelChangeAcknowledgement('• Model changed to GPT-7.2 Artemis high', catalog), {
    model: 'gpt-7.2-artemis', effort: 'high', applicationMode: 'persistent-default', proof: 'tui-model-ack' });
  assert.equal(parseCodexModelChangeAcknowledgement(
    '• Model changed to gpt-6.1-sol max\n• Model changed to GPT-7.2 Artemis high'), null,
  'a newer unresolved ACK cannot reuse an older exact model');
  assert.equal(parseCodexModelChangeAcknowledgement(
    '• Model changed to gpt-6.1-sol max\n• Model changed to ✨'), null,
  'a later malformed native ACK cannot revive the earlier identity');
});

test('automatic settings acknowledgement counts exact display labels without reusing or guessing a model', () => {
  const line = '• Model changed to GPT-6.1 Terra max';
  assert.equal(isCodexModelEffortAppliedMessage(line, 'gpt-6.1-terra', 'max'), true);
  assert.equal(codexModelEffortAppliedMessageCount('• Model changed to gpt-6.1-terra max\n' + line,
    'gpt-6.1-terra', 'max'), 2);
  assert.equal(isCodexModelEffortAppliedMessage('• Model changed to GPT-7.2 Artemis high',
    'gpt-7.2-artemis', 'high'), false);
  assert.equal(isCodexModelEffortAppliedMessage('• Model changed to GPT-7.2 Artemis high',
    'gpt-7.2-artemis', 'high', catalog), true);
  assert.equal(isCodexModelEffortAppliedMessage('• Model changed to GPT-7.2 Artemis high',
    'gpt-7.2-artemis', 'high', [...catalog, { id: 'gpt-7.2-other', label: 'GPT-7.2 Artemis' }]), false);
  assert.equal(isCodexModelEffortAppliedMessage('• Model changed to GPT-6.1 Terra ultra for this conversation',
    'gpt-6.1-terra', 'ultra'), true);
  assert.equal(isCodexModelEffortAppliedMessage('• Model changed to GPT-6.1 Terra ultra',
    'gpt-6.1-terra', 'ultra'), false, 'Ultra still requires conversation-scoped native proof');
  assert.equal(codexModelEffortAppliedMessageCount(
    '• Model changed to gpt-6.1-terra ultra for this conversation\n• Model changed to GPT-6.1 Terra ultra for this conversation',
    'gpt-6.1-terra', 'ultra'), 2);
  assert.equal(isCodexModelEffortAppliedMessage(
    '• Model changed to gpt-6.1-terra max\n• Model changed to GPT-7.2 Artemis high',
    'gpt-6.1-terra', 'max'), false, 'a later unknown model cannot make an earlier ACK current');
  assert.equal(isCodexModelEffortAppliedMessage(
    '• Model changed to gpt-6.1-terra max\n• Model changed to gpt-6-astra high',
    'gpt-6.1-terra', 'max'), false, 'a later different ACK supersedes the old one');
});

test('startup migration ACK resolves the full label, never a guessed or foreign model', () => {
  const output = '• Model changed to GPT-6.1 Terra max';
  assert.equal(parseCodexModelMigrationAcknowledgement(output)?.model, 'gpt-6.1-terra');
  const base = { sameTerminal: true, sameRunSeq: true, sameLaunchId: true, sameInputRevision: true,
    expectedTargetModel: 'gpt-6.1-terra', output };
  assert.equal(decideCodexModelMigrationAcknowledgement(base).allowed, true);
  assert.equal(decideCodexModelMigrationAcknowledgement({ ...base, sameLaunchId: false }).allowed, false);
  assert.equal(decideCodexModelMigrationAcknowledgement({ ...base, expectedTargetModel: 'gpt-6.1-sol' }).allowed, false);
  const futureAck = '• Model changed to GPT-7.2 Artemis high';
  assert.equal(parseCodexModelMigrationAcknowledgement(futureAck), null);
  assert.equal(parseCodexModelMigrationAcknowledgement(futureAck, catalog)?.model, 'gpt-7.2-artemis');
  assert.equal(parseCodexModelMigrationAcknowledgement(futureAck,
    [...catalog, { id: 'gpt-7.2-other', label: 'GPT-7.2 Artemis' }]), null);
  const nonDerived = [{ id: 'gpt-experimental-id', label: 'GPT-7.2 Artemis' }];
  assert.equal(decideCodexModelMigrationAcknowledgement({ ...base, expectedTargetModel: 'GPT-7.2 Artemis',
    output: futureAck, catalog: nonDerived }).allowed, true, 'catalog identity wins over punctuation guessing');
  assert.equal(decideCodexModelMigrationAcknowledgement({ ...base, expectedTargetModel: 'GPT-7.2 Artemis',
    output: futureAck, catalog: [...catalog, { id: 'gpt-7.2-other', label: 'GPT-7.2 Artemis' }] }).allowed, false);
  assert.equal(parseCodexModelMigrationAcknowledgement('• Model changed to GPT-6.1 Terra ultra for this conversation'), null);
  assert.equal(parseCodexModelMigrationAcknowledgement('• Model changed to gpt-6.1-sol max\n• Model changed to ✨'), null);
});

test('migration chooser distinguishes two catalog labels which happen to slugify alike', () => {
  const rows = [{ id: 'gpt-exp-a', label: 'GPT-7.2 Artemis' }, { id: 'gpt-exp-b', label: 'GPT-7.2-Artemis' }];
  const chooser = "Choose how you'd like Codex to proceed.\n› 1. Try new model\n  2. Use existing model\nPress enter to confirm";
  const frame = 'Codex now uses GPT-7.2 Artemis in place of gpt-old. Switch to GPT-7.2-Artemis to continue.\n' + chooser;
  assert.equal(inspectCodexModelMigrationPrompt(frame, rows).modelMetadataValid, false);
  const base = { sameTerminal: true, sameRunSeq: true, sameInputRevision: true, screenAvailable: true,
    cleanText: frame, expectedSourceModel: 'gpt-old', expectedTargetModel: 'gpt-exp-a', catalog: rows };
  assert.equal(decideCodexModelMigrationAutoEnter(base).allowed, false, 'remembered metadata cannot override contradictory live labels');
  assert.equal(decideCodexModelMigrationAutoEnter({ ...base, cleanText: chooser, catalog: [] }).allowed, true,
    'legacy clipped-intro fallback remains available');
});

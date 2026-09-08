import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as preflight from './agentDraftPreflight.mjs';
import { adoptAgentDraftTransferOnce, draftTransferResultFields, readAgentDraftTransfer, recoverAgentDraftTransferToHistory } from './agentDraftTransfer.mjs';

const utilsDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(utilsDir, '..');
const quiet = { log() {}, warn() {}, error() {} };
const source = file => fs.readFileSync(path.join(rendererDir, file), 'utf8');
function part(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'known source boundaries');
  return text.slice(a, b);
}
function fn(text, name, context) {
  return vm.runInNewContext(stripTypeScriptTypes(text.replace(/\bexport /g, '')) + '\n' + name,
    { console: quiet, crypto, ...context });
}
function transferred(text = 'WITHDRAWN [Image #1]\n', success = false) {
  const imagePaths = [{ id: 1, path: '/durable/withdrawn.png', assetId: 'withdrawn', mediaType: 'image/png', size: 123, availability: 'available' }];
  return { success, error: success ? undefined : 'external_editor_return_unconfirmed', text,
    images: 1, imagePaths, editorReturnReady: success,
    draftTransfer: { id: crypto.randomUUID(), tabId: 'T', text, images: 1, imagePaths } };
}
function store() {
  const ui = {
    historyPromptDrafts: { T: 'CURRENT [Image #1]' },
    historyPromptDraftImages: { T: [{ id: 1, path: '/durable/current.png', assetId: 'current', availability: 'available' }] },
    historyPromptDraftChips: { T: [{ id: 'current-chip', kind: 'prompt', label: 'Keep', text: 'CURRENT CHIP' }] },
    writes: 0,
    setHistoryPromptDraft(tab, text, options) {
      this.writes++;
      this.historyPromptDrafts[tab] = text;
      this.historyPromptDraftImages[tab] = options.images;
      this.historyPromptDraftChips[tab] = options.chips;
    },
  };
  return { getState: () => ui };
}

test('readiness failure retains a whole authoring transfer; History merges images/chips exactly once by ID', async () => {
  const result = transferred();
  const ui = store();
  assert.equal((await recoverAgentDraftTransferToHistory(result, 'T', ui)).adopted, true);
  assert.match(ui.getState().historyPromptDrafts.T, /^WITHDRAWN \[Image #2\]\n\nCURRENT \[Image #1\]$/);
  assert.deepEqual(ui.getState().historyPromptDraftImages.T.map(ref => ref.path), ['/durable/current.png', '/durable/withdrawn.png']);
  assert.equal(ui.getState().historyPromptDraftChips.T[0].text, 'CURRENT CHIP');
  assert.equal((await recoverAgentDraftTransferToHistory(result, 'T', ui)).adopted, false);
  assert.equal(ui.getState().writes, 1);
  const another = transferred();
  await recoverAgentDraftTransferToHistory(another, 'T', ui);
  assert.equal(ui.getState().writes, 2, 'identical bytes from another operation remain another draft');
  assert.equal(ui.getState().historyPromptDrafts.T.match(/WITHDRAWN/g).length, 2);
});

test('one transferred snapshot cannot be adopted by two independent receivers; failed receiver releases ownership', async () => {
  const result = transferred();
  const snapshot = readAgentDraftTransfer(result);
  const ui = store();
  let finish;
  const queue = adoptAgentDraftTransferOnce(snapshot, 'queue:T', () => new Promise(resolve => { finish = resolve; }));
  assert.equal((await recoverAgentDraftTransferToHistory(result, 'T', ui)).adopted, false);
  finish();
  assert.equal((await queue).adopted, true);
  assert.equal(ui.getState().writes, 0);
  const failed = transferred();
  await assert.rejects(adoptAgentDraftTransferOnce(readAgentDraftTransfer(failed), 'queue:T', () => { throw new Error('queue unavailable'); }));
  assert.equal((await recoverAgentDraftTransferToHistory(failed, 'T', ui)).adopted, true);
});

for (const provider of ['claude', 'codex']) {
  test(provider + ' actual wrapper does not share independent destructive captures, but retries of one request may join', async () => {
    const isClaude = provider === 'claude';
    const name = isClaude ? 'captureClaudePtyDraft' : 'captureCodexDraft';
    const text = source('utils/' + (isClaude ? 'claudePtyActions.ts' : 'historyAgentRuntimes.ts'));
    const body = part(text, 'async function ' + name + '(', isClaude ? '\nexport async function grabClaudePtyDraft(' : '\nfunction grabCodexDraft(');
    const calls = [];
    const capture = fn(body, name, {
      draftGrabInflight: new Map(), codexDraftInflight: new Map(), shortTab: String, errorText: String,
      ipcRenderer: { invoke(channel, tab, options) {
        return new Promise(resolve => calls.push({ channel, tab, options, resolve }));
      } },
    });
    const first = capture('T', 'grab');
    const second = capture('T', 'grab');
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].options.captureRequestId, calls[1].options.captureRequestId);
    calls[0].resolve({ success: true, text: 'first independent draft' });
    calls[1].resolve({ success: true, text: '' });
    assert.notEqual((await first).text, (await second).text);
    const retryA = capture('T', 'grab', { captureRequestId: 'same-operation' });
    const retryB = capture('T', 'grab', { captureRequestId: 'same-operation' });
    assert.equal(calls.length, 3);
    const copy = capture('T', 'copy', { captureRequestId: 'same-operation' });
    assert.equal(calls.length, 4, 'copy never inherits destructive semantics');
    calls[2].resolve({ success: true, text: 'one logical transfer' });
    calls[3].resolve({ success: true, text: 'non-destructive copy' });
    assert.equal((await retryA).text, (await retryB).text);
    assert.equal((await copy).text, 'non-destructive copy');
  });
}

test('actual History reader returns acquired payload on readiness failure and recovers stale-tab payload to its owner', async () => {
  const text = source('components/Workspace/HistoryPanel.tsx');
  const body = part(text, '  const readTerminalDraft = useCallback(', '\n  useEffect(() => {\n    if (!runtime.supportsInterruptRecovery)');
  const result = transferred();
  const ui = store();
  const tabIdRef = { current: 'T' };
  const read = fn(body, 'readTerminalDraft', {
    ...preflight, useCallback: f => f, tabId: 'T', tabIdRef,
    runtime: { toolType: 'claude', label: 'Claude', logPrefix: 'test', probeDraft: async () => ({ proofOutcome: 'found', hasDraft: true, preview: 'WITHDRAWN' }), grabDraft: async () => result },
    terminalRegistry: { getDraftDiagnosticSnapshot: () => null }, draftGrabErrorText: r => r.error,
    readAgentDraftTransfer, recoverAgentDraftTransferToHistory, useUIStore: ui,
  });
  const captured = await read('manual-pull');
  assert.equal(captured.text, result.text);
  assert.equal(captured.imagePaths[0].assetId, 'withdrawn');
  assert.equal(captured.captureError, 'external_editor_return_unconfirmed');
  assert.equal(captured.draftTransfer.id, result.draftTransfer.id);
  tabIdRef.current = 'OTHER';
  assert.equal((await read('manual-pull')).stale, true);
  assert.match(ui.getState().historyPromptDrafts.T, /WITHDRAWN/);
  assert.equal(ui.getState().historyPromptDrafts.OTHER, undefined);
});

test('actual Queue capture accepts acquired payload despite readiness failure and falls back to History on enqueue failure', async () => {
  const body = part(source('components/Workspace/PromptQueueOverlay.tsx'), '  const grabCurrent = useCallback(', '\n  // The visible trigger now lives');
  for (const fail of [false, true]) {
    const result = transferred();
    const ui = store();
    const queued = [];
    const grab = fn(body, 'grabCurrent', {
      useCallback: f => f, tabId: 'T', sessionType: 'codex', agentLabel: 'Codex',
      resolveActiveInputSurface: () => 'terminal', ipcRenderer: { invoke: async () => result },
      useUIStore: ui, readAgentDraftTransfer, adoptAgentDraftTransferOnce, recoverAgentDraftTransferToHistory,
      enqueueGrabbedPrompt: async (text, images, refs) => { if (fail) throw new Error('queue unavailable'); queued.push({ text, images, refs }); },
      showToast() {}, focusActiveTerminal() {}, focusHistoryComposer() {}, GRAB_ERROR_TOASTS: {},
    });
    await grab();
    assert.equal(queued.length, fail ? 0 : 1);
    if (fail) assert.match(ui.getState().historyPromptDrafts.T, /WITHDRAWN/);
    else {
      assert.equal(queued[0].text, result.text);
      assert.equal(queued[0].refs[0].assetId, 'withdrawn');
      assert.equal(ui.getState().writes, 0);
    }
  }
});

test('actual late send preflight returns full transfer refs; cancellation carries the same snapshot without Send', async () => {
  const text = source('utils/agentSendPreparation.ts');
  const body = part(text, 'const buildDraftCaptureProof =', '\nexport function createAgentReadyWait(')
    + text.slice(text.indexOf('export async function proveAgentComposerForSend('));
  for (const cancel of [false, true]) {
    const result = transferred();
    const prove = fn(body, 'proveAgentComposerForSend', {
      ...preflight, readAgentDraftTransfer, draftTransferResultFields,
      terminalRegistry: { getDraftDiagnosticSnapshot: () => null },
    });
    let checks = 0;
    const task = prove({ tabId: 'T', toolType: 'claude', statusForSend: 'active', source: 'history-panel', returnDraftOnConflict: true,
      providerContract: { carriesExactEmptyEvidence: false },
      runtime: { label: 'Claude', probeDraft: async () => ({ hasDraft: true, proofOutcome: 'found', preview: 'WITHDRAWN' }), grabDraft: async () => result },
      assertSendNotCancelled() { if (cancel && ++checks >= 2) throw new Error('send cancelled'); },
    });
    if (cancel) {
      await assert.rejects(task, error => error.draftTransfer.id === result.draftTransfer.id && error.draftImagePaths[0].assetId === 'withdrawn');
    } else {
      const refused = await task;
      assert.equal(refused.complete, true);
      assert.equal(refused.result.submitted, false);
      assert.equal(refused.result.draftTransfer.id, result.draftTransfer.id);
      assert.equal(refused.result.draftImagePaths[0].assetId, 'withdrawn');
    }
  }
});

test('actual App draft bridge keeps transport success for a domain failure carrying captured ownership', async () => {
  const body = part(source('App.tsx'), "        if (action === 'grabAgentDraft' || action === 'grabAgentDraftScenario') {", "        if (action === 'inspectAgentDraft'");
  const result = transferred();
  const handle = fn('async function handle(){' + body + '}', 'handle', {
    action: 'grabAgentDraftScenario', payload: { tabId: 'T' }, describeAgentTab: () => ({ toolType: 'claude', runtime: {} }),
    grabAgentDraftScenario: async () => result, reply: (...args) => args,
  });
  const [ok, data] = await handle();
  assert.equal(ok, true);
  assert.equal(data.success, false);
  assert.equal(data.draftTransfer.id, result.draftTransfer.id);
  assert.equal(data.imagePaths[0].assetId, 'withdrawn');
});

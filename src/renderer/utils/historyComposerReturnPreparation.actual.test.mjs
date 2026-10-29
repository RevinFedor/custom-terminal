import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { beginComposerReturnPreparation, finishComposerReturnPreparation,
  composerReturnPreparationView } from './historyComposerReturnPreparation.mjs';

const require = createRequire(import.meta.url), ts = require('typescript');
const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const dismissPromptPresentation = useCallback(');
const end = source.indexOf('\n\n  const acknowledgeMaterializedHistoryReceipt', start);
assert(start > 0 && end > start, 'actual return handler boundaries');
const code = ts.transpileModule(source.slice(start, end) + '\nglobalThis.callback = dismissPromptPresentation;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

function fixture() {
  let preparation = [];
  const requests = [], pending = new Map(), restored = [], removed = [], errors = [];
  const handoffs = ['H1', 'H2'].map(handoffId => ({ handoffId, toolType: 'codex', historyReturn: { token: 'T-' + handoffId } }));
  const context = {
    useCallback: fn => fn, tabId: 'A', sessionId: 'sid', toolType: 'codex',
    returnPromptInflight: { current: new Set() },
    getHistoryPromptHandoffsSnapshot: () => handoffs,
    isLocalPromptEntry: () => true, historySendPresentationAction: () => ({ kind: 'return' }),
    historySendReturnEnabled: () => true,
    beginComposerReturnPreparation, finishComposerReturnPreparation,
    setComposerReturnPreparations: fn => { preparation = fn(preparation); },
    ipcRenderer: { invoke(channel, value) {
      requests.push({ channel, ...value });
      if (channel === 'agent:register-history-send-return') return new Promise((resolve, reject) => pending.set(value.handoffId, { resolve, reject }));
      if (channel === 'agent:return-history-send') return Promise.resolve({ success: true, returned: true, restored: true });
      if (channel === 'agent:ack-history-send-return') return Promise.resolve({ success: true });
      throw Error('unexpected scenario ' + channel);
    } },
    recordHistorySendReturnControl() {}, releaseReturnedHistoryPreparation() {},
    useUIStore: { getState: () => ({ showToast() {}, restoreHistorySendDraft: v => restored.push(v), acknowledgeHistorySendDraftReturn() {} }) },
    removeHistorySendRecovery() {}, consumeHistoryPromptHandoff() {},
    removeLocalPromptEntry: (...v) => removed.push(v),
    isHistorySendReturnRestored: () => false,
    showHistoryIncidentToast: (_tabId, error) => errors.push(error.message),
  };
  vm.runInNewContext(code, context);
  return { run: handoffId => context.callback({ handoffId }), pending, requests, restored, removed, errors,
    visible: (tabId = 'A', sid = 'sid') => composerReturnPreparationView(preparation, tabId, sid),
    preparation: () => preparation };
}

test('actual return handler publishes status before first IPC await and settles after exact ACK', async () => {
  const f = fixture(), operation = f.run('H1');
  assert.equal(f.visible().label, 'Возвращаю сообщение…');
  assert.deepEqual(f.requests.map(x => x.channel), ['agent:register-history-send-return']);
  f.pending.get('H1').resolve({ success: true });
  await operation;
  assert.equal(f.visible(), null);
  assert.deepEqual(f.requests.map(x => x.channel), ['agent:register-history-send-return', 'agent:return-history-send', 'agent:ack-history-send-return']);
  assert.equal(f.removed.length, 1);
  assert.equal(f.restored.length, 0); // already-adopted Main event is not duplicated
});
test('actual overlapping returns and out-of-order completion keep the remaining loader', async () => {
  const f = fixture(), first = f.run('H1'), second = f.run('H2');
  assert.equal(f.visible().count, 2);
  f.pending.get('H2').resolve({ success: true });
  await second;
  assert.equal(f.visible().count, 1);
  f.pending.get('H1').resolve({ success: true });
  await first;
  assert.equal(f.visible(), null);
});
test('actual unknown registration clears presentation without restoring, replay or another mutation', async () => {
  const f = fixture(), operation = f.run('H1');
  f.pending.get('H1').reject(Error('registration outcome unknown'));
  await operation;
  assert.equal(f.visible(), null);
  assert.equal(f.requests.length, 1);
  assert.equal(f.restored.length, 0);
  assert.equal(f.removed.length, 0);
  assert.deepEqual(f.errors, ['registration outcome unknown']);
});
test('actual pending request does not display under another owner or clear an independent return', async () => {
  const f = fixture(), first = f.run('H1'), second = f.run('H2');
  assert.equal(f.visible('B'), null);
  assert.equal(f.visible('A', 'replacement'), null);
  f.pending.get('H1').reject(Error('old request failed'));
  await first;
  assert.equal(f.visible().count, 1);
  f.pending.get('H2').resolve({ success: true });
  await second;
  assert.equal(f.visible(), null);
});

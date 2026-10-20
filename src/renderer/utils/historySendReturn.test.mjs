import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreHistorySendDraft, historySendReturnEnabled, historySendPresentationAction } from './historySendReturn.mjs';
import { splitComposerDraftMemory } from './composerDraftPersistence.mjs';

const state = () => ({ historyPromptDrafts: { T: 'new [Image #1]' },
  historyPromptDraftImages: { T: [{ id: 1, path: '/new.png', assetId: 'new' }] },
  historyPromptDraftChips: { T: [{ id: 'new', kind: 'prompt', text: 'new chip', sourceKey: 'same' }] },
  historyPromptDraftPendingImages: {}, historyPromptDraftUpdatedAt: {}, historyPromptReturnedSends: {} });
const input = { tabId: 'T', handoffId: 'H', token: 'return-H', text: 'old [Image #1]',
  images: [{ id: 1, path: '/old.png', assetId: 'old' }],
  chips: [{ id: 'old', kind: 'prompt', text: 'old chip', label: 'Old', sourceKey: 'same',
    attachmentKind: 'file', filePath: '/original.md', inheritanceDepth: 1, inheritanceParentLabel: 'Parent' }] };
test('returns original before next draft; image ids/chips and adoption receipt persist together', () => {
  const original = state(); let persisted;
  const r = restoreHistorySendDraft(original, input, bytes => { persisted = JSON.parse(bytes); }, 100);
  assert.equal(r.adopted, true);
  assert.equal(original.historyPromptDrafts.T, 'new [Image #1]');
  const saved = splitComposerDraftMemory(persisted);
  assert.match(saved.drafts.T, /^old \[Image #2\]\n\nnew \[Image #1\]$/);
  assert.deepEqual(saved.images.T.map(ref => ref.assetId), ['new', 'old']);
  assert.deepEqual(saved.chips.T.map(chip => chip.text), ['old chip', 'new chip']);
  assert.equal(saved.chips.T[0].filePath, '/original.md');
  assert.equal(saved.chips.T[0].inheritanceParentLabel, 'Parent');
  assert.deepEqual(saved.returnedByTab.T, ['return-H']);
  const reloaded = { ...original, ...r.patch, historyPromptReturnedSends: saved.returnedByTab };
  assert.equal(restoreHistorySendDraft(reloaded, input, bytes => {
    assert.equal(JSON.parse(bytes).T.text, saved.drafts.T, 'mirror retry must not prepend twice');
  }).adopted, false);
});
test('storage failure does not publish adoption or mutate the next draft', () => {
  const original = state();
  assert.throws(() => restoreHistorySendDraft(original, input, () => { throw Error('quota'); }), /quota/);
  assert.equal(original.historyPromptDrafts.T, 'new [Image #1]');
  assert.deepEqual(original.historyPromptReturnedSends, {});
});
test('button returns before payload, never hides/returns a possibly written message', () => {
  for (const queueStatus of ['preparing', 'sending', 'application-queued'])
    assert.equal(historySendReturnEnabled({ queueStatus, historyReturn: { token: 'H', state: 'available' } }), true);
  for (const queueStatus of ['sent', 'queued', 'audit-pending', 'delivery-unknown'])
    assert.equal(historySendReturnEnabled({ queueStatus, historyReturn: { token: 'H', state: 'available' } }), false);
  assert.equal(historySendReturnEnabled({ queueStatus: 'preparing', historyReturn: { token: 'H', state: 'writing' } }), false);
  assert.equal(historySendReturnEnabled({ queueStatus: 'preparing', enterAttemptAt: 1, historyReturn: { token: 'H', state: 'available' } }), false);
  assert.equal(historySendReturnEnabled({ queueStatus: 'application-queued' }), false);
  assert.equal(historySendReturnEnabled({ queueStatus: 'queued', statusReason: 'send-ready-queued',
    historyReturn: { token: 'H', state: 'available' } }), true, 'busy-ready is not native queue acceptance');
});

test('failed/cancelled/unknown cards dismiss, while pending sends retain the existing return fence', () => {
  for (const queueStatus of ['failed', 'cancelled', 'delivery-unknown']) {
    for (const historyReturn of [undefined, { token: 'H', state: 'available' }, { token: 'H', state: 'writing' }]) {
      assert.deepEqual(historySendPresentationAction({ queueStatus, historyReturn }), { kind: 'dismiss', enabled: true });
    }
  }
  for (const queueStatus of ['preparing', 'sending', 'application-queued', 'queued', 'audit-pending', 'sent']) {
    const entry = { queueStatus, historyReturn: { token: 'H', state: 'available' } };
    assert.deepEqual(historySendPresentationAction(entry), { kind: 'return', enabled: historySendReturnEnabled(entry) });
  }
  assert.deepEqual(historySendPresentationAction({ queueStatus: 'delivery-unknown',
    historyReturn: { token: 'H', state: 'returned' } }), { kind: 'return', enabled: true },
  'an already Main-fenced return must still finish its original authoring adoption');
});

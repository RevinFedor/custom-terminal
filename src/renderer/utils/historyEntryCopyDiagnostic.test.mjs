import test from 'node:test';
import assert from 'node:assert/strict';
import { historyEntryCopyDiagnostic } from './historyEntryCopyDiagnostic.mjs';

test('only unconfirmed ID-copy attaches the exact owning tab/message metadata', () => {
  const entry = { uuid: 'message-A', sessionId: 'session-A', handoffId: 'handoff-A',
    queueStatus: 'delivery-unknown', content: '  prompt\ntext', imagePaths: ['/image.png'],
    promptChips: [{ id: 'one' }, { id: 'two' }] };
  const result = historyEntryCopyDiagnostic(entry, 'background-tab-A', 'codex', 42);
  assert.equal(result.tabId, 'background-tab-A');
  assert.equal(result.messageId, 'message-A');
  assert.equal(result.handoffId, 'handoff-A');
  assert.equal(result.promptText, '  prompt\ntext');
  assert.equal(result.chipCount, 2);
  assert.deepEqual(result.imagePaths, ['/image.png']);
  assert.equal(result.requestedAt, 42);
  assert.equal(historyEntryCopyDiagnostic(entry, 'tab-A', 'claude', 42).toolType, 'claude');
  for (const queueStatus of [undefined, 'queued', 'sent', 'preparing', 'sending', 'audit-pending', 'failed']) {
    assert.equal(historyEntryCopyDiagnostic({ ...entry, queueStatus }, 'tab-A', 'codex'), null);
  }
  assert.equal(historyEntryCopyDiagnostic(entry, '', 'codex'), null);
  assert.equal(historyEntryCopyDiagnostic(entry, 'tab-A', 'gemini'), null);
});

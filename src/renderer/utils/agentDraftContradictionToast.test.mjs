import test from 'node:test';
import assert from 'node:assert/strict';
import { showAgentDraftScreenContradictionToast } from './agentDraftContradictionToast.mjs';

test('recovered screen contradiction produces one persistent tab-scoped warning with a copyable report', () => {
  const calls = [];
  const store = {
    toasts: [],
    showToast(...args) {
      calls.push(args);
      this.toasts.push({
        message: args[0],
        type: args[1],
        persistent: args[3],
        tabId: args[7],
        details: args[9],
        copyText: args[4],
      });
    },
  };

  assert.equal(showAgentDraftScreenContradictionToast(store, {
    tabId: 'tab-a',
    label: 'Claude',
  }).shown, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'warning');
  assert.equal(calls[0][3], true);
  assert.equal(calls[0][7], 'tab-a');
  assert.match(calls[0][4], /Noted Terminal input diagnostic/);
  assert.match(calls[0][4], /Tab ID: tab-a/);
  assert.match(calls[0][4], /not delivery confirmation/);
  assert.match(calls[0][4], /Log lookup: \[AgentDraftProof:CONTRADICTION\]/);
  assert.doesNotMatch(calls[0][9], /Diagnostics were saved/);

  assert.equal(showAgentDraftScreenContradictionToast(store, {
    tabId: 'tab-a',
    label: 'Claude',
  }).reason, 'already-visible');
  assert.equal(calls.length, 1);

  assert.equal(showAgentDraftScreenContradictionToast(store, {
    tabId: 'tab-b',
    label: 'Claude',
  }).shown, true);
  assert.equal(calls.length, 2);
});

test('Copy identifies the exact capture and includes both before/after input ownership without private draft text', () => {
  const calls = [];
  showAgentDraftScreenContradictionToast({ showToast: (...args) => calls.push(args) }, {
    tabId: 'T', label: 'Codex', occurredAt: Date.parse('2026-09-10T10:36:43.094Z'),
    screenProof: { source: 'headless:empty+visual-positive', hasDraft: true, inputRevision: 3,
      terminalLifecycleGeneration: 'G', terminalRunSeq: 1, mirrorGeneration: 'M',
      preview: 'PRIVATE DRAFT' },
    exactCapture: { proofOutcome: 'absent', proofReason: 'external-editor-empty-current-frame',
      inputRevision: 4, captureRequestId: 'exact-capture', text: '' },
  });
  const report = calls[0][4];
  assert.match(report, /13:36:43.094 MSK/);
  assert.match(report, /Capture request ID: exact-capture/);
  assert.match(report, /Input revision: 3 → 4/);
  assert.match(report, /Lifecycle: G/);
  assert.doesNotMatch(report, /PRIVATE DRAFT/);
});

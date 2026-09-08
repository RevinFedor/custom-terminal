'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repo = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(repo, 'src/main/main.js'), 'utf8');
const runner = fs.readFileSync(
  path.join(repo, 'src/renderer/hooks/usePromptQueueRunner.ts'),
  'utf8',
);
const receiptStore = fs.readFileSync(
  path.join(repo, 'src/main/agent-send-receipt-store.js'),
  'utf8',
);
const webServer = fs.readFileSync(path.join(repo, 'src/main/web-server.js'), 'utf8');

const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

test('every committed headless frame checks exact Codex native queue acceptance', () => {
  const commit = between(
    main,
    'function commitHeadlessVisibleBufferSnapshot',
    'function parseClaudeDraftFromVisibleSnapshot',
  );
  assert.match(commit, /observeCodexQueuedMessageCommittedFrame\(tabId, state, committed\)/);

  const staging = between(
    main,
    'stagedCodexAudit = {',
    'enqueueCodexPasteAudit\(broadcastTabId, stagedCodexAudit\)',
  );
  assert.match(staging, /queuedAtSubmit: queuedAtSubmit === true/);
  assert.match(staging, /queueScreenBaseline = captureCodexQueuedMessageAuditBaseline/);
});

test('queue proof resolves the caller but leaves the exact rollout audit pending', () => {
  const accept = between(
    main,
    'function acceptCodexQueuedMessageAudit',
    'function observeCodexQueuedMessageCommittedFrame',
  );
  assert.match(accept, /markProviderQueueAccepted/);
  assert.match(accept, /audit\.providerQueueAcceptedResult = result/);
  assert.match(accept, /audit\.resolve\(result\)/);
  assert.doesNotMatch(accept, /finishCodexPasteAudit|removePendingCodexPasteAudit/);

  const wait = between(
    main,
    'function waitForCodexPasteAudit',
    'function markCodexAuditDeliveryUnknown',
  );
  assert.match(wait, /if \(audit\.providerQueueAcceptedResult\)/);
  assert.match(wait, /return Promise\.resolve\(audit\.providerQueueAcceptedResult\)/);
});

test('renderer projects native Codex queue proof before generic failure handling', () => {
  const handler = between(
    runner,
    "const onPromptAuditResult =",
    "ipcRenderer.on('agent-prompt:audit-result'",
  );
  const queued = handler.indexOf("detail?.providerQueueAccepted === true");
  const success = handler.indexOf('detail.success === true');
  assert.ok(queued >= 0, 'provider queue branch missing');
  assert.ok(success > queued, 'generic success/failure handling runs before queue proof');
  assert.match(handler, /acceptHistoryPromptHandoffProviderQueue/);
});

test('durable provider queue evidence may arrive after timeout without becoming a second attempt', () => {
  assert.match(
    receiptStore,
    /state IN \('enter-armed', 'audit-pending', 'delivery-unknown'\)/,
  );
  assert.match(
    receiptStore,
    /record\.state !== STORE_STATES\.DELIVERY_UNKNOWN/,
  );
});

test('Project API, Inbox and orchestration expose provider acceptance as queued', () => {
  assert.match(
    webServer,
    /if \(isAgentSendProviderQueueAccepted\(data\)\)[\s\S]{0,420}status: 'queued'/,
  );
  assert.match(
    webServer,
    /if \(isAgentSendProviderQueueAccepted\(sendResult\)\)[\s\S]{0,760}status: 'queued'/,
  );
  assert.match(
    webServer,
    /receiptState: 'queued'/,
  );
  assert.match(
    webServer,
    /delivery\.receiptState === 'queued'[\s\S]{0,180}\? 'queued'/,
  );
});

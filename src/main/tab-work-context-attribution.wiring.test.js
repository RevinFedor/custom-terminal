'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const context = fs.readFileSync(path.join(__dirname, 'tab-work-context.js'), 'utf8');

function sliceBetween(start, end) {
  const from = main.indexOf(start);
  const to = main.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing main block ${start}`);
  return main.slice(from, to);
}

test('writer lifecycle refreshes attribution subscriptions from exact live ownership', () => {
  const configure = sliceBetween('tabWorkContext.configure({', "console.log('[Startup] Starting Mobile WebServer...')");
  assert.match(configure, /getCodexWriterProofSnapshot\(tab\.tabId\)\?\.sessionId/);
  assert.match(configure, /bridgeKnownSessions\.get\(tab\.tabId\)/);

  const adoption = sliceBetween('proofRecord.acceptedResumeSource =', 'if (proofChanged && mainWindow');
  assert.ok(adoption.indexOf('const proofChanged =') < adoption.indexOf('[TabContext] Codex source sync:'),
    'the sync must not read proofChanged before it is initialized');

  const invalidation = sliceBetween('function invalidateCodexWriterProof(', 'function clearCodexKnownSession(');
  assert.match(invalidation, /codexWriterProofs\.set[\s\S]*\[TabContext\] Codex source invalidate:/);
  const clear = sliceBetween('function clearCodexKnownSession(', 'function claimCodexResumeSourceLease(');
  assert.match(clear, /hadWriterProof[\s\S]*codexWriterProofs\.delete[\s\S]*\[TabContext\] Codex source clear:/);
  const bridge = sliceBetween('bridgeKnownSessions.set(tabId, data.session_id);', '// Save session link for Clear Context');
  assert.match(bridge, /\[TabContext\] Claude source sync:/);
  const bridgeClear = sliceBetween('function clearBridgeTab(', 'function publishClaudePromptReady(');
  assert.match(bridgeClear, /bridgeKnownSessions\.delete[\s\S]*\[TabContext\] Claude source clear:/);
});

test('file provenance subscribes only resolver-approved sessions and exposes structured sources', () => {
  assert.match(context, /const binding = this\.attributionBinding\(tab, isOwner\)/);
  assert.match(context, /this\.resolveAttributionSource\) return null/);
  assert.match(context, /sourceTabs,/);
  assert.match(context, /hasUnknownSource,/);
  assert.match(context, /provenanceCoversTransition/);
  assert.match(context, /acceptAgentRead/);
  assert.match(context, /acknowledgedText/);
  assert.match(main, /tab-work-context:restore-dismissed/);
  assert.match(main, /tab-work-context:delete/);
  assert.match(main, /tabWorkContext\.dismiss\(tabId, updateId, updateIds\)/);
  assert.match(main, /tabWorkContext\.deleteUpdate\(tabId, updateId, updateIds\)/);
  assert.match(main, /tabWorkContext\.restoreDismissed\(tabId, updateId, updateIds\)/);
});

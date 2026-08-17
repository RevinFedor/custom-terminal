'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return source.slice(from, to);
}

test('Claude abnormal process boundaries publish one exact terminal lifecycle outcome', () => {
  const helper = between(
    main,
    'function emitClaudeAbnormalTurnEnd',
    '\nconst claudeTurnWatchdog',
  );
  const clear = between(main, 'function clearBridgeTab', '\nfunction publishClaudePromptReady');
  const watchdog = between(main, 'function scheduleClaudeTurnWatchdog', '\n// Awaiting-user-input state');

  assert.match(helper, /getActiveAgentExecutionContext\(tabId\)/);
  assert.match(helper, /type: 'busy', busy: false/);
  assert.match(helper, /type: 'done'/);
  assert.match(clear, /if \(wasTurnBusy\) emitClaudeAbnormalTurnEnd\(tabId, reason\)/);
  assert.match(watchdog, /emitClaudeAbnormalTurnEnd\(tabId, 'watchdog'\)/);
});

test('Codex background agents feed the same durable orchestration lifecycle', () => {
  const publish = between(main, 'function publishTabBackgroundWork', '\nfunction clearClaudeBackgroundSidecarTimer');
  const codex = between(main, 'function emitCodexBusy', '\n// Live context-window');
  const lifecycle = between(web, 'async function processOrchestrationLifecycle', '\nasync function performE2eBoundaryAction');

  assert.match(publish, /type: 'background-work'/);
  assert.match(codex, /backgroundWorkCount: getCombinedTabBackgroundWorkCount\(tabId\)/);
  assert.match(lifecycle, /'background-work'/);
});

test('source completion waits for idle and reuses the shared History receipt authority', () => {
  const send = between(
    web,
    'async function sendOrchestrationCompletionNotification',
    '\nasync function notifyAgentPromptAuditResult',
  );
  assert.match(send, /notification-deferred-source-busy/);
  assert.match(send, /queue: false/);
  assert.doesNotMatch(send, /sendOperationKey:/);
});

test('startup repairs a reserved target or makes its absence explicit', () => {
  const recover = between(
    web,
    'async function recoverMissingOrchestrationTarget',
    '\nasync function reconcileActiveOrchestrations',
  );
  assert.match(recover, /reservedTabId: current\.targetTabId/);
  assert.match(recover, /targetMaterializedAt: Date\.now\(\)/);
  assert.match(recover, /handleTargetClosed/);
});

test('authoritative done bounds transcript materialization instead of waiting forever', () => {
  assert.match(web, /ORCHESTRATION_RESULT_PROOF_FLUSH_GRACE_MS = 60_000/);
  assert.match(web, /resultProofDeadlineAt: resultComplete/);
  assert.match(web, /beginResultProofRecovery\(/);
});

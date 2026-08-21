'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const claudeHistorySource = fs.readFileSync(path.join(__dirname, 'ipc', 'claude-data.js'), 'utf8');
const historySource = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'HistoryPanel.tsx'),
  'utf8',
);

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, 'missing start: ' + startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, 'missing end: ' + endNeedle);
  return source.slice(start, end);
}

test('operational compact state is runtime-owned and remount-queryable, never transcript-rehydrated', () => {
  const runtimeOwner = sourceBetween(
    mainSource,
    'const compactOperations = createCompactOperationRegistry({',
    'const agentSendCancellations =',
  );
  assert.match(runtimeOwner, /agent:operational-phase/);
  assert.match(runtimeOwner, /\[CompactOperation\]/);
  assert.match(mainSource, /ipcMain\.handle\('agent:get-operational-phase'[\s\S]{0,300}compactOperations\.snapshot/);
  assert.doesNotMatch(
    sourceBetween(mainSource, "ipcMain.handle('agent:get-operational-phase'", "ipcMain.handle('claude:startup-slash-proof'"),
    /JSONL|readFile|history|getFullHistory/,
  );
});

test('Claude starts only after physical submit and settles from its exact watcher owner', () => {
  const activate = sourceBetween(
    mainSource,
    'function activateClaudeLocalCommandWatcher(',
    'function startClaudeLocalCommandWatcher(',
  );
  assert.ok(activate.indexOf('claudeLocalCommandWatchers.set(tabId, state)') >= 0);
  assert.ok(
    activate.indexOf('compactOperations.begin({')
      > activate.indexOf('claudeLocalCommandWatchers.set(tabId, state)'),
  );
  const stop = sourceBetween(
    mainSource,
    'function stopClaudeLocalCommandWatcher(',
    'function completeClaudeLocalCommand(',
  );
  assert.match(stop, /compactOperations\.finish\(\{[\s\S]{0,350}claudeCompactOutcomeFromReason\(reason\)/);
  assert.doesNotMatch(activate, /30 \* 60 \* 1000|TIMEOUT/,
    'a fixed timer must not decide whether compact completed');
});

test('Codex manual xterm compact stays pending until task_started, while public submit keeps user_message audit', () => {
  const body = sourceBetween(
    mainSource,
    'function processCodexTurnLine(',
    'function inferCodexBusyFromText(',
  );
  const activation = sourceBetween(
    mainSource,
    'function activateCodexManualCompactAfterPtyWrite(',
    '// ─── JSONL interruption watcher implementation',
  );
  assert.match(body, /classifyCodexCompactEvidence\(record\)/);
  assert.match(body, /compactEvidence\.kind === 'start'[\s\S]{0,1800}compactOperations\.begin/);
  assert.match(body, /event === 'task_started'[\s\S]{0,1000}compactOperations\.getPending|event === 'task_started'[\s\S]{0,1000}reconcileCodexManualCompactPendingOwner/);
  assert.match(body, /event === 'task_started'[\s\S]{0,1800}compactOperations\.confirmStart/);
  assert.doesNotMatch(body, /user_message-after-manual-enter/,
    'manual user_message telemetry must not activate compacting');
  assert.match(body, /compactEvidence\.kind === 'terminal'[\s\S]{0,1500}compactOperations\.finish/);
  assert.match(mainSource, /function trackCodexInputLineForCompact\(/);
  assert.match(mainSource, /function activateCodexManualCompactAfterPtyWrite\(/);
  assert.match(activation, /compactOperations\.armPending\(/);
  assert.doesNotMatch(activation, /compactOperations\.begin\(/);
  assert.match(activation, /promptGeneration: boundary\.promptSeq/);
  assert.match(activation, /terminal: boundary\.terminal/);
  assert.match(mainSource, /manualCompactIntentPending[\s\S]{0,1200}promptInFlight = manualCompactIntentPending[\s\S]{0,80}\? null/,
    'pending compact must not create the generic pre-task loader window');
  assert.match(mainSource, /\^\[\\r\\n\]\+\$[\s\S]{0,250}cancelCodexManualCompactPending/,
    'Enter-only input preserves pending while other manual content cancels it');
  assert.match(body, /different-user-message/);
  assert.match(body, /userMessageAudit\?\.matched === true[\s\S]{0,700}different-submit/,
    'a separately audited exact submit must supersede stale manual pending');
  assert.match(body, /prompt-generation-changed/);
  assert.match(mainSource, /input-escape/);
  assert.match(mainSource, /input-ctrl-c/);
  assert.match(mainSource, /function closeCodexTurnWatcher[\s\S]{0,400}cancelCodexManualCompactPending/);
  assert.match(mainSource, /async function stopAiProcessInTab[\s\S]{0,900}cancelCodexManualCompactPending/);
  assert.match(mainSource, /origin === 'user' \|\| origin === 'unknown'/);
  assert.match(mainSource, /causalStartRequired: false/,
    'public rollout user_message remains the external-submit proof');
  assert.doesNotMatch(body, /context_compacted[\s\S]{0,120}compactOperations\.finish/,
    'Codex context telemetry is not the durable compacted record');
});

test('History slash compact supplies the provider before arming its pending operation', () => {
  const handler = sourceBetween(
    mainSource,
    "ipcMain.handle('codex:send-live-slash-command'",
    '// ========== GEMINI REWIND',
  );
  const compactBranch = sourceBetween(
    handler,
    "if (String(command || '').trim() === '/compact')",
    'const result = await sendCodexLiveSlashCommand',
  );
  assert.match(compactBranch, /compactOperations\.armPending\(\{[\s\S]{0,180}provider:\s*'codex'/);
  assert.match(
    handler,
    /ignorePendingCompactOperationId:\s*compactPendingOperation\?\.operationId \|\| null/,
    'the exact compact reservation must not reject its own guarded PTY write as codex_turn_busy',
  );
});

test('Claude accepted compact queue rows become slash history instead of stale SENT', () => {
  const projection = sourceBetween(
    claudeHistorySource,
    'const historyBranch = _injectQueueOperationsIntoBranch(',
    'const latestSessionId = resolveLatestSessionInChain(',
  );
  const dequeue = projection.indexOf("entry.operation === 'dequeue'");
  const dequeuePromotion = projection.indexOf('promoteQueuedCompactEntry(', dequeue);
  const cancelled = projection.indexOf('Compaction canceled');
  const cancelledPromotion = projection.indexOf('promotePendingCompactEntry(', cancelled);
  const boundary = projection.lastIndexOf("entry.subtype === 'compact_boundary'");
  const boundaryPromotion = projection.indexOf('promotePendingCompactEntry(', boundary);
  assert.ok(dequeue >= 0 && dequeuePromotion > dequeue);
  assert.ok(cancelled >= 0 && cancelledPromotion > cancelled);
  assert.ok(boundary >= 0 && boundaryPromotion > boundary);
});

test('History shows Compacting with a loader and consumes the exact settled handoff', () => {
  assert.match(historySource, /ipcRenderer\.on\('agent:operational-phase'/);
  assert.match(historySource, /ipcRenderer\.invoke\('agent:get-operational-phase'/);
  assert.match(historySource, /title: 'COMPACTING'/);
  assert.match(historySource, /busy=\{showBusyLoader \|\| isCompacting\}/);
  assert.match(historySource, /data-agent-operational-phase=\{isCompacting \? 'compacting'/);
  assert.match(historySource, /removeLocalPromptEntry\([\s\S]{0,220}consumeHistoryPromptHandoff/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function functionBody(name, nextName) {
  const start = mainSource.indexOf('async function ' + name + '(');
  assert.notEqual(start, -1, 'missing function ' + name);
  const end = mainSource.indexOf('\n' + nextName, start);
  assert.notEqual(end, -1, 'missing boundary after ' + name);
  return mainSource.slice(start, end);
}

test('Claude send-command wires /compact observer after the PTY submit boundary', () => {
  const body = functionBody(
    'sendClaudeCommandUnclaimed',
    "ipcMain.handle('claude:send-command'",
  );

  const lifecycle = body.indexOf('submitWithClaudeLocalCommandLifecycle({');
  const submit = body.indexOf('submit: () => safePasteAndSubmit(', lifecycle);
  const activate = body.indexOf('activate: (preparation) => activateClaudeLocalCommandWatcher(', submit);

  assert.ok(lifecycle >= 0, 'send-command must use the post-submit lifecycle transaction');
  assert.ok(submit > lifecycle, 'PTY submit must be owned by the transaction');
  assert.ok(activate > submit, 'watcher activation must be sequenced after submit');
  assert.equal(
    body.includes("startClaudeLocalCommandWatcher(tabId, command, 'send-command')"),
    false,
    'the old pre-admission activation recreates the self-blocking race',
  );
  assert.equal(
    body.includes("stopClaudeLocalCommandWatcher(tabId, 'prompt-queue-admission-deferred')"),
    false,
    'a deferred send must discard inert preparation, not roll back published busy state',
  );
});

test('safe paste returns explicit physical-submit proof to its caller', () => {
  const start = mainSource.indexOf('async function _safePasteAndSubmitInner(');
  const end = mainSource.indexOf('\n// Send input to terminal', start);
  assert.ok(start >= 0 && end > start);
  const body = mainSource.slice(start, end);

  assert.match(
    body,
    /return \{\s*success: true,\s*submitted: submit,/,
    'success must say whether a submit key crossed the PTY boundary',
  );
});

test('manual xterm /compact stays prepared until the exact Enter is written', () => {
  const trackStart = mainSource.indexOf('function trackClaudeInputLineForLocalCommands(');
  const trackEnd = mainSource.indexOf('\n// ─── JSONL interruption watcher', trackStart);
  const trackBody = mainSource.slice(trackStart, trackEnd);
  assert.match(trackBody, /prepareClaudeLocalCommandWatcher\(tabId, command, 'terminal-input'\)/);
  assert.doesNotMatch(
    trackBody,
    /startClaudeLocalCommandWatcher\(tabId, command, 'terminal-input'\)/,
    'typing Enter must not publish busy before the byte reaches PTY',
  );

  const inputStart = mainSource.indexOf('async function handleTerminalInput(');
  const inputEnd = mainSource.indexOf("\nipcMain.on('terminal:input'", inputStart);
  const inputBody = mainSource.slice(inputStart, inputEnd);
  const prepare = inputBody.indexOf('trackClaudeInputLineForLocalCommands(');
  const write = inputBody.lastIndexOf('term.write(data)');
  const activate = inputBody.indexOf('activateClaudeLocalCommandWatcher(manualClaudeLocalCommandPreparation)', write);
  assert.ok(prepare >= 0 && write > prepare, 'manual compact proof must be captured before Enter');
  assert.ok(activate > write, 'watcher must activate only after the PTY accepted Enter');
  assert.match(
    inputBody.slice(prepare, write),
    /\{ isTerminalProtocolResponse \}/,
    'terminal protocol replies must not mutate the reconstructed user line',
  );
});

test('handshake slash commands use the same post-submit local-command transaction', () => {
  const start = mainSource.indexOf('async function sendHandshakePrompt(');
  const end = mainSource.indexOf('\n      // Wait for Claude prompt char', start);
  const body = mainSource.slice(start, end);
  assert.match(body, /submitWithClaudeLocalCommandLifecycle\(\{/);
  assert.doesNotMatch(body, /startClaudeLocalCommandWatcher\(tabId, slashCommands\[ci\], 'handshake'\)/);
  assert.match(body, /if \(slashResult\?\.submitted !== true\)/);
});

test('quick-action command observers activate only after their Enter write', () => {
  const start = mainSource.indexOf("ipcMain.on('terminal:executeCommand'");
  const end = mainSource.indexOf("\nipcMain.handle('file:list-sh-scripts'", start);
  const body = mainSource.slice(start, end);
  assert.doesNotMatch(body, /startClaudeLocalCommandWatcher\(/);

  const syncPrepare = body.indexOf("prepareClaudeLocalCommandWatcher(tabId, command, 'execute-command')");
  const syncEnter = body.indexOf("term.write('\\r')", syncPrepare);
  const syncActivate = body.indexOf('activateClaudeLocalCommandWatcher(preparation)', syncEnter);
  assert.ok(syncPrepare >= 0 && syncEnter > syncPrepare && syncActivate > syncEnter);

  const asyncPrepare = body.indexOf("prepareClaudeLocalCommandWatcher(tabId, command, 'execute-command-async')");
  const asyncEnter = body.indexOf("term.write('\\r')", asyncPrepare);
  const asyncActivate = body.indexOf('activateClaudeLocalCommandWatcher(preparation)', asyncEnter);
  assert.ok(asyncPrepare >= 0 && asyncEnter > asyncPrepare && asyncActivate > asyncEnter);
});

test('PTY compact output needs transcript intent and StopFailure closes the exact watcher', () => {
  assert.match(
    mainSource,
    /compactOutputPhase === 'compacting'[\s\S]{0,180}observeClaudeCompactFromPtyWithTranscriptProof\(tabId\)/,
    'ambiguous PTY text must be joined to an exact transcript intent before activation',
  );
  assert.doesNotMatch(
    mainSource,
    /compactOutputPhase === 'compacting'[\s\S]{0,180}startClaudeLocalCommandWatcher\(tabId, '\/compact', 'pty-output'\)/,
    'automatic compaction output must not create a manual local-command owner',
  );
  assert.match(
    mainSource,
    /event === 'StopFailure' && claudeLocalCommandWatchers\.has\(tabId\)[\s\S]{0,120}completeClaudeLocalCommand\(tabId, 'stop-failure'\)/,
    'a failed local command must release its loader immediately',
  );
  assert.doesNotMatch(
    mainSource,
    /compactOutputPhase === 'compacted'[\s\S]{0,700}completeClaudeLocalCommand\(tabId, 'pty-output-compacted'\)/,
    'ambiguous PTY completion text must not directly advance the queue',
  );
  assert.match(
    mainSource,
    /compactOutputPhase === 'compacted'[\s\S]{0,900}requestTranscriptScan\?\.\(\)/,
    'PTY completion may only ask the exact watcher to rescan durable proof',
  );
});

test('PTY compact intent proof retries on transcript changes instead of one-shot rejection', () => {
  const start = mainSource.indexOf('function observeClaudeCompactFromPtyWithTranscriptProof(');
  const end = mainSource.indexOf('\nfunction noteClaudePtyCompactOutputCompletion(', start);
  assert.ok(start >= 0 && end > start);
  const body = mainSource.slice(start, end);

  assert.match(body, /fs\.watch\(/, 'proof must follow durable transcript changes');
  assert.match(body, /requestClaudePtyCompactTranscriptProof\(/);
  assert.doesNotMatch(
    body,
    /latest-prompt-is-not-compact[\s\S]{0,160}discardClaudeLocalCommandWatcherPreparation/,
    'a pre-flush ordinary prompt must not permanently reject a later exact command carrier',
  );
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const runtimeContract = fs.readFileSync(path.join(__dirname, 'codex-runtime-contract.js'), 'utf8');
const sendContract = fs.readFileSync(
  path.join(root, 'renderer', 'utils', 'agentSendProviderContract.ts'),
  'utf8',
);

function block(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, 'missing block start: ' + start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, 'missing block end: ' + end);
  return source.slice(from, to);
}

test('Codex busy lifecycle keeps the operational input surface available', () => {
  const projection = block(
    runtimeContract,
    'function projectCodexPublicRuntimeProjection',
    'function codexSessionIdFromAuthoritativeStatus',
  );
  assert.match(projection, /tuiInputReady === true \|\| turnBusy === true/);
  assert.doesNotMatch(projection, /turnBusy !== true/);
});

test('task_started wakes startup and AutoResume readiness waiters', () => {
  const emitBusy = block(main, 'function emitCodexBusy', 'function emitCodexContextPct');
  assert.match(emitBusy, /runtimeProjection\.inputReady === true/);
  assert.match(emitBusy, /emitAgentReadinessChanged\(tabId/);

  const readReady = block(
    main,
    'async function readMainAgentStartReadiness',
    'async function waitForMainAgentStartReady',
  );
  assert.match(readReady, /projectCodexRuntimeSnapshotFromEvents\(tabId\)/);
  assert.match(readReady, /runtime\?\.sessionStatus \|\| 'starting'/);
});

test('task_complete and turn_aborted restore readiness in live and catch-up paths', () => {
  const suppressedRelease = block(
    main,
    'function publishCodexSuppressedCatchUpRelease',
    'function releaseCodexSourceObservationAfterWriterProof',
  );
  assert.match(suppressedRelease, /isCodexInputReadyTurnEndEvent\(event\)/);
  assert.match(suppressedRelease, /markCodexTuiReadyFromTurnEnd\(tabId/);

  const liveTurnEnd = block(
    main,
    'if (turnOutcome?.busy === false) {',
    '\nfunction inferCodexBusyFromText',
  );
  assert.match(liveTurnEnd, /isCodexInputReadyTurnEndEvent\(event\)/);
  assert.match(liveTurnEnd, /markCodexTuiReadyFromTurnEnd\(state\.tabId, event\)/);

  const ordinaryCatchUp = block(
    main,
    'async function catchUpCodexTurnState',
    '\nfunction processCodexTurnText',
  );
  assert.match(
    ordinaryCatchUp,
    /!inferred\.busy\s*&&\s*isCodexInputReadyTurnEndEvent\(inferred\.event\)/,
  );
  assert.match(ordinaryCatchUp, /markCodexTuiReadyFromTurnEnd\(tabId/);
});

test('post-turn readiness keeps Stop and model migration guards and never writes input', () => {
  const turnEndReady = block(
    main,
    'function markCodexTuiReadyFromTurnEnd',
    'function maybeArmCodexMcpStartupWatchdog',
  );
  assert.match(turnEndReady, /aiStoppingTabs\.has\(tabId\)/);
  assert.match(turnEndReady, /codexPendingModelMigrations\.has\(tabId\)/);
  assert.doesNotMatch(turnEndReady, /\.write\(|safePasteAndSubmit|terminal:input/);

  const transport = block(
    main,
    'async function _safePasteAndSubmitInner',
    '\nasync function handleTerminalInput',
  );
  const draftRefusal = transport.indexOf('codex_existing_draft_before_paste');
  const payloadWrite = transport.indexOf('term.write(payload)');
  assert.ok(draftRefusal >= 0 && payloadWrite > draftRefusal,
    'restored composer text must still refuse before the first prompt payload write');
});

test('busy send still chooses queue before direct submission', () => {
  const providers = [
    block(sendContract, 'const CLAUDE_SEND_CONTRACT', 'const CODEX_SEND_CONTRACT'),
    block(sendContract, 'const CODEX_SEND_CONTRACT', 'export function getAgentSendProviderContract'),
  ];
  for (const provider of providers) {
    const busyAt = provider.indexOf("if (presence.status === 'busy') return 'queue'");
    const directAt = provider.indexOf("presence.inputReady === true) return 'direct'");
    assert.ok(busyAt >= 0 && directAt > busyAt,
      'busy must remain queue-owned even when inputReady is true');
  }
});

test('Claude session broadcasts no longer revoke input solely because it is busy', () => {
  assert.doesNotMatch(main, /inputReady:\s*promptReady\s*&&\s*!busy/);

  const readReady = block(
    main,
    'async function readMainAgentStartReadiness',
    'async function waitForMainAgentStartReady',
  );
  assert.match(readReady, /getClaudePtyRuntimePresence\(tabId\)/);

  const hookLifecycle = block(
    main,
    "console.log('[MobBcast] busy tab='",
    'if (!busy) {',
  );
  assert.match(hookLifecycle, /getClaudePtyRuntimePresence\(tabId\)\.inputReady === true/);
  assert.match(hookLifecycle, /emitAgentReadinessChanged\(tabId/);
});

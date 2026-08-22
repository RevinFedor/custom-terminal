'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function block(start, end) {
  const at = source.indexOf(start);
  assert.ok(at >= 0, 'missing start: ' + start);
  const to = source.indexOf(end, at + start.length);
  assert.ok(to > at, 'missing end: ' + end);
  return source.slice(at, to);
}

test('process proof confirms liveness but never invents identity from a saved row', () => {
  const helper = block(
    'async function augmentShutdownStateFromProcessProof',
    '\n\nfunction markInterruptedAiSessionEntries',
  );
  assert.match(helper, /for \(const tabId of terminals\.keys\(\)\)/);
  assert.match(helper, /inspectAiDescendantProcessesByTab\(tabId, null\)/);
  assert.match(helper, /providers\.size > 1/);
  assert.match(helper, /resolveAcceptedClaudeResumeShutdownTarget\(\{/);
  assert.match(helper, /intentSessionId: intentBefore\?\.sessionId/);
  assert.match(helper, /persistedSessionId: persistedAfter\?\.claude_session_id/);
  assert.doesNotMatch(helper, /terminalCommandState[\s\S]{0,80}isRunning/,
    'stale isRunning must not become shutdown proof');
});

test('exact collector requires Claude bridge / Codex writer / active turn / stopping identity', () => {
  const collector = block(
    'function exactShutdownCandidatesForTab',
    '\n\nfunction getInterruptedAiSessionEntries',
  );
  assert.match(collector, /bridgeKnownSessions\.get\(tabId\)/);
  assert.match(collector, /getCodexWriterProofSnapshot\(tabId\)/);
  assert.match(collector, /getActiveAgentExecutionContext\(tabId\)/);
  assert.match(collector, /aiStoppingTabs\.get\(tabId\)/);
  assert.doesNotMatch(collector, /codexKnownSessions\.get\(tabId\)/);
});

test('before-quit freezes augmented owners and will-quit never recomputes them away', () => {
  const before = block("app.on('before-quit'", "app.on('will-quit'");
  const will = block("app.on('will-quit'", "app.on('window-all-closed'");
  assert.match(before, /augmentShutdownStateFromProcessProof\(activeAiSessions, liveAiTabIds\)/);
  assert.match(before, /_gracefulShutdownAiSessions = new Map\(activeAiSessions\)/);
  assert.match(before, /reconcileInterruptedAiSessionEntries\([\s\S]{0,180}'before-quit-process-proof'/);
  assert.match(will, /_gracefulShutdownAiSessions \|\| getInterruptedAiSessionEntries\(\)/);
  assert.match(will, /markInterruptedAiSessionEntries\(activeAiSessions, 'will-quit'\)/);
});

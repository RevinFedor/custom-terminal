/**
 * A failing decoration must never stop a turn from finishing.
 *
 * Prod scar 2026-07-29 (tab-1005). Chain of events, confirmed from the log by
 * two independent sessions:
 *
 *   03:33:22 MSK  turn starts, busy=true, the tab timer starts
 *   03:33:17..    every rollout line throws inside the subagent bookkeeping
 *                 ("isAgentFinishedByOwnTranscript is not defined" — a helper
 *                 that was exported and called but never imported)
 *   03:35:14      Codex writes the turn's terminal event
 *                 → never read: the throw had already aborted the scan
 *   …            no busy=false ever follows. Nine minutes of a live loader,
 *                 an empty subagent strip, and a frozen tab timer. Reopening
 *                 the tab did not help: the UI asked the main process for the
 *                 state and got back the same stale "still running".
 *
 * The previous turn (03:33:02, aborted) closed correctly in the same
 * millisecond — proof that the lifecycle itself was healthy and only the
 * decoration on top of it was poisoning the stream.
 *
 * Two independent guarantees are tested here, because either one alone would
 * have prevented nine minutes of a stuck UI:
 *   1. subagent bookkeeping is isolated — its failure cannot reach the scanner;
 *   2. the terminal event of the turn is still processed when it does fail.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

/** Body of a top-level `function <name>(` declaration in main.js. */
const functionBody = (name) => {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start > 0, 'function ' + name + ' must exist in main.js');
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') { depth += 1; seenBrace = true; }
    else if (ch === '}') {
      depth -= 1;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced body for ' + name);
};

test('subagent bookkeeping is isolated from turn line processing', () => {
  const body = functionBody('processCodexTurnLine');
  const call = body.indexOf('trackCodexTabSubagentActivity(state, record);');
  assert.ok(call > 0, 'the per-line subagent tracking call must be here');

  const before = body.slice(0, call);
  const openTry = before.lastIndexOf('try {');
  assert.ok(openTry > 0, 'the tracking call must sit inside a try block');
  // Nothing may close that try between its opening and the call itself.
  assert.equal(
    before.slice(openTry).includes('} catch'),
    false,
    'the try block wrapping the tracking call must still be open at the call',
  );
  assert.ok(
    body.slice(call).includes('} catch'),
    'the tracking call must be followed by a catch',
  );
});

test('the turn keeps being decoded after the decoration fails', () => {
  // The event that ends the turn is read further down the same function. If
  // the guard were placed after it — or the call left bare — a throw would
  // skip the terminal event and the turn would stay busy forever.
  const body = functionBody('processCodexTurnLine');
  const trackCall = body.indexOf('trackCodexTabSubagentActivity(state, record);');
  const eventDecode = body.indexOf('codexEventType(record)');
  assert.ok(eventDecode > trackCall,
    'turn event decoding happens after the decoration — so the decoration must not be able to throw past it');
});

test('turn-completion state is not reached through the subagent sweep', () => {
  // The sweep answers "did this agent finish by its own transcript" and is
  // ONLY about the subagent strip. If a name used there is unbound, the whole
  // turn dies with it — hence both the isolation above and this wiring check.
  const sweepOwner = functionBody('trackCodexTabSubagentActivity');
  assert.ok(
    sweepOwner.includes('isAgentFinishedByOwnTranscript'),
    'the sweep is the only consumer of the own-transcript proof',
  );
  const importPattern = /const\s*\{([^}]*)\}\s*=\s*require\([^)]*subagent-transcript[^)]*\)/;
  const imported = source.match(importPattern)?.[1] || '';
  assert.ok(
    imported.includes('isAgentFinishedByOwnTranscript'),
    'the proof helper must be imported, not merely exported and called',
  );
});

test('the tab timer is closed by the same signal that clears busy', () => {
  // The user-visible symptom was a frozen timer, not "subagents missing".
  // The timer has no separate lifecycle: it follows recordActivity, which is
  // driven by the busy transition. Documented here so a future change that
  // gives the timer its own source is a conscious decision, not a silent one.
  const marker = source.indexOf("'[CodexTurn] busy tab='");
  assert.ok(marker > 0, 'the busy transition must be logged');
  const after = source.slice(marker, marker + 900);
  assert.ok(
    after.includes('recordActivity(tabId, busy,'),
    'the activity/timer record must be driven by the same busy transition',
  );
});

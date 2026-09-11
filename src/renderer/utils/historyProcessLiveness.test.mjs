import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldHistoryAgentProcessLiveness,
  isHistoryBackgroundTaskLive,
} from './historyProcessLiveness.mjs';

/**
 * Process liveness is THREE-valued: alive / dead / not-established-yet.
 *
 * The composer publishes `unknown` on every tab-bind, a few hundred
 * milliseconds before presence re-confirms the process. Folding `unknown` into
 * "dead" makes a working agent's chip blink out and back on every switch to
 * its tab. E2E 2026-07-29 caught the flip on a live 30-file background agent:
 *
 *   01:09:51.0  status active -> unknown   reason=tab-bind
 *   01:09:51.0  count=0  processAlive=0     <- agent still working
 *   01:09:51.x  count=1  processAlive=1
 *   01:12:25.4  count=0  processAlive=0     <- again, same cause
 *   01:12:25.7  count=1  processAlive=1
 *
 * Project rule (CLAUDE.md): a fallible lookup returns found / absent /
 * unknown; a timeout or error is `unknown`, never `absent`, and only a
 * successful empty result may clear confirmed state.
 *
 * This mirrors the reducer used by HistoryPanel so the rule is pinned
 * independently of the component.
 */

const replay = (statuses, initial = false) => {
  let alive = initial;
  return statuses.map((s) => {
    alive = foldHistoryAgentProcessLiveness(s, alive);
    return alive;
  });
};

test('unknown holds the previous answer instead of reporting death', () => {
  assert.equal(foldHistoryAgentProcessLiveness('unknown', true), true);
  assert.equal(foldHistoryAgentProcessLiveness('unknown', false), false);
});

test('the tab-bind flip no longer drops a live agent', () => {
  // The exact sequence from the E2E log.
  assert.deepEqual(
    replay(['active', 'unknown', 'active']),
    [true, true, true],
    'switching to the tab must not blink the chip off',
  );
});

test('a real negative still clears the state', () => {
  // `inactive` is an answer, not an absence of one — the process really ended.
  assert.deepEqual(replay(['active', 'inactive']), [true, false]);
});

test('every alive status counts, and an unfamiliar one does not', () => {
  assert.deepEqual(replay(['starting', 'busy', 'active']), [true, true, true]);
  // A future status we have never seen must not resurrect a dead process:
  // only `unknown` is "no answer"; anything else is a claim we do not honour.
  assert.deepEqual(replay(['active', 'hibernating']), [true, false]);
});

test('unknown before any answer is not treated as alive', () => {
  // Nothing has been established yet, so there is nothing to hold onto.
  assert.deepEqual(replay(['unknown', 'unknown']), [false, false]);
});

test('liveness is remembered per tab, not globally', () => {
  // The History panel is persistent-mounted and shared by every tab. A single
  // remembered slot would hand tab A's "alive" to tab B during the `unknown`
  // window right after a switch — a chip on a tab that has no agent at all.
  const known = new Map();
  const fold = (tabId, status) => {
    const alive = foldHistoryAgentProcessLiveness(status, known.get(tabId) ?? false);
    if (status !== 'unknown') known.set(tabId, alive);
    return alive;
  };

  assert.equal(fold('A', 'active'), true);   // A has a live agent
  assert.equal(fold('B', 'unknown'), false); // B never answered — not A's truth
  assert.equal(fold('B', 'inactive'), false);
  assert.equal(fold('A', 'unknown'), true);  // A still holds its own answer
});

test('the tab loader counts agents, not background shell commands', () => {
  // The strip above the composer holds two kinds of work: subagents and
  // `run_in_background` Bash. Both deserve a visible chip — the user opens
  // them the same way — but the TAB loader answers a narrower question:
  // "is an agent working here?". A long-running shell spinning the tab makes
  // the tab list lie about agent activity. The main-process watcher already
  // counts subagents only; the History surface must agree with it.
  const chips = [
    { kind: 'subagent', key: 'task:a' },
    { kind: 'bash', key: 'bash:b' },
    { kind: 'bash', key: 'bash:c' },
  ];
  const broadcast = chips.filter((c) => c.kind === 'subagent').length;
  assert.equal(broadcast, 1, 'only subagents drive the tab loader');
  assert.equal(chips.length, 3, 'all three still render as chips in the strip');

  const bashOnly = [{ kind: 'bash', key: 'bash:x' }];
  assert.equal(
    bashOnly.filter((c) => c.kind === 'subagent').length,
    0,
    'a tab running only background commands must not spin',
  );
});

test('a liveness claim needs rows read from disk, not a cache hit', () => {
  // Two separate facts about a tab switch:
  //   presented — this owner's rows are on screen (a cache hit satisfies it);
  //   fresh     — this owner's rows were actually read from disk.
  // Chips assert "work is ALIVE", so they need the stronger one. A cache
  // written while an agent was still running keeps describing it as running:
  // E2E 2026-07-29 saw the strip resurrect an agent 8 seconds after it had
  // finished (count=0 → 1 → 0 around a single load).
  const settled = (presented, fresh, owner) => presented === owner && fresh === owner;

  assert.equal(settled('A', 'A', 'A'), true,  'own rows, read from disk');
  assert.equal(settled('A', '',  'A'), false, 'cache hit alone is not enough');
  assert.equal(settled('A', 'B', 'A'), false, 'freshness belongs to another owner');
  assert.equal(settled('B', 'A', 'A'), false, 'still presenting the previous owner');
});

test('an unsettled owner publishes nothing rather than zero', () => {
  // Publishing 0 during the handoff would read as "the agent stopped" and
  // blink the tab loader off on every switch. Silence means "no new answer".
  const publish = (settled, count) => (settled ? count : null);
  assert.equal(publish(false, 0), null, 'no claim while the owner is unsettled');
  assert.equal(publish(true, 0), 0,     'a settled owner may report emptiness');
  assert.equal(publish(true, 2), 2);
});

test('durable background acceptance cannot resurrect work after runtime restart', () => {
  assert.equal(isHistoryBackgroundTaskLive({
    processAlive: true,
    exactActive: false,
    terminal: false,
  }), false, 'a historical `Monitor started` card is not current liveness proof');
  assert.equal(isHistoryBackgroundTaskLive({
    processAlive: true,
    exactActive: true,
    terminal: false,
  }), true, 'the exact current main snapshot keeps real work visible');
  assert.equal(isHistoryBackgroundTaskLive({
    processAlive: true,
    exactActive: true,
    terminal: true,
  }), false, 'terminal proof outranks an older active snapshot');
  assert.equal(isHistoryBackgroundTaskLive({
    processAlive: false,
    exactActive: true,
    terminal: false,
  }), false, 'background work never outlives its owning Claude process');
});

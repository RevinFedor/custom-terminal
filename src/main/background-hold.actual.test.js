'use strict';

// Explicit hold for one background shell command.
//
// Subagents (Claude Agent/Task, Codex subagents) always keep their tab busy.
// Background shells do NOT by default: a long `npm run dev` would otherwise
// hold its tab — and the install — forever. 01Nov decision: the user asks in
// words ("hold the tab while this script runs"), the agent calls
// hold_background_work with the task id it just got, and that one command
// keeps the tab busy until it ends. No release call: the task leaves the
// running set on its own terminal notification, TaskStop or process boundary.
//
// These cases run the REAL tracker and the REAL shared count from main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClaudeBackgroundAgentActivityTracker } = require('./claude-background-agent-activity');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

const assistant = (name, input, id) => ({
  type: 'assistant', timestamp: '2026-11-01T07:29:00.000Z',
  message: { content: [{ type: 'tool_use', name, input, id }] },
});
const toolResult = (id, text, extra = {}) => ({
  type: 'user', timestamp: '2026-11-01T07:29:01.000Z',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  ...extra,
});
const backgroundBash = (id, taskId, description) => [
  assistant('Bash', { command: 'sleep 600', description, run_in_background: true }, id),
  toolResult(id, 'Command did not complete and was moved to the background (ID: ' + taskId + ').'),
];

function tracker(records = []) {
  const instance = createClaudeBackgroundAgentActivityTracker();
  instance.bind({ tabId: 'T', sessionId: 'S', generation: 'g1' });
  for (const record of records) instance.observe({ tabId: 'T', sessionId: 'S', record });
  return instance;
}

// The REAL shared signal every consumer reads (loader, Auto-stop, Run After,
// mini-orchestrator, continuation gate), executed out of main.js.
function busyCount(instance, codexSubagents = 0) {
  const start = main.indexOf('function getCombinedTabBackgroundWorkCount(tabId) {');
  assert.ok(start > 0, 'getCombinedTabBackgroundWorkCount must exist');
  const end = main.indexOf('\n}', start) + 2;
  const context = vm.createContext({
    claudeBackgroundAgentActivity: instance,
    codexTabLiveSubagents: new Map([['T', { size: codexSubagents }]]),
  });
  vm.runInContext(main.slice(start, end), context);
  return context.getCombinedTabBackgroundWorkCount('T');
}

test('a background shell does not hold the tab until it is explicitly held', () => {
  const instance = tracker([...backgroundBash('toolu_a', 'bash-7', 'npm run dev')]);
  assert.equal(instance.snapshot('T').taskCount, 1, 'the command is tracked');
  assert.equal(busyCount(instance), 0, 'but it does not make the tab busy by itself');

  assert.equal(instance.hold('T', 'bash-7').held, true);
  assert.equal(busyCount(instance), 1, 'held → the tab is busy');
});

test('the hold accepts the task id or the tool_use id, and repeats are idempotent', () => {
  const byTaskId = tracker([...backgroundBash('toolu_a', 'bash-7', 'worker')]);
  assert.equal(byTaskId.hold('T', 'bash-7').held, true);
  const again = byTaskId.hold('T', 'bash-7');
  assert.equal(again.held, true);
  assert.equal(again.repeated, true);
  assert.equal(busyCount(byTaskId), 1, 'a repeat never double counts');

  const byToolUse = tracker([...backgroundBash('toolu_b', 'bash-9', 'worker')]);
  assert.equal(byToolUse.hold('T', 'toolu_b').held, true);
  assert.equal(busyCount(byToolUse), 1);
});

test('the hold releases itself when that exact command finishes', () => {
  const instance = tracker([
    ...backgroundBash('toolu_a', 'bash-1', 'Wait for the worker turn'),
    ...backgroundBash('toolu_b', 'bash-2', 'Wait for the worker to finish'),
  ]);
  instance.hold('T', 'bash-1');
  instance.hold('T', 'bash-2');
  assert.equal(busyCount(instance), 2);

  instance.observe({ tabId: 'T', sessionId: 'S', record: { type: 'attachment', sessionId: 'S' },
    notifications: [{ toolUseId: 'toolu_a', taskId: 'bash-1', status: 'completed' }] });
  assert.equal(busyCount(instance), 1, 'only the finished command is released');

  instance.observe({ tabId: 'T', sessionId: 'S', record: { type: 'attachment', sessionId: 'S' },
    notifications: [{ toolUseId: 'toolu_b', taskId: 'bash-2', status: 'failed' }] });
  assert.equal(busyCount(instance), 0, 'a failed command also ends its hold');
});

test('only a running background command of this tab can be held', () => {
  const empty = tracker();
  assert.deepEqual(empty.hold('T', 'bash-1'), { held: false, reason: 'background-task-not-running' });
  assert.equal(empty.hold('', 'bash-1').reason, 'identity-required');
  assert.equal(empty.hold('T', '').reason, 'identity-required');
  assert.equal(empty.hold('OTHER', 'bash-1').reason, 'tab-not-bound');

  const foreground = tracker([assistant('Bash', { command: 'ls' }, 'toolu_fg'), toolResult('toolu_fg', 'done')]);
  assert.equal(foreground.hold('T', 'toolu_fg').held, false, 'an ordinary command is not background work');

  const agent = tracker([
    assistant('Agent', { prompt: 'review' }, 'toolu_agent'),
    toolResult('toolu_agent', 'started', { toolUseResult: { agentId: 'agent-1', isAsync: true } }),
  ]);
  assert.equal(agent.hold('T', 'toolu_agent').held, false, 'agents are not held through this path');

  const finished = tracker([...backgroundBash('toolu_a', 'bash-1', 'x')]);
  finished.observe({ tabId: 'T', sessionId: 'S', record: { type: 'attachment', sessionId: 'S' },
    notifications: [{ toolUseId: 'toolu_a', taskId: 'bash-1', status: 'completed' }] });
  assert.equal(finished.hold('T', 'bash-1').held, false, 'a finished command cannot be held');
});

test('subagents keep holding their tab with no hold call at all', () => {
  const instance = tracker([
    assistant('Agent', { prompt: 'review' }, 'toolu_agent'),
    toolResult('toolu_agent', 'started', { toolUseResult: { agentId: 'agent-1', isAsync: true } }),
  ]);
  assert.equal(busyCount(instance), 1, 'Claude agent holds its tab');
  assert.equal(busyCount(instance, 2), 3, 'Codex subagents add to the same signal');

  // An unheld shell alongside a subagent adds nothing.
  for (const record of backgroundBash('toolu_sh', 'bash-5', 'dev server')) {
    instance.observe({ tabId: 'T', sessionId: 'S', record });
  }
  assert.equal(busyCount(instance), 1);
});

test('a new process generation drops holds taken for the previous one', () => {
  const instance = tracker([...backgroundBash('toolu_a', 'bash-1', 'worker')]);
  instance.hold('T', 'bash-1');
  assert.equal(busyCount(instance), 1);
  instance.bind({ tabId: 'T', sessionId: 'S2', generation: 'g2' });
  assert.equal(busyCount(instance), 0, 'a hold never outlives its process');
});

test('the shared count reads held shells, not every shell', () => {
  assert.match(main, /return claude\.count \+ claude\.heldTaskCount \+ codexCount;/);
  assert.match(main, /holdTabBackgroundWork: \(tabId, taskRef\) =>/, 'main exposes the hold to the web server');
  const server = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  assert.match(server, /\/api\\\/terminal-tabs\\\/\(\[\^\/\]\+\)\\\/background-hold\$/,
    'the HTTP route exists for the MCP tool');
});

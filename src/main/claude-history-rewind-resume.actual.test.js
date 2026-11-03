'use strict';
// Manual History Rewind on a Claude tab stopped Claude, rewrote the JSONL, and
// then FAILED to start Claude again — the toast said "Claude start failed
// history_input_launch_changed" and the tab was left with no process.
// Production 01.11.2026, tab f16371ad31df, operation history-operation-1793529519143-1:
//   10:38:39.145  [HistoryInput] reserved
//   10:38:41.494  [DeleteRange] Done. removed=239          ← history already rewritten
//   10:38:42.632  [AgentShellLaunch] clear-and-write bytes=85
//   10:38:42.638  [ERROR] claude:run-command: history_input_launch_changed
//   10:38:42.820  [HistoryInput] released reason=current-process-absent
//
// A held history-input reservation claims the launch generation at the write
// boundary and compares it with the tab's current one. The ordinary claude-c
// branch opens its generation only AFTER the bytes (markClaudeShellLaunchStarted
// follows writeAgentLaunchCommandToIdleShell), so the claim still saw the
// stopped process' generation and refused. The saved-history writer reserves
// that generation BEFORE the write, which is why the same Rewind through the
// API receipt path always worked.
//
// These tests drive the REAL main.js branch, the REAL guarded writer and the
// REAL admission gate, not copies of them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');
const { createHistoryMutationInputGate } = require('./history-mutation-input');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const decl = (name) => ast.statements
  .find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
const quiet = { log() {}, warn() {}, error() {} };

// One fixture = a Claude tab whose process the Rewind scenario just stopped,
// holding the reservation that scenario took before Stop.
function fixture({ reserve = true } = {}) {
  const term = { bytes: [], write(input) { this.bytes.push(input); } };
  const generations = new Map([['T', { generation: 'claude-launch-previous' }]]);
  const state = {
    terminalToken: term, projectId: 'P', cwd: '/fixture', sessionId: 'S', toolType: 'claude',
    runSeq: 7, lifecycleGeneration: 'G', inputRevision: 4,
  };
  const gate = createHistoryMutationInputGate({
    // The real gate reads the tab's CURRENT launch generation here.
    capture: () => ({ ...state, inputOwnerLaunchId: generations.get('T')?.generation || null }),
    log: quiet,
  });
  let historyInput = null;
  if (reserve) {
    historyInput = gate.reserve({ tabId: 'T', operationId: 'OP', sessionId: 'S', toolType: 'claude' });
  }

  let seq = 0;
  const context = vm.createContext({
    console: quiet, path, srcMainDir: __dirname,
    terminals: new Map([['T', term]]),
    terminalProjects: new Map([['T', '/fixture']]),
    terminalCommandState: new Map([['T', { runSeq: state.runSeq, isRunning: false }]]),
    claudeLaunchGenerationByTab: generations,
    claudePreclaimedCommandGenerations: new Map(),
    claudeState: new Map(), claudePendingPrompt: new Map(),
    terminalInputLineBuffers: new Map(), terminalInputEscapeStates: new Map(),
    getTerminalLifecycleGeneration: () => state.lifecycleGeneration,
    getTerminalInputRevision: () => state.inputRevision,
    buildAgentShellLaunchInput: (command) => command + '\r',
    withPtyWriteLock: async (_term, work) => work(),
    assertKnownEmptySend: () => null,
    assertAgentSendLaunchCurrent() {},
    agentShellLaunchError: () => 'claude_already_running',
    getClaudeJsonlLiveOwner: () => null,
    getClaudeJsonlExternalOwner: async () => null,
    markClaudePendingJsonlOwner: () => true,
    terminalShellReadiness: { markAgentLaunchWrite: () => true },
    agentLaunchPreparations: { markIntentWrite: () => true },
    historyMutationInput: gate,
    AI_PROCESS_LOOKUP_STATUS: { UNKNOWN: 'unknown' },
    proveIdleShellForAgentLaunch: async () => ({ allowed: true, shellWriteProof: {
      terminalToken: term, runSeq: state.runSeq,
      lifecycleGeneration: state.lifecycleGeneration, inputRevision: state.inputRevision } }),
    beginClaudeLaunchGeneration: () => {
      const generation = 'claude-launch-' + (++seq);
      generations.set('T', { generation });
      return generation;
    },
    clearClaudeLaunchGeneration: () => { generations.delete('T'); },
    rollbackClaudeShellLaunchClaims() {},
    markClaudeShellLaunchStarted: (_tab, _sid, _reason, options = {}) => {
      if (options.preclaimedLaunchId) return options.preclaimedLaunchId;
      const generation = 'claude-launch-' + (++seq);
      generations.set('T', { generation });
      return generation;
    },
  });
  context.require = () => ({ validateSavedHistoryResume: () => ({ allowed: true }) });
  vm.runInContext([
    'validateClaudeSavedHistoryLaunch', 'writeAgentLaunchCommandToIdleShell',
    'writeClaudeSavedHistoryResume', 'runClaudeCommandFromPayload',
  ].map(decl).join('\n'), context);

  const resume = (payload = {}) => context.runClaudeCommandFromPayload({},
    { tabId: 'T', command: 'claude-c', sessionId: 'S', ...payload },
    { resumeJsonlPrepared: true });
  return { term, state, gate, generations, historyInput, resume };
}

test('a Rewind-held resume starts Claude instead of failing with launch_changed', async () => {
  const f = fixture();
  f.gate.authorizeResume(f.historyInput, { command: 'claude-c', sessionId: 'S' });
  // Pre-fix this returned history_input_launch_changed with zero bytes: the
  // user was left with a rewritten history and no running Claude.
  const result = await f.resume({ historyInput: f.historyInput });
  assert.equal(result.accepted, true);
  assert.equal(result.launchWritten, true);
  assert.deepEqual(f.term.bytes, ['claude --dangerously-skip-permissions --resume S\r']);
  assert.equal(f.generations.get('T').generation, result.launchId,
    'the claimed generation is the one this launch reserved');
});

test('an ordinary resume with no reservation keeps its existing path and bytes', async () => {
  const f = fixture({ reserve: false });
  const result = await f.resume();
  assert.equal(result.accepted, true);
  assert.deepEqual(f.term.bytes, ['claude --dangerously-skip-permissions --resume S\r']);
});

test('the shell write still refuses when the user typed between Stop and launch', async () => {
  const f = fixture();
  f.gate.authorizeResume(f.historyInput, { command: 'claude-c', sessionId: 'S' });
  // A manual key between the reservation and the launch bumps the input
  // revision. This guard is why the launch must not simply be let through.
  f.state.inputRevision += 1;
  await assert.rejects(() => f.resume({ historyInput: f.historyInput }), /history_input_owner_changed/);
  assert.deepEqual(f.term.bytes, [], 'a refusal must never leave a half-written launch');
});

test('this own launch may advance the run counter, unlike a foreign one', async () => {
  // The guarded writer reserves runSeq+1 for its own command; an authorized
  // Resume is allowed to move it. A DIFFERENT terminal/session is not.
  const f = fixture();
  f.gate.authorizeResume(f.historyInput, { command: 'claude-c', sessionId: 'S' });
  const accepted = await f.resume({ historyInput: f.historyInput });
  assert.equal(accepted.accepted, true);

  const other = fixture();
  other.gate.authorizeResume(other.historyInput, { command: 'claude-c', sessionId: 'S' });
  other.state.sessionId = 'OTHER-SESSION';
  await assert.rejects(() => other.resume({ historyInput: other.historyInput }), /history_input_owner_changed/);
  assert.deepEqual(other.term.bytes, []);
});

test('a reservation that never authorized this Resume is still refused', async () => {
  const f = fixture();
  // No authorizeResume: the scenario has not claimed its restart yet.
  await assert.rejects(() => f.resume({ historyInput: f.historyInput }),
    /history_input_launch_changed|history_input_resume/);
  assert.deepEqual(f.term.bytes, []);
});

test('wired: the claude-c branch routes a held reservation through the pre-claiming writer', () => {
  const branch = mainSource.slice(
    mainSource.indexOf("case 'claude-c':"), mainSource.indexOf("case 'claude-f':"));
  const route = branch.indexOf('if (payload.historyOperation || payload.historyInput) {');
  const write = branch.indexOf('writeAgentLaunchCommandToIdleShell(term, {');
  assert.ok(route > 0, 'a held history-input reservation uses the guarded writer');
  assert.ok(route < write, 'it is chosen before the ordinary write-then-claim path');
  // The ordinary path below still opens its generation after the bytes; that is
  // exactly why a reservation cannot use it.
  assert.ok(branch.indexOf("markClaudeShellLaunchStarted(tabId, sessionId, 'claude-run-command-resume')") > write);
});

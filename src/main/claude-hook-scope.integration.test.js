'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { admitClaudeMainHook, resolveClaudeHookTab } = require('./claude-hook-routing');
const { TaskCompletionIntentRegistry, loopTaskCompletionEligibility } = require('./task-completion-intent');
const { selectUniqueClaudePromptSubmitAudit } = require('./claude-prompt-audit');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { claudeProviderFailureFromHook } = require('../shared/claude-provider-failure.cjs');
const { createAgentResponseObservationReader } = require('./agent-response-observation-reader');

// Execute the real socket handler, not a second lifecycle reducer. Only external
// boundaries are fixtures; no installed socket, PTY, transcript or provider is used.
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const parsed = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const serverSource = parsed.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'startClaudeHookServer').getText(parsed);
function fixture({ fresh = false } = {}) {
  const ipc = [], web = [], activity = [], preview = [], logs = [], semantic = [], accessOutcomes = [];
  const holds = new Map();
  let responseReader;
  const context = vm.createContext({
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')), error() {} },
    Date, Map, Set, Number, String, JSON, clearTimeout, process: { pid: 999 },
    fs: { unlinkSync() {}, chmodSync() {}, statSync: () => ({ size: 100 }) },
    net: { createServer(callback) {
      const server = new EventEmitter();
      server.on('connection', callback);
      server.listen = (_path, ready) => ready();
      return server;
    } },
    CLAUDE_HOOK_SOCK: '/fixture/never-opened.sock', claudeHookServer: null,
    claudeHookConnSeq: 0, claudeHookEventSeq: 0, currentLegacyServer: null,
    claudeHookLegacyServer: null, bindLegacyHookServer() {}, writeClaudeHookDiscovery() {},
    terminals: new Map([['T', {}]]), bridgeKnownSessions: new Map(fresh ? [] : [['T', 'S']]),
    bridgePidCache: new Map([[28777, 'T']]),
    claudeLaunchGenerationByTab: new Map([['T', { generation: 'launch-1', pid: 28777 }]]),
    admitClaudeMainHook, resolveClaudeHookTab,
    taskCompletionIntents: new TaskCompletionIntentRegistry(), loopTaskCompletionEligibility,
    getAgentResponseObservationReader: () => responseReader,
    taskCompletionOutcomeMeta: require('./task-completion-intent').taskCompletionOutcomeMeta,
    claudeHookLastEvent: new Map(), claudeTurnBusy: new Map(), claudeSpinnerBusy: new Map(),
    claudeSpinnerLastSeenAt: new Map(), claudeSpinnerIdleTimer: new Map(),
    claudeTurnWatchdog: new Map(), claudeAwaitingInput: new Map(), claudePendingQuestion: new Map(),
    claudeLocalCommandWatchers: new Map(),
    conversationOwners: { noteInput() {} }, clearClaudeEditableLastPrompt() {},
    claudeToolScreenHolds: {
      clear: () => holds.clear(), snapshot: () => [...holds.values()],
      start: input => { holds.set(input.toolUseId, input); return true; },
      complete: input => holds.delete(input.toolUseId),
    },
    getPendingClaudePasteAudits: () => [], selectUniqueClaudePromptSubmitAudit,
    pasteAuditHash: promptAuditFingerprint, getTerminalInputRevision: () => 0,
    claudeInternalAgentContinuationKind: () => null,
    wakeClaudePostEnterResolutionWaitersForTurnIdle() {},
    claudePromptStability: { markBusy() {} },
    terminalHistoryPreviewController: {
      activateSemanticSource() {}, begin: event => preview.push(['begin', event]),
      finish: event => preview.push(['finish', event]),
    },
    getTerminalLifecycleGeneration: () => 'G',
    safelyObserveProviderSemantic: (_label, callback) => callback(),
    providerSemanticShadow: {
      armClaudeTurn: event => semantic.push(['arm', event]),
      finishClaudeTurn: event => semantic.push(['finish', event]),
    },
    armClaudeProviderFatalTurnWatch() {}, clearClaudeProviderFatalTurnWatch() {},
    isLocalSlashCommandPrompt: () => false,
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, data) => ipc.push({ channel, ...data }) } },
    _webBroadcast: (_tabId, data) => web.push(data),
    claudeProviderFailureFromHook, completeClaudeLocalCommand() {}, clearClaudePtyCompactProofAttempt() {},
    observeClaudeAccessOutcome: (tabId, outcome) => accessOutcomes.push({ tabId, ...outcome }),
    getCombinedTabBackgroundWorkCount: () => 0, getClaudePtyRuntimePresence: () => ({ inputReady: true }),
    emitAgentReadinessChanged() {}, recordActivity: (_tab, busy, _provider, details) => activity.push({ busy, ...details }),
    shouldCreateHistoryResponseTiming: ({ event }) => event === 'Stop',
    startInterruptWatcher() {}, stopInterruptWatcher() {}, scheduleClaudeTurnWatchdog() {},
  });
  responseReader = createAgentResponseObservationReader({
    captureState: () => {
      const turn = context.taskCompletionIntents.getTurn('T');
      return { known: true, tabId: 'T', toolType: 'claude', sessionId: 'S', cwd: '/fixture',
        busy: context.claudeTurnBusy.get('T') === true, revision: 'fixture-owner', turn,
        executionContext: turn ? { provider: 'claude', sessionId: 'S', turnId: 'claude:' + turn.generation,
          processId: turn.processId, generation: turn.generation, startedAt: turn.startedAt } : null };
    },
    readLifecycle: async () => ({ processStatus: 'found', processPid: 28777, processName: 'claude' }),
    loadSessionTurns() { throw new Error('hook observation must not select a JSONL prompt'); },
    readTurnResult() { throw new Error('prompt_id must not be used as a JSONL UUID'); },
  });
  vm.runInContext(serverSource + '\nstartClaudeHookServer();', context);
  function hook(event, extra = {}) {
    const socket = new EventEmitter();
    let ack = '';
    socket.setEncoding = () => {};
    socket.write = value => { ack += value; };
    context.claudeHookServer.emit('connection', socket);
    socket.emit('data', JSON.stringify({ event, session_id: 'S', ppid: 28777,
      prompt_id: 'P-current', prompt: 'new user request', ...extra }) + '\n');
    assert.equal(ack, 'ok\n', 'ignored events are acknowledged without forcing a resend');
  }
  return { context, hook, ipc, web, activity, preview, semantic, logs, holds, accessOutcomes, responseReader };
}

test('actual admitted hook captures an exact current subject and privately delivers bounded final before lifecycle wake', async () => {
  const h = fixture();
  h.hook('UserPromptSubmit');
  const before = await h.responseReader.getAgentResponseState('T');
  const subject = before.currentSubject;
  assert.equal(subject.kind, 'claude-hook');
  assert.equal(subject.providerPromptId, 'P-current');
  assert.equal(subject.promptUserUuid, undefined);
  const delivered = [];
  h.responseReader.onAgentResponseCompletion(value => {
    assert.equal(h.web.some(event => event.type === 'done'), false);
    delivered.push(value);
  });
  const final = 'START ' + 'x'.repeat(300000) + ' END';
  h.hook('Stop', { last_assistant_message: final });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].result.sourceVerified, true);
  assert.equal(delivered[0].result.assistantChars, final.length);
  assert.equal(delivered[0].result.truncated, true);
  assert.ok(delivered[0].result.assistantText.length <= 250000);
  assert.equal(JSON.stringify(h.web).includes('START'), false);
  assert.equal(h.logs.some(line => line.includes('START')), false);
  h.hook('UserPromptSubmit', { prompt_id: 'next' });
  const read = await h.responseReader.readAgentObservedResponse({ tabId: 'T', expectedSessionId: 'S', subject, maxChars: 500 });
  assert.equal(read.result.complete, true);
  assert.equal(read.result.assistantChars, final.length);
  assert.ok(read.result.assistantText.startsWith('START '));
  assert.ok(read.result.assistantText.endsWith(' END'));
  assert.ok(read.result.assistantText.length <= 500);
  assert.notEqual((await h.responseReader.getAgentResponseState('T')).revision, before.revision);
});

test('actual hook observation rejects foreign/subagent/stale/duplicate final and preserves exact StopFailure', async () => {
  const h = fixture();
  h.hook('UserPromptSubmit');
  const subject = (await h.responseReader.getAgentResponseState('T')).currentSubject;
  for (const extra of [{ agent_id: 'child' }, { agent_transcript_path: '/fixture/child' },
    { ppid: 999 }, { prompt_id: 'foreign' }, { session_id: 'foreign' }]) {
    h.hook('Stop', { ...extra, last_assistant_message: 'foreign final' });
  }
  assert.equal(h.responseReader.stats().hookEntries, 0);
  h.hook('StopFailure', { error: 'rate_limit', error_details: 'fixture refusal' });
  h.hook('Stop', { last_assistant_message: 'late duplicate success' });
  const read = await h.responseReader.readAgentObservedResponse({ tabId: 'T', expectedSessionId: 'S', subject });
  assert.equal(read.result.complete, false);
  assert.equal(read.result.sourceVerified, true);
  assert.equal(read.result.terminalEvent, 'provider_error');
  assert.equal(read.result.proofDefinitive, true);
  assert.ok(read.result.errorCode);
  assert.equal(h.responseReader.stats().hookEntries, 1);
});

test('legacy/missing Claude hook identity never invents a canonical prompt or final proof', async () => {
  for (const extra of [{ prompt_id: undefined }, { ppid: undefined }]) {
    const h = fixture();
    h.hook('UserPromptSubmit', extra);
    const state = await h.responseReader.getAgentResponseState('T');
    assert.equal(state.currentSubject, undefined);
    if ('prompt_id' in extra) {
      assert.equal(state.executionContext.turnId, 'claude:1');
      assert.equal(state.executionContext.generation, 1);
      assert.equal(state.executionContext.processId, '28777');
      assert.equal(state.executionContext.promptUserUuid, undefined);
    } else assert.equal(state.executionContext, null);
    h.hook('Stop', { ...extra, last_assistant_message: 'unbound' });
    assert.equal(h.responseReader.stats().hookEntries, 0);
  }
  const h = fixture();
  h.hook('UserPromptSubmit');
  const subject = (await h.responseReader.getAgentResponseState('T')).currentSubject;
  h.hook('Stop', { prompt_id: undefined, last_assistant_message: 'unproven' });
  const read = await h.responseReader.readAgentObservedResponse({ tabId: 'T', expectedSessionId: 'S', subject });
  assert.equal(read.pending, true);
  assert.equal(read.code, 'response_hook_evidence_unavailable');
});

test('admitted exact Stop without final text retains a definitive missing-result error', async () => {
  const h = fixture();
  h.hook('UserPromptSubmit');
  const subject = (await h.responseReader.getAgentResponseState('T')).currentSubject;
  h.hook('Stop');
  const read = await h.responseReader.readAgentObservedResponse({ tabId: 'T', expectedSessionId: 'S', subject });
  assert.equal(read.result.found, true);
  assert.equal(read.result.complete, false);
  assert.equal(read.result.sourceVerified, true);
  assert.equal(read.result.proofDefinitive, true);
  assert.equal(read.code, 'no_final_result');
});

test('actual partial Claude Stop includes Main internal background count without claiming whole-work idle', async () => {
  const h = fixture();
  h.context.getCombinedTabBackgroundWorkCount = () => 2;
  const delivered = [];
  const dispose = h.responseReader.onAgentResponseCompletion(value => delivered.push(value));
  h.hook('UserPromptSubmit');
  const subject = (await h.responseReader.getAgentResponseState('T')).currentSubject;
  h.hook('Stop', { last_assistant_message: 'partial physical turn final' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].backgroundWorkCount, 2);
  assert.equal(delivered[0].result.complete, true, 'physical turn completion is distinct from descendants');
  assert.equal((await h.responseReader.readAgentObservedResponse({ tabId: 'T', expectedSessionId: 'S', subject })).result.complete, true);
  dispose();
  h.hook('UserPromptSubmit', { prompt_id: 'next' });
  h.hook('Stop', { prompt_id: 'next', last_assistant_message: 'next final' });
  assert.equal(delivered.length, 1, 'completion subscription has an effective disposer');
});

test('actual hook counts only distinct owned terminal 403 outcomes, not foreign/subagent/duplicate events', () => {
  const { reduceClaudeAccessFailure } = require('./claude-access-failure-stop');
  const h = fixture();
  const refusal = { apiErrorStatus: 403, error: 'authentication_error',
    error_details: 'OAuth authentication is currently not allowed for this organization' };
  h.hook('UserPromptSubmit', { prompt_id: 'P-one' });
  h.hook('StopFailure', { ...refusal, prompt_id: 'foreign' });
  h.hook('SubagentStop', { ...refusal, agent_id: 'child' });
  assert.equal(h.accessOutcomes.length, 0);
  h.hook('StopFailure', { ...refusal, prompt_id: 'P-one' });
  h.hook('StopFailure', { ...refusal, prompt_id: 'P-one' });
  let state = null;
  for (const event of h.accessOutcomes) state = reduceClaudeAccessFailure(state, event) || state;
  assert.equal(state.count, 1);
  h.hook('UserPromptSubmit', { prompt_id: 'P-two' });
  h.hook('StopFailure', { ...refusal, prompt_id: 'P-two' });
  state = reduceClaudeAccessFailure(state, h.accessOutcomes.at(-1));
  assert.equal(state.blocked, true);
});

test('actual main: confirmed start → subagent StopFailure keeps main busy and exact main Stop settles it', () => {
  const h = fixture();
  h.hook('UserPromptSubmit');
  const turn = h.context.taskCompletionIntents.getTurn('T');
  h.hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tool-main' });
  const baseline = [h.ipc.length, h.web.length, h.activity.length, h.preview.length, h.semantic.length];
  h.hook('StopFailure', { agent_id: 'background-A', error: 'rate_limit' });
  h.hook('StopFailure', { agent_transcript_path: '/fixture/S/subagents/agent-B.jsonl', error: 'unknown' });
  assert.equal(h.context.claudeTurnBusy.get('T'), true);
  assert.equal(h.context.claudeSpinnerBusy.get('T'), true);
  assert.deepEqual(h.context.taskCompletionIntents.getTurn('T'), turn);
  assert.equal(h.holds.has('tool-main'), true, 'foreign end must not clear the parent tool hold');
  assert.deepEqual([h.ipc.length, h.web.length, h.activity.length, h.preview.length, h.semantic.length], baseline);
  h.hook('Stop');
  assert.equal(h.context.claudeTurnBusy.get('T'), false);
  assert.equal(h.web.filter(event => event.type === 'done').length, 1);
  assert.equal(h.web.at(-1).turnId, 'claude:1');
  assert.deepEqual(h.activity.map(event => event.busy), [true, false]);
});

test('actual main: old prompt StopFailure on the same SID/PID cannot finish a successor', () => {
  const h = fixture();
  h.hook('UserPromptSubmit', { prompt_id: 'P-old' });
  h.hook('UserPromptSubmit', { prompt_id: 'P-new' });
  const successor = h.context.taskCompletionIntents.getTurn('T');
  h.hook('StopFailure', { prompt_id: 'P-old', error: 'unknown' });
  assert.equal(h.context.claudeTurnBusy.get('T'), true);
  assert.equal(successor.providerPromptId, 'P-new');
  assert.deepEqual(h.context.taskCompletionIntents.getTurn('T'), successor);
  assert.equal(h.web.filter(event => event.type === 'done').length, 0);
  h.hook('StopFailure', { prompt_id: 'P-new', error: 'rate_limit' });
  assert.equal(h.context.claudeTurnBusy.get('T'), false);
  assert.equal(h.web.at(-1).terminalProviderFailure, true, 'real current provider failure is still authoritative');
  assert.equal(h.web.at(-1).turnId, 'claude:2');
  assert.equal(h.activity.at(-1).responseTimingEligible, false);
});

test('actual main: delayed prior PID and unknown/subagent events have no lifecycle effects', () => {
  const h = fixture();
  h.hook('UserPromptSubmit');
  h.hook('Stop', { ppid: 11111 });
  h.hook('Stop', { session_id: 'old-S' });
  h.hook('SubagentStop', { agent_id: 'child' });
  h.hook('Notification');
  assert.equal(h.context.claudeTurnBusy.get('T'), true);
  assert.equal(h.activity.length, 1);
  assert.equal(h.web.filter(event => event.type === 'done').length, 0);
});

test('actual main: fresh pre-bridge and legacy hooks still work; main --agent is not a subagent', () => {
  const h = fixture({ fresh: true });
  h.hook('UserPromptSubmit', { prompt_id: null, agent_type: 'custom-main' });
  assert.equal(h.context.claudeTurnBusy.get('T'), true);
  h.hook('Stop', { prompt_id: null, agent_type: 'custom-main' });
  assert.equal(h.context.claudeTurnBusy.get('T'), false);
  assert.equal(h.web.filter(event => event.type === 'done').length, 1);
});

test('actual main: subagent UserPromptSubmit cannot claim the main turn or activity interval', () => {
  const h = fixture();
  h.hook('UserPromptSubmit', { agent_id: 'child', prompt_id: 'P-child' });
  assert.equal(h.context.taskCompletionIntents.getTurn('T'), null);
  assert.equal(h.context.claudeTurnBusy.has('T'), false);
  assert.equal(h.activity.length, 0);
});

test('actual main: duplicate exact start preserves generation, completion intent and activity', () => {
  const h = fixture();
  h.hook('UserPromptSubmit');
  h.context.taskCompletionIntents.authorizeCompletion({ tabId: 'T', provider: 'claude' });
  h.context.taskCompletionIntents.requestCompletion({ tabId: 'T' });
  const original = h.context.taskCompletionIntents.getTurn('T');
  h.hook('UserPromptSubmit');
  assert.deepEqual(h.context.taskCompletionIntents.getTurn('T'), original);
  assert.equal(h.activity.length, 1);
  assert.equal(h.preview.length, 1);
  h.hook('Stop');
  assert.equal(h.ipc.filter(event => event.channel === 'claude:turn-state').at(-1).explicitTaskComplete, true);
});

test('actual main Stop publishes a blocked Loop outcome separately from task completion', () => {
  const h = fixture();
  h.hook('UserPromptSubmit');
  h.context.taskCompletionIntents.authorizeCompletion({ tabId: 'T', provider: 'claude' });
  h.context.taskCompletionIntents.requestCompletion({ tabId: 'T', status: 'blocked', reason: 'unlock Mac' });
  h.hook('Stop');
  const outcome = h.ipc.filter((event) => event.channel === 'claude:turn-state').at(-1);
  assert.equal(outcome.explicitTaskBlocked, true);
  assert.equal(outcome.explicitTaskComplete, false);
  assert.equal(outcome.taskCompletionReason, 'unlock Mac');
});

test('actual main preserves existing subagent tool/question handling without making its failure a parent end', () => {
  const h = fixture();
  h.hook('UserPromptSubmit');
  const question = { agent_id: 'child', prompt_id: 'P-child', tool_name: 'AskUserQuestion',
    tool_use_id: 'question-child', tool_input: { questions: [{ question: 'Choose?' }] } };
  h.hook('PreToolUse', question);
  assert.equal(h.context.claudeAwaitingInput.get('T'), true);
  assert.equal(h.context.claudePendingQuestion.get('T').toolUseID, 'question-child');
  h.hook('StopFailure', { agent_id: 'other-child', error: 'rate_limit' });
  assert.equal(h.context.claudeAwaitingInput.get('T'), true);
  assert.equal(h.context.claudeTurnBusy.get('T'), true);
  assert.equal(h.web.filter(event => event.type === 'done').length, 0);
  h.hook('PostToolUse', question);
  assert.equal(h.context.claudeAwaitingInput.get('T'), false);
  assert.equal(h.context.claudeTurnBusy.get('T'), true);
  h.hook('Stop');
  assert.equal(h.context.claudeTurnBusy.get('T'), false);
});

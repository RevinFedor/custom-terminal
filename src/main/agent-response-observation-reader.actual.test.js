'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createAgentResponseObservationReader } = require('./agent-response-observation-reader');
const { TaskCompletionIntentRegistry } = require('./task-completion-intent');
const { _api: codexApi } = require('./ipc/codex-data');
const { loadJsonlRecords, _api: claudeDataApi } = require('./ipc/claude-data');
const carriers = require('./claude-prompt-carriers');
const materializers = require('./claude-orchestration-result');
const { classifyOrchestrationResultProbe, RESULT_PROOF_KINDS } = require('./orchestration-result-proof');
const { projectClaudePtyPresence } = require('./claude-pty-presence');
const { projectCodexPublicRuntimeProjection } = require('./codex-runtime-contract');

const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const parsed = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const actual = name => {
  const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(parsed);
};
const functions = ['getActiveAgentExecutionContext', 'captureAgentResponseReadState', 'readObservedTranscriptResponse',
  'getAgentResponseObservationReader', '_getAgentTurnResultForOrchestration', '_loadSessionTurns', '_loadCodexSessionTurns',
  '_buildActiveBranch', '_groupIntoTurns', '_isNoisePrompt'];
const interruptTextsSource = parsed.statements.find(item => ts.isVariableStatement(item)
  && item.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === 'INTERRUPT_TEXTS')).getText(parsed);
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const cUser = uuid => ({ uuid, type: 'user', message: { content: 'same prompt' } });
const cAnswer = (uuid, body, stopReason = 'end_turn', extra = {}) => ({ uuid, type: 'assistant', ...extra,
  message: { role: 'assistant', content: [{ type: 'text', text: body }], stop_reason: stopReason } });
const event = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const codexTurn = (id, body, terminal = 'task_complete') => [event('task_started', { turn_id: id }),
  event('user_message', { message: 'same prompt' }),
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: body }] } },
  ...(terminal ? [event(terminal, { turn_id: id, last_agent_message: body })] : [])];

function fixture(t, { provider = 'claude', rows = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-response-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'S.jsonl');
  const prepare = values => provider === 'claude' ? values.map((row, index) => ({
    sessionId: 'S', timestamp: '2026-10-08T00:00:00Z', parentUuid: index ? values[index - 1].uuid : null, ...row,
  })) : values;
  fs.writeFileSync(file, encode(prepare(rows)));
  const owner = { known: true, provider, sessionId: 'S', cwd: dir, instanceId: 'instance', terminalId: 'term', launchId: 'launch', runSeq: 1 };
  const delivered = [];
  const controls = { input: 1, generation: 'lifecycle:1', ready: true, background: 0,
    lifecycle: { processStatus: 'found', processName: provider, processPid: 321 }, beforeLifecycle: null };
  const cache = new Map();
  const sourceResolver = async () => {
    const stat = await fs.promises.stat(file);
    return { success: true, sessionId: 'S', revisionKey: file,
      sourceSnapshot: { filePath: file, sessionId: 'S', size: stat.size, mtimeMs: stat.mtimeMs },
      segments: [{ filePath: file, physicalSessionId: 'S', fromByte: 0, toByte: stat.size, startLine: 0, frozen: false }] };
  };
  const context = vm.createContext({
    ...carriers, ...materializers, require, path, fs, srcMainDir: __dirname,
    console: { log() {}, warn() {} },
    projectManager: { db: { db: { prepare: sql => {
      assert.match(sql, /^SELECT tab_id FROM tabs WHERE tab_id = \? AND execution_archived = 0 LIMIT 1$/);
      return { get: tabId => { assert.equal(tabId, 'T'); return owner.exists === false ? undefined : { tab_id: 'T' }; } };
    } } } },
    captureConversationOwner: () => ({ ...owner }),
    conversationOwners: { stored: () => null }, sdkSessions: new Map(), terminals: new Map([['T', {}]]),
    ptyActiveWriteOperation: new Map(), claudePendingPrompt: new Map(), codexPromptInFlight: new Map(),
    taskCompletionIntents: new TaskCompletionIntentRegistry(), aiStoppingTabs: new Map(),
    claudeTurnBusy: new Map([['T', false]]), claudeLocalCommandWatchers: new Map(), claudeHookLastEvent: new Map(),
    codexTurnWatchers: new Map([['T', { busy: false, liveTurnEvents: 0, currentTurnId: null,
      sessionId: 'S', processGeneration: 'lifecycle:1', outcomeKnown: true, lastOutcomeReason: 'task_complete' }]]),
    codexProviderSemanticSources: new Map(), bridgeKnownSessions: new Map(provider === 'claude' ? [['T', 'S']] : []),
    getClaudePtyRuntimePresence: () => ({ status: controls.ready ? 'active' : 'starting', inputReady: controls.ready }),
    getCodexPublicRuntimeProjection: () => ({ sessionStatus: controls.ready ? 'active' : 'starting', inputReady: controls.ready }),
    getCodexRuntimeSessionId: () => owner.sessionId,
    getTerminalLifecycleGeneration: () => controls.generation,
    getTerminalInputRevision: () => controls.input, getTerminalStopRevision: () => 0,
    getCombinedTabBackgroundWorkCount: () => controls.background, tabBackgroundWorkRevisionByTab: new Map(),
    readAiLifecycleIdentityForTab: async () => { await controls.beforeLifecycle?.(); return { ...controls.lifecycle }; },
    _resolveHistoryReadSession: async () => ({ provider, filePath: file }), loadJsonlRecords, claudeDataApi,
    _getOverseerTurnsCache: key => cache.get(key), _deleteOverseerTurnsCache: key => cache.delete(key),
    _setOverseerTurnsCache: (key, data) => cache.set(key, data), _loadSessionAnnotations: () => ({}),
    _sessionProgressToolDetail: () => null, shortKnowledgeDocsPath: () => null,
    codexDataModule: { _api: { ...codexApi,
      loadSessionRecords() { throw new Error('forbidden global/raw session discovery'); },
    } },
    transcriptService: { resolveCodexResultSource: sourceResolver,
      loadCodexOperationSource: async () => {
        const stat = await fs.promises.stat(file);
        const data = await codexApi.readJsonlRange(file, 0, stat.size - 1);
        return { success: true, filePath: file, records: data.records,
          sourceSnapshot: (await sourceResolver()).sourceSnapshot, contentRevision: String(stat.size) };
      } },
  });
  vm.runInContext('let agentResponseObservationReader = null;\n' + interruptTextsSource + '\n' + functions.map(actual).join('\n'), context);
  const reader = context.getAgentResponseObservationReader();
  reader.onAgentResponseCompletion(evidence => delivered.push(evidence));
  const begin = (id = 'turn-new') => {
    const turn = context.taskCompletionIntents.beginTurn({ tabId: 'T', provider, sessionId: owner.sessionId,
      turnId: provider === 'codex' ? id : null, providerPromptId: provider === 'claude' ? id : null, processId: 321 });
    if (provider === 'claude') {
      context.claudeTurnBusy.set('T', true);
      reader.observeClaudeHook({ tabId: 'T', turn, admitted: true,
        message: { event: 'UserPromptSubmit', session_id: 'S', ppid: 321, prompt_id: id } });
    } else Object.assign(context.codexTurnWatchers.get('T'), { busy: true, currentTurnId: id,
      outcomeKnown: false, lastOutcomeReason: null, lastOutcomeTurnId: null,
      liveTurnEvents: context.codexTurnWatchers.get('T').liveTurnEvents + 1 });
    return turn;
  };
  const finish = turn => {
    context.taskCompletionIntents.finishTurn({ tabId: 'T', provider, sessionId: owner.sessionId, success: true });
    if (provider === 'claude') {
      context.claudeTurnBusy.set('T', false);
      reader.observeClaudeHook({ tabId: 'T', turn, admitted: true, matched: true, backgroundWorkCount: controls.background,
        message: { event: 'Stop', session_id: 'S', ppid: 321, prompt_id: turn.providerPromptId, last_assistant_message: 'new final' } });
    } else Object.assign(context.codexTurnWatchers.get('T'), { busy: false, lastOutcomeTurnId: turn.turnId,
      outcomeKnown: true, lastOutcomeReason: 'task_complete',
      liveTurnEvents: context.codexTurnWatchers.get('T').liveTurnEvents + 1 });
  };
  return { dir, file, owner, controls, context, reader, begin, finish, delivered,
    write: next => fs.writeFileSync(file, encode(prepare(next))),
    read: args => reader.readAgentObservedResponse({ tabId: 'T', expectedSessionId: 'S', ...args }),
    state: () => reader.getAgentResponseState('T') };
}

test('web options expose all three additive callbacks beside the existing result reader', () => {
  for (const name of ['getAgentResponseState', 'readAgentObservedResponse', 'onAgentResponseCompletion']) {
    assert.match(source, new RegExp(name + ': \\w+ => getAgentResponseObservationReader\\(\\)\\.' + name + '\\('));
  }
  assert.match(source, /getAgentTurnResult: _getAgentTurnResultForOrchestration,/);
});

for (const provider of ['claude', 'codex']) {
  test('actual ' + provider + ' Main latest pins exact saved identity and returns the latest completed text', async t => {
    const rows = provider === 'claude' ? [cUser('U1'), cAnswer('A1', 'old'), cUser('U2'), cAnswer('A2', 'latest')]
      : [...codexTurn('old', 'old'), ...codexTurn('latest', 'latest')];
    const f = fixture(t, { provider, rows });
    const result = await f.read();
    assert.equal(result.result?.assistantText, 'latest', JSON.stringify(result));
    assert.equal(result.result.complete, true);
    assert.equal(result.result.sourceVerified, true);
    if (provider === 'claude') {
      assert.equal(result.subject.kind, 'transcript');
      assert.equal(result.subject.promptUserUuid, 'U2');
      assert.equal(result.subject.targetExecutionContext, null);
    } else {
      assert.equal(result.subject.kind, 'codex-historical-execution');
      assert.equal(result.subject.targetExecutionContext.turnId, 'latest');
      assert.equal(result.subject.targetExecutionContext.generation, null);
    }
    assert.equal((await f.state()).busy, false);
  });

  for (const boundary of ['selection', 'result']) {
    test('actual ' + provider + ' start+finish during ' + boundary + ' I/O invalidates idle latest', async t => {
      const f = fixture(t, { provider, rows: provider === 'claude' ? [cUser('U'), cAnswer('A', 'old')]
        : codexTurn('old', 'old') });
      const targetOwner = provider === 'codex' ? f.context.codexDataModule._api : f.context;
      const target = provider === 'codex' ? 'loadLatestCodexObservedExecution'
        : boundary === 'selection' ? '_loadSessionTurns' : 'readObservedTranscriptResponse';
      // The factory retains callbacks at construction. Recreate it after
      // wrapping the real function with an explicit async scheduling boundary.
      const original = targetOwner[target];
      assert.equal(typeof original, 'function', target + ' must be available for the actual I/O race test');
      let entered = false;
      targetOwner[target] = async (...args) => {
        if (provider === 'codex' && boundary === 'selection') { entered = true; f.finish(f.begin()); }
        const result = await original(...args);
        if (!entered) { entered = true; f.finish(f.begin()); }
        return result;
      };
      vm.runInContext('agentResponseObservationReader = null;', f.context);
      const reader = f.context.getAgentResponseObservationReader();
      // Both hook observations and reads must use the same Main singleton.
      if (provider === 'claude') {
        const oldObserve = f.reader.observeClaudeHook;
        f.reader.observeClaudeHook = args => { oldObserve(args); reader.observeClaudeHook(args); };
      }
      const result = await reader.readAgentObservedResponse({ tabId: 'T', expectedSessionId: 'S' });
      assert.equal(result.pending, true, JSON.stringify(result));
      assert.equal(result.subject, null);
      assert.equal(result.result, undefined);
      assert.equal(result.code, 'response_state_changed');
    });
  }

  test('actual ' + provider + ' busy default does not read or guess the current prompt', async t => {
    const f = fixture(t, { provider });
    f.begin();
    f.context._loadSessionTurns = () => { throw new Error('must not read latest while busy'); };
    const result = await f.read();
    assert.equal(result.pending, true);
    assert.equal(result.code, 'response_busy');
    assert.equal(result.subject, null);
  });

  test('actual ' + provider + ' stopped existing tab can select latest after Main restart', async t => {
    const f = fixture(t, { provider, rows: provider === 'claude' ? [cUser('U'), cAnswer('A', 'saved')]
      : codexTurn('old', 'saved') });
    f.controls.lifecycle.processStatus = 'absent';
    f.context.terminals.clear();
    f.context.claudeTurnBusy.clear();
    f.context.codexTurnWatchers.clear();
    f.context.bridgeKnownSessions.clear();
    f.controls.ready = false;
    // No startup is pending for this stopped tab.
    f.context.getClaudePtyRuntimePresence = () => ({ status: 'inactive', inputReady: false });
    f.context.getCodexPublicRuntimeProjection = () => ({ sessionStatus: 'inactive', inputReady: false });
    const state = await f.state();
    assert.equal(state.processStatus, 'absent');
    assert.equal(state.busy, false);
    const result = await f.read();
    assert.equal(result.result?.assistantText, 'saved', JSON.stringify(result));
    assert.equal(result.result.sourceVerified, true);
  });

  test(provider + ' stopped incomplete latest or pinned response fails the read instead of waiting forever', async t => {
    const f = fixture(t, { provider, rows: provider === 'claude'
      ? [cUser('OLD'), cAnswer('old-final', 'OLD SUCCESS'), cUser('PENDING'), cAnswer('partial', 'PARTIAL', 'tool_use')]
      : [...codexTurn('OLD', 'OLD SUCCESS'), ...codexTurn('PENDING', 'PARTIAL', null)] });
    const initial = await f.read();
    assert.equal(initial.pending, true);
    assert.equal(classifyOrchestrationResultProbe(initial.result).kind, RESULT_PROOF_KINDS.PENDING);
    const pinned = initial.subject;
    for (const processStatus of ['found', 'unknown', 'absent']) {
      f.controls.lifecycle.processStatus = processStatus;
      assert.equal((await f.state()).processStatus, processStatus);
      for (const subject of [null, pinned]) {
        const read = await f.read({ subject });
        if (processStatus !== 'absent') {
          assert.equal(read.pending, true);
        } else {
          assert.equal(read.pending, undefined);
          assert.equal(read.code, 'result_unavailable');
          assert.ok(read.error);
          assert.deepEqual(read.subject, pinned);
          assert.equal(read.result, undefined, 'do not fabricate provider failure or certify partial text');
        }
      }
    }
  });

  test(provider + ' completed response is readable with blocked input, without changing input policy', async t => {
    const f = fixture(t, { provider, rows: provider === 'claude' ? [cUser('U'), cAnswer('A', 'saved final')]
      : codexTurn('completed', 'saved final') });
    const turn = f.begin('completed');
    f.controls.ready = false;
    assert.equal((await f.state()).busy, true);
    assert.equal((await f.read()).code, 'response_busy');
    f.finish(turn);
    for (const projectedStatus of ['active', 'starting']) {
      const getter = provider === 'claude' ? 'getClaudePtyRuntimePresence' : 'getCodexPublicRuntimeProjection';
      f.context[getter] = () => ({ status: projectedStatus, sessionStatus: projectedStatus, inputReady: false });
      const state = await f.state();
      assert.equal(state.busy, false);
      const read = await f.read();
      assert.equal(read.pending, undefined, JSON.stringify(read));
      assert.equal(read.result.complete, true);
      assert.equal(read.result.sourceVerified, true);
      assert.equal(read.result.assistantText, 'saved final');
      assert.equal(f.controls.ready, false);
      assert.equal(f.context[getter]().inputReady, false);
    }
  });

  test(provider + ' confirmed idle with blocked input does not turn unknown process lookup into idle', async t => {
    const f = fixture(t, { provider });
    f.finish(f.begin('completed'));
    f.controls.ready = false;
    f.controls.lifecycle.processStatus = 'unknown';
    assert.equal((await f.state()).busy, null);
    const read = await f.read();
    assert.equal(read.pending, true);
    assert.equal(read.code, 'response_busy_unknown');
    assert.equal(read.result, undefined);
  });

  test(provider + ' blocked input without any authoritative idle evidence remains unknown', async t => {
    const f = fixture(t, { provider });
    f.controls.ready = false;
    f.context.claudeTurnBusy.clear();
    f.context.codexTurnWatchers.get('T').outcomeKnown = false;
    assert.equal((await f.state()).busy, null);
    assert.equal((await f.read()).pending, true);
  });

  test(provider + ' inputReady=true without authoritative idle proof cannot authorize latest selection', async t => {
    const f = fixture(t, { provider, rows: provider === 'claude' ? [cUser('OLD'), cAnswer('A', 'OLD FINAL')]
      : codexTurn('OLD', 'OLD FINAL') });
    f.context.claudeTurnBusy.clear();
    f.context.codexTurnWatchers.get('T').outcomeKnown = false;
    // Exercise the shared projections that allow input independently of turn
    // completion, including the real Main capture and its lifecycle read.
    f.context.getClaudePtyRuntimePresence = () => projectClaudePtyPresence({
      hasTerm: true, hasBridge: true, promptReady: true, cliActive: true,
    });
    f.context.getCodexPublicRuntimeProjection = () => projectCodexPublicRuntimeProjection({
      liveLifecycle: true, tuiInputReady: true, tuiLifecycleEstablished: true, writerUsableForMutation: true,
    });
    const projected = provider === 'claude' ? f.context.getClaudePtyRuntimePresence()
      : f.context.getCodexPublicRuntimeProjection();
    assert.equal(projected.inputReady, true);
    const state = await f.state();
    assert.equal(state.known, true);
    assert.equal(state.processStatus, 'found');
    assert.equal(state.busy, null);
    const result = await f.read();
    assert.equal(result.pending, true);
    assert.equal(result.code, 'response_busy_unknown');
    assert.equal(result.result, undefined);
    assert.equal(result.subject, null);
  });

  test(provider + ' idle proof does not bypass pending input or a successor turn', async t => {
    const f = fixture(t, { provider });
    f.finish(f.begin('completed'));
    f.controls.ready = false;
    const pending = provider === 'claude' ? f.context.claudePendingPrompt : f.context.codexPromptInFlight;
    pending.set('T', 'pending input');
    assert.equal((await f.state()).busy, null);
    assert.equal((await f.read()).pending, true);
    pending.clear();
    f.begin('successor');
    assert.equal((await f.state()).busy, true);
    assert.equal((await f.read()).code, 'response_busy');
  });
}

for (const mismatch of ['session', 'generation', 'turn', 'catch-up', 'binding-conflict']) {
  test('Codex last outcome cannot lend idle proof across ' + mismatch, async t => {
    const f = fixture(t, { provider: 'codex' });
    f.finish(f.begin('completed'));
    f.controls.ready = false;
    const watcher = f.context.codexTurnWatchers.get('T');
    if (mismatch === 'session') watcher.sessionId = 'foreign';
    if (mismatch === 'generation') watcher.processGeneration = 'old-generation';
    if (mismatch === 'turn') watcher.currentTurnId = 'different';
    if (mismatch === 'catch-up') watcher.catchUpPending = true;
    if (mismatch === 'binding-conflict') watcher.manualBindingConflict = { source: 'fixture-owner-conflict' };
    assert.equal((await f.state()).busy, null);
    assert.equal((await f.read()).pending, true);
  });
}

test('Claude known idle does not bypass a real startup settings gate', async t => {
  const f = fixture(t);
  f.finish(f.begin());
  f.context.getClaudePtyRuntimePresence = () => ({ status: 'starting', inputReady: false, startupDefaultsPending: true });
  assert.equal((await f.state()).busy, null);
  assert.equal((await f.read()).pending, true);
});

test('Claude StopFailure remains readable as an explicit failure behind blocked input', async t => {
  const f = fixture(t, { rows: [cUser('U'),
    cAnswer('A', 'API Error: 403 forbidden', 'end_turn', { isApiErrorMessage: true, error: 'authentication_failed' })] });
  f.controls.ready = false;
  f.context.claudeHookLastEvent.set('T', { event: 'StopFailure', sessionId: 'S', turnId: 'claude:1' });
  assert.equal((await f.state()).busy, false);
  const read = await f.read();
  assert.equal(read.pending, undefined);
  assert.equal(read.result.complete, false);
  assert.equal(read.result.proofDefinitive, true);
  assert.equal(read.result.sourceVerified, true);
  assert.equal(read.result.terminalEvent, 'provider_error');
});

test('absent Claude with missing pinned hook evidence returns a read error without inventing a transcript result', async t => {
  const f = fixture(t);
  f.begin();
  const subject = (await f.state()).currentSubject;
  f.context.taskCompletionIntents.abortTurn('T');
  f.context.claudeTurnBusy.set('T', false);
  f.controls.lifecycle.processStatus = 'absent';
  const read = await f.read({ subject });
  assert.equal(read.pending, undefined);
  assert.equal(read.code, 'response_hook_evidence_unavailable');
  assert.equal(read.result, undefined);
});

test('absence does not replace a proven no-final terminal with an incomplete-read failure', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', '')] });
  f.controls.lifecycle.processStatus = 'absent';
  const read = await f.read();
  assert.equal(read.pending, undefined);
  assert.equal(read.code, 'no_final_result');
  assert.equal(read.result.proofDefinitive, true);
  assert.equal(read.result.sourceVerified, true);
});

for (const [name, latest] of [
  ['unanswered', []],
  ['tool-only', [cAnswer('A2', 'partial', 'tool_use')]],
  ['paused', [cAnswer('A2', 'partial', 'pause_turn')]],
  ['provider failure', [cAnswer('A2', 'API Error: 403 forbidden', 'end_turn', { isApiErrorMessage: true, error: 'authentication_failed' })]],
]) test('actual Claude latest never skips ' + name + ' to the old successful turn', async t => {
  const f = fixture(t, { rows: [cUser('U1'), cAnswer('A1', 'old success'), cUser('U2'), ...latest] });
  const result = await f.read();
  assert.equal(result.subject.promptUserUuid, 'U2');
  assert.equal(result.result.complete, false);
  assert.equal(result.result.sourceVerified, true);
  assert.notEqual(result.result.assistantText, 'old success');
});

for (const marker of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
  for (const arrayContent of [false, true]) test('saved exact Claude interruption is terminal: ' + marker + ' array=' + arrayContent, async t => {
    const content = arrayContent ? [{ type: 'text', text: marker }] : marker;
    const f = fixture(t, { rows: [cUser('OLD'), cAnswer('old-final', 'old success'), cUser('CURRENT'),
      cAnswer('partial', 'partial work', 'tool_use'), { ...cUser('ABORT'), message: { content } }] });
    for (const subject of [null, { kind: 'transcript', toolType: 'claude', sessionId: 'S', promptUserUuid: 'ABORT' }]) {
      const result = await f.read({ subject });
      assert.equal(result.pending, undefined);
      assert.equal(result.code, 'turn_aborted');
      assert.equal(result.subject.promptUserUuid, 'ABORT');
      assert.equal(result.result.userUuid, 'ABORT');
      assert.equal(result.result.found, true);
      assert.equal(result.result.complete, false);
      assert.equal(result.result.sourceVerified, true);
      assert.equal(result.result.proofDefinitive, true);
      assert.equal(result.result.terminalEvent, 'turn_aborted');
      assert.equal(result.result.assistantText, '');
    }
  });
}

for (const body of ['"[Request interrupted by user]"', 'Explain [Request interrupted by user]',
  '[Request interrupted by user] quoted in a question', '[Request interrupted because of a network error]']) {
  test('saved ordinary user text is not an exact abort marker: ' + body, async t => {
    const f = fixture(t, { rows: [cUser('OLD'), cAnswer('old-final', 'old success'),
      { ...cUser('NEW'), message: { content: body } }] });
    const result = await f.read();
    assert.equal(result.pending, true);
    assert.equal(result.subject.promptUserUuid, 'NEW');
    assert.equal(result.result.complete, false);
    assert.notEqual(result.result.proofDefinitive, true);
    assert.notEqual(result.result.terminalEvent, 'turn_aborted');
  });
}

test('assistant text quoting the exact interruption marker cannot supply typed user interruption proof', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', '[Request interrupted by user]', 'tool_use')] });
  const result = await f.read();
  assert.equal(result.pending, true);
  assert.notEqual(result.result.terminalEvent, 'turn_aborted');
});

for (const body of ['', '   \n']) test('saved Claude completed empty final is definitive no_final_result: ' + JSON.stringify(body), async t => {
  const f = fixture(t, { rows: [cUser('OLD'), cAnswer('old-final', 'old success'), cUser('EMPTY'), cAnswer('empty-final', body)] });
  const result = await f.read();
  assert.equal(result.pending, undefined);
  assert.equal(result.code, 'no_final_result');
  assert.equal(result.subject.promptUserUuid, 'EMPTY');
  assert.equal(result.result.complete, false);
  assert.equal(result.result.sourceVerified, true);
  assert.equal(result.result.proofDefinitive, true);
  assert.equal(result.result.hasFinalResult, false);
});

test('empty Claude text without completion proof remains pending', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', '', 'tool_use')] });
  const result = await f.read();
  assert.equal(result.pending, true);
  assert.notEqual(result.result.proofDefinitive, true);
});

test('saved abort classifier cannot borrow a rewritten source under the same UUID', async t => {
  const f = fixture(t, { rows: [{ ...cUser('U'), message: { content: '[Request interrupted by user]' } }] });
  const original = f.context._getAgentTurnResultForOrchestration;
  f.context._getAgentTurnResultForOrchestration = async request => {
    const result = await original(request);
    f.write([cUser('U')]);
    return result;
  };
  const result = await f.read();
  assert.equal(result.pending, true);
  assert.equal(result.code, 'response_source_unverified');
  assert.equal(result.result.sourceVerified, false);
  assert.notEqual(result.result.proofDefinitive, true);
  assert.notEqual(result.result.terminalEvent, 'turn_aborted');
});

test('unverified empty final does not acquire definitive terminal proof', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', '')] });
  const original = f.context._getAgentTurnResultForOrchestration;
  f.context._getAgentTurnResultForOrchestration = async request => {
    const result = await original(request);
    f.write([cUser('U'), cAnswer('A', 'changed')]);
    return result;
  };
  const result = await f.read();
  assert.equal(result.pending, true);
  assert.equal(result.result.sourceVerified, false);
  assert.equal(result.result.proofDefinitive, false);
});

for (const terminal of ['turn_aborted', null]) test('actual Codex latest retains ' + (terminal || 'incomplete') + ' outcome', async t => {
  const f = fixture(t, { provider: 'codex', rows: [...codexTurn('old', 'old success'), ...codexTurn('new', 'partial', terminal)] });
  const result = await f.read();
  assert.equal(result.subject.kind, 'codex-historical-execution');
  assert.equal(result.subject.targetExecutionContext.turnId, 'new');
  assert.equal(result.subject.targetExecutionContext.generation, null);
  assert.equal(result.result.complete, false);
  assert.equal(result.result.sourceVerified, true);
  if (!terminal) assert.equal(result.pending, true);
  if (terminal) assert.equal(result.result.errorCode, 'turn_aborted');
});

test('actual Claude queued user is latest and internal continuation still needs its own completion proof', async t => {
  const f = fixture(t, { rows: [cUser('U1'), cAnswer('A1', 'old'),
    { uuid: 'Q', type: 'attachment', attachment: { type: 'queued_command', prompt: 'queued request' } },
    cAnswer('A2', 'before continuation'),
    { ...cUser('internal'), message: { content: '<task-notification>background done</task-notification>' } }] });
  const result = await f.read();
  assert.equal(result.subject.promptUserUuid, 'Q');
  assert.equal(result.result.complete, false);
});

test('actual Codex captured execution reads exact A during B without generic selection or raw cache', async t => {
  const f = fixture(t, { provider: 'codex', rows: [...codexTurn('A', 'A final'), ...codexTurn('B', 'B partial', null)] });
  const a = f.begin('A');
  const subject = (await f.state()).currentSubject;
  assert.equal(subject.kind, 'codex-execution');
  assert.equal(subject.targetExecutionContext.turnId, 'A');
  f.finish(a);
  f.begin('B');
  const before = codexApi.getCodexJsonlCacheStats();
  const result = await f.read({ subject });
  assert.equal(result.result.assistantText, 'A final');
  assert.equal(result.result.complete, true);
  assert.equal(result.result.sourceVerified, true);
  assert.equal(result.subject.targetExecutionContext.turnId, 'A');
  assert.deepEqual(codexApi.getCodexJsonlCacheStats(), before);
});

for (const invalid of ['synthetic', 'missing-generation', 'provisional']) test('Main never exposes an unproven Codex current subject: ' + invalid, async t => {
  const f = fixture(t, { provider: 'codex' });
  f.begin('A');
  if (invalid === 'synthetic') f.context.taskCompletionIntents.turns.get('T').externalTurnId = null;
  if (invalid === 'missing-generation') f.context.taskCompletionIntents.turns.get('T').generation = null;
  if (invalid === 'provisional') f.context.codexTurnWatchers.get('T').publicTurnStateSuppressed = true;
  assert.equal((await f.state()).currentSubject, undefined);
  assert.equal((await f.state()).executionContext, null);
});

for (const unknown of ['process', 'presence', 'startup', 'pending-submit', 'lookup-error']) test('Main busy unknown stays unknown: ' + unknown, async t => {
  const f = fixture(t);
  if (unknown === 'process') f.controls.lifecycle.processStatus = 'unknown';
  if (unknown === 'presence' || unknown === 'startup') f.controls.ready = false;
  if (unknown === 'presence') f.context.claudeTurnBusy.clear();
  if (unknown === 'startup') f.context.getClaudePtyRuntimePresence = () => ({ status: 'starting', inputReady: false, startupDefaultsPending: true });
  if (unknown === 'pending-submit') f.context.claudePendingPrompt.set('T', 'not yet admitted');
  if (unknown === 'lookup-error') f.controls.beforeLifecycle = () => { throw new Error('lookup failed'); };
  const state = await f.state();
  assert.equal(state.busy, null);
  assert.ok(state.error);
  assert.equal((await f.read()).pending, true);
});

test('a full turn during the runtime probe cannot produce a coherent idle observation', async t => {
  const f = fixture(t);
  f.controls.beforeLifecycle = () => { f.finish(f.begin()); };
  const state = await f.state();
  assert.equal(state.known, false);
  assert.equal(state.busy, null);
  assert.equal(state.error, 'response_state_changed');
});

for (const mutation of ['input', 'session', 'cwd', 'launch', 'closed']) test('actual Main latest read fences ' + mutation + ' during I/O', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', 'old')] });
  const original = f.context._getAgentTurnResultForOrchestration;
  f.context._getAgentTurnResultForOrchestration = async request => {
    const result = await original(request);
    if (mutation === 'input') f.controls.input++;
    if (mutation === 'session') { f.owner.sessionId = 'other'; f.context.bridgeKnownSessions.set('T', 'other'); }
    if (mutation === 'cwd') f.owner.cwd = '/different';
    if (mutation === 'launch') f.controls.generation = 'lifecycle:2';
    if (mutation === 'closed') f.owner.known = false;
    return result;
  };
  const result = await f.read();
  assert.equal(result.result, undefined);
  assert.ok(result.pending || result.error);
  assert.equal(result.subject, null);
});

test('explicit transcript subject does not reselect a completed successor', async t => {
  const f = fixture(t, { rows: [cUser('A'), cAnswer('a-final', 'A final'), cUser('B'), cAnswer('b-final', 'B final')] });
  const result = await f.read({ subject: { kind: 'transcript', toolType: 'claude', sessionId: 'S', promptUserUuid: 'A' } });
  assert.equal(result.result.assistantText, 'A final');
  assert.equal(result.result.userUuid, 'A');
  assert.equal(result.result.sourceVerified, true);
});

test('Claude physical source replacement after materialization cannot authorize final evidence', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', 'old')] });
  const original = f.context._getAgentTurnResultForOrchestration;
  f.context._getAgentTurnResultForOrchestration = async request => {
    const result = await original(request);
    fs.renameSync(f.file, f.file + '.old');
    f.write([cUser('U'), cAnswer('A', 'new')]);
    return result;
  };
  const result = await f.read();
  assert.equal(result.pending, true);
  assert.equal(result.result.sourceVerified, false);
  assert.equal(result.code, 'response_source_unverified');
});

test('missing canonical prompt and reader errors stay explicit, never falling back to text/time', async t => {
  const f = fixture(t, { rows: [] });
  assert.equal((await f.read()).code, 'response_latest_user_unavailable');
  fs.unlinkSync(f.file);
  const result = await f.read();
  assert.equal(result.code, 'ENOENT');
  assert.ok(result.error);
});

test('exact Codex helper unavailability remains a named proof failure', async t => {
  const f = fixture(t, { provider: 'codex' });
  f.begin('A');
  const subject = (await f.state()).currentSubject;
  delete f.context.codexDataModule._api.loadCodexObservedExecution;
  const result = await f.read({ subject });
  assert.equal(result.result.sourceVerified, false);
  assert.equal(result.result.found, false);
  assert.equal(result.code, 'codex_observed_execution_reader_unavailable');
});

test('bounded hook evidence evicts without returning another answer and restart has no invented proof', async () => {
  const options = {
    captureState: () => ({ known: true, toolType: 'claude', sessionId: 'S', cwd: '/fixture', busy: false, revision: 1 }),
    readLifecycle: async () => ({ processStatus: 'found', processName: 'claude', processPid: 321 }),
    maxHookEntries: 2, maxHookChars: 1000, maxStateEntries: 2,
  };
  const reader = createAgentResponseObservationReader(options);
  const subjects = [];
  const unsubscribe = reader.onAgentResponseCompletion(value => subjects.push(value.subject));
  for (let generation = 1; generation <= 5; generation++) {
    reader.observeClaudeHook({ tabId: 'T', admitted: true, matched: true,
      turn: { provider: 'claude', sessionId: 'S', generation, processId: '321', providerPromptId: 'P' + generation },
      message: { event: 'Stop', session_id: 'S', ppid: 321, prompt_id: 'P' + generation, last_assistant_message: 'x'.repeat(600) } });
    await reader.getAgentResponseState('T' + generation);
  }
  unsubscribe();
  assert.ok(reader.stats().retainedChars <= 1000);
  assert.ok(reader.stats().hookEntries <= 2);
  assert.equal(reader.stats().stateEntries, 2);
  const request = { tabId: 'T', expectedSessionId: 'S', subject: subjects[0] };
  assert.equal((await reader.readAgentObservedResponse(request)).code, 'response_hook_evidence_unavailable');
  request.subject = subjects.at(-1);
  assert.equal((await reader.readAgentObservedResponse(request)).result.complete, true);
  assert.equal((await createAgentResponseObservationReader(options).readAgentObservedResponse(request)).code, 'response_hook_evidence_unavailable');
});

test('actual Main bounds response body while preserving original character count', async t => {
  const body = 'BEGIN ' + 'x'.repeat(300000) + ' END';
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', body)] });
  for (const maxChars of [500, 250000, 999999]) {
    const result = await f.read({ maxChars });
    assert.equal(result.result.complete, true);
    assert.equal(result.result.sourceVerified, true);
    assert.equal(result.result.truncated, true);
    assert.equal(result.result.assistantChars, body.length);
    assert.ok(result.result.assistantText.length <= Math.min(maxChars, 250000));
    assert.ok(result.result.assistantText.startsWith('BEGIN '));
    assert.ok(result.result.assistantText.endsWith(' END'));
  }
});

test('exact subject is copied before asynchronous observation, never retargeted by caller mutation', async t => {
  const f = fixture(t, { rows: [cUser('A'), cAnswer('a', 'A final'), cUser('B'), cAnswer('b', 'B final')] });
  const subject = { kind: 'transcript', toolType: 'claude', sessionId: 'S', promptUserUuid: 'A' };
  f.controls.beforeLifecycle = () => { subject.promptUserUuid = 'B'; };
  const result = await f.read({ subject });
  assert.equal(result.subject.promptUserUuid, 'A');
  assert.equal(result.result.assistantText, 'A final');
});

test('Main cannot expose an old Claude PID as the current captured turn', async t => {
  const f = fixture(t);
  f.begin();
  f.controls.lifecycle.processPid = 999;
  assert.equal((await f.state()).currentSubject, undefined);
  assert.equal((await f.state()).executionContext, null);
  f.controls.lifecycle.processName = 'codex';
  assert.equal((await f.state()).known, false);
});

test('Main exposes bounded legacy Claude execution identity without pretending it has a prompt UUID', async t => {
  const f = fixture(t);
  const turn = f.begin();
  f.context.taskCompletionIntents.turns.get('T').providerPromptId = null;
  const state = await f.state();
  assert.equal(state.currentSubject, undefined);
  assert.deepEqual(Object.keys(state.executionContext).sort(), ['provider', 'sessionId', 'turnId', 'generation', 'processId', 'startedAt'].sort());
  assert.equal(state.executionContext.provider, 'claude');
  assert.equal(state.executionContext.sessionId, 'S');
  assert.equal(state.executionContext.turnId, 'claude:' + turn.generation);
  assert.equal(state.executionContext.generation, turn.generation);
  assert.equal(state.executionContext.processId, '321');
  state.executionContext.generation = 999;
  assert.equal((await f.state()).executionContext.generation, turn.generation);
  f.finish(turn);
  assert.equal((await f.state()).executionContext, null);
});

test('a PID change during observation cannot publish the old active execution context', async t => {
  const f = fixture(t);
  f.begin();
  f.controls.beforeLifecycle = () => {
    f.context.taskCompletionIntents.turns.get('T').processId = '999';
    f.controls.lifecycle.processPid = 999;
  };
  const state = await f.state();
  assert.equal(state.known, false);
  assert.equal(state.executionContext, null);
  assert.equal(state.error, 'response_state_changed');
});

test('Claude result without actual parser snapshot never receives synthetic source verification', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', 'old')] });
  f.context._getAgentTurnResultForOrchestration = async () => ({ found: true, complete: true, assistantText: 'unproven',
    sourceSnapshot: { filePath: f.file, sessionId: 'S', size: fs.statSync(f.file).size } });
  const result = await f.read();
  assert.equal(result.pending, true);
  assert.equal(result.result.sourceVerified, false);
  assert.equal(result.code, 'response_source_unverified');
});

test('authoritative catalog absence is terminal even when process lookup is unknown or unavailable', async t => {
  const f = fixture(t);
  f.owner.exists = false;
  f.controls.beforeLifecycle = () => { throw new Error('absent catalog must not probe processes'); };
  const state = await f.state();
  assert.equal(state.known, true);
  assert.equal(state.exists, false);
  assert.equal(state.code, 'tab_not_found');
  const result = await f.read();
  assert.equal(result.code, 'tab_not_found');
  assert.equal(result.pending, undefined);
  assert.equal(result.result, undefined);
});

test('catalog close during a result read returns tab_not_found, not an eternal pending observation', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', 'old')] });
  const original = f.context._getAgentTurnResultForOrchestration;
  f.context._getAgentTurnResultForOrchestration = async request => {
    const result = await original(request);
    f.owner.exists = false;
    return result;
  };
  const result = await f.read();
  assert.equal(result.code, 'tab_not_found');
  assert.equal(result.pending, undefined);
  assert.equal(result.result, undefined);
});

test('catalog close during the initial process probe is authoritative absence, not runtime unknown', async t => {
  const f = fixture(t);
  f.controls.beforeLifecycle = () => { f.owner.exists = false; };
  const state = await f.state();
  assert.equal(state.known, true);
  assert.equal(state.exists, false);
  assert.equal(state.code, 'tab_not_found');
});

test('catalog close wins even when the in-flight process probe rejects', async t => {
  const f = fixture(t);
  f.controls.beforeLifecycle = () => { f.owner.exists = false; throw new Error('lookup failed after close'); };
  const state = await f.state();
  assert.equal(state.known, true);
  assert.equal(state.exists, false);
  assert.equal(state.code, 'tab_not_found');
});

test('Main subscription forwards exact admitted Claude completion directly to the private evidence callback', async t => {
  const f = fixture(t);
  const turn = f.begin();
  assert.equal(f.delivered.length, 0);
  f.finish(turn);
  assert.equal(f.delivered.length, 1, 'direct callback is synchronous');
  assert.equal(f.delivered[0].tabId, 'T');
  assert.equal(f.delivered[0].subject.providerPromptId, turn.providerPromptId);
  assert.equal(f.delivered[0].result.assistantText, 'new final');
  assert.equal(f.delivered[0].result.sourceVerified, true);
  assert.equal(f.delivered[0].backgroundWorkCount, 0);
});

test('Main exposes background count and revision independently from its own busy predicate', async t => {
  const f = fixture(t);
  const initial = await f.state();
  f.controls.background = 2;
  const withBackground = await f.state();
  assert.equal(withBackground.busy, false);
  assert.equal(withBackground.backgroundWorkCount, 2);
  assert.notEqual(withBackground.revision, initial.revision);
  assert.equal((await f.read()).code, 'response_background_work');
});

test('background work starting and finishing during a latest read invalidates the read through the existing revision', async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', 'old')] });
  const original = f.context._getAgentTurnResultForOrchestration;
  f.context._getAgentTurnResultForOrchestration = async request => {
    const result = await original(request);
    f.context.tabBackgroundWorkRevisionByTab.set('T', 2);
    return result;
  };
  const result = await f.read();
  assert.equal(result.pending, true);
  assert.equal(result.code, 'response_state_changed');
  assert.equal(result.subject, null);
});

test('latest Codex historical execution survives compact and internal notifications', async t => {
  const rows = codexTurn('A', 'before compact', null);
  rows.push({ type: 'compacted', payload: {} }, event('user_message', { message: '<subagent_notification>internal</subagent_notification>' }),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after compact' }] } },
    event('task_complete', { turn_id: 'A', last_agent_message: 'after compact' }));
  const f = fixture(t, { provider: 'codex', rows });
  const result = await f.read();
  assert.equal(result.result?.complete, true, JSON.stringify(result));
  assert.equal(result.result.sourceVerified, true);
  assert.equal(result.subject.kind, 'codex-historical-execution');
  assert.equal(result.subject.targetExecutionContext.turnId, 'A');
  assert.equal(result.subject.targetExecutionContext.generation, null);
  assert.equal(result.result.assistantText, 'before compact\n\nafter compact');
});

function latestGoalRows({ noUser = false, terminal = 'task_complete', body = 'LATEST' } = {}) {
  return [...codexTurn('A', 'OLD'), event('task_started', { turn_id: 'B' }),
    ...(noUser ? [] : [event('user_message', { message: '<codex_internal_context source="goal">continue</codex_internal_context>' })]),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: body }] } },
    ...(terminal ? [event(terminal, { turn_id: 'B', last_agent_message: body })] : [])];
}

for (const noUser of [false, true]) test('actual compact latest selects ' + (noUser ? 'no-user' : 'Goal') + ' execution B, never old regular user A', async t => {
  const rows = latestGoalRows({ noUser });
  const f = fixture(t, { provider: 'codex', rows });
  f.context._loadSessionTurns = () => { throw new Error('latest Codex must not materialize full History'); };
  f.context.codexDataModule._api.loadCodexProviderResult = () => { throw new Error('latest Codex must not use the prompt reader'); };
  const before = codexApi.getCodexJsonlCacheStats();
  const result = await f.read();
  assert.equal(result.result?.assistantText, 'LATEST', JSON.stringify(result));
  assert.equal(result.result.complete, true);
  assert.equal(result.result.sourceVerified, true);
  assert.equal(result.subject.kind, 'codex-historical-execution');
  assert.equal(result.subject.targetExecutionContext.turnId, 'B');
  assert.equal(result.subject.targetExecutionContext.generation, null);
  assert.deepEqual(result.subject.targetExecutionContext, result.result.executionContext);
  assert.equal(result.subject.promptUserUuid, undefined);
  assert.equal(result.result.userUuid, null);
  assert.deepEqual(codexApi.getCodexJsonlCacheStats(), before);

  f.write([...rows, ...codexTurn('C', 'NOT OURS')]);
  f.begin('C');
  f.context.codexDataModule._api.loadLatestCodexObservedExecution = () => { throw new Error('explicit historical read must not reselect latest'); };
  const exact = await f.read({ subject: result.subject });
  assert.equal(exact.result?.assistantText, 'LATEST', JSON.stringify(exact));
  assert.equal(exact.result.sourceVerified, true);
  assert.equal(exact.result.executionContext.turnId, 'B');
  assert.equal(exact.result.executionContext.generation, null);
});

for (const terminal of ['turn_aborted', null]) test('latest Goal ' + (terminal || 'incomplete') + ' is not replaced by prior success', async t => {
  const f = fixture(t, { provider: 'codex', rows: latestGoalRows({ terminal }) });
  const result = await f.read();
  assert.equal(result.subject?.targetExecutionContext.turnId, 'B', JSON.stringify(result));
  assert.equal(result.result.complete, false);
  assert.notEqual(result.result.assistantText, 'OLD');
  if (terminal) {
    assert.equal(result.result.sourceVerified, true);
    assert.equal(result.code, 'turn_aborted');
  } else assert.equal(result.pending, true);
});

test('adapter callbacks keep historical selection separate from runtime generation and prompt lookup', async t => {
  const f = fixture(t, { provider: 'codex', rows: latestGoalRows() });
  // Only the new private provider boundary is substituted in this wiring test.
  const historical = { provider: 'codex', sessionId: 'S', turnId: 'B', generation: null };
  const calls = [];
  const loaded = { success: true, complete: true, sourceVerified: true, executionContext: historical,
    assistantText: 'LATEST', assistantChars: 6, truncated: false, userUuid: null };
  f.context.codexDataModule._api.loadLatestCodexObservedExecution = async request => {
    assert.equal(typeof request.resolveSource, 'function');
    assert.equal(request.sessionId, 'S');
    assert.equal(request.resultReadMode, 'authoritative');
    assert.equal(request.maxChars, 500);
    calls.push('latest');
    return loaded;
  };
  f.context.codexDataModule._api.loadCodexHistoricalObservedExecution = async request => {
    assert.deepEqual(request.targetExecutionContext, historical);
    assert.equal(typeof request.resolveSource, 'function');
    calls.push('historical');
    return loaded;
  };
  f.context.codexDataModule._api.loadCodexObservedExecution = () => { throw new Error('historical read must not acquire a runtime generation'); };
  f.context._loadSessionTurns = () => { throw new Error('latest must not use History'); };
  const selected = await f.read({ maxChars: 500 });
  assert.equal(selected.result.assistantText, 'LATEST');
  assert.equal(selected.subject.kind, 'codex-historical-execution');
  assert.deepEqual(selected.subject.targetExecutionContext, historical);
  f.begin('C');
  assert.equal((await f.state()).currentSubject.kind, 'codex-execution');
  const exact = await f.read({ subject: selected.subject });
  assert.equal(exact.result.assistantText, 'LATEST');
  assert.deepEqual(calls, ['latest', 'historical']);
});

test('historical physical session remains distinct from the stable Main read view owner', async t => {
  const f = fixture(t, { provider: 'codex', rows: codexTurn('ancestor-turn', 'ancestor final') });
  const resolver = f.context.transcriptService.resolveCodexResultSource;
  f.context.transcriptService.resolveCodexResultSource = async request => {
    const source = await resolver(request);
    source.viewOwnerSessionId = 'S';
    source.segments[0].physicalSessionId = 'P';
    return source;
  };
  const latest = await f.read();
  assert.equal(latest.result?.assistantText, 'ancestor final', JSON.stringify(latest));
  assert.equal(latest.result.sourceVerified, true);
  assert.equal(latest.subject.sessionId, 'S');
  assert.equal(latest.subject.targetExecutionContext.sessionId, 'P');
  assert.equal(latest.subject.targetExecutionContext.generation, null);
  const exact = await f.read({ subject: latest.subject });
  assert.equal(exact.result.assistantText, 'ancestor final');
  assert.equal(exact.result.sourceVerified, true);
  assert.equal((await f.state()).sessionId, 'S');
});

for (const [method, code, explicit] of [
  ['loadLatestCodexObservedExecution', 'codex_latest_observed_execution_reader_unavailable', false],
  ['loadCodexHistoricalObservedExecution', 'codex_historical_observed_execution_reader_unavailable', true],
]) test('missing ' + method + ' is explicit and cannot fall back to prior user History', async t => {
  const f = fixture(t, { provider: 'codex', rows: latestGoalRows() });
  delete f.context.codexDataModule._api[method];
  f.context._loadSessionTurns = () => { throw new Error('forbidden generic fallback'); };
  const subject = explicit ? { kind: 'codex-historical-execution', toolType: 'codex', sessionId: 'S',
    targetExecutionContext: { provider: 'codex', sessionId: 'S', turnId: 'B', generation: null } } : null;
  const result = await f.read({ subject });
  assert.equal(result.code, code);
  assert.equal(result.result.found, false);
  assert.equal(result.result.sourceVerified, false);
});

test('optional historical callback absence and malformed historical identity never select latest', async () => {
  const reader = createAgentResponseObservationReader({
    captureState: () => ({ known: true, toolType: 'codex', sessionId: 'S', cwd: '/fixture', busy: false, revision: 1 }),
    readLifecycle: async () => ({ processStatus: 'found', processName: 'codex' }),
    loadSessionTurns() { throw new Error('forbidden History fallback'); },
  });
  const request = { tabId: 'T', expectedSessionId: 'S' };
  const context = { provider: 'codex', sessionId: 'S', turnId: 'B', generation: null };
  assert.equal((await reader.readAgentObservedResponse(request)).code, 'codex_latest_observed_execution_reader_unavailable');
  for (const kind of ['codex-execution', 'codex-historical-execution']) {
    for (const generation of [undefined, 0, kind === 'codex-execution' ? null : 1]) {
      const result = await reader.readAgentObservedResponse({ ...request,
        subject: { kind, toolType: 'codex', sessionId: 'S', targetExecutionContext: { ...context, generation } } });
      assert.equal(result.code, 'response_subject_unresolved');
    }
  }
  const result = await reader.readAgentObservedResponse({ ...request,
    subject: { kind: 'codex-historical-execution', toolType: 'codex', sessionId: 'S', targetExecutionContext: context } });
  assert.equal(result.code, 'codex_historical_observed_execution_reader_unavailable');
});

for (const subject of [
  {}, { kind: 'transcript', toolType: 'claude', sessionId: 'S', providerPromptId: 'not-a-uuid' },
  { kind: 'codex-execution', toolType: 'codex', sessionId: 'S', targetExecutionContext: { provider: 'codex', sessionId: 'S', turnId: 'T' } },
]) test('an unanchored explicit subject is an error, never SELECT-LATEST: ' + JSON.stringify(subject), async t => {
  const f = fixture(t, { rows: [cUser('U'), cAnswer('A', 'saved')] });
  const result = await f.read({ subject });
  assert.equal(result.code, 'response_subject_unresolved');
  assert.equal(result.result, undefined);
});

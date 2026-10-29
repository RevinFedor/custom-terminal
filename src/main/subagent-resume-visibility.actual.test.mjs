import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { isHistoryTaskChipLive } from '../renderer/utils/historyBackgroundLiveness.mjs';

const require = createRequire(import.meta.url);
const data = require('./ipc/codex-data');
const ownership = require('./codex-process-action-ownership');
const { createCodexChildCompletionWatch } = require('./codex-child-completion-watch');
const reader = require('./subagent-transcript');
const { codexSubagentAcceptedWorkStart } = require('./codex-subagent-cards');
const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declarations = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name?.text, n.getText(ast)]));
const names = ['getCombinedTabBackgroundWorkCount', 'getTabBackgroundWorkAgents',
  'getTabTerminalCodexSubagents', 'parseCodexLiveArgs', 'recordCodexLiveSubagentOwnership',
  'publishCodexSubagentActivity', 'trackCodexTabSubagentActivity'];
const source = names.map(n => { assert.ok(declarations.has(n), n); return declarations.get(n); }).join('\n');
const hp = fs.readFileSync(new URL('../renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const hpAst = ts.createSourceFile('HistoryPanel.tsx', hp, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function hpFunction(name) {
  let declaration;
  const visit = node => {
    if (ts.isVariableStatement(node)
      && node.declarationList.declarations.some(d => d.name.getText(hpAst) === name)) declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  };
  visit(hpAst);
  assert.ok(declaration, name);
  return ts.transpileModule(declaration.getText(hpAst), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const presentation = vm.createContext({ Map, Set, Number, String, Date, Array, Math,
  isLocalPromptEntry: () => false, isRawAction: a => a?.tool === '__raw__',
  isTaskAction: a => a?.tool === 'Task', isHistoryTaskChipLive,
  isHistoryBackgroundTaskLive: () => false,
  historyAgentKey: (a, uuid) => 'task:' + (a.toolUseId || uuid),
});
vm.runInContext(['historySubagentCallIdentity', 'collectHistoryBackgroundChips', 'collectHistoryAgentChips']
  .map(hpFunction).join('\n') + '\nglobalThis.collect = collectHistoryBackgroundChips; globalThis.roster = collectHistoryAgentChips;', presentation);

const TAB = 'own-resume-fixture';
const PARENT = '20bab0cc-5578-42e5-81f6-47c18f8183f2';
const A = '01a17b1a-cdc9-7d63-bae8-da627e71483e';
const B = '01a17ae1-67c6-73e2-8532-0d0815f408cc';
const GEN = 'own-runtime:2';
const START = '2026-10-28T01:22:04.216Z';
const row = (type, payload, offset = 100, timestamp = START) => ({ type, payload, timestamp, __byteOffset: offset });
const call = (id, name, args, offset = 100) => row('response_item', {
  type: 'function_call', call_id: id, name, namespace: 'multi_agent_v1', arguments: JSON.stringify(args),
}, offset);
const output = (id, value, is_error = false) => row('response_item', {
  type: 'function_call_output', call_id: id, output: typeof value === 'string' ? value : JSON.stringify(value), is_error,
}, 120);
function harness({ known = false, generation = GEN, boundary = 0 } = {}) {
  ownership.resetCodexProcessActionOwnershipForTests();
  const knownMap = new Map(known ? [[TAB, new Map([A, B].map((id, i) => ['spawn-' + i, {
    threadId: id, taskName: '/root/reviewer-' + i, sessionId: PARENT, generation: GEN,
    startedAt: Date.parse('2026-10-28T00:00:00Z'),
  }]))]] : []);
  const liveMap = new Map(known ? [[TAB, new Map(knownMap.get(TAB))]] : []);
  const logs = [], publications = [];
  const watches = new Map(), completions = new Map();
  let ctx;
  const watcher = createCodexChildCompletionWatch({
    findFile: ({ agentSessionId }) => agentSessionId, sessionsDir: () => 'own-fixture-directory',
    readCompletion: ({ filePath, notBefore }) => {
      const completedAt = completions.get(filePath) || 0;
      return { finished: completedAt >= notBefore, completedAt };
    },
    watchFile: (file, _options, callback) => {
      watches.set(file, callback); return { on() {}, close() { watches.delete(file); } };
    },
    isCurrent: (tabId, key, descriptor, startedAt, ownerGeneration) =>
      liveMap.get(tabId)?.get(key) === descriptor && descriptor.startedAt === startedAt
      && descriptor.generation === ownerGeneration && ownerGeneration === GEN,
    onComplete: (tabId, key, descriptor, proof) => {
      liveMap.get(tabId)?.delete(key); descriptor.completedAt = proof.completedAt;
      descriptor.terminalStatus = 'completed'; ctx.publishCodexSubagentActivity(tabId);
    },
  });
  ctx = vm.createContext({ Date, Map, Set, Number, String, Object, Array, JSON, require, path,
    srcMainDir: path.dirname(new URL('./main.js', import.meta.url).pathname),
    codexTabLiveSubagents: liveMap, codexTabKnownSubagents: knownMap, codexDataModule: data,
    ...ownership,
    console: { log: (...x) => logs.push(x.join(' ')), warn: (...x) => logs.push(x.join(' ')) },
    claudeBackgroundAgentActivity: { snapshot: () => ({ count: 0, agents: [], tasks: [] }) },
    getTerminalLifecycleGeneration: () => GEN,
    extractCodexLiveText: x => typeof x === 'string' ? x : '',
    findCodexAgentFile: () => null, isAgentFinishedByOwnTranscript: () => false,
    codexChildCompletionWatch: watcher,
    publishTabBackgroundWork: () => publications.push(ctx.getCombinedTabBackgroundWorkCount(TAB)),
  });
  vm.runInContext(source, ctx);
  const state = { tabId: TAB, sessionId: PARENT, processGeneration: generation, processGenerationBoundaryOffset: boundary };
  return { ctx, state, known: knownMap, live: liveMap, logs, publications,
    feed(r) { ctx.recordCodexLiveSubagentOwnership(state, r); ctx.trackCodexTabSubagentActivity(state, r); },
    count: () => ctx.getCombinedTabBackgroundWorkCount(TAB),
    agents: () => ctx.getTabBackgroundWorkAgents(TAB),
    finish(id, at) { completions.set(id, at); watches.get(id)?.(); },
    dispose: () => watcher.clear(TAB),
  };
}
function twoResumes(h) {
  // Same real 4196 shape: four native calls, four printed receipts. Message
  // is computed; it is deliberately NOT evaluated or treated as identity.
  h.feed(row('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'resume-both', input:
    `text(await tools.multi_agent_v1__resume_agent({id:"${A}"}));\n`
    + `text(await tools.multi_agent_v1__send_input({target:"${A}",message:"review "+stage}));\n`
    + `text(await tools.multi_agent_v1__resume_agent({id:"${B}"}));\n`
    + `text(await tools.multi_agent_v1__send_input({target:"${B}",message:"review "+stage}));` }));
  h.feed(row('response_item', { type: 'custom_tool_call_output', call_id: 'resume-both', output: [
    { type: 'input_text', text: 'Script completed\nWall time 0.4 seconds\nOutput:\n' },
    ...[{ status: 'pending_init' }, { submission_id: '01a18019-9bfc-74a2-86bf-a754534b119f' },
      { status: 'pending_init' }, { submission_id: '01a18019-9cdd-73b1-955c-00797012a31f' }]
      .map(x => ({ type: 'input_text', text: JSON.stringify(x) })),
  ] }, 200));
}
const chipArgs = (entries, agents, extra = {}) => [entries, false, extra.alive ?? true,
  extra.session ?? PARENT, extra.generation ?? GEN, 'codex',
  new Map(agents.map(a => [a.toolUseId, a])), new Map(), new Set()];

test('actual 4196 sequence: close both then accepted resume in one exec restores count2', () => {
  const h = harness({ known: true });
  for (const id of [A, B]) { h.feed(call('close-' + id, 'close_agent', { target: id })); h.feed(output('close-' + id, { previous_status: 'running' })); }
  assert.equal(h.count(), 0);
  twoResumes(h);
  assert.equal(h.count(), 2, 'successful native resume must restore both missing leases');
  assert.deepEqual(Array.from(h.agents(), a => a.agentSessionId).sort(), [A, B].sort());
  assert.equal(presentation.collect(...chipArgs([], h.agents())).length, 2, 'live Main-only children are visible without any History read');
});

test('actual Main: cold registry may learn only an exact accepted own current control', () => {
  const h = harness();
  h.feed(call('resume-A', 'resume_agent', { id: A }));
  assert.equal(h.count(), 0, 'call alone is not acceptance');
  h.feed(output('resume-A', { status: 'pending_init' }));
  assert.equal(h.count(), 1);
  assert.equal(h.agents()[0].generation, GEN);
  assert.equal(h.agents()[0].sessionId, PARENT);
  const key = h.agents()[0].toolUseId;
  h.feed(call('input-A', 'send_input', { target: A, message: 'next finite review' }, 300));
  h.feed(output('input-A', { submission_id: '01a18019-9bfc-74a2-86bf-a754534b119f' }));
  assert.equal(h.count(), 1, 'resume plus send_input is one child, never two chips');
  assert.equal(h.agents()[0].toolUseId, key, 'same lease key across continued work');
});

test('actual Main: accepted send_input restores a missing child without an unnecessary resume', () => {
  const h = harness();
  h.feed(call('input-A', 'send_input', { target: A, message: 'bounded review' }));
  h.feed(output('input-A', { submission_id: '01a18019-9bfc-74a2-86bf-a754534b119f' }));
  assert.equal(h.count(), 1);
});

test('actual Main: rejected, errored, incomplete, unknown and non-native controls do not invent work', () => {
  for (const [value, error] of [[{ status: 'not_found' }, false], ['', false],
    [{ status: 'pending_init' }, true], [{ status: { completed: 'already done' } }, false]]) {
    const h = harness(); h.feed(call('bad', 'resume_agent', { id: A })); h.feed(output('bad', value, error));
    assert.equal(h.count(), 0);
  }
  const h = harness();
  h.feed(call('mail', 'send_message', { target: A, message: 'mail' })); h.feed(output('mail', { status: 'pending_init' }));
  const foreign = call('foreign', 'resume_agent', { id: A }); foreign.payload.namespace = 'mcp__unrelated';
  h.feed(foreign); h.feed(output('foreign', { status: 'pending_init' }));
  assert.equal(h.count(), 0);
});

test('actual Main: previous process, copied prefix and missing source proof cannot acquire a resumed child', () => {
  for (const settings of [{ generation: 'old-runtime:1' }, { boundary: 500 }]) {
    const h = harness(settings); twoResumes(h); assert.equal(h.count(), 0);
  }
  const h = harness(); const c = call('no-offset', 'resume_agent', { id: A }); delete c.__byteOffset;
  h.feed(c); h.feed(output('no-offset', { status: 'pending_init' })); assert.equal(h.count(), 0);
});

test('actual chip collector: exact Main-only resumed children are visible, wrong owners are not', () => {
  const agents = [A, B].map((id, i) => ({ provider: 'codex', toolUseId: 'resume-' + i,
    agentSessionId: id, sessionId: PARENT, generation: GEN, startedAt: Date.parse(START) }));
  const chips = presentation.collect(...chipArgs([], agents));
  assert.equal(chips.length, 2);
  assert.deepEqual(Array.from(chips, c => c.agentSessionId).sort(), [A, B].sort());
  for (const extra of [{ alive: false }, { session: 'other-parent' }, { generation: 'old' }])
    assert.equal(presentation.collect(...chipArgs([], agents, extra)).length, 0);
  const rows = agents.map(a => ({ uuid: 'row-' + a.toolUseId, role: 'assistant', sessionId: PARENT,
    actions: [{ tool: 'Task', toolUseId: a.toolUseId, agentSessionId: a.agentSessionId,
      description: 'Existing reviewer', subagentStatus: 'running' }] }));
  assert.equal(presentation.collect(...chipArgs(rows, agents)).length, 2, 'hydration does not duplicate Main-only chips');
});

test('actual roster: Main-only completion keeps the same selected Inspector key and finite clock', () => {
  const h = harness(); twoResumes(h);
  assert.equal(h.count(), 2);
  const chips = presentation.collect(...chipArgs([], h.agents()));
  h.finish(A, Date.parse(START) - 1); assert.equal(h.count(), 2, 'old child completion is not this resumed work');
  h.finish(A, Date.parse(START) + 60000); assert.equal(h.count(), 1);
  h.finish(B, Date.parse(START) + 60000); assert.equal(h.count(), 0);
  const terminal = h.ctx.getTabTerminalCodexSubagents(TAB);
  const roster = presentation.roster([], [], new Map(terminal.map(a => [a.toolUseId, a])));
  assert.equal(roster.length, 2, 'completion cannot drop a selected Main-only child');
  assert.deepEqual(Array.from(roster, c => c.key).sort(), Array.from(chips, c => c.key).sort());
  assert.ok(roster.every(c => c.status === 'completed' && c.durationMs === 60000));
  h.dispose();
});

test('actual owner gate also admits exact active subagents while the full History read is deferred', () => {
  assert.ok(/mainBackgroundOwnerProven\s*=[\s\S]{0,180}exactActiveSubagents/.test(hp),
    'Main-only subagents must establish this exact History owner without waiting for a full read');
});

test('actual owner gate: terminal Main-only facts keep an open panel addressable after count0, never for another owner', () => {
  const c = vm.createContext({ Number, exactActiveBackgroundTasks: new Map(), exactActiveSubagents: new Map(),
    mainBackgroundWork: { tabId: TAB, terminalSubagents: [{ provider: 'codex', toolUseId: 'done-A',
      sessionId: PARENT, generation: GEN, completedAt: Date.parse(START) + 1000 }] },
    tabId: TAB, toolType: 'codex', sessionId: PARENT, agentProcessGeneration: GEN });
  const expression = hpFunction('mainBackgroundOwnerProven') + '\nmainBackgroundOwnerProven;';
  assert.equal(vm.runInContext(expression, c), true);
  c.mainBackgroundWork.tabId = 'foreign-tab';
  assert.equal(vm.runInContext(expression.replaceAll('mainBackgroundOwnerProven', 'foreignOwner'), c), false);
});

test('actual Main: late accepted control cannot reactivate a known child under a replacement process', () => {
  const h = harness({ known: true, generation: 'old-runtime:1' }); h.live.delete(TAB);
  h.feed(call('stale-known', 'resume_agent', { id: A }));
  h.feed(output('stale-known', { status: 'pending_init' }));
  assert.equal(h.count(), 0);
  h.dispose();
});

test('native receipt admission refuses conflicting aliases, quoted prose, missing UUID and completion-only replies', () => {
  const c = { toolName: 'resume_agent', namespace: 'multi_agent_v1', args: { id: A } };
  assert.equal(codexSubagentAcceptedWorkStart({ ...c, args: { id: A, target: B } }, { status: 'pending_init' }), null);
  assert.equal(codexSubagentAcceptedWorkStart({ ...c, args: { target: 'reviewer-name' } }, { status: 'pending_init' }), null);
  assert.equal(codexSubagentAcceptedWorkStart(c, 'quoted {"status":"pending_init"}'), null);
  assert.equal(codexSubagentAcceptedWorkStart(c, { status: { completed: 'not a new turn' } }), null);
  assert.equal(codexSubagentAcceptedWorkStart({ ...c, toolName: 'send_message' }, { status: 'pending_init' }), null);
  assert.equal(codexSubagentAcceptedWorkStart({ ...c, namespace: 'mcp__collaboration' }, { status: 'pending_init' }), null);
});

test('unmatched batch output cannot be guessed onto either resumed child', () => {
  const h = harness();
  h.feed(row('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'ambiguous', input:
    `text(await tools.multi_agent_v1__resume_agent({id:"${A}"})); text(await tools.multi_agent_v1__resume_agent({id:"${B}"}));` }));
  h.feed(row('response_item', { type: 'custom_tool_call_output', call_id: 'ambiguous',
    output: [{ type: 'input_text', text: '{"status":"pending_init"}' }] }, 200));
  assert.equal(h.count(), 0, 'one neighboring receipt cannot authorize two children');
  h.dispose();
});

test('Main-only chip opens its exact native-v1 child source for every supported role, never a neighboring body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-resume-visibility-'));
  const h = harness(); twoResumes(h);
  const chips = presentation.collect(...chipArgs([], h.agents()));
  try {
    for (const role of ['default', 'explorer', 'worker', 'luna_e2e']) {
      const chip = chips.find(x => x.agentSessionId === A), filePath = path.join(dir, role + '.jsonl');
      const records = [
        { type: 'session_meta', payload: { id: A, session_id: PARENT, parent_thread_id: PARENT,
          thread_source: 'subagent', multi_agent_version: 'v1',
          source: { subagent: { thread_spawn: { parent_thread_id: PARENT, agent_role: role } } } } },
        { type: 'turn_context', payload: { model: 'own-child-model', effort: 'high' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary',
          content: [{ type: 'output_text', text: 'OWN_A_' + role }] } },
      ];
      fs.writeFileSync(filePath, records.map(x => JSON.stringify(x) + '\n').join(''), { flag: 'wx' });
      const body = await reader.readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: chip.agentSessionId });
      assert.equal(body.success, true); assert.deepEqual(body.steps.map(x => x.text), ['OWN_A_' + role]);
      assert.equal(body.launchSettings.model, 'own-child-model'); assert.equal(body.launchSettings.sessionId, A);
      const wrong = await reader.readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: B });
      assert.equal(wrong.success, false); assert.deepEqual(wrong.steps, []);
    }
  } finally { h.dispose(); fs.rmSync(dir, { recursive: true }); }
});

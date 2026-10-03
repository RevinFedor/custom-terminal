'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectHistoryOnDemand, HistoryPayloadStash, sliceHistoryPayload,
  HISTORY_PAYLOAD_RENDER_CAP } = require('./history-payload-dehydrate');

test('on-demand hides complete action bodies but preserves prose, identity and grouping labels', () => {
  const stash = new HistoryPayloadStash();
  const source = [{ uuid: 'A', sourceIdentity: 'physical-A', role: 'assistant', content: 'answer'.repeat(10000),
    thinking: 'reason'.repeat(3000), actions: [{ tool: '__raw__', rawTool: { toolUseId: 'call', toolName: 'Edit',
      args: { file_path: '/tmp/real-file.md', old_string: 'OLD'.repeat(20000), new_string: 'NEW'.repeat(20000) },
      result: 'RESULT'.repeat(10000), diffHunks: [{ entries: [{ content: 'DIFF'.repeat(10000) }] }] } }] },
    { uuid: 'C', role: 'compact', content: 'Context compacted', compactSummary: 'SUMMARY'.repeat(30000) },
    { uuid: 'U', role: 'user', content: 'user'.repeat(10000) }];
  const before = JSON.stringify(source);
  const rows = projectHistoryOnDemand({ toolType: 'codex', sessionId: 'S', entries: source, stash });
  assert.equal(JSON.stringify(source), before, 'consumer policy never mutates the canonical graph');
  assert.equal(rows[0].content, source[0].content); assert.equal(rows[2].content, source[2].content);
  assert.equal(rows[0].sourceIdentity, 'physical-A'); assert.equal(rows[0].hasThinking, true);
  const action = rows[0].actions[0];
  assert.equal(action.rawTool.toolUseId, 'call');
  assert.match(JSON.stringify(rows[0].actionSummary), /real-file.md/);
  assert.ok(JSON.stringify(action).length < 5000);
  const full = stash.get('codex', 'S', action.actionRef.payloadId);
  assert.deepEqual(JSON.parse(full), source[0].actions[0]);
  assert.match(action.actionRef.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(stash.get('codex', 'S', rows[1].compactSummaryRef.payloadId), source[1].compactSummary);
  assert.ok(rows[1].compactSummary.length < 1024);
});

test('explicit payload pages are lossless beyond the old render cap, including unicode', () => {
  const text = '🧪'.repeat(HISTORY_PAYLOAD_RENDER_CAP / 2 + 17);
  let reconstructed = '', offset = 0;
  do {
    const page = sliceHistoryPayload(text, { offset, limit: HISTORY_PAYLOAD_RENDER_CAP - 1 });
    assert.equal(page.offset, offset); assert.equal(page.totalChars, text.length);
    assert.equal(page.payload.charCodeAt(page.payload.length - 1) >= 0xd800
      && page.payload.charCodeAt(page.payload.length - 1) <= 0xdbff, false);
    reconstructed += page.payload; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, text);
  assert.throws(() => sliceHistoryPayload(text, { offset: text.length + 1 }), /range/);
});

test('file/Bash/MCP/task grouping headers reuse canonical summaries without shipping hidden task prompts', () => {
  const { makeHistoryRowStub } = require('./history-entry-window');
  const actions = [
    { tool: '__raw__', rawTool: { toolName: 'Read', toolUseId: 'read'.repeat(200), args: { file_path: '/tmp/report.md' } } },
    { tool: '__raw__', rawTool: { toolName: 'Bash', toolUseId: 'bash', args: { command: 'git status' } } },
    { tool: '__raw__', rawTool: { toolName: 'mcp__terminal__get_history', toolUseId: 'mcp', args: { tabId: 'T' } } },
    { tool: 'Task', toolUseId: 'task', description: 'Review', taskPrompt: 'hidden '.repeat(10000),
      subagentStatus: 'running', agentId: 'agent', startedAt: '2026-10-03T00:00:00Z' },
  ];
  const entry = { uuid: 'row', role: 'assistant', content: '', actions, thinking: 'thought', thinkingSeconds: 7 };
  const summary = makeHistoryRowStub(entry).actionSummary;
  const [result] = projectHistoryOnDemand({ toolType: 'claude', sessionId: 'S', entries: [entry], stash: new HistoryPayloadStash() });
  for (let i = 0; i < summary.length; i++) {
    for (const [key, value] of Object.entries(summary[i])) if (value !== undefined && key !== 'taskPrompt') {
      assert.equal(result.actionSummary[i][key], value, key);
    }
  }
  assert.equal(result.hasThinking, true); assert.equal(result.thinkingSeconds, 7);
  assert.equal(result.actionSummary[3].taskPrompt, undefined);
  assert.deepEqual(result.actions.map(action => action.tool), actions.map(action => action.tool));
});

test('bounded previews never introduce an unpaired UTF-16 surrogate into native JSON', () => {
  const { dehydrateHistoryEntries } = require('./history-payload-dehydrate');
  const output = 'x'.repeat(2047) + '🧪'.repeat(10000);
  const rows = [{ uuid: 'unicode', thinking: 'x'.repeat(511) + '🧪tail', actions: [
    { tool: '__raw__', rawTool: { toolName: 'Bash', args: {}, toolUseId: 'C', result: output } },
  ] }];
  const stash = new HistoryPayloadStash();
  dehydrateHistoryEntries({ toolType: 'codex', sessionId: 'S', entries: rows, stash });
  const result = projectHistoryOnDemand({ toolType: 'codex', sessionId: 'S', entries: rows, stash });
  const valid = text => assert.equal(text, Buffer.from(text, 'utf8').toString('utf8'));
  valid(result[0].thinking); valid(rows[0].actions[0].rawTool.result);
  assert.equal(stash.get('codex', 'S', 'result:C'), output);
});

test('headers distinguish absent, null, empty, failed and background results without opening bodies', () => {
  const cases = [
    [{}, false, 'running'], [{ result: null }, false, 'running'], [{ result: '' }, true, 'done'],
    [{ result: 'ok' }, true, 'done'], [{ isError: true, result: '' }, true, 'error'],
    [{ isError: true }, false, 'error'],
    [{ result: '', backgroundStatus: 'running' }, true, 'running'],
    [{ result: '', backgroundStatus: 'completed' }, true, 'done'],
    [{ result: '', backgroundStatus: 'failed' }, true, 'error'],
    [{ awaitingApproval: true }, false, 'waiting'],
    [{ resultRef: { payloadId: 'result:C', totalChars: 40000 } }, true, 'done'],
    [{ resultRef: {} }, false, 'running'],
  ];
  for (const [facts, hasResult, status] of cases) {
    const [row] = projectHistoryOnDemand({ toolType: 'codex', sessionId: 'S', stash: new HistoryPayloadStash(),
      entries: [{ uuid: 'R', actions: [{ tool: '__raw__', rawTool: { toolName: 'Bash', toolUseId: 'C', args: {}, ...facts } }] }] });
    assert.equal(row.actions[0].hasResult, hasResult); assert.equal(row.actions[0].status, status);
    assert.equal(row.actionSummary[0].hasResult, hasResult); assert.equal(row.actionSummary[0].status, status);
    assert.equal(row.actions[0].rawTool.result, undefined);
  }
});

test('file headers carry exact canonical path, display path and real stats, never guessed zero', () => {
  const file = '/tmp/' + 'д'.repeat(600) + '/docs/deep/file.md';
  const actions = [
    { toolName: 'Edit', args: { file_path: file, old_string: 'A\nKEEP', new_string: 'B\nKEEP\nC' } },
    { toolName: 'Write', args: { file_path: file, content: 'A\nB' } },
    { toolName: 'Write', args: { file_path: file } },
    { toolName: 'Edit', args: { file_path: file, old_string: '', new_string: '' }, diffStatsKnown: false },
    { toolName: 'Edit', args: { file_path: file }, diffHunks: [{ entries: [{ tag: 'add', line: 'new' }, { tag: 'eq', line: 'same' }, { tag: 'del', line: 'old' }] }] },
    { toolName: 'Edit', args: { file_path: file, old_string: 'same', new_string: 'same' } },
    { toolName: 'Write', args: { file_path: file, content: '' } },
    { toolName: 'MultiEdit', args: { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'c\ne\nf' }] } },
  ].map((rawTool, index) => ({ tool: '__raw__', rawTool: { ...rawTool, toolUseId: 'C' + index, result: '' } }));
  const [row] = projectHistoryOnDemand({ toolType: 'codex', sessionId: 'S', stash: new HistoryPayloadStash(), entries: [{ uuid: 'R', actions }] });
  assert.deepEqual(row.actions.map(a => [a.fileChange.added, a.fileChange.removed]), [[2, 1], [2, 0], [null, null], [null, null], [1, 1], [0, 0], [0, 0], [3, 2]]);
  for (let i = 0; i < actions.length; i++) {
    assert.equal(row.actions[i].fileChange.filePath, file);
    assert.equal(row.actions[i].fileChange.displayPath, 'docs/deep/file.md');
    assert.deepEqual(row.actionSummary[i].fileChange, row.actions[i].fileChange);
    assert.equal(row.actions[i].rawTool.diffHunks, undefined);
  }
});

test('actual Codex call/result and subagent trackers retain status facts without body reads', () => {
  const { codexHistoryActionsForCall } = require('./ipc/codex-data')._api;
  const { createCodexSubagentTracker } = require('./codex-subagent-cards');
  const project = actions => projectHistoryOnDemand({ toolType: 'codex', sessionId: 'S', stash: new HistoryPayloadStash(),
    entries: [{ uuid: 'R', actions }] })[0].actions;
  const call = { toolName: 'exec_command', callId: 'cmd', args: { cmd: 'true' } };
  for (const [output, error, expected] of [[undefined, false, [false, 'running']], ['', false, [true, 'done']], ['', true, [true, 'error']]]) {
    const [header] = project(codexHistoryActionsForCall(call, output, error).actions);
    assert.deepEqual([header.hasResult, header.status], expected);
  }
  const tracker = createCodexSubagentTracker();
  const task = tracker.registerSpawn({ callId: 'spawn', toolName: 'spawn_agent', namespace: 'multi_agent_v1', args: { message: 'do work' } });
  assert.deepEqual(project([task]).map(a => [a.hasResult, a.status]), [[false, 'running']]);
  tracker.attachSpawnOutput('spawn', JSON.stringify({ agent_id: 'agent' }));
  assert.equal(project([task])[0].status, 'running');
  tracker.absorbControlOutput({ toolName: 'wait_agent', namespace: 'multi_agent_v1', args: { targets: ['agent'] } },
    JSON.stringify({ status: { agent: { completed: '' } }, timed_out: false }));
  assert.equal(task.subagentStatus, 'completed');
  assert.deepEqual(project([task]).map(a => [a.hasResult, a.status]), [[true, 'done']]);
  const rejected = tracker.registerSpawn({ callId: 'rejected', toolName: 'spawn_agent', namespace: 'multi_agent_v1', args: { message: 'work' } });
  tracker.attachSpawnOutput('rejected', 'spawn refused', true);
  assert.equal(project([rejected])[0].status, 'error');
  assert.equal(project([{ tool: 'Task', subagentStatus: 'interrupted' }])[0].status, 'interrupted');
});

test('actual patch projection distinguishes known diff hunks from deletes without contents and failed patch', () => {
  const { codexHistoryActionsForCall } = require('./ipc/codex-data')._api;
  const call = { toolName: 'exec', callId: 'patch', args: { input: 'const patch = makePatch(); await tools.apply_patch(patch);' },
    patchApplyEvents: [{ type: 'patch_apply_end', call_id: 'patch', success: true, changes: {
      '/tmp/old.md': { type: 'delete' },
      '/tmp/changed.md': { type: 'update', move_path: '/tmp/new.md', unified_diff: '@@ -1,2 +1,3 @@\n-OLD\n+NEW\n SAME\n+EXTRA\n' },
      '/tmp/added.md': { type: 'add', content: 'A\nB' },
    } }] };
  const actions = codexHistoryActionsForCall(call, '', false).actions;
  const [row] = projectHistoryOnDemand({ toolType: 'codex', sessionId: 'S', stash: new HistoryPayloadStash(), entries: [{ uuid: 'R', actions }] });
  assert.deepEqual(row.actions.map(a => [a.fileChange.filePath, a.fileChange.added, a.fileChange.removed]),
    [['/tmp/old.md', null, null], ['/tmp/new.md', 2, 1], ['/tmp/added.md', 2, 0]]);
  assert.equal(row.actions[1].fileChange.countsSource, 'hunks');
  const [failed] = projectHistoryOnDemand({ toolType: 'codex', sessionId: 'S', stash: new HistoryPayloadStash(), entries: [{ uuid: 'F',
    actions: [{ tool: '__raw__', rawTool: { toolName: 'Patch', family: 'edit', args: { summary: 'not applied' }, isError: true, result: '' } }],
  }] });
  assert.equal(failed.actions[0].status, 'error'); assert.equal(failed.actions[0].fileChange, undefined);
});

test('fallback counts match the existing renderer LCS for empty, repeated, trailing-newline and generated texts', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
  const { lineDiffStats } = require('../shared/history-action-header.cjs');
  const source = fs.readFileSync(path.join(__dirname, '../../packages/claude-blocks/src/helpers.ts'), 'utf8');
  const ast = ts.createSourceFile('helpers.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['lineDiff', 'countDiffStats'].includes(node.name?.text))
    .map(node => node.getText(ast).replace(/^export /, '')).join('\n');
  const scope = vm.createContext({});
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, scope);
  const texts = ['', 'a', 'a\n', '\n', 'a\nb\na', 'b\na\nb', 'same\nkeep\nold\ntail'];
  let seed = 17;
  for (let i = 0; i < 45; i++) {
    const lines = [];
    for (let j = 0; j < i % 13; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; lines.push(['a', 'b', '', 'c', '🧪'][seed % 5]); }
    texts.push(lines.join('\n'));
  }
  for (const old of texts) for (const next of texts) {
    const expected = scope.countDiffStats(scope.lineDiff(old, next));
    assert.deepEqual(lineDiffStats(old, next), { added: expected.added, removed: expected.removed });
  }
  const common = 'same\n'.repeat(50000);
  assert.deepEqual(lineDiffStats(common + 'old', common + 'new'), { added: 1, removed: 1 });
});

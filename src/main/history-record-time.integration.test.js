const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const ts = require('typescript');
const callAt = '2026-10-07T07:46:18.647Z';
const resultAt = '2026-10-07T07:46:23.699Z';

test('actual Claude durable parser and append→live reducer keep exact call/text/user record dates', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-record-time-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.claude/projects/-record-time'); fs.mkdirSync(dir, { recursive: true });
  const records = [
    { uuid: 'U', type: 'user', timestamp: '2026-10-07T07:43:15.599Z', message: { role: 'user', content: 'inspect' } },
    { uuid: 'A', parentUuid: 'U', type: 'assistant', timestamp: callAt, message: { id: 'model-A', role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'pwd' } }] } },
    { uuid: 'R', parentUuid: 'A', type: 'user', timestamp: resultAt, message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] } },
    { uuid: 'T', parentUuid: 'R', type: 'assistant', timestamp: '2026-10-07T07:47:01.000Z', message: { id: 'model-T', role: 'assistant', content: [{ type: 'text', text: 'text block' }] } },
  ].map(r => ({ ...r, sessionId: 'S', cwd: '/record-time' }));
  const filePath = path.join(dir, 'S.jsonl');
  const original = records.map(r => JSON.stringify(r)).join('\n') + '\n'; fs.writeFileSync(filePath, original);
  const load = Module._load, dataPath = require.resolve('./ipc/claude-data'); delete require.cache[dataPath];
  Module._load = function(name, parent, isMain) {
    if (name === 'electron') return { ipcMain: { handle() {} } };
    if (name === 'os' || name === 'node:os') return { ...os, homedir: () => root };
    return load.call(this, name, parent, isMain);
  };
  let data; try { data = require(dataPath); } finally { Module._load = load; }
  data.register({ projectManager: {}, formatToolAction: () => null });
  const result = await data._api.getFullHistory({ sessionId: 'S', cwd: '/record-time' });
  assert.equal(result.success, true, result.error);
  assert.equal(result.entries.find(e => e.uuid === 'A').actions[0].rawTool.recordTime.timestamp, callAt);
  assert.equal(result.entries.find(e => e.uuid === 'A').timestamp, callAt);
  assert.equal(result.entries.find(e => e.uuid === 'U').recordTime.timestamp, records[0].timestamp);
  assert.equal(result.entries.find(e => e.uuid === 'T').recordTime.timestamp, records[3].timestamp);
  const { SessionTranscriptService } = require('./session-transcript-service');
  const events = [];
  const service = new SessionTranscriptService({ getMainWindow: () => null, onLiveMessage: e => events.push(e) });
  await service._broadcastClaudeDelta({ filePath, size: Buffer.byteLength(original), offset: 0, sessionId: 'S', consumers: new Map([['consumer', { tabId: 'fixture' }]]) }, 0);
  const { reduceHistoryLiveProjection } = await import('../renderer/utils/historyLiveProjection.mjs');
  let live = [];
  for (const event of events) live = reduceHistoryLiveProjection(live, event, { includeUserText: true });
  assert.equal(live.find(e => e.uuid === 'A').actions[0].rawTool.recordTime.timestamp, callAt);
  assert.equal(live.find(e => e.uuid === 'T').recordTime.timestamp, records[3].timestamp);
  assert.equal(live.find(e => e.uuid === 'U').recordTime.timestamp, records[0].timestamp);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
});

test('actual Main Codex live call adapter supplies container scope from the call, not output/arrival', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const names = ['buildCodexLiveRawMessage', 'codexEventType', 'codexLiveProjectionState', 'parseCodexLiveArgs',
    'decodeCodexLiveToolActions', 'codexLiveUuid', 'codexLiveSourceIdentity'];
  const context = vm.createContext({ require, path, srcMainDir: __dirname, console: { log() {}, warn() {} }, codexDataModule: require('./ipc/codex-data'),
    codexKnownSessions: new Map(), getCodexProcessActionGeneration: () => null });
  for (const name of names) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name); vm.runInContext(node.getText(ast), context);
  }
  for (const name of ['exec', 'exec_command']) {
    const call = { type: 'response_item', timestamp: callAt, __line: 10, __byteOffset: 1000,
      payload: { type: 'function_call', name, call_id: 'call', arguments: JSON.stringify(name === 'exec'
        ? { code: 'const a = await tools.exec_command({cmd:"pwd"}); text(a);' } : { cmd: 'pwd' }) } };
    const message = context.buildCodexLiveRawMessage({ sessionId: 'S', tabId: 'fixture' }, call);
    assert.equal(message.message.content[0].recordTime.timestamp, callAt);
    assert.equal(message.message.content[0].recordTime.scope, name === 'exec' ? 'container' : 'record');
    const unknown = context.buildCodexLiveRawMessage({ sessionId: 'S', tabId: 'fixture' }, { ...call, timestamp: undefined });
    assert.equal(unknown.message.content[0].recordTime, undefined);
  }
});

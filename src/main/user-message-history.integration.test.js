'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { once } = require('node:events');
const { parse } = require('@babel/parser');
const { AgentSessionAvailabilityService } = require('./agent-session-availability');
const { extractClaudePromptCarrier, claudeInternalAgentContinuationKindFromEntry } = require('./claude-prompt-carriers');
const { historyReadError } = require('./history-session-resolution');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const functions = parse(source, { sourceType: 'unambiguous' }).program.body.filter(node => node.type === 'FunctionDeclaration');
const names = ['_historyReadBindings', '_resolveHistoryReadSession', '_loadSessionTurns', '_getUserMessageHistory',
  '_buildActiveBranch', '_extractTurnPromptText', '_groupIntoTurns', '_isNoisePrompt', 'handleOverseerRequest', 'handleOverseerMutation'];
const selected = names.map(name => {
  const fn = functions.find(node => node.id?.name === name);
  assert.ok(fn, name); return source.slice(fn.start, fn.end);
}).join('\n');
const SID = '11111111-1111-4111-8111-111111111111';
const MISSING = '22222222-2222-4222-8222-222222222222';
const FORK = '33333333-3333-4333-8333-333333333333';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-history-http-'));
  const claudeProjectsDir = path.join(root, 'claude'), codexHome = path.join(root, 'codex');
  fs.mkdirSync(path.join(claudeProjectsDir, 'moved-project'), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  const text = '<saved_prompt name="Product">Use product rules</saved_prompt>\nFirst task';
  const records = [
    { type: 'user', uuid: 'user-a', parentUuid: null, timestamp: '2026-08-01T10:00:00Z', message: { content: text } },
    { type: 'assistant', uuid: 'assistant-a', parentUuid: 'user-a', message: { content: [
      { type: 'text', text: 'NEVER RETURN ASSISTANT' }, { type: 'tool_use', name: 'Read', input: { value: 'NEVER RETURN TOOL' } }] } },
    { type: 'attachment', uuid: 'queued-b', parentUuid: 'assistant-a', timestamp: '2026-08-02T10:00:00Z',
      attachment: { type: 'queued_command', prompt: 'Second task while busy' } },
  ];
  const recordMap = new Map(records.map(row => [row.uuid, row]));
  fs.writeFileSync(path.join(claudeProjectsDir, 'moved-project', SID + '.jsonl'), records.map(row => JSON.stringify(row)).join('\n'));
  fs.writeFileSync(path.join(codexHome, 'sessions', FORK + '.jsonl'), '{}\n');
  const fork = { provider: 'codex', childSessionId: FORK, sourceSessionId: SID, forkMode: 'unknown', snapshotComplete: false, entryUuids: [] };
  const availability = new AgentSessionAvailabilityService({ claudeProjectsDir, codexHome });
  let codexReads = 0;
  const context = vm.createContext({ require, URL, Object, Map, Set, fs, path, srcMainDir: __dirname,
    console: { log() {}, warn() {} }, userMessageHistory: null,
    extractClaudePromptCarrier, claudeInternalAgentContinuationKindFromEntry,
    getAgentSessionAvailabilityService: () => availability,
    codexDataModule: { _api: { findCodexSessionFile: async () => null } },
    projectManager: { db: {
      db: { prepare: sql => ({ all: id => sql.includes('FROM tabs') ? [{ tab_id: 'tab-' + id, project_id: 'p', cwd: '/old-project',
        claude_session_id: id === FORK ? null : id, codex_session_id: id === FORK ? id : null }] : [] }) },
      getSessionHistoryContext: id => ({ fork: id === FORK ? fork : null }),
      getHistoryPromptPresentations: () => [], getHistoryPromptPresentationsForEntries: () => [],
    } },
    _getOverseerTurnsCache: () => null, _setOverseerTurnsCache() {}, _deleteOverseerTurnsCache() {},
    _loadSessionAnnotations: () => ({ notesByTurn: new Map(), rewindByTurn: new Map(), orphanNotes: [] }),
    loadJsonlRecords: async () => ({ recordMap, lastRecord: records.at(-1) }),
    _sessionProgressToolDetail: () => null,
    listSessionCatalogCandidates: async () => ({ candidates: [{ sessionId: SID, cwd: '/old-project', provider: 'claude', projectId: 'p' }], total: 1 }),
    _loadCodexSessionTurns: async () => { codexReads += 1; throw Object.assign(new Error('lineage_unresolved'), { status: 409, lineageReason: 'provider-history-base-absent' }); },
  });
  vm.runInContext(selected, context);
  const server = http.createServer(async (request, response) => {
    try {
      let out;
      if (request.method === 'GET') out = await context.handleOverseerRequest(request.url);
      else {
        let body = ''; for await (const chunk of request) body += chunk;
        out = await context.handleOverseerMutation(request.url, JSON.parse(body));
      }
      response.writeHead(out.status || 200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(out.body));
    } catch (error) { response.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(historyReadError(error))); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    return { status: response.status, body: await response.json() };
  };
  return { call, codexReads: () => codexReads, text };
}

test('actual main GET/POST routes use the same active branch and read queued user bodies', async t => {
  const f = await fixture(t);
  const caps = await f.call('/overseer/capabilities'); assert.equal(caps.body.userMessageHistory.version, 1);
  const search = await f.call('/overseer/user-messages?project=p&dateFrom=2026-08-02');
  assert.equal(search.status, 200);
  assert.equal(search.body.messages.length, 1);
  assert.equal(search.body.messages[0].userUuid, 'queued-b');
  const read = await f.call('/overseer/user-messages/read', { messages: search.body.messages.map(row => row.ref) });
  assert.equal(read.body.messages[0].text, 'Second task while busy');
  assert.doesNotMatch(JSON.stringify(read.body), /NEVER RETURN/);
  const prompt = await f.call('/overseer/user-messages?project=p&promptName=Product');
  assert.deepEqual(prompt.body.messages.map(row => row.turnIndex), [0]);
  const original = await f.call('/overseer/user-messages/read', { messages: prompt.body.messages.map(row => row.ref) });
  assert.equal(original.body.messages[0].text, f.text);
});

test('actual main failures expose saved provider and fork metadata without guessing a parent', async t => {
  const f = await fixture(t);
  const missing = await f.call(`/overseer/session/${MISSING}/stats`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'history_source_missing');
  assert.equal(missing.body.diagnostics.expectedProvider, 'claude');
  assert.equal(f.codexReads(), 0);
  const unresolved = await f.call(`/overseer/session/${FORK}/stats`);
  assert.equal(unresolved.status, 409);
  assert.equal(unresolved.body.lineageReason, 'provider-history-base-absent');
  assert.equal(unresolved.body.diagnostics.fork.boundaryRecorded, false);
  assert.equal(unresolved.body.diagnostics.parentSubstitution, false);
  const metadata = await f.call(`/overseer/session/${FORK}/diagnostics`);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.readability, 'not-verified');
  assert.equal(f.codexReads(), 1, 'diagnostics must not load the transcript');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { _api } = require('./ipc/codex-data');
const { createCodexResultReader } = require('./codex-result-reader');
const { createCodexResultSourceResolver } = require('./codex-result-source');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('async function _getAgentTurnResultForOrchestration(');
const end = source.indexOf('\nfunction sessionCatalogProjectMatches', start);
assert.ok(start >= 0 && end > start);
const functionSource = source.slice(start, end);

for (const mode of ['exact', 'exact-recovery', 'unbound-uuid', 'unbound-recovery', 'unbound-hash', 'unbound-legacy']) test('actual main Codex adapter avoids generic/raw/History readers: ' + mode, async t => {
  const recovery = mode.includes('recovery'), unbound = mode.startsWith('unbound'), legacy = mode.endsWith('legacy');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-result-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const rows = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T' } },
    { type: 'event_msg', timestamp: '2026-09-14T02:00:00Z', payload: { type: 'user_message', message: 'go' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'exact answer' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T', last_agent_message: 'exact answer' } },
  ];
  if (legacy) for (const row of rows) delete row.payload.turn_id;
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  const reader = createCodexResultReader({ readJsonlRange: _api.readJsonlRange,
    createTimelineProjector: _api.createCodexTimelineProjector,
    buildResult: _api.buildCodexProviderTurnAssistantResult, extractText: _api.extractTextContent,
    userIdentity: _api.getCodexUserRecordIdentity,
    isCompactPayload: _api.isCompactPayload, extractReasoning: _api.extractReasoning,
    findExecutionContext: _api.findCodexPromptExecutionContext,
    collectLegacy: _api.collectCodexTurnAssistantBlocks,
    log: { log() {} } });
  const resolver = createCodexResultSourceResolver({ codexApi: { findCodexSessionFile: async () => ({ filePath: file }) } });
  let sourceResolutions = 0;
  const read = vm.runInNewContext('(' + functionSource + ')', {
    _loadSessionTurns() { throw new Error('forbidden generic whole-history read'); },
    codexDataModule: { _api: {
      loadCodexProviderResult: request => reader.load(request),
      loadSessionRecords() { throw new Error('forbidden raw cache'); },
      buildCodexFullHistory() { throw new Error('forbidden History projection'); },
    } },
    transcriptService: { resolveCodexResultSource: args => {
      sourceResolutions++; return resolver.resolve({ ...args, lineage: { kind: 'physical' } });
    } },
    console: { log() {}, warn() {} },
  });
  const request = { sessionId: 'S', cwd: dir, forceFresh: true, toolType: 'codex',
    ...(unbound ? {} : { targetExecutionContext: { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 4 } }),
    ...(recovery ? { resultAfterAt: Date.parse('2026-09-14T01:59:59Z') }
      : mode === 'unbound-hash' ? { promptHash: require('./claude-prompt-carriers').promptFingerprint('go') }
        : { promptUserUuid: 'codex-user-S-1' }) };
  const result = await read(request);
  assert.equal(result.found, true, JSON.stringify(result)); assert.equal(result.complete, true);
  assert.equal(result.assistantText, 'exact answer'); assert.equal(result.userUuid, 'codex-user-S-1');
  if (legacy) assert.equal(result.executionContext, null);
  else assert.equal(result.executionContext.generation, unbound ? null : 4);
  assert.equal(result.turnIndex, 0);
  const before = reader.stats();
  await read(request);
  assert.equal(reader.stats().bytesRead, before.bytesRead);
  assert.equal(reader.stats().verificationBytes, before.verificationBytes);
  assert.equal(sourceResolutions, 4, 'source authority is checked before and after I/O, including a cached exact result');
});

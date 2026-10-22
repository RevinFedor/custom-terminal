const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const reader = require('./subagent-transcript');
const {createProviderSemanticShadow} = require('./provider-semantic-shadow');
const {codexProviderPreviewOwnerVerdict} = require('./codex-provider-preview');

// Actual Main reader/lease/cache/dehydration declarations; only Electron's
// transport and the locator are controlled. Files are synthetic and private.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('const subagentFilePathCache = new Map();');
const end = source.indexOf("ipcMain.handle('subagent:get-step-payload'", start);
assert.ok(start > 0 && end > start);
const slice = source.slice(start, end);
const meta = { type: 'session_meta', payload: { id: 'child-A', thread_source: 'subagent',
  parent_thread_id: 'parent', agent_path: '/root/A', multi_agent_version: 'v2' } };
const snapshot = tier => ({ type: 'event_msg', payload: { type: 'thread_settings_applied',
  thread_id: 'child-A', thread_settings: { service_tier: tier, model: 'gpt-6-luna' } } });
const newTask = { type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/A',
  content: 'Message Type: NEW_TASK\nTask name: /root/A\nSender: /root\nPayload:\nSynthetic task' } };
const context = { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'max' } };
const rows = tier => [meta, snapshot(tier), newTask, context,
  { type: 'response_item', payload: { type: 'function_call', name: 'Read', call_id: 'read-A', arguments: '{"path":"synthetic.txt"}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'read-A', output: 'Synthetic payload '.repeat(100) } }];
const serialize = records => records.map(row => JSON.stringify(row)).join('\n') + '\n';

function harness(filePath, overrides = {}) {
  const handlers = new Map(), events = new Map(), logs = [];
  let scans = 0, reads = 0;
  const scope = { fs, crypto,
    console: { log: value => logs.push(value), error: value => logs.push(value) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => events.set(name, handler) },
    findCodexAgentFile: () => filePath, findClaudeAgentFile: () => null,
    findCodexSubagentNewTaskBoundary: async args => { scans++; return reader.findCodexSubagentNewTaskBoundary(args); },
    createSubagentStepProjectionState: reader.createSubagentStepProjectionState,
    readAgentStepsAsync: async args => { reads++; return reader.readAgentStepsAsync(args); },
    codexDataModule: null,
    providerSemanticShadow: {getCodexSubagentServiceTier: () => null},
    HISTORY_PAYLOAD_PREVIEW_CHARS: 100, HISTORY_PAYLOAD_DEHYDRATE_THRESHOLD: 200,
    ...overrides,
  };
  vm.runInNewContext(slice + '\nglobalThis.caches = { subagentStepReaderCache, subagentPayloadSourceCache, subagentCodexBoundaryCache };', scope);
  return {
    read: (readerId, offset = 0, extra = {}) => handlers.get('subagent:read-steps')(null, { readerId,
      tabId: 'tab-A',
      chipKey: 'task:spawn-A', toolType: 'codex', parentSessionId: 'parent',
      agentSessionId: 'child-A', spawnedAt: 100, offset, ...extra }),
    release: readerId => events.get('subagent:release-reader')(null, { readerId }),
    counts: () => ({ scans, reads }), logs, caches: scope.caches,
  };
}

function threadResolverHarness() {
  const begin = source.indexOf('function resolveCodexLiveAgentThreadId(');
  const end = source.indexOf("ipcMain.handle('subagent:resolve-codex-thread'", begin);
  assert.ok(begin > 0 && end > begin);
  const live = new Map(), known = new Map();
  const scope = {codexTabLiveSubagents: live, codexTabKnownSubagents: known};
  const resolve = vm.runInNewContext(source.slice(begin, end) + '\nresolveCodexLiveAgentThreadId;', scope);
  return {live, known, resolve};
}

test('actual Main resolver never substitutes sole child B for an unknown or not-yet-bound requested call A', () => {
  const h = threadResolverHarness();
  const childB = {threadId: 'child-B'};
  h.live.set('tab-A', new Map([['call-B', childB]]));
  h.known.set('tab-A', new Map([['call-A', {threadId: ''}], ['call-B', childB]]));
  assert.equal(h.resolve('tab-A', 'unknown-call'), '');
  assert.equal(h.resolve('tab-A', 'call-A'), '');
  assert.equal(h.resolve('tab-A', 'call-A:canonical:0'), '');
  assert.equal(h.resolve('tab-A', 'call-B'), 'child-B');
  assert.equal(h.resolve('tab-A', 'call-B:canonical:0'), 'child-B');
  assert.equal(h.resolve('other-tab', 'call-B'), '');
  assert.equal(h.resolve('tab-A', ''), 'child-B', 'preserve no-card legacy lookup');
  h.known.get('tab-A').get('call-A').threadId = 'child-A';
  assert.equal(h.resolve('tab-A', 'call-A'), 'child-A', 'late exact identity remains usable');
  assert.equal(h.resolve('tab-A', 'call-A:canonical:0'), 'child-A');
  h.live.delete('tab-A');
  assert.equal(h.resolve('tab-A', 'call-A'), 'child-A', 'known completed child can reopen');
  assert.equal(h.resolve('tab-A', ''), '', 'no-card fallback is live-only');
});

test('actual Main pending read distinguishes missing child identity from missing transcript and logs no prompt/path', async () => {
  const main = harness(null);
  const unknown = {agentSessionId: '', agentId: '', taskText: 'PRIVATE TASK BODY', cwd: '/private/secret-cwd'};
  const first = await main.read('reader-unresolved', 0, unknown);
  assert.equal(first.success, true);
  assert.equal(first.pending, true);
  assert.equal(first.reason, 'child-thread-unresolved');
  assert.equal(first.offset, 0);
  await main.read('reader-unresolved', 0, unknown);
  assert.equal(main.logs.length, 1, 'same phase does not log each tail tick');
  const withId = await main.read('reader-unresolved');
  assert.equal(withId.reason, 'transcript-not-found');
  assert.equal(main.logs.length, 2, 'new phase has its own explanation');
  assert.equal(main.counts().reads, 0);
  assert.equal(main.counts().scans, 0);
  for (const value of main.logs) {
    assert.ok(!value.includes('PRIVATE TASK BODY'));
    assert.ok(!value.includes('/private/secret-cwd'));
  }
  const trace = JSON.parse(main.logs[0].slice('[SubagentSteps] pending '.length));
  assert.equal(trace.readerId, 'reader-unresolved');
  assert.equal(trace.tabId, 'tab-A');
  assert.equal(trace.chipKey, 'task:spawn-A');
  assert.equal(trace.parentSessionId, 'parent');
  assert.equal(trace.childSessionId, '');
  main.release('reader-unresolved');
});

test('actual Main root and NEW_TASK waits have distinct reasons without advancing or bypassing their guards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-inspector-pending-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    fs.writeFileSync(filePath, serialize(rows('priority')));
    for (const [boundary, reason] of [
      [{rootMetaSeen: false}, 'root-meta-pending'],
      [{rootMetaSeen: true, requiresBoundary: true, found: false}, 'new-task-boundary-pending'],
    ]) {
      const main = harness(filePath, {findCodexSubagentNewTaskBoundary: async () => boundary});
      const first = await main.read('reader-pending');
      assert.equal(first.success, true);
      assert.equal(first.pending, true);
      assert.equal(first.reason, reason);
      assert.equal(first.offset, 0);
      assert.equal(first.size, fs.statSync(filePath).size);
      assert.equal(first.launchSettings, undefined);
      assert.equal(first.requestServiceTier, undefined);
      assert.equal(main.counts().reads, 0, 'no child rows before required identity boundary');
      await main.read('reader-pending');
      assert.equal(main.logs.length, 1);
      main.release('reader-pending');
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

function tierAuthority() {
  const terminal = {};
  const owner = {sourceId: 'source-A', terminalToken: terminal, runSeq: 2,
    lifecycleGeneration: 'generation-A', launchId: 'launch-A'};
  const current = {...owner};
  const writer = {sessionId: 'parent', terminalToken: terminal, runSeq: 2, lifecycleGeneration: 'generation-A'};
  const scope = {codexProviderSemanticSources: new Map([['tab-A', owner]]),
    currentCodexProviderSemanticOwnerContext: () => current,
    getCodexWriterProofSnapshot: () => writer,
    codexProviderPreviewOwnerVerdict};
  const begin = source.indexOf('function authorizeCodexSubagentTierRequest(');
  const end = source.indexOf('const providerSemanticShadow = ', begin);
  assert.ok(begin > 0 && end > begin);
  const authorize = vm.runInNewContext(source.slice(begin, end) + '\nauthorizeCodexSubagentTierRequest;', scope);
  return {authorize, current, owner, writer};
}

test('actual Main authorizes tier capture only for the current source/terminal/run/lifecycle and proven parent', () => {
  const exact = {tabId: 'tab-A', sourceId: 'source-A'};
  assert.equal(tierAuthority().authorize(exact).allowed, true);
  assert.equal(tierAuthority().authorize({...exact, sourceId: 'stale-source'}).allowed, false);
  for (const [target, field, changed] of [
    ['current', 'terminalToken', {}], ['current', 'runSeq', 3],
    ['current', 'lifecycleGeneration', 'generation-B'], ['current', 'launchId', 'launch-B'],
    ['writer', 'terminalToken', {}], ['writer', 'runSeq', 3],
    ['writer', 'lifecycleGeneration', 'generation-B'], ['writer', 'sessionId', null],
  ]) {
    const h = tierAuthority(); h[target][field] = changed;
    assert.equal(h.authorize(exact).allowed, false, target + '.' + field);
  }
});

test('actual provider observer → Main reader returns child request Fast without a JSONL launch snapshot or a new reader', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tier-request-main-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    fs.writeFileSync(filePath, serialize([meta, newTask, context]));
    const {authorize} = tierAuthority();
    const shadow = createProviderSemanticShadow({log: {log() {}}, authorizeCodexSubagentRequest: authorize});
    const connection = shadow.createCodexConnection({tabId: 'tab-A', sourceId: 'source-A'});
    const request = tier => ({type: 'response.create', service_tier: tier,
      client_metadata: {'x-codex-turn-metadata': JSON.stringify({session_id: 'parent',
        thread_id: 'child-A', turn_id: 'turn-A'}), 'x-openai-subagent': 'worker'}});
    connection.observeClientFrame(JSON.stringify(request('priority')));
    const main = harness(filePath, {providerSemanticShadow: shadow});
    const first = await main.read('reader-A');
    assert.equal(first.launchServiceTier, null, 'no invented initial snapshot');
    assert.equal(first.requestServiceTier.serviceTier, 'priority');
    assert.equal(first.requestServiceTier.parentSessionId, 'parent');
    assert.equal(first.requestServiceTier.sessionId, 'child-A');
    assert.ok(main.logs.some(line => line.includes('requestTier=priority')));
    const counts = main.counts();
    connection.observeClientFrame(JSON.stringify(request('default')));
    const next = await main.read('reader-A', first.offset);
    assert.equal(next.requestServiceTier.serviceTier, 'default');
    assert.equal(next.launchServiceTier, null);
    assert.equal(main.counts().scans, counts.scans, 'reuse existing prefix scan');
    assert.equal(next.offset, first.offset);
    const otherParent = await main.read('reader-A', next.offset, {parentSessionId: 'other-parent'});
    assert.equal(otherParent.requestServiceTier, null);
    const otherTab = await main.read('reader-A', next.offset, {tabId: 'other-tab'});
    assert.equal(otherTab.requestServiceTier, null);
    main.release('reader-A');
    const reopened = await main.read('reader-B');
    assert.equal(reopened.requestServiceTier.serviceTier, 'default');
    main.release('reader-B');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('actual Main IPC carries skipped launch tier through EOF/warm reopen without extra scans or payload changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tier-main-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    fs.writeFileSync(filePath, serialize(rows('priority')));
    const main = harness(filePath);
    const first = await main.read('reader-A');
    assert.equal(first.success, true);
    assert.equal(first.launchServiceTier.serviceTier, 'priority');
    assert.equal(first.launchSettings.model, 'gpt-6-luna');
    assert.equal(first.launchSettings.effort, 'max');
    const result = first.steps.find(step => step.resultRef);
    assert.ok(result?.resultRef.payloadId);
    const payloadId = result.resultRef.payloadId;
    assert.equal(main.caches.subagentPayloadSourceCache.size, 1);
    const eof = await main.read('reader-A', first.offset);
    assert.deepEqual(eof.steps, []);
    assert.equal(eof.launchServiceTier.serviceTier, 'priority');
    assert.equal(eof.offset, first.offset);
    main.release('reader-A');
    const reopened = await main.read('reader-B');
    assert.equal(reopened.launchServiceTier.serviceTier, 'priority');
    assert.equal(reopened.steps.find(step => step.resultRef).resultRef.payloadId, payloadId);
    assert.equal(main.counts().scans, 1, 'one existing prefix scan, not an extra settings reader');
    fs.appendFileSync(filePath, serialize([snapshot('default')]));
    main.release('reader-B');
    const appended = await main.read('reader-C');
    assert.equal(appended.launchServiceTier.serviceTier, 'priority');
    assert.equal(main.counts().scans, 1, 'ordinary append preserves the prefix cache');
    assert.ok(main.logs.every(line => !line.includes('Synthetic payload')));
    assert.ok(main.logs.some(line => line.includes('tier=priority')));
    main.release('reader-C');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing Main log explains unknown tier once per actual scalar change, without bodies or extra readers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tier-main-diagnostic-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    const noField = snapshot(null); delete noField.payload.thread_settings.service_tier;
    for (const [settingsRows, reason, proof] of [
      [[], 'initial-snapshot-not-observed', 'none'],
      [[snapshot(null)], 'tier-null', 'own-thread-settings'],
      [[noField], 'tier-field-absent', 'own-thread-settings'],
      [[snapshot('UNRETAINED_SECRET_VALUE')], 'tier-unsupported-string', 'own-thread-settings'],
    ]) {
      fs.writeFileSync(filePath, serialize([meta, ...settingsRows, newTask, context]));
      const main = harness(filePath);
      const first = await main.read('reader-A');
      const lines = main.logs.filter(line => line.includes('[SubagentLaunchSettings]'));
      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes('tierReason=' + reason), lines[0]);
      assert.ok(lines[0].includes('tierProof=' + proof), lines[0]);
      const readCount = main.counts();
      await main.read('reader-A', first.offset);
      assert.equal(main.logs.filter(line => line.includes('[SubagentLaunchSettings]')).length, 1, 'unchanged EOF is quiet');
      assert.equal(main.counts().scans, readCount.scans);
      assert.ok(main.logs.every(line => !line.includes('UNRETAINED_SECRET_VALUE') && !line.includes('Synthetic task')));
      main.release('reader-A');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('actual Main drops cached launch tier/skip offset after same-size rewrite, replacement and truncation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tier-main-reset-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    fs.writeFileSync(filePath, serialize(rows('priority')));
    const main = harness(filePath);
    assert.equal((await main.read('reader-A')).launchServiceTier.serviceTier, 'priority');
    main.release('reader-A');
    const oldSize = fs.statSync(filePath).size;
    fs.writeFileSync(filePath, serialize(rows('default ')));
    assert.equal(fs.statSync(filePath).size, oldSize);
    const changed = new Date(Date.now() + 2000); fs.utimesSync(filePath, changed, changed);
    assert.equal((await main.read('reader-B')).launchServiceTier.serviceTier, 'default');
    main.release('reader-B');
    const replacement = path.join(dir, 'replacement.jsonl');
    fs.writeFileSync(replacement, serialize(rows('priority')));
    fs.renameSync(replacement, filePath);
    assert.equal((await main.read('reader-C')).launchServiceTier.serviceTier, 'priority');
    main.release('reader-C');
    fs.writeFileSync(filePath, serialize([meta, newTask, context]));
    const truncated = await main.read('reader-D');
    assert.equal(truncated.launchServiceTier, null);
    assert.equal(truncated.launchSettings.model, 'gpt-6-luna');
    assert.equal(main.counts().scans, 4);
    main.release('reader-D');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('release during the actual Main boundary await cannot publish late launch metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tier-main-release-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    fs.writeFileSync(filePath, serialize(rows('priority')));
    let resolveBoundary;
    const main = harness(filePath, { findCodexSubagentNewTaskBoundary: () => new Promise(resolve => { resolveBoundary = resolve; }) });
    const pending = main.read('reader-A');
    assert.equal(typeof resolveBoundary, 'function');
    main.release('reader-A');
    resolveBoundary(await reader.findCodexSubagentNewTaskBoundary({ filePath, expectedSessionId: 'child-A' }));
    const late = await pending;
    assert.equal(late.success, false);
    assert.equal(late.error, 'subagent reader released');
    assert.equal(late.launchServiceTier, undefined);
    assert.equal(main.caches.subagentStepReaderCache.size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an already open Main reader resets launch metadata when its file is replaced with a larger source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-tier-main-open-replace-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    fs.writeFileSync(filePath, serialize(rows('priority')));
    const main = harness(filePath);
    const first = await main.read('reader-A');
    assert.equal(first.launchServiceTier.serviceTier, 'priority');
    const replacement = path.join(dir, 'replacement.jsonl');
    fs.writeFileSync(replacement, serialize([...rows('default'), snapshot('priority')]));
    assert.ok(fs.statSync(replacement).size > first.size);
    fs.renameSync(replacement, filePath);
    const replaced = await main.read('reader-A', first.offset);
    assert.equal(replaced.reset, true);
    assert.equal(replaced.launchServiceTier.serviceTier, 'default');
    assert.equal(replaced.launchSettings.model, 'gpt-6-luna');
    main.release('reader-A');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

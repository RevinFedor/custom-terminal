'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const settings = require('./claude-confirmed-settings');
const { scanClaudeStartupSlashRecords } = require('./claude-startup-slash-proof');
const { loadJsonlRecords, _api: jsonlApi } = require('./ipc/claude-data');

const sessionId = 'f00cf3cc-0957-480e-85ba-143708ac6bd3';
const tabId = '__noted_inbox__-tab-18';
// The exact carrier, UUID pairing and timestamps from the isolated E3 run.
// Idle medium used user.message.content; busy-time high used system.content.
const medium = {
  uuid: 'dad2b44d-60bc-48da-b6f6-fa24e3b8ef0a', parentUuid: null,
  type: 'user', sessionId, timestamp: '2026-09-05T14:13:02.832Z',
  message: { content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>medium</command-args>' },
};
const mediumOut = {
  uuid: 'dccc7cca-d93d-4dcf-b99e-af2ade238a37', parentUuid: medium.uuid,
  type: 'user', sessionId, timestamp: medium.timestamp,
  message: { content: '<local-command-stdout>Set effort level to medium (saved as your default for new sessions): Balanced approach with standard implementation and testing</local-command-stdout>' },
};
const user = {
  uuid: '900418c2-a32b-4ca4-ad29-27b4a72a0d32', parentUuid: mediumOut.uuid,
  type: 'user', sessionId, timestamp: '2026-09-05T14:16:53.412Z',
  message: { content: 'E2E_FINAL_SETTINGS_A_20260905' },
};
const high = {
  uuid: '32b8ea02-a29c-4568-8314-69b2748f69fb', parentUuid: user.uuid,
  type: 'system', subtype: 'local_command', sessionId,
  timestamp: '2026-09-05T14:16:54.223Z',
  content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
};
const highOut = {
  uuid: '17c1b61c-1f6a-409c-8599-78761abfd89d', parentUuid: high.uuid,
  type: 'system', subtype: 'local_command', sessionId, timestamp: high.timestamp,
  content: '<local-command-stdout>Set effort level to high (saved as your default for new sessions): Comprehensive implementation with extensive testing and documentation</local-command-stdout>',
};
const answer = {
  uuid: 'ordinary-answer', parentUuid: user.uuid, type: 'assistant', sessionId,
  timestamp: '2026-09-05T14:16:55.900Z', message: { content: 'E2E_FINAL_SETTINGS_A_OK' },
};
const scope = {
  generation: 'claude-launch-1', processAlive: true, sessionId,
  startedAt: Date.parse('2026-09-05T14:11:55.000Z'),
};
const lines = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

test('E3 busy system carrier agrees with exact slash proof without moving the conversation branch', () => {
  const records = [medium, mediumOut, user, high, highOut, answer];
  const exact = scanClaudeStartupSlashRecords(records, '/effort high', {
    sessionId, afterMs: Date.parse('2026-09-05T14:16:53.681Z'),
  });
  assert.equal(exact.success, true);
  const { activeBranch } = settings.traceClaudeActiveBranch({
    recordMap: new Map(records.map(record => [record.uuid, record])), lastRecord: answer,
  });
  assert.equal(settings.deriveConfirmedClaudeSettings(activeBranch).effort.value, 'medium',
    'the assistant remains on its real conversational branch');
  const current = settings.deriveLatestConfirmedClaudeRuntimeEffort(records, { sessionId });
  assert.equal(current.value, 'high');
  assert.equal(current.wrapperUuid, exact.wrapperUuid);
  assert.equal(current.stdoutUuid, exact.stdoutUuid);
  assert.equal(settings.projectConfirmedClaudeSettingsForRuntime({
    effort: current.value, effortProofAt: current.proofAt,
    effortProofSessionId: current.proofSessionId,
  }, scope).effort, 'high');
});

test('system carrier still requires exact parent, matching value and the current runtime session', () => {
  for (const invalid of [
    { ...highOut, parentUuid: 'unrelated-wrapper' },
    { ...highOut, content: '<local-command-stdout>Set effort level to low</local-command-stdout>' },
    { ...highOut, sessionId: 'other-session' },
  ]) {
    const result = settings.deriveLatestConfirmedClaudeRuntimeEffort(
      [medium, mediumOut, user, high, invalid, answer], { sessionId });
    assert.equal(result.value, 'medium');
  }
  const current = settings.deriveLatestConfirmedClaudeRuntimeEffort([high, highOut], { sessionId });
  assert.equal(settings.projectConfirmedClaudeSettingsForRuntime({
    effort: current.value, effortProofAt: current.proofAt,
    effortProofSessionId: current.proofSessionId,
  }, { ...scope, generation: 'new-launch', startedAt: current.proofAt + 1 }).effort, null);
});

test('system model carriers still use the active branch, not the latest abandoned setting', () => {
  const model = { ...high, uuid: 'model', parentUuid: null,
    content: '<command-name>/model</command-name><command-args>haiku</command-args>' };
  const modelOut = { ...highOut, uuid: 'model-out', parentUuid: model.uuid,
    content: '<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>' };
  const abandoned = { ...model, uuid: 'abandoned-model', parentUuid: modelOut.uuid,
    content: '<command-name>/model</command-name><command-args>sonnet</command-args>' };
  const abandonedOut = { ...modelOut, uuid: 'abandoned-out', parentUuid: abandoned.uuid,
    content: '<local-command-stdout>Set model to Sonnet 5</local-command-stdout>' };
  const live = { ...answer, parentUuid: modelOut.uuid };
  const records = [model, modelOut, abandoned, abandonedOut, live];
  const { activeBranch } = settings.traceClaudeActiveBranch({
    recordMap: new Map(records.map(record => [record.uuid, record])), lastRecord: live,
  });
  assert.equal(settings.deriveConfirmedClaudeSettings(activeBranch).model.value, 'haiku');
});

test('actual JSONL loader → confirmed-settings API/cache → ControlBar refresh reads high after append', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-setting-carrier-'));
  const filePath = path.join(directory, sessionId + '.jsonl');
  t.after(() => {
    jsonlApi.resetJsonlCacheForTests();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(filePath, lines([medium, mediumOut, user]));
  const source = fs.readFileSync(path.join(__dirname, 'ipc/claude-data.js'), 'utf8');
  const start = source.indexOf('  const confirmedSettingsCache = new Map();');
  const end = source.indexOf('\n  // Shared revision plumbing', start);
  assert.ok(start > 0 && end > start);
  let registered;
  let runtimeScope = scope;
  const api = vm.createContext({
    ...settings, fs, console: { log() {}, warn() {} }, _api: {},
    _getClaudeRuntimeSettingsScope: () => runtimeScope,
    projectManager: { db: { db: { prepare: () => ({ get: () => ({ claude_session_id: sessionId, cwd: directory }) }) } } },
    findSessionFile: () => ({ filePath, projectDir: directory }),
    resolveLatestSessionInChain: () => sessionId,
    resolveSessionChain: async () => {
      const loaded = await loadJsonlRecords(filePath);
      return { mergedMap: loaded.recordMap, lastRecord: loaded.lastRecord,
        sessionBoundaries: [], historySources: [loaded.sourceSnapshot] };
    },
    ipcMain: { handle: (channel, handler) => {
      assert.equal(channel, 'claude:get-confirmed-settings'); registered = handler;
    } },
  });
  vm.runInContext(source.slice(start, end), api);
  const state = {};
  const bar = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/ClaudeControlBar.tsx'), 'utf8');
  const refreshStart = bar.indexOf('  const refreshClaudeConfirmedSettings = useCallback(');
  const refreshEnd = bar.indexOf('\n  const refreshClaudeMaterialization = useCallback(', refreshStart);
  assert.ok(refreshStart > 0 && refreshEnd > refreshStart);
  const renderer = vm.createContext({
    tabId, claudeSessionId: sessionId, launchCwd: directory, isClaudePtySession: true,
    useCallback: callback => callback,
    claudeSettingsRequestRef: { current: 0 },
    setClaudeModel: value => { state.model = value; },
    setEffortLocal: value => { state.effort = value; },
    setConfirmedSettingsOwnerSessionId: value => { state.sessionId = value; },
    setConfirmingSettings: value => { state.confirming = value; },
    rememberConfirmedSettingsSeed() {}, console: { warn() {} },
    ipcRenderer: { invoke: (channel, request) => {
      assert.equal(channel, 'claude:get-confirmed-settings');
      return registered({}, request);
    } },
  });
  vm.runInContext(ts.transpileModule(bar.slice(refreshStart, refreshEnd)
    + '\nglobalThis.refresh = refreshClaudeConfirmedSettings;', { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText, renderer);
  assert.equal((await renderer.refresh('before-high')).effort, 'medium');
  assert.equal((await renderer.refresh('warm-before-high')).cache, 'hit');
  fs.appendFileSync(filePath, lines([high, highOut, answer]));
  const changed = await renderer.refresh('local-effort-change');
  assert.equal(changed.cache, undefined, 'append invalidates the witness');
  assert.equal(changed.effort, 'high');
  assert.equal(changed.effortProofAt, Date.parse(highOut.timestamp));
  assert.equal(state.effort, 'high');
  assert.equal(state.sessionId, sessionId);
  const warm = await renderer.refresh('fs.watch');
  assert.equal(warm.cache, 'hit');
  assert.equal(state.effort, 'high', 'later refresh cannot resurrect the older medium');
  runtimeScope = { ...scope, generation: 'new-launch', startedAt: Date.parse(high.timestamp) + 1 };
  assert.equal((await renderer.refresh('process-state-change')).effort, null);
  assert.equal(state.effort, undefined, 'cached historical high is not current after Resume');
});

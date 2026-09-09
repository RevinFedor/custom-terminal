'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const vm = require('node:vm');
const promptAudit = require('./claude-prompt-audit');
const { describeClaudeMultitextPromptCarrier } = require('./claude-prompt-carriers');
const { promptAuditFingerprint: hash } = require('./prompt-audit-fingerprint');
const { createTerminalIncidentReporter, terminalSendIncidentNotification } = require('./terminal-incident-reporting');
const writer = require('./terminal-history-preview-diagnostic');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
function section(first, next) {
  const start = main.indexOf(first);
  const end = main.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, `actual main section: ${first}`);
  return main.slice(start, end);
}
const observerSource = section('const claudePromptShapeObserver =', 'function finishClaudePasteAudit(');
const confirmSource = section('function confirmClaudePasteAuditFromTranscriptSelection(', 'async function inspectClaudePostEnterTimeoutAtWriteBoundary(');
const hookSelectionSource = section('                    const selection = selectClaudePendingPromptAudit(alive, candidates, {', '                    if (!selection) break;');
const captureSource = section('async function captureClaudePromptShapeDiagnostic(', 'const {\n  createTerminalIncidentReporter,');
const reporterSource = section('const reportTerminalIncident = createTerminalIncidentReporter({', 'function reportTerminalSendDiagnostic(');

const firstText = 'PRIVATE-FIRST-TEXT';
const secondText = 'PRIVATE-SECOND-TEXT';
const imageData = 'PRIVATE-IMAGE-BASE64';
function fixture(expected = firstText) {
  const transcriptPath = '/synthetic-fixture/session.jsonl';
  const record = { type: 'user', uuid: 'user-after-enter', sessionId: 'session',
    timestamp: '2026-09-09T10:00:01Z', message: { role: 'user', content: [
      { type: 'text', text: firstText }, { type: 'text', text: secondText },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
    ] } };
  const candidate = promptAudit.readClaudeUserRecordsFromBuffer(
    Buffer.from(JSON.stringify(record) + '\n'), transcriptPath, { baseOffset: 128 },
  )[0];
  const audit = { handoffId: 'handoff', sendAttemptId: 'attempt', sendOperationKey: 'operation',
    expectedText: expected, expectedLen: expected.length, expectedHash: hash(expected),
    sentAt: Date.parse('2026-09-09T10:00:00Z'), finished: false, submitWritten: true,
    historySessionId: 'session', enterInputRevision: 7, enterRunSeq: 2,
    enterLifecycleGeneration: 'lifecycle', preSubmitBoundary: { available: true,
      sessionId: 'session', transcriptPath, fileSize: 128, lastUserUuid: 'before-enter' } };
  return { record, candidate, audit };
}

function mainHarness(reportIncident) {
  const events = [];
  const context = vm.createContext({
    ...promptAudit, pasteAuditHash: hash, reportTerminalIncident: reportIncident,
    bridgeKnownSessions: new Map([['tab', 'session']]),
    claudeLaunchGenerationByTab: new Map([['tab', { generation: 'launch' }]]),
    terminalCommandState: new Map([['tab', { runSeq: 2 }]]),
    getTerminalLifecycleGeneration: () => 'lifecycle', getTerminalInputRevision: () => 7,
    projectManager: { db: {} }, saveAuditedPromptPresentation: () => false,
    finishClaudePasteAudit: (_tabId, audit, result) => {
      events.push('settled'); audit.finished = true; audit.result = result;
    },
  });
  vm.runInContext(observerSource + confirmSource, context);
  return { context, events };
}

test('counterfactual first-text success is observed before actual confirmation settles, without changing the verdict', () => {
  const { candidate, audit } = fixture();
  const captured = [];
  const h = mainHarness((key, payload) => {
    assert.equal(audit.finished, false, 'capture starts before settlement');
    assert.deepEqual(h.events, []);
    captured.push({ key, payload });
    return new Promise(() => {}); // Disk completion must not hold delivery.
  });
  const selection = promptAudit.selectClaudePendingPromptAudit([audit], [candidate]);
  const result = h.context.confirmClaudePasteAuditFromTranscriptSelection('tab', audit, selection, 'test-exact');
  assert.equal(result.success, true);
  assert.equal(result.actualLen, firstText.length, 'the existing first-block verdict is unchanged');
  assert.equal(audit.finished, true);
  assert.equal(captured.length, 1);
  const diagnostic = captured[0].payload.context;
  assert.equal(diagnostic.match.selected, true);
  assert.equal(diagnostic.match.verdictChangedByObserver, false);
  assert.equal(diagnostic.shape.nonEmptyTextParts, 2);
  assert.deepEqual(diagnostic.shape.parts.map(part => part.type), ['text', 'text', 'image']);
  assert.equal(diagnostic.expected.hash, hash(firstText));
  assert.equal(diagnostic.shape.parts[1].hash, hash(secondText));
  assert.equal(diagnostic.scope.enterInputRevision, 7);
  const serialized = JSON.stringify(captured);
  for (const secret of [firstText, secondText, imageData, candidate.transcriptPath]) {
    assert.equal(serialized.includes(secret), false, 'only hashes/identities leave the observer');
  }
});

test('actual hook selection observes an A+B mismatch while leaving the audit pending', () => {
  const { candidate, audit } = fixture(firstText + secondText);
  const captured = [];
  const h = mainHarness((key, payload) => captured.push({ key, payload }));
  Object.assign(h.context, { tabId: 'tab', alive: [audit], candidates: [candidate],
    claimedByteOffsets: new Set(), submitted_prompt: audit.expectedText });
  const selection = vm.runInContext('(function () {' + hookSelectionSource + '\nreturn selection;})()', h.context);
  assert.equal(selection, null);
  assert.equal(audit.finished, false);
  assert.deepEqual(h.events, []);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].payload.context.match.reason, 'unmatched-causal-candidate');
  assert.equal(captured[0].payload.context.match.textMatches, false);
  assert.equal(captured[0].payload.context.hookPrompt.hash, hash(firstText + secondText));
  assert.equal(captured[0].payload.context.extracted.hash, hash(firstText));
});

test('single text, meta sibling, tool results, stale and unrelated candidates stay quiet', () => {
  let reports = 0;
  const observe = promptAudit.createClaudePromptShapeObserver({ reportIncident: () => reports++ });
  for (const change of [
    value => { value.candidate.record.message.content = [{ type: 'text', text: firstText }]; },
    value => { value.candidate.record.isMeta = true; },
    value => { value.candidate.record.message.content.push({ type: 'tool_result', content: 'private' }); },
    value => { value.candidate.byteOffset = 127; },
    value => { value.candidate.transcriptPath = '/foreign/session.jsonl'; },
    value => { value.candidate.record.sessionId = 'foreign'; },
    value => { value.audit.finished = true; },
    value => { value.audit.submitWritten = false; },
  ]) {
    const value = fixture(firstText + secondText);
    change(value);
    assert.equal(observe({ tabId: 'tab', audits: [value.audit], candidates: [value.candidate] }), 0);
  }
  const { candidate, audit } = fixture();
  assert.equal(observe({ tabId: 'tab', audits: [audit, { ...audit, handoffId: 'other' }], candidates: [candidate] }), 0,
    'unmatched observation cannot guess among two causal pending operations');
  assert.equal(observe({ tabId: 'tab', audits: [audit], candidates: [candidate], claimedByteOffsets: new Set([128]) }), 0);
  assert.equal(reports, 0);
});

test('shape observations deduplicate across callbacks and remain scoped to an exact attempt', () => {
  const { candidate, audit } = fixture();
  const captures = [];
  const observe = promptAudit.createClaudePromptShapeObserver({ reportIncident: (key, payload) => captures.push({ key, payload }) });
  const selection = promptAudit.selectClaudePendingPromptAudit([audit], [candidate]);
  const args = { tabId: 'tab', audits: [audit], candidates: [candidate], selection };
  assert.equal(observe({ ...args, source: 'live' }), 1);
  assert.equal(observe({ ...args, source: 'hook' }), 0);
  assert.equal(observe({ ...args, source: 'timeout' }), 0);
  audit.sendAttemptId = 'second-attempt';
  assert.equal(observe(args), 1);
  assert.equal(captures.length, 2);
  assert.notEqual(captures[0].key, captures[1].key);
});

test('an unmatched later native input is not reported against an older pending operation', () => {
  const { candidate, audit } = fixture(firstText + secondText);
  let reports = 0;
  const observe = promptAudit.createClaudePromptShapeObserver({ reportIncident: () => reports++ });
  const args = { tabId: 'tab', audits: [audit], candidates: [candidate] };
  assert.equal(observe({ ...args, getScope: () => ({ inputRevision: 8, runSeq: 2, lifecycleGeneration: 'lifecycle' }) }), 0);
  assert.equal(observe({ ...args, getScope: () => ({ inputRevision: 7, runSeq: 3, lifecycleGeneration: 'later' }) }), 0);
  assert.equal(reports, 0);
});

test('image hashing is explicitly sampled and bounded; raw image bytes are never retained', () => {
  const { record } = fixture();
  record.message.content[2].source.data = 'x'.repeat(4 * 1024 * 1024);
  const hashLengths = [];
  const shape = describeClaudeMultitextPromptCarrier(record, { hashText: text => {
    hashLengths.push(text.length); return hash(text);
  } });
  assert.equal(shape.parts[2].encodedLength, 4 * 1024 * 1024);
  assert.equal(shape.parts[2].hashScope, 'encoded-head-tail-32KiB');
  assert.ok(Math.max(...hashLengths) <= 64 * 1024 + 1);
  assert.ok(JSON.stringify(shape).length < 2000);
});

test('synchronous and asynchronous observer failures never change actual confirmation', async () => {
  for (const report of [() => { throw Error('observer broke'); }, () => Promise.reject(Error('writer broke'))]) {
    const { candidate, audit } = fixture();
    const h = mainHarness(report);
    const selection = promptAudit.selectClaudePendingPromptAudit([audit], [candidate]);
    assert.equal(h.context.confirmClaudePasteAuditFromTranscriptSelection('tab', audit, selection, 'test').success, true);
    assert.equal(audit.finished, true);
  }
  await new Promise(resolve => setImmediate(resolve)); // rejected writes were consumed
});

test('actual incident router persists only shape metadata and keeps other observations on full replay capture', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-shape-diagnostic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = [];
  const notifications = [];
  const replayReasons = [];
  const context = vm.createContext({
    ...writer, crypto, createTerminalIncidentReporter, terminalSendIncidentNotification,
    app: { getPath: () => directory }, console: { warn() {} },
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false,
      send: (_channel, value) => notifications.push(value) } },
    captureTerminalHistoryPreviewDiagnostic: async payload => {
      replayReasons.push(payload.incidentReason); return { artifactPath: '/full-packet', reference: 'full packet' };
    },
  });
  vm.runInContext(captureSource + reporterSource + '\nglobalThis.report = reportTerminalIncident;', context);
  const { candidate, audit } = fixture();
  const observe = promptAudit.createClaudePromptShapeObserver({ reportIncident: (key, payload) => {
    const promise = context.report(key, payload); saved.push(promise); return promise;
  } });
  observe({ tabId: 'tab', audits: [audit], candidates: [candidate],
    selection: promptAudit.selectClaudePendingPromptAudit([audit], [candidate]) });
  const result = await saved[0];
  assert.equal(result.success, true);
  assert.equal(result.metadataOnly, true);
  assert.deepEqual(replayReasons, []);
  assert.equal(fs.statSync(result.artifactPath).mode & 0o777, 0o600);
  const raw = fs.readFileSync(result.artifactPath, 'utf8');
  const artifact = JSON.parse(raw);
  assert.equal(artifact.diagnostic.metadataOnly, true);
  assert.equal(artifact.diagnostic.incident.context.shape.textParts, 2);
  for (const forbidden of [firstText, secondText, imageData, 'serializedScreen', 'composerTrace', 'rendererSnapshot']) {
    assert.equal(raw.includes(forbidden), false);
  }
  assert.match(notifications[0].headline, /без текста сообщения/);
  for (const reason of ['codex-turn-identity-contradiction', 'claude-settings-dialog-observation']) {
    await context.report(reason, { tabId: 'tab', toolType: reason.startsWith('codex') ? 'codex' : 'claude', incidentReason: reason });
  }
  assert.deepEqual(replayReasons, ['codex-turn-identity-contradiction', 'claude-settings-dialog-observation']);
  assert.ok(notifications.every(value => !value.headline.includes('Отправка не подтверждена')));
});

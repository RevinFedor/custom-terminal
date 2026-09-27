'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const data = require('./ipc/codex-data');
const { hashCodexRewindTargetText, classifyCodexStableSourceTranscriptRecovery } = require('./codex-rewind-target-proof');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { codexUserMessageAuditText } = require('./codex-prompt-audit');
const ast = ts.createSourceFile('main.js', fs.readFileSync(require.resolve('./main'), 'utf8'), ts.ScriptTarget.Latest, true);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'projectCodexSourceTranscriptForRewindRecovery');
const project = vm.runInNewContext(node.getText(ast) + '\nprojectCodexSourceTranscriptForRewindRecovery', {
  codexDataModule: data, hashCodexRewindTargetText, codexUserMessageAuditText, pasteAuditHash: promptAuditFingerprint,
});

test('legacy journal uses actual transcript proof and exact SQLite settlement without rewriting receipt or history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-legacy-rewind-'));
  const db = new Database(path.join(root, 'fixture.db'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);'
    + 'CREATE TABLE tabs(project_id TEXT, tab_id TEXT, codex_session_id TEXT);');
  const manager = new DatabaseManager({ existingConnection: db });
  const row = (time, type, payload) => JSON.stringify({ timestamp: new Date(time).toISOString(), type, payload }) + '\n';
  const prefix = row(500, 'session_meta', { id: 'S' })
    + row(1_000, 'event_msg', { type: 'user_message', message: 'target' });
  const bytes = prefix + row(2_220, 'event_msg', { type: 'task_started' })
    + row(2_240, 'event_msg', { type: 'user_message', message: 'continued' });
  const sourceFilePath = path.join(root, 'source.jsonl');
  fs.writeFileSync(sourceFilePath, bytes);
  const journal = { version: 2, projectId: 'P', originProjectId: 'P', tabId: 'T', cwd: root,
    sourceSessionId: 'S', expectedBindingSessionId: 'S', sourceBindingMode: 'confirmed-writer',
    sourceLifecycleGeneration: 'L:1', sourceRunSeq: 1, operationId: 'O', requestId: 'O',
    actionGeneration: 'G', actionStartedAtMs: 2_000,
    targetUuid: 'codex-user-S-1', targetSourceLine: 1, targetTextHash: hashCodexRewindTargetText('target'),
    rollbackTurns: 3, phase: 'stable-source-submit-written', appliedAtMs: 2_005,
    restoredTextHash: hashCodexRewindTargetText('target'), stableSourceSettledAtMs: 2_010,
    submitProof: { version: 1, submitId: 'A', sourceSessionId: 'S', actionGeneration: 'G',
      expectedLen: 9, expectedHash: promptAuditFingerprint('continued'), sentAtMs: 2_200,
      submitWrittenAtMs: 2_201, sourceFilePath, sourceFileSize: Buffer.byteLength(prefix), runSeq: 1 } };
  const key = 'codex.pending-writer-handoff.v1:T';
  const raw = JSON.stringify(journal);
  db.prepare('INSERT INTO tabs VALUES(?,?,?)').run('P', 'T', 'S');
  db.prepare('INSERT INTO app_state VALUES(?,?,?)').run(key, raw, 1);
  db.prepare('INSERT INTO app_state VALUES(?,?,?)').run('unrelated', '"preserved"', 1);
  const scan = await data._api.scanCodexStableSourceRewindProof(sourceFilePath, {
    targetSourceLine: 1, actionStartedAtMs: 2_000, expectedSubmit: journal.submitProof,
  });
  assert.equal(scan.complete, true);
  assert.equal(scan.expectedSubmitMatched, true);
  const transcript = project([scan.targetRecord, scan.taskStartedRecord, scan.userMessageRecord], 'S');
  const proof = classifyCodexStableSourceTranscriptRecovery({ journal, currentSessionId: 'S',
    discoveryComplete: true, descendants: [], ...transcript });
  assert.equal(proof.proven, true);
  assert.equal(Object.hasOwn(proof.submitProof, 'originPhase'), false);
  const request = { journalKey: key, projectId: 'P', tabId: 'T', sourceSessionId: 'S', actionGeneration: 'G',
    targetSourceLine: proof.targetSourceLine, targetTextHash: journal.targetTextHash,
    taskStartedSourceLine: proof.taskStartedSourceLine, taskStartedAtMs: 2_220,
    userMessageSourceLine: proof.userMessageSourceLine, userMessageTimestampMs: proof.userMessageTimestampMs,
    taskStartedByteOffset: proof.taskStartedByteOffset, userMessageByteOffset: proof.userMessageByteOffset,
    userMessageTextLength: proof.userMessageTextLength, userMessageAuditHash: proof.userMessageAuditHash,
    submitProof: proof.submitProof };
  for (const patch of [
    { actionGeneration: 'other' }, { targetTextHash: 'wrong' },
    { userMessageAuditHash: 'wrong' }, { userMessageByteOffset: 0 },
    { submitProof: { ...proof.submitProof, submitId: 'foreign' } },
    { submitProof: { ...proof.submitProof, originPhase: 'stable-source-settled' } },
  ]) {
    assert.equal(manager.resolvePendingCodexStableSourceFromTranscript({ ...request, ...patch }).success, false);
    assert.equal(db.prepare('SELECT value FROM app_state WHERE key=?').get(key).value, raw);
  }
  const settled = manager.resolvePendingCodexStableSourceFromTranscript(request);
  assert.equal(settled.success, true);
  assert.equal(settled.journalCleared, true);
  assert.equal(db.prepare('SELECT value FROM app_state WHERE key=?').get(key), undefined);
  assert.equal(manager.getTabCodexSessionId('P', 'T'), 'S');
  assert.equal(manager.getAppState('unrelated'), 'preserved');
  assert.equal(fs.readFileSync(sourceFilePath, 'utf8'), bytes);
});

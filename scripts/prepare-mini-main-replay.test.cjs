'use strict';
// Source/artifact integrity only. No app, provider, MCP call or source storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const dir = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay/main');
const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
const json = name => {
  const value = JSON.parse(read(name));
  // The original prelaunch evidence is immutable; current DEV now selects two
  // completed cases. Do not pretend the old frozen request was replaced.
  return name === 'REPLAY.json' && value.case === 'two-completed-readonly-cases'
    ? JSON.parse(fs.readFileSync(path.join(dir, '../ready-v2/PREVIOUS-MAIN-MANIFEST.json'), 'utf8')) : value;
};
const hash = text => createHash('sha256').update(text).digest('hex');
test('first exact canonical request and original image ownership are retained, not the later clarification', () => {
  const source = json('SOURCE-EVIDENCE.json'), manifest = json('REPLAY.json');
  // Fedor intentionally edited the authoring TXT. Preserve that edit; exact
  // historical assertions belong to the immutable API evidence, not the draft.
  const text = source.canonical.text;
  assert.equal(hash(text), '359bc824b2b749369c5d9ab45f1b75bb045b98d79cd1bae45007eb71c8cbf27e');
  assert.equal(text, source.canonical.text);
  assert.equal(manifest.selectedUser.userUuid, 'codex-user-dcb48f49-d127-49d7-82f4-a97370d3d114-69060');
  assert.equal(source.receipt.entryUuid, manifest.selectedUser.userUuid);
  assert.equal(source.receipt.exactAuditConfirmed, true);
  assert.equal(source.receipt.handoffId, 'mvuyys8q-9n19k8');
  assert.equal(source.receipt.authoringSnapshot.imagePaths.length, 1);
  assert.equal(source.receipt.authoringSnapshot.imagePaths[0].assetId, manifest.prompt.images[0].assetId);
  assert.match(text, /\[Image #1\]/);
  assert.equal(source.receipt.authoringSnapshot.chips.length, 0);
  assert.equal(read('EDITOR-PROMPT.txt'), source.receipt.authoringSnapshot.editorText);
  assert.doesNotMatch(text, /mvuzwdx5-o207f0/);
});
test('selected prior compact contains the requested chronology, without choosing the known newer compact', () => {
  const m = json('REPLAY.json');
  assert.equal(m.selectedCompact.compactEventIdentity, 'codex-compact-dcb48f49-d127-49d7-82f4-a97370d3d114-67663');
  assert.ok(Date.parse(m.selectedCompact.timestamp) < Date.parse(m.selectedTimestamp));
  assert.ok(Date.parse(m.selectedTimestamp) < Date.parse(m.latestCompact.timestamp));
  assert.equal(m.requestedFork.fullHistory, false);
  assert.equal(m.requestedFork.mode, 'selected-prior-compact');
  assert.equal(m.status, 'prepared'); assert.equal(m.reason, null);
  assert.notEqual(m.targetSessionId, m.sourceSessionId);
  assert.equal(m.targetSessionId, m.privateProfile.sessionId);
  assert.equal(m.offlineCopy.sourceUnchanged, true);
  assert.equal(m.offlineCopy.originalTurnHeaderRemoved, true);
});
test('instruction and actual Gemini input shape are a prelaunch snapshot, not a fabricated runtime receipt', () => {
  const m = json('REPLAY.json'), i = m.instruction, template = json(i.templateFile);
  assert.equal(hash(read(i.textFile)), i.sha256);
  assert.equal(i.model, 'gemini-3.8-flash'); assert.equal(i.thinkingLevel, 'HIGH');
  assert.equal(i.providerReceived, false); assert.equal(i.runtimeRequestAudit, null);
  assert.equal(template.userObject.request[0].text, json('SOURCE-EVIDENCE.json').canonical.text);
  assert.equal(template.userObject.request.length, 1);
  assert.equal(template.generationAttempted, false);
  assert.equal(template.userObject.completedAnswer, '<ANSWER_AFTER_FEDOR_MANUAL_SEND>');
  assert.equal(template.tools[0].functionDeclarations[0].name, 'send_prompt');
  assert.deepEqual(m.mutations, { source: 0, forks: 0, rewinds: 0, appDevLaunches: 0, modelPrompts: 0 });
});

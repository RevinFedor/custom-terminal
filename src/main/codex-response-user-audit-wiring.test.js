'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const startup = fs.readFileSync(
  path.join(root, 'src/main/agent-send-startup-reconcile.js'),
  'utf8',
);
const codexData = fs.readFileSync(
  path.join(root, 'src/main/ipc/codex-data.js'),
  'utf8',
);

test('provisional Resume source scans both Codex user carriers without publishing lifecycle', () => {
  const sourceAudit = main.slice(
    main.indexOf('function processCodexSourceAuditOnlyText'),
    main.indexOf('function armCodexManualWriterBindingConflict'),
  );
  assert.match(sourceAudit, /consumeCodexUserMessageAuditChunk\(/);
  assert.match(sourceAudit, /selectCodexPreferredUserMessageAuditRecords\(consumed\.records\)/);
  assert.match(sourceAudit, /processCodexUserMessagePasteAudit\(state, candidate\.record\)/);
});

test('live image audit carries the exact staged transport paths', () => {
  const staging = main.slice(
    main.indexOf('// Stage paste audit BEFORE Enter.'),
    main.indexOf('if (fast) {', main.indexOf('// Stage paste audit BEFORE Enter.')),
  );
  assert.match(staging, /expectedImagePaths: \(codexImagePasteSegments \|\| \[\]\)/);
  assert.match(staging, /segment\?\.kind === 'image'/);
  assert.match(staging, /\.map\(\(segment\) => segment\.text\)/);
});

test('delivery proof keeps raw provider identity while presentation uses one normalized slot', () => {
  const audit = main.slice(
    main.indexOf('function processCodexUserMessagePasteAudit'),
    main.indexOf('function processCodexSourceAuditOnlyText'),
  );
  assert.match(audit, /preserveProviderImageMarkup: true/);
  assert.match(audit, /const presentationText = codexUserMessagePresentationText\(record\) \|\| actualText/);
  assert.match(audit, /actualText: presentationText,[\s\S]{0,80}actualHash: presentationHash/);
});

test('durable receipt preserves staged paths for exact restart reconciliation', () => {
  const durableStage = main.slice(
    main.indexOf('const stagedDurableContext = agentSendReceiptStore.stageAttemptContext'),
    main.indexOf('if (stagedDurableContext?.ok !== true)',
      main.indexOf('const stagedDurableContext = agentSendReceiptStore.stageAttemptContext')),
  );
  assert.match(durableStage, /transportText: content/);
  assert.match(durableStage, /expectedImagePaths: \(codexImagePasteSegments \|\| \[\]\)/);
  assert.match(startup, /expectedImagePaths: provider === 'codex'/);
  assert.match(startup, /allowUnprovenImageCarrier: context\.expectedImagePaths\.length === 0/);
});

test('restart reconciliation reads response_item text through the same audit contract', () => {
  assert.match(startup, /codexUserMessageAuditText/);
  assert.match(startup, /const actualText = codexUserMessageAuditText\(candidate\.record, \{[\s\S]{0,100}preserveProviderImageMarkup: true/);
  assert.doesNotMatch(startup, /function codexUserMessageText\(/);
});

test('active writer chooses one preferred carrier before per-line audit', () => {
  const turnText = main.slice(
    main.indexOf('function processCodexTurnText'),
    main.indexOf('async function scanCodexTurnAppend'),
  );
  const turnLine = main.slice(
    main.indexOf('function processCodexTurnLine'),
    main.indexOf('function inferCodexBusyFromText'),
  );
  assert.match(turnText, /selectCodexPreferredUserMessageAuditRecords\(carriers\.records\)/);
  assert.match(turnText, /state\.preferredUserAuditOffsets = new Set/);
  assert.match(turnLine, /preferredResponseUserCarrier[\s\S]*?processCodexUserMessagePasteAudit/);
  assert.match(
    turnLine,
    /projectCodexLiveMessageForPublication\(state, record, liveMessage,[\s\S]*?publishResponseCarrier: !responseUserRecord \|\| preferredResponseUserCarrier/,
  );
  assert.doesNotMatch(turnLine, /responseUserRecord && !preferredResponseUserCarrier\)\s*\?\s*null/);
  assert.match(main, /payload\.type === 'message' && payload\.role === 'user'[\s\S]*?codexLiveSourceIdentity\(state, record, 'codex-user'\)/);
});

test('History, Timeline, range editing, and native Rewind consume response-only users', () => {
  assert.match(codexData, /function createCodexTimelineProjector[\s\S]*?pendingResponseUsers/);
  assert.match(codexData, /function createCodexHistoryProjector[\s\S]*?pendingResponseUsers/);
  assert.match(codexData, /function buildCodexVisibleRecordWrappers[\s\S]*?fallbackIndex/);
  assert.match(main, /async function buildCodexResponseUserRewindPayload/);
  assert.match(main, /carrier=' \+ \(eventUser \? 'event_msg' : 'response_item'\)/);
});

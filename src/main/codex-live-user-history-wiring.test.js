'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function functionBody(name, nextName) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\nfunction ' + nextName + '(', start + 1);
  assert.notEqual(start, -1, name + ' must exist');
  assert.notEqual(end, -1, nextName + ' boundary must exist');
  return source.slice(start, end);
}

test('Codex user audit ownership is resolved before the live row is published', () => {
  const body = functionBody('processCodexTurnLine', 'inferCodexBusyFromText');
  const audit = body.indexOf('processCodexUserMessagePasteAudit(state, record)');
  const live = body.indexOf('buildCodexLiveRawMessage(state, record)');
  assert.notEqual(audit, -1);
  assert.notEqual(live, -1);
  assert.ok(audit < live, 'the exact handoff must be known before live publication');
  assert.equal(
    body.match(/processCodexUserMessagePasteAudit\(state, record\)/g)?.length,
    1,
    'one rollout record must consume its audit at most once',
  );
  assert.match(
    body,
    /projectCodexLiveMessageForPublication\(state, record, liveMessage, \{[\s\S]{0,120}promptOwner/,
  );
  assert.match(
    body,
    /\.\.\.\(projected\.promptOwner \? \{ promptOwner: projected\.promptOwner \} : \{\}\)/,
  );
});

test('Codex live and durable user rows share the exact rollout source identity', () => {
  const build = functionBody('buildCodexLiveRawMessage', 'summarizeCodexTurnChunk');
  assert.match(
    build,
    /sourceIdentity: codexLiveSourceIdentity\(state, record, 'codex-user'\)/,
  );
  const audit = functionBody('processCodexUserMessagePasteAudit', 'processCodexSourceAuditOnlyText');
  assert.match(audit, /rememberCodexLivePromptOwner\(state, result\)/);
});

test('Codex live project instructions carry structural service identity', () => {
  const build = functionBody('buildCodexLiveRawMessage', 'summarizeCodexTurnChunk');
  assert.match(build, /isCodexProjectInstructionsUserText\(text\)/);
  assert.match(build, /serviceCarrier \? \{ serviceCarrier \} : \{\}/);
});

test('Codex live user carriers pair across watcher appends before publication', () => {
  const project = functionBody(
    'projectCodexLiveMessageForPublication',
    'summarizeCodexTurnChunk',
  );
  assert.match(project, /state\.liveUserCarrierPairer\.accept\(\{/);
  assert.match(project, /text: codexUserMessagePresentationText\(record\)/);
  assert.match(project, /byteOffset: record\.__byteOffset/);
  assert.match(project, /publish: carrierKind !== CODEX_LIVE_USER_RESPONSE_CARRIER/);

  const body = functionBody('processCodexTurnLine', 'inferCodexBusyFromText');
  assert.doesNotMatch(
    body,
    /responseUserRecord && !preferredResponseUserCarrier\)\s*\?\s*null/,
    'a response carrier must reach the cross-append pairer even when its event is in this chunk',
  );
  assert.match(body, /for \(const projected of liveProjection\.projections\)/);
  assert.match(body, /message: projected\.message/);
});

test('top-level compact publishes a lightweight exact-position History row', () => {
  const build = functionBody('buildCodexHistoryLiveCompactEntry', 'emitCodexHistoryLiveTurnBoundary');
  assert.match(build, /record\?\.type !== 'compacted'/);
  assert.match(build, /codexLiveSourceIdentity\(state, record, 'codex-compact'\)/);
  assert.match(build, /content: 'Conversation compacted'/);
  assert.doesNotMatch(build, /compactSummary|replacement_history/);

  const process = functionBody('processCodexTurnLine', 'inferCodexBusyFromText');
  assert.match(process, /buildCodexHistoryLiveCompactEntry\(state, record\)/);
  assert.match(process, /type: 'history_entry'/);
  assert.match(process, /entry: liveHistoryEntry/);
});

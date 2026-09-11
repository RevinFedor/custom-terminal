'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  assert.match(audit, /entryUuid \? \{ entryUuid \}/);
  assert.match(audit, /recordByteOffset,/);
});

test('actual live user builders publish the durable record UUID when line identity is available', () => {
  const context = {
    codexKnownSessions: new Map(),
    codexUserMessagePresentationText: record => record.payload.message,
    isCodexEnvironmentContextUserText: () => false,
    isCodexProjectInstructionsUserText: () => false,
    isCodexTurnAbortedUserText: text => /^<turn_aborted>(?:\s|$)/i.test(String(text || '').trim()),
    codexUserMessageImageRefs: () => [],
    recoverManagedHistoryImageRefs: () => ({ imagePaths: [] }),
    recoverManagedHistoryImageRef: null,
    Date,
  };
  vm.runInNewContext([
    functionBody('codexEventType', 'codexLiveUuid'),
    functionBody('codexLiveUuid', 'codexStableLiveUserUuid'),
    functionBody('codexStableLiveUserUuid', 'codexLiveSourceIdentity'),
    functionBody('codexLiveSourceIdentity', 'buildCodexHistoryLiveCompactEntry'),
    functionBody('buildCodexLiveRawMessage', 'summarizeCodexTurnChunk'),
  ].join('\n'), context);
  const state = { tabId: 'tab-a', sessionId: 'session-a' };
  for (const record of [
    { __line: 12, __byteOffset: 640, timestamp: '2026-09-09T13:00:00Z',
      type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
    { __line: 11, __byteOffset: 590, timestamp: '2026-09-09T13:00:00Z',
      type: 'response_item', payload: { type: 'message', role: 'user', message: 'hello' } },
  ]) {
    const projected = context.buildCodexLiveRawMessage(state, record);
    assert.equal(projected.uuid, 'codex-user-session-a-' + record.__line);
    assert.equal(projected.sourceIdentity, 'codex-user-source-session-a-' + record.__byteOffset);
  }
});

test('Codex live publication rejects provider-owned turn_aborted user carriers', () => {
  const context = {
    codexKnownSessions: new Map(),
    codexUserMessagePresentationText: record => record.payload.message,
    isCodexEnvironmentContextUserText: () => false,
    isCodexProjectInstructionsUserText: () => false,
    isCodexTurnAbortedUserText: text => /^<turn_aborted>(?:\s|$)/i.test(String(text || '').trim()),
    codexUserMessageImageRefs: () => [],
    recoverManagedHistoryImageRefs: () => ({ imagePaths: [] }),
    recoverManagedHistoryImageRef: null,
    Date,
  };
  vm.runInNewContext([
    functionBody('codexEventType', 'codexLiveUuid'),
    functionBody('codexLiveUuid', 'codexStableLiveUserUuid'),
    functionBody('codexStableLiveUserUuid', 'codexLiveSourceIdentity'),
    functionBody('codexLiveSourceIdentity', 'buildCodexHistoryLiveCompactEntry'),
    functionBody('buildCodexLiveRawMessage', 'summarizeCodexTurnChunk'),
  ].join('\n'), context);
  const state = { tabId: 'tab-a', sessionId: 'session-a' };
  const abortedText = '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>';
  for (const record of [
    { __line: 21, __byteOffset: 700, timestamp: '2026-09-10T16:07:39.528Z',
      type: 'response_item', payload: { type: 'message', role: 'user', message: abortedText } },
    { __line: 22, __byteOffset: 800, timestamp: '2026-09-10T16:07:39.529Z',
      type: 'event_msg', payload: { type: 'user_message', message: abortedText } },
  ]) {
    assert.equal(context.buildCodexLiveRawMessage(state, record), null);
  }

  const literalMention = context.buildCodexLiveRawMessage(state, {
    __line: 23,
    __byteOffset: 900,
    timestamp: '2026-09-10T16:08:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'Почему после сообщения видно <turn_aborted>?' },
  });
  assert.equal(literalMention?.message?.content?.[0]?.text,
    'Почему после сообщения видно <turn_aborted>?');
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

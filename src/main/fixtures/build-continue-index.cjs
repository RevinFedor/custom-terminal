'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { _api } = require('../ipc/codex-data');
const { createCodexResultReader } = require('../codex-result-reader');
const event = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
const turn = (id, text, end = 'task_complete') => [event('task_started', { turn_id: id }), event('user_message', { message: text }),
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer ' + id }] } },
  event(end, { turn_id: id, last_agent_message: 'answer ' + id })];
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t, { middle = [], malformed = false, parent = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-continue-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'B.jsonl'), oldFile = path.join(root, 'A.jsonl');
  const old = turn('old', 'original work', 'turn_aborted'), rest = [...middle, ...turn('callback', 'saved callback')];
  const prefix = encode(old);
  fs.writeFileSync(file, (parent ? '' : prefix) + (malformed ? '{broken-json}\n' : '') + encode(rest));
  if (parent) fs.writeFileSync(oldFile, prefix);
  let revision = 'exact-descriptor-1';
  const reader = createCodexResultReader({ readJsonlRange: _api.readJsonlRange,
    createTimelineProjector: _api.createCodexTimelineProjector, buildResult: _api.buildCodexProviderTurnAssistantResult,
    extractText: _api.extractTextContent, userIdentity: _api.getCodexUserRecordIdentity, isCompactPayload: _api.isCompactPayload,
    extractReasoning: _api.extractReasoning, findExecutionContext: _api.findCodexPromptExecutionContext,
    collectLegacy() { assert.fail('no raw History fallback'); }, log: { log() {}, warn() {} } });
  const resolveSource = async () => ({ success: true, sessionId: 'B', viewOwnerSessionId: 'B', revisionKey: revision,
    digestsVerified: !parent || digest(fs.readFileSync(oldFile)) === digest(prefix),
    segments: [...(parent ? [{ filePath: oldFile, physicalSessionId: 'A', segmentId: 'accepted-frozen-parent',
      fromByte: 0, toByte: Buffer.byteLength(prefix), endLine: old.length, frozen: true }] : []),
    { filePath: file, physicalSessionId: 'B', segmentId: 'child', fromByte: 0, toByte: fs.statSync(file).size, frozen: false }] });
  const request = { sessionId: 'B', cwd: root, resolveSource, maxChars: 500 };
  let original, latest;
  return { reader, root, file, request, async prime() {
    original = await reader.loadHistoricalObservedExecution({ ...request,
      targetExecutionContext: { provider: 'codex', sessionId: parent ? 'A' : 'B', turnId: 'old', generation: null } });
    latest = await reader.loadLatestObservedExecution(request);
    assert.equal(original.sourceVerified, true); assert.equal(latest.sourceVerified, true);
    return { original, latest };
  }, async latest() { latest = await reader.loadLatestObservedExecution(request); return latest; },
  interval: extra => reader.readCachedInputInterval({ sessionId: 'B', cwd: root,
    from: { userUuid: original?.userUuid, sourceIdentity: original?.sourceIdentity, executionContext: original?.executionContext },
    through: { userUuid: latest?.userUuid, sourceIdentity: latest?.sourceIdentity, executionContext: latest?.executionContext },
    readSourceRevision: () => revision, ...extra }), changeRevision() { revision = 'other-descriptor'; } };
}

module.exports = { fixture, turn, encode };

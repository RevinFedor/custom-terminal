'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findTabMessageSourceLocation: find, resolveTabMessageSourceLocation: resolve } = require('./tab-message-source-location');
const message = { messageId: 'M', kind: 'question', sourceTabId: 'A', sourceProvider: 'codex',
  sourceSessionId: 'S', targetTabId: 'B', requestId: 'R' };
const body = extra => ({ ok: true, accepted: true, messageId: 'M', requestId: 'R',
  message: { sourceTabId: 'A', sourceSessionId: 'S', targetTabId: 'B' }, ...extra });
const action = extra => ({ tool: '__raw__', rawTool: { family: 'mcp', mcpServer: 'terminal',
  mcpMethod: 'send_message', toolUseId: 'call:0', args: { tabId: 'B' }, result: JSON.stringify(body()), ...extra } });
const history = (actions, extra = {}) => ({ success: true, toolType: 'codex', sessionId: 'S',
  entries: [{ uuid: 'E', role: 'assistant', sessionId: 'S', actions }], ...extra });

test('exact accepted message selects one normalized MCP call, not its containing group', () => {
  const result = find(message, history([action()]));
  assert.equal(result.success, true); assert.equal(result.location.entryUuid, 'E');
  assert.equal(result.location.toolUseId, 'call:0'); assert.equal(result.location.proof, 'accepted-message-id');
});
test('MCP content/structured wrappers are parsed structurally', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify(body()) }] };
  assert.equal(find(message, history([action({ result: JSON.stringify(result) })])).success, true);
});
test('a reply resolves its own reply_to_message, never the original question', () => {
  const reply = { ...message, kind: 'reply', replyTo: 'Q' };
  const result = find(reply, history([action(), action({ mcpMethod: 'reply_to_message',
    toolUseId: 'reply', args: { messageId: 'Q' } })]));
  assert.equal(result.location.toolUseId, 'reply');
});
test('user quote, Read output, get_message and a different recipient are not source calls', () => {
  for (const raw of [{ family: 'read' }, { mcpMethod: 'get_message' }, { args: { tabId: 'C' } }]) {
    assert.equal(find(message, history([action(raw)])).success, false);
  }
  const rows = history([action()]); rows.entries[0].role = 'user';
  assert.equal(find(message, rows).success, false);
});
test('quoted IDs nested in the tool answer text are not an acceptance', () => {
  const quoted = { text: JSON.stringify(body()), question: { messageId: 'M' } };
  assert.equal(find(message, history([action({ result: JSON.stringify(quoted) })])).success, false);
});
test('foreign SID/source and contradictory request IDs refuse the target', () => {
  for (const result of [body({ requestId: 'foreign' }), body({ message: { sourceTabId: 'C' } }),
    body({ message: { sourceSessionId: 'foreign' } })]) {
    assert.equal(find(message, history([action({ result: JSON.stringify(result) })])).success, false);
  }
  assert.equal(find(message, history([action({ args: { tabId: 'B', requestId: 'foreign' } })])).success, false);
});
test('an exact request ID may identify an ACK-lost call without inventing delivery proof', () => {
  const result = find(message, history([action({ args: { tabId: 'B', requestId: 'R' }, result: undefined })]));
  assert.equal(result.location.proof, 'exact-request-id');
});
test('idempotent replay keeps the initial call; ambiguous initial calls are not guessed', () => {
  const replay = action({ toolUseId: 'retry', result: JSON.stringify(body({ deduplicated: true })) });
  assert.equal(find(message, history([action(), replay])).location.toolUseId, 'call:0');
  assert.equal(find(message, history([action(), action({ toolUseId: 'other' })])).error, 'tab_message_source_ambiguous');
});
test('inherited projection can retain an exact physical source accepted by its receipt', () => {
  const rows = history([action()], { sessionId: 'child' }); rows.entries[0].sessionId = undefined;
  const result = find(message, rows);
  assert.equal(result.success, true); assert.equal(result.location.readSessionId, 'child');
});
test('nullable source identity and authoritative history failure are not empty successful matches', () => {
  assert.equal(find({ ...message, sourceSessionId: null }, history([action()])).success, false);
  assert.equal(find(message, { success: false, error: 'lineage_unresolved' }).error, 'lineage_unresolved');
});
test('the resolver rechecks read owner after asynchronous I/O', async () => {
  let sid = 'S';
  const result = await resolve('M', { getMessage: async () => ({ message }),
    readOwner: async () => ({ toolType: 'codex', sessionId: sid, cwd: '/cwd' }),
    readLocation: async () => { sid = 'replacement'; return find(message, history([action()])); } });
  assert.equal(result.error, 'tab_message_source_read_identity_changed');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as codec from './terminal-message-reference.mjs';

const target = { tabId: 'tab-own', provider: 'codex', sessionId: 'physical-source', messageId: 'codex-user-exact-42',
  physicalSessionId: 'physical-source', rawUuid: 'raw-exact', viewOwnerSessionId: 'read-view',
  transcriptSegmentId: 'segment:1', sourceIdentity: 'source/with+encoded:value', iteration: 42 };

test('a prose link roundtrips the existing exact target, not its displayed iteration', () => {
  assert.equal(typeof codec.terminalMessageLink, 'function');
  const href = codec.terminalMessageLink(target);
  assert.match(href, /^#noted-message\?/);
  assert.deepEqual(codec.readTerminalMessageLink(href), codec.normalizeTerminalMessageTarget(target));
  const changed = codec.readTerminalMessageLink(href.replace('iteration=42', 'iteration=999'));
  assert.equal(changed.messageId, target.messageId); assert.equal(changed.physicalSessionId, target.physicalSessionId);
  for (const provider of ['claude', 'codex', 'gemini']) {
    assert.equal(codec.readTerminalMessageLink(codec.terminalMessageLink({ ...target, provider })).provider, provider);
  }
});
test('ordinary URLs, unknown/duplicate fields, absent identity and oversized metadata do not create a target', () => {
  const good = '#noted-message?tabId=T&provider=codex&sessionId=S&messageId=U';
  assert.equal(codec.readTerminalMessageLink(good).messageId, 'U');
  for (const href of ['https://example.test', 'file:///finite/file', '#other', good + '&messageId=foreign',
    good + '&action=rewind', good.replace('sessionId=S&', ''), good.replace('provider=codex', 'provider=other'),
    good.replace('messageId=U', 'messageId=%0AU'), good + '&iteration=-1', good + '&iteration=1.5',
    good + '&tabName=' + 'x'.repeat(16384)]) assert.equal(codec.readTerminalMessageLink(href), null, href.slice(0, 100));
  assert.equal(codec.terminalMessageLink({ ...target, sessionId: '' }), null);
});

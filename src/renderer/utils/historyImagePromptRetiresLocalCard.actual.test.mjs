// A prompt WITH AN IMAGE was drawn twice and never retired.
//
// 03.11, tab 1ccc61c912ae, handoff mw01agh2-d8g4rb. Earlier fixes retired the
// local SENT card as soon as Claude's own row appeared — and they worked, for
// a plain text prompt. An image prompt is recorded differently:
//
//   queue-operation enqueue              ← our send, carries the queue identity
//   user        uuid=d84b93b5            ← the turn envelope
//   attachment  uuid=72c64b51  type=queued_command   ← THIS is what the feed
//                                                      draws as the user row
//
// The parser projects that attachment as `role: 'user'`, so the row was there
// and its role matched. What did not match was the id: the retirement compared
// `auditProof.entryUuid`, the uuid our audit saw, and the visible row carries
// the attachment's uuid instead.
//
// The exact proof was never missing. The attachment row inherits the consumed
// queue item's `sourceIdentity`, the card carries the same one in
// `providerQueueProof` — nothing about text, timestamps or content shape is
// involved. The lookup simply had to consider both ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const panel = readFileSync(join(root, 'src', 'renderer', 'components', 'Workspace', 'HistoryPanel.tsx'), 'utf8');
const retire = (() => {
  const start = panel.indexOf('const retireLocalPromptsCoveredByCanonicalRows');
  assert.ok(start > 0, 'retirement not found');
  const end = panel.indexOf('const queueMergeIntents', start);
  assert.ok(end > start);
  return panel.slice(start, end);
})();

test('the queue proof id is considered, not only the audit id', () => {
  assert.match(retire, /record\.auditProof\?\.entryUuid\s*\n?\s*\|\| record\.providerQueueProof\?\.entryUuid/,
    'an image prompt row is addressed by the queue item, not by the audit uuid');
});

test('sourceIdentity remains the primary proof', () => {
  // It is the one id BOTH sides always carry: the attachment row inherits it
  // from the consumed queue item, and the card holds it in its queue proof.
  assert.match(retire, /const proof = record\.auditProof \|\| record\.providerQueueProof;/);
  assert.match(retire, /const sourceIdentity = proof\?\.sourceIdentity \|\| '';/);
});

test('a card with no exact id is still never retired', () => {
  assert.match(retire, /if \(!sourceIdentity && !entryUuid\) continue;/,
    'without an exact id there is nothing to match and the card must stay');
});

test('matching stays exact — no text, no timestamp', () => {
  assert.match(retire, /historyEntryHasExactIdentity\(entry, sourceIdentity\)/);
  assert.match(retire, /historyEntryHasExactIdentity\(entry, entryUuid\)/);
  for (const forbidden of ['.content', 'timestamp', 'startsWith', 'includes(']) {
    assert.ok(!retire.includes(forbidden),
      'retirement must not compare by ' + forbidden);
  }
});

test('the real 03.11 shape retires through the queue identity', () => {
  // The attachment row as the parser projects it: role user, the attachment's
  // own uuid, and the sourceIdentity inherited from the consumed queue item.
  const identity = 'claude-queue:offset:be82a19d-4a26-4263-b32a-e91477e1cd17:44182311';
  const visibleRow = { uuid: '72c64b51-6973-4356-8745-f211d386d8af', role: 'user', sourceIdentity: identity };
  // The card's audit never saw that uuid; its queue proof holds the identity.
  assert.equal(historyEntryHasExactIdentity(visibleRow, identity), true,
    'sourceIdentity alone already matches this row');
  assert.equal(historyEntryHasExactIdentity(visibleRow, 'some-audit-uuid'), false,
    'and the audit uuid alone does not — which is why the card survived');
});

test('a foreign row is not retired by a neighbouring identity', () => {
  const row = { uuid: 'other', role: 'user', sourceIdentity: 'claude-queue:offset:S:1' };
  assert.equal(historyEntryHasExactIdentity(row, 'claude-queue:offset:S:2'), false);
});

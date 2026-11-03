// A clickable link whose address was truncated.
//
// 02.11, session da3b72ff, tab 8c1ef183: an assistant wrote an iteration link
// in prose and shortened the UUID the way identifiers are shortened for a
// reader:
//
//   written : messageId=dd6da706
//   actual  : dd6da706-fa64-4dde-9ec9-89db97573f97
//
// The codec accepted it — non-empty, no whitespace — so the link rendered blue
// and clickable. Every click walked the whole path (open tab, reveal History,
// search the feed) and ended at `identity-not-in-display`, surfaced as
// "ссылка устарела или цель недоступна". Both halves of that sentence were
// false: the link was minutes old and its target was alive four rows away.
//
// A message id is an opaque app-issued identifier, so it cannot be validated
// by shape in general — Codex uses `codex-user-<session>-<line>`, Claude queue
// rows use `claude-queue:…`. But a TRUNCATED UUID is detectable exactly: bare
// hex-and-dashes that is not a whole UUID. Those are refused at the door, so
// the link is never offered as clickable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as codec from './terminal-message-reference.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const link = messageId => '#noted-message?tabId=T&provider=claude&sessionId=S&messageId='
  + encodeURIComponent(messageId);

test('the exact truncated address from 02.11 is refused', () => {
  assert.equal(codec.readTerminalMessageLink(link('dd6da706')), null);
  // ...while the address it was truncated from still resolves.
  const whole = 'dd6da706-fa64-4dde-9ec9-89db97573f97';
  assert.equal(codec.readTerminalMessageLink(link(whole))?.messageId, whole);
});

test('every partial cut of a UUID is refused, not just the first group', () => {
  const whole = 'dd6da706-fa64-4dde-9ec9-89db97573f97';
  for (const cut of [8, 9, 13, 14, 18, 19, 23, 24, 30, whole.length - 1]) {
    assert.equal(codec.readTerminalMessageLink(link(whole.slice(0, cut))), null,
      'truncated at ' + cut + ': ' + whole.slice(0, cut));
  }
});

test('the identifiers the app actually issues all still resolve', () => {
  // These are not UUIDs and never will be; the guard must not touch them.
  for (const id of [
    'dd6da706-fa64-4dde-9ec9-89db97573f97',          // Claude record UUID
    'codex-user-01a01f10-2c13-7140-8ab9-a6617aabc9d3-42', // Codex synthetic
    'codex-user-exact-42',
    'codex-compact-unknown-7',
    'claude-queue:offset:30ea154d:41443353',          // Claude queue row
    'claude-queue:uuid:dd6da706-fa64-4dde-9ec9-89db97573f97',
    'claude-queue-settlement:uuid:dd6da706-fa64-4dde-9ec9-89db97573f97',
    'source/with+encoded:value',
    'public-user',
    'U',
  ]) {
    assert.equal(codec.readTerminalMessageLink(link(id))?.messageId, id, id);
  }
});

test('a whole UUID is accepted in either case, and a 36-char non-UUID is untouched', () => {
  const upper = 'DD6DA706-FA64-4DDE-9EC9-89DB97573F97';
  assert.equal(codec.readTerminalMessageLink(link(upper))?.messageId, upper);
  // Same length, same dashes, but the groups are not hex — an app-issued key
  // of that shape must keep working.
  const notHex = 'zz6da706-fa64-4dde-9ec9-89db97573f97';
  assert.equal(codec.readTerminalMessageLink(link(notHex))?.messageId, notHex);
});

test('the guard applies to the object codec too, not only to links', () => {
  // The clipboard/HTML snapshot path and the main-process navigation endpoint
  // both go through normalizeTerminalMessageTarget, so a truncated address
  // must not enter through them either.
  const base = { tabId: 'T', provider: 'claude', sessionId: 'S' };
  assert.equal(codec.normalizeTerminalMessageTarget({ ...base, messageId: 'dd6da706' }), null);
  assert.ok(codec.normalizeTerminalMessageTarget({ ...base, messageId: 'dd6da706-fa64-4dde-9ec9-89db97573f97' }));
  assert.equal(codec.terminalMessageLink({ ...base, messageId: 'dd6da706' }), null,
    'a truncated address cannot be re-encoded into a new link either');
});

test('a refused address renders as plain text, never as a clickable promise', () => {
  const source = fs.readFileSync(root + 'src/renderer/components/Workspace/HistoryIterationLink.tsx', 'utf8');
  const span = source.slice(source.indexOf('if (!target)'), source.indexOf('return <a'));
  assert.match(span, /<span/, 'an unresolvable address must not become an anchor');
  assert.match(span, /Неполный или некорректный адрес/,
    'and must say why, instead of claiming the link went stale');
});

test('a failed jump names its actual cause', () => {
  const source = fs.readFileSync(root + 'src/renderer/components/Workspace/HistoryIterationLink.tsx', 'utf8');
  assert.doesNotMatch(source, /ссылка устарела или цель недоступна/,
    'the single catch-all sentence claimed a stale link for every cause');
  assert.match(source, /JUMP_FAILURE_TEXT/);
  // The code the 02.11 click actually produced must have its own wording.
  assert.match(source, /'identity-not-in-display': '[^']+'/);
  const table = source.slice(source.indexOf('JUMP_FAILURE_TEXT'), source.indexOf('export function'));
  for (const code of ['source-session-changed', 'tab_message_source_tab_unavailable',
    'tab_message_source_identity_changed']) {
    assert.ok(table.includes(code), 'missing cause: ' + code);
  }
  assert.match(source, /JUMP_FAILURE_TEXT\[code\] \|\| /, 'an unknown cause still needs a fallback');
});

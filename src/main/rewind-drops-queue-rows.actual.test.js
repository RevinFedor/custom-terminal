'use strict';
// A Rewind left the prompt-queue rows of the removed stretch behind.
//
// 02.11, session da3b72ff: the rewind removed the target iteration and its
// future, but six `queue-operation` rows written during that stretch stayed in
// the file. History draws an `enqueue` row as a `queued` message, so the user
// saw a block of their own texts in a row with no iteration between them — and
// no iteration could exist, because those prompts were never sent (every one
// of the fourteen had no matching user record; most were followed by `remove`).
//
// Why the existing passes missed them: the range is computed over the active
// branch and the orphan pass follows `parentUuid`. A queue row has neither a
// uuid nor a parent, so nothing could ever select it. Its only ordering is the
// timestamp, which is what the cut uses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'ipc', 'claude-data.js'), 'utf8');
const assembly = (() => {
  const start = source.indexOf('const cutFromTs');
  const anchor = source.indexOf('const outputLines = []');
  const end = source.indexOf('const survivingUuidCount', anchor > 0 ? anchor : 0);
  assert.ok(start > 0 && anchor > 0 && end > anchor, 'output assembly not found');
  return source.slice(Math.min(start, anchor), end);
})();

test('queue rows inside the removed stretch are dropped', () => {
  assert.match(assembly, /\['queue-operation', 'last-prompt'\]\.includes\(rec\.type\)/,
    'both queue bookkeeping kinds must be considered');
  assert.match(assembly, /queueRowsDropped\+\+; continue;/,
    'a row inside the range must not reach the output');
});

test('the cut point comes from the records actually removed', () => {
  // Not from the requested range bounds: the orphan pass can widen the removal,
  // and a queue row written beside a cascaded record belongs to the same stretch.
  assert.match(assembly, /removeUuids\.has\(rec\.uuid\)/);
  assert.match(assembly, /earliest === null \|\| at < earliest/,
    'the earliest removed timestamp is the boundary');
});

test('rows before the cut are kept', () => {
  assert.match(assembly, /at >= cutFromTs/,
    'only rows at or after the boundary are dropped, never earlier queue history');
});

test('an unreadable or absent timestamp keeps the row', () => {
  assert.match(assembly, /Number\.isFinite\(at\) &&/,
    'a row whose position cannot be proven must survive, not be guessed away');
  assert.match(assembly, /cutFromTs !== null/,
    'a rewind that removed nothing datable must not drop queue rows at all');
});

test('rows that carry a uuid keep the existing uuid-based rules', () => {
  assert.match(assembly, /!rec\.uuid && cutFromTs !== null/,
    'the timestamp rule applies only to rows the uuid passes cannot reach');
  // The original guards must still run first.
  assert.match(assembly, /if \(rec\.uuid && removeUuids\.has\(rec\.uuid\)\) continue;/);
  assert.match(assembly, /rangeStart === 0 && rec\.type === 'last-prompt'/,
    'the clean-slate rule for a delete-from-start is unchanged');
});

test('the drop is reported', () => {
  assert.match(source, /Dropped ' \+ queueRowsDropped \+ ' prompt-queue rows/,
    'a silent removal of user-visible rows would be unexplainable afterwards');
});

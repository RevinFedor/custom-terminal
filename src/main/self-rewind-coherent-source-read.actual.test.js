'use strict';
// A self rewind failed at `stale_transcript_revision` during PREPARE, before
// Stop, with the rewrite never attempted.
//
// E2E 02.11, isolated stand, tab 215d81406552, operation e2e-rewind-iter2-v3:
//
//   accepted  → ok:true, toolType claude, expectedContentRevision null
//   prepare   → "saved-history:step: stale_transcript_revision"
//   failed    → historyMutated false, bindingCommitted false
//
// `loadOperationSource` read the chain, then re-read each file exactly, and
// demanded that both describe identical bytes. For a SELF rewind the process
// appending to that file IS the session issuing the rewind: it is mid-turn, so
// the two reads legitimately disagree. That is not corruption, and before Stop
// it is the expected state — the file is supposed to be growing.
//
// The repair keeps the guarantee and drops the false failure: the read is
// retried until it is coherent, so what the caller receives is still one
// snapshot whose topology describes its own bytes. A topology problem
// (`stale_transcript_topology`) still fails immediately, and an append that
// keeps winning the race still ends in `stale_transcript_revision`. The checks
// that actually protect the rewrite run after Stop, when the file is frozen.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const file = path.join(__dirname, 'ipc', 'claude-data.js');
const source = fs.readFileSync(file, 'utf8');
const body = (() => {
  const start = source.indexOf('_api.loadOperationSource = async function');
  assert.ok(start > 0, 'loadOperationSource not found');
  const end = source.indexOf('_api.deleteRange = async function', start);
  assert.ok(end > start, 'end anchor not found');
  return source.slice(start, end);
})();

test('a source that grew mid-read is re-read, not failed', () => {
  assert.match(body, /COHERENT_READ_ATTEMPTS/, 'the read must be retryable');
  assert.match(body, /for \(let attempt = 1; attempt <= COHERENT_READ_ATTEMPTS/);
  // The old code threw on the first disagreement; nothing may do that now.
  // Measured on code only — the explanation above the loop names the error.
  const code = body.slice(0, body.indexOf('for (let attempt'))
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /throw[\s\S]{0,120}stale_transcript_revision/,
    'no unconditional failure may precede the retry loop');
});

test('the chain is re-resolved on each attempt, not just the file', () => {
  // Re-reading only the bytes would compare fresh bytes against a stale
  // topology for ever: the mismatch is BETWEEN the two reads.
  const loop = body.slice(body.indexOf('for (let attempt'));
  assert.match(loop, /resolveSessionChain\(sessionId, cwd\)/,
    'resolveSessionChain must run inside the loop');
});

test('what is returned is still one coherent snapshot', () => {
  assert.match(body, /if \(!conflict\) \{/,
    'a snapshot is only accepted when its topology matches its own bytes');
  assert.match(body, /source\.size !== exact\.size \|\| source\.mtimeMs !== exact\.mtimeMs/,
    'the byte/topology agreement check itself must survive');
  assert.match(body, /loaded\.revision = claudeMutationRevision\(loaded\)/);
  assert.match(body, /assertClaudeMutationCurrent\(loaded/,
    'the current-source assertion must still run on the accepted snapshot');
});

test('a topology problem still fails immediately', () => {
  // stale_transcript_topology means the chain itself moved — a different file,
  // or a parent link that changed. Retrying that would hide a real defect.
  assert.match(body, /error\?\.code !== 'stale_transcript_revision'/,
    'only a revision conflict may be retried');
  assert.match(body, /throw error;/, 'anything else is rethrown as-is');
});

test('a source that keeps growing still reports the conflict', () => {
  const loop = body.slice(body.indexOf('for (let attempt'));
  assert.match(loop, /attempt === COHERENT_READ_ATTEMPTS/,
    'the last attempt must surface the failure rather than loop for ever');
  assert.ok((loop.match(/stale_transcript_revision/g) || []).length >= 2,
    'exhaustion must still produce stale_transcript_revision');
});

test('a missing session file is still a plain failure, never retried', () => {
  assert.match(body, /return \{ success: false, error: 'Session file not found' \}/,
    'an absent file is a different outcome from a racing one');
});

test('the retry is bounded and observable', () => {
  assert.match(body, /setTimeout\(resolve, 60 \* attempt\)/,
    'successive attempts must back off, not spin');
  assert.match(body, /\[ClaudeOperationSource\]/,
    'a retry must be visible in the log, so a slow prepare can be explained');
});

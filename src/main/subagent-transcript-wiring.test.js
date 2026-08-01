/**
 * Wiring guard for the subagent-transcript helpers.
 *
 * Scar 2026-07-29 (production tab-1005): `isAgentFinishedByOwnTranscript` was
 * exported by the module and CALLED in main.js, but never listed in main.js's
 * destructuring import. Nothing failed at load time — the ReferenceError fired
 * only when a real Codex turn produced a `task_complete`, i.e. exactly at the
 * moment the turn was supposed to finish. The throw propagated out of the
 * per-line handler into the rollout scanner, which aborted the scan; the
 * terminating event was therefore never read and the tab spun for nine
 * minutes with a live loader and an empty subagent strip.
 *
 * The user-visible bug ("the loader never stops") pointed nowhere near
 * subagents, so the cheap structural check below is worth far more than its
 * size: every helper main.js calls by bare name must actually be imported.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_PATH = path.join(__dirname, 'main.js');
const MODULE_NAME = 'subagent-transcript';

const readMainSource = () => fs.readFileSync(MAIN_PATH, 'utf8');

/** Names main.js pulls out of the subagent-transcript module. */
const importedNames = (source) => {
  const pattern = new RegExp(
    'const\\s*\\{([^}]*)\\}\\s*=\\s*require\\([^)]*' + MODULE_NAME + '[^)]*\\)',
  );
  const match = source.match(pattern);
  if (!match) return null;
  return match[1]
    .split(',')
    .map((part) => part.split(':')[0].trim())
    .filter(Boolean);
};

test('every subagent-transcript helper main.js calls is actually imported', () => {
  const source = readMainSource();
  const imported = importedNames(source);
  assert.ok(imported, 'main.js must import from ' + MODULE_NAME);

  const exported = Object.keys(require('./subagent-transcript'));
  const missing = exported.filter((name) => {
    // Called as a bare function somewhere in main.js…
    const called = new RegExp('(^|[^.\\w])' + name + '\\s*\\(', 'm').test(source);
    // …but absent from the import list.
    return called && !imported.includes(name);
  });

  assert.deepEqual(
    missing,
    [],
    'main.js calls these helpers without importing them: ' + missing.join(', '),
  );
});

test('isAgentFinishedByOwnTranscript is imported — it gates turn completion', () => {
  // Singled out because its absence had no load-time symptom and only fired
  // on `task_complete`: the one event whose loss keeps a turn busy forever.
  const imported = importedNames(readMainSource()) || [];
  assert.ok(
    imported.includes('isAgentFinishedByOwnTranscript'),
    'the subagent sweep runs on task_complete; an unbound name there stalls the turn',
  );
});

test('subagent bookkeeping cannot abort rollout line processing', () => {
  // The sweep reads OTHER agents' files and can fail for reasons unrelated to
  // this turn. Whatever it throws must not escape into the scanner, or the
  // terminating event of the current turn is never read.
  const source = readMainSource();
  const call = source.indexOf('trackCodexTabSubagentActivity(state, record);');
  assert.ok(call > 0, 'the per-line subagent tracking call must exist');

  const before = source.slice(Math.max(0, call - 400), call);
  const after = source.slice(call, call + 400);
  assert.ok(
    /try\s*\{[^}]*$/.test(before) && /catch\s*\(/.test(after),
    'trackCodexTabSubagentActivity must be wrapped so a failure degrades the '
      + 'subagent strip only, never the turn lifecycle',
  );
});

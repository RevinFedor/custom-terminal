/**
 * A background cell id may only come from Codex's own announcement line —
 * never from prose that happens to quote it.
 *
 * Prod scar 2026-07-31 (tab-2634, «команда sed крутится вечно»):
 *
 *   1. A command's output contained our OWN documentation sentence:
 *      «Orchestrated `exec` может вернуть `Script running with cell ID N`».
 *   2. The parser matched `[^\s]+` anywhere in that output and captured the
 *      cell id "N`," — a fragment of the quoted markdown.
 *   3. The live projection therefore filed the card away as BACKGROUND work
 *      under an id no `wait {cell_id}` could ever name, so its result never
 *      reattached: 809 live tool cards opened against 808 closed.
 *   4. The single orphan kept its spinner. The user saw whatever command was
 *      on screen (`sed`) spinning forever, on a tab whose turn had long since
 *      finished — the tab looked "active" with nothing running.
 *
 * The asymmetry that matters: a MISSED announcement is cheap (the card stays
 * inline and settles normally), a FALSE one strands the card forever. So the
 * rule is deliberately strict — its own line, digits only.
 */

const test = require('node:test');
const assert = require('node:assert');

const { _api } = require('./ipc/codex-data');
const { codexHistoryCellId } = _api;

/**
 * The real call site passes the tool's raw output straight through, so the
 * tests do the same. Codex sends it either as a plain string or as the
 * content-part array below.
 */
const output = (text) => text;
const parts = (text) => [{ type: 'output_text', text }];

test('a real announcement on its own line is accepted', () => {
  assert.equal(codexHistoryCellId(output('Script running with cell ID 268')), '268');
});

test('the announcement is found among ordinary output lines', () => {
  const text = [
    'Wall time: 0.4s',
    'Script running with cell ID 42',
    'Output:',
  ].join('\n');
  assert.equal(codexHistoryCellId(output(text)), '42');
});

test('prose quoting the phrase mid-sentence is NOT an announcement', () => {
  // The exact text that caused the scar.
  const text = 'Orchestrated `exec` может вернуть `Script running with cell ID N`, '
    + 'а итог прийти следующим прямым `wait {cell_id:N}`.';
  assert.equal(codexHistoryCellId(output(text)), null);
});

test('a literal N is not a cell id even on its own line', () => {
  assert.equal(codexHistoryCellId(output('Script running with cell ID N')), null);
});

test('an id glued to trailing punctuation is rejected', () => {
  // "268`," is what quoting produces; accepting it would strand the card.
  assert.equal(codexHistoryCellId(output('Script running with cell ID 268`,')), null);
});

test('documentation embedded in a file the agent printed does not match', () => {
  const fileDump = [
    '## Как работает фоновая ячейка',
    '',
    'Команда может ответить `Script running with cell ID N`, и тогда',
    'результат придёт отдельным `wait`.',
  ].join('\n');
  assert.equal(codexHistoryCellId(output(fileDump)), null);
});

test('missing or empty output yields no id', () => {
  assert.equal(codexHistoryCellId(output('')), null);
  assert.equal(codexHistoryCellId(undefined), null);
});

test('the content-part form behaves identically', () => {
  // Codex sends output either as a string or as content parts; the rule must
  // not depend on which transport carried it.
  assert.equal(codexHistoryCellId(parts('Script running with cell ID 268')), '268');
  assert.equal(
    codexHistoryCellId(parts('вернёт `Script running with cell ID N`, а итог')),
    null,
  );
});

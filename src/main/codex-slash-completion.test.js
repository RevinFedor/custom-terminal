'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inspectCodexSlashCompletionDismissal,
  inspectCodexSlashCompletionSnapshot,
  parseSlashCommandToken,
} = require('./codex-slash-completion');

function frame({ draft = '/compact', suggestions = true } = {}) {
  const promptRow = 21;
  return {
    success: true,
    authoritativeFrameCommitted: true,
    writeSeq: 8,
    flushedSeq: 8,
    codexCursorComposer: {
      row: promptRow,
      text: draft,
      hasDraft: true,
      cursorOwned: true,
    },
    lines: [
      { row: promptRow, text: '› ' + draft },
      { row: promptRow + 1, text: '' },
      ...(suggestions ? [{
        row: promptRow + 2,
        text: '  /compact  summarize conversation to prevent hitting the',
        hasNonDefaultFg: true,
      }] : []),
      { row: promptRow + 3, text: '  gpt-5.6-sol max · Context 12% used', hasNonDefaultFg: true },
    ],
  };
}

test('recognizes the slash completion owned by the current Codex composer', () => {
  const result = inspectCodexSlashCompletionSnapshot(frame());
  assert.equal(result.visible, true);
  assert.equal(result.draftText, '/compact');
  assert.deepEqual(result.suggestionRows.map((row) => row.command), ['/compact']);
});

test('recognizes a matching completion for a partial slash command', () => {
  const snapshot = frame({ draft: '/comp' });
  const result = inspectCodexSlashCompletionSnapshot(snapshot);
  assert.equal(result.visible, true);
  assert.equal(result.suggestionRows[0].command, '/compact');
});

test('does not mistake ordinary drafts or unstyled transcript text for completion', () => {
  assert.equal(inspectCodexSlashCompletionSnapshot(frame({ draft: 'hello' })).visible, false);
  const transcriptLike = frame();
  transcriptLike.lines[2].hasNonDefaultFg = false;
  assert.equal(inspectCodexSlashCompletionSnapshot(transcriptLike).visible, false);
  assert.equal(parseSlashCommandToken('/compact later'), null);
});

test('dismissal succeeds only after suggestions disappear and the draft remains exact', () => {
  const closed = inspectCodexSlashCompletionDismissal(
    frame({ suggestions: false }),
    '/compact',
  );
  assert.equal(closed.dismissed, true);
  assert.equal(closed.draftPreserved, true);

  const changed = inspectCodexSlashCompletionDismissal(
    frame({ draft: '/status', suggestions: false }),
    '/compact',
  );
  assert.equal(changed.dismissed, true);
  assert.equal(changed.draftPreserved, false);
});

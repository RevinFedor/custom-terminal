import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findLastCodexComposerPromptIndex,
  hasCodexComposerPromptGlyph,
} from './codexComposerGlyphs.mjs';

for (const glyph of ['›', '❯', '»']) {
  test(`renderer draft grammar recognizes ${glyph}`, () => {
    assert.equal(hasCodexComposerPromptGlyph(`${glyph} draft`), true);
  });
}

test('renderer draft grammar excludes ASCII shell redirects', () => {
  assert.equal(hasCodexComposerPromptGlyph('echo foo > output.txt'), false);
});

test('renderer draft grammar selects the latest supported marker', () => {
  const text = '  › old text\n\t» new prompt';
  assert.equal(findLastCodexComposerPromptIndex(text), text.indexOf('»'));
});

test('renderer draft grammar ignores Russian guillemets inside ordinary text', () => {
  const draft = '› Исправь кнопку «Старт» сейчас';
  assert.equal(findLastCodexComposerPromptIndex(draft), 0);
  assert.equal(hasCodexComposerPromptGlyph('Обычная строка: «готово»'), false);
});

import grammar from '../../shared/codex-tui-grammar.json' with { type: 'json' };

export const CODEX_COMPOSER_PROMPT_GLYPHS = Object.freeze([
  ...grammar.composerPromptGlyphs,
]);

const glyphPattern = CODEX_COMPOSER_PROMPT_GLYPHS
  .map((glyph) => glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const composerPromptLineSource = `(?:^|\\n)([\\t ]*)(${glyphPattern})(?=\\s|$)`;
export const CODEX_COMPOSER_PROMPT_GLYPH_RE = new RegExp(composerPromptLineSource, 'u');

export function hasCodexComposerPromptGlyph(text) {
  return CODEX_COMPOSER_PROMPT_GLYPH_RE.test(String(text || ''));
}

export function findLastCodexComposerPromptIndex(text) {
  const value = String(text || '');
  let latest = -1;
  const matcher = new RegExp(composerPromptLineSource, 'gu');
  for (const match of value.matchAll(matcher)) {
    const glyph = match[2] || '';
    latest = match.index + match[0].lastIndexOf(glyph);
  }
  return latest;
}

'use strict';

// Display-only inline Markdown web images and ChatGPT's favicon links share
// one grammar in browser authoring, Copy/Paste and synchronous Main transport.
// No fetch/import, attachment identity or new Markdown transport is created.
function collectPromptWebImageReferences(text = '') {
  const value = String(text || '');
  const candidate = /(?<!\\)(?:!\[([^\]\r\n]*)\]|\[(image)\])\([ \t]*(<?https?:\/\/)/gi;
  const result = [];
  let match;
  while ((match = candidate.exec(value)) !== null) {
    const angle = match[3][0] === '<';
    const urlStart = candidate.lastIndex - match[3].length + (angle ? 1 : 0);
    let cursor = urlStart, depth = 0;
    const limit = Math.min(value.length, urlStart + 8192);
    for (; cursor < limit; cursor += 1) {
      const char = value[cursor];
      if (char === '\\' && cursor + 1 < limit && !/[\r\n]/.test(value[cursor + 1])) { cursor += 1; continue; }
      if (/[\r\n]/.test(char) || (angle ? char === '>' : /\s/.test(char))) break;
      if (!angle && char === '(') depth += 1;
      if (!angle && char === ')') { if (depth === 0) break; depth -= 1; }
    }
    const urlEnd = cursor;
    if (cursor >= limit) { candidate.lastIndex = cursor; continue; }
    if (depth > 0 || urlEnd === urlStart) continue;
    if (angle) { if (value[cursor] !== '>') continue; cursor += 1; }
    const beforeSpace = cursor;
    while (cursor < limit && /[ \t]/.test(value[cursor])) cursor += 1;
    if (cursor > beforeSpace && /["']/.test(value[cursor] || '')) {
      const quote = value[cursor++];
      while (cursor < limit && value[cursor] !== quote && !/[\r\n]/.test(value[cursor])) {
        if (value[cursor] === '\\') cursor += 1;
        cursor += 1;
      }
      if (value[cursor] !== quote) continue;
      cursor += 1;
      while (cursor < limit && /[ \t]/.test(value[cursor])) cursor += 1;
    }
    if (cursor >= limit || value[cursor] !== ')') continue;
    const end = cursor + 1;
    result.push({ start: match.index, end, source: value.slice(match.index, end),
      url: value.slice(urlStart, urlEnd), alt: match[1] || match[2] || 'image' });
    candidate.lastIndex = end;
  }
  return result;
}

function mapPromptImageAuthoringText(text, map) {
  const value = String(text || '');
  const references = collectPromptWebImageReferences(value);
  if (references.length === 0) return map(value);
  let cursor = 0, result = '';
  for (const reference of references) {
    result += map(value.slice(cursor, reference.start)) + reference.source;
    cursor = reference.end;
  }
  return result + map(value.slice(cursor));
}

// Diagnostics and range consumers keep exact original UTF-16 coordinates.
function maskPromptWebImageReferences(text) {
  const value = String(text || '');
  const references = collectPromptWebImageReferences(value);
  let cursor = 0, masked = '';
  for (const reference of references) {
    masked += value.slice(cursor, reference.start) + ' '.repeat(reference.end - reference.start);
    cursor = reference.end;
  }
  return masked + value.slice(cursor);
}

// Infer occurrences only for legacy raw text. A typed image part is stronger
// authoring and must not be masked again by a downstream consumer.
function collectLegacyPromptImageRanges(text) {
  const source = String(text || '');
  return Array.from(maskPromptWebImageReferences(source).matchAll(/\[imagePath:\s*([^\]\r\n]+?)\s*\]/gi))
    .filter(match => match[1].trim().startsWith('/'))
    .map(match => ({ start: match.index, end: match.index + match[0].length, path: match[1] }));
}

module.exports = { collectPromptWebImageReferences, mapPromptImageAuthoringText,
  maskPromptWebImageReferences, collectLegacyPromptImageRanges };

'use strict';

// Two observed carrier forms: app-authored bare tags and Claude's native
// opaque-id tags (the closing tag repeats the same id). An id is presentation
// syntax, NEVER a send/attempt identity or permission to normalize other text.
const OPEN = /^<pasted_content(?: id="([A-Za-z0-9_-]{1,128})")?>/u;
const CLOSE = /^<\/pasted_content(?: id="([A-Za-z0-9_-]{1,128})")?>/u;

function trimStructuralNewlines(text) {
  let body = text;
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\r\n')) body = body.slice(0, -2);
  else if (body.endsWith('\n')) body = body.slice(0, -1);
  return body;
}

function findPastedContentEnvelope(value, fromIndex = 0) {
  const text = String(value || '');
  const opening = /<pasted_content(?=[\s>])/gu;
  opening.lastIndex = Math.max(0, Number(fromIndex) || 0);
  const at = opening.exec(text);
  if (!at) return null;
  const start = at.index;
  const open = OPEN.exec(text.slice(start));
  const invalid = { start, contentStart: null, contentEnd: null, end: null,
    id: open?.[1] || null, valid: false, body: null };
  if (!open) return invalid;
  const contentStart = start + open[0].length;
  const closing = /<\/pasted_content(?=[\s>])/gu;
  closing.lastIndex = contentStart;
  const endAt = closing.exec(text);
  if (!endAt) return invalid;
  const close = CLOSE.exec(text.slice(endAt.index));
  // Do not skip a foreign closing tag to find a more convenient later one:
  // doing so would swallow another message/block into this pasted content.
  if (!close || (open[1] || null) !== (close[1] || null)) return invalid;
  return { start, contentStart, contentEnd: endAt.index,
    end: endAt.index + close[0].length, id: open[1] || null, valid: true,
    body: trimStructuralNewlines(text.slice(contentStart, endAt.index)) };
}

module.exports = { findPastedContentEnvelope };

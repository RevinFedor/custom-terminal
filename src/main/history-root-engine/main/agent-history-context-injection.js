'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_PATH_RE_SOURCE = String.raw`\[imagePath:\s*([^\]\r\n]+?)\s*\]`;
const MAX_EMBEDDED_IMAGE_BYTES = 25 * 1024 * 1024;
// Claude needs a non-empty assistant boundary after an injected user record;
// otherwise Resume materializes a visible synthetic "No response requested."
// turn. U+2063 is non-empty for the provider while remaining visually empty in
// the raw TUI. Only the exact app-owned model + text + stop_reason tuple is
// hidden from History/Timeline; ordinary user/model content is never filtered.
const CLAUDE_HISTORY_CONTEXT_ACK_TEXT = '\u2063';
const CLAUDE_HISTORY_CONTEXT_ACK_MODEL = '<synthetic>';

function imageMediaType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  return null;
}

function protectedPromptRanges(text) {
  const ranges = [];
  const wrapper = /<(pasted_content|saved_prompt)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
  let match;
  while ((match = wrapper.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  const open = /<(pasted_content|saved_prompt)(?:\s[^>]*)?>/gi;
  while ((match = open.exec(text)) !== null) {
    if (!ranges.some((range) => match.index >= range.start && match.index < range.end)) {
      ranges.push({ start: match.index, end: text.length });
    }
  }
  return ranges;
}

function splitHistoryContextPrompt(prompt, { imagePaths = [] } = {}) {
  const text = String(prompt || '');
  const refsByPath = new Map();
  for (const ref of Array.isArray(imagePaths) ? imagePaths : []) {
    const filePath = typeof ref?.path === 'string' ? ref.path.trim() : '';
    if (!filePath) continue;
    const queue = refsByPath.get(filePath) || [];
    queue.push(ref);
    refsByPath.set(filePath, queue);
  }
  if (refsByPath.size === 0) return [{ kind: 'text', text }];
  const protectedRanges = protectedPromptRanges(text);
  const matcher = new RegExp(IMAGE_PATH_RE_SOURCE, 'gi');
  const segments = [];
  let cursor = 0;
  let match;
  while ((match = matcher.exec(text)) !== null) {
    const filePath = String(match[1] || '').trim();
    const inProtectedWrapper = protectedRanges.some((range) => (
      match.index >= range.start && match.index < range.end
    ));
    const availableRefs = refsByPath.get(filePath) || [];
    if (inProtectedWrapper || availableRefs.length === 0) continue;
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, match.index) });
    }
    const ref = availableRefs.shift();
    segments.push({ kind: 'image', path: filePath, id: Number(ref?.id) || null });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  const missing = Array.from(refsByPath.values()).flat();
  if (missing.length > 0) {
    const error = new Error('history_context_image_marker_mismatch');
    error.code = 'history_context_image_marker_mismatch';
    throw error;
  }
  if (segments.length === 0) segments.push({ kind: 'text', text });
  return segments;
}

async function readHistoryContextImage(filePath) {
  const candidate = String(filePath || '').trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    const error = new Error('history_context_image_path_invalid');
    error.code = 'history_context_image_path_invalid';
    throw error;
  }
  const mediaType = imageMediaType(candidate);
  if (!mediaType) {
    const error = new Error('history_context_image_type_unsupported');
    error.code = 'history_context_image_type_unsupported';
    throw error;
  }
  const stat = await fs.promises.stat(candidate).catch(() => null);
  if (!stat?.isFile()) {
    const error = new Error('history_context_image_missing');
    error.code = 'history_context_image_missing';
    throw error;
  }
  if (stat.size > MAX_EMBEDDED_IMAGE_BYTES) {
    const error = new Error('history_context_image_too_large');
    error.code = 'history_context_image_too_large';
    throw error;
  }
  const bytes = await fs.promises.readFile(candidate);
  return {
    path: candidate,
    mediaType,
    data: bytes.toString('base64'),
    dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
    size: bytes.length,
  };
}

async function buildClaudeHistoryContextContent(prompt, options = {}) {
  const segments = splitHistoryContextPrompt(prompt, options);
  if (!segments.some((segment) => segment.kind === 'image')) {
    return String(prompt || '');
  }
  const content = [];
  for (const segment of segments) {
    if (segment.kind === 'text') {
      if (segment.text) content.push({ type: 'text', text: segment.text });
      continue;
    }
    const image = await readHistoryContextImage(segment.path);
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.data,
      },
    });
  }
  return content;
}

async function buildCodexHistoryContextItem(prompt, itemId, options = {}) {
  const id = String(itemId || '').trim();
  if (!id) throw new TypeError('itemId must be a non-empty string');
  const content = [];
  for (const segment of splitHistoryContextPrompt(prompt, options)) {
    if (segment.kind === 'text') {
      if (segment.text) content.push({ type: 'input_text', text: segment.text });
      continue;
    }
    const image = await readHistoryContextImage(segment.path);
    content.push({ type: 'input_image', image_url: image.dataUrl });
  }
  if (content.length === 0) content.push({ type: 'input_text', text: '' });
  return {
    type: 'message',
    id,
    role: 'user',
    content,
  };
}

module.exports = {
  CLAUDE_HISTORY_CONTEXT_ACK_MODEL,
  CLAUDE_HISTORY_CONTEXT_ACK_TEXT,
  MAX_EMBEDDED_IMAGE_BYTES,
  buildClaudeHistoryContextContent,
  buildCodexHistoryContextItem,
  imageMediaType,
  readHistoryContextImage,
  splitHistoryContextPrompt,
};

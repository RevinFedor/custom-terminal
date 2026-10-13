import { buildHistoryComposerPresentationParts } from './composerChips.mjs';

const plural = new Intl.PluralRules('ru');
const lineWord = n => ({ one: 'строка', few: 'строки', many: 'строк', other: 'строки' })[plural.select(n)];
const MAX_JSON_CLASSIFICATION_CHARS = 250000;

function codeFence(code, language) {
  let size = 3;
  for (const match of code.matchAll(/`{3,}/g)) size = Math.max(size, match[0].length + 1);
  const fence = '`'.repeat(size);
  return `${fence}${language}\n${code}\n${fence}`;
}

function inspectJson(text) {
  if (text.length > MAX_JSON_CLASSIFICATION_CHARS || !/^[{[]/.test(text)) return null;
  try { return { language: 'json', first: JSON.parse(text) }; } catch { /* Try JSONL. */ }
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return null;
  try {
    let first;
    for (let i = 0; i < lines.length; i++) {
      const value = JSON.parse(lines[i]);
      if (i === 0) first = value;
    }
    return { language: 'jsonl', first };
  } catch { return null; }
}

// A literal textual field is a useful excerpt, not an inferred verdict or a
// generated summary. Inspect only the first record, never walk the whole tree.
function jsonExcerpt(value) {
  if (Array.isArray(value)) value = value[0];
  const from = object => object && typeof object === 'object'
    ? ['summary', 'reason', 'message'].map(key => object[key]).find(text => typeof text === 'string' && text.trim())
    : null;
  const own = from(value);
  if (own) return own;
  if (value && typeof value === 'object') for (const key of ['items', 'results', 'records']) {
    if (Array.isArray(value[key])) {
      const first = from(value[key][0]);
      if (first) return first;
    }
  }
  return null;
}

/** Display only. Never execute provider JSX/HTML, or rewrite the stored answer.
 * Recognize a COMPLETE, exact CodeBlock wrapper/fence; quoted/in-text/malformed
 * wrappers stay literal Markdown. JSON classification is bounded and memoized
 * by the callers, not repeated on hover or modifier changes. */
export function researchResultPresentation(value) {
  const text = typeof value === 'string' ? value : '';
  const trimmed = text.trim();
  const wrapper = /^<CodeBlock\s+language=("|')([\w#+.-]{1,32})\1\s+editable=\{false\}\s*>([\s\S]*)<\/CodeBlock>$/.exec(trimmed);
  const escapedJson = /^<escape>([\s\S]*)<\/escape>$/.exec(trimmed);
  const fence = /^(`{3,}|~{3,})([\w#+.-]{0,32})[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\1$/.exec(trimmed);
  let language = null, code = null, displayText = text, json = null;
  if (wrapper && !/<\/?CodeBlock\b/.test(wrapper[3])) {
    language = wrapper[2].toLowerCase(); code = wrapper[3].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  } else if (fence) {
    language = fence[2].toLowerCase() || 'text'; code = fence[3];
  } else if (escapedJson) {
    // A saved provider wrapper, never HTML/JSX. Only a complete JSON/JSONL
    // payload may lose this wrapper in display; raw text/Copy stay unchanged.
    json = inspectJson(escapedJson[1].trim());
    language = json?.language || null;
    if (language) code = escapedJson[1].trim();
  } else if (!wrapper && !fence) {
    json = inspectJson(trimmed);
    language = json?.language || null;
    if (language) code = trimmed;
  }
  if (!json && code !== null && ['json', 'jsonl', 'ndjson'].includes(language)) json = inspectJson(code.trim());
  if (code !== null) displayText = codeFence(code, language);
  const lineCount = (code === null ? text : code).split(/\r?\n/).length;
  const format = language === 'json' ? 'JSON' : ['jsonl', 'ndjson'].includes(language) ? 'JSONL'
    : language ? language.toUpperCase() : null;
  const summary = format ? `${format} · ${lineCount.toLocaleString('ru-RU')} ${lineWord(lineCount)}` : null;
  // Do not render a huge hidden Markdown/code DOM just to clamp its first
  // three lines. Stop before the first fenced block; disclose the whole body.
  const firstFence = text.search(/^(?:`{3,}|~{3,})/m);
  const prose = firstFence < 0 ? text : text.slice(0, firstFence);
  const excerpt = code === null ? prose.trim() || (firstFence >= 0 ? 'Answer with code' : '')
    : jsonExcerpt(json?.first) || code.trim().replace(/\s+/g, ' ');
  const preview = excerpt.trim().slice(0, 800);
  return { language, format, summary, lineCount, displayText, code,
    previewText: preview + (excerpt.trim().length > 800 ? '…' : ''),
    needsDisclosure: !!language || firstFence >= 0 || text.length > 800 || text.split(/\r?\n/).length > 3 };
}

/** Existing audited offsets/hash are the authority. The helper consumes that
 * projector's result; wrapper text alone must NEVER classify a user as SC.
 * Deferred prompt/image context before the envelope retains its chips, while
 * reserved-looking strings INSIDE the answer remain code/text, not chips. */
export function researchReplyFromProjection(entry, service, projected) {
  if (service?.runKind !== 'external-research' || !['completion', 'failure'].includes(service.phase)
    || !projected?.projected || projected.questionReply
    || !Number.isSafeInteger(service.bodyStart) || !Number.isSafeInteger(service.bodyEnd)
    || !Number.isSafeInteger(service.envelopeStart)) return null;
  const body = entry.content.slice(service.bodyStart, service.bodyEnd);
  const prefix = entry.content.slice(0, service.envelopeStart);
  const prefixParts = buildHistoryComposerPresentationParts({ text: prefix,
    chips: entry.promptChips, imagePaths: entry.imagePaths }).parts;
  return { ...researchResultPresentation(body), failed: service.phase === 'failure', prefixParts,
    parts: [...prefixParts, { kind: 'text', text: body }] };
}

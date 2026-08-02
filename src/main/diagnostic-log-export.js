const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');

const DEFAULT_MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const HEADER_RESERVE_BYTES = 32 * 1024;
const MAX_PROBLEM_DESCRIPTION_CHARS = 8000;
const LOG_TIMESTAMP_RE = /^(\d{2}:\d{2}:\d{2}\.\d{3}) date=(\d{4}-\d{2}-\d{2})\b/;

const TEXT_FIELD_NAMES = [
  'content',
  'prompt',
  'promptPreview',
  'fullPrompt',
  'userText',
  'assistantText',
  'responseText',
  'draft',
  'draftText',
  'selectedText',
  'inputText',
  'outputText',
  'preview',
];
const TEXT_FIELD_PATTERN = TEXT_FIELD_NAMES.join('|');
// Plain key=value log fields can contain multiple quoted messages separated by
// pipes. Once a content-bearing field begins, redact the remainder of the log
// line so a second fragment cannot escape the first quoted-value match.
const TEXT_KV_RE = new RegExp(`\\b(${TEXT_FIELD_PATTERN})=.*$`, 'gi');
const TEXT_JSON_RE = new RegExp(`("(?:${TEXT_FIELD_PATTERN})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi');

function parseLogTimestamp(line) {
  const match = typeof line === 'string' ? line.match(LOG_TIMESTAMP_RE) : null;
  if (!match) return null;
  const timestamp = Date.parse(`${match[2]}T${match[1]}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function replaceAndCount(value, pattern, replacement, stats) {
  return value.replace(pattern, (...args) => {
    stats.redactions += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
}

function createDiagnosticSanitizer({ includeMessageText = false } = {}) {
  const stats = { redactions: 0, textRedactions: 0, secretRedactions: 0 };
  let insidePrivateKey = false;

  const sanitizeLine = (input) => {
    let line = String(input ?? '');

    if (insidePrivateKey) {
      stats.redactions += 1;
      stats.secretRedactions += 1;
      if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) insidePrivateKey = false;
      return null;
    }

    const privateKeyIndex = line.search(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
    if (privateKeyIndex >= 0) {
      insidePrivateKey = true;
      stats.redactions += 1;
      stats.secretRedactions += 1;
      line = `${line.slice(0, privateKeyIndex)}[REDACTED PRIVATE KEY BLOCK]`;
    }

    const beforeSecrets = stats.redactions;
    line = replaceAndCount(
      line,
      /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi,
      (_match, key) => `${key}=<redacted>`,
      stats,
    );
    line = replaceAndCount(
      line,
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      (_match, scheme) => `${scheme} <redacted>`,
      stats,
    );
    line = replaceAndCount(
      line,
      /\b((?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|GITHUB|GH|AWS|SONIOX|ASSEMBLYAI|PERPLEXITY)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      (_match, key) => `${key}=<redacted>`,
      stats,
    );
    line = replaceAndCount(
      line,
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd)\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      (_match, key) => `${key}=<redacted>`,
      stats,
    );
    line = replaceAndCount(
      line,
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth|password|secret|signature)=)[^&\s]+/gi,
      '$1<redacted>',
      stats,
    );
    line = replaceAndCount(line, /\bsk-[A-Za-z0-9_-]{12,}\b/g, '<redacted-api-key>', stats);
    line = replaceAndCount(line, /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, '<redacted-github-token>', stats);
    line = replaceAndCount(line, /\bAIza[0-9A-Za-z_-]{20,}\b/g, '<redacted-google-key>', stats);
    line = replaceAndCount(line, /\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>', stats);
    line = replaceAndCount(line, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted-jwt>', stats);
    stats.secretRedactions += stats.redactions - beforeSecrets;

    if (!includeMessageText) {
      const beforeText = stats.redactions;
      line = replaceAndCount(
        line,
        TEXT_JSON_RE,
        (_match, prefix) => `${prefix}"<redacted-message-text>"`,
        stats,
      );
      line = replaceAndCount(
        line,
        TEXT_KV_RE,
        (_match, key) => `${key}=<redacted-message-text>`,
        stats,
      );
      stats.textRedactions += stats.redactions - beforeText;
    }

    return line;
  };

  return {
    sanitizeLine,
    getStats: () => ({ ...stats }),
  };
}

function sanitizeProblemDescription(value) {
  const description = typeof value === 'string'
    ? value.trim().slice(0, MAX_PROBLEM_DESCRIPTION_CHARS)
    : '';
  const sanitizer = createDiagnosticSanitizer({ includeMessageText: true });
  const lines = [];

  for (const line of description.split(/\r?\n/)) {
    const sanitized = sanitizer.sanitizeLine(line);
    if (sanitized !== null) lines.push(sanitized);
  }

  return {
    text: lines.join('\n').trim(),
    stats: sanitizer.getStats(),
  };
}

class BoundedLogBuffer {
  constructor(maxBytes) {
    this.maxBytes = Math.max(1024, maxBytes);
    this.records = [];
    this.head = 0;
    this.bytes = 0;
    this.droppedLines = 0;
  }

  push(line) {
    let record = `${line}\n`;
    let bytes = Buffer.byteLength(record, 'utf8');
    if (bytes > this.maxBytes) {
      const suffix = '\n[... oversized diagnostic line truncated ...]\n';
      const budget = Math.max(256, this.maxBytes - Buffer.byteLength(suffix, 'utf8'));
      record = `${Buffer.from(record, 'utf8').subarray(bytes - budget).toString('utf8')}${suffix}`;
      bytes = Buffer.byteLength(record, 'utf8');
      this.droppedLines += 1;
    }
    while (this.head < this.records.length && this.bytes + bytes > this.maxBytes) {
      const removed = this.records[this.head];
      this.head += 1;
      this.bytes -= removed.bytes;
      this.droppedLines += 1;
    }
    if (this.head > 4096 && this.head * 2 > this.records.length) {
      this.records = this.records.slice(this.head);
      this.head = 0;
    }
    if (bytes <= this.maxBytes) {
      this.records.push({ record, bytes });
      this.bytes += bytes;
    }
  }

  *values() {
    for (let index = this.head; index < this.records.length; index += 1) {
      yield this.records[index];
    }
  }

  get length() {
    return this.records.length - this.head;
  }
}

async function collectSourceLines({
  sourcePath,
  fromMs,
  toMs,
  sanitizer,
  buffer,
  sourceLabel,
}) {
  let sourceLines = 0;
  let selectedLines = 0;
  let includeContinuation = false;
  let sourceStarted = false;
  let pendingSessionHeader = null;

  const input = fs.createReadStream(sourcePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    sourceLines += 1;
    const timestamp = parseLogTimestamp(line);
    if (timestamp !== null) {
      includeContinuation = timestamp >= fromMs && timestamp <= toMs;
      if (!includeContinuation) continue;

      if (!sourceStarted) {
        buffer.push(`=== ${sourceLabel} ===`);
        if (pendingSessionHeader) buffer.push(pendingSessionHeader);
        sourceStarted = true;
      }
      const sanitized = sanitizer.sanitizeLine(line);
      if (sanitized !== null) buffer.push(sanitized);
      selectedLines += 1;
      continue;
    }

    if (/^--- Session /.test(line)) {
      pendingSessionHeader = line;
      if (includeContinuation && sourceStarted) buffer.push(line);
      continue;
    }

    if (includeContinuation && sourceStarted) {
      const sanitized = sanitizer.sanitizeLine(line);
      if (sanitized !== null) buffer.push(sanitized);
    }
  }

  return { sourceLines, selectedLines };
}

async function writeWithBackpressure(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

function buildHeader({
  generatedAt,
  appVersion,
  environment,
  fromMs,
  toMs,
  problemDescription,
  includeMessageText,
  sources,
  selectedLines,
  droppedLines,
  sanitizerStats,
}) {
  return [
    'Noted Terminal diagnostics',
    '',
    '--- USER REPORT ---',
    problemDescription || '[Not provided]',
    '',
    '--- DIAGNOSTIC METADATA ---',
    `Generated: ${generatedAt}`,
    `Application version: ${appVersion || 'unknown'}`,
    `Environment: ${environment}`,
    `Time range (UTC): ${new Date(fromMs).toISOString()} -> ${new Date(toMs).toISOString()}`,
    `Message text from logs: ${includeMessageText ? 'included' : 'redacted'}`,
    `Source logs: ${sources.length ? sources.join(', ') : 'none found'}`,
    `Selected timestamped lines: ${selectedLines}`,
    `Redactions: ${sanitizerStats.redactions} (secrets: ${sanitizerStats.secretRedactions}, message text: ${sanitizerStats.textRedactions})`,
    `Oldest lines dropped by size limit: ${droppedLines}`,
    '',
    'Technical terminal frames may contain visible terminal text because they are required to diagnose startup and recovery failures.',
    'Full Claude/Codex session transcripts are not attached by this export.',
    '',
    '--- LOG ---',
    '',
  ].join('\n');
}

async function exportDiagnosticLog({
  sourcePaths,
  destinationPath,
  fromMs,
  toMs = Date.now(),
  problemDescription = '',
  includeMessageText = false,
  appVersion = 'unknown',
  environment = 'production',
  maxBytes = DEFAULT_MAX_EXPORT_BYTES,
}) {
  if (!destinationPath || typeof destinationPath !== 'string') throw new Error('destinationPath is required');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) throw new Error('Invalid diagnostic time range');

  const existingSources = [];
  for (const sourcePath of sourcePaths || []) {
    if (typeof sourcePath !== 'string') continue;
    try {
      const stat = await fs.promises.stat(sourcePath);
      if (stat.isFile()) existingSources.push(sourcePath);
    } catch {}
  }

  const sanitizer = createDiagnosticSanitizer({ includeMessageText });
  const dataBudget = Math.max(1024, maxBytes - HEADER_RESERVE_BYTES);
  const buffer = new BoundedLogBuffer(dataBudget);
  let scannedLines = 0;
  let selectedLines = 0;

  for (const sourcePath of existingSources) {
    const stats = await collectSourceLines({
      sourcePath,
      fromMs,
      toMs,
      sanitizer,
      buffer,
      sourceLabel: path.basename(sourcePath),
    });
    scannedLines += stats.sourceLines;
    selectedLines += stats.selectedLines;
  }

  if (selectedLines === 0) buffer.push('[No log lines found in the selected time range]');

  const logSanitizerStats = sanitizer.getStats();
  const sanitizedProblemDescription = sanitizeProblemDescription(problemDescription);
  const sanitizerStats = {
    redactions: logSanitizerStats.redactions + sanitizedProblemDescription.stats.redactions,
    textRedactions: logSanitizerStats.textRedactions + sanitizedProblemDescription.stats.textRedactions,
    secretRedactions: logSanitizerStats.secretRedactions + sanitizedProblemDescription.stats.secretRedactions,
  };
  const generatedAt = new Date().toISOString();
  const header = buildHeader({
    generatedAt,
    appVersion,
    environment,
    fromMs,
    toMs,
    problemDescription: sanitizedProblemDescription.text,
    includeMessageText,
    sources: existingSources.map((sourcePath) => path.basename(sourcePath)),
    selectedLines,
    droppedLines: buffer.droppedLines,
    sanitizerStats,
  });

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.partial-${process.pid}-${Date.now()}`;
  const output = fs.createWriteStream(tempPath, { encoding: 'utf8', flags: 'wx' });

  try {
    await writeWithBackpressure(output, `${header}\n`);
    if (buffer.droppedLines > 0) {
      await writeWithBackpressure(output, `[... ${buffer.droppedLines} older lines omitted to keep the TXT bounded ...]\n\n`);
    }
    for (const item of buffer.values()) await writeWithBackpressure(output, item.record);
    output.end();
    await once(output, 'finish');
    await fs.promises.rename(tempPath, destinationPath);
  } catch (error) {
    output.destroy();
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  const stat = await fs.promises.stat(destinationPath);
  return {
    filePath: destinationPath,
    bytes: stat.size,
    scannedLines,
    selectedLines,
    exportedLines: buffer.length,
    droppedLines: buffer.droppedLines,
    redactions: sanitizerStats,
    sourceFiles: existingSources,
  };
}

module.exports = {
  DEFAULT_MAX_EXPORT_BYTES,
  createDiagnosticSanitizer,
  exportDiagnosticLog,
  parseLogTimestamp,
};

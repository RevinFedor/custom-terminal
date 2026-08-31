'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_CONTEXT_FILES = 16;
const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 8;
const INCLUDE_LINE_RE = /^<!-- @include: (.+?) -->$/;
const CONTEXT_FILE_CLOSE = '</context_file>';
const CONTEXT_FILE_CLOSE_ESCAPED = '<\\/context_file>';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function contextFileError(code, message, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function normalizeContextFileRefs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw contextFileError('invalid_context_files', 'files must be an array');
  }
  if (value.length > MAX_CONTEXT_FILES) {
    throw contextFileError(
      'context_file_count_exceeded',
      `files cannot contain more than ${MAX_CONTEXT_FILES} items`,
      413,
    );
  }

  const seen = new Set();
  return value.flatMap((item) => {
    const descriptor = typeof item === 'string'
      ? { path: clean(item), role: 'source', label: '' }
      : {
        path: clean(item?.path),
        role: clean(item?.role) || 'source',
        label: clean(item?.label || item?.name),
      };
    if (!descriptor.path) {
      throw contextFileError('invalid_context_file', 'each file needs a path');
    }
    if (!path.isAbsolute(descriptor.path)) {
      throw contextFileError(
        'context_file_path_not_absolute',
        `context file path must be absolute: ${descriptor.path}`,
      );
    }
    if (descriptor.role !== 'source' && descriptor.role !== 'instructions') {
      throw contextFileError(
        'invalid_context_file_role',
        `context file role must be source or instructions: ${descriptor.path}`,
      );
    }
    const key = `${descriptor.role}\0${path.normalize(descriptor.path)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [descriptor];
  });
}

async function inspectReadableFile(requestedPath) {
  let canonicalPath;
  try {
    canonicalPath = await fs.promises.realpath(requestedPath);
  } catch (error) {
    throw contextFileError(
      'context_file_unavailable',
      `context file is unavailable: ${requestedPath}`,
      404,
      { cause: error },
    );
  }

  let stat;
  try {
    stat = await fs.promises.stat(canonicalPath);
  } catch (error) {
    throw contextFileError(
      'context_file_unavailable',
      `context file is unavailable: ${requestedPath}`,
      404,
      { cause: error },
    );
  }
  if (!stat.isFile()) {
    throw contextFileError(
      'context_file_not_regular',
      `context file must be a regular file: ${requestedPath}`,
    );
  }
  return { canonicalPath, stat };
}

async function readUtf8File(requestedPath, budget, limits) {
  const { canonicalPath, stat } = await inspectReadableFile(requestedPath);
  if (stat.size > limits.maxFileBytes) {
    throw contextFileError(
      'context_file_too_large',
      `context file exceeds ${limits.maxFileBytes} bytes: ${canonicalPath}`,
      413,
      { filePath: canonicalPath, size: stat.size },
    );
  }
  if (budget.bytes + stat.size > limits.maxTotalBytes) {
    throw contextFileError(
      'context_files_too_large',
      `context files exceed ${limits.maxTotalBytes} total bytes`,
      413,
      { filePath: canonicalPath, size: stat.size },
    );
  }

  let buffer;
  try {
    buffer = await fs.promises.readFile(canonicalPath);
  } catch (error) {
    throw contextFileError(
      'context_file_unavailable',
      `context file could not be read: ${canonicalPath}`,
      404,
      { cause: error },
    );
  }
  if (buffer.byteLength > limits.maxFileBytes) {
    throw contextFileError(
      'context_file_too_large',
      `context file exceeds ${limits.maxFileBytes} bytes: ${canonicalPath}`,
      413,
      { filePath: canonicalPath, size: buffer.byteLength },
    );
  }
  if (budget.bytes + buffer.byteLength > limits.maxTotalBytes) {
    throw contextFileError(
      'context_files_too_large',
      `context files exceed ${limits.maxTotalBytes} total bytes`,
      413,
      { filePath: canonicalPath, size: buffer.byteLength },
    );
  }
  budget.bytes += buffer.byteLength;
  if (buffer.includes(0)) {
    throw contextFileError(
      'context_file_binary_unsupported',
      `binary context files are not supported yet: ${canonicalPath}`,
      415,
      { filePath: canonicalPath },
    );
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw contextFileError(
      'context_file_encoding_unsupported',
      `context file must be UTF-8 text: ${canonicalPath}`,
      415,
      { filePath: canonicalPath, cause: error },
    );
  }
  return { canonicalPath, text, bytes: buffer.byteLength };
}

function stripIncludedFrontmatter(text) {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 3);
  return end < 0 ? text : text.slice(end + 5);
}

async function expandInstructionIncludes(text, currentFilePath, depth, seen, budget, limits) {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw contextFileError(
      'context_file_include_depth_exceeded',
      `context file include depth exceeds ${MAX_INCLUDE_DEPTH}: ${currentFilePath}`,
    );
  }
  const lines = text.split('\n');
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(INCLUDE_LINE_RE);
    if (!match) {
      result.push(line);
      continue;
    }

    if (lines[index + 1] === '<!-- BEGIN TRANSCLUDE -->') {
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor] !== '<!-- END TRANSCLUDE -->') cursor += 1;
      index = cursor;
    }

    const includePath = path.resolve(path.dirname(currentFilePath), match[1].trim());
    const included = await readUtf8File(includePath, budget, limits);
    if (seen.has(included.canonicalPath)) {
      throw contextFileError(
        'context_file_include_cycle',
        `context file include cycle: ${included.canonicalPath}`,
      );
    }
    const nextSeen = new Set(seen);
    nextSeen.add(included.canonicalPath);
    result.push(await expandInstructionIncludes(
      stripIncludedFrontmatter(included.text),
      included.canonicalPath,
      depth + 1,
      nextSeen,
      budget,
      limits,
    ));
  }
  return result.join('\n');
}

async function resolveInstructionText(file, budget, limits) {
  const seen = new Set([file.canonicalPath]);
  const expanded = await expandInstructionIncludes(
    file.text,
    file.canonicalPath,
    0,
    seen,
    budget,
    limits,
  );
  return expanded
    .replace(/<!--\s*@ai:[\s\S]*?-->\n?/g, '')
    .replace(/^<!-- @include: .+? -->\n?/gm, '')
    .replace(/^<!-- (?:BEGIN|END) TRANSCLUDE -->\n?/gm, '');
}

function escapeAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function buildContextFileWrapper(file) {
  const body = String(file?.text || '')
    .split(CONTEXT_FILE_CLOSE)
    .join(CONTEXT_FILE_CLOSE_ESCAPED);
  const attrs = [
    `name="${escapeAttribute(file?.label || path.basename(file?.filePath || '') || 'FILE')}"`,
    `path="${escapeAttribute(file?.filePath || '')}"`,
    `role="${file?.role === 'instructions' ? 'instructions' : 'source'}"`,
    `sha256="${escapeAttribute(file?.sha256 || '')}"`,
    `bytes="${Math.max(0, Number(file?.bytes) || 0)}"`,
  ];
  return `<context_file ${attrs.join(' ')}>\n${body}\n${CONTEXT_FILE_CLOSE}`;
}

function prependContextFileChips(prompt, files) {
  const task = String(prompt || '');
  const wrappers = (Array.isArray(files) ? files : []).map(buildContextFileWrapper);
  return [...wrappers, ...(task ? [task] : [])].join('\n\n');
}

async function resolveContextFileRefs({
  refs,
  maxFileBytes = MAX_CONTEXT_FILE_BYTES,
  maxTotalBytes = MAX_CONTEXT_TOTAL_BYTES,
} = {}) {
  const normalized = normalizeContextFileRefs(refs);
  const limits = {
    maxFileBytes: Math.max(1, Number(maxFileBytes) || MAX_CONTEXT_FILE_BYTES),
    maxTotalBytes: Math.max(1, Number(maxTotalBytes) || MAX_CONTEXT_TOTAL_BYTES),
  };
  const budget = { bytes: 0 };
  const files = [];
  for (const [index, descriptor] of normalized.entries()) {
    const raw = await readUtf8File(descriptor.path, budget, limits);
    const text = descriptor.role === 'instructions'
      ? await resolveInstructionText(raw, budget, limits)
      : raw.text;
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const bytes = Buffer.byteLength(text, 'utf8');
    files.push({
      id: `context-file-${sha256.slice(0, 16)}-${index}`,
      kind: 'prompt',
      attachmentKind: 'file',
      label: descriptor.label || path.basename(raw.canonicalPath) || 'FILE',
      text,
      sourceKey: `context-file:${descriptor.role}:${raw.canonicalPath}:${sha256}`,
      filePath: raw.canonicalPath,
      role: descriptor.role,
      sha256,
      bytes,
    });
  }
  return files;
}

module.exports = {
  CONTEXT_FILE_CLOSE,
  CONTEXT_FILE_CLOSE_ESCAPED,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TOTAL_BYTES,
  buildContextFileWrapper,
  normalizeContextFileRefs,
  prependContextFileChips,
  resolveContextFileRefs,
};

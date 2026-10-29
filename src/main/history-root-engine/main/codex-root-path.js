'use strict';
const path = require('node:path');
const text = require('./history-paged-text');
const ops = require('./history-root-operations');
const { normalizeWin32PatchPath } = require('./codex-root-win32-path');

// Codex rollout paths on the supported desktop are POSIX paths. Preserve the
// existing path.normalize(absolute) / path.resolve(cwd, relative) distinction,
// including the former's trailing slash. Components and output stay on pages.
function normalizePatchPath(filePath, cwd) {
  const value = text.coerce(filePath || '').trim();
  if (!value) return '';
  const arena = ops.arenaOf(value, cwd);
  if (!arena) return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value));
  if (path.sep !== '/') return normalizeWin32PatchPath(value, cwd, arena);
  const absolute = value.startsWith('/');
  let source = value;
  if (!absolute) {
    let base = cwd || process.cwd();
    if (!text.isText(base)) throw new TypeError('The cwd argument must be a string');
    if (!base.startsWith('/')) base = text.concat([process.cwd(), '/', base], '', arena);
    source = text.concat([base, '/', value], '', arena);
  }
  const parts = arena.make('array');
  for (const part of text.splitLiteral(source, '/')) {
    if (!part || text.equal(part, '.')) continue;
    if (text.equal(part, '..')) { if (parts.length) parts.pop(); }
    else parts.push(part);
  }
  const body = text.concat(parts, '/', arena);
  return text.concat(['/', body, body && absolute && value.endsWith('/') ? '/' : ''], '', arena);
}
module.exports = { normalizePatchPath };

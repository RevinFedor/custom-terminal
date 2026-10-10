import {
  classifyHistoryAction, effectiveBashWord, extractBashSubject,
  historyActionPresentationMeta, tokenizeCommand,
} from '../../shared/history-action-grammar.mjs';

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'Update']);

// jq's first positional argument is a program, not a file. The headline
// grammar can call `.items` path-like; do not turn that filter into navigation.
function jqHasFileOperand(command, target) {
  const unquote = value => value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  const tokens = tokenizeCommand(command).map(unquote);
  const start = tokens.findIndex(value => value.split('/').pop() === 'jq');
  const positional = [], files = [];
  let fromFile = false;
  const arity = { '--arg': 2, '--argjson': 2, '--slurpfile': 2, '--rawfile': 2,
    '--argfile': 2, '-L': 1 };
  for (let i = start + 1; start >= 0 && i < tokens.length; i++) {
    const value = tokens[i];
    if (['|', '||', '&&', ';'].includes(value)) break;
    if (value === '-f' || value === '--from-file') {
      files.push(tokens[++i]); fromFile = true;
    } else if (arity[value]) {
      if (['--slurpfile', '--rawfile', '--argfile'].includes(value)) files.push(tokens[i + 2]);
      i += arity[value];
    } else if (!value.startsWith('-')) positional.push(value);
  }
  return [...files, ...positional.slice(fromFile ? 0 : 1)].includes(target);
}

/** A display basename is never a file address. Reuse the same structural
 * grammar that produced the row; no output/body parsing or payload read. */
export function historyFileActionMenuPayload(action, cwd, { path, pathToFileURL, homeDir } = {}) {
  const args = action?.args || {};
  const toolName = String(action?.toolName || '');
  let target = '';
  const shell = toolName === 'Bash';
  if (FILE_TOOLS.has(toolName)) {
    target = args.file_path || args.path || '';
  } else if (shell) {
    const classified = classifyHistoryAction(action);
    const family = action.family || classified.family;
    const word = action.bashWord || classified.bashWord || effectiveBashWord(args.command);
    if (family === 'read' || family === 'git') {
      target = extractBashSubject(args.command, family, word).subject;
      if (word === 'jq' && !jqHasFileOperand(args.command, target)) return null;
    } else if (family === 'edit') {
      target = historyActionPresentationMeta(action).fileEditTarget || '';
    }
  }
  if (typeof target !== 'string' || !target || target.length > 4096
    || /[\u0000-\u001f\u007f]/.test(target) || /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return null;
  // A shell pattern/unresolved expression is not one concrete file. Native
  // file arguments can contain literal $, #, brackets or spaces and keep them.
  if (shell && /[$`*?\[\]{}…]/.test(target)) return null;
  if (!path || typeof pathToFileURL !== 'function') return null;
  if (target === '~' || target.startsWith('~/')) {
    if (!homeDir || !path.isAbsolute(homeDir)) return null;
    target = path.resolve(homeDir, target.slice(2));
  }
  let base = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null;
  const workdir = shell ? args.workdir || args.cwd : null;
  if (typeof workdir === 'string' && workdir) {
    if (/[\u0000-\u001f$`]/.test(workdir)) return null;
    if (workdir === '~' || workdir.startsWith('~/')) {
      if (!homeDir || !path.isAbsolute(homeDir)) return null;
      base = path.resolve(homeDir, workdir.slice(2));
    } else base = path.isAbsolute(workdir) ? workdir : base ? path.resolve(base, workdir) : null;
  }
  if (!path.isAbsolute(target)) {
    if (!base) return null;
    // The shared subject grammar does not certify an in-command directory
    // change. Do not open a same-named file in the panel's unrelated cwd.
    if (shell && /(?:^|[;&\n])\s*cd\s/.test(String(args.command || ''))) return null;
    target = path.resolve(base, target);
  }
  return { href: pathToFileURL(target).href, editorFirst: true };
}

export function dispatchHistoryFileActionContextMenu(event, action, cwd, environment) {
  const payload = historyFileActionMenuPayload(action, cwd, environment);
  if (!payload || typeof environment?.send !== 'function') return false;
  // An unavailable IPC must not eat the old entry/browser context menu.
  try { environment.send('show-markdown-link-context-menu', payload); }
  catch { return false; }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

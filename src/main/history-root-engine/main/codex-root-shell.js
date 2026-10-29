'use strict';

// The classifier's existing shell grammar, with range captures, paged aliases,
// and one token/stage at a time. Display/renderer grammar is not rerouted.
const text = require('./history-paged-text');
const rx = require('./history-paged-pattern');
const { accumulator } = require('./codex-root-js-text');
const { BASH_EDIT_WORDS, bashFamily } = require('../shared/history-action-grammar.cjs');
const REDIRECT_WORDS = new Set(['cat', 'echo', 'printf', 'tee']);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const same = text.equal;
const coerce = value => text.coerce(value || '');
function baseName(value) {
  let last = -1;
  for (let at = value.indexOf('/'); at >= 0; at = value.indexOf('/', at + 1)) last = at;
  return value.slice(last + 1);
}
function* stages(command, firstOnly = false) {
  const scan = text.reader(command); let start = 0, quote = '';
  for (let at = 0; at < command.length; at++) {
    const c = scan.at(at);
    if (quote) {
      if (c === '\\' && quote !== "'") { at++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '\\') { at++; continue; }
    if (c === ';' || !firstOnly && c === '\n' || c === '|' || c === '&' && scan.at(at + 1) === '&') {
      const stage = command.slice(start, at);
      if (firstOnly) { yield stage; return; }
      const trimmed = stage.trim(); if (trimmed) yield trimmed;
      if (c === '&') at++;
      start = at + 1;
    }
  }
  const stage = command.slice(start);
  if (firstOnly) yield stage;
  else { const trimmed = stage.trim(); if (trimmed) yield trimmed; }
}
function* tokens(command) {
  const scan = text.reader(command);
  let writer = accumulator(command), length = 0, started = false, quote = '';
  for (let at = 0; at < command.length; at++) {
    const c = scan.at(at);
    if (quote) {
      if (c === '\\' && quote === '"' && at + 1 < command.length) { writer.write(scan.at(++at)); length++; continue; }
      if (c === quote) { quote = ''; continue; }
      writer.write(c); length++; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (/\s/.test(c)) {
      if (started || length) { yield writer.finish(); writer = accumulator(command); length = 0; started = false; }
      continue;
    }
    writer.write(c); length++;
  }
  if (started || length) yield writer.finish();
}
function effectiveWord(command) {
  for (let stage of stages(command)) {
    if (stage.startsWith('#')) continue;
    const scan = text.reader(stage); let begin = 0;
    while (/\s/.test(scan.at(begin) || '')) begin++;
    while (scan.at(begin) === '(') begin++;
    stage = stage.slice(begin);
    for (const token of tokens(stage)) {
      if (rx.test(assignment, token)) continue;
      if (!token) break;
      const word = (baseName(token) || token).toLowerCase();
      if (['cd','echo','true','time','env','command','nohup','exec'].some(name => same(word, name))) break;
      return word;
    }
  }
  return '';
}
function aliasesFor(command, arena) {
  const aliases = arena.make('map');
  for (const stage of stages(command)) {
    let first = true;
    for (const token of tokens(stage)) {
      if (first && same(token, 'export')) { first = false; continue; }
      first = false;
      const match = rx.exec(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/, token);
      if (!match) break;
      if (match[2] && !rx.test(/[`$]/, match[2])) aliases.set(match[1], match[2]);
    }
  }
  return aliases;
}
function resolveTarget(value, aliases) {
  const target = coerce(value).trim();
  const variable = rx.exec(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/, target);
  if (variable) return aliases.get(variable[1] || variable[2]) || '';
  return target.includes('$') || target.includes('`') ? '' : target;
}
function looksLikePath(value) {
  return !!value && !value.startsWith('-') && (value.includes('/') || rx.test(/\.[A-Za-z0-9]{1,6}$/, value));
}
function ephemeral(value) { if (value.startsWith('./')) value = value.slice(2); return value.startsWith('tmp/') || value.startsWith('/tmp/'); }
function pythonEdit(command, word, arena) {
  if (!same(word, 'py') && !rx.test(/^python(?:\d+(?:\.\d+)*)?$/, word)) return { isEdit: false, target: '' };
  const aliases = arena.make('map');
  for (const match of rx.matches(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:(?:pathlib\.)?Path\s*\(\s*)?(?:[rRuUbBfF]{0,2})?(['"])([^'"\r\n]+)\2\s*\)?/g, command)) aliases.set(match[1], match[3]);
  function targetFor(expression) {
    let value = coerce(expression).trim();
    const path = rx.exec(/^(?:pathlib\.)?Path\s*\(\s*([\s\S]+?)\s*\)$/, value);
    if (path) value = path[1].trim();
    const literal = rx.exec(/^(?:[rRuUbBfF]{0,2})?(['"])([^'"\r\n]+)\1$/, value);
    if (literal) return literal[2];
    return rx.test(/^[A-Za-z_][A-Za-z0-9_]*$/, value) ? aliases.get(value) || '' : '';
  }
  let isEdit = false, target = '';
  const remember = value => { isEdit = true; if (!target) target = targetFor(value); };
  for (const match of rx.matches(/\b(?:io\.)?open\s*\(\s*([^,\r\n]+?)\s*,\s*(?:mode\s*=\s*)?(['"])([^'"]*)\2/g, command)) {
    if (rx.test(/[wax+]/i, match[3])) remember(match[1]);
  }
  for (const match of rx.matches(/(?:\b(?:pathlib\.)?Path\s*\(\s*([^)]+?)\s*\)|\b([A-Za-z_][A-Za-z0-9_]*))\s*\.\s*(?:write_text|write_bytes|touch|unlink)\s*\(/g, command)) {
    if (match[1] || aliases.has(match[2])) remember(match[1] || match[2]);
  }
  return { isEdit, target };
}
function sedEdit(command) {
  const iterator = tokens(command); let first = true;
  for (const arg of iterator) {
    if (first && rx.test(assignment, arg)) continue;
    if (first) { first = false; continue; }
    if (same(arg, '--')) break;
    if (same(arg, '--in-place') || arg.startsWith('--in-place=')) return true;
    if (same(arg, '--expression') || same(arg, '--file')) { iterator.next(); continue; }
    if (!arg.startsWith('-') || arg.startsWith('--')) continue;
    const scan = text.reader(arg);
    for (let at = 1; at < arg.length; at++) {
      if (scan.at(at) === 'i') return true;
      if (scan.at(at) === 'e' || scan.at(at) === 'f') { if (at === arg.length - 1) iterator.next(); break; }
    }
  }
  return false;
}
function editInfo(command, word, arena) {
  const python = pythonEdit(command, word, arena);
  if (python.isEdit) return ephemeral(python.target) ? { isEdit: false, target: '' } : python;
  const targetFromArguments = () => {
    let stage = command;
    for (const candidate of stages(command)) {
      const first = tokens(candidate).next().value || '';
      if (same(baseName(first).toLowerCase(), word)) { stage = candidate; break; }
    }
    const end = Math.max(0, command.indexOf(stage)) + stage.length;
    const aliases = aliasesFor(command.slice(0, end), arena);
    let target = '', first = true;
    for (const token of tokens(stage)) {
      if (first) { first = false; continue; }
      const resolved = resolveTarget(token, aliases); if (looksLikePath(resolved)) target = resolved;
    }
    return target;
  };
  if (BASH_EDIT_WORDS.has(word)) {
    const target = targetFromArguments(); return { isEdit: !ephemeral(target), target: ephemeral(target) ? '' : target };
  }
  if (same(word, 'sed')) for (const stage of stages(command)) {
    let program = '';
    for (const token of tokens(stage)) { if (!rx.test(assignment, token)) { program = baseName(token).toLowerCase(); break; } }
    if (!same(program, word) || !sedEdit(stage)) continue;
    let target = '', first = true;
    for (const token of tokens(stage)) {
      if (first && rx.test(assignment, token)) continue;
      if (first) { first = false; continue; }
      if (looksLikePath(token)) target = token;
    }
    return { isEdit: !ephemeral(target), target: ephemeral(target) ? '' : target };
  }
  if (same(word, 'perl') && rx.test(/(?:^|\s)-[A-Za-z]*i[^\s]*(?=\s|$)/, command)) {
    const target = targetFromArguments(); return { isEdit: !ephemeral(target), target: ephemeral(target) ? '' : target };
  }
  if (same(word, 'tee')) { const target = targetFromArguments(); if (target && !ephemeral(target)) return { isEdit: true, target }; }
  const first = tokens(stages(command, true).next().value || '').next().value || '';
  const redirectOwner = word || baseName(first).toLowerCase();
  if (!REDIRECT_WORDS.has(redirectOwner)) return { isEdit: false, target: '' };
  for (const match of rx.matches(/(^|[\s;|&])(\d*)>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g, command)) {
    if (match[2] && !same(match[2], '1')) continue;
    const target = resolveTarget(match[3] || match[4] || match[5] || '', aliasesFor(command.slice(0, match.index), arena));
    if (!target || target.startsWith('&') || rx.test(/^\/dev\/(?:null|stdout|stderr)$/, target) || ephemeral(target)) continue;
    return { isEdit: true, target };
  }
  return { isEdit: false, target: '' };
}
function classifyRootShell(command) {
  const arena = text.info(command)?.arena;
  if (!arena) throw new TypeError('history_shell_paged_text_required');
  const word = effectiveWord(command), edit = editInfo(command, word, arena);
  if (edit.isEdit) return { family: 'edit', bashWord: word || undefined };
  const family = bashFamily(word); let bashDetail;
  if (family === 'git') {
    const match = rx.exec(/\bgit\s+(?:-[^\s]+\s+)*([a-z][a-z-]*)/i, command);
    if (match) bashDetail = match[1].toLowerCase();
  }
  return { family, bashWord: word || undefined, bashDetail };
}
function recoverCommand(command) {
  // Exactly the former three /cmd\s*:\s*QUOTE((?:[^QUOTE\\]|\\.)+)QUOTE/
  // searches, in quote priority order. Unlike a generic backtracker this
  // deterministic quoted run needs no per-character backtracking pages.
  const scan = text.reader(command);
  for (const quote of ['"', "'", '`']) {
    for (let at = command.indexOf('cmd'); at >= 0; at = command.indexOf('cmd', at + 1)) {
      let start = at + 3;
      while (/\s/.test(scan.at(start) || '')) start++;
      if (scan.at(start++) !== ':') continue;
      while (/\s/.test(scan.at(start) || '')) start++;
      if (scan.at(start++) !== quote) continue;
      for (let end = start; end < command.length; end++) {
        const c = scan.at(end);
        if (c === quote) {
          if (end > start) return text.replaceLiteral(command.slice(start, end), '\\n', '\n');
          break;
        }
        if (c === '\\') {
          const escaped = scan.at(++end);
          if (escaped === undefined || /[\n\r\u2028\u2029]/.test(escaped)) break;
        }
      }
    }
  }
  return '';
}
module.exports = { classifyRootShell, effectiveWord, stages, tokens, editInfo, recoverCommand };

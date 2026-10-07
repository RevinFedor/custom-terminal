'use strict';

/**
 * History action grammar — the single classifier both providers' parsers and
 * the renderer's display projection agree on.
 *
 * Families are the unit of series-collapsing in History. Two facts from the
 * production-corpus research (docs/tmp/визуал-history-research-*.md) shape
 * this module:
 *   - 76% of Claude's Bash and 65% of Codex's shell are actually reads and
 *     searches expressed through a shell command, so the shell family MUST be
 *     split by the command's effective first word or the transcript stays a
 *     wall of "BASH";
 *   - MCP calls must never surface the transport name (mcp__server__method);
 *     the server and method are parsed here once, and every consumer renders
 *     the human form.
 *
 * CommonJS on purpose: main requires it directly; the renderer imports it
 * through Vite's CJS interop. One source file, no build step.
 */

const BASH_READ_WORDS = new Set([
  'sed', 'nl', 'cat', 'tail', 'head', 'wc', 'jq', 'awk', 'less', 'more',
  'stat', 'file', 'od', 'xxd', 'strings', 'bat', 'column', 'diff', 'cut',
  'sort', 'uniq', 'comm', 'readlink', 'basename', 'dirname', 'du', 'df',
]);

const BASH_SEARCH_WORDS = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'ls', 'tree', 'which',
  'whereis', 'locate', 'ag',
]);

// Shell HTTP clients are still COMMANDS. Keep the vocabulary exported for
// consumers that need to recognise the program, but never promote curl/wget
// to the provider-owned Web family: they are commonly local API probes.
const BASH_WEB_WORDS = new Set(['curl', 'wget', 'http', 'https', 'httpie']);
const BASH_EDIT_WORDS = new Set(['cp', 'mv', 'rm', 'touch', 'truncate']);
const BASH_REDIRECT_EDIT_WORDS = new Set(['cat', 'echo', 'printf', 'tee']);

/**
 * The literal first token misleads in a quarter of real commands (`cd X && …`,
 * `P=/path node …`, leading `echo` banners). Walk past those wrappers to the
 * word that names what the command actually does.
 */
function effectiveBashWord(command) {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) return '';
  // Use the same quote-aware lexer as presentation. The old hand-written
  // assignment skip treated the first space INSIDE `F="/path with space"`
  // as the end of the value and promoted its tail to a fake executable.
  for (const raw of splitShellStages(text)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const tokens = tokenizeCommand(raw.replace(/^\s*\(+/, ''));
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] || '')) tokens.shift();
    const word = tokens[0] || '';
    if (!word) continue;
    const base = word.split('/').pop() || word;
    const lower = base.toLowerCase();
    if (lower === 'cd' || lower === 'echo' || lower === 'true' || lower === 'time'
      || lower === 'env' || lower === 'command' || lower === 'nohup' || lower === 'exec') {
      continue;
    }
    return lower;
  }
  return '';
}

function literalShellAssignments(command) {
  const aliases = new Map();
  for (const stage of splitShellStages(command)) {
    const tokens = tokenizeCommand(stage);
    let index = tokens[0] === 'export' ? 1 : 0;
    while (index < tokens.length) {
      const token = String(tokens[index] || '');
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
      if (!match) break;
      const value = match[2];
      // Command substitutions and variable-derived paths are runtime values,
      // not exact path evidence.
      if (value && !/[`$]/.test(value)) aliases.set(match[1], value);
      index += 1;
    }
  }
  return aliases;
}

function resolveLiteralShellTarget(value, aliases) {
  const target = String(value || '').trim();
  const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(target);
  if (variable) return aliases.get(variable[1] || variable[2]) || '';
  return target.includes('$') || target.includes('`') ? '' : target;
}

function bashFamily(word) {
  if (!word) return 'run';
  if (word === 'git') return 'git';
  if (BASH_READ_WORDS.has(word)) return 'read';
  if (BASH_SEARCH_WORDS.has(word)) return 'search';
  return 'run';
}

/** Detect a Python invocation that actually mutates a file and recover its
 * target when the script makes that target explicit. Merely running Python is
 * still Run. The edit proof is a write-mode open or a pathlib mutation; text
 * operations such as s.replace() alone are not enough. */
function pythonEditInfo(command, word) {
  const interpreter = String(word || effectiveBashWord(command)).toLowerCase();
  if (interpreter !== 'py' && !/^python(?:\d+(?:\.\d+)*)?$/.test(interpreter)) {
    return { isEdit: false, target: '' };
  }
  const source = String(command || '');
  const aliases = new Map();
  const assignments = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:(?:pathlib\.)?Path\s*\(\s*)?(?:[rRuUbBfF]{0,2})?(['"])([^'"\r\n]+)\2\s*\)?/g;
  let match;
  while ((match = assignments.exec(source)) !== null) aliases.set(match[1], match[3]);

  const resolveTarget = (expression) => {
    let value = String(expression || '').trim();
    const pathCall = value.match(/^(?:pathlib\.)?Path\s*\(\s*([\s\S]+?)\s*\)$/);
    if (pathCall) value = pathCall[1].trim();
    const literal = value.match(/^(?:[rRuUbBfF]{0,2})?(['"])([^'"\r\n]+)\1$/);
    if (literal) return literal[2];
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return aliases.get(value) || '';
    return '';
  };

  let isEdit = false;
  let target = '';
  const remember = (expression) => {
    isEdit = true;
    if (!target) target = resolveTarget(expression);
  };

  const writeOpen = /\b(?:io\.)?open\s*\(\s*([^,\r\n]+?)\s*,\s*(?:mode\s*=\s*)?(['"])([^'"]*)\2/g;
  while ((match = writeOpen.exec(source)) !== null) {
    if (/[wax+]/i.test(match[3])) remember(match[1]);
  }

  const pathWrite = /(?:\b(?:pathlib\.)?Path\s*\(\s*([^)]+?)\s*\)|\b([A-Za-z_][A-Za-z0-9_]*))\s*\.\s*(?:write_text|write_bytes|touch|unlink)\s*\(/g;
  while ((match = pathWrite.exec(source)) !== null) {
    if (match[1] || aliases.has(match[2])) remember(match[1] || match[2]);
  }

  return { isEdit, target };
}

function shellArgumentListsForWord(command, word) {
  const matches = [];
  for (const stage of splitShellStages(command)) {
    const tokens = tokenizeCommand(stage);
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] || '')) tokens.shift();
    const program = (String(tokens[0] || '').split('/').pop() || '').toLowerCase();
    if (program === word) matches.push(tokens.slice(1));
  }
  return matches;
}

function sedArgumentsEdit(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--') break;
    if (arg === '--in-place' || arg.startsWith('--in-place=')) return true;
    if (arg === '--expression' || arg === '--file') { index += 1; continue; }
    if (!arg.startsWith('-') || arg.startsWith('--')) continue;
    const flags = arg.slice(1);
    for (let offset = 0; offset < flags.length; offset += 1) {
      if (flags[offset] === 'i') return true;
      // -e/-f consume a program/file, attached or in the next argv slot.
      // `sed -e '-i'` quotes a program; it does not request an in-place edit.
      if (flags[offset] === 'e' || flags[offset] === 'f') {
        if (offset === flags.length - 1) index += 1;
        break;
      }
    }
  }
  return false;
}

function shellEditInfo(command, word) {
  const python = pythonEditInfo(command, word);
  const isEphemeralTarget = (target) => /^\/?tmp\//.test(String(target || '').replace(/^\.\//, ''));
  if (python.isEdit) return isEphemeralTarget(python.target) ? { isEdit: false, target: '' } : python;
  const text = String(command || '');
  const actingWord = String(word || effectiveBashWord(text)).toLowerCase();
  const targetFromArguments = () => {
    const stage = splitShellStages(text).find((candidate) => {
      const first = tokenizeCommand(candidate)[0] || '';
      return (String(first).split('/').pop() || '').toLowerCase() === actingWord;
    }) || text;
    const stageEnd = Math.max(0, text.indexOf(stage)) + stage.length;
    const shellAliases = literalShellAssignments(text.slice(0, stageEnd));
    const rawTarget = tokenizeCommand(stage).slice(1).reverse().find((token) => (
      looksLikePath(resolveLiteralShellTarget(token, shellAliases))
    )) || '';
    return resolveLiteralShellTarget(rawTarget, shellAliases);
  };

  if (BASH_EDIT_WORDS.has(actingWord)) {
    const target = targetFromArguments();
    return isEphemeralTarget(target) ? { isEdit: false, target: '' } : { isEdit: true, target };
  }
  if (actingWord === 'sed') {
    // Flags belong to this sed invocation, not a later grep -i/echo in the
    // compound script. The same argv owns the displayed target filename.
    for (const args of shellArgumentListsForWord(text, actingWord)) {
      if (sedArgumentsEdit(args)) {
        const target = args.slice().reverse().find(looksLikePath) || '';
        return isEphemeralTarget(target) ? { isEdit: false, target: '' } : { isEdit: true, target };
      }
    }
  }
  if (actingWord === 'perl' && /(?:^|\s)-[A-Za-z]*i[^\s]*(?=\s|$)/.test(text)) {
    const target = targetFromArguments();
    return isEphemeralTarget(target) ? { isEdit: false, target: '' } : { isEdit: true, target };
  }
  if (actingWord === 'tee') {
    const target = targetFromArguments();
    if (target && !isEphemeralTarget(target)) return { isEdit: true, target };
  }

  const firstToken = tokenizeCommand(firstShellStage(text))[0] || '';
  const redirectOwner = actingWord || (String(firstToken).split('/').pop() || '').toLowerCase();
  if (!BASH_REDIRECT_EDIT_WORDS.has(redirectOwner)) return { isEdit: false, target: '' };
  const redirect = /(^|[\s;|&])(\d*)>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let match;
  while ((match = redirect.exec(text)) !== null) {
    if (match[2] && match[2] !== '1') continue;
    const target = resolveLiteralShellTarget(
      String(match[3] || match[4] || match[5] || ''),
      literalShellAssignments(text.slice(0, match.index)),
    );
    if (!target || target.startsWith('&') || /^\/dev\/(?:null|stdout|stderr)$/.test(target)) continue;
    if (isEphemeralTarget(target)) continue;
    return { isEdit: true, target };
  }
  return { isEdit: false, target: '' };
}

/**
 * mcp__server__method → { server, method }. The method drops a repeated
 * server prefix (`electron__electron_evaluate` reads as `evaluate`).
 */
function parseMcpToolName(toolName) {
  const name = String(toolName || '');
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const splitAt = rest.indexOf('__');
  if (splitAt <= 0) return { server: rest || 'mcp', method: '' };
  const server = rest.slice(0, splitAt);
  let method = rest.slice(splitAt + 2);
  const redundantPrefix = server.toLowerCase() + '_';
  if (method.toLowerCase().startsWith(redundantPrefix)) {
    method = method.slice(redundantPrefix.length);
  }
  return { server, method };
}

/**
 * Structural Claude background-shell identity.
 *
 * `Monitor` is background by definition after its tool result accepts the
 * task. Bash/PowerShell are background only when the provider call explicitly
 * says so. Never infer this from result prose: ordinary Read/docs output can
 * quote "running in background" and previously created phantom live work.
 */
function claudeBackgroundToolKind(toolName, args) {
  const name = String(toolName || '');
  if (name === 'Monitor') return 'monitor';
  if ((name === 'Bash' || name === 'PowerShell') && args?.run_in_background === true) {
    return 'bash';
  }
  return null;
}

/**
 * Classify one canonical action into the grouping family. Accepts both
 * Claude's raw tool names and Codex's normalized ones. Explicit
 * mcpServer/mcpMethod (already parsed upstream) win over name parsing.
 *
 * Returns { family, bashWord?, mcpServer?, mcpMethod? }.
 * Families: read | search | git | run | edit | mcp | plan | web | task |
 * question | wait | other.
 */
function classifyHistoryAction({ toolName, args, mcpServer, mcpMethod } = {}) {
  const name = String(toolName || '');
  if (mcpServer) {
    return { family: 'mcp', mcpServer: String(mcpServer), mcpMethod: String(mcpMethod || '') };
  }
  const mcp = parseMcpToolName(name);
  if (mcp) return { family: 'mcp', mcpServer: mcp.server, mcpMethod: mcp.method };
  switch (name) {
    case 'Bash': {
      const word = effectiveBashWord(args?.command);
      const shellEdit = shellEditInfo(args?.command, word);
      if (shellEdit.isEdit) return { family: 'edit', bashWord: word || undefined };
      const family = bashFamily(word);
      // Git subcommand (diff/status/push…) — the collapsed-group digest for
      // the git family; repeating the word "git" both in the verb and the
      // digest is noise (user feedback). Stub-safe: stamped by the parser.
      let bashDetail;
      if (family === 'git' && typeof args?.command === 'string') {
        const match = args.command.match(/\bgit\s+(?:-[^\s]+\s+)*([a-z][a-z-]*)/i);
        if (match) bashDetail = match[1].toLowerCase();
      }
      return { family, bashWord: word || undefined, bashDetail };
    }
    case 'Read':
      return { family: 'read' };
    case 'Grep':
    case 'Glob':
      return { family: 'search' };
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Update':
    // A patch that never applied (Codex: the script building it crashed).
    // It touched no file, so it must not claim one — but it IS an attempt to
    // change files, and leaving it in `other` kept it out of every block, so
    // one failed attempt stood alone between two edit groups.
    case 'Patch':
      return { family: 'edit' };
    case 'MCP':
      // Codex-normalized MCP action without parsed identity.
      return { family: 'mcp', mcpServer: 'mcp', mcpMethod: '' };
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TodoWrite':
    case 'Plan':
      return { family: 'plan' };
    case 'WebSearch':
    case 'WebFetch':
      return { family: 'web' };
    case 'Script':
      // A JS snippet Codex ran in its own sandbox with no tool inside it.
      // It is a run: same class as shell commands, so it never splits the
      // group it sits in (as its own family it used to cut noise runs in two).
      return { family: 'run' };
    case 'Tool Search':
    case 'ToolSearch':
      // Codex's "look what tools exist" — the emptiest noise there is: the
      // text is always the same, it carries nothing for understanding the
      // run. Its own family INSIDE the noise class, so it dissolves into
      // noise containers (header says `Tools ×2`) instead of standing
      // between them and splitting them (seen live: one lone Tool Search cut
      // a noise run into two containers).
      return { family: 'toolsearch' };
    case 'Task':
    case 'Agent':
      return { family: 'task' };
    case 'AskUserQuestion':
    case 'Question':
      return { family: 'question' };
    case 'Wait':
      return { family: 'wait' };
    default:
      return { family: 'other' };
  }
}

/** Canonical TYPE word used by every collapsed History container. */
const FAMILY_LABELS = {
  read: 'Read',
  search: 'Search',
  git: 'Git',
  run: 'Bash',
  edit: 'Edit',
  mcp: 'MCP',
  plan: 'Plan',
  web: 'Web',
  toolsearch: 'Tools',
  task: 'Agent',
  question: 'Question',
  wait: 'Wait',
  other: 'Tool',
};

/**
 * Caption linkage threshold: an assistant text this short, structurally tied
 * to the next tool call (same message id for Claude, commentary-before-call
 * for Codex), renders as the call's headline instead of a standalone
 * paragraph. Longer texts stay paragraphs — they are real narration.
 */
const HISTORY_CAPTION_MAX_CHARS = 600;

// ── Subject extraction ─────────────────────────────────────────────────────
// A row's headline must say WHAT was touched, never HOW it was invoked. The
// literal command (`sed -n '500,560p' src/…`) pushed the only useful token —
// the file name — past the right edge, and repeating it inside the expanded
// body added nothing. These helpers pull the subject out of the command so the
// header can read `READ  …/Storyboard.tsx · 500–560`; the raw command survives
// in the expanded body's dim invocation line for run/git only.

const SHELL_OPTION = /^-/;

/**
 * Search options that CONSUME the next token as their value.
 *
 * grep/rg spell context, limits and globs as «flag value» pairs, so a naive
 * "drop tokens starting with -" leaves the VALUE standing where the pattern
 * should be. Short forms are matched per letter (`-nA` bundles `-n` and `-A`,
 * and the bundle still eats one value), long forms by name.
 */
const SEARCH_VALUE_FLAGS_SHORT = new Set(['A', 'B', 'C', 'm', 'e', 'f', 'g', 'd', 't', 'T']);
const SEARCH_VALUE_FLAGS_LONG = new Set([
  'after-context', 'before-context', 'context', 'max-count', 'regexp', 'file',
  'glob', 'iglob', 'type', 'type-not', 'type-add', 'max-depth', 'maxdepth',
  'threads', 'include', 'exclude', 'exclude-dir', 'color', 'colour', 'replace',
  'sort', 'sortr', 'pre', 'path-separator', 'max-filesize', 'ignore-file',
]);

/**
 * Split a search command's arguments into what the user SEARCHED FOR and the
 * noise around it.
 *
 * Returns `positional` (option values removed) and `flagPattern` — the pattern
 * given explicitly via `-e`/`--regexp`, which outranks position because that
 * is exactly what those flags mean.
 */
function splitSearchArguments(tokens) {
  const positional = [];
  let flagPattern = '';
  let endOfOptions = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '');
    if (endOfOptions || !SHELL_OPTION.test(token) || token === '-') {
      positional.push(token);
      continue;
    }
    if (token === '--') { endOfOptions = true; continue; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).toLowerCase();
      const inlineValue = eq >= 0 ? token.slice(eq + 1) : null;
      if (!SEARCH_VALUE_FLAGS_LONG.has(name)) continue;
      // `--regexp=x` / `--regexp x` — the pattern, stated outright.
      const value = inlineValue !== null ? inlineValue : (i + 1 < tokens.length ? tokens[i += 1] : '');
      if ((name === 'regexp' || name === 'file') && !flagPattern && value) flagPattern = value;
      continue;
    }
    // Short bundle: `-nA`, `-rn`, `-m2` (value glued on).
    const letters = token.slice(1);
    let consumes = '';
    for (let k = 0; k < letters.length; k += 1) {
      const letter = letters[k];
      if (!SEARCH_VALUE_FLAGS_SHORT.has(letter)) continue;
      consumes = letter;
      const glued = letters.slice(k + 1);
      if (glued) {
        if ((letter === 'e' || letter === 'f') && !flagPattern) flagPattern = glued;
        consumes = '';                       // value came glued — nothing to eat
      }
      break;
    }
    if (!consumes) continue;
    const value = i + 1 < tokens.length ? tokens[i += 1] : '';
    if ((consumes === 'e' || consumes === 'f') && !flagPattern && value) flagPattern = value;
  }
  return { positional, flagPattern };
}

/** Strip shell quoting from a single token. */
function unquoteToken(token) {
  const text = String(token || '');
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * Split a command line into tokens, keeping quoted runs intact. Deliberately
 * small: this feeds a headline, not a shell.
 */
function tokenizeCommand(command) {
  const text = String(command || '');
  const out = [];
  let current = '';
  let started = false;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { current += text[i + 1]; i += 1; continue; }
      if (ch === quote) { quote = ''; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || current) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
  }
  if (started || current) out.push(current);
  return out;
}

/** A token that looks like a filesystem path or a file name. */
function looksLikePath(token) {
  const text = String(token || '');
  if (!text || SHELL_OPTION.test(text)) return false;
  if (text.includes('/')) return true;
  return /\.[A-Za-z0-9]{1,6}$/.test(text);
}

/**
 * `sed -n '500,560p'` / `head -n 40` / `tail -50` carry the line window the
 * user actually cares about. Returned as an en-dash range for the headline.
 */
function extractLineRange(word, tokens) {
  for (const token of tokens) {
    const range = String(token).match(/^'?(\d+)\s*,\s*(\d+)\s*p'?$/);
    if (range) return range[1] + '–' + range[2];
  }
  if (word === 'head' || word === 'tail') {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = String(tokens[i]);
      const inline = token.match(/^-n?(\d+)$/);
      if (inline) return (word === 'head' ? 'first ' : 'last ') + inline[1];
      if (token === '-n' && tokens[i + 1] && /^\d+$/.test(String(tokens[i + 1]))) {
        return (word === 'head' ? 'first ' : 'last ') + tokens[i + 1];
      }
    }
  }
  return '';
}

/**
 * The subject of a shell command: the path it works on plus (for reads) the
 * line window. Pipelines keep the FIRST segment's subject — that is the file
 * being read; everything downstream is filtering.
 */
/**
 * First shell stage of a command — split on `|`, `&&`, `;` that are NOT inside
 * quotes.
 *
 * A naive `.split(/\||&&|;/)` cuts inside quoted arguments, and one very
 * common tool carries those characters as DATA: a jq program is one quoted
 * string full of pipes (`jq '.trace | keys, {n:(.e|length)}' file.json`).
 * Cutting at the first inner pipe left the stage as `jq '.trace ` — no path
 * in it — so the header had no subject and the card fell back to printing the
 * whole raw command in grey (user: «серый непонятный текст вместо имени
 * файла»).
 */
function firstShellStage(command) {
  const text = String(command || '');
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote !== "'") { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === ';') return text.slice(0, i);
    if (ch === '|') {
      // `||` is a separator too — both halves are stages.
      return text.slice(0, i);
    }
    if (ch === '&' && text[i + 1] === '&') return text.slice(0, i);
  }
  return text;
}

/**
 * Quote-aware split of a command into its shell stages (`|`, `&&`, `;`,
 * newlines). Separators inside quotes are data — same rule as
 * firstShellStage, applied to the WHOLE command.
 */
function splitShellStages(command) {
  const text = String(command || '');
  const stages = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote !== "'") { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && text[i + 1] === '&')) {
      stages.push(text.slice(start, i));
      if (ch === '&') i += 1;
      start = i + 1;
    }
  }
  stages.push(text.slice(start));
  return stages.map((stage) => stage.trim()).filter(Boolean);
}

function extractBashSubject(command, family, word) {
  const text = String(command || '');
  if (!text.trim()) return { subject: '', detail: '' };
  // The subject lives in the stage the WORD came from — never blindly in
  // stage one. The classifier walks past wrapper stages to find the acting
  // word (`P=file; echo "…"; awk '…' $P | head` classifies as awk), but the
  // extractor used to read stage one regardless, which there is the variable
  // assignment: no subject, and the card fell back to printing the whole raw
  // pipeline in dim grey (live screenshot, five awk walls in a row).
  //
  // Assignments passed on the way are collected so a `$VAR` argument can be
  // resolved to the value it names — `P=~/…/production.log; awk '…' $P` is
  // the model's own shorthand for a long path, and the header exists to show
  // exactly that path.
  const stages = splitShellStages(text);
  const assignments = new Map();
  let stage = null;
  for (const candidate of stages) {
    let lead = '';
    for (const token of tokenizeCommand(candidate)) {
      const assign = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
      if (assign) {
        if (stage === null) assignments.set(assign[1], unquoteToken(assign[2]));
        continue;
      }
      lead = (unquoteToken(token).split('/').pop() || '').toLowerCase();
      break;
    }
    if (stage === null && word && lead === word) stage = candidate;
  }
  if (stage === null) stage = stages[0] || text;
  // A `$VAR` argument resolves through three doors, best first: a value
  // assigned earlier in this same command; `$HOME` (its meaning is fixed —
  // `~` is the standard display for it); any other unknown variable keeps its
  // `$` — corpus audit: `$SP/map-body.txt` with no assignment in sight, and
  // inventing a value would be a lie. Substitution is INSIDE the token, not
  // whole-token: real commands write `"$D/agent.meta.json"`. Depth-limited
  // recursion, because assignment VALUES are themselves shell text —
  // `LOG="$HOME/…/production.log"` needs the inner `$HOME` resolved too
  // (corpus audit: one substitution pass left `$HOME/…` on the header).
  const substituteVars = (value, depth = 0) => String(value).replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    (whole, name) => {
      if (depth < 3 && assignments.has(name)) return substituteVars(assignments.get(name), depth + 1);
      if (name === 'HOME') return '~';
      return whole;
    },
  );
  const tokens = tokenizeCommand(stage).map((token) => substituteVars(unquoteToken(token)));
  const detail = family === 'read' ? extractLineRange(word, tokens) : '';
  if (family === 'git') {
    const path = tokens.slice(2).find((token) => looksLikePath(token) && token !== '--');
    return { subject: path || '', detail: '' };
  }
  if (family === 'search') {
    // The pattern is POSITIONAL: grep/rg take it as the first non-flag
    // argument. Guessing it as "the first token that does not look like a
    // path" broke the common case of searching for a file NAME
    // (`grep "grammar.cjs" src/`): the pattern itself looks like a path, so
    // nothing qualified and the header came out empty (corpus audit).
    //
    // But an option's VALUE is not a positional argument. Dropping only the
    // tokens that start with `-` left `8` from `grep -A 8 "real" file`
    // standing first, so the context SIZE became "the pattern" and the row
    // read «Search 8 · file» — 47 rows in the corpus (1.3% of searches), and
    // worse, two different searches of one file rendered as the same row
    // («нахуй мне search дублировать, если они идут для одного и того же
    // файла»). So options are consumed WITH their value.
    const { positional, flagPattern } = splitSearchArguments(tokens.slice(1));
    const pattern = flagPattern || positional[0] || '';
    const scope = (flagPattern ? positional : positional.slice(1))
      .find((token) => looksLikePath(token)) || '';
    if (word === 'ls' || word === 'find' || word === 'tree' || word === 'fd') {
      return { subject: positional.find((token) => looksLikePath(token)) || pattern, detail: '' };
    }
    return { subject: pattern, detail: scope };
  }
  // Read subject must BE a path. The old fallback took the last argument even
  // when nothing looked like one, which put a jq PROGRAM on the header
  // (`{incidentId:.incident…}`, `"INCIDENT "+.id`) — corpus audit found 13
  // such rows. A read of an unnamed stream has no subject; an empty subject
  // at least falls back honestly.
  const path = tokens.slice(1).reverse().find(looksLikePath) || '';
  if (family === 'read' && path && /[|;{}()+]/.test(path)) return { subject: '', detail };
  return { subject: path, detail };
}

/**
 * Compact subject for a `run` command: the program plus at most two more
 * tokens, and never past the first pipeline/chain separator. `npm run build`
 * survives whole; a 200-character printf/rg/sort chain becomes `printf …`.
 */
function shortRunSubject(command, word) {
  const text = String(command || '').trim();
  if (!text) return '';
  // The subject comes from the first stage that CONTAINS a program — not from
  // stage one unconditionally. `F=/path.jsonl⏎node -e '…'` opens with an
  // assignment-only stage; reading only it produced an empty headline
  // (corpus audit) and the card printed the raw command instead.
  let tokens = [];
  let start = 0;
  for (const stage of splitShellStages(text)) {
    if (stage.trim().startsWith('#')) continue;
    const candidate = tokenizeCommand(stage)
      // A subshell paren is invocation plumbing, not part of any word —
      // unstripped it glued onto the program name («(NOTED_WEB_PORT=1 npx…»,
      // corpus audit) and dragged the assignment into the headline with it.
      .map((token) => String(token).replace(/^\(+/, ''))
      .filter(Boolean);
    let lead = 0;
    while (lead < candidate.length
      && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate[lead]) || candidate[lead] === 'cd')) {
      lead += 1;
    }
    if (lead < candidate.length) { tokens = candidate; start = lead; break; }
  }
  const program = tokens[start] ? unquoteToken(tokens[start]).split('/').pop() : (word || '');
  if (!program) return '';
  const parts = [program];
  for (let i = start + 1; i < parts.length + start + 2 && i < tokens.length; i += 1) {
    const tok = unquoteToken(tokens[i]);
    if (!/^[a-z][a-z0-9-]*$/.test(tok)) break;
    parts.push(tok);
  }
  return parts.join(' ');
}

/** Header path contract shared by native Read/Edit and shell-derived reads.
 * Ordinary source paths collapse to the basename; documentation keeps the
 * useful repository-relative tail beginning at its `docs/` segment. The full
 * path remains presentation identity and expanded-body data. */
function historyDisplayPath(value) {
  const text = String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  if (!text) return '';
  const parts = text.split('/').filter(Boolean);
  if (parts.length === 0) return text;
  const docsIndex = parts.findIndex((part) => part.toLowerCase() === 'docs');
  if (docsIndex >= 0) return parts.slice(docsIndex).join('/');
  return parts[parts.length - 1] || text;
}

/**
 * Headline parts for one action: `{ verb, subject, detail }`.
 *   verb    — one word, the MEANING (Read / Search / Git / Run / Edit / MCP);
 *   subject — what it touched or the semantic program (path, rg, git status);
 *   detail  — secondary qualifier (line range, search scope).
 * Consumers render `verb subject · detail`; nothing here is a raw command.
 */
function historyActionHeadline({ toolName, args, family, bashWord, bashDetail, mcpServer, mcpMethod } = {}) {
  const name = String(toolName || '');
  const fam = String(family || '');
  if (fam === 'mcp' || name === 'MCP' || name.startsWith('mcp__')) {
    const parsed = mcpServer ? { server: mcpServer, method: mcpMethod || '' } : (parseMcpToolName(name) || { server: 'mcp', method: '' });
    return { verb: parsed.server || 'MCP', subject: parsed.method || '', detail: '' };
  }
  if (name === 'Read') {
    const path = args?.file_path || args?.path || '';
    let detail = '';
    if (typeof args?.offset === 'number' && args.offset > 0) {
      const limit = typeof args?.limit === 'number' ? args.limit : 0;
      detail = limit > 0 ? args.offset + '–' + (args.offset + limit) : 'from ' + args.offset;
    }
    return { verb: 'Read', subject: historyDisplayPath(path), detail };
  }
  if (name === 'Patch') {
    // Attempted, not done — the one edit-family row that must NOT read «Edit».
    return { verb: 'Patch', subject: String(args?.summary || 'not applied'), detail: '' };
  }
  if (name === 'Script') {
    // JS, not a shell line: reading it with the shell rules printed its first
    // two tokens («Run const example»). The source belongs to the body.
    return { verb: 'Run', subject: 'script', detail: '' };
  }
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'Update' || (fam === 'edit' && name !== 'Bash')) {
    const path = args?.file_path || args?.path || '';
    return { verb: 'Edit', subject: historyDisplayPath(path), detail: '' };
  }
  if (name === 'Grep') {
    return { verb: 'Search', subject: 'grep', detail: historyDisplayPath(args?.path || args?.glob || '') };
  }
  if (name === 'Glob') {
    return { verb: 'Search', subject: 'glob', detail: historyDisplayPath(args?.path || '') };
  }
  if (name === 'WebSearch' || name === 'WebFetch') {
    return { verb: 'Web', subject: String(args?.query || args?.url || ''), detail: '' };
  }
  if (name === 'Bash') {
    const command = typeof args?.command === 'string' ? args.command : '';
    const word = bashWord || effectiveBashWord(command);
    const shellEdit = shellEditInfo(command, word);
    const fam2 = fam || (shellEdit.isEdit ? 'edit' : bashFamily(word));
    if (fam2 === 'edit') {
      return { verb: 'Edit', subject: historyDisplayPath(shellEdit.target), detail: '' };
    }
    const { subject, detail } = extractBashSubject(command, fam2, word);
    if (fam2 === 'git') {
      // Old/projected rows may carry `family=git` without the optional
      // `bashDetail` stamp. Re-derive the subcommand from the invocation
      // instead of returning an empty subject — an empty semantic subject
      // made the card renderer fall back to the WHOLE raw pipeline in grey
      // (`Git git status --short | sed … | rg …`, reported live 17.08).
      const sub = bashDetail
        || classifyHistoryAction({ toolName: 'Bash', args }).bashDetail
        || '';
      const target = subject ? subject.split('/').pop() : '';
      return { verb: 'Git', subject: [sub, target].filter(Boolean).join(' · '), detail: '' };
    }
    if (fam2 === 'read') return { verb: 'Read', subject: historyDisplayPath(subject), detail };
    if (fam2 === 'search') {
      return {
        verb: 'Search',
        subject: word || 'search',
        detail: historyDisplayPath(detail),
      };
    }
    if (fam2 === 'web') return { verb: 'Web', subject: word || 'request', detail: '' };
    // A plain run: the SHORT form of the command — the program plus its first
    // meaningful argument (`npm run build`, `node scripts/x.js`). The literal
    // pipeline belongs in the expanded body only: a `printf … | rg … | sort`
    // chain in the header is the wall this feature removes, and the header
    // must fit a line regardless of what the model typed.
    return { verb: 'Bash', subject: shortRunSubject(command, word), detail: '' };
  }
  return { verb: name || 'Tool', subject: '', detail: '' };
}

/** Stable target/scope identity for presentation grouping. See the ESM twin. */
function historyActionPresentationMeta({ toolName, args, family, bashWord, bashDetail, mcpServer, mcpMethod } = {}) {
  const name = String(toolName || '');
  const classified = classifyHistoryAction({ toolName: name, args, mcpServer, mcpMethod });
  const fam = String(family || classified.family || 'other');
  const server = String(mcpServer || classified.mcpServer || '');
  const method = String(mcpMethod || classified.mcpMethod || '');
  const headline = historyActionHeadline({
    toolName: name,
    args,
    family: fam,
    bashWord: bashWord || classified.bashWord,
    bashDetail: bashDetail || classified.bashDetail,
    mcpServer: server,
    mcpMethod: method,
  });
  const normalizeTarget = (value) => String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
  const docsTarget = (value) => {
    const text = normalizeTarget(value);
    if (!text) return false;
    const parts = text.split('/').filter(Boolean);
    const base = parts[parts.length - 1] || '';
    return base === 'CLAUDE.md' || parts.some((part) => part.toLowerCase() === 'docs');
  };

  let targetSource = '';
  let targetLabel = '';
  let operationLabel = String(headline.subject || '');
  let rawPathTarget = '';
  let rawSearchTarget = '';
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'Update') {
    rawPathTarget = String(args?.file_path || args?.path || '');
  } else if (name === 'Bash' && (fam === 'read' || fam === 'edit')) {
    const command = typeof args?.command === 'string' ? args.command : '';
    const word = bashWord || classified.bashWord || effectiveBashWord(command);
    rawPathTarget = fam === 'edit'
      ? String(shellEditInfo(command, word).target || '')
      : String(extractBashSubject(command, fam, word).subject || '');
  }
  if (fam === 'search') {
    if (name === 'Grep') rawSearchTarget = String(args?.path || args?.glob || '');
    else if (name === 'Glob') rawSearchTarget = String(args?.path || '');
    else if (name === 'Bash') {
      const command = typeof args?.command === 'string' ? args.command : '';
      const word = bashWord || classified.bashWord || effectiveBashWord(command);
      rawSearchTarget = String(extractBashSubject(command, fam, word).detail || '');
    }
  }
  if (fam === 'mcp') {
    targetSource = server || 'mcp';
    targetLabel = (method || server || 'mcp').replace(/_/g, ' ');
    operationLabel = targetLabel;
  } else if (fam === 'search') {
    targetSource = String(rawSearchTarget || headline.detail || headline.subject || '');
    targetLabel = historyDisplayPath(targetSource);
  } else if (rawPathTarget) {
    targetSource = rawPathTarget;
    targetLabel = historyDisplayPath(rawPathTarget);
  } else {
    targetSource = String(headline.subject || '');
    targetLabel = historyDisplayPath(targetSource);
  }
  const targetKey = normalizeTarget(targetSource);
  const isKnowledgeSearch = fam === 'mcp'
    && server.toLowerCase() === 'knowledge'
    && method.toLowerCase().replace(/\s+/g, '_') === 'docs_search';
  const docsKind = isKnowledgeSearch
    ? 'search'
    : docsTarget(targetKey)
      ? (fam === 'edit' ? 'edit' : (fam === 'read' || fam === 'search' ? 'search' : ''))
      : '';
  const scope = docsKind ? 'docs' : 'regular';
  const aggregateKey = fam === 'mcp'
    ? `mcp:${server || 'mcp'}:${scope}`
    : `${fam}:${scope}`;
  return {
    aggregateKey,
    targetKey,
    targetLabel,
    operationLabel,
    docsKind,
    // Display subjects can be summaries (e.g. "Patch not applied"), not paths.
    ...(fam === 'edit' && rawPathTarget ? { fileEditTarget: normalizeTarget(rawPathTarget) } : {}),
  };
}

module.exports = {
  BASH_READ_WORDS,
  BASH_SEARCH_WORDS,
  BASH_EDIT_WORDS,
  BASH_WEB_WORDS,
  FAMILY_LABELS,
  HISTORY_CAPTION_MAX_CHARS,
  bashFamily,
  claudeBackgroundToolKind,
  classifyHistoryAction,
  effectiveBashWord,
  extractBashSubject,
  historyActionHeadline,
  historyActionPresentationMeta,
  historyDisplayPath,
  parseMcpToolName,
  tokenizeCommand,
};

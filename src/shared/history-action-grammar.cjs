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

/**
 * The literal first token misleads in a quarter of real commands (`cd X && …`,
 * `P=/path node …`, leading `echo` banners). Walk past those wrappers to the
 * word that names what the command actually does.
 */
function effectiveBashWord(command) {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) return '';
  // First line that is not a comment: multi-line commands lead with the real
  // invocation; heredoc bodies never reach this point.
  let line = '';
  for (const candidate of text.split('\n')) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    line = trimmed;
    break;
  }
  if (!line) return '';
  // Walk `&&`/`;`-joined segments so `cd x && rg y` classifies as rg.
  const segments = line.split(/&&|;/);
  for (let raw of segments) {
    let segment = raw.trim();
    if (!segment) continue;
    // Skip environment assignments (`FOO=bar cmd …`) and subshell prefix.
    segment = segment.replace(/^\(+/, '');
    let word = '';
    for (;;) {
      const match = segment.match(/^([A-Za-z0-9_./~-]+)/);
      if (!match) break;
      const token = match[1];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment)) {
        segment = segment.slice(segment.indexOf('=') + 1).replace(/^\S*\s*/, '');
        continue;
      }
      word = token;
      break;
    }
    if (!word) continue;
    // Strip a path prefix: `/usr/bin/grep` and `./scripts/run.sh` both count
    // by their basename.
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

function bashFamily(word) {
  if (!word) return 'run';
  if (word === 'git') return 'git';
  if (BASH_READ_WORDS.has(word)) return 'read';
  if (BASH_SEARCH_WORDS.has(word)) return 'search';
  return 'run';
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
    case 'Tool Search':
    case 'ToolSearch':
      // Codex's "look what tools exist" — the emptiest noise there is: the
      // text is always the same, it carries nothing for understanding the
      // run. Its own family INSIDE the noise class, so it dissolves into
      // noise containers (header says «Tool search ×2») instead of standing
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

/**
 * Family → the icon slot and the English verb pair used by collapsed group
 * headers. Kept here so main-side summaries (stubs) and the renderer print
 * the same words.
 */
const FAMILY_LABELS = {
  read: { active: 'Reading', done: 'Read', unit: ['file', 'files'] },
  search: { active: 'Searching', done: 'Searched', unit: ['query', 'queries'] },
  git: { active: 'Running git', done: 'Ran git', unit: ['command', 'commands'] },
  run: { active: 'Running', done: 'Ran', unit: ['command', 'commands'] },
  edit: { active: 'Editing', done: 'Edited', unit: ['file', 'files'] },
  mcp: { active: 'Calling', done: 'Called', unit: ['call', 'calls'] },
  plan: { active: 'Updating plan', done: 'Updated plan', unit: ['step', 'steps'] },
  web: { active: 'Searching web', done: 'Searched web', unit: ['query', 'queries'] },
  toolsearch: { active: 'Searching tools', done: 'Tool search', unit: ['call', 'calls'] },
  task: { active: 'Running agent', done: 'Ran agent', unit: ['agent', 'agents'] },
  question: { active: 'Asking', done: 'Asked', unit: ['question', 'questions'] },
  wait: { active: 'Waiting', done: 'Waited', unit: ['task', 'tasks'] },
  other: { active: 'Working', done: 'Done', unit: ['call', 'calls'] },
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
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
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
function extractBashSubject(command, family, word) {
  const text = String(command || '');
  if (!text.trim()) return { subject: '', detail: '' };
  const firstSegment = text.split(/\||&&|;/)[0] || text;
  const tokens = tokenizeCommand(firstSegment).map(unquoteToken);
  const detail = family === 'read' ? extractLineRange(word, tokens) : '';
  if (family === 'git') {
    // Subject of a git command is its target path, when it names one.
    const path = tokens.slice(2).find((token) => looksLikePath(token) && token !== '--');
    return { subject: path || '', detail: '' };
  }
  if (family === 'search') {
    // `rg <pattern> <path>` / `grep -n <pattern> <path>` — the pattern is the
    // subject, the path is the scope.
    const args = tokens.slice(1).filter((token) => !SHELL_OPTION.test(token));
    const pattern = args.find((token) => !looksLikePath(token)) || '';
    const scope = args.find((token) => looksLikePath(token)) || '';
    if (word === 'ls' || word === 'find' || word === 'tree' || word === 'fd') {
      return { subject: scope || pattern, detail: '' };
    }
    return { subject: pattern, detail: scope };
  }
  const path = tokens.slice(1).reverse().find(looksLikePath) || '';
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
  const firstLine = text.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) || text;
  const firstSegment = firstLine.split(/\||&&|;/)[0].trim();
  const tokens = tokenizeCommand(firstSegment);
  let start = 0;
  while (start < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]) || tokens[start] === 'cd')) {
    start += 1;
  }
  const program = tokens[start] ? unquoteToken(tokens[start]).split('/').pop() : (word || '');
  if (!program) return '';
  // Subcommand words only: bare lowercase words that are not flags, not
  // paths, not quoted payloads («npm run build», «docker compose up»). The
  // first flag/path/argument ends the headline — details live in the body.
  const parts = [program];
  for (let i = start + 1; i < parts.length + start + 2 && i < tokens.length; i += 1) {
    const tok = unquoteToken(tokens[i]);
    if (!/^[a-z][a-z0-9-]*$/.test(tok)) break;
    parts.push(tok);
  }
  return parts.join(' ');
}

/**
 * Headline parts for one action: `{ verb, subject, detail }`.
 *   verb    — one word, the MEANING (Read / Search / Git / Run / Edit / MCP);
 *   subject — what it touched (path, pattern, git subcommand + target);
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
    return { verb: 'Read', subject: String(path), detail };
  }
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'Update' || fam === 'edit') {
    const path = args?.file_path || args?.path || '';
    return { verb: 'Edit', subject: String(path), detail: '' };
  }
  if (name === 'Grep') {
    return { verb: 'Search', subject: String(args?.pattern || ''), detail: String(args?.path || args?.glob || '') };
  }
  if (name === 'Glob') {
    return { verb: 'Search', subject: String(args?.pattern || ''), detail: String(args?.path || '') };
  }
  if (name === 'WebSearch' || name === 'WebFetch') {
    return { verb: 'Web', subject: String(args?.query || args?.url || ''), detail: '' };
  }
  if (name === 'Bash') {
    const command = typeof args?.command === 'string' ? args.command : '';
    const word = bashWord || effectiveBashWord(command);
    const fam2 = fam || bashFamily(word);
    const { subject, detail } = extractBashSubject(command, fam2, word);
    if (fam2 === 'git') {
      const sub = bashDetail || '';
      const target = subject ? subject.split('/').pop() : '';
      return { verb: 'Git', subject: [sub, target].filter(Boolean).join(' · '), detail: '' };
    }
    if (fam2 === 'read') return { verb: 'Read', subject, detail };
    if (fam2 === 'search') return { verb: 'Search', subject, detail };
    // A plain run: the SHORT form of the command — the program plus its first
    // meaningful argument (`npm run build`, `node scripts/x.js`). The literal
    // pipeline belongs in the expanded body only: a `printf … | rg … | sort`
    // chain in the header is the wall this feature removes, and the header
    // must fit a line regardless of what the model typed.
    return { verb: 'Run', subject: shortRunSubject(command, word), detail: '' };
  }
  return { verb: name || 'Tool', subject: '', detail: '' };
}

module.exports = {
  BASH_READ_WORDS,
  BASH_SEARCH_WORDS,
  FAMILY_LABELS,
  HISTORY_CAPTION_MAX_CHARS,
  bashFamily,
  classifyHistoryAction,
  effectiveBashWord,
  extractBashSubject,
  historyActionHeadline,
  parseMcpToolName,
  tokenizeCommand,
};

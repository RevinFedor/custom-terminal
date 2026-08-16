/**
 * ESM twin of history-action-grammar.cjs — SAME logic, two module formats.
 *
 * Why two files: main loads modules at runtime with CommonJS `require`
 * (Electron 28 / Node 18 cannot require ESM), while the renderer is served by
 * Vite, which ships source `.cjs` files RAW to the browser where
 * `module.exports` does not exist (proven live: RendererBootstrap failed to
 * load application modules). One runtime cannot share one file here without a
 * build step, so the logic exists twice and
 * `history-action-grammar.parity.test.cjs` locks the two implementations
 * together — any drift fails the suite.
 *
 * EDIT RULE: change both files in the same commit; the parity test is the
 * enforcement.
 */

export const BASH_READ_WORDS = new Set([
  'sed', 'nl', 'cat', 'tail', 'head', 'wc', 'jq', 'awk', 'less', 'more',
  'stat', 'file', 'od', 'xxd', 'strings', 'bat', 'column', 'diff', 'cut',
  'sort', 'uniq', 'comm', 'readlink', 'basename', 'dirname', 'du', 'df',
]);

export const BASH_SEARCH_WORDS = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'ls', 'tree', 'which',
  'whereis', 'locate', 'ag',
]);

export function effectiveBashWord(command) {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) return '';
  let line = '';
  for (const candidate of text.split('\n')) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    line = trimmed;
    break;
  }
  if (!line) return '';
  const segments = line.split(/&&|;/);
  for (let raw of segments) {
    let segment = raw.trim();
    if (!segment) continue;
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

export function bashFamily(word) {
  if (!word) return 'run';
  if (word === 'git') return 'git';
  if (BASH_READ_WORDS.has(word)) return 'read';
  if (BASH_SEARCH_WORDS.has(word)) return 'search';
  return 'run';
}

export function parseMcpToolName(toolName) {
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

export function classifyHistoryAction({ toolName, args, mcpServer, mcpMethod } = {}) {
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

export const FAMILY_LABELS = {
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

export const HISTORY_CAPTION_MAX_CHARS = 600;

// ── Subject extraction ─────────────────────────────────────────────────────
// See the .cjs twin for the rationale: a headline says WHAT was touched, never
// HOW it was invoked.

const SHELL_OPTION = /^-/;

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

export function tokenizeCommand(command) {
  const text = String(command || '');
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  return out;
}

function looksLikePath(token) {
  const text = String(token || '');
  if (!text || SHELL_OPTION.test(text)) return false;
  if (text.includes('/')) return true;
  return /\.[A-Za-z0-9]{1,6}$/.test(text);
}

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

export function extractBashSubject(command, family, word) {
  const text = String(command || '');
  if (!text.trim()) return { subject: '', detail: '' };
  const firstSegment = text.split(/\||&&|;/)[0] || text;
  const tokens = tokenizeCommand(firstSegment).map(unquoteToken);
  const detail = family === 'read' ? extractLineRange(word, tokens) : '';
  if (family === 'git') {
    const path = tokens.slice(2).find((token) => looksLikePath(token) && token !== '--');
    return { subject: path || '', detail: '' };
  }
  if (family === 'search') {
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

/** Compact subject for a run command — see the .cjs twin. */
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
  const parts = [program];
  for (let i = start + 1; i < parts.length + start + 2 && i < tokens.length; i += 1) {
    const tok = unquoteToken(tokens[i]);
    if (!/^[a-z][a-z0-9-]*$/.test(tok)) break;
    parts.push(tok);
  }
  return parts.join(' ');
}

export function historyActionHeadline({ toolName, args, family, bashWord, bashDetail, mcpServer, mcpMethod } = {}) {
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
    return { verb: 'Run', subject: shortRunSubject(command, word), detail: '' };
  }
  return { verb: name || 'Tool', subject: '', detail: '' };
}

'use strict';

const crypto = require('crypto');

const MAX_PREVIEW_CHARS = 64 * 1024;
const MAX_PREVIEW_LINES = 800;

const normalizeProvider = (value) => (
  value === 'claude' || value === 'codex' ? value : null
);

const cleanLine = (value) => String(value || '')
  .replace(/\u00a0/g, ' ')
  .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
  .replace(/[ \t]+$/g, '');

const compactText = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeTerminalHistoryPromptText = (value) => compactText(
  String(value || '').replace(/^\s*(?:⏵|❯|›|»)\s*/u, ''),
);

function previewTextHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

const styleIncludes = (value, token) => new RegExp('(?:^|[,\\s])' + token + '(?:$|[,\\s])', 'i')
  .test(String(value || '').replace(/\s+x\d+$/i, ''));

function terminalLineStyleEvidence(raw) {
  const styles = Array.isArray(raw?.styles) ? raw.styles.map(String) : [];
  const firstTextStyle = String(raw?.firstTextStyle || 'none');
  const styleValues = firstTextStyle && firstTextStyle !== 'none'
    ? [firstTextStyle, ...styles]
    : styles;
  const hasDim = raw?.hasDim === true || styleValues.some((style) => styleIncludes(style, 'dim'));
  const allTextDim = raw?.allTextDim === true || (
    styleValues.length > 0 && styleValues.every((style) => styleIncludes(style, 'dim'))
  );
  const activeByInverse = raw?.activeByInverse === true;
  const hasInverse = activeByInverse
    || raw?.hasInverse === true
    || styleValues.some((style) => styleIncludes(style, 'inverse'));
  const hasNonDefaultFg = raw?.hasNonDefaultFg === true;
  const hasNonDefaultBg = raw?.hasNonDefaultBg === true;
  return {
    firstTextStyle,
    styles,
    hasDim,
    allTextDim,
    activeByInverse,
    hasInverse,
    hasNonDefaultFg,
    hasNonDefaultBg,
    hasSystemTint: hasDim || allTextDim || hasNonDefaultFg || hasInverse || hasNonDefaultBg,
  };
}

function logicalTerminalLines(physicalLines) {
  const result = [];
  for (const raw of Array.isArray(physicalLines) ? physicalLines : []) {
    const text = cleanLine(raw?.text);
    const style = terminalLineStyleEvidence(raw);
    if (raw?.wrapped === true && result.length > 0) {
      const current = result[result.length - 1];
      current.text += text;
      current.endRow = Number.isFinite(Number(raw?.row))
        ? Number(raw.row)
        : current.endRow;
      current.styles = Array.from(new Set([...current.styles, ...style.styles]));
      current.hasDim = current.hasDim || style.hasDim;
      current.allTextDim = current.allTextDim && style.allTextDim;
      current.activeByInverse = current.activeByInverse || style.activeByInverse;
      current.hasInverse = current.hasInverse || style.hasInverse;
      current.hasNonDefaultFg = current.hasNonDefaultFg || style.hasNonDefaultFg;
      current.hasNonDefaultBg = current.hasNonDefaultBg || style.hasNonDefaultBg;
      current.hasSystemTint = current.hasSystemTint || style.hasSystemTint;
      continue;
    }
    const row = Number.isFinite(Number(raw?.row)) ? Number(raw.row) : result.length;
    result.push({
      text,
      startRow: row,
      endRow: row,
      ...style,
    });
  }
  return result;
}

const STRONG_COMPOSER_RE = /^\s*(?:⏵|❯|›|»)(?=\s|$)/u;
const CLAUDE_BOX_BOTTOM_RE = /^\s*╰(?:─|━|┄|╌|═)+/u;

/**
 * Finds the exact submitted prompt in the current TUI frame.
 *
 * Codex and Claude repaint their conversation panes in place. An xterm marker
 * registered on the old frame is consequently allowed to disappear; prompt
 * text plus the lifecycle-owned turn is the durable boundary. TUI wrapping is
 * not always reported as xterm `isWrapped` (Codex can emit explicit cursor
 * moves), so this deliberately joins consecutive physical rows as well.
 */
function findTerminalHistorySubmittedPromptBoundary({
  physicalLines,
  promptText,
  provider = null,
  beforeRow = null,
  maxRows = 48,
} = {}) {
  const expected = normalizeTerminalHistoryPromptText(promptText);
  if (!expected) return null;
  const rowLimit = Number.isFinite(Number(beforeRow)) ? Number(beforeRow) : null;
  const source = (Array.isArray(physicalLines) ? physicalLines : [])
    .filter((line) => {
      const row = Number(line?.row);
      return Number.isFinite(row) && (rowLimit === null || row < rowLimit);
    });
  const promptCandidates = [];
  for (let index = 0; index < source.length; index += 1) {
    const firstRaw = cleanLine(source[index]?.text);
    if (!STRONG_COMPOSER_RE.test(firstRaw)) continue;
    promptCandidates.push(index);
  }
  if (promptCandidates.length === 0) return null;

  // Codex keeps submitted prompts as inverse-background root blocks. Prefer
  // that geometry so a quoted `›` inside assistant prose cannot masquerade
  // as the prompt boundary. If style metadata is unavailable, retain the
  // text-only fallback used by fixtures and older snapshots.
  const styledCodexCandidates = provider === 'codex'
    ? promptCandidates.filter((index) => (
        source[index]?.activeByInverse === true
        || source[index]?.hasInverse === true
        || source[index]?.hasNonDefaultBg === true
      ))
    : [];
  const candidates = styledCodexCandidates.length > 0
    ? styledCodexCandidates
    : promptCandidates;

  // The active composer row is excluded by `beforeRow`, therefore the newest
  // remaining prompt-shaped block is the only admissible submitted prompt.
  // Falling through to an older identical prompt would cross a turn boundary.
  const start = candidates[candidates.length - 1];
  {
    const firstRaw = cleanLine(source[start]?.text);
    let combined = '';
    const endLimit = Math.min(source.length, start + Math.max(1, Number(maxRows) || 1));
    for (let end = start; end < endLimit; end += 1) {
      const raw = cleanLine(source[end]?.text);
      const piece = normalizeTerminalHistoryPromptText(
        end === start ? raw.replace(STRONG_COMPOSER_RE, '') : raw,
      );
      if (piece) {
        if (!combined) {
          combined = piece;
        } else {
          const withSpace = compactText(combined + ' ' + piece);
          const withoutSpace = compactText(combined + piece);
          // TUI explicit cursor moves do not always set xterm `isWrapped`.
          // Choose the only join which remains an exact prefix of the source
          // prompt. This accepts a visual split inside `STREAM-CODEX-` /
          // `WARM-2`, while never fuzzy-matching different text.
          if (expected.startsWith(withSpace)) combined = withSpace;
          else if (expected.startsWith(withoutSpace)) combined = withoutSpace;
          else break;
        }
      }
      if (combined === expected) {
        return {
          startRow: Number(source[start].row),
          endRow: Number(source[end].row),
          rows: end - start + 1,
          hash: previewTextHash(expected),
        };
      }
      if (!expected.startsWith(combined) || combined.length >= expected.length) break;
    }
  }
  return null;
}

function findComposerIndex(lines, provider) {
  const start = Math.max(0, lines.length - 16);
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const text = lines[index]?.text || '';
    if (STRONG_COMPOSER_RE.test(text)) return index;
    if (provider === 'claude' && CLAUDE_BOX_BOTTOM_RE.test(text)) return index;
    // ASCII `>` is allowed only as the final compact Claude composer. Treating
    // every Markdown quote as a prompt would truncate genuine streamed text.
    if (
      provider === 'claude'
      && index >= lines.length - 4
      && /^\s*>\s*(?:$|Send a prompt)/i.test(text)
    ) return index;
  }
  return -1;
}

const FRAME_ONLY_LINE_RES = [
  /^\s*[✢✳✶✻✽*]\s*(?:Working|Thinking|Cooked|Cr(?:unched|eating)|Churned|Brewed|Sautéed)(?:\b|\s*\()/i,
  /^\s*(?:Working|Thinking)\s*\([^)]*esc to (?:interrupt|cancel)[^)]*\)\s*$/i,
  /^\s*(?:esc to interrupt|esc to cancel)\s*$/i,
  /^\s*▶▶\s*bypass permissions on\b/i,
  /^\s*\[(?:Opus|Sonnet|Haiku|Claude)[^\]]*\]\s*\d+%\s*$/i,
  /^\s*(?:gpt-|codex-|claude-|opus|sonnet|haiku)[^\n]{0,100}\b(?:Full Access|Context\s+\d+%|bypass permissions)\b/i,
  /^\s*You have \d+ usage limit resets? available\b/i,
  /^\s*(?:⚠\s*)?Heads up, you have less than \d+%/i,
  /^\s*Send a prompt\.\.\.\s*$/i,
  /^\s*(?:─|━|═|┄|╌){3,}\s*\[imagePath:\s*[^\]]+\]\s*$/iu,
  /^\s*(?:─|━|═|┄|╌|╭|╰|┌|┐|└|┘|│|┃){4,}\s*$/u,
];

// Claude chooses the activity verb from a large rotating vocabulary
// (Reticulating, Recombobulating, Razzle-dazzling, ...). Enumerating those
// words made a new verb look like assistant text and poisoned every later
// frame merge. The activity *block* has a stable shape even when the word and
// help text change: an optional assistant bullet, a non-ASCII spinner glyph,
// one gerund/completed verb, optional telemetry, then only indented/branch
// continuation rows (usually `⎿ Tip:`). It is always the suffix immediately
// before the composer. This preserves ordinary answer text and avoids keeping
// an ever-growing catalogue of Claude's strings.
const CLAUDE_ACTIVITY_ANCHOR_RE = /^\s*(?:⏺|●)?\s*[✢✣✤✥✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❈❉❊❋·*]\s*[A-Z][\p{L}\p{M}-]{2,64}(?:ing|ed)(?:…|\.\.\.)?(?:\s*(?:\([^)]*\)|for\s+\d+\w*(?:\s+\d+\w*)*))?\s*$/iu;
// Codex owns the whole activity footer. Its stable grammar ends at the
// keyboard affordance inside `(...)`; telemetry after that is deliberately
// free-form and has already changed from `background tasks` to `background
// terminal running`. Do not enumerate those words. The root bullet or xterm
// system tint is still required so ordinary prose quoting this UI stays prose.
const CODEX_ACTIVITY_ANCHOR_RE = /^\s*(?:•|●)?\s*[A-Z][\p{L}\p{M}-]{2,64}(?:ing|ed)\s*\([^\n)]{0,240}(?:esc to (?:interrupt|cancel))[^\n)]{0,240}\)(?:\s*[·•]\s*[^\n]{1,320})?\s*$/iu;
const CODEX_ACTIVITY_ROOT_RE = /^\s*(?:•|●)\s+/u;
const TERMINAL_BLOCK_CONTINUATION_RE = /^(?:⎿|└|├|│|╰)\s*|^Tip\s*:/iu;
const CLAUDE_SYSTEM_CARD_ANCHOR_RE = /^\s*※\s*/u;
const CLAUDE_BRANCH_STATUS_ANCHOR_RE = /^\s*⎿\s*/u;
const CLAUDE_KNOWN_BRANCH_STATUS_RE = /\bInterrupted\b/i;
const TERMINAL_ROOT_BLOCK_MARKER = {
  claude: /^\s*⏺\s+/u,
  codex: /^\s*•\s+/u,
};
const TERMINAL_TOOL_CHILD_RE = /^\s{2,}(?:⎿|└|├|╰)\s*/u;
// Some Claude tool rows have no result child yet, but carry a TUI-owned
// keyboard affordance in the root itself (`ctrl+o to expand`). That suffix is
// structural UI proof; the verb/title before it is intentionally unrestricted.
const CLAUDE_TOOL_ROOT_UI_AFFORDANCE_RE = /\(\s*(?:ctrl|control|cmd)\+[^)]{1,24}\s+to\s+(?:expand|collapse|open|view)[^)]*\)\s*$/i;
// A Claude tool invocation can be visible before its result child is painted.
// The provider bullet plus a function-call-shaped root is structural proof;
// the tool name itself is deliberately unrestricted so new tools do not need
// another phrase catalogue.
const CLAUDE_BARE_TOOL_INVOCATION_RE = /^\s*⏺\s+[A-Z][A-Za-z0-9_.:-]{1,64}\s*\([\s\S]*(?:\)|…)\s*$/u;
// Explicit cursor moves can paint a long Claude invocation over several
// physical rows without setting xterm's wrapped bit. In that shape the first
// row is only the opening `⏺ Tool(` and the closing parenthesis lives above
// the later styled `⎿` result child.
const CLAUDE_OPEN_TOOL_INVOCATION_RE = /^\s*⏺\s+[A-Z][A-Za-z0-9_.:-]{1,64}\s*\(/u;
// Newer Claude builds render the compact summary of an expandable thinking or
// tool group with a gray `●` instead of the ordinary assistant/tool `⏺`.
// The title and counters are intentionally free-form; the bullet plus the
// keyboard affordance are the stable structural evidence. Wrapped physical
// rows are joined before this classifier runs.
const CLAUDE_EXPANDABLE_SUMMARY_ANCHOR_RE = /^\s*●\s+.+\(\s*(?:ctrl|control|cmd)\+[^)]{1,24}\s+to\s+(?:expand|collapse|open|view)[^)]*\)\s*$/iu;
// Claude sometimes repaints an expandable summary without either provider
// root glyph (`⏺` / `●`). This is not limited to thinking: production frame
// 2197 rendered `Reading 1 file… (ctrl+o to expand)` the same way. Do not
// enumerate titles. The provider-owned keyboard affordance plus the committed
// headless-xterm system tint is the structural proof; either one alone remains
// ordinary assistant prose.
const CLAUDE_BARE_EXPANDABLE_SUMMARY_ANCHOR_RE = /^(?!\s*(?:⏺|●)(?:\s|$))(?=\s*\S)[^\n]{1,240}\(\s*(?:ctrl|control|cmd)\+[^)]{1,24}\s+to\s+(?:expand|collapse|open|view)[^)]*\)\s*$/iu;
const CLAUDE_CLIPPED_EXPANDABLE_SUMMARY_ANCHOR_RE = /^\s*(?:…|\.\.\.)\s*\+\d+\s+lines?\s*\(\s*(?:ctrl|control|cmd)\+[^)]{1,24}\s+to\s+(?:expand|collapse|open|view)[^)]*\)/iu;
// Codex renders provider-owned progress rows with the same `•` root glyph as
// assistant prose. Tool-card geometry alone therefore cannot distinguish a
// standalone web-search update or a call whose result is still pending. Keep
// these grammars deliberately narrow: complete Codex UI sentences or a
// namespaced tool call with its argument list, never an arbitrary verb/title.
const CODEX_WEB_SEARCH_STATUS_RE = /^\s*(?:•\s+)?(?:Searching|Searched)\s+the web(?:\s+for\b.*)?\s*$/iu;
const CODEX_TOOL_CALL_STATUS_RE = /^\s*(?:•\s+)?Calling\s+[A-Za-z0-9_.:-]+\s*\([\s\S]*\)\s*$/u;
const CODEX_CONTEXT_COMPACTED_RE = /^\s*(?:•\s+)?Context compacted\s*$/iu;
// `/fast` writes this provider-owned confirmation into the transcript pane.
// Require the Codex root bullet and the complete sentence so ordinary prose
// discussing service tiers remains eligible for preview.
const CODEX_SERVICE_TIER_STATUS_RE = /^\s*•\s+Service tier set to [A-Za-z0-9_.:-]+\s*$/u;
const CODEX_QUEUE_FOOTER_RE = /^\s*tab to queue message\s+\d+%\s+context left\s*$/iu;
const CODEX_QUEUED_MESSAGE_STATUS_RE = /^\s*(?:•\s+)?Messages to be submitted after next tool call(?:\s+\(press esc to interrupt and send immediately\))?(?:\s+↳(?:\s+.*)?)?\s*$/iu;
const CODEX_QUEUED_MESSAGE_CONTINUATION_RE = /^\s*\(press esc to interrupt and send immediately\)(?:\s+↳(?:\s+.*)?)?\s*$/iu;
const CODEX_QUEUED_MESSAGE_BRANCH_RE = /^\s*↳(?:\s+.*)?$/u;
const CODEX_TRANSPORT_STATUS_RE = /^\s*⚠\s*Falling back from WebSockets to HTTPS transport\.?(?:\s+stream disconnected before completion:\s*websocket)?(?:\s+closed by server before response\.completed)?\s*$/iu;
const CODEX_TRANSPORT_CONTINUATION_RE = /^\s*(?:stream disconnected before completion:\s*websocket(?:\s+closed by server before response\.completed)?|closed by server before response\.completed)\s*$/iu;

// Codex often redraws narrow panes with explicit cursor moves rather than
// xterm soft-wraps. Reassemble only the exact queue-card sentence over a small
// adjacent window; arbitrary prose never becomes a status from style alone.
function classifySplitCodexQueueAnchor(lines, start) {
  const source = Array.isArray(lines) ? lines : [];
  let combined = '';
  let matchedEnd = -1;
  let styleEvidence = false;
  const limit = Math.min(source.length, start + 6);
  for (let end = start; end < limit; end += 1) {
    const raw = String(source[end]?.text || '');
    if (!raw.trim()) break;
    if (end > start && (STRONG_COMPOSER_RE.test(raw)
      || TERMINAL_ROOT_BLOCK_MARKER.codex.test(raw)
      || CODEX_QUEUED_MESSAGE_BRANCH_RE.test(raw))) break;
    combined = compactText(combined + ' ' + raw);
    styleEvidence = styleEvidence
      || terminalLineStyleEvidence(source[end]).hasSystemTint;
    if (CODEX_QUEUED_MESSAGE_STATUS_RE.test(combined)
      || CODEX_QUEUED_MESSAGE_CONTINUATION_RE.test(combined)) {
      matchedEnd = end;
    }
  }
  return matchedEnd >= start
    ? { kind: 'queue-status', styleEvidence, endIndex: matchedEnd }
    : null;
}

// The transport warning is also repainted as independent physical rows in a
// narrow pane. Reassemble only its complete provider sentence; colour alone
// never turns arbitrary prose into transport chrome.
function classifySplitCodexTransportAnchor(lines, start) {
  const source = Array.isArray(lines) ? lines : [];
  let combined = '';
  let matchedEnd = -1;
  let styleEvidence = false;
  const limit = Math.min(source.length, start + 6);
  for (let end = start; end < limit; end += 1) {
    const raw = String(source[end]?.text || '');
    if (!raw.trim()) break;
    if (end > start && (STRONG_COMPOSER_RE.test(raw)
      || TERMINAL_ROOT_BLOCK_MARKER.codex.test(raw))) break;
    combined = compactText(combined + ' ' + raw);
    styleEvidence = styleEvidence
      || terminalLineStyleEvidence(source[end]).hasSystemTint;
    if (CODEX_TRANSPORT_STATUS_RE.test(combined)
      || CODEX_TRANSPORT_CONTINUATION_RE.test(combined)) {
      matchedEnd = end;
    }
  }
  return matchedEnd >= start
    ? { kind: 'transport-status', styleEvidence, endIndex: matchedEnd }
    : null;
}

function classifyTerminalSystemBlockAt(lines, index, provider) {
  if (provider === 'codex') {
    const transport = classifySplitCodexTransportAnchor(lines, index);
    if (transport) return transport;
    const queue = classifySplitCodexQueueAnchor(lines, index);
    if (queue) return queue;
  }
  const direct = classifyTrailingTerminalBlockAnchor(lines[index], provider);
  return direct ? { ...direct, endIndex: index } : null;
}

function classifyTrailingTerminalBlockAnchor(line, provider) {
  const raw = String(line?.text || '');
  const style = terminalLineStyleEvidence(line);
  if (provider === 'codex'
    && (CODEX_QUEUED_MESSAGE_STATUS_RE.test(raw)
      || CODEX_QUEUED_MESSAGE_CONTINUATION_RE.test(raw))) {
    return { kind: 'queue-status', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'codex'
    && (CODEX_TRANSPORT_STATUS_RE.test(raw)
      || CODEX_TRANSPORT_CONTINUATION_RE.test(raw))) {
    return { kind: 'transport-status', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'codex' && CODEX_WEB_SEARCH_STATUS_RE.test(raw)) {
    return { kind: 'tool-status', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'codex' && CODEX_TOOL_CALL_STATUS_RE.test(raw)) {
    return { kind: 'tool-status', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'codex' && CODEX_CONTEXT_COMPACTED_RE.test(raw)) {
    return { kind: 'lifecycle-status', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'codex' && CODEX_SERVICE_TIER_STATUS_RE.test(raw)) {
    return { kind: 'lifecycle-status', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'codex'
    && style.hasSystemTint
    && CODEX_QUEUE_FOOTER_RE.test(raw)) {
    return { kind: 'composer-footer', styleEvidence: true };
  }
  if (provider === 'claude' && CLAUDE_EXPANDABLE_SUMMARY_ANCHOR_RE.test(raw)) {
    return { kind: 'structured-summary', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'claude'
    && style.hasSystemTint
    && CLAUDE_BARE_EXPANDABLE_SUMMARY_ANCHOR_RE.test(raw)) {
    return { kind: 'structured-summary', styleEvidence: true };
  }
  if (provider === 'claude'
    && style.hasSystemTint
    && CLAUDE_CLIPPED_EXPANDABLE_SUMMARY_ANCHOR_RE.test(raw)) {
    return { kind: 'structured-summary', styleEvidence: true };
  }
  if (provider === 'claude' && CLAUDE_ACTIVITY_ANCHOR_RE.test(raw)) {
    return { kind: 'activity', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'codex'
    && CODEX_ACTIVITY_ANCHOR_RE.test(raw)
    && (CODEX_ACTIVITY_ROOT_RE.test(raw) || style.hasSystemTint)) {
    return { kind: 'activity', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'claude' && CLAUDE_SYSTEM_CARD_ANCHOR_RE.test(raw)) {
    return { kind: 'system-card', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'claude'
    && CLAUDE_BRANCH_STATUS_ANCHOR_RE.test(raw)
    && (style.hasSystemTint || CLAUDE_KNOWN_BRANCH_STATUS_RE.test(raw))) {
    return { kind: 'branch-status', styleEvidence: style.hasSystemTint };
  }
  return null;
}

function isTrailingTerminalBlockContinuation(line, provider) {
  const raw = String(line?.text || '');
  if (!raw.trim()) return true;
  if (classifyTrailingTerminalBlockAnchor(line, provider)) return true;
  return /^\s{2,}\S/u.test(raw)
    || TERMINAL_BLOCK_CONTINUATION_RE.test(raw.trimStart());
}

function filterTerminalSystemBlocks(lines, provider) {
  const source = Array.isArray(lines) ? lines : [];
  const excluded = new Set();
  const kinds = [];
  let styleEvidence = false;
  for (let index = 0; index < source.length; index += 1) {
    const anchor = classifyTerminalSystemBlockAt(source, index, provider);
    if (!anchor) continue;
    if (!kinds.includes(anchor.kind)) kinds.push(anchor.kind);
    styleEvidence = styleEvidence || anchor.styleEvidence === true;
    for (let covered = index; covered <= anchor.endIndex; covered += 1) {
      excluded.add(covered);
    }
    let next = anchor.endIndex + 1;
    while (next < source.length) {
      const nestedAnchor = classifyTerminalSystemBlockAt(source, next, provider);
      if (nestedAnchor) {
        if (!kinds.includes(nestedAnchor.kind)) kinds.push(nestedAnchor.kind);
        styleEvidence = styleEvidence || nestedAnchor.styleEvidence === true;
        for (let covered = next; covered <= nestedAnchor.endIndex; covered += 1) {
          excluded.add(covered);
        }
        next = nestedAnchor.endIndex + 1;
        continue;
      }
      const raw = String(source[next]?.text || '');
      const queueContinuation = anchor.kind === 'queue-status'
        && (CODEX_QUEUED_MESSAGE_BRANCH_RE.test(raw)
          || (terminalLineStyleEvidence(source[next]).hasSystemTint
            && !STRONG_COMPOSER_RE.test(raw)
            && !TERMINAL_ROOT_BLOCK_MARKER.codex.test(raw)));
      if (!isTrailingTerminalBlockContinuation(source[next], provider)
        && !queueContinuation) break;
      excluded.add(next);
      next += 1;
    }
    index = next - 1;
  }
  if (excluded.size === 0) {
    return { lines: source, filtered: 0, kinds: [], styleEvidence: false };
  }
  return {
    lines: source.filter((_, index) => !excluded.has(index)),
    filtered: excluded.size,
    kinds,
    styleEvidence,
  };
}

function filterClippedCodexToolCardPrefix(lines, provider) {
  const source = Array.isArray(lines) ? lines : [];
  if (provider !== 'codex' || source.length === 0) {
    return { lines: source, filtered: 0, styleEvidence: false };
  }
  let start = 0;
  while (start < source.length && !String(source[start]?.text || '').trim()) start += 1;
  if (start >= source.length) {
    return { lines: source, filtered: 0, styleEvidence: false };
  }
  const firstText = String(source[start]?.text || '');
  const firstStyle = terminalLineStyleEvidence(source[start]);
  // The root `• Ran/Search/...` can have scrolled above the owned viewport.
  // A child glyph plus provider styling is the remaining structural proof;
  // an unstyled tree at the start of an answer must remain ordinary prose.
  const clippedChild = /^(?:\s*)(?:⎿|└|├|│|╰)\s*/u.test(firstText);
  if (!clippedChild || !(firstStyle.hasDim || firstStyle.allTextDim
    || firstStyle.hasNonDefaultFg || firstStyle.hasNonDefaultBg)) {
    return { lines: source, filtered: 0, styleEvidence: false };
  }

  let end = start + 1;
  for (; end < source.length; end += 1) {
    const raw = String(source[end]?.text || '');
    if (!raw.trim()) continue;
    if (STRONG_COMPOSER_RE.test(raw)
      || TERMINAL_ROOT_BLOCK_MARKER.codex.test(raw)
      || classifyTerminalSystemBlockAt(source, end, provider)) break;
    const style = terminalLineStyleEvidence(source[end]);
    if (!(style.hasSystemTint
      || TERMINAL_BLOCK_CONTINUATION_RE.test(raw.trimStart())
      || /^\s{2,}\S/u.test(raw))) break;
  }
  return {
    lines: source.slice(0, start).concat(source.slice(end)),
    filtered: end - start,
    styleEvidence: true,
  };
}

function filterInlineTerminalToolCards(lines, provider) {
  const source = Array.isArray(lines) ? lines : [];
  const rootMarker = TERMINAL_ROOT_BLOCK_MARKER[provider];
  if (!rootMarker) return { lines: source, filtered: 0, styleEvidence: false };
  const excluded = new Set();
  let styleEvidence = false;
  for (let start = 0; start < source.length; start += 1) {
    const rootText = String(source[start]?.text || '');
    if (!rootMarker.test(rootText)) continue;
    let end = start + 1;
    while (end < source.length
      && !rootMarker.test(String(source[end]?.text || ''))) end += 1;
    let child = start + 1;
    while (child < end && !String(source[child]?.text || '').trim()) child += 1;
    let childText = String(source[child]?.text || '');
    // Codex can wrap a long `Ran <command>` root with explicit cursor moves,
    // so xterm does not mark those visual rows as `isWrapped`. In that form
    // the dim `└ result` is still the structural child, but no longer the
    // first non-blank logical line. Search only inside the same `•` block and
    // require dim styling for this fallback; an ordinary answer containing a
    // literal tree glyph must remain prose.
    const rootStyle = terminalLineStyleEvidence(source[start]);
    const mayHaveExplicitPhysicalWraps = provider === 'codex'
      || (provider === 'claude'
        && CLAUDE_OPEN_TOOL_INVOCATION_RE.test(rootText)
        && rootStyle.hasSystemTint);
    if (mayHaveExplicitPhysicalWraps
      && (child >= end || !TERMINAL_TOOL_CHILD_RE.test(childText))) {
      for (let candidate = start + 1; candidate < end; candidate += 1) {
        const candidateText = String(source[candidate]?.text || '');
        const candidateStyle = terminalLineStyleEvidence(source[candidate]);
        if (TERMINAL_TOOL_CHILD_RE.test(candidateText)
          && (provider === 'codex'
            ? (candidateStyle.hasDim || candidateStyle.allTextDim)
            : candidateStyle.hasSystemTint)) {
          child = candidate;
          childText = candidateText;
          break;
        }
      }
    }
    if (child >= end || !TERMINAL_TOOL_CHILD_RE.test(childText)) {
      if (provider === 'claude'
        && (CLAUDE_TOOL_ROOT_UI_AFFORDANCE_RE.test(rootText)
          || CLAUDE_BARE_TOOL_INVOCATION_RE.test(rootText))) {
        excluded.add(start);
        styleEvidence = styleEvidence
          || terminalLineStyleEvidence(source[start]).hasSystemTint;
      }
      start = end - 1;
      continue;
    }
    // `⏺ short answer` followed by Claude's tinted branch/status card is still
    // assistant prose plus lifecycle chrome, not a tool invocation. Keep the
    // answer root and let the system-block pass remove the child. A function-
    // shaped tool root remains authoritative even if its result happens to be
    // dimmed.
    if (provider === 'claude') {
      const childStyle = terminalLineStyleEvidence(source[child]);
      const tintedBranch = (childStyle.hasDim || childStyle.allTextDim)
        && !CLAUDE_OPEN_TOOL_INVOCATION_RE.test(rootText);
      if (CLAUDE_KNOWN_BRANCH_STATUS_RE.test(childText) || tintedBranch) {
        start = end - 1;
        continue;
      }
    }
    for (let index = start; index < end; index += 1) excluded.add(index);
    styleEvidence = styleEvidence
      || terminalLineStyleEvidence(source[start]).hasSystemTint
      || terminalLineStyleEvidence(source[child]).hasSystemTint;
    start = end - 1;
  }
  if (excluded.size === 0) return { lines: source, filtered: 0, styleEvidence: false };
  return {
    lines: source.filter((_, index) => !excluded.has(index)),
    filtered: excluded.size,
    styleEvidence,
  };
}

/**
 * Carries provider-owned block identity across the exact preview boundary.
 *
 * A marker/baseline can land inside a multi-line TUI card. The owned region
 * then starts with an innocent-looking tail (`MCP tools`, a plan checkbox,
 * etc.) while the structural root remains a few rows above it. The context is
 * read-only: it can prove that the first owned rows continue an already-open
 * provider block, but it is never returned as assistant text.
 */
function filterBoundarySpanningProviderBlock({
  leadingPhysicalLines,
  physicalLines,
  provider,
} = {}) {
  const ownedLogical = logicalTerminalLines(physicalLines);
  const leading = Array.isArray(leadingPhysicalLines) ? leadingPhysicalLines : [];
  if (leading.length === 0 || ownedLogical.length === 0) {
    return {
      lines: ownedLogical,
      filtered: 0,
      kinds: [],
      styleEvidence: false,
    };
  }
  const ownedRows = (Array.isArray(physicalLines) ? physicalLines : [])
    .map((line) => Number(line?.row))
    .filter(Number.isFinite);
  if (ownedRows.length === 0) {
    return {
      lines: ownedLogical,
      filtered: 0,
      kinds: [],
      styleEvidence: false,
    };
  }
  const firstOwnedRow = Math.min(...ownedRows);
  const context = leading.filter((line) => {
    const row = Number(line?.row);
    return Number.isFinite(row) && row < firstOwnedRow;
  });
  if (context.length === 0) {
    return {
      lines: ownedLogical,
      filtered: 0,
      kinds: [],
      styleEvidence: false,
    };
  }

  const combined = logicalTerminalLines([...context, ...physicalLines]);
  const composerIndex = findComposerIndex(combined, provider);
  const candidate = composerIndex >= 0 ? combined.slice(0, composerIndex) : combined;
  // Preserve the root/child relationship before the generic system filter
  // removes a styled `⎿` child on its own. Long Claude commands can occupy
  // several explicit physical rows, so losing that child makes the remaining
  // `⏺ Bash(...)` rows look like prose.
  const toolCards = filterInlineTerminalToolCards(candidate, provider);
  const systemBlocks = filterTerminalSystemBlocks(toolCards.lines, provider);
  const kept = new Set(systemBlocks.lines);
  let contextTail = -1;
  let firstOwned = -1;
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index].endRow < firstOwnedRow) contextTail = index;
    else if (firstOwned < 0) firstOwned = index;
  }
  // Context is authority only when the provider-owned block reaches the exact
  // boundary and also consumes the first owned logical row. An earlier card
  // cannot suppress a later independent assistant paragraph.
  if (contextTail < 0
    || firstOwned < 0
    || kept.has(candidate[contextTail])
    || kept.has(candidate[firstOwned])) {
    return {
      lines: ownedLogical,
      filtered: 0,
      kinds: [],
      styleEvidence: false,
    };
  }

  const excludedRanges = candidate
    .filter((line) => line.endRow >= firstOwnedRow && !kept.has(line))
    .map((line) => [line.startRow, line.endRow]);
  const lines = ownedLogical.filter((line) => !excludedRanges.some(([start, end]) => (
    line.endRow >= start && line.startRow <= end
  )));
  const filtered = ownedLogical.length - lines.length;
  if (filtered <= 0) {
    return {
      lines: ownedLogical,
      filtered: 0,
      kinds: [],
      styleEvidence: false,
    };
  }
  const kinds = ['boundary-system-continuation', ...systemBlocks.kinds];
  if (toolCards.filtered > 0 && !kinds.includes('tool-card')) kinds.push('tool-card');
  return {
    lines,
    filtered,
    kinds,
    styleEvidence: systemBlocks.styleEvidence === true || toolCards.styleEvidence === true,
  };
}

function isFrameOnlyLine(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return FRAME_ONLY_LINE_RES.some((pattern) => pattern.test(value));
}

function removeSubmittedPromptPrefix(lines, promptText) {
  const expected = compactText(promptText);
  if (!expected || lines.length === 0) return { lines, removed: 0 };

  // The exact lifecycle hook fires after Enter, but the TUI can still be
  // painting the submitted prompt. Search only the first few owned lines and
  // remove them only when their concatenation is a prefix/equal match. This
  // never performs fuzzy matching against an older response farther down.
  let combined = '';
  const limit = Math.min(lines.length, 12);
  for (let index = 0; index < limit; index += 1) {
    const piece = compactText(lines[index]?.text);
    if (!piece) continue;
    combined = compactText(combined + ' ' + piece.replace(STRONG_COMPOSER_RE, ''));
    if (combined === expected || expected.startsWith(combined)) {
      if (combined === expected) {
        return { lines: lines.slice(index + 1), removed: index + 1 };
      }
      continue;
    }
    break;
  }
  return { lines, removed: 0 };
}

function removeClippedSubmittedPromptPrefix(lines, promptText) {
  const expected = compactText(promptText);
  if (!expected || lines.length === 0) return { lines, removed: 0 };

  // Once the exact prompt boundary was proven, scrolling may leave only the
  // tail of that prompt at the top of the viewport. Remove it only when the
  // visible rows form an exact suffix which reaches the prompt's end.
  let candidates = [];
  let removableRows = 0;
  const limit = Math.min(lines.length, 16);
  for (let index = 0; index < limit; index += 1) {
    const piece = compactText(lines[index]?.text);
    if (!piece) continue;
    if (candidates.length === 0) {
      candidates = expected.includes(piece) ? [piece] : [];
    } else {
      const nextCandidates = [];
      for (const candidate of candidates) {
        for (const joined of [
          compactText(candidate + ' ' + piece),
          compactText(candidate + piece),
        ]) {
          if (expected.includes(joined) && !nextCandidates.includes(joined)) {
            nextCandidates.push(joined);
          }
        }
      }
      candidates = nextCandidates;
    }
    if (candidates.length === 0) break;
    if (candidates.some((candidate) => expected.endsWith(candidate))) {
      removableRows = index + 1;
    }
  }
  return removableRows > 0
    ? { lines: lines.slice(removableRows), removed: removableRows }
    : { lines, removed: 0 };
}

function removeResidualCodexSubmittedPromptBlocks(lines, provider) {
  const source = Array.isArray(lines) ? lines : [];
  if (provider !== 'codex' || source.length === 0) {
    return { lines: source, removed: 0, blocks: 0 };
  }
  const excluded = new Set();
  let blocks = 0;
  let index = 0;
  while (index < source.length) {
    const line = source[index];
    const text = String(line?.text || '');
    const style = terminalLineStyleEvidence(line);
    if (!STRONG_COMPOSER_RE.test(text)
      || !(style.activeByInverse || style.hasInverse || style.hasNonDefaultBg)) {
      index += 1;
      continue;
    }

    // A full-screen redraw can repaint the submitted prompt below older
    // history, so it is not necessarily the first non-empty owned row. The
    // provider-owned background/inverse card is the structural proof; an
    // ordinary `›` in assistant prose still has no such style and is kept.
    blocks += 1;
    excluded.add(index);
    index += 1;
    while (index < source.length) {
      const continuation = terminalLineStyleEvidence(source[index]);
      if (!(continuation.activeByInverse
        || continuation.hasInverse
        || continuation.hasNonDefaultBg)) break;
      excluded.add(index);
      index += 1;
    }
  }
  if (excluded.size === 0) return { lines: source, removed: 0, blocks: 0 };
  return {
    lines: source.filter((_, index) => !excluded.has(index)),
    removed: excluded.size,
    blocks,
  };
}

function collapseBlankLines(lines) {
  const out = [];
  let blank = false;
  for (const line of lines) {
    const text = cleanLine(line?.text);
    if (!text.trim()) {
      if (!blank && out.length > 0) out.push('');
      blank = true;
      continue;
    }
    blank = false;
    out.push(text);
  }
  while (out[0] === '') out.shift();
  while (out[out.length - 1] === '') out.pop();
  return out;
}

function removeProviderAnswerMarker(lines, provider) {
  const source = Array.isArray(lines) ? lines.map((line) => ({ ...line })) : [];
  // A TUI may paint the answer bullet one frame before it paints the first
  // character of prose. The standalone bullet is presentation chrome, not a
  // one-character assistant message. Accept either whitespace or EOL after
  // the glyph so that this intermediate frame stays empty and cannot become
  // the immutable prefix of the live preview.
  const marker = provider === 'claude' ? /^\s*⏺(?:\s+|$)/u : /^\s*•(?:\s+|$)/u;
  let atBlockBoundary = true;
  let removedCount = 0;
  for (const line of source) {
    const text = String(line?.text || '');
    if (!text.trim()) {
      atBlockBoundary = true;
      continue;
    }
    if (atBlockBoundary && marker.test(text)) {
      line.text = text.replace(marker, '');
      removedCount += 1;
    }
    atBlockBoundary = false;
  }
  return { lines: source, removed: removedCount > 0, removedCount };
}

function extractTerminalHistoryPreviewText({
  provider,
  leadingPhysicalLines = [],
  physicalLines,
  promptText = '',
  promptPrefixClipped = false,
  regionTruncated = false,
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    return { status: 'unknown', reason: 'provider-unsupported', text: '' };
  }
  const boundaryContext = filterBoundarySpanningProviderBlock({
    leadingPhysicalLines,
    physicalLines,
    provider: normalizedProvider,
  });
  const logical = boundaryContext.lines;
  if (logical.length === 0) {
    return { status: 'empty', reason: 'owned-region-empty', text: '', logicalLines: 0 };
  }
  const composerIndex = findComposerIndex(logical, normalizedProvider);
  let owned = composerIndex >= 0 ? logical.slice(0, composerIndex) : logical.slice();
  let promptRemoval = removeSubmittedPromptPrefix(owned, promptText);
  if (promptRemoval.removed === 0 && promptPrefixClipped === true) {
    promptRemoval = removeClippedSubmittedPromptPrefix(owned, promptText);
  }
  owned = promptRemoval.lines;
  // A full-screen Codex repaint can destroy the xterm marker and redraw a
  // previously submitted user prompt below the exact JSONL baseline. That
  // prompt is not assistant output. Remove only provider-styled inverse/
  // background prompt blocks; an ordinary `›` in assistant prose remains.
  const residualPromptBlocks = removeResidualCodexSubmittedPromptBlocks(
    owned,
    normalizedProvider,
  );
  owned = residualPromptBlocks.lines;
  const withoutFrameChrome = owned.filter((line) => !isFrameOnlyLine(line.text));
  // Tool cards are atomic provider records. Classify them before their styled
  // result child is consumed as a standalone branch/status row.
  const toolCards = filterInlineTerminalToolCards(withoutFrameChrome, normalizedProvider);
  const systemBlocks = filterTerminalSystemBlocks(toolCards.lines, normalizedProvider);
  const clippedToolCard = filterClippedCodexToolCardPrefix(
    systemBlocks.lines,
    normalizedProvider,
  );
  const kept = clippedToolCard.lines;
  const markerRemoval = removeProviderAnswerMarker(kept, normalizedProvider);
  const textLines = collapseBlankLines(markerRemoval.lines);
  let text = textLines.join('\n').trim();
  let truncated = regionTruncated === true;
  const filteredBlockKinds = Array.from(new Set([
    ...boundaryContext.kinds,
    ...systemBlocks.kinds,
  ]));
  if ((toolCards.filtered > 0 || clippedToolCard.filtered > 0)
    && !filteredBlockKinds.includes('tool-card')) {
    filteredBlockKinds.push('tool-card');
  }
  const styleEvidenceUsed = boundaryContext.styleEvidence === true
    || systemBlocks.styleEvidence === true
    || toolCards.styleEvidence === true
    || clippedToolCard.styleEvidence === true;
  if (text.length > MAX_PREVIEW_CHARS) {
    text = text.slice(text.length - MAX_PREVIEW_CHARS);
    truncated = true;
  }
  if (!text) {
    return {
      status: 'empty',
      reason: composerIndex >= 0 ? 'only-composer-or-status' : 'only-status',
      text: '',
      logicalLines: logical.length,
      keptLines: 0,
      filteredLines: owned.length,
      composerFound: composerIndex >= 0,
      promptLinesRemoved: promptRemoval.removed,
      residualPromptLinesRemoved: residualPromptBlocks.removed,
      residualPromptBlocksRemoved: residualPromptBlocks.blocks,
      leadingContextLinesRemoved: boundaryContext.filtered,
      answerMarkerRemoved: markerRemoval.removed,
      filteredBlockKinds,
      styleEvidenceUsed,
      truncated,
    };
  }
  return {
    status: 'text',
    reason: truncated ? 'owned-output-truncated' : 'owned-output',
    text,
    hash: previewTextHash(text),
    logicalLines: logical.length,
    keptLines: textLines.length,
    filteredLines: Math.max(0, owned.length - kept.length),
    composerFound: composerIndex >= 0,
    promptLinesRemoved: promptRemoval.removed,
    residualPromptLinesRemoved: residualPromptBlocks.removed,
    residualPromptBlocksRemoved: residualPromptBlocks.blocks,
    leadingContextLinesRemoved: boundaryContext.filtered,
    answerMarkerRemoved: markerRemoval.removed,
    filteredBlockKinds,
    styleEvidenceUsed,
    truncated,
  };
}

function lineOverlap(previous, next) {
  const left = previous.split('\n');
  const right = next.split('\n');
  const max = Math.min(40, left.length, right.length);
  for (let count = max; count > 0; count -= 1) {
    const leftTail = left.slice(left.length - count).join('\n');
    const rightHead = right.slice(0, count).join('\n');
    if (leftTail !== rightHead) continue;
    const meaningful = count >= 2 || compactText(leftTail).length >= 12;
    if (meaningful) return count;
  }
  return 0;
}

function normalizedTextWithOffsets(value) {
  const source = String(value || '');
  let text = '';
  const endOffsets = [];
  let pendingWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (/\s/u.test(char)) {
      pendingWhitespace = text.length > 0;
      continue;
    }
    if (pendingWhitespace) {
      text += ' ';
      endOffsets.push(index - 1);
      pendingWhitespace = false;
    }
    text += char;
    endOffsets.push(index);
  }
  return { text, endOffsets };
}

const MAX_STRUCTURED_PROOF_FRAGMENTS = 32;
const MAX_STRUCTURED_PROOF_FRAGMENT_CHARS = 128 * 1024;
const MAX_STRUCTURED_PROOF_TOTAL_CHARS = 256 * 1024;
const MIN_STRUCTURED_PROJECTION_MATCH = 32;
const MIN_STRUCTURED_CHAIN_SEGMENT_MATCH = 8;

// Terminal wrapping can split a word without marking the row as xterm-wrap.
// Exact JSONL proof therefore compares a whitespace-free representation while
// retaining offsets into the original candidate for safe prefix removal.
function structuredProjectionTextWithOffsets(value) {
  const source = String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  let text = '';
  const endOffsets = [];
  for (let index = 0; index < source.length; index += 1) {
    if (/\s/u.test(source[index])) continue;
    text += source[index];
    endOffsets.push(index);
  }
  return { source, text, endOffsets };
}

function tokenizeStructuredShellCommands(value) {
  const source = String(value || '');
  const commands = [];
  let command = [];
  let token = '';
  let quote = null;
  let escaped = false;

  const flushToken = () => {
    if (!token) return;
    command.push(token);
    token = '';
  };
  const flushCommand = () => {
    flushToken();
    if (command.length > 0) commands.push(command);
    command = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      // Keep the slash: it can be meaningful inside an rg expression. It only
      // changes how the following shell character is tokenized here.
      token += char;
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      flushToken();
      if (char === '\n' || char === '\r') flushCommand();
      continue;
    }
    if (char === ';' || char === '|' || char === '&') {
      flushCommand();
      continue;
    }
    token += char;
  }
  flushCommand();
  return commands;
}

const STRUCTURED_SEARCH_NO_VALUE_FLAGS = new Set([
  '-n', '--line-number', '-i', '--ignore-case', '-S', '--smart-case',
  '-F', '--fixed-strings', '-l', '--files-with-matches', '--hidden',
  '--no-heading', '--heading', '--trim', '-w', '--word-regexp',
  '-x', '--line-regexp', '-U', '--multiline', '--pcre2', '-r', '-R',
]);
const STRUCTURED_SEARCH_VALUE_FLAGS = new Set([
  '-C', '--context', '-A', '--after-context', '-B', '--before-context',
  '-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count',
]);

function structuredShellSearchProjectionVariants(value) {
  const variants = [];
  for (const tokens of tokenizeStructuredShellCommands(value)) {
    let commandIndex = 0;
    if (tokens[commandIndex] === 'command' || tokens[commandIndex] === 'env') {
      commandIndex += 1;
    }
    const executable = String(tokens[commandIndex] || '').split('/').pop();
    if (executable !== 'rg' && executable !== 'grep') continue;

    let pattern = null;
    const paths = [];
    let optionsEnded = false;
    let supported = true;
    for (let index = commandIndex + 1; index < tokens.length; index += 1) {
      const current = tokens[index];
      if (!optionsEnded && current === '--') {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && current.startsWith('-') && current !== '-') {
        if (current.includes('=') || STRUCTURED_SEARCH_NO_VALUE_FLAGS.has(current)) {
          continue;
        }
        if (STRUCTURED_SEARCH_VALUE_FLAGS.has(current)) {
          index += 1;
          if (index >= tokens.length) supported = false;
          continue;
        }
        // Unknown options can consume a following value. Refuse to derive a
        // semantic projection instead of guessing which token is the pattern.
        supported = false;
        break;
      }
      if (pattern === null) pattern = current;
      else paths.push(current);
    }
    if (!supported || !pattern || paths.length === 0) continue;

    for (const filePath of paths) {
      const basename = String(filePath || '').replace(/[\\/]+$/u, '').split(/[\\/]/u).pop();
      if (!basename || basename === '.' || basename === '..') continue;
      // Codex renders an exact rg/grep invocation as `Search <pattern> in
      // <basename>`. Keep both the full card text and the clipped form seen
      // when the root/verb was already painted into the committed baseline.
      variants.push(`Search ${pattern} in ${basename}`);
      variants.push(`${pattern} in ${basename}`);
    }
  }
  return variants;
}

function structuredShellReadProjectionVariants(value) {
  const variants = [];
  for (const tokens of tokenizeStructuredShellCommands(value)) {
    let commandIndex = 0;
    if (tokens[commandIndex] === 'command' || tokens[commandIndex] === 'env') {
      commandIndex += 1;
    }
    const executable = String(tokens[commandIndex] || '').split('/').pop();
    const paths = [];

    if (executable === 'sed') {
      let scriptConsumed = false;
      for (let index = commandIndex + 1; index < tokens.length; index += 1) {
        const current = tokens[index];
        if (current === '--') continue;
        if (current === '-n' || current === '--quiet' || current === '--silent') continue;
        if (current === '-e' || current === '--expression'
          || current === '-f' || current === '--file') {
          index += 1;
          scriptConsumed = true;
          continue;
        }
        if (current.startsWith('-') && current !== '-') continue;
        if (!scriptConsumed) {
          scriptConsumed = true;
          continue;
        }
        paths.push(current);
      }
    } else if (executable === 'cat' || executable === 'head' || executable === 'tail') {
      for (let index = commandIndex + 1; index < tokens.length; index += 1) {
        const current = tokens[index];
        if (current === '-n' || current === '-c' || current === '--lines'
          || current === '--bytes') {
          index += 1;
          continue;
        }
        if (current === '--' || (current.startsWith('-') && current !== '-')) continue;
        paths.push(current);
      }
    } else {
      continue;
    }

    for (const filePath of paths) {
      const basename = String(filePath || '').replace(/[\\/]+$/u, '').split(/[\\/]/u).pop();
      if (!basename || basename === '.' || basename === '..' || basename === '-') continue;
      variants.push(`Read ${basename}`);
    }
  }
  return variants;
}

function structuredJsonLeafStrings(value) {
  const source = String(value || '').trim();
  if (!source || !(
    (source.startsWith('{') && source.endsWith('}'))
    || (source.startsWith('[') && source.endsWith(']'))
  )) return [];

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }

  const strings = [];
  const visit = (current, depth = 0) => {
    if (strings.length >= 64 || depth > 8 || current == null) return;
    if (typeof current === 'string') {
      const text = current.trim();
      if (text) strings.push(text);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current !== 'object') return;
    for (const nested of Object.values(current)) {
      visit(nested, depth + 1);
      if (strings.length >= 64) break;
    }
  };
  visit(parsed);
  return strings;
}

function structuredProofValueVariants(value) {
  const exactValues = [value, ...structuredJsonLeafStrings(value)];
  const variants = [];
  for (const exactValue of exactValues) {
    variants.push(
      exactValue,
      ...structuredShellSearchProjectionVariants(exactValue),
      ...structuredShellReadProjectionVariants(exactValue),
    );
  }
  return [...new Set(variants)];
}

function boundedStructuredProofParts(value) {
  const normalized = structuredProjectionTextWithOffsets(value).text;
  if (normalized.length < MIN_STRUCTURED_CHAIN_SEGMENT_MATCH) return [];
  if (normalized.length <= MAX_STRUCTURED_PROOF_FRAGMENT_CHARS) return [normalized];
  const half = Math.floor(MAX_STRUCTURED_PROOF_FRAGMENT_CHARS / 2);
  return [normalized.slice(0, half), normalized.slice(-half)];
}

/**
 * Builds a bounded, in-memory receipt of exact thinking/tool JSONL payloads.
 * Raw strings are not logged or persisted here; they are retained only for
 * the active turn and are discarded with its controller state.
 */
function createTerminalHistoryStructuredProof(values, previousProof = null) {
  const fragments = Array.isArray(previousProof?.fragments)
    ? previousProof.fragments.slice()
    : [];
  for (const value of Array.isArray(values) ? values : [values]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    for (const variant of structuredProofValueVariants(value)) {
      for (const text of boundedStructuredProofParts(variant)) {
        if (fragments.some((fragment) => fragment === text)) continue;
        fragments.push(text);
      }
    }
  }
  while (fragments.length > MAX_STRUCTURED_PROOF_FRAGMENTS
    || fragments.reduce((sum, fragment) => sum + fragment.length, 0)
      > MAX_STRUCTURED_PROOF_TOTAL_CHARS) {
    fragments.shift();
  }
  return {
    fragments,
    chars: fragments.reduce((sum, fragment) => sum + fragment.length, 0),
  };
}

function longestStructuredProjectionPrefix(candidateText, fragments) {
  if (candidateText.length < MIN_STRUCTURED_PROJECTION_MATCH) return 0;
  const seed = candidateText.slice(0, MIN_STRUCTURED_PROJECTION_MATCH);
  let best = 0;
  for (const fragment of fragments) {
    let position = fragment.indexOf(seed);
    let inspected = 0;
    while (position >= 0 && inspected < 32) {
      let length = MIN_STRUCTURED_PROJECTION_MATCH;
      const limit = Math.min(candidateText.length, fragment.length - position);
      while (length < limit && candidateText[length] === fragment[position + length]) {
        length += 1;
      }
      if (length > best) best = length;
      if (best === candidateText.length) return best;
      position = fragment.indexOf(seed, position + 1);
      inspected += 1;
    }
  }
  return best;
}

function completeStructuredProjectionMatch(candidateValue, fragments, allowShort = false) {
  const normalized = structuredProjectionTextWithOffsets(candidateValue).text;
  if (!normalized) return { matched: false, strong: false };
  if (normalized.length >= MIN_STRUCTURED_PROJECTION_MATCH) {
    const matched = longestStructuredProjectionPrefix(normalized, fragments);
    if (matched >= normalized.length) return { matched: true, strong: true };

    // Claude/Codex abbreviate a tool card with a terminal ellipsis even though
    // the exact structured payload continues. The ellipsis is presentation,
    // not part of the command receipt.
    const unclipped = normalized.replace(/(?:…|\.\.\.)(?:\))?$/u, '');
    if (unclipped.length >= MIN_STRUCTURED_PROJECTION_MATCH
      && unclipped.length < normalized.length
      && longestStructuredProjectionPrefix(unclipped, fragments) >= unclipped.length) {
      return { matched: true, strong: true };
    }
  }
  if (!allowShort
    || normalized.length < MIN_STRUCTURED_CHAIN_SEGMENT_MATCH
    || normalized.length >= MIN_STRUCTURED_PROJECTION_MATCH) {
    return { matched: false, strong: false };
  }
  return {
    matched: fragments.some((fragment) => fragment === normalized || fragment.endsWith(normalized)),
    strong: false,
  };
}

function isStructuredProjectionShortPrefixChain(candidate, fragments) {
  let inspected = 0;
  for (let index = candidate.indexOf('\n'); index >= 0 && inspected < 16;
    index = candidate.indexOf('\n', index + 1)) {
    inspected += 1;
    const prefix = candidate.slice(0, index).trim();
    const suffix = candidate.slice(index + 1).trim();
    const prefixLength = structuredProjectionTextWithOffsets(prefix).text.length;
    if (prefixLength >= MIN_STRUCTURED_PROJECTION_MATCH) break;
    if (prefixLength < MIN_STRUCTURED_CHAIN_SEGMENT_MATCH || !suffix) continue;
    const prefixMatch = completeStructuredProjectionMatch(prefix, fragments, true);
    if (!prefixMatch.matched) continue;
    const suffixMatch = completeStructuredProjectionMatch(suffix, fragments, false);
    if (suffixMatch.matched && suffixMatch.strong) return true;
  }
  return false;
}

const STRUCTURED_DIFF_GUTTER_RE = /^\s*\d+\s+[+-]{1,2}/u;
const STRUCTURED_DIFF_END_RE = /^\s*\d+\s*$/u;

function subtractStructuredProjectionDiffTail(value) {
  const source = String(value || '');
  const lines = source.split('\n');
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start += 1;
  if (start >= lines.length || !STRUCTURED_DIFF_GUTTER_RE.test(lines[start])) {
    return { matched: false, text: source, removedChars: 0 };
  }

  let end = start;
  let gutterCount = 0;
  let sawEndRow = false;
  while (end < lines.length) {
    const raw = lines[end];
    if (STRUCTURED_DIFF_GUTTER_RE.test(raw)) {
      gutterCount += 1;
      end += 1;
      continue;
    }
    if (gutterCount > 0 && STRUCTURED_DIFF_END_RE.test(raw)) {
      sawEndRow = true;
      end += 1;
      continue;
    }
    if (!raw.trim()) {
      end += 1;
      continue;
    }
    // Narrow panes explicitly repaint continuation cells instead of setting
    // xterm's wrapped bit. They remain deeply indented under the diff gutter.
    if (gutterCount > 0 && /^\s{4,}\S/u.test(raw)) {
      end += 1;
      continue;
    }
    break;
  }

  // One line such as `64 + is a formula` may be legitimate prose. Require a
  // real multi-row diff or its provider-rendered terminal row sentinel.
  if (gutterCount < 2 && !sawEndRow) {
    return { matched: false, text: source, removedChars: 0 };
  }
  const text = lines.slice(end).join('\n').trim();
  return {
    matched: true,
    text,
    removedChars: Math.max(0, source.length - text.length),
  };
}

/**
 * Removes only a prefix/current frame which is byte-content-equivalent to an
 * exact structured JSONL payload. An unrelated provisional assistant answer
 * is returned untouched. A matched prefix is trimmed only at a line boundary,
 * so a partial same-line coincidence cannot consume following prose.
 */
function subtractTerminalHistoryStructuredProjection(proof, candidateValue) {
  const candidate = String(candidateValue || '').trim();
  const fragments = Array.isArray(proof?.fragments) ? proof.fragments : [];
  if (!candidate) return { status: 'empty', reason: 'candidate-empty', text: '' };
  if (fragments.length === 0) {
    return { status: 'text', reason: 'structured-proof-unavailable', text: candidate };
  }

  // The provider can abbreviate the last visible cells of a long exact
  // thinking/tool record with `…`. That glyph belongs to terminal
  // presentation; a strong match of every preceding character is sufficient
  // to identify the whole candidate as the already-materialized record.
  const complete = completeStructuredProjectionMatch(candidate, fragments, false);
  if (complete.matched && complete.strong) {
    return {
      status: 'empty',
      reason: 'structured-projection-only',
      text: '',
      removedChars: candidate.length,
    };
  }

  // A viewport/baseline boundary can split two adjacent provider-owned
  // records so the first visible fragment is shorter than the normal 32-char
  // collision guard (`the scripting work.` + Bash, or `Read main.js` +
  // Search). A short fragment has no authority by itself. Suppress only when
  // it is an exact suffix/derived label from the receipt and the entire
  // following block has an independent strong receipt.
  if (isStructuredProjectionShortPrefixChain(candidate, fragments)) {
    return {
      status: 'empty',
      reason: 'structured-projection-chain-only',
      text: '',
      removedChars: candidate.length,
    };
  }

  let remaining = candidate;
  let removedChars = 0;
  for (let pass = 0; pass < 8 && remaining; pass += 1) {
    const normalized = structuredProjectionTextWithOffsets(remaining);
    const matched = longestStructuredProjectionPrefix(normalized.text, fragments);
    if (matched < MIN_STRUCTURED_PROJECTION_MATCH) break;
    if (matched >= normalized.text.length) {
      return {
        status: 'empty',
        reason: removedChars > 0
          ? 'structured-projections-only'
          : 'structured-projection-only',
        text: '',
        removedChars: candidate.length,
      };
    }
    const originalEnd = normalized.endOffsets[matched - 1];
    if (!Number.isFinite(originalEnd)) break;
    const tail = remaining.slice(originalEnd + 1);
    // A proof fragment ending in the middle of a rendered line is not enough
    // authority to remove anything. Exact tool/result blocks transition to a
    // following semantic block on a physical line boundary.
    if (!/^\s*\n/u.test(tail)) break;
    removedChars += originalEnd + 1;
    remaining = tail.replace(/^\s+/u, '');
  }

  // Codex renders an Update/MultiEdit result as a header followed by a
  // numbered diff gutter. The exact JSONL fragment proves the header, but the
  // presentation-only line numbers, +/- columns and explicit-wrap indentation
  // cannot byte-match that fragment. Once the header has been removed, consume
  // only a structurally complete multi-line diff tail. A later unindented line
  // is preserved as genuine assistant prose.
  if (removedChars > 0 && remaining) {
    const diffTail = subtractStructuredProjectionDiffTail(remaining);
    if (diffTail.matched) {
      removedChars += diffTail.removedChars;
      remaining = diffTail.text;
    }
  }

  if (remaining !== candidate) {
    return {
      status: remaining ? 'text' : 'empty',
      reason: remaining
        ? 'structured-projection-prefix-removed'
        : 'structured-projections-only',
      text: remaining,
      removedChars,
      hash: remaining ? previewTextHash(remaining) : null,
    };
  }
  return {
    status: 'text',
    reason: 'candidate-not-structured-projection',
    text: candidate,
  };
}

function characterOverlap(previous, next, maxChars = 8192) {
  const left = normalizedTextWithOffsets(previous);
  const right = normalizedTextWithOffsets(next);
  if (!left.text || !right.text) return null;
  const max = Math.min(maxChars, left.text.length, right.text.length);
  const pattern = right.text.slice(0, max);
  const tail = left.text.slice(left.text.length - max);
  const joined = pattern + '\u0000' + tail;
  const prefix = new Uint32Array(joined.length);
  for (let index = 1; index < joined.length; index += 1) {
    let matched = prefix[index - 1];
    while (matched > 0 && joined[index] !== joined[matched]) {
      matched = prefix[matched - 1];
    }
    if (joined[index] === joined[matched]) matched += 1;
    prefix[index] = matched;
  }
  const overlap = Math.min(Number(prefix[prefix.length - 1] || 0), pattern.length);
  if (overlap < 32) return null;
  const originalEnd = right.endOffsets[overlap - 1];
  if (!Number.isFinite(originalEnd)) return null;
  return {
    overlap,
    remainder: String(next).slice(originalEnd + 1).replace(/^\s+/u, ''),
  };
}

function mergeTerminalHistoryPreviewText(previousValue, nextValue) {
  const previous = String(previousValue || '').trim();
  const next = String(nextValue || '').trim();
  if (!next) return { status: 'unchanged', reason: 'next-empty', text: previous };
  if (!previous) return { status: 'updated', reason: 'first-frame', text: next };
  if (previous === next) return { status: 'unchanged', reason: 'same-frame', text: previous };
  if (next.startsWith(previous)) {
    return { status: 'updated', reason: 'growing-frame', text: next };
  }
  if (previous.startsWith(next) || previous.endsWith(next)) {
    return { status: 'unchanged', reason: 'shorter-redraw', text: previous };
  }
  if (compactText(previous) === compactText(next)) {
    return { status: 'updated', reason: 'reflow-only', text: next };
  }
  const overlap = lineOverlap(previous, next);
  if (overlap > 0) {
    const appended = next.split('\n').slice(overlap).join('\n');
    const merged = appended ? previous + '\n' + appended : previous;
    return { status: merged === previous ? 'unchanged' : 'updated', reason: 'scrolled-overlap', text: merged };
  }
  const character = characterOverlap(previous, next);
  if (character) {
    const merged = character.remainder
      ? previous + '\n' + character.remainder
      : previous;
    return {
      status: merged === previous ? 'unchanged' : 'updated',
      reason: 'scrolled-character-overlap',
      text: merged,
    };
  }
  return {
    status: 'unknown',
    reason: 'frame-does-not-extend-owned-output',
    text: previous,
    candidateHash: previewTextHash(next),
  };
}

/**
 * Returns only output which appeared after an exact JSONL boundary snapshot.
 *
 * Full-screen Claude/Codex repaint legitimately destroys xterm markers. The
 * boundary snapshot is therefore retained as durable same-generation proof,
 * parsed through the same system/tool filter, and subtracted from the current
 * committed frame. No fuzzy text match and no timer can authorize output.
 */
function deriveTerminalHistoryPreviewTextAfterBaseline(baselineValue, currentValue) {
  const baseline = String(baselineValue || '').trim();
  const current = String(currentValue || '').trim();
  if (!current) {
    return { status: 'empty', reason: 'current-frame-empty', text: '' };
  }
  if (!baseline) {
    return { status: 'text', reason: 'baseline-empty-first-output', text: current };
  }
  const merged = mergeTerminalHistoryPreviewText(baseline, current);
  if (merged.status === 'unknown') {
    return {
      status: 'unknown',
      reason: 'frame-does-not-extend-exact-baseline',
      text: '',
      baselineHash: previewTextHash(baseline),
      candidateHash: previewTextHash(current),
    };
  }
  if (compactText(merged.text) === compactText(baseline)) {
    return { status: 'empty', reason: 'no-output-after-exact-baseline', text: '' };
  }
  if (!merged.text.startsWith(baseline)) {
    return {
      status: 'unknown',
      reason: 'merged-frame-does-not-retain-exact-baseline',
      text: '',
      baselineHash: previewTextHash(baseline),
      candidateHash: previewTextHash(current),
    };
  }
  const suffix = merged.text.slice(baseline.length).replace(/^\s+/u, '');
  if (!suffix) {
    return { status: 'empty', reason: 'no-output-after-exact-baseline', text: '' };
  }
  return {
    status: 'text',
    reason: 'output-after-exact-baseline',
    text: suffix,
    hash: previewTextHash(suffix),
  };
}

/**
 * Removes an assistant record which JSONL has already materialized but the
 * terminal paints only after the exact JSONL boundary snapshot was captured.
 *
 * This is intentionally content-exact (apart from terminal reflow
 * whitespace). It never guesses by time or semantic similarity. A clipped
 * viewport may expose only a contiguous part or the tail of the canonical
 * record, so those shapes remain empty until genuinely new text follows it.
 */
function terminalMaterializedProjectionVariants(value) {
  const raw = String(value || '').trim();
  const variants = [{ value: raw, projection: 'exact-jsonl' }];
  // Codex stores Markdown delimiters in JSONL but paints inline-code spans by
  // ANSI style, without the backticks. The rendered characters are still an
  // exact projection of the same record; compare both deterministic shapes.
  const withoutInlineCodeDelimiters = raw.replace(/(?<!`)`([^`\r\n]+)`(?!`)/gu, '$1');
  if (withoutInlineCodeDelimiters !== raw) {
    variants.push({
      value: withoutInlineCodeDelimiters,
      projection: 'terminal-inline-code',
    });
  }
  return variants;
}

function subtractTerminalHistoryMaterializedText(materializedValue, candidateValue) {
  const materialized = String(materializedValue || '').trim();
  const candidate = String(candidateValue || '').trim();
  if (!candidate) {
    return { status: 'empty', reason: 'candidate-empty', text: '' };
  }
  if (!materialized) {
    return { status: 'text', reason: 'materialized-text-unavailable', text: candidate };
  }

  const actual = normalizedTextWithOffsets(candidate);
  const variants = terminalMaterializedProjectionVariants(materialized)
    .map((variant) => ({ ...variant, normalized: normalizedTextWithOffsets(variant.value) }))
    .filter((variant) => variant.normalized.text);
  if (variants.length === 0 || !actual.text) {
    return { status: 'text', reason: 'materialized-text-unavailable', text: candidate };
  }

  for (const variant of variants) {
    const expected = variant.normalized;
    const isPartialMaterializedFrame = expected.text.startsWith(actual.text)
      || (actual.text.length >= 32 && expected.text.includes(actual.text));
    if (expected.text === actual.text || isPartialMaterializedFrame) {
      return {
        status: 'empty',
        reason: expected.text === actual.text
          ? 'materialized-record-only'
          : 'materialized-record-partial-frame',
        text: '',
        projection: variant.projection,
      };
    }

    if (actual.text.startsWith(expected.text)) {
      const originalEnd = actual.endOffsets[expected.text.length - 1];
      const suffix = Number.isFinite(originalEnd)
        ? candidate.slice(originalEnd + 1).replace(/^\s+/u, '')
        : '';
      if (!suffix) {
        return {
          status: 'empty',
          reason: 'materialized-record-only',
          text: '',
          projection: variant.projection,
        };
      }
      return {
        status: 'text',
        reason: 'materialized-record-prefix-removed',
        text: suffix,
        hash: previewTextHash(suffix),
        projection: variant.projection,
      };
    }
  }

  for (const variant of variants) {
    const clippedTail = characterOverlap(variant.value, candidate);
    if (!clippedTail) continue;
    if (!clippedTail.remainder) {
      return {
        status: 'empty',
        reason: 'materialized-record-clipped-tail',
        text: '',
        projection: variant.projection,
      };
    }
    return {
      status: 'text',
      reason: 'materialized-record-clipped-tail-removed',
      text: clippedTail.remainder,
      hash: previewTextHash(clippedTail.remainder),
      projection: variant.projection,
    };
  }

  return {
    status: 'text',
    reason: 'candidate-after-materialized-record',
    text: candidate,
    hash: previewTextHash(candidate),
  };
}

function clampPreviewRegionLines(lines) {
  const source = Array.isArray(lines) ? lines : [];
  if (source.length <= MAX_PREVIEW_LINES) {
    return { lines: source, truncated: false, dropped: 0 };
  }
  return {
    lines: source.slice(source.length - MAX_PREVIEW_LINES),
    truncated: true,
    dropped: source.length - MAX_PREVIEW_LINES,
  };
}

module.exports = {
  MAX_PREVIEW_CHARS,
  MAX_PREVIEW_LINES,
  clampPreviewRegionLines,
  deriveTerminalHistoryPreviewTextAfterBaseline,
  extractTerminalHistoryPreviewText,
  findTerminalHistorySubmittedPromptBoundary,
  logicalTerminalLines,
  mergeTerminalHistoryPreviewText,
  normalizeTerminalHistoryPromptText,
  previewTextHash,
  subtractTerminalHistoryMaterializedText,
  createTerminalHistoryStructuredProof,
  subtractTerminalHistoryStructuredProjection,
};

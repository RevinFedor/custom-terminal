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
const CODEX_ACTIVITY_ANCHOR_RE = /^\s*(?:•|●)?\s*[A-Z][\p{L}-]{2,64}(?:ing|ed)\s*\([^)]*(?:esc to (?:interrupt|cancel))[^)]*\)(?:\s*[·•]\s*\d+\s+background(?:\s+(?:tasks?|commands?|agents?))?)?\s*$/iu;
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
// Newer Claude builds render the compact summary of an expandable thinking or
// tool group with a gray `●` instead of the ordinary assistant/tool `⏺`.
// The title and counters are intentionally free-form; the bullet plus the
// keyboard affordance are the stable structural evidence. Wrapped physical
// rows are joined before this classifier runs.
const CLAUDE_EXPANDABLE_SUMMARY_ANCHOR_RE = /^\s*●\s+.+\(\s*(?:ctrl|control|cmd)\+[^)]{1,24}\s+to\s+(?:expand|collapse|open|view)[^)]*\)\s*$/iu;
// The same expandable thinking card is sometimes repainted without its `●`
// root glyph. In that frame the title is still provider-owned chrome and the
// indented rows below it are hidden thinking, not assistant prose. The title
// alone is not enough proof because an ordinary answer may mention
// "Thinking for ...". Require both Claude's keyboard affordance and the
// system tint carried by the committed headless-xterm frame.
const CLAUDE_BARE_EXPANDABLE_THINKING_ANCHOR_RE = /^\s*(?:Thought|Thinking)\s+for\b.{0,180}\(\s*(?:ctrl|control|cmd)\+[^)]{1,24}\s+to\s+(?:expand|collapse|open|view)[^)]*\)\s*$/iu;
const CLAUDE_CLIPPED_EXPANDABLE_SUMMARY_ANCHOR_RE = /^\s*(?:…|\.\.\.)\s*\+\d+\s+lines?\s*\(\s*(?:ctrl|control|cmd)\+[^)]{1,24}\s+to\s+(?:expand|collapse|open|view)[^)]*\)/iu;
// Codex renders provider-owned progress rows with the same `•` root glyph as
// assistant prose. Tool-card geometry alone therefore cannot distinguish a
// standalone web-search update or a call whose result is still pending. Keep
// these grammars deliberately narrow: complete Codex UI sentences or a
// namespaced tool call with its argument list, never an arbitrary verb/title.
const CODEX_WEB_SEARCH_STATUS_RE = /^\s*(?:•\s+)?(?:Searching|Searched)\s+the web(?:\s+for\b.*)?\s*$/iu;
const CODEX_TOOL_CALL_STATUS_RE = /^\s*(?:•\s+)?Calling\s+[A-Za-z0-9_.:-]+\s*\([\s\S]*\)\s*$/u;
const CODEX_CONTEXT_COMPACTED_RE = /^\s*(?:•\s+)?Context compacted\s*$/iu;
const CODEX_QUEUED_MESSAGE_STATUS_RE = /^\s*(?:•\s+)?Messages to be submitted after next tool call(?:\s+\(press esc to interrupt and send immediately\))?(?:\s+↳(?:\s+.*)?)?\s*$/iu;
const CODEX_QUEUED_MESSAGE_CONTINUATION_RE = /^\s*\(press esc to interrupt and send immediately\)(?:\s+↳(?:\s+.*)?)?\s*$/iu;
const CODEX_TRANSPORT_STATUS_RE = /^\s*⚠\s*Falling back from WebSockets to HTTPS transport\.?(?:\s+stream disconnected before completion:\s*websocket)?(?:\s+closed by server before response\.completed)?\s*$/iu;
const CODEX_TRANSPORT_CONTINUATION_RE = /^\s*(?:stream disconnected before completion:\s*websocket(?:\s+closed by server before response\.completed)?|closed by server before response\.completed)\s*$/iu;

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
  if (provider === 'claude' && CLAUDE_EXPANDABLE_SUMMARY_ANCHOR_RE.test(raw)) {
    return { kind: 'structured-summary', styleEvidence: style.hasSystemTint };
  }
  if (provider === 'claude'
    && style.hasSystemTint
    && CLAUDE_BARE_EXPANDABLE_THINKING_ANCHOR_RE.test(raw)) {
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
  if (provider === 'codex' && CODEX_ACTIVITY_ANCHOR_RE.test(raw)) {
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
    const anchor = classifyTrailingTerminalBlockAnchor(source[index], provider);
    if (!anchor) continue;
    if (!kinds.includes(anchor.kind)) kinds.push(anchor.kind);
    styleEvidence = styleEvidence || anchor.styleEvidence === true;
    excluded.add(index);
    let next = index + 1;
    while (next < source.length && isTrailingTerminalBlockContinuation(source[next], provider)) {
      const nestedAnchor = classifyTrailingTerminalBlockAnchor(source[next], provider);
      if (nestedAnchor) {
        if (!kinds.includes(nestedAnchor.kind)) kinds.push(nestedAnchor.kind);
        styleEvidence = styleEvidence || nestedAnchor.styleEvidence === true;
      }
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
    if (provider === 'codex'
      && (child >= end || !TERMINAL_TOOL_CHILD_RE.test(childText))) {
      for (let candidate = start + 1; candidate < end; candidate += 1) {
        const candidateText = String(source[candidate]?.text || '');
        const candidateStyle = terminalLineStyleEvidence(source[candidate]);
        if (TERMINAL_TOOL_CHILD_RE.test(candidateText)
          && (candidateStyle.hasDim || candidateStyle.allTextDim)) {
          child = candidate;
          childText = candidateText;
          break;
        }
      }
    }
    if (child >= end || !TERMINAL_TOOL_CHILD_RE.test(childText)) {
      if (provider === 'claude' && CLAUDE_TOOL_ROOT_UI_AFFORDANCE_RE.test(rootText)) {
        excluded.add(start);
        styleEvidence = styleEvidence
          || terminalLineStyleEvidence(source[start]).hasSystemTint;
      }
      start = end - 1;
      continue;
    }
    // `⏺ short answer` followed by Claude's own interruption branch is still
    // assistant prose plus lifecycle chrome, not a tool invocation.
    if (provider === 'claude' && CLAUDE_KNOWN_BRANCH_STATUS_RE.test(childText)) {
      start = end - 1;
      continue;
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
  const index = source.findIndex((line) => String(line?.text || '').trim());
  if (index < 0) return { lines: source, removed: 0, blocks: 0 };
  const line = source[index];
  const text = String(line?.text || '');
  const style = terminalLineStyleEvidence(line);
  if (!STRONG_COMPOSER_RE.test(text)
    || !(style.activeByInverse || style.hasInverse || style.hasNonDefaultBg)) {
    return { lines: source, removed: 0, blocks: 0 };
  }
  excluded.add(index);
  let next = index + 1;
  while (next < source.length) {
    const continuation = terminalLineStyleEvidence(source[next]);
    if (!(continuation.activeByInverse
      || continuation.hasInverse
      || continuation.hasNonDefaultBg)) break;
    excluded.add(next);
    next += 1;
  }
  if (excluded.size === 0) return { lines: source, removed: 0, blocks: 0 };
  return {
    lines: source.filter((_, index) => !excluded.has(index)),
    removed: excluded.size,
    blocks: 1,
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
  physicalLines,
  promptText = '',
  promptPrefixClipped = false,
  regionTruncated = false,
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    return { status: 'unknown', reason: 'provider-unsupported', text: '' };
  }
  const logical = logicalTerminalLines(physicalLines);
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
  const systemBlocks = filterTerminalSystemBlocks(owned, normalizedProvider);
  const withoutFrameChrome = systemBlocks.lines.filter((line) => !isFrameOnlyLine(line.text));
  const toolCards = filterInlineTerminalToolCards(withoutFrameChrome, normalizedProvider);
  const kept = toolCards.lines;
  const markerRemoval = removeProviderAnswerMarker(kept, normalizedProvider);
  const textLines = collapseBlankLines(markerRemoval.lines);
  let text = textLines.join('\n').trim();
  let truncated = regionTruncated === true;
  const filteredBlockKinds = [...systemBlocks.kinds];
  if (toolCards.filtered > 0 && !filteredBlockKinds.includes('tool-card')) {
    filteredBlockKinds.push('tool-card');
  }
  const styleEvidenceUsed = systemBlocks.styleEvidence === true
    || toolCards.styleEvidence === true;
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
function subtractTerminalHistoryMaterializedText(materializedValue, candidateValue) {
  const materialized = String(materializedValue || '').trim();
  const candidate = String(candidateValue || '').trim();
  if (!candidate) {
    return { status: 'empty', reason: 'candidate-empty', text: '' };
  }
  if (!materialized) {
    return { status: 'text', reason: 'materialized-text-unavailable', text: candidate };
  }

  const expected = normalizedTextWithOffsets(materialized);
  const actual = normalizedTextWithOffsets(candidate);
  if (!expected.text || !actual.text) {
    return { status: 'text', reason: 'materialized-text-unavailable', text: candidate };
  }

  const isPartialMaterializedFrame = expected.text.startsWith(actual.text)
    || (actual.text.length >= 32 && expected.text.includes(actual.text));
  if (expected.text === actual.text || isPartialMaterializedFrame) {
    return {
      status: 'empty',
      reason: expected.text === actual.text
        ? 'materialized-record-only'
        : 'materialized-record-partial-frame',
      text: '',
    };
  }

  if (actual.text.startsWith(expected.text)) {
    const originalEnd = actual.endOffsets[expected.text.length - 1];
    const suffix = Number.isFinite(originalEnd)
      ? candidate.slice(originalEnd + 1).replace(/^\s+/u, '')
      : '';
    if (!suffix) {
      return { status: 'empty', reason: 'materialized-record-only', text: '' };
    }
    return {
      status: 'text',
      reason: 'materialized-record-prefix-removed',
      text: suffix,
      hash: previewTextHash(suffix),
    };
  }

  const clippedTail = characterOverlap(materialized, candidate);
  if (clippedTail) {
    if (!clippedTail.remainder) {
      return { status: 'empty', reason: 'materialized-record-clipped-tail', text: '' };
    }
    return {
      status: 'text',
      reason: 'materialized-record-clipped-tail-removed',
      text: clippedTail.remainder,
      hash: previewTextHash(clippedTail.remainder),
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
};

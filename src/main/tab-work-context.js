'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { isLocalSlashCommandPrompt } = require('../shared/agent-local-command.cjs');
const { completionContextText } = require('./orchestration-source-context');
const { agentSendTargetPreconditionFailure } = require('./agent-send-target-precondition');
const {
  classifyHistoryAction,
  historyActionHeadline,
  historyActionPresentationMeta,
} = require('../shared/history-action-grammar.cjs');
const {
  createSubagentStepProjectionState, claudeRecordToSteps, codexRecordToSteps,
} = require('./subagent-transcript');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OWNED_HEADS = 256;
const FILE_DIFF_CONTEXT_LINES = 2;
const FILE_DIFF_MAX_DISTANCE = 512;
const FILE_DIFF_MAX_WORK = 1024 * 1024;
const FILE_CHANGE_PRESENTATION_VERSION = 3;
const READ_ACK_CLOCK_SKEW_MS = 5000;
const READ_ACK_MTIME_ROUNDING_MS = 2;
const SHELL_EDIT_CLOCK_SKEW_MS = 1000;
const SHELL_EDIT_MAX_DURATION_MS = 10 * 60 * 1000;
const MAX_SHELL_EDIT_PROOFS = 2048;
const MAX_SHELL_EDIT_TRANSITION_BYTES = 32 * 1024 * 1024;
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const clean = (text) => typeof text === 'string' ? text.trim() : '';
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]+/g, ' ');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function updateWrapper(update) {
  return '<saved_prompt name="' + escape(update.title) + '" context-update-id="'
    + escape(update.id) + '">\n'
    + update.text.split('</saved_prompt>').join('<\\/saved_prompt>') + '\n</saved_prompt>';
}

function refreshUpdateWrapper(prompt, update) {
  const source = String(prompt);
  const markers = Array.from(new Set([update.id, ...(update.memberIds || [])]
    .filter(Boolean).map((id) => 'context-update-id="' + id + '"')));
  const replacement = updateWrapper(update);
  let cursor = 0;
  let output = '';
  let found = false;
  while (cursor < source.length) {
    let markerAt = -1;
    let markerLength = 0;
    for (const marker of markers) {
      const candidate = source.indexOf(marker, cursor);
      if (candidate >= 0 && (markerAt < 0 || candidate < markerAt)) {
        markerAt = candidate;
        markerLength = marker.length;
      }
    }
    if (markerAt < 0) break;
    const openAt = source.lastIndexOf('<saved_prompt', markerAt);
    const openEnd = source.indexOf('>', markerAt + markerLength);
    const closeAt = openEnd >= 0 ? source.indexOf('</saved_prompt>', openEnd + 1) : -1;
    if (openAt < cursor || openEnd < markerAt || closeAt < 0) {
      output += source.slice(cursor, markerAt + markerLength);
      cursor = markerAt + markerLength;
      continue;
    }
    output += source.slice(cursor, openAt);
    if (!found) output += replacement;
    found = true;
    cursor = closeAt + '</saved_prompt>'.length;
  }
  output += source.slice(cursor);
  return { prompt: output, found };
}

function backtrackLineDiff(trace, previousLines, currentLines) {
  let oldIndex = previousLines.length;
  let newIndex = currentLines.length;
  const reversed = [];
  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const previous = trace[distance - 1];
    const diagonal = oldIndex - newIndex;
    const left = previous.has(diagonal - 1) ? previous.get(diagonal - 1) : -Infinity;
    const right = previous.has(diagonal + 1) ? previous.get(diagonal + 1) : -Infinity;
    const previousDiagonal = diagonal === -distance
      || (diagonal !== distance && left < right)
      ? diagonal + 1
      : diagonal - 1;
    const previousOld = previous.get(previousDiagonal) ?? 0;
    const previousNew = previousOld - previousDiagonal;
    while (oldIndex > previousOld && newIndex > previousNew) {
      reversed.push({ tag: 'eq', line: previousLines[oldIndex - 1] });
      oldIndex -= 1;
      newIndex -= 1;
    }
    if (oldIndex === previousOld) {
      newIndex -= 1;
      reversed.push({ tag: 'add', line: currentLines[newIndex] });
    } else {
      oldIndex -= 1;
      reversed.push({ tag: 'del', line: previousLines[oldIndex] });
    }
  }
  while (oldIndex > 0 && newIndex > 0) {
    reversed.push({ tag: 'eq', line: previousLines[oldIndex - 1] });
    oldIndex -= 1;
    newIndex -= 1;
  }
  while (oldIndex > 0) {
    oldIndex -= 1;
    reversed.push({ tag: 'del', line: previousLines[oldIndex] });
  }
  while (newIndex > 0) {
    newIndex -= 1;
    reversed.push({ tag: 'add', line: currentLines[newIndex] });
  }
  return reversed.reverse();
}

// Myers is linear for the common case (few edits in a long Markdown) and is
// bounded so a genuinely rewritten 2 MB file cannot monopolize Electron main.
function lineDiffOperations(previousLines, currentLines) {
  const maxDistance = Math.min(
    previousLines.length + currentLines.length,
    FILE_DIFF_MAX_DISTANCE,
  );
  let work = 0;
  let frontier = new Map([[1, 0]]);
  const trace = [];
  for (let distance = 0; distance <= maxDistance; distance += 1) {
    const next = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      work += 1;
      if (work > FILE_DIFF_MAX_WORK) return null;
      const left = frontier.has(diagonal - 1) ? frontier.get(diagonal - 1) : -Infinity;
      const right = frontier.has(diagonal + 1) ? frontier.get(diagonal + 1) : -Infinity;
      let oldIndex = diagonal === -distance
        || (diagonal !== distance && left < right)
        ? (Number.isFinite(right) ? right : 0)
        : (Number.isFinite(left) ? left + 1 : 0);
      let newIndex = oldIndex - diagonal;
      while (oldIndex < previousLines.length && newIndex < currentLines.length
        && previousLines[oldIndex] === currentLines[newIndex]) {
        work += 1;
        if (work > FILE_DIFF_MAX_WORK) return null;
        oldIndex += 1;
        newIndex += 1;
      }
      next.set(diagonal, oldIndex);
      if (oldIndex >= previousLines.length && newIndex >= currentLines.length) {
        trace.push(next);
        return backtrackLineDiff(trace, previousLines, currentLines);
      }
    }
    trace.push(next);
    frontier = next;
  }
  return null;
}

function fallbackLineOperations(previousLines, currentLines) {
  return [
    ...previousLines.map((line) => ({ tag: 'del', line })),
    ...currentLines.map((line) => ({ tag: 'add', line })),
  ];
}

function changedHunks(before, after, contextLines = FILE_DIFF_CONTEXT_LINES) {
  const previous = before.split('\n');
  const current = after.split('\n');
  let prefix = 0;
  while (prefix < previous.length && prefix < current.length
    && previous[prefix] === current[prefix]) prefix += 1;
  let previousEnd = previous.length;
  let currentEnd = current.length;
  while (previousEnd > prefix && currentEnd > prefix
    && previous[previousEnd - 1] === current[currentEnd - 1]) {
    previousEnd -= 1;
    currentEnd -= 1;
  }
  if (prefix === previous.length && prefix === current.length) {
    return { hunks: [], changedLineCount: 0, fallback: false };
  }

  const previousMiddle = previous.slice(prefix, previousEnd);
  const currentMiddle = current.slice(prefix, currentEnd);
  const calculated = lineDiffOperations(previousMiddle, currentMiddle);
  const leadingContext = Math.min(contextLines, prefix);
  const trailingContext = Math.min(
    contextLines,
    previous.length - previousEnd,
    current.length - currentEnd,
  );
  const operations = [
    ...previous.slice(prefix - leadingContext, prefix).map((line) => ({ tag: 'eq', line })),
    ...(calculated || fallbackLineOperations(previousMiddle, currentMiddle)),
    ...previous.slice(previousEnd, previousEnd + trailingContext).map((line) => ({ tag: 'eq', line })),
  ];
  const positions = [];
  let oldLine = prefix - leadingContext + 1;
  let newLine = prefix - leadingContext + 1;
  for (const operation of operations) {
    positions.push({ oldLine, newLine });
    if (operation.tag !== 'add') oldLine += 1;
    if (operation.tag !== 'del') newLine += 1;
  }
  const changedIndexes = operations.map((operation, index) => (
    operation.tag === 'eq' ? -1 : index
  )).filter((index) => index >= 0);
  if (changedIndexes.length === 0) {
    return { hunks: [], changedLineCount: 0, fallback: !calculated };
  }

  const groups = [];
  let first = changedIndexes[0];
  let last = first;
  for (const index of changedIndexes.slice(1)) {
    let equalGap = 0;
    for (let cursor = last + 1; cursor < index; cursor += 1) {
      if (operations[cursor].tag === 'eq') equalGap += 1;
    }
    if (equalGap > contextLines * 2) {
      groups.push({ first, last });
      first = index;
    }
    last = index;
  }
  groups.push({ first, last });

  const hunks = groups.map((group) => {
    const start = Math.max(0, group.first - contextLines);
    const end = Math.min(operations.length, group.last + contextLines + 1);
    const entries = operations.slice(start, end);
    const removed = entries.filter((entry) => entry.tag === 'del').length;
    const added = entries.filter((entry) => entry.tag === 'add').length;
    const oldCount = entries.filter((entry) => entry.tag !== 'add').length;
    const newCount = entries.filter((entry) => entry.tag !== 'del').length;
    return {
      oldStart: positions[start]?.oldLine ?? prefix + 1,
      newStart: positions[start]?.newLine ?? prefix + 1,
      oldCount,
      newCount,
      removed,
      added,
      changedLineCount: Math.max(removed, added),
      entries,
    };
  });
  return {
    hunks,
    changedLineCount: hunks.reduce((sum, hunk) => sum + hunk.changedLineCount, 0),
    fallback: !calculated,
  };
}

function changedFilePresentation(before, after) {
  const diff = changedHunks(before, after);
  const hunks = diff.hunks;
  const first = hunks[0] || { newStart: 1 };
  const last = hunks[hunks.length - 1] || first;
  const endLine = Math.max(first.newStart, last.newStart + Math.max(0, last.newCount - 1));
  const text = hunks.map((hunk) => (
    '@@ -' + hunk.oldStart + ',' + hunk.oldCount
      + ' +' + hunk.newStart + ',' + hunk.newCount + ' @@\n'
      + hunk.entries.map((entry) => (
        entry.tag === 'eq' ? '  ' + entry.line : entry.tag === 'del' ? '- ' + entry.line : '+ ' + entry.line
      )).join('\n')
  )).join('\n\n');
  return {
    ...diff,
    startLine: first.newStart,
    endLine,
    text,
  };
}

function splitFileLines(text) {
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body ? body.split('\n') : [], finalNewline };
}

function normalizeReadRanges(ranges) {
  const sorted = (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({ start: Number(range?.start), end: Number(range?.end) }))
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end)
      && range.start > 0 && range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function readRangesContainLine(ranges, line) {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function numberedReadRanges(result, currentLines, allowTabNumbers = false) {
  const verified = [];
  for (const rawLine of String(result || '').replace(/\r\n?/g, '\n').split('\n')) {
    const arrow = /^\s*(\d+)\u2192(.*)$/.exec(rawLine);
    const tabbed = allowTabNumbers ? /^\s*(\d+)\t(.*)$/.exec(rawLine) : null;
    const match = arrow || tabbed;
    if (!match) continue;
    const line = Number(match[1]);
    if (!Number.isInteger(line) || line <= 0 || currentLines[line - 1] !== match[2]) continue;
    verified.push({ start: line, end: line });
  }
  return normalizeReadRanges(verified);
}

function exactRawReadRange(result, currentLines, requested = null) {
  const normalized = String(result ?? '').replace(/\r\n?/g, '\n');
  const resultLines = splitFileLines(normalized).lines;
  if (resultLines.length === 0) return null;
  const matchesAt = (start) => start >= 1
    && start - 1 + resultLines.length <= currentLines.length
    && resultLines.every((line, index) => currentLines[start - 1 + index] === line);
  if (requested?.start) {
    if (!matchesAt(requested.start)) return null;
    if (requested.end && requested.start + resultLines.length - 1 > requested.end) return null;
    return { start: requested.start, end: requested.start + resultLines.length - 1 };
  }
  const candidates = [];
  for (let start = 1; start <= currentLines.length - resultLines.length + 1; start += 1) {
    if (matchesAt(start)) candidates.push(start);
    if (candidates.length > 1) return null;
  }
  return candidates.length === 1
    ? { start: candidates[0], end: candidates[0] + resultLines.length - 1 }
    : null;
}

function resolveReadAction(step, cwd) {
  const tool = String(step?.tool || '');
  const args = step?.args || {};
  const direct = tool === 'Read' || tool === 'read_file';
  const classified = classifyHistoryAction({
    toolName: tool,
    args,
    family: step?.family,
    bashWord: step?.bashWord,
  });
  if (!direct && !(tool === 'Bash' && (step?.family || classified.family) === 'read')) return null;
  const meta = historyActionPresentationMeta({
    toolName: tool,
    args,
    family: step?.family || classified.family,
    bashWord: step?.bashWord || classified.bashWord,
    bashDetail: step?.bashDetail || classified.bashDetail,
  });
  let target = direct ? String(args.file_path || args.path || '') : String(meta.targetKey || '');
  if (!target || target === '(image)' || target.includes('$')) return null;
  if (target === '~') target = os.homedir();
  else if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
  const filePath = path.resolve(cwd || '/', target);
  let requested = null;
  if (direct) {
    const start = Number.isInteger(Number(args.offset)) && Number(args.offset) > 0
      ? Number(args.offset)
      : 1;
    const limit = Number.isInteger(Number(args.limit)) && Number(args.limit) > 0
      ? Number(args.limit)
      : null;
    requested = { start, end: limit ? start + limit - 1 : null };
  } else {
    const headline = historyActionHeadline({
      toolName: tool,
      args,
      family: step?.family || classified.family,
      bashWord: step?.bashWord || classified.bashWord,
      bashDetail: step?.bashDetail || classified.bashDetail,
    });
    const numeric = /^(\d+)[\u2013-](\d+)$/.exec(headline.detail || '');
    const first = /^first (\d+)$/.exec(headline.detail || '');
    if (numeric) requested = { start: Number(numeric[1]), end: Number(numeric[2]) };
    else if (first) requested = { start: 1, end: Number(first[1]) };
  }
  return {
    filePath,
    direct,
    requested,
    allowTabNumbers: direct || (step?.bashWord || classified.bashWord) === 'nl',
    bashWord: step?.bashWord || classified.bashWord || '',
  };
}

function resolveShellEditAction(step, cwd) {
  if (step?.kind !== 'tool' || step?.tool !== 'Bash') return null;
  const args = step.args || {};
  const classified = classifyHistoryAction({
    toolName: step.tool,
    args,
  });
  if (classified.family !== 'edit') return null;
  const meta = historyActionPresentationMeta({
    toolName: step.tool,
    args,
    family: classified.family,
    bashWord: classified.bashWord,
    bashDetail: classified.bashDetail,
  });
  let target = String(meta.targetKey || '').trim();
  if (!target || target.includes('$') || /[*?{}[\]<>|]/.test(target)) return null;
  if (target === '~') target = os.homedir();
  else if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
  return { filePath: path.resolve(cwd || '/', target) };
}

function explicitShellExitCode(result) {
  if (result == null) return null;
  const text = typeof result === 'string' ? result : (() => {
    try { return JSON.stringify(result); } catch { return String(result); }
  })();
  for (const pattern of [
    /["']exit_code["']\s*:\s*(-?\d+)/i,
    /\bexit[_ ]code(?:\s*[:=]|\s+)\s*(-?\d+)/i,
    /^\s*(?:process|command) exited with (?:status|code)\s+(-?\d+)\s*$/im,
  ]) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

function shellEditStepSucceeded(step) {
  if (step?.isError) return false;
  const exitCode = explicitShellExitCode(step?.result);
  return exitCode === null || exitCode === 0;
}

function shellOperationCouldProduceTransition(operation, transition) {
  if (!operation || !transition
    || operation.targetTabId !== transition.targetTabId
    || operation.filePath !== transition.filePath
    || !Number.isFinite(operation.startedAt)
    || !Number.isFinite(transition.afterMtimeMs)) return false;
  // Transcript delivery can lag fs.watch. In the normal order, the durable
  // row still has transition.beforeHash when the call is observed. In the
  // inverted order, accept only an exact transition that already existed in
  // our in-memory ledger after the provider call. Keep every such transition:
  // if another writer also touched the path, degree-one matching must fail
  // closed instead of assigning whichever transition happens to be the head.
  const versionMatches = operation.beforeHash === transition.beforeHash
    || (operation.lateTransitionIds || []).includes(String(transition.id));
  if (!versionMatches) return false;
  const earliest = operation.startedAt - SHELL_EDIT_CLOCK_SKEW_MS;
  if (transition.afterMtimeMs < earliest) return false;
  if (!Number.isFinite(operation.completedAt)) {
    return transition.afterMtimeMs - operation.startedAt <= SHELL_EDIT_MAX_DURATION_MS;
  }
  if (operation.completedAt + SHELL_EDIT_CLOCK_SKEW_MS < transition.afterMtimeMs) return false;
  return operation.completedAt - operation.startedAt <= SHELL_EDIT_MAX_DURATION_MS;
}

function verifiedReadCoverage(step, currentText, cwd) {
  if (step?.result === undefined || step?.isError) return null;
  const action = resolveReadAction(step, cwd);
  if (!action) return null;
  const normalizedCurrent = String(currentText || '').replace(/\r\n?/g, '\n');
  const current = splitFileLines(normalizedCurrent);
  const normalizedResult = String(step.result ?? '').replace(/\r\n?/g, '\n');
  if (normalizedResult === normalizedCurrent
    || (current.finalNewline && normalizedResult + '\n' === normalizedCurrent)) {
    return {
      filePath: action.filePath,
      ranges: current.lines.length > 0 ? [{ start: 1, end: current.lines.length }] : [],
      full: true,
    };
  }
  const numbered = numberedReadRanges(normalizedResult, current.lines, action.allowTabNumbers);
  if (numbered.length > 0) {
    return { filePath: action.filePath, ranges: numbered, full: false };
  }
  let requested = action.requested;
  if (!requested && action.bashWord === 'tail') {
    const headline = historyActionHeadline({
      toolName: step.tool,
      args: step.args,
      family: step.family,
      bashWord: step.bashWord,
      bashDetail: step.bashDetail,
    });
    const tail = /^last (\d+)$/.exec(headline.detail || '');
    if (tail) {
      const count = Math.min(current.lines.length, Number(tail[1]));
      requested = { start: current.lines.length - count + 1, end: current.lines.length };
    }
  }
  const exact = exactRawReadRange(normalizedResult, current.lines, requested);
  return exact ? { filePath: action.filePath, ranges: [exact], full: false } : null;
}

function acknowledgeReadCoverage(before, after, coverage) {
  if (before === after) return before;
  if (coverage?.full) return after;
  const ranges = normalizeReadRanges(coverage?.ranges);
  if (ranges.length === 0) return before;
  const previous = before.split('\n');
  const current = after.split('\n');
  const operations = lineDiffOperations(previous, current);
  if (!operations) return before;
  const output = [];
  let newLine = 1;
  for (let index = 0; index < operations.length;) {
    if (operations[index].tag === 'eq') {
      output.push(operations[index].line);
      newLine += 1;
      index += 1;
      continue;
    }
    const oldLines = [];
    const newLines = [];
    const blockNewStart = newLine;
    while (index < operations.length && operations[index].tag !== 'eq') {
      const operation = operations[index];
      if (operation.tag === 'del') oldLines.push(operation.line);
      else { newLines.push(operation.line); newLine += 1; }
      index += 1;
    }
    const blockLines = newLines.map((_, offset) => blockNewStart + offset);
    const deletionAnchor = Math.max(1, Math.min(current.length, blockNewStart));
    const complete = newLines.length > 0
      ? blockLines.every((line) => readRangesContainLine(ranges, line))
      : current.length > 0 && readRangesContainLine(ranges, deletionAnchor);
    if (complete) {
      output.push(...newLines);
      continue;
    }
    if (oldLines.length === newLines.length) {
      for (let offset = 0; offset < oldLines.length; offset += 1) {
        output.push(readRangesContainLine(ranges, blockNewStart + offset)
          ? newLines[offset]
          : oldLines[offset]);
      }
    } else if (oldLines.length === 0) {
      for (let offset = 0; offset < newLines.length; offset += 1) {
        if (readRangesContainLine(ranges, blockNewStart + offset)) output.push(newLines[offset]);
      }
    } else {
      // An unbalanced replacement cannot be split without inventing which old
      // line corresponds to which new one. Keep it until its whole new span is
      // proven read; a full-file read still clears it through the branch above.
      output.push(...oldLines);
    }
  }
  return output.join('\n');
}

// patch_apply_end already carries source line coordinates. Apply those
// coordinates to one exact file version instead of guessing which repeated
// old_string Codex changed.
function applyDiffHunks(before, hunks) {
  if (!Array.isArray(hunks) || hunks.length === 0) return null;
  const source = splitFileLines(before);
  const output = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const oldStart = Number(hunk?.oldStart);
    const newStart = Number(hunk?.newStart);
    const entries = hunk?.entries;
    if (!Number.isInteger(oldStart) || oldStart < 0
      || !Number.isInteger(newStart) || newStart < 0
      || !Array.isArray(entries)) return null;
    const sourceIndex = oldStart === 0 ? 0 : oldStart - 1;
    const outputIndex = newStart === 0 ? 0 : newStart - 1;
    if (sourceIndex < cursor || sourceIndex > source.lines.length) return null;
    output.push(...source.lines.slice(cursor, sourceIndex));
    if (output.length !== outputIndex) return null;
    cursor = sourceIndex;
    for (const entry of entries) {
      const tag = entry?.tag;
      const line = typeof entry?.line === 'string' ? entry.line : null;
      if (!line && line !== '') return null;
      if (tag === 'add') {
        output.push(line);
        continue;
      }
      if ((tag !== 'eq' && tag !== 'del') || source.lines[cursor] !== line) return null;
      if (tag === 'eq') output.push(line);
      cursor += 1;
    }
  }
  output.push(...source.lines.slice(cursor));
  return output.join('\n') + (source.finalNewline ? '\n' : '');
}

function applyOwnedEdit(before, { args = {}, tool = '', diffHunks = null } = {}) {
  if (typeof before !== 'string') return null;
  if (/write/i.test(tool)) return typeof args.content === 'string' ? args.content : null;
  const positioned = applyDiffHunks(before, diffHunks);
  if (positioned !== null) return positioned;
  let expected = before;
  for (const edit of Array.isArray(args.edits) ? args.edits : [args]) {
    const old = edit?.old_string ?? edit?.oldText;
    const next = edit?.new_string ?? edit?.newText;
    if (typeof old !== 'string' || !old || typeof next !== 'string') return null;
    const at = expected.indexOf(old);
    if (at < 0) return null;
    if (edit.replace_all) expected = expected.split(old).join(next);
    else {
      // Without a line-aware patch, a repeated fragment has no exact owner.
      if (expected.indexOf(old, at + old.length) >= 0) return null;
      expected = expected.slice(0, at) + next + expected.slice(at + old.length);
    }
  }
  return expected;
}

function fileUpdatePresentation(filePath, before, after, beforeHash, afterHash) {
  const diff = changedFilePresentation(before, after);
  return {
    title: path.basename(filePath) + ':' + diff.startLine + '-' + diff.endLine,
    text: 'Working context changed in ' + filePath + '\nVersions: '
      + beforeHash + ' -> ' + afterHash + '\n' + diff.text,
    diff,
  };
}

function pluralRu(value, one, few, many) {
  const n = Math.abs(Number(value)) % 100;
  const tail = n % 10;
  if (n > 10 && n < 20) return many;
  if (tail === 1) return one;
  if (tail >= 2 && tail <= 4) return few;
  return many;
}

function normalizeFileSource(value) {
  if (!value || typeof value !== 'object' || !clean(value.tabId)) return null;
  return {
    tabId: clean(value.tabId),
    tabName: clean(value.tabName) || clean(value.tabId),
    projectId: clean(value.projectId) || null,
    sessionId: clean(value.sessionId) || null,
    operationId: clean(value.operationId) || null,
  };
}

function mergeFileSources(...groups) {
  const byTab = new Map();
  for (const source of groups.flat().map(normalizeFileSource).filter(Boolean)) {
    const previous = byTab.get(source.tabId);
    byTab.set(source.tabId, {
      ...previous,
      ...source,
      tabName: source.tabName || previous?.tabName || source.tabId,
    });
  }
  return [...byTab.values()];
}

function normalizeFileProvenance(value) {
  const source = normalizeFileSource(value?.source);
  const beforeHash = clean(value?.beforeHash);
  const afterHash = clean(value?.afterHash);
  if (!source || !beforeHash || !afterHash || beforeHash === afterHash) return null;
  return { beforeHash, afterHash, source };
}

function mergeFileProvenance(...groups) {
  const byEdge = new Map();
  for (const edge of groups.flat().map(normalizeFileProvenance).filter(Boolean)) {
    const key = edge.beforeHash + '\0' + edge.afterHash + '\0' + edge.source.tabId;
    byEdge.set(key, edge);
  }
  return [...byEdge.values()];
}

function provenanceCoversTransition(beforeHash, afterHash, provenance) {
  if (beforeHash === afterHash) return true;
  const byBefore = new Map();
  for (const edge of provenance || []) {
    if (!byBefore.has(edge.beforeHash)) byBefore.set(edge.beforeHash, []);
    byBefore.get(edge.beforeHash).push(edge.afterHash);
  }
  const pending = [beforeHash];
  const seen = new Set(pending);
  while (pending.length > 0 && seen.size <= 4096) {
    const current = pending.shift();
    for (const next of byBefore.get(current) || []) {
      if (next === afterHash) return true;
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

function fileSourceSummary(changes) {
  const sources = mergeFileSources(changes.flatMap((change) => change.sources || []));
  const unknown = changes.some((change) => change.unknownSource !== false);
  return {
    sources,
    unknown,
    detail: [
      ...sources.map((source) => source.tabName),
      ...(unknown ? ['Внешнее изменение'] : []),
    ].join(', '),
  };
}

function normalizeFileChange(value) {
  if (!value || typeof value !== 'object' || !clean(value.path)) return null;
  const beforeText = typeof value.beforeText === 'string' ? value.beforeText : null;
  const afterText = typeof value.afterText === 'string' ? value.afterText : null;
  if (beforeText === null || afterText === null) return null;
  const beforeHash = clean(value.beforeHash) || hash(beforeText);
  const afterHash = clean(value.afterHash) || hash(afterText);
  const acknowledgedText = typeof value.acknowledgedText === 'string'
    ? value.acknowledgedText
    : null;
  const afterMtimeMs = value.afterMtimeMs != null && Number.isFinite(Number(value.afterMtimeMs))
    ? Number(value.afterMtimeMs)
    : null;
  return {
    path: path.resolve(value.path),
    beforeHash,
    afterHash,
    beforeText,
    afterText,
    acknowledgedText,
    afterMtimeMs,
    sources: mergeFileSources(value.sources || []),
    provenance: mergeFileProvenance(value.provenance || []),
    unknownSource: value.unknownSource !== false,
    presentationVersion: Number(value.presentationVersion) || 1,
  };
}

function effectiveFileChangeBeforeText(change) {
  return typeof change?.acknowledgedText === 'string'
    ? change.acknowledgedText
    : change?.beforeText;
}

function fileChangeIsPending(change) {
  const before = effectiveFileChangeBeforeText(change);
  return typeof before === 'string' && typeof change?.afterText === 'string'
    && before !== change.afterText;
}

function fileChangesFromRow(row) {
  if (!row) return [];
  if (typeof row.file_changes_json === 'string' && row.file_changes_json) {
    try {
      const parsed = JSON.parse(row.file_changes_json);
      if (Array.isArray(parsed)) return parsed.map(normalizeFileChange).filter(Boolean);
    } catch {}
  }
  const legacy = normalizeFileChange({
    path: row.path,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    beforeText: row.before_text,
    afterText: row.after_text,
  });
  return legacy ? [legacy] : [];
}

function mergeFileChanges(changes, incoming) {
  const next = changes.map((item) => ({ ...item }));
  const normalized = normalizeFileChange(incoming);
  if (!normalized) return next;
  const index = next.findIndex((item) => item.path === normalized.path);
  if (index < 0) next.push(normalized);
  else {
    const previous = next[index];
    if (previous.afterHash === normalized.afterHash) {
      const sameTransition = previous.beforeHash === normalized.beforeHash;
      const provenance = mergeFileProvenance(previous.provenance, normalized.provenance);
      next[index] = {
        ...previous,
        acknowledgedText: previous.acknowledgedText ?? normalized.acknowledgedText,
        afterMtimeMs: Math.max(previous.afterMtimeMs || 0, normalized.afterMtimeMs || 0) || null,
        sources: mergeFileSources(previous.sources, normalized.sources),
        unknownSource: sameTransition
          ? !provenanceCoversTransition(previous.beforeHash, previous.afterHash, provenance)
          : previous.unknownSource || normalized.unknownSource,
        provenance,
      };
      return next;
    }
    const provenance = mergeFileProvenance(previous.provenance, normalized.provenance);
    next[index] = {
      path: normalized.path,
      beforeHash: previous.beforeHash,
      beforeText: previous.beforeText,
      afterHash: normalized.afterHash,
      afterText: normalized.afterText,
      acknowledgedText: previous.acknowledgedText,
      afterMtimeMs: normalized.afterMtimeMs,
      sources: mergeFileSources(previous.sources, normalized.sources),
      provenance,
      unknownSource: !provenanceCoversTransition(previous.beforeHash, normalized.afterHash, provenance),
    };
  }
  return next.filter(fileChangeIsPending);
}

function fileBatchPresentation(changes) {
  const normalized = changes.map(normalizeFileChange).filter(Boolean);
  const spans = normalized.map((item) => ({
    item,
    presentation: fileUpdatePresentation(
      item.path,
      effectiveFileChangeBeforeText(item),
      item.afterText,
      hash(effectiveFileChangeBeforeText(item)),
      item.afterHash,
    ),
  }));
  const lines = spans.reduce((sum, entry) => sum + entry.presentation.diff.changedLineCount, 0);
  const hunks = spans.reduce((sum, entry) => sum + entry.presentation.diff.hunks.length, 0);
  const lineLabel = lines + ' ' + pluralRu(lines, 'строка', 'строки', 'строк');
  const hunkLabel = hunks + ' ' + pluralRu(hunks, 'участок', 'участка', 'участков');
  const subject = normalized.length === 1
    ? path.basename(normalized[0].path)
    : normalized.length + ' ' + pluralRu(normalized.length, 'файл', 'файла', 'файлов');
  const source = fileSourceSummary(normalized);
  const title = subject + ' · ' + hunkLabel + ' · ' + lineLabel;
  return {
    title,
    text: (source.detail ? 'Sources: ' + source.detail + '\n\n' : '')
      + spans.map((entry) => entry.presentation.text).join('\n\n'),
    startLine: normalized.length === 1 ? spans[0].presentation.diff.startLine : null,
    endLine: normalized.length === 1 ? spans[0].presentation.diff.endLine : null,
    sourceTabId: source.sources.length === 1 && !source.unknown ? source.sources[0].tabId : null,
    sourceTabs: source.sources,
    hasUnknownSource: source.unknown,
  };
}

function fileChangeCounts(changes) {
  let hunks = 0;
  let lines = 0;
  for (const raw of changes) {
    const change = normalizeFileChange(raw);
    if (!change) continue;
    const diff = changedFilePresentation(
      effectiveFileChangeBeforeText(change),
      change.afterText,
    );
    hunks += diff.hunks.length;
    lines += diff.changedLineCount;
  }
  return { hunks, lines };
}

function fileChangeCountLabel(changes) {
  const counts = fileChangeCounts(changes);
  return {
    ...counts,
    title: counts.hunks + ' ' + pluralRu(counts.hunks, 'участок', 'участка', 'участков')
      + ' · ' + counts.lines + ' ' + pluralRu(counts.lines, 'строка', 'строки', 'строк'),
  };
}

function fileUpdatePaths(row) {
  if (row?.kind !== 'file' && row?.kind !== 'file-batch') return null;
  const changes = fileChangesFromRow(row);
  if (changes.length === 0) return null;
  return Array.from(new Set(changes.map((change) => change.path)));
}

function logicalFileUpdateId(tabId, status) {
  return 'file-context-' + hash(tabId + '\0' + status).slice(0, 32);
}

function groupedFileUpdatePresentation(tabId, status, entries) {
  const rawSections = entries.map(({ row, update }) => {
    const changes = fileChangesFromRow(row);
    const counts = fileChangeCountLabel(changes);
    const paths = Array.from(new Set(changes.map((change) => change.path)));
    const subject = paths.length > 1
      ? paths.length + ' ' + pluralRu(paths.length, 'файл', 'файла', 'файлов') + ' · '
      : '';
    return {
      id: row.id,
      title: subject + counts.title,
      hunkCount: counts.hunks,
      lineCount: counts.lines,
      paths,
      text: update.text,
      sourceTabId: update.sourceTabId,
      sourceTabs: update.sourceTabs,
      hasUnknownSource: update.hasUnknownSource,
      startLine: update.startLine,
      endLine: update.endLine,
      createdAt: update.createdAt,
    };
  });
  const totals = rawSections.reduce((sum, section) => ({
    hunks: sum.hunks + section.hunkCount,
    lines: sum.lines + section.lineCount,
  }), { hunks: 0, lines: 0 });
  const sourceTabs = mergeFileSources(rawSections.flatMap((section) => section.sourceTabs || []));
  const hasUnknownSource = rawSections.some((section) => section.hasUnknownSource);
  const memberIds = entries.map(({ row }) => row.id);
  const paths = Array.from(new Set(rawSections.flatMap((section) => section.paths)));
  const subject = paths.length === 1
    ? path.basename(paths[0])
    : paths.length + ' ' + pluralRu(paths.length, 'файл', 'файла', 'файлов');
  const title = subject
    + ' · ' + totals.hunks + ' ' + pluralRu(totals.hunks, 'участок', 'участка', 'участков')
    + ' · ' + totals.lines + ' ' + pluralRu(totals.lines, 'строка', 'строки', 'строк');
  let text = '';
  const sections = rawSections.map((section, index) => {
    if (index > 0) text += '\n\n';
    if (rawSections.length > 1) {
      text += 'Context section ' + (index + 1) + '/' + rawSections.length + ' · ' + section.title + '\n';
    }
    const textStart = text.length;
    text += section.text;
    const textEnd = text.length;
    const { text: _text, ...metadata } = section;
    return { ...metadata, textStart, textEnd };
  });
  return {
    id: logicalFileUpdateId(tabId, status),
    memberIds,
    title,
    text,
    kind: 'file-batch',
    path: paths.length === 1 ? paths[0] : null,
    sourceTabId: sourceTabs.length === 1 && !hasUnknownSource ? sourceTabs[0].tabId : null,
    sourceTabs,
    hasUnknownSource,
    sections,
    startLine: sections.length === 1 ? sections[0].startLine : null,
    endLine: sections.length === 1 ? sections[0].endLine : null,
    status,
    createdAt: Math.min(...sections.map((section) => section.createdAt)),
  };
}

class TabWorkContext {
  constructor({ db, listTabs, archivedTab, onChanged }) {
    this.db = db;
    this.listTabs = listTabs;
    this.archivedTab = archivedTab;
    this.onChanged = onChanged;
    this.watchers = new Map();
    this.reads = new Map();
    this.projectors = new Map();
    this.pendingEdits = new Map();
    this.shellEdits = new Map();
    this.fileTransitions = new Map();
    this.fileTransitionSequence = 0;
    this.fileTransitionBytes = 0;
    this.ownedHeads = new Map();
    this.subscriptions = new Map();
    this.subscriptionInflight = new Map();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tab_work_context (
        tab_id TEXT PRIMARY KEY, responsibility TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tab_context_files (
        tab_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', hash TEXT,
        error TEXT, PRIMARY KEY(tab_id, path)
      );
      CREATE TABLE IF NOT EXISTS tab_context_updates (
        id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, source_tab_id TEXT, request_key TEXT,
        title TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, path TEXT,
        before_hash TEXT, after_hash TEXT, before_text TEXT, after_text TEXT,
        start_line INTEGER, end_line INTEGER, file_changes_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, UNIQUE(tab_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS tab_context_updates_owner ON tab_context_updates(tab_id, status);
      CREATE TABLE IF NOT EXISTS tab_context_handoffs (
        tab_id TEXT NOT NULL, handoff_id TEXT NOT NULL, base_hash TEXT NOT NULL,
        prefix TEXT NOT NULL, prepared_prompt TEXT, payload_hash TEXT NOT NULL, update_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'preparing', created_at INTEGER NOT NULL,
        PRIMARY KEY(tab_id, handoff_id)
      );
      CREATE INDEX IF NOT EXISTS tab_context_handoffs_prompt
        ON tab_context_handoffs(tab_id, payload_hash, status);
    `);
    const updateColumns = new Set(
      this.db.prepare('PRAGMA table_info(tab_context_updates)').all().map((column) => column.name),
    );
    if (!updateColumns.has('file_changes_json')) {
      this.db.exec('ALTER TABLE tab_context_updates ADD COLUMN file_changes_json TEXT');
    }
    const handoffColumns = new Set(
      this.db.prepare('PRAGMA table_info(tab_context_handoffs)').all().map((column) => column.name),
    );
    if (!handoffColumns.has('prepared_prompt')) {
      this.db.exec('ALTER TABLE tab_context_handoffs ADD COLUMN prepared_prompt TEXT');
    }
    if (!handoffColumns.has('continuation_facts')) {
      this.db.exec("ALTER TABLE tab_context_handoffs ADD COLUMN continuation_facts TEXT NOT NULL DEFAULT '[]'");
    }
    this.consolidatePendingFileBatches();
  }

  configure({
    transcriptService,
    decodeCodexCall,
    decodeCodexPatch,
    readReceipts,
    resolveAttributionSource,
    readContinuationFacts,
    resolveContinuationWriteTarget,
  }) {
    this.transcriptService = transcriptService;
    this.decodeCodexCall = decodeCodexCall;
    this.decodeCodexPatch = decodeCodexPatch;
    this.readReceipts = readReceipts;
    this.resolveAttributionSource = resolveAttributionSource;
    this.readContinuationFacts = readContinuationFacts;
    this.resolveContinuationWriteTarget = resolveContinuationWriteTarget;
    // A staged UI send that never crossed the durable send boundary can be
    // restored. Unknown physical attempts keep their immutable attachment set.
    for (const row of this.db.prepare("SELECT * FROM tab_context_handoffs WHERE status='preparing'").all()) {
      const receipt = (readReceipts?.(row.tab_id) || []).find((r) => r.handoffId === row.handoff_id);
      if (receipt?.state === 'confirmed') this.confirm(row.tab_id, row.handoff_id, row.payload_hash);
      else if (!receipt || ['not-submitted', 'reserved', 'preparing'].includes(receipt.state)) {
        this.release(row.tab_id, row.handoff_id);
      }
    }
    void this.syncLinks().catch((error) => console.warn('[TabContext] startup:', error.message));
  }

  tab(tabId) {
    return this.listTabs().find((tab) => tab.tabId === tabId) || this.archivedTab?.(tabId) || null;
  }

  requireTab(tabId) {
    if (!clean(tabId) || !this.tab(tabId)) throw fail('tab not found', 404);
  }

  touch(tabId) {
    this.db.prepare(`INSERT INTO tab_work_context(tab_id, revision) VALUES (?, 1)
      ON CONFLICT(tab_id) DO UPDATE SET revision=revision+1`).run(tabId);
    this.onChanged?.(this.get(tabId));
  }

  sourceDescriptor(tabId, sessionId = null, operationId = null) {
    const tab = this.tab(tabId);
    return normalizeFileSource({
      tabId,
      tabName: tab?.name || tabId,
      projectId: tab?.projectId || null,
      sessionId,
      operationId,
    });
  }

  presentUpdate(row) {
    let title = row.title;
    let text = row.text;
    let startLine = row.start_line;
    let endLine = row.end_line;
    let sourceTabId = row.source_tab_id;
    let sourceTabs = [];
    let hasUnknownSource = false;
    if (row.kind === 'file' || row.kind === 'file-batch') {
      const changes = fileChangesFromRow(row);
      const source = fileSourceSummary(changes);
      sourceTabs = source.sources.map((stored) => {
        const live = this.tab(stored.tabId);
        return normalizeFileSource({
          ...stored,
          tabName: live?.name || stored.tabName,
          projectId: live?.projectId || stored.projectId,
        });
      }).filter(Boolean);
      hasUnknownSource = source.unknown;
      if (changes.length > 0
        && changes.some((change) => change.presentationVersion !== FILE_CHANGE_PRESENTATION_VERSION)) {
        const presentation = fileBatchPresentation(changes);
        title = presentation.title;
        text = presentation.text;
        startLine = presentation.startLine;
        endLine = presentation.endLine;
        sourceTabId = presentation.sourceTabId;
      }
    } else if (row.kind === 'message' && sourceTabId) {
      const source = this.sourceDescriptor(sourceTabId);
      sourceTabs = source ? [source] : [];
      if (source) text = 'Sources: ' + source.tabName + '\n\n' + text;
    }
    return {
      id: row.id,
      title,
      text,
      kind: row.kind,
      path: row.path,
      sourceTabId: sourceTabId || null,
      sourceTabs,
      hasUnknownSource,
      startLine: startLine ?? null,
      endLine: endLine ?? null,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  presentUpdates(rows) {
    const entries = rows.map((row) => ({
      row,
      update: this.presentUpdate(row),
      filePaths: fileUpdatePaths(row),
    }));
    const groups = new Map();
    for (const entry of entries) {
      if (!entry.filePaths) continue;
      const key = entry.row.status;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const emitted = new Set();
    const updates = [];
    for (const entry of entries) {
      if (!entry.filePaths) {
        updates.push({ ...entry.update, memberIds: [entry.row.id] });
        continue;
      }
      const key = entry.row.status;
      if (emitted.has(key)) continue;
      emitted.add(key);
      updates.push(groupedFileUpdatePresentation(
        entry.row.tab_id,
        entry.row.status,
        groups.get(key),
      ));
    }
    return updates;
  }

  get(tabId, tab = this.tab(tabId)) {
    const row = this.db.prepare('SELECT * FROM tab_work_context WHERE tab_id=?').get(tabId);
    const updateRows = this.db.prepare(`SELECT * FROM tab_context_updates
      WHERE tab_id=? AND status IN ('pending','sending') ORDER BY created_at, rowid`)
      .all(tabId);
    const updates = this.presentUpdates(updateRows);
    const files = this.db.prepare('SELECT path, hash, error FROM tab_context_files WHERE tab_id=? ORDER BY path').all(tabId);
    return {
      tabId, name: tab?.name || null, projectId: tab?.projectId || null,
      responsibility: row?.responsibility || '', revision: row?.revision || 0,
      files, updates, pendingCount: updates.filter((item) => item.status === 'pending').length,
      sessionId: tab?.codexSessionId || tab?.claudeSessionId || null,
      cwd: tab?.cwd || null,
    };
  }

  deliveredUpdatePresentation(tabId, prompt, updateId) {
    this.requireTab(tabId);
    if (typeof prompt !== 'string' || prompt.length > 2 * MAX_FILE_BYTES || !clean(updateId)) return null;
    const handoffs = this.db.prepare(`SELECT prepared_prompt, update_ids FROM tab_context_handoffs
      WHERE tab_id=? AND payload_hash=? AND status='delivered'`)
      .all(tabId, promptAuditFingerprint(prompt));
    let matching = null;
    for (const handoff of handoffs) {
      if (handoff.prepared_prompt !== prompt) continue;
      let memberIds;
      try { memberIds = JSON.parse(handoff.update_ids); } catch { continue; }
      if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > 256) continue;
      const rows = memberIds.map((id) => this.db.prepare(
        'SELECT * FROM tab_context_updates WHERE tab_id=? AND id=?',
      ).get(tabId, id));
      if (rows.some((row) => !row)) continue;
      const updates = this.presentUpdates(rows.map((row) => ({ ...row, status: 'pending' })));
      const update = updates.find((item) => item.id === updateId);
      if (!update || !prompt.includes(updateWrapper(update))) continue;
      const result = {
        id: update.id,
        title: update.title,
        text: update.text,
        sourceTabId: update.sourceTabId,
        sourceTabs: update.sourceTabs,
        hasUnknownSource: update.hasUnknownSource,
        sections: update.sections || [],
      };
      if (matching && JSON.stringify(matching) !== JSON.stringify(result)) return null;
      matching = result;
    }
    return matching;
  }

  list() {
    return this.listTabs().filter((tab) => tab.tabType !== 'file').map((tab) => {
      const state = this.get(tab.tabId, tab);
      return { ...state, updates: state.updates.map(({ text, sections, ...item }) => ({
        ...item,
        ...(sections ? { sections: sections.map(({ textStart: _start, textEnd: _end, ...section }) => section) } : {}),
      })) };
    });
  }

  setResponsibility(tabId, description) {
    this.requireTab(tabId);
    if (typeof description !== 'string' || description.length > 12000) throw fail('description must be text up to 12000 characters');
    this.db.prepare(`INSERT INTO tab_work_context(tab_id, responsibility) VALUES (?, ?)
      ON CONFLICT(tab_id) DO UPDATE SET responsibility=excluded.responsibility`).run(tabId, description.trim());
    this.touch(tabId);
    return this.get(tabId);
  }

  publish(tabId, { title, text, sourceTabId = null, requestId = null }) {
    this.requireTab(tabId);
    if (!clean(text) || text.length > 100000) throw fail('update text must contain 1-100000 characters');
    const key = clean(requestId) || null;
    const storedTitle = clean(title) || 'Обновление состояния';
    const existing = key && this.db.prepare('SELECT * FROM tab_context_updates WHERE tab_id=? AND request_key=?').get(tabId, key);
    if (existing) {
      if (existing.text !== text.trim() || existing.title !== storedTitle) throw fail('update requestId was reused with different content', 409);
      return { updateId: existing.id, deduplicated: true };
    }
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO tab_context_updates(id, tab_id, source_tab_id, request_key, title, text, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'message', ?)`).run(id, tabId, sourceTabId, key, storedTitle, text.trim(), Date.now());
    this.touch(tabId);
    void this.syncLinks().catch((e) => console.warn('[TabContext] update subscription:', e.message));
    return { updateId: id, deduplicated: false };
  }

  attributionBinding(tab, forceOwner = false) {
    const resolved = this.resolveAttributionSource?.(tab);
    if (resolved?.sessionId && ['claude', 'codex'].includes(resolved.toolType)) {
      return { toolType: resolved.toolType, sessionId: resolved.sessionId };
    }
    if (this.resolveAttributionSource) return null;
    if (!forceOwner) return null;
    const toolType = tab?.commandType?.startsWith('codex')
      ? 'codex'
      : tab?.commandType?.startsWith('claude')
        ? 'claude'
        : null;
    if (!toolType) return null;
    const sessionId = toolType === 'codex' ? tab?.codexSessionId : tab?.claudeSessionId;
    return sessionId ? { toolType, sessionId } : null;
  }

  pendingUpdateMemberIds(tabId, id, requestedIds = null) {
    this.requireTab(tabId);
    const pendingRows = this.db.prepare("SELECT * FROM tab_context_updates WHERE tab_id=? AND status='pending' ORDER BY created_at,rowid")
      .all(tabId);
    const logical = this.presentUpdates(pendingRows).find((update) => update.id === id);
    if (!logical) throw fail('update changed or is already being sent', 409);
    const available = new Set(logical.memberIds || [id]);
    const memberIds = Array.from(new Set((Array.isArray(requestedIds) && requestedIds.length > 0
      ? requestedIds
      : [...available]).map(String).filter(Boolean)));
    if (memberIds.length === 0 || memberIds.some((memberId) => !available.has(memberId))) {
      throw fail('context update group changed', 409);
    }
    return memberIds;
  }

  dismiss(tabId, id, requestedIds = null) {
    const memberIds = this.pendingUpdateMemberIds(tabId, id, requestedIds);
    this.db.transaction(() => {
      for (const memberId of memberIds) {
        const result = this.db.prepare("UPDATE tab_context_updates SET status='dismissed' WHERE id=? AND tab_id=? AND status='pending'")
          .run(memberId, tabId);
        if (!result.changes) throw fail('context update group changed', 409);
      }
    })();
    this.touch(tabId);
    return this.get(tabId);
  }

  deleteUpdate(tabId, id, requestedIds = null) {
    const memberIds = this.pendingUpdateMemberIds(tabId, id, requestedIds);
    this.db.transaction(() => {
      for (const memberId of memberIds) {
        // Keep a terminal tombstone: a publish_context_update retry with the
        // same requestId must not resurrect something the user deleted.
        const result = this.db.prepare("UPDATE tab_context_updates SET status='deleted' WHERE id=? AND tab_id=? AND status='pending'")
          .run(memberId, tabId);
        if (!result.changes) throw fail('context update group changed', 409);
      }
    })();
    this.touch(tabId);
    return this.get(tabId);
  }

  restoreDismissed(tabId, id, requestedIds = null) {
    this.requireTab(tabId);
    const memberIds = Array.from(new Set((Array.isArray(requestedIds) && requestedIds.length > 0
      ? requestedIds
      : [id]).map(String).filter(Boolean)));
    const rows = memberIds.map((memberId) => this.db.prepare(
      "SELECT * FROM tab_context_updates WHERE id=? AND tab_id=? AND status='dismissed'",
    ).get(memberId, tabId));
    if (rows.some((row) => !row)) throw fail('dismissed update group changed', 409);
    this.db.transaction(() => {
      for (const memberId of memberIds) {
        const result = this.db.prepare("UPDATE tab_context_updates SET status='pending' WHERE id=? AND tab_id=? AND status='dismissed'")
          .run(memberId, tabId);
        if (!result.changes) throw fail('dismissed update group changed', 409);
      }
    })();
    this.touch(tabId);
    return this.get(tabId);
  }

  async syncLinks() {
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = this._syncLinks();
    try { await this.syncing; } finally {
      this.syncing = null;
      if (this.syncAgain) { this.syncAgain = false; void this.syncLinks().catch((e) => console.warn('[TabContext] sync:', e.message)); }
    }
  }

  async _syncLinks() {
    const tabs = this.listTabs();
    const owners = new Map(tabs.map((tab) => [tab.tabId, tab]));
    const links = new Set();
    const dirs = new Set();
    const subscriptionIds = new Set();
    const linkedOwnerIds = new Set();
    for (const child of tabs) {
      if (child.tabType !== 'file' || !/\.(md|markdown)$/i.test(child.filePath || '')) continue;
      const owner = owners.get(child.visualParentTabId);
      if (!owner) continue;
      const filePath = path.resolve(child.filePath);
      linkedOwnerIds.add(owner.tabId);
      links.add(owner.tabId + '\0' + filePath);
      dirs.add(path.dirname(filePath));
      const inserted = this.db.prepare('INSERT OR IGNORE INTO tab_context_files(tab_id,path) VALUES (?,?)').run(owner.tabId, filePath);
      if (inserted.changes || !this.watchers.has(path.dirname(filePath))) await this.readFile(filePath);
    }
    const sourceBindings = new Map();
    for (const tab of tabs) {
      if (tab.tabType === 'file') continue;
      const isOwner = linkedOwnerIds.has(tab.tabId);
      if (!isOwner && linkedOwnerIds.size === 0) continue;
      const binding = this.attributionBinding(tab, isOwner);
      if (binding) sourceBindings.set(tab.tabId, { tab, ...binding });
    }
    for (const source of sourceBindings.values()) {
      const { tab, sessionId, toolType } = source;
      if (this.transcriptService) {
        const consumerId = 'tab-work-context:' + tab.tabId;
        subscriptionIds.add(consumerId);
        if (this.subscriptions.get(consumerId) !== sessionId && !this.subscriptionInflight.has(consumerId)) {
          const request = this.transcriptService.subscribe({ consumerId, tabId: tab.tabId, sessionId, toolType, cwd: tab.cwd })
            .then((subscribed) => { if (subscribed.success) this.subscriptions.set(consumerId, sessionId); })
            .catch((error) => console.warn('[TabContext] transcript unavailable:', tab.tabId, error.message))
            .finally(() => {
              this.subscriptionInflight.delete(consumerId);
              const current = this.listTabs().find((candidate) => candidate.tabId === tab.tabId);
              const desired = current ? this.attributionBinding(current, linkedOwnerIds.has(current.tabId))?.sessionId : null;
              if (desired !== sessionId) {
                void this.syncLinks().catch((error) => console.warn('[TabContext] rebind:', error.message));
              }
            });
          this.subscriptionInflight.set(consumerId, request);
        }
      }
    }
    for (const row of this.db.prepare('SELECT tab_id,path FROM tab_context_files').all()) {
      // Closed owners retain their baseline; reopening can catch offline edits.
      if (owners.has(row.tab_id) && !links.has(row.tab_id + '\0' + row.path)) {
        this.db.prepare('DELETE FROM tab_context_files WHERE tab_id=? AND path=?').run(row.tab_id, row.path);
        this.touch(row.tab_id);
      } else if (!owners.has(row.tab_id)) dirs.add(path.dirname(row.path));
    }
    for (const [dir, watcher] of this.watchers) if (!dirs.has(dir)) { watcher.close(); this.watchers.delete(dir); }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_event, name) => {
          const paths = this.db.prepare('SELECT DISTINCT path FROM tab_context_files').all()
            .filter((row) => path.dirname(row.path) === dir && (!name || path.basename(row.path) === String(name)));
          for (const row of paths) void this.readFile(row.path).catch((e) => console.warn('[TabContext] watch:', e.message));
        });
        watcher.on('error', (e) => console.warn('[TabContext] watcher:', dir, e.message));
        watcher.unref();
        this.watchers.set(dir, watcher);
        for (const file of this.db.prepare('SELECT DISTINCT path FROM tab_context_files').all()) {
          if (path.dirname(file.path) === dir) await this.readFile(file.path);
        }
      } catch (e) { console.warn('[TabContext] watcher unavailable:', dir, e.message); }
    }
    for (const id of this.subscriptions.keys()) if (!subscriptionIds.has(id)) {
      await this.transcriptService?.unsubscribe({ consumerId: id });
      this.subscriptions.delete(id);
    }
  }

  async readFile(filePath) {
    const previous = this.reads.get(filePath) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      let content;
      let modifiedAt = null;
      let error = null;
      try {
        const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          modifiedAt = Number(stat.mtimeMs) || null;
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw fail('Markdown file is unavailable or exceeds 2 MB');
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (!chunk.bytesRead) break;
            bytesRead += chunk.bytesRead;
          }
          if (bytesRead > MAX_FILE_BYTES) throw fail('Markdown file exceeds 2 MB');
          content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
        } finally { await handle.close(); }
      } catch (e) { error = String(e.message || e); }
      for (const row of this.db.prepare('SELECT * FROM tab_context_files WHERE path=?').all(filePath)) {
        if (error) {
          if (row.error === error) continue;
          this.db.prepare('UPDATE tab_context_files SET error=? WHERE tab_id=? AND path=?').run(error, row.tab_id, filePath);
          this.publishFileUpdate(row, { error });
          this.touch(row.tab_id);
          continue;
        }
        const digest = hash(content);
        if (digest === row.hash && !row.error) continue;
        const transition = row.hash && row.hash !== digest ? {
          id: ++this.fileTransitionSequence,
          targetTabId: row.tab_id,
          filePath,
          before: row.content,
          after: content,
          beforeHash: row.hash,
          afterHash: digest,
          afterMtimeMs: modifiedAt,
        } : null;
        this.db.transaction(() => {
          if (row.error) this.db.prepare("UPDATE tab_context_updates SET status='superseded' WHERE tab_id=? AND path=? AND kind='file-error' AND status='pending'").run(row.tab_id, filePath);
          if (row.hash && row.hash !== digest) this.publishFileUpdate(row, { content, digest, modifiedAt });
          this.db.prepare('UPDATE tab_context_files SET content=?, hash=?, error=NULL WHERE tab_id=? AND path=?')
            .run(content, digest, row.tab_id, filePath);
        })();
        if (transition) this.rememberFileTransition(transition);
        this.touch(row.tab_id);
      }
      this.reconcileShellEditProofs(filePath);
    });
    this.reads.set(filePath, work);
    try { await work; } finally { if (this.reads.get(filePath) === work) this.reads.delete(filePath); }
  }

  reservedUpdateIds(tabId) {
    const ids = new Set();
    for (const row of this.db.prepare('SELECT update_ids FROM tab_context_handoffs WHERE tab_id=?').all(tabId)) {
      try {
        for (const id of JSON.parse(row.update_ids || '[]')) ids.add(String(id));
      } catch {}
    }
    return ids;
  }

  pendingFileRows(tabId, { mutableOnly = false } = {}) {
    const rows = this.db.prepare(`SELECT * FROM tab_context_updates
      WHERE tab_id=? AND status='pending' AND kind IN ('file','file-batch')
      ORDER BY created_at,rowid`).all(tabId);
    if (!mutableOnly) return rows;
    const reserved = this.reservedUpdateIds(tabId);
    return rows.filter((row) => !reserved.has(row.id));
  }

  saveFileBatch(rowId, tabId, changes, emptyStatus = 'superseded') {
    const normalized = changes.map(normalizeFileChange).filter(Boolean)
      .filter(fileChangeIsPending)
      .map((item) => ({ ...item, presentationVersion: FILE_CHANGE_PRESENTATION_VERSION }));
    if (normalized.length === 0) {
      return this.db.prepare(`UPDATE tab_context_updates
        SET status=?,before_text=NULL,after_text=NULL,file_changes_json='[]'
        WHERE id=? AND tab_id=? AND status='pending'`).run(emptyStatus, rowId, tabId).changes > 0;
    }
    const presentation = fileBatchPresentation(normalized);
    const single = normalized.length === 1 ? normalized[0] : null;
    return this.db.prepare(`UPDATE tab_context_updates SET
      title=?,text=?,kind='file-batch',path=?,source_tab_id=?,before_hash=?,after_hash=?,
      before_text=?,after_text=?,start_line=?,end_line=?,file_changes_json=?
      WHERE id=? AND tab_id=? AND status='pending'`).run(
      presentation.title,
      presentation.text,
      single?.path || null,
      presentation.sourceTabId,
      single?.beforeHash || null,
      single?.afterHash || null,
      single?.beforeText || null,
      single?.afterText || null,
      presentation.startLine,
      presentation.endLine,
      JSON.stringify(normalized),
      rowId,
      tabId,
    ).changes > 0;
  }

  consolidatePendingFileBatches(tabId = null) {
    const ownerIds = tabId
      ? [tabId]
      : this.db.prepare(`SELECT DISTINCT tab_id FROM tab_context_updates
          WHERE status='pending' AND kind IN ('file','file-batch')`).all().map((row) => row.tab_id);
    for (const ownerId of ownerIds) {
      const rows = this.pendingFileRows(ownerId, { mutableOnly: true });
      if (rows.length === 0) continue;
      let changes = [];
      for (const row of rows) {
        for (const item of fileChangesFromRow(row)) changes = mergeFileChanges(changes, item);
      }
      this.saveFileBatch(rows[0].id, ownerId, changes);
      for (const row of rows.slice(1)) {
        this.db.prepare(`UPDATE tab_context_updates
          SET status='superseded',before_text=NULL,after_text=NULL,file_changes_json=NULL
          WHERE id=? AND tab_id=? AND status='pending'`).run(row.id, ownerId);
      }
    }
  }

  upsertPendingFileChange(tabId, incoming) {
    const rows = this.pendingFileRows(tabId, { mutableOnly: true });
    let changes = [];
    for (const row of rows) {
      for (const item of fileChangesFromRow(row)) changes = mergeFileChanges(changes, item);
    }
    changes = mergeFileChanges(changes, incoming);
    if (rows.length === 0) {
      if (changes.length === 0) return;
      const id = crypto.randomUUID();
      const first = changes[0];
      this.db.prepare(`INSERT INTO tab_context_updates(
        id,tab_id,title,text,kind,path,before_hash,after_hash,before_text,after_text,
        start_line,end_line,file_changes_json,created_at
      ) VALUES (?,?,'','', 'file-batch',?,?,?,?,?,NULL,NULL,?,?)`).run(
        id, tabId, first.path, first.beforeHash, first.afterHash,
        first.beforeText, first.afterText, JSON.stringify(changes), Date.now(),
      );
      this.saveFileBatch(id, tabId, changes);
      return;
    }
    this.saveFileBatch(rows[0].id, tabId, changes);
    for (const row of rows.slice(1)) {
      this.db.prepare(`UPDATE tab_context_updates
        SET status='superseded',before_text=NULL,after_text=NULL,file_changes_json=NULL
        WHERE id=? AND tab_id=? AND status='pending'`).run(row.id, tabId);
    }
  }

  latestPendingFileChange(tabId, filePath, afterHash) {
    const rows = this.pendingFileRows(tabId).reverse();
    for (const row of rows) {
      const match = fileChangesFromRow(row).find((item) => (
        item.path === filePath && item.afterHash === afterHash
      ));
      if (match) return match;
    }
    return null;
  }

  publishFileUpdate(row, { content, digest, modifiedAt, error }) {
    if (!error) {
      this.upsertPendingFileChange(row.tab_id, {
        path: row.path,
        beforeHash: row.hash,
        afterHash: digest,
        beforeText: row.content,
        afterText: content,
        afterMtimeMs: modifiedAt,
        sources: [],
        provenance: [],
        unknownSource: true,
      });
      return;
    }
    const presentation = error ? null
      : fileUpdatePresentation(row.path, row.content, content, row.hash, digest);
    const title = presentation?.title || path.basename(row.path) + ' · недоступен';
    const text = error
      ? 'Linked working file is unavailable: ' + row.path + '\n' + error
      : presentation.text;
    this.db.prepare(`INSERT INTO tab_context_updates(id,tab_id,title,text,kind,path,before_hash,after_hash,
      before_text,after_text,start_line,end_line,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), row.tab_id, title, text, error ? 'file-error' : 'file', row.path,
        row.hash, digest || null, error ? null : row.content, content ?? null,
        presentation?.span.startLine || null, presentation?.span.endLine || null, Date.now());
  }

  async prepare(tabId, handoffId, prompt) {
    if (!tabId || !handoffId || !String(prompt).trim() || isLocalSlashCommandPrompt(prompt)) return { prompt, prefix: '' };
    const saved = this.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (saved) {
      if (promptAuditFingerprint(prompt) === saved.payload_hash) return { prompt, prefix: saved.prefix };
      if (hash(prompt) !== saved.base_hash) throw fail('context handoff reused for another prompt', 409);
      return { prompt: saved.prepared_prompt || saved.prefix + prompt, prefix: saved.prefix };
    }
    if ((this.readReceipts?.(tabId) || []).some((receipt) => receipt.handoffId === handoffId)) {
      return { prompt, prefix: '' };
    }
    await this.syncLinks();
    for (const file of this.db.prepare('SELECT path FROM tab_context_files WHERE tab_id=?').all(tabId)) await this.readFile(file.path);
    // Quiet completion context is attached only to a new ordinary send. Do not
    // revive an old notification, touch the UI's dismissed chips, or read an
    // answer on the user's behalf. Unknown input delivery keeps the SAME frozen
    // handoff; it is not permission to attach this fact to a new preparation.
    // Explicit retry of a DIFFERENT proven-unsent frozen prompt may repeat its
    // read-only facts (user decision15.09); it is governed by its own receipt.
    let continuationFacts = [];
    if (this.readContinuationFacts && !handoffId.startsWith('orchestration-complete:')) {
      const source = this.resolveAttributionSource?.(this.tab(tabId));
      if (source?.sessionId && source.toolType) {
        try {
          continuationFacts = await this.readContinuationFacts({ tabId, ...source });
        } catch (error) {
          console.warn('[OrchestrationContext] unavailable tab=' + tabId.slice(-12) + ' error=' + error.message);
        }
        const currentSource = this.resolveAttributionSource?.(this.tab(tabId));
        if (source.sessionId !== currentSource?.sessionId || source.toolType !== currentSource?.toolType) continuationFacts = [];
      }
    }
    // Another caller may have reserved this same handoff while file IO yielded.
    if (this.db.prepare('SELECT 1 FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId)) {
      return this.prepare(tabId, handoffId, prompt);
    }
    if (continuationFacts.length) {
      const claimedFacts = new Set(this.db.prepare(`SELECT continuation_facts FROM tab_context_handoffs
        WHERE tab_id=? AND status IN ('preparing','delivered') AND continuation_facts!='[]'`).all(tabId)
        .flatMap(row => JSON.parse(row.continuation_facts)));
      continuationFacts = continuationFacts.filter(fact => !claimedFacts.has(fact.id)).slice(0, 8);
    }
    const updateRows = this.db.prepare("SELECT * FROM tab_context_updates WHERE tab_id=? AND status='pending' ORDER BY created_at,rowid")
      .all(tabId);
    const updates = this.presentUpdates(updateRows);
    const memberIds = updateRows.map((row) => row.id);
    let preparedBase = prompt;
    const missing = [];
    for (const update of updates) {
      const refreshed = refreshUpdateWrapper(preparedBase, update);
      preparedBase = refreshed.prompt;
      if (!refreshed.found) missing.push(update);
    }
    const prefix = [completionContextText(continuationFacts), ...missing.map(updateWrapper)].filter(Boolean).join('\n\n');
    const separatorPrefix = prefix ? prefix + '\n\n' : '';
    const full = separatorPrefix + preparedBase;
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO tab_context_handoffs(
        tab_id,handoff_id,base_hash,prefix,prepared_prompt,payload_hash,update_ids,created_at,continuation_facts
      ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        tabId, handoffId, hash(prompt), separatorPrefix, full,
        promptAuditFingerprint(full), JSON.stringify(memberIds), Date.now(), JSON.stringify(continuationFacts.map(fact => fact.id)),
      );
      for (const id of memberIds) {
        this.db.prepare("UPDATE tab_context_updates SET status='sending' WHERE id=? AND status='pending'").run(id);
      }
    })();
    if (updates.length) this.touch(tabId);
    if (continuationFacts.length) console.log('[OrchestrationContext] prepared tab=' + tabId.slice(-12)
      + ' handoff=' + handoffId + ' facts=' + continuationFacts.length + ' (not result/delivery proof)');
    return { prompt: full, prefix: separatorPrefix };
  }

  confirm(tabId, handoffId, expectedHash) {
    const sent = this.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (!sent || sent.payload_hash !== expectedHash || sent.status === 'delivered') return;
    this.db.transaction(() => {
      for (const id of JSON.parse(sent.update_ids)) {
        this.db.prepare("UPDATE tab_context_updates SET status='delivered',before_text=NULL,after_text=NULL WHERE id=? AND tab_id=? AND status='sending'").run(id, tabId);
      }
      this.db.prepare("UPDATE tab_context_handoffs SET status='delivered' WHERE tab_id=? AND handoff_id=?").run(tabId, handoffId);
    })();
    this.touch(tabId);
  }

  activate(tabId, handoffId) {
    const sent = this.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (!sent || sent.status === 'delivered') return;
    let changed = 0;
    this.db.transaction(() => {
      for (const id of JSON.parse(sent.update_ids)) changed += this.db.prepare("UPDATE tab_context_updates SET status='sending' WHERE id=? AND tab_id=? AND status='pending'").run(id, tabId).changes;
      this.db.prepare("UPDATE tab_context_handoffs SET status='preparing' WHERE tab_id=? AND handoff_id=?").run(tabId, handoffId);
    })();
    if (changed) this.touch(tabId);
  }

  hasHandoff(tabId, handoffId) {
    return !!this.db.prepare('SELECT 1 FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
  }

  assertContinuationScope(tabId, handoffId, { atWrite = false } = {}) {
    if (!tabId || !handoffId) return;
    const saved = this.db.prepare('SELECT continuation_facts FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (!saved || saved.continuation_facts === '[]') return;
    const tab = this.tab(tabId);
    let matches = false;
    try {
      const facts = JSON.parse(saved.continuation_facts);
      matches = facts.length > 0 && facts.every(id => {
        const [kind, , , provider, sessionId] = JSON.parse(id);
        if (kind !== 'orchestration-completion-v1' || !sessionId || !provider) return false;
        // Preflight must preserve stopped-session Resume. A saved binding can
        // route that preparation but NEVER proves a physical write. At write,
        // reuse the existing main destination proof including its exact own
        // accepted Resume source (not arbitrary lineage or a renderer hint).
        const current = atWrite ? this.resolveContinuationWriteTarget?.(tabId, provider)
          : this.resolveAttributionSource?.(tab) || {
            toolType: tab?.commandType?.startsWith('codex') ? 'codex'
              : tab?.commandType?.startsWith('claude') ? 'claude' : null,
            sessionId: provider === 'codex' ? tab?.codexSessionId : tab?.claudeSessionId,
          };
        return !agentSendTargetPreconditionFailure({ toolType: provider, sessionId }, current);
      });
    } catch { /* malformed persisted proof is not an unscoped prompt */ }
    if (!matches) throw Object.assign(fail('Контекст этой отправки принадлежит другой или неподтверждённой сессии.', 409), {
      code: 'agent_context_source_changed', success: false, accepted: false,
      submitted: false, pasteWritten: false, enterWritten: false,
    });
  }

  release(tabId, handoffId) {
    const sent = this.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (!sent || sent.status === 'delivered') return;
    this.db.transaction(() => {
      for (const id of JSON.parse(sent.update_ids)) this.db.prepare("UPDATE tab_context_updates SET status='pending' WHERE id=? AND tab_id=? AND status='sending'").run(id, tabId);
      this.db.prepare("UPDATE tab_context_handoffs SET status='failed' WHERE tab_id=? AND handoff_id=?").run(tabId, handoffId);
    })();
    this.touch(tabId);
  }

  settle(tabId, handoffId, result) {
    const receipt = classifyAgentSendReceipt(result);
    if (receipt.state === 'not-submitted' || receipt.state === 'provider-not-accepted' || result?.historyRecorded === true) {
      if (result?.historyRecorded === true) {
        const record = this.db.prepare('SELECT payload_hash FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
        if (record) this.confirm(tabId, handoffId, record.payload_hash);
      } else this.release(tabId, handoffId);
    }
  }

  ownedHeadKey(tabId, sessionId, filePath) {
    return tabId + '\0' + (sessionId || '') + '\0' + filePath;
  }

  rememberOwnedHead(tabId, sessionId, filePath, before, after) {
    if (before === after) return;
    const key = this.ownedHeadKey(tabId, sessionId, filePath);
    const beforeHash = hash(before);
    const afterHash = hash(after);
    const previous = this.ownedHeads.get(key);
    this.ownedHeads.delete(key);
    this.ownedHeads.set(key, previous?.afterHash === beforeHash
      ? { beforeHash: previous.beforeHash, afterHash, afterText: after }
      : { beforeHash, afterHash, afterText: after });
    while (this.ownedHeads.size > MAX_OWNED_HEADS) {
      this.ownedHeads.delete(this.ownedHeads.keys().next().value);
    }
  }

  ownedEditBefore(tabId, sessionId, filePath, row) {
    const key = this.ownedHeadKey(tabId, sessionId, filePath);
    const head = this.ownedHeads.get(key);
    if (!head) return row.content;
    if (head.beforeHash === row.hash) return head.afterText;
    // The filesystem observer caught up or a different writer advanced the
    // file. Either way the durable row is now the newer starting point.
    this.ownedHeads.delete(key);
    return row.content;
  }

  reconcileOwnedTransition(tabId, filePath, before, after, current, edit = null) {
    if (before === after) return null;
    const beforeHash = hash(before);
    const afterHash = hash(after);
    for (const row of this.pendingFileRows(tabId)) {
      const changes = fileChangesFromRow(row);
      const index = changes.findIndex((item) => item.path === filePath && item.beforeHash === beforeHash);
      if (index < 0) continue;
      const observed = changes[index];
      if (observed.afterHash === afterHash) {
        changes.splice(index, 1);
        this.saveFileBatch(row.id, tabId, changes, 'own-edit');
        return { changed: true, outcome: 'exact', beforeHash, afterHash };
      }
      // fs.watch may coalesce "own A->B" and a later external B->C into one
      // durable A->C row. Remove only the proven A->B prefix; C remains visible.
      if (!current?.hash || current.hash !== observed.afterHash) continue;
      const acknowledgedText = typeof observed.acknowledgedText === 'string' && edit
        ? applyOwnedEdit(observed.acknowledgedText, edit)
        : null;
      changes[index] = {
        ...observed,
        beforeHash: afterHash,
        beforeText: after,
        acknowledgedText: acknowledgedText ?? observed.acknowledgedText,
        unknownSource: !provenanceCoversTransition(
          afterHash,
          observed.afterHash,
          observed.provenance,
        ),
      };
      const netChanges = !fileChangeIsPending(changes[index])
        ? changes.filter((_, itemIndex) => itemIndex !== index)
        : changes;
      this.saveFileBatch(row.id, tabId, netChanges, 'own-edit');
      return { changed: true, outcome: 'external-residue', beforeHash, afterHash };
    }
    return null;
  }

  rebaseOwnedEditAcrossPending(tabId, filePath, before, after, current, edit) {
    if (!edit || before === after || current?.hash !== hash(after)) return null;
    const beforeHash = hash(before);
    const afterHash = hash(after);
    for (const row of this.pendingFileRows(tabId)) {
      const changes = fileChangesFromRow(row);
      const index = changes.findIndex((item) => item.path === filePath
        && item.afterHash === afterHash && item.beforeHash !== beforeHash
        && item.acknowledgedText === null);
      if (index < 0) continue;
      const observed = changes[index];
      const rebasedBefore = applyOwnedEdit(observed.beforeText, edit);
      if (rebasedBefore === null) continue;
      const rebasedHash = hash(rebasedBefore);
      const source = observed.sources.length === 1 ? observed.sources[0] : null;
      const knownSource = !!source && observed.provenance.length > 0
        && observed.provenance.every((edge) => edge.source.tabId === source.tabId)
        && provenanceCoversTransition(observed.beforeHash, beforeHash, observed.provenance);
      changes[index] = {
        ...observed,
        beforeHash: rebasedHash,
        beforeText: rebasedBefore,
        afterHash,
        afterText: after,
        provenance: knownSource && rebasedHash !== afterHash
          ? [{ beforeHash: rebasedHash, afterHash, source }]
          : [],
        unknownSource: !knownSource,
      };
      this.saveFileBatch(row.id, tabId, changes, 'own-edit');
      return { changed: true, outcome: knownSource ? 'known-source-rebased' : 'unknown-source-rebased' };
    }
    return null;
  }

  attributeAgentTransition(tabId, filePath, before, after, source) {
    if (before === after || !source) return null;
    const beforeHash = hash(before);
    const afterHash = hash(after);
    for (const row of this.pendingFileRows(tabId)) {
      const changes = fileChangesFromRow(row);
      const index = changes.findIndex((item) => item.path === filePath);
      if (index < 0) continue;
      const observed = changes[index];
      const beginsAtObserved = observed.beforeHash === beforeHash;
      const endsAtObserved = observed.afterHash === afterHash;
      if (!beginsAtObserved && !endsAtObserved) continue;
      const exact = beginsAtObserved && endsAtObserved;
      const sources = mergeFileSources(observed.sources, [source]);
      const provenance = mergeFileProvenance(observed.provenance, [{
        beforeHash,
        afterHash,
        source,
      }]);
      const unknownSource = !provenanceCoversTransition(
        observed.beforeHash,
        observed.afterHash,
        provenance,
      );
      const changed = sources.length !== observed.sources.length
        || provenance.length !== observed.provenance.length
        || unknownSource !== observed.unknownSource;
      if (!changed) return { changed: false, outcome: exact ? 'attributed-exact' : 'attributed-partial' };
      changes[index] = {
        ...observed,
        sources,
        provenance,
        unknownSource,
      };
      this.saveFileBatch(row.id, tabId, changes, 'attributed-edit');
      return {
        changed: true,
        outcome: exact ? 'attributed-exact' : 'attributed-partial',
        beforeHash,
        afterHash,
      };
    }
    return null;
  }

  rememberFileTransition(transition) {
    const byteSize = Buffer.byteLength(transition.before, 'utf8')
      + Buffer.byteLength(transition.after, 'utf8');
    if (byteSize > MAX_SHELL_EDIT_TRANSITION_BYTES) return;
    const key = String(transition.id);
    this.fileTransitions.set(key, { ...transition, byteSize });
    this.fileTransitionBytes += byteSize;
    while (this.fileTransitions.size > MAX_SHELL_EDIT_PROOFS
      || this.fileTransitionBytes > MAX_SHELL_EDIT_TRANSITION_BYTES) {
      this.deleteFileTransition(this.fileTransitions.keys().next().value);
    }
  }

  deleteFileTransition(key) {
    const transition = this.fileTransitions.get(key);
    if (!transition) return;
    this.fileTransitions.delete(key);
    this.fileTransitionBytes = Math.max(0, this.fileTransitionBytes - Number(transition.byteSize || 0));
  }

  pendingTransitionHasConflictingSource(operation, transition) {
    for (const row of this.pendingFileRows(operation.targetTabId)) {
      const change = fileChangesFromRow(row).find((item) => item.path === operation.filePath);
      if (!change) continue;
      if ((change.provenance || []).some((edge) => (
        edge.beforeHash === transition.beforeHash
        && edge.afterHash === transition.afterHash
        && edge.source?.tabId
        && edge.source.tabId !== operation.sourceTabId
      ))) return true;
    }
    return false;
  }

  reconcileObservedOwnedTransition(tabId, filePath, before, after, current) {
    const prefix = this.reconcileOwnedTransition(tabId, filePath, before, after, current);
    if (prefix) return prefix;
    const beforeHash = hash(before);
    const afterHash = hash(after);
    for (const row of this.pendingFileRows(tabId)) {
      const changes = fileChangesFromRow(row);
      const index = changes.findIndex((item) => (
        item.path === filePath && item.afterHash === afterHash
      ));
      if (index < 0) continue;
      const observed = changes[index];
      // The watcher can first publish external A->B and then merge this
      // operation's B->C into A->C. Remove the proven suffix by restoring B
      // as the pending endpoint; the earlier A->B residue remains visible.
      changes[index] = {
        ...observed,
        afterHash: beforeHash,
        afterText: before,
        unknownSource: !provenanceCoversTransition(
          observed.beforeHash,
          beforeHash,
          observed.provenance,
        ),
      };
      const netChanges = !fileChangeIsPending(changes[index])
        ? changes.filter((_, itemIndex) => itemIndex !== index)
        : changes;
      this.saveFileBatch(row.id, tabId, netChanges, 'own-shell-edit');
      return { changed: true, outcome: 'external-prefix', beforeHash, afterHash };
    }
    return null;
  }

  acceptShellEditProof(operation, transition) {
    const conflictingSource = this.pendingTransitionHasConflictingSource(operation, transition);
    if (conflictingSource) return { consumed: true, changed: false, outcome: 'conflicting-source' };
    const current = this.db.prepare('SELECT * FROM tab_context_files WHERE tab_id=? AND path=?')
      .get(operation.targetTabId, operation.filePath);
    const ownEdit = operation.sourceTabId === operation.targetTabId;
    const reconciled = ownEdit
      ? this.reconcileObservedOwnedTransition(
          operation.targetTabId,
          operation.filePath,
          transition.before,
          transition.after,
          current,
        )
      : this.attributeAgentTransition(
          operation.targetTabId,
          operation.filePath,
          transition.before,
          transition.after,
          this.sourceDescriptor(
            operation.sourceTabId,
            operation.sessionId,
            operation.operationId,
          ),
        );
    if (reconciled) {
      if (reconciled.changed) this.touch(operation.targetTabId);
      return { consumed: true, changed: !!reconciled.changed, outcome: reconciled.outcome };
    }
    const stillPending = this.pendingFileRows(operation.targetTabId)
      .some((row) => fileChangesFromRow(row).some((item) => item.path === operation.filePath));
    return { consumed: !stillPending, changed: false, outcome: 'not-pending' };
  }

  reconcileShellEditProofs(filePath) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const transitions = [...this.fileTransitions.entries()]
        .filter(([, transition]) => transition.filePath === filePath);
      const operations = [...this.shellEdits.entries()]
        .filter(([, operation]) => operation.filePath === filePath);
      for (const [operationKey, operation] of operations) {
        if (!Number.isFinite(operation.completedAt) || operation.claimable !== true) continue;
        const candidates = transitions.filter(([, transition]) => (
          shellOperationCouldProduceTransition(operation, transition)
        ));
        if (candidates.length !== 1) continue;
        const [transitionKey, transition] = candidates[0];
        // Require degree one on both sides. A timestamp window narrows causal
        // evidence; it does not choose between two commands that could both
        // have written the same version.
        const possibleOwners = operations.filter(([, candidate]) => (
          shellOperationCouldProduceTransition(candidate, transition)
        ));
        if (possibleOwners.length !== 1) continue;
        const accepted = this.acceptShellEditProof(operation, transition);
        if (!accepted.consumed) continue;
        this.shellEdits.delete(operationKey);
        this.deleteFileTransition(transitionKey);
        console.log('[TabContext] shell file change ' + (accepted.changed ? 'reconciled' : 'retained')
          + ' tab=' + String(operation.targetTabId).slice(-12)
          + ' source=' + String(operation.sourceTabId || '-').slice(-12)
          + ' session=' + String(operation.sessionId || '-').slice(0, 8)
          + ' operation=' + String(operation.operationId || '-').slice(0, 24)
          + ' outcome=' + accepted.outcome + ' file=' + path.basename(filePath));
        progressed = true;
        break;
      }
    }
  }

  observeShellEditStep({ sourceTabId, sessionId, step, recordedAt, cwd }) {
    if (!Number.isFinite(recordedAt)) return;
    const action = resolveShellEditAction(step, cwd);
    if (!action) return;
    const operationPrefix = sourceTabId + ':' + sessionId + ':' + step.id + '\0';
    if (step.result === undefined) {
      const rows = this.db.prepare('SELECT tab_id,hash FROM tab_context_files WHERE path=?').all(action.filePath);
      for (const row of rows) {
        const operationKey = operationPrefix + row.tab_id;
        const lateTransitionIds = [...this.fileTransitions.values()]
          .filter((transition) => (
            transition.targetTabId === row.tab_id
            && transition.filePath === action.filePath
            && Number.isFinite(transition.afterMtimeMs)
            && transition.afterMtimeMs + READ_ACK_MTIME_ROUNDING_MS >= recordedAt
            && transition.afterMtimeMs <= recordedAt + SHELL_EDIT_MAX_DURATION_MS
          ))
          .map((transition) => String(transition.id));
        if (!this.shellEdits.has(operationKey)) this.shellEdits.set(operationKey, {
          targetTabId: row.tab_id,
          sourceTabId,
          filePath: action.filePath,
          beforeHash: row.hash,
          lateTransitionIds,
          startedAt: recordedAt,
          completedAt: null,
          claimable: null,
          sessionId,
          operationId: step.id,
        });
      }
      while (this.shellEdits.size > MAX_SHELL_EDIT_PROOFS) {
        this.shellEdits.delete(this.shellEdits.keys().next().value);
      }
      return;
    }
    const paths = new Set();
    for (const [operationKey, operation] of [...this.shellEdits]) {
      if (!operationKey.startsWith(operationPrefix)) continue;
      paths.add(operation.filePath);
      if (recordedAt + SHELL_EDIT_CLOCK_SKEW_MS < operation.startedAt
        || recordedAt - operation.startedAt > SHELL_EDIT_MAX_DURATION_MS) {
        this.shellEdits.delete(operationKey);
        continue;
      }
      operation.completedAt = recordedAt;
      operation.claimable = shellEditStepSucceeded(step);
    }
    for (const targetPath of paths) {
      void this.readFile(targetPath)
        .then(() => this.reconcileShellEditProofs(targetPath))
        .catch((error) => console.warn('[TabContext] shell edit:', error.message));
    }
  }

  async acceptAgentRead(tabId, step, recordedAt) {
    if (!Number.isFinite(recordedAt)) return;
    const tab = this.tab(tabId);
    const action = resolveReadAction(step, tab?.cwd || '/');
    if (!action) return;
    const linked = this.db.prepare('SELECT * FROM tab_context_files WHERE tab_id=? AND path=?')
      .get(tabId, action.filePath);
    if (!linked) return;
    await this.readFile(action.filePath);
    const current = this.db.prepare('SELECT * FROM tab_context_files WHERE tab_id=? AND path=?')
      .get(tabId, action.filePath);
    if (!current?.hash || current.error) return;
    const coverage = verifiedReadCoverage(step, current.content, tab?.cwd || '/');
    if (!coverage || coverage.filePath !== action.filePath) return;

    let changed = false;
    let acknowledgedLines = 0;
    for (const row of this.pendingFileRows(tabId)) {
      // Transcript subscriptions can replay old calls after restart. Matching
      // bytes prove what was read, while these version times prove it was read
      // after this file version existed rather than in an older equal state.
      if (recordedAt + READ_ACK_CLOCK_SKEW_MS < Number(row.created_at || 0)) continue;
      const changes = fileChangesFromRow(row);
      const index = changes.findIndex((item) => (
        item.path === action.filePath && item.afterHash === current.hash
      ));
      if (index < 0) continue;
      const observed = changes[index];
      if (observed.afterMtimeMs !== null
        && recordedAt + READ_ACK_MTIME_ROUNDING_MS < observed.afterMtimeMs) continue;
      const before = effectiveFileChangeBeforeText(observed);
      const next = acknowledgeReadCoverage(before, observed.afterText, coverage);
      if (next === before) continue;
      const beforeCount = changedFilePresentation(before, observed.afterText).changedLineCount;
      const afterCount = changedFilePresentation(next, observed.afterText).changedLineCount;
      acknowledgedLines += Math.max(0, beforeCount - afterCount);
      if (next === observed.afterText) changes.splice(index, 1);
      else changes[index] = { ...observed, acknowledgedText: next };
      this.saveFileBatch(row.id, tabId, changes, 'read-acknowledged');
      changed = true;
    }
    if (!changed) return;
    console.log('[TabContext] linked file read acknowledged tab=' + String(tabId).slice(-12)
      + ' operation=' + String(step.id || '-').slice(0, 24)
      + ' lines=' + acknowledgedLines
      + ' full=' + (coverage.full ? '1' : '0')
      + ' file=' + path.basename(action.filePath));
    this.touch(tabId);
  }

  observeRecord(detail) {
    const { tabId: sourceTabId, sessionId, toolType, message } = detail;
    let userText = null;
    if (toolType === 'codex' && message?.type === 'event_msg' && message.payload?.type === 'user_message') {
      userText = message.payload.message;
    } else if (toolType === 'claude' && message?.type === 'user' && message.uuid && message.isMeta !== true) {
      const blocks = message.message?.content;
      if (typeof blocks === 'string') userText = blocks;
      else if (Array.isArray(blocks) && !blocks.some((block) => block.type === 'tool_result')) {
        userText = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n');
      }
    }
    if (typeof userText === 'string') {
      const digest = promptAuditFingerprint(userText);
      for (const sent of this.db.prepare("SELECT handoff_id FROM tab_context_handoffs WHERE tab_id=? AND payload_hash=? AND status='preparing'").all(sourceTabId, digest)) {
        this.confirm(sourceTabId, sent.handoff_id, digest);
      }
    }
    if (!this.db.prepare('SELECT 1 FROM tab_context_files LIMIT 1').get()) return;
    const sourceTab = this.tab(sourceTabId);
    if (toolType === 'codex' && message?.type === 'event_msg') {
      for (const action of this.decodeCodexPatch?.(message.payload) || []) {
        const filePath = path.resolve(sourceTab?.cwd || '/', action.args?.file_path || '');
        const rows = this.db.prepare('SELECT * FROM tab_context_files WHERE path=?').all(filePath);
        for (const row of rows) {
          void this.acceptAgentEdit(row.tab_id, sourceTabId, filePath, {
            before: sourceTabId === row.tab_id
              ? this.ownedEditBefore(row.tab_id, sessionId, filePath, row)
              : row.content,
            args: action.args,
            tool: action.toolName,
            diffHunks: action.diffHunks,
            sessionId,
            operationId: String(message.payload?.call_id || message.payload?.id || 'patch'),
            beforeTrusted: false,
          }).catch((e) => console.warn('[TabContext] agent patch:', e.message));
        }
      }
    }
    const key = sourceTabId + ':' + sessionId;
    let state = this.projectors.get(key);
    if (!state) {
      for (const candidate of this.projectors.keys()) {
        if (candidate.startsWith(sourceTabId + ':')) this.projectors.delete(candidate);
      }
      state = createSubagentStepProjectionState({ codexSessionId: sessionId });
      this.projectors.set(key, state);
    }
    const steps = toolType === 'codex'
      ? codexRecordToSteps(message, state, this.decodeCodexCall)
      : claudeRecordToSteps(message, state);
    const recordedAt = Date.parse(message?.timestamp || message?.payload?.timestamp || '');
    for (const step of steps) {
      const readAction = resolveReadAction(step, sourceTab?.cwd || '/');
      if (readAction && step.result !== undefined && !step.isError) {
        void this.acceptAgentRead(sourceTabId, step, recordedAt)
          .catch((e) => console.warn('[TabContext] agent read:', e.message));
        continue;
      }
      if (step.kind === 'tool' && step.tool === 'Bash') {
        this.observeShellEditStep({
          sourceTabId,
          sessionId,
          step,
          recordedAt,
          cwd: sourceTab?.cwd || '/',
        });
        continue;
      }
      if (step.kind !== 'tool' || !['Edit','MultiEdit','Write','edit_file','write_file'].includes(step.tool)) continue;
      const args = step.args || {};
      const filePath = path.resolve(sourceTab?.cwd || '/', args.file_path || args.path || '');
      const operationKey = key + ':' + step.id;
      if (step.result === undefined) {
        const rows = this.db.prepare('SELECT * FROM tab_context_files WHERE path=?').all(filePath);
        for (const row of rows) {
          const targetKey = operationKey + '\0' + row.tab_id;
          if (!this.pendingEdits.has(targetKey)) this.pendingEdits.set(targetKey, {
            targetTabId: row.tab_id,
            sourceTabId,
            filePath,
            before: sourceTabId === row.tab_id
              ? this.ownedEditBefore(row.tab_id, sessionId, filePath, row)
              : row.content,
            args,
            tool: step.tool,
            diffHunks: step.diffHunks,
            sessionId,
            operationId: step.id,
            beforeTrusted: true,
          });
        }
        while (this.pendingEdits.size > 2048) {
          this.pendingEdits.delete(this.pendingEdits.keys().next().value);
        }
        continue;
      }
      const prefix = operationKey + '\0';
      for (const [pendingKey, pending] of [...this.pendingEdits]) {
        if (!pendingKey.startsWith(prefix)) continue;
        this.pendingEdits.delete(pendingKey);
        if (step.isError) continue;
        void this.acceptAgentEdit(pending.targetTabId, pending.sourceTabId, pending.filePath, {
          ...pending,
          diffHunks: step.diffHunks || pending.diffHunks,
        }).catch((e) => console.warn('[TabContext] agent edit:', e.message));
      }
    }
  }

  async acceptAgentEdit(tabId, sourceTabId, filePath, {
    before, args, tool, diffHunks = null, sessionId = null, operationId = null,
    beforeTrusted = false,
  }) {
    const ownEdit = sourceTabId === tabId;
    const initialExpected = applyOwnedEdit(before, { args, tool, diffHunks });
    if (ownEdit && beforeTrusted && initialExpected !== null) {
      this.rememberOwnedHead(tabId, sessionId, filePath, before, initialExpected);
    }
    await this.readFile(filePath);
    const current = this.db.prepare('SELECT * FROM tab_context_files WHERE tab_id=? AND path=?').get(tabId, filePath);
    const latestTransition = current?.hash
      ? this.latestPendingFileChange(tabId, filePath, current.hash)
      : null;
    const candidates = new Set([before, latestTransition?.beforeText].filter((item) => typeof item === 'string'));
    let changed = false;
    let outcome = null;
    for (const candidate of candidates) {
      const expected = applyOwnedEdit(candidate, { args, tool, diffHunks });
      if (expected === null) continue;
      const reconciled = ownEdit
        ? this.reconcileOwnedTransition(tabId, filePath, candidate, expected, current, {
            args,
            tool,
            diffHunks,
          }) || (beforeTrusted && candidate === before
            ? this.rebaseOwnedEditAcrossPending(tabId, filePath, candidate, expected, current, {
                args,
                tool,
                diffHunks,
              })
            : null)
        : this.attributeAgentTransition(
            tabId,
            filePath,
            candidate,
            expected,
            this.sourceDescriptor(sourceTabId, sessionId, operationId),
          );
      if (reconciled?.changed) {
        if (ownEdit) this.rememberOwnedHead(tabId, sessionId, filePath, candidate, expected);
        changed = true;
        outcome = reconciled.outcome;
      }
      if (!ownEdit && reconciled) break;
    }
    if (ownEdit) {
      const headKey = this.ownedHeadKey(tabId, sessionId, filePath);
      const head = this.ownedHeads.get(headKey);
      if (head && current?.hash === head.afterHash) this.ownedHeads.delete(headKey);
    }
    if (changed) {
      console.log('[TabContext] ' + (ownEdit ? 'own' : 'attributed')
        + ' file change reconciled tab=' + String(tabId).slice(-12)
        + ' source=' + String(sourceTabId || '-').slice(-12)
        + ' session=' + String(sessionId || '-').slice(0, 8)
        + ' operation=' + String(operationId || '-').slice(0, 24)
        + ' outcome=' + outcome + ' file=' + path.basename(filePath));
      this.touch(tabId);
    }
  }
}

module.exports = {
  TabWorkContext,
  updateWrapper,
  applyDiffHunks,
  applyOwnedEdit,
  changedHunks,
  changedFilePresentation,
  fileBatchPresentation,
  verifiedReadCoverage,
  acknowledgeReadCoverage,
  resolveShellEditAction,
  shellEditStepSucceeded,
};

'use strict';

// Cheap facts from an ALREADY canonical History action. No transcript parser,
// filesystem lookup or body rehydration. Status is not inferred from prose.
const { historyActionHeadline, historyActionPresentationMeta } = require('./history-action-grammar.cjs');

function resultFacts(action) {
  const raw = action.tool === '__raw__' ? action.rawTool || {} : action;
  const ref = raw.resultRef;
  const hasResult = raw.result !== undefined && raw.result !== null
    || typeof ref?.payloadId === 'string' && ref.payloadId.length > 0 && Number.isSafeInteger(ref.totalChars) && ref.totalChars >= 0;
  let status;
  if (raw.awaitingApproval === true) status = 'waiting';
  else if (raw.isError === true || action.spawnRejected === true) status = 'error';
  else {
    const phase = action.tool === 'Task' ? action.subagentStatus : raw.backgroundStatus;
    status = phase === 'completed' ? 'done'
      : phase === 'running' ? 'running'
        : ['failed', 'error'].includes(phase) ? 'error'
          : ['interrupted', 'stopped', 'killed', 'cancelled'].includes(phase) ? 'interrupted'
            : phase ? 'unknown' : hasResult ? 'done' : 'running';
  }
  return { hasResult, status };
}

// Same line tokenization/minimal insert-delete counts as claude-blocks'
// lineDiff + countDiffStats. Only the counts are needed here, so Myers' frontier
// replaces the UI's quadratic LCS matrix. Common edges/disjoint inputs are
// linear; no diff text or n*m allocation is built on first History load.
function lineDiffStats(oldText, newText) {
  if (oldText === newText) return { added: 0, removed: 0 };
  const a = oldText.split('\n'), b = newText.split('\n');
  let start = 0, aEnd = a.length, bEnd = b.length;
  while (start < aEnd && start < bEnd && a[start] === b[start]) start++;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  const n = aEnd - start, m = bEnd - start;
  if (!n || !m) return { added: m, removed: n };
  const seen = new Set(a.slice(start, aEnd));
  if (!b.slice(start, bEnd).some(line => seen.has(line))) return { added: m, removed: n };
  const max = n + m, offset = max + 1, frontier = new Int32Array(2 * max + 3);
  for (let distance = 0; distance <= max; distance++) {
    for (let k = -distance; k <= distance; k += 2) {
      const at = offset + k;
      let x = k === -distance || (k !== distance && frontier[at - 1] < frontier[at + 1])
        ? frontier[at + 1] : frontier[at - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++; }
      frontier[at] = x;
      if (x >= n && y >= m) return { added: (distance + m - n) / 2, removed: (distance + n - m) / 2 };
    }
  }
  throw Error('history_diff_distance_unreachable');
}

function fileDiffStats(raw) {
  if (raw.diffStatsKnown === false) return null; // e.g. delete without old contents
  if (Array.isArray(raw.diffHunks) && raw.diffHunks.length) {
    let added = 0, removed = 0;
    for (const hunk of raw.diffHunks) {
      if (!Array.isArray(hunk?.entries)) return null;
      for (const entry of hunk.entries) {
        if (!entry || typeof entry.line !== 'string' || !['eq', 'add', 'del'].includes(entry.tag)) return null;
        if (entry.tag === 'add') added++;
        if (entry.tag === 'del') removed++;
      }
    }
    return { added, removed, countsSource: 'hunks' };
  }
  const args = raw.args || {};
  if (raw.toolName === 'Write') return typeof args.content === 'string'
    ? { added: args.content ? args.content.split('\n').length : 0, removed: 0, countsSource: 'arguments' } : null;
  const edits = raw.toolName === 'MultiEdit' ? args.edits : [args];
  if (!['Edit', 'Update', 'MultiEdit'].includes(raw.toolName) || !Array.isArray(edits)) return null;
  let added = 0, removed = 0;
  for (const edit of edits) {
    if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string') return null;
    const stats = lineDiffStats(edit.old_string, edit.new_string);
    added += stats.added; removed += stats.removed;
  }
  return { added, removed, countsSource: 'arguments' };
}

function historyActionHeaderFacts(action) {
  const result = resultFacts(action);
  const raw = action.tool === '__raw__' ? action.rawTool : null;
  if (!raw) return result;
  const headline = historyActionHeadline(raw);
  if (headline.verb !== 'Edit' || raw.toolName === 'Patch') return result;
  // Explicit native file args are verbatim. Shell edits reuse the grammar's
  // resolved path identity (including its quoted-alias proof), never a new
  // shell parser or the shortened/basename UI label.
  const filePath = raw.args?.file_path || raw.args?.path || historyActionPresentationMeta(raw).targetKey;
  if (typeof filePath !== 'string' || !filePath) return result;
  const stats = fileDiffStats(raw);
  result.fileChange = { filePath, displayPath: headline.subject,
    added: stats?.added ?? null, removed: stats?.removed ?? null, countsSource: stats?.countsSource ?? null };
  return result;
}

module.exports = { historyActionHeaderFacts, lineDiffStats };

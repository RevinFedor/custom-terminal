'use strict';

const { createHash } = require('node:crypto');
const { HistoryProjectionArena } = require('./history-projection-arena');
const text = require('./history-paged-text');
const { HISTORY_PAYLOAD_DEHYDRATE_THRESHOLD, HISTORY_PAYLOAD_PREVIEW_CHARS } = require('./history-payload-dehydrate');

// The default desktop presentation starts from a private CoW view. Preserve
// the existing dehydration policy/IDs/UTF-8 hashes without first decoding a
// whole result/thinking/compact String, or putting it in the native stash.
// Aliased rawTool objects remain aliased: the first mutation is visible at all
// their logical references, just as in dehydrateHistoryEntries. The canonical
// lease and earlier frozen views are never changed. Rows/actions and the
// later native presentation DTO are still unbounded owners, explicitly.
async function dehydrateHistoryRoot(store, root, { control, stats = {} } = {}) {
  const arena = new HistoryProjectionArena(store, root);
  let output = null;
  Object.assign(stats, { dehydrated: 0, savedChars: 0, maxHashChunkChars: 0,
    maxPreviewChars: 0, nativeBodyStashWrites: 0, completeReadPlaneBounded: false });
  const checkpoint = async () => {
    if (control?.checkpoint) await control.checkpoint();
    else await new Promise(resolve => setImmediate(resolve));
    control?.assertCurrent();
  };
  async function field(target, name, payloadId, recordLineName) {
    const plan = arena.step(() => {
      const value = target[name];
      return !target[name + 'Ref'] && text.isText(value) && value.length > HISTORY_PAYLOAD_DEHYDRATE_THRESHOLD
        ? { value, length: value.length, line: target[recordLineName] } : null;
    });
    if (!plan) return;
    const hash = createHash('sha256');
    let carry = '', preview = '', chunks = 0;
    for (const chunk of text.chunks(plan.value)) {
      control?.assertCurrent();
      if (preview.length < HISTORY_PAYLOAD_PREVIEW_CHARS + 1) {
        preview += chunk.slice(0, HISTORY_PAYLOAD_PREVIEW_CHARS + 1 - preview.length);
      }
      let part = carry + chunk; carry = '';
      // A page boundary is not a Unicode boundary. Match the old UTF-8 hash
      // for astral pairs and preserve either kind of unpaired surrogate.
      if (/[\uD800-\uDBFF]/.test(part.at(-1) || '')) { carry = part.at(-1); part = part.slice(0, -1); }
      if (part) hash.update(part, 'utf8');
      stats.maxHashChunkChars = Math.max(stats.maxHashChunkChars, part.length);
      if (++chunks % 64 === 0) await checkpoint();
    }
    if (carry) hash.update(carry, 'utf8');
    const contentHash = hash.digest('hex');
    let end = Math.min(HISTORY_PAYLOAD_PREVIEW_CHARS, preview.length);
    if (/[\uD800-\uDBFF]/.test(preview[end - 1] || '') && /[\uDC00-\uDFFF]/.test(preview[end] || '')) end--;
    preview = preview.slice(0, end) + '\n… (+' + Math.max(1, Math.round((plan.length - end) / 1024))
      + ' KB — полный вывод загрузится при раскрытии)';
    control?.assertCurrent();
    arena.step(() => {
      target[name + 'Ref'] = { payloadId: payloadId(), totalChars: plan.length, contentHash,
        ...(Number.isInteger(plan.line) ? { recordLine: plan.line } : {}) };
      target[name] = preview;
    });
    stats.dehydrated++; stats.savedChars += plan.length;
    stats.maxPreviewChars = Math.max(stats.maxPreviewChars, preview.length);
  }
  try {
    const length = arena.state().length;
    for (let index = 0; index < length; index++) {
      control?.assertCurrent();
      const row = arena.step(() => arena.state()[index]);
      if (!row) continue;
      const actions = arena.step(() => row.actions);
      if (Array.isArray(actions)) for (let at = 0; at < actions.length; at++) {
        const raw = arena.step(() => {
          const action = actions[at];
          return action && text.equal(action.tool, '__raw__') ? action.rawTool : null;
        });
        if (!raw) continue;
        await field(raw, 'result', () => text.concat(['result:', text.coerce(raw.toolUseId ||
          text.concat([text.coerce(row.uuid || ''), ':', String(at)], '', arena))], '', arena), 'resultSourceLine');
        await checkpoint();
      }
      await field(row, 'thinking', () => text.concat(['thinking:', text.coerce(row.uuid || '')], '', arena), 'sourceRecordLine');
      await field(row, 'compactSummary', () => text.concat(['compact:', text.coerce(row.uuid || '')], '', arena), 'sourceRecordLine');
      await checkpoint();
    }
    control?.assertCurrent();
    output = arena.step(() => arena.publish(arena.state()));
    control?.assertCurrent();
    return output;
  } catch (error) { output?.release(); throw error; }
  finally { arena.close(); }
}

module.exports = { dehydrateHistoryRoot };

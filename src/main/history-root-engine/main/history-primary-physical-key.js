'use strict';

// The exact physical key grammar of HistoryPanel/historyLivePresentationKey.
// Growing text remains UTF16 pages; this does not use a source/rank or lease
// as a substitute for the semantic React identity. The legacy queue fallback
// is streamed too, including its exact prompt normalization and FNV hash.
const text = require('./history-paged-text');
const truth = value => text.isText(value) ? value.length > 0 : !!value;
const eq = (left, right) => text.isText(left) && text.isText(right) ? text.equal(left, right) : left === right;
const asText = value => text.coerce(truth(value) ? value : '');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !text.isText(value);

function queueText(arena, value) {
  if (text.isText(value)) return value;
  if (Array.isArray(value)) return text.concat((function* () {
    for (const item of value) {
      if (text.isText(item)) { if (item.length) yield item; }
      else if (object(item) && eq(item.type, 'text') && text.isText(item.text) && item.text.length) yield item.text;
    }
  })(), '\n', arena);
  return object(value) && text.isText(value.text) ? value.text : '';
}

function queueHash(arena, value) {
  const source = queueText(arena, value);
  const removed = text.build(arena, (function* () {
    let from = 0;
    for (;;) {
      const start = text.indexOf(source, '<system-reminder>', from);
      if (start < 0) break;
      const end = text.indexOf(source, '</system-reminder>', start + 17);
      if (end < 0) break;
      yield* text.chunks(source, from, start);
      from = end + 18;
    }
    yield* text.chunks(source, from);
  })());
  const clean = text.replaceLiteral(text.replaceLiteral(removed, '[200~', ''), '~]', '');
  let hash = 0x811c9dc5, nonempty = false, space = false;
  const add = unit => { hash ^= unit; hash = Math.imul(hash, 0x01000193) >>> 0; };
  for (const chunk of text.chunks(clean)) for (let index = 0; index < chunk.length; index++) {
    if (/\s/u.test(chunk[index])) { if (nonempty) space = true; continue; }
    if (space) add(32);
    space = false; nonempty = true; add(chunk.charCodeAt(index));
  }
  return nonempty ? hash.toString(16).padStart(8, '0') : null;
}

function historyPrimaryPhysicalKey(arena, unit) {
  if (eq(unit?.kind, 'group')) return asText(unit.key);
  const row = unit?.entry || {};
  for (const field of ['rewriteRenderKey', 'settingsPresentationKey', 'servicePresentationKey']) {
    if (truth(row[field])) return text.coerce(row[field]);
  }
  const identity = asText(row.sourceIdentity);
  const setting = row.settingsFact;
  const settingFact = eq(row.role, 'slash') && setting?.version === 1 && eq(setting.provider, 'codex')
    && (eq(setting.kind, 'model') || eq(setting.kind, 'effort')) && text.isText(setting.value) && setting.value.length > 0;
  const interruption = eq(row.role, 'interrupted') && eq(row.serviceCarrier, 'turn-aborted')
    && identity.startsWith('codex-interrupted-source-');
  if (identity.length && (eq(row.role, 'assistant') || eq(row.role, 'compact') || eq(row.role, 'goal')
    || interruption || settingFact || identity.startsWith('claude-queue:'))) {
    return text.concat(['source:', identity], '', arena);
  }
  if (eq(row.role, 'queued') && !asText(row.uuid).startsWith('local-prompt-')) {
    const stamp = asText(row.timestamp);
    if (stamp.length) {
      const hash = queueHash(arena, row.content);
      if (hash) return text.concat(['source:claude-queue:', asText(row.sessionId), ':', stamp, ':', hash], '', arena);
    }
  }
  return text.concat(['uuid:', asText(row.uuid)], '', arena);
}

module.exports = { historyPrimaryPhysicalKey };

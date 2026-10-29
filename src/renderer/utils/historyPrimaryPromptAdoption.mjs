import { normalizePromptImageIdentity } from './promptImageAttachments.mjs';
import { historyEntryHasExactIdentity, matchesHistoryPromptExactProof } from './historyPromptPresentation.mjs';
import { buildHistoryLivePresentation } from './historyLiveProjection.mjs';
import { copyHistoryPrimaryMetadataOrigin } from './historyPrimaryMetadataOrigin.mjs';
import { withHistoryPrimaryCanonicalConsumer, selectHistoryPrimaryCanonicalValue as selected } from './historyPrimaryCanonicalConsumers.mjs';

const fail = code => Object.assign(new Error(code), { code });
const LOCAL = 'local-prompt-', REWIND = 'local-rewind-', COMPACT = 'local-compact-error-';
const normalize = text => normalizePromptImageIdentity(String(text || '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\[200~/g, '').replace(/~\]/g, '').trim());
const selectedGraphIdentities = new WeakMap();
const PREPARED_ROWS = Symbol('held-prepared-current-local-rows');
const COMPATIBILITY_EXCLUSIONS = Symbol('prepared-compatibility-exclusions');
const SPARSE_COMPATIBILITY_ORIGIN = Symbol('prepared-sparse-compatibility-origin');
// Only authenticated publications allocated by the planner enter this table.
// Values contain sparse CURRENT edits, never the historical metadata array.
const sparsePublications = new WeakMap();
const scalarKinds = new Set(['string', 'number', 'bigint', 'boolean', 'null', 'undefined']);

// One fresh witness of CURRENT authoring, never a retained graph/hash cache.
// Own nonenumerables, prototypes, sparse inherited elements, Maps/Sets and
// cycles are included. Hashing is done at dispatch/final/publication only;
// each signed historical read instead uses the cheap owner/cut guard.
export function historyPrimaryPromptAdoptionFingerprint(value) {
  const { createHash } = window.require('node:crypto');
  const hash = createHash('sha256'), bytes = new Uint8Array(4096), seen = new Map();
  const tag = value => hash.update(value + ';');
  const text = value => {
    tag('string:' + value.length);
    for (let at = 0; at < value.length; at += 2048) {
      const count = Math.min(2048, value.length - at);
      for (let index = 0; index < count; index++) {
        const unit = value.charCodeAt(at + index); bytes[index * 2] = unit & 255; bytes[index * 2 + 1] = unit >>> 8;
      }
      hash.update(bytes.subarray(0, count * 2));
    }
  };
  function* fields(object) {
    if (object instanceof Map) for (const [key, value] of object) { yield key; yield value; }
    if (object instanceof Set) for (const value of object) yield value;
    for (const key of Reflect.ownKeys(object)) {
      yield key;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) { yield 'missing-descriptor'; continue; }
      yield !!descriptor.enumerable; yield !!descriptor.configurable;
      if ('value' in descriptor) { yield !!descriptor.writable; yield descriptor.value; }
      else { yield descriptor.get; yield descriptor.set; }
    }
    yield Object.getPrototypeOf(object);
  }
  const stack = [{ value }];
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.children) {
      const next = frame.children.next();
      if (next.done) { tag('end'); stack.pop(); } else stack.push({ value: next.value });
      continue;
    }
    const value = frame.value, type = typeof value;
    if (type === 'string') { text(value); stack.pop(); continue; }
    if (type === 'function') { tag('function'); text(Function.prototype.toString.call(value)); stack.pop(); continue; }
    if (value === null || type !== 'object') {
      tag(type); text(type === 'number' && Object.is(value, -0) ? '-0' : String(value)); stack.pop(); continue;
    }
    if (seen.has(value)) { tag('ref:' + seen.get(value)); stack.pop(); continue; }
    seen.set(value, seen.size); tag('object:' + (seen.size - 1));
    tag(Array.isArray(value) ? 'array' : value instanceof Map ? 'map' : value instanceof Set ? 'set' : 'object');
    frame.children = fields(value);
  }
  return hash.digest('hex');
}

function legacyRun(handoff) {
  if (handoff?.queueStatus !== 'sent' || handoff?.sendOperationKey || handoff?.sendAttemptId) return null;
  const id = String(handoff?.handoffId || '');
  if (!id.startsWith('orchestration-complete:')) return null;
  const run = id.slice('orchestration-complete:'.length).trim();
  if (!run) return null;
  const source = String(handoff?.source || '');
  return source && source !== 'orchestration-completion:' + run ? null : run;
}
function nativeLegacy(handoff, row) {
  const run = legacyRun(handoff);
  return run !== null && (Array.isArray(row?.semanticTags) ? row.semanticTags : []).some(tag =>
    tag?.kind === 'orchestration' && tag?.runId === run && (tag?.phase === 'completion' || tag?.phase === 'failure'));
}
function finderInput(local, capturedClock) {
  // Only these two operations are eager in the original finder, including
  // empty domains. Other getters are captured only at their first used arm.
  const normalizedText = normalize(local.content);
  let clock;
  const localAt = local.optimisticAt || Date.parse(local.timestamp) || (clock = capturedClock ?? Date.now());
  return { local, normalizedText, localAt, clock };
}
function inlineInput(local) {
  const value = { handoffId: local.handoffId || '', source: '', queueStatus: local.queueStatus || 'sending',
    sendOperationKey: null, sendAttemptId: null };
  return { ...value, run: legacyRun(value) };
}
function exactInput(local) {
  const branch = local.auditEntryUuid || local.sourceIdentity;
  if (!branch) return { branch, exact: false };
  const entryUuid = local.auditEntryUuid, sourceIdentity = local.sourceIdentity;
  // The original exact helper prepares both typed selectors before inspecting
  // a row. Capture that current work once, then replay it at publication.
  return { branch, exact: true, entryUuid, sourceIdentity,
    entrySelector: typeof entryUuid === 'string' ? entryUuid.trim() : '',
    sourceSelector: typeof sourceIdentity === 'string' ? sourceIdentity.trim() : '' }; 
}
function fallbackInput(input) {
  const local = input.local;
  return { normalizedText: input.normalizedText, localAt: input.localAt,
    requiresAuditIdentity: local.requiresAuditIdentity === true,
    auditTimestamp: local.auditTimestamp, auditSessionId: local.auditSessionId,
    sourceIdentity: local.sourceIdentity, queueStatus: local.queueStatus, statusReason: local.statusReason,
    sessionId: local.auditSessionId || local.sessionId };
}
const getInline = input => input.inline ||= inlineInput(input.local);
const getExact = input => input.exact ||= exactInput(input.local);
const getFallback = input => input.fallback ||= fallbackInput(input);
const getThreshold = input => {
  if (!input.threshold) input.threshold = { value: input.localAt - 5000 };
  return input.threshold.value;
};
const getFallbackSelector = input => {
  if (!input.fallbackSelector) {
    const identity = getFallback(input).sourceIdentity;
    input.fallbackSelector = { value: typeof identity === 'string' ? identity.trim() : '' };
  }
  return input.fallbackSelector.value;
};
const fieldsEqual = (left, right) => Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(key => Object.is(left[key], right[key]));
function nativeLegacyRun(row, run) {
  return run !== null && (Array.isArray(row?.semanticTags) ? row.semanticTags : []).some(tag =>
    tag?.kind === 'orchestration' && tag?.runId === run && (tag?.phase === 'completion' || tag?.phase === 'failure'));
}
// Exact CURRENT local override semantics. The record contains only native
// values actually evaluated by this branch, so final revalidation cannot
// introduce an unused coercion or omit one hidden behind an inherited method.
function nativeFinderRow(row, input) {
  const inline = getInline(input), legacy = nativeLegacyRun(row, inline.run);
  if (legacy) return { matched: true, witness: { branch: 'legacy', run: inline.run } };
  const exact = getExact(input);
  if (exact.exact) {
    const matched = matchesHistoryPromptExactProof(row, exact);
    return { matched, witness: { branch: 'exact', matched } };
  }
  const durable = { role: row.role, normalizedText: normalize(row.content), timestamp: row.timestamp,
    sessionId: row.sessionId, sourceIdentity: row.sourceIdentity, sourceIdentityAliases: row.sourceIdentityAliases };
  const local = getFallback(input), witness = { branch: 'fallback', durable };
  if (durable.role !== 'user' && durable.role !== 'queued') return { matched: false, witness };
  if (local.requiresAuditIdentity) {
    const matched = local.sourceIdentity ? historyEntryHasExactIdentity(durable, local.sourceIdentity)
      : durable.normalizedText === local.normalizedText && !!local.auditTimestamp
        && durable.timestamp === local.auditTimestamp && (!local.auditSessionId || durable.sessionId === local.auditSessionId);
    return { matched, witness };
  }
  if (durable.normalizedText !== local.normalizedText) return { matched: false, witness };
  witness.entryAt = Date.parse(durable.timestamp || '');
  if (!Number.isFinite(witness.entryAt)) return { matched: true, witness };
  witness.threshold = getThreshold(input);
  return { matched: witness.entryAt >= witness.threshold, witness };
}

async function completeText(context, value, operation = 'string-falsy') {
  return context.withText(value, async document => {
    let text = '';
    await context.scanText(document, part => { text += part; });
    return text;
  }, operation);
}
async function strictEquals(context, value, expected) {
  const kind = expected === null ? 'null' : typeof expected;
  if (kind === 'object') {
    const identity = selectedGraphIdentities.get(expected);
    if (!identity || identity.header !== context.header) return false;
    return context.withText(value, async document => {
      let equal = document.length === identity.key.length;
      await context.scanText(document, (text, at) => { if (text !== identity.key.slice(at, at + text.length)) equal = false; });
      return equal;
    }, 'graph-identity');
  }
  if (!scalarKinds.has(kind) || kind === 'number' && Number.isNaN(expected)) return false;
  if (await context.kind(value) !== kind) return false;
  if (kind === 'undefined' || kind === 'null') return true;
  if (kind === 'number') return await context.number(value) === expected;
  if (kind === 'boolean') return await context.smallText(value, 5, 'truthy') === String(expected);
  return context.equals(value, String(expected || ''));
}
async function arrayLength(context, value) {
  const length = await context.number(value, 'array-length');
  if (!Number.isSafeInteger(length) || length < 0) throw fail('HISTORY_PRIMARY_PROMPT_ARRAY_LENGTH');
  return length;
}
async function exactIdentity(context, row, exact, fallback = false) {
  if (!exact) return false;
  for (const field of fallback ? ['sourceIdentity'] : ['uuid', 'sourceIdentity']) if (await context.rawStringEquals(selected(row, field), exact)) return true;
  for (const field of fallback ? ['sourceIdentityAliases'] : ['sourceIdentityAliases', 'sourceUuidAliases']) {
    const value = selected(row, field);
    if (await context.kind(value) !== 'array') continue;
    if (await context.smallText(value, 4, 'array-some-check') !== 'true') throw fail('HISTORY_PRIMARY_PROMPT_SOME_REQUIRED');
    const length = await arrayLength(context, value);
    for (let index = 0; index < length; index++) if (await context.rawStringEquals(selected(row, field, index), exact)) return true;
  }
  return false;
}
async function legacyRow(context, row, run) {
  context.check();
  if (run === null) return false;
  const tags = selected(row, 'semanticTags');
  if (await context.kind(tags) !== 'array') return false;
  if (await context.smallText(tags, 4, 'array-some-check') !== 'true') throw fail('HISTORY_PRIMARY_PROMPT_SOME_REQUIRED');
  const length = await arrayLength(context, tags);
  for (let index = 0; index < length; index++) {
    if (!await context.rawStringEquals(selected(row, 'semanticTags', index, 'kind'), 'orchestration')) continue;
    if (!await context.rawStringEquals(selected(row, 'semanticTags', index, 'runId'), run)) continue;
    if (await context.rawStringEquals(selected(row, 'semanticTags', index, 'phase'), 'completion')
      || await context.rawStringEquals(selected(row, 'semanticTags', index, 'phase'), 'failure')) return true;
  }
  return false;
}

async function committedRow(context, row) {
  if (await context.rawStringEquals(selected(row, 'role'), 'queued')) {
    if (await context.kind(selected(row, 'uuid')) !== 'string') throw new TypeError('entry.uuid.startsWith is not a function');
    const local = await context.withText(selected(row, 'uuid'), async document => {
      let matches = document.length >= LOCAL.length;
      await context.scanText(document, (text, at) => {
        if (at < LOCAL.length && text.slice(0, LOCAL.length - at) !== LOCAL.slice(at, at + text.length)) matches = false;
      });
      return matches;
    });
    if (local) return false;
  }
  return await context.smallText(selected(row, 'liveProjection'), 5, 'truthy') === 'false';
}
async function finderRow(context, row, input) {
  if (await legacyRow(context, row, getInline(input).run)) return true;
  const exact = getExact(input); context.check();
  if (exact.exact) return await exactIdentity(context, row, exact.entrySelector) || exactIdentity(context, row, exact.sourceSelector);
  // Native durableIdentity normalizes the full content even for non-user
  // rows, BEFORE it builds the local fallback identity/getters.
  const equal = await context.withText(selected(row, 'content'), async document => {
    let matched = document.length === input.normalizedText.length;
    await context.scanText(document, (text, at) => {
      if (text !== input.normalizedText.slice(at, at + text.length)) matched = false;
    });
    return matched;
  }, 'prompt-identity');
  const local = getFallback(input); context.check();
  const role = await context.role(row);
  if (role !== 'user' && role !== 'queued') return false;
  if (local.requiresAuditIdentity) {
    if (local.sourceIdentity) return exactIdentity(context, row, getFallbackSelector(input), true);
    if (!equal || !local.auditTimestamp || !await strictEquals(context, selected(row, 'timestamp'), local.auditTimestamp)) return false;
    return !local.auditSessionId || strictEquals(context, selected(row, 'sessionId'), local.auditSessionId);
  }
  if (!equal) return false;
  // Date.parse remains the native selected scalar sink, after full signed
  // text verification, with no alternate date grammar or truncation.
  const timestamp = await completeText(context, selected(row, 'timestamp'));
  const entryAt = Date.parse(timestamp);
  if (!Number.isFinite(entryAt)) return true;
  const threshold = getThreshold(input); context.check();
  return entryAt >= threshold;
}

// A selected identity graph is the existing explicit native scalar/graph
// compatibility sink. It contains five matched-row fields only, never content,
// actions or an N-row collection. Its signed UTF16 document preserves full
// strings, scalar types, holes, aliases, prototypes and cycles. Graph backrefs
// to the source row resolve to this scoped identity projection.
async function selectedEntry(context, row) {
  const wire = await completeText(context, row, 'prompt-selected-identity');
  context.check();
  let graph;
  try { graph = JSON.parse(wire); } catch { throw fail('HISTORY_PRIMARY_PROMPT_SELECTED_GRAPH'); }
  context.check();
  const invalid = () => fail('HISTORY_PRIMARY_PROMPT_SELECTED_GRAPH');
  if (graph?.version !== 'primary-prompt-selected-identity-v1' || graph.root !== 0
    || !Array.isArray(graph.nodes) || !graph.nodes.length) throw invalid();
  const nodes = [], kinds = ['object', 'array', 'map', 'set']; let work = 0;
  const step = async () => { context.check(); if (++work % 64 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); context.check(); } };
  for (const node of graph.nodes) {
    await step();
    if (!node || !kinds.includes(node.kind) || !Array.isArray(node.properties)
      || !Array.isArray(node.prototype) || typeof node.identity !== 'string' || !node.identity) throw invalid();
    if (node.kind === 'array' && (!Number.isSafeInteger(node.length) || node.length < 0 || node.length > 0xffffffff)) throw invalid();
    nodes.push(node.kind === 'array' ? new Array(node.length) : node.kind === 'map' ? new Map() : node.kind === 'set' ? new Set() : {});
  }
  const value = token => {
    if (!Array.isArray(token)) throw invalid();
    const [kind, data] = token;
    if (kind === 'undefined' || kind === 'null') { if (token.length !== 1) throw invalid(); return kind === 'null' ? null : undefined; }
    if (token.length !== 2) throw invalid();
    if (kind === 'ref') { if (!Number.isSafeInteger(data) || data < 0 || data >= nodes.length) throw invalid(); return nodes[data]; }
    if (kind === 'string') { if (typeof data !== 'string') throw invalid(); return data; }
    if (kind === 'boolean') { if (typeof data !== 'boolean') throw invalid(); return data; }
    if (kind === 'number') {
      if (typeof data !== 'string') throw invalid();
      const number = Number(data);
      if (data !== String(number) && !(data === '-0' && Object.is(number, -0))) throw invalid();
      return number;
    }
    if (kind === 'bigint' && typeof data === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(data)) return BigInt(data);
    throw invalid();
  };
  for (let index = 0; index < nodes.length; index++) {
    const object = nodes[index], node = graph.nodes[index], keys = new Set();
    for (const property of node.properties) {
      await step();
      if (!Array.isArray(property) || property.length !== 2 || typeof property[0] !== 'string' || keys.has(property[0])) throw invalid();
      keys.add(property[0]);
      Object.defineProperty(object, property[0], { value: value(property[1]), enumerable: true, configurable: true, writable: true });
    }
    if (node.kind === 'map' || node.kind === 'set') {
      if (!Array.isArray(node.entries)) throw invalid();
      for (const entry of node.entries) {
        await step();
        if (node.kind === 'map') {
          if (!Array.isArray(entry) || entry.length !== 2) throw invalid();
          Map.prototype.set.call(object, value(entry[0]), value(entry[1]));
        } else Set.prototype.add.call(object, value(entry));
      }
    }
    const proto = node.prototype;
    if (proto[0] === 'null' && proto.length === 1) Object.setPrototypeOf(object, null);
    else if (proto[0] === 'ref' && proto.length === 2) Object.setPrototypeOf(object, value(proto));
    else if (proto[0] !== 'default' || proto.length !== 1) throw invalid();
    selectedGraphIdentities.set(object, { header: context.header, key: node.identity });
  }
  const entry = nodes[0];
  if (graph.nodes[0].kind !== 'object' || Object.keys(entry).length !== 7
    || ['uuid', 'sessionId', 'sourceIdentity', 'sourceIdentityAliases', 'sourceUuidAliases', 'hasPromptChips', 'hasImagePaths']
      .some(key => !Object.hasOwn(entry, key))
    || typeof entry.hasPromptChips !== 'boolean' || typeof entry.hasImagePaths !== 'boolean') throw invalid();
  for (const node of nodes) { await step(); Object.freeze(node); }
  context.check();
  return { entry, hasPromptChips: entry.hasPromptChips, hasImagePaths: entry.hasImagePaths };
}

/** Exact ordered CURRENT finder. This proof carries no Send/ACK authority. */
export async function readHistoryPrimaryPromptAdoption(model, view, local, options = {}) {
  const scope = options.scope ?? 'canonical';
  const keys = ['scope', 'committed', 'excludedUuids', 'legacyHandoff', 'signal', 'owns', 'onProof'];
  if (Reflect.ownKeys(options).some(key => key !== PREPARED_ROWS && !keys.includes(key))
    || options[PREPARED_ROWS] !== undefined && (scope !== 'prepared' || typeof options[PREPARED_ROWS] !== 'function')
    || options.onProof !== undefined && typeof options.onProof !== 'function'
    || options.committed !== undefined && typeof options.committed !== 'boolean'
    || !['canonical', 'prepared'].includes(scope) || options.committed && scope !== 'canonical'
    || options.excludedUuids !== undefined && !(options.excludedUuids instanceof Set)) throw fail('HISTORY_PRIMARY_PROMPT_QUERY_INVALID');
  const dataSubject = model.getReceiptDataSubject(), exclusions = options.excludedUuids || new Set();
  if (!dataSubject || dataSubject !== view.receiptDataSubject) throw fail('HISTORY_PRIMARY_PROMPT_DATA_SUBJECT');
  const excluded = [...exclusions], localFingerprint = historyPrimaryPromptAdoptionFingerprint(local);
  const handoff = options.legacyHandoff, handoffFingerprint = handoff === undefined ? null : historyPrimaryPromptAdoptionFingerprint(handoff);
  const header = view.header, reader = view.reader, root = view.root, sequence = model.sequence;
  // The returned checker proves only the held immutable source and query
  // grammar. Callers separately fence their original H/meta successor. It
  // cannot recapture that authority after an awaited read or own transition.
  const heldCurrent = () => !options.signal?.aborted && !model.closed && model.sequence === sequence
    && model.view === view && view.header === header && view.reader === reader && view.root === root
    && model.getReceiptDataSubject() === dataSubject && view.receiptDataSubject === dataSubject;
  const activeCurrent = () => heldCurrent() && (options.owns ? options.owns() === true : true)
    && exclusions.size === excluded.length && excluded.every(value => exclusions.has(value));
  let check, outerUsed = false, outerRun;
  const outer = () => {
    if (!outerUsed) { outerRun = legacyRun(handoff); outerUsed = true; }
    return outerRun;
  };
  // Only CURRENT replacement rows have native witness records. Historical
  // rows remain in the immutable paged owner; there is no N-row inventory.
  const nativeWitnesses = [];
  const recordNative = (row, kind, observed) => {
    nativeWitnesses.push({ row, kind, rowFingerprint: historyPrimaryPromptAdoptionFingerprint(row),
      observed: historyPrimaryPromptAdoptionFingerprint(observed) });
    return observed.matched;
  };
  // If the outer legacy pass wins, the original finder never normalizes
  // current content or coerces its timestamp, including during revalidation.
  let input = handoff === undefined ? finderInput(local) : null;
  const result = await withHistoryPrimaryCanonicalConsumer(model, view, { ...options, owns: activeCurrent }, async context => {
    check = context.check;
    const eligible = async (row, ordinal, match, nativeMatch) => {
      const override = options[PREPARED_ROWS]?.(ordinal);
      if (override === false) return false;
      if (override && override !== true) {
        if (exclusions.has(override.uuid)) return false;
        return nativeMatch(override);
      }
      if (options.committed && !await committedRow(context, row)) return false;
      for (const value of excluded) {
        const uuid = selected(row, 'uuid');
        const equal = typeof value === 'number' && Number.isNaN(value)
          ? await context.kind(uuid) === 'number' && Number.isNaN(await context.number(uuid))
          : await strictEquals(context, uuid, value);
        if (equal) return false;
      }
      return match(row);
    };
    let legacy = false, found;
    if (handoff !== undefined) {
      found = await context.find(scope, (row, ordinal) => eligible(row, ordinal,
        row => legacyRow(context, row, outer()), row => recordNative(row, 'outer',
          { matched: nativeLegacyRun(row, outer()), run: outerRun })));
      legacy = !!found;
    }
    if (!found) {
      input ||= finderInput(local); context.check();
      found = await context.find(scope, (row, ordinal) => eligible(row, ordinal,
        row => finderRow(context, row, input), row => recordNative(row, 'finder', nativeFinderRow(row, input))));
    }
    if (!found) return null;
    const override = options[PREPARED_ROWS]?.(found.ordinal, true);
    const projection = override && override !== true
      ? { entry: override, hasPromptChips: !!override.promptChips?.length, hasImagePaths: !!override.imagePaths?.length }
      : await selectedEntry(context, found.row);
    context.check();
    return Object.freeze({ ...projection, ordinal: found.ordinal, legacy, header: context.header, dataSubject });
  });
  // Re-evaluate only native operations actually entered by the query. Hashes
  // alone cannot witness an inherited join/valueOf closure's current result.
  // Native work comes before the final graph and cheap checks, so reentrant
  // mutation or disposal inside a coercion cannot publish a stale proof.
  const isCurrent = () => {
    try {
      if (!heldCurrent() || !excluded.every(value => exclusions.has(value))) return false;
      reader.assertOpen();
      if (outerUsed && !Object.is(legacyRun(handoff), outerRun)) return false;
      const fresh = input ? finderInput(local, input.clock) : null;
      if (input) {
        if (fresh.normalizedText !== input.normalizedText || !Object.is(fresh.localAt, input.localAt)) return false;
        if (input.inline && !fieldsEqual(getInline(fresh), input.inline)) return false;
        if (input.exact && !fieldsEqual(getExact(fresh), input.exact)) return false;
        if (input.fallback && !fieldsEqual(getFallback(fresh), input.fallback)) return false;
        if (input.fallbackSelector && getFallbackSelector(fresh) !== input.fallbackSelector.value) return false;
        if (input.threshold && !Object.is(getThreshold(fresh), input.threshold.value)) return false;
      }
      for (const witness of nativeWitnesses) {
        const observed = witness.kind === 'outer'
          ? { matched: nativeLegacyRun(witness.row, outerRun), run: outerRun }
          : nativeFinderRow(witness.row, fresh);
        if (historyPrimaryPromptAdoptionFingerprint(observed) !== witness.observed
          || historyPrimaryPromptAdoptionFingerprint(witness.row) !== witness.rowFingerprint) return false;
      }
      const same = historyPrimaryPromptAdoptionFingerprint(local) === localFingerprint
        && (handoff === undefined || historyPrimaryPromptAdoptionFingerprint(handoff) === handoffFingerprint);
      reader.assertOpen();
      return same && heldCurrent() && excluded.every(value => exclusions.has(value));
    } catch { return false; }
  };
  check();
  if (!isCurrent()) throw fail('HISTORY_READ_CANCELLED');
  check();
  if (options.onProof) {
    options.onProof(isCurrent);
    check();
    if (!isCurrent()) throw fail('HISTORY_READ_CANCELLED');
    check();
  }
  return result;
}

/** A typed, complete UUID only for an actual local row. Historical UUIDs
 * stay in their signed documents; this is an O(local) selected native sink. */
async function preparedLocalIdentity(context, row, isLocal) {
  const role = await context.role(row);
  const prefix = role === 'queued' ? LOCAL : role === 'rewind' ? REWIND : role === 'compact-error' ? COMPACT : null;
  if (prefix === null) return null;
  const value = selected(row, 'uuid');
  if (await context.kind(value) !== 'string') throw new TypeError('entry.uuid.startsWith is not a function');
  return context.withText(value, async document => {
    let starts = document.length >= prefix.length, uuid = '';
    await context.scanText(document, (part, at) => {
      if (at < prefix.length && part.slice(0, prefix.length - at) !== prefix.slice(at, at + part.length)) starts = false;
      // Strings are collected only for the small actual local domain. A
      // nonlocal UUID (including a giant historical one) remains streamed.
      if (starts) uuid += part;
    });
    if (!starts) return null;
    const identity = { role, uuid };
    // Both real classifiers use only this typed role/prefix identity. Keep
    // the older queued-only caller distinct from Panel's three-local union.
    // This object is classification evidence, never a prompt-match body.
    return isLocal(identity) ? identity : null;
  });
}

function currentLocalIndex(currentRows, isLocal) {
  const locals = new Map();
  for (const row of currentRows) if (isLocal(row)) {
    const old = locals.get(row.uuid);
    if (old && ['handoffId', 'sendOperationKey', 'sendAttemptId'].some(key =>
      old[key] != null && row[key] != null && old[key] !== row[key])) throw fail('HISTORY_PRIMARY_LOCAL_IDENTITY_CONFLICT');
    if (!old || old.rowStub || !row.rowStub) locals.set(row.uuid, row);
  }
  return locals;
}

function suppressionInput(value) {
  // The same native normalization and typed identity grammar as the Panel.
  // Inputs are CURRENT local values; no historical scalar is copied here.
  return { normalizedText: normalize(value.text), requiresAuditIdentity: value.requiresAuditIdentity,
    auditTimestamp: value.auditTimestamp, auditSessionId: value.auditSessionId,
    sourceIdentity: value.sourceIdentity, since: value.since, until: value.until };
}
function relationalPrimitive(value) {
  // Abstract Relational Comparison uses ToPrimitive with the number hint;
  // keep bigint/string/boolean/null/undefined/Symbol intact for native >=/<=.
  if (value === null || typeof value !== 'object' && typeof value !== 'function') return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic != null) {
    if (typeof exotic !== 'function') throw new TypeError('Cannot convert object to primitive value');
    const result = Reflect.apply(exotic, value, ['number']);
    if (result === null || typeof result !== 'object' && typeof result !== 'function') return result;
    throw new TypeError('Cannot convert object to primitive value');
  }
  for (const name of ['valueOf', 'toString']) {
    const method = value[name];
    if (typeof method !== 'function') continue;
    const result = Reflect.apply(method, value, []);
    if (result === null || typeof result !== 'object' && typeof result !== 'function') return result;
  }
  throw new TypeError('Cannot convert object to primitive value');
}
async function suppressedPreparedRow(context, row, localIdentity, getInput, bound) {
  // entryMatchesSuppressedPrompt constructs normalized durable identity before
  // matchesHistoryPromptSuppression decides role/local eligibility. Preserve
  // that eager coercion and its full signed-text validation.
  const role = await context.role(row);
  let input;
  const equal = await context.withText(selected(row, 'content'), async document => {
    input = getInput(); context.check();
    let matches = document.length === input.normalizedText.length;
    await context.scanText(document, (part, at) => {
      if (part !== input.normalizedText.slice(at, at + part.length)) matches = false;
    });
    return matches;
  }, 'prompt-identity');
  if (localIdentity?.role === 'queued' || role !== 'user' && role !== 'queued') return false;
  if (input.requiresAuditIdentity) {
    if (input.sourceIdentity) {
      const identity = typeof input.sourceIdentity === 'string' ? input.sourceIdentity.trim() : '';
      // Panel durableIdentity contains sourceIdentity/sourceIdentityAliases,
      // not uuid/sourceUuidAliases. Preserve that narrower suppression proof.
      return exactIdentity(context, row, identity, true);
    }
    if (!equal || !input.auditTimestamp || !await strictEquals(context, selected(row, 'timestamp'), input.auditTimestamp)) return false;
    return !input.auditSessionId || strictEquals(context, selected(row, 'sessionId'), input.auditSessionId);
  }
  if (!equal) return false;
  const entryAt = Date.parse(await completeText(context, selected(row, 'timestamp')));
  return !Number.isFinite(entryAt) || entryAt >= bound('since', input.since) && entryAt <= bound('until', input.until);
}

/** Late-current pass over the effective MIXED prepared domain. Its retained
 * result is O(current locals + changed ordinals + matched sidecars), never an
 * Np row result, UUID inventory, or historical content graph. The independent
 * prepared owner is supplied by the caller through model/view. */
export async function prepareHistoryPrimarySparsePromptAdoption(model, view, currentRows, capturedRows, options = {}) {
  if (!Array.isArray(currentRows) || !Array.isArray(capturedRows) || typeof options.isLocal !== 'function'
    || options.suppressions !== undefined && !Array.isArray(options.suppressions)) throw fail('HISTORY_PRIMARY_SPARSE_QUERY_INVALID');
  const isLocal = options.isLocal, locals = currentLocalIndex(currentRows, isLocal);
  const captured = new Set(capturedRows.map(row => row.uuid)), seen = new Set();
  const fingerprints = [...locals.values()].map(row => [row, historyPrimaryPromptAdoptionFingerprint(row)]);
  const capturedFingerprint = historyPrimaryPromptAdoptionFingerprint(capturedRows);
  const suppressions = options.suppressions || [], suppressionFingerprints = suppressions.map(value =>
    historyPrimaryPromptAdoptionFingerprint(value)), suppressionInputs = new Map(), suppressionBounds = new Map();
  const header = view.header, reader = view.reader, root = view.root, sequence = model.sequence, dataSubject = view.receiptDataSubject;
  if (!dataSubject || model.getReceiptDataSubject() !== dataSubject || !Number.isSafeInteger(header.sourceEntryCount)
    || header.sourceEntryCount < 0) throw fail('HISTORY_PRIMARY_SPARSE_DATA_SUBJECT');
  const cheapCurrent = () => !model.closed && model.sequence === sequence && model.view === view
    && view.header === header && view.reader === reader && view.root === root && view.receiptDataSubject === dataSubject
    && model.getReceiptDataSubject() === dataSubject && !options.signal?.aborted
    && (options.owns ? options.owns() === true : true);
  const check = () => { if (!cheapCurrent()) throw fail('HISTORY_READ_CANCELLED'); reader.assertOpen(); };
  const queryProofs = [];
  const isCurrent = () => {
    try {
      // Native predicate replay first; the fresh ORIGINAL full CURRENT witness
      // follows it, then the cheap original owner. Do not reverse this order:
      // a native coercion can synchronously dispose/reenter/change authoring.
      if (!cheapCurrent() || queryProofs.some(current => !current())) return false;
      for (const [index, input] of suppressionInputs) {
        if (!fieldsEqual(suppressionInput(suppressions[index]), input)) return false;
        const bounds = suppressionBounds.get(index);
        if (bounds) for (const [field, value] of bounds) if (!Object.is(relationalPrimitive(input[field]), value)) return false;
      }
      const fresh = currentLocalIndex(currentRows, isLocal), ordered = [...fresh.values()];
      const same = ordered.length === fingerprints.length && fingerprints.every(([row, fingerprint], index) =>
        ordered[index] === row && historyPrimaryPromptAdoptionFingerprint(row) === fingerprint)
        && historyPrimaryPromptAdoptionFingerprint(capturedRows) === capturedFingerprint
        && suppressions.length === suppressionFingerprints.length && suppressions.every((value, index) =>
          historyPrimaryPromptAdoptionFingerprint(value) === suppressionFingerprints[index]);
      reader.assertOpen(); return same && cheapCurrent();
    } catch { return false; }
  };
  const replacements = new Map(), exclusions = new Set(options[COMPATIBILITY_EXCLUSIONS] || []);
  for (const ordinal of exclusions) if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= header.sourceEntryCount)
    throw fail('HISTORY_PRIMARY_SPARSE_ORDINAL');
  const getSuppression = index => {
    if (!suppressionInputs.has(index)) suppressionInputs.set(index, suppressionInput(suppressions[index]));
    return suppressionInputs.get(index);
  };
  const suppressionBound = (index, field, value) => {
    const primitive = relationalPrimitive(value), bounds = suppressionBounds.get(index) || new Map();
    if (bounds.has(field) && !Object.is(bounds.get(field), primitive)) throw fail('HISTORY_READ_CANCELLED');
    bounds.set(field, primitive); suppressionBounds.set(index, bounds); return primitive;
  };
  check();
  await withHistoryPrimaryCanonicalConsumer(model, view, { signal: options.signal, owns: cheapCurrent }, async context => {
    await context.find('prepared', async (row, ordinal) => {
      if (exclusions.has(ordinal)) return false;
      const localIdentity = await preparedLocalIdentity(context, row, isLocal);
      for (let index = 0; index < suppressions.length; index++) {
        if (await suppressedPreparedRow(context, row, localIdentity, () => getSuppression(index),
          (field, value) => suppressionBound(index, field, value))) {
          exclusions.add(ordinal); return false;
        }
      }
      if (localIdentity) {
        const current = locals.get(localIdentity.uuid);
        if (current && !seen.has(localIdentity.uuid)) { seen.add(localIdentity.uuid); replacements.set(ordinal, current); }
        else exclusions.add(ordinal);
      }
      return false;
    });
    context.check();
  });
  check();
  const late = [...locals.values()].filter(row => !captured.has(row.uuid) && !seen.has(row.uuid));
  const retained = [], consumed = new Set(), chips = new Map(), images = new Map(), now = Date.now();
  const preparedRow = ordinal => exclusions.has(ordinal) ? false : replacements.get(ordinal) || true;
  for (const local of late) {
    check();
    if (local.role === 'rewind' && local.uuid.startsWith(REWIND)
      || local.role === 'compact-error' && local.uuid.startsWith(COMPACT)) { retained.push(local); continue; }
    if (local.role !== 'queued' || !local.uuid.startsWith(LOCAL)) continue;
    const proof = await readHistoryPrimaryPromptAdoption(model, view, local,
      { scope: 'prepared', excludedUuids: consumed, signal: options.signal, owns: cheapCurrent,
        onProof: current => queryProofs.push(current), [PREPARED_ROWS]: preparedRow });
    check();
    if (proof) {
      // One reservation belongs to the complete ordered pass. Even if a
      // CURRENT sidecar getter throws below, no downstream caller can reuse it.
      consumed.add(proof.entry.uuid);
      if (local.promptChips?.length && !proof.hasPromptChips) chips.set(proof.entry.uuid, local.promptChips);
      if (local.imagePaths?.length && !proof.hasImagePaths) images.set(proof.entry.uuid, local.imagePaths);
      continue;
    }
    const age = now - (local.statusChangedAt || local.optimisticAt || Date.parse(local.timestamp || '') || now);
    const recovery = Number.isSafeInteger(local.applicationQueueId) && Number(local.applicationQueueId) > 0
      || local.statusReason === 'history-preparation-interrupted';
    if ((local.queueStatus === 'failed' || local.queueStatus === 'cancelled') && !recovery && age >= 15000) continue;
    retained.push(local);
  }
  if (!isCurrent()) throw fail('HISTORY_READ_CANCELLED');
  const enrichmentKeys = new Set([...chips.keys(), ...images.keys()]);
  const publication = Object.freeze({ kind: 'history-primary-sparse-presentation-v1', header, dataSubject,
    sourceEntryCount: header.sourceEntryCount,
    replacements: Object.freeze([...replacements].map(([ordinal, row]) => Object.freeze({ ordinal, row }))),
    exclusions: Object.freeze([...exclusions].sort((left, right) => left - right)),
    enrichments: Object.freeze([...enrichmentKeys].map(uuid => Object.freeze({ uuid,
      ...(chips.has(uuid) ? { promptChips: chips.get(uuid) } : {}), ...(images.has(uuid) ? { imagePaths: images.get(uuid) } : {}) }))),
    // This is the existing full causal merge recipe, not a Nu/rank or layout
    // certificate. Its native compatibility adapter remains explicitly OPEN.
    insertionOrder: 'buildHistoryLivePresentation', insertions: Object.freeze(retained.slice()),
    currentLocals: Object.freeze([...locals.values()]),
  });
  // Construction proofs close over original caller witnesses and may still
  // reference an Np compatibility owner. They remain on the transient proof,
  // never on the independently retained sparse publication.
  sparsePublications.set(publication, { replacements, exclusions, chips, images, retained });
  return Object.freeze({ publication, isCurrent,
    materializeCompatibility: prepared => {
      if (!isCurrent()) throw fail('HISTORY_READ_CANCELLED');
      const entries = materializeHistoryPrimarySparseCompatibility(publication, prepared);
      if (!isCurrent()) throw fail('HISTORY_READ_CANCELLED');
      return entries;
    } });
}

/** Explicit Np compatibility adapter. It receives the exact original frozen
 * prepared array from the candidate owner; the sparse publication never
 * captures that array/result. Existing geometry/rosters/legacy consumers still
 * own this genuine result. The caller binds the original metadata identity,
 * not an arbitrary equal count/keys array, before invoking this adapter. */
export function materializeHistoryPrimarySparseCompatibility(publication, prepared) {
  const state = sparsePublications.get(publication);
  if (!state || !Array.isArray(prepared) || prepared.length !== publication.sourceEntryCount)
    throw fail('HISTORY_PRIMARY_SPARSE_COMPATIBILITY');
  const rows = [];
  for (let ordinal = 0; ordinal < prepared.length; ordinal++) {
    if (state.exclusions.has(ordinal)) continue;
    const original = state.replacements.get(ordinal) || prepared[ordinal];
    const promptChips = state.chips.get(original.uuid), imagePaths = state.images.get(original.uuid);
    if (promptChips || imagePaths) {
      const decorated = { ...original,
        ...(promptChips ? { promptChips } : {}), ...(imagePaths ? { imagePaths } : {}) };
      // The native adapter already creates this clone. Keep its exact source
      // ordinal on that clone, not in another historical N-row Map. Genuine
      // CURRENT originals and frozen historical rows are never mutated.
      Object.defineProperty(decorated, SPARSE_COMPATIBILITY_ORIGIN,
        { value: Object.freeze({ publication, ordinal }), enumerable: false });
      copyHistoryPrimaryMetadataOrigin(original, decorated);
      rows.push(decorated);
    } else rows.push(original);
  }
  const entries = state.retained.length ? buildHistoryLivePresentation(rows, state.retained) : rows;
  return entries;
}

/** Registration-time origin of a sparse enrichment clone only. It is neither
 * a historical UUID lookup nor proof that a different publication is equal. */
export function historyPrimarySparseCompatibilityOrdinal(publication, row) {
  if (!sparsePublications.has(publication)) throw fail('HISTORY_PRIMARY_SPARSE_PUBLICATION');
  const origin = row && typeof row === 'object' ? Object.getOwnPropertyDescriptor(row, SPARSE_COMPATIBILITY_ORIGIN)?.value : null;
  return origin?.publication === publication ? origin.ordinal : null;
}

/** Select the exact prepared/MIXED member named by its source ordinal. This
 * carries only CURRENT overrides and sidecars; historical rows remain selected
 * at the independent held owner. A false return is a proved exclusion, never
 * unavailable history or an empty-state substitute. */
export function historyPrimarySparsePreparedOverride(publication, ordinal) {
  const state = sparsePublications.get(publication);
  if (!state || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= publication.sourceEntryCount)
    throw fail('HISTORY_PRIMARY_SPARSE_ORDINAL');
  return state.exclusions.has(ordinal) ? false : state.replacements.get(ordinal) || true;
}

/** Selected counterpart of the explicit Np adapter. The caller supplies one
 * authenticated metadata ordinal from the SAME held prepared publication.
 * Enriched duplicate occurrences do not become a retained historical array;
 * only this selected result is allocated and sidecars keep native identity. */
export function selectHistoryPrimarySparsePreparedRow(publication, ordinal, selectedMetadata) {
  const state = sparsePublications.get(publication);
  const override = historyPrimarySparsePreparedOverride(publication, ordinal);
  if (override === false) return false;
  const row = override === true ? selectedMetadata : override;
  if (!row || typeof row !== 'object') throw fail('HISTORY_PRIMARY_SPARSE_SELECTED_ROW');
  const promptChips = state.chips.get(row.uuid), imagePaths = state.images.get(row.uuid);
  return promptChips || imagePaths ? { ...row,
    ...(promptChips ? { promptChips } : {}), ...(imagePaths ? { imagePaths } : {}) } : row;
}

/** Older real Np caller. Its array filtering is an explicit compatibility
 * adapter only; the new planner itself never consults native historical rows. */
export async function prepareHistoryPrimaryPromptAdoption(model, view, prepared, currentRows, capturedRows, options) {
  const source = view.serverMetadata.entries, exclusions = new Set();
  let position = 0;
  for (let ordinal = 0; ordinal < source.length; ordinal++) {
    if (prepared[position] === source[ordinal]) position++;
    else exclusions.add(ordinal);
  }
  if (position !== prepared.length) throw fail('HISTORY_PRIMARY_SPARSE_COMPATIBILITY');
  const sparse = await prepareHistoryPrimarySparsePromptAdoption(model, view, currentRows, capturedRows,
    { ...options, [COMPATIBILITY_EXCLUSIONS]: exclusions });
  const entries = sparse.materializeCompatibility(source);
  return Object.freeze({ entries, publication: sparse.publication, isCurrent: sparse.isCurrent });
}

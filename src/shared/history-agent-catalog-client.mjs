// A catalog is an independently retained read capability. Its root contains
// paged records, never a native historical roster. All selected text borrows
// this lease; cancelling a demand abandons its local probe, not the owner.
import { HistoryRootClient, HistoryTextDocument, historyRootIdentity,
  checkedHistoryRootOpenHeader, checkedHistoryPrimaryPreparedPresentation } from './history-root-read-client.mjs';

export const HISTORY_AGENT_CATALOG_PROFILE = 'history-agent-catalog-v1';
export const HISTORY_AGENT_CATALOG_ENCODING = 'history-primary-agent-catalog-v1';
const IDENTITIES = ['leaseId', 'ownerKey', 'revision', 'generation'];
const SECTIONS = ['all', 'roster', 'running', 'completed', 'interrupted', 'background'];
const COUNTS = ['total', 'roster', 'running', 'completed', 'interrupted', 'background', 'backgroundAgents'];
const NATIVE_REQUESTS = ['identities', 'physical', 'deferred', 'setting', 'isLastUser', 'task-actions',
  'agentKey', 'property', 'has', 'coerce', 'date', 'map-get', 'set-has', 'iterator', 'next', 'strict-equal', 'subtract', 'setting-conflict-clone'];
const SCALAR_CHARS = 4096;
const SUMMARY_FIELDS = ['key', 'kind', 'label', 'startedAt', 'status', 'completedAt', 'durationMs'];
const NATIVE_FIELDS = new Set(['key', 'kind', 'label', 'startedAt', 'status', 'completedAt', 'durationMs', 'entryUuid', 'taskHistory', 'taskResult', 'agentSessionId', 'agentId',
  'taskPrompt', 'launchSettings', 'bashAcceptance', 'backgroundCommand', 'backgroundTaskId']);
const fail = code => Object.assign(new Error(code), { code });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const same = (left, right) => IDENTITIES.every(key => left?.[key] === right?.[key]);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const checked = new WeakSet();
const capabilityStates = new WeakMap();

function bindingFor(capability) {
  checkedHistoryPrimaryPreparedPresentation(capability);
  const header = checkedHistoryRootOpenHeader(capability.header), cap = header.preparedPresentation;
  if (!cap || cap.schema !== 1 || header.metadataSchema !== 1 || header.semanticSnapshotComplete !== true
    || header.sourceMetadata?.length !== header.sourceEntryCount) throw fail('HISTORY_AGENT_CATALOG_SOURCE');
  return Object.freeze({ ...historyRootIdentity(header), profile: cap.profile, schema: cap.schema,
    parentNodeToken: header.root.nodeToken, nodeToken: header.sourceMetadata.nodeToken,
    metadataIdentity: header.metadataIdentity, metadataSchema: header.metadataSchema,
    semanticIdentity: header.semanticIdentity, semanticRevisionToken: header.semanticRevisionToken,
    viewRevisionToken: header.viewRevisionToken, canonicalEntryCount: header.canonicalEntryCount,
    sourceEntryCount: header.sourceEntryCount, sourceProof: cap.sourceProof,
    validationDigest: cap.validationDigest, validationToken: cap.validationToken });
}
function descriptor(value, identity, kind) {
  // Reuse the canonical checked descriptor implementation; construction has
  // no remote side effect and cannot mint a catalog capability on its own.
  const probe = new HistoryRootClient(() => { throw fail('HISTORY_AGENT_CATALOG_DESCRIPTOR'); }, value);
  const result = probe.root;
  void probe.abandon();
  if (!same(result, identity) || result.kind !== kind || kind === 'array' && !integer(result.length)) {
    throw fail('HISTORY_AGENT_CATALOG_DESCRIPTOR');
  }
  return result;
}
function headerFor(result, binding, catalogRequestId, expectedSequence = 0) {
  if (result?.success !== true) throw fail(result?.error || 'HISTORY_AGENT_CATALOG_OPEN_FAILED');
  const identity = historyRootIdentity(result);
  if (result.__notedHistoryTransport !== 'root-v1' || result.readProfile !== HISTORY_AGENT_CATALOG_PROFILE
    || result.schema !== 1 || result.catalogRequestId !== catalogRequestId
    || !integer(result.sequence) || result.sequence !== expectedSequence
    || !['native', 'ready'].includes(result.phase)
    || identity.leaseId === binding.leaseId
    || ['ownerKey', 'revision', 'generation'].some(key => identity[key] !== binding[key])
    || !exactKeys(result.binding, Object.keys(binding))
    || Object.keys(binding).some(key => result.binding[key] !== binding[key])) throw fail('HISTORY_AGENT_CATALOG_HEADER');
  const root = descriptor(result.root, identity, 'object');
  if (result.phase !== 'ready') {
    if (!exactKeys(result.nativeRequest, ['kind', 'arguments']) || !NATIVE_REQUESTS.includes(result.nativeRequest.kind)) {
      throw fail('HISTORY_AGENT_CATALOG_NATIVE_REQUEST');
    }
    const argumentsNode = descriptor(result.nativeRequest.arguments, identity, 'object');
    return Object.freeze({ ...identity, root, binding, catalogRequestId, readProfile: HISTORY_AGENT_CATALOG_PROFILE,
      schema: 1, phase: result.phase, sequence: result.sequence,
      nativeRequest: Object.freeze({ kind: result.nativeRequest.kind, arguments: argumentsNode }) });
  }
  if (!exactKeys(result.counts, COUNTS) || COUNTS.some(key => !integer(result.counts[key]))
    || result.counts.roster !== result.counts.running + result.counts.completed + result.counts.interrupted
    || result.counts.roster > result.counts.total
    || result.counts.backgroundAgents > result.counts.background
    || !exactKeys(result.sections, SECTIONS)) throw fail('HISTORY_AGENT_CATALOG_HEADER');
  const sections = {};
  for (const section of SECTIONS) {
    sections[section] = descriptor(result.sections[section], identity, 'array');
    if (sections[section].length !== result.counts[section === 'all' ? 'total' : section]) {
      throw fail('HISTORY_AGENT_CATALOG_COUNTS');
    }
  }
  return Object.freeze({ ...identity, root, sections: Object.freeze(sections),
    counts: Object.freeze(Object.fromEntries(COUNTS.map(key => [key, result.counts[key]]))),
    binding, catalogRequestId, readProfile: HISTORY_AGENT_CATALOG_PROFILE, schema: 1, phase: 'ready', sequence: result.sequence });
}
function retainedCatalogInvoke(invoke, releaseChannel, pageChannel, state) {
  return (channel, payload) => {
    const header = state.header;
    if (channel === releaseChannel && payload?.leaseId === header.leaseId)
      return invoke(channel, { ...payload, catalogRequestId: header.catalogRequestId });
    if (channel !== pageChannel) return invoke(channel, payload);
    const request = { ...payload, catalogRequestId: header.catalogRequestId, catalogSequence: header.sequence };
    return Promise.resolve(invoke(channel, request)).then(result => {
      if (state.header !== header) throw fail('HISTORY_AGENT_CATALOG_SEQUENCE');
      if (result?.success === true && (result.catalogSequence !== header.sequence || result.catalogRequestId !== header.catalogRequestId)) throw fail('HISTORY_AGENT_CATALOG_SEQUENCE');
      return result;
    });
  };
}
function assertOwner(signal, owns) {
  if (signal?.aborted || owns() !== true || signal?.aborted) throw fail('HISTORY_READ_CANCELLED');
}

// Construct outside the allocating call. Retained readers cannot capture its
// transient current recipe, abort listeners, raw receipt or compiler context.
function createCatalogCapability(invoke, channels, header, binding, catalogRequestId, transport) {
  const state = { header, reading: false };
  const reader = new HistoryRootClient(retainedCatalogInvoke(invoke, channels.releaseChannel, channels.pageChannel, state), header.root, { pageBytes: channels.pageBytes,
    pageItems: channels.pageItems, pageChannel: channels.pageChannel,
    releaseChannel: channels.releaseChannel, forkChannel: channels.forkChannel });
  let stagePending = false;
  const child = Object.freeze({ kind: 'history-agent-catalog-capability-v1', get header() { return state.header; }, reader, transport,
    async advance(data, options = {}) {
      const stageSignal = options.signal, stageOwns = options.owns || (() => true), original = state.header;
      assertOwner(stageSignal, stageOwns); reader.assertOpen(stageSignal);
      if (stagePending || state.reading || original.phase === 'ready') throw fail('HISTORY_AGENT_CATALOG_STAGE');
      stagePending = true;
      let rejectStage;
      const cancelled = new Promise((_resolve, reject) => { rejectStage = reject; }); cancelled.catch(() => {});
      const abortStage = () => rejectStage(fail('HISTORY_READ_CANCELLED'));
      stageSignal?.addEventListener('abort', abortStage, { once: true });
      const unsubscribeClose = reader.subscribeClose(abortStage);
      try {
        const binding = { ...historyRootIdentity(original), nodeToken: original.root.nodeToken,
          kind: 'primary-agent-catalog-step', catalogRequestId, sequence: original.sequence,
        };
        const call = async (operation, data) => {
          assertOwner(stageSignal, stageOwns); reader.assertOpen(stageSignal);
          const request = { ...binding, operation, data };
          const raw = transport?.readHistoryThroughIpc
            ? transport.readHistoryThroughIpc(invoke, reader.pageChannel, request, { signal: stageSignal })
            : invoke(reader.pageChannel, request);
          const result = await Promise.race([raw, cancelled]);
          assertOwner(stageSignal, stageOwns); reader.assertOpen(stageSignal);
          if (state.header !== original) throw fail('HISTORY_AGENT_CATALOG_SEQUENCE');
          return result;
        };
        let result;
        if (data?.value?.type === 'string' && typeof data.value.value === 'string'
          && data.value.value.length > SCALAR_CHARS) {
          // This is a catalog-owned scalar under the SAME child/sequence.
          // It is neither a user Input document nor another allocation lane.
          // Unpaired UTF16 surrogates and full key/prompt lengths are exact.
          const text = data.value.value;
          for (let offset = 0; offset < text.length;) {
            const chunk = text.slice(offset, offset + SCALAR_CHARS);
            const receipt = await call('append-value', { offset, text: chunk });
            if (receipt?.success !== true) throw fail(receipt?.error || 'HISTORY_AGENT_CATALOG_SCALAR');
            if (!same(receipt, original) || receipt.catalogRequestId !== catalogRequestId
              || receipt.sequence !== original.sequence || receipt.accepted !== true
              || receipt.offset !== offset || receipt.nextOffset !== offset + chunk.length) {
              throw fail('HISTORY_AGENT_CATALOG_SCALAR_RECEIPT');
            }
            offset = receipt.nextOffset;
          }
          result = await call('advance-value', { length: text.length, valueType: 'string' });
        } else result = await call('advance', data);
        assertOwner(stageSignal, stageOwns); reader.assertOpen(stageSignal);
        if (state.header !== original) throw fail('HISTORY_AGENT_CATALOG_SEQUENCE');
        state.header = headerFor(result, original.binding, catalogRequestId, original.sequence + 1);
        return state.header;
      } finally { stageSignal?.removeEventListener('abort', abortStage); unsubscribeClose(); stagePending = false; }
    },
  });
  checked.add(child);
  capabilityStates.set(child, { state, busy: () => stagePending });
  return child;
}

/** Allocate once from the original independently held prepared source. The
 * original request ID accompanies every cleanup, including malformed replies.
 * An aborted UI lane never waits for the unobserved raw allocation/release. */
export async function openHistoryAgentCatalog(capability, current, {
  signal, owns = () => true, transport,
} = {}) {
  const binding = bindingFor(capability), parent = capability.reader;
  parent.assertOpen(signal); assertOwner(signal, owns); parent.assertOpen(signal);
  const crypto = globalThis.crypto || globalThis.window?.require?.('node:crypto');
  if (typeof crypto?.randomUUID !== 'function') throw fail('HISTORY_AGENT_CATALOG_CRYPTO_REQUIRED');
  const catalogRequestId = crypto.randomUUID();
  const request = { ...binding, encoding: HISTORY_AGENT_CATALOG_ENCODING, catalogRequestId, current };
  let observed, child, abandoned = false, discarded = false, rejectAbort;
  const discard = result => {
    if (discarded || child || result?.success !== true) return;
    let identity;
    try { identity = historyRootIdentity(result); } catch { return; }
    if (identity.leaseId === binding.leaseId
      || ['ownerKey', 'revision', 'generation'].some(key => identity[key] !== binding[key])) return;
    discarded = true;
    try { Promise.resolve(parent.invoke(parent.releaseChannel, { ...identity, catalogRequestId })).catch(() => {}); } catch {}
  };
  const invoke = (channel, payload) => {
    const raw = parent.invoke(channel, payload);
    if (channel !== parent.forkChannel) return raw;
    return Promise.resolve(raw).then(result => {
      observed = result;
      if (abandoned || parent.closed || signal?.aborted) discard(result);
      return result;
    });
  };
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const onAbort = () => { abandoned = true; discard(observed); rejectAbort(fail('HISTORY_READ_CANCELLED')); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const unsubscribeClose = parent.subscribeClose(onAbort);
  try {
    assertOwner(signal, owns); parent.assertOpen(signal);
    const pending = transport?.readHistoryThroughIpc
      ? transport.readHistoryThroughIpc(invoke, parent.forkChannel, request, { signal })
      : invoke(parent.forkChannel, request);
    const result = await Promise.race([pending, aborted]);
    assertOwner(signal, owns); parent.assertOpen(signal);
    const header = headerFor(result, binding, catalogRequestId);
    child = createCatalogCapability(parent.invoke, { pageBytes: parent.pageBytes, pageItems: parent.pageItems,
      pageChannel: parent.pageChannel, releaseChannel: parent.releaseChannel, forkChannel: parent.forkChannel },
      header, binding, catalogRequestId, transport);
    return child;
  } catch (error) {
    abandoned = true;
    if (child) void child.reader.close().catch(() => {}); else discard(observed);
    throw error;
  } finally { signal?.removeEventListener('abort', onAbort); unsubscribeClose(); }
}

class CatalogProbe extends HistoryRootClient { close() { return this.abandon(); } }
class BorrowedCatalogText extends HistoryTextDocument {
  #closed = false;
  async read(offset, limit, options) {
    if (this.#closed) throw fail('HISTORY_READ_CANCELLED');
    const result = await super.read(offset, limit, options);
    if (this.#closed) throw fail('HISTORY_READ_CANCELLED');
    return result;
  }
  close() { this.#closed = true; return Promise.resolve(); }
}

/** One bounded page or one selected record. Text integrity remains checked by
 * the caller's existing UTF16 document sink; no text child lease is created. */
export function createHistoryAgentCatalogReader(capability, { nativeValues = [], readText } = {}) {
  if (!checked.has(capability) || !Array.isArray(nativeValues) || typeof readText !== 'function') {
    throw fail('HISTORY_AGENT_CATALOG_CAPABILITY');
  }
  const { header, reader, transport } = capability;
  let closed = false, pending = false, releaseState = 'held', releasePromise;
  const check = (signal, owns) => {
    if (closed) throw fail('HISTORY_READ_CANCELLED');
    assertOwner(signal, owns); reader.assertOpen(signal);
    if (closed) throw fail('HISTORY_READ_CANCELLED');
  };
  const run = async (options, operation) => {
    const { signal, owns = () => true } = options;
    check(signal, owns);
    const control = capabilityStates.get(capability);
    if (pending || control.busy() || control.state.reading) throw fail('HISTORY_AGENT_CATALOG_CONCURRENT_READ');
    if (control.state.header !== header) throw fail('HISTORY_AGENT_CATALOG_SEQUENCE');
    control.state.reading = true;
    pending = true;
    const probe = new CatalogProbe((channel, payload) => channel === reader.pageChannel && transport?.readHistoryThroughIpc
      ? transport.readHistoryThroughIpc(reader.invoke, channel, payload, { signal })
      : reader.invoke(channel, payload), header.root, { pageBytes: reader.pageBytes,
      pageItems: reader.pageItems, pageChannel: reader.pageChannel, releaseChannel: reader.releaseChannel,
      forkChannel: reader.forkChannel });
    const guard = () => check(signal, owns);
    const onAbort = () => { void probe.abandon(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const unsubscribeClose = reader.subscribeClose(onAbort);
    try { const result = await operation(probe, guard, signal); guard(); return result; }
    finally { signal?.removeEventListener('abort', onAbort); unsubscribeClose(); void probe.abandon(); pending = false; control.state.reading = false; }
  };
  const decode = async (probe, descriptor, guard, signal) => {
    const decoded = new Map(), work = [];
    const value = async node => {
      guard();
      if (!node || typeof node !== 'object' || !node.protocol) return node;
      if (decoded.has(node.nodeToken)) return decoded.get(node.nodeToken);
      if (node.kind === 'text') {
        const selected = await readText(new BorrowedCatalogText(probe, node), { signal, owns: () => { guard(); return true; } });
        guard(); decoded.set(node.nodeToken, selected); return selected;
      }
      if (!['array', 'object'].includes(node.kind)) throw fail('HISTORY_AGENT_CATALOG_VALUE');
      const result = node.kind === 'array' ? new Array(node.length) : {};
      decoded.set(node.nodeToken, result); work.push({ node, result }); return result;
    };
    const result = await value(descriptor);
    while (work.length) {
      const frame = work.pop(); let offset = 0;
      do {
        guard();
        const array = frame.node.kind === 'array';
        const page = array ? await probe.range(frame.node, { offset }) : await probe.fields(frame.node, { offset });
        guard();
        for (const item of page.items) {
          if (array && item.present === false) continue;
          const key = array ? String(item.ordinal) : await value(item.name);
          guard();
          if (typeof key !== 'string') throw fail('HISTORY_AGENT_CATALOG_FIELD');
          Object.defineProperty(frame.result, key, { value: await value(item.value), enumerable: true, writable: true, configurable: true });
        }
        if (page.done) break;
        if (page.nextOffset <= offset) throw fail('HISTORY_AGENT_CATALOG_PROGRESS');
        offset = page.nextOffset;
      } while (true);
    }
    guard(); return result;
  };
  const projection = async (probe, node, fields, guard, signal) => {
    const result = {}; let offset = 0;
    for (;;) {
      const page = await probe.project(node, fields, { offset, limit: probe.pageItems }); guard();
      for (const item of page.items) {
        if (typeof item.name !== 'string' || !fields.includes(item.name) || own(result, item.name))
          throw fail('HISTORY_AGENT_CATALOG_FIELD');
        Object.defineProperty(result, item.name, { value: await decode(probe, item.value, guard, signal),
          enumerable: true, configurable: true, writable: true });
      }
      if (page.done) break;
      if (page.nextOffset <= offset) throw fail('HISTORY_AGENT_CATALOG_PROGRESS');
      offset = page.nextOffset;
    }
    if (!fields.every(field => own(result, field))) throw fail('HISTORY_AGENT_CATALOG_FIELD');
    return result;
  };
  const record = async (probe, node, guard, signal, summary = false) => {
    let wrapper;
    if (summary) {
      const packet = await probe.project(node, ['record', 'fieldRefs', 'fieldTypes'], { limit: 3 }); guard();
      if (!packet.done || packet.items.length !== 3
        || packet.items.some((item, index) => item.name !== ['record', 'fieldRefs', 'fieldTypes'][index])) {
        throw fail('HISTORY_AGENT_CATALOG_RECORD');
      }
      const recordNode = packet.items[0].value;
      if (recordNode?.kind !== 'object') throw fail('HISTORY_AGENT_CATALOG_RECORD');
      wrapper = { record: await projection(probe, recordNode, SUMMARY_FIELDS, guard, signal),
        fieldRefs: await decode(probe, packet.items[1].value, guard, signal) };
      const types = await decode(probe, packet.items[2].value, guard, signal);
      if (types !== undefined) wrapper.fieldTypes = types;
    } else wrapper = await decode(probe, node, guard, signal);
    if (!(exactKeys(wrapper, ['record', 'fieldRefs']) || exactKeys(wrapper, ['record', 'fieldRefs', 'fieldTypes']))
      || !object(wrapper.record) || !object(wrapper.fieldRefs)
      || own(wrapper, 'fieldTypes') && !object(wrapper.fieldTypes)) {
      throw fail('HISTORY_AGENT_CATALOG_RECORD');
    }
    for (const [field, slot] of Object.entries(wrapper.fieldRefs)) {
      if (!NATIVE_FIELDS.has(field) || !integer(slot) || slot >= nativeValues.length || !own(nativeValues, slot)) {
        throw fail('HISTORY_AGENT_CATALOG_NATIVE_REFERENCE');
      }
      const type = wrapper.fieldTypes?.[field];
      if (type && (!exactKeys(type, ['type', 'slot', 'valueType', 'array', 'truthy']) || type.type !== 'native'
        || type.slot !== slot || type.valueType !== typeof nativeValues[slot]
        || type.array !== Array.isArray(nativeValues[slot]) || type.truthy !== !!nativeValues[slot])) {
        throw fail('HISTORY_AGENT_CATALOG_NATIVE_REFERENCE');
      }
      if (summary && !SUMMARY_FIELDS.includes(field)) continue;
      Object.defineProperty(wrapper.record, field, { value: nativeValues[slot], enumerable: true, writable: true, configurable: true });
    }
    if (typeof wrapper.record.key !== 'string' || !wrapper.record.key || typeof wrapper.record.label !== 'string') {
      throw fail('HISTORY_AGENT_CATALOG_RECORD');
    }
    guard(); return wrapper.record;
  };
  const pageNodes = async (probe, section, offset, limit, guard) => {
    const node = header.sections[section];
    const page = await probe.range(node, { offset, limit }); guard();
    if (page.length !== node.length || page.nextOffset !== offset + page.items.length
      || page.done !== (page.nextOffset === node.length)
      || page.items.some((item, index) => item.ordinal !== offset + index || item.present !== true || item.value?.kind !== 'object')) {
      throw fail('HISTORY_AGENT_CATALOG_PAGE');
    }
    return page;
  };
  const membership = async (probe, operation, values, guard) => {
    const result = await Promise.race([probe.invoke(probe.pageChannel, { ...historyRootIdentity(header),
      kind: 'primary-agent-catalog-membership', operation, values }), probe.closedPromise]);
    guard();
    if (result?.success !== true) throw fail(result?.error || 'HISTORY_AGENT_CATALOG_MEMBERSHIP_FAILED');
    if (!exactKeys(result, ['success', ...IDENTITIES, 'catalogRequestId', 'catalogSequence', 'kind', 'operation', 'items'])
      || !same(result, header) || result.catalogRequestId !== header.catalogRequestId
      || result.catalogSequence !== header.sequence || result.kind !== 'primary-agent-catalog-membership'
      || result.operation !== operation || !Array.isArray(result.items) || result.items.length !== values.length) {
      throw fail('HISTORY_AGENT_CATALOG_MEMBERSHIP_PROTOCOL');
    }
    return result.items.map((item, index) => {
      if (!exactKeys(item, operation === 'detail' ? ['ordinal', 'found', 'record'] : ['ordinal', 'found'])
        || item.ordinal !== index || typeof item.found !== 'boolean') throw fail('HISTORY_AGENT_CATALOG_MEMBERSHIP_PROTOCOL');
      const selected = operation === 'detail' && item.found ? descriptor(item.record, header, 'object') : null;
      if (operation === 'detail' && !item.found && item.record !== null) throw fail('HISTORY_AGENT_CATALOG_MEMBERSHIP_PROTOCOL');
      return Object.freeze({ value: values[index], found: item.found, ...(operation === 'detail' ? { record: selected } : {}) });
    });
  };
  return Object.freeze({ kind: 'history-agent-catalog-reader-v1', header, counts: header.counts,
    readValue(node, options = {}) { return run(options, (probe, guard, signal) => decode(probe, node, guard, signal)); },
    readRecord(node, options = {}) { return run(options, (probe, guard, signal) => record(probe, node, guard, signal)); },
    get closed() { return closed; }, get releaseState() { return releaseState; },
    async readPage({ section = 'all', offset = 0, limit = 24, ...options } = {}) {
      if (header.phase !== 'ready' || !SECTIONS.includes(section) || !integer(offset) || offset > header.sections[section].length
        || !integer(limit) || limit < 1 || limit > 64) throw fail('HISTORY_AGENT_CATALOG_RANGE');
      return run(options, async (probe, guard, signal) => {
        const rows = []; let nextOffset = offset;
        while (rows.length < limit && nextOffset < header.sections[section].length) {
          const page = await pageNodes(probe, section, nextOffset, Math.min(probe.pageItems, limit - rows.length), guard);
          for (const item of page.items) rows.push(await record(probe, item.value, guard, signal, true));
          nextOffset = page.nextOffset; guard();
        }
        return Object.freeze({ section, offset, nextOffset, done: nextOffset === header.sections[section].length,
          total: header.sections[section].length, rows: Object.freeze(rows) });
      });
    },
    async lookup(key, options = {}) {
      if (header.phase !== 'ready' || typeof key !== 'string' || !key) throw fail('HISTORY_AGENT_CATALOG_KEY');
      // The exact key index lives in the same paged child. Selection does
      // not retain or reconstruct a native all-key/roster Map.
      return run(options, async (probe, guard, signal) => {
        const [found] = await membership(probe, 'detail', [key], guard);
        const selected = found.found ? await record(probe, found.record, guard, signal) : null;
        if (selected && selected.key !== key) throw fail('HISTORY_AGENT_CATALOG_SELECTED_KEY');
        return selected ? Object.freeze({ kind: 'found', key, record: selected })
          : Object.freeze({ kind: 'missing', key });
      });
    },
    membership(operation, values, options = {}) {
      if (header.phase !== 'ready' || !['entry', 'call'].includes(operation) || !Array.isArray(values)
        || values.length < 1 || values.length > 3 || values.some(value => typeof value !== 'string')) {
        throw fail('HISTORY_AGENT_CATALOG_MEMBERSHIP');
      }
      const captured = values.slice();
      return run(options, async (probe, guard) => Object.freeze(await membership(probe, operation, captured, guard)));
    },
    close() {
      if (releasePromise) return releasePromise;
      closed = true; releaseState = 'pending';
      releasePromise = Promise.resolve().then(() => reader.close()).then(result => {
        if (result?.success !== true || result.released !== true || !same(result, header)
          || result.catalogRequestId !== header.catalogRequestId) {
          releaseState = 'unknown'; throw fail('HISTORY_AGENT_CATALOG_RELEASE_UNKNOWN');
        }
        releaseState = 'released'; return result;
      }, error => { releaseState = 'unknown'; throw error; });
      releasePromise.catch(() => {}); return releasePromise;
    },
  });
}

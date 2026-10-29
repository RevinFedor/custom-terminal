import { HistoryRootClient } from './historyRootReadClient.mjs';
import { createDocumentUtf16Digest } from './documentUtf16Digest.mjs';

export const HISTORY_PRIMARY_ADDRESS_PROFILE = 'primary-presentation-address-v1';
const FIELDS = ['kind', 'key', 'rank', 'firstUuid', 'lastUuid', 'entryCount', 'expanded', 'physicalKey'];
const CUT = ['leaseId', 'ownerKey', 'revision', 'generation', 'semanticIdentity', 'metadataIdentity',
  'semanticRevisionToken', 'viewRevisionToken'];
const fail = code => Object.assign(new Error(code), { code });
const small = value => typeof value === 'string' && value.length <= 2048
  && new TextEncoder().encode(value).byteLength <= 4096;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const descriptor = value => value && typeof value === 'object' && value.protocol;
const truth = value => descriptor(value) ? value.kind === 'text' ? value.length > 0 : true : !!value;
const choose = (...values) => values.find(truth) ?? values.at(-1);

// This reader borrows exactly one held parent. A failed/cancelled point demand
// cannot close the panel or its independently forked menu/document consumers.
class AddressProbe extends HistoryRootClient {
  close() { return this.abandon(); }
}

export function historyPrimaryAddressCut(header) {
  return Object.freeze(Object.fromEntries(CUT.map(key => [key, header[key]])));
}
export function historyPrimaryAddressMatchesCut(address, header) {
  return !!address && CUT.every(key => address.cut?.[key] === header?.[key])
    && address.header?.leaseId === header?.leaseId
    && address.header?.revision === header?.revision;
}
export function requireHistoryPrimaryAddressCapability(header) {
  if (header?.presentationAddresses?.profile !== HISTORY_PRIMARY_ADDRESS_PROFILE
    || header.presentationAddresses.maxItems !== 3) throw fail('HISTORY_PRIMARY_ADDRESS_PROFILE_REQUIRED');
}

function captureTool(tool) {
  if (tool == null) return null;
  const result = {};
  if (tool.toolUseId !== undefined) {
    if (typeof tool.toolUseId !== 'string') throw fail('HISTORY_PRIMARY_ADDRESS_TARGET_INVALID');
    result.toolUseId = tool.toolUseId;
  }
  if (tool.messageReference !== undefined) {
    const ref = tool.messageReference;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw fail('HISTORY_PRIMARY_ADDRESS_TARGET_INVALID');
    const copy = {};
    for (const key of ['physicalSessionId', 'sessionId', 'transcriptSegmentId', 'rawUuid']) {
      if (ref[key] !== undefined) {
        if (typeof ref[key] !== 'string') throw fail('HISTORY_PRIMARY_ADDRESS_TARGET_INVALID');
        copy[key] = ref[key];
      }
    }
    result.messageReference = Object.freeze(copy);
  } else if (typeof result.toolUseId !== 'string') throw fail('HISTORY_PRIMARY_ADDRESS_TARGET_INVALID');
  return Object.freeze(result);
}

// A bounded address page, or one active subject, is the only native owner here.
// Long selectors use signed cursors and exact chunk comparison. They never
// decode sourceMetadata, collect visited IDs, or treat a digest as equality.
export async function readHistoryPrimaryPresentationAddresses(model, view, {
  mode = 'range', offset = 0, limit = 3, value = null, tool = null,
  signal, owns = () => true,
} = {}) {
  requireHistoryPrimaryAddressCapability(view.header);
  if (!['range','uuid','target','group','key'].includes(mode) || !integer(offset)
    || !integer(limit) || limit < 1 || limit > 3
    || (mode === 'range' ? value !== null : typeof value !== 'string' || offset !== 0)
    || mode !== 'target' && tool !== null) throw fail('HISTORY_PRIMARY_ADDRESS_QUERY_INVALID');
  tool = captureTool(tool);
  const check = () => {
    if (signal?.aborted || model.closed || owns() !== true) throw fail('HISTORY_READ_CANCELLED');
    view.reader.assertOpen();
  };
  check();
  return model.pull(async () => {
    check();
    const parent = view.reader;
    const invoke = (channel, payload) => channel === parent.pageChannel
      ? model.transport.readHistoryThroughIpc(parent.invoke, channel, payload, { signal })
      : parent.invoke(channel, payload);
    const reader = new AddressProbe(invoke, view.root, {
      pageBytes: parent.pageBytes, pageItems: Math.min(3, parent.pageItems),
      pageChannel: parent.pageChannel, releaseChannel: parent.releaseChannel, forkChannel: parent.forkChannel,
    });
    const query = async options => {
      check();
      const result = await reader.primaryPresentationAddresses(view.root, {
        header: view.header, ...options, signal,
      });
      check(); return result;
    };
    const project = async (node, fields) => {
      const result = Object.create(null);
      if (!descriptor(node) || node.kind !== 'object') return result;
      for (let at = 0; at < fields.length;) {
        check();
        const page = await reader.project(node, fields, { offset: at, limit: Math.min(3, fields.length - at) });
        check();
        if (page.length !== fields.length || page.nextOffset !== at + page.items.length
          || page.nextOffset > fields.length || page.done !== (page.nextOffset === fields.length)
          || page.items.some((item, i) => item.name !== fields[at + i])) throw fail('HISTORY_PRIMARY_ADDRESS_FIELDS');
        for (const item of page.items) result[item.name] = item.value;
        at = page.nextOffset;
      }
      return result;
    };
    const range = async (node, at) => {
      check(); const page = await reader.range(node, { offset: at, limit: Math.min(3, reader.pageItems) }); check();
      if (page.length !== node.length || page.nextOffset !== at + page.items.length
        || page.nextOffset > node.length || page.done !== (page.nextOffset === node.length)
        || page.items.some((item, i) => item.ordinal !== at + i || typeof item.present !== 'boolean')) {
        throw fail('HISTORY_PRIMARY_ADDRESS_RANGE');
      }
      return page;
    };
    const text = async (node, expected) => {
      if (!descriptor(node)) return expected === undefined ? node : node === expected;
      if (node.kind !== 'text') return expected === undefined ? undefined : false;
      if (expected !== undefined && node.length !== expected.length) return false;
      check(); const document = await reader.forkText(node, { signal });
      try {
        check(); const digest = await createDocumentUtf16Digest(); check();
        let at = 0; const parts = expected === undefined ? [] : null;
        while (at < document.length) {
          const part = await document.read(at, Math.min(1024, document.length - at), { signal });
          check();
          if (!part.text.length || part.nextOffset !== at + part.text.length
            || part.nextOffset > document.length) throw fail('HISTORY_PRIMARY_ADDRESS_TEXT_PROGRESS');
          if (expected !== undefined && part.text !== expected.slice(at, part.nextOffset)) return false;
          digest.update(part.text); parts?.push(part.text); at = part.nextOffset;
        }
        if (digest.digest() !== document.digest) throw fail('HISTORY_PRIMARY_DOCUMENT_DIGEST');
        return parts ? parts.join('') : true;
      } finally { await document.close(); }
    };
    const equal = (node, expected) => expected === undefined
      ? Promise.resolve(node === undefined) : text(node, expected);
    const aliasesMatch = async (node, exact) => {
      if (node?.kind !== 'array') return false;
      for (let at = 0; at < node.length;) {
        const page = await range(node, at);
        for (const item of page.items) if (item.present && await equal(item.value, exact)) return true;
        at = page.nextOffset;
      }
      return false;
    };
    const matchesIdentity = async (row, exact) => {
      if (!exact) return false;
      const fields = await project(row, ['uuid', 'sourceIdentity', 'sourceIdentityAliases', 'sourceUuidAliases']);
      return await equal(fields.uuid, exact) || await equal(fields.sourceIdentity, exact)
        || await aliasesMatch(fields.sourceIdentityAliases, exact) || await aliasesMatch(fields.sourceUuidAliases, exact);
    };
    const matchesTarget = async row => {
      if (mode === 'uuid') return equal((await project(row, ['uuid'])).uuid, value);
      const ref = tool?.messageReference;
      if (ref) {
        const fields = await project(row, ['entryRef', 'physicalSessionId', 'sessionId', 'rawUuid', 'uuid', 'transcriptSegmentId']);
        const entryRef = await project(fields.entryRef, ['physicalSessionId', 'rawUuid', 'segmentId']);
        const physical = choose(entryRef.physicalSessionId, fields.physicalSessionId, fields.sessionId);
        const raw = choose(entryRef.rawUuid, fields.rawUuid, fields.uuid);
        if (!await equal(physical, ref.physicalSessionId || ref.sessionId)
          || ref.transcriptSegmentId && !await equal(choose(entryRef.segmentId, fields.transcriptSegmentId), ref.transcriptSegmentId)
          || ref.rawUuid && !await equal(raw, ref.rawUuid)) return false;
        return await matchesIdentity(row, value.trim()) || !!ref.rawUuid
          && await equal(raw, ref.rawUuid) && await equal(physical, ref.physicalSessionId);
      }
      if (tool) {
        const fields = await project(row, ['role', 'actions']);
        if (!await equal(fields.role, 'assistant') || fields.actions?.kind !== 'array') return false;
        for (let at = 0; at < fields.actions.length;) {
          const page = await range(fields.actions, at);
          for (const item of page.items) if (item.present) {
            const action = await project(item.value, ['rawTool']);
            if (await equal((await project(action.rawTool, ['toolUseId'])).toolUseId, tool.toolUseId)) return true;
          }
          at = page.nextOffset;
        }
        return false;
      }
      return matchesIdentity(row, value.trim());
    };
    const decode = async item => {
      const fields = await project(item.header, FIELDS);
      if (fields.rank !== item.rank || !['entry', 'group'].includes(fields.kind)
        || !integer(fields.entryCount)) throw fail('HISTORY_PRIMARY_ADDRESS_HEADER');
      const physicalKey = await text(fields.physicalKey), firstUuid = await text(fields.firstUuid), lastUuid = await text(fields.lastUuid);
      const groupKey = fields.kind === 'group' ? await text(fields.key) : null;
      const entryUuid = item.entry ? await text((await project(item.entry, ['uuid'])).uuid) : firstUuid;
      if (typeof physicalKey !== 'string' || !physicalKey || typeof firstUuid !== 'string'
        || typeof lastUuid !== 'string' || typeof entryUuid !== 'string'
        || fields.kind === 'group' && typeof groupKey !== 'string') throw fail('HISTORY_PRIMARY_ADDRESS_KEY');
      check();
      return Object.freeze({ index: item.rank, header: item.header, sourceEntry: item.entry,
        sourceOrdinal: item.sourceOrdinal, entryUuid, uuid: entryUuid, firstUuid, lastUuid,
        groupKey, physicalKey, kind: fields.kind, entryCount: fields.entryCount, expanded: fields.expanded === true,
        cut: historyPrimaryAddressCut(view.header) });
    };
    try {
      let page;
      const long = ['uuid', 'target', 'key', 'group'].includes(mode) && (!small(value)
        || tool && (!Object.values(tool.messageReference || {}).every(small)
          || tool.toolUseId !== undefined && !small(tool.toolUseId))
        // Short scalars can still expand heavily when JSON escapes NUL or
        // lone surrogates. Leave the framing/descriptor budget untouched and
        // use signed source chunks for this combined literal as well.
        || new TextEncoder().encode(JSON.stringify({value,tool})).byteLength > 32768);
      if (!long) page = await query({ mode, offset, limit, value, tool });
      else if (mode === 'key' || mode === 'group') {
        // No giant selector in IPC. Compare one paged header scalar at a time.
        let selected = null, ambiguous = false;
        for (let at = 0; at < view.header.totalEntries;) {
          const batch = await query({ mode: 'range', offset: at, limit: 3 });
          for (const item of batch.items) {
            const fields = await project(item.header, ['kind', mode === 'key' ? 'physicalKey' : 'key']);
            if ((mode !== 'group' || fields.kind === 'group')
              && await equal(fields[mode === 'key' ? 'physicalKey' : 'key'], value)) {
              if (selected) { ambiguous = true; break; }
              selected = item;
              if (mode === 'group') break;
            }
          }
          if (ambiguous || selected && mode === 'group') break;
          at = batch.nextOffset;
        }
        check();
        return Object.freeze({ status: ambiguous ? 'ambiguous' : selected ? 'found' : 'absent',
          done: true, nextOffset: 0, addresses: Object.freeze(selected && !ambiguous ? [await decode(selected)] : []) });
      } else {
        const source = (await query({ mode: 'scan', limit: 1 })).source;
        let selected = null, ambiguous = false;
        for (let at = 0; at < source.length;) {
          const batch = await range(source, at);
          for (const item of batch.items) if (item.present && await matchesTarget(item.value)) {
            if (selected !== null) { ambiguous = true; break; }
            selected = item.ordinal;
            if (mode === 'uuid' || !tool) break;
          }
          if (ambiguous || selected !== null && (mode === 'uuid' || !tool)) break;
          at = batch.nextOffset;
        }
        if (selected === null || ambiguous) return Object.freeze({ status: ambiguous ? 'ambiguous' : 'absent',
          done: true, nextOffset: 0, addresses: Object.freeze([]) });
        page = await query({ mode: 'source-rank', offset: selected, limit: 1 });
      }
      const addresses = [];
      for (const item of page.items) addresses.push(await decode(item));
      check();
      return Object.freeze({ status: page.status, done: page.done, nextOffset: page.nextOffset,
        addresses: Object.freeze(addresses) });
    } finally { await reader.abandon(); }
  });
}

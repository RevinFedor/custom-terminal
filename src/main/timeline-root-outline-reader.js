'use strict';

// Main-only adapter. The caller supplies its independent retained Timeline
// action lease; this job borrows it, never the viewport or a fresh source file.
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fail = code => Object.assign(new Error(code), { code });
const identityKeys = ['leaseId', 'ownerKey', 'revision', 'generation'];
const same = (a, b) => identityKeys.every(key => a?.[key] === b?.[key]);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const CREDIT = 16384;
const FIELDS = ['uuid', 'type', 'kind', 'timestamp', 'ts', 'sessionId',
  'isCompactSummary', 'isSubAgent', 'isSubAgentTimeout', 'isPlan'];

// Parent-owned reader hook: dispatch outline-item here BEFORE the ordinary
// Timeline query's nodeToken check. The action IPC has only a retained identity,
// not a renderer-owned node token. timelineViewParent authenticates the exact
// session/cwd/tab AND consumer before describing one complete logical row.
// Deliberately includes compact/continued/subagent boundary rows, not just
// eligible prompts: prepareGroupingInput owns the existing predicates/hash.
function readTimelineOutlineItem(plane, state, request, { consumerKey, control } = {}) {
  if (request.kind !== 'timeline-query' || request.operation !== 'outline-item'
    || request.toolType !== 'codex' || typeof request.sessionId !== 'string' || !request.sessionId
    || typeof request.tabId !== 'string' || !request.tabId
    || (request.cwd !== undefined && typeof request.cwd !== 'string')
    || !same(request, request.timelineParentLease)) throw fail('TIMELINE_OUTLINE_SCOPE');
  const check = () => {
    control?.assertCurrent();
    if (plane.state(request, consumerKey) !== state
      || plane.timelineViewParent(request, consumerKey) !== state) throw fail('TIMELINE_OUTLINE_SCOPE');
    if (state.timelinePresentation.closed) throw fail('TIMELINE_VIEW_RELEASED');
    state.timelinePresentation.view.assert();
  };
  check();
  const view = state.timelinePresentation.view, total = view.logical.entries.length;
  const offset = request.offset, credit = request.creditBytes ?? CREDIT;
  if (!integer(offset) || offset > total) throw fail('TIMELINE_OUTLINE_OFFSET');
  if (!integer(credit) || credit < 512 || credit > 65536) throw fail('HISTORY_ROOT_CREDIT');
  const present = offset < total;
  const packet = { success: true, ...plane.identity(state), kind: 'timeline-query', operation: 'outline-item',
    offset, logicalRank: present ? offset : null, nextOffset: offset + Number(present), total,
    done: !present || offset + 1 === total, logicalRevision: view.logical.revision,
    entry: present ? plane.describe(state, view.actualRow(offset), { inline: false }) : null, creditBytesUsed: 0 };
  let previous;
  do { previous = packet.creditBytesUsed; packet.creditBytesUsed = Buffer.byteLength(JSON.stringify(packet)); }
  while (previous !== packet.creditBytesUsed);
  if (packet.creditBytesUsed > credit) throw Object.assign(fail('HISTORY_ROOT_CREDIT_TOO_SMALL'),
    { minimumCreditBytes: packet.creditBytesUsed });
  check(); return packet;
}

async function openTimelineRootOutlineReader(event, payload, bridge) {
  if (!bridge || typeof bridge.run !== 'function') throw fail('HISTORY_ROOT_READER_UNAVAILABLE');
  const sender = event?.sender;
  if (!sender || typeof sender.on !== 'function' || typeof sender.removeListener !== 'function'
    || typeof sender.isDestroyed !== 'function' || sender.isDestroyed()) throw fail('HISTORY_READ_DEMAND_OWNER_INVALID');
  if (payload?.toolType !== 'codex' || typeof payload.sessionId !== 'string' || !payload.sessionId
    || payload.sessionId !== payload.sessionId.trim() || typeof payload.tabId !== 'string' || !payload.tabId
    || (payload.cwd !== undefined && typeof payload.cwd !== 'string')) throw fail('TIMELINE_OUTLINE_SCOPE');
  const { HistoryRootClient, historyRootIdentity, isHistoryRootDescriptor } = await import(
    pathToFileURL(path.join(__dirname, '../shared/history-root-read-client.mjs')).href);
  const identity = historyRootIdentity(payload.timelineParentLease);
  const scope = { toolType: 'codex', sessionId: payload.sessionId, tabId: payload.tabId,
    ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}), readProfile: 'timeline-view-v1' };
  let closed = false, retired = false, client, first, total, logicalRevision, closePromise;
  const retire = () => { retired = true; };
  const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame === true && inPlace === false) retire(); };
  sender.on('destroyed', retire); sender.on('render-process-gone', retire); sender.on('did-start-navigation', navigation);
  const assertCurrent = () => { if (closed || retired || sender.isDestroyed()) throw fail('HISTORY_READ_CANCELLED'); };
  const invoke = async (channel, request) => {
    if (channel === 'agent-transcript:release-read-root') return { success: true };
    assertCurrent();
    const result = await bridge.run(event, request, 'readHistoryRootPage');
    assertCurrent(); return result;
  };
  const query = async offset => {
    const result = await invoke(null, { ...scope, ...identity, timelineParentLease: identity,
      kind: 'timeline-query', operation: 'outline-item', offset, creditBytes: CREDIT });
    if (result?.success !== true) throw fail(result?.code || result?.error || 'TIMELINE_OUTLINE_READ_FAILED');
    if (!same(result, identity) || result.kind !== 'timeline-query' || result.operation !== 'outline-item'
      || result.offset !== offset || !integer(result.total) || offset > result.total
      || result.nextOffset !== offset + Number(offset < result.total)
      || result.done !== (result.nextOffset === result.total)
      || result.logicalRank !== (offset < result.total ? offset : null)
      || typeof result.logicalRevision !== 'string' || !/^[a-f0-9]{64}$/.test(result.logicalRevision)
      || (total !== undefined && (total !== result.total || logicalRevision !== result.logicalRevision))) {
      throw fail('TIMELINE_OUTLINE_PAGE_IDENTITY');
    }
    if (!integer(result.creditBytesUsed) || result.creditBytesUsed > CREDIT
      || Buffer.byteLength(JSON.stringify(result)) !== result.creditBytesUsed) throw fail('HISTORY_ROOT_PAGE_CREDIT');
    if (offset < result.total) {
      if (!isHistoryRootDescriptor(result.entry) || result.entry.kind !== 'object' || !same(result.entry, identity)) {
        throw fail('TIMELINE_OUTLINE_ROW_REQUIRED');
      }
    } else if (result.entry !== null) throw fail('TIMELINE_OUTLINE_ROW_REQUIRED');
    total = result.total; logicalRevision = result.logicalRevision; return result;
  };
  const close = () => {
    if (!closePromise) {
      closed = true;
      sender.removeListener('destroyed', retire); sender.removeListener('render-process-gone', retire);
      sender.removeListener('did-start-navigation', navigation);
      // This local decoder BORROWS the renderer action capability. Abandon
      // never releases that cap (or the unrelated Timeline UI lease). The
      // action caller owns its release in finally, including IPC errors.
      closePromise = client ? client.abandon() : Promise.resolve();
    }
    return closePromise;
  };
  try {
    first = await query(0);
    if (first.entry) client = new HistoryRootClient(invoke, first.entry, { pageBytes: CREDIT, pageItems: 3 });
    const scalar = async node => {
      assertCurrent();
      if (!isHistoryRootDescriptor(node)) return node;
      if (!same(node, identity) || node.kind !== 'text') throw fail('TIMELINE_OUTLINE_FIELD');
      const parts = [], hash = createHash('sha256'); let length = 0;
      for await (const part of client.text(node).chunks()) {
        assertCurrent(); parts.push(part); length += part.length; hash.update(Buffer.from(part, 'utf16le'));
      }
      if (length !== node.length || hash.digest('hex') !== node.digest) throw fail('TIMELINE_OUTLINE_TEXT_DIGEST');
      return parts.join(''); // Explicit BodyOPEN full native prompt sink.
    };
    const project = async (entry, fields) => {
      const selected = {};
      for (let offset = 0; offset < fields.length;) {
        const names = fields.slice(offset, offset + 3);
        const page = await client.project(entry, names, { limit: names.length }); assertCurrent();
        if (!page.done || page.items.length !== names.length || page.nextOffset !== names.length
          || page.items.some((item, i) => item.name !== names[i])) throw fail('TIMELINE_OUTLINE_FIELDS');
        for (const item of page.items) selected[item.name] = await scalar(item.value);
        offset += names.length;
      }
      return selected;
    };
    let read = false;
    return Object.freeze({
      // Signed, authenticated source identity for global one-flight admission.
      sourceKey: JSON.stringify([identity.ownerKey, identity.revision, identity.generation, logicalRevision]),
      assertCurrent,
      async check() { assertCurrent(); await query(total); },
      async readTimeline() {
        assertCurrent(); if (read) throw fail('TIMELINE_OUTLINE_ALREADY_READ'); read = true;
        const entries = []; let packet = first; first = null;
        while (packet.entry) {
          const entry = await project(packet.entry, FIELDS);
          const type = String(entry.type || entry.kind || '').toLowerCase();
          if (type === 'user' && !entry.isCompactSummary && !entry.isSubAgent && !entry.isSubAgentTimeout) {
            const content = await project(packet.entry, ['content']);
            if (typeof content.content === 'string') entry.content = content.content;
            else {
              const full = await project(packet.entry, ['full']);
              if (typeof full.full !== 'string') throw fail('TIMELINE_OUTLINE_FULL_CONTENT_REQUIRED');
              entry.full = full.full;
            }
          }
          entries.push(entry);
          if (packet.done) break;
          packet = await query(packet.nextOffset);
        }
        assertCurrent(); return { success: true, entries }; // BodyOPEN, not a cached Timeline DTO.
      },
      close,
    });
  } catch (error) { await close(); throw error; }
}

module.exports = { openTimelineRootOutlineReader, readTimelineOutlineItem };

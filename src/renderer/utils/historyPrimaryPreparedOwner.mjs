import { HistoryRootClient, HistoryTextDocument, checkedHistoryPrimaryPreparedPresentation } from './historyRootReadClient.mjs';
import { openHistoryAgentCatalog, createHistoryAgentCatalogReader } from '../../shared/history-agent-catalog-client.mjs';
import { historyPrimaryMetadataSubject } from './historyPrimaryMetadataOrigin.mjs';

const failure = code => Object.assign(new Error(code), { code });
// A selected reader is a demand, not the owner of the retained child lease.
class BorrowedPreparedText extends HistoryTextDocument {
  #closed = false;
  async read(offset = 0, limit, options = {}) {
    if (this.#closed) throw failure('HISTORY_READ_CANCELLED');
    const page = await super.read(offset, limit, options);
    if (this.#closed) throw failure('HISTORY_READ_CANCELLED');
    return page;
  }
  close() { this.#closed = true; return Promise.resolve(); }
}
class PreparedProbe extends HistoryRootClient {
  // The retained prepared lease already pins these signed text nodes. Reuse
  // the normal checked text/range/UTF16 document protocol without allocating
  // a child or coupling a cancelled selected demand to its raw release ACK.
  async forkText(node, options = {}) {
    this.assertOpen(options.signal);
    return new BorrowedPreparedText(this, this.text(node).descriptor);
  }
  close() { return this.abandon(); }
}

/** One authenticated prepared cut, shared only through explicit local handles.
 * Model, shown publication and V51 each release their own handle. The weak
 * compatibility witness authenticates ordinals without retaining native Np.
 * No ready-root registry or subsequent owner lookup participates in reads. */
export function createHistoryPrimaryPreparedOwner(capability, transport, {
  receiptDataSubject, compatibilityEntries, readMetadata, readText,
} = {}) {
  checkedHistoryPrimaryPreparedPresentation(capability);
  if (!receiptDataSubject || !Array.isArray(compatibilityEntries) || typeof readMetadata !== 'function'
    || compatibilityEntries.length !== capability.header.sourceEntryCount) {
    throw failure('HISTORY_PRIMARY_PREPARED_OWNER_INVALID');
  }
  const compatibility = new WeakRef(compatibilityEntries);
  const metadataSubject = historyPrimaryMetadataSubject(compatibilityEntries);
  const reader = capability.reader, header = capability.header, root = capability.root;
  let references = 0, retired = false, releasePromise = null, releaseState = 'held';
  // Each existing selected protocol creates its own non-owning probe. Its
  // callers already own the bounded running/pending lane, so this facade must
  // neither add an unbounded promise queue nor cancel a sibling's demand.
  const view = Object.freeze({ header, root, reader, receiptDataSubject });
  const model = Object.freeze({ get closed() { return retired; }, sequence: 0, view, transport,
    pull: operation => { if (retired) throw failure('HISTORY_READ_CANCELLED'); return operation(); },
    getReceiptDataSubject: () => retired ? null : receiptDataSubject });
  const retire = () => {
    if (releasePromise) return releasePromise;
    retired = true;
    releaseState = 'pending';
    // No retries. A thrown or malformed raw release receipt remains UNKNOWN.
    releasePromise = Promise.resolve().then(() => reader.close()).then(result => {
      if (result?.success !== true || result.released !== true
        || result.preparedRequestId !== capability.preparedRequestId
        || ['leaseId', 'ownerKey', 'revision', 'generation'].some(key => result[key] !== header[key])) {
        releaseState = 'unknown'; throw failure('HISTORY_PRIMARY_PREPARED_RELEASE_UNKNOWN');
      }
      releaseState = 'released'; return result;
    }, error => { releaseState = 'unknown'; throw error; });
    releasePromise.catch(() => {});
    return releasePromise;
  };
  const handle = () => {
    if (retired) throw failure('HISTORY_READ_CANCELLED');
    references++;
    let closed = false, closePromise = null;
    const check = ({ signal, owns = () => true } = {}) => {
      if (closed || retired || signal?.aborted || owns() !== true) throw failure('HISTORY_READ_CANCELLED');
      reader.assertOpen();
      if (closed || retired || signal?.aborted) throw failure('HISTORY_READ_CANCELLED');
    };
    return Object.freeze({ kind: 'history-primary-prepared-owner-v1', capability, header, metadataSubject,
      originHeader: capability.originalHeader, model, view,
      get closed() { return closed || retired; },
      get releaseState() { return releaseState; },
      get receiptDataSubject() { return receiptDataSubject; },
      retain(options) { check(options); return handle(); },
      ownsCompatibilityMetadata(entries) { return !closed && !retired && compatibility.deref() === entries; },
      assertCurrent(options) { check(options); },
      async readMetadataOrdinal(ordinal, options = {}) {
        check(options);
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= header.sourceEntryCount) {
          throw failure('HISTORY_PRIMARY_PREPARED_ORDINAL');
        }
        const valid = () => { check(options); return true; };
        const probe = new PreparedProbe((channel, payload) => channel === reader.pageChannel
          ? transport.readHistoryThroughIpc(reader.invoke, channel, payload, { signal: options.signal })
          : reader.invoke(channel, payload), root, { pageBytes: reader.pageBytes, pageItems: reader.pageItems,
          pageChannel: reader.pageChannel, releaseChannel: reader.releaseChannel, forkChannel: reader.forkChannel });
        let primary;
        try {
          const page = await probe.range(header.sourceMetadata, { offset: ordinal, limit: 1 });
          check(options);
          const item = page.items[0];
          if (page.length !== header.sourceEntryCount || page.items.length !== 1 || item?.ordinal !== ordinal
            || item.present !== true || item.value?.kind !== 'object' || page.nextOffset !== ordinal + 1
            || page.done !== (ordinal + 1 === header.sourceEntryCount)) throw failure('HISTORY_PRIMARY_PREPARED_ORDINAL');
          const row = await readMetadata(probe, item.value, { signal: options.signal, owns: valid });
          check(options); return row;
        } catch (error) { primary = error; throw error; }
        finally { await probe.abandon(); if (!primary) check(options); }
      },
      async openAgentCatalog(current, options = {}) {
        check(options);
        if (!current || !Array.isArray(current.values) || typeof current.drive !== 'function'
          || typeof readText !== 'function') throw failure('HISTORY_AGENT_CATALOG_CURRENT');
        const valid = () => { check(options); return true; };
        let opened, transferred = false;
        try {
          opened = await openHistoryAgentCatalog(capability, current.wire,
            { signal: options.signal, owns: valid, transport });
          check(options);
          // One retained child and one caller demand. Every coroutine advance
          // remains under the original signal and owner; no deadline/retry.
          const stage = Object.freeze({
            get header() { return opened.header; },
            advance(value) { check(options); return opened.advance({ value },
              { signal: options.signal, owns: valid }); },
            readValue(node) { check(options); return createHistoryAgentCatalogReader(opened,
              { nativeValues: current.values, readText }).readValue(node,
                { signal: options.signal, owns: valid }); },
            readRecord(node) { check(options); return createHistoryAgentCatalogReader(opened,
              { nativeValues: current.values, readText }).readRecord(node,
                { signal: options.signal, owns: valid }); },
          });
          await current.drive(stage, { signal: options.signal, owns: valid });
          check(options);
          if (opened.header.phase !== 'ready') throw failure('HISTORY_AGENT_CATALOG_NOT_READY');
          const selected = createHistoryAgentCatalogReader(opened, { nativeValues: current.values, readText });
          transferred = true; return selected;
        } finally {
          // A cancelled UI lane must not wait for an UNKNOWN release ACK.
          if (opened && !transferred) void opened.reader.close().catch(() => {});
        }
      },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        references--;
        closePromise = references === 0 ? retire() : Promise.resolve({ success: true, retained: true });
        return closePromise;
      },
      retirement() { return releasePromise || Promise.resolve({ status: releaseState }); },
    });
  };
  return handle();
}

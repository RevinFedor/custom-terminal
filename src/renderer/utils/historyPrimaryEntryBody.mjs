import { createDocumentUtf16Digest } from './documentUtf16Digest.mjs';
// Explicit selected-unit sink. The identity table is ONLY this one full unit,
// discarded after decoding, never an N-history map/cache or native bound claim.
const fail = code => Object.assign(new Error(code), { code });
export async function readHistoryPrimaryEntryBody(reader, { signal, owns = () => true } = {}) {
  const current = () => { if (signal?.aborted || !owns()) throw fail('HISTORY_READ_CANCELLED'); reader.assertOpen(signal); };
  const decoded = new Map(), pending = [];
  const value = async node => {
    current();
    if (!node || typeof node !== 'object' || !node.protocol) return node;
    if (decoded.has(node.nodeToken)) return decoded.get(node.nodeToken);
    if (node.kind === 'text') {
      const hash = await createDocumentUtf16Digest(); current();
      let result = '';
      // The independent body lease already pins this leaf. No extra text pin.
      for await (const part of reader.text(node).chunks({ signal })) { current(); hash.update(part); result += part; }
      if (result.length !== node.length || hash.digest() !== node.digest) throw fail('HISTORY_PRIMARY_DOCUMENT_DIGEST');
      return result;
    }
    if (!['array','object','map','set'].includes(node.kind)) throw fail('HISTORY_BODY_KIND');
    if (node.kind === 'array' && (!Number.isSafeInteger(node.length) || node.length < 0 || node.length > 0xffffffff)) throw fail('HISTORY_BODY_ARRAY_LENGTH');
    const result = node.kind === 'array' ? new Array(node.length) : node.kind === 'map' ? new Map()
      : node.kind === 'set' ? new Set() : {};
    decoded.set(node.nodeToken, result); pending.push({ node, result }); return result;
  };
  let primary;
  try {
    const result = await value(reader.root);
    while (pending.length) {
      const frame = pending.pop(), kind = frame.node.kind;
      // V8 drops inherited prototypes and custom Map/Set own properties.
      // Arrays preserve both sparse indices and enumerable extra properties.
      const phases = kind === 'array' ? ['body-items','fields'] : ['map','set'].includes(kind) ? ['body-pairs'] : ['fields'];
      for (const phase of phases) {
        let offset = 0, lastOrdinal = -1;
        for (;;) {
          current();
          const page = await reader.page(frame.node, phase, { offset, signal }); current();
          for (const item of page.items) {
            if (phase === 'body-items') {
              if (item.ordinal <= lastOrdinal) throw fail('HISTORY_ROOT_PAGE_ORDINAL');
              lastOrdinal = item.ordinal;
            }
            if (phase === 'body-pairs') {
              const key = await value(item.key);
              if (kind === 'map') frame.result.set(key, await value(item.value)); else frame.result.add(key);
            } else {
              const key = phase === 'body-items' ? String(item.ordinal) : await value(item.name);
              if (typeof key !== 'string') throw fail('HISTORY_BODY_FIELD');
              Object.defineProperty(frame.result, key, { value: await value(item.value), enumerable: true, writable: true, configurable: true });
            }
          }
          if (page.done) break;
          if (page.nextOffset <= offset) throw fail('HISTORY_BODY_PROGRESS');
          offset = page.nextOffset;
        }
      }
    }
    current(); return result;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    decoded.clear(); pending.length = 0;
    try { await reader.close(); }
    catch (error) {
      if (!primary) throw error;
      try { console.warn('[HistoryPrimary] body-borrow-release-failed code=' + String(error?.code || 'UNKNOWN')); } catch {}
    }
    // The child has closed; only the caller/signal fence can be checked here.
    // A new view during release must not receive this old unit as current.
    if (!primary && (signal?.aborted || !owns())) throw fail('HISTORY_READ_CANCELLED');
  }
}

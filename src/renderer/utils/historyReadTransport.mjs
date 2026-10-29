import { HistoryRootClient, historyRootIdentity, isHistoryRootDescriptor, checkedHistoryRootOpenHeader } from './historyRootReadClient.mjs';
// Desktop-only, negotiated IPC encoding. Public HTTP/MCP and older main
// processes keep their ordinary object responses. Main forwards the bytes
// without deserializing/re-serializing the complete positional row index.
import { currentUIActionId, uiPerformancePhase } from './uiPerformanceDiagnostics.mjs';
let readSequence = 0;
// WebContents can survive a renderer reload; its new module must not reuse a
// prior request ID merely because wall-clock time or the local counter repeats.
const readBoot = globalThis.crypto?.randomUUID?.()
  || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let codec;
function decoder() {
  if (typeof window === 'undefined' || typeof window.require !== 'function') return null;
  if (codec) return codec;
  try {
    const { deserialize } = window.require('node:v8');
    const { Buffer } = window.require('node:buffer');
    if (typeof deserialize !== 'function' || typeof Buffer?.from !== 'function') return null;
    codec = data => deserialize(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return codec;
  } catch { return null; }
}

export function historyReadAbortError() {
  const error = new Error('History read consumer released');
  error.name = 'AbortError';
  error.code = 'HISTORY_READ_CANCELLED';
  return error;
}

// A demand identifies a read consumer, never an input/Send operation. It is
// scoped again to event.sender by Main. AbortSignal must stay in this renderer;
// Electron cannot structured-clone its cancellation semantics.
export async function readHistoryThroughIpc(invoke, channel, payload, { signal } = {}) {
  const id = 'hr-' + readBoot + '-' + (++readSequence).toString(36);
  const start = performance.now();
  const diagnosticActionId = currentUIActionId();
  const decode = payload?.readTransport !== 'root-v1' && payload?.toolType === 'codex'
    && ['agent-transcript:get-history', 'agent-transcript:get-timeline'].includes(channel) ? decoder() : null;
  uiPerformancePhase('history-ipc-start', { tab: payload?.tabId });
  let issued = false, settled = false, cancelSent = false, rejectAbort;
  const aborted = signal ? new Promise((_resolve, reject) => { rejectAbort = reject; }) : null;
  // A synchronous invoke adapter may abort and then throw before Promise.race.
  // Observe that rejection even in this admission-failure path.
  aborted?.catch(() => {});
  // Install before invoke, but send cancellation only AFTER admission was
  // issued. This also covers a synchronous abort inside an invoke adapter.
  const onAbort = () => {
    if (settled) return;
    if (issued && !cancelSent) {
      cancelSent = true;
      try {
        Promise.resolve(invoke('agent-transcript:cancel-read', { readDemandId: id }))
          .catch(() => { /* A lost cancel ACK is not a source invalidation or retry authority. */ });
      } catch { /* The local consumer still releases; Main may already be gone. */ }
    }
    rejectAbort?.(historyReadAbortError());
  };
  try {
    if (signal?.aborted) throw historyReadAbortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    const pending = invoke(channel, { ...payload, readDemandId: id, diagnosticReadId: id, diagnosticActionId,
      ...(decode ? { readTransport: 'v8-1' } : {}) });
    issued = true;
    if (signal?.aborted) onAbort();
    const result = await (aborted ? Promise.race([pending, aborted]) : pending);
    // A response can win the Promise race before this continuation runs.
    // Do not materialize a V8 DTO for a consumer which has already left.
    if (signal?.aborted) throw historyReadAbortError();
    const receivedAt = performance.now();
    // Object IPC has no measured byte count. In particular a root header is
    // neither a full DTO nor evidence that its referenced bodies cost zero.
    let decoded = result, bytes = null;
    if (result?.__notedHistoryTransport === 'v8-1') {
      if (!decode || !ArrayBuffer.isView(result.data)) throw new Error('Invalid History IPC encoding');
      bytes = result.data.byteLength;
      decoded = decode(result.data);
    }
    const end = performance.now();
    if (end - start >= 50 || end - receivedAt >= 8 || decoded?.success === false) {
      console.warn('[Perf:HistoryTransport] ' + JSON.stringify({ id, actionId: diagnosticActionId,
        channel, tab: String(payload?.tabId || '').slice(-12), session: String(payload?.sessionId || '').slice(0, 8),
        startAbs: performance.timeOrigin + start, endAbs: performance.timeOrigin + end,
        ipcMs: +(receivedAt - start).toFixed(1), decodeMs: +(end - receivedAt).toFixed(1), bytes,
        rows: decoded?.__notedHistoryTransport==='root-v1' ? decoded.totalEntries ?? null
          : decoded?.entries?.length ?? decoded?.order?.length ?? null,
        shape: decoded?.__notedHistoryTransport==='root-v1' ? 'root'
          : decoded?.unchanged ? 'unchanged' : decoded?.delta ? 'delta' : decoded?.rewriteDelta ? 'rewrite' : 'full',
        success: decoded?.success !== false }));
    }
    uiPerformancePhase('history-ipc-decoded', { ms: end - start, decodeMs: end - receivedAt, bytes });
    return decoded;
  } catch (error) {
    console.warn('[Perf:HistoryTransport] ' + JSON.stringify({ id, actionId: diagnosticActionId, channel,
      status: 'failed', elapsedMs: +(performance.now() - start).toFixed(1), error: error?.code || error?.name || 'Error' }));
    throw error;
  } finally {
    settled = true;
    signal?.removeEventListener('abort', onAbort);
  }
}


// A cursor caller negotiates a different return contract deliberately. An old
// process can still return its complete positional object; it is labelled
// legacy and never captured into a new paged store or described as bounded.
// Callers with a legacy UI use that explicit branch. Cursor-only sinks can
// retain the old path as a visible capability fallback at their own boundary.
export function checkedHistoryDependencySupersession(result, request) {
  const invalid = () => { throw Object.assign(new Error('HISTORY_PRIMARY_DEPENDENCY_PROTOCOL'),{code:'HISTORY_PRIMARY_DEPENDENCY_PROTOCOL'}); };
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const exact = (value,keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!exact(result,['success','__notedHistoryTransport','outcome','domain','requiredClass','generation','ownerKey','scope','witness'])
    || result.success !== false || result.__notedHistoryTransport !== 'primary-dependency-v1'
    || result.outcome !== 'superseded-dependency' || !['prompt','timing'].includes(result.domain)
    || result.requiredClass !== 'source' || !sha(result.ownerKey)
    || typeof result.generation !== 'string' || !result.generation || result.generation.length > 2048
    || !exact(result.scope,['readDemandId','toolType','sessionId','cwd','tabId'])
    || !exact(result.witness,['mode','before','after']) || result.witness.mode !== 'scoped'
    || !sha(result.witness.before) || !sha(result.witness.after) || result.witness.before === result.witness.after) invalid();
  const expected = {readDemandId:request?.readDemandId,toolType:request?.toolType,
    sessionId:request?.sessionId,cwd:request?.cwd ?? '',tabId:request?.tabId ?? ''};
  if (expected.toolType !== 'codex' || typeof expected.readDemandId !== 'string' || !expected.readDemandId
    || !Object.keys(expected).every(key=>typeof expected[key] === 'string' && result.scope[key] === expected[key])) invalid();
  return Object.freeze({...result,scope:Object.freeze({...result.scope}),witness:Object.freeze({...result.witness})});
}
export async function openHistoryRootThroughIpc(invoke, channel, payload, options = {}) {
  const { signal } = options;
  let releasedLate = false, observedResult, admittedRequest;
  const discard = result => {
    if (releasedLate || !result) return;
    try {
      // The admission receipt identifies the newly installed lease even when
      // the nested descriptor/header is malformed. Never release sessionMeta,
      // another old reader, or more than one candidate on a corrupt response.
      let identity;
      try { identity = historyRootIdentity(result); }
      catch {
        // Older malformed peers may only return a descriptor. A complete
        // identity is still required; partial identities are never guessed.
        identity = historyRootIdentity(result.root || result.payloadDocument);
      }
      releasedLate = true;
      Promise.resolve(invoke('agent-transcript:release-read-root', identity)).catch(() => {});
    } catch { /* Cleanup must preserve the primary abort/protocol error. */ }
  };
  const guardedInvoke = (method, request) => {
    if (method === channel) admittedRequest = request;
    const pending = invoke(method, request);
    if (method !== channel) return pending;
    return Promise.resolve(pending).then(result => {
      observedResult = result;
      if (signal?.aborted) discard(result);
      return result;
    });
  };
  let result;
  try {
    result = await readHistoryThroughIpc(guardedInvoke, channel,
      { ...payload, readTransport: 'root-v1' }, { signal });
  } catch (error) {
    // Abort can occur between the adapter's fulfillment and the transport's
    // post-race continuation. That root was admitted but never delivered.
    discard(observedResult); throw error;
  }
  if (signal?.aborted) { discard(result); throw historyReadAbortError(); }
  if (result?.__notedHistoryTransport === 'primary-dependency-v1') {
    return {kind:'superseded-dependency',result:checkedHistoryDependencySupersession(result,admittedRequest)};
  }
  if (result?.__notedHistoryTransport !== 'root-v1') {
    // Legacy DTOs have no root protocol marker/capability. Loss or mutation of
    // a root marker must not turn a corrupted admission into a legacy success.
    if (result && ['__notedHistoryTransport', 'root', 'payloadDocument', 'leaseId']
      .some(key => Object.prototype.hasOwnProperty.call(result, key))) {
      discard(result);
      throw Object.assign(new Error('HISTORY_ROOT_OPEN_HEADER_INVALID'), { code: 'HISTORY_ROOT_OPEN_HEADER_INVALID' });
    }
    return { kind: 'legacy', result };
  }
  let reader, header;
  try {
    header = checkedHistoryRootOpenHeader(result, payload);
    reader = new HistoryRootClient(invoke, header.root || header.payloadDocument, options);
    if (signal?.aborted) throw historyReadAbortError();
  }
  catch (error) {
    if (reader) void reader.close().catch(() => {}); else discard(result);
    throw error;
  }
  // metadata remains an alias for existing callers, but carries only the
  // validated root-v1 header, never the peer's arbitrary metadata/body DTO.
  return { kind: 'root', reader, root: reader.root, header, metadata: header };
}


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
  const decode = payload?.toolType === 'codex'
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
    let decoded = result, bytes = 0;
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
        rows: decoded?.entries?.length ?? decoded?.order?.length ?? null,
        shape: decoded?.unchanged ? 'unchanged' : decoded?.delta ? 'delta' : decoded?.rewriteDelta ? 'rewrite' : 'full',
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


// Desktop-only, negotiated IPC encoding. Public HTTP/MCP and older main
// processes keep their ordinary object responses. Main forwards the bytes
// without deserializing/re-serializing the complete positional row index.
import { currentUIActionId, uiPerformancePhase } from './uiPerformanceDiagnostics.mjs';
let readSequence = 0;
const readBoot = Date.now().toString(36);
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

export async function readHistoryThroughIpc(invoke, channel, payload) {
  const id = 'hr-' + readBoot + '-' + (++readSequence).toString(36);
  const start = performance.now();
  const diagnosticActionId = currentUIActionId();
  const decode = payload?.toolType === 'codex'
    && ['agent-transcript:get-history', 'agent-transcript:get-timeline'].includes(channel) ? decoder() : null;
  uiPerformancePhase('history-ipc-start', { tab: payload?.tabId });
  try {
    const result = await invoke(channel, { ...payload, diagnosticReadId: id, diagnosticActionId,
      ...(decode ? { readTransport: 'v8-1' } : {}) });
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
  }
}

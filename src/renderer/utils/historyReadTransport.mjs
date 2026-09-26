// Desktop-only, negotiated IPC encoding. Public HTTP/MCP and older main
// processes keep their ordinary object responses. Main forwards the bytes
// without deserializing/re-serializing the complete positional row index.
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
  const decode = payload?.toolType === 'codex'
    && ['agent-transcript:get-history', 'agent-transcript:get-timeline'].includes(channel) ? decoder() : null;
  const result = await invoke(channel, decode ? { ...payload, readTransport: 'v8-1' } : payload);
  if (result?.__notedHistoryTransport !== 'v8-1') return result;
  if (!decode || !ArrayBuffer.isView(result.data)) throw new Error('Invalid History IPC encoding');
  return decode(result.data);
}

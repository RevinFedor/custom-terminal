// NDJSON history stream consumer.
//
// Architecture (read top-to-bottom):
//   fetch(url, { Accept: application/x-ndjson })
//     → response.body : ReadableStream<Uint8Array>
//     → getReader().read() loop  (NOT for-await — Safari 26.x still ships
//        without async-iterable Response bodies; manual loop is the safe form,
//        see https://github.com/i-am-bee/ACP/issues/231)
//     → TextDecoder('utf-8') with `stream: true` (keeps multi-byte chars
//        across chunk boundaries)
//     → newline split with carry-over remainder
//     → JSON.parse per line → emit to caller
//
// Why not @streamparser/json: NDJSON is one JSON per `\n`, no nesting state,
// no need for a JSON-path parser. A 50-line hand-roll is faster, smaller, and
// doesn't pull a dependency for what is effectively `line.split('\n')`.
//
// The caller decides when to flush React state — we just deliver records.
// Batching happens at the consumer (every N records or every animation frame)
// so React doesn't re-render once per message at line-of-sight speeds.

export type StreamMeta = {
  type: 'meta';
  total: number;
  returned: number;
  truncated: boolean;
  dropped: number;
  sessionId?: string;
  etag: string;
  lastUuid: string | null;
  // First uuid in the returned slice — used by phase-2 cold open to ask for
  // the prefix via `?before=<firstUuid>` after the tail paint completes.
  firstUuid: string | null;
};

export type StreamDone = { type: 'done'; written: number };
export type StreamMessage = any; // SDK shape — opaque to the stream layer

export type StreamHandlers = {
  onMeta: (meta: StreamMeta) => void;
  onMessage: (msg: StreamMessage, indexFromStart: number) => void;
  onDone: (done: StreamDone, bytesRead: number) => void;
  onError: (err: Error, bytesRead: number) => void;
};

export type StreamHandle = {
  abort: () => void;
  // Resolves when stream finished (success or error). Useful for await callers.
  finished: Promise<void>;
};

export function streamHistory(
  url: string,
  token: string,
  handlers: StreamHandlers,
): StreamHandle {
  const ac = new AbortController();
  let bytesRead = 0;
  let cancelled = false;
  // Idle watchdog — if no bytes arrive for IDLE_MS we abort with an error.
  // Without this an Electron crash mid-stream leaves the phone with a forever
  // "loading…" spinner and no signal. 30s is generous enough for slow WiFi
  // pauses but tight enough to fail fast when the server actually died.
  const IDLE_MS = 30_000;
  let idleTimer: any = null;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      try { ac.abort(); } catch {}
      handlers.onError(new Error('Stream idle timeout (' + (IDLE_MS / 1000) + 's no bytes)'), bytesRead);
    }, IDLE_MS);
  };

  const finished = (async () => {
    try {
      armIdleTimer();
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/x-ndjson',
          'Authorization': 'Bearer ' + token,
          // Brotli first — we want the small bytes on the wire. Server falls
          // back to gzip or plain if br not supported (older Node), but Node
          // 18+ always has br.
          'Accept-Encoding': 'br, gzip',
        },
        signal: ac.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      if (!resp.body) throw new Error('No response body');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let carry = '';
      let msgIndex = 0;

      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdleTimer(); // re-arm on every chunk
        bytesRead += value.byteLength;
        // stream: true keeps the decoder mid-codepoint state across chunks —
        // a 4-byte UTF-8 emoji split across two TCP packets won't break.
        const text = decoder.decode(value, { stream: true });
        const merged = carry + text;
        const lines = merged.split('\n');
        carry = lines.pop() ?? ''; // last fragment is incomplete (or empty if ended on \n)

        for (const line of lines) {
          if (!line) continue;
          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch (e) {
            // A malformed line means we lost framing — bail rather than skip
            // silently. Server bug, not data bug.
            throw new Error('NDJSON parse error: ' + (e as Error).message);
          }
          if (obj && obj.type === 'meta') {
            handlers.onMeta(obj as StreamMeta);
          } else if (obj && obj.type === 'done') {
            handlers.onDone(obj as StreamDone, bytesRead);
            return;
          } else {
            handlers.onMessage(obj, msgIndex);
            msgIndex += 1;
          }
        }
      }
      // Drain trailing line if present (no final newline).
      if (carry && !cancelled) {
        try {
          const obj = JSON.parse(carry);
          if (obj?.type === 'done') handlers.onDone(obj, bytesRead);
          else if (obj?.type === 'meta') handlers.onMeta(obj);
          else handlers.onMessage(obj, -1);
        } catch {}
      }
    } catch (e: any) {
      if (cancelled) return;
      handlers.onError(e instanceof Error ? e : new Error(String(e)), bytesRead);
    } finally {
      clearTimeout(idleTimer);
    }
  })();

  return {
    abort: () => { cancelled = true; clearTimeout(idleTimer); ac.abort(); },
    finished,
  };
}

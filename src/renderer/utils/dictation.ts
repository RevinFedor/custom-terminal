// Soniox real-time dictation engine.
//
// Architecture (instant-record, then catch-up):
//
//   click → DictationSession.start()
//      ↓ (parallel)
//   ┌──────────────────────┐   ┌──────────────────────────────────────┐
//   │ getUserMedia          │   │ fetchToken → new WebSocket → onopen  │
//   │ AudioContext           │   │                                       │
//   │ ScriptProcessorNode    │   │  (300-700ms cold start)               │
//   │ register onaudioprocess│   │                                       │
//   │ → buffer PCM chunks    │   │                                       │
//   │   to memory queue      │   │                                       │
//   └──────────────────────┘   └──────────────────────────────────────┘
//                                            ↓ onopen
//                              flush queue (catch up frames captured during
//                              token+ws handshake) → switch processor to
//                              direct ws.send mode.
//
// This means audio is captured from frame 1 — the user can speak before the
// socket is open and no syllables are lost.
//
// UI lifecycle:
//   onConnected — called on ws.onopen, after queue flush. UI can flip its
//                 indicator from "buffering locally" to "live to server" if it
//                 wants to surface that, but the user's experience is the
//                 same in both phases.
//   onUpdate    — fired on every server frame ({final, partial} accumulated
//                 transcript).
//   onStopped   — terminal state (graceful close or error). UI returns to idle.
//   onError     — non-fatal error info (token fetch, mic permission, soniox
//                 error_code, socket error). Caller decides what to surface.
//
// dlog → logs/dev.log via main process. console.* in renderer doesn't reach
// the file (see CLAUDE.md "Логирование").

function dlog(msg: string) {
  try {
    (window as any).require?.('electron')?.ipcRenderer?.send('log:renderer', '[Dictation] ' + msg);
  } catch {}
}

export interface DictationUpdate {
  final: string;
  partial: string;
}

export interface DictationOptions {
  fetchToken: () => Promise<string>;
  onUpdate: (u: DictationUpdate) => void;
  onError: (msg: string) => void;
  onStopped?: () => void;
  onConnected?: () => void;
  languageHints?: string[];
  model?: string;
}

function downsampleFloat32(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate === inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function floatToS16LE(buf: Float32Array): ArrayBuffer {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    let s = buf[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out.buffer;
}

const TARGET_RATE = 16000;

export class DictationSession {
  private ws: WebSocket | null = null;
  private ac: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  // PCM chunks captured between getUserMedia-ready and ws.open. Flushed on
  // onopen; bounded by maxPending so a slow socket can't OOM. ~50 chunks ≈
  // 4.2 s of audio at default buffer, far more than the typical 0.5 s lag.
  private pending: ArrayBuffer[] = [];
  private maxPending = 200;
  private wsOpen = false;
  private finalText = '';
  private partialText = '';
  private opts: DictationOptions;
  private stopped = false;
  private stoppedFired = false;
  private forceStopTimer: any = null;
  private acRate = 48000;

  constructor(opts: DictationOptions) {
    this.opts = opts;
  }

  private fireStopped() {
    if (this.stoppedFired) return;
    this.stoppedFired = true;
    if (this.forceStopTimer) { clearTimeout(this.forceStopTimer); this.forceStopTimer = null; }
    try { this.opts.onStopped?.(); } catch {}
  }

  async start(): Promise<void> {
    dlog('start() begin');

    // ─── PHASE 1: audio capture (acquire mic + AudioContext SYNCHRONOUSLY-ish) ───
    // Runs first, in parallel with the token fetch. As soon as the processor
    // is wired into the graph, every audio frame gets pushed into `pending`
    // so we don't lose the user's first word while we wait for the WebSocket.
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      dlog('mic ok tracks=' + this.stream.getTracks().length);
    } catch (e: any) {
      dlog('mic error: ' + (e?.name || '') + ' ' + (e?.message || String(e)));
      this.opts.onError('mic: ' + (e?.message || String(e)));
      this.fireStopped();
      return;
    }

    try {
      this.ac = new AudioContext();
      this.acRate = this.ac.sampleRate;
      if (this.ac.state === 'suspended') {
        try { await this.ac.resume(); } catch {}
      }
      this.source = this.ac.createMediaStreamSource(this.stream);
      this.processor = this.ac.createScriptProcessor(4096, 1, 1);
      this.source.connect(this.processor);
      const sink = this.ac.createGain();
      sink.gain.value = 0;
      this.processor.connect(sink).connect(this.ac.destination);
      dlog('audio ok rate=' + this.acRate);

      // Wire the capture handler IMMEDIATELY. Frames will go to `pending`
      // until ws.onopen flips wsOpen=true.
      this.processor.onaudioprocess = (ev) => {
        const ch0 = ev.inputBuffer.getChannelData(0);
        const down = downsampleFloat32(ch0, this.acRate, TARGET_RATE);
        const pcm = floatToS16LE(down);
        if (this.wsOpen && this.ws && this.ws.readyState === WebSocket.OPEN) {
          try { this.ws.send(pcm); } catch {}
        } else if (this.pending.length < this.maxPending) {
          this.pending.push(pcm);
        }
        // Else: queue overflow → drop oldest-first behavior would be more
        // correct, but in practice this only triggers if ws hangs >4s; the
        // user will hit Stop long before that.
      };
    } catch (e: any) {
      dlog('audio error: ' + (e?.name || '') + ' ' + (e?.message || String(e)));
      this.opts.onError('audio: ' + (e?.message || String(e)));
      await this.cleanup();
      this.fireStopped();
      return;
    }

    // ─── PHASE 2: mint token + open ws (in parallel with capture). ───
    let apiKey: string;
    try {
      apiKey = await this.opts.fetchToken();
      dlog('token ok len=' + apiKey.length);
    } catch (e: any) {
      dlog('token error: ' + (e?.message || String(e)));
      this.opts.onError('token: ' + (e?.message || String(e)));
      await this.cleanup();
      this.fireStopped();
      return;
    }

    if (this.stopped) {
      dlog('start() aborted (stopped during token fetch)');
      await this.cleanup();
      this.fireStopped();
      return;
    }

    dlog('opening ws');
    this.ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      dlog('ws.onopen, flushing ' + this.pending.length + ' buffered frames');
      try {
        // Config message first.
        this.ws!.send(JSON.stringify({
          api_key: apiKey,
          model: this.opts.model || 'stt-rt-v4',
          audio_format: 's16le',
          sample_rate: TARGET_RATE,
          num_channels: 1,
          language_hints: this.opts.languageHints || ['en', 'ru'],
          enable_endpoint_detection: true,
        }));
        // Flush queued PCM frames captured during the cold-start gap.
        for (const buf of this.pending) {
          try { this.ws!.send(buf); } catch {}
        }
      } catch (e: any) {
        dlog('onopen flush failed: ' + (e?.message || e));
      }
      this.pending = [];
      this.wsOpen = true;
      try { this.opts.onConnected?.(); } catch {}
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.error_code) {
        this.opts.onError(`soniox ${msg.error_code}: ${msg.error_message || ''}`);
        return;
      }
      if (Array.isArray(msg.tokens)) {
        let newFinal = '';
        let newPartial = '';
        for (const t of msg.tokens) {
          if (!t || typeof t.text !== 'string') continue;
          // Soniox sends synthetic markers like "<end>" (endpoint detection)
          // and "<fin>" (finalization) interleaved with real word tokens.
          // They're for clients building speaker-turn logic; we just want the
          // spoken words. Strip anything matching <…>.
          if (/^<[a-z_]+>$/i.test(t.text)) continue;
          if (t.is_final) newFinal += t.text;
          else newPartial += t.text;
        }
        if (newFinal) this.finalText += newFinal;
        this.partialText = newPartial;
        this.opts.onUpdate({ final: this.finalText, partial: this.partialText });
      }
    };

    this.ws.onerror = () => {
      dlog('socket error');
      this.opts.onError('socket error');
    };

    this.ws.onclose = async (e) => {
      dlog('ws.onclose code=' + e.code + ' reason=' + e.reason + ' wasClean=' + e.wasClean);
      this.wsOpen = false;
      await this.cleanup();
      this.fireStopped();
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      dlog('stop() called while already stopping → forcing cleanup');
      await this.cleanup();
      this.fireStopped();
      return;
    }
    this.stopped = true;
    dlog('stop() called, ws.readyState=' + (this.ws?.readyState ?? 'null'));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Tell Soniox we're done — it'll send remaining finals then close.
      try { this.ws.send(new ArrayBuffer(0)); } catch (e: any) { dlog('flush failed: ' + (e?.message || e)); }
      // Safety net for hung connections.
      this.forceStopTimer = setTimeout(async () => {
        dlog('onclose timeout → force cleanup');
        try { this.ws?.close(); } catch {}
        await this.cleanup();
        this.fireStopped();
      }, 3000);
    } else {
      // Socket never opened (CONNECTING / null). Detach handlers BEFORE
      // .close() so the async onerror/onclose firing on a half-opened
      // socket doesn't bubble back as a "socket error" toast.
      if (this.ws) {
        try { this.ws.onopen = null; this.ws.onmessage = null; this.ws.onerror = null; this.ws.onclose = null; } catch {}
        try { this.ws.close(); } catch {}
      }
      await this.cleanup();
      this.fireStopped();
    }
  }

  /** Full transcript captured so far (final + partial tail). */
  getText(): string { return this.finalText + this.partialText; }

  private async cleanup(): Promise<void> {
    try { if (this.processor) this.processor.onaudioprocess = null as any; } catch {}
    try { this.processor?.disconnect(); } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { await this.ac?.close(); } catch {}
    this.ws = null;
    this.ac = null;
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.pending = [];
  }
}

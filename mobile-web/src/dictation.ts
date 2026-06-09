// Soniox real-time dictation engine for mobile-web (mirror of
// src/renderer/utils/dictation.ts — same logic, kept as a separate file
// because mobile-web and the Electron renderer are two independent Vite
// builds. See fact-mobile-web.md).
//
// Capture: AudioWorklet preferred (runs off the JS main thread, avoiding the
// deprecated-ScriptProcessorNode SIGSEGV class on macOS Electron — see
// fix-mic-renderer-sigsegv.md), with a ScriptProcessorNode fallback for old
// iOS Safari builds that refuse the blob:URL worklet load. Both paths route
// PCM through sendFrame; the slight extra SPN latency is imperceptible.

export interface DictationUpdate {
  final: string;
  partial: string;
}

export interface DictationOptions {
  fetchToken: () => Promise<string>;
  onUpdate: (u: DictationUpdate) => void;
  onError: (msg: string) => void;
  onStopped?: () => void;
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

// AudioWorklet capture processor (mirror of src/renderer/utils/dictation.ts).
// Preferred over ScriptProcessorNode because the worklet runs on the audio
// render thread rather than the JS main thread — the deprecated SPN
// intermittently SIGSEGVs the host renderer on macOS Electron (see
// fix-mic-renderer-sigsegv.md). On the desktop Electron renderer the worklet
// always loads (CSP allows blob:). On mobile some old iOS Safari builds refuse
// the blob:URL worklet — there we fall back to SPN, so there is no regression.
// The processor batches to 4096 samples to match the SPN ws.send cadence.
const WORKLET_BATCH = 4096;
const WORKLET_SRC = `
const BATCH = ${WORKLET_BATCH};
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._buf = new Float32Array(BATCH); this._n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n === BATCH) {
          this.port.postMessage(this._buf.slice(0));
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

export class DictationSession {
  private ws: WebSocket | null = null;
  private ac: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletURL: string | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private muteSink: MediaStreamAudioDestinationNode | null = null;
  private stream: MediaStream | null = null;
  private finalText = '';
  private partialText = '';
  private opts: DictationOptions;
  private stopped = false;
  private acRate = 48000;

  constructor(opts: DictationOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    let apiKey: string;
    try {
      apiKey = await this.opts.fetchToken();
    } catch (e: any) {
      this.opts.onError('token: ' + (e?.message || String(e)));
      this.opts.onStopped?.();
      return;
    }

    // navigator.mediaDevices is ONLY exposed in a secure context (HTTPS or
    // localhost). The phone loads mobile-web over plain http://<lan-ip>:7878
    // in dev, where `navigator.mediaDevices` is `undefined` → calling
    // .getUserMedia on it throws "Cannot read properties of undefined", which
    // surfaced as a cryptic "Mic undefined". Detect it up front and give an
    // actionable message instead. (Prod is served over HTTPS via the VPS
    // tunnel, where this works; the WKWebView already grants mic permission.)
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const secure = (window as any).isSecureContext;
      this.opts.onError(
        secure
          ? 'mic: getUserMedia unavailable in this browser'
          : 'mic: needs HTTPS (use the Prod address — plain http blocks the microphone)'
      );
      this.opts.onStopped?.();
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e: any) {
      this.opts.onError('mic: ' + (e?.message || String(e)));
      this.opts.onStopped?.();
      return;
    }

    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.ac = new AC();
      this.acRate = this.ac!.sampleRate;
      if (this.ac!.state === 'suspended') {
        try { await this.ac!.resume(); } catch {}
      }
      this.source = this.ac!.createMediaStreamSource(this.stream);

      // Off-device sink shared by both capture paths — a node is only pulled
      // while it reaches a destination, but this destination writes into a
      // MediaStream we never read, so audio never touches the hardware output
      // (the SIGSEGV path). See fix-mic-renderer-sigsegv.md.
      this.muteSink = this.ac!.createMediaStreamDestination();

      // Prefer AudioWorklet (off the main thread). Fall back to SPN if the
      // blob:URL worklet is refused (some old iOS Safari builds).
      let usingWorklet = false;
      try {
        if (this.ac!.audioWorklet) {
          const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
          this.workletURL = URL.createObjectURL(blob);
          await this.ac!.audioWorklet.addModule(this.workletURL);
          this.workletNode = new AudioWorkletNode(this.ac!, 'capture-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
          });
          this.workletNode.port.onmessage = (ev) => {
            this.sendFrame(ev.data as Float32Array);
          };
          this.source.connect(this.workletNode);
          this.workletNode.connect(this.muteSink);
          usingWorklet = true;
        }
      } catch (e: any) {
        try { this.workletNode?.disconnect(); } catch {}
        this.workletNode = null;
        if (this.workletURL) { try { URL.revokeObjectURL(this.workletURL); } catch {}; this.workletURL = null; }
      }

      if (!usingWorklet) {
        this.processor = this.ac!.createScriptProcessor(4096, 1, 1);
        this.source.connect(this.processor);
        this.processor.connect(this.muteSink);
        this.processor.onaudioprocess = (ev) => {
          this.sendFrame(ev.inputBuffer.getChannelData(0));
        };
      }
    } catch (e: any) {
      this.opts.onError('audio: ' + (e?.message || String(e)));
      await this.cleanup();
      this.opts.onStopped?.();
      return;
    }

    this.ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({
        api_key: apiKey,
        model: this.opts.model || 'stt-rt-v4',
        audio_format: 's16le',
        sample_rate: TARGET_RATE,
        num_channels: 1,
        language_hints: this.opts.languageHints || ['en', 'ru'],
        enable_endpoint_detection: true,
      }));
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
          if (t.is_final) newFinal += t.text;
          else newPartial += t.text;
        }
        if (newFinal) this.finalText += newFinal;
        this.partialText = newPartial;
        this.opts.onUpdate({ final: this.finalText, partial: this.partialText });
      }
    };

    this.ws.onerror = () => {
      this.opts.onError('socket error');
    };

    this.ws.onclose = async () => {
      await this.cleanup();
      this.opts.onStopped?.();
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(new ArrayBuffer(0)); } catch {}
    } else {
      await this.cleanup();
      this.opts.onStopped?.();
    }
  }

  getText(): string { return this.finalText + this.partialText; }

  // Shared capture path for worklet (Float32 batch) and SPN fallback. Mobile
  // has no pre-open buffer (unlike desktop): frames captured before ws.onopen
  // are dropped, same as the original onaudioprocess guard.
  private sendFrame(ch0: Float32Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const down = downsampleFloat32(ch0, this.acRate, TARGET_RATE);
    const pcm = floatToS16LE(down);
    try { this.ws.send(pcm); } catch {}
  }

  private async cleanup(): Promise<void> {
    try { if (this.processor) this.processor.onaudioprocess = null as any; } catch {}
    try { if (this.workletNode) this.workletNode.port.onmessage = null as any; } catch {}
    try { this.workletNode?.disconnect(); } catch {}
    try { this.processor?.disconnect(); } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.muteSink?.disconnect(); } catch {}
    try { this.muteSink?.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { await this.ac?.close(); } catch {}
    if (this.workletURL) { try { URL.revokeObjectURL(this.workletURL); } catch {}; this.workletURL = null; }
    this.ws = null;
    this.ac = null;
    this.workletNode = null;
    this.muteSink = null;
    this.processor = null;
    this.source = null;
    this.stream = null;
  }
}

// Soniox real-time dictation engine for mobile-web (mirror of
// src/renderer/utils/dictation.ts — same logic, kept as a separate file
// because mobile-web and the Electron renderer are two independent Vite
// builds. See fact-mobile-web.md).
//
// Uses ScriptProcessorNode instead of AudioWorklet for maximum portability —
// some iOS Safari versions and Electron-with-Vite-CSP configurations refuse
// the blob:URL audio-worklet load. ScriptProcessorNode is deprecated but
// universally available; for dictation usage the slight extra latency is
// imperceptible.

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

export class DictationSession {
  private ws: WebSocket | null = null;
  private ac: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private finalText = '';
  private partialText = '';
  private opts: DictationOptions;
  private stopped = false;

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

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e: any) {
      this.opts.onError('mic: ' + (e?.message || String(e)));
      this.opts.onStopped?.();
      return;
    }

    let acRate = 48000;
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.ac = new AC();
      acRate = this.ac!.sampleRate;
      if (this.ac!.state === 'suspended') {
        try { await this.ac!.resume(); } catch {}
      }
      this.source = this.ac!.createMediaStreamSource(this.stream);
      this.processor = this.ac!.createScriptProcessor(4096, 1, 1);
      this.source.connect(this.processor);
      const sink = this.ac!.createGain();
      sink.gain.value = 0;
      this.processor.connect(sink).connect(this.ac!.destination);
    } catch (e: any) {
      this.opts.onError('audio: ' + (e?.message || String(e)));
      await this.cleanup();
      this.opts.onStopped?.();
      return;
    }

    const TARGET_RATE = 16000;

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
      this.processor!.onaudioprocess = (ev) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const ch0 = ev.inputBuffer.getChannelData(0);
        const down = downsampleFloat32(ch0, acRate, TARGET_RATE);
        const pcm = floatToS16LE(down);
        try { this.ws.send(pcm); } catch {}
      };
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
  }
}

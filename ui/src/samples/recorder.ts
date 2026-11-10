// Recording the microphone in the browser: getUserMedia (127.0.0.1 is a secure context) into an AudioWorklet that hands over float samples at the
// device's own rate. Nothing is trimmed or processed: echo cancellation, noise suppression and automatic gain are asked to be off.

export interface Recording { rate: number; channels: Float32Array[]; seconds: number }

const WORKLET_URL = new URL('./recorder.worklet.js', import.meta.url).href;

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private parts: Float32Array[][] = [];
  private capturing = false;
  private peak = 0;
  rate = 0;

  /** Ask for the microphone and start listening (the meter moves); nothing is kept until `capture`. */
  async open(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser cannot record: it offers no microphone API on this address');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.ctx = new AudioContext();
    this.rate = this.ctx.sampleRate;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    this.node = new AudioWorkletNode(this.ctx, 'soundclaw-recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
    // the microphone is ready when its first block of audio has come: a device can take a moment to start, and a take begun before that has nothing in it
    let heard!: () => void;
    const first = new Promise<void>((resolve) => { heard = resolve; });
    this.node.port.onmessage = (ev: MessageEvent<Float32Array[]>) => {
      heard();
      const chans = ev.data;
      let pk = 0;
      for (const c of chans) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]!); if (v > pk) pk = v; }
      this.peak = Math.max(this.peak, pk);
      if (this.capturing) this.parts.push(chans);
    };
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
    await Promise.race([first, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('the microphone is open but gives no audio: check the input device in the system settings')), 15_000))]);
  }

  /** The loudest sample since the last call, 0 to 1. */
  level(): number {
    const p = this.peak;
    this.peak = 0;
    return p;
  }

  /** A short tick through the speakers (a count-in beat). */
  tick(accent = false): void {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = accent ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, this.ctx.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.09);
    o.connect(g).connect(this.ctx.destination);
    o.start();
    o.stop(this.ctx.currentTime + 0.1);
  }

  capture(): void {
    this.parts = [];
    this.capturing = true;
  }

  /** Stop keeping samples and give what was kept. */
  finish(): Recording {
    this.capturing = false;
    const n = this.parts.reduce((s, p) => s + p[0]!.length, 0);
    const nch = this.parts[0]?.length ?? 1;
    const channels = Array.from({ length: nch }, (_, c) => {
      const a = new Float32Array(n);
      let at = 0;
      for (const p of this.parts) { a.set(p[Math.min(c, p.length - 1)]!, at); at += p[0]!.length; }
      return a;
    });
    this.parts = [];
    return { rate: this.rate, channels, seconds: n / this.rate };
  }

  /** Let go of the microphone. */
  async close(): Promise<void> {
    this.capturing = false;
    this.source?.disconnect();
    this.node?.port.close();
    this.node?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null; this.stream = null; this.node = null; this.source = null;
  }
}

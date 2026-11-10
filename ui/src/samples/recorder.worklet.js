// The microphone's audio worklet: it copies the input's float samples, a block at a time, to the page, which keeps them.
// Plain JavaScript (the browser loads it by its address), no imports.
class SoundClawRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.frames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0].length) {
      this.parts.push(input.map((c) => c.slice()));
      this.frames += input[0].length;
      // about every 2048 frames: fewer, larger messages
      if (this.frames >= 2048) this.flush();
    }
    return true;
  }

  flush() {
    const channels = this.parts[0].length;
    const out = [];
    for (let c = 0; c < channels; c++) {
      const a = new Float32Array(this.frames);
      let at = 0;
      for (const p of this.parts) { a.set(p[Math.min(c, p.length - 1)], at); at += p[0].length; }
      out.push(a);
    }
    this.port.postMessage(out, out.map((a) => a.buffer));
    this.parts = [];
    this.frames = 0;
  }
}
registerProcessor('soundclaw-recorder', SoundClawRecorder);

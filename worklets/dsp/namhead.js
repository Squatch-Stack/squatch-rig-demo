// The per-node signal path around a NAM model: input gain, the model, output
// gain with loudness normalisation (de-zippered), and a 10 Hz DC blocker.
// Shared by the AudioWorklet (nam-processor.js) and the offline renderer
// (tools/render), so both run exactly the same arithmetic.
const dbToLin = (db) => Math.pow(10, db / 20);

export class NamHead {
  constructor(sampleRate, params = {}, block = 128) {
    this.params = { input: 0, output: 0, normalize: 1, dcblock: 1, ...params };
    // One-pole 10 Hz DC blocker on the output: NAM models can emit DC and
    // subsonics, which eat headroom downstream.
    this.dcR = 1 - (2 * Math.PI * 10) / sampleRate; this.dcX = 0; this.dcY = 0;
    this.model = null; this.loudness = null;
    this.buf = new Float32Array(block); this.outBuf = new Float32Array(block);
    this.gIn = 1; this.gOut = 1; this.gOutTarget = 1;
    this.gains();
  }
  /** Swap in a loaded model (returns the previous one so the caller can destroy it). */
  setModel(model) {
    const old = this.model;
    this.model = model; this.loudness = model ? model.loudness : null;
    this.gains();
    return old;
  }
  set(name, value) { this.params[name] = value; this.gains(); }
  gains() {
    this.gIn = dbToLin(this.params.input);
    // Normalise like the NAM plugin: bring the model's stated loudness to -18 dB.
    const norm = this.params.normalize >= 0.5 && this.loudness != null ? -18 - this.loudness : 0;
    this.gOutTarget = dbToLin(this.params.output + norm);
  }
  /** input may be null (silence). Writes n samples to out. */
  process(input, out, n) {
    const buf = this.buf;
    if (input) { const g = this.gIn; for (let i = 0; i < n; i++) buf[i] = input[i] * g; } else buf.fill(0);
    this.model.process(buf, this.outBuf, n);
    // de-zipper output gain changes
    let g = this.gOut; const tgt = this.gOutTarget, a = 0.002;
    for (let i = 0; i < n; i++) { g += (tgt - g) * a; out[i] = this.outBuf[i] * g; }
    this.gOut = g;
    if (this.params.dcblock >= 0.5) {
      let x1 = this.dcX, y1 = this.dcY; const R = this.dcR;
      for (let i = 0; i < n; i++) { const x = out[i], y = x - x1 + R * y1; x1 = x; y1 = y; out[i] = y; }
      this.dcX = x1; this.dcY = y1;
    }
  }
}

// The per-node signal path around a NAM model: input gain, the model, output
// gain with loudness normalisation (de-zippered), and a 10 Hz DC blocker.
// Shared by the AudioWorklet (nam-processor.js) and the offline renderer
// (tools/render), so both run exactly the same arithmetic.
import { Biquad } from './util.js';

const dbToLin = (db) => Math.pow(10, db / 20);

export class NamHead {
  constructor(sampleRate, params = {}, block = 128) {
    this.sampleRate = sampleRate;
    this.params = { input: 0, output: 0, bass: 0, normalize: 1, dcblock: 1, ...params };
    // One-pole 10 Hz DC blocker on the output: NAM models can emit DC and
    // subsonics, which eat headroom downstream.
    this.dcR = 1 - (2 * Math.PI * 10) / sampleRate; this.dcX = 0; this.dcY = 0;
    this.model = null; this.loudness = null;
    this.buf = new Float32Array(block); this.outBuf = new Float32Array(block);
    this.gIn = 1; this.gOut = 1; this.gOutTarget = 1;
    this.bassFilter = new Biquad().set('lowshelf', 160, sampleRate, 0.7071, this.params.bass);
    this.bassCoeffStart = null; this.bassCoeffTarget = null; this.bassCoeffStep = null;
    this.bassFadePos = 0; this.bassFadeSamples = Math.max(1, Math.round(sampleRate * 0.012));
    this.gains();
  }
  /** Swap in a loaded model (returns the previous one so the caller can destroy it). */
  setModel(model) {
    const old = this.model;
    this.model = model; this.loudness = model ? model.loudness : null;
    this.gains();
    return old;
  }
  set(name, value) {
    this.params[name] = value;
    if (name === 'bass') {
      const f = this.bassFilter;
      const targetFilter = new Biquad().set('lowshelf', 160, this.sampleRate, 0.7071, value);
      const start = [f.b0, f.b1, f.b2, f.a1, f.a2];
      const target = [targetFilter.b0, targetFilter.b1, targetFilter.b2, targetFilter.a1, targetFilter.a2];
      // Ramp from the coefficients currently in use. If the player changes
      // Bass again mid-ramp, this starts from the current coefficients rather
      // than dropping one side of an unfinished crossfade.
      this.bassCoeffStart = start; this.bassCoeffTarget = target;
      this.bassCoeffStep = target.map((v, i) => (v - start[i]) / this.bassFadeSamples);
      this.bassFadePos = 0;
      return;
    }
    this.gains();
  }
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
    for (let i = 0; i < n; i++) {
      g += (tgt - g) * a;
      const input = this.outBuf[i] * g;
      const start = this.bassCoeffStart, step = this.bassCoeffStep;
      if (start) {
        const f = this.bassFilter, target = this.bassCoeffTarget;
        const p = Math.min(this.bassFadeSamples, ++this.bassFadePos);
        f.b0 = start[0] + step[0] * p; f.b1 = start[1] + step[1] * p; f.b2 = start[2] + step[2] * p;
        f.a1 = start[3] + step[3] * p; f.a2 = start[4] + step[4] * p;
        if (p === this.bassFadeSamples) {
          f.b0 = target[0]; f.b1 = target[1]; f.b2 = target[2]; f.a1 = target[3]; f.a2 = target[4];
          this.bassCoeffStart = this.bassCoeffTarget = this.bassCoeffStep = null;
        }
      }
      out[i] = this.bassFilter.process(input);
    }
    this.gOut = g;
    if (this.params.dcblock >= 0.5) {
      let x1 = this.dcX, y1 = this.dcY; const R = this.dcR;
      for (let i = 0; i < n; i++) { const x = out[i], y = x - x1 + R * y1; x1 = x; y1 = y; out[i] = y; }
      this.dcX = x1; this.dcY = y1;
    }
  }
}

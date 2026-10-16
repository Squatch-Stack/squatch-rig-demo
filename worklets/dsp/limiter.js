// Look-ahead peak limiter that cannot overshoot its ceiling.
//
// Per sample: required gain r = min(1, ceiling/|x|). A running minimum of r
// over the look-ahead window L, then a release-only smoother (instant down,
// exponential up), then a length-L moving average. Every gain applied to a
// peak is an average of values each <= that peak's required gain, and the
// audio is delayed by L-1 samples so the average has fully arrived: output
// peak <= ceiling, exactly, with a click-free ramp into the reduction.
import { dbToLin, tauCoef } from './util.js';

export class Limiter {
  static params = {
    gain: { min: 0, max: 18, def: 0, unit: 'dB', label: 'Drive' },
    ceiling: { min: -12, max: 0, def: -1, unit: 'dB', label: 'Ceiling' },
    release: { min: 10, max: 1000, def: 120, unit: 'ms', label: 'Release', curve: 'log' },
  };
  constructor(sampleRate, lookaheadMs = 2) {
    this.sr = sampleRate;
    this.p = {};
    for (const [k, v] of Object.entries(Limiter.params)) this.p[k] = v.def;
    this.L = Math.max(1, Math.round((lookaheadMs * sampleRate) / 1000));
    this.req = new Float64Array(this.L).fill(1); // ring of required gains (for the min)
    this.sm = new Float64Array(this.L).fill(1); // ring of smoothed gains (for the average)
    this.sum = this.L; this.idx = 0; this.r = 1;
    this.delay = [];
    this.grDb = 0;
    this.latency = this.L - 1;
    this._update();
  }
  set(name, value) { this.p[name] = value; this._update(); }
  _update() {
    this.inGain = dbToLin(this.p.gain);
    this.ceil = dbToLin(this.p.ceiling);
    this.aR = tauCoef(this.p.release, this.sr);
  }
  process(ins, outs, n) {
    const L = this.L, chans = ins.length;
    while (this.delay.length < chans) this.delay.push(new Float32Array(L));
    let minGain = 1;
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let c = 0; c < chans; c++) { const v = Math.abs(ins[c][i] * this.inGain); if (v > a) a = v; }
      const idx = this.idx;
      this.req[idx] = a > this.ceil ? this.ceil / a : 1;
      let h = 1;
      for (let k = 0; k < L; k++) if (this.req[k] < h) h = this.req[k];
      this.r = h < this.r ? h : this.aR * this.r + (1 - this.aR) * h;
      if (this.r > h) this.r = h;
      this.sum += this.r - this.sm[idx];
      this.sm[idx] = this.r;
      if ((i & 63) === 0) { let s = 0; for (let k = 0; k < L; k++) s += this.sm[k]; this.sum = s; }
      const g = Math.min(1, this.sum / L);
      if (g < minGain) minGain = g;
      // ring index idx currently holds the sample written L steps ago -> delay L-1 after write/read order
      const readIdx = (idx + 1) % L;
      for (let c = 0; c < chans; c++) {
        const d = this.delay[c];
        d[idx] = ins[c][i] * this.inGain;
        outs[c][i] = d[readIdx] * g;
      }
      this.idx = readIdx;
    }
    this.grDb = -20 * Math.log10(minGain);
  }
}

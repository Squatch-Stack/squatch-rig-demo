// Feedback delay network reverb: 8 lines, Householder feedback matrix,
// per-line gain set from the target RT60, a one-pole damping lowpass in every
// loop (unity at DC, so the set decay is the low-frequency RT60), pre-delay and
// four series allpass diffusers on the input. Mono in, stereo out.
import { OnePole, dbToLin } from './util.js';

const LINE_MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.1, 73.3];
const AP_MS = [4.771, 3.595, 12.73, 9.307];
const SIGN_L = [1, -1, 1, -1, 1, -1, 1, -1];
const SIGN_R = [1, 1, -1, -1, 1, 1, -1, -1];

class Delay {
  constructor(maxLen) { this.b = new Float32Array(maxLen + 1); this.w = 0; this.len = maxLen; }
  read(d) { let r = this.w - d; if (r < 0) r += this.b.length; return this.b[r]; }
  write(x) { this.b[this.w] = x; this.w = (this.w + 1) % this.b.length; }
}

export class Reverb {
  static params = {
    decay: { min: 0.2, max: 12, def: 2.4, unit: 's', label: 'Decay', curve: 'log' },
    size: { min: 0.3, max: 1.6, def: 1, unit: '', label: 'Size' },
    damp: { min: 1000, max: 20000, def: 6500, unit: 'Hz', label: 'Damp', curve: 'log' },
    predelay: { min: 0, max: 150, def: 18, unit: 'ms', label: 'Pre' },
    mix: { min: 0, max: 1, def: 0.25, unit: '', label: 'Mix' },
    width: { min: 0, max: 1, def: 1, unit: '', label: 'Width' },
  };
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.p = {};
    for (const [k, v] of Object.entries(Reverb.params)) this.p[k] = v.def;
    const maxLine = Math.ceil((73.3 * 1.6 * sampleRate) / 1000) + 2;
    this.lines = LINE_MS.map(() => new Delay(maxLine));
    this.damps = LINE_MS.map(() => new OnePole());
    this.pre = new Delay(Math.ceil(0.16 * sampleRate));
    this.aps = AP_MS.map((ms) => ({ d: new Delay(Math.ceil((ms * 1.6 * sampleRate) / 1000) + 2), len: 1 }));
    this.len = new Int32Array(8);
    this.g = new Float64Array(8);
    this.x = new Float64Array(8);
    this._update();
  }
  set(name, value) { this.p[name] = value; this._update(); }
  _update() {
    const { decay, size, damp } = this.p;
    for (let i = 0; i < 8; i++) {
      this.len[i] = Math.max(8, Math.round((LINE_MS[i] * size * this.sr) / 1000));
      this.g[i] = Math.pow(10, (-3 * this.len[i]) / (decay * this.sr));
      this.damps[i].setCutoff(damp, this.sr);
    }
    AP_MS.forEach((ms, i) => { this.aps[i].len = Math.max(1, Math.round((ms * Math.min(size, 1.6) * this.sr) / 1000)); });
    this.preLen = Math.max(0, Math.round((this.p.predelay * this.sr) / 1000));
  }
  /** ins: 1-2 channels (summed to mono); outs: 2 channels. */
  process(ins, outs, n) {
    const { mix, width } = this.p;
    const L = outs[0], R = outs[1] || outs[0];
    const x = this.x, lines = this.lines, len = this.len, g = this.g;
    const wet = mix, dry = 1 - mix;
    const outScale = 0.35;
    for (let i = 0; i < n; i++) {
      const dl = ins[0][i], dr = ins.length > 1 ? ins[1][i] : dl;
      let s = 0.5 * (dl + dr);
      this.pre.write(s);
      s = this.preLen ? this.pre.read(this.preLen) : s;
      for (const ap of this.aps) {
        const z = ap.d.read(ap.len);
        const v = s + 0.6 * z;
        ap.d.write(v);
        s = z - 0.6 * v;
      }
      let sum = 0;
      for (let k = 0; k < 8; k++) { x[k] = this.damps[k].lp(lines[k].read(len[k])) * g[k]; sum += x[k]; }
      const hh = (2 / 8) * sum;
      let yl = 0, yr = 0;
      for (let k = 0; k < 8; k++) {
        yl += SIGN_L[k] * x[k]; yr += SIGN_R[k] * x[k];
        lines[k].write(x[k] - hh + s);
      }
      yl *= outScale; yr *= outScale;
      const mid = 0.5 * (yl + yr), side = 0.5 * (yl - yr) * width;
      L[i] = dry * dl + wet * (mid + side);
      if (R !== L) R[i] = dry * dr + wet * (mid - side);
    }
  }
}
export { dbToLin };

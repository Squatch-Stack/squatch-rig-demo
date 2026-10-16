// Polyphase 4x oversampler: linear-phase Kaiser FIR used for both the
// interpolator and the decimator. 129 taps at the 4x rate (group delay exactly
// 64 samples at 4x = 16 at 1x per filter, 32 samples round trip). Kaiser beta
// 8.6 gives ~86 dB stopband; the transition runs ~17-25 kHz at a 48 kHz base
// rate, so anything folding back lands above ~23 kHz.
import { kaiserLowpass } from './util.js';

export class Oversampler4x {
  constructor(taps = 129) {
    const L = 4;
    this.L = L;
    const h = kaiserLowpass(taps, 21000 / 192000, 8.6);
    const per = Math.ceil(taps / L);
    this.per = per;
    // phases[k][j] = L*h[j*L + k]  (interpolator gain L restores the level)
    this.phases = [];
    for (let k = 0; k < L; k++) {
      const p = new Float64Array(per);
      for (let j = 0; j < per; j++) { const t = j * L + k; p[j] = t < taps ? L * h[t] : 0; }
      this.phases.push(p);
    }
    this.h = Float64Array.from(h);
    this.taps = taps;
    // Doubled circular histories so every convolution reads one contiguous run.
    this.xh = new Float64Array(2 * per); this.xi = 0;
    this.uh = new Float64Array(2 * taps); this.ui = 0;
    this.latency = (taps - 1) / L; // at the base rate, round trip
  }
  /** Push one base-rate sample, write L oversampled samples into out4. */
  up(x, out4) {
    const per = this.per;
    this.xi = (this.xi + 1) % per;
    this.xh[this.xi] = x; this.xh[this.xi + per] = x;
    const base = this.xi + per; // newest sample, walking backwards
    for (let k = 0; k < this.L; k++) {
      const p = this.phases[k];
      let s = 0;
      for (let j = 0; j < per; j++) s += p[j] * this.xh[base - j];
      out4[k] = s;
    }
  }
  /** Push L oversampled samples, return one base-rate sample. */
  down(in4) {
    const taps = this.taps;
    for (let k = 0; k < this.L; k++) {
      this.ui = (this.ui + 1) % taps;
      this.uh[this.ui] = in4[k]; this.uh[this.ui + taps] = in4[k];
    }
    const base = this.ui + taps, h = this.h;
    let s = 0;
    for (let t = 0; t < taps; t++) s += h[t] * this.uh[base - t];
    return s;
  }
}

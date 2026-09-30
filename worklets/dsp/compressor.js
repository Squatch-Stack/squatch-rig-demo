// Feed-forward compressor, log-domain, stereo-linked.
//
// Structure after Giannoulis, Massberg & Reiss, "Digital Dynamic Range
// Compressor Design - A Tutorial and Analysis" (JAES 2012): peak level in dB ->
// static gain computer (soft knee) -> smooth branching peak detector applied to
// the gain reduction -> make-up gain.
import { dbToLin, tauCoef } from './util.js';

/** Static curve: output level (dB) for input level x (dB). */
export function gainComputer(x, threshold, ratio, knee) {
  const d = x - threshold;
  if (2 * d < -knee) return x;
  if (knee > 0 && 2 * Math.abs(d) <= knee) return x + ((1 / ratio - 1) * (d + knee / 2) ** 2) / (2 * knee);
  return threshold + d / ratio;
}

export class Compressor {
  static params = {
    threshold: { min: -60, max: 0, def: -24, unit: 'dB', label: 'Thresh' },
    ratio: { min: 1, max: 20, def: 4, unit: ':1', label: 'Ratio', curve: 'log' },
    attack: { min: 0.1, max: 100, def: 5, unit: 'ms', label: 'Attack', curve: 'log' },
    release: { min: 10, max: 1000, def: 120, unit: 'ms', label: 'Release', curve: 'log' },
    knee: { min: 0, max: 24, def: 6, unit: 'dB', label: 'Knee' },
    makeup: { min: 0, max: 24, def: 6, unit: 'dB', label: 'Makeup' },
    mix: { min: 0, max: 1, def: 1, unit: '', label: 'Blend' },
  };

  constructor(sampleRate) {
    this.sr = sampleRate;
    this.p = {};
    for (const [k, v] of Object.entries(Compressor.params)) this.p[k] = v.def;
    this.yL = 0; // smoothed gain reduction, dB (>= 0)
    this.grDb = 0; // exposed for metering
    this._update();
  }
  set(name, value) { this.p[name] = value; this._update(); }
  _update() {
    this.aA = tauCoef(this.p.attack, this.sr);
    this.aR = tauCoef(this.p.release, this.sr);
    this.makeup = dbToLin(this.p.makeup);
  }
  /** @param {Float32Array[]} ins @param {Float32Array[]} outs */
  process(ins, outs, n) {
    const { threshold, ratio, knee, mix } = this.p;
    const aA = this.aA, aR = this.aR, mk = this.makeup, chans = ins.length;
    let yL = this.yL, maxGr = 0;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < chans; c++) { const a = Math.abs(ins[c][i]); if (a > peak) peak = a; }
      const xG = peak > 1e-9 ? 20 * Math.log10(peak) : -180;
      const xL = xG - gainComputer(xG, threshold, ratio, knee);
      yL = xL > yL ? aA * yL + (1 - aA) * xL : aR * yL + (1 - aR) * xL;
      if (yL > maxGr) maxGr = yL;
      const g = Math.pow(10, -yL / 20) * mk;
      const wet = mix * g + (1 - mix);
      for (let c = 0; c < chans; c++) outs[c][i] = ins[c][i] * wet;
    }
    this.yL = yL;
    this.grDb = maxGr;
  }
}

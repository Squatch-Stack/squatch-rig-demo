// Envelope filter (auto-wah): an attack/release envelope follower drives the
// cutoff of a resonant SVF exponentially between `lo` and `hi`.
import { Svf } from './svf.js';
import { dbToLin, tauCoef } from './util.js';

export const MODES = ['lowpass', 'bandpass', 'highpass'];

export class EnvelopeFilter {
  static params = {
    sens: { min: -12, max: 36, def: 18, unit: 'dB', label: 'Sens' },
    lo: { min: 60, max: 2000, def: 250, unit: 'Hz', label: 'Low', curve: 'log' },
    hi: { min: 300, max: 8000, def: 2800, unit: 'Hz', label: 'High', curve: 'log' },
    q: { min: 0.5, max: 12, def: 4, unit: '', label: 'Reso', curve: 'log' },
    attack: { min: 0.5, max: 100, def: 6, unit: 'ms', label: 'Attack', curve: 'log' },
    release: { min: 10, max: 1000, def: 140, unit: 'ms', label: 'Decay', curve: 'log' },
    mode: { min: 0, max: 2, def: 1, step: 1, unit: '', label: 'Mode', options: MODES },
    down: { min: 0, max: 1, def: 0, step: 1, unit: '', label: 'Down', options: ['up', 'down'] },
    mix: { min: 0, max: 1, def: 1, unit: '', label: 'Mix' },
  };
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.p = {};
    for (const [k, v] of Object.entries(EnvelopeFilter.params)) this.p[k] = v.def;
    this.env = 0;
    this.cutoff = this.p.lo; // exposed for metering / tests
    this.f = [];
    this.o = new Float64Array(3);
    this._update();
  }
  set(name, value) { this.p[name] = value; this._update(); }
  _update() {
    this.aA = tauCoef(this.p.attack, this.sr);
    this.aR = tauCoef(this.p.release, this.sr);
    this.sensLin = dbToLin(this.p.sens);
  }
  process(ins, outs, n) {
    const { lo, hi, q, mix } = this.p;
    const mode = Math.round(this.p.mode), down = this.p.down >= 0.5;
    while (this.f.length < ins.length) this.f.push(new Svf());
    const ratio = Math.log2(hi / lo), chans = ins.length, o = this.o;
    let env = this.env;
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let c = 0; c < chans; c++) a += Math.abs(ins[c][i]);
      a /= chans;
      env = a > env ? this.aA * env + (1 - this.aA) * a : this.aR * env + (1 - this.aR) * a;
      if ((i & 7) === 0) {
        // |x| of a sine averages 2/pi of its peak; sens scales that into 0..1.
        let e = env * this.sensLin;
        e = e > 1 ? 1 : e;
        if (down) e = 1 - e;
        this.cutoff = lo * Math.pow(2, ratio * e);
        for (let c = 0; c < chans; c++) this.f[c].set(this.cutoff, q, this.sr);
      }
      for (let c = 0; c < chans; c++) {
        this.f[c].tick(ins[c][i], o);
        // Band-pass is normalised to unity peak gain (bp * k) so resonance
        // changes width, not level.
        const w = mode === 1 ? o[1] * this.f[c].k : o[mode === 0 ? 0 : 2];
        outs[c][i] = mix * w + (1 - mix) * ins[c][i];
      }
    }
    this.env = env;
  }
}

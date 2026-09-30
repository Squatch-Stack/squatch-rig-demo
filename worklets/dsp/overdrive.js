// Tube-Screamer-style overdrive with 4x oversampling.
//
// Signal model (TS808-ish, simplified): the op-amp stage outputs the clean
// input PLUS a clipped copy of a band-limited, amplified version of it. The
// clipped path is high-passed at ~720 Hz (4.7k/47nF) and low-passed by the
// feedback cap (51 pF against 51k + drive*500k), which is where the mid hump
// comes from; bass passes clean. Clipping is an asymmetric soft clip (biased
// tanh, DC removed), so it produces even harmonics as well as odd. The
// nonlinear part runs at 4x with a linear-phase FIR up/down pair to keep
// aliasing down; tone (one-pole LP sweep) and level run at the base rate.
import { OnePole, DcBlock, dbToLin, tanhFast } from './util.js';
import { Oversampler4x } from './oversample.js';
import { TRAIL_OD_PARAMS } from '../../js/graph/trail-od-contract.js';

export class Overdrive {
  static params = {
    ...TRAIL_OD_PARAMS,
    voice: { min: 80, max: 1200, def: 720, unit: 'Hz', label: 'Voice', curve: 'log' },
    asym: { min: 0, max: 1, def: 0.35, unit: '', label: 'Asym' },
  };

  /** @param {number} sampleRate @param {{oversample?: 1|4}} [opts] */
  constructor(sampleRate, opts = {}) {
    this.sr = sampleRate;
    this.os = opts.oversample ?? 4;
    this.p = {};
    for (const [k, v] of Object.entries(Overdrive.params)) this.p[k] = v.def;
    this.ch = [];
    this.u4 = new Float64Array(4);
    this.y4 = new Float64Array(4);
    this._update();
  }
  _chan(c) {
    while (this.ch.length <= c) {
      this.ch.push({ os: new Oversampler4x(), hp: new OnePole(), lp: new OnePole(), tone: new OnePole(), dc: new DcBlock(this.sr, 8) });
      this._update();
    }
    return this.ch[c];
  }
  set(name, value) { this.p[name] = value; this._update(); }
  _update() {
    const { drive, tone, level, voice, asym } = this.p;
    const fsHi = this.sr * this.os;
    // Pot is audio taper: gain 1 + drive^2 * 500k/4.7k-ish, i.e. up to ~ +41 dB.
    this.gain = 1 + 110 * drive * drive;
    const rf = 51e3 + drive * drive * 500e3;
    const fcClip = Math.min(1 / (2 * Math.PI * rf * 51e-12), 0.45 * fsHi);
    this.bias = 0.6 * asym;
    this.tb = Math.tanh(this.bias);
    this.out = dbToLin(level);
    for (const c of this.ch) {
      c.hp.setCutoff(voice, fsHi);
      c.lp.setCutoff(fcClip, fsHi);
      c.tone.setCutoff(500 * Math.pow(2, tone * 4.5), this.sr); // 500 Hz .. 11 kHz
    }
  }
  _nl(c, u) {
    const v = c.lp.lp(c.hp.hp(u) * this.gain);
    // Diode pair ~ +-0.5 of full scale, asymmetric via the bias.
    return u + 0.5 * (tanhFast(2 * v + this.bias) - this.tb);
  }
  process(ins, outs, n) {
    const u4 = this.u4, y4 = this.y4;
    for (let c = 0; c < ins.length; c++) {
      const st = this._chan(c), x = ins[c], y = outs[c];
      for (let i = 0; i < n; i++) {
        let s;
        if (this.os === 4) {
          st.os.up(x[i], u4);
          for (let k = 0; k < 4; k++) y4[k] = this._nl(st, u4[k]);
          s = st.os.down(y4);
        } else {
          s = this._nl(st, x[i]);
        }
        y[i] = st.tone.lp(st.dc.process(s)) * this.out;
      }
    }
  }
}

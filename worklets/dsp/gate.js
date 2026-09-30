// Noise gate: peak detector with hysteresis and hold; gain ramps between unity
// and the floor (`range`) with separate open/close times.
import { dbToLin, tauCoef } from './util.js';

export class NoiseGate {
  static params = {
    threshold: { min: -90, max: -10, def: -58, unit: 'dB', label: 'Thresh' },
    hysteresis: { min: 0, max: 20, def: 6, unit: 'dB', label: 'Hyst' },
    attack: { min: 0.1, max: 50, def: 1, unit: 'ms', label: 'Attack', curve: 'log' },
    hold: { min: 0, max: 500, def: 40, unit: 'ms', label: 'Hold' },
    release: { min: 5, max: 1000, def: 90, unit: 'ms', label: 'Release', curve: 'log' },
    range: { min: -90, max: 0, def: -70, unit: 'dB', label: 'Range' },
  };
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.p = {};
    for (const [k, v] of Object.entries(NoiseGate.params)) this.p[k] = v.def;
    this.env = 0; this.open = false; this.holdLeft = 0; this.gain = 0;
    this._update();
  }
  set(name, value) { this.p[name] = value; this._update(); }
  _update() {
    this.envRel = tauCoef(20, this.sr);
    this.aOpen = tauCoef(this.p.attack, this.sr);
    this.aClose = tauCoef(this.p.release, this.sr);
    this.thOpen = dbToLin(this.p.threshold);
    this.thClose = dbToLin(this.p.threshold - this.p.hysteresis);
    this.floor = dbToLin(this.p.range);
    this.holdN = Math.round((this.p.hold * this.sr) / 1000);
  }
  process(ins, outs, n) {
    const chans = ins.length;
    let env = this.env, gain = this.gain;
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let c = 0; c < chans; c++) { const v = Math.abs(ins[c][i]); if (v > a) a = v; }
      env = a > env ? a : this.envRel * env + (1 - this.envRel) * a;
      if (env >= this.thOpen) { this.open = true; this.holdLeft = this.holdN; }
      else if (env < this.thClose) { if (this.holdLeft > 0) this.holdLeft--; else this.open = false; }
      const target = this.open ? 1 : this.floor;
      const c = target > gain ? this.aOpen : this.aClose;
      gain = c * gain + (1 - c) * target;
      for (let ch = 0; ch < chans; ch++) outs[ch][i] = ins[ch][i] * gain;
    }
    this.env = env; this.gain = gain;
  }
}

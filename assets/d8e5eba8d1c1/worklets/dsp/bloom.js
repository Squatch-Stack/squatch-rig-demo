// Bloom: a pick-sensitive drive. A short attack detector holds the clean,
// delay-aligned pick in front; as it decays, an oversampled overdrive blooms
// into the sustain. This is a DSP pedal, not a trained NAM capture.
import { Overdrive } from './overdrive.js';
import { dbToLin } from './util.js';
import { BLOOM_PARAMS } from '../../js/graph/bloom-contract.js';

const LATENCY = 32; // Oversampler4x's measured algorithmic delay in this rig.

export class Bloom {
  static params = BLOOM_PARAMS;

  constructor(sampleRate) {
    this.sr = sampleRate;
    this.drive = new Overdrive(sampleRate);
    this.p = Object.fromEntries(Object.entries(Bloom.params).map(([k, v]) => [k, v.def]));
    this.ch = [];
    this.wetInputs = [];
    // What the UI's bloom motion reads (fxMeter, ~60 Hz): the drive share of the
    // output averaged since the last read, and the strongest pick guard.
    this.mixSum = 0; this.mixN = 0; this.pickPeak = 0;
    this._update();
  }
  _update() {
    this.drive.set('drive', 0.18 + 0.64 * this.p.bloom);
    this.drive.set('tone', 0.74 - 0.48 * this.p.warmth);
    this.drive.set('voice', 760 - 460 * this.p.warmth);
    this.drive.set('asym', 0.3);
    this.drive.set('level', 0);
    this.out = dbToLin(this.p.level);
    this.fastA = 1 - Math.exp(-1 / (0.003 * this.sr));
    this.fastR = 1 - Math.exp(-1 / (0.045 * this.sr));
    this.slowA = 1 - Math.exp(-1 / (0.085 * this.sr));
    this.slowR = 1 - Math.exp(-1 / (0.19 * this.sr));
  }
  set(name, value) {
    if (!Object.hasOwn(Bloom.params, name) || !Number.isFinite(value)) return;
    const spec = Bloom.params[name];
    this.p[name] = Math.max(spec.min, Math.min(spec.max, value));
    this._update();
  }
  _chan(index, n) {
    while (this.ch.length <= index) this.ch.push({ fast: 0, slow: 0, ring: new Float32Array(LATENCY), at: 0, wet: new Float32Array(n) });
    const ch = this.ch[index];
    if (ch.wet.length < n) ch.wet = new Float32Array(n);
    return ch;
  }
  process(ins, outs, n) {
    this.wetInputs.length = ins.length;
    for (let c = 0; c < ins.length; c++) this.wetInputs[c] = this._chan(c, n).wet;
    this.drive.process(ins, this.wetInputs, n);
    for (let c = 0; c < ins.length; c++) {
      const st = this._chan(c, n), input = ins[c], output = outs[c];
      for (let i = 0; i < n; i++) {
        const x = input[i], abs = Math.abs(x);
        st.fast += (abs > st.fast ? this.fastA : this.fastR) * (abs - st.fast);
        st.slow += (abs > st.slow ? this.slowA : this.slowR) * (abs - st.slow);
        const onset = Math.max(0, st.fast - st.slow) / Math.max(st.fast, 0.015);
        const guard = Math.min(1, onset * this.p.touch * 1.65);
        const clean = st.ring[st.at];
        st.ring[st.at] = x;
        st.at = (st.at + 1) % st.ring.length;
        const mix = Math.max(0.05, Math.min(1, this.p.bloom * (1 - 0.85 * guard)));
        output[i] = (clean * (1 - mix) + st.wet[i] * mix) * this.out;
        if (c === 0) { this.mixSum += mix; if (guard > this.pickPeak) this.pickPeak = guard; }
      }
      if (c === 0) this.mixN += n;
    }
  }
}

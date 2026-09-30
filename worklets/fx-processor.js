// AudioWorklet host for the JS effect kernels in ./dsp. One processor class,
// the kernel chosen by processorOptions.kind. Parameters arrive over the port
// (they are k-rate by nature; kernels smooth what needs smoothing).
import { Compressor } from './dsp/compressor.js';
import { Overdrive } from './dsp/overdrive.js';
import { Bloom } from './dsp/bloom.js';
import { EnvelopeFilter } from './dsp/envfilter.js';
import { Reverb } from './dsp/reverb.js';
import { NoiseGate } from './dsp/gate.js';
import { Limiter } from './dsp/limiter.js';
import { CpuMeter } from './cpu.js';
import { runFx, fxMeter } from './dsp/fxrun.js';

const METER_EVERY = 6; // quanta: 768 frames = 16 ms at 48 kHz, i.e. ~60 Hz

const KINDS = { compressor: Compressor, overdrive: Overdrive, bloom: Bloom, envfilter: EnvelopeFilter, reverb: Reverb, gate: NoiseGate, limiter: Limiter };

class RigFxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { kind, params = {} } = options.processorOptions;
    const K = KINDS[kind];
    this.kind = kind;
    this.kernel = new K(sampleRate);
    for (const [k, v] of Object.entries(params)) this.kernel.set(k, v);
    this.bypass = false;
    this.alive = true;
    this.cpu = new CpuMeter();
    this.silentIn = [new Float32Array(128)];
    // Only kernels with something to report post meter messages.
    this.metered = ['compressor', 'limiter', 'gate', 'envfilter', 'bloom'].includes(kind);
    this.meterCount = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'param') this.kernel.set(m.name, m.value);
      else if (m.type === 'params') for (const [k, v] of Object.entries(m.values)) this.kernel.set(k, v);
      else if (m.type === 'bypass') this.bypass = m.value;
      else if (m.type === 'dispose') this.alive = false;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    let ins = inputs[0];
    if (this.bypass) { for (const ch of out) ch.fill(0); return this.alive; }
    const t0 = this.cpu.start();
    if (!ins || ins.length === 0) ins = this.silentIn;
    const n = out[0].length;
    runFx(this.kind, this.kernel, ins, out, n);
    const stats = this.cpu.stop(t0, n);
    if (stats) {
      stats.type = 'stats';
      if (this.kernel.grDb !== undefined) stats.grDb = this.kernel.grDb;
      if (this.kernel.cutoff !== undefined) stats.cutoff = this.kernel.cutoff;
      this.port.postMessage(stats);
    }
    // ~60 Hz metering (gain reduction, filter cutoff, gate state) for the UI's motion.
    if (this.metered && ++this.meterCount >= METER_EVERY) {
      this.meterCount = 0;
      const m = fxMeter(this.kind, this.kernel);
      m.type = 'meter'; m.frame = currentFrame;
      this.port.postMessage(m);
    }
    return this.alive;
  }
}
registerProcessor('rig-fx', RigFxProcessor);

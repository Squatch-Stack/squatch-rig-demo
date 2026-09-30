// NAM amp head in an AudioWorklet. The main thread sends the .wasm bytes and
// the .nam JSON bytes per model. Every NAM node in an AudioContext shares ONE
// compiled module and ONE instance (one linear memory) through module scope -
// each node owns a model handle inside it. One heap rather than one per node
// is what keeps several heads inside iOS Safari's memory limits (the TONE3000
// web engine moved to the same design for that reason).
//
// Model parsing happens on the audio thread, between render quanta: swapping a
// model can drop a few quanta. Processing itself allocates nothing.
import { instantiateNam } from './nam-wasm.js';
import { NamHead } from './dsp/namhead.js';
import { CpuMeter } from './cpu.js';

let modulePromise = null;
let sharedNam = null; // one instance for every node in this AudioWorkletGlobalScope

class RigNamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.head = new NamHead(sampleRate, o.params || {});
    this.bypass = false; this.alive = true;
    this.cpu = new CpuMeter();
    this.port.onmessage = (e) => this._onMessage(e.data);
  }
  async _onMessage(m) {
    if (m.type === 'wasm') {
      if (!modulePromise) modulePromise = WebAssembly.compile(m.bytes);
    } else if (m.type === 'model') {
      try {
        const mod = await modulePromise;
        if (!sharedNam) sharedNam = instantiateNam(mod, (line) => console.log('[nam]', line));
        const t0 = Date.now();
        const next = sharedNam.create(new Uint8Array(m.bytes), sampleRate, 128);
        const old = this.head.setModel(next);
        if (old) old.destroy();
        this.port.postMessage({ type: 'loaded', hash: m.hash, ms: Date.now() - t0, loudness: next.loudness, expectedSampleRate: next.expectedSampleRate });
      } catch (err) {
        this.port.postMessage({ type: 'error', hash: m.hash, message: String(err && err.message || err) });
      }
    } else if (m.type === 'param') this.head.set(m.name, m.value);
    else if (m.type === 'bypass') this.bypass = m.value;
    else if (m.type === 'dispose') { this.alive = false; const old = this.head.setModel(null); if (old) old.destroy(); }
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return this.alive;
    const input = inputs[0] && inputs[0][0];
    if (this.bypass || !this.head.model) { out.fill(0); return this.alive; }
    const t0 = this.cpu.start();
    this.head.process(input || null, out, out.length);
    const stats = this.cpu.stop(t0, out.length);
    if (stats) { stats.type = 'stats'; this.port.postMessage(stats); }
    return this.alive;
  }
}
registerProcessor('rig-nam', RigNamProcessor);

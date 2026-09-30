// WebAudio realisations of each node type. Every wrapper exposes
//   inputs[]  / outputs[]  AudioNodes per port
//   analysers[]            one AnalyserNode per output port (levels, wire pulses)
//   apply(node)            push params/bypass from the document
//   stats                  last CPU report from its worklet (if any)
//   dispose()
import { dbToLin } from '../../worklets/dsp/util.js';
import { synthCabIR } from './ir.js';
import { insOf, outsOf, paramsOf } from '../graph/types.js';

const RAMP = 0.012; // s, bypass/param smoothing time constant

function analyser(ctx) { return new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 }); }
function setSmooth(param, value, ctx) { param.setTargetAtTime(value, ctx.currentTime, RAMP); }

class Base {
  constructor(engine, id, node) {
    this.engine = engine; this.ctx = engine.ctx; this.id = id; this.type = node.type;
    this.config = JSON.stringify(node.config || {});
    this.inputs = []; this.outputs = []; this.analysers = [];
    this.applied = {}; this.bypass = null; this.stats = null; this.status = 'ready';
  }
  _tapOutputs() { this.analysers = this.outputs.map((o) => { const a = analyser(this.ctx); o.connect(a); return a; }); }
  apply(node) {
    for (const [k, v] of Object.entries(node.params)) if (this.applied[k] !== v) { this.applied[k] = v; this.setParam(k, v, node); }
    if (this.bypass !== node.bypass) { this.bypass = node.bypass; this.setBypass(node.bypass); }
  }
  setParam() {}
  setBypass() {}
  dispose() { for (const n of [...this.inputs, ...this.outputs]) try { n.disconnect(); } catch {} }
}

/** One in, one out, with a dry path for click-free bypass. */
class Insert extends Base {
  constructor(engine, id, node) {
    super(engine, id, node);
    const ctx = this.ctx;
    this.inp = new GainNode(ctx); this.out = new GainNode(ctx);
    this.wet = new GainNode(ctx, { gain: 1 }); this.dry = new GainNode(ctx, { gain: 0 });
    this.inp.connect(this.dry).connect(this.out);
    this.wet.connect(this.out);
    this.inputs = [this.inp]; this.outputs = [this.out];
    this._tapOutputs();
  }
  setBypass(b) {
    setSmooth(this.wet.gain, b ? 0 : 1, this.ctx);
    setSmooth(this.dry.gain, b ? 1 : 0, this.ctx);
    if (this.proc?.port) {
      clearTimeout(this._bt);
      if (b) this._bt = setTimeout(() => this.proc.port.postMessage({ type: 'bypass', value: true }), 80);
      else this.proc.port.postMessage({ type: 'bypass', value: false });
    }
  }
  dispose() {
    super.dispose();
    if (this.proc) { this.proc.port?.postMessage({ type: 'dispose' }); try { this.proc.disconnect(); } catch {} }
    try { this.wet.disconnect(); this.dry.disconnect(); } catch {}
  }
}

export class FxNode extends Insert {
  constructor(engine, id, node, kind) {
    super(engine, id, node);
    const opts = { processorOptions: { kind, params: { ...node.params } }, numberOfInputs: 1, numberOfOutputs: 1 };
    if (kind === 'reverb') opts.outputChannelCount = [2];
    this.proc = new AudioWorkletNode(this.ctx, 'rig-fx', opts);
    this.applied = { ...node.params };
    this.proc.port.onmessage = (e) => {
      if (e.data.type === 'meter') this.fxMeter = e.data; // ~60 Hz: gr, cutoff, env, open
      else if (e.data.type === 'stats') this.stats = e.data;
    };
    this.fxMeter = null;
    this.inp.connect(this.proc).connect(this.wet);
    // Algorithmic latency, for the round-trip estimate.
    this.latencySamples = ['overdrive', 'bloom'].includes(kind) ? 32 : kind === 'limiter' ? Math.round(0.002 * this.ctx.sampleRate) - 1 : 0;
  }
  setParam(k, v) { this.proc.port.postMessage({ type: 'param', name: k, value: v }); }
}

export class NamNode extends Insert {
  constructor(engine, id, node) {
    super(engine, id, node);
    this.proc = new AudioWorkletNode(this.ctx, 'rig-nam', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { params: { ...node.params } },
    });
    this.applied = { ...node.params };
    this.proc.port.postMessage({ type: 'wasm', bytes: engine.wasmBytes });
    this.proc.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'stats') this.stats = m;
      else if (m.type === 'loaded') { this.status = 'ready'; this.loadInfo = m; this.engine.emit('node-status', { id }); }
      else if (m.type === 'error') { this.status = 'error'; this.error = m.message; this.engine.emit('node-status', { id }); console.error('NAM', id, m.message); }
      else if (m.type === 'log') console.info('NAM', id, m.line);
    };
    this.model = null;
    this.status = 'empty';
    this.inp.connect(this.proc).connect(this.wet);
  }
  setParam(k, v) { this.proc.port.postMessage({ type: 'param', name: k, value: v }); }
  async setModel(hash) {
    if (hash === this.model) return;
    this.model = hash;
    if (!hash) { this.status = 'empty'; return; }
    this.status = 'loading'; this.engine.emit('node-status', { id: this.id });
    const bytes = await this.engine.library.bytes(hash);
    if (this.model !== hash) return;
    if (!bytes) { this.status = 'missing'; this.engine.emit('node-status', { id: this.id }); return; }
    this.proc.port.postMessage({ type: 'model', hash, bytes: bytes.slice(0) });
  }
}

export class CabNode extends Insert {
  constructor(engine, id, node) {
    super(engine, id, node);
    const ctx = this.ctx;
    this.conv = new ConvolverNode(ctx, { disableNormalization: true });
    this.hp = new BiquadFilterNode(ctx, { type: 'highpass', Q: 0.7 });
    this.lp = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.7 });
    this.level = new GainNode(ctx);
    this.inp.connect(this.conv).connect(this.hp).connect(this.lp).connect(this.level).connect(this.wet);
    this.ir = null;
    this._regen(node);
  }
  _regen(node) {
    if (this.ir) return;
    const data = synthCabIR(this.ctx.sampleRate, node.params.voice, node.params.mic);
    const b = new AudioBuffer({ length: data.length, sampleRate: this.ctx.sampleRate, numberOfChannels: 1 });
    b.copyToChannel(data, 0);
    this.conv.buffer = b;
    this.irName = 'synthetic';
  }
  setParam(k, v, node) {
    if (k === 'voice' || k === 'mic') { clearTimeout(this._rt); this._rt = setTimeout(() => this._regen(node), 60); }
    else if (k === 'lowcut') setSmooth(this.hp.frequency, v, this.ctx);
    else if (k === 'highcut') setSmooth(this.lp.frequency, v, this.ctx);
    else if (k === 'level') setSmooth(this.level.gain, dbToLin(v), this.ctx);
  }
  async setIr(hash, node) {
    if (hash === this.ir) return;
    this.ir = hash || null;
    if (!hash) { this._regen(node); return; }
    const bytes = await this.engine.library.bytes(hash);
    if (!bytes) { this.status = 'missing'; this.ir = null; this._regen(node); return; }
    const buf = await this.ctx.decodeAudioData(bytes.slice(0));
    // normalise to unity energy-ish so real IRs land near the synthetic level
    let e = 0; for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) e += v * v;
    const g = 1 / Math.sqrt(e / buf.numberOfChannels || 1) * 0.25;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
    this.conv.buffer = buf;
    this.irName = node.ir && this.engine.doc?.irs?.[node.ir]?.name || 'custom';
  }
}

export class SplitterNode extends Base {
  constructor(engine, id, node) {
    super(engine, id, node);
    const ctx = this.ctx;
    this.inp = new GainNode(ctx);
    this.gains = []; this.pans = [];
    for (let i = 0; i < outsOf(node); i++) {
      const g = new GainNode(ctx), p = new StereoPannerNode(ctx);
      this.inp.connect(g).connect(p);
      this.gains.push(g); this.pans.push(p);
    }
    this.inputs = [this.inp]; this.outputs = this.pans;
    this._tapOutputs();
  }
  setParam(k, v) {
    const i = +k.replace(/\D/g, '');
    if (k.startsWith('level')) setSmooth(this.gains[i].gain, dbToLin(v), this.ctx);
    if (k.startsWith('pan')) setSmooth(this.pans[i].pan, v, this.ctx);
  }
}

export class MixerNode extends Base {
  constructor(engine, id, node) {
    super(engine, id, node);
    const ctx = this.ctx;
    this.master = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit' });
    this.gains = []; this.pans = [];
    for (let i = 0; i < insOf(node); i++) {
      const g = new GainNode(ctx), p = new StereoPannerNode(ctx);
      g.connect(p).connect(this.master);
      this.gains.push(g); this.pans.push(p);
    }
    this.inputs = this.gains; this.outputs = [this.master];
    this._tapOutputs();
  }
  setParam(k, v) {
    if (k === 'master') return setSmooth(this.master.gain, dbToLin(v), this.ctx);
    const i = +k.replace(/\D/g, '');
    if (k.startsWith('level')) setSmooth(this.gains[i].gain, dbToLin(v), this.ctx);
    if (k.startsWith('pan')) setSmooth(this.pans[i].pan, v, this.ctx);
  }
}

export class InputNode extends Base {
  constructor(engine, id, node) {
    super(engine, id, node);
    const ctx = this.ctx;
    this.out = new GainNode(ctx);
    this.diGain = new GainNode(ctx); this.diGain.connect(this.out);
    this.liveGain = new GainNode(ctx, { gain: 0 }); this.liveGain.connect(this.out);
    // Transport input gain (engine-wide, not saved in the preset), after the
    // node's own gain. Its output also feeds the engine's dry bus for A/B.
    this.trim = new GainNode(ctx, { gain: engine.inputTrim ?? 1 });
    this.out.connect(this.trim);
    if (engine.dryBus) this.trim.connect(engine.dryBus);
    this.outputs = [this.trim];
    this._tapOutputs();
    this.src = null; this.srcGain = null; this.live = null;
  }
  /** Start the DI loop (from the top). Crossfades out a source already playing. */
  startDi({ restart = false } = {}) {
    if (!this.engine.diBuffer) return;
    if (this.src && !restart && this.src.buffer === this.engine.diBuffer) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (this.src) {
      const old = this.src, og = this.srcGain;
      og.gain.setTargetAtTime(0, t, 0.004);
      try { old.stop(t + 0.03); } catch {}
      old.onended = () => { try { og.disconnect(); } catch {} };
    }
    this.srcGain = new GainNode(ctx, { gain: this.src ? 0 : 1 });
    if (this.src) this.srcGain.gain.setTargetAtTime(1, t, 0.004);
    this.srcGain.connect(this.diGain);
    this.src = new AudioBufferSourceNode(ctx, { buffer: this.engine.diBuffer, loop: true });
    this.src.connect(this.srcGain);
    this.src.start(t);
  }
  setTrim(g) { setSmooth(this.trim.gain, g, this.ctx); }
  async _live(channel) {
    if (!this.live) {
      const stream = await this.engine.getInputStream();
      const srcNode = new MediaStreamAudioSourceNode(this.ctx, { mediaStream: stream });
      const split = new ChannelSplitterNode(this.ctx, { numberOfOutputs: 2 });
      const pick = new GainNode(this.ctx, { channelCount: 1, channelCountMode: 'explicit' });
      srcNode.connect(split);
      this.live = { stream, srcNode, split, pick, ch: null };
      pick.connect(this.liveGain);
    }
    const L = this.live;
    if (L.ch === channel) return;
    try { L.split.disconnect(); } catch {}
    try { L.srcNode.disconnect(L.split); } catch {}
    if (channel === 2) { L.srcNode.connect(L.pick); }
    else { L.srcNode.connect(L.split); L.split.connect(L.pick, channel); }
    L.ch = channel;
  }
  setParam(k, v, node) {
    if (k === 'gain') setSmooth(this.out.gain, dbToLin(v), this.ctx);
    if (k === 'source' || k === 'channel') {
      const live = Math.round(node.params.source) === 1;
      if (live) {
        this._live(Math.round(node.params.channel)).then(() => {
          setSmooth(this.liveGain.gain, 1, this.ctx); setSmooth(this.diGain.gain, 0, this.ctx);
          this.status = 'ready'; this.engine.emit('node-status', { id: this.id });
        }).catch((e) => { this.status = 'error'; this.error = e.message; this.engine.emit('node-status', { id: this.id }); });
      } else {
        this.startDi();
        setSmooth(this.liveGain.gain, 0, this.ctx); setSmooth(this.diGain.gain, 1, this.ctx);
      }
    }
  }
  dispose() {
    super.dispose();
    try { this.src?.stop(); } catch {}
    try { this.trim.disconnect(); } catch {}
    this.live?.stream.getTracks().forEach((t) => t.stop());
  }
}

export class OutputNode extends Base {
  constructor(engine, id, node) {
    super(engine, id, node);
    this.inp = new GainNode(this.ctx, { channelCount: 2, channelCountMode: 'explicit' });
    this.inp.connect(engine.rigBus || engine.masterBus);
    this.inputs = [this.inp];
    this.analysers = [];
    this.meter = analyser(this.ctx); this.inp.connect(this.meter);
  }
  setParam(k, v) { if (k === 'volume') setSmooth(this.inp.gain, dbToLin(v), this.ctx); }
}

export function createNode(engine, id, node) {
  switch (node.type) {
    case 'input': return new InputNode(engine, id, node);
    case 'output': return new OutputNode(engine, id, node);
    case 'nam': return new NamNode(engine, id, node);
    case 'cab': return new CabNode(engine, id, node);
    case 'splitter': return new SplitterNode(engine, id, node);
    case 'mixer': return new MixerNode(engine, id, node);
    default: return new FxNode(engine, id, node, node.type);
  }
}
export { paramsOf };

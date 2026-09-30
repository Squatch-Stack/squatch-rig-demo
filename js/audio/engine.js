// Audio engine: owns the AudioContext and reconciles a WebAudio graph against
// the pipeline document (create/dispose nodes, push params, diff the edge set
// so only changed connections are touched).
import { createNode } from './nodes.js';
import { typeOf } from '../graph/types.js';
import { createMeters, applyFrame, decayMeters, fillInputs, motionOf } from './meters.js';
import { encodeWav } from './wav.js';
import { dbToLin } from '../../worklets/dsp/util.js';

const ASSET = (p) => new URL(`../../${p}`, import.meta.url);

export class Engine extends EventTarget {
  constructor(library) {
    super();
    this.library = library;
    this.nodes = new Map();
    this.conns = new Map(); // key -> { from, fp, to, tp }
    this.levels = new Map(); // `${id}:${port}` -> { rms, peak }
    this.scratch = new Float32Array(1024);
    this.inputDeviceId = null;
    this.capacity = null;
    this.master = { rms: 0, peak: 0 };
    // Transport state (engine-wide, not part of the preset).
    this.meters = createMeters(); // the documented metering object, see meters.js
    this.loops = []; this.loopId = null; this.loopBuffers = new Map();
    this.inputTrim = 1; this.masterLevel = 1; this.bypassed = false; this.dryMakeupDb = 1.5;
    this.tapAcc = { peak: 0, ss: 0, n: 0, clips: 0 };
    this.tapStats = { quanta: 0, frame: 0, meterMsgs: 0 };
    this.recording = null;
    this.synced = new Promise((r) => { this._resolveSynced = r; }); // first sync() done
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /**
   * Create the AudioContext synchronously. Call this inside a user gesture
   * (with ctx.resume()) so the first click plays in Safari as well as Chrome.
   */
  ensureContext({ sampleRate = 48000, latencyHint = 'interactive' } = {}) {
    if (!this.ctx) {
      // iOS/macOS Safari: play through the ringer switch like a media app.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not WebKit */ }
      this.ctx = new AudioContext({ sampleRate, latencyHint });
      // Some browsers (headless Chrome, or a site with high media engagement)
      // start a context already running. Nothing plays until Play is pressed.
      if (this.ctx.state === 'running' && !this.playRequested) this.ctx.suspend();
    }
    return this.ctx;
  }

  /** Pass `context` to render into an OfflineAudioContext (tests, benchmarks). */
  /** `loop`: DI loop id to start on; `diUrl`: a WAV to use instead of the loops (parity checks). */
  async init({ sampleRate = 48000, latencyHint = 'interactive', context = null, loop = null, diUrl = null } = {}) {
    this.ctx = context || this.ensureContext({ sampleRate, latencyHint });
    await Promise.all([
      this.ctx.audioWorklet.addModule(ASSET('worklets/fx-processor.js')),
      this.ctx.audioWorklet.addModule(ASSET('worklets/nam-processor.js')),
      this.ctx.audioWorklet.addModule(ASSET('worklets/tap-processor.js')),
    ]);
    const [wasm, loops] = await Promise.all([
      fetch(ASSET('wasm/nam.wasm')).then((r) => r.arrayBuffer()),
      fetch(ASSET('audio/loops/index.json')).then((r) => r.json()).then((j) => j.loops).catch(() => []),
    ]);
    this.wasmBytes = wasm;
    this.loops = loops;
    const first = loops.find((l) => l.id === loop) || loops[0];
    this.diBuffer = diUrl || !first ? await this._decode(diUrl ? new URL(diUrl, location.href) : ASSET('audio/di-loop.wav')) : await this._loopBuffer(first.id);
    this.loopId = diUrl || !first ? null : first.id;
    this.meters.loop = this.loopId;
    // Master section:  output nodes -> rigBus ─┐
    //                  input trims  -> dryBus ─┴-> masterBus (level) -> tap -> destination
    const ctx = this.ctx;
    this.rigBus = new GainNode(ctx, { gain: this.bypassed ? 0 : 1 });
    this.dryBus = new GainNode(ctx, { gain: this.bypassed ? dbToLin(this.dryMakeupDb) : 0, channelCount: 2, channelCountMode: 'explicit' });
    this.masterBus = new GainNode(ctx, { gain: this.masterLevel });
    this.rigBus.connect(this.masterBus); this.dryBus.connect(this.masterBus);
    this.tap = new AudioWorkletNode(ctx, 'rig-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    this.tap.port.onmessage = (e) => this._onTap(e.data);
    this.masterBus.connect(this.tap).connect(ctx.destination);
    this.masterMeter = new AnalyserNode(ctx, { fftSize: 2048 });
    this.masterBus.connect(this.masterMeter);
    if (!context) { this._watchCapacity(); this._startMeterLoop(); }
    this.ready = true;
    this.emit('ready');
    return this;
  }

  async _decode(url) { return this.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()); }
  async _loopBuffer(id) {
    if (!this.loopBuffers.has(id)) {
      const l = this.loops.find((x) => x.id === id);
      if (!l) throw new Error(`no loop ${id}`);
      this.loopBuffers.set(id, this._decode(ASSET(l.file)));
    }
    return this.loopBuffers.get(id);
  }

  // ---------------------------------------------------------------- transport
  _inputs() { return [...this.nodes.values()].filter((n) => n.type === 'input'); }
  /** Switch the DI loop; playback restarts from the top of the new loop. */
  async setLoop(id) {
    const buf = await this._loopBuffer(id);
    this.diBuffer = buf; this.loopId = id; this.meters.loop = id;
    for (const n of this._inputs()) if (n.src) n.startDi({ restart: true });
    this.emit('transport');
  }
  /** Audition a user-selected DI WAV without uploading or saving it in a preset. */
  async setLocalDi(file) {
    if (!file || !/\.wav$/i.test(file.name) || file.size > 64 * 1024 * 1024 || !file.size) {
      throw new Error('Choose a WAV file smaller than 64 MB');
    }
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    if (!buf.length || buf.duration > 600) throw new Error('Choose a nonempty DI take under 10 minutes');
    this.loopBuffers.delete('local-di');
    this.loopBuffers.set('local-di', Promise.resolve(buf));
    this.loops = this.loops.filter((l) => l.id !== 'local-di');
    this.loops.push({ id: 'local-di', title: file.name, kind: 'your DI', local: true });
    await this.setLoop('local-di');
  }
  /** Rewind the DI loop to its start (Play after Stop starts from the top). */
  restartLoop() { for (const n of this._inputs()) if (n.src) n.startDi({ restart: true }); }
  /** Transport input gain in dB, applied after every input node. */
  setInputGain(db) {
    this.inputTrim = dbToLin(db);
    for (const n of this._inputs()) n.setTrim(this.inputTrim);
    this.emit('transport');
  }
  /** Master level in dB, the last gain before the tap and the output. */
  setMasterLevel(db) {
    this.masterLevel = dbToLin(db);
    if (this.masterBus) this.masterBus.gain.setTargetAtTime(this.masterLevel, this.ctx.currentTime, 0.012);
    this.emit('transport');
  }
  /**
   * A/B: true plays the dry DI (post input gain, plus `dryMakeupDb` so the two
   * are roughly level-matched) instead of the rig. The rig keeps running, so
   * switching back is instant. 5 ms crossfade.
   */
  setBypass(on) {
    this.bypassed = !!on; this.meters.bypassed = this.bypassed;
    if (this.rigBus) {
      const t = this.ctx.currentTime;
      this.rigBus.gain.setTargetAtTime(on ? 0 : 1, t, 0.005);
      this.dryBus.gain.setTargetAtTime(on ? dbToLin(this.dryMakeupDb) : 0, t, 0.005);
    }
    this.emit('transport');
  }

  // ---------------------------------------------------------------- recording
  /** Arm the tap: everything reaching the output from now on is captured. */
  startRecording({ maxSeconds = 600 } = {}) {
    if (this.recording || !this.tap) return;
    this.recording = { chunks: [], frames: 0, max: maxSeconds * this.ctx.sampleRate, done: null };
    this.meters.recording = true;
    this.tap.port.postMessage({ type: 'record', on: true });
    this.emit('transport');
  }
  get recordedSeconds() { return this.recording ? this.recording.frames / this.ctx.sampleRate : 0; }
  /** Disarm and return the take as a 24-bit stereo WAV Blob. */
  stopRecording() {
    const rec = this.recording;
    if (!rec) return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.done = () => {
        const L = new Float32Array(rec.frames), R = new Float32Array(rec.frames);
        let o = 0;
        for (const c of rec.chunks) { L.set(c.L.subarray(0, c.n), o); R.set(c.R.subarray(0, c.n), o); o += c.n; }
        this.recording = null; this.meters.recording = false;
        this.emit('transport');
        resolve(new Blob([encodeWav([L, R], this.ctx.sampleRate, { format: 'pcm24' })], { type: 'audio/wav' }));
      };
      this.tap.port.postMessage({ type: 'record', on: false });
      // A suspended context never answers; finish with what has arrived.
      if (this.ctx.state !== 'running') setTimeout(() => rec.done && rec.done(), 0);
    });
  }
  _onTap(m) {
    if (m.type === 'meter') {
      const a = this.tapAcc;
      a.peak = Math.max(a.peak, m.peakL, m.peakR); a.ss += (m.sumsqL + m.sumsqR) / 2; a.n += m.n; a.clips += m.clips;
      this.tapStats.quanta = m.quanta; this.tapStats.frame = m.frame; this.tapStats.meterMsgs++;
    } else if (m.type === 'chunk' && this.recording) {
      const rec = this.recording;
      rec.chunks.push(m); rec.frames += m.n;
      if (rec.frames >= rec.max) this.emit('record-limit');
    } else if (m.type === 'recstop' && this.recording?.done) {
      const d = this.recording.done; this.recording.done = null; d();
    }
  }

  // ---------------------------------------------------------------- meters (~60 Hz)
  _startMeterLoop() {
    let last = performance.now();
    const tick = () => {
      const now = performance.now(), dt = Math.min(0.25, (now - last) / 1000); last = now;
      if (!this.replaying) this.updateMeters(dt);
      schedule();
    };
    const schedule = () => {
      if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) requestAnimationFrame(tick);
      else setTimeout(tick, 16);
    };
    schedule();
  }
  /** Build one metering frame from the analysers, fx worklets and the tap. */
  _frame() {
    const nodes = {};
    for (const [id, n] of this.nodes) {
      const ports = (n.analysers.length ? n.analysers : n.meter ? [n.meter] : []).map((_, p) => this.level(id, p));
      const fm = n.bypass ? null : n.fxMeter;
      nodes[id] = { type: n.type, ports: ports.length ? ports : [{ rms: 0, peak: 0 }], gr: fm?.gr || 0, cutoff: fm?.cutoff ?? null, open: fm?.open ?? null, bloom: fm?.bloom ?? null, pick: fm?.pick ?? null };
    }
    const a = this.tapAcc;
    const master = a.n ? { rms: Math.sqrt(a.ss / a.n), peak: a.peak, clips: a.clips } : { rms: this.master.rms, peak: this.master.peak, clips: 0 };
    this.tapAcc = { peak: 0, ss: 0, n: 0, clips: 0 };
    const frame = { time: this.ctx.currentTime, master, nodes };
    return this.doc ? fillInputs(frame, this.doc) : frame;
  }
  /** Per-node motion values for the UI (web/js/ui/motion.js hook); null when unknown. */
  motion(id) { return this.meters.running ? motionOf(this.meters, id) : null; }
  updateMeters(dt = 1 / 60) {
    if (!this.ctx) return;
    const running = this.ctx.state === 'running';
    this.meters.running = running;
    if (running) { this.pollLevels(true); applyFrame(this.meters, this._frame(), dt); }
    else decayMeters(this.meters, dt);
    this.emit('meters', this.meters);
  }
  /**
   * Drive the meters (and engine.level()) from a precomputed frame instead of
   * the live analysers: used by tools/reel.mjs so the picture follows the
   * offline render sample-accurately. Pass null to return to live metering.
   */
  replay(frame, dt = 1 / 30) {
    if (!frame) { this.replaying = false; return; }
    this.replaying = true;
    for (const [id, f] of Object.entries(frame.nodes)) f.ports.forEach((p, i) => this.levels.set(`${id}:${i}`, { rms: p.rms, peak: p.peak }));
    this.master = { rms: frame.master.rms, peak: frame.master.peak };
    this.meters.running = true;
    applyFrame(this.meters, frame, dt);
    this.emit('meters', this.meters);
  }
  /** Chrome's AudioContext.playbackStats (underruns), where available. */
  playbackStats() {
    const ps = this.ctx?.playbackStats;
    if (!ps) return null;
    const j = typeof ps.toJSON === 'function' ? ps.toJSON() : ps;
    return { underrunEvents: j.underrunEvents, underrunDuration: j.underrunDuration, totalDuration: j.totalDuration, averageLatency: j.averageLatency, maximumLatency: j.maximumLatency };
  }

  _watchCapacity() {
    // Chrome's AudioContext.renderCapacity (where shipped) reports the whole
    // render thread's load, including native nodes the worklets cannot see.
    const rc = this.ctx.renderCapacity;
    if (!rc || typeof rc.start !== 'function') return;
    try {
      rc.addEventListener('update', (e) => { this.capacity = { average: e.averageLoad, peak: e.peakLoad, underruns: e.underrunRatio }; });
      rc.start({ updateInterval: 1 });
    } catch { /* not available */ }
  }

  /** Resolves when every NAM node has its model loaded (or failed). */
  whenModelsLoaded(timeoutMs = 20000) {
    const pending = () => [...this.nodes.values()].filter((n) => n.type === 'nam' && n.model && n.status === 'loading' || (n.type === 'nam' && n.model && n.status === 'empty'));
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const check = () => { if (!pending().length) res(); else if (Date.now() - t0 > timeoutMs) rej(new Error('model load timeout')); else setTimeout(check, 50); };
      check();
    });
  }

  async resume() { this.playRequested = true; if (this.ctx.state !== 'running') await this.ctx.resume(); }
  async suspend() { if (this.ctx.state === 'running') await this.ctx.suspend(); }

  async getInputStream() {
    if (this.stream) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.inputDeviceId ? { exact: this.inputDeviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 }, sampleRate: { ideal: this.ctx.sampleRate }, latency: { ideal: 0 },
      },
    });
    this.emit('devices');
    return this.stream;
  }
  async setInputDevice(deviceId) {
    this.inputDeviceId = deviceId || null;
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    // Rebuild live inputs on next sync.
    for (const [id, n] of this.nodes) if (n.type === 'input' && n.live) { n.dispose(); this.nodes.delete(id); this._dropConns(id); }
    if (this.doc) this.sync(this.doc);
  }
  async setOutputDevice(deviceId) {
    if (typeof this.ctx.setSinkId !== 'function') throw new Error('setSinkId not supported in this browser');
    await this.ctx.setSinkId(deviceId || '');
  }

  _dropConns(id) { for (const [k, c] of this.conns) if (c.from === id || c.to === id) this.conns.delete(k); }

  /** Reconcile the WebAudio graph with `doc`. Cheap when nothing changed. */
  sync(doc) {
    this.doc = doc;
    for (const [id, n] of this.nodes) {
      const dn = doc.nodes[id];
      if (!dn || dn.type !== n.type || JSON.stringify(dn.config || {}) !== n.config) {
        for (const [k, c] of this.conns) if (c.from === id || c.to === id) { this._disconnect(c); this.conns.delete(k); }
        n.dispose(); this.nodes.delete(id);
      }
    }
    for (const [id, dn] of Object.entries(doc.nodes)) {
      let n = this.nodes.get(id);
      if (!n) { n = createNode(this, id, dn); this.nodes.set(id, n); }
      n.apply(dn);
      if (dn.type === 'nam') n.setModel(dn.model || null);
      if (dn.type === 'cab') n.setIr(dn.ir || null, dn);
    }
    const want = new Map();
    for (const e of Object.values(doc.edges)) want.set(`${e.from[0]}:${e.from[1]}>${e.to[0]}:${e.to[1]}`, { from: e.from[0], fp: e.from[1], to: e.to[0], tp: e.to[1] });
    for (const [k, c] of this.conns) if (!want.has(k)) { this._disconnect(c); this.conns.delete(k); }
    for (const [k, c] of want) {
      if (this.conns.has(k)) continue;
      const a = this.nodes.get(c.from), b = this.nodes.get(c.to);
      if (!a || !b || !a.outputs[c.fp] || !b.inputs[c.tp]) continue;
      a.outputs[c.fp].connect(b.inputs[c.tp]);
      this.conns.set(k, c);
    }
    this._resolveSynced();
  }
  _disconnect(c) {
    const a = this.nodes.get(c.from), b = this.nodes.get(c.to);
    try { a?.outputs[c.fp]?.disconnect(b?.inputs[c.tp]); } catch { /* already gone */ }
  }

  /** Update cached levels for every output port (call once per UI frame; cheap if called twice). */
  pollLevels(force = false) {
    if (!this.masterMeter || this.replaying) return;
    const now = performance.now();
    if (!force && now - (this._polled || 0) < 5) return;
    this._polled = now;
    const buf = this.scratch;
    for (const [id, n] of this.nodes) {
      const list = n.analysers.length ? n.analysers : n.meter ? [n.meter] : [];
      list.forEach((a, port) => {
        a.getFloatTimeDomainData(buf);
        let s = 0, p = 0;
        for (let i = 0; i < buf.length; i++) { const v = buf[i]; s += v * v; const av = v < 0 ? -v : v; if (av > p) p = av; }
        this.levels.set(`${id}:${port}`, { rms: Math.sqrt(s / buf.length), peak: p });
      });
    }
    const m = new Float32Array(this.masterMeter.fftSize);
    this.masterMeter.getFloatTimeDomainData(m);
    let s = 0, p = 0; for (const v of m) { s += v * v; p = Math.max(p, Math.abs(v)); }
    this.master = { rms: Math.sqrt(s / m.length), peak: p };
  }
  level(id, port = 0) { return this.levels.get(`${id}:${port}`) || { rms: 0, peak: 0 }; }

  /** Sum of worklet render time as a fraction of the render-quantum budget. */
  cpu() {
    let us = 0, budget = (128 / this.ctx.sampleRate) * 1e6, precise = true;
    const per = {};
    for (const [id, n] of this.nodes) {
      if (!n.stats || n.bypass) continue;
      us += n.stats.cpuUs; per[id] = n.stats.cpuUs; budget = n.stats.budgetUs; precise &&= n.stats.precise;
    }
    return { us, budget, fraction: us / budget, per, precise, capacity: this.capacity };
  }

  /** Round-trip latency estimate: input + output device latency + longest algorithmic path. */
  latency() {
    const sr = this.ctx.sampleRate;
    const base = this.ctx.baseLatency || 0;
    const out = this.ctx.outputLatency || 0;
    let input = null;
    const track = this.stream?.getAudioTracks?.()[0];
    const st = track?.getSettings?.();
    if (st && typeof st.latency === 'number') input = st.latency;
    // longest path (samples) through the DAG
    const doc = this.doc, memo = new Map();
    const own = (id) => { const n = this.nodes.get(id); return n && !n.bypass && n.latencySamples ? n.latencySamples : 0; };
    const longest = (id, seen = new Set()) => {
      if (memo.has(id)) return memo.get(id);
      if (seen.has(id)) return 0; seen.add(id);
      let m = 0;
      for (const e of Object.values(doc?.edges || {})) if (e.to[0] === id) m = Math.max(m, longest(e.from[0], seen));
      const v = m + own(id); memo.set(id, v); return v;
    };
    let algo = 0;
    for (const [id, dn] of Object.entries(doc?.nodes || {})) if (typeOf(dn) && dn.type === 'output') algo = Math.max(algo, longest(id));
    const quantum = 128 / sr;
    return { base, output: out, input, algorithmic: algo / sr, quantum, roundTrip: (input ?? 0) + base + out + algo / sr + quantum, inputKnown: input != null };
  }
}

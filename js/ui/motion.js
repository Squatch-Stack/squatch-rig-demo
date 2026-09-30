// Audio -> motion. Turns what the audio engine measures into the handful of
// per-device quantities the brush layer draws, with the ballistics from
// design/DIRECTION.md section 6 (the eye needs a longer release than the ear).
// The UI never computes DSP: every number here is a meter reading or a
// parameter, smoothed.
//
// ------------------------------------------------------------ MOTION HOOK
// Interface for the audio side (web/js/audio/meters.js implements it; see its contract):
//
//   engine.motion?.(nodeId) -> { rms, peak, inRms, inPeak, env, grDb, cutoff, clip } | null
//
// all linear amplitudes except grDb (dB, >= 0) and cutoff (Hz); `clip` is true
// when the window clipped. Where the engine provides it, it replaces the
// fallbacks below field by field; without it (an older engine, or a test
// double) the feed derives the same quantities from:
//   - engine.level(id, port): AnalyserNode rms/peak per output port, polled once per frame
//   - engine.nodes.get(id).stats.grDb / .cutoff: worklet reports, every 16 quanta (~23 Hz)
//   - node parameters (threshold, ratio, drive, decay...) for the curve shapes
// ------------------------------------------------------------------------
import { motionReduced } from './theme.js';

const EPS = 0.01; // below this nothing visible changes
const dB = (x) => 20 * Math.log10(Math.max(x, 1e-6));
export const dbNorm = (x) => Math.max(0, Math.min(1, (dB(x) + 60) / 60));
const follow = (y, x, dt, atk, rel) => {
  const v = y + (x - y) * (1 - Math.exp(-dt / Math.max(1e-3, x > y ? atk : rel)));
  return x === 0 && v < EPS ? 0 : v; // settle exactly, so an idle rig stops drawing
};

function fresh() {
  return { vis: 0, env: 0, inN: 0, inLin: 0, gr: 0, grN: 0, clip: 0, cutN: 0, tail: 0, onset: 9, outs: [0, 0, 0, 0], ins: [0, 0, 0, 0], open: 0, slow: 0, pick: 0, sus: 0 };
}

export class MotionFeed {
  constructor(engine, store) {
    this.engine = engine; this.store = store;
    this.state = new Map();
    this.stepAcc = 0;
    this.active = false;
    this.reduced = motionReduced();
  }

  node(id) { return this.state.get(id) || fresh(); }
  /** visual energy on the cable leaving (id, port) */
  edge(fromId, port) { const s = this.state.get(fromId); return s ? s.outs[port] ?? 0 : 0; }

  /** Advance one UI frame. Returns true while anything is visibly moving. */
  update(dt, running) {
    const eng = this.engine, doc = this.store.doc;
    this.reduced = motionReduced();
    const hook = typeof eng?.motion === 'function' ? eng.motion.bind(eng) : null;
    // reduced motion: sample at 4 Hz, quantise, no easing
    if (this.reduced) {
      this.stepAcc += dt;
      if (this.stepAcc < 0.25) return false; // nothing changes between 4 Hz steps, so nothing needs drawing
      this.stepAcc = 0;
    }
    if (this.reduced) dt = 0.25;
    const q = (v) => (this.reduced ? Math.round(v * 12) / 12 : v);
    const ease = (y, x, atk, rel) => (this.reduced ? q(x) : follow(y, x, dt, atk, rel));

    const incoming = new Map();
    for (const e of Object.values(doc.edges)) {
      const lv = running ? eng.level(e.from[0], e.from[1]) : { rms: 0, peak: 0 };
      const cur = incoming.get(e.to[0]) || { rms: 0, peak: 0, ports: [] };
      cur.rms = Math.max(cur.rms, lv.rms); cur.peak = Math.max(cur.peak, lv.peak);
      cur.ports[e.to[1]] = Math.max(cur.ports[e.to[1]] || 0, lv.rms);
      incoming.set(e.to[0], cur);
    }

    let active = false;
    for (const id of this.state.keys()) if (!doc.nodes[id]) this.state.delete(id);
    for (const [id, n] of Object.entries(doc.nodes)) {
      let s = this.state.get(id);
      if (!s) { s = fresh(); this.state.set(id, s); }
      const h = running && hook ? hook(id) : null;
      const en = eng?.nodes?.get(id);
      const out0 = running ? eng.level(id, 0) : { rms: 0, peak: 0 };
      const inc = incoming.get(id) || { rms: 0, peak: 0, ports: [] };
      const inRms = h?.inRms ?? (n.type === 'input' ? out0.rms : inc.rms);
      const inPeak = h?.inPeak ?? (n.type === 'input' ? out0.peak : inc.peak);
      const outRms = h?.rms ?? out0.rms, outPeak = h?.peak ?? out0.peak;
      const live = running && !n.bypass;

      s.vis = ease(s.vis, live ? dbNorm(outRms) : 0, 0.015, 0.28);
      s.env = ease(s.env, live ? dbNorm(inPeak) : 0, 0.005, 0.12);
      s.inN = ease(s.inN, live ? dbNorm(inRms) : 0, 0.015, 0.2);
      s.inLin = live ? Math.max(inPeak, s.inLin * Math.exp(-dt / 0.12)) : 0;
      for (let p = 0; p < 4; p++) {
        const lv = running && p > 0 ? eng.level(id, p) : p === 0 ? out0 : { rms: 0 };
        s.outs[p] = ease(s.outs[p], running ? dbNorm(lv.rms) : 0, 0.015, 0.28);
        s.ins[p] = ease(s.ins[p], running ? dbNorm(inc.ports[p] || 0) : 0, 0.015, 0.28);
      }

      // gain reduction (compressor, limiter): the worklet's own detector, else a static-curve estimate
      let grT = 0;
      if (live && (n.type === 'compressor' || n.type === 'limiter')) {
        grT = h?.grDb ?? en?.stats?.grDb;
        if (grT == null && n.type === 'compressor') {
          const over = dB(inRms) + 3 - (n.params.threshold ?? -24);
          grT = Math.max(0, over) * (1 - 1 / Math.max(1, n.params.ratio ?? 4));
        }
        grT = Math.max(0, grT || 0);
      }
      s.gr = ease(s.gr, grT, 0.01, 0.15);
      if (grT === 0 && s.gr < 0.05) s.gr = 0;
      s.grN = Math.min(1, s.gr / 12);

      // clipping: pressed like a seal, 450 ms fade (reduced motion: held flat for 1 s)
      let clipped = !!h?.clip;
      if (live && !clipped) {
        if (n.type === 'overdrive') clipped = inPeak * (1 + 7 * (n.params.drive ?? 0.5)) > 1.8;
        else if (n.type === 'nam') clipped = inPeak * 10 ** ((n.params.input ?? 0) / 20) > 0.75;
        else if (n.type === 'output') clipped = outPeak > 0.98;
        else if (n.type === 'limiter') clipped = s.gr > 4;
      }
      if (clipped) { s.clip = 1; s.clipHold = 1; }
      else if (this.reduced) { s.clipHold = Math.max(0, (s.clipHold || 0) - 0.25); s.clip = s.clipHold > 0 ? 1 : 0; }
      else s.clip = Math.max(0, s.clip - dt / 0.45);

      // envelope filter: the swept cutoff, as a fraction of its lo..hi range
      if (n.type === 'envfilter') {
        const lo = n.params.lo ?? 300, hi = n.params.hi ?? 3000;
        const c = h?.cutoff ?? en?.stats?.cutoff;
        const t = c ? Math.log(c / lo) / Math.log(hi / lo) : s.env * Math.max(0, Math.min(1, ((n.params.sens ?? 18) + 12) / 48));
        s.cutN = ease(s.cutN, live ? Math.max(0, Math.min(1, t)) : 0, 0.01, 0.08);
      }
      // reverb: the tail releases over the decay time; an onset restarts the echoes
      if (n.type === 'reverb') {
        const decay = Math.max(0.3, Math.min(8, n.params.decay ?? 2));
        const prev = s.envPrev ?? 0;
        if (s.env - prev > 0.08) s.onset = 0; else s.onset += dt / decay;
        s.envPrev = s.env;
        s.tail = ease(s.tail, live ? dbNorm(outRms) : 0, 0.04, decay * 0.4);
      }
      // Bloom: the pick is the pedal's own onset guard (the clean transient it
      // holds in front); `sus` is the drive share times the note's level, so the
      // sheaf opens as the note sustains and closes as it dies. Without worklet
      // meters, the same fast/slow detector runs here on the input envelope.
      if (n.type === 'bloom') {
        s.slow = ease(s.slow, live ? dbNorm(inPeak) : 0, 0.085, 0.19);
        const touch = n.params.touch ?? 0.7, amount = n.params.bloom ?? 0.7;
        // the DSP's guard idles near 0.25 on a held note (its 3 ms detector rides the waveform): below 0.3 is no pick
        const guard = h?.pick ?? Math.min(1, Math.max(0, s.env - s.slow) / Math.max(s.env, 0.05) * touch * 1.65);
        const pickT = live ? Math.max(0, (guard - 0.3) / 0.7) : 0;
        const mixT = h?.bloom ?? Math.max(0.05, Math.min(1, amount * (1 - 0.85 * guard)));
        s.pick = ease(s.pick, pickT, 0.004, 0.09);
        // full open at a typical held note: drive share relative to 0.75, level over -48..-12 dB RMS
        const lvl = Math.max(0, Math.min(1, (dB(inRms) + 48) / 36));
        s.sus = ease(s.sus, live ? Math.min(1, mixT / 0.75) * lvl : 0, 0.085, 0.35);
      }
      if (n.type === 'gate') s.open = ease(s.open, live && dB(inPeak) > (n.params.threshold ?? -60) ? 1 : 0, 0.003, 0.08);

      active ||= s.vis > EPS || s.env > EPS || s.clip > EPS || s.tail > EPS || s.gr > 0.05 || s.sus > EPS || s.pick > EPS;
    }
    this.active = active;
    return active;
  }
}

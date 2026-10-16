// The metering interface the UI drives motion from. Pure JS (no WebAudio), so
// the live engine, the offline renderer and the demo-reel replay all produce
// identical values from identical inputs.
//
// ── Contract (stable; additive changes only) ─────────────────────────────────
//
//   engine.meters                       one object, updated in place ~60 Hz
//   engine.addEventListener('meters', (e) => e.detail === engine.meters)
//
// Treat it as read-only. Its identity never changes, so it is safe to keep a
// reference. Every level is linear full scale (1.0 = 0 dBFS) unless the key ends
// in Db.
//
//   {
//     version: 1,
//     seq,            increments on every update
//     time,           AudioContext time (s) the values describe
//     running,        the context is running (audio is flowing)
//     bypassed,       A/B: the dry DI is being heard instead of the rig
//     recording,      the Record tap is armed
//     loop,           id of the DI loop playing (null when the source is live)
//     master: { rms, peak, rmsDb, peakDb, env, clip, clipHold, clips }
//     nodes: {
//       [nodeId]: {
//         type,               pipeline node type ('nam', 'compressor', ...)
//         rms, peak,          output port 0 over the last ~21 ms (1024 samples)
//         rmsDb, peakDb,
//         inRms, inPeak,      loudest signal arriving at its inputs (max over
//                             the wires feeding it; the DI level for inputs)
//         env,                0..1 motion envelope: rms mapped -60..0 dB, 15 ms
//                             attack, 250 ms release (smooth enough to animate)
//         gr,                 gain reduction in dB, >= 0 (compressor, limiter,
//                             gate; 0 elsewhere)
//         cutoff,             Hz for the env filter, else null
//         open,               gate state, else null
//         bloom, pick,        Bloom only: drive share 0..1 and pick guard 0..1, else null
//         clip,               this window reached 0 dBFS (|x| >= 0.999)
//         clipHold,           true for 1 s after any clip (for a clip LED)
//         ports: [{ rms, peak }]   every output port (splitters have several)
//       }
//     }
//   }
//
//   engine.motion(nodeId) -> { rms, peak, inRms, inPeak, env, grDb, cutoff, clip, bloom, pick } | null
//     the per-node view of the same record, in the shape web/js/ui/motion.js
//     asks for (grDb = gr).
//
// master.* comes from the tap worklet, which sees every sample at the very
// end of the chain (true sample peak, clips = clipped samples since start).
// The node values come from one AnalyserNode per output port.

export const METER_FLOOR_DB = -60;
const ATTACK_S = 0.015, RELEASE_S = 0.25, CLIP_HOLD_S = 1, CLIP = 0.999;

export const toDb = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);
/** rms (linear) -> 0..1 on a -60..0 dB scale. */
export const levelNorm = (x) => Math.max(0, Math.min(1, (toDb(x) - METER_FLOOR_DB) / -METER_FLOOR_DB));

export function createMeters() {
  return {
    version: 1, seq: 0, time: 0, running: false, bypassed: false, recording: false, loop: null,
    master: { rms: 0, peak: 0, rmsDb: -180, peakDb: -180, env: 0, clip: false, clipHold: false, clips: 0, _hold: 0 },
    nodes: {},
  };
}

function follow(env, target, dt) {
  const tau = target > env ? ATTACK_S : RELEASE_S;
  return env + (target - env) * (1 - Math.exp(-dt / tau));
}

/** Update one level record in place (a node, or master). */
export function updateLevel(m, rms, peak, dt, clipped = peak >= CLIP) {
  m.rms = rms; m.peak = peak; m.rmsDb = toDb(rms); m.peakDb = toDb(peak);
  m.env = follow(m.env, levelNorm(rms), dt);
  m.clip = clipped;
  m._hold = clipped ? CLIP_HOLD_S : Math.max(0, (m._hold || 0) - dt);
  m.clipHold = m._hold > 0;
  return m;
}

export function nodeRecord(type) {
  return { type, rms: 0, peak: 0, rmsDb: -180, peakDb: -180, inRms: 0, inPeak: 0, env: 0, gr: 0, cutoff: null, open: null, bloom: null, pick: null, clip: false, clipHold: false, _hold: 0, ports: [] };
}

/**
 * Apply one frame of raw values to the snapshot.
 * frame = { time, master: { rms, peak, clips }, nodes: { id: { type, ports: [{rms, peak}], inRms, inPeak, gr, cutoff, open } } }
 */
export function applyFrame(meters, frame, dt) {
  meters.time = frame.time;
  const mm = frame.master || { rms: 0, peak: 0, clips: 0 };
  updateLevel(meters.master, mm.rms, mm.peak, dt, (mm.clips || 0) > 0 || mm.peak >= CLIP);
  meters.master.clips += mm.clips || 0;
  for (const id of Object.keys(meters.nodes)) if (!frame.nodes[id]) delete meters.nodes[id];
  for (const [id, f] of Object.entries(frame.nodes)) {
    const r = meters.nodes[id] || (meters.nodes[id] = nodeRecord(f.type));
    r.type = f.type;
    const p0 = f.ports[0] || { rms: 0, peak: 0 };
    updateLevel(r, p0.rms, p0.peak, dt);
    r.ports.length = f.ports.length;
    for (let i = 0; i < f.ports.length; i++) r.ports[i] = { rms: f.ports[i].rms, peak: f.ports[i].peak };
    r.inRms = f.inRms || 0; r.inPeak = f.inPeak || 0;
    r.gr = f.gr || 0; r.cutoff = f.cutoff ?? null; r.open = f.open ?? null; r.bloom = f.bloom ?? null; r.pick = f.pick ?? null;
  }
  meters.seq++;
  return meters;
}

/**
 * Fill inRms/inPeak on every node of a frame from the pipeline's edges (max
 * over incoming wires; an input node's own output stands in for its input).
 */
export function fillInputs(frame, doc) {
  for (const [id, f] of Object.entries(frame.nodes)) { f.inRms = f.type === 'input' ? f.ports[0].rms : 0; f.inPeak = f.type === 'input' ? f.ports[0].peak : 0; }
  for (const e of Object.values(doc.edges)) {
    const src = frame.nodes[e.from[0]]?.ports[e.from[1]], dst = frame.nodes[e.to[0]];
    if (!src || !dst) continue;
    dst.inRms = Math.max(dst.inRms, src.rms); dst.inPeak = Math.max(dst.inPeak, src.peak);
  }
  return frame;
}

/** The motion hook's per-node view (see the contract above). */
export function motionOf(meters, id) {
  const r = meters.nodes[id];
  if (!r) return null;
  return { rms: r.rms, peak: r.peak, inRms: r.inRms, inPeak: r.inPeak, env: r.env, grDb: r.gr, cutoff: r.cutoff, clip: r.clip, bloom: r.bloom, pick: r.pick };
}

/** Decay everything towards silence (the context stopped). */
export function decayMeters(meters, dt) {
  const zero = { time: meters.time, master: { rms: 0, peak: 0, clips: 0 }, nodes: {} };
  for (const [id, r] of Object.entries(meters.nodes)) zero.nodes[id] = { type: r.type, ports: r.ports.map(() => ({ rms: 0, peak: 0 })), gr: 0, cutoff: r.cutoff, open: r.open };
  return applyFrame(meters, zero, dt);
}

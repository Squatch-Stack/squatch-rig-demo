// Live device glyphs: each device face carries its own transfer or response
// curve, drawn in brush and moved only by the audio (design/DIRECTION.md 1, 6).
//
//   compressor   the static curve with its knee at the threshold; above the knee
//                the stroke thins and dries with gain reduction; a seal-red bar
//                grows right to left; a dot rides the curve at the input level
//   overdrive    the tanh transfer; steepens with drive, its shoulders flare and
//                bleed as the input pushes into them; clipping presses the seal
//   envfilter    the filter's magnitude; the resonant peak sweeps with the envelope
//   reverb       an open enso that breathes with the tail; echo rings widen and
//                fade over the decay time
//   gate         the expander curve; the stroke dries and breaks when the gate shuts
//   limiter      unity to the ceiling, then the wall; GR as for the compressor
//   splitter/mix one stroke forking (or converging); each branch's width follows its level
//   amp head     the nameplate swash straightens into the tanh curve as it is driven
//   input/output a plucked burst that follows the input level / the master level stroke
//   cab          a brush ring around each cone, swept by the level
//
// box = { x, y, w, h, k }: the glyph area in node-local units; k = art scale.
import { Brush, pressure } from './brush.js';

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const SEEDS = { compressor: 3, overdrive: 5, bloom: 23, envfilter: 7, reverb: 9, gate: 13, limiter: 17, nam: 31, input: 51, output: 52, splitter: 60, mixer: 70, cab: 81 };

const BLOOM_FIBRES = 7;

export function brushesFor(type) {
  const s = SEEDS[type] ?? 99;
  const extra = type === 'bloom' ? BLOOM_FIBRES : 4;
  return { main: new Brush(s, { streaks: 6 }), dot: new Brush(s + 1, { streaks: 0 }), seal: new Brush(s + 2, { streaks: 0 }), bar: new Brush(s + 3, { streaks: 0 }), extra: Array.from({ length: extra }, (_, i) => new Brush(s + 10 + i, { streaks: 3 })) };
}

// ---- Bloom's sheaf: fixed per-fibre offsets (seeded, never per frame), so only
// the opening, width and wetness move
const FIBRE = Array.from({ length: BLOOM_FIBRES }, (_, i) => {
  const h = Math.sin((i + 1) * 12.9898) * 43758.5453, r = h - Math.floor(h);
  return { u: i / (BLOOM_FIBRES - 1) - 0.5, len: 0.8 + 0.2 * r, lift: 0.05 + 0.1 * ((r * 7) % 1) - 0.5 * (i / (BLOOM_FIBRES - 1) - 0.5), wt: 0.7 + 0.5 * ((r * 13) % 1) };
});

/** The sheaf's frame inside the glyph box: the lamp (origin) at the lower left, aimed up and right. */
export function bloomGeom(box, P = {}) {
  const ox = box.x + 0.06 * box.w, oy = box.y + 0.9 * box.h;
  const tx = box.x + box.w * 0.98, ty = box.y + box.h * 0.52;
  const a0 = Math.atan2(ty - oy, tx - ox) + 0.04, dist = Math.hypot(tx - ox, ty - oy);
  return { ox, oy, a0, dist, rest: 0.3 + 0.35 * clamp(P.bloom ?? 0.7), wt: FIBRE.map((f) => f.wt) };
}

/** One fibre's centreline (i = -1 is the spine): straight out of the lamp, curling upward as it opens. */
export function bloomFibre(G, i, open) {
  const f = i < 0 ? { u: 0, len: 1.02, lift: 0.1 } : FIBRE[i];
  const a = G.a0 + f.u * (0.06 + 0.34 * open);
  const L = G.dist * f.len * (0.72 + 0.28 * open), lift = f.lift * (0.25 + 0.75 * open);
  const pts = [];
  for (let j = 0; j < 5; j++) {
    const t = j / 4;
    pts.push([G.ox + Math.cos(a) * L * t, G.oy + Math.sin(a) * L * t - L * lift * t * t]);
  }
  return pts;
}

/**
 * The bloom glow: the one soft light in the rig, the lamp's colour carried into
 * the sheaf while the note sustains. Three flat stepped discs, not a gradient or
 * a filter, so it costs four fills a frame. Off under reduced motion (like bleed)
 * and when bypassed; the sheaf's opening still shows the state.
 */
export function bloomGlow(g, box, led, m, on, reduced, T) {
  if (!on || reduced) return;
  if (m.sus > 0.03) {
    const G = bloomGeom(box), cx = G.ox + Math.cos(G.a0) * G.dist * 0.62, cy = G.oy + Math.sin(G.a0) * G.dist * 0.62 - G.dist * 0.06;
    const R = box.w * (0.2 + 0.24 * m.sus);
    for (const [s, a] of [[1, 0.05], [0.68, 0.07], [0.4, 0.09]]) g.circle(cx, cy, R * s).fill({ color: T.bloomLeaf, alpha: a * m.sus });
  }
  if (m.pick > 0.04 && led) g.circle(led.x, led.y, (led.r || 3) * 3.2).fill({ color: T.bloomLed, alpha: 0.28 * m.pick });
}

function curvePts(fn, x0, x1, yb, h, n) {
  const pts = [];
  for (let i = 0; i < n; i++) { const u = i / (n - 1); pts.push([x0 + (x1 - x0) * u, yb - h * fn(u)]); }
  return pts;
}

function axes(g, x0, x1, yb, h, k, T) {
  g.moveTo(x0, yb).lineTo(x1, yb).moveTo(x0, yb).lineTo(x0, yb - h).stroke({ width: 0.75 * k, color: T.inkDim, alpha: 0.9 });
}

function dashH(g, x0, x1, y, k, T) {
  for (let x = x0; x < x1; x += 5 * k) g.moveTo(x, y).lineTo(Math.min(x1, x + 2 * k), y);
  g.stroke({ width: 0.75 * k, color: T.inkDim });
}
function dashV(g, x, y0, y1, k, T) {
  for (let y = y0; y > y1; y -= 5 * k) g.moveTo(x, y).lineTo(x, Math.max(y1, y - 2 * k));
  g.stroke({ width: 0.75 * k, color: T.inkDim });
}

function dottedRing(g, cx, cy, r, n, rad, color, alpha) {
  if (alpha < 0.02) return;
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; g.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rad); }
  g.fill({ color, alpha });
}

/** The gain-reduction bar: seal red, growing right to left under the curve. */
function grBar(g, B, x1, y, len, k, T) {
  if (len < 1) return;
  B.draw(g, [[x1, y], [x1 - len * 0.5, y + 0.3 * k], [x1 - len, y]], 4.2 * k, { n: 10, dry: 0, entry: 0.05, exit: 0.3, belly: 0, color: T.seal });
}

function seal(g, B, x, y, amt, k, T) {
  if (amt <= 0.01) return;
  B.dot(g, x, y, 5 * k, { color: T.seal, alpha: 0.35 + 0.65 * amt });
}

/**
 * Draw node's glyph into g.
 *   m      motion state (motion.js), or zeros
 *   c      { theme, bypass, selected, reach (settle draw-on 0..1), ports }
 */
export function drawGlyph(g, node, box, m, c, br) {
  const T = c.theme, k = box.k, P = node.params || {};
  const reach = c.reach ?? 1;
  const bp = !!node.bypass;
  const ink = bp ? T.inkDim : T.ink;
  const env = bp ? 0 : m.env, vis = bp ? 0 : m.vis;
  const dry = bp ? 1 : clamp(0.9 - 0.75 * env);
  const paper = T.paper;
  const pad = 4 * k, x0 = box.x, x1 = box.x + box.w, yb = box.y + box.h - pad, gh = box.h - 2 * pad;

  switch (node.type) {
    case 'bloom': {
      // The sheaf (design/BLOOM-DIRECTION.md): gold leaf on the green field. Every
      // fibre starts at the lamp, which is the pick point, as a fine point and
      // widens as it travels. The pick itself is a straight needle that flashes
      // and fades; as the note sustains the drive comes in (m.sus) and the fibres
      // fan open, soak and lengthen; as it dies they close and dry. At rest the
      // sheaf is half open, set by the Bloom knob, so the face still reads.
      const g0 = bloomGeom(box, P);
      const open = bp ? g0.rest * 0.7 : g0.rest + (1 - g0.rest) * m.sus;
      const sus = bp ? 0 : m.sus, pick = bp ? 0 : m.pick;
      const fdry = bp ? 1 : clamp(0.85 - 0.6 * sus - 0.2 * env);
      for (let i = 0; i < BLOOM_FIBRES; i++) {
        const pts = bloomFibre(g0, i, open);
        br.extra[i].draw(g, pts, (1.1 + 2.2 * sus + 1.0 * env) * k * g0.wt[i], { n: 16, reach, color: ink, paper, alpha: 0.9, dry: fdry, entry: 0.55, exit: 0.3, belly: 0.25 });
      }
      br.main.draw(g, bloomFibre(g0, -1, open), (2.4 + 4 * sus) * k, { n: 20, reach, color: ink, paper, dry: bp ? 1 : clamp(0.7 - 0.6 * sus), entry: 0.5, exit: 0.3, belly: 0.3, bleed: c.reduced ? 0 : 0.5 * sus });
      if (pick > 0.04 && reach >= 1) {
        const len = g0.dist * (0.22 + 0.5 * pick);
        g.moveTo(g0.ox, g0.oy).lineTo(g0.ox + Math.cos(g0.a0) * len, g0.oy + Math.sin(g0.a0) * len).stroke({ width: 0.9 * k, color: ink, alpha: 0.35 + 0.65 * pick, cap: 'round' });
      }
      break;
    }
    case 'compressor': {
      const thrN = clamp(1 + (P.threshold ?? -24) / 60, 0.05, 0.95), R = Math.max(1, P.ratio ?? 4), kn = (P.knee ?? 6) / 60;
      const f = (u) => {
        const x = u - thrN;
        if (2 * x < -kn) return u;
        if (2 * x > kn) return thrN + x / R;
        return u + ((1 / R - 1) * (x + kn / 2) ** 2) / (2 * Math.max(kn, 1e-3));
      };
      axes(g, x0, x1, yb, gh, k, T);
      dashH(g, x0, x1, yb - gh * thrN, k, T);
      const grN = bp ? 0 : m.grN;
      br.main.draw(g, curvePts(f, x0, x1, yb, gh, 9), 9 * k, {
        n: 18, reach, color: ink, paper,
        dry: bp ? 1 : clamp(0.9 - 0.75 * env + 0.55 * grN, 0.05, 1),
        widthFn: (t) => 9 * k * pressure(t) * (t > thrN ? 1 - 0.55 * grN * smooth(thrN, thrN + 0.15, t) : 1),
      });
      if (!bp && env > 0.02 && reach >= 1) { const u = clamp(env, 0, 0.98); br.dot.dot(g, x0 + (x1 - x0) * u, yb - gh * f(u), 2.8 * k, { color: ink }); }
      grBar(g, br.bar, x1, yb + 6 * k, grN * (x1 - x0), k, T);
      break;
    }
    case 'limiter': {
      const ceilN = clamp(0.55 + 0.35 * (1 + (P.ceiling ?? -1) / 12), 0.3, 0.92);
      const f = (u) => (u < ceilN - 0.06 ? u : ceilN - 0.06 + 0.06 * (1 - Math.exp(-(u - ceilN + 0.06) / 0.06)));
      axes(g, x0, x1, yb, gh, k, T);
      dashH(g, x0, x1, yb - gh * ceilN, k, T);
      const grN = bp ? 0 : m.grN;
      br.main.draw(g, curvePts(f, x0, x1, yb, gh, 10), 8 * k, { n: 18, reach, color: ink, paper, dry: bp ? 1 : clamp(dry + 0.5 * grN, 0, 1),
        widthFn: (t) => 8 * k * pressure(t) * (t > ceilN ? 1 + 0.6 * grN : 1) });
      if (!bp && env > 0.02 && reach >= 1) { const u = clamp(env, 0, 0.98); br.dot.dot(g, x0 + (x1 - x0) * u, yb - gh * f(u), 2.6 * k, { color: ink }); }
      grBar(g, br.bar, x1, yb + 6 * k, grN * (x1 - x0), k, T);
      seal(g, br.seal, x1 - 3 * k, yb - gh - 1 * k, m.clip, k, T);
      break;
    }
    case 'overdrive': {
      const D = 1 + 7 * (P.drive ?? 0.5);
      const f = (u) => 0.5 + (0.5 * Math.tanh(D * (u - 0.5) * 2)) / Math.tanh(D);
      const flare = bp ? 0 : clamp(env * (0.5 + D / 8) - 0.25);
      axes(g, x0, x1, yb, gh, k, T);
      br.main.draw(g, curvePts(f, x0, x1, yb, gh, 11), 10 * k, {
        n: 20, reach, color: ink, paper, dry, bleed: flare,
        widthFn: (t) => 10 * k * pressure(t) * (1 + 0.6 * flare * smooth(0.2, 0.42, Math.abs(t - 0.5))),
      });
      if (!bp && env > 0.02 && reach >= 1) { const u = 0.5 + 0.47 * env; br.dot.dot(g, x0 + (x1 - x0) * u, yb - gh * f(u), 2.8 * k, { color: ink }); }
      seal(g, br.seal, x1 - 2 * k, yb - gh + 2 * k, m.clip, k, T);
      break;
    }
    case 'envfilter': {
      const Q = Math.max(0.5, P.q ?? 4), mode = Math.round(P.mode ?? 1);
      const uc = 0.14 + 0.66 * (bp ? 0.3 : m.cutN);
      const mag = (u) => {
        const x = u / uc, den = Math.sqrt((1 - x * x) ** 2 + (x / Q) ** 2);
        return mode === 0 ? 1 / den : mode === 2 ? (x * x) / den : x / Q / den;
      };
      const top = mode === 1 ? 1 : Math.max(1, Q) * 1.02;
      axes(g, x0, x1, yb, gh, k, T);
      br.main.draw(g, curvePts((u) => 0.08 + 0.84 * clamp(mag(u) / top), x0, x1, yb, gh, 25), 5.5 * k, {
        n: 44, reach, color: ink, paper, dry, widthFn: (t) => 5.5 * k * pressure(t, 0.06, 0.25, 0.1) * (0.7 + 0.6 * env),
      });
      // the cutoff, as a hairline tick on the axis
      const xc = x0 + (x1 - x0) * uc;
      g.moveTo(xc, yb).lineTo(xc, yb + 3 * k).stroke({ width: 1.2 * k, color: ink });
      break;
    }
    case 'reverb': {
      const cx = x0 + box.w / 2, cy = box.y + box.h / 2 + 1 * k, tail = bp ? 0 : m.tail;
      const r = 24 * k * (1 + 0.07 * tail);
      const pts = [];
      for (let a = -70; a <= 250; a += 26) pts.push([cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)]);
      // resting echoes (pen-quiet), then the live echoes travelling outward over the decay
      dottedRing(g, cx, cy, r + 9 * k, 28, 0.55 * k, T.inkDim, 0.55);
      dottedRing(g, cx, cy, r + 16 * k, 36, 0.5 * k, T.inkDim, 0.3);
      if (tail > 0.02) {
        const ph = clamp(m.onset);
        dottedRing(g, cx, cy, r + (9 + 12 * ph) * k, 28, 0.9 * k, ink, tail * (1 - ph) * 0.9);
        dottedRing(g, cx, cy, r + (16 + 18 * ph) * k, 36, 0.8 * k, ink, tail * (1 - ph) * 0.55);
      }
      br.main.draw(g, pts, 9 * k * (0.75 + 0.5 * tail), { n: 22, reach, color: ink, paper, dry: bp ? 1 : clamp(0.75 - 0.5 * tail), bleed: tail * 0.8, entry: 0.05, exit: 0.4, belly: 0.25 });
      break;
    }
    case 'gate': {
      const thrN = clamp(0.1 + 0.8 * (((P.threshold ?? -58) + 90) / 80), 0.1, 0.9);
      const f = (u) => (u >= thrN ? u : Math.max(0, u - (thrN - u) * 2.2));
      const open = bp ? 0 : m.open;
      axes(g, x0, x1, yb, gh, k, T);
      dashV(g, x0 + (x1 - x0) * thrN, yb, yb - gh, k, T);
      br.main.draw(g, curvePts(f, x0, x1, yb, gh, 12), 8 * k, { n: 20, reach, color: ink, alpha: 0.55 + 0.45 * open, paper, dry: bp ? 1 : clamp(0.95 - 0.8 * open * (0.4 + 0.6 * env)) });
      if (!bp && env > 0.02 && reach >= 1) { const u = clamp(env, 0, 0.98); br.dot.dot(g, x0 + (x1 - x0) * u, yb - gh * f(u), 2.6 * k, { color: ink }); }
      break;
    }
    case 'input': {
      const a = 0.12 + 0.88 * vis, mid = box.y + box.h / 2, pts = [];
      for (let i = 0; i < 15; i++) pts.push([x0 + (box.w * i) / 14, mid - box.h * 0.42 * a * Math.exp(-i / 6) * Math.sin(i * 1.9)]);
      br.main.draw(g, pts, 4 * k * (0.7 + 0.6 * env), { n: 30, reach, color: ink, paper, dry, entry: 0.05, exit: 0.3, belly: 0 });
      break;
    }
    case 'output': {
      const mid = box.y + box.h / 2, len = Math.max(0.06, vis) * box.w;
      g.moveTo(x0, mid).lineTo(x1, mid).stroke({ width: 0.75 * k, color: T.inkDim, alpha: 0.6 });
      br.main.draw(g, [[x0, mid + 2 * k], [x0 + len * 0.45, mid], [x0 + len, mid - 2 * k]], 12 * k * (0.6 + 0.4 * env), { n: 14, reach, color: ink, paper, dry: bp ? 1 : clamp(0.8 - 0.6 * vis), entry: 0.08, exit: 0.4 });
      seal(g, br.seal, x1 - 3 * k, box.y + 3 * k, m.clip, k, T);
      break;
    }
    case 'splitter':
    case 'mixer': {
      const ports = c.ports; if (!ports) break;
      const split = node.type === 'splitter';
      const hub = split ? ports.ins[0] : ports.outs[0];
      const rows = split ? ports.outs : ports.ins;
      rows.forEach((p, i) => {
        const lv = bp ? 0 : split ? m.outs[i] ?? 0 : m.ins[i] ?? 0;
        const B = br.extra[i % 4];
        const pts = split
          ? [[x0, hub.y], [x0 + box.w * 0.4, hub.y + (p.y - hub.y) * 0.15], [x0 + box.w * 0.78, p.y - (p.y - hub.y) * 0.2], [x1, p.y]]
          : [[x0, p.y], [x0 + box.w * 0.22, p.y + (hub.y - p.y) * 0.2], [x0 + box.w * 0.6, hub.y + (p.y - hub.y) * 0.15], [x1, hub.y]];
        B.draw(g, pts, 5 * k * (0.55 + 0.9 * lv), { n: 16, reach, color: ink, paper, dry: bp ? 1 : clamp(0.85 - 0.8 * lv), entry: 0.05, exit: 0.25, belly: 0 });
      });
      break;
    }
    case 'nam': {
      // box is the nameplate; the swash straightens into the drive curve as the head is driven
      const D = 1.5 + 4 * clamp(((P.input ?? 0) + 24) / 48);
      const a = bp ? 0 : clamp(Math.max(vis * 1.5, c.selected ? 1 : 0));
      const sw = [[0.1, 0.62], [0.36, 0.38], [0.66, 0.55], [0.9, 0.28]];
      const f = (u) => 0.5 + (0.5 * Math.tanh(D * (u - 0.5) * 2)) / Math.tanh(D);
      const px = x0 + 7 * k, pw = box.w - 14 * k, py = box.y + 3.5 * k, ph = box.h - 7 * k;
      const pts = [];
      for (let i = 0; i < 9; i++) {
        const u = i / 8, j = Math.min(2, Math.floor(u * 3)), t = u * 3 - j;
        const sx = sw[j][0] + (sw[j + 1][0] - sw[j][0]) * t, sy = sw[j][1] + (sw[j + 1][1] - sw[j][1]) * t;
        const cxp = 0.06 + 0.88 * u, cyp = 1 - f(u);
        pts.push([px + pw * (sx + (cxp - sx) * a), py + ph * (sy + (cyp - sy) * a)]);
      }
      br.main.draw(g, pts, 7 * k * (0.8 + 0.5 * env), { n: 18, reach, color: ink, paper, dry: bp ? 1 : clamp(0.9 - 0.75 * env), bleed: env * a * 0.6 });
      if (!bp && env > 0.02 && a > 0.5 && reach >= 1) { const u = 0.5 + 0.44 * env; br.dot.dot(g, px + pw * (0.06 + 0.88 * u), py + ph * (1 - f(u)), 2.6 * k, { color: ink }); }
      seal(g, br.seal, x1 - 5 * k, box.y + 6 * k, m.clip, k, T);
      break;
    }
    case 'cab': {
      if (bp || vis < 0.01) break;
      (box.cones || []).forEach((cone, i) => {
        const R = cone.r * 1.08, sweep = 270 * vis, pts = [], steps = Math.max(3, Math.ceil(sweep / 24));
        for (let s = 0; s <= steps; s++) { const ang = ((135 + (sweep * s) / steps) * Math.PI) / 180; pts.push([cone.cx + R * Math.cos(ang), cone.cy + R * Math.sin(ang)]); }
        br.extra[i % 4].draw(g, pts, 5 * k * (0.7 + 0.6 * env), { n: 20, color: ink, alpha: 0.9, paper, dry: clamp(0.8 - 0.6 * env), entry: 0.06, exit: 0.45 });
      });
      break;
    }
    default: break;
  }
}

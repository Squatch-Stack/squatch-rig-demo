// The ink brush, for Pixi. A JS port of design/src/rigart.py brush() (and the
// motion demo's Stroke): a centreline through a Catmull-Rom spline, a pressure
// profile (press-in, belly, long lift-off), and dry-brush streaks cut in paper
// colour. Every stroke owns a fixed seed, so its streak layout and edge jitter
// never re-randomise between frames: only geometry, width and dryness move.
// A per-frame random sketch "boils"; this does not.
//
// draw() tessellates one filled polygon (about 2n+6 vertices) plus a few thin
// streak polylines into a Graphics. Nothing here allocates per frame beyond
// the point arrays Pixi itself needs.

export function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n points along a Catmull-Rom spline through pts ([[x,y], ...]). Writes into cx/cy. */
function catmull(pts, n, cx, cy) {
  const m = pts.length, segs = m - 1;
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * segs, k = Math.min(Math.floor(u), segs - 1), t = u - k, t2 = t * t, t3 = t2 * t;
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(m - 1, k + 2)];
    cx[i] = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
    cy[i] = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
  }
}

/** Brush pressure 0..1 along the stroke: a quick press-in, a slight belly, a long lift-off. */
export function pressure(t, entry = 0.12, exit = 0.35, belly = 0.15) {
  let a = entry > 0 ? Math.min(1, t / entry) : 1; a = 1 - (1 - a) ** 2;
  const z = (exit > 0 ? Math.min(1, Math.max(0, 1 - t) / exit) : 1) ** 0.8;
  return Math.max(0, a * z * (1 + belly * Math.sin(Math.PI * t)));
}

const MAXN = 64;

export class Brush {
  constructor(seed = 1, { streaks = 6, jitter = 0.07 } = {}) {
    const r = mulberry(seed);
    this.jit = Float32Array.from({ length: MAXN }, () => 1 + (r() * 2 - 1) * jitter);
    this.st = Array.from({ length: streaks }, (_, s) => {
      const o = -0.46 + (0.92 * (s + 0.2 + 0.6 * r())) / streaks, edge = Math.abs(o) > 0.3;
      return { o, reach: edge ? 0.45 + 0.5 * r() : 0.25 + 0.45 * r(), w: edge ? 0.05 + 0.05 * r() : 0.02 + 0.04 * r() };
    });
    this.cx = new Float32Array(MAXN); this.cy = new Float32Array(MAXN);
    this.nx = new Float32Array(MAXN); this.ny = new Float32Array(MAXN); this.w = new Float32Array(MAXN);
  }

  /**
   * Draw a stroke along pts into Graphics g.
   *   width   max body width (world units), or use opts.widthFn(t) -> width
   *   opts    { n, dry 0..1, entry, exit, belly, color, alpha, paper (streak colour),
   *             bleed 0..1 (a wider soft halo), reach 0..1 (draw-on: how far the brush has travelled) }
   */
  draw(g, pts, width, opts = {}) {
    if (!pts || pts.length < 2 || !(width > 0)) return;
    const { dry = 0.5, entry = 0.12, exit = 0.35, belly = 0.15, color = 0, alpha = 1, paper = null, bleed = 0, widthFn = null } = opts;
    const reach = Math.max(0, Math.min(1, opts.reach ?? 1));
    const N = Math.min(MAXN, Math.max(4, opts.n || 16));
    if (reach <= 0) return;
    const position = reach * (N - 1);
    const whole = Math.floor(position);
    const n = reach >= 1 ? N : whole + 2;
    const { cx, cy, nx, ny, w, jit } = this;
    catmull(pts, N, cx, cy);
    // Keep the moving tip between spline samples. Advancing the vertex count
    // alone makes short glyphs and cables jump by a whole sample at a time.
    if (reach < 1) {
      const f = position - whole;
      cx[n - 1] = cx[whole] + (cx[whole + 1] - cx[whole]) * f;
      cy[n - 1] = cy[whole] + (cy[whole + 1] - cy[whole]) * f;
    }
    let maxW = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
      const dx = cx[b] - cx[a], dy = cy[b] - cy[a], L = Math.hypot(dx, dy) || 1;
      nx[i] = -dy / L; ny[i] = dx / L;
      // a partly drawn stroke tapers at the brush, not at the stroke's own end
      const t = i / (N - 1);
      const p = widthFn ? widthFn(t) : width * pressure(t, entry, reach >= 1 ? exit : Math.max(exit, 0.25), belly);
      const tip = reach >= 1 ? 1 : Math.min(1, Math.max(0, position - i));
      w[i] = Math.max(0, p * jit[i] * tip);
      if (w[i] > maxW) maxW = w[i];
    }
    w[n - 1] = 0;
    const poly = (scale, ox, oy) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push(cx[i] + ox + (nx[i] * w[i] * scale) / 2, cy[i] + oy + (ny[i] * w[i] * scale) / 2);
      for (let i = n - 1; i >= 0; i--) out.push(cx[i] + ox - (nx[i] * w[i] * scale) / 2, cy[i] + oy - (ny[i] * w[i] * scale) / 2);
      // round head cap: half circle behind the first sample
      const r0 = Math.max((w[0] * scale) / 2, 0.3), a0 = Math.atan2(-ny[0], -nx[0]);
      for (let k = 1; k < 6; k++) { const a = a0 - (Math.PI * k) / 6; out.push(cx[0] + ox + Math.cos(a) * r0, cy[0] + oy + Math.sin(a) * r0); }
      return out;
    };
    if (bleed > 0.01) g.poly(poly(1.45, 0.8, 0.6)).fill({ color, alpha: alpha * bleed * 0.35 });
    g.poly(poly(1, 0, 0)).fill({ color, alpha });
    if (paper == null || dry < 0.02 || !this.st.length) return;
    for (const s of this.st) {
      const t0 = Math.max(0.08, 1 - dry * s.reach), i0 = Math.floor(t0 * (N - 1));
      if (n - i0 < 2) continue;
      g.moveTo(cx[i0] + nx[i0] * w[i0] * s.o, cy[i0] + ny[i0] * w[i0] * s.o);
      for (let i = i0 + 1; i < n; i++) g.lineTo(cx[i] + nx[i] * w[i] * s.o, cy[i] + ny[i] * w[i] * s.o);
      // End at the moving tip; an overshoot would jump when a new sample appears.
      g.stroke({ width: Math.max(0.3, maxW * s.w), color: paper, alpha: 1, cap: 'round', join: 'round' });
    }
  }

  /** A pressed dot (the "hit" mark: clip seal, a dot riding a curve). */
  dot(g, x, y, r, opts = {}) {
    this.draw(g, [[x - r * 0.5, y + r * 0.1], [x, y], [x + r * 0.5, y - r * 0.05]], r * 1.6, { n: 8, dry: 0, entry: 0.3, exit: 0.5, belly: 0.6, ...opts });
  }
}

/** Sample a cubic bezier [x0,y0,c1x,c1y,c2x,c2y,x1,y1] into k points. */
export function sampleBezier(c, k = 12, out = []) {
  out.length = 0;
  for (let i = 0; i < k; i++) {
    const t = i / (k - 1), u = 1 - t;
    out.push([
      u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
      u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7],
    ]);
  }
  return out;
}

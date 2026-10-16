// "Settle": when a device is added or a preset loads, its glyph unfurls from a
// knot into its final gesture. The knot is SVGDreamer's own optimisation
// trajectory (design/assets/brush/generated/*-settle.json: N paths x K
// keyframes of cubic control points, shared topology), played back once over
// ~800 ms while the device's real glyph draws on behind it. Never looped.
import { sampleBezier } from './brush.js';

const FILES = { A: 'assets/brush/generated/A-stroke-settle.json', B: 'assets/brush/generated/B-enso-settle.json' };
export const SETTLE_MS = 820;

function parsePath(d) {
  // "M x y C x y x y x y C ..." -> [[x0,y0,c1x,c1y,c2x,c2y,x1,y1], ...]
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi).map(Number);
  const out = [];
  let x = nums[0], y = nums[1];
  for (let i = 2; i + 5 < nums.length; i += 6) { out.push([x, y, nums[i], nums[i + 1], nums[i + 2], nums[i + 3], nums[i + 4], nums[i + 5]]); x = nums[i + 4]; y = nums[i + 5]; }
  return out;
}

export class Settle {
  constructor(base) { this.base = base; this.sets = {}; }

  async load() {
    await Promise.all(Object.entries(FILES).map(async ([k, f]) => {
      try {
        const j = await (await fetch(new URL(f, this.base))).json();
        const vb = j.viewBox || [0, 0, 260, 260];
        const paths = j.paths.map((p) => ({ keys: p.d.map(parsePath), w: p.w, o: p.o }))
          .filter((p) => p.keys.every((kf) => kf.length === p.keys[0].length && kf.length > 0));
        this.sets[k] = { vb, paths };
      } catch (e) { console.warn('settle: could not load', f, e); }
    }));
    return this;
  }

  /**
   * Draw the settle gesture for progress t (0..1) into box {x,y,w,h}.
   * Early on the knot is dense ink; it opens out along the optimiser's path and
   * fades as the device's own glyph arrives.
   */
  draw(g, box, t, set, color, brushes) {
    const S = this.sets[set] || this.sets.A;
    if (!S || t >= 1) return;
    const K = S.paths[0]?.keys.length || 0;
    if (K < 2) return;
    // the trajectory runs from the optimiser's first frames to its last; ease-out
    const e = 1 - (1 - t) ** 3;
    const kf = e * (K - 1), i0 = Math.min(K - 2, Math.floor(kf)), f = kf - i0;
    const [vx, vy, vw, vh] = S.vb;
    const s = Math.min(box.w / vw, box.h / vh) * 1.15;
    const ox = box.x + box.w / 2 - (vx + vw / 2) * s, oy = box.y + box.h / 2 - (vy + vh / 2) * s;
    const alpha = 0.85 * (1 - smoothstep(0.45, 1, t));
    const tmp = [];
    S.paths.forEach((p, pi) => {
      const A = p.keys[i0], B = p.keys[i0 + 1];
      const pts = [];
      for (let c = 0; c < A.length; c++) {
        const seg = A[c].map((v, j) => (v + (B[c][j] - v) * f));
        for (let j = 0; j < 8; j += 2) seg[j] = ox + seg[j] * s, seg[j + 1] = oy + seg[j + 1] * s;
        sampleBezier(seg, 4, tmp);
        for (const q of c === 0 ? tmp : tmp.slice(1)) pts.push(q);
      }
      const w = ((p.w?.[i0] ?? 4) * (1 - f) + (p.w?.[i0 + 1] ?? p.w?.[i0] ?? 4) * f) * s * 0.9;
      const opacity = (p.o?.[i0] ?? 1) * (1 - f) + (p.o?.[i0 + 1] ?? p.o?.[i0] ?? 1) * f;
      brushes[pi % brushes.length].draw(g, pts, w, { n: Math.min(48, pts.length * 2), color, alpha: alpha * opacity, dry: 0.3, entry: 0.06, exit: 0.3, belly: 0.1 });
    });
  }
}

function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

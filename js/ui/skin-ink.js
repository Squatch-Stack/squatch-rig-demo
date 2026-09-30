// The default "ink" skin: every device is line art drawn with Pixi Graphics -
// ink strokes on a faintly tinted paper body, hatching for shade.
//
// A skin is a plain object with this interface (see skins.js for how a design
// drop in design/ can override bodies with SVG art):
//   size(node)                        -> { w, h }
//   drawBody(g, node, ctx)            -> draws the static device body
//   knobs(node, keys, size)           -> [{ key, x, y, r }]
//   drawKnob(g, x, y, r, t, ctx)      -> t = 0..1 knob position
//   ports(node, size)                 -> { ins: [{x,y}], outs: [{x,y}] }
//   footswitch(node, size)            -> { x, y, r } | null
//   led(node, size)                   -> { x, y }
//   title(node, size)                 -> { x, y, size, anchor }
// ctx = { theme, accent, selected, bypass, status }
import { mix } from './theme.js';
import { insOf, outsOf } from '../graph/types.js';

const FORMS = {
  pedal: { w: 132, h: 196 },
  mini: { w: 116, h: 150 },
  head: { w: 236, h: 158 },
  cab: { w: 186, h: 186 },
  io: { w: 118, h: 150 },
};

function hatch(g, x, y, w, h, gap, color, alpha = 1, width = 1, dir = 1) {
  // 45-degree hatching clipped to the rectangle
  for (let c = -h; c < w; c += gap) {
    let x0 = x + c, y0 = y, x1 = x + c + h, y1 = y + h;
    if (dir < 0) { x0 = x + c + h; x1 = x + c; }
    // clip to [x, x+w]
    const clip = (xa, ya, xb, yb) => {
      const t0 = (x - xa) / (xb - xa), t1 = (x + w - xa) / (xb - xa);
      let ta = 0, tb = 1;
      const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
      ta = Math.max(ta, lo); tb = Math.min(tb, hi);
      if (ta >= tb) return null;
      return [xa + (xb - xa) * ta, ya + (yb - ya) * ta, xa + (xb - xa) * tb, ya + (yb - ya) * tb];
    };
    const s = clip(x0, y0, x1, y1);
    if (s) g.moveTo(s[0], s[1]).lineTo(s[2], s[3]);
  }
  g.stroke({ width, color, alpha });
}

function screws(g, w, h, c) {
  for (const [x, y] of [[9, 9], [w - 9, 9], [9, h - 9], [w - 9, h - 9]]) {
    g.circle(x, y, 2.6).stroke({ width: 1, color: c.theme.inkDim });
    g.moveTo(x - 1.8, y - 1.8).lineTo(x + 1.8, y + 1.8).stroke({ width: 1, color: c.theme.inkDim });
  }
}

function utilitySize(node) {
  const ways = node.config?.ways ?? 2;
  return { w: 150, h: 58 + ways * 46 + (node.type === 'mixer' ? 46 : 0) };
}

export const inkSkin = {
  name: 'ink',
  size(node) {
    const t = node.type;
    if (t === 'splitter' || t === 'mixer') return utilitySize(node);
    const form = { input: 'io', output: 'io', gate: 'mini', limiter: 'mini', nam: 'head', cab: 'cab' }[t] || 'pedal';
    return FORMS[form];
  },

  drawBody(g, node, c) {
    const { w, h } = this.size(node);
    const T = c.theme, ink = c.bypass ? T.inkDim : T.ink;
    const body = mix(T.paper, c.accent, T.tint * (c.bypass ? 0.4 : 1));
    // drop shadow + body
    g.roundRect(4, 6, w, h, 12).fill({ color: T.shadow, alpha: T.name === 'dark' ? 0.35 : 0.12 });
    if (c.selected) g.roundRect(-5, -5, w + 10, h + 10, 15).stroke({ width: 2, color: T.wireSel, alpha: 0.9 });
    const t = node.type;
    if (t === 'nam') return this._head(g, node, c, w, h, body, ink);
    if (t === 'cab') return this._cab(g, node, c, w, h, body, ink);
    if (t === 'splitter' || t === 'mixer') return this._utility(g, node, c, w, h, body, ink);
    if (t === 'input' || t === 'output') return this._io(g, node, c, w, h, body, ink);
    g.roundRect(0, 0, w, h, 11).fill({ color: body }).stroke({ width: 1.7, color: ink });
    g.roundRect(5, 5, w - 10, h - 10, 8).stroke({ width: 1, color: T.inkFaint });
    screws(g, w, h, c);
    // label band with hatch either side
    const bandY = t === 'gate' || t === 'limiter' ? 86 : 124;
    g.moveTo(12, bandY - 10).lineTo(w - 12, bandY - 10).stroke({ width: 1, color: T.inkFaint });
    g.moveTo(12, bandY + 12).lineTo(w - 12, bandY + 12).stroke({ width: 1, color: T.inkFaint });
    hatch(g, 12, bandY + 16, w - 24, h - bandY - 28, 7, c.accent, 0.18, 1);
    // side jacks
    for (const p of this.ports(node, { w, h }).ins) g.rect(-6, p.y - 7, 7, 14).fill({ color: body }).stroke({ width: 1.2, color: ink });
    for (const p of this.ports(node, { w, h }).outs) g.rect(w - 1, p.y - 7, 7, 14).fill({ color: body }).stroke({ width: 1.2, color: ink });
    const fs = this.footswitch(node, { w, h });
    if (fs) {
      g.circle(fs.x, fs.y, fs.r + 4).fill({ color: T.paperHi }).stroke({ width: 1.4, color: ink });
      g.circle(fs.x, fs.y, fs.r).stroke({ width: 1.2, color: ink });
      g.circle(fs.x, fs.y, fs.r * 0.45).stroke({ width: 1, color: T.inkDim });
    }
  },

  _head(g, node, c, w, h, body, ink) {
    const T = c.theme;
    g.roundRect(w / 2 - 38, -10, 76, 16, 7).stroke({ width: 1.6, color: ink });
    g.roundRect(0, 0, w, h, 10).fill({ color: body }).stroke({ width: 1.8, color: ink });
    // grille
    g.roundRect(10, 10, w - 20, 58, 6).fill({ color: mix(body, T.shadow, 0.08) }).stroke({ width: 1.2, color: ink });
    hatch(g, 12, 12, w - 24, 54, 6, T.inkDim, 0.45, 1, 1);
    hatch(g, 12, 12, w - 24, 54, 6, T.inkDim, 0.25, 1, -1);
    // logo plate
    g.roundRect(w / 2 - 76, 26, 152, 26, 5).fill({ color: T.paperHi }).stroke({ width: 1.2, color: ink });
    // control panel
    g.moveTo(10, 80).lineTo(w - 10, 80).stroke({ width: 1, color: T.inkFaint });
    g.roundRect(10, 84, w - 20, h - 94, 6).stroke({ width: 1, color: T.inkFaint });
    for (const p of this.ports(node, { w, h }).ins) g.rect(-6, p.y - 7, 7, 14).fill({ color: body }).stroke({ width: 1.2, color: ink });
    for (const p of this.ports(node, { w, h }).outs) g.rect(w - 1, p.y - 7, 7, 14).fill({ color: body }).stroke({ width: 1.2, color: ink });
    const fs = this.footswitch(node, { w, h });
    // standby toggle
    g.roundRect(fs.x - 7, fs.y - 12, 14, 24, 4).stroke({ width: 1.3, color: ink });
    g.circle(fs.x, c.bypass ? fs.y + 6 : fs.y - 6, 4).fill({ color: ink });
  },

  _cab(g, node, c, w, h, body, ink) {
    const T = c.theme;
    g.roundRect(0, 0, w, h, 8).fill({ color: body }).stroke({ width: 1.8, color: ink });
    hatch(g, 4, 4, w - 8, h - 8, 9, c.accent, 0.12, 1);
    g.roundRect(10, 26, w - 20, h - 84, 5).fill({ color: mix(T.paper, T.shadow, 0.06) }).stroke({ width: 1.2, color: ink });
    const voice = Math.round(node.params.voice ?? 0);
    const bx = 10, by = 26, bw = w - 20, bh = h - 84;
    const spk = voice === 0
      ? [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]].map(([x, y]) => [bx + x * bw, by + y * bh, bh * 0.22])
      : voice === 1 ? [[0.27, 0.5], [0.73, 0.5]].map(([x, y]) => [bx + x * bw, by + y * bh, bh * 0.36])
        : [[bx + bw / 2, by + bh / 2, bh * 0.42]];
    for (const [x, y, r] of spk) {
      g.circle(x, y, r).stroke({ width: 1.3, color: ink });
      g.circle(x, y, r * 0.78).stroke({ width: 0.8, color: T.inkDim });
      g.circle(x, y, r * 0.3).fill({ color: T.paperHi }).stroke({ width: 1, color: ink });
      for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * Math.PI * 2;
        g.moveTo(x + Math.cos(ang) * r * 0.34, y + Math.sin(ang) * r * 0.34).lineTo(x + Math.cos(ang) * r * 0.76, y + Math.sin(ang) * r * 0.76);
      }
      g.stroke({ width: 0.7, color: T.inkFaint });
    }
    for (const p of this.ports(node, { w, h }).ins) g.rect(-6, p.y - 7, 7, 14).fill({ color: body }).stroke({ width: 1.2, color: ink });
    for (const p of this.ports(node, { w, h }).outs) g.rect(w - 1, p.y - 7, 7, 14).fill({ color: body }).stroke({ width: 1.2, color: ink });
  },

  _utility(g, node, c, w, h, body, ink) {
    const T = c.theme;
    g.roundRect(0, 0, w, h, 6).fill({ color: body }).stroke({ width: 1.7, color: ink });
    for (const x of [10, w - 10]) {
      g.moveTo(x, 8).lineTo(x, h - 8).stroke({ width: 1, color: T.inkFaint });
      for (let y = 20; y < h - 10; y += 26) g.circle(x, y, 2.2).stroke({ width: 1, color: T.inkDim });
    }
    const ways = node.config?.ways ?? 2;
    for (let i = 0; i < ways; i++) {
      const y = 58 + i * 46;
      g.moveTo(18, y - 23).lineTo(w - 18, y - 23).stroke({ width: 1, color: T.inkFaint, alpha: 0.7 });
    }
    for (const p of this.ports(node, { w, h }).ins) g.rect(-6, p.y - 6, 7, 12).fill({ color: body }).stroke({ width: 1.2, color: ink });
    for (const p of this.ports(node, { w, h }).outs) g.rect(w - 1, p.y - 6, 7, 12).fill({ color: body }).stroke({ width: 1.2, color: ink });
  },

  _io(g, node, c, w, h, body, ink) {
    const T = c.theme;
    g.roundRect(0, 0, w, h, 14).fill({ color: body }).stroke({ width: 1.7, color: ink });
    // a 1/4" jack face
    const x = w / 2, y = 54;
    g.circle(x, y, 20).stroke({ width: 1.4, color: ink });
    g.circle(x, y, 13).fill({ color: T.paperHi }).stroke({ width: 1.2, color: ink });
    g.circle(x, y, 5).fill({ color: ink });
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      g.moveTo(x + Math.cos(ang) * 20, y + Math.sin(ang) * 20).lineTo(x + Math.cos(ang) * 24, y + Math.sin(ang) * 24);
    }
    g.stroke({ width: 1.2, color: ink });
    for (const p of this.ports(node, { w, h }).ins) g.rect(-6, p.y - 7, 7, 14).fill({ color: body }).stroke({ width: 1.2, color: ink });
    for (const p of this.ports(node, { w, h }).outs) g.rect(w - 1, p.y - 7, 7, 14).fill({ color: body }).stroke({ width: 1.2, color: ink });
  },

  knobs(node, keys, size) {
    const { w, h } = size, t = node.type;
    if (t === 'splitter' || t === 'mixer') {
      return keys.map((key) => {
        if (key === 'master') return { key, x: w / 2 + 20, y: h - 30, r: 13 };
        const i = +key.replace(/\D/g, '');
        return { key, x: w / 2 + 20, y: 58 + i * 46, r: 12 };
      });
    }
    if (t === 'nam') return keys.map((key, i) => ({ key, x: 40 + i * 50, y: 114, r: 14 }));
    if (t === 'cab') return keys.map((key, i) => ({ key, x: 36 + i * ((w - 72) / Math.max(1, keys.length - 1)), y: h - 28, r: 11 }));
    if (t === 'input' || t === 'output') return keys.map((key) => ({ key, x: w / 2, y: h - 26, r: 12 }));
    if (t === 'gate' || t === 'limiter') return keys.map((key, i) => ({ key, x: w / 2 + (i - (keys.length - 1) / 2) * 50, y: 42, r: 15 }));
    // pedals: up to 3 per row, two rows
    const perRow = keys.length > 4 ? 3 : keys.length === 4 ? 2 : keys.length;
    const rows = Math.ceil(keys.length / perRow);
    return keys.map((key, i) => {
      const row = Math.floor(i / perRow), col = i % perRow;
      const inRow = Math.min(perRow, keys.length - row * perRow);
      const sp = perRow === 3 ? 38 : 48;
      const r = perRow === 3 ? 12.5 : 14.5;
      return { key, x: w / 2 + (col - (inRow - 1) / 2) * sp, y: (rows === 1 ? 52 : 36) + row * 50, r };
    });
  },

  drawKnob(g, x, y, r, t, c, bipolar = false) {
    const T = c.theme, a0 = 0.75 * Math.PI, a1 = 2.25 * Math.PI;
    const ang = a0 + t * (a1 - a0);
    // every arc starts with a moveTo: Pixi joins an arc to the current point otherwise
    const R = r + 4.5, arc = (s, e) => g.moveTo(x + Math.cos(s) * R, y + Math.sin(s) * R).arc(x, y, R, s, e);
    arc(a0, a1).stroke({ width: 2, color: T.inkFaint, cap: 'round' });
    const mid = 1.5 * Math.PI;
    if (bipolar) { if (Math.abs(ang - mid) > 0.01) arc(Math.min(mid, ang), Math.max(mid, ang)).stroke({ width: 2.6, color: c.accent, cap: 'round' }); }
    else if (t > 0.002) arc(a0, ang).stroke({ width: 2.6, color: c.accent, cap: 'round' });
    g.circle(x, y, r).fill({ color: T.paperHi }).stroke({ width: 1.4, color: c.bypass ? T.inkDim : T.ink });
    g.circle(x, y, r * 0.62).stroke({ width: 0.8, color: T.inkFaint });
    g.moveTo(x + Math.cos(ang) * r * 0.2, y + Math.sin(ang) * r * 0.2).lineTo(x + Math.cos(ang) * r * 0.92, y + Math.sin(ang) * r * 0.92)
      .stroke({ width: 2, color: T.ink, cap: 'round' });
  },

  ports(node, size) {
    const { w, h } = size, t = node.type;
    const nIn = insOf(node), nOut = outsOf(node);
    const spread = (n, y0, y1) => Array.from({ length: n }, (_, i) => y0 + ((i + 0.5) * (y1 - y0)) / n);
    if (t === 'splitter') return { ins: [{ x: 0, y: h / 2 }], outs: spread(nOut, 0, nOut).map((_, i) => ({ x: w, y: 58 + i * 46 })) };
    if (t === 'mixer') return { ins: spread(nIn, 0, nIn).map((_, i) => ({ x: 0, y: 58 + i * 46 })), outs: [{ x: w, y: h / 2 }] };
    const yMid = t === 'nam' ? 44 : t === 'input' || t === 'output' ? 54 : t === 'cab' ? 26 + (h - 84) / 2 : 56;
    return { ins: spread(nIn, yMid - 20 * (nIn - 1), yMid + 20 * (nIn - 1) + 1).map((y) => ({ x: 0, y: nIn === 1 ? yMid : y })), outs: spread(nOut, 0, 1).map(() => ({ x: w, y: yMid })) };
  },

  footswitch(node, size) {
    const { w, h } = size, t = node.type;
    if (t === 'nam') return { x: w - 28, y: 114, r: 12 };
    if (t === 'gate' || t === 'limiter') return { x: w / 2, y: 122, r: 10 };
    if (t === 'cab') return { x: w - 20, y: 13, r: 7 };
    if (['splitter', 'mixer', 'input', 'output'].includes(t)) return null;
    return { x: w / 2, y: h - 30, r: 13 };
  },

  led(node, size) {
    const { w, h } = size, t = node.type;
    if (t === 'nam') return { x: w - 58, y: 114 };
    if (t === 'gate' || t === 'limiter') return { x: w - 18, y: 18 };
    if (t === 'cab') return { x: w - 36, y: 13 };
    if (t === 'splitter' || t === 'mixer') return { x: w - 22, y: 18 };
    if (t === 'input' || t === 'output') return { x: w - 16, y: 16 };
    return { x: w / 2, y: h - 62 };
  },

  title(node, size) {
    const { w, h } = size, t = node.type;
    if (t === 'nam') return { x: w / 2, y: 39, size: 13 };
    if (t === 'cab') return { x: 12, y: 13, size: 11, left: true };
    if (t === 'splitter' || t === 'mixer') return { x: w / 2, y: 18, size: 12 };
    if (t === 'input' || t === 'output') return { x: w / 2, y: 16, size: 11 };
    if (t === 'gate' || t === 'limiter') return { x: w / 2, y: 86, size: 12 };
    return { x: w / 2, y: 125, size: 13 };
  },
};

// Skin loading. Two skins ship:
//   brush-ink (default)  the design job's pen line art (design/skin.brush-ink.json ->
//                        design/assets/devices/*.svg) with live brush glyphs on top
//   ink                  the older built-in line art drawn with Pixi Graphics (?skin=ink)
// Any design/skin.<name>.json can be selected with ?skin=<name>:
//
//   { "name": "brush-ink",
//     "devices": {
//       "overdrive": { "svg": "assets/devices/pedal-overdrive.svg", "scale": 0.8 },
//       "splitter":  { "svg": "assets/devices/splitter-{ways}.svg", "ways": [2, 3, 4], "scale": 0.8 },
//       "nam": { "svg": "assets/devices/amp-head.svg", "scale": 0.46, "params": { "gain": "input", "master": "output" } } },
//     "themes": { "dark": { "--ink": "#..." } } }        (optional overrides; default: css/app.css)
//
// The SVGs follow the anchor contract (design/DIRECTION.md, "The anchor
// contract"): invisible `.slot` elements mark jacks (`jack-in[-a..d]`,
// `jack-out[-a..d]`), knobs (`knob` + `data-i`, parameter on the parent
// `g.knob[data-param]`), `footswitch`, `toggle`, `led`, `nameplate`, `cone`,
// and `glyph` (the box the live glyph is drawn into). The static `g.glyph`
// group and any knob the node type does not have are removed before the art is
// rasterised, because the canvas draws those live. CSS variables in the SVG are
// substituted per theme first (they do not resolve in a detached image), and
// the paper grain is baked into the body.
import { Texture } from 'pixi.js';
import { inkSkin } from './skin-ink.js';
import { TYPES, faceOf, insOf, outsOf } from '../graph/types.js';
import { getTheme } from './theme.js';
import { grainInto } from './paper.js';

const ART_TOKENS = { '--ink': 'ink', '--ink-soft': 'ink-soft', '--paper': 'paper', '--paper-2': 'paper-2', '--accent': 'accent', '--seal': 'seal', '--bloom': 'bloom', '--bloom-leaf': 'bloom-leaf', '--bloom-led': 'bloom-led' };

function themed(svgText, tokens) {
  // var(--x, #fallback) -> token value or the fallback
  return svgText.replace(/var\(\s*(--[\w-]+)\s*,\s*([^)]+)\)/g, (_, name, fb) => tokens[name] ?? fb.trim());
}

async function decodeSvg(svgText) {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

async function rasterise(svgText, w, h, theme, oversample = 3) {
  const img = await decodeSvg(svgText);
  const c = document.createElement('canvas');
  c.width = Math.round(w * oversample); c.height = Math.round(h * oversample);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  grainInto(ctx, c.width, c.height, theme, oversample / 2);
  return Texture.from(c);
}

function parseSlots(doc) {
  const svg = doc.documentElement;
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const W = vb.length === 4 ? vb[2] : +svg.getAttribute('width'), H = vb.length === 4 ? vb[3] : +svg.getAttribute('height');
  const slots = [];
  for (const el of doc.querySelectorAll('[data-slot]')) {
    const s = { slot: el.getAttribute('data-slot'), i: el.hasAttribute('data-i') ? +el.getAttribute('data-i') : null };
    if (el.tagName === 'rect') { s.x = +el.getAttribute('x'); s.y = +el.getAttribute('y'); s.w = +el.getAttribute('width'); s.h = +el.getAttribute('height'); s.cx = s.x + s.w / 2; s.cy = s.y + s.h / 2; s.r = Math.min(s.w, s.h) / 2; }
    else { s.cx = +el.getAttribute('cx'); s.cy = +el.getAttribute('cy'); s.r = +el.getAttribute('r'); }
    if (s.slot === 'knob') s.param = el.closest('g.knob')?.getAttribute('data-param') || doc.querySelector(`g.knob[data-i="${s.i}"]`)?.getAttribute('data-param') || null;
    slots.push(s);
  }
  return { W, H, slots };
}

/** Which knob slots a node of this shape uses: named matches first, then the rest in order. */
function assignKnobs(slots, face, map) {
  const ks = slots.filter((s) => s.slot === 'knob').sort((p, q) => p.i - q.i);
  const used = new Set(), out = [];
  for (const s of ks) {
    const key = map[s.param] ?? s.param;
    if (key && face.includes(key) && !used.has(key)) { used.add(key); out.push({ key, s }); }
  }
  const free = ks.filter((s) => !out.some((o) => o.s === s));
  for (const key of face) if (!used.has(key) && free.length) { used.add(key); out.push({ key, s: free.shift() }); }
  return out;
}

async function loadArt(base, spec, d, type, ways) {
  const file = d.svg.replace('{ways}', String(ways ?? ''));
  const text = await (await fetch(new URL(file, base))).text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const { W, H, slots } = parseSlots(doc);
  const face = faceOf({ type, config: { ways: ways ?? 2 }, params: {} });
  const knobs = assignKnobs(slots, face, d.params || {});
  // the canvas draws these live: drop the static glyph and any knob this device does not have
  doc.querySelectorAll('g.glyph').forEach((el) => el.remove());
  doc.querySelectorAll('g.knob').forEach((el) => { if (!knobs.some((k) => k.s.i === +el.getAttribute('data-i'))) el.remove(); });
  const clean = new XMLSerializer().serializeToString(doc);
  const k = d.scale ?? 1;
  const size = { w: Math.round(W * k), h: Math.round(H * k) };
  const sc = (s) => ({ ...s, cx: s.cx * k, cy: s.cy * k, r: s.r * k, x: s.x * k, y: s.y * k, w: s.w * k, h: s.h * k });
  const textures = {};
  for (const name of ['dark', 'light']) {
    const T = getTheme(name);
    const tokens = Object.fromEntries(Object.entries(ART_TOKENS).map(([v, t]) => [v, T.css[t]]));
    Object.assign(tokens, spec.themes?.[name] || {});
    textures[name] = await rasterise(themed(clean, tokens), size.w, size.h, T);
  }
  return { ...d, k, size, slots: slots.map(sc), knobs: knobs.map(({ key, s }) => ({ key, s: sc(s) })), textures };
}

/** cc.squatch.skin.<name>: a squatch-skin package (skin-package.js re-checks the same pattern). */
export const isPackageSkin = (name) => /^cc\.squatch\.skin\.[a-z0-9-]+$/.test(String(name));

export async function loadSkin(name = 'brush-ink', base = new URL('../../design/', import.meta.url)) {
  if (name === 'ink') return inkSkin;
  if (isPackageSkin(name)) return loadPackageSkin(name, base);
  let spec;
  try {
    const r = await fetch(new URL(`skin.${name}.json`, base));
    if (!r.ok) return inkSkin;
    spec = await r.json();
  } catch { return inkSkin; }
  const art = {}; // key: type or `${type}:${ways}`
  await Promise.all(Object.entries(spec.devices || {}).map(async ([type, d]) => {
    const variants = d.ways || [null];
    await Promise.all(variants.map(async (ways) => {
      try { art[ways ? `${type}:${ways}` : type] = await loadArt(base, spec, d, type, ways); } catch (e) { console.warn('skin: could not load', d.svg, ways ?? '', e); }
    }));
  }));
  const artOf = (node) => art[`${node.type}:${node.config?.ways ?? 2}`] || art[node.type] || null;
  const slotsOf = (node, name) => artOf(node)?.slots.filter((s) => s.slot === name) || [];
  // A device may carry its own finish: "face": { "<part>": { "<theme role>": "<theme role>" } }, part is
  // glyph | knob | legend | led. Bloom's lacquer maps ink to gold leaf and paper to the green field.
  const faces = new Map();
  const face = (node, T, part) => {
    const map = artOf(node)?.face?.[part];
    if (!map) return null;
    const key = `${T.name}:${node.type}:${part}`;
    if (!faces.has(key)) faces.set(key, { ...T, ...Object.fromEntries(Object.entries(map).map(([role, from]) => [role, T[from] ?? T[role]])) });
    return faces.get(key);
  };
  const skin = {
    ...inkSkin,
    name: spec.name || name,
    art,
    artOf,
    face,
    liveGlyphs: true,
    mono: true,
    textureFor(node, themeName) { return artOf(node)?.textures[themeName] || null; },
    scaleOf(node) { return artOf(node)?.k ?? 1; },
    size(node) { return artOf(node)?.size || inkSkin.size.call(this, node); },
    knobs(node, keys, size) {
      const a = artOf(node);
      if (!a) return inkSkin.knobs.call(this, node, keys, size);
      const out = a.knobs.filter((q) => keys.includes(q.key)).map(({ key, s }) => ({ key, x: s.cx, y: s.cy, r: s.r * 0.66 }));
      // legend placement: under the knob, pushed outward when a knob sits just below
      for (const kb of out) {
        const below = out.find((o) => o !== kb && o.y - kb.y > kb.r && o.y - kb.y < kb.r * 5 && Math.abs(o.x - kb.x) < kb.r * 4);
        const gap = 7 * a.k;
        if (below) kb.legend = { x: kb.x + (kb.x < below.x ? 1 : -1) * kb.r * 0.85, y: kb.y + kb.r + gap, ax: kb.x < below.x ? 1 : 0 };
        else kb.legend = { x: kb.x, y: kb.y + kb.r + gap, ax: 0.5 };
      }
      return out;
    },
    ports(node, size) {
      const a = artOf(node);
      if (!a) return inkSkin.ports.call(this, node, size);
      const pick = (names) => names.flatMap((nm) => slotsOf(node, nm)).map((s) => ({ x: s.cx, y: s.cy }));
      const ins = pick(['jack-in', 'jack-in-a', 'jack-in-b', 'jack-in-c', 'jack-in-d']);
      const outs = pick(['jack-out', 'jack-out-a', 'jack-out-b', 'jack-out-c', 'jack-out-d']);
      const ink = inkSkin.ports.call(this, node, size);
      return { ins: ins.length >= insOf(node) ? ins.slice(0, insOf(node)) : ink.ins, outs: outs.length >= outsOf(node) ? outs.slice(0, outsOf(node)) : ink.outs };
    },
    footswitch(node, size) {
      const a = artOf(node);
      if (!a) return inkSkin.footswitch.call(this, node, size);
      const s = slotsOf(node, 'footswitch')[0] || slotsOf(node, 'toggle')[0];
      return s ? { x: s.cx, y: s.cy, r: s.r } : null;
    },
    led(node, size) {
      const s = artOf(node) && slotsOf(node, 'led')[0];
      return s ? { x: s.cx, y: s.cy, r: s.r } : inkSkin.led.call(this, node, size);
    },
    glyphBox(node) {
      const a = artOf(node);
      if (!a) return null;
      const s = slotsOf(node, node.type === 'nam' ? 'nameplate' : 'glyph')[0];
      const cones = slotsOf(node, 'cone');
      if (node.type === 'cab') return { x: 0, y: 0, w: a.size.w, h: a.size.h, k: a.k, cones };
      return s ? { x: s.x, y: s.y, w: s.w, h: s.h, k: a.k } : null;
    },
    /** Label under the device, in the hand's voice. */
    title(node, size) { return { x: size.w / 2, y: size.h + 16, size: 17, below: true }; },
    /** Pen knob: cap, detail ring, pointer; the value is an accent arc (your hand). */
    drawKnob(g, x, y, r, t, c, bipolar = false) {
      const T = c.theme, k = c.k ?? 0.8, a0 = 0.75 * Math.PI, a1 = 2.25 * Math.PI;
      const ang = a0 + t * (a1 - a0), R = r + 3.4 * k + 1;
      const arc = (s, e) => g.moveTo(x + Math.cos(s) * R, y + Math.sin(s) * R).arc(x, y, R, s, e);
      arc(a0, a1).stroke({ width: 0.9 * k + 0.2, color: T.inkFaint, cap: 'round' });
      const mid = 1.5 * Math.PI;
      if (bipolar) { if (Math.abs(ang - mid) > 0.01) arc(Math.min(mid, ang), Math.max(mid, ang)).stroke({ width: 2.6 * k + 0.4, color: T.accent, cap: 'round' }); }
      else if (t > 0.002) arc(a0, ang).stroke({ width: 2.6 * k + 0.4, color: c.bypass ? T.inkDim : T.accent, cap: 'round' });
      const ink = c.bypass ? T.inkDim : T.ink;
      g.circle(x, y, r).fill({ color: T.paper }).stroke({ width: 2.25 * k, color: ink });
      g.circle(x, y, r * 0.68).stroke({ width: 1.25 * k, color: ink, alpha: 0.9 });
      g.moveTo(x + Math.cos(ang) * r * 0.22, y + Math.sin(ang) * r * 0.22).lineTo(x + Math.cos(ang) * r * 0.86, y + Math.sin(ang) * r * 0.86)
        .stroke({ width: 2.25 * k, color: ink, cap: 'round' });
    },
  };
  return skin;
}

// ---------------------------------------------------------------- squatch-skin packages
// ?skin=cc.squatch.skin.<name> loads design/skins/<name>/, a byte-identical copy of a squatch-skin
// package, and validates it with squatch-skin's own validator (skin-package.js). A device whose
// node type names a contract (types.js `contract`) that the package lays out is then drawn from the
// package: its faceplate and footswitch art at the layout's millimetre positions, its knob and lamp
// art, every colour from the --sq-comp-* tokens after the skin's overrides, and its knobs driven by
// the contract. Every other device, and every jack, keeps the default brush-ink art. A refused
// package changes nothing on the canvas, and the rig calls it "a refused skin", never by its name.
const PART_OVERSAMPLE = 6;
const artPaths = (m) => ({ faceplate: m.art.faceplate, knob: m.art.knob.body, pointer: m.art.knob.pointer, footswitch: m.art.footswitch, ledOn: m.art.led.on, ledOff: m.art.led.off });
const num = (v) => parseInt(String(v).trim().slice(1, 7), 16);

async function partTexture(svgText, px) {
  const img = await decodeSvg(svgText);
  const c = document.createElement('canvas');
  c.width = c.height = px;
  c.getContext('2d').drawImage(img, 0, 0, px, px);
  return Texture.from(c);
}

/** The device body: the faceplate in the face rect and the footswitch on it, grain baked in like every other device. */
async function faceTexture(drawn, geo, box, theme, oversample = 3) {
  const c = document.createElement('canvas');
  c.width = Math.round(box.w * oversample); c.height = Math.round(box.h * oversample);
  const ctx = c.getContext('2d');
  const F = geo.face, S = geo.footswitch;
  ctx.drawImage(await decodeSvg(drawn.faceplate), F.x * oversample, F.y * oversample, F.w * oversample, F.h * oversample);
  ctx.drawImage(await decodeSvg(drawn.footswitch), (S.x - S.r) * oversample, (S.y - S.r) * oversample, 2 * S.r * oversample, 2 * S.r * oversample);
  grainInto(ctx, c.width, c.height, theme, oversample / 2);
  return Texture.from(c);
}

async function loadPackageSkin(id, base) {
  const [host, P] = await Promise.all([loadSkin('brush-ink', base), import('./skin-package.js')]);
  const dir = new URL(`skins/${P.PACKAGE_ID.exec(id)?.[1] ?? '-'}/`, base);
  const vendor = new URL('../../vendor/squatch-skin/', import.meta.url);
  const get = async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u.pathname}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const sha256 = globalThis.crypto?.subtle ? async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b)) : null;
  const pkg = await P.loadPackage(id, { readVendor: (rel) => get(new URL(rel, vendor)), readPackage: (rel) => get(new URL(rel, dir)), sha256 });
  pkg.drawn = {};
  pkg.unresolved = {};
  pkg.devices = [];
  const skin = { ...host, name: id, label: pkg.label, package: pkg };
  if (!pkg.ok) { console.warn(`skin: ${pkg.label}, ${pkg.errors.length} problems; drawing brush-ink`, pkg.errors); return skin; }

  const m = pkg.manifest, paths = artPaths(m);
  const devices = new Map(); // node type -> { product, L, geo }
  for (const [type, t] of Object.entries(TYPES)) {
    const product = t.contract ? pkg.products.get(t.contract) : null;
    const L = product ? P.layoutFor(m, product) : null;
    if (!L) continue;
    const box = host.size({ type, config: {}, params: {} });
    devices.set(type, { product, L, box, geo: P.faceGeometry(L, product, box) });
  }
  pkg.devices = [...devices.keys()];
  const values = {}, faces = {}, parts = {}, specs = new Map();
  const maxD = Math.max(1, ...[...devices.values()].flatMap((d) => [...d.geo.knobs.map((k) => 2 * k.r), 2 * d.geo.led.r]));
  const px = Math.ceil(maxD * PART_OVERSAMPLE);
  for (const mode of ['dark', 'light']) {
    const V = values[mode] = P.skinTokens(pkg.theme, m, mode);
    const drawn = pkg.drawn[mode] = {};
    pkg.unresolved[mode] = [];
    for (const [part, rel] of Object.entries(paths)) {
      const s = P.substitute(pkg.texts[rel], V);
      drawn[part] = s.text;
      pkg.unresolved[mode].push(...s.unresolved);
    }
    const T = getTheme(mode);
    parts[mode] = { knob: await partTexture(drawn.knob, px), pointer: await partTexture(drawn.pointer, px), ledOn: await partTexture(drawn.ledOn, px), ledOff: await partTexture(drawn.ledOff, px) };
    faces[mode] = {};
    for (const [type, d] of devices) faces[mode][type] = await faceTexture(drawn, d.geo, d.box, T);
  }
  pkg.values = values;
  const dev = (node) => (node ? devices.get(node.type) : null);
  const tok = (T, name) => values[T.name].get(name);
  const specOf = (p) => {
    // a rig parameter spec whose mapping and readout are the contract's own (taper, display scale, units)
    if (!specs.has(p.path)) specs.set(p.path, { label: p.name, min: p.min, max: p.max, def: p.default, unit: p.unit === 'db' ? 'dB' : '', contract: p,
      norm: (v) => P.toNormalized(p, v), value: (n) => P.fromNormalized(p, n), show: (v) => P.formatValue(p, v) });
    return specs.get(p.path);
  };
  // the device's own finish, as theme roles: glyph ink, legend colour, the face as paper, the value gold
  const finish = new Map();
  const face = (node, T, part) => {
    if (!dev(node)) return host.face(node, T, part);
    if (!finish.has(T.name)) {
      const n = (k) => num(tok(T, k));
      finish.set(T.name, { ...T, ink: n('--sq-comp-glyph-ink'), inkDim: n('--sq-comp-legend-color'), paper: n('--sq-comp-pedal-face'), accent: n('--sq-comp-knob-value'), inkFaint: n('--sq-comp-knob-track') });
    }
    return finish.get(T.name);
  };
  // legends in the skin's own legend type, scaled from the rig's legend size by the skin's ratio to the theme's
  const baseLegend = parseFloat(P.skinTokens(pkg.theme, null, 'light').get('--sq-comp-legend-type-font-size'));
  return Object.assign(skin, {
    face,
    textureFor(node, themeName) { const d = dev(node); return d ? faces[themeName][node.type] : host.textureFor(node, themeName); },
    glyphBox(node) { const d = dev(node); return d ? { ...d.geo.glyph, k: host.scaleOf(node) } : host.glyphBox(node); },
    footswitch(node, size) { const d = dev(node); return d ? { ...d.geo.footswitch } : host.footswitch.call(this, node, size); },
    led(node, size) { const d = dev(node); return d ? { ...d.geo.led } : host.led.call(this, node, size); },
    legendStyle(node, T) {
      if (!dev(node)) return null;
      const g = (k) => tok(T, `--sq-comp-legend-type-${k}`);
      return {
        font: g('font-family'), italic: g('font-style') === 'italic', weight: String(g('font-weight')),
        upper: g('text-transform') === 'uppercase', scale: parseFloat(g('font-size')) / baseLegend, spacing: parseFloat(g('letter-spacing')) || 0,
      };
    },
    knobs(node, keys, size) {
      const d = dev(node);
      if (!d) return host.knobs.call(this, node, keys, size);
      const lg = 6.2 * (parseFloat(values.light.get('--sq-comp-legend-type-font-size')) / baseLegend);
      const out = d.geo.knobs.filter((q) => keys.includes(q.key));
      // under the knob, as the squatch-skin demo places it; when another knob sits just below, the
      // legend grows outward from the knob's centre so it stays clear of that knob's value ring
      return out.map((q) => {
        const below = out.find((o) => o !== q && o.y - q.y > q.r && o.y - q.y < q.r * 4 && Math.abs(o.x - q.x) < q.r * 4);
        const y = q.y + q.r * 1.16 + 1.2 * d.geo.mm + lg * 0.55;
        return { key: q.key, x: q.x, y: q.y, r: q.r, spec: specOf(q.param), art: true, legend: { x: q.x, y, ax: below ? (q.x < below.x ? 1 : 0) : 0.5 } };
      });
    },
    /** The product's name on the nameplate, and its state when bypassed. */
    nameplate(node) {
      const d = dev(node);
      return d?.geo.nameplate ? { ...d.geo.nameplate, name: d.product.name, status: node.bypass ? 'bypassed' : '' } : null;
    },
    /** Knob art: the value ring (component.knob.*), the body, and the pointer turned to -travel/2 + travel x n. */
    drawKnob(g, x, y, r, t, c, bipolar = false) {
      const d = dev(c.node);
      if (!d) return host.drawKnob.call(this, g, x, y, r, t, c, bipolar);
      const T = c.theme, travel = Number(tok(T, '--sq-comp-knob-travel')) || 270;
      const ring = parseFloat(tok(T, '--sq-comp-knob-ring-width')) * (d.geo.mm / 3); // one token px = a third of a face millimetre
      const R = r * 1.08, rad = Math.PI / 180;
      const a0 = -Math.PI / 2 - (travel / 2) * rad, a = -Math.PI / 2 + P.pointerDegrees(travel, t) * rad;
      g.moveTo(x + Math.cos(a0) * R, y + Math.sin(a0) * R).arc(x, y, R, a0, a0 + travel * rad)
        .stroke({ width: Math.max(0.5, ring * 0.3), color: num(tok(T, '--sq-comp-knob-track')), cap: 'round' });
      if (t > 0.004) g.moveTo(x + Math.cos(a0) * R, y + Math.sin(a0) * R).arc(x, y, R, a0, a)
        .stroke({ width: ring, color: num(tok(T, c.bypass ? '--sq-sys-color-text-secondary' : '--sq-comp-knob-value')), cap: 'round' });
      const tex = parts[T.name];
      g.texture(tex.knob, 0xffffff, x - r, y - r, 2 * r, 2 * r);
      const cs = Math.cos(a + Math.PI / 2), sn = Math.sin(a + Math.PI / 2);
      g.setTransform(cs, sn, -sn, cs, x, y).texture(tex.pointer, 0xffffff, -r, -r, 2 * r, 2 * r).setTransform(1, 0, 0, 1, 0, 0);
    },
    /** Lamp art, lit or not; returns false for devices the package does not draw. */
    drawLed(g, node, led, on, themeName) {
      if (!dev(node)) return false;
      g.texture(parts[themeName][on ? 'ledOn' : 'ledOff'], 0xffffff, led.x - led.r, led.y - led.r, 2 * led.r, 2 * led.r);
      return true;
    },
  });
}

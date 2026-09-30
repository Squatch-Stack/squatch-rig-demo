// The node editor: a PixiJS (WebGL2; WebGPU on request) canvas that draws the
// pipeline document and turns pointer input into document edits.
//
// Two instruments (design/DIRECTION.md): the PEN draws devices and never moves
// (rasterised line art, knobs drawn live only because their values change);
// the BRUSH draws signal and moves only when audio drives it: ink cables whose
// weight and bleed follow the level, ink carried along them, and each device's
// own glyph. With no signal nothing moves, and nothing is rendered: the loop
// only submits a frame when something changed.
import { Application, Container, Graphics, Text, Sprite, Rectangle, TilingSprite } from 'pixi.js';
import { TYPES, paramsOf, faceOf, toNorm, fromNorm, formatValue, bypassable, insOf, outsOf } from '../graph/types.js';
import { THEMES, mix, motionReduced } from './theme.js';
import { Brush, pressure, sampleBezier } from './brush.js';
import { MotionFeed } from './motion.js';
import { drawGlyph, brushesFor, bloomGlow } from './glyphs.js';
import { SETTLE_MS } from './settle.js';
import { paperTexture } from './paper.js';

const UI_FONT = 'Inter, ui-sans-serif, -apple-system, "Segoe UI", sans-serif';
const HAND_FONT = 'Lora, ui-serif, Georgia, serif';
const MONO_FONT = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const TEXT_RES = Math.min(4, (globalThis.devicePixelRatio || 1) * 2);
const LEGEND_MIN_PX = 6.2; // knob legends hide below this on-screen size (the inspector carries them)
const CABLE_SETTLE_MS = 480;

function bezier(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return [a.x, a.y, a.x + dx, a.y, b.x - dx, b.y, b.x, b.y];
}
function bezPoint(c, t) {
  const u = 1 - t;
  return {
    x: u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
    y: u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7],
  };
}
function hashSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
const easeOut = (t) => 1 - (1 - t) ** 3;

class Stats {
  constructor(n = 240) { this.a = new Float32Array(n); this.i = 0; this.n = 0; }
  push(v) { this.a[this.i] = v; this.i = (this.i + 1) % this.a.length; this.n = Math.min(this.n + 1, this.a.length); }
  summary() {
    if (!this.n) return null;
    const s = Array.from(this.a.slice(0, this.n)).sort((x, y) => x - y);
    const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
    return { p50: q(0.5), p95: q(0.95), max: +s[s.length - 1].toFixed(3), n: this.n };
  }
}

class NodeView {
  constructor(canvas, id) {
    this.canvas = canvas; this.id = id;
    this.root = new Container();
    this.root.eventMode = 'static';
    this.root.cursor = 'grab';
    this.body = new Graphics();   // fallback body, selection underline
    this.knobG = new Graphics();
    this.glyph = new Graphics();  // live brush glyph
    this.live = new Graphics();   // LEDs, meters
    this.texts = new Container();
    this.legends = new Container();
    this.root.addChild(this.body, this.glyph, this.knobG, this.texts, this.legends, this.live);
    this.sprite = null;
    this.sig = '';
    this.glyphKey = '';
    this.brushes = null;
    this.settleAt = null;
  }
}

export class GraphCanvas extends EventTarget {
  constructor({ host, store, engine, library, skin, themeName = 'dark', settle = null }) {
    super();
    Object.assign(this, { host, store, engine, library, skin, settle });
    this.theme = THEMES[themeName];
    this.views = new Map();
    this.selected = null; // { kind: 'node'|'edge', id }
    this.drag = null;
    this.flow = new Map(); // edgeId -> phase
    this.edgeSeen = new Set();
    this.edgeSettle = new Map(); // edgeId -> start ms
    this.lastTexts = 0;
    this.dirty = true;
    this.stats = { update: new Stats(), render: new Stats(), interval: new Stats(), rendered: 0, skipped: 0, since: performance.now() };
    this.touch = matchMedia('(pointer: coarse)').matches;
  }

  async init(preference = 'webgl') {
    this.app = new Application();
    await this.app.init({
      preference, resizeTo: this.host, antialias: true, autoDensity: true, autoStart: false,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1), background: this.theme.bg,
      powerPreference: 'high-performance',
    });
    this.app.stop(); // we render on demand from our own loop
    this.rendererName = this.app.renderer.name || (this.app.renderer.type === 2 ? 'webgpu' : 'webgl');
    const cv = this.app.canvas;
    cv.tabIndex = 0;
    cv.setAttribute('role', 'application');
    cv.setAttribute('aria-label', 'Pipeline graph editor. Tab selects devices; arrows move; B bypasses; Delete removes. Parameters are editable in the inspector.');
    this.host.appendChild(cv);

    this.paper = new TilingSprite({ texture: paperTexture(this.theme), width: this.app.screen.width, height: this.app.screen.height });
    this.grid = new Graphics();
    this.world = new Container();
    this.cables = new Graphics();
    this.flowG = new Graphics();
    this.nodesLayer = new Container();
    this.overlay = new Graphics();
    this.world.addChild(this.cables, this.flowG, this.nodesLayer, this.overlay);
    this.app.stage.addChild(this.paper, this.grid, this.world);
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;

    this.motion = new MotionFeed(this.engine, this.store);
    this.cableBrush = new Brush(105, { streaks: 3, jitter: 0.03 });
    this.flowBrush = new Brush(106, { streaks: 0, jitter: 0.02 });
    this.selBrush = new Brush(41, { streaks: 4 });

    this.app.stage.on('pointerdown', (e) => this._bgDown(e));
    this.app.stage.on('pointermove', (e) => this._move(e));
    this.app.stage.on('pointerup', (e) => this._up(e));
    this.app.stage.on('pointerupoutside', (e) => this._up(e));
    cv.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    cv.addEventListener('dblclick', (e) => this._dbl(e));
    cv.addEventListener('keydown', (e) => this._key(e));
    this.app.renderer.on?.('resize', () => { this._viewChanged(); });

    this.store.addEventListener('change', (e) => this._onDoc(e.detail.kind));
    this.engine?.addEventListener?.('node-status', () => this.rebuild(true));
    this.rebuild();
    for (const id of Object.keys(this.store.doc.edges)) this.edgeSeen.add(id);
    this.fit();
    this._last = performance.now();
    this._loop = (now) => { this._raf = requestAnimationFrame(this._loop); this._tick(now); };
    this._raf = requestAnimationFrame(this._loop);
    return this;
  }

  setTheme(name) {
    this.theme = THEMES[name];
    this.app.renderer.background.color = this.theme.bg;
    this.paper.texture = paperTexture(this.theme);
    this.rebuild(true);
    this._viewChanged();
  }
  setSkin(skin) { this.skin = skin; this.rebuild(true); }
  markDirty() { this.dirty = true; }

  /** Frame-time and render statistics (ms), for the visual tests and the perf note. */
  perf() {
    const secs = (performance.now() - this.stats.since) / 1000;
    return {
      renderedFps: +(this.stats.rendered / secs).toFixed(1), rendered: this.stats.rendered, idleFrames: this.stats.skipped,
      updateMs: this.stats.update.summary(), renderSubmitMs: this.stats.render.summary(), frameIntervalMs: this.stats.interval.summary(),
      reducedMotion: this.motion.reduced,
    };
  }
  resetPerf() { this.stats = { update: new Stats(), render: new Stats(), interval: new Stats(), rendered: 0, skipped: 0, since: performance.now() }; }

  // ---------------------------------------------------------------- view
  toWorld(gx, gy) { const s = this.world.scale.x; return { x: (gx - this.world.x) / s, y: (gy - this.world.y) / s }; }
  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of Object.values(this.store.doc.nodes)) {
      const s = this.skin.size(n);
      x0 = Math.min(x0, n.pos[0] - 10); y0 = Math.min(y0, n.pos[1] - 16);
      x1 = Math.max(x1, n.pos[0] + s.w + 10); y1 = Math.max(y1, n.pos[1] + s.h + 44);
    }
    return { x0, y0, x1, y1 };
  }
  fit() {
    if (!Object.keys(this.store.doc.nodes).length) return;
    const { x0, y0, x1, y1 } = this.bounds();
    const W = this.app.screen.width, H = this.app.screen.height, pad = W < 600 ? 14 : 36;
    const sw = (W - 2 * pad) / (x1 - x0), sh = (H - 2 * pad) / (y1 - y0);
    let s = Math.min(1.4, sw, sh);
    let left = (W - (x1 - x0) * s) / 2 - x0 * s;
    // phones: a chain this wide would be unreadable; keep it legible and let it scroll (the chain strip pans it)
    if (sw < 0.42 && sh > sw) { s = Math.max(sw, Math.min(sh, 0.8)); left = pad - x0 * s; }
    this.world.scale.set(s);
    this.world.position.set(left, (H - (y1 - y0) * s) / 2 - y0 * s);
    this._viewChanged();
  }
  /** Horizontal position along the chain, 0..1, and how much of it is visible. */
  chainView() {
    const { x0, x1 } = this.bounds(), s = this.world.scale.x, W = this.app.screen.width;
    const span = (x1 - x0) * s;
    const visible = Math.min(1, W / span), travel = span - W;
    return { visible, pos: travel > 0 ? Math.max(0, Math.min(1, (-this.world.x - x0 * s) / travel)) : 0 };
  }
  scrollChain(pos) {
    const { x0, x1 } = this.bounds(), s = this.world.scale.x, W = this.app.screen.width;
    const travel = (x1 - x0) * s - W;
    if (travel <= 0) return;
    this.world.x = -(x0 * s + pos * travel);
    this._viewChanged(false);
  }
  _viewChanged(emit = true) {
    const W = this.app.screen.width, H = this.app.screen.height;
    if (this.paper) { this.paper.width = W; this.paper.height = H; const s = Math.max(0.5, Math.min(2, this.world.scale.x)); this.paper.tileScale.set(s * 0.75); this.paper.tilePosition.set(this.world.x, this.world.y); }
    this._drawGrid();
    this._legendLOD();
    this.dirty = true;
    if (emit) this.dispatchEvent(new CustomEvent('view', { detail: this.chainView() }));
  }
  _drawGrid() {
    const g = this.grid, T = this.theme, s = this.world.scale.x;
    const W = this.app.screen.width, H = this.app.screen.height;
    g.clear();
    let step = 24 * s; while (step < 14) step *= 2;
    const ox = ((this.world.x % step) + step) % step, oy = ((this.world.y % step) + step) % step;
    for (let x = ox; x < W; x += step) for (let y = oy; y < H; y += step) g.rect(x - 0.7, y - 0.7, 1.4, 1.4);
    g.fill({ color: T.gridMajor, alpha: 0.55 });
  }
  _legendLOD() {
    const show = (size) => size * this.world.scale.x >= LEGEND_MIN_PX;
    for (const v of this.views.values()) v.legends.visible = show(v.legendSize || 7);
  }

  // ---------------------------------------------------------------- document
  _onDoc(kind) {
    this.dirty = true;
    if (kind === 'layout') { for (const [id, v] of this.views) { const n = this.store.doc.nodes[id]; if (n) v.root.position.set(n.pos[0], n.pos[1]); } return; }
    const before = new Set(this.views.keys());
    this.rebuild(kind === 'load');
    if (kind === 'load') { this.edgeSeen = new Set(Object.keys(this.store.doc.edges)); this.settleAll(); return; }
    // settle: a device just added draws its glyph in; a cable just wired draws itself along
    const now = performance.now();
    for (const [id, v] of this.views) if (!before.has(id)) this._startSettle(v, now);
    for (const id of Object.keys(this.store.doc.edges)) if (!this.edgeSeen.has(id)) { this.edgeSeen.add(id); if (!motionReduced()) this.edgeSettle.set(id, now); }
  }
  _startSettle(v, at) { if (!motionReduced() && this.skin.liveGlyphs) v.settleAt = at; }
  /** Every glyph settles, staggered along the chain (after a preset loads, or when the intro ends). */
  settleAll() {
    const now = performance.now();
    const order = [...this.views.values()].sort((a, b) => (a.node?.pos[0] ?? 0) - (b.node?.pos[0] ?? 0));
    order.forEach((v, i) => this._startSettle(v, now + i * 55));
    this.dirty = true;
  }
  _accent(node) { return this.skin.mono ? this.theme.accent : this.theme.accents[TYPES[node.type].color] ?? this.theme.ink; }

  rebuild(force = false) {
    const doc = this.store.doc;
    for (const [id, v] of this.views) if (!doc.nodes[id]) { v.root.destroy({ children: true }); this.views.delete(id); }
    for (const [id, node] of Object.entries(doc.nodes)) {
      let v = this.views.get(id);
      if (!v) { v = new NodeView(this, id); this.views.set(id, v); this.nodesLayer.addChild(v.root); this._wireNodeEvents(v); force = true; }
      v.root.position.set(node.pos[0], node.pos[1]);
      const eng = this.engine?.nodes?.get(id);
      const sig = JSON.stringify([node.type, node.label, node.bypass, node.config, node.params, node.model, node.ir, this.selected?.id === id, this.theme.name, this.skin.name, eng?.status, eng?.irName]);
      if (force || sig !== v.sig) { v.sig = sig; this._drawNode(v, node); v.glyphKey = ''; }
    }
    if (this.selected?.kind === 'node' && !doc.nodes[this.selected.id]) this.select(null);
    if (this.selected?.kind === 'edge' && !doc.edges[this.selected.id]) this.select(null);
    this._legendLOD();
    this.dirty = true;
  }

  _text(v, str, x, y, opts = {}) {
    const T = this.theme;
    const t = new Text({
      text: str, resolution: TEXT_RES,
      style: {
        fontFamily: opts.font || UI_FONT, fontSize: opts.size || 9, fill: opts.color ?? T.inkDim,
        fontWeight: opts.weight || '500', fontStyle: opts.italic ? 'italic' : 'normal', letterSpacing: opts.spacing ?? 0.3,
      },
    });
    t.anchor.set(opts.ax ?? 0.5, opts.ay ?? 0.5);
    t.position.set(x, y);
    (opts.layer || v.texts).addChild(t);
    return t;
  }

  _drawNode(v, node) {
    const T = this.theme, skin = this.skin, size = skin.size(node), accent = this._accent(node);
    const eng = this.engine?.nodes?.get(v.id);
    const k = skin.scaleOf?.(node) ?? 1;
    const c = { theme: T, accent, selected: this.selected?.kind === 'node' && this.selected.id === v.id, bypass: node.bypass, status: eng?.status, k };
    v.size = size; v.node = node; v.k = k;
    v.body.clear(); v.knobG.clear(); v.glyph.clear();
    for (const layer of [v.texts, v.legends]) layer.removeChildren().forEach((t) => t.destroy());
    const tex = skin.textureFor?.(node, T.name);
    if (tex) {
      if (!v.sprite) { v.sprite = new Sprite(tex); v.root.addChildAt(v.sprite, 0); }
      v.sprite.texture = tex;
      v.sprite.width = size.w; v.sprite.height = size.h; v.sprite.alpha = node.bypass ? 0.62 : 1;
    } else {
      if (v.sprite) { v.sprite.destroy(); v.sprite = null; }
      skin.drawBody(v.body, node, c);
    }
    v.root.hitArea = new Rectangle(-10, -14, size.w + 20, size.h + 46);
    v.brushes ||= brushesFor(node.type);
    v.glyphBox = skin.liveGlyphs ? skin.glyphBox?.(node) : null;

    // the device's name, under it, in the hand's voice (Lora italic); the selection is a gold brush underline
    const tl = skin.title(node, size);
    const title = tl.below
      ? this._text(v, node.label, tl.x, tl.y, { font: HAND_FONT, italic: true, size: tl.size, color: node.bypass ? T.inkDim : T.ink, weight: '500', spacing: 0.1 })
      : this._text(v, node.label.toUpperCase(), tl.x, tl.y, { font: UI_FONT, size: tl.size, color: node.bypass ? T.inkDim : T.ink, weight: '700', spacing: 1.2, ax: tl.left ? 0 : 0.5 });
    const maxW = tl.below ? size.w + 36 : node.type === 'nam' ? 142 : size.w - 26;
    if (title.width > maxW) title.scale.set(maxW / title.width);
    if (c.selected) {
      const w = Math.max(40, title.width + 16), y = tl.y + title.height / 2 + 1;
      this.selBrush.draw(v.body, [[tl.x - w / 2, y + 1.5], [tl.x - w / 6, y], [tl.x + w / 5, y + 0.8], [tl.x + w / 2, y - 1]], 4.4, { n: 16, color: T.accent, paper: T.bg, dry: 0.45, entry: 0.06, exit: 0.45 });
    }
    v.titleY = tl.y;

    // knobs (pen) with their legends; legends hide when too small to read (LOD)
    const specs = paramsOf(node);
    const utility = node.type === 'splitter' || node.type === 'mixer';
    v.knobs = skin.knobs(node, faceOf(node), size).map((q) => ({ ...q, spec: specs[q.key] }));
    v.legendSize = tex ? 6.2 : 7.4;
    // a device with its own finish (Bloom's lacquer) recolours its knobs and legends; everything else keeps the theme
    const KT = skin.face?.(node, T, 'knob') ?? T, LT = skin.face?.(node, T, 'legend') ?? T;
    const kc = KT === T ? c : { ...c, theme: KT };
    for (const q of v.knobs) {
      const val = node.params[q.key];
      skin.drawKnob(v.knobG, q.x, q.y, q.r, toNorm(q.spec, val), kc, q.spec.min < 0 && q.spec.max > 0 && q.key.startsWith('pan'));
      const lab = utility ? (q.key === 'master' ? 'MASTER' : q.key.startsWith('pan') ? 'PAN' : 'LEVEL') : q.spec.label.toUpperCase();
      const L = q.legend || { x: q.x, y: q.y + q.r + 9, ax: 0.5 };
      const dragging = this.drag?.knob === q.key && this.drag?.id === v.id;
      q.label = lab;
      if (utility && tex && q.key !== 'master' && !dragging) continue; // rows carry letters; the inspector names them
      q.valueText = this._text(v, dragging ? formatValue(q.spec, val) : lab, L.x, L.y, { size: v.legendSize, spacing: 0.6, weight: '600', ax: L.ax, layer: dragging ? v.texts : v.legends, font: dragging ? MONO_FONT : UI_FONT, color: dragging ? LT.accent : LT.inkDim });
    }
    // ports, rows, readouts
    const ports = skin.ports(node, size);
    v.ports = { ins: ports.ins, outs: ports.outs };
    if (utility) {
      const rows = node.type === 'splitter' ? ports.outs : ports.ins;
      rows.forEach((p, i) => this._text(v, String.fromCharCode(65 + i), tex ? (node.type === 'splitter' ? size.w - 70 * k : 70 * k) : 30, p.y, { font: HAND_FONT, italic: true, size: 13 * (tex ? k * 1.2 : 1), color: T.ink, weight: '600' }));
    }
    // text lines under the device name (art skins); the classic ink skin keeps its own spots inside the body
    const INK_SPOTS = { nam: 72, cab: size.h - 50, input: 92 };
    const below = (str, row, opts = {}) => (tl.below
      ? this._text(v, str, size.w / 2, tl.y + 19 + row * 11.5, { size: 9, color: T.inkDim, ...opts })
      : this._text(v, str, size.w / 2, opts.cpu ? size.h + 12 : INK_SPOTS[node.type] ?? size.h + 24, { size: 9, color: T.inkDim, ...opts }));
    if (node.type === 'nam') {
      const info = node.model ? (this.store.doc.models[node.model] || this.library?.info(node.model)) : null;
      const status = eng?.status;
      const line = !node.model ? 'drop a .nam here' : status === 'missing' ? 'model missing' : status === 'error' ? 'load error' : status === 'loading' ? 'loading…' : (info?.name || node.model.slice(7, 19));
      const warn = status === 'error' || status === 'missing';
      if (tex && v.knobs.length >= 2) {
        // the capture's name sits on the control panel, between the two knobs the head has
        const [a, b] = [...v.knobs].sort((p, q) => p.x - q.x);
        const t = this._text(v, line, (a.x + b.x) / 2, a.y, { font: HAND_FONT, italic: true, size: 10, color: warn ? T.seal : T.inkDim, weight: '500', spacing: 0 });
        const room = b.x - a.x - a.r - b.r - 10;
        if (t.width > room) t.scale.set(room / t.width);
      } else below(line, 0, { color: warn ? T.seal : T.inkDim });
      if (info?.family && !tex) this._text(v, info.family, size.w - 16, 20, { font: MONO_FONT, size: 9, color: T.accent, ax: 1, weight: '700' });
    }
    let row = 0;
    if (node.type === 'cab') below(eng?.irName && eng.irName !== 'synthetic' ? `IR: ${eng.irName}` : `${['4x12', '2x12', '1x12'][Math.round(node.params.voice)]} · synthetic IR`, row++);
    if (node.type === 'input') {
      const live = Math.round(node.params.source) === 1;
      below(live ? `interface · ${['in 1', 'in 2', 'in 1+2'][Math.round(node.params.channel)]}` : 'DI loop (CC BY)', row++);
    }
    v.cpuText = below('', row, { font: MONO_FONT, size: 8.5, color: T.inkDim, cpu: true });

    for (const p of [...ports.ins, ...ports.outs]) v.knobG.circle(p.x, p.y, 3.4).fill({ color: T.paper }).stroke({ width: 1.3, color: node.bypass ? T.inkDim : T.ink });
    v.fs = skin.footswitch(node, size);
    v.led = skin.led(node, size);
  }

  // ---------------------------------------------------------------- frame
  _portPos(nodeId, dir, port) {
    const v = this.views.get(nodeId); const n = this.store.doc.nodes[nodeId];
    if (!v || !v.ports) return null;
    const p = v.ports[dir][port];
    if (!p) return null;
    return { x: n.pos[0] + p.x + (dir === 'outs' ? 3 : -3), y: n.pos[1] + p.y };
  }

  _tick(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this.stats.interval.push(now - this._last);
    this._last = now;
    const t0 = performance.now();
    const eng = this.engine, running = eng?.ctx?.state === 'running';
    if (running) eng.pollLevels();
    const moving = this.motion.update(dt, running);
    const settling = [...this.views.values()].some((v) => v.settleAt != null) || this.edgeSettle.size > 0;
    const texts = now - this.lastTexts > 300 && running;
    if (!(moving || settling || this.dirty || this.drag || texts || this._wasMoving)) { this.stats.skipped++; return; }
    this._wasMoving = moving || settling; // one more frame after motion stops, to draw the rest state
    this._update(dt, now, running);
    const t1 = performance.now();
    this.app.render();
    const t2 = performance.now();
    this.stats.update.push(t1 - t0); this.stats.render.push(t2 - t1); this.stats.rendered++;
    this.dirty = false;
  }

  _update(dt, now, running) {
    const T = this.theme, doc = this.store.doc, eng = this.engine, M = this.motion;
    const reduced = M.reduced;
    // ---- cables: brush strokes whose weight, wetness and bleed follow the source's level
    const w = this.cables, fg = this.flowG;
    w.clear(); fg.clear();
    this._curves = [];
    const pts = [];
    for (const [eid, e] of Object.entries(doc.edges)) {
      const a = this._portPos(e.from[0], 'outs', e.from[1]), b = this._portPos(e.to[0], 'ins', e.to[1]);
      if (!a || !b) continue;
      const c = bezier(a, b);
      this._curves.push({ id: eid, c });
      const sel = this.selected?.kind === 'edge' && this.selected.id === eid;
      const energy = M.edge(e.from[0], e.from[1]);
      let reach = 1;
      const st = this.edgeSettle.get(eid);
      if (st != null) { reach = easeOut(Math.min(1, (now - st) / CABLE_SETTLE_MS)); if (reach >= 1) this.edgeSettle.delete(eid); }
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      sampleBezier(c, 7, pts);
      const width = (sel ? 3.4 : 2.3) + energy * 2.6;
      const color = sel ? T.accent : mix(T.inkDim, T.ink, Math.min(1, 0.25 + energy * 1.1));
      this.cableBrush.draw(w, pts, width, {
        n: Math.max(12, Math.min(40, Math.round(len / 10))), reach, color, alpha: 0.95, paper: T.bg,
        dry: reduced ? 0.5 : Math.max(0.12, 0.8 - energy * 0.9), bleed: reduced ? 0 : energy * 0.9,
        widthFn: (t) => width * pressure(t, 0.03, 0.08, 0) * (0.92 + 0.08 * Math.sin(Math.PI * t)),
      });
      // ink carried along the cable: dabs drift at 20 + 260 * level px/s (not under reduced motion)
      if (!reduced && energy > 0.03 && reach >= 1) {
        const ph = ((this.flow.get(eid) ?? (hashSeed(eid) % 1000) / 1000) + (dt * (20 + 260 * energy)) / Math.max(60, len * 1.15)) % 1;
        this.flow.set(eid, ph);
        const dabs = Math.max(2, Math.round(len / 90));
        for (let i = 0; i < dabs; i++) {
          const t = (ph + i / dabs) % 1, t2 = Math.min(1, t + 0.05);
          if (t2 - t < 0.02) continue;
          const p0 = bezPoint(c, t), p1 = bezPoint(c, (t + t2) / 2), p2 = bezPoint(c, t2);
          this.flowBrush.draw(fg, [[p0.x, p0.y], [p1.x, p1.y], [p2.x, p2.y]], width * 0.95, { n: 8, color: T.accent, alpha: 0.35 + 0.6 * energy, entry: 0.3, exit: 0.6, belly: 0.3, dry: 0 });
        }
      }
    }
    // ---- per device: glyph (brush), LED, meter for art-less devices
    for (const [id, v] of this.views) {
      const n = doc.nodes[id]; if (!n || !v.size) continue;
      const m = M.node(id);
      let reach = 1, settleT = 1;
      if (v.settleAt != null) {
        settleT = (now - v.settleAt) / SETTLE_MS;
        if (settleT < 0) reach = 0;
        else if (settleT >= 1) { v.settleAt = null; settleT = 1; }
        else reach = easeOut(Math.max(0, (settleT - 0.18) / 0.82));
      }
      if (v.glyphBox) {
        const key = `${Math.round(m.vis * 120)},${Math.round(m.env * 120)},${Math.round(m.grN * 120)},${Math.round(m.clip * 60)},${Math.round(m.cutN * 120)},${Math.round(m.tail * 120)},${Math.round(m.open * 60)},${Math.round(Math.min(1, m.onset) * 60)},${Math.round(m.pick * 90)},${Math.round(m.sus * 120)},${m.outs.map((x) => Math.round(x * 60))},${m.ins.map((x) => Math.round(x * 60))},${reach.toFixed(3)},${settleT < 1}`;
        if (key !== v.glyphKey) {
          v.glyphKey = key;
          v.glyph.clear();
          const GT = this.skin.face?.(n, T, 'glyph') ?? T;
          if (settleT < 1 && settleT >= 0 && this.settle) this.settle.draw(v.glyph, v.glyphBox, settleT, n.type === 'reverb' ? 'B' : 'A', GT.inkDim, v.brushes.extra);
          if (reach > 0) drawGlyph(v.glyph, n, v.glyphBox, m, { theme: GT, reach, selected: this.selected?.id === id, ports: v.ports, reduced }, v.brushes);
        }
      }
      const g = v.live; g.clear();
      if (v.led) {
        const on = !n.bypass, LT = this.skin.face?.(n, T, 'led') ?? T;
        const drive = n.type === 'compressor' || n.type === 'limiter' ? Math.max(m.grN * 1.4, m.vis * 0.4) : n.type === 'bloom' ? Math.max(m.vis, m.pick) : m.vis;
        const glow = on ? Math.min(1, 0.25 + 0.75 * drive) : 0;
        const r = Math.max(2.6, (v.led.r || 3.2) * 0.9);
        if (n.type === 'bloom' && v.glyphBox) bloomGlow(g, v.glyphBox, v.led, m, on, reduced, T);
        if (on && glow > 0.3) g.circle(v.led.x, v.led.y, r * 2.6).fill({ color: LT.accent, alpha: 0.14 * glow });
        g.circle(v.led.x, v.led.y, r).fill({ color: on ? LT.accent : LT.paper, alpha: on ? 0.45 + 0.55 * glow : 1 }).stroke({ width: 1, color: n.bypass ? LT.inkDim : LT.ink, alpha: 0.8 });
      }
      if (!v.glyphBox) {
        // art-less device (ink skin): a thin ink meter on the right inner edge; the limit is seal red
        const mh = Math.min(70, v.size.h - 40), mx = v.size.w - 7, my = 22 + mh;
        g.rect(mx - 1.5, my - mh, 3, mh).fill({ color: T.inkFaint, alpha: 0.35 });
        if (m.vis > 0) g.rect(mx - 1.5, my - mh * m.vis, 3, mh * m.vis).fill({ color: m.clip > 0.5 ? T.seal : T.ink, alpha: 0.85 });
      }
    }
    // ---- in-progress wire
    const o = this.overlay; o.clear();
    if (this.drag?.kind === 'wire') {
      const a = this.drag.from, b = this.drag.to;
      sampleBezier(bezier(a, b), 7, pts);
      this.cableBrush.draw(o, pts, 3, { n: 24, color: T.accent, alpha: 0.95, dry: 0.3, paper: T.bg, entry: 0.03, exit: 0.1, belly: 0 });
      o.circle(b.x, b.y, 5).stroke({ width: 1.5, color: T.accent });
    }
    // ---- CPU readouts, a few times a second
    if (now - this.lastTexts > 300 && eng?.nodes) {
      this.lastTexts = now;
      for (const [id, v] of this.views) {
        const en = eng.nodes.get(id), n = doc.nodes[id];
        if (!v.cpuText || !n) continue;
        const s = en?.stats;
        const txt = n.bypass ? 'bypassed' : s && running ? `${(s.cpuUs / 1000).toFixed(3)} ms · ${((100 * s.cpuUs) / s.budgetUs).toFixed(1)}%` : en && !s && TYPES[n.type].worklet === undefined && n.type !== 'nam' ? 'native' : '';
        if (v.cpuText.text !== txt) v.cpuText.text = txt;
      }
    }
  }

  // ---------------------------------------------------------------- input
  select(sel) {
    this.selected = sel;
    this.rebuild();
    this.dispatchEvent(new CustomEvent('select', { detail: sel }));
  }

  _hitKnob(v, lx, ly) {
    // at least ~30 px (44 px on touch) on screen, nearest knob wins where targets overlap
    const min = (this.touch ? 22 : 15) / this.world.scale.x;
    let best = null, bd = Infinity;
    for (const q of v.knobs || []) {
      const d = (lx - q.x) ** 2 + (ly - q.y) ** 2, R = Math.max(q.r + 5, Math.min(min, q.r * 2.2));
      if (d <= R * R && d < bd) { bd = d; best = q; }
    }
    return best;
  }
  _hitPort(v, lx, ly, dir) {
    const R = Math.max(11, (this.touch ? 20 : 12) / this.world.scale.x);
    return (v.ports?.[dir] || []).findIndex((p) => (lx - p.x) ** 2 + (ly - p.y) ** 2 <= R ** 2);
  }

  _wireNodeEvents(v) {
    // the cursor says what a press will do: turn a knob, pull a cable, stomp, or move the device
    v.root.on('pointermove', (e) => {
      if (this.drag) return;
      const lp = v.root.toLocal(e.global);
      const cur = this._hitPort(v, lp.x, lp.y, 'outs') >= 0 || this._hitPort(v, lp.x, lp.y, 'ins') >= 0 ? 'crosshair'
        : this._hitKnob(v, lp.x, lp.y) ? 'ns-resize'
          : v.fs && (lp.x - v.fs.x) ** 2 + (lp.y - v.fs.y) ** 2 <= (v.fs.r + 6) ** 2 ? 'pointer' : 'grab';
      if (v.root.cursor !== cur) v.root.cursor = cur;
    });
    v.root.on('pointerdown', (e) => {
      e.stopPropagation();
      this.app.canvas.focus();
      const n = this.store.doc.nodes[v.id];
      const lp = v.root.toLocal(e.global);
      const outP = this._hitPort(v, lp.x, lp.y, 'outs');
      if (outP >= 0) { this.drag = { kind: 'wire', from: this._portPos(v.id, 'outs', outP), fromRef: [v.id, outP], to: this.toWorld(e.global.x, e.global.y) }; return; }
      const inP = this._hitPort(v, lp.x, lp.y, 'ins');
      if (inP >= 0) {
        // pick up an existing wire from this input
        const hit = Object.entries(this.store.doc.edges).find(([, ed]) => ed.to[0] === v.id && ed.to[1] === inP);
        if (hit) {
          const [eid, ed] = hit;
          this.store.disconnect(eid);
          this.drag = { kind: 'wire', from: this._portPos(ed.from[0], 'outs', ed.from[1]), fromRef: ed.from, to: this.toWorld(e.global.x, e.global.y) };
        }
        return;
      }
      const k = this._hitKnob(v, lp.x, lp.y);
      if (k) {
        if (this.selected?.id !== v.id) this.select({ kind: 'node', id: v.id });
        this.drag = { kind: 'knob', id: v.id, knob: k.key, spec: k.spec, y0: e.global.y, t0: toNorm(k.spec, n.params[k.key]) };
        return;
      }
      if (v.fs && (lp.x - v.fs.x) ** 2 + (lp.y - v.fs.y) ** 2 <= (v.fs.r + 6) ** 2 && bypassable(n)) {
        this.store.setBypass(v.id, !n.bypass);
        return;
      }
      this.select({ kind: 'node', id: v.id });
      v.root.cursor = 'grabbing';
      this.drag = { kind: 'node', id: v.id, dx: lp.x, dy: lp.y };
    });
  }

  _bgDown(e) {
    this.app.canvas.focus();
    const p = this.toWorld(e.global.x, e.global.y);
    const hit = this._hitWire(p);
    if (hit) { this.select({ kind: 'edge', id: hit }); return; }
    if (this.selected) this.select(null);
    this.drag = { kind: 'pan', x0: e.global.x, y0: e.global.y, wx: this.world.x, wy: this.world.y };
  }
  _hitWire(p) {
    let best = null, bd = ((this.touch ? 14 : 9) / this.world.scale.x) ** 2;
    for (const { id, c } of this._curves || []) {
      for (let i = 0; i <= 40; i++) {
        const q = bezPoint(c, i / 40), d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < bd) { bd = d; best = id; }
      }
    }
    return best;
  }

  _move(e) {
    const d = this.drag;
    if (!d) return;
    this.dirty = true;
    if (d.kind === 'pan') {
      this.world.position.set(d.wx + e.global.x - d.x0, d.wy + e.global.y - d.y0);
      this._viewChanged();
    } else if (d.kind === 'node') {
      const p = this.toWorld(e.global.x, e.global.y);
      const snap = (x) => Math.round(x / 10) * 10;
      this.store.moveNode(d.id, [snap(p.x - d.dx), snap(p.y - d.dy)]);
    } else if (d.kind === 'knob') {
      const fine = e.shiftKey ? 600 : 160;
      const t = d.t0 + (d.y0 - e.global.y) / fine;
      const val = fromNorm(d.spec, t);
      if (this.store.doc.nodes[d.id].params[d.knob] !== val) this.store.setParam(d.id, d.knob, val);
    } else if (d.kind === 'wire') {
      d.to = this.toWorld(e.global.x, e.global.y);
    }
  }

  _up(e) {
    const d = this.drag;
    this.drag = null;
    this.dirty = true;
    if (!d) return;
    if (d.kind === 'node') { const v = this.views.get(d.id); if (v) v.root.cursor = 'grab'; }
    if (d.kind === 'knob') this.rebuild(true);
    if (d.kind === 'wire') {
      const p = this.toWorld(e.global.x, e.global.y);
      const R = Math.max(16, (this.touch ? 24 : 16) / this.world.scale.x);
      for (const [id, v] of this.views) {
        const n = this.store.doc.nodes[id];
        const idx = (v.ports?.ins || []).findIndex((q) => (p.x - n.pos[0] - q.x) ** 2 + (p.y - n.pos[1] - q.y) ** 2 <= R ** 2);
        if (idx >= 0) {
          const ok = this.store.connect(d.fromRef, [id, idx]);
          if (!ok) this.dispatchEvent(new CustomEvent('toast', { detail: 'That connection would make a loop (or already exists).' }));
          return;
        }
      }
    }
  }

  _wheel(e) {
    e.preventDefault();
    const rect = this.app.canvas.getBoundingClientRect();
    const gx = e.clientX - rect.left, gy = e.clientY - rect.top;
    const p = this.toWorld(gx, gy);
    // wheel over a knob turns it
    for (const [id, v] of this.views) {
      const n = this.store.doc.nodes[id];
      const k = this._hitKnob(v, p.x - n.pos[0], p.y - n.pos[1]);
      if (k && !e.ctrlKey) {
        const t = toNorm(k.spec, n.params[k.key]) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.025);
        this.store.setParam(id, k.key, fromNorm(k.spec, t));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || (Math.abs(e.deltaY) > 0 && !e.shiftKey && e.deltaMode === 0 && Math.abs(e.deltaX) < 1)) {
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const s = Math.min(3, Math.max(0.2, this.world.scale.x * f));
      this.world.scale.set(s);
      this.world.position.set(gx - p.x * s, gy - p.y * s);
    } else {
      this.world.position.set(this.world.x - e.deltaX, this.world.y - e.deltaY);
    }
    this._viewChanged();
  }

  _dbl(e) {
    const rect = this.app.canvas.getBoundingClientRect();
    const p = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    for (const [id, v] of this.views) {
      const n = this.store.doc.nodes[id];
      const k = this._hitKnob(v, p.x - n.pos[0], p.y - n.pos[1]);
      if (k) { this.store.setParam(id, k.key, k.spec.def); return; }
      if (p.x >= n.pos[0] && p.x <= n.pos[0] + v.size.w && p.y >= n.pos[1] && p.y <= n.pos[1] + v.size.h) return;
    }
    this.dispatchEvent(new CustomEvent('add-at', { detail: { world: p, client: { x: e.clientX, y: e.clientY } } }));
  }

  _key(e) {
    const sel = this.selected;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault();
      if (sel.kind === 'node') this.store.removeNode(sel.id); else this.store.disconnect(sel.id);
    } else if (e.key === 'Tab') {
      const ids = Object.entries(this.store.doc.nodes).sort((a, b) => a[1].pos[0] - b[1].pos[0] || a[1].pos[1] - b[1].pos[1]).map(([id]) => id);
      if (!ids.length) return;
      e.preventDefault();
      const i = sel?.kind === 'node' ? ids.indexOf(sel.id) : -1;
      const id = ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length];
      this.select({ kind: 'node', id });
      this._reveal(id);
    } else if (e.key === 'Escape' && sel) {
      this.select(null);
    } else if (sel?.kind === 'node' && e.key.toLowerCase() === 'b') {
      const n = this.store.doc.nodes[sel.id];
      if (bypassable(n)) this.store.setBypass(sel.id, !n.bypass);
    } else if (sel?.kind === 'node' && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const n = this.store.doc.nodes[sel.id], s = e.shiftKey ? 50 : 10;
      const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
      this.store.moveNode(sel.id, [n.pos[0] + dx, n.pos[1] + dy]);
    } else if (e.key === 'f') this.fit();
  }

  /** Pan just enough to bring a device into view (keyboard selection on a scrolled chain). */
  _reveal(id) {
    const n = this.store.doc.nodes[id], v = this.views.get(id);
    if (!n || !v) return;
    const s = this.world.scale.x, W = this.app.screen.width, pad = 24;
    const x0 = this.world.x + n.pos[0] * s, x1 = x0 + v.size.w * s;
    if (x0 < pad) this.world.x += pad - x0; else if (x1 > W - pad) this.world.x -= x1 - (W - pad);
    this._viewChanged();
  }

  /** World-space hit test used by drag-and-drop. */
  nodeAt(clientX, clientY) {
    const rect = this.app.canvas.getBoundingClientRect();
    const p = this.toWorld(clientX - rect.left, clientY - rect.top);
    for (const [id, v] of this.views) {
      const n = this.store.doc.nodes[id];
      if (p.x >= n.pos[0] && p.x <= n.pos[0] + v.size.w && p.y >= n.pos[1] && p.y <= n.pos[1] + v.size.h) return { id, node: n, world: p };
    }
    return { id: null, node: null, world: p };
  }
}

export { insOf, outsOf };

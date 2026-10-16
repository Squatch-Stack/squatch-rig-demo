// Colour tokens for the canvas. The single source is css/app.css: the canvas
// reads the same custom properties the DOM chrome uses, so a colour (seal red
// included) is defined exactly once. Palette: squatch.cc warm, see
// design/DIRECTION.md section 4.
//
// A theme object carries 0xRRGGBB numbers for Pixi plus the raw CSS strings
// (`css`) for SVG token substitution.
const TOKENS = ['canvas', 'paper', 'paper-2', 'paper-hi', 'ink', 'ink-soft', 'ink-faint', 'rule', 'accent', 'seal', 'shadow', 'bloom', 'bloom-leaf', 'bloom-led'];

const hex = (s) => parseInt(String(s).trim().replace('#', '').slice(0, 6), 16);
const cache = {};

// There is no fallback table: a second copy of the palette is what drifted before (squatch-skin
// INVENTORY I-7). A page without app.css fails here, by name, instead of drawing in stale colours.
function readTokens(name) {
  const out = {};
  if (typeof document === 'undefined' || !document.body) throw new Error('theme: no document to read web/css/app.css from');
  const probe = document.createElement('div');
  probe.dataset.theme = name;
  probe.hidden = true;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  for (const t of TOKENS) { const v = cs.getPropertyValue(`--${t}`).trim(); if (/^#[0-9a-f]{6}/i.test(v)) out[t] = v; }
  probe.remove();
  const missing = TOKENS.filter((t) => !(t in out));
  if (missing.length) throw new Error(`theme ${name}: web/css/app.css does not define ${missing.map((t) => `--${t}`).join(' ')}`);
  return out;
}

export function getTheme(name) {
  if (cache[name]) return cache[name];
  const c = readTokens(name);
  const n = (k) => hex(c[k]);
  const T = {
    name,
    css: c,
    bg: n('canvas'), paper: n('paper'), paper2: n('paper-2'), paperHi: n('paper-hi'),
    ink: n('ink'), inkDim: n('ink-soft'), inkFaint: n('ink-faint'), rule: n('rule'),
    accent: n('accent'), seal: n('seal'), shadow: n('shadow'),
    bloom: n('bloom'), bloomLeaf: n('bloom-leaf'), bloomLed: n('bloom-led'),
    // derived roles
    danger: n('seal'), wire: n('ink-soft'), wireSel: n('accent'), pulse: n('accent'),
    gridMajor: mix(n('canvas'), n('ink-soft'), name === 'dark' ? 0.32 : 0.28),
    tint: name === 'dark' ? 0.05 : 0.04,
    bloomDim: mix(n('bloom'), n('bloom-leaf'), 0.45), // bypassed leaf: dim, still readable on the field
  };
  // the classic ink skin tints bodies by device family; everything maps to the one accent
  T.accents = new Proxy({}, { get: () => T.accent });
  cache[name] = T;
  return T;
}

export const THEMES = new Proxy({}, { get: (_, k) => (k === 'dark' || k === 'light' ? getTheme(k) : undefined) });

export function preferredTheme() {
  try {
    const saved = localStorage.getItem('squatch-rig:theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* storage unavailable */ }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Mix two 0xRRGGBB colours. */
export function mix(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

/** Motion preference: the in-app setting wins in both directions, else the OS. */
export function motionReduced() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'reduced') return true;
  if (pref === 'full') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

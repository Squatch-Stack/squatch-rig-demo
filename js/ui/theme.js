// Colour tokens for the canvas. The single source is css/app.css: the canvas
// reads the same custom properties the DOM chrome uses, so a colour (seal red
// included) is defined exactly once. Palette: squatch.cc warm, see
// design/DIRECTION.md section 4.
//
// A theme object carries 0xRRGGBB numbers for Pixi plus the raw CSS strings
// (`css`) for SVG token substitution.
const TOKENS = ['canvas', 'paper', 'paper-2', 'paper-hi', 'ink', 'ink-soft', 'ink-faint', 'rule', 'accent', 'seal', 'shadow', 'bloom', 'bloom-leaf', 'bloom-led'];

// Used only if the stylesheet is missing (tests, or a page without app.css).
const FALLBACK = {
  dark: { canvas: '#100D09', paper: '#1A150F', 'paper-2': '#231D15', 'paper-hi': '#201A12', ink: '#EDE6D8', 'ink-soft': '#A89878', 'ink-faint': '#4A4034', rule: '#3A3226', accent: '#D4A93F', seal: '#D9553D', shadow: '#000000', bloom: '#1F3A2C', 'bloom-leaf': '#D4A93F', 'bloom-led': '#E0674F' },
  light: { canvas: '#EEE9DF', paper: '#F7F5F0', 'paper-2': '#E8E0D4', 'paper-hi': '#FCFBF8', ink: '#1C160E', 'ink-soft': '#6B5B3E', 'ink-faint': '#CBBFA9', rule: '#D4CBBB', accent: '#9C7208', seal: '#9A2E1B', shadow: '#6B5B3E', bloom: '#1F3A2C', 'bloom-leaf': '#C9A04A', 'bloom-led': '#E0674F' },
};

const hex = (s) => parseInt(String(s).trim().replace('#', '').slice(0, 6), 16);
const cache = {};

function readTokens(name) {
  const out = { ...FALLBACK[name] };
  if (typeof document === 'undefined' || !document.body) return out;
  const probe = document.createElement('div');
  probe.dataset.theme = name;
  probe.hidden = true;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  for (const t of TOKENS) { const v = cs.getPropertyValue(`--${t}`).trim(); if (/^#[0-9a-f]{6}/i.test(v)) out[t] = v; }
  probe.remove();
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

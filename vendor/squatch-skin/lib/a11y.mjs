// The accessibility contract every theme, and every theme-plus-skin combination, must meet.
// Checked by the token build (a theme that fails does not build) and by the skin validator.
import { contrast, worstCaseDelta, parseColor, toHex } from './color.mjs';

const T = 'semantic.color.';
const C = 'component.';

// [foreground, background, minimum ratio, why]. WCAG 2.2: 4.5 for text (1.4.3), 3 for the parts of a
// control you need to see to use it (1.4.11).
export const CONTRAST_PAIRS = [
  [`${T}text.primary`, `${T}surface.page`, 4.5, 'body text'],
  [`${T}text.primary`, `${T}surface.sunken`, 4.5, 'text on a panel'],
  [`${T}text.secondary`, `${T}surface.page`, 4.5, 'labels'],
  [`${T}text.secondary`, `${T}surface.sunken`, 4.5, 'labels on a panel'],
  [`${T}text.on-accent`, `${T}accent`, 3, 'large label on an accent fill'],
  [`${T}accent`, `${T}surface.page`, 3, 'selection, value ring, focus'],
  [`${T}accent`, `${T}surface.sunken`, 3, 'value ring on a panel'],
  [`${T}status.limit`, `${T}surface.page`, 4.5, 'CLIP / GR readouts are text'],
  [`${C}legend.color`, `${C}pedal.face`, 4.5, 'legends on the pedal face'],
  [`${C}knob.pointer`, `${C}knob.cap`, 3, 'knob pointer on its cap'],
  [`${C}knob.outline`, `${C}pedal.face`, 3, 'knob edge on the face'],
  [`${C}knob.value`, `${C}pedal.face`, 3, 'value ring on the face'],
  [`${C}led.on`, `${C}pedal.face`, 3, 'engaged LED on the face'],
  [`${C}footswitch.outline`, `${C}pedal.face`, 3, 'footswitch edge on the face'],
  [`${C}glyph.ink`, `${C}pedal.face`, 3, 'response glyph on the face'],
];

// Colours that carry different meanings and so must stay apart for everyone, including the ~8 % of
// men with red-green colour vision deficiency (Okabe & Ito). OKLab distance, worst case over normal,
// protan, deutan and tritan simulation. Below WARN: pair it with shape or text (the DIRECTION rule
// "never colour alone" already requires that). Below FAIL: not allowed.
export const CVD_WARN = 0.1;
export const CVD_FAIL = 0.05;
export const DISTINCT_PAIRS = [
  [`${T}accent`, `${T}status.limit`, 'your hand vs the limit'],
  [`${C}led.on`, `${C}led.clip`, 'engaged lamp vs clip lamp'],
  [`${C}led.on`, `${C}led.off`, 'LED on vs off'],
];

const isColor = (v) => { try { parseColor(v); return true; } catch { return false; } };

/** resolvedByMode: { light: Map(path -> {type, value}), dark: ... }. Returns { errors, warnings, rows }. */
export function checkAccessibility(resolvedByMode) {
  const errors = [];
  const warnings = [];
  const rows = [];
  for (const [mode, r] of Object.entries(resolvedByMode)) {
    const get = (p) => r.get(p)?.value;
    for (const [fg, bg, min, why] of CONTRAST_PAIRS) {
      const [a, b] = [get(fg), get(bg)];
      if (!isColor(a) || !isColor(b)) { errors.push(`${mode}: ${fg} / ${bg} missing or not a colour`); continue; }
      const ratio = contrast(a, b);
      const ok = ratio >= min;
      rows.push({ mode, check: 'contrast', fg, bg, ratio: +ratio.toFixed(2), min, why, ok });
      if (!ok) errors.push(`${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1 (${why})`);
    }
    for (const [a, b, why] of DISTINCT_PAIRS) {
      const [x, y] = [get(a), get(b)];
      if (!isColor(x) || !isColor(y)) { errors.push(`${mode}: ${a} / ${b} missing or not a colour`); continue; }
      const w = worstCaseDelta(x, y);
      const level = w.d < CVD_FAIL ? 'fail' : w.d < CVD_WARN ? 'warn' : 'ok';
      rows.push({ mode, check: 'distinct', fg: a, bg: b, deltaE: +w.d.toFixed(3), vision: w.kind, why, ok: level !== 'fail', level });
      const msg = `${mode}: ${a} vs ${b} (${why}) are ${w.d.toFixed(3)} apart in OKLab under ${w.kind} vision`;
      if (level === 'fail') errors.push(`${msg}; must be at least ${CVD_FAIL}`);
      else if (level === 'warn') warnings.push(`${msg}; below ${CVD_WARN}, so shape or text must carry the difference too`);
    }
  }
  return { errors, warnings, rows };
}

// Pairs that are not gates today but are worth knowing, because a surface may be tempted to use them.
// Reported by tools/contrast-report.mjs and the token reference page; never fail a build. Each says
// what the pair would be used for and the WCAG 2.2 AA threshold that use would need.
export const ADVISORY_PAIRS = [
  [`${T}accent`, `${T}surface.page`, 4.5, 'accent used as small text (the tuner readout, links)'],
  [`${T}accent`, `${T}surface.sunken`, 4.5, 'accent used as small text on a panel'],
  [`${T}text.on-accent`, `${T}accent`, 4.5, 'small text on an accent fill (INVENTORY I-6)'],
  [`${T}status.limit`, `${T}surface.sunken`, 4.5, 'CLIP / GR readout on a panel (the rig inspector)'],
  [`${T}status.limit`, `${T}surface.raised`, 4.5, 'CLIP / GR readout on a card'],
  [`${T}text.primary`, `${T}surface.raised`, 4.5, 'body text on a card'],
  [`${T}text.secondary`, `${T}surface.raised`, 4.5, 'labels on a card'],
  [`${T}text.secondary`, `${T}surface.canvas`, 4.5, 'labels on the canvas'],
  [`${C}legend.color`, `${C}knob.cap`, 4.5, 'a legend printed on a knob cap'],
];

/** Advisory rows for every mode: { mode, fg, bg, ratio, min, why, ok }. Missing tokens are skipped. */
export function advisoryRows(resolvedByMode) {
  const rows = [];
  for (const [mode, r] of Object.entries(resolvedByMode)) {
    for (const [fg, bg, min, why] of ADVISORY_PAIRS) {
      const [a, b] = [r.get(fg)?.value, r.get(bg)?.value];
      if (!isColor(a) || !isColor(b)) continue;
      const ratio = contrast(a, b);
      rows.push({ mode, check: 'advisory', fg, bg, ratio: +ratio.toFixed(2), min, why, ok: ratio >= min });
    }
  }
  return rows;
}

// The pedal's own emissive palette (hardware.*). Mode-less, so it is checked once. Every display role
// that can carry text must reach 4.5:1 on the display background, and must still do so after RGB565
// quantisation, which is what a TFT actually shows. LEDs must stay apart under colour-vision deficiency.
const H = 'hardware.';
export const HARDWARE_TEXT = ['text', 'secondary', 'accent', 'limit'].map((k) => [`${H}display.${k}`, `${H}display.background`, 4.5, `${k} on the pedal display`]);
export const HARDWARE_DISTINCT = [
  [`${H}display.accent`, `${H}display.limit`, 'selected vs the limit, on the display'],
  [`${H}led.engaged`, `${H}led.limit`, 'engaged lamp vs clip lamp'],
];

/** The colour a 16-bit RGB565 panel shows for an sRGB colour: quantise, then expand back to 8 bits. */
export function quantize565(c) {
  const { r, g, b } = parseColor(c);
  const q = (x, bits) => { const m = (1 << bits) - 1; return Math.round(Math.round(x * m) * 255 / m) / 255; };
  return toHex({ r: q(r, 5), g: q(g, 6), b: q(b, 5) });
}

/** resolved: one mode's Map (hardware is mode-less). Returns { errors, warnings, rows }. */
export function checkHardware(resolved) {
  const errors = [];
  const warnings = [];
  const rows = [];
  const get = (p) => resolved.get(p)?.value;
  for (const [fg, bg, min, why] of HARDWARE_TEXT) {
    const [a, b] = [get(fg), get(bg)];
    if (!isColor(a) || !isColor(b)) { errors.push(`hardware: ${fg} / ${bg} missing or not a colour`); continue; }
    for (const [depth, x, y] of [['rgb888', a, b], ['rgb565', quantize565(a), quantize565(b)]]) {
      const ratio = contrast(x, y);
      rows.push({ mode: 'hardware', depth, check: 'contrast', fg, bg, ratio: +ratio.toFixed(2), min, why, ok: ratio >= min });
      if (ratio < min) errors.push(`hardware (${depth}): ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1 (${why})`);
    }
  }
  for (const [a, b, why] of HARDWARE_DISTINCT) {
    const [x, y] = [get(a), get(b)];
    if (!isColor(x) || !isColor(y)) { errors.push(`hardware: ${a} / ${b} missing or not a colour`); continue; }
    const w = worstCaseDelta(x, y);
    const level = w.d < CVD_FAIL ? 'fail' : w.d < CVD_WARN ? 'warn' : 'ok';
    rows.push({ mode: 'hardware', check: 'distinct', fg: a, bg: b, deltaE: +w.d.toFixed(3), vision: w.kind, why, ok: level !== 'fail', level });
    if (level === 'fail') errors.push(`hardware: ${a} vs ${b} (${why}) are ${w.d.toFixed(3)} apart under ${w.kind} vision; must be at least ${CVD_FAIL}`);
    else if (level === 'warn') warnings.push(`hardware: ${a} vs ${b} (${why}) are ${w.d.toFixed(3)} apart under ${w.kind} vision; pair with position or a word`);
  }
  for (const [p, t] of resolved) if (p.startsWith(H) && t.type === 'color' && get(p) && parseColor(get(p)).a < 1) errors.push(`hardware: ${p} has alpha; an emissive pixel or lamp cannot be translucent`);
  return { errors, warnings, rows };
}

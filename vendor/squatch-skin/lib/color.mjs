// Colour maths with no dependencies: parsing, WCAG contrast, colour-vision-deficiency simulation
// and OKLab distance. Runs unchanged in Node and in the browser.

/** '#RGB', '#RRGGBB', '#RRGGBBAA' or a DTCG colour object -> { r, g, b, a } with r,g,b in 0..1 (sRGB). */
export function parseColor(v) {
  if (v && typeof v === 'object') {
    if (typeof v.hex === 'string') return { ...parseColor(v.hex), a: v.alpha ?? 1 };
    if (v.colorSpace === 'srgb' && Array.isArray(v.components)) {
      const [r, g, b] = v.components;
      return { r, g, b, a: v.alpha ?? 1 };
    }
    throw new Error(`unsupported colour object ${JSON.stringify(v)}`);
  }
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(v).trim());
  if (!m) throw new Error(`not a colour: ${v}`);
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

const hex2 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0').toUpperCase();
export function toHex({ r, g, b, a = 1 }) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a) : ''}`;
}

/** A DTCG 2025.10 colour value for a hex string. */
export function dtcgColor(hex) {
  const { r, g, b, a } = parseColor(hex);
  const round = (x) => Math.round(x * 10000) / 10000;
  const out = { colorSpace: 'srgb', components: [round(r), round(g), round(b)], hex: toHex({ r, g, b }) };
  if (a < 1) out.alpha = round(a);
  return out;
}

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const unlin = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance. */
export function luminance(c) {
  const { r, g, b } = parseColor(c);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio, 1..21. Not rounded: 2.999 fails 3 (SC 1.4.11 says so). */
export function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
export const CVD_KINDS = Object.keys(CVD);

/** The colour as a person with full protanopia / deuteranopia / tritanopia would see it. */
export function simulate(c, kind) {
  const { r, g, b } = parseColor(c);
  const v = [lin(r), lin(g), lin(b)];
  const m = CVD[kind];
  const o = m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return toHex({ r: unlin(Math.max(0, Math.min(1, o[0]))), g: unlin(Math.max(0, Math.min(1, o[1]))), b: unlin(Math.max(0, Math.min(1, o[2]))) });
}

/** OKLab (Ottosson 2020). */
export function oklab(c) {
  const { r, g, b } = parseColor(c);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean distance in OKLab. About 0.02 is a just-noticeable difference side by side. */
export function deltaE(a, b) {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** The smallest OKLab distance between two colours across normal vision and the three CVD kinds. */
export function worstCaseDelta(a, b) {
  let worst = { kind: 'normal', d: deltaE(a, b) };
  for (const k of CVD_KINDS) {
    const d = deltaE(simulate(a, k), simulate(b, k));
    if (d < worst.d) worst = { kind: k, d };
  }
  return worst;
}

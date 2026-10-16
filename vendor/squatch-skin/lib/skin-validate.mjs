// Validate a skin package: a folder (or, later, a zip) holding skin.json, SVG and raster art, and fonts.
// Runs in Node and in the browser: the caller supplies file reading and SHA-256.
//
// A skin that passes is safe to load from a stranger: it is data only, every file is listed and
// hashed, sizes are bounded, the SVG passes an allowlist lint, token overrides keep every
// theme accessible, and every product the skin lays out has each control placed once, on the face,
// without overlaps.
import { lintSvg, svgMetaText } from './svg-lint.mjs';
import { applyOverrides, resolve } from './tokens.mjs';
import { checkAccessibility } from './a11y.mjs';

export const FORMAT = 'cc.squatch.skin/1';
export const LIMITS = {
  manifestBytes: 64 * 1024,
  files: 64,
  totalBytes: 4 * 1024 * 1024,
  perType: { '.svg': 128 * 1024, '.png': 1024 * 1024, '.webp': 1024 * 1024, '.woff2': 512 * 1024, '.txt': 64 * 1024 },
};
// Licences a skin's art may use (SPDX ids). A LicenseRef-* is allowed for commercial skins if the
// licence text ships in the package. Fonts must be under a licence that permits embedding.
export const ART_LICENSES = new Set(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'Apache-2.0', 'BSD-3-Clause']);
export const FONT_LICENSES = new Set(['OFL-1.1', 'Apache-2.0', 'MIT', 'CC0-1.0', 'Ubuntu-1.0']);
// Other makers' marks that must not appear in a skin's names, descriptions or art metadata. The rule
// and its source: pedal-lab decisions/D-2026-09-21-kit-board-names.md (trade dress, Consequences).
export const PROTECTED_MARKS = ['TUBE SCREAMER', 'TUBESCREAMER', 'TS808', 'TS-808', 'TS9', 'TS-9', 'IBANEZ', 'MAXON', 'KLON', 'CENTAUR',
  'PROCO', 'PRO CO', 'BOSS', 'ELECTRO-HARMONIX', 'BIG MUFF', 'FULLTONE', 'STRYMON', 'LINE 6', 'HELIX', 'QUAD CORTEX', 'NEURAL DSP',
  'KEMPER', 'FRACTAL', 'POSITIVE GRID', 'MESA', 'MARSHALL', 'FENDER', 'VOX'];
const RAT_WORD = /\bRAT\b/; // the ProCo RAT: matched case-sensitively as a whole word so "rate" and "Rat" in prose pass

const SAFE_PATH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ext = (p) => (p.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
const MAGIC = {
  '.png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  '.woff2': [0x77, 0x4f, 0x46, 0x32],
};

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Every path the manifest references, with what it is for. */
export function referencedFiles(m) {
  const out = [];
  const add = (p, role) => { if (typeof p === 'string') out.push({ path: p, role }); };
  const art = m.art ?? {};
  for (const [k, v] of Object.entries(art)) {
    if (typeof v === 'string') add(v, `art.${k}`);
    else if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) add(v2, `art.${k}.${k2}`);
  }
  for (const [i, f] of (m.fonts ?? []).entries()) { add(f.file, `fonts[${i}]`); add(f.licenseFile, `fonts[${i}].licenseFile`); }
  add(m.licenseFile, 'licenseFile');
  return out;
}

function checkManifest(m, errors, warnings) {
  const need = (k, t = 'string') => { if (typeof m[k] !== t) errors.push(`skin.json: "${k}" is required (${t})`); };
  if (m.format !== FORMAT) errors.push(`skin.json: "format" must be "${FORMAT}"`);
  need('id'); need('name'); need('version'); need('author'); need('license'); need('tradeDress');
  if (typeof m.id === 'string' && !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/.test(m.id)) errors.push(`skin.json: id "${m.id}" must be reverse-DNS, e.g. com.example.skin.name`);
  if (typeof m.version === 'string' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version)) errors.push(`skin.json: version "${m.version}" is not semver`);
  if (typeof m.license === 'string' && !ART_LICENSES.has(m.license)) {
    if (/^LicenseRef-[A-Za-z0-9.-]+$/.test(m.license)) { if (!m.licenseFile) errors.push('skin.json: a LicenseRef-* licence needs "licenseFile"'); }
    else errors.push(`skin.json: license "${m.license}" is not an allowed SPDX id (${[...ART_LICENSES].join(', ')}, or LicenseRef-*)`);
  }
  for (const [i, f] of (m.fonts ?? []).entries()) {
    if (!f.family || !f.file) errors.push(`skin.json: fonts[${i}] needs family and file`);
    if (!FONT_LICENSES.has(f.license)) errors.push(`skin.json: fonts[${i}] (${f.family}) licence "${f.license}" does not permit embedding; allowed: ${[...FONT_LICENSES].join(', ')}`);
    if (!f.licenseFile) errors.push(`skin.json: fonts[${i}] (${f.family}) must ship its licence text (licenseFile)`);
  }
  if (typeof m.tradeDress === 'string' && m.tradeDress.trim().length < 20) warnings.push('skin.json: tradeDress should say, in a sentence, that the art is original and copies no other maker\'s look');
  const allowed = new Set(['$schema', 'format', 'id', 'name', 'version', 'author', 'license', 'licenseFile', 'description', 'homepage', 'surfaces', 'tokens', 'fonts', 'art', 'layouts', 'files', 'tradeDress']);
  for (const k of Object.keys(m)) if (!allowed.has(k)) errors.push(`skin.json: unknown field "${k}"`);
}

function checkTradeDress(label, text, errors) {
  const up = String(text ?? '').toUpperCase();
  for (const mark of PROTECTED_MARKS) if (new RegExp(`(^|[^A-Z0-9])${mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9])`).test(up)) errors.push(`${label}: names "${mark}", another maker's mark (see the trade-dress rule)`);
  if (RAT_WORD.test(String(text ?? ''))) errors.push(`${label}: names "RAT", another maker's mark`);
}

function checkLayouts(m, products, errors, warnings) {
  const layouts = m.layouts ?? {};
  if (!Object.keys(layouts).length) errors.push('skin.json: "layouts" is empty; a skin must lay out at least one product or form');
  const placed = [];
  for (const p of products) {
    const key = layouts[p.id] ? p.id : layouts[`form:${p.form}`] ? `form:${p.form}` : null;
    if (!key) { warnings.push(`layouts: nothing for ${p.id} (form ${p.form}); a host falls back to its generated panel`); continue; }
    placed.push(p.id);
    const L = layouts[key];
    const W = L.face?.width;
    const H = L.face?.height;
    if (!(W > 0 && H > 0) || L.face?.unit !== 'mm') { errors.push(`layouts.${key}: face needs width, height and unit "mm"`); continue; }
    const circles = [];
    const inside = (what, x, y, r) => {
      if (!(x - r >= 0 && y - r >= 0 && x + r <= W && y + r <= H)) errors.push(`layouts.${key}: ${what} at (${x}, ${y}) r ${r} runs off the ${W} x ${H} mm face`);
    };
    const knobs = p.controls.filter((c) => c.kind === 'knob');
    for (const [i, c] of knobs.entries()) {
      const s = L.controls?.[c.key] ?? L.knobs?.[i];
      if (!s) { errors.push(`layouts.${key}: control "${c.key}" is not placed`); continue; }
      if (!(s.d >= 10)) errors.push(`layouts.${key}: ${c.key} knob diameter ${s.d} mm is under 10 mm`);
      inside(c.key, s.x, s.y, s.d / 2);
      circles.push({ what: c.key, x: s.x, y: s.y, r: s.d / 2 });
    }
    if (L.controls) for (const k of Object.keys(L.controls)) if (!knobs.some((c) => c.key === k)) errors.push(`layouts.${key}: places "${k}", which ${p.id} does not have`);
    for (const part of ['footswitch', 'led']) {
      const s = L[part];
      if (!s) { errors.push(`layouts.${key}: no ${part}`); continue; }
      inside(part, s.x, s.y, s.d / 2);
      circles.push({ what: part, x: s.x, y: s.y, r: s.d / 2 });
    }
    for (let i = 0; i < circles.length; i++) {
      for (let j = i + 1; j < circles.length; j++) {
        const [a, b] = [circles[i], circles[j]];
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
        if (gap < 2) errors.push(`layouts.${key}: ${a.what} and ${b.what} are ${gap.toFixed(1)} mm apart; they need 2 mm clearance`);
      }
    }
    for (const part of ['glyph', 'nameplate']) {
      const r = L[part];
      if (r && !(r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H)) errors.push(`layouts.${key}: ${part} rect runs off the face`);
    }
  }
  return placed;
}

/**
 * @param {object} o
 * @param {string} o.manifestText         the bytes of skin.json, as text
 * @param {(rel:string)=>Promise<Uint8Array>} o.readFile   read a file in the package
 * @param {(bytes:Uint8Array)=>Promise<Uint8Array>} o.sha256
 * @param {{id:string, tokens:Map, modes:string[]}[]} o.themes   themes the skin must keep accessible
 * @param {{id:string, form:string, controls:{key:string, kind:string}[]}[]} o.products
 */
export async function validateSkin({ manifestText, readFile, sha256, themes = [], products = [] }) {
  const errors = [];
  const warnings = [];
  const report = { files: [], a11y: [], products: [] };
  const mbytes = new TextEncoder().encode(manifestText).length;
  if (mbytes > LIMITS.manifestBytes) errors.push(`skin.json: ${mbytes} bytes, over ${LIMITS.manifestBytes}`);
  let m;
  try { m = JSON.parse(manifestText); } catch (e) { return { ok: false, errors: [`skin.json: not JSON (${e.message})`], warnings, report }; }
  checkManifest(m, errors, warnings);
  checkTradeDress('skin.json name/description/id', `${m.name} ${m.description ?? ''} ${m.id}`, errors);

  // Files: listed, hashed, bounded, and of a type we can render without code.
  const files = m.files ?? {};
  const listed = Object.keys(files);
  if (listed.length > LIMITS.files) errors.push(`files: ${listed.length} files, over ${LIMITS.files}`);
  for (const r of referencedFiles(m)) if (!(r.path in files)) errors.push(`${r.role}: "${r.path}" is not listed in "files" with a hash`);
  let total = mbytes;
  for (const rel of listed) {
    const e = ext(rel);
    if (!SAFE_PATH.test(rel) || rel.includes('\\')) { errors.push(`files: "${rel}" is not a safe relative path`); continue; }
    if (!(e in LIMITS.perType)) { errors.push(`files: "${rel}" has type ${e || '(none)'}; allowed ${Object.keys(LIMITS.perType).join(' ')}`); continue; }
    let bytes;
    try { bytes = await readFile(rel); } catch { errors.push(`files: "${rel}" is listed but missing`); continue; }
    total += bytes.length;
    if (bytes.length > LIMITS.perType[e]) errors.push(`files: "${rel}" is ${bytes.length} bytes, over ${LIMITS.perType[e]} for ${e}`);
    const want = files[rel];
    const got = `sha256-${b64(await sha256(bytes))}`;
    if (want !== got) errors.push(`files: "${rel}" hash mismatch (manifest ${want}, file ${got})`);
    if (MAGIC[e] && !MAGIC[e].every((b, i) => bytes[i] === b)) errors.push(`files: "${rel}" is not really ${e}`);
    if (e === '.webp' && !(String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP')) errors.push(`files: "${rel}" is not really .webp`);
    const row = { path: rel, bytes: bytes.length };
    if (e === '.svg') {
      const text = new TextDecoder().decode(bytes);
      const lint = lintSvg(text, { name: rel, maxBytes: LIMITS.perType['.svg'] });
      errors.push(...lint.errors);
      warnings.push(...lint.warnings);
      checkTradeDress(`${rel} title/desc`, svgMetaText(text), errors);
      row.elements = lint.stats.elements;
    }
    report.files.push(row);
  }
  if (total > LIMITS.totalBytes) errors.push(`package is ${total} bytes, over ${LIMITS.totalBytes}`);

  // Tokens: the skin's overrides must keep every theme it may be shown with accessible.
  for (const t of themes) {
    const { tokens, problems } = applyOverrides(t.tokens, m.tokens, { source: `skin tokens (on ${t.id})` });
    errors.push(...problems);
    try {
      const byMode = Object.fromEntries(t.modes.map((mode) => [mode, resolve(tokens, mode)]));
      const a = checkAccessibility(byMode);
      errors.push(...a.errors.map((x) => `with theme ${t.id}: ${x}`));
      warnings.push(...a.warnings.map((x) => `with theme ${t.id}: ${x}`));
      report.a11y.push({ theme: t.id, rows: a.rows });
    } catch (e) { errors.push(`skin tokens (on ${t.id}): ${e.message}`); }
  }

  report.products = checkLayouts(m, products, errors, warnings);
  return { ok: errors.length === 0, errors, warnings, report, manifest: m };
}

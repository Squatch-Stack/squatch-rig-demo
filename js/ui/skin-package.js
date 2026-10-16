// cc.squatch.skin/1 packages in the rig: load one, validate it with squatch-skin's own validator
// (vendored byte for byte in web/vendor/squatch-skin, never reimplemented here), and turn its
// millimetre layout and token overrides into what the canvas draws. DOM-free, so
// tests/rig-skin.test.mjs runs exactly this code in Node.
//
// The four layers meet here: the control contract (contracts/trail-od.oscquery.json) says what the
// device can do, the tokens (squatch-ink) say what the brand looks like, the skin package says
// where things go and what they look like, and the canvas draws it. The contract is read from the
// contract, never from the skin: a skin has no parameters.
import { flatten, themeInfo, resolve, applyOverrides } from '../../vendor/squatch-skin/lib/tokens.mjs';
import { cssDecls } from '../../vendor/squatch-skin/lib/css.mjs';
import { validateSkin } from '../../vendor/squatch-skin/lib/skin-validate.mjs';
import { productFromContract } from '../../vendor/squatch-skin/lib/contract.mjs';

export { toNormalized, fromNormalized, formatValue } from '../../vendor/squatch-skin/lib/contract.mjs';

/** First-party skins only until signing and a reviewed gallery (squatch-skin DECISIONS.md D4). */
export const PACKAGE_ID = /^cc\.squatch\.skin\.([a-z0-9-]+)$/;
/** A refused skin is never shown by its own name: its text is untrusted (THEME-SUPPORT-PLAN §2.4). */
export const REFUSED = 'a refused skin';
/** The theme the rig draws a package skin under. Both themes must stay accessible for it to load. */
export const THEME_ID = 'squatch-ink';
export const THEMES = ['squatch-ink', 'studio'];
export const CONTRACTS = ['trail-od'];
/** var(--sq-sys-*|--sq-comp-*, #hex): the only form svg-lint lets into skin art. */
const VAR = /var\(\s*(--sq-[a-z0-9-]+)\s*,\s*(#[0-9A-Fa-f]{3,8})\s*\)/g;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Load and validate a package.
 * @param {string} id   cc.squatch.skin.<name>; the package must say the same id
 * @param {{readVendor:(rel:string)=>Promise<Uint8Array>, readPackage:(rel:string)=>Promise<Uint8Array>,
 *          sha256:((b:Uint8Array)=>Promise<Uint8Array>)|null}} io
 */
export async function loadPackage(id, { readVendor, readPackage, sha256 }) {
  const out = { id, ok: false, errors: [], warnings: [], report: {}, manifest: null, texts: {}, label: REFUSED, products: new Map(), theme: null };
  if (!PACKAGE_ID.test(id)) { out.errors.push(`"${id}" is not a first-party skin id (cc.squatch.skin.<name>)`); return out; }
  if (!sha256) { out.errors.push('this page is not in a secure context, so file hashes cannot be checked; open it over https or localhost'); return out; }
  const text = (b) => new TextDecoder().decode(b);
  try {
    const themes = [];
    for (const t of THEMES) {
      const doc = JSON.parse(text(await readVendor(`tokens/${t}.tokens.json`)));
      themes.push({ ...themeInfo(doc), tokens: flatten(doc, { source: t }) });
    }
    for (const c of CONTRACTS) {
      const p = productFromContract(JSON.parse(text(await readVendor(`contracts/${c}.oscquery.json`))));
      out.products.set(p.id, p);
    }
    out.theme = themes.find((t) => t.id === THEME_ID);
    const manifestText = text(await readPackage('skin.json'));
    const readFile = async (rel) => {
      if (!SAFE.test(rel) || rel.includes('..')) throw new Error('unsafe path');
      const b = await readPackage(rel);
      if (rel.endsWith('.svg')) out.texts[rel] = text(b);
      return b;
    };
    const r = await validateSkin({ manifestText, readFile, sha256, themes, products: [...out.products.values()] });
    Object.assign(out, { ok: r.ok, errors: r.errors, warnings: r.warnings, report: r.report, manifest: r.manifest ?? null });
    if (out.ok && out.manifest.id !== id) { out.ok = false; out.errors.push(`skin.json: the package is not ${id}`); }
  } catch (e) {
    out.ok = false;
    out.errors.push(`could not load ${id}: ${e.message}`);
  }
  if (out.ok) out.label = `${out.manifest.name} skin`;
  else out.texts = {};
  return out;
}

/** The layout a package gives a product: by product id first, then by form; null means "not laid out". */
export function layoutFor(manifest, product) {
  const L = manifest?.layouts ?? {};
  return L[product.id] ?? L[`form:${product.form}`] ?? null;
}

/** Every --sq-* custom property for one mode, after the skin's overrides (the build's own emission rules). */
export function skinTokens(theme, manifest, mode) {
  const { tokens, problems } = applyOverrides(theme.tokens, manifest?.tokens);
  if (problems.length) throw new Error(problems.join('; '));
  return new Map(cssDecls(tokens, resolve(tokens, mode), mode));
}

/** Substitute var(--sq-*, #hex) with the token's value. Nothing else in the text changes. */
export function substitute(svgText, values) {
  const unresolved = [];
  const text = svgText.replace(VAR, (_, name, fb) => {
    const v = values.get(name);
    if (v == null) { unresolved.push(name); return fb; }
    return v;
  });
  return { text, unresolved };
}

/** Every token name a piece of art binds. */
export const tokensIn = (svgText) => [...svgText.matchAll(VAR)].map((m) => m[1]);

/**
 * Place a layout's face (millimetres) in a device box (world units): scaled to fit, centred. The
 * rig keeps its own jacks at the box edges, because the skin format has no jack positions (G4).
 */
export function faceGeometry(L, product, box) {
  const W = L.face.width, H = L.face.height;
  const mm = Math.min(box.w / W, box.h / H);
  const ox = (box.w - W * mm) / 2, oy = (box.h - H * mm) / 2;
  const circle = (s) => ({ x: ox + s.x * mm, y: oy + s.y * mm, r: (s.d / 2) * mm });
  const rect = (r) => (r ? { x: ox + r.x * mm, y: oy + r.y * mm, w: r.w * mm, h: r.h * mm } : null);
  const knobs = product.params.filter((p) => p.kind === 'knob').map((p, i) => {
    const s = L.controls?.[p.key] ?? L.knobs?.[i];
    return { key: p.key, param: p, mm: s, ...circle(s) };
  });
  return {
    mm, face: { x: ox, y: oy, w: W * mm, h: H * mm }, knobs,
    footswitch: circle(L.footswitch), led: circle(L.led), glyph: rect(L.glyph), nameplate: rect(L.nameplate),
  };
}

/** Knob pointer angle in degrees, 0 = straight up: -travel/2 + travel x n (component.knob.travel). */
export const pointerDegrees = (travel, n) => -travel / 2 + travel * n;

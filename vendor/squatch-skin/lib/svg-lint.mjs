// A strict allowlist lint for SVG art in a skin package. String based, so it runs anywhere with no DOM.
//
// A skin is data, never code. SVG can carry code in several ways (script elements, on* handlers,
// javascript: URLs, SMIL <set>/<animate> rewriting href, foreignObject HTML, external references that
// leak the viewer's address, entity expansion). Rather than chase those, the lint allows a known-safe
// subset and rejects everything else. The renderer additionally draws art through <img> (see the demo),
// where browsers never run script or fetch sub-resources; the lint is the first of two walls.

const ELEMENTS = new Set(['svg', 'g', 'defs', 'title', 'desc', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'symbol', 'use',
  'filter', 'feturbulence', 'fedisplacementmap', 'fegaussianblur', 'fecolormatrix', 'feoffset', 'feblend', 'fecomposite',
  'feflood', 'femerge', 'femergenode', 'femorphology', 'fecomponenttransfer', 'fefunca', 'fefuncr', 'fefuncg', 'fefuncb']);
// Deliberately absent: script, style, foreignObject, image, a, text/tspan/textPath (no text is baked into
// art: labels come from the contract, so they stay localisable and accessible), animate, set,
// animateTransform, animateMotion (motion belongs to the renderer and only moves with signal), iframe.

const ATTR = /^(?:[a-z][a-z0-9-]*|xmlns(?::xlink)?|xlink:href|xml:space|data-[a-z0-9-]+)$/i;
const MAX_ELEMENTS = 4000;

/** Returns { ok, errors[], warnings[], stats }. */
export function lintSvg(text, { name = 'svg', maxBytes = 128 * 1024 } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(`${name}: ${m}`);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) err(`${bytes} bytes, over the ${maxBytes}-byte limit`);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) err('DOCTYPE or ENTITY declarations are not allowed (entity expansion)');
  if (/<!\[CDATA\[/i.test(text)) err('CDATA sections are not allowed');
  if (/<\?(?!xml\s)/i.test(text)) err('processing instructions other than the XML declaration are not allowed');

  const body = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[^>]*\?>/i, '');
  const tagRe = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)([^>]*?)(\/?)\s*>/g;
  let m;
  let count = 0;
  let root = null;
  const ids = new Set();
  const refs = [];
  let consumed = 0;
  while ((m = tagRe.exec(body))) {
    const between = body.slice(consumed, m.index);
    if (/</.test(between)) err('malformed markup near a "<" that is not a tag');
    consumed = tagRe.lastIndex;
    const [, closing, rawName, attrs] = m;
    const tag = rawName.toLowerCase();
    if (closing) continue;
    count++;
    if (!root) root = tag;
    if (!ELEMENTS.has(tag)) { err(`<${rawName}> is not allowed`); continue; }
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')|(\S+)/g;
    let a;
    while ((a = attrRe.exec(attrs))) {
      if (a[5]) { if (a[5] !== '/') err(`<${rawName}> has a malformed attribute "${a[5]}"`); continue; }
      const key = a[1];
      const val = a[3] ?? a[4] ?? '';
      const k = key.toLowerCase();
      if (!ATTR.test(key)) { err(`<${rawName}> attribute "${key}" is not allowed`); continue; }
      if (k.startsWith('on')) { err(`<${rawName}> event handler "${key}" is not allowed`); continue; }
      if (k === 'style') { err(`<${rawName}> style attributes are not allowed; use presentation attributes and var(--sq-*) tokens`); continue; }
      if (/(?:java|vb)script:|data:|expression\s*\(/i.test(val)) err(`<${rawName}> ${key} contains a script or data URL`);
      if (k === 'href' || k === 'xlink:href') {
        if (!/^#[A-Za-z_][\w.-]*$/.test(val)) err(`<${rawName}> ${key}="${val}" must be a local #fragment`);
        else refs.push(val.slice(1));
      }
      const urls = [...val.matchAll(/url\(\s*['"]?([^'")]*)['"]?\s*\)/gi)].map((u) => u[1]);
      for (const u of urls) {
        if (!/^#[A-Za-z_][\w.-]*$/.test(u)) err(`<${rawName}> ${key} references "${u}"; only url(#local-id) is allowed`);
        else refs.push(u.slice(1));
      }
      for (const v of val.matchAll(/var\(([^)]*)\)/g)) {
        if (!/^\s*--sq-(?:sys|comp)-[a-z0-9-]+\s*,\s*#[0-9A-Fa-f]{3,8}\s*$/.test(v[1])) {
          err(`<${rawName}> ${key}="${val}": var() must name a --sq-sys-* or --sq-comp-* token and give a #hex fallback`);
        }
      }
      if (k === 'id') ids.add(val);
    }
    if (count > MAX_ELEMENTS) { err(`more than ${MAX_ELEMENTS} elements`); break; }
  }
  if (/[^\s]/.test(body.slice(consumed).replace(/<[^>]*>/g, ''))) warnings.push(`${name}: stray text content after the last tag`);
  const textContent = body.replace(/<title[\s\S]*?<\/title>|<desc[\s\S]*?<\/desc>/gi, '').replace(/<[^>]*>/g, '').trim();
  if (textContent) err('character data outside <title>/<desc>; art carries no text');
  if (root !== 'svg') err(`root element is <${root ?? 'nothing'}>, not <svg>`);
  if (!/<svg[^>]*\sviewBox\s*=/i.test(body)) err('the <svg> root needs a viewBox');
  for (const r of refs) if (!ids.has(r)) err(`reference to #${r}, which is not defined in this file`);
  return { ok: errors.length === 0, errors, warnings, stats: { bytes, elements: count } };
}

/** Title and desc text, for the trade-dress name scan. */
export function svgMetaText(text) {
  return [...text.matchAll(/<(title|desc)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]).join(' ');
}

// Token -> CSS custom property emission, shared by the build (tools/build-tokens.mjs) and the browser
// renderer (which applies a skin's overrides at run time with exactly the same rules).
import { parseColor, toHex } from './color.mjs';

/** The tiers a surface binds to. Primitives are raw palette; hardware.* is the pedal's own emissive
 *  palette (built to C, C++, Swift and JSON, never to CSS). */
export const isRole = (p) => p.startsWith('semantic.') || p.startsWith('component.');
export const cssName = (p) => '--sq-' + p.replace(/^semantic\./, 'sys.').replace(/^component\./, 'comp.').replace(/\./g, '-');
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system']);

export function cssValue(type, v) {
  switch (type) {
    case 'color': return toHex(parseColor(v));
    case 'dimension': case 'duration': return `${v.value}${v.unit}`;
    case 'number': case 'fontWeight': return String(v);
    case 'fontFamily': return (Array.isArray(v) ? v : [v]).map((f) => (GENERIC.has(f) ? f : `"${f}"`)).join(', ');
    case 'cubicBezier': return `cubic-bezier(${v.join(', ')})`;
    case 'shadow': return (Array.isArray(v) ? v : [v]).map((s) => `${cssValue('dimension', s.offsetX)} ${cssValue('dimension', s.offsetY)} ${cssValue('dimension', s.blur)} ${cssValue('dimension', s.spread)} ${cssValue('color', s.color)}`).join(', ');
    default: return null;
  }
}

/** A token's extensions, merged over those of the token it aliases (so an alias keeps, say, uppercase). */
export function extOf(tokens, p, seen = new Set()) {
  const tok = tokens.get(p);
  if (!tok || seen.has(p)) return {};
  seen.add(p);
  const m = typeof tok.value === 'string' && /^\{([^{}]+)\}$/.exec(tok.value);
  const base = m ? extOf(tokens, m[1], seen) : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(tok.extensions ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(base[k] ?? {}), ...v } : v;
  return out;
}

/** CSS declarations for one mode: [name, value] pairs. Typography expands into its parts. */
export function cssDecls(tokens, resolved, mode) {
  const out = [];
  for (const [p, tok] of tokens) {
    if (!isRole(p)) continue;
    const { type, value } = resolved.get(p);
    const name = cssName(p);
    if (type === 'typography') {
      out.push([`${name}-font-family`, cssValue('fontFamily', value.fontFamily)], [`${name}-font-size`, cssValue('dimension', value.fontSize)],
        [`${name}-font-weight`, String(value.fontWeight)], [`${name}-letter-spacing`, cssValue('dimension', value.letterSpacing)],
        [`${name}-line-height`, String(value.lineHeight)]);
      for (const [k, v] of Object.entries(extOf(tokens, p)['cc.squatch.type'] ?? {})) out.push([`${name}-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`, v]);
      continue;
    }
    const v = cssValue(type, value);
    if (v !== null) out.push([name, v]);
    const ink = tok.extensions['cc.squatch.ink'];
    if (ink?.blend) out.push([`${name.replace(/-opacity$/, '')}-blend`, ink.blend[mode] ?? ink.blend.light]);
    if (ink?.shape) out.push([`${name.replace(/-roughness$/, '')}-shape`, ink.shape]);
  }
  return out;
}


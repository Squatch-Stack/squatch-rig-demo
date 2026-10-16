// Read W3C Design Tokens (DTCG Format Module 2025.10) files: flatten groups, inherit $type, resolve
// {alias} references per mode, and merge overrides. No dependencies; runs in Node and the browser.
//
// What this reader supports, and what it refuses rather than silently ignores:
//   supported  $value $type $description $deprecated $extensions, group $type inheritance,
//              curly-brace aliases (whole-value and inside composite values), cycle detection
//   ours       $extensions["cc.squatch.modes"] = { dark: <value> } - a per-mode value
//              $extensions["cc.squatch.theme"] on the root - theme id, name, modes
//   refused    $extends, $ref (JSON Pointer) and $root: legal DTCG, not needed yet, and a build that
//              skipped them would produce wrong output without saying so

export const TYPES = new Set(['color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'cubicBezier', 'number',
  'strokeStyle', 'border', 'transition', 'shadow', 'gradient', 'typography']);
const REFUSED = ['$extends', '$ref', '$root'];
const ALIAS = /^\{([^{}]+)\}$/;
export const MODES_EXT = 'cc.squatch.modes';
export const THEME_EXT = 'cc.squatch.theme';

/** Flatten a token document into Map(path -> token). Throws with every problem found, not just the first. */
export function flatten(doc, { source = 'tokens' } = {}) {
  const out = new Map();
  const problems = [];
  const walk = (node, path, inherited) => {
    for (const k of REFUSED) if (k in node) problems.push(`${source}: ${path.join('.') || '(root)'} uses ${k}, which this build does not support`);
    const type = node.$type ?? inherited;
    if ('$value' in node) {
      if (!type) problems.push(`${source}: ${path.join('.')} has no $type (DTCG: tools must not guess a type)`);
      else if (!TYPES.has(type)) problems.push(`${source}: ${path.join('.')} has unknown $type "${type}"`);
      out.set(path.join('.'), { path: path.join('.'), type, value: node.$value, description: node.$description, extensions: node.$extensions ?? {}, deprecated: node.$deprecated });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      if (/[{}.]/.test(k)) problems.push(`${source}: name "${k}" under ${path.join('.')} contains { } or .`);
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, [...path, k], type);
      else problems.push(`${source}: ${[...path, k].join('.')} is neither a token nor a group`);
    }
  };
  walk(doc, [], undefined);
  if (problems.length) throw Object.assign(new Error(problems.join('\n')), { problems });
  return out;
}

export function themeInfo(doc) {
  const t = doc?.$extensions?.[THEME_EXT] ?? {};
  return { id: t.id, name: t.name ?? t.id, modes: t.modes ?? ['light'], defaultMode: t.defaultMode ?? (t.modes ?? ['light'])[0], version: t.version, status: t.status };
}

/** The raw (unresolved) value of a token in a mode. */
export function rawValue(tok, mode) {
  const m = tok.extensions?.[MODES_EXT];
  return m && mode in m ? m[mode] : tok.value;
}

/** Resolve every token for one mode. Returns Map(path -> { type, value }) with no aliases left. */
export function resolve(tokens, mode) {
  const done = new Map();
  const visiting = new Set();
  const one = (path, chain) => {
    if (done.has(path)) return done.get(path);
    const tok = tokens.get(path);
    if (!tok) throw new Error(`alias to missing token {${path}}${chain.length ? ` (from ${chain.join(' -> ')})` : ''}`);
    if (visiting.has(path)) throw new Error(`circular alias: ${[...chain, path].join(' -> ')}`);
    visiting.add(path);
    const deep = (v) => {
      if (typeof v === 'string') {
        const m = ALIAS.exec(v);
        if (!m) return v;
        const target = one(m[1], [...chain, path]);
        return target.value;
      }
      if (Array.isArray(v)) return v.map(deep);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
      return v;
    };
    const raw = rawValue(tok, mode);
    const whole = typeof raw === 'string' && ALIAS.exec(raw);
    if (whole) {
      const target = tokens.get(whole[1]);
      if (target && target.type !== tok.type) throw new Error(`${path} ($type ${tok.type}) aliases ${whole[1]} ($type ${target.type})`);
    }
    const r = { type: tok.type, value: deep(raw) };
    visiting.delete(path);
    done.set(path, r);
    return r;
  };
  for (const p of tokens.keys()) one(p, []);
  return done;
}

/** Apply a skin's token overrides (a DTCG fragment) onto a theme's flattened tokens.
 *  Only semantic.* and component.* may be overridden, only paths that exist, and never with a new $type. */
export function applyOverrides(tokens, overrideDoc, { source = 'skin' } = {}) {
  const merged = new Map(tokens);
  const problems = [];
  if (!overrideDoc || !Object.keys(overrideDoc).length) return { tokens: merged, problems };
  let flat;
  try {
    flat = flattenLoose(overrideDoc, tokens);
  } catch (e) {
    return { tokens: merged, problems: e.problems ?? [e.message] };
  }
  for (const [path, tok] of flat) {
    if (!/^(semantic|component)\./.test(path)) { problems.push(`${source}: may not override ${path}: only semantic.* and component.* tokens`); continue; }
    const base = tokens.get(path);
    if (!base) { problems.push(`${source}: overrides ${path}, which the theme does not define`); continue; }
    if (tok.type && tok.type !== base.type) { problems.push(`${source}: ${path} changes $type ${base.type} -> ${tok.type}`); continue; }
    merged.set(path, { ...base, value: tok.value, extensions: { ...base.extensions, ...tok.extensions }, overridden: true });
  }
  return { tokens: merged, problems };
}

/** Like flatten(), but a token's $type may come from the base theme it overrides. */
function flattenLoose(doc, base) {
  const out = new Map();
  const walk = (node, path, inherited) => {
    const type = node.$type ?? inherited;
    if ('$value' in node) {
      const p = path.join('.');
      out.set(p, { path: p, type: type ?? base.get(p)?.type, value: node.$value, extensions: node.$extensions ?? {} });
      return;
    }
    for (const [k, v] of Object.entries(node)) if (!k.startsWith('$') && v && typeof v === 'object') walk(v, [...path, k], type);
  };
  walk(doc, [], undefined);
  return out;
}

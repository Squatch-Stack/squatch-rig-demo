// The control contract: one parameter descriptor per product, emitted into existing standards.
//
//   source   contracts/<product>.params.json   profile cc.squatch.control/1. Field names follow CLAP
//            (id, name, min/max/default, module-style group, bypass polarity) and LV2 (key = lv2:symbol,
//            unit from the LV2 units vocabulary, log taper = pprops:logarithmic).
//   wire     OSCQuery (github.com/Vidvox/OSCQueryProposal): the JSON namespace a device serves over HTTP,
//            values as OSC over WebSocket. What OSCQuery has no attribute for (default, taper, role,
//            page/slot, smoothing, display) rides in one extra attribute, SQUATCH.
//   also     LV2 Turtle for the Pi (PiPedal), MIDI-CI Property Exchange ChCtrlList for the Daisy over
//            USB-MIDI, and a WAM 2.0 parameter configuration for the browser.
// Runs in Node and the browser.

export const PROFILE = 'cc.squatch.control/1';
// LV2 unit -> OSCQuery UNIT string (OSCQueryProposal units.md) -> display suffix
const UNITS = {
  db: { lv2: 'units:db', osc: 'gain.db', suffix: ' dB' },
  hz: { lv2: 'units:hz', osc: 'time.hz', suffix: ' Hz' },
  ms: { lv2: 'units:ms', osc: 'time.ms', suffix: ' ms' },
  s: { lv2: 'units:s', osc: 'time.sec', suffix: ' s' },
  pc: { lv2: 'units:pc', osc: null, suffix: ' %' },
  cent: { lv2: 'units:cent', osc: 'time.cents', suffix: ' ct' },
};
const VALUE_ROLES = new Set(['param', 'bypass', 'meter']);

/** Check a descriptor source. Returns a list of problems (empty when valid). */
export function checkDescriptor(src) {
  const out = [];
  if (src.profile !== PROFILE) out.push(`profile must be ${PROFILE}`);
  const ids = new Set();
  const keys = new Set();
  let bypass = 0;
  for (const p of src.params ?? []) {
    const at = `param ${p.key ?? p.id}`;
    if (!Number.isInteger(p.id) || p.id < 0 || p.id > 0xfffffffe) out.push(`${at}: id must be a u32 (CLAP clap_id)`);
    if (ids.has(p.id)) out.push(`${at}: id ${p.id} is used twice; ids are never reused`);
    ids.add(p.id);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key ?? '')) out.push(`${at}: key must be an LV2 symbol ([A-Za-z_][A-Za-z0-9_]*)`);
    if (keys.has(p.key)) out.push(`${at}: key used twice`);
    keys.add(p.key);
    if (!['param', 'bypass', 'meter', 'fs_momentary', 'fs_latching'].includes(p.role)) out.push(`${at}: unknown role ${p.role}`);
    if (p.role === 'bypass') bypass++;
    if (VALUE_ROLES.has(p.role)) {
      if (!(typeof p.min === 'number' && typeof p.max === 'number' && p.min < p.max)) out.push(`${at}: needs min < max`);
      if (!(p.default >= p.min && p.default <= p.max)) out.push(`${at}: default outside [min, max]`);
      if (p.unit != null && !(p.unit in UNITS)) out.push(`${at}: unit ${p.unit} is not in the LV2 units table`);
      if (!['linear', 'log', 'exp'].includes(p.taper ?? 'linear')) out.push(`${at}: taper must be linear, log or exp`);
      if (p.taper === 'log' && p.min <= 0) out.push(`${at}: a log taper needs min > 0`);
      if (p.taper === 'exp' && !(p.exponent > 0)) out.push(`${at}: an exp taper needs exponent > 0 (WAM exponent)`);
    }
  }
  if (bypass > 1) out.push('at most one bypass parameter (CLAP_PARAM_IS_BYPASS)');
  return out;
}

const valueType = (p) => (p.steps === 1 && p.min === 0 && p.max === 1 ? 'T' : p.steps > 1 ? 'i' : 'f');

/** The OSCQuery namespace a device serves at GET / (and GET /<product>). */
export function toOscQuery(src) {
  const base = `/${src.product.key.replace(/_/g, '-')}`;
  const node = (p, path) => {
    const t = valueType(p);
    const n = { FULL_PATH: path, DESCRIPTION: p.name };
    if (VALUE_ROLES.has(p.role)) {
      n.TYPE = t;
      n.ACCESS = p.role === 'meter' ? 1 : 3;
      n.VALUE = [t === 'T' ? p.default === 1 : p.default];
      if (t !== 'T') { n.RANGE = [{ MIN: p.min, MAX: p.max }]; n.CLIPMODE = 'both'; }
      if (p.unit && UNITS[p.unit]?.osc) n.UNIT = [UNITS[p.unit].osc];
    } else {
      n.TYPE = 's';
      n.ACCESS = 1;
      n.RANGE = [{ VALS: p.events }];
    }
    const sq = { id: p.id, role: p.role };
    for (const k of ['shortName', 'unit', 'default', 'taper', 'exponent', 'steps', 'page', 'slot', 'smoothMs', 'display', 'rateHz', 'drives', 'events']) if (p[k] !== undefined && p[k] !== null) sq[k] = p[k];
    n.SQUATCH = sq;
    return n;
  };
  const contents = {};
  const groups = {};
  for (const p of src.params) {
    if (p.group) {
      groups[p.group] ??= { FULL_PATH: `${base}/${p.group}`, DESCRIPTION: p.group, CONTENTS: {} };
      groups[p.group].CONTENTS[p.key] = node(p, `${base}/${p.group}/${p.key}`);
    } else contents[p.key] = node(p, `${base}/${p.key}`);
  }
  Object.assign(contents, groups);
  return {
    FULL_PATH: '/',
    DESCRIPTION: src.product.house,
    CONTENTS: {
      [base.slice(1)]: {
        FULL_PATH: base,
        DESCRIPTION: src.product.name,
        SQUATCH: { profile: PROFILE, product: src.product.id, form: src.product.form, house: src.product.house },
        CONTENTS: contents,
      },
    },
  };
}

/** The same product as LV2 Turtle ports (for the Pi's PiPedal host). */
export function toLv2(src) {
  const lines = ['@prefix lv2: <http://lv2plug.in/ns/lv2core#> .', '@prefix units: <http://lv2plug.in/ns/extensions/units#> .',
    '@prefix pprops: <http://lv2plug.in/ns/ext/port-props#> .', '@prefix doap: <http://usefulinc.com/ns/doap#> .', '',
    `<${src.product.lv2}> a lv2:Plugin ;`, `  doap:name "${src.product.name}" ;`];
  const ports = [];
  let index = 0;
  for (const p of src.params) {
    if (!VALUE_ROLES.has(p.role)) continue;
    const isOut = p.role === 'meter';
    const props = [];
    if (valueType(p) === 'T') props.push('lv2:toggled');
    else if (valueType(p) === 'i') props.push('lv2:integer');
    if (p.taper === 'log') props.push('pprops:logarithmic');
    // LV2's bypass is lv2:enabled with the opposite polarity to CLAP; the host inverts the value.
    const bypass = p.role === 'bypass';
    const port = [`a lv2:ControlPort, lv2:${isOut ? 'OutputPort' : 'InputPort'}`, `lv2:index ${index++}`, `lv2:symbol "${bypass ? 'enabled' : p.key}"`,
      `lv2:name "${bypass ? 'Enabled' : p.name}"`, `lv2:minimum ${p.min}`, `lv2:maximum ${p.max}`, `lv2:default ${bypass ? 1 - p.default : p.default}`];
    if (bypass) port.push('lv2:designation lv2:enabled');
    if (p.unit) port.push(`units:unit ${UNITS[p.unit].lv2}`);
    if (props.length) port.push(`lv2:portProperty ${props.join(', ')}`);
    ports.push(`  [\n    ${port.join(' ;\n    ')}\n  ]`);
  }
  lines.push(`  lv2:port\n${ports.join(' ,\n')} .`, '');
  return lines.join('\n');
}

/** MIDI-CI Property Exchange ChCtrlList (M2-117-UM Controller Resources) for USB-MIDI hosts. */
export function toMidiCi(src, { firstCc = 20 } = {}) {
  let cc = firstCc;
  return src.params.filter((p) => p.role === 'param' || p.role === 'bypass').map((p) => {
    const e = { title: p.name, ctrlType: 'cc', ctrlIndex: [cc++], default: Math.round(((p.default - p.min) / (p.max - p.min)) * 0xffffffff), typeHint: p.role === 'bypass' ? 'toggle' : 'continuous', recognize: 'absolute', transmit: 'absolute' };
    if (p.group) e.paramPath = p.group;
    if (p.steps > 0) e.stepCount = p.steps + 1;
    return e;
  });
}

/** Web Audio Modules 2.0 WamParameterConfiguration map, for the browser rig. */
export function toWam(src) {
  return Object.fromEntries(src.params.filter((p) => p.role === 'param' || p.role === 'bypass').map((p) => [p.key, {
    label: p.name, type: valueType(p) === 'T' ? 'boolean' : valueType(p) === 'i' ? 'int' : 'float',
    defaultValue: p.default, minValue: p.min, maxValue: p.max, ...(p.taper === 'exp' ? { exponent: p.exponent } : {}), units: p.unit ?? '',
  }]));
}

// ------------------------------------------------------------------ reading a served contract
/** Normalise an OSCQuery namespace carrying SQUATCH attributes into the renderer's product model. */
export function productFromContract(doc) {
  const product = Object.values(doc.CONTENTS ?? {}).find((n) => n.SQUATCH?.profile === PROFILE);
  if (!product) throw new Error(`no ${PROFILE} product in this OSCQuery namespace`);
  const params = [];
  const meters = [];
  const events = [];
  const walk = (n) => {
    for (const c of Object.values(n.CONTENTS ?? {})) {
      if (c.CONTENTS) { walk(c); continue; }
      const sq = c.SQUATCH ?? {};
      const range = c.RANGE?.[0] ?? {};
      const bool = c.TYPE === 'T' || c.TYPE === 'F';
      const p = {
        id: sq.id, key: c.FULL_PATH.split('/').pop(), path: c.FULL_PATH, name: c.DESCRIPTION, unit: sq.unit ?? null,
        min: bool ? 0 : range.MIN, max: bool ? 1 : range.MAX, default: bool ? sq.default === 1 : sq.default,
        taper: sq.taper ?? 'linear', exponent: sq.exponent, steps: sq.steps ?? 0, display: sq.display ?? {}, role: sq.role,
        kind: bool ? 'switch' : 'knob',
      };
      if (sq.role === 'param' || sq.role === 'bypass') params.push(p);
      else if (sq.role === 'meter') meters.push(p);
      else events.push({ ...p, events: sq.events, drives: sq.drives });
    }
  };
  walk(product);
  return {
    id: product.SQUATCH.product, name: product.DESCRIPTION, form: product.SQUATCH.form, path: product.FULL_PATH,
    params, meters, events, controls: params.map((p) => ({ key: p.key, kind: p.kind })),
  };
}

export function toNormalized(p, v) {
  if (p.kind === 'switch') return v ? 1 : 0;
  const x = Math.min(p.max, Math.max(p.min, Number(v)));
  if (p.taper === 'log') return Math.log(x / p.min) / Math.log(p.max / p.min);
  const lin = (x - p.min) / (p.max - p.min);
  return p.taper === 'exp' ? lin ** (1 / p.exponent) : lin;
}

export function fromNormalized(p, n) {
  if (p.kind === 'switch') return n >= 0.5;
  const t = Math.min(1, Math.max(0, n));
  let v;
  if (p.taper === 'log') v = p.min * (p.max / p.min) ** t;
  else v = p.min + (p.max - p.min) * (p.taper === 'exp' ? t ** p.exponent : t);
  if (p.steps > 0) v = p.min + Math.round(((v - p.min) / (p.max - p.min)) * p.steps) * ((p.max - p.min) / p.steps);
  return Math.round(v * 1e4) / 1e4;
}

export function formatValue(p, v) {
  if (p.kind === 'switch') return p.role === 'bypass' ? (v ? 'bypassed' : 'engaged') : v ? 'on' : 'off';
  const d = p.display ?? {};
  const x = Number(v) * (d.scale ?? 1);
  const s = x.toFixed(d.decimals ?? 2).replace('-', '−');
  return s + (p.unit ? UNITS[p.unit]?.suffix ?? '' : '');
}

/** What crosses the wire: OSC address -> arguments, the same whatever skin or theme is showing. */
export function stateMessage(product, values) {
  return Object.fromEntries(product.params.map((p) => [p.path, [values[p.key]]]));
}

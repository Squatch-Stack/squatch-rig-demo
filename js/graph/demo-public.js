// Public static demo: only the MIT NAM Core example model is bundled. Every
// visible node has a model or effect that can actually load in a fresh browser.
import { emptyDoc, newId } from './doc.js';
import { defaultParams } from './types.js';

export function demoDoc(modelIndex) {
  const example = modelIndex.find((model) => model.file === 'namcore-example-A2.nam');
  if (!example) throw new Error('public demo needs the NAM Core A2 example model');
  const doc = emptyDoc('Demo: drives into NAM Core');
  doc.models[example.hash] = {
    name: example.name, file: example.file, family: example.family,
    arch: example.arch, bytes: example.bytes,
  };
  const add = (type, label, x, params = {}, extra = {}) => {
    const id = newId(type);
    const node = { type, label, pos: [x, 0], bypass: false, ...extra };
    node.params = { ...defaultParams(node), ...params };
    doc.nodes[id] = node;
    return id;
  };
  const chain = [
    add('input', 'DI / Interface', 0),
    add('gate', 'Gate', 160, { threshold: -36, hysteresis: 4, hold: 15, release: 40, range: -90 }),
    add('compressor', 'Squash', 310, { threshold: -30, ratio: 4, makeup: 8, mix: 0.8 }),
    add('overdrive', 'TS Drive', 480, { drive: 0.35, tone: 0.55, level: -2 }),
    add('overdrive', 'Stack Drive', 650, { drive: 0.45, tone: 0.45, level: -6 }),
    // Leave headroom for the two drives. The example model compresses hard
    // when fed at the old -4 dB trim, masking knob and bypass changes.
    add('nam', 'NAM Core head', 820, { input: -16, output: 0 }, { model: example.hash }),
    add('cab', 'Cab 4x12', 1060, { voice: 0, mic: 0.45 }),
    add('envfilter', 'Env Filter', 1250, { sens: 12, mix: 0.45 }),
    add('reverb', 'Hall', 1420, { decay: 1.2, mix: 0.08 }),
    add('limiter', 'Limiter', 1590, { ceiling: -1, gain: 0 }),
    add('output', 'Output', 1740, { volume: 0 }),
  ];
  for (let i = 1; i < chain.length; i++) doc.edges[newId('e')] = { from: [chain[i - 1], 0], to: [chain[i], 0] };
  return doc;
}

/** Upgrade only the exact first-release public demo gain settings in autosave. */
export function upgradePublicDemo(doc) {
  if (!doc || !/^(Demo: drives into NAM Core|Quick sound: )/.test(doc.name || '')) return doc;
  const nodes = Object.values(doc.nodes || {});
  const head = nodes.find((n) => n.type === 'nam' && n.label === 'NAM Core head');
  const limiter = nodes.find((n) => n.type === 'limiter' && n.label === 'Limiter');
  if (head?.params?.input !== -4 || limiter?.params?.gain !== 6 ||
      !nodes.some((n) => n.label === 'TS Drive' || n.label === 'Bloom')) return doc;
  head.params.input = -16;
  limiter.params.gain = 0;
  const gate = nodes.find((n) => n.label === 'Gate');
  if (gate?.params?.threshold === -46) Object.assign(gate.params, { threshold: -36, hold: 15, release: 40, range: -90 });
  const hall = nodes.find((n) => n.label === 'Hall');
  if (hall?.params?.decay === 2.6 && hall.params.mix === 0.22) Object.assign(hall.params, { decay: 1.2, mix: 0.08 });
  const trim = { 'Quick sound: Trail OD': -5, 'Quick sound: Bloom': -4.5, 'Quick sound: Hall': -4 }[doc.name];
  const output = nodes.find((n) => n.type === 'output');
  if (output && trim != null && output.params.volume === 0) output.params.volume = trim;
  return doc;
}

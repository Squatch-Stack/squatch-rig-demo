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
    add('gate', 'Gate', 160, { threshold: -46, hysteresis: 4 }),
    add('compressor', 'Squash', 310, { threshold: -30, ratio: 4, makeup: 8, mix: 0.8 }),
    add('overdrive', 'TS Drive', 480, { drive: 0.35, tone: 0.55, level: -2 }),
    add('overdrive', 'Stack Drive', 650, { drive: 0.45, tone: 0.45, level: -6 }),
    add('nam', 'NAM Core head', 820, { input: -4, output: 0 }, { model: example.hash }),
    add('cab', 'Cab 4x12', 1060, { voice: 0, mic: 0.45 }),
    add('envfilter', 'Env Filter', 1250, { sens: 12, mix: 0.45 }),
    add('reverb', 'Hall', 1420, { decay: 2.6, mix: 0.22 }),
    add('limiter', 'Limiter', 1590, { ceiling: -1, gain: 6 }),
    add('output', 'Output', 1740, { volume: 0 }),
  ];
  for (let i = 1; i < chain.length; i++) doc.edges[newId('e')] = { from: [chain[i - 1], 0], to: [chain[i], 0] };
  return doc;
}

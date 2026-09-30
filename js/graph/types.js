// Node type registry: ports, parameters, which knobs appear on the device face,
// and the device "form" the skin draws. Shared by the audio engine, the canvas,
// the inspector and the preset validator.
import { Compressor } from '../../worklets/dsp/compressor.js';
import { Overdrive } from '../../worklets/dsp/overdrive.js';
import { Bloom } from '../../worklets/dsp/bloom.js';
import { EnvelopeFilter } from '../../worklets/dsp/envfilter.js';
import { Reverb } from '../../worklets/dsp/reverb.js';
import { NoiseGate } from '../../worklets/dsp/gate.js';
import { Limiter } from '../../worklets/dsp/limiter.js';

const p = (label, min, max, def, unit = '', extra = {}) => ({ label, min, max, def, unit, ...extra });

function waysParams(ways, kind) {
  const out = {};
  for (let i = 0; i < ways; i++) {
    const L = String.fromCharCode(65 + i);
    out[`level${i}`] = p(`${L} lvl`, -60, 12, 0, 'dB');
    out[`pan${i}`] = p(`${L} pan`, -1, 1, kind === 'mixer' ? (ways === 1 ? 0 : -0.8 + (1.6 * i) / (ways - 1)) : 0, '');
  }
  if (kind === 'mixer') out.master = p('Master', -24, 12, -3, 'dB');
  return out;
}

export const TYPES = {
  input: {
    label: 'Input', form: 'io', color: 'io', ins: 0, outs: 1, bypassable: false,
    params: {
      source: p('Source', 0, 1, 0, '', { step: 1, options: ['DI loop', 'Interface'] }),
      channel: p('Channel', 0, 2, 0, '', { step: 1, options: ['In 1', 'In 2', 'In 1+2'] }),
      gain: p('Gain', -24, 24, 0, 'dB'),
    },
    face: ['gain'],
  },
  output: {
    label: 'Output', form: 'io', color: 'io', ins: 1, outs: 0, bypassable: false,
    params: { volume: p('Volume', -60, 6, -6, 'dB') },
    face: ['volume'],
  },
  gate: { label: 'Gate', form: 'mini', color: 'steel', ins: 1, outs: 1, worklet: 'gate', params: NoiseGate.params, face: ['threshold', 'release'] },
  compressor: { label: 'Compressor', form: 'pedal', color: 'blue', ins: 1, outs: 1, worklet: 'compressor', params: Compressor.params, face: ['threshold', 'ratio', 'release', 'makeup'] },
  overdrive: { label: 'Trail OD', form: 'pedal', color: 'green', ins: 1, outs: 1, worklet: 'overdrive', params: Overdrive.params, face: ['drive', 'tone', 'level'] },
  bloom: { label: 'Bloom', form: 'pedal', color: 'green', ins: 1, outs: 1, worklet: 'bloom', params: Bloom.params, face: ['warmth', 'bloom', 'touch', 'level'] },
  envfilter: { label: 'Env Filter', form: 'pedal', color: 'violet', ins: 1, outs: 1, worklet: 'envfilter', params: EnvelopeFilter.params, face: ['sens', 'q', 'lo', 'hi'] },
  reverb: { label: 'Reverb', form: 'pedal', color: 'teal', ins: 1, outs: 1, worklet: 'reverb', params: Reverb.params, face: ['decay', 'damp', 'predelay', 'mix'] },
  limiter: { label: 'Limiter', form: 'mini', color: 'steel', ins: 1, outs: 1, worklet: 'limiter', params: Limiter.params, face: ['gain', 'ceiling'] },
  nam: {
    label: 'NAM Head', form: 'head', color: 'amber', ins: 1, outs: 1, model: true,
    params: {
      input: p('Input', -24, 24, 0, 'dB'),
      output: p('Master', -24, 24, 0, 'dB'),
      normalize: p('Norm', 0, 1, 1, '', { step: 1, options: ['off', 'on'] }),
      dcblock: p('DC block', 0, 1, 1, '', { step: 1, options: ['off', 'on'] }),
    },
    face: ['input', 'output'],
  },
  cab: {
    label: 'Cab', form: 'cab', color: 'wood', ins: 1, outs: 1, ir: true,
    params: {
      voice: p('Voice', 0, 2, 0, '', { step: 1, options: ['4x12 closed', '2x12 open', '1x12 combo'] }),
      mic: p('Mic', 0, 1, 0.5, ''),
      lowcut: p('Low cut', 20, 300, 70, 'Hz', { curve: 'log' }),
      highcut: p('High cut', 2000, 16000, 9000, 'Hz', { curve: 'log' }),
      level: p('Level', -24, 12, 0, 'dB'),
    },
    face: ['mic', 'lowcut', 'highcut'],
  },
  splitter: {
    label: 'Splitter', form: 'utility', color: 'steel', ins: 1, outs: (n) => n.config?.ways ?? 2, bypassable: false,
    params: (n) => waysParams(n.config?.ways ?? 2, 'splitter'),
    face: (n) => Array.from({ length: n.config?.ways ?? 2 }, (_, i) => `level${i}`),
  },
  mixer: {
    label: 'Mixer', form: 'utility', color: 'steel', ins: (n) => n.config?.ways ?? 2, outs: 1, bypassable: false,
    params: (n) => waysParams(n.config?.ways ?? 2, 'mixer'),
    face: (n) => [...Array.from({ length: n.config?.ways ?? 2 }, (_, i) => `pan${i}`), 'master'],
  },
};

const resolve = (v, node) => (typeof v === 'function' ? v(node) : v);
export const typeOf = (node) => TYPES[node.type];
export const paramsOf = (node) => resolve(TYPES[node.type].params, node);
export const faceOf = (node) => resolve(TYPES[node.type].face, node);
export const insOf = (node) => resolve(TYPES[node.type].ins, node);
export const outsOf = (node) => resolve(TYPES[node.type].outs, node);
export const bypassable = (node) => TYPES[node.type].bypassable !== false;

export function defaultParams(node) {
  const out = {};
  for (const [k, v] of Object.entries(paramsOf(node))) out[k] = v.def;
  return out;
}

/** Map 0..1 knob position <-> parameter value, honouring log curves and steps. */
export function toNorm(spec, v) {
  if (spec.curve === 'log') return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  return (v - spec.min) / (spec.max - spec.min);
}
export function fromNorm(spec, t) {
  t = Math.min(1, Math.max(0, t));
  let v = spec.curve === 'log' ? spec.min * Math.pow(spec.max / spec.min, t) : spec.min + t * (spec.max - spec.min);
  if (spec.step) v = Math.round(v / spec.step) * spec.step;
  return v;
}
export function formatValue(spec, v) {
  if (spec.options) return spec.options[Math.round(v)] ?? String(v);
  const a = Math.abs(v);
  let s;
  if (spec.unit === 'Hz' && a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 1 : 2) + ' kHz';
  if (a >= 100) s = v.toFixed(0); else if (a >= 10) s = v.toFixed(1); else s = v.toFixed(2);
  return spec.unit ? `${s} ${spec.unit}`.replace(' :1', ':1') : s;
}

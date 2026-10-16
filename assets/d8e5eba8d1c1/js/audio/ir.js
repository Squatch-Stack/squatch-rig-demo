// Synthetic guitar-cab impulse responses, generated deterministically in JS so
// nothing with an unclear licence has to be bundled. An excitation (unit
// impulse plus a few sparse early reflections) goes through a cascade of RBJ
// biquads that sketch a speaker/cab: low-end resonance, a lower-mid scoop, a
// presence peak set by the "mic" control, cone break-up notch, and a steep
// top-end roll-off. It is a plausible cab colouring, not a measurement of any
// real cabinet; drop a real IR (.wav) on the node to replace it.
import { Biquad } from '../../worklets/dsp/util.js';

const VOICES = [
  // 4x12 closed back: big low resonance, darker top
  { name: '4x12 closed', res: [105, 5, 1.3], scoop: [450, -4, 1], lp: 5200, lpQ: [0.9, 0.6], notch: [4200, -7, 3], hp: 75, refl: 6, reflDb: -26 },
  // 2x12 open back: less thump, more room, brighter
  { name: '2x12 open', res: [120, 2.5, 1.1], scoop: [600, -2.5, 0.9], lp: 6500, lpQ: [0.8, 0.6], notch: [3600, -5, 2.5], hp: 90, refl: 14, reflDb: -20 },
  // 1x12 combo: boxy mids, small low end
  { name: '1x12 combo', res: [140, 3, 1.2], scoop: [380, 1.5, 1.2], lp: 7200, lpQ: [0.75, 0.55], notch: [5000, -6, 3], hp: 110, refl: 10, reflDb: -22 },
];

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {Float32Array} mono IR, peak-normalised so a 1 kHz tone is ~unity gain */
export function synthCabIR(sr, voiceIndex = 0, mic = 0.5, length = 4096) {
  const v = VOICES[Math.max(0, Math.min(VOICES.length - 1, Math.round(voiceIndex)))];
  const rnd = mulberry32(1234 + voiceIndex * 77);
  const x = new Float64Array(length);
  x[0] = 1;
  for (let i = 0; i < v.refl; i++) {
    const t = Math.floor((0.0008 + rnd() * 0.004) * sr);
    x[t] += (rnd() < 0.5 ? -1 : 1) * Math.pow(10, (v.reflDb - rnd() * 8) / 20);
  }
  const presenceF = 1800 + mic * 1600; // mic toward the cone centre: brighter
  const presenceG = -2 + mic * 9;
  const chain = [
    new Biquad().set('highpass', v.hp, sr, 0.8),
    new Biquad().set('peaking', v.res[0], sr, v.res[2], v.res[1]),
    new Biquad().set('peaking', v.scoop[0], sr, v.scoop[2], v.scoop[1]),
    new Biquad().set('peaking', presenceF, sr, 1.4, presenceG),
    new Biquad().set('peaking', v.notch[0], sr, v.notch[2], v.notch[1]),
    new Biquad().set('lowpass', v.lp * (0.85 + 0.3 * mic), sr, v.lpQ[0]),
    new Biquad().set('lowpass', v.lp * 1.25, sr, v.lpQ[1]),
  ];
  const y = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let s = x[i];
    for (const b of chain) s = b.process(s);
    y[i] = s;
  }
  const fade = Math.floor(length * 0.3);
  for (let i = 0; i < fade; i++) y[length - 1 - i] *= i / fade;
  // normalise: unity gain at 1 kHz
  let re = 0, im = 0;
  for (let i = 0; i < length; i++) { const w = 2 * Math.PI * 1000 * i / sr; re += y[i] * Math.cos(w); im -= y[i] * Math.sin(w); }
  const g = 1 / Math.hypot(re, im);
  for (let i = 0; i < length; i++) y[i] *= g;
  return y;
}

export const CAB_VOICES = VOICES.map((v) => v.name);

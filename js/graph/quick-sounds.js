// Playable starting points built from the same licensed demo rig. Choosing one
// loads a complete wired document, so the selected pedal is heard immediately.
import { demoDoc } from './demo-public.js';
import { defaultParams } from './types.js';

export const QUICK_SOUNDS = [
  { id: 'stack', label: 'Stacked drives', note: 'The full three-head demo rig.' },
  { id: 'trail', label: 'Trail OD', note: 'One drive into a centred amp.' },
  { id: 'bloom', label: 'Bloom', note: 'Pick attack stays clear while sustain blooms.' },
  { id: 'hall', label: 'Hall', note: 'The cab path with a long reverb tail.' },
];

export function quickSoundDoc(models, sound = 'stack') {
  const choice = QUICK_SOUNDS.find((item) => item.id === sound);
  if (!choice) throw new Error(`unknown quick sound: ${sound}`);
  const doc = demoDoc(models);
  doc.name = `Quick sound: ${choice.label}`;
  if (sound === 'stack') return doc;
  const node = (label) => {
    const found = Object.values(doc.nodes).find((entry) => entry.label === label);
    if (!found) throw new Error(`demo node missing: ${label}`);
    return found;
  };
  const bypass = (...labels) => labels.forEach((label) => { node(label).bypass = true; });
  const split = Object.values(doc.nodes).find((entry) => entry.label === 'Split');
  const mix = Object.values(doc.nodes).find((entry) => entry.label === 'Mix');
  if (sound === 'trail') {
    bypass('Squash', 'Stack Drive', 'Env Filter', 'Hall');
    if (split) Object.assign(split.params, { level0: -2, level1: -60, level2: -60 });
    if (mix) Object.assign(mix.params, { pan0: 0, level0: 0, master: -3 });
  } else if (sound === 'bloom') {
    const pedal = node('TS Drive');
    pedal.type = 'bloom';
    pedal.label = 'Bloom';
    pedal.params = { ...defaultParams(pedal), warmth: 0.6, bloom: 0.7, touch: 0.7 };
    bypass('Squash', 'Stack Drive', 'Env Filter');
    if (split) Object.assign(split.params, { level0: -3, level1: -60, level2: -60 });
    if (mix) Object.assign(mix.params, { pan0: 0, level0: 0, master: -3 });
    node('Hall').params.mix = 0.12;
  } else if (sound === 'hall') {
    bypass('Squash', 'TS Drive', 'Stack Drive', 'Env Filter');
    if (split) Object.assign(split.params, { level0: -60, level1: -60, level2: 0 });
    if (mix) Object.assign(mix.params, { pan2: 0, level2: 0, master: -3 });
    Object.assign(node('Hall').params, { decay: 4.2, mix: 0.42 });
    if (!split) Object.assign(node('Gate').params, { threshold: -46, hold: 40, release: 90 });
  }
  // The public one-head model has a different loudness curve from the private
  // three-head capture mix. Trim complete public sounds after the amp so
  // switching sounds does not jump several dB.
  if (!split) node('Output').params.volume = { trail: -5, bloom: -4.5, hall: -4 }[sound] ?? 0;
  return doc;
}

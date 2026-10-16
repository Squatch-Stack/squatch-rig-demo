// Which audio input the rig should listen to. "System default" on a laptop is its built-in microphone: with
// Source -> Interface that sends the room (and the player's voice) through the amp, and with speakers on it
// howls. So the rig remembers the player's choice, prefers a real interface when one is plugged in, and says
// so when it is about to listen through a built-in microphone.

const BUILT_IN = /built-?in|macbook|imac|internal|iphone|ipad|airpods|webcam|facetime/i;
// Chrome lists aliases of the system default ("Default - ...", "Communications - ...") with these ids.
const ALIAS_IDS = new Set(['', 'default', 'communications']);

export function isBuiltIn(label) {
  return BUILT_IN.test(String(label || ''));
}

/**
 * The input to use: the saved choice if that device is present (by id, else by its label, since ids can change
 * between sessions), otherwise the first real interface, otherwise '' (the system default).
 * `inputs` are MediaDeviceInfo-like { deviceId, label }; labels are empty until the page has mic permission,
 * and then nothing is picked automatically.
 */
export function pickInput(inputs, saved = {}) {
  const real = inputs.filter((d) => !ALIAS_IDS.has(d.deviceId));
  if (saved.id && real.some((d) => d.deviceId === saved.id)) return saved.id;
  if (saved.label) {
    const byLabel = real.find((d) => d.label === saved.label);
    if (byLabel) return byLabel.deviceId;
  }
  const iface = real.find((d) => d.label && !isBuiltIn(d.label));
  return iface ? iface.deviceId : '';
}

/** The label of what `deviceId` ('' = system default) actually listens to, for the built-in warning. */
export function effectiveLabel(inputs, deviceId) {
  if (deviceId) return inputs.find((d) => d.deviceId === deviceId)?.label ?? '';
  const def = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
  return def ? String(def.label || '').replace(/^Default - /, '') : '';
}

/** Saved choices are "id\tlabel"; tolerant of anything else. */
export function readChoice(raw) {
  if (!raw) return {};
  const [id = '', label = ''] = String(raw).split('\t');
  return { id, label };
}

export function writeChoice(id, label) {
  return `${id || ''}\t${label || ''}`;
}

// Describe a parsed .nam document in a few words (architecture family, size).
// Works in the browser and in Node (used by tools/model-index.mjs).
export function describeModel(doc) {
  const arch = doc.architecture;
  const c = doc.config || {};
  if (arch === 'WaveNet' && Array.isArray(c.layers)) {
    const L = c.layers[0] || {};
    const layers = c.layers.reduce((s, l) => s + (l.dilations?.length || 0), 0);
    const ch = L.channels;
    const dw = L.groups_input && L.groups_input === ch && ch > 1;
    const a2 = L.layer1x1 !== undefined && L.kernel_sizes !== undefined;
    const family = dw ? 'A3' : a2 ? 'A2' : 'A1';
    return { family, text: `WaveNet ${family}${dw ? ' depthwise' : ''} · ${ch}ch · ${layers} layers` };
  }
  if (arch === 'SlimmableContainer') {
    const n = c.submodels?.length || 0;
    const inner = c.submodels?.[n - 1]?.model ? describeModel(c.submodels[n - 1].model) : { family: '?' };
    return { family: inner.family, text: `Slimmable · ${n} sizes · ${inner.text || ''}` };
  }
  return { family: arch, text: arch || 'unknown' };
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

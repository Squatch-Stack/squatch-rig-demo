// WAV (RIFF/WAVE) encoder and decoder. Pure JS over ArrayBuffers: the Record
// button, the offline renderer (tools/render.mjs) and the tests all use it.
//
//   encodeWav(channels, sampleRate, { format })  -> ArrayBuffer
//     channels  array of Float32Array (all the same length), -1..1
//     format    'pcm16' | 'pcm24' | 'float32' (default 'pcm24')
//     PCM is scaled by 2^(bits-1), rounded and clamped (so +1.0 becomes the
//     largest positive code; decode divides by the same 2^(bits-1), which makes
//     the round trip exact to half an LSB). No dither: the rig's
//     output already carries far more noise than a 24-bit LSB, and determinism
//     matters more for the renders.
//   decodeWav(ArrayBuffer | Uint8Array) -> { sampleRate, channels: Float32Array[] }
//     reads PCM 16/24/32 and IEEE float 32/64, including WAVE_FORMAT_EXTENSIBLE.

const FORMATS = {
  pcm16: { tag: 1, bits: 16 },
  pcm24: { tag: 1, bits: 24 },
  float32: { tag: 3, bits: 32 },
};

export function encodeWav(channels, sampleRate, { format = 'pcm24' } = {}) {
  const f = FORMATS[format];
  if (!f) throw new Error(`unknown WAV format ${format}`);
  if (!channels.length) throw new Error('no channels');
  const nch = channels.length, frames = channels[0].length;
  for (const c of channels) if (c.length !== frames) throw new Error('channel lengths differ');
  const bps = f.bits / 8, block = nch * bps, dataBytes = frames * block;
  const buf = new ArrayBuffer(44 + dataBytes + (dataBytes & 1));
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes + (dataBytes & 1), true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, f.tag, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * block, true); dv.setUint16(32, block, true); dv.setUint16(34, f.bits, true);
  str(36, 'data'); dv.setUint32(40, dataBytes, true);
  let o = 44;
  if (f.tag === 3) {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) { dv.setFloat32(o, channels[c][i], true); o += 4; }
  } else if (f.bits === 16) {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) {
      dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32768))), true); o += 2;
    }
  } else {
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) {
      const s = Math.max(-8388608, Math.min(8388607, Math.round(channels[c][i] * 8388608)));
      u8[o] = s & 0xff; u8[o + 1] = (s >> 8) & 0xff; u8[o + 2] = (s >> 16) & 0xff; o += 3;
    }
  }
  return buf;
}

export function decodeWav(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= u8.length) {
    const id = tag(p), size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') {
      fmt = { tag: dv.getUint16(p + 8, true), ch: dv.getUint16(p + 10, true), sr: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
      if (fmt.tag === 0xfffe && size >= 26) fmt.tag = dv.getUint16(p + 32, true); // SubFormat GUID's first two bytes
    } else if (id === 'data') data = { off: p + 8, size: Math.min(size, u8.length - p - 8) };
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data chunk');
  const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.ch));
  const channels = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.ch; c++) {
      const o = data.off + (i * fmt.ch + c) * bps;
      let v;
      if (fmt.tag === 3) v = fmt.bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      else if (fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (fmt.bits === 24) { let s = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16); if (s & 0x800000) s -= 0x1000000; v = s / 8388608; }
      else if (fmt.bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else if (fmt.bits === 8) v = (u8[o] - 128) / 128;
      else throw new Error(`unsupported WAV: ${fmt.bits}-bit format ${fmt.tag}`);
      channels[c][i] = v;
    }
  }
  return { sampleRate: fmt.sr, channels };
}

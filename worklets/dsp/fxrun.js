// Per-quantum glue between a host (AudioWorklet or the offline renderer) and
// an effect kernel: channel mapping, and the values a kernel exposes for
// metering. Shared so the browser and tools/render run identical code.

/** Run one block. `ins`/`out` are arrays of Float32Array channels. */
export function runFx(kind, kernel, ins, out, n) {
  if (kind === 'reverb') { kernel.process(ins, out, n); return; }
  // Kernels map input channel c to output channel c; pad/duplicate as needed.
  const chans = Math.min(ins.length, out.length);
  kernel.process(ins.slice(0, chans), out.slice(0, chans), n);
  for (let c = chans; c < out.length; c++) out[c].set(out[chans - 1]);
}

/**
 * Metering values a kernel exposes, normalised across kinds:
 *   gr      gain reduction in dB, >= 0 (compressor, limiter, gate)
 *   cutoff  filter frequency in Hz (env filter), else null
 *   env     detector envelope, linear (gate, env filter), else null
 *   open    gate state (gate only), else null
 */
export function fxMeter(kind, k) {
  switch (kind) {
    case 'compressor': return { gr: Math.max(0, k.grDb || 0), cutoff: null, env: null, open: null };
    case 'limiter': return { gr: Math.max(0, k.grDb || 0), cutoff: null, env: null, open: null };
    case 'gate': return { gr: Math.max(0, -20 * Math.log10(Math.max(k.gain, 1e-6))), cutoff: null, env: k.env, open: k.open };
    case 'envfilter': return { gr: 0, cutoff: k.cutoff, env: k.env, open: null };
    case 'bloom': {
      // drive share since the last read (0..1) and the pick guard's peak; reading resets both
      const bloom = k.mixN ? k.mixSum / k.mixN : 0, pick = k.pickPeak || 0;
      k.mixSum = 0; k.mixN = 0; k.pickPeak = 0;
      return { gr: 0, cutoff: null, env: null, open: null, bloom, pick };
    }
    default: return { gr: 0, cutoff: null, env: null, open: null };
  }
}

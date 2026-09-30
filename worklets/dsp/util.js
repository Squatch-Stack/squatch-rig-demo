// Shared DSP helpers. Plain ES modules with no DOM or WebAudio dependency, so
// the same code runs in AudioWorkletGlobalScope and under `node --test`.

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));

/** One-pole smoothing coefficient for a time constant in ms (to ~63%). */
export const tauCoef = (ms, sr) => (ms <= 0 ? 0 : Math.exp(-1 / (0.001 * ms * sr)));

/** Kaiser-windowed-sinc lowpass. cutoff is normalised to the sample rate (0..0.5). */
export function kaiserLowpass(taps, cutoff, beta = 8) {
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  const i0 = (x) => {
    let sum = 1, t = 1;
    for (let k = 1; k < 50; k++) { t *= (x / (2 * k)) ** 2; sum += t; if (t < 1e-12 * sum) break; }
    return sum;
  };
  const denom = i0(beta);
  let s = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - m;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const r = (2 * n) / (taps - 1) - 1;
    h[n] = sinc * (i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom);
    s += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= s;
  return h;
}

/** First-order TPT (topology-preserving) filter: lowpass and highpass outputs. */
export class OnePole {
  constructor() { this.s = 0; this.g = 0; }
  setCutoff(fc, sr) {
    const g = Math.tan(Math.PI * Math.min(fc, 0.49 * sr) / sr);
    this.g = g / (1 + g);
  }
  lp(x) { const v = (x - this.s) * this.g; const y = v + this.s; this.s = y + v; return y; }
  hp(x) { return x - this.lp(x); }
  reset() { this.s = 0; }
}

/** DC blocker: y = x - x1 + R*y1. */
export class DcBlock {
  constructor(sr, fc = 10) { this.r = Math.exp(-2 * Math.PI * fc / sr); this.x1 = 0; this.y1 = 0; }
  process(x) { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = y; return y; }
}

/**
 * RBJ biquad (direct form I, double precision state). Used for the cab IR
 * generator and EQ-ish shaping; not in any modulated path.
 */
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  set(type, f, sr, q = 0.7071, gainDb = 0) {
    const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'peaking': b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
      case 'lowshelf': {
        const sa = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * cw + sa); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sa);
        a0 = (A + 1) + (A - 1) * cw + sa; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sa; break;
      }
      case 'highshelf': {
        const sa = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * cw + sa); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sa);
        a0 = (A + 1) - (A - 1) * cw + sa; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sa; break;
      }
      default: throw new Error('biquad type ' + type);
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Fast rational tanh approximation (|err| < 2e-4, exact saturation at +-1). */
export function tanhFast(x) {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const x2 = x * x;
  const a = x * (135135 + x2 * (17325 + x2 * (378 + x2)));
  const b = 135135 + x2 * (62370 + x2 * (3150 + x2 * 28));
  return a / b;
}

/**
 * Accumulates peak and mean-square of the processor's output so the processor
 * can report levels to the UI a few dozen times a second.
 */
export class LevelMeter {
  constructor() { this.peak = 0; this.sumSq = 0; this.n = 0; }
  add(buf, n) {
    let p = this.peak, s = this.sumSq;
    for (let i = 0; i < n; i++) { const v = buf[i]; const a = v < 0 ? -v : v; if (a > p) p = a; s += v * v; }
    this.peak = p; this.sumSq = s; this.n += n;
  }
  take() {
    const r = { peak: this.peak, rms: this.n ? Math.sqrt(this.sumSq / this.n) : 0 };
    this.peak = 0; this.sumSq = 0; this.n = 0;
    return r;
  }
}

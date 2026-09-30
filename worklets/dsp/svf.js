// Zero-delay-feedback state variable filter (Simper / Cytomic "SvfLinearTrapOptimised2").
export class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.set(1000, 0.707, 48000); }
  set(fc, q, sr) {
    const g = Math.tan(Math.PI * Math.min(fc, 0.49 * sr) / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  /** Returns [lp, bp, hp] via out (Float64Array(3)). */
  tick(v0, out) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    out[0] = v2; out[1] = v1; out[2] = v0 - this.k * v1 - v2;
  }
}

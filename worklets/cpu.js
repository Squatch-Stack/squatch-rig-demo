// Per-node CPU accounting inside a worklet. AudioWorkletGlobalScope may not
// expose `performance`; Date.now() (1 ms ticks) is then used, which is still an
// unbiased estimator of the MEAN render time when averaged over many quanta
// (each quantum's start is uniformly distributed against the tick), but gives
// no useful per-quantum max.
const hasPerf = typeof globalThis.performance !== 'undefined' && typeof globalThis.performance.now === 'function';
const now = hasPerf ? () => globalThis.performance.now() : () => Date.now();

export class CpuMeter {
  // Reports every `reportEvery` quanta; the mean is an exponential average over
  // ~`window` quanta (about 1 s), long enough for the 1 ms-tick estimator.
  constructor(reportEvery = 16, window = 384) {
    this.every = reportEvery; this.a = 1 / window; this.ema = null; this.count = 0; this.max = 0; this.frames = 0;
  }
  start() { return now(); }
  /** Returns a stats object every `reportEvery` quanta, else null. */
  stop(t0, frames) {
    const dt = now() - t0;
    this.ema = this.ema === null ? dt : this.ema + (dt - this.ema) * this.a;
    if (dt > this.max) this.max = dt; this.count++; this.frames += frames;
    if (this.count < this.every) return null;
    const budgetMs = (1000 * this.frames) / this.count / sampleRate;
    const meanMs = this.ema;
    const r = { cpuUs: meanMs * 1000, cpuMaxUs: hasPerf ? this.max * 1000 : null, budgetUs: budgetMs * 1000, precise: hasPerf };
    this.count = 0; this.max = 0; this.frames = 0;
    return r;
  }
}

// Master tap: an inline, pass-through stereo node at the very end of the chain
// (master level -> tap -> destination), so what it sees is exactly what is
// heard. It
//   - meters every sample (true sample peak, RMS, clip count) and reports at
//     ~60 Hz, which the analyser-based meters cannot (they see a window),
//   - records: while armed it ships the audio to the main thread in ~100 ms
//     chunks, where web/js/audio/wav.js turns it into a WAV file,
//   - counts render quanta, so a check can prove process() is being called.
const METER_EVERY = 6;       // quanta (768 frames = 16 ms at 48 kHz)
const CHUNK = 4800;          // frames per recording message (100 ms)
const CLIP = 0.999;          // |x| at or above this counts as a clipped sample

class RigTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.quanta = 0; this.count = 0;
    this.pk = [0, 0]; this.ss = [0, 0]; this.n = 0; this.clips = 0;
    this.rec = false; this.fill = 0; this._newChunk();
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'record') {
        if (m.on && !this.rec) { this.rec = true; this.fill = 0; this.port.postMessage({ type: 'recstart', frame: currentFrame }); }
        else if (!m.on && this.rec) { this.rec = false; this._flush(); this.port.postMessage({ type: 'recstop', frame: currentFrame }); }
      }
    };
  }
  _newChunk() { this.cL = new Float32Array(CHUNK); this.cR = new Float32Array(CHUNK); }
  _flush() {
    if (!this.fill) return;
    const L = this.cL, R = this.cR, n = this.fill;
    this.port.postMessage({ type: 'chunk', n, L, R }, [L.buffer, R.buffer]);
    this.fill = 0; this._newChunk();
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    const L = inp && inp[0], R = inp && (inp[1] || inp[0]);
    if (!L) { for (const ch of out) ch.fill(0); } else {
      out[0].set(L); if (out[1]) out[1].set(R);
      let pL = this.pk[0], pR = this.pk[1], sL = this.ss[0], sR = this.ss[1], clips = this.clips;
      for (let i = 0; i < n; i++) {
        const a = L[i], b = R[i];
        const aa = a < 0 ? -a : a, bb = b < 0 ? -b : b;
        if (aa > pL) pL = aa; if (bb > pR) pR = bb;
        if (aa >= CLIP) clips++; if (bb >= CLIP) clips++;
        sL += a * a; sR += b * b;
      }
      this.pk[0] = pL; this.pk[1] = pR; this.ss[0] = sL; this.ss[1] = sR; this.clips = clips;
      if (this.rec) {
        let off = 0;
        while (off < n) {
          const k = Math.min(n - off, CHUNK - this.fill);
          this.cL.set(L.subarray(off, off + k), this.fill); this.cR.set(R.subarray(off, off + k), this.fill);
          this.fill += k; off += k;
          if (this.fill === CHUNK) this._flush();
        }
      }
    }
    this.n += n; this.quanta++;
    if (++this.count >= METER_EVERY) {
      this.count = 0;
      this.port.postMessage({ type: 'meter', peakL: this.pk[0], peakR: this.pk[1], sumsqL: this.ss[0], sumsqR: this.ss[1], n: this.n, clips: this.clips, frame: currentFrame, quanta: this.quanta });
      this.pk[0] = this.pk[1] = this.ss[0] = this.ss[1] = 0; this.n = 0; this.clips = 0;
    }
    return true;
  }
}
registerProcessor('rig-tap', RigTapProcessor);

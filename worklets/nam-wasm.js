// Minimal loader for web/wasm/nam.wasm (built with -sSTANDALONE_WASM, so the
// only imports are a handful of WASI stubs). No Emscripten JS glue: the same
// code runs in AudioWorkletGlobalScope (which has no fetch, and in some
// browsers no TextDecoder) and in Node for the tests.

function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}

function utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const s = unescape(encodeURIComponent(str));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Instantiate the NAM module synchronously from a compiled WebAssembly.Module
 * (compiled once on the main thread and handed to each worklet node).
 * @param {WebAssembly.Module} module
 * @param {(line: string) => void} [log]
 */
export function instantiateNam(module, log = () => {}) {
  let memory = null;
  const errBuf = [];
  const view = () => new DataView(memory.buffer);
  const wasi = {
    fd_write(fd, iovs, iovsLen, nwritten) {
      const dv = view();
      let n = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true);
        const len = dv.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        for (const b of bytes) {
          if (b === 10) { log(utf8Decode(new Uint8Array(errBuf))); errBuf.length = 0; } else errBuf.push(b);
        }
        n += len;
      }
      dv.setUint32(nwritten, n, true);
      return 0;
    },
    fd_seek: () => 70, fd_read: () => 70, fd_close: () => 0,
    environ_sizes_get(countPtr, sizePtr) { const dv = view(); dv.setUint32(countPtr, 0, true); dv.setUint32(sizePtr, 0, true); return 0; },
    environ_get: () => 0,
  };
  const instance = new WebAssembly.Instance(module, {
    env: { emscripten_notify_memory_growth() {} },
    wasi_snapshot_preview1: wasi,
  });
  const x = instance.exports;
  memory = x.memory;
  x._initialize();

  const cstr = (ptr) => {
    const u8 = new Uint8Array(memory.buffer);
    let end = ptr; while (u8[end]) end++;
    return utf8Decode(u8.subarray(ptr, end));
  };

  return {
    /**
     * @param {string|Uint8Array} json .nam file contents
     * @returns {NamModel}
     */
    create(json, sampleRate, maxBlock = 128) {
      const bytes = typeof json === 'string' ? utf8Encode(json) : json;
      const p = x.nam_malloc(bytes.length);
      new Uint8Array(memory.buffer, p, bytes.length).set(bytes);
      const h = x.nam_create(p, bytes.length, sampleRate, maxBlock);
      x.nam_free(p);
      if (!h) throw new Error('NAM load failed: ' + cstr(x.nam_last_error()));
      return new NamModel(x, memory, h, maxBlock);
    },
  };
}

export class NamModel {
  constructor(x, memory, h, maxBlock) {
    this.x = x; this.memory = memory; this.h = h; this.maxBlock = maxBlock;
    this.inPtr = x.nam_in_ptr(h); this.outPtr = x.nam_out_ptr(h);
    this._bind();
    this.expectedSampleRate = x.nam_expected_sample_rate(h);
    const loud = x.nam_loudness(h);
    this.loudness = loud > 1e8 ? null : loud;
  }
  _bind() {
    this.buf = this.memory.buffer;
    this.inView = new Float32Array(this.buf, this.inPtr, this.maxBlock);
    this.outView = new Float32Array(this.buf, this.outPtr, this.maxBlock);
  }
  /** Process `input` (Float32Array, length <= maxBlock) into `output`. */
  process(input, output, n = input.length) {
    if (this.buf !== this.memory.buffer) this._bind(); // memory grew
    this.inView.set(n === input.length ? input : input.subarray(0, n));
    this.x.nam_process(this.h, n);
    if (this.buf !== this.memory.buffer) this._bind();
    output.set(n === this.maxBlock ? this.outView : this.outView.subarray(0, n));
  }
  reset(sampleRate) { this.x.nam_reset(this.h, sampleRate); }
  destroy() { if (this.h) { this.x.nam_destroy(this.h); this.h = 0; } }
}

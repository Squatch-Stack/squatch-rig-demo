// Model and IR library. Bundled models are listed in /models/index.json with
// their sha256; anything the user drops is hashed, kept in IndexedDB under that
// hash, and referenced from presets by hash only (the bytes never go into a
// preset).
import { describeModel, sha256Hex } from './modeldesc.js';

const DB = 'squatch-rig', STORE = 'blobs';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction(STORE).objectStore(STORE).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch { return undefined; }
}
async function idbPut(key, value) {
  try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(value, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) { console.warn('IndexedDB unavailable', e); }
}
async function idbKeys() {
  try { const db = await idb(); return await new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }); } catch { return []; }
}

export class Library {
  constructor(base = new URL('../../models/', import.meta.url)) { this.base = base; this.models = []; this.cache = new Map(); this.user = new Map(); }
  async init() {
    const r = await fetch(new URL('index.json', this.base));
    this.models = (await r.json()).models;
    for (const k of await idbKeys()) {
      if (!String(k).startsWith('meta:')) continue;
      const info = await idbGet(k);
      if (info?.kind === 'model') this.user.set(info.hash, info);
    }
    return this;
  }
  list() { return [...this.models, ...this.user.values()]; }
  info(hash) { return this.models.find((m) => m.hash === hash) || this.user.get(hash) || null; }
  /** @returns {Promise<ArrayBuffer|null>} */
  async bytes(hash) {
    if (this.cache.has(hash)) return this.cache.get(hash);
    const m = this.models.find((x) => x.hash === hash);
    let buf = null;
    if (m) buf = await (await fetch(new URL(m.file, this.base))).arrayBuffer();
    else buf = (await idbGet('blob:' + hash)) || null;
    if (buf) this.cache.set(hash, buf);
    return buf;
  }
  /** Add a dropped .nam file. Returns its library entry. */
  async addModelFile(file) {
    const buf = await file.arrayBuffer();
    const doc = JSON.parse(new TextDecoder().decode(buf));
    if (!doc.architecture || !doc.config) throw new Error(`${file.name}: not a .nam model`);
    const hash = 'sha256:' + (await sha256Hex(buf));
    const d = describeModel(doc);
    const info = { kind: 'model', hash, name: file.name.replace(/\.nam$/i, ''), family: d.family, arch: d.text, bytes: buf.byteLength, loudness: doc.metadata?.loudness ?? null, source: 'dropped by user', licence: 'unknown (user file)' };
    await idbPut('blob:' + hash, buf);
    await idbPut('meta:' + hash, info);
    this.user.set(hash, info);
    this.cache.set(hash, buf);
    return info;
  }
  /** Add a dropped IR .wav. Returns { hash, name, buf }. */
  async addIrFile(file) {
    const buf = await file.arrayBuffer();
    const hash = 'sha256:' + (await sha256Hex(buf));
    await idbPut('blob:' + hash, buf);
    await idbPut('meta:' + hash, { kind: 'ir', hash, name: file.name });
    this.cache.set(hash, buf);
    return { hash, name: file.name, buf };
  }
}

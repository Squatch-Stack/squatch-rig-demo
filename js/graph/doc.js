// The pipeline document ("preset"): a plain JSON object and the only source of
// truth. The audio engine and the canvas both reconcile themselves against it.
//
// Shape (format squatch-rig/pipeline, version 1):
//   {
//     format, version, id, name,
//     meta:   { created, modified, owner, signature, parents: [] },
//     models: { "<sha256:...>": { name, file?, family, arch, bytes } },   // refs by hash
//     irs:    { "<sha256:...>": { name } },
//     nodes:  { "<nodeId>": { type, label, pos: [x, y], bypass, params: {..}, config?: {..},
//                             model?: "<sha256:...>", ir?: "<sha256:...>" } },
//     edges:  { "<edgeId>": { from: ["<nodeId>", outPort], to: ["<nodeId>", inPort] } }
//   }
//
// Everything that can change concurrently is a map keyed by a random id (never
// an array index), so every edit is a set/delete at a path. That maps 1:1 onto
// Loro's LoroMap containers for a later CRDT sync, and two peers adding nodes
// or edges never collide. `meta.signature` covers canonicalJSON(doc with
// meta.signature = null); see canonicalJSON below.
import { TYPES, defaultParams, insOf, outsOf, paramsOf } from './types.js';

export const FORMAT = 'squatch-rig/pipeline';
export const VERSION = 1;

export const newId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

export function emptyDoc(name = 'Untitled rig') {
  const now = new Date().toISOString();
  return {
    format: FORMAT, version: VERSION, id: newId('rig'), name,
    meta: { created: now, modified: now, owner: null, signature: null, parents: [] },
    models: {}, irs: {}, nodes: {}, edges: {},
  };
}

/** Deterministic serialisation (sorted keys, no whitespace) for hashing and signing. */
export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
}

/** Validate and normalise an incoming document. Throws on anything unusable. */
export function validateDoc(doc) {
  if (!doc || doc.format !== FORMAT) throw new Error('not a squatch-rig pipeline');
  if (doc.version > VERSION) throw new Error(`pipeline version ${doc.version} is newer than this app (${VERSION})`);
  const d = structuredClone(doc);
  d.meta = { created: null, modified: null, owner: null, signature: null, parents: [], ...(d.meta || {}) };
  d.models ||= {}; d.irs ||= {}; d.nodes ||= {}; d.edges ||= {};
  for (const [id, n] of Object.entries(d.nodes)) {
    if (!TYPES[n.type]) throw new Error(`node ${id}: unknown type ${n.type}`);
    n.params = { ...defaultParams(n), ...(n.params || {}) };
    n.pos ||= [0, 0];
    n.bypass = !!n.bypass;
    n.label ||= TYPES[n.type].label;
  }
  for (const [id, e] of Object.entries(d.edges)) {
    const a = d.nodes[e.from?.[0]], b = d.nodes[e.to?.[0]];
    if (!a || !b || e.from[1] >= outsOf(a) || e.to[1] >= insOf(b)) { delete d.edges[id]; continue; }
  }
  return d;
}

/**
 * Observable store around one document with snapshot undo. Every mutation
 * goes through `change(kind, fn)`; listeners get (doc, kind).
 */
export class Store extends EventTarget {
  constructor(doc) { super(); this.doc = validateDoc(doc); this.undoStack = []; this.redoStack = []; }
  _emit(kind, detail = {}) { this.dispatchEvent(new CustomEvent('change', { detail: { kind, ...detail } })); }
  /** kind: 'topology' | 'params' | 'layout' | 'meta' | 'load' */
  change(kind, fn, { undoable = true, coalesce = null } = {}) {
    if (undoable) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (!(coalesce && top && top.coalesce === coalesce && Date.now() - top.t < 800)) {
        this.undoStack.push({ snap: JSON.stringify(this.doc), coalesce, t: Date.now() });
        if (this.undoStack.length > 200) this.undoStack.shift();
      } else top.t = Date.now();
      this.redoStack.length = 0;
    }
    const r = fn(this.doc);
    this.doc.meta.modified = new Date().toISOString();
    this._emit(kind);
    return r;
  }
  load(doc) { this.undoStack.push({ snap: JSON.stringify(this.doc), t: 0 }); this.doc = validateDoc(doc); this._emit('load'); }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push(JSON.stringify(this.doc)); this.doc = JSON.parse(s.snap); this._emit('load'); }
  redo() { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push({ snap: JSON.stringify(this.doc), t: 0 }); this.doc = JSON.parse(s); this._emit('load'); }

  addNode(type, pos, extra = {}) {
    return this.change('topology', (d) => {
      const id = newId(type);
      const node = { type, label: TYPES[type].label, pos, bypass: false, ...extra };
      node.params = { ...defaultParams(node), ...(extra.params || {}) };
      d.nodes[id] = node;
      return id;
    });
  }
  removeNode(id) {
    const node = this.doc.nodes[id];
    if (!node) return false;
    if ((node.type === 'input' || node.type === 'output') &&
        Object.values(this.doc.nodes).filter((n) => n.type === node.type).length === 1) {
      this.dispatchEvent(new CustomEvent('blocked', { detail: `Keep one ${node.type === 'output' ? 'Output' : 'Input'} stage in the rig.` }));
      return false;
    }
    this.change('topology', (d) => {
      delete d.nodes[id];
      for (const [eid, e] of Object.entries(d.edges)) if (e.from[0] === id || e.to[0] === id) delete d.edges[eid];
    });
    return true;
  }
  /** Repair an older saved rig whose Output was deleted, keeping its other edits. */
  restoreOutput() {
    const existing = Object.entries(this.doc.nodes).find(([, n]) => n.type === 'output');
    if (existing) return existing[0];
    const fed = new Set(Object.values(this.doc.edges).map((e) => e.from[0]));
    const ends = Object.entries(this.doc.nodes).filter(([id, n]) => outsOf(n) > 0 && !fed.has(id));
    ends.sort((a, b) => b[1].pos[0] - a[1].pos[0]);
    const last = ends[0];
    return this.change('topology', (d) => {
      const id = newId('output');
      const node = { type: 'output', label: 'Output', pos: last ? [last[1].pos[0] + 180, last[1].pos[1]] : [0, 0], bypass: false };
      node.params = { ...defaultParams(node), volume: 0 };
      d.nodes[id] = node;
      if (last) d.edges[newId('e')] = { from: [last[0], 0], to: [id, 0] };
      return id;
    });
  }
  connect(from, to) {
    const d = this.doc;
    if (from[0] === to[0]) return null;
    if (Object.values(d.edges).some((e) => e.from[0] === from[0] && e.from[1] === from[1] && e.to[0] === to[0] && e.to[1] === to[1])) return null;
    if (this.reaches(to[0], from[0])) return null; // would make a cycle
    return this.change('topology', (doc) => { const id = newId('e'); doc.edges[id] = { from, to }; return id; });
  }
  disconnect(edgeId) { this.change('topology', (d) => { delete d.edges[edgeId]; }); }
  /** Is `target` reachable downstream of `start`? */
  reaches(start, target) {
    const seen = new Set([start]), stack = [start];
    while (stack.length) {
      const n = stack.pop();
      if (n === target) return true;
      for (const e of Object.values(this.doc.edges)) if (e.from[0] === n && !seen.has(e.to[0])) { seen.add(e.to[0]); stack.push(e.to[0]); }
    }
    return false;
  }
  setParam(id, name, value) {
    this.change('params', (d) => { d.nodes[id].params[name] = value; }, { coalesce: `${id}.${name}` });
  }
  setBypass(id, value) { this.change('params', (d) => { d.nodes[id].bypass = value; }); }
  moveNode(id, pos) { this.change('layout', (d) => { d.nodes[id].pos = pos; }, { coalesce: `${id}.pos` }); }
  setModel(id, hash, info) {
    this.change('model', (d) => { d.models[hash] = info; d.nodes[id].model = hash; this._gc(d); });
  }
  setIr(id, hash, info) { this.change('ir', (d) => { if (hash) d.irs[hash] = info; d.nodes[id].ir = hash; this._gc(d); }); }
  _gc(d) {
    const used = new Set(Object.values(d.nodes).flatMap((n) => [n.model, n.ir]).filter(Boolean));
    for (const k of Object.keys(d.models)) if (!used.has(k)) delete d.models[k];
    for (const k of Object.keys(d.irs)) if (!used.has(k)) delete d.irs[k];
  }
}

export { paramsOf };

// DOM inspector for the selected node: real <input type=range> controls, so
// every parameter is reachable by keyboard and screen reader even though the
// graph itself is a canvas.
import { TYPES, paramsOf, toNorm, fromNorm, formatValue, bypassable } from '../graph/types.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

export class Inspector {
  constructor({ el, store, engine, library, onPickModel, onPickIr }) {
    Object.assign(this, { el, store, engine, library, onPickModel, onPickIr });
    this.id = null;
    store.addEventListener('change', (e) => { if (e.detail.kind !== 'layout') this.render(e.detail.kind === 'params'); });
    engine?.addEventListener?.('node-status', () => this.render());
  }
  show(id) { this.id = id; this.render(); }

  render(paramsOnly = false) {
    const node = this.id && this.store.doc.nodes[this.id];
    if (!node) { this.el.replaceChildren(this._empty()); return; }
    // cheap path while a knob is being dragged: update values in place
    if (paramsOnly && this.el.dataset.node === this.id) {
      for (const [k, spec] of Object.entries(paramsOf(node))) {
        const r = this.el.querySelector(`[data-param="${k}"]`);
        if (r && document.activeElement !== r) r.value = String(toNorm(spec, node.params[k]) * 1000);
        const o = this.el.querySelector(`[data-out="${k}"]`);
        if (o) o.textContent = formatValue(spec, node.params[k]);
      }
      const bp = this.el.querySelector('[data-bypass]');
      if (bp) { bp.setAttribute('aria-pressed', String(!node.bypass)); bp.textContent = node.bypass ? 'Bypassed' : 'On'; }
      return;
    }
    this.el.dataset.node = this.id;
    const def = TYPES[node.type];
    const eng = this.engine?.nodes?.get(this.id);
    const kids = [], side = [];
    side.push(h('div', { class: 'insp-head' },
      h('input', { class: 'insp-title', value: node.label, 'aria-label': 'Device name', onchange: (e) => this.store.change('meta', (d) => { d.nodes[this.id].label = e.target.value || def.label; }) }),
      h('span', { class: 'insp-type' }, def.label),
    ));
    const row = h('div', { class: 'insp-actions' });
    if (bypassable(node)) {
      row.append(h('button', { 'data-bypass': '', 'aria-pressed': String(!node.bypass), class: 'toggle', onclick: () => this.store.setBypass(this.id, !node.bypass) }, node.bypass ? 'Bypassed' : 'On'));
    }
    row.append(h('button', { class: 'danger', onclick: () => this.store.removeNode(this.id) }, 'Remove'));
    side.push(row);

    if (node.type === 'nam') side.push(this._modelPanel(node, eng));
    if (node.type === 'cab') side.push(this._irPanel(node, eng));
    if (node.type === 'splitter' || node.type === 'mixer') {
      const ways = node.config?.ways ?? 2;
      const sel = h('select', { 'aria-label': 'Number of paths', onchange: (e) => {
        const n = +e.target.value;
        this.store.change('topology', (d) => {
          d.nodes[this.id].config = { ways: n };
          for (const [eid, ed] of Object.entries(d.edges)) {
            if (node.type === 'splitter' && ed.from[0] === this.id && ed.from[1] >= n) delete d.edges[eid];
            if (node.type === 'mixer' && ed.to[0] === this.id && ed.to[1] >= n) delete d.edges[eid];
          }
          const p = d.nodes[this.id].params;
          for (let i = 0; i < n; i++) { p[`level${i}`] ??= 0; p[`pan${i}`] ??= 0; }
        });
      } }, [2, 3, 4].map((n) => h('option', { value: n, selected: n === ways }, `${n} paths`)));
      side.push(h('label', { class: 'field' }, h('span', {}, 'Paths'), sel));
    }

    const specs = paramsOf(node);
    const list = h('div', { class: 'params' });
    for (const [k, spec] of Object.entries(specs)) {
      const id = `p-${this.id}-${k}`;
      const out = h('output', { for: id, 'data-out': k }, formatValue(spec, node.params[k]));
      let input;
      if (spec.options) {
        input = h('select', { id, 'data-param': k, onchange: (e) => this.store.setParam(this.id, k, +e.target.value) },
          spec.options.map((o, i) => h('option', { value: spec.min + i * (spec.step || 1), selected: Math.round(node.params[k]) === spec.min + i }, o)));
      } else {
        input = h('input', {
          id, type: 'range', min: 0, max: 1000, step: spec.step ? 1000 / ((spec.max - spec.min) / spec.step) : 1,
          value: String(toNorm(spec, node.params[k]) * 1000), 'data-param': k,
          'aria-valuetext': formatValue(spec, node.params[k]),
          oninput: (e) => { const v = fromNorm(spec, +e.target.value / 1000); e.target.setAttribute('aria-valuetext', formatValue(spec, v)); this.store.setParam(this.id, k, v); },
          ondblclick: () => this.store.setParam(this.id, k, spec.def),
        });
      }
      list.append(h('div', { class: 'param' }, h('label', { for: id }, spec.label), input, out));
    }
    this.readout = h('p', { class: 'insp-readout', 'aria-live': 'off' });
    side.push(this.readout);

    if (eng?.stats) {
      side.push(h('p', { class: 'insp-note insp-cpu', title: eng.stats.precise ? '' : 'Averaged from 1 ms clock ticks' }, `Worklet ${(eng.stats.cpuUs / 1000).toFixed(3)} ms per ${Math.round(eng.stats.budgetUs / 1000 * 48)}-frame quantum (${((100 * eng.stats.cpuUs) / eng.stats.budgetUs).toFixed(1)}%)`));
    }
    kids.push(h('div', { class: 'insp' }, h('div', { class: 'insp-side' }, side), list));
    this.el.replaceChildren(...kids);
    this.tick();
  }

  /** Live readout for the selected device, 10 Hz: numbers carry what colour and motion show. */
  tick() {
    const node = this.id && this.store.doc.nodes[this.id];
    if (!node || !this.readout || !this.motion) return;
    const m = this.motion.node(this.id);
    const en = this.engine?.nodes?.get(this.id);
    const db = (x) => (x > 1e-5 ? (20 * Math.log10(x)).toFixed(1) : '−∞');
    const lv = this.engine?.ctx?.state === 'running' ? this.engine.level(this.id, 0) : { rms: 0, peak: 0 };
    const parts = [`OUT <b>${db(lv.rms)}</b> dB`];
    if (node.type === 'compressor' || node.type === 'limiter') parts.push(`<span class="gr">GR <b>${m.gr.toFixed(1)}</b> dB</span>`);
    if (node.type === 'envfilter' && en?.stats?.cutoff) parts.push(`fc <b>${Math.round(en.stats.cutoff)}</b> Hz`);
    if (m.clip > 0.5) parts.push('<span class="gr"><b>CLIP</b></span>');
    const html = parts.join(' · ');
    if (this.readout.innerHTML !== html) this.readout.innerHTML = html;
  }

  _empty() {
    return h('div', { class: 'insp-empty' },
      h('h2', {}, 'Select a device to edit it'),
      h('p', {}, 'Wire from a jack on the right to one on the left. Double-click empty space to add a device. Drop a .nam on a head, a .wav IR on a cab, or a preset .json anywhere.'),
      h('p', {}, h('kbd', {}, 'Tab'), ' select · ', h('kbd', {}, 'B'), ' bypass · ', h('kbd', {}, 'Del'), ' remove · ', h('kbd', {}, '⌘Z'), ' undo · ', h('kbd', {}, 'F'), ' fit'),
    );
  }

  _modelPanel(node, eng) {
    const models = this.library.list();
    const cur = node.model;
    const sel = h('select', { 'aria-label': 'Model', onchange: (e) => {
      const m = this.library.info(e.target.value);
      if (m) this.store.setModel(this.id, m.hash, { name: m.name, file: m.file, family: m.family, arch: m.arch, bytes: m.bytes });
    } },
    h('option', { value: '', disabled: true, selected: !cur }, 'Choose a model…'),
    h('optgroup', { label: 'Bundled' }, this.library.models.map((m) => h('option', { value: m.hash, selected: m.hash === cur }, `${m.name} (${m.family})`))),
    this.library.user.size ? h('optgroup', { label: 'Your models' }, [...this.library.user.values()].map((m) => h('option', { value: m.hash, selected: m.hash === cur }, `${m.name} (${m.family})`))) : null,
    cur && !this.library.info(cur) ? h('option', { value: cur, selected: true }, `missing: ${cur.slice(7, 19)}…`) : null);
    const info = cur ? this.library.info(cur) || this.store.doc.models[cur] : null;
    const status = eng?.status === 'error' ? `Load failed: ${eng.error}` : eng?.status === 'missing' ? 'This preset references a model that is not in your library. Drop the .nam file on the head.' : eng?.status === 'loading' ? 'Loading…' : eng?.loadInfo ? `Loaded in ${eng.loadInfo.ms} ms${eng.loadInfo.loudness != null ? ` · loudness ${eng.loadInfo.loudness.toFixed(1)} dB` : ''}` : '';
    return h('div', { class: 'panel' },
      h('label', { class: 'field' }, h('span', {}, 'Model'), sel),
      h('button', { onclick: () => this.onPickModel?.(this.id) }, 'Load .nam file…'),
      info ? h('p', { class: 'insp-note' }, `${info.arch || ''}${info.licence ? ` · ${info.licence}` : ''}`) : null,
      info?.source ? h('p', { class: 'insp-note' }, info.source) : null,
      status ? h('p', { class: 'insp-note', role: 'status' }, status) : null,
    );
  }

  _irPanel(node, eng) {
    return h('div', { class: 'panel' },
      h('p', { class: 'insp-note' }, node.ir ? `Impulse response: ${this.store.doc.irs[node.ir]?.name || 'custom'}` : 'Synthetic cab IR (generated in the browser; voice and mic reshape it).'),
      h('div', { class: 'insp-actions' },
        h('button', { onclick: () => this.onPickIr?.(this.id) }, 'Load IR .wav…'),
        node.ir ? h('button', { onclick: () => this.store.setIr(this.id, null) }, 'Use synthetic') : null),
    );
  }
}

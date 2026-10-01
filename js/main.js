// Boot: library -> document -> audio engine -> canvas -> chrome.
import { Store, validateDoc, canonicalJSON } from './graph/doc.js';
import { demoDoc } from './graph/demo-public.js';
import { upgradePublicDemo } from './graph/demo-public.js';
import { QUICK_SOUNDS, quickSoundDoc } from './graph/quick-sounds.js';
import { TYPES } from './graph/types.js';
import { Library } from './audio/library.js';
import { Engine } from './audio/engine.js';
import { GraphCanvas } from './ui/canvas.js';
import { Inspector } from './ui/inspector.js';
import { loadSkin } from './ui/skins.js';
import { preferredTheme } from './ui/theme.js';
import { mountTransport } from './ui/transport.js';
import { prepareVisuals, mountChrome } from './ui/chrome.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const AUTOSAVE = 'squatch-rig:autosave';
const safeStorage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

// A skin is design/skin.<name>.json, so the name goes into a URL: word characters only.
const skinName = (v) => String(v || '').replace(/[^\w-]/g, '') || 'brush-ink';

async function main() {
  const library = await new Library().init();
  let doc = null;
  if (!params.has('demo')) { try { doc = JSON.parse(safeStorage.get(AUTOSAVE) || 'null'); if (doc) { validateDoc(doc); upgradePublicDemo(doc); } } catch { doc = null; } }
  const freshDemo = !doc;
  if (!doc) doc = demoDoc(library.models);
  const store = new Store(doc);
  window.rig = { store, library }; // for the console and the headless checks

  const engine = new Engine(library);
  window.rig.engine = engine;
  try { engine.ensureContext({ sampleRate: 48000 }); } catch (e) { console.error(e); }
  // Transport (play/stop, loop, gains, A/B, record). Mounted before the engine
  // finishes loading so the first click is honoured.
  window.rig.transport = mountTransport({ el: $('#transport'), engine, creditEl: $('#credit'), toast, presetName: () => store.doc.name });

  const want = params.get('theme');
  let themeName = want === 'dark' || want === 'light' ? want : preferredTheme();
  document.documentElement.dataset.theme = themeName;

  // brush-ink is the default skin; ?skin=ink is the older built-in line art. The
  // Skin picker's choice is remembered, but a ?skin= in the URL always wins.
  const [skin, settle] = await Promise.all([loadSkin(skinName(params.get('skin') || safeStorage.get('squatch-rig:skin') || 'brush-ink')), prepareVisuals()]);
  const canvas = new GraphCanvas({ host: $('#stage'), store, engine, library, skin, themeName, settle });
  await canvas.init(params.get('renderer') === 'webgpu' ? 'webgpu' : 'webgl');
  window.rig.canvas = canvas;
  const skinPick = $('#skin-pick');
  const showSkin = (name) => {
    if (![...skinPick.options].some((o) => o.value === name)) skinPick.append(new Option(name, name)); // ?skin=<a design skin>
    skinPick.value = name;
  };
  // A skin other than the default names itself in the tab, so ?skin=ink reads "squatch-rig - ink skin".
  const describeSkin = (name) => {
    document.title = name === 'brush-ink' ? 'squatch-rig' : `squatch-rig - ${name} skin`;
    $('#renderer').textContent = `${canvas.rendererName}${name === 'ink' ? '' : ` · skin ${name}`}`;
  };
  showSkin(skin.name);
  describeSkin(skin.name);

  const inspector = new Inspector({
    el: $('#inspector'), store, engine, library,
    onPickModel: (id) => pickFile('.nam', async (f) => setModelFromFile(id, f)),
    onPickIr: (id) => pickFile('.wav,audio/wav', async (f) => setIrFromFile(id, f)),
  });
  canvas.addEventListener('select', (e) => inspector.show(e.detail?.kind === 'node' ? e.detail.id : null));
  canvas.addEventListener('toast', (e) => toast(e.detail));
  store.addEventListener('blocked', (e) => toast(e.detail));
  inspector.show(null);
  mountChrome({ canvas, inspector, params });

  // ---- audio
  try {
    await engine.init({ sampleRate: 48000 });
    engine.sync(store.doc);
  } catch (e) {
    console.error(e);
    toast('Audio failed to start: ' + e.message, 8000);
  }
  store.addEventListener('change', (e) => {
    $('#sound-pick').value = ''; // a user edit or undo is now their own rig
    if (e.detail.kind !== 'layout' && engine.ctx) engine.sync(store.doc);
    clearTimeout(main.saveT);
    main.saveT = setTimeout(() => safeStorage.set(AUTOSAVE, JSON.stringify(store.doc)), 400);
    $('#preset-name').value = store.doc.name;
    $('#restore-output').hidden = Object.values(store.doc.nodes).some((n) => n.type === 'output');
  });
  $('#restore-output').hidden = Object.values(store.doc.nodes).some((n) => n.type === 'output');
  $('#restore-output').addEventListener('click', () => {
    const id = store.restoreOutput();
    canvas.select({ kind: 'node', id });
    canvas.fit();
    toast('Output restored and wired to the end of the rig.');
  });
  // ---- devices
  async function listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind) => {
      const cur = sel.value;
      sel.replaceChildren(new Option('System default', ''), ...devs.filter((d) => d.kind === kind).map((d) => new Option(d.label || `${kind} ${d.deviceId.slice(0, 6)}`, d.deviceId)));
      sel.value = cur;
    };
    fill($('#in-dev'), 'audioinput');
    fill($('#out-dev'), 'audiooutput');
  }
  $('#in-dev').addEventListener('change', (e) => engine.setInputDevice(e.target.value));
  $('#out-dev').addEventListener('change', (e) => engine.setOutputDevice(e.target.value).catch((err) => toast(err.message)));
  engine.addEventListener('devices', listDevices);
  navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
  listDevices();
  $('#source').addEventListener('change', (e) => {
    const input = Object.entries(store.doc.nodes).find(([, n]) => n.type === 'input');
    if (input) store.setParam(input[0], 'source', +e.target.value);
    if (+e.target.value === 1) engine.resume();
  });

  // ---- presets
  const soundPick = $('#sound-pick');
  soundPick.replaceChildren(new Option('Custom rig', ''), ...QUICK_SOUNDS.map((sound) => new Option(sound.label, sound.id)));
  soundPick.value = freshDemo ? 'stack' : '';
  soundPick.addEventListener('change', () => {
    if (!soundPick.value) return;
    const sound = soundPick.value;
    store.load(quickSoundDoc(library.models, sound));
    soundPick.value = sound;
    canvas.fit();
    toast(`Loaded ${QUICK_SOUNDS.find((item) => item.id === sound).label}.`);
  });
  $('#preset-name').value = store.doc.name;
  $('#preset-name').addEventListener('change', (e) => store.change('meta', (d) => { d.name = e.target.value || 'Untitled rig'; }));
  $('#save').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(store.doc, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${store.doc.name.replace(/[^\w.-]+/g, '_')}.rig.json` });
    a.click(); URL.revokeObjectURL(a.href);
  });
  $('#load').addEventListener('click', () => pickFile('.json,application/json', loadPresetFile));
  $('#demo').addEventListener('click', () => { store.load(demoDoc(library.models)); soundPick.value = 'stack'; canvas.fit(); });
  $('#undo').addEventListener('click', () => store.undo());
  $('#redo').addEventListener('click', () => store.redo());
  $('#fit').addEventListener('click', () => canvas.fit());
  // ---- theme and skin (the ◐ button and the two picks say the same thing)
  const setTheme = (name) => {
    themeName = name === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = themeName;
    safeStorage.set('squatch-rig:theme', themeName);
    canvas.setTheme(themeName);
    $('#theme-pick').value = themeName;
  };
  $('#theme-pick').value = themeName;
  $('#theme-pick').addEventListener('change', (e) => setTheme(e.target.value));
  $('#theme').addEventListener('click', () => setTheme(themeName === 'dark' ? 'light' : 'dark'));
  skinPick.addEventListener('change', async (e) => {
    const sel = e.target, want = skinName(sel.value);
    sel.disabled = true; // the art is rasterised per theme, so this takes a moment
    try {
      const next = await loadSkin(want);
      canvas.setSkin(next);
      safeStorage.set('squatch-rig:skin', want);
      showSkin(next.name);
      describeSkin(next.name);
    } catch (err) { toast(`Could not load the ${want} skin: ${err.message}`, 6000); }
    finally { sel.disabled = false; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); }
  });

  // ---- add menu
  const menu = $('#add-menu');
  const addable = ['gate', 'compressor', 'overdrive', 'bloom', 'envfilter', 'reverb', 'limiter', 'nam', 'cab', 'splitter', 'mixer', 'input', 'output'];
  // the Pedal picker in the top strip: every effect type the registry knows, the
  // ones the DSP worklets run, each under its own label
  const pedals = Object.keys(TYPES).filter((t) => TYPES[t].worklet);
  let addPos = null;
  /** Add a device at a world point, snapped to the grid, and select it. */
  const addDevice = (type, pos) => {
    const id = store.addNode(type, [Math.round(pos.x / 10) * 10, Math.round(pos.y / 10) * 10], type === 'splitter' || type === 'mixer' ? { config: { ways: 2 } } : {});
    canvas.select({ kind: 'node', id });
    return id;
  };
  const addPoint = () => addPos || canvas.toWorld(canvas.app.screen.width / 2, canvas.app.screen.height / 2);
  menu.replaceChildren(...addable.map((t) => Object.assign(document.createElement('button'), {
    textContent: TYPES[t].label, role: 'menuitem',
    onclick: () => { addDevice(t, addPoint()); menu.hidden = true; addPos = null; },
  })));
  const pedalPick = $('#pedal-pick');
  pedalPick.replaceChildren(new Option('Add a pedal…', ''), ...pedals.map((t) => new Option(TYPES[t].label, t)));
  pedalPick.addEventListener('change', (e) => {
    const type = e.target.value;
    e.target.value = ''; // it adds a pedal, it is not a mode
    if (type) addDevice(type, addPoint());
  });
  $('#add').addEventListener('click', (e) => { const r = e.target.getBoundingClientRect(); addPos = null; openMenu(r.left, r.bottom + 4); });
  canvas.addEventListener('add-at', (e) => { addPos = e.detail.world; openMenu(e.detail.client.x, e.detail.client.y); });
  function openMenu(x, y) {
    menu.style.left = `${Math.min(x, innerWidth - 180)}px`; menu.style.top = `${Math.min(y, innerHeight - 380)}px`;
    menu.hidden = false; menu.querySelector('button').focus();
  }
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'add') menu.hidden = true; });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });

  // ---- files
  function pickFile(accept, cb) {
    const i = Object.assign(document.createElement('input'), { type: 'file', accept });
    i.onchange = () => i.files[0] && cb(i.files[0]).catch((e) => toast(e.message));
    i.click();
  }
  async function setModelFromFile(id, f) {
    const info = await library.addModelFile(f);
    store.setModel(id, info.hash, { name: info.name, family: info.family, arch: info.arch, bytes: info.bytes });
    toast(`Loaded ${info.name} (${info.arch})`);
  }
  async function setIrFromFile(id, f) {
    const ir = await library.addIrFile(f);
    store.setIr(id, ir.hash, { name: ir.name });
  }
  async function loadPresetFile(f) {
    const d = validateDoc(JSON.parse(await f.text()));
    store.load(d); canvas.fit();
    const missing = Object.keys(d.models).filter((h) => !library.info(h));
    if (missing.length) toast(`${missing.length} model(s) in this preset are not in your library yet; drop the .nam files on the heads.`, 6000);
  }
  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
  stage.addEventListener('drop', async (e) => {
    e.preventDefault(); stage.classList.remove('drop');
    for (const f of e.dataTransfer.files) {
      const at = canvas.nodeAt(e.clientX, e.clientY);
      const name = f.name.toLowerCase();
      try {
        if (name.endsWith('.nam')) {
          const id = at.node?.type === 'nam' ? at.id : store.addNode('nam', [at.world.x, at.world.y], { label: f.name.replace(/\.nam$/i, '').slice(0, 22) });
          await setModelFromFile(id, f);
        } else if (name.endsWith('.wav')) {
          const id = at.node?.type === 'cab' ? at.id : store.addNode('cab', [at.world.x, at.world.y]);
          await setIrFromFile(id, f);
        } else if (name.endsWith('.json')) await loadPresetFile(f);
        else toast(`Don't know what to do with ${f.name}`);
      } catch (err) { toast(err.message, 6000); }
    }
  });

  // ---- status bar
  const fmtMs = (s) => (s == null ? '?' : `${(s * 1000).toFixed(1)} ms`);
  setInterval(() => {
    if (!engine.ctx) return;
    const cpu = engine.cpu(), lat = engine.latency();
    $('#dsp').textContent = `${(cpu.fraction * 100).toFixed(1)}%`;
    $('#dsp').title = `Sum of AudioWorklet render time per quantum (${cpu.us.toFixed(0)} µs of ${cpu.budget.toFixed(0)} µs)${cpu.precise ? '' : '; averaged from 1 ms clock ticks'}. Native nodes (convolver, gains, panners) are not included.`;
    $('#cap').textContent = cpu.capacity ? `${(cpu.capacity.average * 100).toFixed(0)}% avg · ${(cpu.capacity.peak * 100).toFixed(0)}% peak` : 'n/a';
    $('#lat').textContent = `${fmtMs(lat.roundTrip)}${lat.inputKnown ? '' : ' + input'}`;
    $('#lat').title = `input ${lat.inputKnown ? fmtMs(lat.input) : 'unknown (not reported until the interface is live)'} · base ${fmtMs(lat.base)} · output ${fmtMs(lat.output)} · one render quantum ${fmtMs(lat.quantum)} · algorithmic ${fmtMs(lat.algorithmic)} (oversampling filters, limiter look-ahead)`;
    $('#sr').textContent = `${engine.ctx.sampleRate / 1000} kHz`;
    const m = engine.master || { rms: 0, peak: 0 };
    const db = (x) => 20 * Math.log10(Math.max(x, 1e-6));
    $('#meter-fill').style.width = `${Math.max(0, Math.min(100, (db(m.rms) + 60) / 60 * 100))}%`;
    $('#meter-peak').style.left = `${Math.max(0, Math.min(100, (db(m.peak) + 60) / 60 * 100))}%`;
    $('#meter-db').textContent = m.peak > 1e-5 ? `${db(m.peak).toFixed(1)} dBFS pk` : '−∞';
    window.rig.status = { cpu, lat, master: m };
  }, 250);

  window.rig.canonical = () => canonicalJSON(store.doc);
  document.body.dataset.ready = '1';
}

main().catch((e) => { console.error(e); toast('Failed to start: ' + e.message, 10000); });

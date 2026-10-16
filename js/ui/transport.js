// Transport: play/stop, DI loop picker, input gain, master level + meter,
// A/B (whole rig vs dry DI), record to WAV. Deliberately plain DOM with `tp-`
// classes (css/transport.css) so a skin can restyle it without touching this.
//
// Play works on the first click in Chrome and Safari: the click handler
// creates/resumes the AudioContext synchronously, before any await, which is
// what WebKit's autoplay policy requires. If the engine is still loading, the
// click is remembered and the loop starts from the top once the heads load.
import { dismissFirstPlay, firstPlayDismissed } from './first-play-storage.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.filter((k) => k != null));
  return el;
};
const fmtDb = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`;
const dbOf = (x) => 20 * Math.log10(Math.max(x, 1e-6));
const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

export function mountTransport({ el, engine, creditEl = null, guideEl = document.querySelector('#first-play'), toast = () => {}, presetName = () => 'rig', onHear = () => {} }) {
  let wantPlay = false;

  const play = h('button', { class: 'tp-play primary', 'aria-pressed': 'false', title: 'Play / stop (Space)' }, 'Play');
  const loopSel = h('select', { class: 'tp-loop', 'aria-label': 'DI loop' });
  const localDi = h('button', { class: 'tp-local', title: 'Open a DI WAV from this computer' }, 'My DI…');
  const localFile = h('input', { type: 'file', accept: '.wav,audio/wav', hidden: true, 'aria-label': 'Choose a local DI WAV' });
  const inGain = h('input', { type: 'range', min: -24, max: 24, step: 0.5, value: 0, 'aria-label': 'Input gain', class: 'tp-range' });
  const inOut = h('output', { class: 'tp-val' }, fmtDb(0));
  const master = h('input', { type: 'range', min: -60, max: 6, step: 0.5, value: 0, 'aria-label': 'Master level', class: 'tp-range' });
  const masterOut = h('output', { class: 'tp-val' }, fmtDb(0));
  const fill = h('span', { class: 'tp-meter-fill' }), peak = h('span', { class: 'tp-meter-peak' }), clip = h('span', { class: 'tp-clip', title: 'Clip (0 dBFS reached in the last second)' });
  const meter = h('span', { class: 'tp-meter', role: 'meter', 'aria-label': 'Output level', 'aria-valuemin': -60, 'aria-valuemax': 0, 'aria-valuenow': -60 }, fill, peak);
  const ab = h('button', { class: 'tp-ab', 'aria-pressed': 'false', title: 'A/B: hear the dry DI instead of the rig (level-matched)' }, 'A/B · Rig');
  const rec = h('button', { class: 'tp-rec', 'aria-pressed': 'false', title: 'Record the output to a WAV file' }, h('span', { class: 'tp-rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'tp-rec-label' }, 'Rec'));
  const guideDismissed = firstPlayDismissed();
  const loopButtons = h('div', { class: 'first-play-loops', role: 'group', 'aria-label': 'Choose a guitar loop' });
  let guideOpen = !!guideEl && !guideDismissed;
  let guidedStarted = false;
  if (guideOpen) {
    const dismiss = h('button', { class: 'first-play-dismiss', 'aria-label': 'Dismiss first-play guide permanently', title: 'Dismiss this guide' }, '×');
    guideEl.replaceChildren(
      h('div', { class: 'first-play-copy' },
        h('strong', {}, 'Hear the rig'),
        h('span', {}, 'Start a guitar loop, then compare the processed sound with level-matched dry DI.'),
      ),
      h('div', { class: 'first-play-actions' }, play, ab, loopButtons),
      dismiss,
    );
    guideEl.hidden = false;
    document.body.classList.add('first-play-open');
    dismiss.addEventListener('click', () => {
      dismissFirstPlay(); // guide still closes for this visit if storage is blocked
      guideOpen = false;
      guideEl.hidden = true; document.body.classList.remove('first-play-open');
      el.prepend(play); el.append(ab);
      play.removeAttribute('aria-label');
      setPlayUi();
    });
    play.textContent = 'Hear it';
    play.setAttribute('aria-label', 'Hear it: start the processed guitar loop');
    play.addEventListener('click', () => {
      if (!guideOpen) return;
      if (running()) { play.setAttribute('aria-label', 'Stop listening'); return; }
      if (!guidedStarted) {
        guidedStarted = true;
        onHear();
        if (loopSel.value !== 'chord-stabs') { loopSel.value = 'chord-stabs'; loopSel.dispatchEvent(new Event('change')); }
      }
    }, { capture: true });
  } else {
    el.replaceChildren(play, ab);
  }
  el.append(
    h('label', { class: 'tp-field' }, h('span', {}, 'Loop'), loopSel),
    localDi, localFile,
    h('label', { class: 'tp-field' }, h('span', {}, 'In'), inGain, inOut),
    h('label', { class: 'tp-field' }, h('span', {}, 'Master'), master, masterOut),
    meter, clip, ...(guideOpen ? [] : [ab]), rec,
  );
  el.classList.add('tp');

  const running = () => engine.ctx?.state === 'running';
  const setPlayUi = () => {
    const on = running() || (wantPlay && !engine.ready);
    play.textContent = guideOpen ? (wantPlay && !engine.ready ? 'Loading…' : on ? 'Stop' : 'Hear it') : (wantPlay && !engine.ready ? 'Loading…' : on ? 'Stop' : 'Play');
    play.setAttribute('aria-pressed', String(on));
    if (guideOpen) play.setAttribute('aria-label', on ? 'Stop listening' : 'Hear it: start the processed guitar loop');
  };

  async function start() {
    wantPlay = true; engine.playRequested = true;
    try {
      const ctx = engine.ensureContext();
      const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume(); // inside the gesture
      setPlayUi();
      await resumed;
      if (!engine.ready) await new Promise((resolve, reject) => {
        if (engine.initError) { reject(engine.initError); return; }
        engine.addEventListener('ready', resolve, { once: true });
        engine.addEventListener('init-error', (e) => reject(e.detail), { once: true });
      });
      if (!engine.playRequested) return;
      if (engine.ctx.state !== 'running') await engine.ctx.resume();
      await engine.synced;
      await engine.whenModelsLoaded().catch(() => {});
      if (!engine.playRequested) return;
      engine.restartLoop(); // from the top, through the loaded heads
    } catch (e) { engine.playRequested = false; toast('Audio could not start: ' + e.message, 6000); }
    wantPlay = false;
    setPlayUi();
  }
  async function stop() {
    wantPlay = false; engine.playRequested = false;
    if (engine.recording) await finishRecording();
    await engine.suspend();
    setPlayUi();
  }
  // Use the last rendered Play/Stop state for intent. A fresh WebKit user
  // gesture can resume AudioContext before this listener runs; checking only
  // ctx.state there mistakes the requested Play for a Stop.
  const shouldStop = () => play.getAttribute('aria-pressed') === 'true' || wantPlay;
  play.addEventListener('click', () => (shouldStop() ? stop() : start()));
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || e.target.closest?.('input, select, textarea, button, [contenteditable]')) return;
    e.preventDefault();
    if (shouldStop()) stop(); else start();
  });

  // ---- loops + credits
  const renderCredit = () => {
    if (!creditEl) return;
    const l = engine.loops.find((x) => x.id === engine.loopId);
    const nam = ' NAM Core © Steven Atkinson, MIT.';
    if (!l) { creditEl.textContent = nam.trim(); return; }
    if (l.local) {
      creditEl.textContent = `Your DI “${l.title}” stays in this browser session.${nam}`;
      return;
    }
    creditEl.replaceChildren(
      `DI loop “${l.title}”: ${l.credit}, `,
      h('a', { href: l.url, target: '_blank', rel: 'noopener' }, 'source'), ', ',
      h('a', { href: l.licenceUrl, target: '_blank', rel: 'noopener' }, l.licence),
      `; ${l.modified}.${nam}`,
    );
    creditEl.title = engine.loops.map((x) => `${x.title}: ${x.credit} (${x.licence}), ${x.source}`).join('\n');
  };
  const fillLoops = () => {
    loopSel.replaceChildren(...engine.loops.map((l) => h('option', { value: l.id }, `${l.title} — ${l.kind}`)));
    loopSel.value = engine.loopId || '';
    loopSel.disabled = !engine.loops.length;
    renderCredit();
    if (guideOpen) {
      loopButtons.replaceChildren(...engine.loops.filter((l) => !l.local).map((l) => {
        const b = h('button', { type: 'button', 'aria-pressed': String(l.id === engine.loopId), 'data-loop': l.id }, l.title);
        b.addEventListener('click', () => { loopSel.value = l.id; loopSel.dispatchEvent(new Event('change')); });
        return b;
      }));
    }
  };
  loopSel.addEventListener('change', () => engine.setLoop(loopSel.value).then(() => {
    renderCredit();
    for (const b of loopButtons.children) b.setAttribute('aria-pressed', String(b.dataset.loop === engine.loopId));
  }).catch((e) => toast(e.message)));
  localDi.addEventListener('click', () => localFile.click());
  localFile.addEventListener('change', async () => {
    const file = localFile.files?.[0];
    if (!file) return;
    try { await engine.setLocalDi(file); fillLoops(); toast(`Loaded your DI: ${file.name}`); }
    catch (e) { toast(e.message, 6000); }
    localFile.value = '';
  });
  engine.addEventListener('ready', fillLoops);
  if (engine.ready) fillLoops();

  // ---- gains, A/B
  inGain.addEventListener('input', () => { const v = +inGain.value; inOut.textContent = fmtDb(v); engine.setInputGain(v); });
  inGain.addEventListener('dblclick', () => { inGain.value = 0; inGain.dispatchEvent(new Event('input')); });
  master.addEventListener('input', () => { const v = +master.value; masterOut.textContent = fmtDb(v); engine.setMasterLevel(v); });
  master.addEventListener('dblclick', () => { master.value = 0; master.dispatchEvent(new Event('input')); });
  ab.addEventListener('click', () => {
    engine.setBypass(!engine.bypassed);
    syncAbUi();
  });
  function syncAbUi() {
    ab.setAttribute('aria-pressed', String(engine.bypassed));
    ab.textContent = engine.bypassed ? 'A/B · Dry DI' : 'A/B · Rig';
    ab.title = engine.bypassed ? 'Return to the processed rig' : 'A/B: compare level-matched dry DI';
  }
  engine.addEventListener('transport', syncAbUi);

  // ---- record
  async function finishRecording() {
    const secs = engine.recordedSeconds;
    const blob = await engine.stopRecording();
    rec.setAttribute('aria-pressed', 'false');
    rec.querySelector('.tp-rec-label').textContent = 'Rec';
    if (!blob || secs < 0.05) return;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const a = h('a', { href: URL.createObjectURL(blob), download: `${presetName().replace(/[^\w.-]+/g, '_')}-${stamp}.wav` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Recorded ${secs.toFixed(1)} s (24-bit WAV, ${(blob.size / 1e6).toFixed(1)} MB)`);
  }
  rec.addEventListener('click', async () => {
    if (engine.recording) { await finishRecording(); return; }
    if (!running()) await start();
    engine.startRecording();
    rec.setAttribute('aria-pressed', 'true');
  });
  engine.addEventListener('record-limit', () => { finishRecording(); toast('Recording stopped at the 10 minute limit'); });

  // ---- meter (driven by the engine's ~60 Hz meters event)
  engine.addEventListener('meters', (e) => {
    const m = e.detail.master;
    fill.style.width = `${pct(dbOf(m.rms))}%`;
    peak.style.left = `${pct(m.peakDb)}%`;
    meter.setAttribute('aria-valuenow', Math.round(Math.max(-60, m.peakDb)));
    clip.classList.toggle('on', m.clipHold);
    if (engine.recording) rec.querySelector('.tp-rec-label').textContent = fmtTime(engine.recordedSeconds);
  });
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  engine.addEventListener('transport', setPlayUi);
  let interruptionShown = false;
  const onState = () => {
    setPlayUi();
    if (running()) { interruptionShown = false; return; }
    if (engine.playRequested && engine.ready && !document.hidden && !interruptionShown) {
      interruptionShown = true;
      toast('Audio was paused by the browser or device. Press Play to resume.', 7000);
    }
  };
  const watchState = () => engine.ctx?.addEventListener('statechange', onState);
  if (engine.ctx) watchState(); else engine.addEventListener('ready', watchState, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onState(); });
  setPlayUi();
  return { start, stop, el };
}

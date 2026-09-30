// Visual chrome around the canvas: fonts and settle keyframes before the first
// frame, the brand intro, the Motion setting, the phone menu, the chain strip,
// and the inspector's 10 Hz readout. main.js calls prepareVisuals() before the
// canvas exists and mountChrome() once it does.
import { Settle } from './settle.js';
import { motionReduced } from './theme.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};

// The Motion preference and the intro start as soon as this module is evaluated
// (before main.js awaits the library, the engine or the skin), so the ink wash
// covers the page from its first frames instead of following a flash of it.
{
  const saved = store.get('squatch-rig:motion');
  if (saved === 'full' || saved === 'reduced') document.documentElement.dataset.motion = saved;
}
const intro = playIntro(new URLSearchParams(location.search));

/** Fonts (Pixi rasterises text once, so the faces must be ready) and the settle trajectories. */
export async function prepareVisuals() {
  const fonts = Promise.all(['500 12px Inter', '600 12px Inter', 'italic 500 14px Lora'].map((f) => document.fonts?.load(f))).catch(() => {});
  const timeout = new Promise((r) => setTimeout(r, 1500));
  const settle = new Settle(new URL('../../design/', import.meta.url));
  await Promise.all([Promise.race([fonts, timeout]), settle.load()]);
  return settle;
}

const MOTION = [
  { mode: 'auto', icon: '〰', label: 'Motion: follow system' },
  { mode: 'reduced', icon: '—', label: 'Motion: reduced (state updates in steps, nothing flows)' },
  { mode: 'full', icon: '∿', label: 'Motion: full' },
];

export function mountChrome({ canvas, inspector, onIntroDone }) {
  // ---- Motion setting: the app setting wins over the OS in both directions
  const mb = $('#motion');
  const showMotion = () => {
    const cur = document.documentElement.dataset.motion || 'auto';
    const m = MOTION.find((x) => x.mode === cur) || MOTION[0];
    mb.textContent = m.icon; mb.title = m.label; mb.setAttribute('aria-label', m.label);
    mb.setAttribute('aria-pressed', String(cur !== 'auto'));
  };
  mb?.addEventListener('click', () => {
    const cur = document.documentElement.dataset.motion || 'auto';
    const next = MOTION[(MOTION.findIndex((x) => x.mode === cur) + 1) % MOTION.length].mode;
    if (next === 'auto') delete document.documentElement.dataset.motion; else document.documentElement.dataset.motion = next;
    store.set('squatch-rig:motion', next);
    showMotion(); canvas.markDirty();
  });
  if (mb) showMotion();

  // ---- phone: everything but Play behind "More"
  const bar = $('.bar'), more = $('#more');
  more?.addEventListener('click', () => {
    const open = !bar.classList.contains('open');
    bar.classList.toggle('open', open);
    more.setAttribute('aria-expanded', String(open));
  });

  // ---- chain strip: a real range input that pans a chain wider than the screen
  const strip = $('#chain-strip'), range = strip?.querySelector('input');
  const syncStrip = (v) => {
    if (!strip) return;
    strip.classList.toggle('on', v.visible < 0.97 && innerWidth <= 640);
    if (document.activeElement !== range) range.value = String(Math.round(v.pos * 1000));
  };
  canvas.addEventListener('view', (e) => syncStrip(e.detail));
  range?.addEventListener('input', () => canvas.scrollChain(+range.value / 1000));
  syncStrip(canvas.chainView());

  // ---- inspector: live readout at 10 Hz
  inspector.motion = canvas.motion;
  setInterval(() => inspector.tick(), 100);

  // ---- the stage changes size when the inspector opens or the phone menu does
  let autoFit = true;
  canvas.app.canvas.addEventListener('wheel', () => { autoFit = false; }, { passive: true });
  canvas.app.canvas.addEventListener('pointerdown', () => { canvas._userPan = true; });
  canvas.addEventListener('view', () => { if (canvas.drag?.kind === 'pan') autoFit = false; });
  $('#fit')?.addEventListener('click', () => { autoFit = true; });
  new ResizeObserver(() => {
    canvas.app.resize();
    if (autoFit) canvas.fit();
  }).observe(canvas.host);

  intro.then(() => { canvas.settleAll(); onIntroDone?.(); });
}

/**
 * The brand intro: an ink wash blooms on the paper, the Squatch mark resists it
 * (paper showing through the ink), the wordmark is brushed in, and the page
 * opens. About 1.8 s, once per session, skippable by any key, click or the
 * Skip button, and never shown under reduced motion. ?intro=0 skips, ?intro=1 forces.
 */
function playIntro(params) {
  const force = params.get('intro') === '1', off = params.get('intro') === '0';
  if (off || (!force && (motionReduced() || store.sget('squatch-rig:intro')))) return Promise.resolve();
  store.sset('squatch-rig:intro', '1');
  const el = document.createElement('div');
  el.className = 'intro';
  el.setAttribute('role', 'presentation');
  el.innerHTML = `
    <svg class="wash" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <filter id="intro-wash" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" seed="7" result="n"/>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="110" xChannelSelector="R" yChannelSelector="G" result="d"/>
          <feGaussianBlur in="d" stdDeviation="1.4"/>
        </filter>
        <filter id="intro-bleed" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="3" result="n"/>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="160" xChannelSelector="G" yChannelSelector="B" result="d"/>
          <feGaussianBlur in="d" stdDeviation="10"/>
        </filter>
      </defs>
      <g filter="url(#intro-bleed)"><circle class="halo" cx="505" cy="490" r="400" fill="var(--ink)" opacity="0.22"/></g>
      <g filter="url(#intro-wash)"><circle class="bloom" cx="500" cy="500" r="300" fill="var(--ink)"/></g>
    </svg>
    <div class="lockup"><span class="mark" aria-hidden="true"></span><span class="wordmark">squatch<i>rig</i></span></div>
    <button class="skip" type="button">Skip</button>`;
  document.body.appendChild(el);
  const [halo, bloom] = el.querySelectorAll('.halo, .bloom');
  const mark = el.querySelector('.mark'), word = el.querySelector('.wordmark');
  for (const c of [halo, bloom]) { c.style.transformBox = 'fill-box'; c.style.transformOrigin = 'center'; }
  const ease = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
  const anims = [
    bloom.animate([{ transform: 'scale(0.02)' }, { transform: 'scale(1)' }], { duration: 760, easing: ease, fill: 'both' }),
    halo.animate([{ transform: 'scale(0.05)', opacity: 0 }, { transform: 'scale(1)', opacity: 0.22 }], { duration: 1100, easing: ease, fill: 'both' }),
    mark.animate([{ clipPath: 'inset(100% 0 0 0)', opacity: 0.2 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], { duration: 420, delay: 420, easing: ease, fill: 'both' }),
    word.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 460, delay: 640, easing: 'cubic-bezier(0.5, 0, 0.3, 1)', fill: 'both' }),
  ];
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      document.removeEventListener('keydown', finish, true);
      el.classList.add('out');
      setTimeout(() => { el.remove(); }, 460);
      anims.forEach((a) => a.finish?.());
      resolve();
    };
    el.addEventListener('click', finish);
    document.addEventListener('keydown', finish, true);
    setTimeout(finish, 1750);
  });
}

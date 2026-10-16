// Which NAM engine the page loads. The standard engine (stock NAM Core, A2 fast path included) is the default and the
// only one a page load fetches unless the user asks otherwise. "Experimental" is a separate build with a speculative
// fast path; it is loaded only after the user selects it (the Engine picker, or ?engine=experimental).
export const ENGINE_KEY = 'squatch-rig:engine';
export const ENGINES = Object.freeze({ standard: 'wasm/nam.wasm', experimental: 'wasm/nam-experimental.wasm' });

const clean = (v) => (v === 'experimental' ? 'experimental' : 'standard');

/** `search`: a location.search string; `storage`: localStorage-like. Anything unrecognised is the standard engine. */
export function engineChoice({ search = '', storage = null } = {}) {
  const fromUrl = new URLSearchParams(search).get('engine');
  if (fromUrl) return clean(fromUrl);
  try { return clean(storage?.getItem(ENGINE_KEY)); } catch { return 'standard'; }
}

export const engineWasmPath = (choice) => ENGINES[clean(choice)];

export function rememberEngine(storage, choice) {
  try { if (clean(choice) === 'standard') storage.removeItem(ENGINE_KEY); else storage.setItem(ENGINE_KEY, 'experimental'); } catch { /* private mode */ }
}

/** The page's localStorage, or null where it is blocked. */
export function browserStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }

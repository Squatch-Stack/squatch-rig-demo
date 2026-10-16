const KEY = 'squatch-rig:first-play-dismissed';

export function firstPlayDismissed(storage) {
  try { return (storage ?? globalThis.localStorage).getItem(KEY) === '1'; }
  catch { return false; }
}

export function dismissFirstPlay(storage) {
  try { (storage ?? globalThis.localStorage).setItem(KEY, '1'); return true; }
  catch { return false; }
}

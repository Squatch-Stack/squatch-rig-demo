// Paper and ink texture, generated procedurally at start-up (no image assets).
// A seamless tile of periodic value noise (the tooth of the paper) plus a few
// long, faint fibres. It is one texture per theme, sampled by a TilingSprite
// behind the graph and baked once into each device body when the body is
// rasterised, so it costs nothing per frame.
import { Texture } from 'pixi.js';
import { mulberry } from './brush.js';

const SIZE = 256;

function periodicNoise(size, cell, seed) {
  // value noise on a lattice that wraps, so the tile has no seams
  const n = Math.round(size / cell), r = mulberry(seed);
  const lat = Float32Array.from({ length: n * n }, () => r());
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / cell), iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < size; x++) {
      const fx = (x / cell), ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
      const a = lat[(iy % n) * n + (ix % n)], b = lat[(iy % n) * n + ((ix + 1) % n)];
      const c = lat[((iy + 1) % n) * n + (ix % n)], d = lat[((iy + 1) % n) * n + ((ix + 1) % n)];
      out[y * size + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    }
  }
  return out;
}

const cache = {};

/** A canvas holding grain as signed deviations around mid-grey, alpha-weighted. */
export function grainCanvas(theme) {
  const key = theme.name;
  if (cache[key]) return cache[key];
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const coarse = periodicNoise(SIZE, 32, 11), mid = periodicNoise(SIZE, 8, 12), fine = periodicNoise(SIZE, 2, 13);
  const dark = theme.name === 'dark';
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = 0.15 * coarse[i] + 0.3 * mid[i] + 0.55 * fine[i] - 0.5; // about -0.5..0.5: mostly tooth, a little cloud
    // darken for tooth, lighten for fibre highlights
    const ink = v < 0 ? 0 : 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = ink;
    img.data[i * 4 + 3] = Math.round(Math.abs(v) * (dark ? 30 : 30));
  }
  ctx.putImageData(img, 0, 0);
  // fibres: long faint strokes, drawn at the wrap offsets too so the tile stays seamless
  const r = mulberry(21);
  ctx.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const x = r() * SIZE, y = r() * SIZE, a = r() * Math.PI, L = 20 + r() * 60;
    ctx.strokeStyle = dark ? `rgba(255,248,230,${0.025 + r() * 0.03})` : `rgba(90,70,40,${0.03 + r() * 0.035})`;
    ctx.lineWidth = 0.6 + r() * 0.7;
    for (const ox of [-SIZE, 0, SIZE]) for (const oy of [-SIZE, 0, SIZE]) {
      ctx.beginPath();
      ctx.moveTo(x + ox, y + oy);
      ctx.quadraticCurveTo(x + ox + Math.cos(a) * L * 0.5 + (r() - 0.5) * 6, y + oy + Math.sin(a) * L * 0.5, x + ox + Math.cos(a) * L, y + oy + Math.sin(a) * L);
      ctx.stroke();
    }
  }
  cache[key] = c;
  return c;
}

const texCache = {};
/** The paper tile for the canvas background: page colour plus grain. */
export function paperTexture(theme) {
  if (texCache[theme.name]) return texCache[theme.name];
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `#${theme.bg.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(grainCanvas(theme), 0, 0);
  const t = Texture.from(c);
  t.source.addressMode = 'repeat';
  texCache[theme.name] = t;
  return t;
}

/** Bake grain into a rasterised device body (only where the body is opaque). */
export function grainInto(ctx2d, w, h, theme, scale = 1) {
  const g = grainCanvas(theme);
  ctx2d.save();
  ctx2d.globalCompositeOperation = 'source-atop';
  ctx2d.globalAlpha = 0.8;
  const pat = ctx2d.createPattern(g, 'repeat');
  if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(scale));
  ctx2d.fillStyle = pat;
  ctx2d.fillRect(0, 0, w, h);
  ctx2d.restore();
}

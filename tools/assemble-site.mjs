#!/usr/bin/env node
// Assemble the publishable site from a checkout of the public demo repo plus the wasm that CI just built.
//
//   node tools/assemble-site.mjs --wasm nam.wasm --experimental nam-experimental.wasm --src . --out _site
//
// The standard build is the default engine; the experimental build is a separate file the page fetches only when a user
// selects it. Copies the site (not .git, .github, tools, wasm-src), places the wasm at every target manifest.json names, adds it to
// the manifest, and runs tools/public-guard.mjs on the result. Fails if the source tree already holds a .wasm
// (build outputs are never committed), if the file is not a WebAssembly module, or if the guard finds anything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanTree } from './public-guard.mjs';

const SKIP = new Set(['.git', '.github', '_site', '.work', 'node_modules', 'tools', 'wasm-src', '.gitignore', '.DS_Store']);

export function assemble({ wasm, experimental, src, out }) {
  src = path.resolve(src); out = path.resolve(out);
  if (!experimental) throw new Error('both builds are required: pass the experimental wasm too');
  const load = (file) => {
    const b = fs.readFileSync(file);
    if (b.length < 1024 || b.readUInt32LE(0) !== 0x6d736100) throw new Error(`${file} is not a WebAssembly module`);
    return b;
  };
  const bytes = load(wasm), expBytes = load(experimental);
  const walkFor = (dir, hit) => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const abs = path.join(dir, item.name); if (SKIP.has(item.name)) continue; if (item.isDirectory()) walkFor(abs, hit); else hit(abs); } };
  walkFor(src, (abs) => { if (/\.wasm$/i.test(abs)) throw new Error(`a built .wasm is committed: ${path.relative(src, abs)}`); });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const copyTree = (from, to) => {
    for (const item of fs.readdirSync(from, { withFileTypes: true })) {
      if (from === src && SKIP.has(item.name)) continue;
      const a = path.join(from, item.name), b = path.join(to, item.name);
      if (item.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copyTree(a, b); } else fs.copyFileSync(a, b);
    }
  };
  copyTree(src, out);
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const expSha256 = crypto.createHash('sha256').update(expBytes).digest('hex');
  const place = (targets, b, digest) => {
    for (const target of targets) {
      fs.mkdirSync(path.dirname(path.join(out, target)), { recursive: true });
      fs.writeFileSync(path.join(out, target), b);
      manifest.files.push({ file: target, bytes: b.length, sha256: digest });
    }
  };
  place(manifest.wasm.targets, bytes, sha256);
  place(manifest.wasm.experimentalTargets, expBytes, expSha256);
  manifest.files.sort((a, b) => (a.file < b.file ? -1 : 1));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const { files, findings } = scanTree(out);
  if (findings.length) throw new Error(`public guard: ${findings.map((f) => `${f.file}: ${f.pattern} (${f.how})`).join('; ')}`);
  return { out, files, sha256, expSha256, bytes: bytes.length, targets: manifest.wasm.targets, experimentalTargets: manifest.wasm.experimentalTargets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []));
  try {
    console.log(JSON.stringify(assemble({ wasm: args.wasm, experimental: args.experimental, src: args.src || '.', out: args.out || '_site' })));
  } catch (error) {
    console.error(`assemble-site: ${error.message}`);
    process.exit(1);
  }
}

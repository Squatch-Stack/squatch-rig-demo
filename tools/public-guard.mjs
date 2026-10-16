#!/usr/bin/env node
// The public-release guard: scans EVERY file of a tree that is about to be published, binaries included, for internal
// model-family code names, private lineage, local paths and the other banned terms.
//
//   node tools/public-guard.mjs DIR            exit 1 and list every finding
//   node tools/public-guard.mjs --self-test    plant a failure in a scratch tree; exit 0 only if the guard catches it
//
// Why it exists: an earlier guard skipped .wasm, .png, .wav and the vendored bundle, and an internal model-family code
// name shipped inside a public nam.wasm (as symbol names) and in every commit of the demo repo that held it.
// Text files are scanned as text. Every file, whatever its extension, is also scanned as bytes: printable runs of five
// or more characters (what `strings -n 5` prints) are matched against the NAME patterns, which catches symbol
// tables in .wasm, comments in minified bundles, PNG tEXt and EXIF fields, and WAV LIST/INFO chunks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Patterns are assembled from fragments on purpose: this file ships in the public tree and is scanned with it, so it must
// not contain the banned words itself.
const re = (...parts) => new RegExp(parts.join(''), 'i');
// Names that must never appear anywhere, in text or in a binary's strings. Case-insensitive.
export const NAME_PATTERNS = [
  re('a3', '[_-]?(?:fast|dw|clean|lab|shape|model|net|family)'), // code-name symbols and file names
  re('(?:create|is|build)_', 'a3'),
  re('nam-', 'a3'),
  re('a4', '[_-]?(?:fast|dw|clean|lab|shape|model|net|family)'),
  re('spark ?', '2'),
  re('(?:distill|student|teacher|trained (?:on|from))[^.\\n]{0,40}tone ?', '3000'), // lineage, not a credit
  re('t3k', '_'),
  re('gpu', '5090'),
  re('pif', 'uzz'),
  new RegExp(['/Us', 'ers/'].join('')),
  re('daoye', '\\.dev'),
  re('\\.secr', 'ets/'),
  // Trademark allusions (owner, 2026-10-16): a pedal label that alluded to a trademarked pedal reached the live rig.
  re('\\bts[ _-]?', 'drive'),
  re('tube[ _-]?', 'screamer'),
];
// A bare code-name token (the letter A and a 3 or a 4). In text files any whole word counts. In a binary's strings the
// token must sit in prose (a word of three or more letters next to it), because compressed data (fonts, images, audio)
// holds short printable runs by chance, and code bytes are not names. A musical pitch such as
// concert A at 440 Hz is not a code name: review such hits and add them to ALLOW with a reason.
export const WORD_TEXT = /\bA[34]\b/;
export const WORD_BINARY = /[A-Za-z]{3,}[ _-]A[34]\b|\bA[34][ _-][A-Za-z]{3,}/;
// Extra patterns for TEXT files only (digit runs and addresses are noise inside binaries).
export const TEXT_ONLY_PATTERNS = [re('65', '05'), re('192\\.', '168\\.')];

const TEXT_EXT = /\.(?:html?|css|js|mjs|cjs|json|map|md|txt|svg|xml|yml|yaml|toml|sh|webmanifest|csv|cpp|h|patch)$/i;
const MIN_RUN = 5;

// Reviewed exceptions: [file regex, pattern source, reason]. Keep this list short; each entry needs a reason.
export const ALLOW = [
  // squatch-skin's validator lists protected marks so it can REFUSE a skin that uses one; the list is the point.
  [/(?:^|\/)vendor\/squatch-skin\/lib\/skin-validate\.mjs$/, re('tube[ _-]?', 'screamer').source],
  // PixiJS minified bundle: the short tokens are mangled local variable names, not names.
  [/(?:^|\/)vendor\/pixi\.mjs$/, WORD_TEXT.source],
];

function stringsOf(buf) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    const printable = c >= 0x20 && c < 0x7f;
    if (printable) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= MIN_RUN) runs.push(buf.toString('latin1', start, i));
    start = -1;
  }
  return runs;
}

function allowed(file, pattern) {
  return ALLOW.some(([f, p]) => f.test(file) && p === pattern.source);
}

export function scanBuffer(file, buf) {
  const findings = [];
  const isText = TEXT_EXT.test(file);
  const add = (pattern, how, sample) => {
    if (!allowed(file, pattern)) findings.push({ file, pattern: String(pattern), how, sample: sample.slice(0, 80) });
  };
  if (isText) {
    const text = buf.toString('utf8');
    for (const p of [...NAME_PATTERNS, WORD_TEXT, ...TEXT_ONLY_PATTERNS]) {
      const m = p.exec(text);
      if (m) add(p, 'text', text.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' '));
    }
    return findings;
  }
  // Everything else is bytes: the printable runs, as `strings -n 5` prints them.
  const runs = stringsOf(buf);
  for (const p of [...NAME_PATTERNS, WORD_BINARY]) {
    for (const run of runs) {
      const m = p.exec(run);
      if (m) { add(p, 'strings', run.slice(Math.max(0, m.index - 20), m.index + 40)); break; }
    }
  }
  return findings;
}

export function scanTree(dir) {
  const findings = [];
  let files = 0;
  const walk = (d) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, item.name);
      if (item.name === '.git') continue;
      if (item.isDirectory()) walk(abs);
      else if (item.isFile()) {
        files++;
        findings.push(...scanBuffer(path.relative(dir, abs).split(path.sep).join('/'), fs.readFileSync(abs)));
      }
    }
  };
  walk(dir);
  return { files, findings };
}

// Plant each failure in a scratch tree and check the guard flags it, and that a clean tree passes. Returns problems.
export function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-guard-'));
  const problems = [];
  try {
    const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff, 0]), Buffer.from(['create_', 'a3', '_fast_config'].join('')), Buffer.from([0, 0xfe])]);
    const planted = {
      'wasm/nam.wasm': wasm,
      'img/pic.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.from('tEXtComment\0from the ' + ['A', '3Fast', 'Model'].join('') + ' lab'), Buffer.from([0, 1])]),
      'audio/loop.wav': Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.from([0, 1]), Buffer.from('LIST....INFOISFT\0' + ['nam-', 'a', '3'].join('') + ' capture'), Buffer.from([0])]),
      'js/bundle.min.js': Buffer.from('var x=1;/* trained on ' + ['gpu', '5090'].join('') + ' */'),
      'audio/note.wav': Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.from([0, 1]), Buffer.from('LIST....INFOICMT\0made with the ' + ['A', '3'].join('') + ' model'), Buffer.from([0])]),
      'notes.txt': Buffer.from('the ' + ['A', '4'].join('') + ' model\n'),
      'pedal.js': Buffer.from("label: '" + ['TS', ' Drive'].join('') + "'"),
      'about.html': Buffer.from('<p>a ' + ['Tube ', 'Screamer'].join('') + ' style pedal</p>'),
    };
    for (const [file, bytes] of Object.entries(planted)) {
      const dir = path.join(tmp, 'bad-' + file.replace(/\W+/g, '_'));
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), bytes);
      if (scanTree(dir).findings.length === 0) problems.push(`planted failure not caught: ${file}`);
    }
    const clean = path.join(tmp, 'clean');
    fs.mkdirSync(path.join(clean, 'wasm'), { recursive: true });
    // Looks like the real thing: "lkA4lj" code bytes, a hex table that holds a3/a4 as byte pairs, an experimental symbol.
    fs.writeFileSync(path.join(clean, 'wasm/nam.wasm'), Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d]), Buffer.from('lkA4lj\0a1a2a3a4a5a6\0create_experimental_fast_config\0')]));
    fs.writeFileSync(path.join(clean, 'index.html'), 'Squatch Rig, A2 and experimental fast paths. Tuned to A 440 Hz.');
    const res = scanTree(clean);
    if (res.findings.length) problems.push(`clean tree flagged: ${JSON.stringify(res.findings)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === '--self-test') {
    const problems = selfTest();
    for (const p of problems) console.error(`public-guard self-test: ${p}`);
    console.log(problems.length ? 'public-guard self-test FAILED' : 'public-guard self-test ok');
    process.exit(problems.length ? 1 : 0);
  }
  if (!arg) { console.error('usage: public-guard.mjs DIR | --self-test'); process.exit(2); }
  const { files, findings } = scanTree(path.resolve(arg));
  for (const f of findings) console.error(`public-guard: ${f.file}: ${f.pattern} (${f.how}): ${f.sample}`);
  console.log(`public-guard: ${files} files scanned, ${findings.length} finding(s)`);
  process.exit(findings.length ? 1 : 0);
}

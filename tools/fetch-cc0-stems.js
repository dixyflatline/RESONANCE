#!/usr/bin/env node
// Download CC0 field recordings from Wikimedia Commons and turn them into
// seamless, bar-aligned loops for the RESONANCE PoC (70 BPM, 4/4).
//
//   npm run fetch-stems          -> writes packs/field-recordings-cc0/cc0_*.wav
//
// No dependencies (Node 18+). Every source is CC0 (public-domain dedication);
// provenance is written to packs/field-recordings-cc0/CREDITS.md.
//
// Processing per stem (same as the in-browser prototype):
//  - textures: take a fixed window of (loop + 3 s) from the source, then
//    equal-power crossfade the extra 3 s into the start so the loop point is seamless
//  - gong: a single strike placed on bar 1 and bar 5; its tail wraps around the loop
//  - loudness: normalise to a target RMS, soft-limit peaks, cap at -1 dBFS

const fs = require('fs');
const path = require('path');

const TEMPO = 70, BPB = 4, BAR = (60 / TEMPO) * BPB, XF = 3;
const OUT = path.join(__dirname, '..', 'packs', 'field-recordings-cc0');
const LOCAL = process.env.STEMS_SOURCE_DIR; // optional: read sources from disk (offline/testing)

const SOURCES = [
  {
    out: 'cc0_stream_16bars_70bpm.wav', kind: 'loop', bars: 16, startSec: 9.5, targetDb: -26,
    url: 'https://upload.wikimedia.org/wikipedia/commons/5/54/433589_jackthemurray_stream-river-water-up-close.wav',
    page: 'https://commons.wikimedia.org/wiki/File:433589_jackthemurray_stream-river-water-up-close.wav',
    author: 'jackthemurray (via Freesound)', title: 'Stream / river water up close',
  },
  {
    out: 'cc0_rain_16bars_70bpm.wav', kind: 'loop', bars: 16, startSec: 29.25, targetDb: -28, soft: true,
    url: 'https://upload.wikimedia.org/wikipedia/commons/b/b6/Light_Rain_Distant_Thunder_July_5th_2016.wav',
    page: 'https://commons.wikimedia.org/wiki/File:Light_Rain_Distant_Thunder_July_5th_2016.wav',
    author: 'kvgarlic (via Freesound)', title: 'Light Rain, Distant Thunder, July 5th 2016',
  },
  {
    out: 'cc0_garden_8bars_70bpm.wav', kind: 'loop', bars: 8, startSec: 2.0, targetDb: -28,
    url: 'https://upload.wikimedia.org/wikipedia/commons/2/25/Garden_at_Pioneer_Works.wav',
    page: 'https://commons.wikimedia.org/wiki/File:Garden_at_Pioneer_Works.wav',
    author: 'Ogbabydiesal', title: 'Garden at Pioneer Works (birds, wind)',
  },
  {
    out: 'cc0_gong_8bars_70bpm.wav', kind: 'oneshot', bars: 8, onsetFrom: 13.0, onsetTo: 14.2, hitsAtBars: [0, 4], targetDb: -22,
    url: 'https://upload.wikimedia.org/wikipedia/commons/1/16/240382_the-very-real-horst_chinese-gong-finish-session-2014-06-10-29-143.wav',
    page: 'https://commons.wikimedia.org/wiki/File:240382_the-very-real-horst_chinese-gong-finish-session-2014-06-10-29-143.wav',
    author: 'the_very_Real_Horst (via Freesound)', title: 'Chinese gong, finish of session',
  },
];

// ---------- WAV I/O ----------
function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null, data = null, p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    let size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2), sampleRate = buf.readUInt32LE(body + 4), bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE -> subformat
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      if (size === 0 || body + size > buf.length) size = buf.length - body; // tolerate streamed headers
      data = buf.subarray(body, body + size);
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  const { format, channels, bits, sampleRate } = fmt;
  const bps = bits / 8, frames = Math.floor(data.length / (bps * channels));
  const read =
    format === 3 && bits === 32 ? (o) => data.readFloatLE(o) :
    format === 3 && bits === 64 ? (o) => data.readDoubleLE(o) :
    format === 1 && bits === 16 ? (o) => data.readInt16LE(o) / 32768 :
    format === 1 && bits === 24 ? (o) => data.readIntLE(o, 3) / 8388608 :
    format === 1 && bits === 32 ? (o) => data.readInt32LE(o) / 2147483648 :
    format === 1 && bits === 8 ? (o) => (data.readUInt8(o) - 128) / 128 : null;
  if (!read) throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = i * bps * channels;
    L[i] = read(o);
    R[i] = channels > 1 ? read(o + bps) : L[i];
  }
  return { L, R, sampleRate };
}

function writeWav(file, [L, R], sampleRate) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (const ch of [L, R]) {
    const x = Math.max(-1, Math.min(1, ch[i]));
    b.writeInt16LE(Math.round(x < 0 ? x * 32768 : x * 32767), o); o += 2;
  }
  fs.writeFileSync(file, b);
}

// ---------- DSP ----------
function loopAt(a, bars, startSec) {
  const sr = a.sampleRate, N = Math.round(bars * BAR * sr), X = Math.round(XF * sr), s = Math.round(startSec * sr);
  if (s + N + X > a.L.length) throw new Error(`source too short for ${bars} bars from ${startSec}s`);
  return [a.L, a.R].map((src) => {
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (i < X) { const t = i / X; out[i] = src[s + i] * Math.sin(t * Math.PI / 2) + src[s + N + i] * Math.cos(t * Math.PI / 2); }
      else out[i] = src[s + i];
    }
    return out;
  });
}

function oneshotLoop(a, { bars, onsetFrom, onsetTo, hitsAtBars }) {
  const sr = a.sampleRate, N = Math.round(bars * BAR * sr);
  let pk = 0;
  for (let j = Math.round(onsetFrom * sr); j < Math.round(onsetTo * sr); j++) pk = Math.max(pk, Math.abs(a.L[j]));
  let on = Math.round(onsetFrom * sr);
  while (Math.abs(a.L[on]) < pk * 0.3) on++;
  on = Math.max(0, on - Math.round(0.005 * sr));
  const len = a.L.length - on, fadeN = Math.round(0.5 * sr);
  return [a.L, a.R].map((src) => {
    const out = new Float32Array(N);
    for (const hb of hitsAtBars) {
      const off = Math.round(hb * BAR * sr);
      for (let i = 0; i < len; i++) out[(off + i) % N] += src[on + i] * (i > len - fadeN ? (len - i) / fadeN : 1);
    }
    return out;
  });
}

function level(chs, targetDb, soft) {
  const n = chs[0].length;
  let s = 0; for (const c of chs) for (let i = 0; i < n; i++) s += c[i] * c[i];
  const g = 10 ** (targetDb / 20) / Math.sqrt(s / (2 * n));
  let pk = 0;
  for (const c of chs) for (let i = 0; i < n; i++) {
    let x = c[i] * g;
    if (soft) { const k = 0.6, ax = Math.abs(x); if (ax > k) x = Math.sign(x) * (k + (1 - k) * Math.tanh((ax - k) / (1 - k))); }
    c[i] = x; pk = Math.max(pk, Math.abs(x));
  }
  const ceil = 0.89; // -1 dBFS
  if (pk > ceil) for (const c of chs) for (let i = 0; i < n; i++) c[i] *= ceil / pk;
  s = 0; for (const c of chs) for (let i = 0; i < n; i++) s += c[i] * c[i];
  return { rmsDb: 10 * Math.log10(s / (2 * n)), peakDb: 20 * Math.log10(Math.min(pk, ceil)) };
}

// ---------- main ----------
async function getSource(src) {
  if (LOCAL) return fs.readFileSync(path.join(LOCAL, decodeURIComponent(path.basename(src.url))));
  // Wikimedia rate-limits bursts (HTTP 429). Back off and retry, honouring Retry-After.
  const UA = 'ResonancePoC/0.1 (https://github.com/; stem fetcher for CC0 loops) node-fetch';
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(src.url, { headers: { 'User-Agent': UA } });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000 * 2 ** (attempt - 1); // 5, 10, 20, 40, 80 s
      process.stdout.write(`HTTP ${res.status}, retrying in ${Math.round(wait / 1000)} s … `);
      await res.arrayBuffer().catch(() => {});
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${src.url}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const credits = ['# Stem credits', '', 'All sources are CC0 1.0 (public-domain dedication) on Wikimedia Commons. No attribution is required; listed for provenance.', ''];
  let failed = 0, fetched = 0;
  for (const src of SOURCES) {
    const dest = path.join(OUT, src.out);
    const credit = `- **${src.out}**: "${src.title}" by ${src.author}. CC0. Source: ${src.page}`;
    if (fs.existsSync(dest) && !process.argv.includes('--force')) {
      console.log(`${src.out} … already there, skipping (use --force to rebuild)`);
      credits.push(credit);
      continue;
    }
    try {
      process.stdout.write(`${src.out} … `);
      if (!LOCAL && fetched++) await sleep(3000); // be gentle between downloads
      const a = readWav(await getSource(src));
      const chs = src.kind === 'loop' ? loopAt(a, src.bars, src.startSec) : oneshotLoop(a, src);
      const lv = level(chs, src.targetDb, src.soft);
      writeWav(dest, chs, a.sampleRate);
      const seam = Math.max(...chs.map((c) => Math.abs(c[0] - c[c.length - 1])));
      console.log(`ok  ${(chs[0].length / a.sampleRate).toFixed(3)} s @ ${a.sampleRate} Hz, rms ${lv.rmsDb.toFixed(1)} dBFS, peak ${lv.peakDb.toFixed(1)} dBFS, seam Δ ${seam.toFixed(4)}`);
      credits.push(credit);
    } catch (e) {
      failed++;
      console.log('FAILED: ' + e.message);
    }
  }
  fs.writeFileSync(path.join(OUT, 'CREDITS.md'), credits.join('\n') + '\n');
  console.log(failed ? `\n${failed} stem(s) failed.` : '\nDone. Reload the engine page to hear them.');
  process.exit(failed ? 1 : 0);
})();

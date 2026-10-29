#!/usr/bin/env node
// Roughness audit of the favorites:   node tools/audit-kits.js [--port=3000] [--only=gospel-glide]     (the server must be running; needs `npm i --no-save playwright`)
// Opens the engine page in a headless browser, loads each favorite, takes the notes of every generated stem (the piano-roll data) and, sixteenth by sixteenth,
// checks every pair of sounding notes in Hz: two tones closer than 0.4 of a critical band beat against each other (the band is wide in the bass, narrow in the treble).
// Prints the rough pairs per favorite, worst first. Percussive stems (Pulse, drums) and recorded samples have no clear pitch and are skipped.
// Minor thirds inside one chord can show up in the low register; they are the chord's own tones. "between different instruments" is the number to watch.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const PORT = Number(arg('port', 3000)), ONLY = arg('only', null);
const post = (o) => new Promise((r) => { const q = http.request({ port: PORT, path: '/api/input', method: 'POST' }, (s) => { s.resume(); s.on('end', r); }); q.end(JSON.stringify(o)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'], nm = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Plomp-Levelt style roughness of two pure tones: peaks at a quarter of the critical bandwidth, zero at unison and when far apart
const cbw = (f) => 25 + 75 * Math.pow(1 + 1.4 * Math.pow((f) / 1000, 2), 0.69);
const rough = (f1, f2) => { const r = Math.abs(f1 - f2) / cbw((f1 + f2) / 2); return r < 0.03 ? 0 : r < 0.4 ? 1 - r / 0.4 * 0.4 : 0; };
const FAVS = fs.readdirSync(path.join(__dirname, '..', 'favorites')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((f) => !ONLY || f === ONLY);
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const pg = await b.newPage({ viewport: { width: 1400, height: 900 } });
  await pg.goto(`http://localhost:${PORT}/engine`); await pg.click('#startBtn'); await pg.waitForSelector('#gate', { state: 'hidden', timeout: 170000 });
  const idle = async () => { await sleep(2500); await pg.waitForFunction(() => !document.querySelector('#toasts .work'), null, { timeout: 170000 }).catch(() => {}); await sleep(1500); };
  const out = [];
  for (const fav of FAVS) {
    await post({ type: 'kit', id: fav }); await idle();
    const data = await pg.evaluate(() => { const e = window.__engine, r = []; for (const [id, s] of e.stems) if (s.roll && s.roll.notes.length && s.def.voice !== 'sample' && !['pulse','beats'].includes(s.def.synth)) r.push({ name: s.def.name, beats: s.roll.beats, notes: s.roll.notes, slot: s.def.slot || '' }); return r; });
    // slices of a 16th
    const total = Math.max(...data.map((d) => d.beats)), step = 0.25, bad = new Map(); let n = 0, worst = 0, cross = 0;
    for (let t = 0; t < total; t += step) {
      const on = [];
      for (const d of data) for (const [t0, dur, p] of d.notes) { const tt = t % d.beats; if (tt >= t0 - 1e-6 && tt < t0 + dur - 1e-6) on.push({ who: d.name, p, f: hz(p) }); }
      for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
        if (on[i].who === on[j].who && on[i].p === on[j].p) continue;
        const r = rough(on[i].f, on[j].f); n++; if (r > 0 && on[i].who !== on[j].who) cross++;
        if (r > 0) { const k = [on[i].who + ' ' + nm(on[i].p), on[j].who + ' ' + nm(on[j].p)].sort().join(' vs '); const o = bad.get(k) || { c: 0, r: 0 }; o.c++; o.r = Math.max(o.r, r); bad.set(k, o); worst = Math.max(worst, r); }
      }
    }
    const list = [...bad.entries()].sort((a, c) => c[1].c - a[1].c).slice(0, 6);
    out.push(`== ${fav}: stems ${data.map((d) => d.name).join(', ')}\n   pairs checked ${n}, rough pairs ${[...bad.values()].reduce((a, c) => a + c.c, 0)} (between different instruments: ${cross}), worst ${worst.toFixed(2)}\n` + list.map(([k, v]) => `   ${k}: ${v.c} slices, peak ${v.r.toFixed(2)}`).join('\n'));
    console.log(out[out.length - 1]);
  }
  await b.close();
})();

#!/usr/bin/env node
// Harmony audit for the generated stems:   npm run clash   (optionally: npm run clash -- --key=F --seeds=200)
// Builds the shared note plan (public/synth.js) for many seeds and keys and checks it, bar by bar, against the rules
// in the priority list, using its own copy of the rules (so it can catch mistakes in the plan itself):
//   - two sounding notes a whole tone or closer apart clash,
//   - below G3 only unison, octave and fifth are allowed between notes,
//   - near the bass (within ~1.5 octaves), a note a semitone, whole tone or tritone from the Drone's D or A clashes.
// Notes that double a note the Drone/Sub already hold are fine. Exits with code 1 if anything clashes.
const fs = require('fs');
const path = require('path');
global.window = {};
require(path.join(__dirname, '..', 'public', 'synth.js'));
const { buildPlan, KEY_ROOTS } = global.window.ResonanceSynth;

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const KEYS = arg('key', null) ? [arg('key')] : Object.keys(KEY_ROOTS).filter((k) => !k.includes('#'));
const SEEDS = Number(arg('seeds', 100));
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const nm = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

function audit(plan, root) {
  const bad = [];
  const pc = (m) => (((m - root) % 12) + 12) % 12;
  // --- Sub rules: every note is on the ladder (D or A of the Drone), long, and at most two notes per chord ---
  const W = plan.chordBeats;
  for (const e of plan.subEv) {
    for (const n of [e.n]) {
      if (pc(n) !== 0 && pc(n) !== 7) bad.push(`Sub note ${nm(n)} is not a D/A-type note (tonic or fifth) of the Drone`);
      if (n < root - 12 || n > root + 7) bad.push(`Sub note ${nm(n)} outside the ladder`);
    }
    if (e.d < 2) bad.push(`Sub note ${nm(e.n)} at beat ${e.t} lasts only ${e.d} beats (want long notes)`);
    if (e.from != null && (Math.abs(e.n - e.from) !== 1 || e.sb < 1.5 || e.sb > 2.5 || e.n >= root)) bad.push(`Sub slide ${nm(e.from)} to ${nm(e.n)} must be a half-step scoop into a low tone (D2/A2) over 1.5 to 2.5 beats (${e.sb} beats)`);
  }
  for (let ci = 0; ci < 4; ci++) { const k = plan.subEv.filter((e) => e.t >= ci * W && e.t < (ci + 1) * W).length; if (k > 2) bad.push(`chord ${ci + 1}: ${k} Sub notes (max 2)`); }
  for (let b = 0; b < 8; b++) {
    const ci = Math.floor(b / 2), passes = [];
    // --- everything else against the bass register and the Sub's notes ---
    const bass = [...plan.drone, ...plan.pulse];
    const soft = plan.subNotes(ci).flatMap((x) => (x < root ? [x, x + 12] : [x]));
    const groups = { pad: plan.pad[ci], atmos: plan.atmos[ci], arp: plan.arp[ci] };
    const all = Object.entries(groups).flatMap(([name, notes]) => notes.map((n) => [name, n]));
    for (let i = 0; i < all.length; i++) {
      const [na, a] = all[i];
      for (const h of soft) if (a !== h && Math.abs(a - h) <= 2 && !bass.includes(a)) bad.push(`bar ${b + 1}: ${na} ${nm(a)} against the Sub's ${nm(h)}`);
      for (const e of passes) if (Math.abs(a - e.n) <= 2 && a !== e.n) bad.push(`bar ${b + 1}: ${na} ${nm(a)} against the Sub's passing tone ${nm(e.n)}`);
      if (bass.includes(a)) continue; // doubles a bass-register note
      for (const h of bass) { // against the bass register
        const d = Math.abs(a - h), ic = d % 12;
        if (d <= 2 || (a < 55 && h < 55 && ic !== 0 && ic !== 7) || (d < 20 && [1, 2, 6, 10, 11].includes(ic))) bad.push(`bar ${b + 1}: ${na} ${nm(a)} against bass ${nm(h)}`);
      }
      for (let j = i + 1; j < all.length; j++) { // against each other (arp notes are single notes, so only pad/atmos are checked together)
        const [nb, c2] = all[j];
        if (a === c2 || bass.includes(c2)) continue;
        if (Math.abs(a - c2) <= 2 && !(na === 'arp' && nb === 'arp')) bad.push(`bar ${b + 1}: ${na} ${nm(a)} against ${nb} ${nm(c2)}`);
        if (a < 55 && c2 < 55 && ![0, 7].includes(Math.abs(a - c2) % 12)) bad.push(`bar ${b + 1}: ${na} ${nm(a)} and ${nb} ${nm(c2)} are a muddy interval in the low register`);
      }
    }
  }
  return bad;
}

let failures = 0, checked = 0;
for (const key of KEYS) for (let seed = 1; seed <= SEEDS; seed++) {
  const plan = buildPlan(KEY_ROOTS[key], seed); checked++;
  const bad = audit(plan, KEY_ROOTS[key]);
  if (bad.length) { failures++; if (failures <= 10) console.log(`✗ key ${key} seed ${seed}:\n   ` + bad.join('\n   ')); }
}
// Show the default arrangement.
const key = config.key || 'D', seed = config.seed ?? 1, plan = buildPlan(KEY_ROOTS[key], seed);
console.log(`\nDefault arrangement (key ${key}, seed ${seed}) — what sounds under each bar:`);
console.log('Sub line (beat from loop start: note; ↗ = half-step scoop into the note, 8 beats per chord):');
console.log('  ' + plan.subEv.map((e) => `${e.t}:${e.from != null ? '↗' : ''}${nm(e.n)}(${e.d}b)`).join('  '));
console.log('\nbar | Pad                    | Atmos                  | Arp tones');
for (let b = 0; b < 8; b++) {
  const ci = Math.floor(b / 2), f = (a) => a.map(nm).join(' ').padEnd(22);
  console.log(` ${b + 1}  | ${f(plan.pad[ci])} | ${f(plan.atmos[ci])} | ${plan.arp[ci].map(nm).join(' ')}`);
}
console.log(`\n${checked} arrangements checked (${KEYS.length} keys × ${SEEDS} seeds): ${failures ? failures + ' with clashes ✗' : 'no clashes ✓'}\n`);
process.exit(failures ? 1 : 0);

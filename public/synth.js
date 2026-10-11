// RESONANCE PoC — procedural ambient stem generator.
//
// Renders each stem offline (OfflineAudioContext) as a seamless loop of exactly
// `bars` bars at the configured tempo. All stems share one chord progression
// (i – VI – III – VII in natural minor, 2 bars per chord) so any combination
// stacks cleanly, and each stem sticks to one sonic role / frequency band.
//
// Seamless looping: every event is placed in *circular* time. We render the
// loop plus a tail, then fold everything past the loop end back onto the start
// (out[i % N] += r[i]). That is exactly what the loop would sound like if it had
// been playing forever — reverb tails, delays and held notes wrap around with
// no click or gap. LFOs use frequencies of k / loopLength so they wrap too.

(function () {
  const KEY_ROOTS = { C: 48, 'C#': 49, Db: 49, D: 50, 'D#': 51, Eb: 51, E: 52, F: 53, 'F#': 54, Gb: 54, G: 55, 'G#': 44, Ab: 44, A: 45, 'A#': 46, Bb: 46, B: 47 };

  // i m9 | VI maj7#11 | III maj9 | VII 6/9   (semitones from the tonic)
  const CHORDS = [
    [0, 3, 7, 10, 14],
    [-4, 0, 3, 7, 14],
    [3, 7, 10, 14, 17],
    [-2, 2, 5, 7, 12],
  ];
  const BASS = [0, -4, 3, -2];
  const PENTA = [0, 3, 5, 7, 10]; // minor pentatonic, for melody

  // Melody pack: the progression 1 – 4 – 3 – 6 – 2 – 5 – 1 (2 bars per chord = 14 bars), in the
  // pack's mode. Minor (default) matches the generated ambient stems: i – iv – III – VI – ii° – v – i.
  // Chord tones in semitones above the tonic.
  const PROGS = {
    minor: [
      [0, 3, 7, 10, 14],   // i    m9
      [5, 8, 12, 15, 19],  // iv   m9
      [3, 7, 10, 14, 17],  // III  maj9
      [8, 12, 15, 19, 22], // VI   maj9
      [2, 5, 8, 12, 15],   // ii°  m7b5
      [7, 10, 14, 17, 21], // v    m9
      [0, 3, 7, 10, 14],   // i
    ],
    major: [
      [0, 4, 7, 11, 14],   // I    maj9
      [5, 9, 12, 16, 19],  // IV   maj9
      [4, 7, 11, 14, 17],  // iii  m7
      [9, 12, 16, 19, 23], // vi   m9
      [2, 5, 9, 12, 16],   // ii   m9
      [7, 11, 14, 17, 21], // V    9
      [0, 4, 7, 11, 14],   // I
    ],
  };
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };

  // ---------- arrangement plan: who may play what (priority list) ----------
  // Stems are rendered separately, so to keep them from clashing they all read the same plan, which is built
  // deterministically from the seed. Higher-priority voices decide first; lower ones fit around them:
  //   1 Drone   holds D2, A2, D3 (tonic and fifth)               never changes
  //   2 Pulse   thump always lands on the tonic (D2)
  //   3 Sub     only notes the Drone already holds (D2 or A2), picked from the chord's tones
  //   4 Pad     chord body; tones that would rub against the bass are lifted an octave or dropped
  //   5 Atmos   chord tones above the pad
  //   6 Arp     single notes
  //   7 Melody / Bells / Shimmer   top line; avoids seconds against everything sounding underneath
  // Rules for two sounding notes (midi numbers): a whole tone or closer is a clash; below G3 (midi 55) only unison, octave or
  // fifth are allowed (thirds and fourths are muddy down there); near the bass notes (within ~1.5 octaves) a semitone, whole
  // tone or tritone away from D or A is a clash too. A note is lifted by octaves until it fits, or dropped.
  const PRIORITY = ['drone', 'pulse', 'sub', 'pad', 'atmos', 'arp', 'melody'];
  const LOW = 55;
  const conflict = (m, h, shield) => {
    const d = Math.abs(m - h); if (!d) return false; if (d <= 2) return true;
    const ic = d % 12;
    if (m < LOW && h < LOW && ic !== 0 && ic !== 7) return true;
    return !!shield && d < 20 && [1, 2, 6, 10, 11].includes(ic);
  };
  const blocked = (m, shield, soft) => {
    if (shield.includes(m)) return false; // doubles a note the bass register already holds
    if (shield.some((h) => conflict(m, h, true))) return true;
    return soft.some((h) => h !== m && conflict(m, h, false));
  };
  const place = (m0, shield, soft) => { for (let k = 0; k < 3; k++) if (!blocked(m0 + 12 * k, shield, soft)) return m0 + 12 * k; return null; };

  function buildPlan(root, seed, opts = {}) {
    const bpb = opts.bpb || 4, mode = opts.mode || 'minor';
    const rnd = mulberry32(hash(`plan:${seed}`));
    const drone = [root - 12, root - 5, root], pulse = [root - 12];
    const pcOf = (n) => ((n % 12) + 12) % 12;
    // Sub: per bar of the 8-bar cycle. Every bar has an anchor note the Drone already holds (D or A) that is also a chord tone,
    // and a short walking line built on the "ladder" D2 A2 D3 A3 (open fifths: always in tune with the Drone).
    // Some bars also get a quiet passing tone on the "and" of beat 2 or 4 that steps into the next note.
    const sub = [], subByChord = [[], [], [], []];
    const anchors = [];
    let prev = -1;
    CHORDS.forEach((chord, ci) => {
      const pcs = chord.map(pcOf);
      let ok = [0, 7].filter((pc) => pcs.includes(pc)); if (!ok.length) ok = [0];
      for (let b = 0; b < 2; b++) {
        const pool = ok.filter((x) => x !== prev), src = pool.length ? pool : ok;
        const pc = b === 0 && ok.includes(0) && prev === -1 ? 0 : src[Math.floor(rnd() * src.length)];
        prev = pc; anchors[ci * 2 + b] = pc === 0 ? 0 : 1; /* ladder index: 0 = D2, 1 = A2 */
      }
    });
    const LADDER = [root - 12, root - 5, root, root + 7];
    const rl = mulberry32(hash(`subline:${seed}`));
    /* Long, spare and blooming. Each chord (two bars) is one of four shapes, chosen from the seed. Notes need not start on beat 1;
       wide moves only (octave or twelfth leaps, plus a gentle half-step scoop), and every note sits on the ladder (D or A) so it is in tune with the Drone.
         bloom: one note enters on beat 1, 2, 3 or 4 and rings to the end of the chord
         leap:  a note, then a jump up an octave (now and then a twelfth, D2 to A3) four beats later
         slide: a note, then the other low tone arrives with a half-step scoop (a gentle half-note-long slide)
         late:  silent first bar, one note enters late in the second bar and carries over into the next chord */
    const W = 2 * bpb; /* beats per chord */
    const SHAPES = { bloom: 2, leap: 2.5, slide: 2, late: 1.5 };
    const pickW = (items) => { const total = items.reduce((x, [, w]) => x + w, 0); let r = rl() * total; for (const [v, w] of items) { r -= w; if (r <= 0) return v; } return items[0][0]; };
    const subEv = []; /* [{ t: start in beats from the loop start, d: beats, n: midi, from?: midi to slide from, sb?: slide length in beats }] */
    let lastShape = '';
    for (let ci = 0; ci < 4; ci++) {
      const shape = pickW(Object.entries(SHAPES).filter(([k]) => k !== lastShape));
      lastShape = shape;
      const base = ci * W, n0 = LADDER[anchors[2 * ci]];
      if (shape === 'bloom') { const o = pickW([[0, 1], [1, 2], [2, 2], [3, 1]]); subEv.push({ t: base + o, d: W - o, n: n0 }); }
      else if (shape === 'leap') {
        const o = pickW([[0, 1], [1, 2], [2, 2]]);
        const up = n0 === LADDER[0] && rl() < 0.35 ? 19 : 12; /* D2 can leap a twelfth to A3 */
        subEv.push({ t: base + o, d: bpb, n: n0 }, { t: base + o + bpb, d: W - o - bpb, n: n0 + up });
      } else if (shape === 'slide') {
        /* gentle: a note, then the other low tone (D2 or A2) arrives with a half-step scoop that settles into it over a half note (2 beats) */
        const o = pickW([[0, 1], [1, 1]]);
        const T = n0 === LADDER[0] ? LADDER[1] : LADDER[0];
        const d2 = W - o - bpb;
        subEv.push({ t: base + o, d: bpb, n: n0 }, { t: base + o + bpb, d: d2, n: T, from: T + (rl() < 0.7 ? -1 : 1), sb: 2 });
      } else { const o = pickW([[1, 2], [2, 2], [3, 1]]); subEv.push({ t: base + bpb + o, d: W - bpb - o + 2, n: LADDER[anchors[2 * ci + 1]] }); }
    }
    for (let bar = 0; bar < 8; bar++) { sub[bar] = LADDER[anchors[bar]]; subByChord[Math.floor(bar / 2)].push(sub[bar]); } /* 'strict' style: one held anchor note per bar */
    const subNotes = (ci) => [...new Set(subEv.filter((e) => e.t < (ci + 1) * W && e.t + e.d > ci * W).map((e) => e.n))];
    const shieldFor = (ci) => [...drone, ...pulse]; /* every Sub note is a D or A, in the Drone's own octaves or an open fifth above it */
    const subOct = (ci) => subNotes(ci).flatMap((x) => (x < root ? [x, x + 12] : [x])); /* only the low notes get the octave layer */ // the Sub's notes above the Drone and their quiet octave layer: only seconds against them matter
    const voice = (chord, count, lift, shield, soft) => { // place chord tones in order; each must fit the bass and the notes placed before it
      const placed = [];
      chord.slice(0, count).forEach((n) => { const q = place(root + lift + n, shield, [...soft, ...placed]); if (q !== null) placed.push(q); });
      return placed;
    };
    const pad = [], atmos = [], arp = [];
    CHORDS.forEach((chord, ci) => {
      const sh = shieldFor(ci);
      pad[ci] = voice(chord, 4, 0, sh, subOct(ci));
      atmos[ci] = voice(chord, 5, 12, sh, [...pad[ci], ...subOct(ci)]);
      arp[ci] = chord.map((n) => place(root + 12 + n, sh, [...pad[ci], ...atmos[ci], ...subOct(ci)])).filter((x) => x !== null);
    });
    const passByChord = [[], [], [], []]; /* no passing tones: the bass stays long and spare */
    // Melody-register notes (melody, bells, shimmer) for chord ci: true if the note fits under everything sounding.
    const okAbove = (midi, ci) => !blocked(midi, shieldFor(ci), [...pad[ci], ...atmos[ci], ...subOct(ci), ...passByChord[ci]]);
    const fit = (midi, ci) => place(midi, shieldFor(ci), [...pad[ci], ...atmos[ci], ...subOct(ci), ...passByChord[ci]]); // lift a top-register note until it fits, or null
    return { chordBeats: W, drone, pulse, sub, subEv, subNotes, ladder: LADDER, subByChord, pad, atmos, arp, okAbove, fit, shieldFor, PRIORITY };
  }

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

  // ---------- building blocks ----------
  function makeIR(sampleRate, seconds, seed) {
    const rnd = mulberry32(seed);
    const len = Math.floor(sampleRate * seconds);
    const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / sampleRate;
        d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 2.2) * Math.exp(-t * 0.9) * (t < 0.02 ? t / 0.02 : 1);
      }
    }
    return buf;
  }
  function makeNoise(sampleRate, seconds, seed) {
    const rnd = mulberry32(seed);
    const len = Math.floor(sampleRate * seconds);
    const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b = 0;
      for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (rnd() * 2 - 1); d[i] = (rnd() * 2 - 1) * 0.5 + b * 3; } // white + a little brown
    }
    return buf;
  }

  // Equal-power swell: fade in over xf starting at t, hold `dur`, fade out over xf.
  function swell(param, t, dur, xf, peak) {
    const n = 64, up = new Float32Array(n), down = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1); up[i] = peak * Math.sin(x * Math.PI / 2); down[i] = peak * Math.cos(x * Math.PI / 2); }
    dur = Math.max(dur, xf);
    if (t > 0) param.setValueAtTime(0, 0); else param.value = 0;
    param.setValueCurveAtTime(up, t, xf);
    param.setValueCurveAtTime(down, t + dur, xf);
  }

  // A sustained voice: several detuned oscillators through a gain that swells.
  function padVoice(ctx, dest, { t, dur, xf, freq, types = ['sawtooth', 'sawtooth'], detune = 8, gain = 0.1, pan = 0 }) {
    const g = ctx.createGain(); swell(g.gain, t, dur, xf, gain);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p).connect(dest);
    types.forEach((type, i) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
      o.detune.value = (i - (types.length - 1) / 2) * detune * 2;
      o.connect(g); o.start(t); o.stop(t + dur + xf + 0.05);
    });
  }

  function pluck(ctx, dest, { t, freq, gain = 0.2, decay = 1.2, type = 'triangle', pan = 0 }) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2).connect(g); g.connect(p).connect(dest);
    o.start(t); o2.start(t); o.stop(t + decay + 0.05); o2.stop(t + decay + 0.05);
  }

  function bell(ctx, dest, { t, freq, gain = 0.15, decay = 5, pan = 0 }) {
    const car = ctx.createOscillator(); car.frequency.value = freq;
    const mod = ctx.createOscillator(); mod.frequency.value = freq * 3.5;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * 2.2, t); mg.gain.exponentialRampToValueAtTime(freq * 0.05, t + decay * 0.6);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    car.connect(g).connect(p).connect(dest);
    car.start(t); mod.start(t); car.stop(t + decay + 0.05); mod.stop(t + decay + 0.05);
  }

  function thump(ctx, dest, { t, gain = 0.6, f0 = 95, f1 = 42, decay = 0.45 }) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(dest); o.start(t); o.stop(t + decay + 0.05);
  }

  function noiseHit(ctx, dest, noise, { t, gain = 0.05, decay = 0.08, hp = 6000, pan = 0, offset = 0 }) {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    s.connect(f).connect(g).connect(p).connect(dest);
    s.start(t, offset); s.stop(t + decay + 0.05);
  }

  // Periodic LFO (frequency = cycles / L so it wraps with the loop).
  function lfo(ctx, param, { L, cycles = 1, depth, phase = 0 }) {
    const o = ctx.createOscillator(); o.frequency.value = cycles / L;
    const real = new Float32Array([0, Math.sin(phase)]), imag = new Float32Array([0, Math.cos(phase)]);
    o.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
    const g = ctx.createGain(); g.gain.value = depth;
    o.connect(g).connect(param); o.start(0);
  }

  // ---------- stems ----------
  // Each builder receives: ctx, out (dry bus), verb (reverb send), m (musical context)
  const BUILDERS = {
    drone(ctx, out, verb, m) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 0.7;
      lfo(ctx, f.frequency, { L: m.L, cycles: 2, depth: 350 });
      f.connect(out); f.connect(verb.in(0.6));
      const xf = Math.min(4, m.L / 4);
      [[m.root - 12, 0.16, -0.3], [m.root - 5, 0.1, 0.3], [m.root, 0.06, 0]].forEach(([n, g, pan]) =>
        padVoice(ctx, f, { t: 0, dur: m.L, xf, freq: mtof(n), types: ['sawtooth', 'triangle', 'sawtooth'], detune: 6, gain: g, pan }));
    },

    pad(ctx, out, verb, m) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; f.Q.value = 1.2;
      lfo(ctx, f.frequency, { L: m.L, cycles: 1, depth: 700, phase: 1 });
      f.connect(out); f.connect(verb.in(0.8));
      m.forChords((chord, t, seg, ci) => m.plan.pad[ci].forEach((note, i) => // voicing from the plan: tones that rub against the bass are lifted
        padVoice(ctx, f, { t, dur: seg, xf: 1.6, freq: mtof(note), detune: 9, gain: 0.045, pan: (i - 1.5) * 0.35 })));
    },

    // Atmos: a blend-style layer. Two timbres (a soft triangle/sine choir and a brighter filtered saw) play the same chord
    // tones, and a slow LFO crossfades between them over the loop (2 full cycles), so the colour keeps slowly morphing.
    // Notes avoid the Drone like the other melodic stems.
    atmos(ctx, out, verb, m) {
      const soft = ctx.createGain(), bright = ctx.createGain(), lp = ctx.createBiquadFilter();
      soft.gain.value = 0.5; bright.gain.value = 0.5;
      lfo(ctx, soft.gain, { L: m.L, cycles: 2, depth: 0.5, phase: 0 });
      lfo(ctx, bright.gain, { L: m.L, cycles: 2, depth: 0.5, phase: Math.PI });
      lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 0.8;
      lfo(ctx, lp.frequency, { L: m.L, cycles: 2, depth: 900, phase: Math.PI });
      const pan = ctx.createStereoPanner(); pan.pan.value = 0;
      soft.connect(out); soft.connect(verb.in(1.0)); bright.connect(lp); lp.connect(out); lp.connect(verb.in(1.0));
      m.forChords((chord, t, seg, ci) => m.plan.atmos[ci].forEach((note, i) => {
        const p = (i - 2) * 0.3;
        padVoice(ctx, soft, { t, dur: seg, xf: 2.4, freq: mtof(note), types: ['triangle', 'sine'], detune: 5, gain: 0.04, pan: p });
        padVoice(ctx, bright, { t, dur: seg, xf: 2.4, freq: mtof(note), types: ['sawtooth'], detune: 7, gain: 0.022, pan: -p });
      }));
    },

    // Sub bass: moves between D and A (the notes the Drone already holds) following the chord tones; the plan picks the
    // note for each bar. Anything else in the low register would beat against the Drone and the Pulse.
    sub(ctx, out, verb, m) {
      /* The Sub: long swelling notes that need not start on beat 1, octave/twelfth leaps and a gentle half-step scoop from the plan, sent through
         a heavy reverb and a ping-pong delay so each note blooms and dissolves into the mix. style 'strict' = one held note per bar, dry. */
      const strict = m.style === 'strict', B = m.beat, nBars = Math.round(m.L / m.bar);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 190; f.connect(out); /* dry: pure low end */
      const wet = ctx.createBiquadFilter(); wet.type = 'lowpass'; wet.frequency.value = 1100; /* wet: a little brighter, so the bloom can be heard */
      const wetSend = ctx.createGain(); wetSend.gain.value = strict ? 0 : 1; wet.connect(wetSend);
      wetSend.connect(verb.in(2.6)); /* heavy reverb */
      const d1 = ctx.createDelay(4), d2 = ctx.createDelay(4), fb1 = ctx.createGain(), fb2 = ctx.createGain(), p1 = ctx.createStereoPanner(), p2 = ctx.createStereoPanner(), dl = ctx.createBiquadFilter();
      d1.delayTime.value = 1.5 * B; d2.delayTime.value = 2 * B; fb1.gain.value = fb2.gain.value = 0.55; p1.pan.value = -0.65; p2.pan.value = 0.65; dl.type = 'lowpass'; dl.frequency.value = 800;
      wetSend.connect(dl).connect(d1); d1.connect(p1).connect(out); d1.connect(fb1).connect(d2); d2.connect(p2).connect(out); d2.connect(fb2).connect(d1);
      d1.connect(verb.in(1.2));
      const note = (t, dur, midi, { gain = 0.5, attack, release, from = null, slideSec = 0 }) => {
        const g = ctx.createGain(), end = t + dur;
        const a = Math.min(attack, dur * 0.5), r = release;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + a);
        if (from !== null) { /* dip a little while the pitch settles, so the scoop is soft */
          const t1 = t + 0.1, t2 = t1 + slideSec;
          g.gain.setValueAtTime(gain, t1); g.gain.linearRampToValueAtTime(gain * 0.8, t1 + slideSec * 0.5); g.gain.linearRampToValueAtTime(gain, t2);
          g.gain.setValueAtTime(gain, Math.max(t2, end));
        } else g.gain.setValueAtTime(gain, Math.max(t + a, end));
        g.gain.linearRampToValueAtTime(0, end + r);
        g.connect(f); g.connect(wet);
        [[0, 'sine', 1], [12, 'triangle', midi >= m.root ? 0 : 0.16]].forEach(([off, type, lv]) => {
          if (!lv) return;
          const o = ctx.createOscillator(); o.type = type;
          if (from !== null) { o.frequency.setValueAtTime(mtof(from + off), t); o.frequency.setValueAtTime(mtof(from + off), t + 0.1); o.frequency.exponentialRampToValueAtTime(mtof(midi + off), t + 0.1 + slideSec); }
          else o.frequency.setValueAtTime(mtof(midi + off), t);
          const og = ctx.createGain(); og.gain.value = lv; o.connect(og).connect(g); o.start(t); o.stop(end + r + 0.1);
        });
      };
      if (strict) { for (let b = 0; b < nBars; b++) note(b * m.bar, m.bar, m.plan.sub[b % 8], { attack: 0.35, release: 0.35 }); return; }
      for (let c = 0; c < Math.round(m.L / (B * m.plan.chordBeats)); c++) f.frequency.setValueAtTime(150 + m.rnd() * 110, c * B * m.plan.chordBeats);
      const cycle = m.plan.chordBeats * 4 * B;
      for (let rep = 0; rep * cycle < m.L - 1e-6; rep++) for (const e of m.plan.subEv) {
        note(rep * cycle + e.t * B, e.d * B, e.n, {
          attack: 0.9 + m.rnd() * 0.8, release: 1.4 + m.rnd() * 1.0,
          from: e.from ?? null, slideSec: (e.sb || 0) * B,
        });
      }
    },

    arp(ctx, out, verb, m) {
      const delay = ctx.createDelay(2); delay.delayTime.value = m.beat * 0.75;
      const fb = ctx.createGain(); fb.gain.value = 0.38;
      const dl = ctx.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 2500;
      const bus = ctx.createGain();
      bus.connect(out); bus.connect(verb.in(0.5));
      bus.connect(delay); delay.connect(dl).connect(fb).connect(delay); dl.connect(out);
      const pattern = [0, 2, 1, 3, 4, 2, 3, 1];
      const step = m.beat / 2;
      m.forChords((chord, t0, seg, ci) => {
        const steps = Math.round(seg / step), tones = m.plan.arp[ci];
        for (let s = 0; s < steps; s++) {
          if (m.rnd() < 0.18) continue;
          const note = tones[pattern[s % pattern.length] % tones.length];
          pluck(ctx, bus, { t: t0 + s * step, freq: mtof(note), gain: 0.11 + m.rnd() * 0.07, decay: 1.4, pan: Math.sin(s * 0.9) * 0.5 });
        }
      });
    },

    texture(ctx, out, verb, m) {
      const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(0.4));
      const grain = m.bar * 2, len = grain * 1.6;
      for (let t = 0; t < m.L - 1e-6; t += grain) {  // overlapping "waves"
        const s = ctx.createBufferSource(); s.buffer = m.noise; s.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass';
        f.frequency.setValueAtTime(250 + m.rnd() * 200, t);
        f.frequency.linearRampToValueAtTime(900 + m.rnd() * 900, t + len * 0.45);
        f.frequency.linearRampToValueAtTime(260, t + len);
        const g = ctx.createGain(); swell(g.gain, t, len * 0.6, len * 0.4, 0.22);
        const p = ctx.createStereoPanner(); p.pan.value = (m.rnd() - 0.5) * 1.4;
        s.connect(f).connect(g).connect(p).connect(bus);
        s.start(t, m.rnd() * (m.noise.duration - 1)); s.stop(t + len + 0.1);
      }
      // airy band on top
      const s = ctx.createBufferSource(); s.buffer = m.noise; s.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.8;
      lfo(ctx, bp.frequency, { L: m.L, cycles: 3, depth: 1500 });
      const g = ctx.createGain(); swell(g.gain, 0, m.L, 2, 0.02);
      s.connect(bp).connect(g).connect(bus); s.start(0); s.stop(m.L + 2.1);
    },

    pulse(ctx, out, verb, m) {
      // A slow collective heartbeat (lub-dub on beats 1 and 3) + soft shaker.
      const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(0.15));
      const beats = Math.round(m.L / m.beat);
      for (let b = 0; b < beats; b++) {
        const t = b * m.beat, inBar = b % m.bpb;
        if (inBar === 0 || inBar === Math.floor(m.bpb / 2)) {
          // tuned to the key: each beat drops onto the tonic (D2 in D), the same D the Drone and Sub sit on
          thump(ctx, bus, { t, gain: 0.55, f0: mtof(m.root), f1: mtof(m.root - 12) });
          thump(ctx, bus, { t: t + 0.22, gain: 0.32, f0: mtof(m.root - 5), f1: mtof(m.root - 12), decay: 0.35 });
        }
        for (let s = 0; s < 4; s++) {
          const acc = s === 2 ? 1 : s === 0 ? 0.5 : 0.3;
          if (m.rnd() < 0.12) continue;
          noiseHit(ctx, bus, m.noise, { t: t + s * m.beat / 4, gain: 0.035 * acc * (0.7 + m.rnd() * 0.6), decay: 0.07, hp: 7000, pan: (m.rnd() - 0.5) * 0.8, offset: m.rnd() * 5 });
        }
        if (inBar === m.bpb - 1 && m.rnd() < 0.6)
          noiseHit(ctx, bus, m.noise, { t: t + m.beat / 2, gain: 0.08, decay: 0.12, hp: 2500, offset: m.rnd() * 5 });
      }
    },

    bells(ctx, out, verb, m) {
      const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(1.1));
      m.forChords((chord, t0, seg, ci) => {
        const tones = chord.map((n) => ((n % 12) + 12) % 12).filter((n) => PENTA.includes(n) || m.rnd() < 0.3);
        const count = 1 + Math.floor(m.rnd() * 3);
        for (let k = 0; k < count; k++) {
          const beatPos = Math.floor(m.rnd() * Math.round(seg / m.beat));
          const n = tones[Math.floor(m.rnd() * tones.length)] ?? 0;
          const bn = m.plan.fit(m.root + 24 + n, ci); const bt = t0 + beatPos * m.beat + (m.rnd() < 0.3 ? m.beat / 2 : 0); if (bn === null) continue;
          bell(ctx, bus, { t: bt, freq: mtof(bn), gain: 0.07 + m.rnd() * 0.05, decay: 5, pan: (m.rnd() - 0.5) * 1.2 });
        }
      });
    },

    // ----- melody pack (I IV iii vi ii V I) -----
    mchords(ctx, out, verb, m) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800; f.Q.value = 0.9;
      lfo(ctx, f.frequency, { L: m.L, cycles: 2, depth: 600 });
      f.connect(out); f.connect(verb.in(0.8));
      m.forProg((chord, t, seg) => chord.slice(0, 4).forEach((n, i) =>
        padVoice(ctx, f, { t, dur: seg, xf: 1.2, freq: mtof(m.root + n), detune: 8, gain: 0.05, pan: (i - 1.5) * 0.35 })));
    },

    mbass(ctx, out, verb, m) {
      m.forProg((chord, t, seg) => {
        padVoice(ctx, out, { t, dur: seg, xf: 0.25, freq: mtof(m.root - 12 + chord[0]), types: ['sine', 'triangle'], detune: 2, gain: 0.14 });
        for (let b = 0; b < Math.round(seg / m.bar); b++)
          pluck(ctx, out, { t: t + b * m.bar, freq: mtof(m.root - 12 + chord[0]), gain: 0.12, decay: 1.4, type: 'sine' });
      });
    },

    marp(ctx, out, verb, m) {
      const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(0.9));
      const pat = [0, 2, 1, 3, 2, 4, 3, 1];
      m.forProg((chord, t0, seg, ci) => {
        const steps = Math.round(seg / (m.beat / 2));
        for (let s = 0; s < steps; s++) {
          let note = m.root + 24 + chord[pat[s % pat.length]] - (chord[pat[s % pat.length]] > 12 ? 12 : 0);
          if (m.ambient) { note = m.plan.fit(note, ci); if (note === null) continue; } // follows the ambient stems: fits under the plan
          pluck(ctx, bus, { t: t0 + s * m.beat / 2, freq: mtof(note), gain: s % 4 === 0 ? 0.15 : 0.1, decay: 1.1, pan: Math.sin(s) * 0.5 });
        }
      });
    },

    // A seeded melody that follows the chords: chord tones on strong beats, stepwise motion
    // between them, each phrase leans toward the next chord, and the last phrase lands on the tonic.
    melody(ctx, out, verb, m) {
      // Four characters to choose from. pOn/pOff: chance of a note on a beat / off-beat; hold: extra chance after a long gap;
      // step: how far each note may move (in scale steps); oct: octave shift; decay: ring time; echo: delay level.
      const STYLES = {
        lyrical: { pOn: 0.30, pOff: 0.05, hold: 0.5, step: 3.2, oct: 0, type: 'triangle', decay: 1.0, echo: 0.28 },
        flowing: { pOn: 0.65, pOff: 0.5, hold: 0.0, step: 3.0, oct: 0, type: 'triangle', decay: 0.5, echo: 0.2 },
        leaping: { pOn: 0.42, pOff: 0.22, hold: 0.3, step: 8.0, oct: 0, type: 'triangle', decay: 0.7, echo: 0.3 },
        bright: { pOn: 0.22, pOff: 0.05, hold: 0.6, step: 4.0, oct: 12, type: 'sine', decay: 1.8, echo: 0.4 },
      };
      const st = STYLES[m.style] || { pOn: 0.38, pOff: 0.16, hold: 0.4, step: 4.4, oct: 0, type: 'triangle', decay: 0.8, echo: 0.28 };
      const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(0.9));
      const dly = ctx.createDelay(1); dly.delayTime.value = m.beat * 0.75; // dotted-8th echo
      const fb = ctx.createGain(); fb.gain.value = 0.3; const dg = ctx.createGain(); dg.gain.value = st.echo;
      bus.connect(dg).connect(dly); dly.connect(fb).connect(dly); dly.connect(out); dly.connect(verb.in(0.5));
      const poolAll = [];
      for (let o = 0; o < 3; o++) for (const d of m.scale) { const n = m.root + 12 + o * 12 + d; if (n <= m.root + 12 + 19) poolAll.push(n); }
      let pool = poolAll;
      const pcs = (chord) => chord.map((n) => ((n % 12) + 12) % 12);
      const isTone = (n, chord) => pcs(chord).includes(((n - m.root) % 12 + 12) % 12);
      const nearest = (n, pred) => pool.filter(pred).sort((a, b) => Math.abs(a - n) - Math.abs(b - n))[0] ?? n;
      let cur = nearest(m.root + 19, (n) => isTone(n, m.prog[0]));
      m.forProg((chord, t0, seg, i, cnt) => {
        if (m.ambient) { const ok = poolAll.filter((n) => m.plan.okAbove(n + st.oct, i)); /* st.oct: the 'bright' style plays an octave up */ pool = ok.length ? ok : poolAll; } // notes that fit under this chord's pad/atmos/bass
        const next = m.prog[(i + 1) % cnt], last = !m.ambient && i === cnt - 1, slots = Math.round(seg / (m.beat / 2));
        const onsets = [0];
        for (let s = 2; s < slots; s++) {
          const gap = s - onsets[onsets.length - 1];
          if (gap >= 2 && m.rnd() < (s % 2 === 0 ? st.pOn : st.pOff) + (gap >= 5 ? st.hold : 0)) onsets.push(s);
        }
        onsets.forEach((s, k) => {
          const strong = s % 4 === 0, final = k === onsets.length - 1;
          let idx = pool.indexOf(cur);
          idx = Math.max(0, Math.min(pool.length - 1, idx + Math.round((m.rnd() - 0.5) * st.step)));
          let n = pool[idx];
          if (final) n = last ? nearest(cur, (x) => (x - m.root) % 12 === 0)
            : nearest(cur, (x) => isTone(x, next));
          else if (strong || k === 0) n = nearest(n, (x) => isTone(x, chord));
          cur = n;
          const dur = ((onsets[k + 1] ?? slots) - s) * m.beat / 2;
          pluck(ctx, bus, { t: t0 + s * m.beat / 2, freq: mtof(n + st.oct), gain: (strong ? 0.32 : 0.25) * (st.oct ? 0.75 : 1), decay: Math.min(3, st.decay + dur), type: st.type, pan: (m.rnd() - 0.5) * 0.4 });
        });
      });
    },

    shimmer(ctx, out, verb, m) {
      const bus = ctx.createGain(); bus.gain.value = 1;
      lfo(ctx, bus.gain, { L: m.L, cycles: 8, depth: 0.25 });
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      bus.connect(hp); hp.connect(out); hp.connect(verb.in(1.4));
      m.forChords((chord, t, seg, ci) => [chord[1], chord[2], chord[4] ?? chord[3]].forEach((n, i) => {
        const sn = m.plan.fit(m.root + 24 + n, ci); if (sn === null) return;
        padVoice(ctx, bus, { t, dur: seg, xf: 3, freq: mtof(sn), types: ['sine', 'triangle'], detune: 4, gain: 0.03, pan: (i - 1) * 0.6 });
      }));
    },
  };

  // ---------- chord timeline (for the engine's chord display) ----------
  // Same chords and lengths the stems are built from. Returns { bars, chords: [{ name, roman, start, len }] } (start/len in bars).
  const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  // [semitones above the tonic, quality, roman numeral]; matches CHORDS / PROGS above.
  const LABELS = {
    ambient: [[0, 'm9', 'i'], [8, 'maj7♯11', 'VI'], [3, 'maj9', 'III'], [10, '6/9', 'VII']],
    minor: [[0, 'm9', 'i'], [5, 'm9', 'iv'], [3, 'maj9', 'III'], [8, 'maj9', 'VI'], [2, 'm7♭5', 'ii°'], [7, 'm9', 'v'], [0, 'm9', 'i']],
    major: [[0, 'maj9', 'I'], [5, 'maj9', 'IV'], [4, 'm7', 'iii'], [9, 'm9', 'vi'], [2, 'm9', 'ii'], [7, '9', 'V'], [0, 'maj9', 'I']],
  };
  const PROG_SYNTHS = ['mchords', 'mbass', 'marp', 'melody'];
  function chordTimeline({ synth, progression, bars, key, mode }) {
    const kind = progression === 'ambient' || !PROG_SYNTHS.includes(synth) ? 'ambient' : (mode === 'major' ? 'major' : 'minor');
    const list = LABELS[kind], root = KEY_ROOTS[key] ?? 50, chords = [];
    const lens = [];
    if (kind === 'ambient' && progression !== 'ambient') { // the ambient stems: one chord every 2 bars, cycling
      for (let i = 0, t = 0; t < bars; i++, t += 2) lens.push([i % list.length, t, Math.min(2, bars - t)]);
    } else { // progression synths: whole bars each, extra bars to the first chords
      const n = Math.min(list.length, bars), base = Math.floor(bars / n), extra = bars - base * n;
      for (let i = 0, t = 0; i < n; i++) { const len = base + (i < extra ? 1 : 0); lens.push([i, t, len]); t += len; }
    }
    for (const [i, start, len] of lens) {
      const [o, q, roman] = list[i];
      chords.push({ name: NOTE_NAMES[(root + o) % 12] + q, roman, start, len });
    }
    return { bars, chords };
  }

  /**
   * Render one stem. Returns an AudioBuffer exactly `bars` bars long.
   * opts: { synth, sampleRate, tempo, beatsPerBar, bars, key, mode ('minor'|'major'), progression ('ambient' | default 1-4-3-6-2-5-1), style (melody: lyrical|flowing|leaping|bright), seed, id }
   */
  async function renderStem(opts) {
    const { synth, sampleRate, tempo, beatsPerBar: bpb, bars, key, seed, id } = opts;
    const ambient = opts.progression === 'ambient';
    const style = opts.style; // follow the ambient stems' chords (i – VI – III – VII)
    const mode = ambient || opts.mode !== 'major' ? 'minor' : 'major';
    const prog = ambient ? CHORDS : PROGS[mode];
    const build = BUILDERS[synth];
    if (!build) throw new Error('Unknown synth type: ' + synth);
    const beat = 60 / tempo, bar = beat * bpb, L = bar * bars;
    const TAIL = 12;
    const N = Math.round(L * sampleRate);
    const ctx = new OfflineAudioContext(2, N + Math.round(TAIL * sampleRate), sampleRate);

    const rnd = mulberry32(hash(`${seed}:${synth}:${id}`));
    const noise = makeNoise(sampleRate, 8, hash(`noise:${seed}`));
    const ir = makeIR(sampleRate, 6, hash(`ir:${seed}`));

    const out = ctx.createGain(); out.connect(ctx.destination);
    const conv = ctx.createConvolver(); conv.buffer = ir; conv.connect(out);
    const verb = { in(level) { const g = ctx.createGain(); g.gain.value = level * 0.35; g.connect(conv); return g; } };

    const seg = bar * 2; // one chord every 2 bars
    const m = {
      mode, prog, ambient, style, plan: buildPlan(KEY_ROOTS[key] ?? 50, seed, { bpb, mode: 'minor' }), scale: SCALES[mode], root: KEY_ROOTS[key] ?? 50, beat, bar, bpb, L, rnd, noise,
      // The progression's chords spread over the loop in whole bars; extra bars go to the first chords (7 chords in 8 bars -> 2,1,1,1,1,1,1; the 4 ambient chords -> 2 bars each).
      forProg(fn) {
        const n = Math.min(prog.length, bars), base = Math.floor(bars / n), extra = bars - base * n;
        let t = 0;
        for (let i = 0; i < n; i++) { const len = (base + (i < extra ? 1 : 0)) * bar; fn(prog[i], t, len, i, n); t += len; }
      },
      forChords(fn) { const n = Math.max(1, Math.round(L / seg)); for (let i = 0; i < n; i++) fn(CHORDS[i % 4], i * seg, seg, i % 4); },
    };
    build(ctx, out, verb, m);

    const r = await ctx.startRendering();
    // Fold the tail back onto the start -> seamless circular loop.
    const loop = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate });
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      const src = r.getChannelData(ch), dst = loop.getChannelData(ch);
      for (let i = 0; i < src.length; i++) dst[i % N] += src[i];
      for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(dst[i]));
    }
    if (peak > 0.95) { // keep headroom; never clip a stem on its own
      const k = 0.95 / peak;
      for (let ch = 0; ch < 2; ch++) { const d = loop.getChannelData(ch); for (let i = 0; i < N; i++) d[i] *= k; }
    }
    return loop;
  }

  // Encode an AudioBuffer as a 16-bit WAV Blob (for exporting generated stems).
  function toWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const ab = new ArrayBuffer(44 + len * ch * 2), v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, len * ch * 2, true);
    const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, data[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Blob([ab], { type: 'audio/wav' });
  }

  window.ResonanceSynth = { renderStem, toWav, chordTimeline, buildPlan, KEY_ROOTS, KEYS: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] };
})();

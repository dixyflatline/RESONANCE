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


  /* Genre progressions for the Melody packs (packs/melody-*): every chord is built from the notes of D natural minor (= F major: D E F G A B♭ C),
     so the melody, the chords and the arp stay diatonic and sit on the Drone, Pad and Atmos of the ambient stems (D minor). Roots are semitones above the tonic;
     the Roman numerals are relative to the minor tonic. Pack stems pick one with "progression": "<key>". Typical of each genre, not copies of any product's presets. */
  const QUALITIES = { m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14], maj7: [0, 4, 7, 11], maj9: [0, 4, 7, 11, 14], 7: [0, 4, 7, 10], 9: [0, 4, 7, 10, 14], 'm7♭5': [0, 3, 6, 10], add9: [0, 4, 7, 14], sus4: [0, 5, 7, 12] };
  const PROG_LIB = {};
  const addProg = (key, name, list) => { PROG_LIB[key] = { name, chords: list.map(([o, q]) => QUALITIES[q].map((n) => o + n)), labels: list.map(([o, q, r]) => [o, q, r]) }; };
  addProg('ballad', 'Ballad', [[3, 'maj9', 'III'], [7, 'm7', 'v'], [8, 'maj9', 'VI'], [10, '9', 'VII']]); /* I iii IV V in F: sweeping */
  addProg('pop', 'Pop', [[3, 'add9', 'III'], [10, 'sus4', 'VII'], [0, 'm7', 'i'], [8, 'maj7', 'VI']]); /* I V vi IV in F, with sus4 */
  addProg('house', 'Dance / House', [[0, 'm9', 'i'], [8, 'maj9', 'VI'], [5, 'm9', 'iv'], [7, 'm7', 'v']]); /* i VI iv v: deep house stabs */
  addProg('gospel', 'Gospel', [[3, 'maj9', 'III'], [8, 'maj9', 'VI'], [7, 'm7', 'v'], [0, 'm9', 'i'], [5, 'm9', 'iv'], [10, '9', 'VII'], [3, 'maj9', 'III']]); /* I IV iii vi ii V I in F: the circle walks */
  addProg('jazz', 'Jazz', [[5, 'm9', 'iv'], [10, '9', 'VII'], [3, 'maj9', 'III'], [0, 'm9', 'i'], [5, 'm9', 'iv'], [10, '9', 'VII'], [3, 'maj9', 'III']]); /* ii V I vi ii V I in F */
  addProg('lofi', 'Lo-fi / West Coast', [[3, 'maj9', 'III'], [7, 'm7', 'v'], [0, 'm9', 'i'], [5, 'm9', 'iv']]); /* I iii vi ii: smooth and jazzy */
  addProg('neosoul', 'R&B / Neo-soul', [[8, 'maj9', 'VI'], [7, 'm7', 'v'], [5, 'm9', 'iv'], [10, '9', 'VII']]); /* IV iii ii V in F: extended Rhodes-style */
  addProg('soul70', 'Soulful seventies', [[3, 'maj7', 'III'], [0, 'm7', 'i'], [5, 'm7', 'iv'], [10, '9', 'VII']]); /* I vi ii V turnaround */
  addProg('dark', 'Boom-bap (dark minor)', [[0, 'm7', 'i'], [2, 'm7♭5', 'ii°'], [8, 'maj7', 'VI'], [7, 'm7', 'v']]); /* i ii° VI v: gritty and tense */
  addProg('trap', 'Trap (dark)', [[0, 'm9', 'i'], [8, 'maj7', 'VI'], [0, 'm9', 'i'], [2, 'm7♭5', 'ii°']]); /* i VI i ii°: ominous and sparse */

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

  // The Sub's long, spare, blooming line. segs = [{ base: start in beats, W: length in beats, a0, a1: ladder indices of its anchor notes }].
  // Each segment (normally one chord = two bars) is one of four shapes, chosen from the seed. Notes need not start on beat 1;
  // wide moves only (octave or twelfth leaps, plus a gentle half-step scoop), and every note sits on the ladder (D or A) so it is in tune with the Drone.
  //   bloom: one note enters on beat 1, 2, 3 or 4 and rings to the end of the segment
  //   leap:  a note, then a jump up an octave (now and then a twelfth, D2 to A3) four beats later
  //   slide: a note, then the other low tone arrives with a half-step scoop (a gentle half-note-long slide)
  //   late:  silent first bar, one note enters late in the second bar and carries over into the next segment
  // Returns [{ t: start in beats from the loop start, d: beats, n: midi, from?: midi to slide from, sb?: slide length in beats }].
  function subLine(rl, segs, bpb, LADDER) {
    const SHAPES = { bloom: 2, leap: 2.5, slide: 2, late: 1.5 };
    const pickW = (items) => { const total = items.reduce((x, [, w]) => x + w, 0); let r = rl() * total; for (const [v, w] of items) { r -= w; if (r <= 0) return v; } return items[0][0]; };
    const subEv = [];
    let lastShape = '';
    for (const sg of segs) {
      const { base, W } = sg, n0 = LADDER[sg.a0];
      const shape = W < 2 * bpb ? 'bloom' : pickW(Object.entries(SHAPES).filter(([k]) => k !== lastShape)); /* a short last segment can only bloom */
      lastShape = shape;
      if (shape === 'bloom') { const o = Math.min(pickW([[0, 1], [1, 2], [2, 2], [3, 1]]), Math.max(0, W - 1)); subEv.push({ t: base + o, d: W - o, n: n0 }); }
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
      } else { const o = pickW([[1, 2], [2, 2], [3, 1]]); subEv.push({ t: base + bpb + o, d: W - bpb - o + 2, n: LADDER[sg.a1] }); }
    }
    return subEv;
  }

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
    const W = 2 * bpb; /* beats per chord */
    const subEv = subLine(rl, [0, 1, 2, 3].map((ci) => ({ base: ci * W, W, a0: anchors[2 * ci], a1: anchors[2 * ci + 1] })), bpb, LADDER); /* [{ t, d, n, from?, sb? }] */
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

  // ---------- custom progression (from a MusicXML chord chart) ----------
  // custom = { bars, mode: 'minor'|'major', chords: [{ rel, ints, q, bassRel?, roman, start, len }] }  (start/len in bars; rel = root in semitones from the tonic, -5..6;
  // ints = chord intervals above the root, e.g. [0, 4, 7, 11]). Everything is relative to the tonic, so the Key menu transposes the whole chart.
  // Chord tones in semitones above the tonic, same shape as CHORDS: root, then the chord above it, at least five tones, a ninth added for colour.
  function customTones(c) {
    const r = c.rel, ints = [...new Set(c.ints)].sort((a, b) => a - b), t = ints.map((i) => r + i);
    const has = (x) => ints.some((i) => ((i % 12) + 12) % 12 === x);
    const sus = has(5) || has(2), dim = has(6) && !has(7);
    if (t.length < 5 && !sus && !has(1) && !has(13)) t.push(r + 14);                 /* ninth (not on sus chords or where a flat/sharp ninth is already written) */
    for (const extra of [12, 19, 16, 24]) { if (t.length >= 5) break; t.push(r + (dim && extra === 19 ? 18 : extra)); }
    return [...new Set(t)].sort((a, b) => a - b);
  }

  // The slow harmony the upper voices follow: one chord per bar. In a bar with two (or more) chords the first is ignored and the last one holds the whole bar,
  // which keeps the arrangement simple and ambient. Equal neighbours merge.
  const sameChord = (a, b) => a.rel === b.rel && a.ints.join() === b.ints.join();
  function slowHarmony(custom) {
    const out = [];
    for (let b = 0; b < custom.bars; b++) {
      const here = custom.chords.filter((c) => c.start < b + 1 - 1e-6 && c.start + c.len > b + 1e-6);
      const c = here[here.length - 1] || custom.chords[0], prev = out[out.length - 1];
      if (prev && sameChord(prev, c)) prev.len += 1; else out.push({ ...c, start: b, len: 1 });
    }
    return { ...custom, chords: out };
  }

  // Open, voice-led voicings for a chord sequence. For each chord pick `count` notes inside [lo, hi] that are chord tones, spread apart (never closer than a
  // minor third, preferably a fourth or more), always carrying the third and the seventh (the notes that give a chord its character) when they fit, and
  // choose the set that keeps the most notes from the previous chord (common tones stay put) and moves the others the least. `softFor(ci)` = notes already
  // sounding that the new notes must not rub against.
  function voiceLead(root, chords, lo, hi, count, shield, softFor) {
    const out = []; let prev = [];
    const role = (i) => { const x = ((i % 12) + 12) % 12; return x === 0 ? 'r' : (x === 3 || x === 4 || x === 5 || x === 2) ? (x === 2 ? 'n' : '3') : (x === 6 || x === 7 || x === 8) ? '5' : (x === 9 || x === 10 || x === 11) ? '7' : 'n'; };
    chords.forEach((c, ci) => {
      const pcRole = new Map(); // pitch class -> role
      for (const i of c.ints) { const pc = (((root + c.rel + i) % 12) + 12) % 12; if (!pcRole.has(pc) || role(i) === '3' || role(i) === '7') pcRole.set(pc, role(i)); }
      const soft = softFor(ci), roles = new Set(pcRole.values());
      let best = null, bestCost = Infinity, cand = [];
      const need = [roles.has('3') ? '3' : null, roles.has('7') ? '7' : null].filter(Boolean);
      for (const sh of [shield, []]) { // second try: if the bass rules leave too few notes (a chord far from the key), keep only the rule against rubbing the other voices
      if (best) break;
      cand = []; for (let m = lo; m <= hi; m++) if (pcRole.has(((m % 12) + 12) % 12) && !blocked(m, sh, soft)) cand.push(m);
      for (const req of [need, need.slice(0, 1), []]) {
        for (const n of [count, count - 1]) {
          if (n < 2) continue;
          const pick = []; // depth-first over ascending candidates
          const go = (from) => {
            if (pick.length === n) {
              const have = new Set(pick.map((m) => pcRole.get(((m % 12) + 12) % 12)));
              if (!req.every((r) => have.has(r))) return;
              let cost = 0;
              for (let k = 1; k < n; k++) { const g = pick[k] - pick[k - 1]; if (g < 4) cost += 6; if (g > 12) cost += (g - 12) * 1.5; }
              cost += pick.reduce((x, m) => x + Math.abs(m - (lo + hi) / 2), 0) * 0.15;
              cost -= 2 * (have.size - req.length);
              if (prev.length) {
                const common = pick.filter((m) => prev.includes(m)).length;
                let move = 0; for (let k = 0; k < Math.min(n, prev.length); k++) move += Math.abs(pick[k] - prev[k]);
                cost += move - 8 * common;
              }
              if (cost < bestCost) { bestCost = cost; best = [...pick]; }
              return;
            }
            for (let k = from; k < cand.length; k++) {
              if (pick.length && cand[k] - pick[pick.length - 1] < 3) continue; // no seconds
              if (pick.length && cand[k] - pick[0] > 26) break;
              pick.push(cand[k]); go(k + 1); pick.pop();
            }
          };
          go(0);
          if (best) break;
        }
        if (best) break;
      }
      }
      if (!best) best = [];
      out[ci] = best; prev = best;
    });
    return out;
  }
  // Chart arrangement register. The rules for two notes sounding together are the same idea as the built-in plan's (a whole tone or closer is a clash, nothing muddy
  // below E3, and the notes near the Drone's tonic and fifth must not rub against them), but the "near the bass" zone is one octave and a second instead of 19 semitones,
  // so the upper voices can live lower.
  const LOW_C = 52, NEAR_C = 15;
  const conflictC = (m, h, shield) => {
    const d = Math.abs(m - h); if (!d) return false; if (d <= 2) return true;
    const ic = d % 12;
    if (m < LOW_C && h < LOW_C && ic !== 0 && ic !== 7) return true;
    return !!shield && d < NEAR_C && [1, 2, 6, 10, 11].includes(ic);
  };
  const blockedC = (m, shield, soft) => {
    if (shield.includes(m)) return false;
    if (shield.some((h) => conflictC(m, h, true))) return true;
    return soft.some((h) => h !== m && conflictC(m, h, false));
  };

  // One voice per octave band (low to high), so the chord tones sit in different octaves. For each chord choose one note per band from the chord's tones: no two voices
  // closer than `minGap`, the third and seventh present when they fit, pitch classes not already used by `avoidFor(ci)` preferred (no doubling between layers),
  // and the choice that keeps the most notes from the previous chord (common tones stay put) and moves the others the least.
  function voiceBands(root, chords, bands, minGap, shield, softFor, avoidFor, wantRoles = true) {
    const out = []; let prev = [];
    const role = (i) => { const x = ((i % 12) + 12) % 12; return x === 0 ? 'r' : (x === 3 || x === 4 || x === 5) ? '3' : (x === 6 || x === 7 || x === 8) ? '5' : (x === 9 || x === 10 || x === 11) ? '7' : 'n'; };
    chords.forEach((c, ci) => {
      const pcRole = new Map();
      for (const i of c.ints) { const pc = (((root + c.rel + i) % 12) + 12) % 12; if (!pcRole.has(pc) || role(i) === '3' || role(i) === '7') pcRole.set(pc, role(i)); }
      const roles = new Set(pcRole.values()), avoid = new Set((avoidFor ? avoidFor(ci) : []).map((m) => ((m % 12) + 12) % 12)), soft = softFor(ci);
      const need = wantRoles ? [roles.has('3') ? '3' : null, roles.has('7') ? '7' : null].filter(Boolean) : [];
      let best = null, bestCost = Infinity;
      const subsets = [bands.map((_, k) => k)]; for (let k = bands.length - 1; k >= 0; k--) subsets.push(bands.map((_, j) => j).filter((j) => j !== k)); // all voices, then one fewer
      for (const sh of [shield, []]) { // second try: if the bass rules leave too little (a chord far from the key), keep only the rule against rubbing the other voices
        for (const minG of [minGap, 3]) for (const req of [need, need.slice(0, 1), []]) {
          for (const use of subsets) {
            const cands = use.map((k) => { const a = []; for (let m = bands[k][0]; m <= bands[k][1]; m++) if (pcRole.has(((m % 12) + 12) % 12) && !blockedC(m, sh, soft)) a.push(m); return a; });
            if (cands.some((a) => !a.length)) continue;
            const pick = [];
            const go = (v) => {
              if (v === use.length) {
                const have = new Set(pick.map((m) => pcRole.get(((m % 12) + 12) % 12)));
                if (!req.every((r) => have.has(r))) return;
                let cost = 0;
                for (let k = 1; k < pick.length; k++) { const g = pick[k] - pick[k - 1]; if (g < 7) cost += (7 - g) * 2.5; if (g > 14) cost += (g - 14) * 1.2; }
                for (const m of pick) if (avoid.has(((m % 12) + 12) % 12)) cost += 14;
                cost -= 2 * (have.size - req.length);
                if (new Set(pick.map((m) => ((m % 12) + 12) % 12)).size < pick.length) cost += 4; // the same chord tone in two octaves: fine, but prefer different tones
                if (prev.length) {
                  const common = pick.filter((m) => prev.includes(m)).length; let move = 0;
                  for (let k = 0; k < Math.min(pick.length, prev.length); k++) move += Math.abs(pick[k] - prev[k]);
                  cost += move * 0.8 - 5 * common;
                }
                if (cost < bestCost) { bestCost = cost; best = [...pick]; }
                return;
              }
              for (const m of cands[v]) { if (pick.length && m - pick[pick.length - 1] < minG) continue; pick.push(m); go(v + 1); pick.pop(); }
            };
            go(0);
            if (best) break;
          }
          if (best) break;
        }
        if (best) break;
      }
      out[ci] = best || []; prev = out[ci];
    });
    return out;
  }
  // Notes that carry on unchanged from one chord into the next are one long note (no new attack): [{ n, t, len }] in bars.
  function heldNotes(chords, voicings) {
    const notes = [], open = new Map();
    chords.forEach((c, ci) => {
      const now = new Set(voicings[ci]);
      for (const [n, o] of [...open]) if (!now.has(n)) { notes.push({ n, t: o.t, len: o.end - o.t }); open.delete(n); }
      for (const n of now) { if (open.has(n)) open.get(n).end = c.start + c.len; else open.set(n, { t: c.start, end: c.start + c.len }); }
    });
    for (const [n, o] of open) notes.push({ n, t: o.t, len: o.end - o.t });
    return notes;
  }

  function buildCustomPlan(root, seed, custom0, bpb) {
    const full = custom0, custom = slowHarmony(custom0); /* the Sub still reads the full chart; the upper voices read the slow harmony */
    const pcOf = (n) => ((n % 12) + 12) % 12;
    const drone = [root - 12, root - 5, root], pulse = [root - 12];
    const LADDER = [root - 12, root - 5, root, root + 7];
    const chords = custom.chords.map((c) => ({ ...c, tones: customTones(c), b0: c.start * bpb, b1: (c.start + c.len) * bpb }));
    const fullChords = full.chords.map((c) => ({ ...c, tones: customTones(c), b0: c.start * bpb, b1: (c.start + c.len) * bpb }));
    const bars = custom.bars, W = 2 * bpb;
    // Sub: one segment per two bars; its anchor is the tonic or the fifth (what the Drone holds), whichever is a chord tone of the chord sounding there.
    const segs = [], sub = [];
    let prev = -1;
    const rnd = mulberry32(hash(`plan:${seed}`));
    for (let b0 = 0; b0 < bars; b0 += 2) {
      const Wb = Math.min(2, bars - b0) * bpb, anchor = [];
      const here = fullChords.filter((c) => c.b1 > b0 * bpb && c.b0 < (b0 * bpb + Wb));
      for (let k = 0; k < 2; k++) {
        const c = here[Math.min(k, here.length - 1)] || fullChords[0];
        const pcs = c.tones.map(pcOf);
        let ok = [0, 7].filter((pc) => pcs.includes(pc)); if (!ok.length) ok = [0];
        const pool = ok.filter((x) => x !== prev), src = pool.length ? pool : ok;
        const pc = prev === -1 && ok.includes(0) ? 0 : src[Math.floor(rnd() * src.length)];
        prev = pc; anchor[k] = pc === 0 ? 0 : 1;
      }
      segs.push({ base: b0 * bpb, W: Wb, a0: anchor[0], a1: anchor[1] });
      for (let b = b0; b < Math.min(b0 + 2, bars); b++) sub[b] = LADDER[anchor[b - b0]];
    }
    const subEv = subLine(mulberry32(hash(`subline:${seed}`)), segs, bpb, LADDER);
    const subNotes = (ci) => { const c = chords[ci]; return [...new Set(subEv.filter((e) => e.t < c.b1 && e.t + e.d > c.b0).map((e) => e.n))]; };
    const shieldFor = () => [...drone, ...pulse];
    const subOct = (ci) => subNotes(ci).flatMap((x) => (x < root ? [x, x + 12] : [x]));
    const voice = (chord, count, lift, shield, soft) => {
      const placed = [];
      chord.slice(0, count).forEach((n) => { const q = place(root + lift + n, shield, [...soft, ...placed]); if (q !== null) placed.push(q); });
      return placed;
    };
    const sh = shieldFor(0);
    // Pad: three voices, one per octave band (G#2-G3, A3-G#4, A4-G#5): a wide, open voicing. Atmos: two voices above it (C4-B4, C5-B5) on chord tones the pad does not use.
    const pad = voiceBands(root, chords, [[44, 56], [57, 68], [69, 80]], 5, sh, (ci) => subOct(ci));
    const atmos = voiceBands(root, chords, [[60, 71], [72, 83]], 5, sh, (ci) => [...pad[ci], ...subOct(ci)], (ci) => pad[ci], false);
    // Arp: the lower chord tones from G3 up (notes the pad or atmos hold are fine: a plucked note is short).
    const arp = chords.map((c, ci) => {
      const pcs = new Set(c.tones.map((n) => ((root + n) % 12 + 12) % 12)), a = [];
      for (let m = 55; m <= 82; m++) if (pcs.has(m % 12) && !blockedC(m, sh, subOct(ci))) a.push(m);
      return a;
    });
    const padNotes = heldNotes(chords, pad).map((p) => ({ ...p, pan: Math.max(-0.7, Math.min(0.7, (p.n - 66) / 20)) }));
    const atmosNotes = heldNotes(chords, atmos).map((p) => ({ ...p, pan: Math.max(-0.8, Math.min(0.8, (p.n - 78) / 14)) }));
    const okAbove = (midi, ci) => !blockedC(midi, shieldFor(ci), [...pad[ci], ...atmos[ci], ...subOct(ci)]);
    const fit = (midi, ci) => { for (let k = 0; k < 3; k++) if (!blockedC(midi + 12 * k, shieldFor(ci), [...pad[ci], ...atmos[ci], ...subOct(ci)])) return midi + 12 * k; return null; };
    return { chordBeats: W, cycleBeats: bars * bpb, drone, pulse, sub, subEv, subNotes, ladder: LADDER, pad, atmos, arp, padNotes, atmosNotes, okAbove, fit, shieldFor, PRIORITY, tones: chords.map((c) => c.tones), harmony: custom };
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
  /* A more natural space (Lush reverb): stereo with decorrelated channels, a pre-delay and a few sparse early reflections, a
     smooth diffuse onset, and high frequencies that die away faster than the lows (a two-pole low-pass whose cutoff slides down
     with time), like air absorption in a real hall. `rt60` is the decay time of the lows; hiStart/hiEnd/hiTau shape the darkening. */
  function makeSpaceIR(sampleRate, seconds, seed, { pre = 0.03, rt60 = 8.5, hiStart = 9000, hiEnd = 450, hiTau = 3.2, onset = 0.04, taps = 9 } = {}) {
    const rnd = mulberry32(seed), len = Math.floor(sampleRate * seconds);
    const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
    const start = Math.floor(pre * sampleRate), k = 6.9 / rt60;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let y1 = 0, y2 = 0;
      for (let i = start; i < len; i++) {
        const t = (i - start) / sampleRate;
        const fc = hiEnd + (hiStart - hiEnd) * Math.exp(-t / hiTau);
        const a = 1 - Math.exp(-2 * Math.PI * fc / sampleRate);
        y1 += a * ((rnd() * 2 - 1) - y1); y2 += a * (y1 - y2);
        const fadeOut = Math.min(1, (len - i) / (sampleRate * 0.8));
        d[i] = (y2 / Math.sqrt(a)) * Math.exp(-t * k) * Math.min(1, t / onset) * fadeOut;
      }
      for (let j = 0; j < taps; j++) { // early reflections, different in each channel
        const at = start + Math.floor((0.004 + rnd() * 0.07) * sampleRate);
        d[at] += (rnd() < 0.5 ? -1 : 1) * (0.9 - j * 0.07) * 1.5;
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
  /* Note recorder for the phones' piano roll. While a complexity layer is rendered, ctx.__ev collects [start s, length s, pitch (MIDI; null = a percussive tick)]
     for every note actually built in that layer. renderStem turns them into beats and attaches them to the buffer. */
  const rec = (ctx, t, d, p) => { if (ctx.__ev) ctx.__ev.push([t, d, p]); };
  const f2p = (f) => 69 + 12 * Math.log2(f / 440);
  function padVoice(ctx, dest, { t, dur, xf, freq, types = ['sawtooth', 'sawtooth'], detune = 8, gain = 0.1, pan = 0 }) {
    rec(ctx, t, dur, f2p(freq));
    const g = ctx.createGain(); swell(g.gain, t, dur, xf, gain);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p).connect(dest);
    types.forEach((type, i) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
      o.detune.value = (i - (types.length - 1) / 2) * detune * 2;
      o.connect(g); o.start(t); o.stop(t + dur + xf + 0.05);
    });
  }

  /* Lush voice: a thick unison. n oscillators spread across ±spread cents with a little random jitter, each panned across the
     stereo field and each with its own very slow random pitch drift (a few cents, 0.05-0.2 Hz), so the beating never settles into
     a fixed pattern. Level is normalised so a voice is about as loud as the plain padVoice it replaces. */
  const LUSH_TRIM = 0.6;
  function lushVoice(ctx, dest, { t, dur, xf, freq, types = ['sawtooth', 'sawtooth'], gain = 0.1, pan = 0, rnd, n = 5, spread = 14, drift = 4, width = 0.7 }) {
    const g = ctx.createGain(); swell(g.gain, t, dur, xf, gain * Math.sqrt(types.length / n));
    g.connect(dest);
    const end = t + dur + xf + 0.05;
    for (let i = 0; i < n; i++) {
      const u = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
      const o = ctx.createOscillator(); o.type = types[i % types.length]; o.frequency.value = freq;
      o.detune.value = u * spread + (rnd() - 0.5) * spread * 0.5;
      const d = ctx.createOscillator(); d.frequency.value = 0.05 + rnd() * 0.15;
      const dg = ctx.createGain(); dg.gain.value = (rnd() < 0.5 ? -1 : 1) * drift * (0.5 + rnd() * 0.5);
      d.connect(dg).connect(o.detune);
      const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan + u * width + (rnd() - 0.5) * 0.2));
      o.connect(p).connect(g);
      o.start(t); o.stop(end); d.start(t); d.stop(end);
    }
  }

  /* Chorus bus: the dry signal plus two slowly modulated delays panned hard left and right. LFO cycles are whole numbers per
     loop so the movement wraps seamlessly. Returns the node to connect onwards. */
  function chorusBus(ctx, input, m, { rate = 0.11, base = 0.022, depth = 0.004, mix = 0.5 } = {}) {
    const out = ctx.createGain(); input.connect(out);
    [[-0.85, 1, 0, 1], [0.85, 1.31, Math.PI / 2, 1.18]].forEach(([pan, rm, ph, bm]) => {
      const dl = ctx.createDelay(0.1); dl.delayTime.value = base * bm;
      lfo(ctx, dl.delayTime, { L: m.L, cycles: Math.max(1, Math.round(m.L * rate * rm)), depth, phase: ph });
      const w = ctx.createGain(); w.gain.value = mix;
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      input.connect(dl); dl.connect(w).connect(p).connect(out);
    });
    return out;
  }

  function pluck(ctx, dest, { t, freq, gain = 0.2, decay = 1.2, type = 'triangle', pan = 0, attack = 0.006 }) {
    rec(ctx, t, Math.min(5, decay * 0.6), f2p(freq));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2).connect(g); g.connect(p).connect(dest);
    o.start(t); o2.start(t); o.stop(t + decay + 0.05); o2.stop(t + decay + 0.05);
  }

  function bell(ctx, dest, { t, freq, gain = 0.15, decay = 5, pan = 0, attack = 0.004 }) {
    rec(ctx, t, Math.min(5, decay * 0.6), f2p(freq));
    const car = ctx.createOscillator(); car.frequency.value = freq;
    const mod = ctx.createOscillator(); mod.frequency.value = freq * 3.5;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * 2.2, t); mg.gain.exponentialRampToValueAtTime(freq * 0.05, t + decay * 0.6);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    car.connect(g).connect(p).connect(dest);
    car.start(t); mod.start(t); car.stop(t + decay + 0.05); mod.stop(t + decay + 0.05);
  }

  /* Gate length by complexity (arp, bells). A note of complexity level lv sounds as a short body in its own layer; layers 1 and 2 add a longer tail
     of the same pitch with a soft attack, so the higher the complexity, the longer the note rings before it is cut off. D = the ring time (decay) of the body, of tail 1 and of tail 2.
     Tail j lives in layer max(j, lv). play(decay, gainMultiplier, attack) makes one sound. */
  const TAIL_GAIN = [1, 0.6, 0.5];
  function gated(m, lv, D, play) {
    if (m.want(lv)) play(D[0], 1, undefined);
    for (const j of [1, 2]) if (m.want(Math.max(j, lv))) play(D[j], TAIL_GAIN[j], 0.04);
  }


  /* Rhythm templates for Pulse and Sub: the seed of the stem picks one, so "New variation" on either instrument changes the groove, not just the details. */
  const pickW = (r, w) => { const tot = w.reduce((a, b) => a + b, 0); let x = r * tot; for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; } return 0; };
  /* Pulse: hits as [beat in the bar, voice, gain, layer]; voices R tonic thump, F fifth thump, t tuned tom, u high tom. sh = the shaker over 16 sixteenths (X accent, x normal, o ghost). Layer = the complexity layer the hit belongs to (0 sparse .. 2 busy). */
  const PULSE_TPL = [
    { name: 'Heartbeat', w: 3 }, /* the original: lub-dub on beats 1 and 3, tuned toms on the off-beats, written out in pulse() itself */
    { name: 'Tresillo', w: 2, sh: 'x.o.x.o.x.o.X.o.', th: [[0, 'R', 0.55, 0], [1.5, 'F', 0.4, 0], [3, 'R', 0.42, 0], [0.75, 'F', 0.22, 1], [2.25, 't', 0.2, 1], [2.75, 't', 0.16, 2], [3.5, 'u', 0.14, 2], [1, 'u', 0.12, 2]] },
    { name: 'Four on the floor', w: 2, sh: '..o...X...o...X.', th: [[0, 'R', 0.55, 0], [1, 'F', 0.3, 0], [2, 'R', 0.5, 0], [3, 'F', 0.3, 0], [2.5, 't', 0.2, 1], [0.5, 't', 0.15, 1], [1.75, 'u', 0.14, 2], [3.75, 'u', 0.14, 2]] },
    { name: 'Half-time breath', w: 2, sh: 'x...o...x...o...', th: [[0, 'R', 0.6, 0], [2.75, 'F', 0.35, 0], [2, 'R', 0.25, 1], [3.5, 't', 0.22, 1], [1.5, 'u', 0.15, 2], [3.75, 'u', 0.14, 2]] },
    { name: 'Syncopated', w: 2, sh: 'x.ox.o.xx.o.x.ox', th: [[0, 'R', 0.55, 0], [1.75, 'R', 0.4, 0], [2.5, 'F', 0.34, 0], [3.25, 't', 0.22, 1], [0.75, 't', 0.15, 1], [3, 'u', 0.14, 2], [3.75, 'u', 0.14, 2], [1, 'F', 0.2, 2]] },
    { name: 'Rolling toms', w: 2, sh: 'o.x.o.x.o.x.o.x.', th: [[0, 'R', 0.55, 0], [2, 'R', 0.5, 0], [1, 't', 0.2, 1], [3, 't', 0.2, 1], [1.5, 'F', 0.2, 1], [0.5, 'u', 0.12, 2], [1.5, 'u', 0.12, 2], [2.5, 'u', 0.12, 2], [3.5, 'u', 0.12, 2]] },
  ];
  const PULSE_VOICE = { R: [0, -12, 0.45], F: [-5, -12, 0.35], t: [7, -5, 0.3], u: [10, 0, 0.22] }; /* [semitones from the key's tonic for the attack, for the end of the drop, decay] */
  /* Sub: [beat in the bar, length in beats, kind]; a = an anchor (D or A, as the plan), c = a chord tone, o = the anchor an octave up, k = walk up through the chord's low tones. 'breath' works per chord (2 bars) instead of per bar. */
  const SUB_TPL = [
    { name: 'Long line', w: 3 }, /* the original: the plan's long blooming line */
    { name: 'Root and chord tone', w: 2, bar: [[0, 2.5, 'a'], [2.5, 1.5, 'c']] },
    { name: 'Syncopated bass', w: 2, bar: [[0, 1.5, 'a'], [1.5, 1.5, 'c'], [3, 1, 'a']] },
    { name: 'Slow breath', w: 2, chord: [[0, 4.5, 'a'], [4.5, 3.5, 'c']] },
    { name: 'Octave bounce', w: 1, bar: [[0, 1, 'a'], [1.5, 1, 'o'], [3, 1, 'a']] },
    { name: 'Chord walk', w: 1, bar: [[0, 1.5, 'k'], [1.5, 1.5, 'k'], [3, 1, 'k']] },
  ];

  function thump(ctx, dest, { t, gain = 0.6, f0 = 95, f1 = 42, decay = 0.45 }) {
    rec(ctx, t, decay * 0.5, f2p(f0));
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(dest); o.start(t); o.stop(t + decay + 0.05);
  }

  function noiseHit(ctx, dest, noise, { t, gain = 0.05, decay = 0.08, hp = 6000, pan = 0, offset = 0 }) {
    rec(ctx, t, Math.max(decay, 0.1), null);
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


  // ---------- long, sparse mono leads: Melody A (style 'glide') = glide lead, Melody B (style 'acid') = acid line ----------
  /* Plans a few long notes. Each note is a chord tone of the chord sounding when it starts and must fit under the Pad, Atmos and
     bass of every chord it crosses (plan.okAbove) and not clash with the chords it is held over; if no note survives a crossing, the
     note is shortened to the longest length that does. Everything sits on bar lines. After a
     note the line either continues legato into the next one (a glide/slide joins them) or rests for a while. Returns
     [{ t, d, n, join, accent }] in seconds. cfg: lo/hi register (midi), lens (note lengths in bars), rest [min,max] bars, legato
     chance, maxPhrase (notes per legato phrase), wander (random leap), accent chance. */
  function planLongNotes(m, cfg) {
    const segs = []; m.forProg((chord, t0, seg, i) => segs.push({ chord, t0, t1: t0 + seg, i }));
    const L = m.L, bar = m.bar, rnd = m.rnd;
    const ok = (n, i) => !m.ambient || m.plan.okAbove(n, i);
    const rel = (n) => (((n - m.root) % 12) + 12) % 12, pcsOf = (chord) => chord.map((x) => ((x % 12) + 12) % 12);
    const isTone = (n, chord) => pcsOf(chord).includes(rel(n));
    /* A note held across a chord change must not clash with the new chord: it is fine if it is a chord tone of it, or a colour
       tone (9th, 11th, 13th...) with no chord tone a semitone above or below it. The note it starts on must be a chord tone. */
    const consonant = (n, chord) => { const r = rel(n), p = pcsOf(chord); return p.includes(r) || !p.some((q) => (((q - r) % 12) + 12) % 12 === 1 || (((r - q) % 12) + 12) % 12 === 1); };
    const segAt = (t) => segs.find((s) => t >= s.t0 - 1e-6 && t < s.t1 - 1e-6) || segs[segs.length - 1];
    const spanned = (a, b) => segs.filter((s) => s.t1 > a + 1e-6 && s.t0 < b - 1e-6);
    const cands = (a, b) => {
      const sp = spanned(a, b), out = [];
      for (let n = cfg.lo; n <= cfg.hi; n++) if (sp.every((s, k) => (k === 0 ? isTone(n, s.chord) : consonant(n, s.chord)) && ok(n, s.i)) && !(cfg.avoid && cfg.avoid(n, a, b))) out.push(n);
      return out;
    };
    const notes = []; let c = bar * (1 + Math.floor(rnd() * 2)), prev = null, phrase = 0, join = false; // everything sits on bar lines
    while (c < L - bar * 0.9) {
      const want = Math.round(cfg.lens[Math.floor(rnd() * cfg.lens.length)]);
      let d = 0, list = [];
      for (let b = want; b >= 1; b--) { const dd = Math.min(b * bar, L - c); list = cands(c, c + dd); if (list.length) { d = dd; break; } } // the longest length that stays clear of every chord it crosses
      if (!list.length) { c += bar; prev = null; phrase = 0; join = false; continue; }
      const other = prev === null ? list : list.filter((n) => n !== prev);
      if (join && !other.length) join = false;
      const pool = join ? other : list, near = prev === null ? (cfg.lo + cfg.hi) / 2 : prev;
      let best = pool[0], bs = 1e9;
      for (const n of pool) { const sc = Math.abs(n - near) + rnd() * cfg.wander; if (sc < bs) { bs = sc; best = n; } }
      notes.push({ t: c, d, n: best, join, accent: rnd() < cfg.accent });
      prev = best; phrase++;
      join = rnd() < cfg.legato && phrase < cfg.maxPhrase;
      if (join) c += d; else { c += d + bar * Math.max(1, Math.round(cfg.rest[0] + rnd() * (cfg.rest[1] - cfg.rest[0]))); phrase = 0; prev = null; }
    }
    lastLongPlan = { notes: notes.map((n) => ({ ...n })), segs: segs.map((s) => ({ t0: s.t0, t1: s.t1, pcs: pcsOf(s.chord) })), root: m.root, bar, style: m.style }; // read back by the test suite
    return notes;
  }
  let lastLongPlan = null;
  const phrasesOf = (notes) => { const out = []; for (const n of notes) { if (n.join && out.length) out[out.length - 1].push(n); else out.push([n]); } return out; };
  const driveCurve = (k) => { const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); } return c; };

  /* Glide lead: an analog mono-synth voice. Two detuned saws and a square an octave down through a resonant low-pass that opens
     on each note and settles, a little tanh warmth, and a slow vibrato that fades in. Notes in a phrase are joined by a long
     exponential glide (portamento) that takes 55-80% of the new note; the first note scoops up into pitch from two semitones below over 1.2 s and the sound fades in over 2.2 s. */
  function glideLead(ctx, dest, { notes, pan = -0.15, gain = 0.1, rnd, fast = false }) {
    for (const nt of notes) rec(ctx, nt.t, nt.d, nt.n);
    const F = fast; /* fast: the same sound for note-by-note melodies, with an attack, glides and filter moves that fit short notes (the slow set is for notes of whole bars) */
    const t0 = notes[0].t, last = notes[notes.length - 1], tEnd = last.t + last.d;
    const fin = F ? 0.04 : 2.2;
    const amp = ctx.createGain(); amp.gain.setValueAtTime(0, t0); amp.gain.linearRampToValueAtTime(gain, t0 + fin); // enters gently (2.2 s) or quickly (40 ms)
    const rel = F ? Math.max(t0 + fin + 0.01, tEnd - 0.05) : Math.max(t0 + 2.3, tEnd - 0.8);
    if (F) notes.forEach((nt, k) => { if (k > 0 && nt.t > t0 + fin + 0.02 && nt.t < rel - 0.07) { amp.gain.setValueAtTime(gain * 0.72, nt.t); amp.gain.linearRampToValueAtTime(gain, nt.t + 0.06); } }); /* a small re-gate on each joined note so repeated pitches are heard */
    amp.gain.setValueAtTime(gain, rel); amp.gain.setTargetAtTime(0, rel, F ? 0.1 : 0.7);
    const sat = ctx.createWaveShaper(); sat.curve = driveCurve(1.8); sat.oversample = '2x';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3.5;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    lp.connect(sat).connect(amp).connect(p).connect(dest);
    const vib = ctx.createOscillator(); vib.frequency.value = 5 + (rnd ? rnd() : 0.5) * 0.8;
    const vg = ctx.createGain(); vg.gain.setValueAtTime(0, t0); vg.gain.linearRampToValueAtTime(7, t0 + (F ? 0.4 : 2.5)); vib.connect(vg);
    const end = tEnd + (F ? 1.5 : 4.5); vib.start(t0); vib.stop(end);
    const cut = (n) => Math.min(2400, Math.max(550, mtof(n) * 4.2));
    notes.forEach((nt) => { // filter opens on each note, then settles
      const base = cut(nt.n);
      if (F) { lp.frequency.setTargetAtTime(base * 2.2, nt.t, 0.05); lp.frequency.setTargetAtTime(base * 0.9, nt.t + Math.min(0.15, nt.d * 0.4), 0.25); }
      else { lp.frequency.setTargetAtTime(base * 1.8, nt.t, 0.7); lp.frequency.setTargetAtTime(base * 0.85, nt.t + 2, 1.5); } // the filter opens slowly too
    });
    [['sawtooth', -7, 1, 1], ['sawtooth', 7, 1, 1], ['square', 0, 0.5, 0.55]].forEach(([type, det, mul, g]) => {
      const o = ctx.createOscillator(); o.type = type; o.detune.value = det; vg.connect(o.detune);
      const og = ctx.createGain(); og.gain.value = g * 0.5; o.connect(og).connect(lp);
      const f0 = mtof(notes[0].n) * mul;
      o.frequency.setValueAtTime(f0 * Math.pow(2, (F ? -1 : -2) / 12), t0); o.frequency.exponentialRampToValueAtTime(f0, t0 + (F ? 0.06 : 1.2));
      for (let k = 1; k < notes.length; k++) {
        const fp = mtof(notes[k - 1].n) * mul, fk = mtof(notes[k].n) * mul, gl = F ? Math.min(0.14, notes[k].d * 0.5) : notes[k].d * (0.55 + (rnd ? rnd() : 0.5) * 0.25); // the glide takes 55-80% of a long note, or at most 140 ms of a short one
        o.frequency.setValueAtTime(fp, notes[k].t); o.frequency.exponentialRampToValueAtTime(fk, notes[k].t + gl);
      }
      o.start(t0); o.stop(end);
    });
  }

  /* Acid line: a TB-303-style voice. One saw (sometimes square) into two resonant low-pass filters in series (Q 12 and 1), hard
     tanh distortion, and a filter that swells open at the start of each note then settles: accented notes open wider and
     are louder. Everything is slow: a 4 s fade-in with the filter closed at first, slides that take 55-80% of the note, a 0.5 s release. Long notes also get a slow filter "wail" halfway through, and a slow LFO drifts the cutoff. Notes that join a
     phrase are 303-style slides, slowed right down: the glide takes 55-80% of the note, with the gate held (no new attack). */
  function acidVoice(ctx, dest, { notes, pan = 0.2, gain = 0.08, rnd, L, bar, fast = false }) {
    for (const nt of notes) rec(ctx, nt.t, nt.d, nt.n);
    const F = fast || notes.some((x) => !x.join && x.d < 4.2); /* fast: quick attack, slides and filter moves for note-by-note lines (also when a note is too short for the 4 s fade-in) */
    const t0 = notes[0].t, last = notes[notes.length - 1], tEnd = last.t + last.d, end = tEnd + (F ? 1 : 4);
    const o = ctx.createOscillator(); o.type = rnd() < 0.7 ? 'sawtooth' : 'square';
    const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.Q.value = 10;
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.Q.value = 1; lp2.frequency.value = 3200;
    const dist = ctx.createWaveShaper(); dist.curve = driveCurve(5); dist.oversample = '2x';
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 70;
    const amp = ctx.createGain(); amp.gain.setValueAtTime(0, 0);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    o.connect(lp1).connect(lp2).connect(dist).connect(hp).connect(amp).connect(p).connect(dest);
    lfo(ctx, lp1.frequency, { L, cycles: Math.max(1, Math.round(L / 40)), depth: 160, phase: rnd() * 6.28 });
    notes.forEach((nt, k) => {
      const f = mtof(nt.n), floor = 260 + rnd() * 140, peak = nt.accent ? 3600 : 2300 + rnd() * 500, lvl = gain * (nt.accent ? 1.3 : 1);
      if (k === 0) o.frequency.setValueAtTime(f, nt.t);
      if (!nt.join) { // enters gently: a 4 s cosine fade-in, with the filter held low for the first second, then swelling open
        if (F) { amp.gain.setValueAtTime(0, nt.t); amp.gain.linearRampToValueAtTime(lvl, nt.t + 0.015); }
        else { const n = 64, cv = new Float32Array(n); for (let q = 0; q < n; q++) cv[q] = lvl * (0.5 - 0.5 * Math.cos(Math.PI * q / (n - 1))); amp.gain.setValueCurveAtTime(cv, nt.t, 4); }
        lp1.frequency.setValueAtTime(floor * 0.9, nt.t);
      } else { // slide: glide the pitch, hold the gate, level follows the accent
        const fp = mtof(notes[k - 1].n), gl = F ? Math.min(0.09, nt.d * 0.5) : nt.d * (0.55 + rnd() * 0.25); // a slow slide: 55-80% of the new note
        o.frequency.setValueAtTime(fp, nt.t); o.frequency.exponentialRampToValueAtTime(f, nt.t + gl);
        if (F) { amp.gain.setValueAtTime(lvl * 0.6, nt.t); amp.gain.setTargetAtTime(lvl, nt.t, 0.03); } else amp.gain.setTargetAtTime(lvl, nt.t, 0.6);
      }
      // The tone moves as slowly as the glide: one long swell per note, opening over ~the first half and closing over the rest,
      // with time constants that scale with the note (no quick snaps).
      const open = (nt.accent ? 2600 : 1400) + rnd() * 500;
      if (F) { lp1.frequency.setTargetAtTime(open, nt.t, 0.04); lp1.frequency.setTargetAtTime(floor * 1.2, nt.t + Math.min(0.2, nt.d * 0.4), 0.15); }
      else { lp1.frequency.setTargetAtTime(open, nt.t + nt.d * 0.1, Math.max(1.5, nt.d * 0.28)); lp1.frequency.setTargetAtTime(floor * 1.2, nt.t + nt.d * 0.6, Math.max(1.5, nt.d * 0.25)); }
    });
    amp.gain.setTargetAtTime(0, tEnd - (F ? 0.03 : 0.5), F ? 0.06 : 0.55);
    o.start(t0); o.stop(end);
  }

  // ---------- voices: the sound of a role, apart from the notes ----------
  /* A generator (melody, arp, chords, bass) decides WHICH notes play and builds a list of events { t, d, n (MIDI), gain, pan, accent, sus, decay, lv }.
     A voice decides what they sound like. The stem's `voice` field picks it (a kit gives each role one):
       pluck  triangle pluck with a sine octave     bell  FM bell      pad  detuned saws that swell      sub  sine bass (long notes swell, short ones pluck)
       glide  Melody A: analog glide lead           acid  Melody B: TB-303-style line                      sample  a recorded note, repitched (stem.voiceSample)
     pluck, bell, pad, sub and sample are polyphonic: every event is its own sound. glide and acid are mono: one oscillator per line, notes that
     touch are joined by a slide. Gains in events are on the pluck scale; LEVEL maps them to each voice. */
  const MONO_VOICES = new Set(['glide', 'acid']);
  const VOICE_NAMES = ['pluck', 'bell', 'pad', 'sub', 'glide', 'acid', 'sample'];
  const LEVEL = { pluck: 1, bell: 0.45, pad: 0.3, sub: 1, sample: 1 };
  const MONO_GAIN = { glide: 0.1, acid: 0.075 }; /* the level of a mono line whose events have gain 0.3 */
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function sampleNote(ctx, dest, { t, d, n, gain, pan = 0, sample }) {
    if (!sample || !sample.buf) return;
    const rate = Math.pow(2, (n - (sample.root ?? 60)) / 12), natural = sample.buf.duration / rate;
    const len = sample.loop ? Math.max(d, 0.2) : Math.min(natural, Math.max(d * 1.5, 1.2));
    rec(ctx, t, Math.min(d, len), n);
    const src = ctx.createBufferSource(); src.buffer = sample.buf; src.playbackRate.value = rate;
    if (sample.loop) { src.loop = true; src.loopStart = 0; src.loopEnd = sample.buf.duration; }
    const g = ctx.createGain(), peak = gain * (sample.gain ?? 1), rel = Math.min(0.4, len * 0.3), endT = t + len;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.004); g.gain.setValueAtTime(peak, Math.max(t + 0.01, endT - rel)); g.gain.linearRampToValueAtTime(0, endT);
    const pn = ctx.createStereoPanner(); pn.pan.value = pan;
    src.connect(g).connect(pn).connect(dest); src.start(t); src.stop(endT + 0.03);
  }
  /* The bus a voice plays into: dry, a reverb send, and a dotted-eighth echo (echo level 0 = none). */
  function voiceBus(ctx, out, verb, m, { echo = 0.28, rv = 0.9, delay = 0.75, lp = 0 } = {}) {
    const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(rv));
    if (echo > 0) {
      const dly = ctx.createDelay(2); dly.delayTime.value = m.beat * delay;
      const fb = ctx.createGain(); fb.gain.value = 0.3; const dg = ctx.createGain(); dg.gain.value = echo;
      bus.connect(dg).connect(dly);
      if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; dly.connect(f).connect(fb).connect(dly); f.connect(out); f.connect(verb.in(0.5)); }
      else { dly.connect(fb).connect(dly); dly.connect(out); dly.connect(verb.in(0.5)); }
    }
    return bus;
  }
  /* One mono line: events -> phrases (notes that touch, or that carry join: true, are one phrase) -> one glide/acid voice per phrase. slow = notes of whole bars. */
  function monoLine(ctx, dest, m, kind, evs, { gain, pan, slow = false, rnd }) {
    const sorted = [...evs].sort((a, b) => a.t - b.t);
    let prevEnd = -1e9;
    const notes = sorted.map((e, i) => { const join = e.join !== undefined ? e.join : i > 0 && Math.abs(prevEnd - e.t) < 0.02; prevEnd = e.t + e.d; return { t: e.t, d: e.d, n: e.n, join, accent: !!e.accent }; });
    for (const ph of phrasesOf(notes)) {
      if (kind === 'acid') acidVoice(ctx, dest, { notes: ph, rnd, L: m.L, bar: m.bar, pan, gain, fast: !slow });
      else glideLead(ctx, dest, { notes: ph, rnd, pan, gain, fast: !slow });
    }
  }
  /* Plays events with a voice. o: { slow (mono lines of whole bars), rnd, pan/gain overrides for mono lines (by line name) } */
  function playEvents(ctx, dest, m, voice, evs, o = {}) {
    if (!evs.length) return;
    if (MONO_VOICES.has(voice)) {
      const lines = new Map(); for (const e of evs) { const k = e.line ?? e.lv ?? 0; if (!lines.has(k)) lines.set(k, []); lines.get(k).push(e); }
      let i = 0;
      for (const [k, list] of lines) {
        const mean = list.reduce((a, e) => a + e.gain, 0) / list.length, spec = o.lines && o.lines[k] || {};
        monoLine(ctx, dest, m, voice, list, { gain: spec.gain ?? MONO_GAIN[voice] * clamp(mean / 0.3, 0.25, 1.6), pan: spec.pan ?? (voice === 'glide' ? -0.2 : 0.25) * (i++ % 2 ? -1 : 1), slow: spec.slow ?? !!o.slow, rnd: o.rnd || m.rndT });
      }
      return;
    }
    for (const e of evs) {
      const g = e.gain * (LEVEL[voice] ?? 1), pan = e.pan ?? 0, freq = mtof(e.n);
      if (voice === 'bell') bell(ctx, dest, { t: e.t, freq, gain: g, decay: e.decay ? e.decay * 2.5 : clamp(e.d * 1.5, 1.6, 7), pan });
      else if (voice === 'pad') padVoice(ctx, dest, { t: e.t, dur: Math.max(e.d, 0.3), xf: clamp(e.d * 0.3, 0.08, e.sus ? 1.2 : 0.6), freq, detune: 8, gain: g, pan });
      else if (voice === 'sub') { if (e.sus) padVoice(ctx, dest, { t: e.t, dur: e.d, xf: 0.25, freq, types: ['sine', 'triangle'], detune: 2, gain: g, pan }); else pluck(ctx, dest, { t: e.t, freq, gain: g, decay: e.decay ?? clamp(e.d, 0.4, 3), type: 'sine', pan }); }
      else if (voice === 'sample') sampleNote(ctx, dest, { t: e.t, d: e.d, n: e.n, gain: g, pan, sample: m.sample });
      else pluck(ctx, dest, { t: e.t, freq, gain: g, decay: e.decay ?? (e.sus ? clamp(e.d, 0.6, 5) : clamp(e.d * 0.9, 0.4, 3)), type: e.type || 'triangle', pan });
    }
  }
  /* A role's voice: the stem's own, else the role's default. A mono voice cannot play chords, so chords turn it into a pad. */
  const voiceOf = (m, dflt, mono = true) => { const v = VOICE_NAMES.includes(m.voice) ? m.voice : dflt; return v === 'sample' && !(m.sample && m.sample.buf) ? dflt : !mono && MONO_VOICES.has(v) ? 'pad' : v; };

  function longMelody(ctx, out, verb, m, voice = m.style) {
    const acid = voice === 'acid', mono = MONO_VOICES.has(voice);
    const cfg = acid
      ? { lo: 46, hi: 65, lens: [2, 3, 4, 4, 6], rest: [1, 3.5], legato: 0.6, maxPhrase: 3, wander: 5, accent: 0.3 }
      : { lo: 55, hi: 74, lens: [3, 4, 4, 6, 8], rest: [0.5, 3], legato: 0.6, maxPhrase: 3, wander: 6, accent: 0 };
    const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(acid ? 0.8 : 1.0));
    const dly = ctx.createDelay(2); dly.delayTime.value = m.beat * (acid ? 0.75 : 1.5);
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = acid ? 2000 : 2600;
    const fb = ctx.createGain(); fb.gain.value = 0.33; const dg = ctx.createGain(); dg.gain.value = acid ? 0.3 : 0.26;
    bus.connect(dg).connect(dly); dly.connect(dlp).connect(fb).connect(dly); dlp.connect(out); dlp.connect(verb.in(0.5));
    /* Complexity: layer 0 is the plan above (a few long notes). Layer 1 adds a second, shorter line one octave higher in the
       gaps and over the long notes, planned with a stream of its own and kept a tone away from the long notes it sounds with.
       Layer 2 adds a quieter line of shorter notes on top, in the same voice. Every line is played by the stem's voice (glide for Melody A, acid for Melody B, or any other). */
    const LINE = { a: acid ? { pan: 0.25, gain: 0.075 } : { pan: -0.2, gain: 0.1 }, b: acid ? { pan: -0.25, gain: 0.05 } : { pan: 0.25, gain: 0.065 } };
    const play = (notes, line, rnd) => {
      if (mono) { for (const ph of phrasesOf(notes)) { if (acid) acidVoice(ctx, bus, { notes: ph, rnd, L: m.L, bar: m.bar, pan: LINE[line].pan, gain: LINE[line].gain }); else glideLead(ctx, bus, { notes: ph, rnd, pan: LINE[line].pan, gain: LINE[line].gain }); } return; }
      const a = line === 'a';
      playEvents(ctx, bus, m, voice, notes.map((nt) => ({ t: nt.t, d: nt.d, n: nt.n, gain: a ? 0.2 : 0.13, pan: LINE[line].pan, sus: true, accent: nt.accent })), { slow: true });
    };
    if (m.want(0)) play(planLongNotes(m, cfg), 'a', m.rnd);
    if (m.tier === 1 || m.tier === null) {
      const saved = lastLongPlan, base = planLongNotes({ ...m, rnd: m.mkRnd() }, cfg); /* layer 0's notes, rebuilt from the same seed */
      const near = (n, a, b) => base.some((x) => x.t < b - 1e-6 && x.t + x.d > a + 1e-6 && [1, 11].includes((((n - x.n) % 12) + 12) % 12)); /* true = reject: a semitone from a long note that sounds with it */
      const cfg1 = { ...cfg, lo: cfg.lo + 12, hi: cfg.hi + 12, lens: [1, 2, 2, 3], rest: [0.5, 2], legato: 0.5, maxPhrase: 3, wander: 4, accent: 0.2, avoid: near };
      const n1 = planLongNotes({ ...m, rnd: m.rndT }, cfg1); lastLongPlan = saved;
      play(n1, 'b', m.rndT);
    }
    /* A busier line in the gaps, the same notes in every layer: its 12 strongest notes belong to layer 1 and the next 16 to layer 2.
       With layer 0 (the long notes) and layer 1's second line, that is about 4 / 16 / 32 notes per 8 bars at the sparse / medium / complex settings. */
    if (m.want(1) || m.want(2)) pluckedMelody(ctx, out, verb, { ...m, rnd: m.mkRnd() }, 'dense', 0.6, { n1: 12, n2: 16 }, voice);
  }

  /* The note-by-note melody generator. Complexity: strong beats and phrase ends in layer 0, the other beats in layer 1, the off-beats in layer 2.
     Four characters to choose from. pOn/pOff: chance of a note on a beat / off-beat; hold: extra chance after a long gap;
     step: how far each note may move (in scale steps); oct: octave shift; decay: ring time; echo: delay level. */
  const MEL_STYLES = {
    lyrical: { pOn: 0.30, pOff: 0.05, hold: 0.5, step: 3.2, oct: 0, type: 'triangle', decay: 1.0, echo: 0.28 },
    flowing: { pOn: 0.65, pOff: 0.5, hold: 0.0, step: 3.0, oct: 0, type: 'triangle', decay: 0.5, echo: 0.2 },
    leaping: { pOn: 0.42, pOff: 0.22, hold: 0.3, step: 8.0, oct: 0, type: 'triangle', decay: 0.7, echo: 0.3 },
    bright: { pOn: 0.22, pOff: 0.05, hold: 0.6, step: 4.0, oct: 12, type: 'sine', decay: 1.8, echo: 0.4 },
    dense: { pOn: 0.99, pOff: 0.4, hold: 0.0, step: 3.0, oct: 0, type: 'triangle', decay: 0.9, echo: 0.28 }, // a note on almost every beat; used for the busier layers of the long leads
  };
  /* gainMul scales the level (the busier line of the long leads is quieter). `voice` plays the notes: pluck keeps the original sound, the others are listed above. */
  /* How a character phrases its line: nb = about how many notes a bar; maxLen = the longest a note may be, in eighth notes (a note that is
     shorter than the gap to the next one leaves a rest); leap = chance of a leap; tie = chance that a note runs on into the next one (a slur,
     which the glide and acid voices join with a slide); gate = how much of its length a note sounds; adj = may play adjacent eighths. */
  const MEL_SHAPE = {
    lyrical: { nb: 3, maxLen: 5, leap: 0.12, tie: 0.35, gate: 0.85, adj: false, orn: 0.5, lift: [0, 1, 3, -1] },
    flowing: { nb: 5.5, maxLen: 2, leap: 0.15, tie: 0.15, gate: 0.8, adj: true, orn: 0, lift: [0, 2, 1, -1] },
    leaping: { nb: 4, maxLen: 3, leap: 0.3, tie: 0.1, gate: 0.8, adj: false, orn: 0.6, lift: [0, 3, 5, 0] },
    bright: { nb: 3, maxLen: 6, leap: 0.18, tie: 0.2, gate: 0.9, adj: false, orn: 0.5, lift: [1, 3, 4, 0] },
    dense: { nb: 7, maxLen: 2, leap: 0.12, tie: 0, gate: 0.7, adj: true, orn: 0, lift: [0, 1, 2, 0] },
    dflt: { nb: 4, maxLen: 3, leap: 0.2, tie: 0.2, gate: 0.85, adj: false, orn: 0.4, lift: [0, 1, 2, -1] },
  };
  /* The note-by-note melody generator, written like a topline writer works rather than by coin flips:
     - Rhythm first. A bar's rhythm is a cell: a few onsets that favour the strong places (beat 1, beat 3, then the other beats, then the off-beats),
       each note no longer than the style allows, so the line breathes: the gaps are rests. The phrase is four bars: the cell (A), A varied, a contrasting
       cell (B), and a sparser cadence cell that ends on a longer note. The next four bars reuse the same cells, so the ear hears a motif come back.
     - Then pitch. The motif has a contour (steps up and down, now and then a leap that is answered by a step back). Each bar starts on a chord tone of its
       chord near where the last bar stopped and replays the contour from there; notes on strong beats are pulled to chord tones, the others pass between them.
       The end of a four-bar phrase leans to the next chord's tone, the end of the loop lands on the tonic.
     - Then choose. Twelve whole lines are written and scored (chord tones on strong beats, small leaps, no long runs of one note, range, how much is
       repeated, rests present, a good ending); the best one is played. Same seed, same line: the layers are cut from it, not re-rolled. */
  function pluckedMelody(ctx, out, verb, m, styleKey, gainMul, ranked = null, voice = 'pluck') {
    const st = MEL_STYLES[styleKey] || { pOn: 0.38, pOff: 0.16, hold: 0.4, step: 4.4, oct: 0, type: 'triangle', decay: 0.8, echo: 0.28 };
    const P = MEL_SHAPE[styleKey] || MEL_SHAPE.dflt;
    const poolAll = [];
    const mb = m.custom ? 0 : 12; /* a chord chart plays the melody an octave lower */
    for (let o = 0; o < 3; o++) for (const d of m.scale) { const n = m.root + mb + o * 12 + d; if (n <= m.root + mb + 19) poolAll.push(n); }
    const pcs = (chord) => chord.map((n) => ((n % 12) + 12) % 12);
    const isTone = (n, chord) => pcs(chord).includes(((n - m.root) % 12 + 12) % 12);
    const slot = m.beat / 2, barSlots = m.bpb * 2, rnd = m.rnd;
    const segs = []; m.forProg((chord, t0, seg, i, cnt) => segs.push({ chord, t0, seg, i, next: m.prog[(i + 1) % cnt], lastSeg: !m.ambient && i === cnt - 1 }));
    const poolOf = (sg) => { if (!m.ambient) return poolAll; const ok = poolAll.filter((n) => m.plan.okAbove(n + st.oct, sg.i)); return ok.length ? ok : poolAll; }; // notes that fit under this chord's pad/atmos/bass
    const bars = []; segs.forEach((sg) => { const n = Math.max(1, Math.round(sg.seg / m.bar)); for (let b = 0; b < n; b++) { const t = sg.t0 + b * m.bar; bars.push({ sg, t, slots: Math.max(1, Math.min(barSlots, Math.round((sg.t0 + sg.seg - t) / slot))), lastOfSeg: b === n - 1 }); } });
    const wSlot = (x) => (x === 0 ? 1 : x % 4 === 0 ? 0.8 : x % 2 === 0 ? 0.5 : P.adj ? 0.42 : 0.22);
    const pickIdx = (list, w) => { let tot = 0; for (const x of list) tot += w(x); let r = rnd() * tot; for (const x of list) { r -= w(x); if (r <= 0) return x; } return list[list.length - 1]; };
    const makeCell = (slots, sparse) => { /* [{ s: onset slot, len: slots }] */
      const k = Math.max(2, Math.min(slots, Math.round(P.nb * (sparse ? 0.6 : 0.7 + rnd() * 0.6)))), on = new Set();
      if (rnd() < 0.85) on.add(0);
      for (let guard = 0; on.size < k && guard < 60; guard++) {
        const free = []; for (let x = 0; x < slots; x++) if (!on.has(x) && (P.adj || (!on.has(x - 1) && !on.has(x + 1)))) free.push(x);
        if (!free.length) break; on.add(pickIdx(free, wSlot));
      }
      const o = [...on].sort((x, y) => x - y);
      const cell = o.map((s, j) => ({ s, len: Math.max(1, Math.min((o[j + 1] ?? slots) - s, P.maxLen)) }));
      if (!sparse && rnd() < P.orn) { /* a pick-up or passing eighth on an off-beat: it cuts the note it lands in short (this is what the busiest layer adds) */
        const odd = []; for (let x = 1; x < slots; x += 2) if (!on.has(x)) odd.push(x);
        if (odd.length) { const x = odd[Math.floor(rnd() * odd.length)], c = cell.filter((q) => q.s < x).pop(); if (c) { c.len = Math.min(c.len, x - c.s); cell.push({ s: x, len: 1 }); cell.sort((a, b) => a.s - b.s); } }
      }
      return cell;
    };
    const vary = (cell, slots) => { /* the same rhythm with one change: a note moved by an eighth, or one dropped */
      const c = cell.map((x) => ({ ...x })); if (c.length < 3) return c;
      const j = 1 + Math.floor(rnd() * (c.length - 1));
      if (rnd() < 0.5) { const nx = c[j].s + (rnd() < 0.5 ? -1 : 1); if (nx > (c[j - 1].s) && nx < (c[j + 1] ? c[j + 1].s : slots)) c[j].s = nx; } else c.splice(j, 1);
      return c.map((x, q) => ({ s: x.s, len: Math.max(1, Math.min((c[q + 1] ? c[q + 1].s : slots) - x.s, P.maxLen)) }));
    };
    const makeDeltas = (k) => { /* the contour, in scale steps from note to note: it rises through the first half of the bar and falls through the second, or the reverse */
      const d = [0]; let back = 0; const flip = rnd() < 0.5 ? -1 : 1;
      for (let j = 1; j < k; j++) {
        const bias = (j < k / 2 ? 1 : -1) * flip;
        if (back) { d.push(back); back = 0; continue; }
        const r = rnd();
        if (r < P.leap) { const L = (3 + Math.floor(rnd() * 3)) * (rnd() < 0.5 ? -bias : bias); d.push(L); back = L > 0 ? -1 : 1; } /* a leap is answered by a step back */
        else d.push(r < P.leap + 0.1 ? 0 : (rnd() < 0.7 ? bias : -bias) * (rnd() < 0.75 ? 1 : 2));
      }
      return d;
    };
    const build = () => {
      const A = makeCell(barSlots), A1 = vary(A, barSlots), B = makeCell(barSlots), C0 = makeCell(barSlots, true);
      const C = C0.length ? C0.map((x) => ({ ...x })) : A; const lastC = C[C.length - 1]; if (lastC.s < Math.floor(barSlots / 2)) C.push({ s: Math.floor(barSlots / 2), len: 1 });
      C[C.length - 1].len = Math.min(P.maxLen + 2, barSlots - C[C.length - 1].s); /* the cadence ends on a longer note */
      const dA = makeDeltas(Math.max(A.length, A1.length, 8)), dB = makeDeltas(Math.max(B.length, 8));
      const evs = []; let cur = null, pool = poolAll;
      bars.forEach((bar, bi) => {
        const pos = bi % 4, cell = (pos === 0 ? A : pos === 1 ? A1 : pos === 2 ? B : C).filter((x) => x.s < bar.slots), D = pos === 2 ? dB : dA;
        if (!cell.length) return;
        const sg = bar.sg; pool = poolOf(sg);
        const nearest = (n, pred) => pool.filter(pred).sort((x, y) => Math.abs(x - n) - Math.abs(y - n))[0] ?? n;
        if (cur === null) cur = nearest(m.root + mb + 7, (n) => isTone(n, segs[0].chord));
        /* where the bar starts: the phrase's contour (P.lift: a gentle arch over four bars, a step higher the second time round) around the fifth of the key */
        const home = pool.indexOf(nearest(m.root + mb + 7, () => true)), lift = P.lift[pos] + (Math.floor(bi / 4) % 2);
        const aim = pool[Math.max(0, Math.min(pool.length - 1, (home < 0 ? 0 : home) + lift))];
        let idx = pool.indexOf(nearest(aim, (n) => isTone(n, sg.chord)));
        if (idx < 0) idx = 0;
        const barEnd = bi === bars.length - 1, cadence = pos === 3 || barEnd;
        cell.forEach((nt, j) => {
          if (j > 0) idx = Math.max(0, Math.min(pool.length - 1, idx + D[j % D.length]));
          let n = pool[idx];
          const strong = nt.s % 4 === 0, final = j === cell.length - 1 && cadence && bar.lastOfSeg;
          if (final) n = barEnd && sg.lastSeg ? nearest(cur, (x) => (x - m.root) % 12 === 0) : nearest(n, (x) => isTone(x, sg.next));
          else if (strong || j === 0) n = nearest(n, (x) => isTone(x, sg.chord));
          idx = pool.indexOf(n); if (idx < 0) idx = 0; cur = n;
          const tie = !final && P.tie > 0 && j < cell.length - 1 && cell[j + 1].s === nt.s + nt.len && rnd() < P.tie;
          const lv = strong || final ? 0 : nt.s % 2 === 0 ? 1 : 2; /* complexity: strong beats and phrase ends, then the other beats, then the off-beats */
          const dur = nt.len * slot * (tie ? 1 : P.gate * (0.92 + rnd() * 0.12)), pan = (rnd() - 0.5) * 0.4;
          evs.push({ lv, key: 0, first: strong || final ? 0 : 1, strong, final, tie, t: bar.t + nt.s * slot, n: n + st.oct, dur, gain: (strong ? 0.32 : 0.25) * (st.oct ? 0.75 : 1) * gainMul, decay: Math.min(3, st.decay + dur), type: st.type, pan, chord: sg.chord });
        });
      });
      return evs;
    };
    const score = (evs) => {
      if (!evs.length) return -1e9;
      let sc = 0, strongN = 0, strongTone = 0, run = 1, rests = 0;
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i], pv = evs[i - 1];
        if (e.strong) { strongN++; if (isTone(e.n - st.oct, e.chord)) strongTone++; }
        if (pv) {
          const iv = Math.abs(e.n - pv.n); if (iv > 9) sc -= 2; else if (iv > 5 && !P.leap) sc -= 1;
          if (iv === 0) { run++; if (run > 2) sc -= 1.5; } else run = 1;
          if (e.t - (pv.t + pv.dur) > slot * 1.5) rests++;
        }
      }
      sc += 4 * (strongN ? strongTone / strongN : 1) + Math.min(rests, bars.length) * 0.4;
      const per = evs.length / Math.max(1, bars.length); sc -= Math.abs(per - P.nb) * 0.6;
      const ns = evs.map((e) => e.n), span = Math.max(...ns) - Math.min(...ns); sc -= span > 14 ? (span - 14) * 0.5 : 0; sc -= span < 4 ? 2 : 0;
      const sig = (b) => evs.filter((e) => e.t >= bars[b].t - 1e-6 && e.t < bars[b].t + m.bar - 1e-6).map((e) => Math.round((e.t - bars[b].t) / slot)).join();
      const seen = new Set(); let rep = 0; for (let b = 0; b < bars.length; b++) { const k = sig(b); if (seen.has(k)) rep++; seen.add(k); } sc += Math.min(rep, 3) * 0.6;
      const last = evs[evs.length - 1]; if (isTone(last.n - st.oct, last.chord)) sc += 1.5;
      return sc;
    };
    let evs = null, bestSc = -1e9;
    for (let c = 0; c < 12; c++) { const cand = build(), sc = score(cand); if (sc > bestSc) { bestSc = sc; evs = cand; } }
    evs = evs || [];
    if (ranked) for (const e of evs) e.key = rnd(); /* (drawn after the choice, so the dense line's order is its own) */
    if (ranked) { /* strong beats and phrase ends first, then the rest in a fixed random order: the first n1 are layer 1, the next n2 layer 2 */
      [...evs].sort((a, b) => a.first - b.first || a.key - b.key).forEach((e, k) => { e.lv = k < ranked.n1 ? 1 : k < ranked.n1 + ranked.n2 ? 2 : -1; });
    }
    const mine = evs.filter((e) => e.lv >= 0 && m.want(e.lv));
    if (voice === 'pluck') { /* the original sound */
      const bus = voiceBus(ctx, out, verb, m, { echo: st.echo, rv: 0.9, delay: 0.75 });
      for (const e of mine) pluck(ctx, bus, { t: e.t, freq: mtof(e.n), gain: e.gain, decay: e.decay, type: e.type, pan: e.pan });
      return;
    }
    const bus = voiceBus(ctx, out, verb, m, { echo: st.echo, rv: 0.9, delay: 0.75 });
    const events = mine.map((e) => { /* a mono voice joins notes that touch (a slur) and leaves the gaps between the others */
      const d = MONO_VOICES.has(voice) && ranked ? Math.min(e.dur, m.beat * 0.9) : e.dur;
      return { t: e.t, d, n: e.n, gain: e.gain, pan: e.pan, accent: e.strong, decay: e.decay, type: e.type, lv: e.lv, line: e.lv };
    });
    playEvents(ctx, bus, m, voice, events, { rnd: m.rndT, lines: ranked ? { 1: { gain: voice === 'acid' ? 0.04 : 0.05, pan: 0.3 }, 2: { gain: voice === 'acid' ? 0.035 : 0.04, pan: -0.3 } } : null });
  }

  // ---------- stems ----------
  // Each builder receives: ctx, out (dry bus), verb (reverb send), m (musical context)
  const BUILDERS = {
    drone(ctx, out, verb, m) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 0.7;
      lfo(ctx, f.frequency, { L: m.L, cycles: 2, depth: 350 });
      f.connect(out); f.connect(verb.in(0.6));
      const xf = Math.min(4, m.L / 4);
      // One octave lower than before: tonic, fifth and octave starting at the lowest tonic that is still at or above C1 (32.7 Hz).
      // Low keys (Ab, A, Bb, B) were already that low, so they stay where they were.
      const low = m.root - 24 >= 24 ? m.root - 24 : m.root - 12;
      [[low, 0.18, -0.3], [low + 7, 0.11, 0.3], [low + 12, 0.06, 0]].forEach(([n, g, pan]) =>
        padVoice(ctx, f, { t: 0, dur: m.L, xf, freq: mtof(n), types: ['sawtooth', 'triangle', 'sawtooth'], detune: 6, gain: g, pan }));
    },

    pad(ctx, out, verb, m) {
      const lush = m.lush.voices;
      // Lush: a thick, drifting unison for every note, then a chorus. Plain: the original three-oscillator voice.
      const voice = (dest, o, spread = 14) => lush ? lushVoice(ctx, dest, { ...o, gain: o.gain * LUSH_TRIM, rnd: m.rnd, n: 5, spread }) : padVoice(ctx, dest, o); // trim: the unison, chorus and bigger reverb send add level
      // Lush: a quiet sine an octave under the lowest note, only where it lands on a note the Drone already holds (tonic or fifth).
      const subOct = (dest, t, dur, xf, n) => {
        const s = n - 12, pc = (((s - m.root) % 12) + 12) % 12;
        if (lush && s >= m.root - 12 && (pc === 0 || pc === 7)) padVoice(ctx, dest, { t, dur, xf, freq: mtof(s), types: ['sine'], detune: 0, gain: 0.03 });
      };
      if (m.plan.padNotes) { // chord chart: open, voice-led notes; common tones are held, and the sound is warmer (triangle + sine with a little saw) and slow to change
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1000; f.Q.value = 0.5;
        lfo(ctx, f.frequency, { L: m.L, cycles: 1, depth: 350, phase: 1 });
        const bus = lush ? chorusBus(ctx, f, m) : f; bus.connect(out); bus.connect(verb.in(1.0));
        const xf = Math.min(3, m.bar * 0.9);
        for (const p of m.plan.padNotes) {
          voice(f, { t: p.t * m.bar, dur: p.len * m.bar, xf, freq: mtof(p.n), types: ['triangle', 'sine', 'sawtooth'], detune: 5, gain: 0.05, pan: p.pan }, 12);
          if (!m.plan.padNotes.some((q) => q !== p && q.t < p.t + p.len && q.t + q.len > p.t && q.n < p.n)) subOct(f, p.t * m.bar, p.len * m.bar, xf, p.n);
        }
        return;
      }
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400; f.Q.value = 1.2;
      lfo(ctx, f.frequency, { L: m.L, cycles: 1, depth: 700, phase: 1 });
      const bus = lush ? chorusBus(ctx, f, m) : f; bus.connect(out); bus.connect(verb.in(0.8));
      m.forChords((chord, t, seg, ci) => {
        m.plan.pad[ci].forEach((note, i) => // voicing from the plan: tones that rub against the bass are lifted
          voice(f, { t, dur: seg, xf: 1.6, freq: mtof(note), detune: 9, gain: 0.045, pan: (i - 1.5) * 0.35 }, 16));
        subOct(f, t, seg, 1.6, Math.min(...m.plan.pad[ci]));
      });
    },

    // Atmos: a blend-style layer. Two timbres (a soft triangle/sine choir and a brighter filtered saw) play the same chord
    // tones, and a slow LFO crossfades between them over the loop (2 full cycles), so the colour keeps slowly morphing.
    // Notes avoid the Drone like the other melodic stems.
    atmos(ctx, out, verb, m) {
      const lush = m.lush.voices, shim = m.lush.verb; // shim: each note also sends an octave-up sine only into the reverb, so the tail blooms upward
      const voice = (dest, o, spread, n = 5) => lush ? lushVoice(ctx, dest, { ...o, gain: o.gain * LUSH_TRIM, rnd: m.rnd, n, spread }) : padVoice(ctx, dest, o);
      const soft = ctx.createGain(), bright = ctx.createGain(), lp = ctx.createBiquadFilter(), mix = ctx.createGain();
      soft.gain.value = 0.5; bright.gain.value = 0.5;
      lfo(ctx, soft.gain, { L: m.L, cycles: 2, depth: 0.5, phase: 0 });
      lfo(ctx, bright.gain, { L: m.L, cycles: 2, depth: 0.5, phase: Math.PI });
      lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 0.8;
      lfo(ctx, lp.frequency, { L: m.L, cycles: 2, depth: 900, phase: Math.PI });
      soft.connect(mix); bright.connect(lp); lp.connect(mix);
      const bus = lush ? chorusBus(ctx, mix, m, { rate: 0.09, base: 0.026, depth: 0.005 }) : mix; bus.connect(out); bus.connect(verb.in(1.0));
      const shimBus = shim ? ctx.createGain() : null; if (shim) { shimBus.gain.value = 0.5; shimBus.connect(verb.in(2.0)); }
      const note = (t, dur, xf, n, pan) => {
        voice(soft, { t, dur, xf, freq: mtof(n), types: ['triangle', 'sine'], detune: 5, gain: 0.04, pan }, 10);
        voice(bright, { t, dur, xf, freq: mtof(n), types: ['sawtooth'], detune: 7, gain: 0.018, pan: -pan }, 16, 3);
        if (shim && n + 12 < 100) padVoice(ctx, shimBus, { t, dur, xf, freq: mtof(n + 12), types: ['sine'], detune: 0, gain: 0.03, pan });
      };
      if (m.plan.atmosNotes) { // chord chart: open notes above the pad, common tones held
        const xf = Math.min(3.6, m.bar * 1.1);
        for (const p of m.plan.atmosNotes) note(p.t * m.bar, p.len * m.bar, xf, p.n, p.pan);
        return;
      }
      m.forChords((chord, t, seg, ci) => m.plan.atmos[ci].forEach((n, i) => note(t, seg, 2.4, n, (i - 2) * 0.3)));
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
        rec(ctx, t, dur, midi);
        const g = ctx.createGain(), end = t + dur;
        const a = Math.min(attack, dur * 0.5), r = release;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + a);
        if (from !== null) { /* dip a little while the pitch settles, so the scoop is soft */
          const t1 = Math.max(t + 0.1, t + a), t2 = t1 + slideSec; /* start the dip only once the fade-in has finished: setting the gain to its full value mid fade-in was a click */
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
      /* Complexity: layer 0 is one long note per chord (the original sound). Layers 1 and 2 make the bass pulse on the bar's root:
         layer 1 a soft pulse on every beat (quarter notes), layer 2 the pulses in between (eighth notes). The pulses are short, with a touch of the octave above so they carry on small speakers. */
      const extras = () => {
        for (let b = 0; b < nBars; b++) {
          const root = m.plan.sub[b % m.plan.sub.length], t0 = b * m.bar;
          for (let k = 0; k < m.bpb; k++) {
            const acc = k === 0 ? 1 : 0.8;
            if (m.want(1)) { pluck(ctx, f, { t: t0 + k * B, freq: mtof(root), gain: 0.7 * acc, decay: 0.55, type: 'sine' }); pluck(ctx, f, { t: t0 + k * B, freq: mtof(root + 12), gain: 0.25 * acc, decay: 0.35, type: 'sine' }); }
            if (m.want(2)) { pluck(ctx, f, { t: t0 + (k + 0.5) * B, freq: mtof(root), gain: 0.5, decay: 0.35, type: 'sine' }); pluck(ctx, f, { t: t0 + (k + 0.5) * B, freq: mtof(root + 12), gain: 0.18, decay: 0.25, type: 'sine' }); }
          }
        }
      };
      const forcedS = m.tpl ? SUB_TPL.findIndex((x) => x.name === m.tpl) : -1; /* a rhythmic template names the groove; otherwise the seed picks one */
      const si = strict || m.bpb !== 4 ? 0 : forcedS >= 0 ? forcedS : pickW(m.mkRnd()(), SUB_TPL.map((x) => x.w)), stpl = SUB_TPL[si]; m.tplName = strict ? 'Strict' : stpl.name;
      if (si > 0) { /* a rhythm template: the notes are the anchors (D / A) or chord tones in the Sub's own range that do not clash with the drone's pitches or the pad, atmos and arp notes of that chord */
        const root = m.root, ladder = m.plan.ladder || [root - 12, root - 5, root, root + 7], drone = m.plan.drone || [root - 12, root - 5, root];
        const pcOf = (n) => ((n % 12) + 12) % 12;
        m.forChords((chord, t0, seg, ci) => {
          const rr = mulberry32(hash(`${m.seed}:subtpl:${si}:${ci}`));
          const pcs = chord.map(pcOf), soft = [...((m.plan.pad && m.plan.pad[ci]) || []), ...((m.plan.atmos && m.plan.atmos[ci]) || []), ...((m.plan.arp && m.plan.arp[ci]) || [])];
          let anc = (m.plan.subNotes ? m.plan.subNotes(ci) : []).filter((n) => n < root + 8); if (!anc.length) anc = [root - 12];
          const low = []; for (let n = root - 12; n <= root + 7; n++) if (pcs.includes(pcOf(n)) && !drone.some((h) => [1, 2].includes(Math.abs(n - h))) && !blocked(n, [], soft)) low.push(n);
          const alt = low.filter((n) => !ladder.includes(n)), pool = [...new Set([...anc, ...low])].sort((x, y) => x - y);
          const W = Math.round(seg / B); let kStep = 0;
          const evs = [];
          if (stpl.chord) evs.push(...stpl.chord.map(([b, d, k]) => [b, Math.min(d, W - b), k]));
          else for (let bar = 0; bar < Math.floor(W / m.bpb); bar++) for (const [b, d, k] of stpl.bar) evs.push([bar * m.bpb + b, d, k]);
          for (const [b, d, kind] of evs) {
            const r1 = rr(), r2 = rr(), a0 = anc[Math.floor(r1 * anc.length)];
            let n = a0;
            if (kind === 'c') n = alt.length && r2 < 0.65 ? alt[Math.floor(r2 / 0.65 * alt.length)] : anc[(anc.indexOf(a0) + 1) % anc.length] ?? a0;
            else if (kind === 'o') n = a0 + 12 <= root + 7 ? a0 + 12 : a0;
            else if (kind === 'k') n = pool[(kStep++ + ci) % pool.length];
            if (m.want(0)) note(t0 + b * B, d * B, n, { attack: Math.min(0.3, d * B * 0.3), release: 0.9 + r2 * 0.8 });
          }
        });
        extras(); return;
      }
      if (strict) { if (m.want(0)) for (let b = 0; b < nBars; b++) note(b * m.bar, m.bar, m.plan.sub[b % m.plan.sub.length], { attack: 0.35, release: 0.35 }); extras(); return; }
      for (let c = 0; c < Math.round(m.L / (B * m.plan.chordBeats)); c++) f.frequency.setValueAtTime(150 + m.rnd() * 110, c * B * m.plan.chordBeats);
      const cycle = (m.plan.cycleBeats ?? m.plan.chordBeats * 4) * B;
      for (let rep = 0; rep * cycle < m.L - 1e-6; rep++) {
        const seen = {};
        for (const e of m.plan.subEv) {
          const w = Math.floor(e.t / m.plan.chordBeats), lv = Math.min(2, seen[w] = (seen[w] ?? -1) + 1); /* the 1st, 2nd and later note of its chord */
          const attack = 0.9 + m.rnd() * 0.8, release = 1.4 + m.rnd() * 1.0;
          if (lv > 0 || !m.want(0)) continue; /* the leap and the scoop are no longer part of any layer: the bass pulses instead (see extras) */
          note(rep * cycle + e.t * B, e.d * B, e.n, { attack, release, from: e.from ?? null, slideSec: (e.sb || 0) * B });
        }
      }
      extras();
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
      /* Complexity: layer 0 plays every other beat, layer 1 the beats in between plus the off-beat eighths (the original pattern, with its random gaps),
         layer 2 adds quiet sixteenth-note fills, now and then an octave up. */
      m.forChords((chord, t0, seg, ci) => {
        const steps = Math.round(seg / step), tones = m.plan.arp[ci];
        if (!tones.length) return;
        for (let s = 0; s < steps; s++) {
          const skip = m.rnd() < 0.18, g = m.rnd(), g16 = m.rnd(), pick = m.rnd(), oct = m.rnd(); /* the same draws in every layer */
          const note = tones[pattern[s % pattern.length] % tones.length], lv = s % 4 === 0 ? 0 : 1;
          if (!(lv > 0 && skip)) gated(m, lv, [0.35, 1.4, 3.2], (decay, mul, attack) => pluck(ctx, bus, { t: t0 + s * step, freq: mtof(note), gain: (0.11 + g * 0.07) * mul, decay, attack, pan: Math.sin(s * 0.9) * 0.5 }));
          if (pick < 0.55) gated(m, 2, [0.25, 0.9, 2.0], (decay, mul, attack) => pluck(ctx, bus, { t: t0 + s * step + step / 2, freq: mtof(tones[pattern[(s + 1) % pattern.length] % tones.length] + (oct < 0.3 ? 12 : 0)), gain: (0.05 + g16 * 0.04) * mul, decay, attack, pan: Math.sin(s * 0.9 + 1) * 0.5 }));
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

    beats(ctx, out, verb, m) {
      // A pattern player for one-shot recordings (hand drums, bass drums...). The pack gives each stem `voices` (name -> { files (decoded by the engine into m.samples), gain, pan, lane, tune })
      // and `tiers`: three objects, voice name -> pattern, for the three complexity layers (0 = the sparse base, 1 and 2 add hits).
      // A pattern is one line per bar, separated by "|", repeated to fill the loop; each character is one step (`steps` per beat, default 4):
      //   X accent   x normal   o ghost   p a ghost that only sounds about half the time   . rest
      // A voice lists its recordings soft to hard; the hit's strength picks among them, with a little random timing, strength and tuning so it breathes.
      const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(0.12));
      const P = m.pattern || {}, voices = P.voices || {}, tiers = P.tiers || [], spb = Math.max(1, P.steps || 4);
      const stepsPerBar = m.bpb * spb, total = Math.round(m.L / m.beat) * spb, stepLen = m.beat / spb;
      const levels = m.tier === null ? [0, 1, 2] : [m.tier], VEL = { X: 1, x: 0.72, o: 0.4, p: 0.5 };
      const names = Object.keys(voices);
      for (const lv of levels) {
        const rnd = mulberry32(hash(`beats:${m.seed ?? ''}:${lv}:${names.join()}`)), pat = tiers[lv] || {};
        names.forEach((name, vi) => {
          const line = pat[name], bufs = (m.samples && m.samples[name]) || [], v = voices[name] || {};
          if (!line || !bufs.length) return;
          const bars = String(line).split('|').map((q) => q.replace(/\s+/g, '')).filter(Boolean); if (!bars.length) return;
          const pan = ctx.createStereoPanner(); pan.pan.value = Math.max(-1, Math.min(1, v.pan || 0)); pan.connect(bus);
          for (let st = 0; st < total; st++) {
            const bar = Math.floor(st / stepsPerBar), ch = bars[bar % bars.length][st % stepsPerBar];
            if (!ch || ch === '.' || !(ch in VEL)) continue;
            const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd(); /* always drawn, so a change to one hit leaves the others as they were */
            if (ch === 'p' && r1 < 0.5) continue;
            const vel = Math.max(0.15, Math.min(1, VEL[ch] * (0.9 + 0.2 * r2)));
            const idx = Math.max(0, Math.min(bufs.length - 1, Math.round(vel * (bufs.length - 1) + (r3 - 0.5) * 1.4)));
            const t = Math.max(0, st * stepLen + (ch === 'X' ? 0 : (r4 - 0.5) * 0.014)); /* accents stay on the grid; the rest drift by a few milliseconds */
            const src = ctx.createBufferSource(); src.buffer = bufs[idx];
            src.playbackRate.value = Math.pow(2, ((v.tune || 0) + (r1 - 0.5) * 0.12) / 12);
            const g = ctx.createGain(); g.gain.value = (v.gain ?? 0.8) * (0.4 + 0.6 * vel);
            src.connect(g).connect(pan); src.start(t);
            rec(ctx, t, Math.min(bufs[idx].duration, 0.5), v.lane ?? 36 + vi * 4);
          }
        });
      }
    },

    pulse(ctx, out, verb, m) {
      // A slow collective heartbeat (lub-dub on beats 1 and 3) + soft shaker.
      // Complexity: layer 0 is the heartbeat's first thump only; layer 1 adds the second thump and the shaker's eighth notes;
      // layer 2 adds the sixteenth-note shaker, the pick-up before the bar line and a ghost thump.
      const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(0.15));
      const beats = Math.round(m.L / m.beat);
      const forcedP = m.tpl ? PULSE_TPL.findIndex((x) => x.name === m.tpl) : -1;
      const ti = m.bpb === 4 ? (forcedP >= 0 ? forcedP : pickW(m.mkRnd()(), PULSE_TPL.map((x) => x.w))) : 0, tpl = PULSE_TPL[ti]; m.tplName = tpl.name;
      if (ti > 0) { /* a rhythm template (4/4): the hits are the template's, the details (skipped shaker hits, pick-ups) are still drawn from the seed */
        const bars = Math.round(beats / 4);
        for (let bar = 0; bar < bars; bar++) {
          for (const [pos, v, g, lv] of tpl.th) {
            const skip = m.rnd() < (lv === 0 ? 0 : 0.1), jit = m.rnd();
            if (skip || !m.want(lv)) continue;
            const [a, z, dec] = PULSE_VOICE[v];
            thump(ctx, bus, { t: (bar * 4 + pos) * m.beat, gain: g * (0.9 + jit * 0.2), f0: mtof(m.root + a), f1: mtof(m.root + z), decay: dec });
          }
          for (let s = 0; s < 16; s++) {
            const ch = tpl.sh[s], acc = ch === 'X' ? 1 : ch === 'x' ? 0.5 : ch === 'o' ? 0.3 : 0;
            const skip = m.rnd() < 0.12, g = m.rnd(), pn = m.rnd(), off = m.rnd();
            if (!acc || skip || !m.want(s % 2 === 0 ? 1 : 2)) continue;
            noiseHit(ctx, bus, m.noise, { t: (bar * 4 + s / 4) * m.beat, gain: 0.06 * acc * (0.7 + g * 0.6), decay: 0.07, hp: 7000, pan: (pn - 0.5) * 0.8, offset: off * 5 });
          }
          if (bar % 4 === 3) { /* the turnaround at the end of every four bars */
            const pickup = m.rnd() < 0.6, off = m.rnd(), ghost = m.rnd() < 0.5;
            if (pickup && m.want(2)) noiseHit(ctx, bus, m.noise, { t: (bar * 4 + 3.5) * m.beat, gain: 0.08, decay: 0.12, hp: 2500, offset: off * 5 });
            if (ghost && m.want(2)) thump(ctx, bus, { t: (bar * 4 + 3.5) * m.beat, gain: 0.3, f0: mtof(m.root - 5), f1: mtof(m.root - 12), decay: 0.3 });
          }
        }
        return;
      }
      for (let b = 0; b < beats; b++) {
        const t = b * m.beat, inBar = b % m.bpb;
        if (inBar === 0 || inBar === Math.floor(m.bpb / 2)) {
          // tuned to the key: each beat drops onto the tonic (D2 in D), the same D the Drone and Sub sit on
          if (m.want(0)) thump(ctx, bus, { t, gain: 0.55, f0: mtof(m.root), f1: mtof(m.root - 12) });
          if (m.want(1)) thump(ctx, bus, { t: t + 0.22, gain: 0.32, f0: mtof(m.root - 5), f1: mtof(m.root - 12), decay: 0.35 });
        }
        /* more drum voices as the complexity rises: layer 1 a tuned tom on the off-beat after beats 2 and 4, layer 2 another on the last sixteenth of every beat */
        if (inBar % 2 === 1 && m.want(1)) thump(ctx, bus, { t: t + m.beat / 2, gain: 0.2, f0: mtof(m.root + 7), f1: mtof(m.root - 5), decay: 0.3 });
        if (m.want(2)) thump(ctx, bus, { t: t + m.beat * 0.75, gain: 0.14, f0: mtof(m.root + (inBar % 2 ? 12 : 10)), f1: mtof(m.root), decay: 0.22 });
        for (let s = 0; s < 4; s++) {
          const acc = s === 2 ? 1 : s === 0 ? 0.5 : 0.3;
          const skip = m.rnd() < 0.12, g = m.rnd(), pn = m.rnd(), off = m.rnd();
          if (skip || !m.want(s % 2 === 0 ? 1 : 2)) continue;
          noiseHit(ctx, bus, m.noise, { t: t + s * m.beat / 4, gain: 0.06 * acc * (0.7 + g * 0.6), decay: 0.07, hp: 7000, pan: (pn - 0.5) * 0.8, offset: off * 5 });
        }
        if (inBar === m.bpb - 1) {
          const pickup = m.rnd() < 0.6, off = m.rnd(), ghost = m.rnd() < 0.5;
          if (pickup && m.want(2)) noiseHit(ctx, bus, m.noise, { t: t + m.beat / 2, gain: 0.08, decay: 0.12, hp: 2500, offset: off * 5 });
          if (ghost && m.want(2)) thump(ctx, bus, { t: t + m.beat / 2, gain: 0.3, f0: mtof(m.root - 5), f1: mtof(m.root - 12), decay: 0.3 });
        }
      }
    },

    bells(ctx, out, verb, m) {
      /* Complexity: layer 0 is the first bell of each chord (as before), layer 1 three more, layer 2 four more, softer ones:
         1 / 4 / 8 bells per chord, which is about 4 / 16 / 32 per 8 bars. */
      const bus = ctx.createGain(); bus.connect(out); bus.connect(verb.in(1.1));
      m.forChords((chord, t0, seg, ci) => {
        const tones = chord.map((n) => ((n % 12) + 12) % 12).filter((n) => m.custom || PENTA.includes(n) || m.rnd() < 0.3);
        m.rnd(); /* (kept: this draw used to choose how many bells, and dropping it would change the first bell) */
        for (let k = 0; k < 8; k++) {
          const beatPos = Math.floor(m.rnd() * Math.round(seg / m.beat));
          const n = tones[Math.floor(m.rnd() * tones.length)] ?? 0;
          const half = m.rnd() < 0.3, g = m.rnd(), pn = m.rnd(), lv = k === 0 ? 0 : k < 4 ? 1 : 2;
          const bn = m.plan.fit(m.root + (m.custom ? 12 : 24) + n, ci), bt = t0 + beatPos * m.beat + (half ? m.beat / 2 : 0); if (bn === null) continue;
          gated(m, lv, [1.6, 5, 9], (decay, mul, attack) => bell(ctx, bus, { t: bt, freq: mtof(bn), gain: (lv === 2 ? 0.055 + g * 0.04 : 0.07 + g * 0.05) * mul, decay, attack, pan: (pn - 0.5) * 1.2 }));
        }
      });
    },

    // ----- melody pack (I IV iii vi ii V I) -----
    mchords(ctx, out, verb, m) {
      const voice = voiceOf(m, 'pad', false); /* chords are polyphonic: a mono voice becomes a pad */
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = voice === 'pad' ? 1800 : 6000; f.Q.value = 0.9;
      if (voice === 'pad') lfo(ctx, f.frequency, { L: m.L, cycles: 2, depth: 600 });
      f.connect(out); f.connect(verb.in(0.8));
      /* Complexity: layer 0 holds the chord's 1st and 3rd listed tones, layer 1 adds the 2nd, layer 2 the 4th (a fuller chord as X rises).
         A pad holds each chord for its whole length; the other voices strike it again on every bar line. */
      const evs = [];
      m.forProg((chord, t, seg) => chord.slice(0, 4).forEach((n, i) => {
        const lv = [0, 1, 0, 2][i]; if (!m.want(lv)) return;
        const pan = (i - 1.5) * 0.35, base = { n: m.root + n, pan, lv, sus: true };
        if (voice === 'pad') evs.push({ ...base, t, d: seg, gain: 0.05 / LEVEL.pad });
        else for (let b = 0; b < Math.round(seg / m.bar); b++) evs.push({ ...base, t: t + b * m.bar, d: m.bar, gain: voice === 'bell' ? 0.09 / LEVEL.bell : 0.1 });
      }));
      playEvents(ctx, f, m, voice, evs);
    },

    mbass(ctx, out, verb, m) {
      const voice = voiceOf(m, 'sub');
      const evs = [];
      m.forProg((chord, t, seg) => {
        const n = m.root - 12 + chord[0];
        /* Complexity: layer 0 the long note, layer 1 a pluck on every bar, layer 2 a softer pluck on the middle of every bar */
        if (m.want(0)) evs.push({ t, d: seg, n, gain: 0.14, sus: true, lv: 0, line: 0, join: undefined });
        for (let b = 0; b < Math.round(seg / m.bar); b++) {
          if (m.want(1)) evs.push({ t: t + b * m.bar, d: Math.min(m.bar, 1.4), n, gain: 0.12, decay: 1.4, lv: 1, line: 1 });
          if (m.want(2)) evs.push({ t: t + (b + 0.5) * m.bar, d: Math.min(m.bar / 2, 1.0), n, gain: 0.08, decay: 1.0, lv: 2, line: 2 });
        }
      });
      playEvents(ctx, out, m, voice, evs, { lines: { 0: { gain: voice === 'acid' ? 0.06 : 0.09, pan: 0, slow: true }, 1: { gain: voice === 'acid' ? 0.05 : 0.07, pan: 0 }, 2: { gain: voice === 'acid' ? 0.04 : 0.05, pan: 0 } } });
    },

    marp(ctx, out, verb, m) {
      const voice = voiceOf(m, 'pluck');
      const bus = voice === 'pluck' ? (() => { const b = ctx.createGain(); b.connect(out); b.connect(verb.in(0.9)); return b; })() : voiceBus(ctx, out, verb, m, { echo: 0.15, rv: 0.9 });
      const PATS = { rolling: [0, 1, 2, 3, 4, 3, 2, 1], pulse: [0, 2, 0, 3, 0, 2, 0, 4] }; /* the stem's "style" picks the pattern (genre packs); steps past the chord's last tone wrap around */
      const pat = PATS[m.style] || [0, 2, 1, 3, 2, 4, 3, 1];
      const evs = [];
      m.forProg((chord, t0, seg, ci) => {
        const steps = Math.round(seg / (m.beat / 2));
        for (let s = 0; s < steps; s++) {
          const tone = chord[pat[s % pat.length] % chord.length];
          let note = m.root + 24 + tone - (tone > 12 ? 12 : 0);
          if (m.ambient) { note = m.plan.fit(note, ci); if (note === null) continue; } // follows the ambient stems: fits under the plan
          /* Complexity: layer 0 every other beat, layer 1 the beats in between, layer 2 the off-beat eighths */
          const lv = s % 4 === 0 ? 0 : s % 2 === 0 ? 1 : 2;
          if (!m.want(lv)) continue;
          evs.push({ t: t0 + s * m.beat / 2, d: m.beat / 2, n: note, gain: s % 4 === 0 ? 0.15 : 0.1, decay: 1.1, pan: Math.sin(s) * 0.5, lv, line: 0 });
        }
      });
      playEvents(ctx, bus, m, voice, evs, { lines: { 0: { gain: voice === 'acid' ? 0.04 : 0.05, pan: 0.2 } } });
    },

    // A seeded melody that follows the chords: chord tones on strong beats, stepwise motion
    // between them, each phrase leans toward the next chord, and the last phrase lands on the tonic.
    melody(ctx, out, verb, m) {
      /* Two parts: the generator (which notes) and the voice (what they sound like). style 'long' (or the old 'glide' / 'acid') = a few long notes per phrase;
         lyrical / flowing / leaping / bright = note by note. The voice is the stem's `voice` (a kit gives Melody A and B theirs); the old styles glide and acid
         imply their voice when none is given. Any generator can use any voice. */
      const legacy = m.style === 'glide' || m.style === 'acid', voice = voiceOf(m, legacy ? m.style : 'pluck');
      if (legacy || m.style === 'long') return longMelody(ctx, out, verb, m, voice);
      return pluckedMelody(ctx, out, verb, m, m.style, 1, null, voice);
    },

    shimmer(ctx, out, verb, m) {
      /* An aggressive, tremolo-effected distorted-guitar voice with a slight wah: sustained chord tones on detuned saws and a square,
         through a pedal chain: wah (a band-pass sweeping slowly, mixed with the dry signal so it stays slight) -> heavy distortion ->
         a low-pass that tames the fizz -> a deep, fast tremolo. The tremolo and wah are LFOs with whole cycles per loop, so the loop is seamless. */
      const bus = ctx.createGain(); bus.gain.value = 1;
      const hpIn = ctx.createBiquadFilter(); hpIn.type = 'highpass'; hpIn.frequency.value = 160; bus.connect(hpIn); /* keep the mud out of the distortion */
      const wahSum = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(); dry.gain.value = 0.75; wet.gain.value = 1.1;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3; bp.frequency.value = 1100;
      hpIn.connect(dry).connect(wahSum); hpIn.connect(bp).connect(wet).connect(wahSum);
      lfo(ctx, bp.frequency, { L: m.L, cycles: Math.max(1, Math.round(m.L * 0.33)), depth: 600, phase: m.rnd() * 6.28 }); /* wah: 500-1700 Hz, about once every 3 s */
      const dist = ctx.createWaveShaper(); dist.curve = driveCurve(9); dist.oversample = '4x';
      const fizz = ctx.createBiquadFilter(); fizz.type = 'lowpass'; fizz.frequency.value = 4200; fizz.Q.value = 0.7;
      const trem = ctx.createGain(); trem.gain.value = 0.52;
      lfo(ctx, trem.gain, { L: m.L, cycles: Math.max(1, Math.round(m.L * 5.5)), depth: 0.42, phase: m.rnd() * 6.28 }); /* tremolo: 5.5 Hz, deep (0.1-0.94) */
      const level = ctx.createGain(); level.gain.value = 0.04;
      wahSum.connect(dist).connect(fizz).connect(trem).connect(level);
      level.connect(out); level.connect(verb.in(1.1));
      const echo = ctx.createDelay(2), efb = ctx.createGain(), elp = ctx.createBiquadFilter(), eg = ctx.createGain();
      echo.delayTime.value = m.beat * 0.75; efb.gain.value = 0.3; elp.type = 'lowpass'; elp.frequency.value = 2600; eg.gain.value = 0.3;
      level.connect(eg).connect(echo); echo.connect(elp).connect(efb).connect(echo); elp.connect(out);
      /* Complexity: layer 0 is one chord tone, layer 1 adds a second, layer 2 the third plus the first an octave up. */
      m.forChords((chord, t, seg, ci) => {
        const tone = (n, lv, up = 0) => { if (!m.want(lv)) return; const sn = m.plan.fit(m.root + (m.custom ? 12 : 24) + n + up, ci); if (sn === null) return; padVoice(ctx, bus, { t, dur: seg, xf: 0.5, freq: mtof(sn), types: ['sawtooth', 'sawtooth', 'square'], detune: 6, gain: up ? 0.2 : 0.3, pan: 0 }); };
        tone(chord[1], 0); tone(chord[2], 1); tone(chord[4] ?? chord[3], 2); tone(chord[1], 2, 12);
      });
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
  for (const [k, v] of Object.entries(PROG_LIB)) LABELS[k] = v.labels;
  const PROG_SYNTHS = ['mchords', 'mbass', 'marp', 'melody'];
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Spell a transposed chord with sharps when its tonic's key signature uses them (E minor, B minor, G major, ...).
  const SHARP_TONICS = { minor: [4, 11, 6, 1, 8], major: [7, 2, 9, 4, 11, 6] };
  // `transpose` = semitones added for the display only (B♭ instruments such as trumpet and clarinet read +2). Audio is not affected.
  const SUFFIX_SHARP = { minor: SHARP_TONICS.minor, major: SHARP_TONICS.major };
  function chordTimeline({ synth, progression, bars, key, mode, transpose = 0, custom = null }) {
    if (custom) { // a chord chart from MusicXML: names are the file's own qualities on the current key (+ transpose for B♭ instruments)
      const tonic = ((KEY_ROOTS[key] ?? 50) + transpose) % 12, names = transpose && SUFFIX_SHARP[custom.mode === 'major' ? 'major' : 'minor'].includes(tonic) ? SHARP_NAMES : NOTE_NAMES;
      const nm = (rel) => names[(((KEY_ROOTS[key] ?? 50) + rel + transpose) % 12 + 12) % 12];
      const chords = custom.chords.map((c) => ({ name: nm(c.rel) + c.q + (c.bassRel != null && c.bassRel !== c.rel ? '/' + nm(c.bassRel) : ''), roman: c.roman, start: c.start, len: c.len }));
      return { bars: custom.bars, chords, keyName: names[tonic] + (custom.mode === 'major' ? '' : 'm'), custom: true };
    }
    const kind = progression === 'ambient' || !PROG_SYNTHS.includes(synth) ? 'ambient' : PROG_LIB[progression] ? progression : (mode === 'major' ? 'major' : 'minor');
    const list = LABELS[kind], root = KEY_ROOTS[key] ?? 50, chords = [];
    const lens = [];
    if (kind === 'ambient' && progression !== 'ambient') { // the ambient stems: one chord every 2 bars, cycling
      for (let i = 0, t = 0; t < bars; i++, t += 2) lens.push([i % list.length, t, Math.min(2, bars - t)]);
    } else { // progression synths: whole bars each, extra bars to the first chords
      const n = Math.min(list.length, bars), base = Math.floor(bars / n), extra = bars - base * n;
      for (let i = 0, t = 0; i < n; i++) { const len = base + (i < extra ? 1 : 0); lens.push([i, t, len]); t += len; }
    }
    const tonic = (root + transpose) % 12, names = transpose && SHARP_TONICS[kind === 'major' ? 'major' : 'minor'].includes(tonic) ? SHARP_NAMES : NOTE_NAMES;
    for (const [i, start, len] of lens) {
      const [o, q, roman] = list[i];
      chords.push({ name: names[(root + o + transpose) % 12] + q, roman, start, len });
    }
    return { bars, chords, keyName: names[tonic] + (kind === 'major' ? '' : 'm') };
  }

  /**
   * Render one stem. Returns an AudioBuffer exactly `bars` bars long.
   * opts: { lush: { voices, verb } (both default true), synth, sampleRate, tempo, beatsPerBar, bars, key, mode ('minor'|'major'), progression ('ambient' | default 1-4-3-6-2-5-1), style (melody: lyrical|flowing|leaping|bright|glide|acid), seed, id }
   */
  async function renderTier(opts) {
    const tier = opts.tier ?? null; // null = everything in one buffer; 0, 1, 2 = one complexity layer (see renderStem)
    const { synth, sampleRate, tempo, beatsPerBar: bpb, key, seed, id } = opts, bars = opts.custom ? opts.custom.bars : opts.bars;
    const customFull = opts.custom || null; // a chord chart loaded from MusicXML: replaces the built-in progressions for every generated stem
    const custom = customFull ? slowHarmony(customFull) : null; // the upper voices follow one chord per bar (see slowHarmony)
    const ambient = !!custom || opts.progression === 'ambient';
    const style = opts.style; // follow the ambient stems' chords (i – VI – III – VII)
    const lib = !custom && PROG_LIB[opts.progression] || null; // a genre progression (see PROG_LIB): D natural minor
    const mode = custom ? (custom.mode === 'major' ? 'major' : 'minor') : (ambient || lib || opts.mode !== 'major' ? 'minor' : 'major');
    const prog = custom ? custom.chords.map(customTones) : lib ? lib.chords : ambient ? CHORDS : PROGS[mode];
    const build = BUILDERS[synth];
    if (!build) throw new Error('Unknown synth type: ' + synth);
    const beat = 60 / tempo, bar = beat * bpb, L = bar * bars;
    const TAIL = 12;
    const N = Math.round(L * sampleRate);
    const ctx = new OfflineAudioContext(2, N + Math.round(TAIL * sampleRate), sampleRate);

    const rnd = mulberry32(hash(`${seed}:${synth}:${id}`));
    const noise = makeNoise(sampleRate, 8, hash(`noise:${seed}`));
    // Lush options (both on by default): voices = thick drifting unison + chorus on Pad/Atmos; verb = the damped stereo space.
    const lush = { voices: true, verb: true, ...(opts.lush || {}) };
    // Lush reverb: Drone, Sub and Pulse get a small, short room (their low end stays clean and tight); everything else shares a big
    // hall with 30 ms pre-delay whose wet signal is high-passed at 150 Hz. Pad and Atmos send more into it.
    const roomy = lush.verb && (synth === 'drone' || synth === 'sub' || synth === 'pulse' || synth === 'beats');
    const ir = !lush.verb ? makeIR(sampleRate, 6, hash(`ir:${seed}`))
      : roomy ? makeSpaceIR(sampleRate, 3, hash(`ir:${seed}`), { pre: 0.008, rt60: 2.2, hiStart: 7000, hiEnd: 900, hiTau: 0.8, onset: 0.012, taps: 5 })
      : makeSpaceIR(sampleRate, 9, hash(`ir:${seed}`));

    if (tier !== null) ctx.__ev = []; /* only the complexity layers of the audience stems are recorded for the piano roll */
    const out = ctx.createGain(); out.connect(ctx.destination);
    const conv = ctx.createConvolver(); conv.buffer = ir;
    if (lush.verb && !roomy) { const cut = ctx.createBiquadFilter(); cut.type = 'highpass'; cut.frequency.value = 150; cut.Q.value = 0.5; conv.connect(cut); cut.connect(out); } else conv.connect(out);
    const sendBoost = lush.verb && (synth === 'pad' || synth === 'atmos') ? 1.6 : 1;
    const verb = { in(level) { const g = ctx.createGain(); g.gain.value = level * 0.35 * sendBoost; g.connect(conv); return g; } };

    const seg = bar * 2; // one chord every 2 bars
    const m = {
      tier, want: (lv) => tier === null || tier === lv, /* events of complexity level lv are built only in the layer for lv */
      rndT: mulberry32(hash(`${seed}:${synth}:${id}:t${tier}`)), mkRnd: () => mulberry32(hash(`${seed}:${synth}:${id}`)), /* a stream of its own for this layer, and a fresh copy of the shared one */
      lush, mode, prog, ambient, style, custom, plan: custom ? buildCustomPlan(KEY_ROOTS[key] ?? 50, opts.planSeed ?? seed, customFull, bpb) : buildPlan(KEY_ROOTS[key] ?? 50, opts.planSeed ?? seed, { bpb, mode: 'minor' }), scale: SCALES[mode], root: KEY_ROOTS[key] ?? 50, beat, bar, bpb, L, rnd, noise,
      // The progression's chords spread over the loop in whole bars; extra bars go to the first chords (7 chords in 8 bars -> 2,1,1,1,1,1,1; the 4 ambient chords -> 2 bars each).
      forProg(fn) {
        if (custom) { custom.chords.forEach((c, i) => fn(prog[i], c.start * bar, c.len * bar, i, prog.length)); return; }
        const n = Math.min(prog.length, bars), base = Math.floor(bars / n), extra = bars - base * n;
        let t = 0;
        for (let i = 0; i < n; i++) { const len = (base + (i < extra ? 1 : 0)) * bar; fn(prog[i], t, len, i, n); t += len; }
      },
      forChords(fn) { if (custom) { custom.chords.forEach((c, i) => fn(prog[i], c.start * bar, c.len * bar, i)); return; } const n = Math.max(1, Math.round(L / seg)); for (let i = 0; i < n; i++) fn(CHORDS[i % 4], i * seg, seg, i % 4); },
    };
    m.voice = opts.voice || null; m.sample = opts.voiceSample || null; m.tpl = opts.tpl || null; /* the stem's voice (see playEvents), its recorded note, and a forced rhythm template (Pulse / Sub) */
    m.seed = seed; m.id = id; m.samples = opts.samples || {}; m.pattern = opts.pattern || null; /* beats: the decoded one-shots and the pack's patterns */
    build(ctx, out, verb, m);

    const r = await ctx.startRendering();
    // The render stops TAIL seconds after the loop end. Whatever is still ringing then (a long delay or reverb under the bass) would be cut
    // off with a click when it is folded in, so fade the last 5 s of the tail to silence first.
    const fadeN = Math.round(5 * sampleRate);
    for (let ch = 0; ch < 2; ch++) { const src = r.getChannelData(ch); for (let q = 0; q < fadeN && q < src.length; q++) src[src.length - 1 - q] *= 0.5 - 0.5 * Math.cos(Math.PI * q / fadeN); }
    // Fold the tail back onto the start -> seamless circular loop.
    const loop = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate });
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      const src = r.getChannelData(ch), dst = loop.getChannelData(ch);
      for (let i = 0; i < src.length; i++) dst[i % N] += src[i];
      for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(dst[i]));
    }
    if (tier === null && peak > 0.95) { // keep headroom; never clip a stem on its own (complexity layers are scaled together in renderStem)
      const k = 0.95 / peak;
      for (let ch = 0; ch < 2; ch++) { const d = loop.getChannelData(ch); for (let i = 0; i < N; i++) d[i] *= k; }
    }
    loop.tplName = m.tplName;
    if (ctx.__ev) loop.noteEvents = ctx.__ev.filter((e) => e[0] >= 0 && e[0] < L - 1e-6).map(([t, d, p]) => [+(t / beat).toFixed(3), +Math.max(d / beat, 0.05).toFixed(3), p === null ? null : +p.toFixed(1)]); /* in beats, so they stay right when the tempo changes */
    return loop;
  }


  /* Synths whose stems have a complexity control (melodic and rhythmic layers): rendered as three same-length loops that play in sync.
     Layer 0 is the sparse base, layers 1 and 2 add notes. The engine fades layers 1 and 2 in and out with the XY pad's X axis. */
  const TIERED = new Set(['arp', 'bells', 'shimmer', 'melody', 'pulse', 'sub', 'beats', 'marp', 'mchords', 'mbass']);
  const hasTiers = (synth) => TIERED.has(synth);
  /* Returns an AudioBuffer. With opts.tiers, the buffer is layer 0 and its `layers` property holds layers 1 and 2. */
  async function renderStem(opts) {
    if (!opts.tiers || !hasTiers(opts.synth)) return renderTier({ ...opts, tier: null });
    const bufs = [];
    for (let t = 0; t < 3; t++) bufs.push(await renderTier({ ...opts, tier: t }));
    const n = bufs[0].length; let peak = 0; const d = bufs.map((b) => [b.getChannelData(0), b.getChannelData(1)]);
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[0][ch][i] + d[1][ch][i] + d[2][ch][i])); /* the loudest the three layers get together */
    if (peak > 0.95) { const k = 0.95 / peak; for (const c of d) for (const a of c) for (let i = 0; i < n; i++) a[i] *= k; }
    bufs[0].layers = [bufs[1], bufs[2]];
    /* the piano roll: every note with the layer it belongs to, [start beat, length in beats, pitch, layer], and the loop length in beats */
    bufs[0].roll = { beats: bufs[0].duration / (60 / opts.tempo), notes: bufs.flatMap((b, k) => (b.noteEvents || []).map((e) => [...e, k])).sort((a, b) => a[0] - b[0]), name: bufs[0].tplName };
    return bufs[0];
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

  window.ResonanceSynth = { hasTiers, lastLongPlan: () => lastLongPlan, renderStem, toWav, chordTimeline, buildPlan, buildCustomPlan, slowHarmony, KEY_ROOTS, KEYS: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] };
})();

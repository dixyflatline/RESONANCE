// MusicXML chord-chart reader for RESONANCE.
//
//   const chart = await ResonanceXML.parse(arrayBuffer, { written: 'auto' | 'concert' | 'bb', grain: 'half' | 'bar', maxBars: 64 });
//
// Reads the chord symbols (<harmony> elements) of an uncompressed .musicxml / .xml file or a compressed .mxl, and returns a progression the
// synth can render: { title, bars, mode, tonicPc, chords: [{ rel, ints, q, bassRel, roman, start, len }], info, warnings }.
//   rel   root in semitones from the tonic (-5..6)        ints  chord intervals above the root       q  quality text for display ("m7", "7(♭9)")
//   start / len are in bars (one file measure = one bar, so a 3/4 or 6/8 file still maps onto the engine's bars)
// Everything is relative to the tonic: the engine's Key menu transposes the whole chart.
//
// Transposing parts: a part for a B♭ instrument has <transpose><chromatic>-2</chromatic></transpose>, and its chord symbols are written
// for the player ("written pitch"). `written: 'auto'` follows that tag (concert = written - 2); 'bb' forces it; 'concert' reads the symbols as sounding pitch.
(function () {
  const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const KIND = {
    major: [[0, 4, 7], ''], minor: [[0, 3, 7], 'm'], augmented: [[0, 4, 8], 'aug'], diminished: [[0, 3, 6], 'dim'],
    dominant: [[0, 4, 7, 10], '7'], 'major-seventh': [[0, 4, 7, 11], 'maj7'], 'minor-seventh': [[0, 3, 7, 10], 'm7'],
    'diminished-seventh': [[0, 3, 6, 9], 'dim7'], 'augmented-seventh': [[0, 4, 8, 10], '7♯5'], 'half-diminished': [[0, 3, 6, 10], 'm7♭5'],
    'major-minor': [[0, 3, 7, 11], 'm(maj7)'], 'minor-major': [[0, 3, 7, 11], 'm(maj7)'], 'major-sixth': [[0, 4, 7, 9], '6'], 'minor-sixth': [[0, 3, 7, 9], 'm6'],
    'dominant-ninth': [[0, 4, 7, 10, 14], '9'], 'major-ninth': [[0, 4, 7, 11, 14], 'maj9'], 'minor-ninth': [[0, 3, 7, 10, 14], 'm9'],
    'dominant-11th': [[0, 4, 7, 10, 14, 17], '11'], 'major-11th': [[0, 4, 7, 11, 14, 17], 'maj11'], 'minor-11th': [[0, 3, 7, 10, 14, 17], 'm11'],
    'dominant-13th': [[0, 4, 7, 10, 14, 21], '13'], 'major-13th': [[0, 4, 7, 11, 14, 21], 'maj13'], 'minor-13th': [[0, 3, 7, 10, 14, 21], 'm13'],
    'suspended-second': [[0, 2, 7], 'sus2'], 'suspended-fourth': [[0, 5, 7], 'sus4'], power: [[0, 7], '5'], pedal: [[0], ''],
  };
  const DEG = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 9: 14, 11: 17, 13: 21 }; // MusicXML degree number -> semitones above the root
  const ROMAN = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'];
  const ALT = { '-2': '𝄫', '-1': '♭', 1: '♯', 2: '𝄪' };
  const mod12 = (n) => ((n % 12) + 12) % 12;

  // ---- .mxl (a zip file) ----
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Not a valid .mxl file (zip directory not found)');
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    const files = {}, dec = new TextDecoder();
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      files[name] = async () => {
        const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), data = u8.subarray(start, start + csize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error('Unsupported compression in .mxl');
      };
      p += 46 + nl + xl + cl;
    }
    return files;
  }
  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  }
  async function readXmlText(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0x50 && u8[1] === 0x4b) { // "PK": compressed MusicXML
      const files = await unzip(buf);
      let main = null;
      if (files['META-INF/container.xml']) {
        const c = new DOMParser().parseFromString(decodeText(await files['META-INF/container.xml']()), 'application/xml');
        main = c.querySelector('rootfile')?.getAttribute('full-path') || null;
      }
      if (!main || !files[main]) main = Object.keys(files).find((f) => /\.(musicxml|xml)$/i.test(f) && !/^META-INF\//i.test(f));
      if (!main) throw new Error('No MusicXML inside this .mxl file');
      return decodeText(await files[main]());
    }
    return decodeText(u8);
  }

  // ---- chord symbol ----
  const txt = (el, sel) => el.querySelector(sel)?.textContent.trim() ?? null;
  function readHarmony(h) {
    const step = txt(h, 'root > root-step'); if (!step) return null; // chord functions / no root: skipped
    const rootPc = mod12(STEP[step] + Math.round(Number(txt(h, 'root > root-alter') || 0)));
    const kindEl = h.querySelector('kind'), kind = kindEl ? kindEl.textContent.trim() : 'major';
    if (kind === 'none') return { none: true };
    const base = KIND[kind] || KIND.major;
    let ints = [...base[0]], q = base[1];
    if (kindEl && kindEl.hasAttribute('text')) q = kindEl.getAttribute('text'); // the file's own spelling ("m7", "-7", "Δ")
    if (!KIND[kind] && kind !== 'other' && kindEl) q = kindEl.getAttribute('text') ?? kind;
    let extra = '';
    for (const d of h.querySelectorAll('degree')) {
      const v = Number(txt(d, 'degree-value')), alt = Math.round(Number(txt(d, 'degree-alter') || 0)), type = txt(d, 'degree-type') || 'add';
      if (!(v in DEG)) continue;
      const natural = DEG[v], altered = natural + alt;
      if (type === 'subtract') { ints = ints.filter((i) => i !== natural && i !== altered); extra += `(no${v})`; }
      else if (type === 'alter') { ints = ints.filter((i) => i !== natural); ints.push(altered); extra += `(${ALT[alt] || ''}${v})`; }
      else { ints.push(altered); extra += alt ? `(${ALT[alt] || ''}${v})` : `(add${v})`; }
    }
    const bassStep = txt(h, 'bass > bass-step');
    const bassPc = bassStep ? mod12(STEP[bassStep] + Math.round(Number(txt(h, 'bass > bass-alter') || 0))) : null;
    return { rootPc, ints: [...new Set(ints)].sort((a, b) => a - b), q: q + extra, bassPc };
  }

  async function parse(buf, opts = {}) {
    const { written = 'auto', grain = 'half', maxBars = 64 } = opts, warnings = [];
    const xml = await readXmlText(buf);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('This file is not valid XML');
    const root = doc.documentElement.nodeName;
    if (root === 'score-timewise') throw new Error('score-timewise MusicXML is not supported; export "partwise" (the usual kind)');
    if (root !== 'score-partwise') throw new Error('This does not look like MusicXML (no score-partwise element)');
    const title = txt(doc, 'work > work-title') || txt(doc, 'movement-title') || txt(doc, 'credit-words') || '';
    // the first part that has chord symbols
    const part = [...doc.querySelectorAll('part')].find((p) => p.querySelector('harmony > root'));
    if (!part) throw new Error('No chord symbols found. The file needs chord symbols (harmony elements) above the staff; a melody alone is not enough');

    // key, time signature, transposition, tempo (first occurrences)
    const fifths = part.querySelector('attributes > key > fifths') ? Number(part.querySelector('attributes > key > fifths').textContent) : null;
    const modeTxt = txt(part, 'attributes > key > mode');
    const chromatic = Number(txt(part, 'attributes > transpose > chromatic') || 0) + 12 * Number(txt(part, 'attributes > transpose > octave-change') || 0);
    const ts = `${txt(part, 'attributes > time > beats') || '4'}/${txt(part, 'attributes > time > beat-type') || '4'}`;
    const tempo = Number(part.querySelector('sound[tempo]')?.getAttribute('tempo')) || null;

    // walk the measures: harmony position = sum of the note durations before it
    const events = [], mInfo = []; let divisions = 1, nominalBeats = 4, beatType = 4, nMeasures = 0;
    for (const meas of part.querySelectorAll(':scope > measure')) {
      const att = meas.querySelector('attributes');
      if (att) {
        const d = att.querySelector('divisions'); if (d) divisions = Number(d.textContent) || divisions;
        const b = att.querySelector('time > beats'), bt = att.querySelector('time > beat-type');
        if (b && bt) { nominalBeats = parseFloat(b.textContent) || nominalBeats; beatType = parseFloat(bt.textContent) || beatType; }
      }
      let pos = 0, maxPos = 0; const found = [];
      for (const el of meas.children) {
        const n = el.nodeName;
        if (n === 'note') { if (!el.querySelector(':scope > chord')) { pos += Number(txt(el, 'duration') || 0); } }
        else if (n === 'forward') pos += Number(txt(el, 'duration') || 0);
        else if (n === 'backup') pos -= Number(txt(el, 'duration') || 0);
        else if (n === 'harmony') found.push({ pos, h: el, off: Number(txt(el, 'offset') || 0) });
        maxPos = Math.max(maxPos, pos);
      }
      const len = Math.max(maxPos, divisions * nominalBeats * 4 / beatType) || 1;
      for (const f of found) { const c = readHarmony(f.h); if (c) events.push({ m: nMeasures, at: nMeasures + Math.min(0.999, Math.max(0, (f.pos + f.off) / len)), c }); }
      // repeat signs and numbered endings (voltas) on this measure's barlines
      const info = { forward: false, back: 0, endStart: null, stop: false };
      for (const bl of meas.querySelectorAll(':scope > barline')) {
        const rp = bl.querySelector(':scope > repeat');
        if (rp) { if (rp.getAttribute('direction') === 'forward') info.forward = true; else info.back = Math.max(2, Number(rp.getAttribute('times')) || 2); }
        const en = bl.querySelector(':scope > ending');
        if (en) { // "discontinue" is not an end: iReal Pro marks only the first measure of a multi-bar ending that way
          const type = en.getAttribute('type'), nums = (en.getAttribute('number') || '1').split(/[,\s]+/).flatMap((t) => { const r = t.match(/^(\d+)-(\d+)$/); return r ? Array.from({ length: r[2] - r[1] + 1 }, (_, i) => Number(r[1]) + i) : [Number(t)]; }).filter(Boolean);
          if (type === 'start') info.endStart = nums; else if (type === 'stop') info.stop = true;
        }
      }
      mInfo.push(info);
      nMeasures++;
    }
    if (!events.length) throw new Error('No readable chord symbols in this file');
    if (ts !== '4/4') warnings.push(`The file is in ${ts}; each measure plays as one bar of the engine (which is 4/4).`);

    // Play the repeats: expand the measures into the order they are performed (repeat signs, first and second endings).
    // An ending runs to the closing repeat sign, a "stop", or the start of the next ending, whichever comes first.
    const order = [];
    { let i = 0, repStart = 0, pass = 1, jumped = false, guard = 0;
      const endOf = (st) => { for (let k = st; k < nMeasures; k++) { if (k > st && mInfo[k].endStart) return k - 1; if (mInfo[k].back || mInfo[k].stop) return k; } return nMeasures - 1; };
      while (i < nMeasures && guard++ < nMeasures * 12) {
        const mi = mInfo[i];
        if (mi.forward && !jumped) { repStart = i; pass = 1; } // reached by playing on, not by jumping back: a new repeated section starts here
        jumped = false;
        if (mi.endStart && !mi.endStart.includes(pass)) { i = endOf(i) + 1; continue; } // an ending for another pass: skip it
        order.push(i);
        if (mi.back && pass < mi.back) { pass++; i = repStart; jumped = true; continue; } // closing repeat sign: go back
        if (mi.back) { pass = 1; repStart = i + 1; }
        i++;
      } }
    const repeated = order.length !== nMeasures;
    if (repeated) warnings.push(`Repeats played: the ${nMeasures} measures of the file become ${order.length} bars.`);
    { const at = new Map(); order.forEach((m, k) => { if (!at.has(m)) at.set(m, []); at.get(m).push(k); });
      const out = []; for (const e of events) for (const k of at.get(e.m) || []) out.push({ at: k + (e.at - e.m), c: e.c });
      events.length = 0; events.push(...out.sort((a, b) => a.at - b.at)); }
    const nBarsPlayed = order.length;

    // key: tonic and mode in the written key of the part
    const first = events.find((e) => !e.c.none)?.c, lastC = [...events].reverse().find((e) => !e.c.none)?.c;
    const minorish = (c) => c && c.ints.includes(3) && !c.ints.includes(4);
    let tonicW, mode;
    if (fifths !== null) {
      const major = mod12(fifths * 7);
      if (modeTxt) mode = /minor|dorian|phrygian|locrian|aeolian/i.test(modeTxt) ? 'minor' : 'major';
      else mode = (first && first.rootPc === mod12(major + 9) && minorish(first)) || (lastC && lastC.rootPc === mod12(major + 9) && minorish(lastC)) ? 'minor' : 'major';
      tonicW = mode === 'minor' ? mod12(major + 9) : major;
    } else { tonicW = first.rootPc; mode = minorish(first) ? 'minor' : 'major'; warnings.push('No key signature in the file: the first chord is taken as the key.'); }

    const shift = written === 'concert' ? 0 : written === 'bb' ? -2 : chromatic; // written -> sounding
    const readAs = shift ? `written pitch for a ${shift === -2 ? 'B♭' : shift === -9 ? 'E♭' : shift === -7 ? 'F' : `(${shift > 0 ? '+' : ''}${shift})`} instrument, concert = written ${shift > 0 ? '+' : '−'} ${Math.abs(shift)}` : 'concert pitch';
    const tonicPc = mod12(tonicW + shift);

    // chord segments in bars, merged when identical
    let segs = events.filter((e) => !e.c.none).map((e) => ({ at: e.at, c: e.c }));
    const quant = (x) => Math.round(x * 2) / 2;
    segs = segs.map((s) => ({ ...s, at: quant(s.at) }));
    const dedup = []; for (const s of segs) { if (dedup.length && dedup[dedup.length - 1].at === s.at) dedup[dedup.length - 1] = s; else dedup.push(s); }
    const lead = Math.floor(dedup[0].at); // bars before the first chord (a pickup or empty measures) are dropped
    let total = nBarsPlayed - lead;
    if (total > maxBars) { warnings.push(`The chart has ${total} bars. Only the first ${maxBars} are used.`); total = maxBars; }
    let list = dedup.map((s, i) => ({ s: s.at - lead, c: s.c, e: i + 1 < dedup.length ? dedup[i + 1].at - lead : total })).filter((x) => x.s < total);
    list[0].s = 0;
    for (const x of list) x.e = Math.min(x.e, total);
    if (grain === 'bar') { // one chord per bar: the chord that sounds longest in each bar
      const bars = []; for (let b = 0; b < total; b++) {
        let best = null, bl = -1;
        for (const x of list) { const ov = Math.min(x.e, b + 1) - Math.max(x.s, b); if (ov > bl) { bl = ov; best = x; } }
        bars.push(best);
      }
      list = []; bars.forEach((x, b) => { list.push({ s: b, c: x.c, e: b + 1 }); });
    }
    const chords = [];
    for (const x of list) {
      const c = x.c, rel0 = mod12(c.rootPc - tonicW), rel = rel0 > 6 ? rel0 - 12 : rel0;
      const bassRel = c.bassPc == null ? null : (() => { const r = mod12(c.bassPc - tonicW); return r > 6 ? r - 12 : r; })();
      const minor = c.ints.includes(3) && !c.ints.includes(4), dim = c.ints.includes(3) && c.ints.includes(6) && !c.ints.includes(7);
      const roman = (minor ? ROMAN[mod12(rel)].toLowerCase() : ROMAN[mod12(rel)]) + (dim ? '°' : '');
      const prev = chords[chords.length - 1];
      if (prev && prev.rel === rel && prev.q === c.q && prev.bassRel === bassRel && prev.ints.join() === c.ints.join()) { prev.len = x.e - prev.start; continue; }
      chords.push({ rel, ints: c.ints, q: c.q, bassRel, roman, start: x.s, len: x.e - x.s });
    }
    return {
      title: title.slice(0, 80), bars: total, mode, tonicPc, chords, warnings,
      info: { measures: nMeasures, played: nBarsPlayed, timeSig: ts, tempo, transposition: chromatic, readAs, changes: chords.length },
    };
  }

  window.ResonanceXML = { parse };
})();

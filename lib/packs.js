// RESONANCE PoC — sample pack discovery and validation (no dependencies).
//
// A pack is a folder under packs/. Either:
//   - packs/<id>/pack.json   describes the pack (name, tempo, key, stems…), or
//   - packs/<id>/*.wav       just audio files: the pack is auto-detected from the filenames.
// A pack.json with "include": ["pack-a", "pack-b"] builds a combined pack from other packs.
// Used by server.js and by `npm run packs`.

const fs = require('fs');
const path = require('path');
const { parseGroups, openGroup } = require('./rules');

const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a']);
const SYNTHS = new Set(['drone', 'pad', 'atmos', 'sub', 'arp', 'texture', 'pulse', 'bells', 'shimmer', 'mchords', 'mbass', 'marp', 'melody']); // mchords/mbass/marp/melody follow the pack's "mode" // keep in sync with public/synth.js
const COLORS = ['#5b8def', '#8b6cf0', '#2fb5a3', '#e8a33d', '#6fa8b8', '#e0655a', '#d6c24a', '#c77dd6',
  '#4fb0d8', '#7c8fb0', '#8fc06a', '#d9964a', '#e58fb0', '#9fd3c7', '#b9a37e', '#7aa5e8'];
const MAX_COMFORTABLE_STEMS = 16;

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) ? p : null;
}

function humanize(s) {
  const t = s.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\b\d{2,3}\s?bpm\b/gi, '').replace(/\b\d+\s?bars?\b/gi, '').replace(/\s+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : s;
}

// Read length/format from a WAV header (first 64 KB). Returns null for anything else.
function wavInfo(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(65536);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const size = fs.fstatSync(fd).size;
    if (n < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let p = 12, fmt = null;
    while (p + 8 <= n) {
      const id = head.toString('ascii', p, p + 4);
      let len = head.readUInt32LE(p + 4);
      if (id === 'fmt ') fmt = { channels: head.readUInt16LE(p + 10), sampleRate: head.readUInt32LE(p + 12), bits: head.readUInt16LE(p + 22) };
      if (id === 'data') {
        if (!fmt || !fmt.channels || !fmt.bits || !fmt.sampleRate) return null;
        if (len === 0 || p + 8 + len > size) len = size - (p + 8); // tolerate streamed headers
        return { seconds: len / (fmt.channels * (fmt.bits / 8)) / fmt.sampleRate, ...fmt };
      }
      p += 8 + len + (len & 1);
    }
  } catch { /* unreadable: treated as "unknown length" */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  return null;
}

function listAudio(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.') && AUDIO_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch { return []; }
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

// Stems name their group with "group": "<id>"; the pack's "groups" object defines each group's name and audience rules
// (see lib/rules.js). Group fade times become the stems' fade defaults. Packs without groups behave as before.
function applyGroups(stems, groupDefs, warnings) {
  const groups = [...groupDefs];
  const known = new Set(groups.map((g) => g.id));
  for (const st of stems) {
    if (!st.group) continue;
    if (!known.has(st.group)) { known.add(st.group); groups.push(openGroup(st.group)); warnings.push(`stem "${st.name}" uses group "${st.group}" which the pack doesn't define (no rules)`); }
  }
  const ungrouped = stems.filter((st) => !st.group);
  if (groups.length && ungrouped.length) { groups.push(openGroup('main')); for (const st of ungrouped) st.group = 'main'; }
  for (const st of stems) {
    st.about = aboutFor(st);
    const g = groups.find((x) => x.id === st.group);
    if (!g) continue;
    if (g.rules.finale) st.finale = true; /* the end-of-show signal (the gong) */
    if (g.rules.complexity && COMPLEXITY_SYNTHS.has(st.synth)) st.complexity = true; /* the engine renders it as three layers; X on the pad fades them in and out */
    if (g.rules.oneShot) st.oneShot = true; /* the engine plays it once from its start instead of looping it */
    if (st.fadeIn == null && g.rules.fadeIn != null) st.fadeIn = g.rules.fadeIn;
    if (st.fadeOut == null && g.rules.fadeOut != null) st.fadeOut = g.rules.fadeOut;
  }
  return groups.filter((g) => stems.some((st) => st.group === g.id)).sort((a, b) => a.order - b.order);
}

/* Plain-language descriptions of the generated sounds, shown on the phone pad. A stem's own "about" in pack.json wins. */
const SYNTH_ABOUT = {
  drone: 'A deep, steady hum that holds the whole piece together, like one long organ note underneath everything.',
  pad: 'A warm, slowly shifting cloud of chords. It fills the room without ever hurrying.',
  atmos: 'A hazy, ghostly wash that slowly changes colour, like fog drifting through the music.',
  texture: 'Soft rushing waves of air and noise, like the sea heard from far away.',
  arp: 'A gentle sparkle of notes played one after another, like a harp being plucked over the chords.',
  bells: 'Glassy bell tones that ring out and fade away slowly, a few at a time.',
  shimmer: 'A buzzing, crunchy guitar-like tone that pulses and wobbles, with a slight "wah" that makes it sound like it is talking.',
  sub: 'A very deep bass you feel in your chest more than you hear. Long notes that swell and fade.',
  pulse: 'A slow heartbeat with a soft shaker on top. It gives the music its pulse.',
  mchords: 'Soft chords that carry the tune along.',
  mbass: 'A warm bass line that follows the chords.',
  marp: 'A rippling run of notes that follows the chords.',
  melody: 'A little tune that follows the chords, one note after another.',
};
const MELODY_ABOUT = {
  glide: 'A slow, singing lead that slides from one note to the next, like a voice gliding.',
  acid: 'A squelchy, growling line in the style of old analog synthesizers. It slowly opens up and closes again.',
  lyrical: 'A gentle, song-like tune with long, relaxed notes.',
  flowing: 'A busy, flowing tune that keeps moving.',
  leaping: 'A playful tune that jumps between high and low notes.',
  bright: 'A high, clear tune that rings like a music box.',
};
const aboutFor = (st) => st.about || (st.synth === 'melody' && MELODY_ABOUT[st.style]) || SYNTH_ABOUT[st.synth] || '';

const COMPLEXITY_SYNTHS = new Set(['arp', 'bells', 'shimmer', 'melody', 'pulse', 'sub']); /* the generated synths that have complexity layers (see TIERED in public/synth.js) */

function baseInfo(id, pj, d) {
  return {
    id,
    name: (pj && pj.name) || humanize(id),
    description: (pj && pj.description) || '',
    license: (pj && pj.license) || '',
    credits: asList(pj && pj.credits),
    source: (pj && pj.source) || '',
    tags: asList(pj && pj.tags),
    order: num(pj && pj.order) ?? 100,
    beatsPerBar: num(pj && pj.beatsPerBar) ?? d.beatsPerBar ?? 4,
    seed: num(pj && pj.seed) ?? d.seed ?? 1,
    mode: pj && pj.mode === 'major' ? 'major' : 'minor', // harmony of generated stems (minor unless the pack says otherwise)
  };
}

function buildPack({ id, folder, pj }, d) {
  const auto = !pj;
  const files = auto ? listAudio(folder) : [];
  const guess = auto ? files.map((f) => /(\d{2,3})\s?bpm/i.exec(f) || /(\d{2,3})\s?bpm/i.exec(id)).find(Boolean) : null;
  const info = baseInfo(id, pj, d);
  const tempo = num(pj && pj.tempo) ?? (guess ? Number(guess[1]) : null) ?? d.tempo ?? 50;
  const key = pj && 'key' in pj ? pj.key : (d.key ?? 'D'); // null = key-agnostic
  const barLen = (60 / tempo) * info.beatsPerBar;
  const defs = auto ? files.map((f) => ({ name: humanize(f), file: f })) : (Array.isArray(pj.stems) ? pj.stems : []);
  const stems = [], skipped = [], warnings = [];
  let sizeBytes = 0;

  for (const raw of defs) {
    const s = { gain: 0.7, ...raw };
    const label = s.name || s.file || s.synth || `Stem ${stems.length + skipped.length + 1}`;
    s.name = label;
    s.color = s.color || COLORS[stems.length % COLORS.length];
    if (s.file) {
      const fp = safeJoin(folder, String(s.file));
      const ext = path.extname(String(s.file)).toLowerCase();
      if (!fp || !fs.existsSync(fp)) { skipped.push({ name: label, reason: `file missing: ${s.file}` }); continue; }
      if (!AUDIO_EXT.has(ext)) { skipped.push({ name: label, reason: `unsupported file type ${ext || '(none)'}` }); continue; }
      sizeBytes += fs.statSync(fp).size;
      s.url = '/packs/' + encodeURIComponent(id) + '/' + String(s.file).split('/').map(encodeURIComponent).join('/');
      const wi = ext === '.wav' ? wavInfo(fp) : null;
      if (wi) {
        const exact = wi.seconds / barLen;
        if (!s.bars) {
          s.bars = Math.max(1, Math.round(exact));
          if (Math.abs(exact - Math.round(exact)) > 0.04) warnings.push(`${label}: ${exact.toFixed(2)} bars at ${tempo} BPM — not a clean loop (will play as ${s.bars})`);
        } else {
          const want = s.bars * barLen;
          if (wi.seconds < want - 0.02) warnings.push(`${label}: ${wi.seconds.toFixed(2)} s is shorter than ${s.bars} bars at ${tempo} BPM (${want.toFixed(2)} s) — it will loop early and drift out of time`);
          else if (wi.seconds > want + 0.25 * (60 / tempo)) warnings.push(`${label}: longer than ${s.bars} bars — only the first ${s.bars} bars play`);
        }
      } else if (!s.bars) {
        s.bars = d.bars || 8;
        warnings.push(`${label}: length not checked (only WAV files are verified) — assuming ${s.bars} bars`);
      }
    } else if (s.synth) {
      if (!SYNTHS.has(s.synth)) { skipped.push({ name: label, reason: `unknown synth "${s.synth}"` }); continue; }
      s.bars = s.bars || 8;
    } else {
      skipped.push({ name: label, reason: 'needs a "file" or a "synth"' });
      continue;
    }
    s.id = stems.length + 1; // ids are pack-local, 1..n
    stems.push(s);
  }
  if (stems.length > MAX_COMFORTABLE_STEMS) warnings.push(`${stems.length} stems — more than ${MAX_COMFORTABLE_STEMS} gets crowded on a phone screen`);
  if (!auto && !defs.length) warnings.push('pack.json lists no stems');
  if (auto && !files.length) warnings.push('empty folder: add .wav loops or a pack.json');

  const groups = applyGroups(stems, parseGroups(pj && pj.groups), warnings);
  return { ...info, tempo, key, auto, include: [], stems, groups, skipped, warnings, sizeBytes, playable: stems.length > 0, folder };
}

function buildCombined({ id, folder, pj }, byId, d) {
  const parts = asList(pj.include);
  const first = parts.map((p) => byId.get(p)).find(Boolean);
  const info = baseInfo(id, pj, d);
  const tempo = num(pj.tempo) ?? (first && first.tempo) ?? d.tempo ?? 50;
  const key = 'key' in pj ? pj.key : (first ? first.key : d.key ?? 'D');
  const beatsPerBar = num(pj.beatsPerBar) ?? (first && first.beatsPerBar) ?? 4;
  const stems = [], skipped = [], warnings = [];
  let sizeBytes = 0;
  for (const pid of parts) {
    const base = byId.get(pid);
    if (!base) { warnings.push(`included pack "${pid}" not found (or it is itself a combined pack)`); continue; }
    sizeBytes += base.sizeBytes;
    warnings.push(...base.warnings);
    skipped.push(...base.skipped);
    for (const s of base.stems) {
      if (s.file && (base.tempo !== tempo || base.beatsPerBar !== beatsPerBar)) {
        skipped.push({ name: s.name, reason: `from "${pid}" (${base.tempo} BPM, ${base.beatsPerBar}/4); this pack is ${tempo} BPM, ${beatsPerBar}/4` });
        continue;
      }
      stems.push({ ...s, id: stems.length + 1 });
    }
  }
  if (stems.length > MAX_COMFORTABLE_STEMS) warnings.push(`${stems.length} stems — more than ${MAX_COMFORTABLE_STEMS} gets crowded on a phone screen`);
  // Groups: those of the included packs, then this pack's own "groups" (which may override a group's name, preset or rules).
  const merged = new Map();
  for (const pid of parts) { const base = byId.get(pid); if (base) for (const g of base.groups || []) merged.set(g.id, g); }
  for (const g of parseGroups(pj.groups)) merged.set(g.id, g);
  const groups = applyGroups(stems, [...merged.values()], warnings);
  return {
    ...info, groups, mode: pj.mode ? info.mode : (first ? first.mode : info.mode), beatsPerBar, tempo, key, seed: num(pj.seed) ?? (first && first.seed) ?? info.seed,
    tags: info.tags.length ? info.tags : ['combined'], auto: false, include: parts, stems, skipped, warnings, sizeBytes,
    playable: stems.length > 0, folder,
  };
}

/** Scan `dir` for packs. `defaults` = config.json (tempo, beatsPerBar, key, seed). Returns an array sorted by order, then name. */
function scanPacks(dir, defaults = {}) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')); } catch { /* no packs dir */ }
  const raw = [], broken = [];
  for (const e of entries) {
    const folder = path.join(dir, e.name), pjPath = path.join(folder, 'pack.json');
    if (!fs.existsSync(pjPath)) { raw.push({ id: e.name, folder, pj: null }); continue; }
    try { raw.push({ id: e.name, folder, pj: JSON.parse(fs.readFileSync(pjPath, 'utf8')) }); }
    catch (err) { broken.push({ id: e.name, folder, error: err.message }); }
  }
  const byId = new Map();
  for (const r of raw) if (!(r.pj && r.pj.include)) byId.set(r.id, buildPack(r, defaults)); // pass 1: plain packs
  const combined = raw.filter((r) => r.pj && r.pj.include).map((r) => buildCombined(r, byId, defaults)); // pass 2
  const list = [...byId.values(), ...combined];
  for (const b of broken) {
    list.push({ ...baseInfo(b.id, null, defaults), name: b.id, tempo: defaults.tempo ?? 50, key: defaults.key ?? 'D', auto: false, include: [],
      stems: [], skipped: [], warnings: [`pack.json is not valid JSON: ${b.error}`], sizeBytes: 0, playable: false, folder: b.folder });
  }
  return list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

const publicGroup = (g) => ({ id: g.id, name: g.name, description: g.description, rules: g.rules, badges: g.badges });

/** What the browser needs to show a pack card (no server paths). */
function summary(p) {
  return {
    id: p.id, name: p.name, description: p.description, license: p.license, credits: p.credits, source: p.source, tags: p.tags,
    tempo: p.tempo, beatsPerBar: p.beatsPerBar, key: p.key, mode: p.mode,
    groups: (p.groups || []).map(publicGroup), auto: p.auto, include: p.include,
    playable: p.playable, sizeBytes: p.sizeBytes, warnings: p.warnings, skipped: p.skipped,
    stems: p.stems.map((s) => ({ id: s.id, group: s.group || null, name: s.name, role: s.role || '', color: s.color, kind: s.file ? 'file' : 'synth', bars: s.bars })),
  };
}

module.exports = { scanPacks, summary, wavInfo, publicGroup };

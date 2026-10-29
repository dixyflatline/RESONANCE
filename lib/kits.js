// RESONANCE PoC — favorites and the swap of the Melodic / Rhythmic groups (no dependencies).
//
// The structure is  Kit -> Template -> Favorite  (see lib/soundkits.js for the kit):
//   KIT       the voices (sound) of the melodic roles: chords, bass, arp, Melody A, Melody B. soundkits/
//   TEMPLATE  which notes play. Melodic template = a melodic pack (its stems name their role with "slot"); rhythmic template = a rhythmic pack
//             (Pulse and Sub with a chosen groove, or the world-percussion patterns).
//   FAVORITE  a saved combination of the three above plus the Microcosm settings: favorites/ (older files in kits/ still load).
//
// A FAVORITE picks one "template" for the Melodic group and one for the Rhythmic group of the live pack, may name a sound kit, and can carry the
// Microcosm effect settings. Core synth and the nature samples are left alone: they keep sustaining the sound while the
// Melodic and Rhythmic stems are swapped (see server.js: the swap happens once those groups have faded to silence).
//
// A sound set is a plain (not combined) pack. Its stems fill the group's slots, in order, with the group's audience rules.
// A pack says which roles it can fill with "sets": ["melodic"] in pack.json; otherwise it is guessed:
//   - it has stems in a group called "melodic" / "rhythmic" -> that role;
//   - or all its generated stems are melodic synths (arp, bells, shimmer, melody, marp, mchords, mbass) -> "melodic";
//   - or all of them are pulse / sub -> "rhythmic".
// Favorites live as JSON (one file each): { "name", "description", "kit": "<sound kit id>", "melodic": "<pack id>", "rhythmic": "<pack id>", "micro": {...} }.

const fs = require('fs');
const path = require('path');
const { COMPLEXITY_SYNTHS } = require('./packs');
const { applyToStems } = require('./soundkits');

const ROLES = ['melodic', 'rhythmic'];
const MELODIC_SYNTHS = new Set(['arp', 'bells', 'shimmer', 'melody', 'marp', 'mchords', 'mbass']);
const RHYTHM_SYNTHS = new Set(['pulse', 'sub', 'beats']);

/** The roles a (plain) pack can fill. */
function rolesOf(p) {
  if (p.include && p.include.length) return (p.sets || []).filter((r) => ROLES.includes(r));
  if (p.sets && p.sets.length) return p.sets.filter((r) => ROLES.includes(r));
  const out = ROLES.filter((r) => p.stems.some((s) => s.group === r));
  if (out.length) return out;
  const gen = p.stems.length && p.stems.every((s) => s.synth);
  if (gen && p.stems.every((s) => MELODIC_SYNTHS.has(s.synth))) return ['melodic'];
  if (gen && p.stems.every((s) => RHYTHM_SYNTHS.has(s.synth))) return ['rhythmic'];
  return [];
}

/** The stems a pack would put into `role`'s group (the role's own group when it has one, otherwise all of them; never the finale). */
function setStems(p, role) {
  const own = p.stems.filter((s) => s.group === role);
  return (own.length ? own : p.stems).filter((s) => !s.finale);
}

/** Can `p` fill `role` in the live pack `base`? -> { ok, reason, warnings[] } (recorded loops must match the tempo; generated stems the mode). */
function fits(base, p, role) {
  if (!rolesOf(p).includes(role)) return { ok: false, reason: `not a ${role} set`, warnings: [] };
  const stems = setStems(p, role);
  if (!stems.length) return { ok: false, reason: 'no stems', warnings: [] };
  const warnings = [];
  if (stems.some((s) => s.file) && (p.tempo !== base.tempo || p.beatsPerBar !== base.beatsPerBar)) return { ok: false, reason: `${p.tempo} BPM, ${p.beatsPerBar}/4 (live pack is ${base.tempo} BPM, ${base.beatsPerBar}/4)`, warnings };
  if (stems.some((s) => s.synth) && p.mode !== base.mode) return { ok: false, reason: `${p.mode} harmony (live pack is ${base.mode})`, warnings };
  if (p.key && base.key && p.key !== base.key && stems.some((s) => s.file)) warnings.push(`recorded in ${p.key}; the live pack is in ${base.key}`);
  return { ok: true, reason: '', warnings };
}

/** What can be chosen for each role, for the kit panel. `current` = { melodic: pack id | null, rhythmic: ... } (null = the live pack's own). */
function catalog(base, packList, current) {
  const out = { canKit: ROLES.every((r) => (base.groups || []).some((g) => g.id === r)), roles: {} };
  for (const r of ROLES) {
    const own = base.stems.filter((s) => s.group === r).length;
    out.roles[r] = { slots: own, sets: [] };
    for (const p of packList) {
      if (!p.playable || !rolesOf(p).includes(r)) continue;
      const f = fits(base, p, r), st = setStems(p, r);
      out.roles[r].sets.push({ id: p.id, name: p.name, description: p.description, stems: st.map((s) => ({ name: s.name, color: s.color, slot: s.slot || null, tpl: s.tpl || null })), ok: f.ok, reason: f.reason, warnings: f.warnings, current: (current && current[r]) === p.id });
    }
  }
  return out;
}

/** Build the live pack for `picks` = { melodic?: pack id, rhythmic?: pack id } on top of `base` (a missing role keeps the base's own stems).
 *  The group keeps its slot ids in order (so the audience's state for other stems is untouched); extra stems get new ids; unused slots go away.
 *  -> { pack, changed: [role...] } or { error } */
function compose(base, picks, packList, meta, soundKit) {
  const byId = new Map(packList.map((p) => [p.id, p]));
  let stems = base.stems.map((s) => ({ ...s })), changed = [];
  let nextId = Math.max(0, ...base.stems.map((s) => s.id)) + 1;
  for (const role of ROLES) {
    const id = picks && picks[role];
    if (!id) continue;
    const g = (base.groups || []).find((x) => x.id === role);
    if (!g) return { error: `the live pack has no ${role} group` };
    const src = byId.get(id);
    if (!src || !src.playable) return { error: `unknown sound set "${id}"` };
    const f = fits(base, src, role);
    if (!f.ok) return { error: `${src.name} does not fit: ${f.reason}` };
    const slots = base.stems.filter((s) => s.group === role).map((s) => s.id);
    const fresh = setStems(src, role).map((s, i) => {
      const n = { ...s, group: role, id: i < slots.length ? slots[i] : nextId++ };
      delete n.complexity; delete n.oneShot; delete n.finale; delete n.fadeIn; delete n.fadeOut;
      if (s.fadeIn != null && !(src.groups || []).some((x) => x.id === s.group)) n.fadeIn = s.fadeIn;
      if (g.rules.complexity && COMPLEXITY_SYNTHS.has(n.synth)) n.complexity = true;
      if (g.rules.fadeIn != null) n.fadeIn = g.rules.fadeIn;
      if (g.rules.fadeOut != null) n.fadeOut = g.rules.fadeOut;
      return role === 'melodic' && soundKit ? applyToStems([n], soundKit)[0] : n; /* the sound kit gives the stems that name a role their voice */
    });
    const out = []; let put = false;
    for (const s of stems) { if (s.group !== role) out.push(s); else if (!put) { out.push(...fresh); put = true; } }
    stems = out; changed.push(role);
  }
  // The Sub plays the chords of the melodic template (a Sub on the built-in ambient chords would play another harmony than the Bass and Chords), and the kit's
  // note rules reach every Melodic and Rhythmic stem, so a regenerate keeps them.
  const leadSyn = new Set(['mchords', 'mbass', 'marp', 'melody']), lead = stems.find((s) => s.group === 'melodic' && leadSyn.has(s.synth));
  stems = stems.map((s) => {
    if (s.group !== 'melodic' && s.group !== 'rhythmic') return s;
    const n = { ...s }; delete n.rules; delete n.follow;
    if (soundKit && soundKit.rules && Object.keys(soundKit.rules).length) n.rules = soundKit.rules;
    if (s.group === 'rhythmic' && s.synth === 'sub' && lead) { n.follow = true; if (lead.progression !== undefined) n.progression = lead.progression; else delete n.progression; }
    return n;
  });
  const used = new Set(); for (const s of stems) { if (used.has(s.id)) return { error: 'stem id clash' }; used.add(s.id); }
  return { pack: { ...base, stems, ...(meta || {}) }, changed };
}

// ---- kit files ----
const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function cleanMicro(m) { // only the parts the engine understands, bounded
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const k of ['a', 'b']) {
    const x = m[k]; if (!x || typeof x !== 'object') continue;
    const knobs = {}; for (const n of ['activity', 'size', 'repeats', 'tone', 'mix']) if (Number.isFinite(Number(x.knobs && x.knobs[n]))) knobs[n] = Math.max(0, Math.min(1, Number(x.knobs[n])));
    out[k] = { preset: String(x.preset || '').slice(0, 24), on: !!x.on, knobs, src: (Array.isArray(x.src) ? x.src : []).map(String).slice(0, 24), muteDry: !!x.muteDry };
  }
  return Object.keys(out).length ? out : null;
}

function readKit(file, id) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { id, name: String(k.name || id), description: String(k.description || ''), kit: k.kit ? String(k.kit) : null, melodic: k.melodic ? String(k.melodic) : null, rhythmic: k.rhythmic ? String(k.rhythmic) : null, micro: cleanMicro(k.micro), order: Number.isFinite(Number(k.order)) ? Number(k.order) : 100 };
  } catch { return null; }
}

function scanKits(dirs) { /* one folder or several (the first one wins when two files have the same name) */
  const seen = new Map();
  for (const dir of [].concat(dirs)) {
    let names = []; try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')); } catch { /* no favorites yet */ }
    for (const f of names) { const id = f.slice(0, -5); if (!seen.has(id)) { const k = readKit(path.join(dir, f), id); if (k) seen.set(id, k); } }
  }
  return [...seen.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Save (or update, when the name is the same) a kit file. -> the kit */
function saveKit(dir, { name, description, kit: soundKit, melodic, rhythmic, micro }) {
  const id = slug(name); if (!id) return null;
  const kit = { name: String(name).slice(0, 60), description: String(description || '').slice(0, 300), kit: soundKit || undefined, melodic: melodic || undefined, rhythmic: rhythmic || undefined, micro: cleanMicro(micro) || undefined };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(kit, null, 2) + '\n');
  return readKit(path.join(dir, id + '.json'), id);
}

/** Remove a kit file. -> true when it existed. */
function deleteKit(dirs, id) {
  if (!/^[a-z0-9-]+$/.test(String(id))) return false;
  let any = false;
  for (const dir of [].concat(dirs)) { try { fs.unlinkSync(path.join(dir, id + '.json')); any = true; } catch { /* not in this folder */ } }
  return any;
}

module.exports = { deleteKit, ROLES, rolesOf, setStems, fits, catalog, compose, scanKits, saveKit, readKit, cleanMicro, slug };

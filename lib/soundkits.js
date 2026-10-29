// RESONANCE PoC — sound kits: the SOUND of each melodic role (no dependencies).
//
// The structure is  Kit -> Template -> Favorite:
//   - a KIT (this file) is a collection of voices, one for each melodic role: chords, bass, arp, Melody A and Melody B.
//     A voice is a synth voice (pad, pluck, bell, sub, glide, acid) or a recorded sample, repitched across the keyboard.
//   - a TEMPLATE (a melodic pack, packs/melody-*) decides which notes play: its progression, and for each role a generator
//     (arp pattern, melody style, long lines...). Its stems say which role they play with "slot": "melodyA" etc.
//   - a FAVORITE (kits/ or favorites/, see lib/kits.js) saves a combination: kit + melodic template + rhythmic template + effect settings.
// Any kit plays any template: Melody A's glide lead can play a gospel melody, a house melody or the long ambient lines.
//
// Kits live in soundkits/<id>.json, or in soundkits/<id>/kit.json when they come with recorded samples (the sample files sit beside kit.json):
//   { "name": "Layers", "description": "...", "order": 1,
//     "voices": { "chords": "pad", "bass": "sub", "arp": "pluck", "melodyA": "glide", "melodyB": "acid" } }
// A sample voice is an object: { "voice": "sample", "file": "keys-c4.wav", "root": 60, "gain": 0.9, "loop": false }
// ("root" = the MIDI note the recording plays at; "loop": true sustains it by looping, for pads; false plays it as a one-shot).

const fs = require('fs');
const path = require('path');

const SLOTS = ['chords', 'bass', 'arp', 'melodyA', 'melodyB'];
const SLOT_NAMES = { chords: 'Chords', bass: 'Bass', arp: 'Arp', melodyA: 'Melody A', melodyB: 'Melody B' };
const VOICE_NAMES = { pad: 'Warm pad', pluck: 'Pluck', bell: 'Bell', sub: 'Sub bass', glide: 'Glide lead', acid: 'Acid line', sample: 'Recorded sample' };
const LEAD = ['pluck', 'bell', 'pad', 'glide', 'acid', 'sample'];
const ALLOWED = { chords: ['pad', 'pluck', 'bell', 'sample'], bass: ['sub', 'pluck', 'acid', 'glide', 'sample'], arp: LEAD, melodyA: LEAD, melodyB: LEAD };
const DEFAULT_VOICE = { chords: 'pad', bass: 'sub', arp: 'pluck', melodyA: 'pluck', melodyB: 'pluck' };
const { aboutFor } = require('./packs');
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a']);

const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** One slot's voice from the file: a string, or { voice, file, root, gain, loop }. -> { voice, ... } or null (with a warning pushed) */
function cleanVoice(slot, raw, id, folder, warnings) {
  const o = typeof raw === 'string' ? { voice: raw } : raw && typeof raw === 'object' ? raw : null;
  if (!o) return null;
  const voice = String(o.voice || '');
  if (!ALLOWED[slot].includes(voice)) { warnings.push(`${SLOT_NAMES[slot]}: "${voice}" is not a voice for this role (use ${ALLOWED[slot].filter((v) => v !== 'sample').join(', ')}, or sample)`); return null; }
  if (voice !== 'sample') return { voice };
  const rel = String(o.file || '');
  const fp = folder && rel ? path.normalize(path.join(folder, rel)) : null;
  if (!fp || !fp.startsWith(folder + path.sep) || !fs.existsSync(fp) || !AUDIO_EXT.has(path.extname(fp).toLowerCase())) { warnings.push(`${SLOT_NAMES[slot]}: sample file missing or not audio (${rel || 'no "file"'}); it needs a folder kit (soundkits/<id>/kit.json)`); return null; }
  const root = Number.isFinite(Number(o.root)) ? Math.max(0, Math.min(127, Number(o.root))) : 60;
  return { voice, file: rel, url: '/soundkits/' + encodeURIComponent(id) + '/' + rel.split('/').map(encodeURIComponent).join('/'), root, gain: Number.isFinite(Number(o.gain)) ? Math.max(0, Math.min(2, Number(o.gain))) : 1, loop: !!o.loop };
}

/** Note rules a kit asks for (all on by default): lowSplit = with a Bass and a Sub, the Sub keeps to root and fifth and the Bass drops its 3rd (they share the low register);
 *  followProg = the Sub plays the melodic template's chords; subOctave = the Sub's quiet octave-up touch on its pulses (off: nothing sits just above the Sub to rub with a low melody); upperRub = Bells, Shimmer and Arp notes that would rub (within a third of a critical band, measured in Hz) move an octave or are left out. */
const RULE_KEYS = ['lowSplit', 'followProg', 'upperRub', 'subOctave'];
function cleanRules(r) { const out = {}; if (r && typeof r === 'object') for (const k of RULE_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k]; return out; }

function readSoundKit(file, id, folder) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8')), warnings = [], voices = {};
    for (const slot of SLOTS) { const v = cleanVoice(slot, k.voices && k.voices[slot], id, folder, warnings); if (v) voices[slot] = v; }
    return { id, name: String(k.name || id), description: String(k.description || ''), voices, rules: cleanRules(k.rules), warnings, folder: folder || null, order: Number.isFinite(Number(k.order)) ? Number(k.order) : 100 };
  } catch (e) { return null; }
}

/** All kits in `dir`. -> [kit] sorted by order, then name */
function scanSoundKits(dir) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')); } catch { /* none yet */ }
  const out = [];
  for (const e of ents) {
    if (e.isFile() && e.name.endsWith('.json')) { const k = readSoundKit(path.join(dir, e.name), e.name.slice(0, -5), null); if (k) out.push(k); }
    else if (e.isDirectory()) { const folder = path.join(dir, e.name), f = path.join(folder, 'kit.json'); if (fs.existsSync(f)) { const k = readSoundKit(f, e.name, folder); if (k) out.push(k); } }
  }
  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Save a kit made of plain synth voices: { name, description, voices: { slot: voice name } }. A kit that has a folder keeps its samples (they are kept as they were). -> the kit */
function saveSoundKit(dir, { name, description, voices }) {
  const id = slug(name); if (!id) return null;
  const old = scanSoundKits(dir).find((k) => k.id === id), out = {};
  for (const slot of SLOTS) {
    const v = voices && voices[slot];
    if (v && typeof v === 'string' && v !== 'sample' && ALLOWED[slot].includes(v)) out[slot] = v;
    else if (old && old.voices[slot] && old.voices[slot].voice === 'sample') out[slot] = { voice: 'sample', file: old.voices[slot].file, root: old.voices[slot].root, gain: old.voices[slot].gain, loop: old.voices[slot].loop };
    else out[slot] = DEFAULT_VOICE[slot];
  }
  const body = JSON.stringify({ name: String(name).slice(0, 60), description: String(description || '').slice(0, 300), order: old ? old.order : 50, ...(old && Object.keys(old.rules).length ? { rules: old.rules } : {}), voices: out }, null, 2) + '\n';
  const file = old && old.folder ? path.join(old.folder, 'kit.json') : path.join(dir, id + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  return scanSoundKits(dir).find((k) => k.id === id) || null;
}

/** Remove a kit that is a single .json file (a kit with a folder of samples is removed by deleting the folder). -> true when removed */
function deleteSoundKit(dir, id) {
  if (!/^[a-z0-9-]+$/.test(String(id))) return false;
  try { fs.unlinkSync(path.join(dir, id + '.json')); return true; } catch { return false; }
}

/** Give the stems that name a slot the kit's voice for it. Stems without a slot, or slots the kit does not name, are left as they are. */
function applyToStems(stems, kit) {
  if (!kit) return stems;
  return stems.map((s) => {
    const v = s.slot && kit.voices[s.slot];
    if (!v) return s;
    const n = { ...s, voice: v.voice }; n.about = aboutFor({ ...s, about: '', voice: v.voice });
    delete n.voiceUrl; delete n.voiceRoot; delete n.voiceGain; delete n.voiceLoop;
    if (v.voice === 'sample') { n.voiceUrl = v.url; n.voiceRoot = v.root; n.voiceGain = v.gain; n.voiceLoop = v.loop; }
    return n;
  });
}

/** What the browser needs. */
const publicSoundKit = (k) => ({ id: k.id, name: k.name, description: k.description, voices: Object.fromEntries(SLOTS.map((s) => [s, k.voices[s] ? k.voices[s].voice : null])), warnings: k.warnings, editable: !k.folder });

module.exports = { SLOTS, SLOT_NAMES, VOICE_NAMES, ALLOWED, DEFAULT_VOICE, scanSoundKits, saveSoundKit, deleteSoundKit, applyToStems, publicSoundKit, slug };

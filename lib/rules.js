// RESONANCE PoC — stem groups and audience interaction rules (no dependencies).
//
// A pack can sort its stems into groups ("core" synth layers, "nature" samples, ...). Each group has
// rules that decide how remote participants (audience phones) may interact with its stems.
// The engine operator, sensors and HTTP inputs are never limited by these rules.
// Used by lib/packs.js (parsing) and server.js (enforcement).

const DEFAULTS = {
  toggle: true,           // participants may switch stems on/off
  xy: true,               // participants may move the XY pad (volume + filter)
  xyRange: { x: [0, 1], y: [0, 1] }, // limits for what participants can reach on the XY pad
  maxActive: null,        // most stems of this group that can be on at once (null = no limit)
  onFull: 'replace-oldest', // when full: 'replace-oldest' fades out the longest-running stem, 'ignore' refuses the tap
  minActive: 0,           // stems that cannot be switched off by participants (keeps a bed playing)
  cooldown: 0,            // seconds before the same stem can be changed again by participants
  gate: null,             // { participants: N, window: seconds }: N different people must tap within the window
  decay: 0,               // seconds a participant-started stem plays before it fades away on its own (0 = stays)
  maxPlays: null,         // most times participants can start a stem in one performance (null = unlimited); the count resets with a new performance
  oneShot: false,         // the stem plays once from its start (not looped); participants cannot switch it off
  fadeIn: null,           // seconds; overrides the engine's fade sliders for this group's stems
  fadeOut: null,
};

// Ready-made rule sets. A group says `"preset": "core"` and may override single values in `"rules"`.
const PRESETS = {
  // Foundation synth layers: always something playing, a limited number at once, gentle XY range, slow fades.
  core: { minActive: 1, cooldown: 3, xyRange: { x: [0.25, 1], y: [0.3, 1] }, fadeIn: 8, fadeOut: 8 },
  // Nature samples: engagement-driven. Needs two people together, at most two at once, fades away unless re-triggered.
  nature: { gate: { participants: 2, window: 10 }, maxActive: 2, cooldown: 5, decay: 60, xyRange: { x: [0, 1], y: [0, 0.9] }, fadeIn: 6, fadeOut: 10 },
  // Melodic layers: a few at a time, a bit of cooldown so the line doesn't get cluttered, moderate fades.
  melodic: { maxActive: 3, cooldown: 4, xyRange: { x: [0.2, 1], y: [0.2, 1] }, fadeIn: 3, fadeOut: 5 },
  // Rhythmic layers (pulse, bass): at most two, longer cooldown, quick entrances so they land on the beat.
  rhythmic: { maxActive: 2, cooldown: 6, xyRange: { x: [0.4, 1], y: [0.3, 1] }, fadeIn: 1.5, fadeOut: 4 },
  // One-off accents (e.g. a gong): one at a time, long cooldown, fades away by itself.
  accent: { maxActive: 1, cooldown: 20, decay: 30, fadeIn: 0.5, fadeOut: 6 },
  // The climax (the gong): the audience's shared decision that the moment has come, e.g. when they are satisfied with, or tired of,
  // the current setting. Three different people must tap within 20 s; it sounds one strike per vote, at most three times in a
  // performance; it cannot be switched off or shaped by participants, and the strike has an instant attack.
  climax: { gate: { participants: 3, window: 20 }, maxActive: 1, onFull: 'ignore', cooldown: 20, decay: 20, maxPlays: 3, oneShot: true, xy: false, fadeIn: 0.02, fadeOut: 4 },
  // Everything allowed (what packs without groups behave like).
  open: {},
};

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp01 = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d);
const range = (r, d) => (Array.isArray(r) && r.length === 2 ? [clamp01(r[0], d[0]), clamp01(r[1], d[1])].sort((a, b) => a - b) : d);

function normalizeRules(preset, raw) {
  const base = { ...DEFAULTS, ...(PRESETS[preset] || {}), ...(raw || {}) };
  const gate = base.gate && Number(base.gate.participants) > 1 ? { participants: Math.floor(Number(base.gate.participants)), window: Math.max(1, numOrNull(base.gate.window) ?? 10) } : null;
  const xr = base.xyRange || {};
  return {
    toggle: base.toggle !== false,
    xy: base.xy !== false,
    xyRange: { x: range(xr.x, DEFAULTS.xyRange.x), y: range(xr.y, DEFAULTS.xyRange.y) },
    maxActive: numOrNull(base.maxActive) && Number(base.maxActive) > 0 ? Math.floor(Number(base.maxActive)) : null,
    onFull: base.onFull === 'ignore' ? 'ignore' : 'replace-oldest',
    minActive: Math.max(0, Math.floor(numOrNull(base.minActive) ?? 0)),
    cooldown: Math.max(0, numOrNull(base.cooldown) ?? 0),
    gate,
    decay: Math.max(0, numOrNull(base.decay) ?? 0),
    maxPlays: numOrNull(base.maxPlays) && Number(base.maxPlays) > 0 ? Math.floor(Number(base.maxPlays)) : null,
    oneShot: base.oneShot === true,
    fadeIn: numOrNull(base.fadeIn),
    fadeOut: numOrNull(base.fadeOut),
  };
}

/** Short human-readable list of what a rule set does, for the pack browser and the phone grid. */
function describe(r) {
  const out = [];
  if (!r.toggle) out.push('Taps disabled');
  if (r.maxActive) out.push(`Up to ${r.maxActive} at once`);
  if (r.minActive) out.push(`Keeps ${r.minActive} on`);
  if (r.gate) out.push(`Needs ${r.gate.participants} people within ${r.gate.window}s`);
  if (r.oneShot) out.push('One strike per vote');
  if (r.maxPlays) out.push(`Sounds only ${r.maxPlays} times`);
  if (r.cooldown) out.push(`${r.cooldown}s cooldown`);
  if (r.decay) out.push(`Fades away after ${r.decay}s`);
  if (!r.xy) out.push('XY locked');
  else if (r.xyRange.x[0] > 0 || r.xyRange.x[1] < 1 || r.xyRange.y[0] > 0 || r.xyRange.y[1] < 1) out.push('XY range limited');
  return out;
}

/** Parse a pack's `groups` object: { id: { name, description, preset, order, rules } } -> sorted array. */
function parseGroups(raw) {
  const list = [];
  if (raw && typeof raw === 'object') {
    let i = 0;
    for (const [id, g] of Object.entries(raw)) {
      const gg = g && typeof g === 'object' ? g : {};
      const rules = normalizeRules(gg.preset, gg.rules);
      list.push({ id, name: gg.name || id, description: gg.description || '', preset: gg.preset || '', order: numOrNull(gg.order) ?? i++, raw: gg, rules, badges: describe(rules) });
    }
  }
  return list.sort((a, b) => a.order - b.order);
}

/** A group for stems that name a group the pack didn't define (or none at all): everything allowed. */
function openGroup(id) {
  const rules = normalizeRules('open');
  return { id, name: id === 'main' ? 'Stems' : id, description: '', preset: 'open', order: 999, raw: {}, rules, badges: [] };
}

module.exports = { DEFAULTS, PRESETS, normalizeRules, describe, parseGroups, openGroup };

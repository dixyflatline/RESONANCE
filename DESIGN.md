# RESONANCE PoC: design checkpoint (per-layer controller)

Snapshot of the design as of the "checkpoint-xy-pad" tag. Safe point to return to before experiments.

## Architecture
- Node + WebSocket. Three page roles:
  - Fangzhang (server): holds all state, applies group rules, clamps values.
  - Dantian (public/engine.html + engine.js): the one audio engine page. Plays Web Audio, renders stems offline, reports quantize.
  - Daqian (public/client.html): audience phones.
- Music is synthesized, not sampled: `public/synth.js` renders each stem with `OfflineAudioContext` (12 s tail folded onto the start, so loops are seamless). Nature layers use CC0 recordings from `packs/field-recordings-cc0`.
- Packs (`packs/*/pack.json`) define stems and groups; `lib/packs.js` builds the stem list, `lib/rules.js` holds group rule presets.

## Group rules (lib/rules.js)
gate, maxActive, onFull, cooldown, decay, finale, hidden, `volRange`, `complexity`.
- Melodic and rhythmic presets: `complexity: true`, volume limits via `volRange`.
- Core synth: no complexity. Nature: one sample at a time, vote-style. Gong: vote and finale.
- Standby/claim protocol: only one engine page plays. Do not run a second engine on a live server.

## Per-layer controller
State: `state.xy[id] = {x: complexity, y: cutoff, v: volume}`, default `{x: 0.6, y: 1, v: 0.8}`.
Message: `{type:'xy', stem, x, y, v}`. The server clamps with `xyRange` (x, y) and `volRange`; x is ignored for stems without `complexity`.

Mappings (public/xy.js, engine.js):
- Cutoff Hz = `60 * (20000/60) ** y`, filter Q 1.3.
- Volume gain = `(v / 0.8) ** 2`.
- Complexity: layer 1 gain `smooth(0.15, 0.45, x)`, layer 2 gain `smooth(0.5, 0.9, x)`. Default x=0.6 gives layer 1 full, layer 2 about 16%. Gain changes glide with a 0.15 s time constant.

### Complexity layers (tiered stems)
Tiered synths: arp, bells, shimmer, melody, pulse, sub (`TIERED` in synth.js, `COMPLEXITY_SYNTHS` in lib/packs.js).
Each is rendered as three same-length loops that play in sync: a base plus two additive layers (same seed, joint 0.95 peak normalisation). `renderStem` returns the base buffer with `.layers = [l1, l2]`.
- arp: every other beat; remaining eighths; quiet sixteenth fills.
- bells: first bell; other bells; three extra softer bells.
- shimmer: one tone; second tone; third tone plus octave up.
- pulse: first thump; second thump and eighth shaker; sixteenth shaker, pick-up, ghost thump.
- sub: one long note per chord; leap or scoop; soft pluck per bar.
- melody: strong beats and phrase ends; other beats; off-beats. Long (glide, acid) melodies: plan; second line an octave up avoiding semitone clashes; quiet plucked ornaments.
Cost: about 2x render time, 3x memory for tiered stems.

### Engine voice
Base source plus layer sources, each through its own gain node (`voice.lg`) into the shared fade-in gain. `applyXY` sets layer gain, cutoff and volume. `stopVoice` stops all sources. Export WAV is the full mix.

## Phone UI (public/client.html + xy.js)
- Tapping a layer tile opens a bottom sheet; the tile itself only opens it. Swipes do nothing.
- Two sheet modes, chosen by `infoFor(def)`:
  - Pad layers: XY pad (X complexity, Y cutoff), vertical volume fader, `?` button, big toggle switch (92x44, role=switch), `x` close. Double-tap the pad to reset. Complexity axis is locked for non-complexity layers.
  - Vote layers (any group with `gate` or `finale`, such as nature and gong): no pad, no switch, no `?`. Explanation card, a Vote button, and a volume bar (not for the gong).
- First-time help card over the pad (localStorage `resonance.padHelp`; `?help=1` forces it; `?` reopens; Got it / x closes).
- Plain-language text: per-stem `about` (`SYNTH_ABOUT`, `MELODY_ABOUT`, `aboutFor` in lib/packs.js, explicit `about` in pack.json for field recordings). The "joining in" text is composed from group rules in `infoFor`.
- Switch feedback is always visible: optimistic flip (`answerTap`, 1.5 s resync), status note via `syncSheet` and `waitWord` ("Waiting for the next bar", "Playing", "Fading out"). The engine reports its quantize as param `quantizeBar` (1, 0.5 or 1/beats-per-bar) because the server clamps params to 0..1.

## Engine page (unchanged design)
Small square mini pad per layer for complexity, cutoff, volume; sheet with Done and text On/Off. BPM glides, slider capped at 120.

## Finale
Gong x3 while stems exit by stage (`FINALE_*` constants); layered stems fade to silence.

## Verified vs not
Verified headlessly: layered renders (no NaN), protocol and clamping, finale, phone gestures and sheet states, text fit at 390x800 and 360x640, switch stages with a real engine.
Not yet verified: auditioning complexity layers, shimmer, bass-pop fix and gong by ear; real phones.

## Restore point
`git checkout checkpoint-xy-pad` returns to this design.

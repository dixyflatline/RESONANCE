# Sample packs

Each folder in `packs/` is one pack. Open **Packs…** on the engine page to see them all and switch between them. You can also list them in a terminal with `npm run packs`.

## Add a pack in 30 seconds

Make a folder and drop loops in it. That's it:

```
packs/
  my-pack/
    pad_70bpm.wav
    texture_70bpm.wav
```

The pack is detected automatically. Its tempo comes from "70bpm" in a filename or the folder name (else `config.json`), each file becomes a pad named after the file, and each loop's length in bars is worked out from the audio. The pack list flags anything that won't loop cleanly.

## Describing a pack (optional `pack.json`)

Add a `pack.json` to set names, roles, colours and levels:

```json
{
  "name": "My pack",
  "description": "Shown on the pack card",
  "tempo": 70,
  "beatsPerBar": 4,
  "key": "D",
  "license": "CC0",
  "credits": ["Pad: by someone, from somewhere"],
  "tags": ["field recording"],
  "order": 40,
  "stems": [
    { "name": "Pad",  "role": "drone / pad", "file": "pad_70bpm.wav", "bars": 8, "gain": 0.7, "color": "#5b8def" },
    { "name": "Arp",  "role": "melodic",     "synth": "arp",         "bars": 8 }
  ]
}
```

| Field | Meaning |
|---|---|
| `tempo`, `beatsPerBar` | The pack's master clock. Every loop in a pack must match it. |
| `key` | Shown on the card. Use `null` for key-less material (field recordings, drones). |
| `sets` | Optional. `["melodic"]` and/or `["rhythmic"]`: the roles this pack's stems can fill in a **kit** (otherwise guessed from its groups and synths). See README, "Kit, templates, favorites". |
| `slot` (on a stem) | Optional. `chords`, `bass`, `arp`, `melodyA` or `melodyB`: the role this generated stem plays. A sound kit gives stems that name a slot their `voice` (see README); the stem's own `voice` is the default. A pack whose stems have slots is a **melodic template**. |
| `voice` (on a stem) | Optional. `pad`, `pluck`, `bell`, `sub`, `glide`, `acid` or `sample` (kits set it, with `voiceUrl`, `voiceRoot`, `voiceGain`, `voiceLoop` for samples). The generator (`style`) decides which notes play; the voice decides the sound. A melody `style` of `long` makes a few long notes per phrase. |
| `tpl` (on a Pulse or Sub stem) | Optional. Names the rhythm template to play instead of letting the seed pick one: Pulse `Heartbeat`, `Tresillo`, `Four on the floor`, `Half-time breath`, `Syncopated`, `Rolling toms`; Sub `Long line`, `Root and chord tone`, `Syncopated bass`, `Slow breath`, `Octave bounce`, `Chord walk`, `Push`, `One-drop`, `Gallop`, `Dotted`; Bass (`mbass`) `Bar pluck`, `Push`, `Tresillo`, `Offbeat`, `One-drop`, `Gallop`, `Walk`. The `rhythm-*` packs are rhythmic templates. |
| `order` | Sort position in the list (lower first). |
| stem `file` | A WAV (checked for length) or mp3/ogg/flac/m4a (not checked), relative to the pack folder. |
| stem `synth` | Instead of a file: `drone`, `pad`, `sub`, `arp`, `texture`, `pulse`, `bells`, `shimmer`, `atmos` (minor progression), or `mchords`, `mbass`, `marp`, `melody` (progression 1–4–3–6–2–5–1, or the ambient stems' chords when the stem has `"progression": "ambient"`, in the pack's `"mode"`: `"minor"` (default) or `"major"`; 8 bars gives chords of 2,1,1,1,1,1,1 bars; 14 gives 2 bars each), generated in the browser. |
| stem `style` | For `melody`: `lyrical`, `flowing`, `leaping` or `bright` (the melody's character). |
| stem `about` | One or two plain-language sentences about the sound, shown on the phone's pad. Generated synths have a built-in description; recordings should set their own. |
| stem `bars` | Loop length on the grid. If the file is longer, the extra audio is ignored. |
| stem `gain` | Level, 0 to 1 (default 0.7). |
| stem `fadeIn`, `fadeOut` | Per-pad fade times in seconds (default: the engine's sliders). |

Loops should be **seamless**, all the **same tempo**, and a **whole number of bars**. Keeping them in one key (or key-less) lets any combination stack cleanly.

## Groups and audience rules

Stems can be sorted into **groups**, and each group has **rules** for how remote participants (audience phones) may interact with it. Your own taps on the engine page, sensors and HTTP inputs are never limited by these rules.

```json
"groups": {
  "core":   { "name": "Core synth",     "preset": "core" },
  "nature": { "name": "Nature samples", "preset": "nature", "rules": { "decay": 90 } }
},
"stems": [
  { "name": "Drone",  "synth": "drone", "group": "core" },
  { "name": "Stream", "file": "stream.wav", "group": "nature" }
]
```

A group picks a **preset** (`core`, `melodic`, `rhythmic`, `nature`, `accent`, `climax`, `open`) and may override single values in `rules`:

| Rule | Meaning |
|---|---|
| `toggle` | Participants may switch stems on and off (default true). |
| `xy`, `xyRange`, `volRange` | Participants may move the pad, limited to `{ "x": [lo, hi], "y": [lo, hi] }` (0 to 1): x = complexity, y = filter cutoff. `volRange` (`[lo, hi]`) limits the volume fader. |
| `complexity` | `true` gives the group's generated melodic and rhythmic synths (arp, bells, shimmer, melody, pulse, sub) a complexity axis: they are rendered as a sparse base plus two layers that add notes, and X on the pad fades the layers in (the melodic and rhythmic presets). Other stems ignore X. |
| `maxActive`, `onFull` | At most N of the group on at once. `"replace-oldest"` fades out the longest-running one, `"ignore"` refuses the tap. |
| `minActive` | This many stems can't be switched off by participants, so a bed always plays. |
| `cooldown` | Seconds before the same stem can be changed again. |
| `gate` | `{ "participants": 2, "window": 10 }`: that many different people must tap within the window. Phones show "1/2 joined". |
| `decay` | Seconds a participant-started stem plays before it fades away by itself. |
| `hidden` | `true` hides the whole group from the phones: no pads, taps and XY are refused. Only the engine page, HTTP and sensors control it (the core preset). |
| `finale` | `true` makes starting a stem of this group the end-of-show signal (the climax preset): the stem strikes three times and every other stem fades out in stages. Further taps are ignored until a new show. |
| `maxPlays` | The most times participants can start a stem in one performance (the gong uses 3). The count resets with a new performance (Start engine, Restart run count, pack switch). Phones show "N left", then "spent". |
| `oneShot` | The stem plays once from its start instead of looping, lands on a bar line, and participants can't switch it off. The stem's `"playBars": N` limits how many bars of the file play. |
| `fadeIn`, `fadeOut` | Fade times (seconds) for the group's stems. |

Presets: **melodic** allows 3 at once with a 4 s cooldown. **rhythmic** allows 2 at once with a 6 s cooldown and quick fades. **core** keeps one layer always on, 3 s cooldown, limited XY range, 8 s fades. **nature** needs 2 people within 10 s, at most 2 at once, 5 s cooldown, fades away after 60 s, 6 s in / 10 s out. **accent** is one at a time, 20 s cooldown, fades away after 30 s. **climax** is the gong: 3 people within 20 s, one strike per vote, at most 3 strikes per performance, XY locked, instant attack (see "The Gong" in the main README). Packs without groups have no rules.

## Pattern drums (`synth: "beats"`)

A stem with `"synth": "beats"` plays one-shot samples from a pattern, so a few recordings become a living loop. See `packs/world-percussion/pack.json`.

- `voices`: `{ name: { files: [soft ... hard], gain, pan, lane, tune } }`. Paths are relative to the pack. More recordings per voice means more natural velocity.
- `tiers`: three objects (complexity low, mid, high), each `voice name -> pattern`. The pad's X axis fades between them.
- `steps`: steps per beat (default 4).
- Pattern characters: `X` accent, `x` normal, `o` ghost, `p` ghost played about half the time, `.` rest. `|` separates bars, which repeat to fill the loop.
- Each hit varies a little in velocity (which recording), timing (about 7 ms, accents stay on the grid) and tuning, so the loop never repeats exactly.
- Keep tempo 50 (or a pack tempo that divides the show grid) so the loop lines up.

## Combined packs

A pack can be built from other packs:

```json
{ "name": "Full set", "include": ["ambient-generated", "field-recordings-cc0"] }
```

Groups of the included packs carry over (a `groups` entry in the combined pack can override them). Stems from included packs that don't match the combined pack's tempo are left out and listed on its card.

## Notes

- Changes show up when you open **Packs…** (it rescans the folder). To pick up edits to the pack you're playing, press **Reload** on its card.
- The default pack at startup is `"pack"` in `config.json`.
- Switching packs fades out everything that's playing, then loads the new pack and restarts the bar count.
- Packs are uploaded with the app when you deploy it, so keep large libraries out of `packs/`.

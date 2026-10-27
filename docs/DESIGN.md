# RESONANCE PoC: Design, Function and Usage

A high-level guide. It reflects the `microcosm-trial` branch. Full reference: `README.md`, `MANUAL.md`, `packs/README.md`.

## Overview

RESONANCE is a proof of concept for a live room where the audience's phones add layers to one shared piece of ambient music, and every layer lands on the beat and in phase with the others. The sound is made in the browser, so a laptop alone can play a show.

The system has three parts:

- **Fangzhang 方丈** is the server (`server.js`). It holds the show state, decides what each phone may do, and keeps everyone in step.
- **Dantian 丹田** is the engine page (`/engine`). It makes all the sound with Web Audio and is the operator's console. It also hosts the Microcosm effect, Kits and the live input.
- **Daqian 大千** is the audience page (`/`). Each phone shows pads that switch instruments on and off and shape them with an XY control.

## Architecture and timing

Phones never make sound. They send taps to the server, the server applies the rules and tells everyone the new state, and the engine page turns that state into sound on the next bar line.

1. A phone taps a pad or moves its XY control. The message goes to the server over a WebSocket.
2. The server checks it against the rules for that instrument group (for example how many may be on at once, a cooldown, a limited XY range) and updates the shared state.
3. The server broadcasts the state and the pack configuration to every phone and to the engine.
4. The engine starts or stops the instrument on the next quantised boundary (beat or bar) and reports back what is playing.

The engine is the only clock. Every instrument is a loop of the same length, started on a bar line, so layers stay in phase however late they are switched on. The show runs at 50 BPM, which makes one bar 4.8 seconds. Generated loops are written to fit that grid, and recorded files must match the tempo and beats per bar of the pack.

The operator can also drive the server by hand: the engine page has the same toggles, and a plain `POST /api/input` accepts the same messages as a phone. `/api/state`, `/api/config`, `/api/packs` and `/api/kits` report what the server currently holds.

## Sound: packs, stems and synths

A **pack** is a folder under `packs/` that defines the instruments (**stems**) of a show: their names, colours, groups and where each sound comes from. A stem is either a recorded file or a generated one. Generated stems are built in the browser by `public/synth.js` when the engine loads, so a pack of synths needs no audio files. A `pack.json` is optional; without one the server infers the pack from the files and synth names it finds.

Stems sit in **groups** (for example Melodic and Rhythmic), and each group carries the audience rules: how many stems may be on, the cooldown, the XY range. Operator taps are never limited.

**Complexity layers.** A generated stem is rendered as three loops of the same length, from sparse to busy. The pad's X axis fades between them, so one pad moves from simple to rich. Recorded files ignore X.

**Genre melody packs.** Ten Melody packs (Ballad, Pop, Dance / House, Gospel, Jazz, Lo-fi, R&B / Neo-soul, Soulful seventies, Boom-bap, Trap) each play a genre progression with chords, bass, arp and a generated melody. All chords use only the notes of D minor (= F major), so everything stays diatonic and fits the ambient stems. They are melodic templates: chosen as the Melodic template in the Kit · Templates panel, and played in whatever kit is loaded.

**Rhythm templates (Pulse and Sub).** Each of these two instruments has several rhythm templates, and the stem's seed picks one, so pressing New variation on its pad changes the groove. Pulse has Heartbeat (the original), Tresillo, Four on the floor, Half-time breath, Syncopated and Rolling toms. Sub has Long line (the original), Root and chord tone, Syncopated bass, Slow breath, Octave bounce and Chord walk. Sub may now play chord tones as well as D and A, but only low notes that stay clear of the drone's pitches and of the pad, atmos and arp notes of that chord. The chord progression itself always comes from the show seed, so a single instrument's variation never changes the harmony.

**Pattern drums.** The `beats` synth plays one-shot samples from a written pattern. Each voice lists recordings from soft to hard, and each of three tiers gives a pattern per voice. In a pattern `X` is an accent, `x` a normal hit, `o` a ghost note, `p` a ghost played about half the time and `.` a rest; `|` separates bars. Every hit varies a little in velocity (which recording is used), timing (about 7 ms, accents stay on the grid) and tuning, so the loop never repeats exactly.

The **world-percussion** pack uses it for four parts: Darbuka, Congas and Bongos, Frame drum and Deep drums. It holds 41 CC0 samples (about 4 MB) from VCSL, Karoryfer, Fugue State Audio and the Stargate pack, and replaces the Pulse and Sub pair.

## Microcosm effect and live input

Microcosm is a granular effect, in the spirit of the pedal of that name, that chops what it hears into tiny grains and plays them back as swarms with feedback, tone and reverb. It runs as an AudioWorklet in the engine page and belongs to the operator only; the audience cannot touch it.

There are **two boxes**. Box A (arps, plucks and percussion) holds the presets that chop, repeat and strum: Mosaic, Glitch, Strum, Blocks and Pattern. Box B (long tones) holds Haze, Tunnel and Warp, which melt and bend held notes and pads. Each box has its own preset, five knobs (Activity, Size, Repeats, Tone, Mix) and an on/off switch, and is wet-only: it returns just before the master compressor.

**Sources.** A box only affects what you send to it. Each instrument in the left panel has **A** and **B** buttons; click one to send that instrument into the box, and click again to take it out. The box's chips and Add menu show and change the same selection. **Nothing chosen means no effect.** A box can take several instruments, and a percussive instrument can go into either box. Ticking *Mute the dry sources* silences the chosen instruments' normal sound so only the effect is heard, while the box is on.

**Live input.** The first row of the instrument list is Live input. Click it to start the Mac's microphone, 3.5 mm input or an audio interface. Its A and B buttons work like any instrument's; the gear opens the device list, the level and meter, *Hear the dry input too* (off by default, so only the effect is heard) and *Clean up* (echo cancellation and noise reduction, off by default because it dulls instruments). Use headphones with the built-in microphone, and open the engine page as `http://localhost:…` so the browser allows the microphone.

Both boxes start On; with no source chosen they do nothing. Settings are remembered per browser. A favorite can carry effect settings too (see below).

## Kit, templates and favorites: changing sounds during a show

The sound of the melodic and rhythmic groups is chosen in three steps:

1. **Kit: the sound.** A kit gives each melodic role (Chords, Bass, Arp, Melody A, Melody B) a *voice*: a synth voice (pad, pluck, bell, sub, glide lead, acid line) or a recorded sample repitched across the keyboard. Melody A is therefore a sound, not a tune: with the Layers kit it is the glide lead, Melody B the acid line.
2. **Template: the notes.** A melodic template (a melodic pack with stems that name their role) decides the chord progression and, for each role, how notes are generated: arp pattern, melody character (lyrical, flowing, leaping, bright, or a few long notes). A rhythmic template is a rhythmic pack (a Pulse and Sub groove, or the hand-drum patterns).
3. **Favorite: a saved combination** of a kit, both templates and the Microcosm settings.

Generation and sound are separate in the engine: each builder in `public/synth.js` produces a list of note events with the complexity layer each belongs to, and a voice plays them (`playEvents`). Any voice plays any generator, so a kit never adds notes from another synth: layer 0 of a melody is a sparse legato line and layers 1 and 2 add short notes in the same voice. The pad's X axis still fades the layers in and out, and the piano roll shows the notes. The note-by-note melody generator writes rhythm cells with rests, repeats and varies them over a four-bar phrase, pulls strong beats to chord tones, shapes a contour, and keeps the best of twelve scored candidate lines.

Loading swaps the two groups while the rest of the show (the core synth, nature recordings) keeps playing. A swap is gentle, not abrupt:

1. The server fades out the stems of the groups being replaced. Taps on those stems are blocked, and phones show "The sounds are changing…".
2. When those groups are silent, or after at most 45 seconds, the new sounds are applied and the server sends the new configuration. (Changing only the kit still re-renders the melodic stems, because their voices change.)
3. The engine builds only the stems that changed, applies the favorite's effect settings and shows "live" when done. Phones clear their pads for the changed instruments.

A template is refused if it doesn't fit: recorded files must match the pack's tempo and beats per bar, and generated stems must share its mode. A key mismatch only warns.

The **Kit · Templates…** button in the effect panel opens one window with the three steps. *Make or change a kit* builds a kit from synth voices; kits with recordings are folders in `soundkits/` with a `kit.json`. *Load kit + templates* applies a choice directly, and *Save favorite* stores it, with the Microcosm settings, under a name in `favorites/`. Starter kits: Layers (the original sounds), Glass, Analog, Pluck garden and Electric keys (samples). Starter favorites include Layers default, Glass and pulse, World pulse, Gospel · glide lead, House · analog, Lo-fi · electric keys and Long lines. Older favorite files in `kits/` still load.

Generated sounds take time to render after a swap (about 37 seconds in the slower test sandbox; expect less on a Mac), during which the new group is silent.

## Usage: running a show

**Set up.** You need Node.js 18 or newer, a computer wired to the PA, and phones on the same Wi-Fi. Run `npm install` once, then `npm start`; the server listens on port 8080.

**The operator (engine machine).**

1. Open `http://localhost:8080/engine`, send the computer's audio to the PA, and click **Start engine**. It renders the stems and starts silent.
2. Open the menu for the QR code and join link, and let the audience in.
3. Switch instruments on from the left panel, or let phones do it. Set tempo, key, chord source, fades and master volume in the same panel.
4. Shape the sound with Microcosm: choose a preset in each box, send instruments (or the live input) to A and/or B with the buttons beside them, and turn the box On.
5. Change the palette mid-show with **Kit · Templates…**: load a favorite (or a kit with templates) and the Melodic and Rhythmic groups fade, swap and return.
6. **New variation** sits in each instrument's pad window and renders a new version of that instrument only. **Stop all** fades the layers out in order, colour first and drone last.

Only one engine page plays: the page that pressed Start becomes the engine, and others stay in standby.

**The audience.** Scan the QR code, or open the address shown on the engine page with `http://`, not `https://`. Tapping an instrument opens its pad: left and right set the complexity, up and down the filter, and the fader the volume. The On/Off button inside the pad starts or stops it on the next beat. Some layers are shared on purpose: nature sounds need two people at once, and the Gong, which ends the show, needs three people within 20 seconds.

**Adding sounds.** Drop a pack folder into `packs/` (audio files, or a `pack.json` describing synths or pattern drums) and press Rescan in the pack list or Kits panel. Save a combination you like as a favorite. Add a sound kit as a JSON file (or a folder with samples) in `soundkits/`.

## Performance, limits and known gaps

**Load.** Everything is computed on the engine machine; phones only send small messages. The main cost is the engine's audio thread: each Microcosm box is a granular worklet, and generated stems add decode and render work at load. Offline measurements in a test sandbox, which is slower than a Mac, were used as an upper bound, and nothing has been measured on the show hardware yet.

**Not yet verified by ear.** The headless tests cover routing, kit swaps, rendering, levels, every voice on every generator, and the live input signal path. Nothing has been auditioned on the real Mac and phones, including the hand-drum patterns and the live input with a real microphone.

**Known gaps.**

- After a kit swap the new group is silent until its stems finish rendering. Pre-rendering the next kit during the fade-out would hide this; it is not built.
- A Microcosm box has no bypass when it is off, so the box's own path is always in the graph.
- Favorites do not store the live input settings.
- Rhythmic roles are not part of the kit: the kit covers Chords, Bass, Arp, Melody A and Melody B. The rhythmic template picks the groove, and the Pulse and Sub sounds themselves are fixed (the hand-drum pack brings its own recordings).
- Bells, Shimmer and Melody C/D in older packs have no role slot, so a kit does not change their sound.
- The hand-drum pack credits its CC0 sources in `pack.json`, but there is no separate Stargate licence file yet.

## Repository map

| Path | What it holds |
| --- | --- |
| `server.js` | Fangzhang: WebSocket and HTTP server, rules, kit swaps, API |
| `public/engine.html`, `public/engine.js` | Dantian: the operator console, mixing, Microcosm boxes, Kits panel, live input |
| `public/client.html` | Daqian: the audience page |
| `public/synth.js` | Generated instruments, complexity layers, the `beats` pattern player |
| `public/microcosm.js` | The granular effect (AudioWorklet) and its presets |
| `lib/packs.js` | Pack scanning and validation |
| `lib/soundkits.js` | Sound kits: voices per role, scan, save, apply to stems |
| `lib/kits.js` | Favorites and templates: roles, fit checks, compose, save, delete |
| `packs/` | Packs, including `world-percussion/` with its samples |
| `soundkits/` | Kits: JSON, or a folder with `kit.json` and samples |
| `favorites/` | Saved favorites (JSON); older ones in `kits/` still load |
| `README.md`, `MANUAL.md`, `packs/README.md` | Full reference docs |
| `docs/DESIGN.md` | This document |

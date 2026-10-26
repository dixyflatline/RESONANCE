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

**Pattern drums.** The `beats` synth plays one-shot samples from a written pattern. Each voice lists recordings from soft to hard, and each of three tiers gives a pattern per voice. In a pattern `X` is an accent, `x` a normal hit, `o` a ghost note, `p` a ghost played about half the time and `.` a rest; `|` separates bars. Every hit varies a little in velocity (which recording is used), timing (about 7 ms, accents stay on the grid) and tuning, so the loop never repeats exactly.

The **world-percussion** pack uses it for four parts: Darbuka, Congas and Bongos, Frame drum and Deep drums. It holds 41 CC0 samples (about 4 MB) from VCSL, Karoryfer, Fugue State Audio and the Stargate pack, and replaces the Pulse and Sub pair.

## Microcosm effect and live input

Microcosm is a granular effect, in the spirit of the pedal of that name, that chops what it hears into tiny grains and plays them back as swarms with feedback, tone and reverb. It runs as an AudioWorklet in the engine page and belongs to the operator only; the audience cannot touch it.

There are **two boxes**. Box A (arps, plucks and percussion) holds the presets that chop, repeat and strum: Mosaic, Glitch, Strum, Blocks and Pattern. Box B (long tones) holds Haze, Tunnel and Warp, which melt and bend held notes and pads. Each box has its own preset, five knobs (Activity, Size, Repeats, Tone, Mix) and an on/off switch, and is wet-only: it returns just before the master compressor.

**Sources.** A box only affects what you send to it. Each instrument in the left panel has **A** and **B** buttons; click one to send that instrument into the box, and click again to take it out. The box's chips and Add menu show and change the same selection. **Nothing chosen means no effect.** A box can take several instruments, and a percussive instrument can go into either box. Ticking *Mute the dry sources* silences the chosen instruments' normal sound so only the effect is heard, while the box is on.

**Live input.** The first row of the instrument list is Live input. Click it to start the Mac's microphone, 3.5 mm input or an audio interface. Its A and B buttons work like any instrument's; the gear opens the device list, the level and meter, *Hear the dry input too* (off by default, so only the effect is heard) and *Clean up* (echo cancellation and noise reduction, off by default because it dulls instruments). Use headphones with the built-in microphone, and open the engine page as `http://localhost:…` so the browser allows the microphone.

Settings are remembered per browser. A kit can carry effect settings too (see Kits).

## Kits: changing sounds during a show

A **kit** is a curated, saved choice of one Melodic sound set and one Rhythmic sound set, plus optional Microcosm settings. Loading a kit swaps those two groups while the rest of the show (the core synth, nature recordings) keeps playing. A **sound set** is an ordinary pack that offers a melodic or rhythmic group; the pack's `pack.json` can say which.

A swap is gentle, not abrupt:

1. The server fades out the stems of the groups being replaced. Taps on those stems are blocked, and phones show "The sounds are changing…".
2. When those groups are silent, or after at most 45 seconds, the new sounds are applied and the server sends the new configuration.
3. The engine builds only the stems that changed, applies the kit's effect settings and shows "live" when done. Phones clear their pads for the changed instruments.

A kit is refused if it doesn't fit: recorded files must match the pack's tempo and beats per bar, and generated stems must share its mode. A key mismatch only warns.

The **Kits…** button in the effect panel opens the library. Each kit has Load and Remove (two clicks) buttons. *Load these sounds* picks a melodic and a rhythmic set directly, and *Save kit* stores the current choice, with the Microcosm settings, under a name in `kits/`. Starter kits are Layers default, Tidal melodies, Glass and pulse, and World pulse (the hand drums).

Generated sounds take time to render after a swap (about 37 seconds in the slower test sandbox; expect less on a Mac), during which the new group is silent.

## Usage: running a show

**Set up.** You need Node.js 18 or newer, a computer wired to the PA, and phones on the same Wi-Fi. Run `npm install` once, then `npm start`; the server listens on port 8080.

**The operator (engine machine).**

1. Open `http://localhost:8080/engine`, send the computer's audio to the PA, and click **Start engine**. It renders the stems and starts silent.
2. Open the menu for the QR code and join link, and let the audience in.
3. Switch instruments on from the left panel, or let phones do it. Set tempo, key, chord source, fades and master volume in the same panel.
4. Shape the sound with Microcosm: choose a preset in each box, send instruments (or the live input) to A and/or B with the buttons beside them, and turn the box On.
5. Change the palette mid-show with **Kits…**: load a kit and the Melodic and Rhythmic groups fade, swap and return.
6. **New variation** re-seeds melodies, bells, arp, bass and rhythm details. **Stop all** fades the layers out in order, colour first and drone last.

Only one engine page plays: the page that pressed Start becomes the engine, and others stay in standby.

**The audience.** Scan the QR code, or open the address shown on the engine page with `http://`, not `https://`. Tapping an instrument opens its pad: left and right set the complexity, up and down the filter, and the fader the volume. The On/Off button inside the pad starts or stops it on the next beat. Some layers are shared on purpose: nature sounds need two people at once, and the Gong, which ends the show, needs three people within 20 seconds.

**Adding sounds.** Drop a pack folder into `packs/` (audio files, or a `pack.json` describing synths or pattern drums) and press Rescan in the pack list or Kits panel. Save a combination you like as a kit.

## Performance, limits and known gaps

**Load.** Everything is computed on the engine machine; phones only send small messages. The main cost is the engine's audio thread: each Microcosm box is a granular worklet, and generated stems add decode and render work at load. Offline measurements in a test sandbox, which is slower than a Mac, were used as an upper bound, and nothing has been measured on the show hardware yet.

**Not yet verified by ear.** The headless tests cover routing, kit swaps, rendering, levels and the live input signal path. Nothing has been auditioned on the real Mac and phones, including the hand-drum patterns and the live input with a real microphone.

**Known gaps.**

- After a kit swap the new group is silent until its stems finish rendering. Pre-rendering the next kit during the fade-out would hide this; it is not built.
- A Microcosm box has no bypass when it is off, so the box's own path is always in the graph.
- Kits do not store the live input settings.
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
| `lib/kits.js` | Kit rules: roles, fit checks, compose, save, delete |
| `packs/` | Packs, including `world-percussion/` with its samples |
| `kits/` | Saved kits (JSON) |
| `README.md`, `MANUAL.md`, `packs/README.md` | Full reference docs |
| `docs/DESIGN.md` | This document |

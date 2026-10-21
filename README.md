# RESONANCE

**A live-performance instrument where the audience plays the music.** Phones in the room become controllers; one machine plays the sound through the PA.

RESONANCE is the proof of concept (PoC) for a cybernetic, biofeedback-ready live performance. People in the audience tap buttons on their phones to bring ambient layers in and out (drone, pad, arpeggio, bells, a bass line, melodies, field recordings). Every layer is locked to one shared clock and one shared harmony plan, so whatever the crowd does, it stays in time and in tune. The same input path is meant to take biosensor data later (heart rate, breath, movement), so the room's body can shape the music as well as its fingers.

![status](https://img.shields.io/badge/status-proof%20of%20concept-orange)

## What it does

- **The audience plays.** Each phone shows one button per layer. Tap a button to open that layer's pad (complexity and filter) and volume fader, with the on/off button and a × inside, so people play with one instrument instead of tapping every sound once.
- **It always sounds musical.** Layers enter on the beat, phase-aligned to a master clock, with long fades. All generated layers follow one chord progression (Dm9, B♭maj7♯11, Fmaj9, C6/9) and a priority-based harmony plan, so layers do not clash.
- **The performer stays in control.** The engine page has the tempo, key, fades, progression runs, a master volume and a Stop all that brings the instruments out in order. Audience rules (cooldowns, limits, a three-person vote for the gong) stop the room from wrecking the piece.
- **No outside services.** No cloud, no LLM, no accounts. The music is generated in the browser with the Web Audio API, plus a few CC0 field recordings.

## The three parts

| Code name | What it is | URL |
|---|---|---|
| **Fangzhang 方丈** | The server (Node + WebSocket). Keeps the state and the rules, plays nothing. | runs in the terminal |
| **Dantian 丹田** | The engine page. Generates and plays all the audio. Open it on the machine wired to the PA. | `/engine` |
| **Daqian 大千** | The audience page on each phone. | `/` |

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer, and a computer plus phones on the same Wi-Fi.

```bash
git clone https://github.com/dixyflatline/RESONANCE.git
cd RESONANCE
npm install            # one dependency: ws
npm run fetch-stems    # optional: downloads the 4 CC0 field recordings (see "Sample pack" below)
npm start              # server on http://localhost:8080
```

## How to use it

**The performer (on the machine connected to the PA)**

1. Open **http://localhost:8080/engine** and send this computer's audio output to the PA.
2. Click **Start engine**. It renders the stems, then everything starts silent.
3. Open the **☰ menu** to show the QR code and join link for the audience.
4. Shape the performance from the sidebar: BPM (while music is playing the tempo glides to the new value, 3 BPM per bar; with nothing playing it jumps straight to it without rendering anything; the stems are rendered once, at the new tempo, when the first stem is switched on), progression runs (Endless, or 1 to 64 runs, then an automatic fade-out), quantize, key, fades, brightness and master volume. Toggle stems yourself by clicking them; the engine page is not limited by audience rules.
5. **Chord display for** switches the on-screen chords between concert pitch and **B♭ instruments** (trumpet, clarinet, tenor sax), which read two semitones higher: Dm9 · B♭maj7♯11 · Fmaj9 · C6/9 shows as Em9 · Cmaj7♯11 · Gmaj9 · D6/9. Only the display changes, never the audio, and the choice is remembered in the browser.
5. **New variation** re-seeds the melodies, bells, arp, bass and rhythm details. **Stop all** fades the layers out in order, colour first and drone last.

**The audience (on their phones)**

1. Scan the QR code, or open the LAN address shown on the engine page (use `http://`, not `https://`).
2. Tap a button to open that layer's pad: complexity (left/right) and filter (up/down), plus a volume fader at the side.
3. Use the On/Off button inside to bring the layer in or out (it lands on the next beat), and the × to close.
4. Some layers are shared on purpose: nature sounds need two people at once, and the **Gong** is the end of the show: three people within 20 seconds sound it three times while all the music fades out.

**Only one engine tab.** Opening the engine page (in any browser) only connects it in standby: a running engine keeps playing. The page that **presses Start** becomes the engine, and any other engine page that was playing goes idle ("Another engine tab took over") and stops its sound. If the buttons stop responding, check that nothing else started as the engine.

Full details are below: rules, harmony, joining from an iPhone, and the inputs for biosensors.

## Sample pack

RESONANCE needs no samples to run. The default packs generate their stems procedurally. For the natural, organic layer, the **Field recordings · CC0** pack is used: four public-domain recordings, cut into seamless bar-aligned loops at 50 BPM (the default tempo). The Gong is pitched up 12 semitones: the raw recording is a very low tam-tam with almost nothing above 400 Hz and did not read as a gong.

| Layer | Recording | Author | Source |
|---|---|---|---|
| Stream | "Stream / river water up close" | jackthemurray (via Freesound) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:433589_jackthemurray_stream-river-water-up-close.wav) |
| Rain | "Light Rain, Distant Thunder, July 5th 2016" | kvgarlic (via Freesound) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Light_Rain_Distant_Thunder_July_5th_2016.wav) |
| Garden | "Garden at Pioneer Works" (birds, wind) | Ogbabydiesal | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Garden_at_Pioneer_Works.wav) |
| Gong | "Chinese gong, finish of session" | the_very_Real_Horst (via Freesound) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:240382_the-very-real-horst_chinese-gong-finish-session-2014-06-10-29-143.wav) |

**Why this pack:** the original spec named a commercial sample library (Selekt Audio), but it now needs a paid trial with a card on file. These four recordings are licensed **CC0 1.0** (public-domain dedication), so they are free to use in a public performance with no attribution required. They also have no musical key, so they sit under any chord. Credit is given here anyway.

**How the pack is built:** the WAV loops are not stored in this repository. `npm run fetch-stems` downloads the originals from Wikimedia Commons and cuts them into loops in `packs/field-recordings-cc0/` (it also writes a `CREDITS.md` there). Until you run it, the pack shows as unavailable and the generated packs work as normal. Check each file's page above for the licence before reuse; the licence is the author's choice and lives on the Commons page.

To use your own samples, drop WAV loops into a folder under `packs/`. See [packs/README.md](packs/README.md).

## License

No open-source licence has been chosen for the code yet, so all rights are reserved by the author. The field recordings are CC0 (see above).

## Names

The parts of RESONANCE have code names from Chan (Zen) monastery life:

- **Fangzhang 方丈** (the abbot): the server. It keeps the clock, the rules and the state, and plays nothing itself.
- **Dantian 丹田** (the centre below the navel, where breath gathers): the engine page. It plays the sound to the PA.
- **Daqian 大千** (the great thousand worlds, everyone and everything gathered): the audience's phone pages.

The names are used in the page headings, the terminal output and these docs. The code itself still calls them server, engine and client, and the URLs are unchanged (`/` for Daqian, `/engine` for Dantian).

## Run it

```bash
cd resonance-poc
npm install        # installs the one dependency: ws
npm start          # or: PORT=9000 npm start. Restarts itself when the server code changes.
```

1. On the performance machine (audio → PA), open **http://localhost:8080/engine** and click **Start engine**.
2. Audience phones on the same Wi-Fi open the LAN URL printed in the terminal (it's also shown on the engine page), e.g. `http://192.168.1.23:8080/`.
3. Tap to layer stems. A stem comes in on the next beat at the current position on the master timeline.

**Auto-restart:** `npm start` runs the server under a small supervisor (`tools/run.js`). It restarts the server whenever `server.js` or `lib/` change, and the engine sidebar has a **Restart server** button (shows uptime and phones connected). When the code has changed, phones reload themselves and the engine page shows a **Reload page** bar (it doesn't reload by itself, so your audio isn't cut). Use `npm run start:plain` to skip the supervisor.

> On macOS, the first run may ask whether Node can accept incoming connections. Allow it, or phones won't be able to connect.

## Deploying online

See [DEPLOY.md](DEPLOY.md) for Railway (CLI) or Render (free, via GitHub). Vercel can't host the WebSocket server.

## How it maps to the spec

| Spec item | Implementation |
|---|---|
| WebSocket transport | `ws` on `/ws`; roles: `client`, `engine`, `sensor` |
| Messages | `{type:"toggle", stem}` → server; `{type:"state", active, playing, …}` → everyone |
| Audio on server machine only | `engine.html` tab (Web Audio API). Clients only send messages |
| Master clock | `AudioContext.currentTime` only; timeline origin `t0`. Timers are used for UI only |
| Quantised triggers | next beat by default; half-bar / bar selectable on the engine page |
| Phase-aligned entry | `offset = (boundary − t0) mod loopLength` (see note below) |
| Fades | every stem enters from silence with an S-curve fade-in and leaves with a fade-out (`fadeIn` / `fadeOut` in config.json, default 4 s; adjustable live on the engine page; per-stem override with `"fadeIn"` / `"fadeOut"` on a stem) |
| New client gets state | yes, sent on connect; all clients get every change |
| Sensor-ready input | every input goes through `handleInput()` in `server.js` |

**Note on phase alignment:** the spec computes `posInBar`. For multi-bar loops the engine uses position **mod loop length**, which keeps bar 5 of one stem aligned with bar 5 of every other stem. With 1-bar loops the two formulas give the same result.

**Button states:** *starting* / *stopping* (pulsing) means the change is queued for the next beat. *playing* means the engine reports the stem is sounding.

## Per-layer controller (complexity + cutoff + volume)

Every layer has a pad and a volume fader, in the style of GarageBand's Smart Instruments. On phones **tapping a button opens that layer's sheet**: the pad, the volume fader, an **On/Off** button (the layer comes in on the next beat; a pending vote shows as "1/2 joined") and a **×** to close. The aim is to get people to play with one instrument instead of tapping every sound once. Dragging on the button itself does nothing, so a swipe can never change the music by accident. The sheet has a big **ON/OFF switch** (it turns the layer's colour when on) and a **?** button beside it. The switch answers a tap at once and a line under the title says what is happening: "Starting: waiting for the next bar…" (it says beat, half bar or bar, following the engine's Quantize setting), "Fading out…", "1/2 joined. Waiting for the others…", "Waiting for the show to start…" before the engine is running, then "Playing". If the server refuses a tap (a cooldown, say) the switch flips back and the reason appears. The **first time anyone opens a pad on a phone**, a card with the plain-language explanation sits on top of the pad; the **×** or **Got it** crosses it off, and the **?** brings it back any time. The card has three parts: **the sound** (what it is), **play with it** (what dragging does) and **joining in** (the voting and limits that apply: how many people must press together, how many sounds of the group can play at once, the cooldown, whether it fades away by itself). Add `?help=1` to the phone address to see the card every time (handy when testing); the "seen" flag is kept in the browser. The sound descriptions are built in for every generated synth, and a stem can set its own with an `about` line in pack.json; the joining-in text is written from the group's rules. Layers that need a group vote (any group with a `gate`: the nature samples and the gong) have **no pad, no switch and no ?**: their sheet is the explanation (the sound, the vote and, for the nature samples, the volume), a big **Vote** button that shows the vote count ("1/2 joined") and becomes **Stop** once the sound is playing, and the **volume bar** for the nature samples. The gong has no volume bar, and its button reads Struck after the vote succeeds. So the end-of-show vote is two taps and can't happen by accident.

On the engine page nothing changes: the stem rows still toggle on a click, and the small square next to each layer opens the same sheet (with a Done button instead of the ×).

- **Pad, X (left → right): complexity.** From a sparse part to a dense one. This exists only for the generated **melodic and rhythmic** layers (Arp, Bells, Shimmer, both melodies, Pulse, Sub). The core synth, the nature samples and the gong have no complexity: their pad moves up and down only.
- **Pad, Y (bottom → top): filter cutoff**, 60 Hz → 20 kHz on a log scale, with a touch of resonance so a sweep sings. Top means the filter is open.
- **Fader at the side: volume.** The default (0.8) is the layer's `gain` from config.json, the top is +3.9 dB and the bottom is silent.
- **Double-tap** the pad (or the fader) to reset it. The default is complexity 60%, filter open, normal volume.

How complexity works: the music is pre-rendered in loops, so complexity is built in at render time. Each melodic and rhythmic layer is rendered as **three same-length loops that play in sync**: a sparse base that is always on, and two layers that add notes. The pad's X fades layer 1 in from 15% to 45% and layer 2 from 50% to 90% (a smooth glide with no clicks; `layerGain` in public/xy.js). Because the layers only add notes, nothing cancels as you slide. What each layer adds:

| Layer | Base (sparse) | + layer 1 | + layer 2 |
|---|---|---|---|
| Arp | a note every 2 beats | the beats in between and the off-beat eighths (the old pattern, with its gaps) | quiet sixteenth-note fills, sometimes an octave up |
| Bells | the first bell of each chord | three more bells per chord | four more, softer bells (8 per chord in all) |
| Shimmer | one chord tone | a second chord tone | the third tone and the first an octave up |
| Melody A, B (long leads) | the long notes | a second, shorter line an octave up that keeps a semitone away from the long notes, plus the 12 strongest notes of a plucked line | the other 16 notes of that plucked line (a note on almost every beat) |
| Other melodies (lyrical, flowing, ...) | strong beats and phrase ends | the other beats | the off-beats |
| Pulse | the heartbeat's first thump | the second thump, the shaker's eighths and a tuned tom after beats 2 and 4 | sixteenth shaker, pick-up, ghost thump and a second tom on the last sixteenth of every beat |
| Sub | one long note per chord (the original sound) | a soft pulse on the bar's root on every beat (quarter notes) | pulses in between as well (eighth notes) |

Gate length (Arp and Bells): every note also gets longer as the complexity rises. At the sparse end each note is a short pluck (Arp) or a short bell strike, layer 1 adds a longer tail of the same pitch (about the old note length) and layer 2 a still longer one, so notes ring longer before they are cut off. Tails are separate soft-attack layers of the same notes, so the change glides with the pad.

Density target (per 8 bars) for Melody A, Melody B and Bells: about 4 notes at the sparse end (the original sound, unchanged), 16 at the middle (X about 0.5) and 32 at the complex end, i.e. 1, 4 and 8 notes per 2 bars. The Sub does not add notes; it pulses instead (quarter notes in the middle, eighth notes at the complex end). Pulse keeps its own scale: 16 thumps at the sparse end and over 100 hits (thumps, toms and shaker) at the complex end.

Rendering takes about twice as long as before, and the extra layers use about three times the memory of those layers. The exported WAV of such a layer is the full mix (base plus both layers).

Positions are shared. When someone moves a pad, everyone's view of it updates, and anyone who connects later sees the current positions. The pad also works while a layer is off, so it enters with those settings. Sensors or scripts can send the same message: `{"type":"xy","stem":3,"x":0.4,"y":0.7,"v":0.8}` (x = complexity, y = cutoff, v = volume; leave out what you don't change) over the WebSocket or `POST /api/input`.

## Sample packs

Samples live in **packs**: one folder per pack under `packs/`. Click **Browse packs…** in the engine sidebar to see every pack (tempo, key, stems, size, license, credits, warnings) and switch with **Use this pack**. Switching fades out what's playing, loads the new pack on the engine, and updates every phone. `npm run packs` prints the same list in a terminal. The default at startup is `"pack"` in `config.json`.

| Pack | What it is |
|---|---|
| `ambient-generated` | The 8 procedural stems (no files needed) |
| `field-recordings-cc0` | 4 CC0 recordings: Stream, Rain, Garden, Gong (run `npm run fetch-stems`) |
| `melody-progression` | Generated melody over **1–4–3–6–2–5–1** in the same minor key as the generated stems (i–iv–III–VI–ii°–v–i; 8-bar loop, so it lines up with the ambient stems): Chords, Bass, Arp, Melody. `melody-progression-major` is the major version (set `"mode"` in pack.json). *New variation* re-rolls the melody; *Key* transposes it |
| `layers` (default) | Five groups, each with its own audience rules: **Core synth** (Drone, Pad, Atmos, Noise), **Melodic** (Arp, Bells, Shimmer, Melody A glide lead, Melody B acid line), **Rhythmic** (Pulse, Sub), **Nature samples** (Stream, Rain, Garden) and a **Gong** accent |
| `core-synth`, `melodic-synth`, `rhythmic-synth` | The synth groups on their own (`layers` is built from them plus the field recordings) |
| `melody-ambient` | Four generated melodies to choose from (lyrical, flowing, leaping, bright) + an arpeggio, all **following the ambient stems' chords** (i–VI–III–VII, 8 bars) |
| `ambient-melody` | The 8 ambient stems plus those melody stems: everything layers freely |
| `full-set` | Both of the above combined |

**Add your own:** drop a folder of WAV loops into `packs/` (tempo is read from names like `pad_70bpm.wav`, loop length from the audio), or add a `pack.json` for names, roles, colours and levels. The pack list flags loops that are too short or not a whole number of bars. Full details: [packs/README.md](packs/README.md).

### CC0 field recordings

```bash
npm run fetch-stems
```

Downloads 4 CC0 recordings from Wikimedia Commons and cuts them into seamless 50 BPM loops in `packs/field-recordings-cc0/` (`cc0_*_50bpm.wav`), with a `CREDITS.md`. It skips files that already exist; add `-- --force` to rebuild them. Options (environment variables): `TEMPO=60` cuts for another tempo (then point `pack.json` at the `*_60bpm.wav` files), and `GONG_SHIFT=12` sets how many semitones the gong is pitched up (0 = the raw recording). If a source recording is too short for a loop, the tool cuts fewer bars and says which `bars` value to set in `pack.json`. Until you run it, that pack has no playable stems and is shown as unavailable.

| Pad | Source (CC0) | Loop |
|---|---|---|
| Stream | "Stream / river water up close", jackthemurray | 16 bars |
| Rain | "Light Rain, Distant Thunder, July 5th 2016", kvgarlic | 16 bars |
| Garden | "Garden at Pioneer Works" (birds, wind), Ogbabydiesal | 8 bars |
| Gong | "Chinese gong, finish of session", the_very_Real_Horst | 8 bars |

> Selekt Audio (named in the spec) now requires a paid trial with a card on file, so the free path uses Wikimedia Commons.

**Export WAVs** on the engine page downloads the generated stems as loop files.

## Chord charts from MusicXML

The generated stems normally follow the built-in progression (Dm9, B♭maj7♯11, Fmaj9, C6/9). **Chord chart (MusicXML)** in the Dantian sidebar replaces it with the chord symbols of a file you choose, and every generated stem (Drone, Pad, Atmos, Sub, Arp, Bells, Shimmer and the melodies) is re-rendered to follow it. The new chart swaps in on the next bar.

1. Notation programs (MuseScore, Finale, Dorico, Sibelius, Noteflight) export MusicXML: **.musicxml**, **.xml** or the compressed **.mxl**. The file must contain chord symbols above the staff.
2. In the sidebar click **Choose file…** and pick the file. Your computer's file dialog shows any synced drive folder (Google Drive, iCloud, Dropbox); a file that lives only online needs downloading first.
3. The panel under the picker shows what was read: the bars, the number of chords, the concert key and the chords in concert pitch.
4. **Built-in progression** goes back to the default.

**B♭ and other transposing parts.** Chord symbols in a B♭ trumpet or clarinet part are written two semitones above the sound. *File symbols are* **Auto** reads the `transpose` tag of the part (concert = written − 2). If a file was exported without that tag, choose **Written for B♭**; if it holds concert-pitch symbols, choose **Concert pitch**. The engine always plays concert pitch. The *Chord display for* menu then shows the chart in concert pitch or in B♭ (+2), so a trumpet player reads the same chords as the file's own.

**Chords per bar.** *Show as written* keeps changes down to half a bar in the chord display; *Show one per bar* keeps the chord that sounds longest in each bar.

**How the arrangement follows a chart.** To keep it ambient and clear, the Pad, Atmos, Arp, Bells, Shimmer and the melodies play one chord per bar: in a bar with two chords (for example Bm7 E7) the first is ignored and the second holds the whole bar. The Drone, Pulse and Sub stay on the tonic and fifth. The registers are kept apart and low. The **Pad** is three voices, one in each octave band (G♯2–G3, A3–G♯4, A4–G♯5), at least a fourth apart, always carrying the third and the seventh when they fit. The **Atmos** is two voices above it (C4–B5) on chord tones the Pad does not use. The **Arp** takes the lowest chord tones from G3 up, the **melody** sits an octave lower than in the built-in arrangement (around E♭3 to B♭4 in E♭), and the **Bells** and **Shimmer** an octave lower too. Notes that two neighbouring chords share are held as one long note instead of being played again, so the changes move by small steps. A chord that is far from the key may get only two Pad voices: the notes that would rub against the Drone are left out. For a chart the Pad is also warmer (triangle and sine with a little saw, slower swells). The chord display still shows every chord as written.

**Details and limits.**

- One measure of the file is one bar of the engine (4/4), whatever its time signature, and the engine's BPM is not changed by the file's tempo.
- Repeat signs and numbered endings (1st and 2nd time bars) are played out: a 26-measure file with a repeat and two endings becomes the 32 bars that are actually performed, then loops. The panel under the picker says how many bars the file became. Only the first 64 bars are used.
- The first part that has chord symbols is used. A file with only a melody (no chord symbols) is refused.
- The Key menu transposes the whole chart. The Drone, Pulse and Sub sit on the chart's tonic and fifth, like the built-in progression.
- Chord qualities come from the file's `kind` and `degree` elements; the file's own spelling (for example "m7" or "Δ") is shown.
- [examples/bb-trumpet-example.musicxml](examples/bb-trumpet-example.musicxml) is a 16-bar chart written for B♭ trumpet to try it with.

## Lush voices and Lush reverb

Two switches in the Dantian sidebar (under Quantize and Key, on by default, remembered per browser). Switching re-renders the generated stems, so you can A/B them against the plain sound.

- **Lush voices (Pad and Atmos).** Each note is a five-oscillator unison spread across about ±10–16 cents with a little random jitter, each oscillator panned across the stereo field and each with its own very slow pitch drift (0.05–0.2 Hz, a few cents), so the beating never settles into a pattern. A two-tap chorus (slowly modulated delays panned hard left and right, a whole number of cycles per loop so it wraps) sits on top. When the lowest Pad note lands on the key's tonic or fifth, a quiet sine an octave below it doubles a note the Drone already holds. Levels are trimmed so the layer is about as loud as before.
- **Lush reverb.** The impulse response is stereo with decorrelated channels, a 30 ms pre-delay, sparse early reflections and a diffuse onset, and the highs die away faster than the lows (like air absorption in a hall, about 8.5 s for the lows). Drone, Sub and Pulse use a small 2 s room so their low end stays tight; every other stem shares the hall, whose wet signal is high-passed at 150 Hz. Pad and Atmos send about 1.6× more into it, and each Atmos note also sends an octave-up sine into the reverb only, so the tail blooms upward (an additive shimmer).

Turning both off gives the earlier sound exactly.

### The two analog leads (Melody A and B)

In the Layers pack the two melodies are long, sparse, monophonic analog voices, nothing like the plucked Arp, Bells and Shimmer. Each plays a few long notes, on bar lines (glide mostly 3–8 bars, acid 2–6 bars), and then rests for one to three bars; every note is a chord tone of the chord sounding when it starts, stays consonant (a chord tone or colour tone, never a semitone from a chord tone) across every chord change and bar line it crosses, and must fit under the Pad, Atmos and bass of every chord it crosses (or is cut at the chord change), and some notes are joined into short legato phrases.

- **Melody A: glide lead.** Two detuned saws plus a square an octave below, through a resonant low-pass that opens on each note and settles, a little tanh warmth and a slow vibrato that fades in. Notes in a phrase are joined by a very slow portamento: the glide takes 55–80% of the new note, so the pitch is almost always on the move. The sound fades in over 2.2 s, the first note scoops up into pitch from two semitones below over 1.2 s, and the filter opens slowly. Register G3–D5, a slow dotted-quarter echo.
- **Melody B: acid line.** A TB-303-style voice: one saw (sometimes square) into two resonant low-passes in series, hard distortion and a filter that swells open at the start of each note, then settles. Some notes are accented (opens wider, louder). Joined notes are 303-style slides, slowed right down: the glide takes 55–80% of the new note, with the gate held. Each phrase fades in over 4 s with the filter closed at first and a lower resonance, and fades out over about 1.5 s. The tone moves as slowly as the glide: one long filter swell per note, opening over roughly the first half and closing over the rest, with time constants that scale with the note length and no quick filter snaps. Register B♭2–F4 (46–65 in MIDI numbers), a dotted-eighth echo.

## Generated stems

All stems follow one progression, i – VI – III – VII (Dm9 · B♭maj7♯11 · Fmaj9 · C6/9), with 2 bars per chord:

1. **Drone**: tonic, fifth and octave, detuned saws, slow filter sweep. It sits low: the lowest tonic at or above C1 (about 33 Hz), so D is D1 and Eb is Eb1; keys from Ab to B were already that low
2. **Pad**: chord pad
3. **Sub**: sine bass limited to D and A (the notes the Drone already holds), picked from the chord's tones; changes note per bar
4. **Arp**: plucked 8th-note arpeggio with dotted-8th delay
5. **Tide**: filtered-noise "waves" + air
6. **Pulse**: slow heartbeat (lub-dub on beats 1 & 3) + soft shaker, a nod to the biofeedback concept
7. **Bells**: sparse FM bell melody
8. **Shimmer**: an aggressive distorted-guitar voice: sustained chord tones on detuned saws and a square, through a pedal chain of a slight wah (a band-pass sweeping about every 3 s, mixed with the dry signal), heavy distortion, and a deep, fast 5.5 Hz tremolo, with a dotted-eighth echo

Each loop is rendered in circular time: the reverb, delay and note tails past the loop end are folded back onto the start, so the loop point doesn't click or drop out. **New variation** re-rolls the random seed, and the **Key** menu changes the key. Both swap the new stems in on the next bar.

**Staying clear of the Drone:** see *Harmony rules* below. The Pulse heartbeat drops onto the tonic of the key (D2 in D) and follows the Key menu.

## Rehearsal: simulated audience and monitor

Practise playing against a changing room without a room full of people. Open **http://localhost:8080/rehearsal** (the same machine that runs the server; there is also a link in the engine menu).

- **Five simulated people** connect to the server like real phones (WebSocket, `role=client`), so every audience rule applies to them: group limits, cooldowns, the nature samples' two-person vote, the pad ranges. Each has a persona: *Explorer* (tries lots of layers), *Tweaker* (shapes one layer with the pad), *Rhythm lover* (rhythm and melody layers, big complexity sweeps), *Calm listener* (nature and soft touches) and *Mischief* (fast flips, wild cutoff and volume). Change a person's persona or send them out of the room at any time.
- **The room:** *Calm*, *Busy* and *Storm* set how active everyone is; *Waves* makes the room breathe between calm and busy every few minutes; the Activity slider sets the level; *People come and go* makes them leave and return, so the crowd size changes.
- **The monitor** shows every stem (off, waiting for the bar, sounding, a vote in progress, its pad position and volume, and who touched it last), the group limits, the five people and what each is doing, a 3-minute activity chart and a log of what just happened (refusals included). It also shows real phones and your own taps on the engine page, so you can rehearse with a mixed room.
- **The gong** is never voted by the simulation on its own. *Gong vote now* (two clicks) makes three simulated people vote together; if it succeeds, the show ends as it would for an audience.
- **Access:** the page, `/api/sim` and the monitor socket answer only to the machine the server runs on (a request that arrives through a proxy counts as remote). With `ENGINE_KEY` set they answer to anyone with the key (`/rehearsal?key=…`). Everyone else gets the same 404 as for any page that does not exist, so phones cannot reach it. Use `localhost`, not the Wi-Fi address, on the same machine.
- Files: `lib/sim.js` (the simulator), `admin/rehearsal.html` (the page; it lives outside `public/` so it is never served as a plain file), server routes in `server.js`.

## Piano roll on the phones

While the engine renders a layer that has complexity, `synth.js` records every note it builds (`rec()` in the leaf voices: pluck, bell, thump, noise hit, pad, glide and acid leads, sub notes) as `[start beat, length in beats, pitch, layer]` in beats, so a tempo change keeps them right. `renderStem` attaches them to the buffer as `roll`. The engine sends them to the server as `notes` messages (one per stem, again whenever it renders, and again after a reconnect or claim), and the server keeps the latest per stem for phones that join later and forwards them to phones only. The engine's `tick` message carries `n` (the beat count since the loop start) and `bpm`, which the phone runs a local clock on (nudged toward each tick). When a layer is switched on, the engine also sends `sched` with the beat where it will come in, so the phone can mark the entry line exactly. `public/roll.js` draws the strip; the pad sheet in `xy.js` hosts it when the page passes a `rollView(id)` function (the phone page does, the engine page does not).

## Microcosm effect box

A separate granular effect, in the spirit of the Hologram Electronics Microcosm pedal (`public/microcosm.js`, an AudioWorklet; a new implementation, not the pedal's code). It listens to the mix, keeps the last 12 seconds and plays it back as swarms of tiny grains, with feedback, a tone filter and a reverb. It is a wet-only send: the engine takes it after the brightness filter and returns it just before the compressor, so the dry mix is never touched. It is **off** when the engine starts.

- **Where:** its own column between the sidebar and the visuals on the engine page (tabs for boxes A and B; each with On/Off, Sources, its preset buttons, Activity, Size, Repeats, Tone, Mix). Its settings are remembered in the browser. The audience cannot reach it.
- **Two boxes:** A (`rhythm` presets: Mosaic, Glitch, Strum, Blocks, Pattern) for arps, plucks and percussion; B (`sustain` presets: Haze, Tunnel, Warp) for long tones. The split lives in `ResonanceMicro.GROUPS` (`public/microcosm.js`); each box is its own `ResonanceMicro` instance (the worklet module is registered once per audio context).
- **Sources:** per box, any number of instruments. Every stem has **A** and **B** toggles in the sidebar (or use the box's Add menu; chips show and remove them, Clear empties the set); each stem has a send gain per box (`st.fxSends.a` / `.b`, taken after the stem's own cutoff and volume) that is 1 when chosen. With none chosen the box hears the whole mix (its own `masterSend`, after the brightness filter). The effects are wet-only and return before the compressor, so a source keeps playing dry (`st.dry`) unless that box's *Mute the dry sources* is ticked and the box is on. Selections are remembered by name, so they survive a pack switch. Settings live in localStorage `resonance.micro2` (an older single-box save is carried into the box its preset suits).
- **Presets** (four families, two each): **Mosaic** (a tiny loop repeats in layers, some an octave up or down) and **Glitch** (tempo-synced stutter, skips, reverse slices); **Haze** (dense soft cloud) and **Tunnel** (long dark swells, backwards echoes); **Strum** (tuned harp-like strums on a minor pentatonic) and **Blocks** (the last bar chopped into chunks and replayed in a stepped order); **Warp** (slow wobbling pitch-bends) and **Pattern** (a tiny loop played as a tuned 16th-note arpeggio).
- **Knobs:** Activity = how many grains / how fast (the stepped presets change step length), Size = grain and loop length, Repeats = feedback, Tone = low-pass filter, Mix = wet level. Choosing a preset moves the knobs to its own starting values.
- **Tempo:** Glitch, Blocks, Pattern and Strum follow the engine BPM, including its glide.
- **Audition it alone:** open `/micro.html` on the server. It plays a short loop of the Arp, Bells and Melody through the effect with the same presets and knobs.

## Groups and audience rules

Packs can sort stems into groups with rules for remote participants. The `layers` pack has five:

- **Core synth** (Drone, Pad, Atmos, Noise): the bed of the piece. **Hidden from the phones**: there are no pads for it, and taps or XY from a phone are refused. Only the engine page (sidebar rows), `POST /api/input` and sensors control it. Slow 8 s fades. (Set `"hidden": false` in the group's `rules` to give it back to the audience.) *Atmos* is a blend layer: two timbres (soft triangle/sine and a brighter saw) play the same chord tones while a slow LFO crossfades between them.
- **Melodic** (Arp, Bells, Shimmer, Melody A glide lead, Melody B acid line): up to 3 at once (the oldest is replaced), 4 s cooldown, XY range limited, 3 s in / 5 s out. The four plucked melody variations (lyrical, flowing, leaping, bright) are in the *Ambient + melody* pack.
- **Rhythmic** (Pulse, Sub): up to 2 at once, 6 s cooldown, quick 1.5 s entrances so they land with the beat.
- **Nature samples** (Stream, Rain, Garden): engagement-driven. It takes **two people tapping within 10 s** to bring one in (phones show "1/2 joined"), only one plays at once (starting another replaces it), and each one fades away after 60 s unless brought back.
- **Gong, the end of the show** (Gong): the audience's shared decision that the show is over (see *The Gong* below). It takes **three people tapping within 20 s**; the gong then sounds **three times** while every other layer fades out in stages.

### The Gong: the climax

**Intent.** Everything else in RESONANCE is something the audience adds to, shapes or lets fade. The gong is different: it is the one moment the audience decides *together*. It is a deliberate climax, sounded when the audience feels the current setting or performance has reached its natural height (they are satisfied), or has run its course (they are tired of it). It marks a turning point, so it has to be rare, shared and unmistakable. That is why it is built the way it is:

- **A three-person vote.** One person can't sound it. Three different phones must tap within 20 seconds; phones show "1/3 joined" while the vote builds, and the same phone tapping twice counts once. If the third tap doesn't come in time, the vote lapses.
- **The finale.** A successful vote (or one click on the Gong row of the engine page, or `POST /api/input {"type":"toggle","stem":<gong id>}`) ends the show, and it is built to sound solemn and final. The whole mix first dips about 4 dB for one bar (a breath), then the gong strikes three times on bar lines, with widening gaps (3 bars, then 5): each strike is lower than the last (0, −2 and −5 semitones) and louder (70%, 85%, 100%), is its own voice so they ring into each other, and loses its highs as it dies away. The gong has its own long, dark hall reverb, and under the third strike a low sine boom swells in: the key's tonic as low as the Drone, plus its octave. Meanwhile every other stem fades out over 9 s, one stage every 1.5 bars (nature, bells and shimmer first, then melodies and arp, rhythm, Sub, Pad and Atmos, the Drone last with a 14 s fade, leaving as the third strike sounds). After a further 5 s of silence the engine shows “The end”. The numbers are `FINALE_*` in `public/engine.js`.
- **Nothing else can start afterwards.** Once the finale is under way phones dim and show “The gong has sounded · thank you”; taps and engine/HTTP toggles are ignored. A new show (**Restart run count**, **Stop all**, Start engine or a pack switch) brings everything back.
- **Changing it.** Set `"finale": false` in a group's `rules` to make the gong an ordinary one-shot again (with `maxPlays` if you want a limit), or set `gate` to `null` so a single tap ends the show.

What the performer does with it is up to them: let the first strike mark a peak, treat it as a signal to change the setting (new variation, new BPM, strip back to the Drone), and hold the third in reserve as a closing gesture.

The numbers (people, window, strikes, cooldown) live in the `climax` preset in `lib/rules.js` and can be overridden per pack in `rules` (see packs/README.md). The gong sample file holds one strike (bars 1 to 4) repeated in bars 5 to 8; the engine plays only the first strike, and measures that window at the pack's own tempo (50 BPM = 19.2 s), so it stays one strike at any BPM you choose; the stem's `"playBars": 4` plays just one strike.

Rules apply to audience phones only; the engine page, sensors and `POST /api/input` bypass them. When a phone is refused, it sees a short message ("Wait 2s", "Core synth: at least 1 must stay on"). The rules are plain data in each pack's `pack.json` (see packs/README.md), so changing them needs no code.

## Joining from an iPhone or iPad (same Wi-Fi)

1. Start the server on the laptop (`npm start`) and open the engine page there.
2. The engine page's left column shows the audience URL (for example `http://192.168.1.23:8080/`) and a QR code. Point the phone or iPad camera at the QR code and tap the link. The QR code library is bundled, so it works without internet.
3. The phone page is the audience controller; tapping a stem asks the engine to trigger it, subject to the group rules.

If the laptop has several network adapters, the Wi-Fi address is listed first. Click another URL in the list to switch the QR code to it.

If the phone can't connect:
- Both devices must be on the same network. Guest Wi-Fi and some venue networks block devices from seeing each other ("client isolation"); use your own router or a phone hotspot with the laptop on it.
- macOS may ask "Allow incoming connections for node?" the first time. Choose Allow (System Settings, Network, Firewall).
- Use the `http://` address, not `https://`.
- A VPN on the laptop can hide the Wi-Fi address; turn it off while performing.

## BPM, runs and play time

The default tempo is **50 BPM** (`config.json` and every pack's `pack.json`). In the engine sidebar, from the top: the chord chart picker and chord display, then Quantize and Key, then BPM, then the runs and Lush switches, then the stems, and last the fade in, fade out, brightness and master volume. The **BPM** slider (40 to 120) shows the new value and play time while you drag; when you let go, the generated stems are re-rendered at that tempo and swapped in together on the next bar. Every control reports its progress in a message at the bottom of the screen (rendering, waiting for the bar, done, or an error). **Progression runs** sets how many times the 8-bar chord progression plays before everything fades out on its own (choices: 1, 8, 16, 32, 64 or Endless). The line underneath estimates the play time: bars per run, time per run, total, and while playing, the current run and time left.

The run counter starts when the first stem starts. **Restart run count** begins counting again from now. Recorded sample loops (stream, rain and so on) keep their own length and do not change with BPM; picking a different pack goes back to that pack's tempo.

## Harmony rules (priority list)

The generated stems share one note plan, built from the seed, so they don't clash. Higher-priority voices decide first and lower ones fit around them:

| Priority | Voice | What it does |
|---|---|---|
| 1 | Drone | Holds D2, A2 and D3 (tonic and fifth); never changes |
| 2 | Pulse | Thump always lands on the tonic (D2 in D) |
| 3 | Sub | Long blooming notes (D or A) that need not start on beat 1, with octave leaps and a gentle half-step scoop, through heavy reverb and delay |
| 4 | Pad | Chord tones; any that would rub against the bass are lifted an octave or dropped |
| 5 | Atmos | Chord tones above the pad |
| 6 | Arp | Single notes that fit under the pad and Atmos |
| 7 | Melody, Bells, Shimmer | Top line; avoids seconds against everything underneath |

The rules: two sounding notes a whole tone or closer apart clash; below G3 only unison, octave and fifth are allowed (thirds and fourths are muddy down there); near the bass, a note a semitone, whole tone or tritone from D or A clashes. A note that clashes is lifted by octaves until it fits, or dropped. The Sub is limited to D and A because, in the bass register, any other note would beat against the Drone.

### The Sub line

The Sub is long, spare and blooming. Its notes are the D and A the Drone holds (D2, A2, D3 and A3 in key D), so they are always in tune with it. It need not start on beat 1. Each chord (two bars) picks one of four shapes from the seed:

- **Bloom:** one note enters on beat 1, 2, 3 or 4 and rings to the end of the chord.
- **Leap:** a note, then a jump up an octave four beats later (now and then a twelfth, D2 to A3).
- **Slide:** a note, then the other low tone (D2 or A2) arrives with a gentle half-step scoop: it starts a semitone below (or above) and settles into the note over a half note (2 beats), with the volume dipping slightly. The move between the two notes is a soft crossfade, not a long glide.
- **Late:** the first bar is silent; one note enters late in the second bar and carries over into the next chord.

Every note swells in slowly (about one to 1.7 seconds) and dissolves out over one to two and a half seconds, and the Sub is sent through a heavy reverb and a ping-pong delay (1.5 and 2 beats, tempo-synced) so it blooms and dissolves into the mix. The dry signal stays a pure low end; the wet signal is a little brighter so you can hear the bloom. The scoop is the only moment the Sub sounds a pitch outside D and A, and only by a semitone. `npm run clash` checks that every Sub note is on the ladder, notes are at least two beats long, and no chord has more than two.

To get the old single held, dry note per bar, set `"style": "strict"` on the Sub stem in its pack.json.

`npm run clash` audits the plan for 1,200 combinations of key and seed and prints what sounds under each bar for your default seed. Run it after changing any synth. `npm run clash -- --key=F --seeds=500` narrows it.

## Inputs beyond taps (for the later biosensor layer)

```bash
# toggle / set / stop all
curl -X POST localhost:8080/api/input -d '{"type":"toggle","stem":3}'
curl -X POST localhost:8080/api/input -d '{"type":"set","stem":5,"on":true}'
curl -X POST localhost:8080/api/input -d '{"type":"stopAll"}'
# continuous 0..1 parameter (currently: brightness → master low-pass)
curl -X POST localhost:8080/api/input -d '{"type":"param","name":"brightness","value":0.3}'
```

A sensor bridge (for example a Python HRV/EEG process) can POST these messages, or open `ws://host:8080/ws?role=sensor` and send the same JSON. The *brightness* slider on the engine page uses this same path. It's a placeholder for the design doc's "arousal → brighter timbre" mapping.

## Files

- `MANUAL.md`: the user manual for the operator (setup, playing, audience, effect box, rehearsal, troubleshooting)

```
server.js          HTTP + WebSocket hub, state, input handling
config.json        default pack, tempo, beats/bar, quantize, fade, key, seed
lib/packs.js       pack discovery + validation
examples/          bb-trumpet-example.musicxml (a MusicXML chart to try)
public/musicxml.js  MusicXML / .mxl chord-symbol reader
tools/             list-packs.js (npm run packs), fetch-cc0-stems.js
public/engine.html audio engine UI (open on the PA machine)
public/engine.js   clock, scheduling, voices, visual
public/synth.js    procedural ambient stem generator + WAV export
public/client.html audience controller
public/xy.js       the pad (complexity + cutoff) and volume fader sheet, shared by both pages
public/roll.js     the rolling piano roll drawn in the phone's pad sheet (notes come from the engine's render, see below)
packs/             sample packs (one folder each; see packs/README.md)
```

## Out of scope (per spec)

Biosensors, per-client audio, auth, cloud hosting and recording. The visual layer is still an open decision. The engine page has a simple generative ring visual (one ring per stem, reacting to its level) as a placeholder.

# RESONANCE user manual

For the person running the show (the performer or operator). It covers setting up, playing, what the audience sees, the effect box, rehearsing with simulated people, and fixing problems. The README has the technical detail; `DESIGN.md` records the design.

## 1. The three parts

| Name | What it is | Where |
|---|---|---|
| **Fangzhang 方丈** | The server. Keeps the state and the audience rules. Plays nothing. | Terminal |
| **Dantian 丹田** | The engine page. Makes and plays all the sound. | `http://localhost:8080/engine` |
| **Daqian 大千** | The audience page on each phone. | `http://<your Wi-Fi address>:8080/` |
| Rehearsal | Simulated audience and live monitor. Operator only. | `http://localhost:8080/rehearsal` |

Run one engine, on the machine wired to the PA. Phones and the engine must be on the same Wi-Fi, and phones must use `http://`, not `https://`.

## 2. Starting a show

1. In a terminal, in the project folder, run `npm start`. The terminal prints the engine address and the phone addresses. After you update the code, stop the server (Ctrl+C) and start it again.
2. Open **http://localhost:8080/engine** and send this computer's audio output to the PA.
3. Click **Start engine**. It renders every stem (about a minute the first time), then starts silent. Wait until the progress text disappears.
4. Open the **☰ menu** and show the QR code or join link to the audience.
5. Bring the first layers in yourself by clicking stems, or let the audience do it.

Only one engine tab plays. The page that presses Start becomes the engine and any other engine page goes idle. If the buttons do nothing, check that you did not start a second engine.

## 3. The engine page

**Stems (left sidebar).** One row per layer, grouped by type. Click a row to switch the layer on or off. It enters on the next beat (or bar, depending on Quantize) and fades in. The small square beside a row is that layer's pad: left–right is complexity, up–down is the filter cutoff, and the bar beside it is volume. The engine page ignores the audience rules, so you can always do anything.

**Controls under the stems**

| Control | What it does |
|---|---|
| BPM slider, − and + | Sets the tempo target. While music plays, the tempo moves 3 BPM per bar toward the target. With nothing playing it jumps straight there and renders nothing; the stems are rendered once, at the new tempo, when you switch on the first one. |
| Key | Transposes everything. Applies to the next render. |
| Quantize | Whether layers enter on the beat, half bar or bar. |
| Progression runs | *Endless*, or 1–64 runs, then an automatic fade-out. |
| Fade in / Fade out | Default fade times. Some groups have their own. |
| Chord display for | Shows chords in concert pitch or for B♭ instruments. Display only. |
| Microcosm column | Between the stem list and the visuals. See section 6. |
| Brightness | A master low-pass filter. Also a parameter a sensor can drive later. |
| Master volume | Overall level. |
| Export WAVs | Downloads the generated stems as WAV loops (a layer with complexity exports the full mix of its layers). |
| New variation (in each instrument's pad) | Renders a new version of that one instrument with a new random seed. Swaps in on the next bar. Not offered for recorded files. |
| Stop all | Fades the layers out in order, colour first, drone last. |

**Restart run counter** (in the sidebar) restarts the progression-run count and gives the gong its three strikes again.

**☰ menu.** Sample packs, the QR code and join links, the server status with a Restart server button (needs `npm start`), a chord chart loader (MusicXML), and a link to Rehearsal.

**Switching packs.** Open the menu, choose Browse packs. Switching fades out everything that is playing, loads the new pack and starts silent. Plan it between pieces: loading takes a while.

## 4. What the audience sees

Each phone shows one button per layer the audience may use. The core synth layers (Drone, Pad, Atmos, Noise) are yours only and do not appear.

**Tapping a layer** opens its sheet, and if the layer is off it also switches it on (it comes in on the next beat or bar; the switch in the sheet turns it off again). The nature samples and the Gong are the exception: they only react to a vote. The sheet has:

- **The piano roll** (the strip above the pad). The notes of this layer scroll toward the white "now" line from the right, about two bars ahead, so you can see a sound coming before you hear it. A note lights up as it plays. When you have just switched the layer on, a dashed line marks where it comes in (the label counts the beats) and the notes before that line are only outlines. If the layer is off, you see its notes as outlines, as a preview. Moving the pad's complexity adds and removes notes in the roll as you drag. Short ticks along the top are percussion hits; for the Arp and Bells, a longer bar is a note that rings longer. The strip appears once the engine has started; it does not appear for the nature samples and the Gong.
- **The pad.** Drag across it: left–right is complexity (from sparse to dense), up–down is the filter (closed at the bottom, open at the top). Double-tap to reset.
- **The volume fader** on the side.
- **The switch** brings the layer in or out. It always responds: while it waits for the next bar the sheet says so.
- **?** shows the plain-language explanation again. It appears by itself the first time a person opens a pad.
- **×** closes the sheet.

**Complexity** exists only on the generated melodic and rhythmic layers. At the sparse end you hear the original, simple part. Moving right adds notes in two steps, and for the Arp and Bells the notes also ring longer, for Melody A and B more notes join in, and the Sub starts to pulse (quarter notes in the middle, eighth notes at the far right).

**Nature samples and the Gong** have no pad and no switch. They show an explanation and a **Vote** button (the nature samples also have a volume bar).

- Nature samples need two people tapping within 10 seconds, play one at a time and fade away by themselves after a minute.
- The **Gong** is the end of the show. Three people must tap within 20 seconds. It strikes three times while everything fades out in stages. Afterwards nothing can start until you start a new show.

**Audience limits** keep the piece clear: only so many layers at once per group (Melodic 3, Rhythmic 2), a cooldown before the same layer can change again, and limited ranges on some pads. A phone that is refused sees a short message such as "Wait 4s".

## 5. Ending the show

- **The audience's way:** the Gong vote. After the third strike the engine shows "The end".
- **Your way:** click the Gong row on the engine page, or use **Stop all**. Use *Restart run counter* or start the engine again before the next performance so the gong's strikes and votes reset.

## 6. The Microcosm effect box

Two granular effect boxes in their own column between the stem list and the visuals on the engine page, in the spirit of the Microcosm pedal. It takes **one or more instruments** (and the live input) and plays pieces of it back as swarms of tiny grains with feedback, tone and reverb. Both boxes are **on** at start (with nothing chosen they do nothing), and the effect needs the engine to be started, and the audience cannot touch it. Your settings are remembered in the browser.

There are **two effect boxes**, chosen with the tabs at the top of the column. Each has its own on/off, sources, preset and knobs, and both can run at once.

- **A · Arp & plucks** holds the presets that chop, repeat and strum: **Mosaic**, **Glitch**, **Strum**, **Blocks**, **Pattern**. Use it for arps, plucks, bells and other percussive sounds.
- **B · Long tones** holds the presets that melt and bend: **Haze**, **Tunnel**, **Warp**. Use it for held notes, pads and long melodies.

A percussive instrument can go into either box, and an instrument can go into both.

1. Click **A** or **B** beside an instrument in the stem list to send it into that box. Click again to take it out. The chosen sources show as chips in the box (the × removes one), the **Add an instrument** menu does the same, and **Clear** empties the box. With none chosen a box has no input and does nothing (nothing is sent through it).
2. Press **Off** beside the box name to turn it on (the tab shows a lit dot). The sources keep playing as they were and the effect is added on top. Tick **Mute the dry sources** to hear only the effect for the chosen instruments (it applies while that box is on).
3. Pick a preset in the box. Choosing one resets the knobs to a good starting point for it.
4. Shape it: **Activity** (how many grains, how fast), **Size** (grain and loop length), **Repeats** (feedback: how long the sound keeps circling), **Tone** (darker to brighter) and **Mix** (how loud the effect is).

The effect hears the instrument after its own pad settings (cutoff and volume). It only has something to play back while the source is sounding, so switch the source instruments on first. Glitch, Blocks, Pattern and Strum follow the tempo. To try the presets without the show, open **http://localhost:8080/micro.html** and press Start sound.

Tip: turn Mix down before you change preset during a quiet moment, and raise **Repeats** slowly. High Repeats on Haze or Tunnel builds a thick wash.

## 7. Kit, templates and favorites: changing the Melodic and Rhythmic sounds during a show

The sounds are chosen in three steps. A **kit** is the *sound* of the melodic roles (Chords, Bass, Arp, Melody A, Melody B). A **template** decides the *notes* (the chord progression and what each role plays). A **favorite** saves a combination you trust: kit + melodic template + rhythmic template + the settings of both Microcosm boxes. Loading changes the melodic and rhythmic voices without stopping the show: **Core synth** and the **nature samples** keep playing and sustain the sound while the swap happens.

Click **Kit · Templates…** at the top of the effect column. The button then shows the name of the live favorite.

- **1 · Kit.** Pick the sound. Melody A and Melody B are *voices*: with the Layers kit Melody A is the glide lead and Melody B the acid line, and they play whatever melody the template generates, with their extra notes (the pad's X axis) in the same sound. *Make or change a kit* lets you choose a voice for each role and save it under a name. Kits with recordings are folders in `soundkits/`.
- **2 · Templates.** Pick the Melodic template (for example *Gospel*, *House*, *Jazz*, or *Long lines* for the slow ambient notes) and the Rhythmic template (a groove such as *Tresillo* or *Four on the floor*, the seed-picked Rhythmic synth, or the hand drums). Templates that don't fit (recorded loops at another tempo, or generated sounds in another harmony such as major) are greyed out with the reason. Then **Load kit + templates**: the Melodic and Rhythmic stems that are playing fade out (their normal fade-out times), the new sounds go in once those groups are silent, and they start off, ready for the audience or for you to switch on. During the wait phones say "changing sounds…" and cannot start those stems. If something has not faded after 45 seconds the swap happens anyway.
- **3 · Favorites.** **Load** puts a saved combination in. **Save favorite** stores what is live: the kit, both templates and both Microcosm boxes (presets, knobs, which instruments feed A and B). Saving under the same name updates it. A favorite that has Microcosm settings applies them as soon as its sounds are in; instruments are matched by name. *New variation* in an instrument's pad window still re-rolls that instrument's notes inside the chosen template and kit.

Kits and favorites are plain files in `soundkits/` and `favorites/` (see README). Rendering the new generated stems takes some seconds after they are swapped in, longer on a slow computer, so load a favorite between phrases rather than at a climax.

## 8. Rehearsal: simulated audience and monitor

Use this to practise playing against a changing room, alone. Open **http://localhost:8080/rehearsal** on the machine that runs the server (use `localhost`, not the Wi-Fi address). Nobody else can open it.

1. Make sure the engine is started.
2. Press **Start rehearsal**. Five simulated people join. They follow the same rules as real phones.
3. Pick the room: **Calm room**, **Busy room**, **Storm**, or **Waves** (the room breathes between calm and busy every few minutes). The **Activity** slider sets the level (100% is each person's normal pace, 200% twice as often, 0% silent). In **Calm room** the pad handles also glide: they never stop and never turn sharply, they drift in slow curves and ease back from the edges, and the volume drifts gently too. The other rooms move in quick straight steps with pauses. Tick **People come and go** to change the crowd size.
4. Change a person's style with the menu on their card, or untick *in* to send them out. Styles: *Explorer*, *Tweaker*, *Rhythm lover*, *Calm listener*, *Mischief*.
5. Watch the monitor. The stem board shows what is off, waiting for the bar, sounding, or in a vote, plus each pad position and who touched it last. The group lines show limits (for example "2 of 3 on"). The log lists every action, including refusals. Tick *pad moves* to see them. The chart shows how busy the last 3 minutes were.
6. Play the engine page against them.

The simulation never votes for the gong by itself. **Gong vote now** (two clicks) makes three simulated people vote; if it succeeds, the show ends. Press **Stop** to send everyone home.

The monitor also shows real phones and your own taps, so you can rehearse with a mixed room.

**Access.** The page answers only to the server machine. If the server has an `ENGINE_KEY`, add `?key=<the key>` to the address to open it from another device.

## 9. Packs, tempo and files

- Packs live in `packs/`. The default, **layers**, combines the core, melodic and rhythmic synths and the field recordings (15 stems). Other packs: see `packs/README.md`. Recorded loops must be a whole number of bars at the pack tempo (50 BPM).
- Field recordings (`.wav`, about 66 MB in all) are not stored in git. Fetch them with `npm run fetch-stems`.
- Generated stems need no files; they are built in the browser.

## 10. Deploying online

Set `ENGINE_KEY` to a long secret first, then follow `DEPLOY.md`. With a key set, open the engine as `/engine?key=<key>`.

## 11. Troubleshooting

| Symptom | What to do |
|---|---|
| A phone cannot connect | Same Wi-Fi? Use the address shown in the menu, with `http://`. Some venue Wi-Fi blocks devices from seeing each other. |
| Buttons do nothing | Another engine tab may have taken over. Close the others and press Start on the one you want. |
| Nothing sounds | Is the engine started? Is a stem wanted but still "waiting for the bar"? Check the master volume, the browser's audio output device. |
| Start takes a long time | The stems are being rendered (about a minute). A tempo change with something playing renders again in the background and swaps in on the next bar. |
| A layer sounds the same at every pad position | Complexity applies only to Arp, Bells, Shimmer, Melody A/B, Pulse and Sub. The core synth, nature samples and gong have none. |
| The phone says "Wait Ns" | The cooldown. It stops the same layer being flipped too fast. |
| The gong will not play | It needs three people within 20 seconds, and a new show must have started since the last one. |
| After a code update nothing changed | Restart the server and reload the engine and phone pages. |
| `/rehearsal` shows "Not found" | Open it from the server machine using `localhost`, or add `?key=` if the server has a key. |

## 12. Quick reference

- Engine: `http://localhost:8080/engine`
- Audience: the address in the ☰ menu
- Rehearsal: `http://localhost:8080/rehearsal` (this machine only)
- Effect box test page: `http://localhost:8080/micro.html`
- Start: `npm start` · Packs overview: `npm run packs`

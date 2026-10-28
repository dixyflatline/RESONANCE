// RESONANCE PoC — audio engine (runs in a browser tab on the machine wired to the PA).
//
// Timing model (per the implementation spec):
//  - AudioContext.currentTime is the only musical clock. setInterval is used only
//    for UI / reporting, never to decide when sound happens.
//  - Master timeline starts at t0. beat = 60/tempo, bar = beat * beatsPerBar.
//  - A toggle is scheduled on the next quantize boundary (beat by default).
//  - Phase-aligned entry: a stem starts at offset ((boundary - t0) mod loopLength)
//    so it joins exactly where it would be had it been playing since t0.
//    (For 1-bar loops this equals the spec's "posInBar"; for 8/16-bar loops it
//    also keeps bar 5 of one stem lined up with bar 5 of every other stem.)

(() => {
  const $ = (s) => document.querySelector(s);
  const LEAD = 0.025; // min seconds between "now" and a scheduled boundary

  let cfg = null;          // config from server
  let ctx = null;          // AudioContext
  let t0 = 0;              // master timeline origin
  let master, brightness, analyserMaster, compNode;
  const stems = new Map(); // id -> { def, buffer, bus, analyser, voice, stopUntil, level }
  let desired = new Set(); // server's desired active set
  let playsState = {};     // stem id -> { used, max }: how many times participants have started a limited stem (the gong) this performance
  let lastPlayingSent = '';
  let quantize = 'beat';
  /* tell the phones how long a tap can wait (as a share of a bar: params are 0..1), so their switch can say "waiting for the next bar" */
  const reportQuantize = () => send({ type: 'param', name: 'quantizeBar', value: quantize === 'bar' ? 1 : quantize === 'half' ? 0.5 : 1 / cfg.beatsPerBar });
  let ws = null, started = false, rendering = false;
  let key = 'D', seed = 1;
  const varSeed = new Map(); // stem id -> its own seed after a per-instrument "New variation" (the global seed rules the rest)
  let lush = { voices: true, verb: true }; /* Lush voices / Lush reverb switches (see synth.js); saved per browser */
  try { const sv = JSON.parse(localStorage.getItem('resonance.lush') || 'null'); if (sv) lush = { voices: sv.voices !== false, verb: sv.verb !== false }; } catch {}
  let custom = null; /* a chord chart loaded from MusicXML (see the Chord chart picker): replaces the built-in progression in every generated stem */
  let packTempo = null; // the pack's own BPM: recorded one-shots (the gong) are cut to it and keep their length in seconds whatever BPM is chosen
  let tempoOverride = null; // BPM chosen on this page (procedural stems are re-rendered at it); null = pack tempo
  let pendingStop = false, stopTimer = 0;
  function endStop(text) { pendingStop = false; clearTimeout(stopTimer); toast('stop', 'ok', '✓ ' + text); btnState($('#stopAll'), '✓ Stopped', 'ok'); }
  let runs = 0, runStart = null, runEnded = false; // runs = progression passes before auto fade-out (0 = endless)
  const xyState = {};      // id -> { x, y } (x = cutoff, y = volume), mirrored from the server
  let sheet = null;        // XY controller sheet
  let curRev = 0;          // the kit revision of the stems on this page (the server bumps it when Melodic / Rhythmic sounds are swapped)
  let curPackId = null;    // pack the stems/buffers on this page were built for
  let switching = false;   // true while a pack switch is fading out / loading
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const engineKey = new URLSearchParams(location.search).get('key') || '';

  // ---------------- WebSocket ----------------
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=engine&standby=1&key=${encodeURIComponent(engineKey)}`); // standby: opening the page does not take over from a running engine; pressing Start does
    ws.onopen = () => { setConn(true); if (started) { send({ type: 'claim' }); sendAllRolls(); } /* a reconnect of the running engine */ };
    ws.onclose = (e) => {
      setConn(false);
      if (e.code === 4001) { alertBanner('This server needs the engine key. Open this page as /engine?key=YOUR_ENGINE_KEY'); return; }
      setTimeout(connect, 1000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'config') onConfig(msg);
      else if (msg.type === 'state') onState(msg);
      else if (msg.type === 'xy') onXY(msg.stem, msg);
      else if (msg.type === 'restarting') { if (srvState !== 'restarting') watchRestart(srvStarted); }
      else if (msg.type === 'replaced') { ws.onclose = null; alertBanner('Another engine tab took over. This tab is now idle.'); stopAllNow(); }
    };
  }
  const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));

  function onConfig(c) {
    const first = !cfg;
    if (!first && c.build && cfg.build && c.build !== cfg.build) $('#updateBar').hidden = false; // code changed on the server: offer a page reload
    const packChanged = !first && cfg.pack && c.pack && cfg.pack.id !== c.pack.id;
    const kitChanged = !first && !packChanged && cfg.pack && c.pack && (cfg.pack.rev ?? 0) !== (c.pack.rev ?? 0); /* the same pack, with other Melodic / Rhythmic sounds: a kit went live */
    const prevCfg = cfg;
    cfg = c; packTempo = c.tempo; // the tempo the pack's recorded files were cut at
    if (packChanged) tempoOverride = null;
    if (tempoOverride) cfg = { ...c, tempo: tempoOverride };
    cfg.tempo = cfg.tempo;
    $('#packName').textContent = c.pack ? c.pack.name : '–';
    if (packChanged) {
      for (const k of Object.keys(xyState)) delete xyState[k]; for (const k of Object.keys(keptXY)) delete keptXY[k]; // the new pack's pads start at their defaults
      if (sheet) sheet.close();
      if (!$('#packs').hidden) loadPackList();
    }
    if (first) {
      quantize = c.quantize || 'beat';
      key = c.key || 'D'; seed = c.seed ?? 1;
      $('#quantize').value = quantize; reportQuantize();
      $('#key').value = key;
      $('#fadeIn').value = c.fadeIn ?? c.fade ?? 4; $('#fadeOut').value = c.fadeOut ?? c.fade ?? 4;
      $('#fadeInVal').textContent = Number($('#fadeIn').value).toFixed(1) + ' s';
      $('#fadeOutVal').textContent = Number($('#fadeOut').value).toFixed(1) + ' s';
    }
    $('#tempo').textContent = `${cfg.tempo} BPM · ${cfg.beatsPerBar}/4`;
    if (first || packChanged) { $('#bpm').value = cfg.tempo; $('#bpmVal').textContent = cfg.tempo; }
    updateRunInfo();
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(location.hostname) || location.hostname.endsWith('.local');
    $('#urls').innerHTML = (local && c.lanUrls.length ? c.lanUrls : [location.origin + '/']) // hosted: show the public URL
      .map((u) => `<a href="${u}" target="_blank">${u}</a>`).join('<br>');
    drawQR(local && c.lanUrls.length ? c.lanUrls[0] : location.origin + '/');
    buildStemRows();
    if (packChanged && started) switchPack();
    else if (kitChanged && started) swapKit(prevCfg);
    else if (kitChanged) curRev = cfg.pack.rev ?? 0; /* (an engine page that has not started has nothing to swap: it renders the new sounds when Start is pressed) */
    kitBar();
  }

  /* QR for the audience URL (library is bundled, works offline). Click a URL to switch the code. */
  function drawQR(url) {
    const box = $('#qr'); if (!box || typeof qrcode === 'undefined') return;
    try { const q = qrcode(0, 'M'); q.addData(url); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); box.title = url; }
    catch (err) { box.textContent = ''; }
  }
  document.addEventListener('click', (ev) => { const a = ev.target.closest && ev.target.closest('#urls a'); if (a) { ev.preventDefault(); drawQR(a.getAttribute('href')); } });

  /* ---- BPM / runs / play-time estimate ---- */
  const cycleBars = () => { const g = cfg ? cfg.stems.filter((s) => !s.file).map((s) => (custom ? custom.bars : s.bars || 8)) : []; return g.length ? Math.max(...g) : 8; }; /* the chord cycle = longest generated stem */
  const cycleSec = () => cycleBars() * cfg.beatsPerBar * 60 / cfg.tempo;
  const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function updateRunInfo() {
    if (!cfg) return;
    const bpm = Number($('#bpm').value) || cfg.tempo, cs = cycleBars() * cfg.beatsPerBar * 60 / bpm;
    let t = `${cycleBars()} bars per run = ${fmt(cs)} at ${bpm} BPM`;
    if (runs > 0) t += `<br><b>${runs} run${runs > 1 ? 's' : ''} ≈ ${fmt(runs * cs)}</b> (${runs * cycleBars()} bars)`;
    else t += '<br><b>Endless</b> (runs until you stop it)';
    if (started && runStart !== null && ctx) {
      const el = Math.max(0, ctx.currentTime - runStart), cur = Math.floor(el / cycleSec()) + 1;
      t += runs > 0 ? `<br>Now: run ${Math.min(cur, runs)} of ${runs} · ${fmt(runs * cycleSec() - el)} left` : `<br>Now: run ${cur} · ${fmt(el)} elapsed`;
    }
    $('#runInfo').innerHTML = t;
  }
  /* BPM slider: readout + estimate follow the drag; the new tempo is rendered and swapped in when the slider is released (latest value wins if a render is already running) */
  let bpmBusy = false;
  let stale = false, freshening = null; /* stale: the tempo changed while nothing was playing, so the rendered stems still have the old tempo; they are rendered at the new one when the first stem is wanted */
  const showBpm = () => {
    const t = Number($('#bpm').value), now = cfg.tempo;
    $('#bpmVal').textContent = t; $('#bpmNow').textContent = now; $('#bpmTgt').hidden = t === now;
  };
  setInterval(showBpm, 250);
  // BPM: the slider and the +/- buttons set the TARGET instantly; the actual tempo then glides to it
  // in small steps (GLIDE BPM per bar-aligned swap), so a big change is a slow, audible ramp.
  const bpmEl = $('#bpm'), BMIN = +bpmEl.min, BMAX = +bpmEl.max, GLIDE = 3;
  let bumpTimer = 0;
  const bBump = (e, s) => {
    bpmEl.value = Math.max(BMIN, Math.min(BMAX, Number(bpmEl.value) + s * (e.shiftKey ? 5 : 1)));
    showBpm(); updateRunInfo(); clearTimeout(bumpTimer); bumpTimer = setTimeout(pumpBpm, 600);
  };
  $('#bpmDn').addEventListener('click', e => bBump(e, -1));
  $('#bpmUp').addEventListener('click', e => bBump(e, 1));
  bpmEl.addEventListener('input', () => { showBpm(); updateRunInfo(); });
  const anyVoice = () => [...stems.values()].some((s) => s.voice); // is any stem playing (or waiting to start)?
  async function pumpBpm() {
    if (bpmBusy) return; bpmBusy = true;
    try {
      let v;
      while ((v = Number($('#bpm').value)) !== cfg.tempo) {
        if (!started) { toast('bpm', 'ok', `✓ ${v} BPM will be used when the engine starts`); cfg.tempo = v; tempoOverride = v; $('#tempo').textContent = `${v} BPM · ${cfg.beatsPerBar}/4`; break; }
        if (!anyVoice() && !rendering && !switching) { /* nothing is playing: no ramp to hide and nothing to render yet; take the target now and render the stems when the first one is wanted */
          cfg.tempo = v; tempoOverride = v; stale = true; lastBeat = -1; $('#tempo').textContent = `${v} BPM · ${cfg.beatsPerBar}/4`;
          toast('bpm', 'ok', `✓ ${v} BPM: the stems are rendered at it when the first one starts`); break;
        }
        while (rendering || switching) await sleep(200);
        const step = (Math.abs(v - cfg.tempo) <= GLIDE || !anyVoice()) ? v : cfg.tempo + Math.sign(v - cfg.tempo) * GLIDE; /* nothing playing: no glide to hide, go straight to the target */
        if (!(await regenerate(step, step === v ? `Tempo ${v} BPM` : `Tempo → ${step} of ${v} BPM`, false))) break;
      }
    } finally { bpmBusy = false; updateRunInfo(); }
  }
  bpmEl.addEventListener('change', pumpBpm);
  $('#runs').addEventListener('change', (ev) => { runs = Number(ev.target.value); runEnded = false; updateRunInfo(); toast('runs', 'ok', runs ? `✓ Performance will fade out after ${runs} run${runs > 1 ? 's' : ''}` : '✓ Endless: no automatic end'); });
  $('#restartRun').addEventListener('click', () => { send({ type: 'newShow' }); runStart = null; runEnded = false; let any = false; for (const st of stems.values()) if (st.voice) { runStart = ctx.currentTime; any = true; } updateRunInfo(); toast('run', 'ok', (any ? '✓ Run counter restarted from now' : '✓ Run counter reset, it starts with the next stem') + '. The gong has its three strikes again'); btnState($('#restartRun'), '✓ Restarted', 'ok'); });

  /* Menu drawer: pack browser, join QR, server controls */
  (function () {
    const dr = $('#drawer'), sc = $('#scrim');
    const set = (on) => { dr.classList.toggle('open', on); sc.hidden = !on; dr.setAttribute('aria-hidden', on ? 'false' : 'true'); };
    $('#menuBtn').addEventListener('click', () => set(!dr.classList.contains('open')));
    $('#menuClose').addEventListener('click', () => set(false));
    sc.addEventListener('click', () => set(false));
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') set(false); });
    window.closeMenu = () => set(false);
  })();

  function onXY(id, p) {
    xyState[id] = { x: p.x ?? ResonanceXY.XY_DEFAULT.x, y: p.y ?? ResonanceXY.XY_DEFAULT.y, v: p.v ?? ResonanceXY.XY_DEFAULT.v };
    applyXY(id);
    const mini = document.querySelector(`.stemrow[data-id="${id}"] .xy-mini`);
    if (mini) mini.setXY(xyState[id]);
    if (sheet) sheet.update(id, xyState[id]);
  }

  // Pad -> per-stem low-pass cutoff (y), volume (v) and complexity layers (x), smoothed to avoid zipper noise.
  // Complexity: a stem with layers (see renderStem) plays its base loop plus two layers that add notes; x fades the layers in and out.
  function applyXY(id) {
    const st = stems.get(id), p = xyState[id];
    if (!st || !p || !ctx) return;
    const t = ctx.currentTime;
    st.filter.frequency.setTargetAtTime(ResonanceXY.cutoffHz(p.y), t, 0.03);
    st.xyGain.gain.setTargetAtTime(ResonanceXY.volume(p.v), t, 0.03);
    if (st.voice && st.voice.lg) st.voice.lg.forEach((g, k) => g.gain.setTargetAtTime(ResonanceXY.layerGain(p.x, k), t, 0.15)); /* a slow glide: the layers swell in and out, no clicks */
  }
  const layerGainNow = (st, k) => ResonanceXY.layerGain((xyState[st.def.id] || ResonanceXY.XY_DEFAULT).x, k);

  function onState(s) {
    $('#clients').textContent = s.clients;
    if (s.xy) for (const [id, p] of Object.entries(s.xy)) {
      const cur = xyState[id];
      if (!cur || cur.x !== p.x || cur.y !== p.y || cur.v !== p.v) onXY(Number(id), p);
    }
    desired = new Set(s.active);
    if (!!s.kitPending !== !!kitPendingNow) { kitPendingNow = s.kitPending; kitBar(); if (kitPendingNow) toast('kit', 'work', `Changing sounds: ${kitPendingNow.roles.length ? kitPendingNow.roles.join(' + ') + ' fading out…' : 'applying…'}`); }
    playsState = s.plays || {};
    if (pendingStop && desired.size) endStop(`Stopped, but ${desired.size} stem${desired.size > 1 ? 's were' : ' was'} started again`); /* someone tapped during the fade: don't leave a stale "Stopping…" message */
    if (s.params && typeof s.params.brightness === 'number') {
      $('#bright').value = s.params.brightness;
      applyBrightness(s.params.brightness);
    }
    if (s.finale && !finale && !finaleDone && started && !rendering && !switching) startFinale();
    else if (!s.finale && (finale || finaleDone)) cancelFinale(); /* a new show: stop everything of the old finale */
    if (started && !rendering && !switching && !finale && !finaleDone) reconcile();
    renderRows();
  }

  // ---------------- Microcosm effect boxes ----------------
  // A panel between the stem list and the visuals with two effect boxes. A = presets for arps, plucks and percussion; B = presets for long tones, pads and melodies.
  // Each box has its own sources (the A / B buttons in the stem list, or the Add menu; none chosen = no effect), preset and knobs. A percussive instrument can go into either box.
  // The effects are wet-only; a source keeps playing dry unless that box's "Mute the dry sources" is ticked.
  const SLOTS = [
    { key: 'a', tab: 'A', name: 'Arp & plucks', group: 'rhythm', first: 'mosaic', hint: 'For arps, plucks and percussion: presets that chop, repeat and strum.' },
    { key: 'b', tab: 'B', name: 'Long tones', group: 'sustain', first: 'haze', hint: 'For held notes, pads and melodies: presets that melt and bend.' },
  ];
  const slots = {}; // key -> { def, micro, masterSend, set: Set of stem ids (empty = nothing goes in: the box passes nothing), names (the same by name, to survive a pack switch), muteDry, el }
  const slotList = () => SLOTS.map((d) => slots[d.key]).filter(Boolean);
  let fxTab = 'a';
  const KN = ['activity', 'size', 'repeats', 'tone', 'mix'];
  const serSlot = (x) => ({ preset: x.micro.preset, on: x.micro.enabled, knobs: x.micro.knobs, src: x.names, muteDry: x.muteDry });
  function keepMicro() { saveSettingsSoon(); try { localStorage.setItem('resonance.micro2', JSON.stringify({ tab: fxTab, ...Object.fromEntries(slotList().map((x) => [x.def.key, serSlot(x)])) })); } catch { /* storage unavailable */ } }
  function wireFx(st) { /* every stem gets a send into each box and a gain on its dry path, so any of them can be a source */
    st.fxSends = {};
    for (const x of slotList()) { const g = ctx.createGain(); g.gain.value = 0; st.xyGain.connect(g); g.connect(x.micro.input); st.fxSends[x.def.key] = g; }
  }
  function applyFx() { /* the routing follows the selections: only the chosen sources feed a box, and their dry sound can be muted while that box is on */
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [id, st] of stems) {
      let mute = false;
      for (const x of slotList()) {
        const src = x.set.has(id);
        if (st.fxSends && st.fxSends[x.def.key]) st.fxSends[x.def.key].gain.setTargetAtTime(src ? 1 : 0, now, 0.03);
        if (src && x.muteDry && x.micro.enabled) mute = true;
      }
      if (st.dry) st.dry.gain.setTargetAtTime(mute ? 0 : 1, now, 0.03);
    }
    for (const x of slotList()) x.masterSend.gain.setTargetAtTime(0, now, 0.03);
  }
  function setFxSources(x, ids) { /* a whole new selection (an empty one = no input, so no effect) */
    x.set = new Set(ids.map(Number).filter((id) => cfg.stems.some((d) => d.id === id)));
    x.names = [...x.set].map((id) => cfg.stems.find((d) => d.id === id).name);
    renderFx(); applyFx(); keepMicro();
  }
  const toggleFxSource = (x, id) => setFxSources(x, x.set.has(id) ? [...x.set].filter((i) => i !== id) : [...x.set, id]);
  function renderFx() {
    for (const x of slotList()) {
      const el = x.el; if (!el) continue;
      const box = el.querySelector('.fxChips');
      box.innerHTML = x.set.size
        ? [...x.set].map((id) => { const d = cfg.stems.find((q) => q.id === id); return `<span class="fxchip" style="--c:${d.color || '#7fb3ff'}"><i></i>${d.name}<button type="button" data-id="${id}" aria-label="Remove ${d.name}" title="Remove">×</button></span>`; }).join('')
        : '<span class="fxchip all"><i></i>Nothing chosen: no effect</span>';
      box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => toggleFxSource(x, Number(b.dataset.id))));
      const sel = el.querySelector('.fxSource'); sel.innerHTML = '';
      sel.add(new Option('Add an instrument…', ''));
      for (const d of cfg.stems) if (!d.finale && !x.set.has(d.id)) sel.add(new Option(d.name, String(d.id)));
      sel.value = '';
      el.querySelector('.fxClear').disabled = x.set.size === 0;
      const md = el.querySelector('.fxMuteDry'); md.disabled = x.set.size === 0; if (x.set.size === 0) { md.checked = false; x.muteDry = false; }
    }
    document.querySelectorAll('.fxbtn:not(.livefx)').forEach((b) => { const x = slots[b.dataset.slot]; b.classList.toggle('on', !!x && x.set.has(Number(b.dataset.id))); });
  }
  function fillFxSources() { /* (called when the stem list is built, and after a pack switch: the same instruments by name, when the new pack has them) */
    for (const x of slotList()) {
      x.set = new Set(cfg.stems.filter((d) => x.names.includes(d.name) && !d.finale).map((d) => d.id));
      x.names = [...x.set].map((id) => cfg.stems.find((d) => d.id === id).name);
    }
    renderFx(); applyFx();
  }
  function applySlotSaved(x, sv) { /* set one box from saved settings (the browser's own save, or a kit) */
    const P = ResonanceMicro.PRESETS, d = x.def, ok = sv.preset && P[sv.preset] && P[sv.preset].group === d.group;
    x.micro.setPreset(ok ? sv.preset : d.first, !!ok);
    for (const k of KN) if (typeof sv.knobs?.[k] === 'number') x.micro.set(k, sv.knobs[k]);
    x.names = [].concat(sv.src || []).filter((n) => typeof n === 'string'); /* (older saves kept a single name) */
    x.muteDry = !!sv.muteDry; x.ui.q('.fxMuteDry').checked = x.muteDry;
    x.micro.setTempo(cfg.tempo); x.ui.power(sv.on !== false); x.ui.show();
  }
  function applyKitMicro(m) { /* a kit's effect settings: boxes it does not mention are left as they are */
    for (const x of slotList()) if (m[x.def.key] && x.ui) applySlotSaved(x, m[x.def.key]);
    fillFxSources(); keepMicro();
  }
  const microNow = () => Object.fromEntries(slotList().map((x) => [x.def.key, serSlot(x)]));

  // ---- Remembered adjustments: what you changed after loading a kit + templates comes back the next time the same combination is loaded ----
  // (instrument pads, per-instrument variations and the Microcosm boxes; the server keeps them per kit|melodic|rhythmic in state/settings.json)
  let settingsReady = false, settingsTimer = null;
  const keptXY = {}; // id -> the pad as YOU left it (pad window or a restore); moves by phones, the audience simulator or sensors are never remembered
  const kitStems = () => cfg.stems.filter((d) => d.group === 'melodic' || d.group === 'rhythmic');
  function settingsNow() {
    const st = {};
    for (const d of kitStems()) { const p = keptXY[d.id]; const o = {}; if (p) { o.x = p.x; o.y = p.y; o.v = p.v; } if (varSeed.has(d.id)) o.seed = varSeed.get(d.id); if (Object.keys(o).length) st[d.name] = o; }
    return { stems: st, micro: slotList().length ? microNow() : null };
  }
  function saveSettingsSoon() {
    if (!settingsReady || !started) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { if (settingsReady && cfg.pack) send({ type: 'settingsSave', rev: cfg.pack.rev ?? 0, settings: settingsNow() }); }, 1500);
  }
  function settingsSeeds(defs) { /* before the stems render: their remembered variation seeds */
    const sv = cfg.pack && cfg.pack.settings && cfg.pack.settings.stems; if (!sv) return;
    for (const d of defs) if ((d.group === 'melodic' || d.group === 'rhythmic') && sv[d.name] && sv[d.name].seed != null) varSeed.set(d.id, sv[d.name].seed);
  }
  function settingsPads(defs) { /* after they are built: the pads, and the Microcosm boxes */
    const sv = cfg.pack && cfg.pack.settings && cfg.pack.settings.stems;
    if (sv) for (const d of defs) {
      const o = (d.group === 'melodic' || d.group === 'rhythmic') && sv[d.name]; if (!o || o.x == null) continue;
      xyState[d.id] = { x: o.x, y: o.y, v: o.v }; keptXY[d.id] = { x: o.x, y: o.y, v: o.v }; applyXY(d.id); send({ type: 'xy', stem: d.id, x: o.x, y: o.y, v: o.v });
    }
  }
  function initMicroUI() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('resonance.micro2') || 'null'); } catch { /* storage unavailable */ }
    if (!saved) { /* (an older save had a single box: it goes to the box its preset suits) */
      saved = {}; try { const o = JSON.parse(localStorage.getItem('resonance.micro') || 'null'); if (o && o.preset && ResonanceMicro.PRESETS[o.preset]) saved[ResonanceMicro.PRESETS[o.preset].group === 'sustain' ? 'b' : 'a'] = o; } catch { /* nothing to carry over */ }
    }
    if (saved.tab && slots[saved.tab]) fxTab = saved.tab;
    const tabs = $('#fxTabs'), host = $('#fxSlots'), tpl = $('#fxSlotTpl');
    tabs.innerHTML = ''; host.innerHTML = '';
    for (const x of slotList()) {
      const d = x.def, sv = saved[d.key] || {};
      const el = tpl.content.firstElementChild.cloneNode(true); el.dataset.slot = d.key; x.el = el; host.appendChild(el);
      const q = (c) => el.querySelector(c);
      q('.fxslotname').textContent = d.name; q('.fxslothint').textContent = d.hint;
      const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'fxtab'; tab.dataset.slot = d.key; tab.innerHTML = `<i></i><b>${d.tab}</b> ${d.name}`; tabs.appendChild(tab);
      tab.addEventListener('click', () => { fxTab = d.key; showTab(); keepMicro(); });
      const pbox = q('.fxpresets');
      const show = () => {
        for (const k of KN) { q('.mk_' + k).value = x.micro.knobs[k]; q('.mv_' + k).textContent = Math.round(x.micro.knobs[k] * 100); }
        q('.fxblurb').textContent = ResonanceMicro.PRESETS[x.micro.preset].blurb;
        pbox.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === x.micro.preset)));
      };
      const power = (on) => { x.micro.setEnabled(on); const b = q('.slotOn'); b.textContent = on ? 'On' : 'Off'; b.setAttribute('aria-pressed', String(on)); tab.classList.toggle('on', on); applyFx(); };
      for (const id of ResonanceMicro.GROUPS[d.group]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'fxpreset'; b.dataset.id = id; b.setAttribute('aria-pressed', 'false');
        b.innerHTML = `<b>${ResonanceMicro.PRESETS[id].label}</b><small>${ResonanceMicro.PRESETS[id].family}</small>`;
        b.addEventListener('click', () => { x.micro.setPreset(id); show(); keepMicro(); }); pbox.appendChild(b);
      }
      for (const k of KN) q('.mk_' + k).addEventListener('input', (e) => { x.micro.set(k, Number(e.target.value)); show(); keepMicro(); });
      q('.slotOn').addEventListener('click', () => { power(!x.micro.enabled); keepMicro(); });
      q('.fxSource').addEventListener('change', (e) => { if (e.target.value !== '') toggleFxSource(x, Number(e.target.value)); });
      q('.fxClear').addEventListener('click', () => setFxSources(x, []));
      q('.fxMuteDry').addEventListener('change', (e) => { x.muteDry = e.target.checked; applyFx(); keepMicro(); });
      x.ui = { show, power, q };
      applySlotSaved(x, sv);
    }
    const showTab = () => {
      tabs.querySelectorAll('.fxtab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.slot === fxTab)));
      host.querySelectorAll('.fxslot').forEach((e) => { e.hidden = e.dataset.slot !== fxTab; });
    };
    showTab(); fillFxSources();
    $('#fxpanel').classList.add('live'); $('#fxIdle').hidden = true;
    setInterval(() => slotList().forEach((x) => x.micro.setTempo(cfg.tempo)), 500); /* the stepped presets follow the tempo, including its glide */
  }


  // ---------------- Live input (microphone / 3.5 mm / interface) ----------------
  // A row at the top of the instrument list: the button starts / stops the input, A / B send it into the effect boxes,
  // the gear opens device, level and monitoring. Audio: input -> level -> sends into box A / B (+ optional dry into the compressor).
  const live = { on: false, starting: false, stream: null, src: null, trim: null, an: null, sends: {}, dry: null, buf: null };
  const LS = 'resonance.livein';
  const L = Object.assign({ dev: '', ch: 'auto', gain: 1, a: true, b: false, dry: false, clean: false, open: false }, (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { return {}; } })());
  const keepLive = () => { try { localStorage.setItem(LS, JSON.stringify(L)); } catch { /* storage unavailable */ } };
  let liveMsg = '', liveErr = false, liveDevs = [];
  function liveNote(t, err) { liveMsg = t; liveErr = !!err; const n = $('#liveNote'); if (n) { n.textContent = t; n.classList.toggle('err', !!err); } }
  function liveRoute() {
    for (const k of ['a', 'b']) document.querySelectorAll(`.fxbtn.livefx[data-slot="${k}"]`).forEach((b) => b.classList.toggle('on', !!L[k]));
    const gv = $('#liveGv'); if (gv) gv.textContent = Math.round(L.gain * 100) + '%';
    const b = $('#liveOn'); if (b) { b.dataset.state = live.on ? 'playing' : live.starting ? 'starting' : 'off'; b.querySelector('.st').textContent = live.on ? 'live' : live.starting ? 'starting' : ''; }
    if (!live.on) return;
    const now = ctx.currentTime;
    for (const k of ['a', 'b']) live.sends[k].gain.setTargetAtTime(L[k] ? 1 : 0, now, 0.03);
    live.dry.gain.setTargetAtTime(L.dry ? 1 : 0, now, 0.03);
    live.trim.gain.setTargetAtTime(L.gain, now, 0.03);
    const off = ['a', 'b'].filter((k) => L[k] && slots[k] && !slots[k].micro.enabled).map((k) => k.toUpperCase());
    if (off.length) liveNote(`Effect box ${off.join(' and ')} is Off: turn it On (right panel) to hear the input.`);
    else if (!L.a && !L.b && !L.dry) liveNote('Nothing to listen to: send it to A or B, or tick "Hear the dry input".');
    else liveNote('Use headphones with the built-in microphone, or the speakers will feed back into it.');
  }
  async function listInputs() {
    try {
      liveDevs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
      const sel = $('#liveDev'); if (!sel) return;
      sel.innerHTML = ''; sel.add(new Option('Default input', ''));
      liveDevs.forEach((d, i) => sel.add(new Option(d.label || 'Input ' + (i + 1), d.deviceId)));
      sel.value = [...sel.options].some((o) => o.value === L.dev) ? L.dev : '';
      const role = $('#liveRole'); if (role) role.textContent = sel.value ? sel.selectedOptions[0].text : 'mic · line in';
    } catch { /* no device list */ }
  }
  function liveStop() {
    if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
    for (const n of [live.src, live.split, live.trim, live.an, live.dry, ...Object.values(live.sends)]) { try { n && n.disconnect(); } catch { /* gone */ } }
    Object.assign(live, { on: false, starting: false, stream: null, src: null, split: null, trim: null, an: null, sends: {}, dry: null });
    const m = $('#liveMeter'); if (m) m.style.width = '0';
    liveRoute();
  }
  async function liveStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { liveNote('This page cannot use the microphone. Open it as http://localhost:… on this Mac (not the network address).', true); openLive(true); return; }
    if (!ctx) { liveNote('Start the engine first.', true); openLive(true); return; }
    liveStop(); live.starting = true; liveRoute();
    try {
      live.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: L.dev ? { exact: L.dev } : undefined, echoCancellation: L.clean, noiseSuppression: L.clean, autoGainControl: false, channelCount: { ideal: 2 }, latency: 0 } });
    } catch (e) {
      live.starting = false; liveRoute(); openLive(true);
      liveNote(e && e.name === 'NotAllowedError' ? 'The browser blocked the microphone. Allow it for this site (the icon in the address bar), then try again.' : 'Could not open that input: ' + (e && e.message || e), true);
      return;
    }
    /* always stereo downstream: every node after the source is forced to 2 channels, so a mono input is copied to left AND right.
       A stereo input is used as it is ('auto'), or one side is picked and copied to both ('left' / 'right', for an interface with a single input plugged in). */
    const stereo = (n) => { n.channelCount = 2; n.channelCountMode = 'explicit'; n.channelInterpretation = 'speakers'; return n; };
    live.src = ctx.createMediaStreamSource(live.stream); live.trim = stereo(ctx.createGain());
    const chans = (live.stream.getAudioTracks()[0].getSettings() || {}).channelCount || 1;
    if ((L.ch === 'left' || L.ch === 'right') && chans > 1) { live.split = ctx.createChannelSplitter(2); live.src.connect(live.split); live.split.connect(live.trim, L.ch === 'left' ? 0 : 1, 0); }
    else live.src.connect(live.trim);
    live.an = ctx.createAnalyser(); live.an.fftSize = 1024; live.buf = new Float32Array(1024);
    live.trim.connect(live.an);
    for (const k of ['a', 'b']) { const g = stereo(ctx.createGain()); g.gain.value = 0; live.trim.connect(g); if (slots[k]) g.connect(slots[k].micro.input); live.sends[k] = g; }
    live.dry = stereo(ctx.createGain()); live.dry.gain.value = 0; live.trim.connect(live.dry); live.dry.connect(compNode);
    live.on = true; live.starting = false;
    liveRoute(); await listInputs(); /* (device names appear once the permission is given) */
  }
  function openLive(open) { L.open = open; const d = $('#liveDetail'), g = $('#liveGear'); if (d) d.hidden = !open; if (g) g.setAttribute('aria-expanded', String(open)); keepLive(); }
  function mountLiveRow() { /* (called each time the instrument list is rebuilt) */
    const host = $('#stems'); if (!host) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="stemrow liverow" style="--c:#5fd39a"><button class="stem" id="liveOn" type="button" data-state="off" style="--c:#5fd39a" title="Start / stop the Mac's microphone, 3.5 mm input or audio interface"><span class="dot"></span><span class="name">Live input</span><span class="role" id="liveRole">mic · line in</span><span class="st"></span></button><span class="fxbtns"></span><button class="livegear" id="liveGear" type="button" aria-expanded="false" title="Input device, level and monitoring">⚙</button></div>
      <div id="liveDetail" hidden>
        <label><span class="label">Input device</span><select id="liveDev" aria-label="Audio input device"><option value="">Default input</option></select></label>
        <label><span class="label">Channels</span><select id="liveCh" aria-label="Which input channel to use"><option value="auto">Stereo, or mono copied to both sides</option><option value="left">Left input only, copied to both sides</option><option value="right">Right input only, copied to both sides</option></select></label>
        <label><span class="label">Level <span id="liveGv"></span></span><input id="liveGain" type="range" min="0" max="2" step="0.01"></label>
        <div class="livemeter" aria-hidden="true"><i id="liveMeter"></i></div>
        <label class="fxchk" title="Also play the unprocessed input. Off = only what comes out of the effect."><input type="checkbox" id="liveDry"><span>Hear the dry input too</span></label>
        <label class="fxchk" title="Echo cancellation and noise suppression: helps when speakers are close to the microphone, but dulls instruments and line inputs."><input type="checkbox" id="liveClean"><span>Clean up (echo cancel, noise reduction)</span></label>
        <div class="fxhint" id="liveNote"></div>
        <div class="fxhint">If the whole mix turns mono or dull when this starts, Bluetooth headphones have probably switched to headset mode: use wired or built-in output, or pick a different input device.</div>
      </div>`;
    while (wrap.lastChild) host.insertBefore(wrap.lastChild, host.firstChild);
    const fb = host.querySelector('.liverow .fxbtns');
    for (const d of SLOTS) {
      const fx = document.createElement('button'); fx.type = 'button'; fx.className = 'fxbtn livefx'; fx.dataset.slot = d.key; fx.textContent = d.tab;
      fx.title = `Send the live input into Microcosm box ${d.tab} (${d.name}). Click again to remove it.`;
      fx.addEventListener('click', () => { L[d.key] = !L[d.key]; keepLive(); liveRoute(); }); fb.appendChild(fx);
    }
    $('#liveOn').addEventListener('click', () => { if (live.on || live.starting) liveStop(); else liveStart(); });
    $('#liveGear').addEventListener('click', () => openLive(!L.open));
    $('#liveCh').value = L.ch; $('#liveGain').value = L.gain; $('#liveDry').checked = L.dry; $('#liveClean').checked = L.clean;
    $('#liveGain').addEventListener('input', (e) => { L.gain = Number(e.target.value); keepLive(); liveRoute(); });
    $('#liveDry').addEventListener('change', (e) => { L.dry = e.target.checked; keepLive(); liveRoute(); });
    $('#liveClean').addEventListener('change', (e) => { L.clean = e.target.checked; keepLive(); if (live.on) liveStart(); });
    $('#liveCh').addEventListener('change', (e) => { L.ch = e.target.value; keepLive(); if (live.on) liveStart(); });
    $('#liveDev').addEventListener('change', (e) => { L.dev = e.target.value; keepLive(); if (live.on) liveStart(); else listInputs(); });
    openLive(L.open); liveNote(liveMsg || 'Use headphones with the built-in microphone, or the speakers will feed back into it.', liveErr);
    listInputs(); liveRoute();
  }
  function initLiveUI() {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listInputs);
    setInterval(() => {
      if (!live.on) return;
      live.an.getFloatTimeDomainData(live.buf); let p = 0; for (let i = 0; i < live.buf.length; i++) p = Math.max(p, Math.abs(live.buf[i]));
      const m = $('#liveMeter'); if (m) { m.style.width = Math.min(100, Math.round(Math.sqrt(p) * 100)) + '%'; m.style.background = p > 0.9 ? '#ef5a4a' : '#5fd39a'; }
      liveRoute();
    }, 150);
  }

  // ---------------- Audio setup ----------------
  async function start() {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await ctx.resume();
    master = ctx.createGain(); master.gain.value = Number($('#vol').value);
    brightness = ctx.createBiquadFilter(); brightness.type = 'lowpass'; brightness.Q.value = 0.5;
    applyBrightness(Number($('#bright').value));
    const comp = compNode = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.3;
    analyserMaster = ctx.createAnalyser(); analyserMaster.fftSize = 2048;
    master.connect(brightness).connect(comp).connect(analyserMaster).connect(ctx.destination);
    try { /* the Microcosm effect boxes: wet-only, returned just before the compressor. A box's input is the sends of its chosen stems (see wireFx) or, when none is chosen, the master mix after the brightness filter */
      for (const d of SLOTS) {
        const m = await ResonanceMicro.create(ctx); m.setPreset(d.first);
        const ms = ctx.createGain(); ms.gain.value = 0; brightness.connect(ms); ms.connect(m.input); m.output.connect(comp);
        slots[d.key] = { def: d, micro: m, masterSend: ms, set: new Set(), names: [], muteDry: false, el: null };
      }
    } catch (e) { console.warn('Microcosm effect box unavailable', e); for (const k of Object.keys(slots)) delete slots[k]; $('#fxIdle').textContent = 'The effect box is not available in this browser.'; }

    createStemNodes();
    if (slotList().length) initMicroUI();
    initLiveUI();
    settingsSeeds(cfg.stems);
    setBuffers(await loadAll());
    stale = false; t0 = ctx.currentTime + 0.1;
    started = true; showSong();
    setTimeout(() => { if (cfg.pack && cfg.pack.settings) { settingsPads(cfg.stems); if (cfg.pack.settings.micro && slotList().length) applyKitMicro(cfg.pack.settings.micro); } settingsReady = true; }, 600);
    $('#gate').hidden = true;
    setInterval(clockLoop, 15);
    requestAnimationFrame(draw);
    /* Every engine start begins silent: drop whatever was left active on the server (audience taps made before the start, a previous run) */
    send({ type: 'claim' }); sendAllRolls(); send({ type: 'stopAll' }); send({ type: 'newShow' }); desired = new Set(); runStart = null; runEnded = false;
    if (cfg.pack && cfg.pack.id !== curPackId) await switchPack(); // pack changed while we were loading
    else reconcile();
  }

  // One audio chain per stem of the current pack:
  // voices -> bus (pack gain) -> low-pass (XY x) -> xyGain (XY y) -> analyser + master
  function makeStemNodes(def) {
    const bus = ctx.createGain(); bus.gain.value = def.gain ?? 0.7;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 1.3; /* a touch of resonance so a cutoff sweep sings */ filter.frequency.value = 20000;
    const xyGain = ctx.createGain();
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    const dry = ctx.createGain(); /* the stem's normal path to the mix (the Microcosm panel can mute it for its source) */
    bus.connect(filter).connect(xyGain);
    xyGain.connect(analyser); xyGain.connect(dry); dry.connect(master);
    const st = { def, buffer: null, layers: [], bus, filter, xyGain, dry, analyser, voice: null, stopUntil: 0, level: 0 };
    stems.set(def.id, st); wireFx(st);
    return st;
  }
  const dropStemNodes = (st) => { for (const n of [st.bus, st.filter, st.xyGain, st.dry, ...Object.values(st.fxSends || {}), st.analyser]) { try { n.disconnect(); } catch { /* already gone */ } } };
  function createStemNodes() {
    curPackId = cfg.pack ? cfg.pack.id : null; curRev = cfg.pack ? cfg.pack.rev ?? 0 : 0;
    for (const def of cfg.stems) makeStemNodes(def);
    for (const def of cfg.stems) applyXY(def.id);
    applyFx(); /* (the Microcosm source, if any, applies to the new stems) */
  }

  // A kit went live: the server has faded out the Melodic / Rhythmic stems and replaced them. Only the stems that changed are rebuilt;
  // the others (core synth, nature samples...) keep playing, in time, throughout.
  async function swapKit(prev) {
    while (switching) await sleep(100);
    switching = true;
    try {
      const was = new Map(prev.stems.map((d) => [d.id, JSON.stringify(d)]));
      const fresh = cfg.stems.filter((d) => was.get(d.id) !== JSON.stringify(d));
      const gone = prev.stems.filter((d) => !cfg.stems.some((x) => x.id === d.id) || fresh.some((x) => x.id === d.id));
      settingsReady = false; clearTimeout(settingsTimer);
      for (const d of gone) { delete keptXY[d.id]; varSeed.delete(d.id); const st = stems.get(d.id); if (st) { if (st.voice) { stopVoice(st.voice, ctx.currentTime + LEAD, st); st.voice = null; } dropStemNodes(st); stems.delete(d.id); } delete xyState[d.id]; }
      curRev = cfg.pack.rev ?? 0;
      toast('kit', 'work', `Loading ${cfg.pack.kit ? cfg.pack.kit.name : 'new sounds'}…`);
      for (const d of fresh) { if (xyState[d.id] === undefined) delete xyState[d.id]; makeStemNodes(d); }
      for (const d of fresh) applyXY(d.id);
      if (sheet) sheet.close();
      settingsSeeds(fresh);
      const defs = fresh;
      if (defs.length) setBuffers(await loadAll(cfg.tempo, defs));
      buildStemRows(); applyFx();
      settingsPads(fresh);
      const sm = cfg.pack.settings && cfg.pack.settings.micro, m = sm || (cfg.pack.kit && cfg.pack.kit.micro); if (m) applyKitMicro(m);
      toast('kit', 'ok', `✓ ${cfg.pack.kit ? cfg.pack.kit.name : 'Sounds'} is live`);
    } catch (err) {
      console.error('kit swap failed', err);
      toast('kit', 'err', `Could not load ${cfg.pack.kit ? cfg.pack.kit.name : 'the sounds'}: ${err && err.message || err}. Reload this page (Cmd+Shift+R) and restart the server.`);
      try { buildStemRows(); applyFx(); } catch (e) {}
    } finally { switching = false; settingsReady = true; }
    reconcile(); renderRows(); kitBar();
  }

  // Switch to the pack in `cfg`: fade out whatever is playing, load the new stems, restart the bar count.
  async function switchPack() {
    if (switching) return; // the running switch re-checks cfg.pack when it finishes
    switching = true;
    try {
      while (cfg.pack && cfg.pack.id !== curPackId) {
        $('#packStatus').textContent = `Switching to ${cfg.pack.name}…`; toast('pack', 'work', `Switching to ${cfg.pack.name}: fading out, then loading…`);
        let wait = 0;
        for (const st of stems.values()) if (st.voice) wait = Math.max(wait, fadeOut(st));
        stopAllNow();
        if (wait) await sleep((wait + 0.15) * 1000);
        for (const st of stems.values()) for (const n of [st.bus, st.filter, st.xyGain, st.dry, ...Object.values(st.fxSends || {}), st.analyser]) { try { n.disconnect(); } catch { /* already gone */ } }
        stems.clear();
        key = custom ? key : (cfg.key || 'D'); seed = cfg.seed ?? 1; $('#key').value = key;
        createStemNodes();
        setBuffers(await loadAll());
        stale = false; t0 = ctx.currentTime + 0.1; lastBeat = -1; lastPlayingSent = '';
      }
    } finally { switching = false; }
    reconcile(); renderRows();
    toast('pack', 'ok', `✓ Pack loaded: ${cfg.pack ? cfg.pack.name : ''}`);
  }

  /* ---- Explicit action feedback: every management control reports working / done / error ---- */
  const toastTimers = {};
  function toast(key, kind, text, ttl) {
    let box = $('#toasts'), el = box.querySelector(`[data-k="${key}"]`);
    if (!el) { el = document.createElement('div'); el.dataset.k = key; el.innerHTML = '<i></i><span></span>'; box.appendChild(el); }
    el.className = 'toast ' + kind; el.lastChild.textContent = text;
    clearTimeout(toastTimers[key]);
    const life = ttl ?? (kind === 'work' ? 0 : kind === 'ok' ? 4500 : 9000); /* working stays until replaced; errors linger */
    if (life) toastTimers[key] = setTimeout(() => el.remove(), life);
    while (box.children.length > 4) box.firstChild.remove();
  }
  function btnState(btn, label, kind) { /* inline state on the button itself */
    if (!btn || btn.tagName === 'SELECT') return;
    if (btn.dataset.orig === undefined) btn.dataset.orig = btn.textContent;
    btn.textContent = label; btn.classList.toggle('busy', kind === 'work'); btn.classList.toggle('done', kind === 'ok');
    clearTimeout(btn._t);
    if (kind !== 'work') btn._t = setTimeout(() => { btn.textContent = btn.dataset.orig; btn.classList.remove('done'); }, 2500);
  }
  let progressHook = null;
  /* The one-shot recordings of a 'beats' stem (hand drums etc.): fetched and decoded once, shared by every stem and render. -> { voice name: [AudioBuffer...] } */
  const sampleCache = new Map();
  const oneShot = (url) => { if (!sampleCache.has(url)) sampleCache.set(url, fetch(url, { cache: 'force-cache' }).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); }).then((ab) => ctx.decodeAudioData(ab))); return sampleCache.get(url); };
  async function loadVoices(def) {
    const out = {};
    for (const [name, urls] of Object.entries(def.voiceUrls || {})) out[name] = await Promise.all(urls.map(oneShot));
    return out;
  }
  async function loadAll(tempo = cfg.tempo, defs = cfg.stems) {
    rendering = true;
    let done = 0;
    const progress = () => {
      const t = `Preparing ${cfg.pack ? cfg.pack.name : 'stems'}… ${done}/${defs.length}`;
      $('#progress').textContent = t;
      if (started) $('#packStatus').textContent = t;
    };
    progress();
    const buffers = await Promise.all(defs.map(async (def) => {
      let buf;
      try {
        if (def.file) {
          const res = await fetch(def.url, { cache: 'no-store' });
          if (!res.ok) throw new Error(`${def.file}: HTTP ${res.status}`);
          buf = await ctx.decodeAudioData(await res.arrayBuffer());
        } else {
          const samples = def.synth === 'beats' ? await loadVoices(def) : undefined;
          const voiceSample = def.voice === 'sample' && def.voiceUrl ? { buf: await oneShot(def.voiceUrl), root: def.voiceRoot, gain: def.voiceGain, loop: def.voiceLoop } : undefined; /* a kit's recorded voice */
          buf = await ResonanceSynth.renderStem({
            voice: def.voice, voiceSample, tpl: def.tpl, samples, pattern: def.synth === 'beats' ? { voices: def.voices, tiers: def.tiers, steps: def.steps } : undefined,
            synth: def.synth, id: def.id, sampleRate: ctx.sampleRate, tempo,
            beatsPerBar: cfg.beatsPerBar, bars: def.bars || 8, key, mode: cfg.mode, progression: def.progression, style: def.style, seed: varSeed.has(def.id) ? varSeed.get(def.id) : seed, planSeed: seed, custom, lush, tiers: !!def.complexity,
          });
        }
      } catch (e) { console.error(e); alertBanner(`Stem "${def.name}" failed to load: ${e.message}`); }
      done++; progress(); if (progressHook) progressHook(done, defs.length);
      return [def.id, buf];
    }));
    rendering = false;
    $('#progress').textContent = '';
    $('#packStatus').textContent = '';
    return buffers;
  }

  // ---------------- Clock math ----------------
  const beatLen = () => 60 / cfg.tempo;
  const barLen = () => beatLen() * cfg.beatsPerBar;
  function unitLen() {
    const b = beatLen();
    return quantize === 'bar' ? barLen() : quantize === 'half' ? b * cfg.beatsPerBar / 2 : b;
  }
  function nextBoundary(unit = unitLen()) {
    const now = ctx.currentTime;
    const k = Math.floor((now + LEAD - t0) / unit) + 1;
    return t0 + k * unit;
  }
  function loopLen(st) {
    if (st.def.file && tempoOverride) return st.buffer.duration; /* recorded loops keep their own length */
    if (!st.def.file) return st.buffer.duration; /* a generated stem loops over its whole buffer: its length is the chart's (a 32-bar chart must not be cut to the pack's 8 bars: that jumped the waveform at bars 9, 17, 25 and 1) and its seam is made to be sample-exact */
    const want = (st.def.bars || 8) * barLen();
    return Math.min(want, st.buffer.duration);
  }

  // ---------------- Voices ----------------
  // Fade times: per-stem override -> engine slider -> config.json (fadeIn/fadeOut, legacy "fade").
  let fadeInSec = null, fadeOutSec = null;
  const fadeIn = (st) => Math.max(0.01, st.def.fadeIn ?? fadeInSec ?? cfg.fadeIn ?? cfg.fade ?? 4);
  const fadeOut = (st) => Math.max(0.01, st.def.fadeOut ?? fadeOutSec ?? cfg.fadeOut ?? cfg.fade ?? 4);

  // S-shaped curve from silence to full level (gentle start, gentle landing).
  const FADE_IN_CURVE = (() => { const n = 256, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1); c[i] = Math.pow(Math.sin(x * Math.PI / 2), 2); } return c; })();

  // Each voice: source -> fadeIn gain -> fadeOut gain -> stem bus.
  // Two separate gains so a stop during a fade-in never jumps: the fade-out simply multiplies on top.
  function startVoice(st, when, o = {}) {
    if (st.def.oneShot) { /* a strike: plays once from its start (not looped, not phase-aligned), the tail fades out at the end */
      /* the strike window is part of the recording, so it is measured at the tempo the file was cut at, not at the current BPM: at a slower BPM a window of N current bars ran on into the repeat of the strike (the gong rang twice, close together) */
      const nativeBar = (60 / (packTempo || cfg.tempo)) * cfg.beatsPerBar;
      const len = Math.min((st.def.playBars || 8) * nativeBar, st.buffer.duration);
      const rate = o.rate || 1, D = len / rate; /* o.rate < 1 plays the strike lower (and longer) */
      const src = ctx.createBufferSource(); src.buffer = st.buffer; src.loop = false; src.playbackRate.value = rate;
      const gIn = ctx.createGain(), gOut = ctx.createGain(), gv = ctx.createGain(); gv.gain.value = o.level ?? 1;
      gIn.gain.value = 0; gIn.gain.setValueCurveAtTime(FADE_IN_CURVE, when, fadeIn(st));
      gOut.gain.setValueAtTime(1, Math.max(when, when + D - 1.5)); gOut.gain.linearRampToValueAtTime(0, when + D);
      let tail = gOut; src.connect(gIn).connect(gOut);
      if (o.darken) { /* the ring loses its highs slowly: it darkens as it dies away */
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.4; lp.frequency.setValueAtTime(9000, when); lp.frequency.setTargetAtTime(1000, when + 0.5, D * 0.22);
        gOut.connect(lp); tail = lp;
      }
      tail.connect(gv); gv.connect(st.bus); if (o.send) gv.connect(o.send);
      src.start(when, 0, len);
      return { src, g: gOut, start: when, end: when + D };
    }
    const L = loopLen(st);
    const offset = (((when - t0) % L) + L) % L; // phase-aligned entry
    const src = ctx.createBufferSource();
    src.buffer = st.buffer; src.loop = true; src.loopStart = 0; src.loopEnd = L;
    const gIn = ctx.createGain(), gOut = ctx.createGain();
    gIn.gain.value = 0;
    gIn.gain.setValueCurveAtTime(FADE_IN_CURVE, when, fadeIn(st)); // always starts from silence
    src.connect(gIn).connect(gOut).connect(st.bus);
    src.start(when, offset);
    const srcs = [src], lg = [];
    (st.layers || []).forEach((lb, k) => { /* complexity layers: the same loop length and phase, each through its own gain that the pad's X axis moves */
      const ls = ctx.createBufferSource(); ls.buffer = lb; ls.loop = true; ls.loopStart = 0; ls.loopEnd = L;
      const g = ctx.createGain(); g.gain.value = layerGainNow(st, k);
      ls.connect(g).connect(gIn); ls.start(when, offset); srcs.push(ls); lg.push(g);
    });
    return { src, srcs, lg, g: gOut, start: when };
  }

  function stopVoice(v, when, st, dur) {
    const now = ctx.currentTime;
    if (v.start > now + 0.005) { // not audible yet: cancel outright
      for (const x of v.srcs || [v.src]) { try { x.stop(); } catch {} }
      return now;
    }
    const d = dur ?? (st ? fadeOut(st) : 4);
    const p = v.g.gain;
    p.setValueAtTime(1, when);
    p.linearRampToValueAtTime(0, when + d);
    for (const x of v.srcs || [v.src]) x.stop(when + d + 0.05);
    return when + d;
  }

  // Orderly exit: when several stems stop together (Stop all, end of run) they leave one stage per bar,
  // the reverse of how a piece is built: colour and nature first, then melody, rhythm, bass, pads, drone last.
  const EXIT = [/gong|stream|rain|garden|bells|shimmer/i, /melody|arp/i, /pulse|noise|texture|rhythm/i, /^sub/i, /atmos|pad/i, /drone/i];
  const exitRank = (st) => { const i = EXIT.findIndex((re) => re.test(st.def.name || '')); return i < 0 ? 1 : i; };
  function exitSpan() { /* seconds from first to last exit of the stems that are playing now */
    const r = new Set(); for (const st of stems.values()) if (st.voice) r.add(exitRank(st));
    return Math.max(0, r.size - 1) * barLen();
  }

  // Make actual playback match the desired set, on the next boundary.
  function freshen() { /* render every stem at the current tempo (once), for the first stem started after a tempo change with nothing playing */
    if (freshening) return freshening;
    freshening = (async () => {
      while (rendering || switching) await sleep(200);
      progressHook = (d, n) => toast('bpm', 'work', `Rendering at ${cfg.tempo} BPM… ${d}/${n}`);
      toast('bpm', 'work', `Rendering at ${cfg.tempo} BPM…`);
      let tempo;
      try { do { tempo = cfg.tempo; setBuffers(await loadAll(tempo)); } while (tempo !== cfg.tempo); } /* the target moved while rendering: render again */
      catch (err) { toast('bpm', 'err', `Render failed: ${err.message}`); return; }
      finally { progressHook = null; }
      stale = false; t0 = ctx.currentTime + 0.1; lastBeat = -1; if (runStart !== null) runStart = null;
      toast('bpm', 'ok', `✓ ${cfg.tempo} BPM ready`);
    })().finally(() => { freshening = null; });
    return freshening;
  }
  function reconcile() {
    if (stale) { if (desired.size) freshen().then(() => { if (!stale) reconcile(); }); return; }
    const when = nextBoundary();
    const leaving = [], sched = {};
    for (const [id, st] of stems) {
      if (!st.buffer) continue;
      const want = desired.has(id);
      if (want && !st.voice) { st.voice = startVoice(st, st.def.oneShot ? nextBoundary(barLen()) : when); /* a strike always lands on a bar line */
        if (st.roll) sched[id] = +((when - t0) / beatLen()).toFixed(3); } /* the phones' piano roll shows where the layer comes in (in beats on the same clock as the ticks) */
      else if (!want && st.voice) {
        if (st.voice.end && st.voice.end <= ctx.currentTime) { st.voice = null; st.stopUntil = 0; } /* a finished strike: nothing to fade */
        else leaving.push(st);
      }
    }
    if (Object.keys(sched).length) send({ type: 'sched', at: sched });
    const ranks = [...new Set(leaving.map(exitRank))].sort((a, b) => a - b);   /* only the stages that are actually used, one bar apart */
    for (const st of leaving) {
      const stage = leaving.length > 1 ? ranks.indexOf(exitRank(st)) : 0;
      st.stopUntil = stopVoice(st.voice, when + stage * barLen(), st); st.voice = null;
    }
  }

  // ---------------- The finale: the gong is the end-of-show signal ----------------
  // The server flags state.finale when the gong is started (by enough phones, the engine row, or HTTP). Here: three strikes on bar lines,
  // while every other stem fades out in stages (the reverse of how a piece is built: colour and nature first, melody, rhythm, bass, pads,
  // the drone last, the drone leaving as the third strike rings). The strikes are separate voices, so they overlap and ring into each other.
  let finale = null, finaleDone = false;
  const FINALE_GAPS = [3, 5], FINALE_SEMIS = [0, -2, -5], FINALE_LEVELS = [0.7, 0.85, 1], FINALE_FADE = 9, FINALE_PAUSE = 5;
  /* A dark, long hall for the gong only: noise with an exponential tail (about 8 s to fade 60 dB) whose highs die away with time. */
  function darkIR(sec = 9) {
    const sr = ctx.sampleRate, n = Math.round(sec * sr), buf = ctx.createBuffer(2, n, sr), pre = Math.round(0.03 * sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let y = 0;
      for (let i = pre; i < n; i++) { const t = (i - pre) / sr, a = 0.03 + 0.4 * Math.exp(-t / 0.8); y += a * ((Math.random() * 2 - 1) - y); d[i] = y * Math.exp(-0.863 * t); }
    }
    return buf;
  }
  function startFinale() {
    if (finale || !started || !ctx) return;
    const bl = barLen(), tBreath = nextBoundary(bl), t = tBreath + bl, voices = [], extra = [];
    const gong = [...stems.values()].find((s) => s.def.finale && s.buffer);
    const g0 = master.gain.value;
    /* a breath: the whole mix dips for the bar before the first strike, and the gong lands into that space */
    master.gain.setTargetAtTime(g0 * 0.6, tBreath, 0.4); master.gain.setTargetAtTime(g0, t - 0.08, 0.12);
    let tStrike3 = t;
    if (gong) {
      const conv = ctx.createConvolver(); conv.buffer = darkIR(); const send = ctx.createGain(), ret = ctx.createGain(); send.gain.value = 0.55; ret.gain.value = 0.7;
      send.connect(conv); conv.connect(ret); ret.connect(master); extra.push(send, conv, ret);
      const times = [t, t + FINALE_GAPS[0] * bl, t + (FINALE_GAPS[0] + FINALE_GAPS[1]) * bl];
      times.forEach((w, k) => voices.push(startVoice(gong, w, { rate: Math.pow(2, FINALE_SEMIS[k] / 12), level: FINALE_LEVELS[k], send, darken: true })));
      tStrike3 = times[2];
      gong.voice = voices[0]; voices[0].end = voices[2].end; /* shown as sounding until the last strike has rung out */
      /* a low sine boom under the last strike: the tonic two octaves down (as low as the Drone) with its octave, swelling in with the strike */
      const root = (ResonanceSynth.KEY_ROOTS[key] ?? 50), low = root - 24 >= 24 ? root - 24 : root - 12, f = 440 * Math.pow(2, (low - 69) / 12);
      const bg = ctx.createGain(); bg.gain.setValueAtTime(0, tStrike3 - 0.1); bg.gain.linearRampToValueAtTime(1, tStrike3 + 2); bg.gain.setTargetAtTime(0, tStrike3 + 3, 5);
      for (const [mul, lv] of [[1, 0.28], [2, 0.12]]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mul; const og = ctx.createGain(); og.gain.value = lv; o.connect(og).connect(bg); o.start(tStrike3 - 0.1); o.stop(tStrike3 + 32); extra.push(o); }
      bg.connect(gong.bus); extra.push(bg);
    }
    let last = voices.length ? voices[2].end : t;
    const stageBars = (FINALE_GAPS[0] + FINALE_GAPS[1]) / 5; /* the Drone starts to leave as the third strike sounds */
    for (const st of stems.values()) {
      if (st === gong || !st.voice || !st.buffer) continue;
      const at = t + exitRank(st) * stageBars * bl, dur = /drone/i.test(st.def.name || '') ? FINALE_FADE * 1.6 : FINALE_FADE;
      st.stopUntil = stopVoice(st.voice, at, st, dur); st.voice = null; last = Math.max(last, st.stopUntil);
    }
    finale = { t, voices, extra, g0, end: last };
    finaleDone = false; toast('finale', 'ok', 'The gong sounds: the show is ending');
    $('#songName').hidden = true;
    const wait = Math.max(0, (last + FINALE_PAUSE - ctx.currentTime) * 1000); /* then a few seconds of silence before the end is shown */
    finale.timer = setTimeout(() => { finaleDone = true; for (const st of stems.values()) st.voice = null; const el = $('#songName'); el.textContent = 'The end'; el.hidden = false; toast('finale', 'ok', 'End of show. “Restart run counter” or “Stop all” begins a new one'); renderRows(); }, wait);
  }
  function cancelFinale() {
    if (!finale) { finaleDone = false; return; }
    clearTimeout(finale.timer);
    try { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(finale.g0, ctx.currentTime, 0.1); } catch {}
    for (const n of finale.extra || []) { try { if (n.stop) n.stop(); n.disconnect(); } catch {} }
    for (const st of stems.values()) if (st.def.finale) st.voice = null;
    for (const v of finale.voices) { try { stopVoice(v, ctx.currentTime + 0.05, null, 0.4); } catch {} }
    finale = null; finaleDone = false; showSong();
  }

  function stopAllNow() {
    if (!ctx) return;
    cancelFinale();
    for (const st of stems.values()) if (st.voice) { st.stopUntil = stopVoice(st.voice, ctx.currentTime + LEAD, st); st.voice = null; }
  }

  function applyBrightness(v) {
    if (!brightness) return;
    const hz = 300 * Math.pow(2, v * 6); // 300 Hz .. 19.2 kHz
    brightness.frequency.setTargetAtTime(hz, ctx.currentTime, 0.2);
  }

  // Regenerate procedural stems (new key / seed) and swap them in on the next bar.
  async function regenerate(newTempo = cfg.tempo, what = 'New variation', btn = null, only = null) {
    if (!started) { if (/^Key/.test(what)) toast('regen', 'ok', `✓ ${what} will be used when the engine starts`); else toast('regen', 'err', `${what}: start the engine first`); return /^Key/.test(what); }
    if (rendering || switching) { toast('regen', 'err', `${what}: busy, wait for the current render to finish`); return false; }
    const bar = btn === false ? null : btn && btn.tagName !== 'SELECT' ? btn : (btn ? null : $('#regen')), orig = bar ? (bar.dataset.orig ?? bar.textContent) : '';
    $('#regen').disabled = true; $('#applyBpm').disabled = true; $('#key').disabled = true;
    btnState(bar, 'Rendering…', 'work');
    toast('regen', 'work', `${what}: rendering stems…`);
    progressHook = (d, n) => { toast('regen', 'work', `${what}: rendering stems ${d}/${n}…`); btnState(bar, `Rendering ${d}/${n}`, 'work'); };
    let results;
    if (only && (stale || newTempo !== cfg.tempo)) only = null; /* a pending tempo change has to re-render everything */
    try { results = await loadAll(newTempo, only ? [only] : undefined); }
    catch (err) { progressHook = null; toast('regen', 'err', `${what} failed: ${err.message}`); btnState(bar, orig, 'err'); $('#regen').disabled = false; $('#applyBpm').disabled = false; $('#key').disabled = false; return false; }
    progressHook = null;
    const retime = newTempo !== cfg.tempo || stale;
    stale = false;
    const when = retime && !anyVoice() ? ctx.currentTime + 0.05 : nextBoundary(barLen()); /* bar boundary on the current grid, or right now when a tempo change finds nothing playing */
    if (retime) { t0 = when; cfg.tempo = newTempo; tempoOverride = newTempo; lastBeat = -1; if (runStart !== null) runStart = when; }
    let swapped = 0;
    for (const [id, buf] of results) {
      const st = stems.get(id);
      if (!buf) continue;
      if (st.voice) { stopVoice(st.voice, when, st); setBuf(st, buf, (when - ctx.currentTime) * 1000); st.voice = startVoice(st, when); swapped++; } /* (its notes reach the phones when the new loop does) */
      else setBuf(st, buf);
    }
    if (retime) { $('#tempo').textContent = `${cfg.tempo} BPM · ${cfg.beatsPerBar}/4`; }
    if (!only) send({ type: 'reseed', seed, key });
    $('#regen').disabled = false; $('#applyBpm').disabled = false; $('#key').disabled = false; $('#applyBpm').hidden = true;
    updateRunInfo();
    const wait = Math.max(0, when - ctx.currentTime);
    if (swapped && wait > 0.3) { toast('regen', 'work', `${what}: ready, swapping in at the next bar (${wait.toFixed(1)} s)…`); btnState(bar, 'Waiting for bar…', 'work'); await sleep(wait * 1000 + 100); }
    const tn = only && results[0] && results[0][1] && results[0][1].roll && results[0][1].roll.name; toast('regen', 'ok', `✓ ${what}${tn ? ' (' + tn + ')' : ''} applied` + (swapped ? ` (${swapped} playing stem${swapped > 1 ? 's' : ''} swapped)` : ' (takes effect when stems start)'));
    btnState(bar, '✓ Applied', 'ok');
    return true;
  }
  function rollViewFor(id) { /* the pad's piano roll, the same view the phones get: where the notes are now, and when a layer that was just switched on comes in */
    const st = stems.get(id), r = st && st.roll; if (!r || !started || !ctx) return null;
    const now = ctx.currentTime, bl = beatLen(), pos = (now - t0) / bl, on = desired.has(id), xy = xyState[id] || ResonanceXY.XY_DEFAULT;
    const sounding = (st.voice && st.voice.start <= now) || st.stopUntil > now;
    let mode = 'off', start = null, label = 'Off';
    if (sounding) { mode = 'playing'; label = on ? 'Playing' : 'Fading out'; }
    else if (on && st.voice && st.voice.start > now) { mode = 'waiting'; start = (st.voice.start - t0) / bl; const left = Math.max(0, start - pos); label = left < 1 ? 'Starting' : `Starts in ${Math.ceil(left)} beat${Math.ceil(left) > 1 ? 's' : ''}`; }
    return { notes: r.notes, beats: r.beats, pos, bpb: cfg.beatsPerBar || 4, color: st.def.color || '#8fb8ff', mode, start, label, gains: st.def.complexity ? [1, ResonanceXY.layerGain(xy.x, 0), ResonanceXY.layerGain(xy.x, 1)] : [1, 0, 0] };
  }
  async function varyStem(id, btn) { /* "New variation" on one instrument: only its stem is rendered again, with a seed of its own, and swapped in on the next bar */
    const def = cfg.stems.find((d) => d.id === id); if (!def || def.file) return;
    const had = varSeed.has(id), prev = varSeed.get(id);
    varSeed.set(id, 1 + Math.floor(Math.random() * 999999));
    if (!(await regenerate(cfg.tempo, `New variation: ${def.name}`, btn, def))) { if (had) varSeed.set(id, prev); else varSeed.delete(id); } else saveSettingsSoon();
  }
  function setBuf(st, buf, delayMs = 0) { /* a rendered stem with complexity carries its two extra layers on the buffer, and its notes for the phones' piano roll */
    st.buffer = buf; st.layers = buf.layers || []; st.roll = buf.roll || null;
    if (st.roll && started) { if (delayMs > 50) setTimeout(() => sendRoll(st), delayMs); else sendRoll(st); }
  }
  /* The notes of a stem go to the phones through the server (it keeps the latest for phones that join later). [start beat, length in beats, pitch, layer] */
  function sendRoll(st) { if (st.roll) send({ type: 'notes', stem: st.def.id, beats: st.roll.beats, notes: st.roll.notes }); }
  function sendAllRolls() { for (const st of stems.values()) sendRoll(st); }
  function setBuffers(results) { for (const [id, buf] of results) if (buf) setBuf(stems.get(id), buf); }

  // ---------------- Clock loop: UI + reporting ----------------
  let lastBeat = -1;
  function clockLoop() {
    const now = ctx.currentTime;
    const pos = now - t0;
    if (pos < 0) return;
    const beatIdx = Math.floor(pos / beatLen());
    if (beatIdx !== lastBeat) {
      lastBeat = beatIdx;
      const bpb = cfg.beatsPerBar;
      const bar = Math.floor(beatIdx / bpb) % 8 + 1, beat = (beatIdx % bpb) + 1;
      $('#pos').textContent = `${bar}.${beat}`;
      send({ type: 'tick', bar, beat, bpb, n: beatIdx, bpm: cfg.tempo }); /* n = beats since the loop start: the phones' piano roll runs on it */
      updateRunInfo();
    }
    const playing = [];
    for (const [id, st] of stems) {
      const v = st.voice;
      if (v && v.end && now > v.end) { if (!v.done) { v.done = true; send({ type: 'set', stem: id, on: false }); } continue; } /* the strike has finished: free the stem for the next vote */
      if ((v && v.start <= now) || st.stopUntil > now) playing.push(id);
    }
    /* progression-run timer: starts with the first sound, fades everything out when the chosen number of runs is done */
    if (runStart === null) {
      let first = Infinity;
      for (const st of stems.values()) if (st.voice) first = Math.min(first, st.voice.start);
      if (isFinite(first)) { runStart = first; runEnded = false; }
    } else if (!runEnded && runs > 0 && !finale && !finaleDone) {
      let fo = 0; for (const st of stems.values()) if (st.voice) fo = Math.max(fo, fadeOut(st));
      if (now >= runStart + runs * cycleSec() - fo - exitSpan() - beatLen()) { runEnded = true; send({ type: 'stopAll' }); }
    }
    if (runEnded && !playing.length) runStart = null;
    if (pendingStop && !playing.length) endStop('All stems stopped');
    const key = playing.join(',');
    if (key !== lastPlayingSent) { lastPlayingSent = key; send({ type: 'playing', playing }); renderRows(); }
  }

  // ---------------- UI ----------------
  function buildStemRows() {
    const row = (s) => `
      <div class="stemrow" data-id="${s.id}" style="--c:${s.color || '#888'}">
      <button class="stem" data-id="${s.id}" style="--c:${s.color || '#888'}">
        <span class="dot"></span>
        <span class="name">${s.name}</span>
        <span class="role">${s.role || ''}${s.file ? ' · ' + s.file : ''}</span>
        <span class="st"></span>
      </button></div>`;
    const groups = cfg.groups || [];
    $('#stems').innerHTML = groups.length
      ? groups.map((g) => `<div class="ghead" title="Rules for audience phones. Your own taps here are never limited."><b>${g.name}</b><span>${(g.badges || []).join(' · ')}</span></div>${cfg.stems.filter((s) => s.group === g.id).map(row).join('')}`).join('')
      : cfg.stems.map(row).join('');
    $('#stems').querySelectorAll('.stem').forEach((b) =>
      b.addEventListener('click', () => send({ type: 'toggle', stem: Number(b.dataset.id) })));
    $('#stems').querySelectorAll('.stemrow').forEach((row) => {
      const id = Number(row.dataset.id), def = cfg.stems.find((s) => s.id === id);
      const mini = ResonanceXY.miniButton(xyState[id], !!def.complexity);
      mini.addEventListener('click', () => sheet.open(def, xyState[id] || ResonanceXY.XY_DEFAULT, desired.has(id)));
      row.appendChild(mini);
      if (!def.finale) { /* A / B: send this instrument into effect box A (arps, plucks) and/or B (long tones); click again to take it out */
        const wrap = document.createElement('span'); wrap.className = 'fxbtns';
        for (const d of SLOTS) {
          const fx = document.createElement('button'); fx.type = 'button'; fx.className = 'fxbtn'; fx.dataset.id = id; fx.dataset.slot = d.key; fx.textContent = d.tab;
          fx.title = `Send this instrument into Microcosm box ${d.tab} (${d.name}). Click again to remove it.`;
          fx.addEventListener('click', () => { if (slots[d.key]) toggleFxSource(slots[d.key], id); }); wrap.appendChild(fx);
        }
        row.insertBefore(wrap, mini);
      }
    });
    mountLiveRow();
    fillFxSources();
    if (!sheet) sheet = ResonanceXY.createSheet({
      send,
      rollView: rollViewFor,
      onVariation: varyStem, canVary: (def) => !def.file,
      onToggle: (id) => send({ type: 'toggle', stem: id }),
      onLocal: (id, p) => { xyState[id] = { ...p }; keptXY[id] = { ...p }; applyXY(id); saveSettingsSoon(); const m = document.querySelector(`.stemrow[data-id="${id}"] .xy-mini`); if (m) m.setXY(xyState[id]); },
    });
    renderRows();
  }

  function renderRows() {
    const now = ctx ? ctx.currentTime : 0;
    document.querySelectorAll('.stem[data-id]').forEach((b) => {
      const id = Number(b.dataset.id), st = stems.get(id);
      const want = desired.has(id);
      const sounding = st && ((st.voice && st.voice.start <= now) || st.stopUntil > now);
      const pl = playsState[id];
      const label = st && st.def.finale && (finale || finaleDone) ? (finaleDone ? 'done' : 'finale') : want ? (sounding ? 'playing' : 'starting') : (sounding ? 'stopping' : (pl ? (pl.used >= pl.max ? 'spent' : `${pl.max - pl.used} left`) : ''));
      b.dataset.state = label || 'off';
      b.querySelector('.st').textContent = label;
    });
    if (sheet && sheet.stemId != null) sheet.setOn(desired.has(sheet.stemId));
  }

  /* ---- Server status: ok / restarting / down, always visible (pill + banner + drawer) ---- */
  let srvState = 'ok', srvStarted = null, bannerTimer = 0, restartNote = '', restartNoteUntil = 0;
  function setSrv(state, title, detail) {
    srvState = state;
    const pill = $('#srvPill'); pill.className = 'pill ' + state; pill.lastElementChild.textContent = title;
    const big = $('#srvBig'); big.className = state; $('#srvState').textContent = title; $('#srvDetail').textContent = (state === 'ok' && Date.now() < restartNoteUntil ? restartNote + ' · ' : '') + (detail || '');
    const bn = $('#srvBanner'); const keepGood = state === 'ok' && bn.className === 'good' && !bn.hidden; if (!keepGood) clearTimeout(bannerTimer);
    if (state === 'ok' && bn.className === 'good' && !bn.hidden) { /* keep the green "restarted" confirmation up */ }
    else if (state === 'ok') { if (!bn.hidden && bn.dataset.bad) { bn.className = 'good'; bn.textContent = 'Server is back and running'; bn.dataset.bad = ''; bannerTimer = setTimeout(() => { bn.hidden = true; }, 4000); } else bn.hidden = true; }
    else { bn.className = ''; bn.dataset.bad = '1'; bn.hidden = false; bn.textContent = state === 'restarting' ? 'Server restarting… the engine keeps playing and reconnects automatically' : 'Server not reachable. ' + (detail || 'Retrying…'); }
  }
  function setConn(ok) {
    $('#conn').className = ok ? 'ok' : 'bad'; $('#conn').textContent = ok ? 'server connected' : 'reconnecting…';
    if (srvState === 'restarting') return; /* the restart watcher decides when it's over */
    if (ok) { if (srvState !== 'ok') refreshStatus(); } else setSrv('down', 'Server offline', 'Connection lost, retrying…');
  }
  const fmtUp = (u) => u < 90 ? u + ' s' : u < 5400 ? Math.round(u / 60) + ' min' : (u / 3600).toFixed(1) + ' h';
  async function refreshStatus() {
    try {
      const s = await (await fetch('/api/status', { cache: 'no-store' })).json();
      srvStarted = s.started;
      $('#srvInfo').textContent = `${s.clients} phone${s.clients === 1 ? '' : 's'} connected` + (s.supervised ? ' · auto-restart on' : ' · run with npm start for auto-restart');
      $('#restartBtn').disabled = !s.supervised;
      if (srvState !== 'restarting') setSrv('ok', 'Server running', `up ${fmtUp(s.uptime)} · pack ${s.pack} · ${s.node}`);
      return s;
    } catch { if (srvState !== 'restarting') setSrv('down', 'Server offline', 'Cannot reach the server, retrying…'); return null; }
  }
  /* After a restart request: show "restarting" at once, poll until the server answers with a new start time. */
  async function watchRestart(prevStarted) {
    setSrv('restarting', 'Server restarting…', 'Stopping and starting the process');
    const t0w = Date.now();
    while (Date.now() - t0w < 40000) {
      await sleep(500);
      let s = null; try { s = await (await fetch('/api/status', { cache: 'no-store' })).json(); } catch { /* still down */ }
      if (s && s.started !== prevStarted) {
        srvState = 'ok'; srvStarted = s.started; refreshStatus();
        const bn = $('#srvBanner'); bn.className = 'good'; bn.dataset.bad = ''; bn.hidden = false;
        bn.textContent = `Server restarted successfully (${Math.round((Date.now() - t0w) / 100) / 10} s)`; clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { bn.hidden = true; }, 5000);
        restartNote = `Restarted OK in ${Math.round((Date.now() - t0w) / 100) / 10} s`; restartNoteUntil = Date.now() + 8000; setSrv('ok', 'Server running', ''); refreshStatus();
        return;
      }
      $('#srvDetail').textContent = s ? 'Server answering, waiting for the new process…' : `Server is down, waiting for it to come back… ${Math.round((Date.now() - t0w) / 1000)} s`;
    }
    setSrv('down', 'Server did not come back', 'Check the terminal running npm start for an error.');
  }
  let restartArm = 0;
  $('#restartBtn').addEventListener('click', async () => {
    const b = $('#restartBtn');
    if (!restartArm) { restartArm = setTimeout(() => { restartArm = 0; b.textContent = 'Restart server'; }, 4000); b.textContent = 'Click again to restart'; return; }
    clearTimeout(restartArm); restartArm = 0; b.textContent = 'Restart server';
    const prev = srvStarted;
    try {
      const r = await fetch('/api/restart?key=' + encodeURIComponent(engineKey), { method: 'POST' });
      if (!r.ok) { setSrv('down', 'Restart refused', `HTTP ${r.status}${r.status === 401 ? ': engine key needed' : ''}`); return; }
    } catch { /* connection dropped because the server is already going down */ }
    watchRestart(prev);
  });
  setInterval(refreshStatus, 5000); refreshStatus();

  function alertBanner(t) { const el = $('#alert'); el.textContent = t; el.hidden = false; }

  // Generative visual: one breathing ring per stem, radius/brightness from its level.
  const cv = $('#viz'), g2 = cv.getContext('2d');
  const tmp = new Float32Array(512);
  // ---------------- Chord display: current chord + a fixed 5-bar page (4-bar phrase + next bar on deck) ----------------
  let chordTL = null, chordKey = '', chordShown = '', chordBar = -1, chordCurF = -1;
  let chordTrans = 0; /* display-only transposition in semitones: 0 = concert pitch, 2 = B♭ instruments */
  try { chordTrans = Number(localStorage.getItem('resonance.chordTrans')) === 2 ? 2 : 0; } catch {}
  $('#lushVoices').checked = lush.voices; $('#lushVerb').checked = lush.verb;
  for (const id of ['#lushVoices', '#lushVerb']) $(id).addEventListener('change', async () => {
    const prev = { ...lush }; lush = { voices: $('#lushVoices').checked, verb: $('#lushVerb').checked };
    try { localStorage.setItem('resonance.lush', JSON.stringify(lush)); } catch {}
    if (!started || !cfg) return;
    if (!(await regenerate(cfg.tempo, 'Lush ' + (lush.voices ? 'voices' : 'plain voices') + ', ' + (lush.verb ? 'new reverb' : 'old reverb'), false))) {
      lush = prev; $('#lushVoices').checked = lush.voices; $('#lushVerb').checked = lush.verb;
    }
  });
  $('#chordInst').value = String(chordTrans);
  $('#chordInst').addEventListener('change', (e) => { chordTrans = Number(e.target.value) === 2 ? 2 : 0; try { localStorage.setItem('resonance.chordTrans', chordTrans); } catch {} });

  // ---------------- Chord chart from MusicXML ----------------
  // Pick a file; its chord symbols replace the built-in progression in every generated stem (and in the chord display).
  let xmlBuf = null, xmlName = '', xmlSeq = 0;
  function xmlInfoText(c) {
    const i = c.info, kn = ResonanceSynth.KEYS[c.tonicPc] + (c.mode === 'minor' ? 'm' : '');
    const chain = c.chords.slice(0, 16).map((x) => `${ResonanceSynth.KEYS[(c.tonicPc + x.rel + 120) % 12]}${x.q}`).join(' · ') + (c.chords.length > 16 ? ' …' : '');
    return `<b>${esc(xmlName)}</b>${c.title ? ` · “${esc(c.title)}”` : ''}<br>${c.bars} bars, ${c.chords.length} chords, key ${kn} (concert). Read as ${esc(i.readAs)}.` +
      `<br>Concert: ${esc(chain)}` + (i.tempo ? `<br>The file says ♩ = ${Math.round(i.tempo)}; the engine BPM is unchanged.` : '') +
      c.warnings.map((w) => `<br><span class="warn">${esc(w)}</span>`).join('');
  }
  function showSong() { const el = $('#songName'), t = custom ? (custom.title || xmlName.replace(/\.(musicxml|mxl|xml)$/i, '')) : ''; el.textContent = finaleDone ? 'The end' : t; el.hidden = !(started && (t || finaleDone)) || !!(finale && !finaleDone); } // the song being played, on the main screen
  async function applyChart(buf, name) {
    const mine = ++xmlSeq;
    toast('xml', 'work', `Reading ${name}…`);
    let chart;
    try { chart = await ResonanceXML.parse(buf, { written: $('#xmlRead').value, grain: $('#xmlGrain').value }); }
    catch (err) { toast('xml', 'err', `${name}: ${err.message}`, 9000); $('#xmlInfo').innerHTML = `<span class="warn">${esc(name)}: ${esc(err.message)}</span>`; return false; }
    if (mine !== xmlSeq) return false;
    chart.id = `${name}:${Date.now()}`;
    const prev = { custom, key, name: xmlName }; xmlName = name;
    custom = chart; key = ResonanceSynth.KEYS[chart.tonicPc]; $('#key').value = key;
    const label = `Chord chart ${chart.title || name}`;
    if (!started) { toast('xml', 'ok', `✓ ${name} loaded: ${chart.bars} bars. It will be used when the engine starts`); }
    else if (!(await regenerate(cfg.tempo, label, false))) { custom = prev.custom; key = prev.key; xmlName = prev.name; $('#key').value = key; toast('xml', 'err', `${name} could not be applied`); return false; }
    $('#xmlInfo').innerHTML = xmlInfoText(chart); updateRunInfo(); showSong(); syncChartButtons();
    toast('xml', 'ok', `✓ ${name}: ${chart.bars} bars, ${chart.chords.length} chords, key ${key}`);
    return true;
  }
  $('#xmlPick').addEventListener('click', () => $('#xmlFile').click());
  $('#xmlFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('xml', 'err', `${f.name} is too large for a chord chart (over 8 MB)`); return; }
    const buf = await f.arrayBuffer(); xmlBuf = buf; await applyChart(buf, f.name);
  });
  for (const id of ['#xmlRead', '#xmlGrain']) $(id).addEventListener('change', () => { if (xmlBuf && custom) applyChart(xmlBuf, xmlName); });
  /* the button of the source in use is lit: "Built-in progression" while the built-in one is in use (also before the engine starts, where it suggests loading a file), "Choose file…" while a chart is loaded */
  const syncChartButtons = () => { $('#xmlReset').classList.toggle('lit', !custom); $('#xmlPick').classList.toggle('lit', !!custom); };
  setInterval(syncChartButtons, 300); syncChartButtons();
  $('#xmlReset').addEventListener('click', async () => {
    if (!custom) { toast('xml', 'ok', 'Already using the built-in progression. “Choose file…” loads a chord chart'); return; }
    const prev = { custom, key, name: xmlName }; custom = null; xmlBuf = null; key = (cfg && cfg.key) || 'D'; $('#key').value = key;
    if (started && !(await regenerate(cfg.tempo, 'Built-in progression', false))) { custom = prev.custom; key = prev.key; $('#key').value = key; return; }
    $('#xmlInfo').textContent = 'Using the built-in progression.'; xmlName = ''; updateRunInfo(); showSong(); syncChartButtons();
    if (!started) toast('xml', 'ok', '✓ Built-in progression will be used');
  });
  function updateChords(pos) {
    const panel = $('#chordPanel');
    const ref = cfg && cfg.stems.find((s) => s.synth);
    if (!ref) { panel.hidden = true; return; } // audio-file pack: no chord data
    const k = `${curPackId}|${key}|${cfg.mode}|${chordTrans}|${custom ? custom.id : ''}`;
    if (k !== chordKey) {
      chordKey = k; chordShown = ''; chordBar = -1;
      chordTL = ResonanceSynth.chordTimeline({ synth: ref.synth, progression: ref.progression, bars: ref.bars || 8, key, mode: cfg.mode, transpose: chordTrans, custom });
    }
    panel.hidden = false;
    const L = chordTL.bars, barF = ((pos / barLen()) % L + L) % L, bar = Math.floor(barF);
    const idxAt = (b) => { const x = ((b % L) + L) % L; return chordTL.chords.findIndex((c) => x >= c.start && x < c.start + c.len); };
    const curF = idxAt(barF); /* the chord sounding right now (a chart can change chords mid-bar) */
    const within = (b) => chordTL.chords.filter((c) => c.start < b + 1 && c.start + c.len > b); /* every chord that sounds in bar b */
    const label = (b) => { const w = within(((b % L) + L) % L); return { n: w.map((c) => c.name).join('  '), r: w.map((c) => c.roman).join(' ') }; };
    // Fixed page of 5 bars: the 4 bars of the current phrase + the first bar of the next phrase ("on deck").
    // The page only changes when a new phrase starts; the highlight is what moves.
    const ph = Math.floor(bar / 4), start = ph * 4, deckBar = start + 4 >= L ? 0 : start + 4;
    const cells = [0, 1, 2, 3].map((j) => (start + j < L ? start + j : null)).concat([deckBar]);
    const pageSig = `${chordKey}|${ph}`;
    if (pageSig !== chordShown) {
      chordShown = pageSig;
      $('#chordBars').innerHTML = cells.map((b, j) => {
        if (b === null) return '<div class="cb empty"></div>';
        const ch = chordTL.custom ? label(b) : { n: chordTL.chords[idxAt(b)].name, r: chordTL.chords[idxAt(b)].roman };
        const same = j > 0 && j < 4 && cells[j - 1] !== null && (chordTL.custom ? label(cells[j - 1]).n === ch.n : idxAt(cells[j - 1]) === idxAt(b));
        return `<div class="cb${same ? ' same' : ''}${j === 4 ? ' deck' : ''}" data-bar="${b}" data-ci="${idxAt(b)}"><div class="b">${j === 4 ? 'next · ' : ''}${b + 1}</div><div class="n">${ch.n}</div><div class="r">${ch.r}</div><div class="fill"></div></div>`;
      }).join('');
    }
    if (bar !== chordBar || curF !== chordCurF) { // move the highlight (cheap: class changes only)
      chordBar = bar; chordCurF = curF;
      const cur = idxAt(bar), c = chordTL.chords[curF >= 0 ? curF : cur];
      $('#cName').textContent = c.name; $('#cRoman').textContent = c.roman;
      $('#cBar').textContent = (chordTL.custom ? `bar ${bar + 1} of ${L} · phrase ${ph + 1}` : `bar ${bar - c.start + 1} of ${c.len} · loop bar ${bar + 1}/${L} · phrase ${ph + 1}`) + (chordTrans ? ` · B♭ parts, key of ${chordTL.keyName} (concert +${chordTrans})` : '');
      const els = [...document.querySelectorAll('#chordBars .cb[data-bar]')];
      const nowI = els.findIndex((el, j) => j < 4 && Number(el.dataset.bar) === bar);
      els.forEach((el, j) => {
        let run = false;
        if (j < 4 && Number(el.dataset.ci) === cur) { run = true; const st = j < nowI ? 1 : -1; for (let m = j; m !== nowI; m += st) if (Number(els[m].dataset.ci) !== cur) run = false; }
        el.classList.toggle('cur', run);
        el.classList.toggle('now', j === nowI);
        const fl = el.querySelector('.fill'); if (fl && j !== nowI) fl.style.width = '0';
      });
    }
    const f = document.querySelector('#chordBars .now .fill'); if (f) f.style.width = ((barF - bar) * 100).toFixed(1) + '%';
  }

  function draw() {
    requestAnimationFrame(draw);
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.fillStyle = 'rgba(10,12,20,0.22)'; g2.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42;
    const now = ctx.currentTime, pos = now - t0;
    if (pos >= 0 && !switching) updateChords(pos);
    const beatPhase = ((pos / beatLen()) % 1 + 1) % 1;
    const barPhase = ((pos / barLen()) % 1 + 1) % 1;

    // beat grid
    g2.strokeStyle = 'rgba(255,255,255,0.08)'; g2.lineWidth = 1;
    g2.beginPath(); g2.arc(cx, cy, R, 0, Math.PI * 2); g2.stroke();
    const bpb = cfg.beatsPerBar;
    for (let i = 0; i < bpb; i++) {
      const a = -Math.PI / 2 + (i / bpb) * Math.PI * 2;
      g2.fillStyle = Math.floor(barPhase * bpb) === i ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.15)';
      g2.beginPath(); g2.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 4, 0, Math.PI * 2); g2.fill();
    }
    const ha = -Math.PI / 2 + barPhase * Math.PI * 2;
    g2.fillStyle = 'rgba(255,255,255,0.5)';
    g2.beginPath(); g2.arc(cx + Math.cos(ha) * R, cy + Math.sin(ha) * R, 2.5, 0, Math.PI * 2); g2.fill();

    let i = 0;
    for (const st of stems.values()) {
      st.analyser.getFloatTimeDomainData(tmp);
      let sum = 0; for (let k = 0; k < tmp.length; k++) sum += tmp[k] * tmp[k];
      const rms = Math.sqrt(sum / tmp.length);
      st.level += (Math.min(1, rms * 6) - st.level) * 0.15;
      const n = stems.size, base = R * (0.18 + 0.72 * (i + 0.5) / n);
      if (st.level > 0.004) {
        g2.strokeStyle = st.def.color || '#fff';
        g2.globalAlpha = Math.min(1, 0.15 + st.level * 1.5);
        g2.lineWidth = 1 + st.level * 10;
        g2.beginPath();
        for (let a = 0; a <= 64; a++) {
          const th = (a / 64) * Math.PI * 2;
          const wob = Math.sin(th * (i + 2) + pos * (0.3 + i * 0.07)) * st.level * 14;
          const r = base + wob + (1 - beatPhase) * st.level * 6;
          const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
          a ? g2.lineTo(x, y) : g2.moveTo(x, y);
        }
        g2.closePath(); g2.stroke(); g2.globalAlpha = 1;
      }
      i++;
    }
  }

  // ---------------- Pack browser ----------------
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => (b ? (b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB') : 'no files');
  let packData = null;

  function openPacks() { $('#packs').hidden = false; loadPackList(); }
  function closePacks() { $('#packs').hidden = true; }

  async function loadPackList() {
    try {
      const res = await fetch('/api/packs', { cache: 'no-store' }); // the server re-scans packs/ on every request
      packData = await res.json();
      renderPackList();
    } catch (e) { $('#packList').innerHTML = `<p class="muted">Couldn't load the pack list: ${esc(e.message)}</p>`; }
  }

  function renderPackList() {
    const cur = cfg && cfg.pack ? cfg.pack.id : packData.active;
    $('#packList').innerHTML = packData.packs.map((p) => {
      const isActive = p.id === cur;
      const notes = [...p.skipped.map((x) => `✗ ${x.name}: ${x.reason}`), ...p.warnings.map((w) => `⚠ ${w}`)];
      const src = /^https?:\/\//.test(p.source) ? ` · <a href="${esc(p.source)}" target="_blank" rel="noopener">source</a>` : '';
      const credits = p.credits.length ? `<details><summary>Credits</summary><ul>${p.credits.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>` : '';
      return `<article class="pack${isActive ? ' active' : ''}${p.playable ? '' : ' off'}">
        <header><b>${esc(p.name)}</b>${isActive ? '<span class="badge on">Active</span>' : ''}</header>
        ${p.description ? `<p class="pd">${esc(p.description)}</p>` : ''}
        <div class="badges">
          <span class="badge">${p.tempo} BPM · ${p.beatsPerBar}/4</span>
          <span class="badge">${p.key ? 'Key ' + esc(p.key) + (p.mode === 'major' ? ' major' : ' minor') : 'Key-agnostic'}</span>
          <span class="badge">${p.stems.length} stem${p.stems.length === 1 ? '' : 's'}</span>
          ${p.sizeBytes ? `<span class="badge">${fmtSize(p.sizeBytes)}</span>` : ''}
          ${p.tags.map((t) => `<span class="badge tag">${esc(t)}</span>`).join('')}${p.auto ? '<span class="badge tag">auto-detected</span>' : ''}
        </div>
        <div class="chips">${p.stems.map((x) => `<span class="chip" style="--c:${esc(x.color)}" title="${esc(x.role)} · ${x.bars} bars · ${x.kind === 'file' ? 'audio file' : 'generated'}">${esc(x.name)}</span>`).join('')}</div>
        ${p.groups && p.groups.length ? `<div class="groups">${p.groups.map((g) => `<div class="grule"><b>${esc(g.name)}</b> <span>${p.stems.filter((x) => x.group === g.id).map((x) => esc(x.name)).join(', ')}</span><div>${g.badges.length ? g.badges.map((b) => `<span class="badge tag">${esc(b)}</span>`).join('') : '<span class="badge tag">no limits</span>'}</div></div>`).join('')}</div>` : ''}
        ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <footer>
          <span class="lic">${esc(p.license)}${src}${credits}</span>
          <button class="use" data-use="${esc(p.id)}" data-reload="${isActive ? 1 : 0}" ${p.playable ? '' : 'disabled'}>${!p.playable ? 'Unavailable' : isActive ? 'Reload' : 'Use this pack'}</button>
        </footer>
      </article>`;
    }).join('') || '<p class="muted">No packs found. Add a folder to packs/.</p>';
    $('#packList').querySelectorAll('.use').forEach((b) => b.addEventListener('click', () => {
      send({ type: 'pack', id: b.dataset.use, reload: b.dataset.reload === '1' });
      closePacks();
    }));
  }

  // ---------------- Kits ----------------
  let kitData = null;
  const kitNameOf = (id, role) => { const r = kitData && kitData.roles[role]; const x = r && r.sets.find((q) => q.id === id); return x ? x.name : (id || 'pack default'); };
  function kitBar() { /* the button in the effect column: the live kit's name, and a pulse while a swap is waiting */
    const b = $('#kitBtn'); if (!b) return;
    const k = cfg && cfg.pack && cfg.pack.kit;
    b.textContent = kitPendingNow ? 'Changing…' : k ? 'Favorite: ' + k.name : 'Kit · Templates…'; b.classList.toggle('busy', !!kitPendingNow);
  }
  let kitPendingNow = null;
  async function loadKits() {
    try { kitData = await (await fetch('/api/kits', { cache: 'no-store' })).json(); renderKits(); }
    catch (e) { $('#kitBody').innerHTML = `<p class="muted">Couldn't load the kits: ${esc(e.message)}</p>`; }
  }
  function renderKits() {
    const d = kitData, cur = d.current || {}, picks = cur.picks || {};
    if (!d.canKit) { $('#kitBody').innerHTML = `<p class="muted">Favorites swap the Melodic and Rhythmic groups, and the live pack has no such groups. Use a pack like “Layers” first.</p>`; return; }
    const sk = d.soundKits || [], slots = d.slots || [];
    const voiceName = (slot, v) => { const s = slots.find((x) => x.id === slot), q = s && s.voices.find((x) => x.id === v); return q ? q.name : (v || '—'); };
    const kitLine = (k) => slots.map((s) => `<span class="kv"><b>${esc(s.name)}</b> ${esc(voiceName(s.id, k.voices[s.id]))}</span>`).join('');
    const opts = (role) => {
      const r = d.roles[role];
      return `<option value="">Pack's own (${r.slots} stems)</option>` + r.sets.map((x) => `<option value="${esc(x.id)}" ${x.ok ? '' : 'disabled'} ${picks[role] === x.id ? 'selected' : ''}>${esc(x.name)}${x.ok ? '' : ' — ' + esc(x.reason)}</option>`).join('');
    };
    const setsLine = (role, id) => { const x = d.roles[role].sets.find((q) => q.id === id); return x ? x.stems.map((s) => esc(s.name) + (s.tpl ? ` (${esc(s.tpl)})` : '')).join(' · ') + (x.warnings.length ? '<br>⚠ ' + esc(x.warnings.join('; ')) : '') : 'The sounds the pack came with.'; };
    const favKit = (k) => k.kit ? (sk.find((x) => x.id === k.kit) || { name: k.kit }).name : null;
    $('#kitBody').innerHTML = `
      <section><h3>1 · Kit — the sound</h3>
        <label class="kitone"><select id="kitSound"><option value="">None: the template's own sounds</option>${sk.map((k) => `<option value="${esc(k.id)}" ${picks.kit === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>
        <div class="kitvoices" id="kitVoices"></div>
        <details class="kitedit"><summary>Make or change a kit</summary>
          <p class="muted" style="margin:6px 0">A kit gives each role a voice. Any template can be played with any kit. Kits that use recordings are folders in <code>soundkits/</code> (see the manual).</p>
          <div class="kitgrid" id="kitGrid">${slots.map((s) => `<label><span class="label">${esc(s.name)}</span><select data-slot="${esc(s.id)}">${s.voices.filter((v) => v.id !== 'sample').map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>`).join('')}</div>
          <div class="kitsave" style="margin-top:8px"><input id="skName" type="text" maxlength="60" placeholder="Kit name"><button id="skSave">Save kit</button></div>
        </details>
      </section>
      <section><h3>2 · Templates — the notes</h3>
        <div class="kitpick">
          <label><span class="label">Melodic template</span><select id="kitMel">${opts('melodic')}</select><span class="kitsets" id="kitMelSets"></span></label>
          <label><span class="label">Rhythmic template</span><select id="kitRhy">${opts('rhythmic')}</select><span class="kitsets" id="kitRhySets"></span></label>
        </div>
        <p class="muted" style="margin:8px 0 0;font-size:12px">The template decides the chords and which notes play. The kit decides what they sound like: Melody A and Melody B can play any melody.</p>
        <div style="margin-top:10px"><button id="kitLoad">Load kit + templates</button></div>
      </section>
      <section><h3>3 · Favorites</h3>${d.kits.length ? d.kits.map((k) => `<div class="kit${cur.kit === k.id ? ' active' : ''}">
        <div><b>${esc(k.name)}</b><small>${esc(k.description || '')}${k.description ? '<br>' : ''}${favKit(k) ? 'Kit: ' + esc(favKit(k)) + ' · ' : ''}Melodic: ${esc(kitNameOf(k.melodic, 'melodic'))} · Rhythmic: ${esc(kitNameOf(k.rhythmic, 'rhythmic'))}${k.micro ? ' · with Microcosm settings' : ''}</small></div>
        <div class="kitbtns"><button data-kit="${esc(k.id)}">${cur.kit === k.id ? 'Reload' : 'Load'}</button><button class="kitrm" data-rm="${esc(k.id)}" title="Delete this favorite">Remove</button></div></div>`).join('') : '<p class="muted">No favorites yet. Pick a kit and templates above, load them, and save the combination below.</p>'}
        <div class="kitsave" style="margin-top:10px"><input id="kitName" type="text" maxlength="60" placeholder="Favorite name" value="${esc(cfg && cfg.pack && cfg.pack.kit && cfg.pack.kit.name || '')}"><button id="kitSave">Save favorite</button></div>
        <p class="muted" style="margin:6px 0 0;font-size:12px">Saves the kit, both templates that are live, and both Microcosm boxes (presets, knobs, which instruments feed them). Saving with an existing name updates it.</p>
      </section>`;
    const kitNow = () => sk.find((k) => k.id === $('#kitSound').value);
    const upd = () => {
      $('#kitMelSets').innerHTML = setsLine('melodic', $('#kitMel').value); $('#kitRhySets').innerHTML = setsLine('rhythmic', $('#kitRhy').value);
      const k = kitNow(); $('#kitVoices').innerHTML = k ? kitLine(k) + (k.warnings.length ? '<br>⚠ ' + esc(k.warnings.join('; ')) : '') + (k.description ? `<br><span class="muted">${esc(k.description)}</span>` : '') : '<span class="muted">Each template plays with its own sounds.</span>';
      if (k) $('#kitGrid').querySelectorAll('select').forEach((sel) => { if ([...sel.options].some((o) => o.value === k.voices[sel.dataset.slot])) sel.value = k.voices[sel.dataset.slot]; });
      if (k && !$('#skName').value) $('#skName').value = k.editable ? k.name : '';
    };
    $('#kitMel').addEventListener('change', upd); $('#kitRhy').addEventListener('change', upd); $('#kitSound').addEventListener('change', upd); upd();
    $('#skSave').addEventListener('click', () => {
      const name = $('#skName').value.trim(); if (!name) { toast('kit', 'err', 'Give the kit a name first.'); return; }
      const voices = {}; $('#kitGrid').querySelectorAll('select').forEach((sel) => { voices[sel.dataset.slot] = sel.value; });
      send({ type: 'soundKitSave', name, voices }); toast('kit', 'ok', `✓ Saved kit “${name}”`); setTimeout(loadKits, 600);
    });
    $('#kitBody').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { /* two clicks: the second one removes */
      if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Really remove?'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Remove'; }, 3500); return; }
      send({ type: 'kitDelete', id: b.dataset.rm }); toast('kit', 'ok', 'Favorite removed.'); setTimeout(loadKits, 500);
    }));
    $('#kitBody').querySelectorAll('[data-kit]').forEach((b) => b.addEventListener('click', () => { send({ type: 'kit', id: b.dataset.kit }); toast('kit', 'work', 'Favorite requested: the Melodic and Rhythmic sounds are fading out…'); closeKits(); }));
    $('#kitLoad').addEventListener('click', () => { send({ type: 'kit', kit: $('#kitSound').value || null, melodic: $('#kitMel').value || null, rhythmic: $('#kitRhy').value || null, name: 'Custom sounds' }); toast('kit', 'work', 'Requested: the Melodic and Rhythmic sounds are fading out…'); closeKits(); });
    $('#kitSave').addEventListener('click', async () => {
      const name = $('#kitName').value.trim(); if (!name) { toast('kit', 'err', 'Give the favorite a name first.'); return; }
      send({ type: 'kitSave', name, micro: microNow() }); toast('kit', 'ok', `✓ Saved favorite “${name}”`); setTimeout(loadKits, 500);
    });
  }
  const openKits = () => { $('#kits').hidden = false; loadKits(); };
  const closeKits = () => { $('#kits').hidden = true; };

  // ---------------- Wire up ----------------
  $('#key').innerHTML = ResonanceSynth.KEYS.map((k) => `<option>${k}</option>`).join('');
  $('#packBtn').addEventListener('click', () => { window.closeMenu && window.closeMenu(); openPacks(); });
  $('#packsClose').addEventListener('click', closePacks);
  $('#kitBtn').addEventListener('click', openKits); $('#kitsClose').addEventListener('click', closeKits); $('#kitsRescan').addEventListener('click', loadKits);
  $('#kits').addEventListener('pointerdown', (e) => { if (e.target === $('#kits')) closeKits(); });
  $('#packsRescan').addEventListener('click', loadPackList);
  $('#packs').addEventListener('pointerdown', (e) => { if (e.target === $('#packs')) closePacks(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#packs').hidden) closePacks(); if (e.key === 'Escape' && !$('#kits').hidden) closeKits(); });
  $('#startBtn').addEventListener('click', async () => { $('#startBtn').disabled = true; await start(); });
  $('#quantize').addEventListener('change', (e) => { quantize = e.target.value; reportQuantize(); toast('quant', 'ok', `✓ Quantize: ${e.target.selectedOptions[0].textContent}. Taps now land on the next ${quantize === 'bar' ? 'bar line' : quantize === 'half' ? 'half bar' : 'beat'}`); });
  const showFade = () => { $('#fadeInVal').textContent = Number($('#fadeIn').value).toFixed(1) + ' s'; $('#fadeOutVal').textContent = Number($('#fadeOut').value).toFixed(1) + ' s'; };
  $('#fadeIn').addEventListener('input', (e) => { fadeInSec = Number(e.target.value); showFade(); });
  $('#fadeOut').addEventListener('input', (e) => { fadeOutSec = Number(e.target.value); showFade(); });
  $('#vol').addEventListener('input', (e) => master && master.gain.setTargetAtTime(Number(e.target.value), ctx.currentTime, 0.05));
  $('#bright').addEventListener('input', (e) => send({ type: 'param', name: 'brightness', value: Number(e.target.value) }));
  $('#stopAll').addEventListener('click', () => { const n = [...stems.values()].filter((s) => s.voice).length; send({ type: 'stopAll' }); if (n) { pendingStop = true; clearTimeout(stopTimer); stopTimer = setTimeout(() => { if (pendingStop) endStop('Stop finished'); }, 90000); toast('stop', 'work', `Stopping ${n} stem${n > 1 ? 's' : ''}, leaving in order, one group per bar…`); btnState($('#stopAll'), 'Stopping…', 'work'); } else toast('stop', 'ok', '✓ Nothing was playing'); });
  $('#regen').addEventListener('click', async () => { const k = $('#key').value, s0 = seed; key = k; varSeed.clear(); seed = Math.floor(Math.random() * 1e6); if (!(await regenerate(cfg.tempo, 'New variation', $('#regen')))) seed = s0; else saveSettingsSoon(); });
  $('#key').addEventListener('change', async () => { const prev = key; key = $('#key').value; if (!(await regenerate(cfg.tempo, `Key ${key}`, $('#key')))) { key = prev; $('#key').value = prev; } });
  $('#export').addEventListener('click', () => {
    let n = 0; toast('exp', 'work', 'Exporting WAV loops…'); btnState($('#export'), 'Exporting…', 'work');
    for (const st of stems.values()) {
      if (!st.buffer || st.def.file) continue; n++;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(ResonanceSynth.toWav(fullMix(st)));
      a.download = `${String(st.def.id).padStart(2, '0')}_${st.def.name.toLowerCase()}_${cfg.tempo}bpm_${key}_${st.def.bars}bars.wav`;
      a.click();
    }
    toast('exp', n ? 'ok' : 'err', n ? `✓ Exported ${n} WAV loop${n > 1 ? 's' : ''} (check your Downloads folder)` : 'Nothing to export: no generated stems loaded'); btnState($('#export'), n ? '✓ Exported' : 'Nothing to export', n ? 'ok' : 'err');
  });

  /* the exported loop of a stem with complexity layers is the full mix: base plus both layers at full */
  function fullMix(st) {
    if (!st.layers || !st.layers.length) return st.buffer;
    const out = new AudioBuffer({ length: st.buffer.length, numberOfChannels: 2, sampleRate: st.buffer.sampleRate });
    for (let ch = 0; ch < 2; ch++) { const d = out.getChannelData(ch); for (const b of [st.buffer, ...st.layers]) { const a = b.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] += a[i]; } }
    return out;
  }

  // Expose a tiny debug surface (used by automated tests).
  window.__engine = { get ctx() { return ctx; }, get slots() { return slots; }, get micro() { return slots.a && slots.a.micro; }, get t0() { return t0; }, stems, xyState, varSeed, settingsNow, beatLen, barLen, nextBoundary, get cfg() { return cfg; } };
  connect();
})();

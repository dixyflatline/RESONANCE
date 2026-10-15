// RESONANCE PoC: per-stem controller (shared by the audience client and the engine page).
//   The pad:   X (left → right) = complexity, from a sparse part to a dense one (melodic and rhythmic layers only)
//              Y (bottom → top) = filter cutoff, 60 Hz → 20 kHz (log scale)
//   The fader: a separate vertical bar at the side = volume; 0.8 = the stem's configured level, 1.0 = +3.9 dB, 0 = silent
// Double-tap the pad or the fader to reset it.
// Complexity is built into the music: generated melodic and rhythmic stems are rendered as a base loop and two layers that add notes
// (see renderStem in synth.js). The engine fades the layers in and out as X moves; layerGain() is that curve.

(() => {
  const XY_DEFAULT = { x: 0.6, y: 1, v: 0.8 };
  const cutoffHz = (y) => 60 * Math.pow(20000 / 60, y);
  const volume = (v) => Math.pow(v / 0.8, 2);
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  /* gain of extra layer k (0 = first extra, 1 = second) at complexity x: the base is always on, layer 1 joins from 15% to 45%, layer 2 from 50% to 90% */
  const layerGain = (x, k) => (k === 0 ? smooth(0.15, 0.45, x) : smooth(0.5, 0.9, x));
  const fmtHz = (hz) => (hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 0 : 1) + ' kHz' : Math.round(hz) + ' Hz');
  const fmtDb = (g) => (g <= 0.0001 ? '−∞ dB' : (g >= 1 ? '+' : '') + (20 * Math.log10(g)).toFixed(1) + ' dB');
  const fmtCx = (x) => (x < 0.12 ? 'Sparse' : x < 0.4 ? 'Light' : x < 0.65 ? 'Medium' : x < 0.88 ? 'Busy' : 'Dense');
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  const css = `
  .xy-overlay{position:fixed;inset:0;z-index:1000;background:rgba(6,8,14,.82);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px}
  .xy-overlay[hidden]{display:none}
  .xy-sheet{width:min(560px,100%);max-height:100%;background:#11152a;border:1px solid #232a40;border-radius:20px;padding:16px;display:flex;flex-direction:column;gap:12px;color:#e6e9f2;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
  .xy-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .xy-head > div:last-child{display:flex;gap:6px;flex:none}
  .xy-title{font-size:20px;font-weight:650}
  .xy-title small{display:block;font-size:12px;color:#8a93ad;font-weight:400}
  .xy-btn{font:inherit;color:#e6e9f2;background:#1b2136;border:1px solid #2c3552;border-radius:10px;padding:8px 12px;cursor:pointer}
  .xy-btn.close{min-width:40px;font-size:18px;line-height:1;padding:7px 12px}
  .xy-btn.on{background:var(--c);border-color:var(--c);color:#0a0c14;font-weight:600}
  .xy-body{display:flex;gap:12px;align-items:stretch;min-height:0}
  .xy-area{flex:1;min-width:0}
  .xy-pad{position:relative;width:100%;aspect-ratio:1;border-radius:16px;touch-action:none;user-select:none;-webkit-user-select:none;cursor:crosshair;overflow:hidden;
    background:linear-gradient(to top, rgba(0,0,0,.5), transparent 70%), color-mix(in srgb, var(--c) 10%, #0b0e1a);
    border:1px solid color-mix(in srgb, var(--c) 50%, transparent)}
  .xy-pad canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .xy-pad .ch{position:absolute;background:color-mix(in srgb, var(--c) 60%, transparent);pointer-events:none}
  .xy-pad .ch.h{left:0;right:0;height:1px}.xy-pad .ch.v{top:0;bottom:0;width:1px}
  .xy-pad .dot{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:var(--c);box-shadow:0 0 24px var(--c);border:2px solid #fff;pointer-events:none}
  .xy-pad .ax{position:absolute;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.55);pointer-events:none}
  .xy-wrap{position:relative;flex:1;min-width:0}
  /* phone sheet: more room, a big on/off switch, a ? button, and the explanation card that sits over the pad */
  .xy-overlay.compact{padding:10px}.xy-overlay.compact .xy-sheet{padding:12px;gap:10px}.xy-overlay.compact .xy-fader{width:52px}.xy-overlay.compact .xy-body{gap:10px}
  .xy-overlay.compact .xy-pad{aspect-ratio:3/4}
  .xy-btn.help{min-width:40px;height:44px;font-size:19px;font-weight:700;line-height:1;padding:0 12px;border-radius:22px}
  .xy-btn.close{height:44px}
  .xy-btn.vote{height:44px;font-size:16px;font-weight:700;padding:0 20px;border-radius:22px;background:#1b2136;border:2px solid var(--c);color:var(--c);white-space:nowrap}
  .xy-btn.vote.on{background:var(--c);color:#0a0c14}
  .xy-switch{position:relative;width:92px;height:44px;flex:none;border-radius:22px;border:2px solid #3a4468;background:#1b2136;cursor:pointer;padding:0;transition:background .2s,border-color .2s;font:inherit}
  .xy-switch .lbl{position:absolute;top:0;bottom:0;display:flex;align-items:center;font-size:14px;font-weight:800;letter-spacing:.08em;transition:all .2s}
  .xy-switch .lbl{right:14px;color:#8a93ad}
  .xy-switch i{position:absolute;top:3px;left:3px;width:34px;height:34px;border-radius:50%;background:#e6e9f2;box-shadow:0 2px 6px rgba(0,0,0,.5);transition:left .2s}
  .xy-switch[aria-checked=true]{background:var(--c);border-color:var(--c)}
  .xy-switch[aria-checked=true] .lbl{right:auto;left:14px;color:#0a0c14}
  .xy-switch[aria-checked=true] i{left:51px;background:#fff}
  .xy-note{font-size:13px;color:var(--c);font-weight:650;margin-top:-4px}
  .xy-note.wait::before{content:'';display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:var(--c);animation:xypulse 1s ease-in-out infinite}
  .xy-switch.busy,.xy-btn.vote.busy{animation:xyglow 1s ease-in-out infinite}
  @keyframes xypulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
  @keyframes xyglow{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb, var(--c) 0%, transparent)}50%{box-shadow:0 0 0 5px color-mix(in srgb, var(--c) 45%, transparent)}}
  .xy-help{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;border-radius:16px;padding:12px 14px 14px;background:rgba(9,12,22,.97);border:1px solid color-mix(in srgb, var(--c) 65%, transparent);font-size:13px;line-height:1.4;color:#e6e9f2;box-shadow:0 0 30px rgba(0,0,0,.6)}
  .xy-help.show{display:flex}
  .xy-help .hbody{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch}
  .xy-help .hh{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .xy-help .hh b{font-size:15px}
  .xy-help .hx{font:inherit;font-size:20px;line-height:1;width:36px;height:36px;border-radius:18px;border:1px solid #2c3552;background:#1b2136;color:#e6e9f2;cursor:pointer;padding:0}
  .xy-help h4{margin:8px 0 2px;font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:color-mix(in srgb, var(--c) 70%, #fff)}
  .xy-help p{margin:0}
  .xy-help .gotit{display:block;width:100%;flex:none;margin-top:10px;font:inherit;font-weight:650;padding:11px;border-radius:12px;border:0;background:var(--c);color:#0a0c14;cursor:pointer}
  .xy-sheet.nofader .xy-fad,.xy-sheet.nopad .xy-read{display:none}
  .xy-sheet.nopad .xy-area{display:none}
  .xy-sheet.nopad:not(.nofader) .xy-help{min-height:270px}
  .xy-sheet.nopad .xy-help{position:relative;display:block;inset:auto;box-shadow:none}
  .xy-sheet.nopad .xy-help .hbody{overflow:visible}
  .xy-sheet.nopad .xy-help .hx,.xy-sheet.nopad .xy-help .gotit,.xy-sheet.nopad .xy-help .hh{display:none}
  .xy-pad.locked{cursor:ns-resize}
  .xy-pad.locked .ch.v{display:none}
  .xy-pad .nox{position:absolute;left:0;right:0;bottom:10px;text-align:center;font-size:11px;letter-spacing:.06em;color:rgba(255,255,255,.45);pointer-events:none}
  .xy-fader{width:64px;flex:none;display:flex;flex-direction:column;align-items:center;gap:6px;color:#8a93ad;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
  .xy-fader .trk{position:relative;flex:1;width:100%;border-radius:16px;touch-action:none;user-select:none;-webkit-user-select:none;cursor:ns-resize;overflow:hidden;
    background:color-mix(in srgb, var(--c) 8%, #0b0e1a);border:1px solid color-mix(in srgb, var(--c) 50%, transparent)}
  .xy-fader .fill{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(to top, color-mix(in srgb, var(--c) 30%, #0b0e1a), color-mix(in srgb, var(--c) 75%, #0b0e1a));pointer-events:none}
  .xy-fader .thumb{position:absolute;left:6px;right:6px;height:10px;margin-top:-5px;border-radius:5px;background:#fff;box-shadow:0 0 12px var(--c);pointer-events:none}
  .xy-fader .ticks{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.08) 1px,transparent 1px);background-size:100% 12.5%;pointer-events:none}
  .xy-fader b{color:#e6e9f2;font-weight:600;font-size:12px;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;white-space:nowrap}
  .xy-read{display:flex;justify-content:space-between;gap:8px;color:#8a93ad;font-variant-numeric:tabular-nums;flex-wrap:wrap}
  .xy-read b{color:#e6e9f2;font-weight:600}
  .xy-mini{position:absolute;right:10px;bottom:10px;width:34px;height:34px;border-radius:8px;border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.25);cursor:pointer;padding:0}
  .xy-mini i{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#fff}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  /* The pad: a dot matrix whose lit part grows from the bottom-left corner to the handle (further right = more complexity,
     higher = more open). Without complexity the handle only moves up and down. */
  function makePad(el, { onChange }) {
    const P = 18; // handle radius + border
    el.classList.add('xy-pad');
    el.innerHTML = '<canvas></canvas><div class="ch h"></div><div class="ch v"></div><div class="dot"></div>' +
      '<span class="ax" style="left:10px;top:8px">Cutoff ↑</span><span class="ax" style="left:10px;bottom:8px">Sparse</span><span class="ax" style="right:10px;bottom:8px">Dense →</span><span class="nox" hidden>no complexity on this part</span>';
    const cv = el.querySelector('canvas'), dot = el.querySelector('.dot'), h = el.querySelector('.h'), v = el.querySelector('.v'), nox = el.querySelector('.nox');
    const axes = [...el.querySelectorAll('.ax')];
    let x = XY_DEFAULT.x, y = XY_DEFAULT.y, dragging = false, lastTap = 0, locked = false;
    const COLS = 16, ROWS = 16;
    function paint() {
      const r = el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (!r.width) return;
      if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
      g.fillStyle = getComputedStyle(el).getPropertyValue('--c').trim() || '#888';
      const px = locked ? 0.5 : x;
      for (let c = 0; c < COLS; c++) for (let q = 0; q < ROWS; q++) {
        const cx = (c + 0.5) / COLS, cy = (q + 0.5) / ROWS;
        const lit = (locked || cx <= px + 0.5 / COLS) && cy <= y + 0.5 / ROWS;
        g.globalAlpha = lit ? 0.35 + 0.5 * cy : 0.09;
        g.beginPath(); g.arc(cx * r.width, (1 - cy) * r.height, lit ? 3 : 2, 0, 6.2832); g.fill();
      }
      g.globalAlpha = 1;
    }
    function draw() {
      const hx = locked ? 0.5 : x;
      const pxs = `calc(${P}px + (100% - ${2 * P}px) * ${hx})`, pys = `calc(${P}px + (100% - ${2 * P}px) * ${1 - y})`;
      dot.style.left = pxs; dot.style.top = pys; v.style.left = pxs; h.style.top = pys;
      paint();
    }
    function fromEvent(e) {
      const r = el.getBoundingClientRect();
      if (!locked) x = clamp01((e.clientX - r.left - P) / (r.width - 2 * P));
      y = clamp01(1 - (e.clientY - r.top - P) / (r.height - 2 * P));
      draw(); onChange(x, y);
    }
    el.addEventListener('pointerdown', (e) => {
      const now = performance.now();
      if (now - lastTap < 300) { x = XY_DEFAULT.x; y = XY_DEFAULT.y; draw(); onChange(x, y); lastTap = 0; return; }
      lastTap = now; dragging = true; el.setPointerCapture(e.pointerId); fromEvent(e);
    });
    el.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
    const end = () => { dragging = false; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    if (window.ResizeObserver) new ResizeObserver(() => paint()).observe(el);
    draw();
    return {
      set(nx, ny) { if (dragging) return; x = nx; y = ny; draw(); },
      setLocked(on) { locked = !!on; el.classList.toggle('locked', locked); nox.hidden = !locked; axes[1].hidden = axes[2].hidden = locked; draw(); },
      get dragging() { return dragging; },
    };
  }

  /* The volume fader: a vertical bar, full at the top. */
  function makeFader(el, { onChange }) {
    el.classList.add('xy-fader');
    el.innerHTML = '<span>Vol</span><div class="trk"><div class="ticks"></div><div class="fill"></div><div class="thumb"></div></div><b class="vv"></b>';
    const trk = el.querySelector('.trk'), fill = el.querySelector('.fill'), thumb = el.querySelector('.thumb'), vv = el.querySelector('.vv');
    let val = XY_DEFAULT.v, dragging = false, lastTap = 0;
    function draw() { fill.style.height = val * 100 + '%'; thumb.style.top = (1 - val) * 100 + '%'; vv.textContent = fmtDb(volume(val)); }
    function fromEvent(e) { const r = trk.getBoundingClientRect(); val = clamp01(1 - (e.clientY - r.top) / r.height); draw(); onChange(val); }
    trk.addEventListener('pointerdown', (e) => {
      const now = performance.now();
      if (now - lastTap < 300) { val = XY_DEFAULT.v; draw(); onChange(val); lastTap = 0; return; }
      lastTap = now; dragging = true; trk.setPointerCapture(e.pointerId); fromEvent(e);
    });
    trk.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
    const end = () => { dragging = false; };
    trk.addEventListener('pointerup', end); trk.addEventListener('pointercancel', end);
    draw();
    return { set(nv) { if (dragging) return; val = nv; draw(); }, get dragging() { return dragging; } };
  }

  // One shared modal sheet. open(stem, xy, isOn) shows the pad and fader for that stem; stem.complexity says whether X does anything.
  // opts: { send(msg), onToggle(id), onLocal(id, {x, y, v}), closeLabel (e.g. '×'; default 'Done') }
  function createSheet(opts) {
    const ov = document.createElement('div'); ov.className = 'xy-overlay'; ov.hidden = true;
    ov.innerHTML = `<div class="xy-sheet">
      <div class="xy-head"><div class="xy-title"><span class="n"></span><small class="r"></small></div>
        <div><button class="xy-btn help" hidden aria-label="How this works">?</button><button class="xy-btn tog"></button><button class="xy-switch" role="switch" aria-checked="false" aria-label="Play this layer" hidden><span class="lbl">OFF</span><i></i></button><button class="xy-btn vote" hidden>Vote</button><button class="xy-btn close"></button></div></div>
      <div class="xy-note" hidden></div>
      <div class="xy-body"><div class="xy-wrap"><div class="xy-area"></div><div class="xy-help"></div></div><div class="xy-fad"></div></div>
      <div class="xy-read"><span class="rx">Complexity <b class="cx"></b></span><span>Cutoff <b class="cut"></b></span><span>Volume <b class="vol"></b></span></div>
    </div>`;
    document.body.appendChild(ov);
    let stemId = null, hasX = true, pending = null, raf = 0;
    const s = { ...XY_DEFAULT };
    const read = () => {
      ov.querySelector('.cx').textContent = hasX ? `${fmtCx(s.x)} · ${Math.round(s.x * 100)}%` : '—';
      ov.querySelector('.cut').textContent = fmtHz(cutoffHz(s.y));
      ov.querySelector('.vol').textContent = fmtDb(volume(s.v));
    };
    const emit = () => {
      read();
      pending = { type: 'xy', stem: stemId, x: +s.x.toFixed(4), y: +s.y.toFixed(4), v: +s.v.toFixed(4) };
      if (opts.onLocal) opts.onLocal(stemId, { x: s.x, y: s.y, v: s.v });
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pending) opts.send(pending); pending = null; }); // ≤ 1 msg per frame
    };
    const pad = makePad(ov.querySelector('.xy-area'), { onChange(x, y) { s.x = x; s.y = y; emit(); } });
    const fader = makeFader(ov.querySelector('.xy-fad'), { onChange(v) { s.v = v; emit(); } });
    const showHelpOff = () => ov.querySelector('.xy-help').classList.remove('show');
    const closeBtn = ov.querySelector('.close'); closeBtn.textContent = opts.closeLabel || 'Done'; if (opts.closeLabel) closeBtn.setAttribute('aria-label', 'Close'); /* the phone page uses a compact × */
    closeBtn.onclick = () => { showHelpOff(); ov.hidden = true; stemId = null; };
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) { showHelpOff(); ov.hidden = true; stemId = null; } });
    const help = ov.querySelector('.xy-help'), tog = ov.querySelector('.tog'), sw = ov.querySelector('.xy-switch'), voteBtn = ov.querySelector('.vote'), note = ov.querySelector('.xy-note'), qBtn = ov.querySelector('.help');
    let phone = false, isVote = false;
    tog.onclick = sw.onclick = voteBtn.onclick = () => opts.onToggle(stemId);
    /* The explanation: shown on top of the pad the first time anyone opens a pad on this phone (add ?help=1 to the address to see it every time), and again from the ? button. */
    const SEEN = 'resonance.padHelp'; let memSeen = false;
    const seen = () => { if (/[?&]help=1\b/.test(location.search)) return false; try { return localStorage.getItem(SEEN) === '1'; } catch { return memSeen; } };
    const markSeen = () => { memSeen = true; try { localStorage.setItem(SEEN, '1'); } catch { /* private mode: it just shows again next time */ } };
    const showHelp = (on) => { help.classList.toggle('show', !!on); if (on) { { const hb = help.querySelector('.hbody'); if (hb) hb.scrollTop = 0; } markSeen(); } };
    help.addEventListener('click', (e) => { if (e.target.closest('.hx, .gotit')) showHelp(false); });
    qBtn.onclick = () => showHelp(true);
    const apply = (xy) => { Object.assign(s, XY_DEFAULT, xy); pad.set(s.x, s.y); fader.set(s.v); read(); };
    return {
      open(stem, xy, isOn, info) { /* info (phones only): { sound, slide, join, vol, noPad, noFader, vote } plain-language text for the explanation card */
        stemId = stem.id; hasX = !!stem.complexity; phone = !!info; isVote = !!(info && info.vote);
        ov.querySelector('.xy-sheet').style.setProperty('--c', stem.color || '#888');
        ov.querySelector('.n').textContent = stem.name;
        ov.querySelector('.r').textContent = stem.role || '';
        ov.querySelector('.rx').hidden = !hasX;
        ov.classList.toggle('compact', phone); // phones: a little more room
        const noPad = !!(info && info.noPad);
        ov.querySelector('.xy-sheet').classList.toggle('nopad', noPad);
        ov.querySelector('.xy-sheet').classList.toggle('nofader', !!(info && info.noFader));
        tog.hidden = phone; sw.hidden = !phone || isVote; voteBtn.hidden = !isVote; qBtn.hidden = !phone || noPad;
        if (info) {
          const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          const block = (h, t) => (t ? `<h4>${h}</h4><p>${esc(t)}</p>` : '');
          help.innerHTML = '<div class="hh"><b>How this works</b><button class="hx" aria-label="Close the explanation">×</button></div>' +
            '<div class="hbody">' + block('The sound', info.sound) + (noPad ? block('The vote', info.join) + block('Volume', info.vol) : block('Play with it', info.slide) + block('Joining in', info.join)) + '</div><button class="gotit">Got it</button>';
        } else help.innerHTML = '';
        ov.hidden = false; // visible before the pad measures itself
        pad.setLocked(!hasX); apply(xy); this.setOn(isOn);
        showHelp(!!info && (noPad || !seen())); // first time: the card is on top of the pad; the vote layers (gong, nature samples) have no pad: their card is always shown
      },
      close() { showHelpOff(); ov.hidden = true; stemId = null; },
      get stemId() { return stemId; },
      update(id, xy) { if (id === stemId && !pad.dragging && !fader.dragging) apply(xy); },
      /* text: e.g. "1/2 joined" while a vote is pending, or Vote / Struck on the gong's button */
      /* The phone's switch always answers a tap at once. msg = a line under the title that says what is going on ("Starting: waiting for the next bar…",
         "Fading out…", "1/2 joined…"); busy pulses the switch while something is pending. */
      setOn(on, text, msg, busy) {
        if (!phone) { tog.textContent = text || (on ? 'On' : 'Off'); tog.classList.toggle('on', !!on); return; }
        sw.setAttribute('aria-checked', on ? 'true' : 'false'); sw.querySelector('.lbl').textContent = on ? 'ON' : 'OFF';
        voteBtn.textContent = text || 'Vote'; voteBtn.classList.toggle('on', !!on);
        sw.classList.toggle('busy', !!busy); voteBtn.classList.toggle('busy', !!busy);
        note.hidden = !msg; note.textContent = msg || ''; note.classList.toggle('wait', !!busy);
      },
    };
  }

  // Small indicator button showing the current position; click opens the sheet. hasX: the stem has a complexity axis.
  function miniButton(xy, hasX = true) {
    const b = document.createElement('button');
    b.className = 'xy-mini'; b.title = 'Complexity / cutoff / volume'; b.setAttribute('aria-label', 'Complexity, cutoff and volume');
    b.innerHTML = '<i></i>';
    b.setXY = (p) => { const i = b.firstChild; i.style.left = 4 + (hasX ? p.x : 0.5) * 26 + 'px'; i.style.top = 4 + (1 - p.y) * 26 + 'px'; };
    b.setXY(xy || XY_DEFAULT);
    return b;
  }

  window.ResonanceXY = { XY_DEFAULT, cutoffHz, volume, layerGain, fmtHz, fmtDb, fmtCx, makePad, makeFader, createSheet, miniButton };
})();

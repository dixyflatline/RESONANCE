// RESONANCE PoC: per-stem XY controller (shared by the audience client and the engine page).
//   X (left → right) = low-pass filter cutoff, 60 Hz → 20 kHz (log scale)
//   Y (bottom → top) = volume; 0.8 = the stem's configured level, 1.0 = +3.9 dB, 0 = silent
// Double-tap the pad to reset to the default (filter open, normal volume).

(() => {
  const XY_DEFAULT = { x: 1, y: 0.8 };
  const cutoffHz = (x) => 60 * Math.pow(20000 / 60, x);
  const volume = (y) => Math.pow(y / 0.8, 2);
  const fmtHz = (hz) => (hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 0 : 1) + ' kHz' : Math.round(hz) + ' Hz');
  const fmtDb = (g) => (g <= 0.0001 ? '−∞ dB' : (g >= 1 ? '+' : '') + (20 * Math.log10(g)).toFixed(1) + ' dB');

  const css = `
  .xy-overlay{position:fixed;inset:0;z-index:1000;background:rgba(6,8,14,.82);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px}
  .xy-overlay[hidden]{display:none}
  .xy-sheet{width:min(520px,100%);background:#11152a;border:1px solid #232a40;border-radius:20px;padding:16px;display:flex;flex-direction:column;gap:12px;color:#e6e9f2;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
  .xy-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .xy-title{font-size:20px;font-weight:650}
  .xy-title small{display:block;font-size:12px;color:#8a93ad;font-weight:400}
  .xy-btn{font:inherit;color:#e6e9f2;background:#1b2136;border:1px solid #2c3552;border-radius:10px;padding:8px 12px;cursor:pointer}
  .xy-btn.on{background:var(--c);border-color:var(--c);color:#0a0c14;font-weight:600}
  .xy-pad{position:relative;width:100%;aspect-ratio:1;border-radius:16px;touch-action:none;user-select:none;cursor:crosshair;overflow:hidden;
    background:linear-gradient(to top, rgba(0,0,0,.55), transparent), linear-gradient(to right, #0b0e1a, color-mix(in srgb, var(--c) 35%, #0b0e1a));
    border:1px solid color-mix(in srgb, var(--c) 50%, transparent)}
  .xy-pad .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px);background-size:25% 25%}
  .xy-pad .ch{position:absolute;background:color-mix(in srgb, var(--c) 60%, transparent)}
  .xy-pad .ch.h{left:0;right:0;height:1px}.xy-pad .ch.v{top:0;bottom:0;width:1px}
  .xy-pad .dot{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:var(--c);box-shadow:0 0 24px var(--c);border:2px solid #fff}
  .xy-pad .ax{position:absolute;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.55);pointer-events:none}
  .xy-read{display:flex;justify-content:space-between;color:#8a93ad;font-variant-numeric:tabular-nums}
  .xy-read b{color:#e6e9f2;font-weight:600}
  .xy-mini{position:absolute;right:10px;bottom:10px;width:34px;height:34px;border-radius:8px;border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.25);cursor:pointer;padding:0}
  .xy-mini i{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#fff}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // Build an interactive pad inside `el`. onChange(x, y) fires while dragging.
  function makePad(el, { onChange }) {
    const P = 18; // handle radius + border
    el.classList.add('xy-pad');
    el.innerHTML = '<div class="grid"></div><div class="ch h"></div><div class="ch v"></div><div class="dot"></div>' +
      '<span class="ax" style="left:10px;top:8px">Volume ↑</span><span class="ax" style="right:10px;bottom:8px">Filter →</span>';
    const dot = el.querySelector('.dot'), h = el.querySelector('.h'), v = el.querySelector('.v');
    let x = XY_DEFAULT.x, y = XY_DEFAULT.y, dragging = false, lastTap = 0;
    function draw() {
      // keep the handle fully inside the pad: usable area is inset by the handle radius
      const px = `calc(${P}px + (100% - ${2 * P}px) * ${x})`, py = `calc(${P}px + (100% - ${2 * P}px) * ${1 - y})`;
      dot.style.left = px; dot.style.top = py; v.style.left = px; h.style.top = py;
    }
    function fromEvent(e) {
      const r = el.getBoundingClientRect();
      x = Math.max(0, Math.min(1, (e.clientX - r.left - P) / (r.width - 2 * P)));
      y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top - P) / (r.height - 2 * P)));
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
    draw();
    return { set(nx, ny) { if (dragging) return; x = nx; y = ny; draw(); }, get dragging() { return dragging; } };
  }

  // One shared modal sheet. open(stem, xy, isOn) shows the XY pad for that stem.
  // opts: { send(msg), onToggle(id) }
  function createSheet(opts) {
    const ov = document.createElement('div'); ov.className = 'xy-overlay'; ov.hidden = true;
    ov.innerHTML = `<div class="xy-sheet">
      <div class="xy-head"><div class="xy-title"><span class="n"></span><small class="r"></small></div>
        <div><button class="xy-btn tog"></button> <button class="xy-btn close">Done</button></div></div>
      <div class="xy-area"></div>
      <div class="xy-read"><span>Volume <b class="vol"></b></span><span>Cutoff <b class="cut"></b></span></div>
    </div>`;
    document.body.appendChild(ov);
    let stemId = null, pending = null, raf = 0;
    const read = (x, y) => { ov.querySelector('.vol').textContent = fmtDb(volume(y)); ov.querySelector('.cut').textContent = fmtHz(cutoffHz(x)); };
    const pad = makePad(ov.querySelector('.xy-area'), {
      onChange(x, y) {
        read(x, y);
        pending = { type: 'xy', stem: stemId, x: +x.toFixed(4), y: +y.toFixed(4) };
        if (opts.onLocal) opts.onLocal(stemId, x, y);
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pending) opts.send(pending); pending = null; }); // ≤ 1 msg per frame
      },
    });
    ov.querySelector('.close').onclick = () => { ov.hidden = true; stemId = null; };
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) { ov.hidden = true; stemId = null; } });
    ov.querySelector('.tog').onclick = () => opts.onToggle(stemId);
    return {
      open(stem, xy, isOn) {
        stemId = stem.id;
        ov.querySelector('.xy-sheet').style.setProperty('--c', stem.color || '#888');
        ov.querySelector('.n').textContent = stem.name;
        ov.querySelector('.r').textContent = stem.role || '';
        pad.set(xy.x, xy.y); read(xy.x, xy.y); this.setOn(isOn);
        ov.hidden = false;
      },
      close() { ov.hidden = true; stemId = null; },
      get stemId() { return stemId; },
      update(id, xy) { if (id === stemId) { pad.set(xy.x, xy.y); if (!pad.dragging) read(xy.x, xy.y); } },
      setOn(on) { const b = ov.querySelector('.tog'); b.textContent = on ? 'On' : 'Off'; b.classList.toggle('on', !!on); },
    };
  }

  // Small indicator button showing the current XY position; click opens the sheet.
  function miniButton(xy) {
    const b = document.createElement('button');
    b.className = 'xy-mini'; b.title = 'Volume / filter'; b.setAttribute('aria-label', 'Volume and filter');
    b.innerHTML = '<i></i>';
    b.setXY = (p) => { const i = b.firstChild; i.style.left = 4 + p.x * 26 + 'px'; i.style.top = 4 + (1 - p.y) * 26 + 'px'; };
    b.setXY(xy || XY_DEFAULT);
    return b;
  }

  window.ResonanceXY = { XY_DEFAULT, cutoffHz, volume, fmtHz, fmtDb, makePad, createSheet, miniButton };
})();

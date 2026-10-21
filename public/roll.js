// RESONANCE PoC: the rolling piano roll in a phone's pad sheet.
//   Time runs right to left toward a "now" line. Notes of the layer arrive from the right, so you can see a sound coming before you hear it.
//   A note is [start beat, length in beats, pitch (MIDI; null = a percussive tick), layer 0..2] on the loop of the stem (beats = its length).
//   The layers fade in and out with the pad's X axis (gains), so moving the handle visibly adds and removes notes.
//   draw(canvas, view): view = { notes, beats, pos (the beat now, fractional), bpb, color, gains[3],
//     mode: 'playing' | 'waiting' (on, but not sounding yet) | 'off' | 'idle' (no beat clock: the show is not running), start (beat where it comes in, or null), label }
//   Notes drawn as outlines are not sounding: before the entry line when waiting, or everything when the layer is off.

(() => {
  const PAST = 1.25, AHEAD = 8.75; // beats shown behind and ahead of the now line
  const ranges = new WeakMap();
  function rangeOf(notes) {
    let r = ranges.get(notes);
    if (!r) {
      let lo = 127, hi = 0;
      for (const n of notes) if (n[2] !== null) { lo = Math.min(lo, n[2]); hi = Math.max(hi, n[2]); }
      if (hi < lo) { lo = 48; hi = 72; }
      const span = Math.max(14, hi - lo + 4);
      r = { bottom: (hi + lo) / 2 - span / 2, span }; ranges.set(notes, r);
    }
    return r;
  }

  function draw(cv, v) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const ppb = W / (PAST + AHEAD), xAt = (rel) => (rel + PAST) * ppb, xNow = xAt(0);
    const { notes, beats, pos, bpb, mode } = v, topLane = 10, plotH = H - topLane - 4, rg = rangeOf(notes);
    const yOf = (p) => topLane + plotH * (1 - (p - rg.bottom) / rg.span), nh = Math.max(3, Math.min(10, plotH / rg.span * 0.85));

    // beat and bar lines
    for (let a = Math.ceil(pos - PAST); a <= pos + AHEAD; a++) {
      const isBar = (((a % bpb) + bpb) % bpb) === 0;
      g.fillStyle = isBar ? 'rgba(255,255,255,.17)' : 'rgba(255,255,255,.06)'; g.fillRect(Math.round(xAt(a - pos)), 0, 1, H);
    }

    // notes: the highest layer first, so the base layer sits on top
    const loop = ((pos % beats) + beats) % beats, live = mode === 'playing';
    g.lineWidth = 1;
    for (let k = 2; k >= 0; k--) {
      const gain = v.gains[k]; if (!(gain > 0.03)) continue;
      for (const n of notes) {
        if (n[3] !== k) continue;
        for (let j = -1; j <= 1; j++) {
          const rel = n[0] - loop + j * beats; if (rel + n[1] < -PAST || rel > AHEAD) continue;
          const x = xAt(rel), w = Math.max(3, n[1] * ppb), tick = n[2] === null;
          const y = tick ? 2 : yOf(n[2]) - nh / 2, h = tick ? 4 : nh;
          const ghost = mode === 'off' || mode === 'idle' || (mode === 'waiting' && (v.start == null || pos + rel < v.start - 1e-6));
          const sounding = live && rel <= 0 && rel + n[1] >= 0;
          const past = rel + n[1] < 0 ? 0.35 : 1; // already played: dimmer
          g.globalAlpha = Math.min(1, gain * (ghost ? 0.7 : 1) * past);
          if (ghost) { g.strokeStyle = v.color; g.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1)); continue; }
          g.fillStyle = sounding ? '#fff' : v.color;
          if (sounding) { g.shadowColor = v.color; g.shadowBlur = 10; }
          if (g.roundRect && !tick) { g.beginPath(); g.roundRect(x, y, w, h, 2); g.fill(); } else g.fillRect(x, y, w, h);
          g.shadowBlur = 0;
        }
      }
    }
    g.globalAlpha = 1;

    // the entry line: where a layer that is switched on but not sounding yet comes in
    if (mode === 'waiting' && v.start != null) {
      const x = Math.round(xAt(v.start - pos)) + 0.5;
      if (x > 0 && x < W) {
        g.strokeStyle = v.color; g.lineWidth = 2; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
        g.fillStyle = v.color; g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.fill();
      }
    }
    // the now line
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(Math.round(xNow) - 1, 0, 2, H);
    g.beginPath(); g.moveTo(xNow - 5, 0); g.lineTo(xNow + 5, 0); g.lineTo(xNow, 7); g.fill();
    if (v.label) { g.font = '600 10px system-ui, -apple-system, sans-serif'; g.textBaseline = 'top'; g.fillStyle = 'rgba(255,255,255,.62)'; g.textAlign = 'right'; g.fillText(v.label.toUpperCase(), W - 8, 5); }
  }

  window.ResonanceRoll = { draw, PAST, AHEAD };
})();

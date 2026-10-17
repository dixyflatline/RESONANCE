/* RESONANCE · Microcosm-style effect box
 *
 * A granular "microsampling" effect in the spirit of the Hologram Electronics Microcosm pedal: it listens to whatever goes in, keeps the last
 * 12 seconds, and plays it back as swarms of tiny grains (repeating micro-loops, stutters, clouds, tuned plucks, stepped patterns), with the
 * wet sound feeding back into itself and passing through a tone filter and a reverb. It is a separate box: audio goes in at `input`, and only the
 * WET sound comes out at `output`, so you decide how much of it to mix in.
 *
 *   const fx = await ResonanceMicro.create(audioContext);
 *   source.connect(fx.input); fx.output.connect(destination);        // add the dry signal yourself
 *   fx.setPreset('haze');                                              // see ResonanceMicro.PRESETS
 *   fx.set('activity', 0.7);   // activity, size, repeats, tone, mix   (all 0..1)
 *   fx.setTempo(96);           // the stepped presets (Glitch, Blocks, Pattern, Strum) follow it
 *   fx.setEnabled(false);      // fades the wet sound out and clears the memory
 *
 * Eight presets, in the four families of the pedal: Mosaic and Glitch (micro-loops), Haze and Tunnel (washed clouds), Strum and Blocks
 * (tuned and stepped repeats), Warp and Pattern (morphing pitch and arpeggiated patterns). This is a new implementation, not the pedal's code,
 * and it does not claim to match it exactly.
 */
(function () {
  const WORKLET = `
class MicroGrain extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = Math.floor(sampleRate * 12);
    this.bl = new Float32Array(this.N); this.br = new Float32Array(this.N);
    this.w = 0; this.t = 0; this.grains = [];
    this.cfg = null; this.k = { activity: 0.5, size: 0.5, repeats: 0.5 }; this.tempo = 100;
    this.nextAt = 0; this.cfgAt = 0; this.step = 0; this.slice = 0; this.stutter = 0;
    this.anchor = 0; this.anchorAt = -1e9; this.win = 0; this.burstLeft = 0; this.dir = 1; this.idx = 0;
    this.fbL = 0; this.fbR = 0; this.dcL = 0; this.dcR = 0; this.fbx = 0; this.fby = 0; this.s = 2463534242;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cfg) { this.cfg = m.cfg; this.cfgAt = this.t; this.nextAt = this.t; this.step = 0; this.anchorAt = -1e9; this.win = 0; this.burstLeft = 0; }
      if (m.k) this.k = m.k;
      if (m.tempo) this.tempo = m.tempo;
      if (m.clear) { this.bl.fill(0); this.br.fill(0); this.grains.length = 0; this.fbL = this.fbR = this.dcL = this.dcR = this.fbx = this.fby = 0; }
    };
  }
  rnd() { let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return this.s / 4294967296; }
  rr(a, b) { return a + (b - a) * this.rnd(); }
  pickP(a) { return a[Math.floor(this.rnd() * a.length) % a.length]; }
  pan(spread) { const p = (this.rnd() * 2 - 1) * spread, a = (p + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; }
  add(g) { if (this.grains.length > 48) this.grains.shift(); this.grains.push(g); }
  /* a grain that reads freely from the past: starts 'lag' samples behind the write head */
  free(c, len, semi, lag, gm) {
    const rate = Math.pow(2, semi / 12) * (1 + (this.rnd() - 0.5) * (c.detune || 0));
    const rev = this.rnd() < (c.rev || 0);
    lag = rev ? Math.max(lag, 64) : Math.max(lag, len * (rate - 1) + 64);
    const room = this.N - 2048 - lag; if (len * rate > room) len = room / rate;
    const pn = this.pan(c.spread || 0);
    this.add({ pos0: this.w - lag, win: 0, off: 0, edge: 0, ph: 0, rate, rev, len, age: 0, env: c.env, gl: pn[0] * gm * c.gain, gr: pn[1] * gm * c.gain, vd: c.vib ? c.vib[0] * (0.6 + this.rnd() * 0.8) : 0, vw: c.vib ? 2 * Math.PI * c.vib[1] * (0.6 + this.rnd() * 0.8) / sampleRate : 0, vp: this.rnd() * 6.28 });
  }
  /* a grain that loops a captured window of the past */
  looped(c, len, semi, anchor, win, off, gm) {
    const rate = Math.pow(2, semi / 12);
    const pn = this.pan(c.spread || 0);
    this.add({ pos0: anchor, win, off, edge: Math.min(win * 0.12, 0.004 * sampleRate), ph: 0, rate, rev: this.rnd() < (c.rev || 0), len, age: 0, env: c.env, gl: pn[0] * gm * c.gain, gr: pn[1] * gm * c.gain, vd: 0, vw: 0, vp: 0 });
  }
  capture(winSamples, recapSamples) {
    if (this.t - this.cfgAt < 8 * sampleRate) recapSamples = Math.min(recapSamples, winSamples); /* just started: the memory is still filling, so take a fresh slice every window */
    if (this.t - this.anchorAt > recapSamples || Math.abs(this.win - winSamples) > 2) {
      this.win = Math.max(256, Math.min(winSamples, this.N - 4096)); this.anchor = this.w - this.win - 64; this.anchorAt = this.t;
    }
  }
  spawn() {
    const c = this.cfg, k = this.k, sr = sampleRate;
    const dens = 0.25 + 1.5 * k.activity, sm = Math.pow(2, (k.size - 0.5) * 3), beat = 60 / this.tempo * sr, ms = sr / 1000;
    const divMul = dens > 1.4 ? 0.5 : dens < 0.6 ? 2 : 1;
    let gap = 0.1 * sr;
    if (c.mode === 'cloud') {
      this.free(c, this.rr(c.size[0], c.size[1]) * sm * ms, this.pickP(c.pitches), this.rr(c.lag[0], c.lag[1]) * ms, 1);
      gap = this.rr(c.interval[0], c.interval[1]) * ms / dens;
    } else if (c.mode === 'loop') {
      this.capture(this.rr(c.loopMs[0], c.loopMs[1]) * sm * ms, c.recapture * sr);
      this.looped(c, this.rr(c.size[0], c.size[1]) * sm * ms, this.pickP(c.pitches), this.anchor, this.win, Math.floor(this.rnd() * this.win), 1);
      gap = this.rr(c.interval[0], c.interval[1]) * ms / dens;
    } else if (c.mode === 'glitch' || c.mode === 'seq') {
      const stepLen = c.div * beat * divMul; gap = stepLen;
      this.capture(c.winBeats * beat, c.recapBeats * beat);
      const sliceLen = Math.floor(this.win / c.slices);
      if (c.mode === 'glitch') {
        if (this.rnd() >= c.drop) {
          if (this.stutter <= 0) { this.slice = Math.floor(this.rnd() * c.slices); this.stutter = 1 + Math.floor(this.rnd() * 3); }
          this.stutter--;
          this.looped(c, stepLen * c.gate, this.pickP(c.pitches), this.anchor + this.slice * sliceLen, sliceLen, 0, 1);
        }
      } else {
        const st = c.steps[this.step++ % c.steps.length];
        if (st.g > 0) this.looped(c, stepLen * c.gate, st.p, this.anchor + (st.s || 0) * sliceLen, sliceLen, 0, st.g);
      }
    } else if (c.mode === 'strum') {
      if (this.burstLeft <= 0) { this.burstLeft = Math.round(this.rr(c.n[0], c.n[1])); this.dir = this.rnd() < 0.55 ? 1 : -1; this.idx = this.dir > 0 ? 0 : c.scale.length - 1; }
      this.free(c, this.rr(c.size[0], c.size[1]) * sm * ms, c.scale[this.idx], this.rr(c.lag[0], c.lag[1]) * ms, 0.85 + this.rnd() * 0.3);
      this.idx = (this.idx + this.dir + c.scale.length) % c.scale.length; this.burstLeft--;
      gap = this.burstLeft > 0 ? c.spacing * ms / Math.sqrt(dens) : c.every * beat * (0.7 + this.rnd() * 0.6) / dens;
    }
    this.nextAt = this.t + Math.max(8, gap);
  }
  envAt(g, p) {
    switch (g.env) {
      case 'gate': { const r = 0.003 * sampleRate, a = g.age, b = g.len - g.age; return Math.min(1, a / r, b / r); }
      case 'pluck': return Math.min(1, g.age / (0.002 * sampleRate)) * Math.exp(-5 * p);
      case 'rise': return Math.sin(Math.PI * Math.pow(p, 1.7));
      default: { const s = Math.sin(Math.PI * p); return s * s; }
    }
  }
  process(inputs, outputs) {
    const out = outputs[0], inp = inputs[0], N = this.N, bl = this.bl, br = this.br;
    const oL = out[0], oR = out[1] || out[0];
    const c = this.cfg;
    for (let i = 0; i < oL.length; i++) {
      const xl = inp[0] ? inp[0][i] : 0, xr = inp[1] ? inp[1][i] : xl;
      let wl = 0, wr = 0;
      if (c) {
        if (this.t >= this.nextAt) this.spawn();
        const gs = this.grains;
        for (let j = gs.length - 1; j >= 0; j--) {
          const g = gs[j];
          if (g.age >= g.len) { gs[j] = gs[gs.length - 1]; gs.pop(); continue; }
          let idx, fade = 1;
          if (g.win) {
            let x = (g.off + g.ph) % g.win; if (g.rev) x = g.win - 1 - x;
            idx = g.pos0 + x;
            if (g.edge) fade = Math.min(1, x / g.edge, (g.win - 1 - x) / g.edge);
          } else idx = g.rev ? g.pos0 - g.ph : g.pos0 + g.ph;
          idx %= N; if (idx < 0) idx += N;
          const i0 = idx | 0, fr = idx - i0, i1 = i0 + 1 === N ? 0 : i0 + 1;
          const e = this.envAt(g, g.age / g.len) * fade;
          wl += (bl[i0] + (bl[i1] - bl[i0]) * fr) * e * g.gl;
          wr += (br[i0] + (br[i1] - br[i0]) * fr) * e * g.gr;
          g.ph += g.vd ? g.rate * (1 + g.vd * Math.sin(g.vp += g.vw)) : g.rate; g.age++;
        }
      }
      wl = Math.tanh(wl); wr = Math.tanh(wr);
      /* feedback: the wet sound goes back into the memory, with a DC blocker and a soft clip so it can never run away */
      const fb = c ? c.fbMax * this.k.repeats : 0;
      const yl = wl - this.fbx + 0.995 * this.fbL, yr = wr - this.fby + 0.995 * this.fbR; this.fbx = wl; this.fby = wr; this.fbL = yl; this.fbR = yr;
      bl[this.w] = xl + Math.tanh(yl * fb); br[this.w] = xr + Math.tanh(yr * fb);
      this.w = this.w + 1 === N ? 0 : this.w + 1; this.t++;
      oL[i] = wl; oR[i] = wr;
    }
    return true;
  }
}
registerProcessor('micro-grain', MicroGrain);
`;

  const sc = (a) => a; // (readability: the lists below are semitones)
  /* Each preset: dsp = what the grain engine does; fbMax = most feedback (at Repeats = 1); verb = reverb amount; def = where the five knobs start. */
  const PRESETS = {
    mosaic: {
      label: 'Mosaic', family: 'Mosaic', blurb: 'A tiny slice of what you play loops over and over in layers, some an octave up or down.',
      dsp: { mode: 'loop', loopMs: [110, 260], size: [170, 320], interval: [45, 95], recapture: 2.2, pitches: sc([0, 0, 0, 12, 7, -12, 5, -5]), rev: 0.08, spread: 0.75, env: 'hann', gain: 0.7 },
      fbMax: 0.8, verb: 0.3, def: { activity: 0.5, size: 0.5, repeats: 0.45, tone: 0.75, mix: 0.5 },
    },
    glitch: {
      label: 'Glitch', family: 'Mosaic', blurb: 'The sound stutters in time with the tempo: chopped slices repeat, skip and flip backwards.',
      dsp: { mode: 'glitch', winBeats: 2, recapBeats: 4, slices: 8, div: 0.25, gate: 0.9, drop: 0.2, pitches: sc([0, 0, 0, 0, 12, -12, 7]), rev: 0.22, spread: 0.85, env: 'gate', gain: 1.0 },
      fbMax: 0.55, verb: 0.15, def: { activity: 0.5, size: 0.5, repeats: 0.3, tone: 0.85, mix: 0.5 },
    },
    haze: {
      label: 'Haze', family: 'Haze', blurb: 'A dense, soft cloud of overlapping grains: the sound melts into a shimmering wash.',
      dsp: { mode: 'cloud', size: [260, 560], interval: [14, 34], lag: [120, 1600], pitches: sc([0, 0, 12, 7, -12, 12, 19]), rev: 0.12, detune: 0.012, spread: 1, env: 'hann', gain: 0.35 },
      fbMax: 0.85, verb: 0.75, def: { activity: 0.55, size: 0.5, repeats: 0.55, tone: 0.55, mix: 0.55 },
    },
    tunnel: {
      label: 'Tunnel', family: 'Haze', blurb: 'Long, dark, swelling grains and backwards echoes that stretch the sound into a tunnel.',
      dsp: { mode: 'cloud', size: [520, 1100], interval: [90, 190], lag: [300, 3500], pitches: sc([0, 0, -12, 12, 7, 0]), rev: 0.4, detune: 0.01, spread: 1, env: 'rise', gain: 0.55 },
      fbMax: 0.88, verb: 1.0, def: { activity: 0.5, size: 0.55, repeats: 0.6, tone: 0.35, mix: 0.6 },
    },
    strum: {
      label: 'Strum', family: 'Strum', blurb: 'The sound is plucked back as a harp: fast tuned strums run up and down a minor pentatonic scale.',
      dsp: { mode: 'strum', n: [4, 7], spacing: 55, every: 2, size: [450, 950], lag: [60, 700], scale: sc([-12, -5, 0, 3, 7, 10, 12, 15]), detune: 0.003, spread: 0.8, env: 'pluck', gain: 1.7 },
      fbMax: 0.55, verb: 0.5, def: { activity: 0.5, size: 0.5, repeats: 0.35, tone: 0.7, mix: 0.5 },
    },
    blocks: {
      label: 'Blocks', family: 'Strum', blurb: 'The last bar is cut into chunks and replayed in a stepped, shuffled order, like chunky building blocks.',
      dsp: { mode: 'seq', winBeats: 4, recapBeats: 8, slices: 8, div: 0.5, gate: 0.95,
        steps: [{ s: 0, p: 0, g: 1 }, { s: 0, p: 0, g: 0.7 }, { s: 2, p: 0, g: 0.9 }, { s: 3, p: -5, g: 0.8 }, { s: 7, p: 0, g: 0.9 }, { s: 5, p: 7, g: 0.7 }, { s: 2, p: 0, g: 0 }, { s: 6, p: 12, g: 0.7 }],
        rev: 0.1, spread: 0.7, env: 'gate', gain: 1.4 },
      fbMax: 0.55, verb: 0.2, def: { activity: 0.5, size: 0.5, repeats: 0.3, tone: 0.7, mix: 0.55 },
    },
    warp: {
      label: 'Warp', family: 'Warp', blurb: 'Slow, wobbling pitch-bends, like a tape machine melting: the sound drifts and sways.',
      dsp: { mode: 'cloud', size: [1300, 2300], interval: [420, 820], lag: [300, 1000], pitches: sc([0, 0, 0, -12, 7]), vib: [0.045, 0.35], rev: 0.0, detune: 0.03, spread: 0.7, env: 'hann', gain: 0.95 },
      fbMax: 0.8, verb: 0.55, def: { activity: 0.5, size: 0.5, repeats: 0.5, tone: 0.6, mix: 0.55 },
    },
    pattern: {
      label: 'Pattern', family: 'Warp', blurb: 'A tiny loop is played as a tuned 16th-note pattern, an automatic arpeggio made from your own sound.',
      dsp: { mode: 'seq', winBeats: 0.5, recapBeats: 2, slices: 1, div: 0.25, gate: 0.85,
        steps: [0, 7, 12, 7, 3, 10, 15, 12].map((p, i) => ({ s: 0, p, g: i % 4 === 0 ? 1 : 0.75 })),
        rev: 0, spread: 0.9, env: 'pluck', gain: 2.6 },
      fbMax: 0.55, verb: 0.4, def: { activity: 0.5, size: 0.5, repeats: 0.3, tone: 0.75, mix: 0.5 },
    },
  };
  const ORDER = ['mosaic', 'glitch', 'haze', 'tunnel', 'strum', 'blocks', 'warp', 'pattern'];

  function impulse(ctx, sec) { /* a stereo noise-burst reverb tail: dark and smooth, brighter early on */
    const len = Math.floor(ctx.sampleRate * sec), buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let lp = 0, s = 1234567 + ch * 7919;
      for (let i = 0; i < len; i++) {
        s = (s * 1664525 + 1013904223) >>> 0; const n = (s / 4294967296) * 2 - 1, t = i / len;
        lp += (n - lp) * (0.55 - 0.45 * Math.min(1, t * 2)); /* the highs die away faster */
        d[i] = lp * Math.pow(1 - t, 2.2) * (i < 800 ? i / 800 : 1);
      }
    }
    return buf;
  }

  async function create(ctx) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const input = ctx.createGain(), output = ctx.createGain();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 130;
    const node = new AudioWorkletNode(ctx, 'micro-grain', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
    const wet = ctx.createGain(); wet.gain.value = 0;
    const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 5); const verbSend = ctx.createGain(), verbOut = ctx.createGain(); verbOut.gain.value = 0.9;
    input.connect(hp).connect(node).connect(lp);
    lp.connect(wet); lp.connect(verbSend).connect(verb).connect(verbOut).connect(wet);
    wet.connect(output);

    const api = { input, output, node, PRESETS, ORDER, preset: 'mosaic', knobs: { ...PRESETS.mosaic.def }, enabled: false, tempo: 100 };
    let clearTimer = 0;
    const apply = () => {
      const k = api.knobs, t = ctx.currentTime, P = PRESETS[api.preset];
      node.port.postMessage({ k: { activity: k.activity, size: k.size, repeats: k.repeats } });
      lp.frequency.setTargetAtTime(Math.min(20000, 400 * Math.pow(2, k.tone * 6)), t, 0.05);
      verbSend.gain.setTargetAtTime(P.verb, t, 0.05);
      wet.gain.setTargetAtTime(api.enabled ? k.mix * 1.4 : 0, t, api.enabled ? 0.05 : 0.15);
    };
    api.setPreset = (name, keepKnobs = false) => {
      if (!PRESETS[name]) return null;
      api.preset = name; if (!keepKnobs) api.knobs = { ...PRESETS[name].def };
      node.port.postMessage({ cfg: { ...PRESETS[name].dsp, fbMax: PRESETS[name].fbMax }, tempo: api.tempo });
      apply(); return { ...api.knobs };
    };
    api.set = (name, v) => { if (name in api.knobs) { api.knobs[name] = Math.max(0, Math.min(1, v)); apply(); } };
    api.setTempo = (bpm) => { if (bpm > 20 && bpm !== api.tempo) { api.tempo = bpm; node.port.postMessage({ tempo: bpm }); } };
    api.setEnabled = (on) => {
      api.enabled = !!on; clearTimeout(clearTimer); apply();
      if (!on) clearTimer = setTimeout(() => node.port.postMessage({ clear: true }), 700); /* once the wet sound has faded, forget what was heard */
    };
    api.dispose = () => { try { input.disconnect(); node.disconnect(); output.disconnect(); } catch { /* already gone */ } };
    api.setPreset('mosaic'); node.port.postMessage({ tempo: api.tempo });
    return api;
  }

  window.ResonanceMicro = { create, PRESETS, ORDER };
})();

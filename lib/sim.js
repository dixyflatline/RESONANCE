// RESONANCE PoC — the audience simulator ("rehearsal").
//
// Five simulated phones that connect to the server like real ones (WebSocket, role "client"), so the audience rules apply to them exactly as
// they do to people: group limits, cooldowns, the 3-person gong vote, the pad ranges. Each has a persona that decides what it likes to do, and
// the whole room has an activity level, so you can practise playing against a calm room, a busy one, a stormy one or one that breathes in waves.
// Controlled from the rehearsal page (admin/rehearsal.html, localhost or ENGINE_KEY only) through server.js.

const WebSocket = require('ws');
const { EventEmitter } = require('events');

const IDENTITIES = [['Mika', '#f2a65a'], ['Jun', '#6fd3c2'], ['Sol', '#e56b8a'], ['Ren', '#8fb8ff'], ['Kai', '#c3a6ff']];

// rates are "per minute at activity 1". want = how much it likes each kind of layer; on = how much it prefers switching things on over off.
const PERSONAS = {
  explorer: { label: 'Explorer', desc: 'Tries lots of layers and switches often.', toggle: 7, focus: 5, style: 'wander', want: { melodic: 1, rhythmic: 1, nature: 1, other: 1 }, on: 0.65 },
  tweaker: { label: 'Tweaker', desc: 'Settles on one layer and keeps shaping it with the pad.', toggle: 1.2, focus: 0.7, style: 'steady', want: { melodic: 2, rhythmic: 1, nature: 0.2, other: 0.3 }, on: 0.7 },
  rhythm: { label: 'Rhythm lover', desc: 'Goes for rhythm and melody layers, with big complexity sweeps.', toggle: 5, focus: 3, style: 'sweepx', want: { rhythmic: 3, melodic: 2, nature: 0.1, other: 0.2 }, on: 0.6 },
  calm: { label: 'Calm listener', desc: 'Slow and gentle: nature sounds, soft touches, rarely changes anything.', toggle: 1.5, focus: 1, style: 'gentle', want: { nature: 3, melodic: 1, rhythmic: 0.3, other: 1 }, on: 0.55 },
  mischief: { label: 'Mischief', desc: 'Fast flips and wild cutoff and volume jumps.', toggle: 11, focus: 8, style: 'wild', want: { melodic: 1, rhythmic: 1, nature: 1, other: 1 }, on: 0.5 },
};
const DEFAULT_PERSONAS = ['explorer', 'tweaker', 'rhythm', 'calm', 'mischief'];
const SCENARIOS = { // base activity for the room; 'waves' breathes around the slider value
  calm: { label: 'Calm room', activity: 0.35 }, busy: { label: 'Busy room', activity: 1 }, storm: { label: 'Storm', activity: 1.8 }, waves: { label: 'Waves', activity: 1 },
};
const STYLE_SPEED = { wander: 0.35, steady: 0.12, sweepx: 0.55, gentle: 0.1, wild: 1.3 }; // how fast the pad handle travels (pad widths per second)
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

function kindOf(stem) { // a rough sort of the layers, for the personas' tastes
  if (stem.file && stem.group) return 'nature';
  const s = String(stem.synth || '').toLowerCase();
  if (['pulse', 'sub'].includes(s)) return 'rhythmic';
  if (['arp', 'bells', 'shimmer', 'melody'].includes(s)) return 'melodic';
  return 'other';
}

class Bot {
  constructor(sim, i) {
    this.sim = sim; this.i = i; this.name = IDENTITIES[i][0]; this.color = IDENTITIES[i][1];
    this.persona = DEFAULT_PERSONAS[i]; this.on = true; // on = this person is in the room (when the simulator runs)
    this.ws = null; this.cfg = null; this.st = null; this.away = 0; // away: until when this one has stepped out (ms), when "people come and go" is on
    this.focus = null; this.cur = null; this.tgt = null; this.pause = 0; this.lastSend = 0; this.retry = null;
    this.taps = 0; this.denied = 0; this.last = ''; this.lastAt = 0;
  }
  get connected() { return !!(this.ws && this.ws.readyState === 1); }
  connect() {
    if (this.ws || !this.sim.running || !this.on) return;
    const ws = this.ws = new WebSocket(`${this.sim.url}?role=client&sim=${encodeURIComponent(this.name)}`);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.type === 'config') { this.cfg = m; this.focus = null; this.st = this.st || null; }
      else if (m.type === 'state') this.st = m;
      else if (m.type === 'denied') { this.denied++; this.note(`refused: ${m.reason}`); }
    });
    ws.on('error', () => { /* the close handler retries */ });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this.sim.running && this.on && Date.now() >= this.away) { clearTimeout(this.retry); this.retry = setTimeout(() => this.connect(), 2000); }
    });
    ws.on('open', () => this.sim.changed());
  }
  disconnect() { clearTimeout(this.retry); const ws = this.ws; this.ws = null; if (ws) { try { ws.close(); } catch { /* already gone */ } } this.focus = null; }
  note(s) { this.last = s; this.lastAt = Date.now(); this.sim.changed(); }
  send(o) { if (this.connected) this.ws.send(JSON.stringify(o)); }

  stems() { return (this.cfg && this.cfg.stems) || []; }
  rulesOf(stem) { const g = ((this.cfg && this.cfg.groups) || []).find((x) => x.id === stem.group); return g ? g.rules : null; }
  eligible(forXY) { // the layers a person can use: not hidden from phones, not the gong
    return this.stems().filter((s) => { const r = this.rulesOf(s); return !r || (!r.hidden && !r.finale && !r.oneShot && (forXY ? r.xy : r.toggle)); });
  }
  isOn(id) { return !!(this.st && this.st.active.includes(id)); }

  toggleOne() {
    const P = PERSONAS[this.persona], list = this.eligible(false); if (!list.length) return;
    const w = list.map((s) => (P.want[kindOf(s)] ?? 1) * (this.isOn(s.id) ? 1 - P.on : P.on) + 0.01);
    let r = Math.random() * w.reduce((a, b) => a + b, 0), pick = list[0];
    for (let k = 0; k < list.length; k++) { r -= w[k]; if (r <= 0) { pick = list[k]; break; } }
    this.taps++; this.send({ type: 'toggle', stem: pick.id }); this.note(`${this.isOn(pick.id) ? 'switches off' : 'switches on'} ${pick.name}`);
  }
  chooseFocus() {
    const list = this.eligible(true); if (!list.length) return;
    const P = PERSONAS[this.persona];
    const w = list.map((s) => (P.want[kindOf(s)] ?? 1) * (this.isOn(s.id) ? 3 : 0.4) + 0.01);
    let r = Math.random() * w.reduce((a, b) => a + b, 0), pick = list[0];
    for (let k = 0; k < list.length; k++) { r -= w[k]; if (r <= 0) { pick = list[k]; break; } }
    this.focus = pick; const xy = (this.st && this.st.xy && this.st.xy[pick.id]) || { x: 0.6, y: 1, v: 0.8 };
    this.cur = { x: xy.x, y: xy.y, v: xy.v }; this.tgt = null; this.pause = 0;
  }
  newTarget() {
    const P = PERSONAS[this.persona], c = this.cur, st = P.style;
    if (st === 'wander') return { x: rnd(0.05, 0.95), y: rnd(0.3, 1), v: clamp(c.v + rnd(-0.1, 0.1), 0.4, 0.95) };
    if (st === 'steady') return { x: clamp(c.x + rnd(-0.18, 0.18)), y: clamp(c.y + rnd(-0.2, 0.2), 0.3, 1), v: clamp(c.v + rnd(-0.06, 0.06), 0.5, 0.95) };
    if (st === 'sweepx') return { x: c.x < 0.5 ? rnd(0.85, 1) : rnd(0, 0.15), y: rnd(0.6, 1), v: clamp(c.v + rnd(-0.05, 0.1), 0.6, 1) };
    if (st === 'gentle') return { x: clamp(c.x + rnd(-0.1, 0.1)), y: clamp(c.y + rnd(-0.15, 0.1), 0.5, 1), v: rnd(0.5, 0.8) };
    return { x: Math.random(), y: Math.random(), v: Math.random() }; // wild
  }
  stepXY(dt, act) {
    if (!this.focus || !this.cur) return;
    if (!this.tgt) { this.pause -= dt; if (this.pause > 0) return; this.tgt = this.newTarget(); }
    const sp = STYLE_SPEED[PERSONAS[this.persona].style] * Math.max(0.5, act) * dt, t = this.tgt, c = this.cur;
    const dx = t.x - c.x, dy = t.y - c.y, dv = t.v - c.v, d = Math.hypot(dx, dy, dv);
    if (d < 0.01) { this.tgt = null; this.pause = rnd(0.4, 4) / Math.max(0.3, act); return; }
    const k = Math.min(1, sp / d); c.x += dx * k; c.y += dy * k; c.v += dv * k;
    const now = Date.now();
    if (now - this.lastSend >= 100) {
      this.lastSend = now; this.send({ type: 'xy', stem: this.focus.id, x: c.x, y: c.y, v: c.v });
      if (now - this.lastAt > 2500) this.note(`shapes ${this.focus.name}: complexity ${Math.round(c.x * 100)}%, cutoff ${Math.round(c.y * 100)}%, volume ${Math.round(c.v * 100)}%`);
    }
  }
  tick(dt, act) {
    if (!this.connected || !this.cfg || !this.st || this.st.finale) return;
    const P = PERSONAS[this.persona];
    if (Math.random() < P.toggle * act * dt / 60) this.toggleOne();
    if (!this.focus || Math.random() < P.focus * act * dt / 60) this.chooseFocus();
    this.stepXY(dt, act);
  }
}

class Sim extends EventEmitter {
  constructor({ url }) {
    super();
    this.url = url; this.running = false; this.scenario = 'busy'; this.activity = 1; this.churn = false; this.t0 = 0; this.nextChurn = 0;
    this.bots = IDENTITIES.map((_, i) => new Bot(this, i)); this.timer = null; this._ch = 0;
  }
  effective() { return this.scenario === 'waves' ? clamp(this.activity * (0.95 + 0.8 * Math.sin(((Date.now() - this.t0) / 1000) * 2 * Math.PI / 150)), 0.1, 2) : this.activity; }
  changed() { if (!this._ch) this._ch = setTimeout(() => { this._ch = 0; this.emit('status'); }, 150); }
  status() {
    return {
      running: this.running, scenario: this.scenario, activity: this.activity, effective: +this.effective().toFixed(2), churn: this.churn,
      scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label })),
      personas: Object.entries(PERSONAS).map(([id, p]) => ({ id, label: p.label, desc: p.desc })),
      bots: this.bots.map((b) => ({ i: b.i, name: b.name, color: b.color, persona: b.persona, on: b.on, connected: b.connected, away: Date.now() < b.away, focus: b.focus ? b.focus.name : '', taps: b.taps, denied: b.denied, last: b.last, lastAt: b.lastAt })),
    };
  }
  start() {
    if (this.running) return; this.running = true; this.t0 = Date.now(); this.nextChurn = Date.now() + rnd(20000, 40000);
    this.bots.forEach((b, k) => { if (b.on) setTimeout(() => b.connect(), 300 + k * rnd(300, 900)); });
    let prev = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now(), dt = Math.min(0.5, (now - prev) / 1000); prev = now; const act = this.effective();
      for (const b of this.bots) { if (b.away && now >= b.away && b.on) { b.away = 0; b.note('is back'); b.connect(); } b.tick(dt, act); }
      if (this.churn && now >= this.nextChurn) this.churnOne(now, act);
    }, 100);
    this.changed();
  }
  churnOne(now, act) {
    this.nextChurn = now + rnd(20000, 60000) / Math.max(0.4, act);
    const here = this.bots.filter((b) => b.on && b.connected);
    if (here.length > 1) { const b = here[Math.floor(Math.random() * here.length)]; b.away = now + rnd(15000, 60000); b.note('left the room'); b.disconnect(); }
  }
  stop() {
    this.running = false; clearInterval(this.timer); this.timer = null;
    for (const b of this.bots) { b.away = 0; b.disconnect(); }
    this.changed();
  }
  setBot(i, { persona, on }) {
    const b = this.bots[i]; if (!b) return;
    if (persona && PERSONAS[persona]) { b.persona = persona; b.focus = null; b.note(`is now a ${PERSONAS[persona].label}`); }
    if (typeof on === 'boolean' && on !== b.on) { b.on = on; if (!on) { b.disconnect(); b.note('left the room'); } else if (this.running) { b.away = 0; b.connect(); } }
    this.changed();
  }
  set({ scenario, activity, churn }) {
    if (scenario && SCENARIOS[scenario]) { this.scenario = scenario; if (scenario !== 'waves') this.activity = SCENARIOS[scenario].activity; this.t0 = Date.now(); }
    if (Number.isFinite(Number(activity))) this.activity = clamp(Number(activity), 0, 2);
    if (typeof churn === 'boolean') { this.churn = churn; this.nextChurn = Date.now() + rnd(10000, 25000); }
    this.changed();
  }
  /** Three people tap the gong within a few seconds: the end-of-show vote. Only when asked for. */
  gongVote() {
    const here = this.bots.filter((b) => b.connected && b.cfg);
    if (here.length < 3) return { ok: false, msg: 'Three simulated people must be in the room for the gong vote.' };
    const cfg = here[0].cfg, gong = (cfg.stems || []).find((s) => { const g = (cfg.groups || []).find((x) => x.id === s.group); return g && g.rules && g.rules.finale; });
    if (!gong) return { ok: false, msg: 'This pack has no gong.' };
    here.slice(0, 3).forEach((b, k) => setTimeout(() => { b.taps++; b.send({ type: 'toggle', stem: gong.id }); b.note('votes for the gong'); }, k * rnd(800, 3000)));
    return { ok: true, msg: 'Three votes are on their way. The show will end if the vote succeeds.' };
  }
}

module.exports = { Sim, PERSONAS, SCENARIOS };

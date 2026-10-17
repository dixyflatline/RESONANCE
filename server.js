// RESONANCE PoC — Fangzhang 方丈, the stem trigger server
// - Serves the audience client (/), the audio engine (/engine) and sample packs (/packs/*)
// - WebSocket hub at /ws: audience taps -> desired state -> engine plays it on the master clock
// - Input is source-agnostic (see handleInput) so a biosensor feed can join or replace taps later.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { scanPacks, summary, publicGroup } = require('./lib/packs');
const { Sim } = require('./lib/sim');

const PORT = Number(process.env.PORT) || 8080;
// When deployed publicly, set ENGINE_KEY so only you can run the audio engine or send
// admin/sensor input. Open the engine as /engine?key=<ENGINE_KEY>. Unset = no key (local use).
const ENGINE_KEY = process.env.ENGINE_KEY || '';
const keyOk = (k) => !ENGINE_KEY || k === ENGINE_KEY;
// The rehearsal tools (the monitor page, the audience simulator) are for the operator only. Without ENGINE_KEY they answer only to the machine the server
// runs on (a request that came through a proxy counts as remote); with ENGINE_KEY set, anyone who has the key.
const isLoopback = (req) => !req.headers['x-forwarded-for'] && !req.headers.forwarded && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const adminOk = (req, key) => (ENGINE_KEY ? key === ENGINE_KEY : isLoopback(req));
const STARTED = Date.now();
const SUPERVISED = process.env.RESONANCE_SUPERVISED === '1'; // started by tools/run.js (npm start): can restart itself

// "Build" id = newest modification time of the code. Pages compare it to know when to reload.
function buildId() {
  let m = 0;
  const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else m = Math.max(m, fs.statSync(f).mtimeMs); } } catch { /* ignore */ } };
  walk(path.join(__dirname, 'public')); walk(path.join(__dirname, 'lib'));
  try { m = Math.max(m, fs.statSync(__filename).mtimeMs); } catch { /* ignore */ }
  return Math.round(m).toString(36);
}
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PACKS_DIR = path.join(ROOT, 'packs');

// config.json: global settings (default pack, quantize, fades) + fallback tempo/key for packs that don't set their own.
function loadConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
let config = loadConfig();

// ---- Sample packs --------------------------------------------------------
// Each folder in packs/ is a pack (see packs/README.md). The list is re-scanned whenever the
// pack browser asks for it, so dropping in a new folder needs no restart.
let packList = [];
function rescan() { packList = scanPacks(PACKS_DIR, config); return packList; }
rescan();
let active = packList.find((p) => p.id === config.pack && p.playable) || packList.find((p) => p.playable);
if (!active) {
  console.error('\n  No playable sample packs found in packs/. Add a pack folder (see packs/README.md) or run: npm run fetch-stems\n');
  process.exit(1);
}

// ---- State ---------------------------------------------------------------
const state = {
  active: new Set(),   // stems the audience wants on (desired)
  playing: new Set(),  // stems the engine reports as actually sounding
  params: {},          // continuous params (future sensor mapping), e.g. { brightness: 0.8 }
  xy: {},              // per-stem controller: { [id]: { x: complexity 0..1, y: filter cutoff 0..1, v: volume 0..1 } }
  finale: false,       // the end of the show has been signalled (the gong): 3 strikes, everything fades out; taps are ignored until a new show
};
// ---- Audience rules (per stem group; see lib/rules.js) --------------------
// Only taps from audience phones are limited. The engine page, sensors and HTTP inputs bypass the rules.
const lastChange = new Map();   // stem id -> ms of the last change by a participant (cooldown)
const startedAt = new Map();    // stem id -> ms it was switched on (for replace-oldest)
const decayTimers = new Map();  // stem id -> timer that fades a participant-started stem away
const pendingTaps = new Map();  // stem id -> Map(clientId -> ms): taps waiting for enough people (gate)
const plays = new Map();        // stem id -> times participants have started it in this performance (rules.maxPlays, e.g. the gong)
function resetShow() { plays.clear(); pendingTaps.clear(); state.finale = false; } // a new performance: the gong's three strikes come back
function playsSnapshot() {
  const out = {};
  for (const st of active.stems) { const r = rulesOf(st.id); if (r && r.maxPlays) out[st.id] = { used: plays.get(st.id) || 0, max: r.maxPlays }; }
  return out;
}
const groupOf = (id) => { const st = active.stems.find((s) => s.id === id); return st && (active.groups || []).find((g) => g.id === st.group); };
const rulesOf = (id) => (groupOf(id) || { rules: null }).rules;
const groupActive = (g) => active.stems.filter((s) => s.group === g.id && state.active.has(s.id));
function clearTimers() { for (const t of decayTimers.values()) clearTimeout(t); decayTimers.clear(); lastChange.clear(); startedAt.clear(); pendingTaps.clear(); }
function pendingSnapshot() {
  const now = Date.now(), out = {};
  for (const [id, taps] of pendingTaps) {
    const r = rulesOf(id); if (!r || !r.gate) continue;
    for (const [c, t] of taps) if (now - t > r.gate.window * 1000) taps.delete(c);
    if (taps.size) out[id] = { have: taps.size, need: r.gate.participants };
    else pendingTaps.delete(id);
  }
  return out;
}
function switchOff(id, why) {
  if (!state.active.delete(id)) return;
  startedAt.delete(id); clearTimeout(decayTimers.get(id)); decayTimers.delete(id);
  log(`stem ${id} off (${why})`);
}
function startFinale(id, why) { // the gong: the end-of-show signal. The engine plays the three strikes and fades everything else out in stages.
  state.finale = true; state.active.clear(); pendingTaps.clear();
  for (const t of decayTimers.values()) clearTimeout(t); decayTimers.clear();
  log(`FINALE (${why}): gong x3, all stems fading out`);
}
function switchOn(id, byAudience) {
  if (rulesOf(id) && rulesOf(id).finale) { startFinale(id, byAudience ? 'audience' : 'engine'); return; }
  const g = groupOf(id), gr = g && g.rules; // a group's maxActive holds for every source (engine sidebar, HTTP, phones): the oldest steps aside
  if (gr && gr.maxActive && gr.onFull !== 'ignore') for (const o of groupActive(g).filter((s) => s.id !== id).sort((x, y) => (startedAt.get(x.id) || 0) - (startedAt.get(y.id) || 0)).slice(0, Math.max(0, groupActive(g).filter((s) => s.id !== id).length - gr.maxActive + 1))) switchOff(o.id, 'replaced');
  state.active.add(id); startedAt.set(id, Date.now());
  const r = rulesOf(id);
  if (byAudience && r && r.decay) {
    clearTimeout(decayTimers.get(id));
    decayTimers.set(id, setTimeout(() => { decayTimers.delete(id); if (state.active.has(id)) { switchOff(id, 'faded away'); broadcastState(); } }, r.decay * 1000));
  }
}
function deny(sender, id, reason) { if (sender) { send(sender, { type: 'denied', stem: id, reason }); act('client', sender, 'denied', { stem: id, reason }); } }
/** A participant taps a stem. Returns true when the stem list changed. */
function audienceToggle(id, sender) {
  const r = rulesOf(id), g = groupOf(id), now = Date.now();
  if (state.finale) { deny(sender, id, 'The show is ending'); return false; }
  if (!r) { state.active.has(id) ? switchOff(id, 'tap') : switchOn(id, true); return true; } // pack without groups: no rules
  if (r.hidden || !r.toggle) { deny(sender, id, 'Not available to participants'); return false; }
  const stemName = (active.stems.find((s) => s.id === id) || {}).name || 'It';
  if (r.oneShot && state.active.has(id)) { deny(sender, id, `${stemName} is sounding`); return false; } // a strike can't be cut short by participants
  if (r.maxPlays && (plays.get(id) || 0) >= r.maxPlays) { deny(sender, id, `${stemName} has sounded ${r.maxPlays} times. That's all for this performance`); return false; }
  const cd = (lastChange.get(id) || 0) + r.cooldown * 1000 - now;
  if (cd > 0) { deny(sender, id, `Wait ${Math.ceil(cd / 1000)}s`); return false; }
  if (state.active.has(id)) {
    if (groupActive(g).length <= r.minActive) { deny(sender, id, `${g.name}: at least ${r.minActive} must stay on`); return false; }
    switchOff(id, 'tap'); lastChange.set(id, now); return true;
  }
  if (r.gate) { // needs enough different people
    const taps = pendingTaps.get(id) || new Map(); pendingTaps.set(id, taps);
    for (const [c, t] of taps) if (now - t > r.gate.window * 1000) taps.delete(c);
    taps.set(sender ? sender.cid : 'x', now);
    if (taps.size < r.gate.participants) { setTimeout(broadcastState, r.gate.window * 1000 + 50); return true; } // state carries the pending count
    pendingTaps.delete(id);
  }
  if (r.maxActive && groupActive(g).length >= r.maxActive) {
    if (r.onFull === 'ignore') { deny(sender, id, `${g.name}: only ${r.maxActive} at once`); return false; }
    const oldest = groupActive(g).sort((a, b) => (startedAt.get(a.id) || 0) - (startedAt.get(b.id) || 0))[0];
    if (oldest) switchOff(oldest.id, 'replaced');
  }
  switchOn(id, true); lastChange.set(id, now);
  if (r.maxPlays) { plays.set(id, (plays.get(id) || 0) + 1); log(`${stemName}: strike ${plays.get(id)} of ${r.maxPlays}`); }
  return true;
}

const XY_DEFAULT = { x: 0.6, y: 1, v: 0.8 }; // about the stem as it always sounded: complexity 60%, filter fully open, volume at the stem's configured gain
let engineSocket = null;

// ---- HTTP ----------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Expires': '0',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) ? p : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/' || p === '/client') return sendFile(res, path.join(ROOT, 'public', 'client.html'));
  if (p === '/engine') return sendFile(res, path.join(ROOT, 'public', 'engine.html'));
  if (p === '/rehearsal' || p === '/api/sim') { // operator only: clients get the same answer as for any page that does not exist
    const key = req.headers['x-engine-key'] || url.searchParams.get('key');
    if (!adminOk(req, key)) { res.writeHead(404); return res.end('Not found'); }
    if (p === '/rehearsal') return sendFile(res, path.join(ROOT, 'admin', 'rehearsal.html'));
    if (req.method === 'GET') return json(res, sim.status());
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let m; try { m = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
      let out = { ok: true };
      switch (m.action) {
        case 'start': sim.start(); break;
        case 'stop': sim.stop(); break;
        case 'bot': sim.setBot(Number(m.i), m); break;
        case 'set': sim.set(m); break;
        case 'gong': out = sim.gongVote(); break;
        default: res.writeHead(400); return res.end('unknown action');
      }
      json(res, { ...out, status: sim.status() });
    });
    return;
  }
  if (p === '/api/config') return json(res, publicConfig());
  if (p === '/api/packs') { rescan(); return json(res, { active: active.id, packs: packList.map(summary) }); }
  if (p === '/api/state') return json(res, snapshot());
  if (p === '/api/status') return json(res, { started: STARTED, uptime: Math.round((Date.now() - STARTED) / 1000), build: buildId(), supervised: SUPERVISED, node: process.version, pack: active.id, packs: packList.length, clients: snapshot().clients, engine: snapshot().engine });
  if (p === '/api/restart' && req.method === 'POST') {
    if (!keyOk(req.headers['x-engine-key'] || url.searchParams.get('key'))) { res.writeHead(401); return res.end('engine key required'); }
    if (!SUPERVISED) { res.writeHead(409); return res.end('Not started with npm start, so I cannot restart myself. Stop it and run `npm start`.'); }
    json(res, { ok: true });
    log('restart requested from the web UI');
    broadcast({ type: 'restarting' });
    setTimeout(() => process.exit(75), 250);
    return;
  }
  if (p === '/api/input' && req.method === 'POST') {
    if (!keyOk(req.headers['x-engine-key'] || url.searchParams.get('key'))) { res.writeHead(401); return res.end('engine key required'); }
    // HTTP entry point for non-browser inputs (scripts, sensor bridges):
    // curl -X POST localhost:8080/api/input -d '{"type":"toggle","stem":3}'
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try { handleInput(JSON.parse(body), 'http'); json(res, snapshot()); }
      catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  if (p.startsWith('/packs/')) {
    const f = safeJoin(PACKS_DIR, p.slice('/packs/'.length));
    return f ? sendFile(res, f) : (res.writeHead(403), res.end());
  }
  const f = safeJoin(path.join(ROOT, 'public'), p.slice(1));
  return f ? sendFile(res, f) : (res.writeHead(403), res.end());
});

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' });
  res.end(JSON.stringify(obj));
}

// ---- WebSocket hub -------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

function publicConfig() {
  return {
    pack: { id: active.id, name: active.name, description: active.description },
    tempo: active.tempo, beatsPerBar: active.beatsPerBar, quantize: config.quantize,
    fade: config.fade, fadeIn: config.fadeIn, fadeOut: config.fadeOut, key: active.key, mode: active.mode, seed: active.seed,
    stems: active.stems, groups: (active.groups || []).map(publicGroup), lanUrls: lanUrls(), build: buildId(),
  };
}

function snapshot() {
  let clients = 0, simClients = 0;
  for (const ws of wss.clients) if (ws.role === 'client' && ws.readyState === 1) { clients++; if (ws.simName) simClients++; }
  return {
    type: 'state',
    active: [...new Set([...state.active, ...(state.finale ? active.stems.filter((s) => s.finale).map((s) => s.id) : [])])].sort((a, b) => a - b), /* during the finale the gong counts as on */
    finale: state.finale,
    playing: [...state.playing].sort((a, b) => a - b),
    params: state.params,
    xy: Object.fromEntries(active.stems.map((s) => [s.id, state.xy[s.id] || XY_DEFAULT])),
    pending: pendingSnapshot(),
    plays: playsSnapshot(),
    engine: !!(engineSocket && engineSocket.readyState === 1),
    clients, simClients,
  };
}

const toMonitors = (obj) => { const s = JSON.stringify(obj); for (const ws of wss.clients) if (ws.role === 'monitor') send(ws, s); };
const lastXYAct = new Map(); // "cid:stem" -> ms, so pad movement reaches the monitor a few times a second, not 60
/* What happened, for the rehearsal monitor: who (a phone, a simulated person, the engine page, HTTP) did what. */
function act(source, sender, kind, extra) {
  toMonitors({ type: 'act', t: Date.now(), kind, who: source === 'client' && sender ? sender.cid : source, name: sender && sender.simName || null, source, ...extra });
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function broadcast(msg) { const s = JSON.stringify(msg); for (const ws of wss.clients) send(ws, s); }
function broadcastState() { broadcast(snapshot()); }

// Make `next` the live pack for everyone: clients rebuild their grids, the engine fades out and loads it.
function setActive(next, source) {
  active = next;
  state.active.clear(); state.playing.clear(); state.xy = {}; clearTimers(); resetShow();
  log(`${source} pack -> ${next.id} (${next.stems.length} stems, ${next.tempo} BPM)`);
  broadcast({ type: 'config', ...publicConfig() });
  broadcastState();
}

// Single entry point for every musical input (taps, HTTP, future sensors).
function handleInput(msg, source, sender) {
  const validStem = (id) => active.stems.some((s) => s.id === id);
  switch (msg.type) {
    case 'pack': { // switch sample pack (engine / sensor / HTTP only; audience phones can't send this)
      const next = packList.find((p) => p.id === String(msg.id));
      if (!next || !next.playable) return;
      if (next.id !== active.id || msg.reload) { setActive(next, source); act(source, sender, 'pack', { pack: next.id }); }
      return;
    }
    case 'toggle': {
      const id = Number(msg.stem);
      if (!validStem(id)) return;
      if (state.finale) return; // the show is ending: nothing can be started until a new show
      if (source === 'client') { if (!audienceToggle(id, sender)) { if (Object.keys(pendingSnapshot()).length) broadcastState(); return; } }
      else state.active.has(id) ? switchOff(id, source) : switchOn(id, false);
      break;
    }
    case 'set': { // explicit on/off (idempotent; handy for sensor rules)
      const id = Number(msg.stem);
      if (!validStem(id)) return;
      if (state.finale) return;
      msg.on ? (state.active.has(id) || switchOn(id, false)) : switchOff(id, source);
      break;
    }
    case 'stopAll':
      state.active.clear(); clearTimers(); state.finale = false;
      break;
    case 'newShow': // a new performance (engine start / restart run count): votes and the gong's strikes start again
      resetShow();
      break;
    case 'param': { // continuous 0..1 params, e.g. brightness (placeholder for biosignal mapping)
      const v = Math.max(0, Math.min(1, Number(msg.value)));
      if (typeof msg.name === 'string' && Number.isFinite(v)) state.params[msg.name] = v;
      break;
    }
    case 'xy': { // per-stem controller (x = complexity, y = filter cutoff, v = volume), high-rate: no log, no full state
      const id = Number(msg.stem);
      if (!validStem(id)) return;
      const clamp = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d);
      const cur = { ...XY_DEFAULT, ...(state.xy[id] || {}) };
      const stem = active.stems.find((s) => s.id === id);
      let xy = { x: stem && stem.complexity ? clamp(msg.x, cur.x) : cur.x, y: clamp(msg.y, cur.y), v: clamp(msg.v, cur.v) }; // no complexity layers: X stays put
      let limited = false;
      const r = source === 'client' ? rulesOf(id) : null;
      if (r) { // participants: locked pad or limited range for this group
        if (r.hidden || !r.xy) return;
        const lim = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
        const c = { x: lim(xy.x, r.xyRange.x), y: lim(xy.y, r.xyRange.y), v: lim(xy.v, r.volRange) };
        limited = c.x !== xy.x || c.y !== xy.y || c.v !== xy.v; xy = c;
      }
      state.xy[id] = xy;
      { const k = (sender ? sender.cid : source) + ':' + id, now = Date.now(); if (now - (lastXYAct.get(k) || 0) > 400) { lastXYAct.set(k, now); act(source, sender, 'xy', { stem: id, ...xy }); } }
      const out = JSON.stringify({ type: 'xy', stem: id, ...xy });
      for (const ws of wss.clients) if (ws !== sender || limited) send(ws, out);
      return;
    }
    default:
      return;
  }
  if (['toggle', 'set', 'stopAll', 'newShow'].includes(msg.type)) act(source, sender, msg.type, { stem: msg.stem != null ? Number(msg.stem) : null, on: msg.stem != null ? state.active.has(Number(msg.stem)) : null, pending: msg.stem != null && pendingTaps.has(Number(msg.stem)) });
  log(`${source} ${msg.type}${msg.stem != null ? ' ' + msg.stem : ''}${msg.name ? ' ' + msg.name + '=' + msg.value : ''} -> active [${[...state.active].join(',')}]`);
  broadcastState();
}

// The one engine: a newly claiming engine page replaces the old one (which goes idle and stops its sound).
function claimEngine(ws) {
  if (engineSocket === ws) return;
  if (engineSocket && engineSocket.readyState === 1) {
    send(engineSocket, { type: 'replaced' });
    engineSocket.close();
  }
  engineSocket = ws;
  state.playing.clear();
  log('engine connected');
  broadcastState();
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  ws.role = url.searchParams.get('role') === 'engine' ? 'engine'
    : url.searchParams.get('role') === 'sensor' ? 'sensor' : url.searchParams.get('role') === 'monitor' ? 'monitor' : 'client';
  if (ws.role === 'client' && url.searchParams.get('sim') && isLoopback(req)) ws.simName = String(url.searchParams.get('sim')).slice(0, 20); /* a simulated person (only this machine can say so) */
  ws.isAlive = true;
  ws.cid = Math.random().toString(36).slice(2, 10); // identifies this participant for group rules
  ws.on('pong', () => { ws.isAlive = true; });
  if (ws.role !== 'client' && !keyOk(url.searchParams.get('key'))) {
    log(`${ws.role} rejected: bad or missing engine key`);
    return ws.close(4001, 'engine key required');
  }
  if (ws.role === 'monitor' && !adminOk(req, url.searchParams.get('key'))) { log('monitor rejected: not from this machine and no key'); return ws.close(4003, 'operator only'); }

  ws.standby = ws.role === 'engine' && url.searchParams.get('standby') === '1';
  if (ws.role === 'engine' && ws.standby) {
    log('engine page opened (standby: it becomes the engine when Start is pressed)'); // opening the page must not silence a running engine
  } else if (ws.role === 'engine') {
    claimEngine(ws);
  } else if (!ws.simName) {
    log(`${ws.role} connected (${req.socket.remoteAddress})`);
  }
  if (ws.role === 'client') act('client', ws, 'join', {});

  send(ws, { type: 'config', ...publicConfig() });
  broadcastState();

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (ws.role === 'engine') {
      if (msg.type === 'claim') { claimEngine(ws); return; } // Start was pressed on this page
      if (ws !== engineSocket && (msg.type === 'playing' || msg.type === 'tick' || msg.type === 'reseed')) return; // a standby page is not the engine
      if (msg.type === 'playing') { state.playing = new Set(msg.playing.map(Number)); broadcastState(); }
      else if (msg.type === 'tick') broadcast(msg); // beat clock for client UIs
      else if (msg.type === 'reseed') { active.seed = msg.seed; active.key = msg.key || active.key; }
      else handleInput(msg, 'engine', ws);
      return;
    }
    if (ws.role === 'monitor') return; // the monitor only watches
    // Audience phones may only toggle stems and move XY pads.
    if (ws.role === 'client' && msg.type !== 'toggle' && msg.type !== 'xy') return;
    handleInput(msg, ws.role, ws);
  });

  ws.on('close', () => {
    if (ws === engineSocket) { engineSocket = null; state.playing.clear(); log('engine disconnected'); }
    if (ws.role === 'client') act('client', ws, 'leave', {});
    broadcastState();
  });
});

// The audience simulator (see lib/sim.js). Its status goes to the rehearsal monitors when it changes and once a second while it runs.
const sim = new Sim({ url: `ws://127.0.0.1:${PORT}/ws` });
const pushSim = () => toMonitors({ type: 'sim', status: sim.status() });
sim.on('status', pushSim);
setInterval(() => { if (sim.running) pushSim(); }, 1000);

// Heartbeat: drop dead phones so client counts stay honest.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 10000);

// ---- Utils ---------------------------------------------------------------
function lanUrls() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      /* Wi-Fi/ethernet first; VPN, Docker and virtual adapters last */
      const virt = /^(utun|tun|tap|docker|br-|veth|vmnet|vbox|bridge|awdl|llw|ppp)/i.test(name);
      const rank = (virt ? 20 : 0) + (i.address.startsWith('192.168.') ? 0 : i.address.startsWith('10.') ? 1 : 2);
      out.push({ rank, url: `http://${i.address}:${PORT}/` });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((o) => o.url);
}
function log(s) { console.log(new Date().toISOString().slice(11, 19), s); }

fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  try { config = loadConfig(); log('config.json reloaded (reload the engine page to apply)'); broadcast({ type: 'config', ...publicConfig() }); }
  catch (e) { log('config.json invalid: ' + e.message); }
});

server.listen(PORT, () => {
  console.log('\n  Sample packs (default marked *):');
  for (const p of packList) console.log(`   ${p.id === active.id ? '*' : p.playable ? ' ' : 'x'} ${p.name} (${p.id}): ${p.stems.length} stems, ${p.tempo} BPM${p.warnings.length ? ', ' + p.warnings.length + ' warning(s), see: npm run packs' : ''}`);
  if (ENGINE_KEY) console.log('  ENGINE_KEY is set: open the engine as /engine?key=…');
  console.log('\n  RESONANCE · Fangzhang 方丈 (server)');
  console.log(`  Dantian 丹田 (engine; open on the machine wired to the PA): http://localhost:${PORT}/engine`);
  console.log(`  Rehearsal monitor and audience simulator (this machine only${ENGINE_KEY ? ', or with the key' : ''}): http://localhost:${PORT}/rehearsal${ENGINE_KEY ? '?key=…' : ''}`);
  console.log('  Daqian 大千 (audience phones, same Wi-Fi):');
  for (const u of lanUrls()) console.log('    ' + u);
  console.log('');
});

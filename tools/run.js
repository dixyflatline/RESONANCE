#!/usr/bin/env node
// RESONANCE PoC supervisor for Fangzhang 方丈, the server (this is what `npm start` runs).
//  - restarts the server automatically when server.js, lib/*.js or package.json change,
//  - restarts it when the web UI's "Restart server" button asks (the server exits with code 75),
//  - restarts it if it crashes (and gives up if it keeps dying instantly, e.g. port already in use).
// Use `npm run start:plain` to run the server without it.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const watched = () => {
  const files = [path.join(root, 'server.js'), path.join(root, 'package.json')];
  try { for (const f of fs.readdirSync(path.join(root, 'lib'))) files.push(path.join(root, 'lib', f)); } catch { /* no lib */ }
  return files;
};
const stamp = () => watched().map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(',');

let child = null, last = stamp(), quitting = false, fast = 0, startedAt = 0;

function start() {
  startedAt = Date.now();
  child = spawn(process.execPath, [path.join(root, 'server.js')], { stdio: 'inherit', env: { ...process.env, RESONANCE_SUPERVISED: '1' } });
  child.on('exit', (code, sig) => {
    child = null;
    if (quitting) return process.exit(0);
    fast = Date.now() - startedAt < 3000 ? fast + 1 : 0;
    if (fast >= 4) { console.error('\n[run] The server keeps exiting right away, so I stopped. Fix the error above and run `npm start` again.\n'); process.exit(1); }
    console.log(`[run] server ${code === 75 ? 'restart requested' : sig ? 'stopped (' + sig + ')' : 'exited (' + code + ')'}; starting again…`);
    setTimeout(start, code === 75 ? 100 : 1000);
  });
}

function restart(why) {
  if (!child) return;
  console.log(`[run] ${why}; restarting the server…`);
  child.kill('SIGTERM');
}

setInterval(() => { const now = stamp(); if (now !== last) { last = now; setTimeout(() => restart('code changed'), 300); } }, 1000).unref();
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { quitting = true; if (child) child.kill(s); else process.exit(0); });
start();

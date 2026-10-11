#!/usr/bin/env node
// List the sample packs in packs/ and flag problems:   npm run packs
const fs = require('fs');
const path = require('path');
const { scanPacks } = require('../lib/packs');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const packs = scanPacks(path.join(root, 'packs'), config);
const mb = (b) => (b ? (b / 1e6).toFixed(1) + ' MB' : '—');
const pad = (s, n) => String(s).padEnd(n);

if (!packs.length) { console.log('No packs found in packs/. See packs/README.md.'); process.exit(0); }
console.log(`\n  ${pad('', 2)}${pad('id', 24)}${pad('name', 28)}${pad('tempo · key', 14)}${pad('stems', 7)}size`);
for (const p of packs) {
  const mark = p.id === config.pack ? '★' : p.playable ? ' ' : '✗';
  console.log(`  ${mark} ${pad(p.id, 24)}${pad(p.name.slice(0, 26), 28)}${pad(`${p.tempo} · ${p.key || 'any'}`, 14)}${pad(p.stems.length, 7)}${mb(p.sizeBytes)}${p.auto ? '  (auto-detected)' : ''}${p.include.length ? '  (combines ' + p.include.join(' + ') + ')' : ''}`);
  for (const s of p.skipped) console.log(`        ✗ ${s.name}: ${s.reason}`);
  for (const w of p.warnings) console.log(`        ⚠ ${w}`);
}
console.log(`\n  ★ = default pack at startup (config.json "pack")\n`);

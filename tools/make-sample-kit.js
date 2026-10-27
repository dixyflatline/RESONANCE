// Writes soundkits/keys-samples/: a small sound kit made of recorded-style samples (generated here, so no licence to worry about)
// to show how a kit can use audio files. Run: node tools/make-sample-kit.js
// Two files: keys-c4.wav (an electric-piano-like note at C4, MIDI 60) and bass-c2.wav (a round bass note at C2, MIDI 36).
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'soundkits', 'keys-samples');
fs.mkdirSync(dir, { recursive: true });
const SR = 44100;
function wav(name, secs, fn) {
  const n = Math.round(SR * secs), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let peak = 0; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = fn(i / SR, i); peak = Math.max(peak, Math.abs(x[i])); }
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((x[i] / peak) * 0.85 * 32767), 44 + i * 2);
  fs.writeFileSync(path.join(dir, name), buf);
}
const f = 261.6256, fb = 65.4064;
// electric piano: a tine (partials at 1, 2, 3, 4.01, 6.02 with their own decays) over a soft hammer click; fades out over the last 0.4 s
wav('keys-c4.wav', 3.2, (t) => {
  const P = [[1, 1, 1.4], [2, 0.5, 1.0], [3, 0.22, 0.7], [4.01, 0.3, 0.35], [6.02, 0.12, 0.2]];
  let y = 0; for (const [m, a, d] of P) y += a * Math.sin(2 * Math.PI * f * m * t) * Math.exp(-t / d);
  y += 0.35 * Math.sin(2 * Math.PI * f * 1.0005 * t) * Math.exp(-t / 1.6); // a slightly detuned partner, for a little beating
  y *= 1 - Math.exp(-t / 0.004); // 4 ms attack
  return y * Math.min(1, (3.2 - t) / 0.4);
});
wav('bass-c2.wav', 2.0, (t) => {
  let y = Math.sin(2 * Math.PI * fb * t) + 0.35 * Math.sin(2 * Math.PI * fb * 2 * t) * Math.exp(-t / 0.5) + 0.12 * Math.sin(2 * Math.PI * fb * 3 * t) * Math.exp(-t / 0.2);
  y *= Math.exp(-t / 0.9) * (1 - Math.exp(-t / 0.006));
  return y * Math.min(1, (2 - t) / 0.3);
});
fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify({
  name: 'Electric keys (samples)', description: 'Recorded-style notes repitched across the keyboard: an electric piano for chords, arp and Melody A, a round bass, and a synth bell for Melody B. Shows how a kit uses audio files (generated here: CC0).', order: 20,
  voices: {
    chords: { voice: 'sample', file: 'keys-c4.wav', root: 60, gain: 1.5 }, bass: { voice: 'sample', file: 'bass-c2.wav', root: 36, gain: 1.8 },
    arp: { voice: 'sample', file: 'keys-c4.wav', root: 60, gain: 1.6 }, melodyA: { voice: 'sample', file: 'keys-c4.wav', root: 60, gain: 1.0 }, melodyB: 'bell',
  },
}, null, 2) + '\n');
console.log('wrote', dir);

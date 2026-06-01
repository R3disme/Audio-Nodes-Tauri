import { _electron as electron } from 'playwright-core';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = await electron.launch({
  executablePath: join(ROOT, 'node_modules/electron/dist/electron.exe'),
  args: [join(ROOT, 'out/main/index.js')],
  env: { ...process.env, NODE_ENV: 'production' },
  timeout: 30_000,
});

await new Promise(r => setTimeout(r, 2500));
const page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? await app.firstWindow();

const errors = [];
const warnings = [];
page.on('console', msg => {
  const text = msg.text();
  if (msg.type() === 'error') errors.push(text);
  if (msg.type() === 'warning') warnings.push(text);
});
page.on('pageerror', err => errors.push(`Page error: ${err.message}`));

// Deterministic run: clear any persisted graph/settings, then reload fresh.
await page.evaluate(() => {
  localStorage.removeItem('audio-nodes.graph.v1');
  localStorage.removeItem('audio-nodes.settings.v1');
});
await page.reload();
await new Promise(r => setTimeout(r, 1500));

// Add all node types
const types = [
  'input', 'application', 'volume', 'eq', 'compressor', 'gate',
  'reverb', 'delay', 'chorus', 'distortion', 'pan', 'mixer', 'output'
];
for (const t of types) {
  await page.evaluate(type => window.__audioStore.getState().addNode(type), t);
  await new Promise(r => setTimeout(r, 200));
}

// Change channel counts (including the new multi-channel effects, which exercises
// the setChannelCount rebuild path and chorus-LFO teardown)
await page.evaluate(() => {
  const store = window.__audioStore;
  const byType = t => store.getState().nodes.find(n => n.type === t);
  store.getState().setNodeChannels(byType('eq').id, 'eq', 3);
  store.getState().setNodeChannels(byType('compressor').id, 'compressor', 2);
  store.getState().setNodeChannels(byType('reverb').id, 'reverb', 2);
  store.getState().setNodeChannels(byType('delay').id, 'delay', 2);
  store.getState().setNodeChannels(byType('chorus').id, 'chorus', 3);   // grow then shrink → LFOs
  store.getState().setNodeChannels(byType('chorus').id, 'chorus', 1);
  store.getState().setNodeChannels(byType('pan').id, 'pan', 2);
});

// Various param changes
await page.evaluate(() => {
  const store = window.__audioStore;
  const nodes = store.getState().nodes;
  const byType = t => nodes.find(n => n.type === t);
  const e = window.__audioEngine;
  e.setGain(byType('volume').id, 0.5);
  e.setEQBand(byType('eq').id, 0, -6);
  e.setEQBand(byType('eq').id, 4, 8);
  e.setReverb(byType('reverb').id, { mix: 0.5, decay: 4, preDelay: 0.04 });
  e.setDelay(byType('delay').id, { time: 0.5, feedback: 0.6, mix: 0.5 });
  e.setChorus(byType('chorus').id, { rate: 3, depth: 0.005, mix: 0.6 });
  e.setDistortion(byType('distortion').id, { drive: 20, mix: 0.7 });
  e.setPan(byType('pan').id, -0.8);
});

// Delete all nodes
await page.evaluate(() => {
  const store = window.__audioStore;
  store.setState({ nodes: [], edges: [] });
});

await new Promise(r => setTimeout(r, 500));

console.log('Errors:', errors.length);
for (const e of errors) console.log('  -', e);
console.log('Warnings:', warnings.length);
for (const w of warnings) console.log('  -', w);

await app.close();
process.exit(errors.length === 0 ? 0 : 1);

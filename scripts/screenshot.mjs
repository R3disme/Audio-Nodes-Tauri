import { _electron as electron } from 'playwright-core';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = join(ROOT, 'screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

const app = await electron.launch({
  executablePath: join(ROOT, 'node_modules/electron/dist/electron.exe'),
  args: [join(ROOT, 'out/main/index.js')],
  env: { ...process.env, NODE_ENV: 'production', AUDIO_NODES_E2E: '1' },
  timeout: 30_000,
});

await new Promise(r => setTimeout(r, 3500));
const page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? await app.firstWindow();

page.on('console', msg => {
  if (msg.type() === 'error') console.log('[renderer error]', msg.text());
});
page.on('pageerror', err => console.log('[page error]', err.message));

// Deterministic run: clear any persisted graph/settings, then reload fresh.
await page.evaluate(() => {
  localStorage.removeItem('audio-nodes.graph.v1');
  localStorage.removeItem('audio-nodes.workspaces.v1');
  // Pin the Web Audio engine so the demo is deterministic, independent of the
  // app's default engine.
  localStorage.setItem('audio-nodes.settings.v1', JSON.stringify({ engine: 'webaudio' }));
});
await page.reload();
await new Promise(r => setTimeout(r, 1500));

// Programmatically add nodes at specific positions and wire them up
const layout = await page.evaluate(async () => {
  const store = window.__audioStore;
  if (!store) return { error: 'No store' };

  const positions = {
    input:       { x:  60, y:  70 },
    application: { x:  60, y: 290 },
    volume:      { x: 310, y:  80 },
    eq:          { x: 560, y:  50 },
    compressor:  { x: 560, y: 300 },
    gate:        { x: 820, y:  50 },
    distortion:  { x: 310, y: 350 },
    chorus:      { x: 560, y: 540 },
    reverb:      { x: 820, y: 300 },
    delay:       { x: 1080, y: 300 },
    pan:         { x: 1080, y:  70 },
    mixer:       { x: 820, y: 540 },
    output:      { x: 1100, y: 540 },
    recorder:    { x: 1100, y: 760 }
  };
  for (const [type, pos] of Object.entries(positions)) {
    await store.getState().addNode(type, pos);
  }

  // Increase the EQ to 2 channels to demonstrate multi-channel
  await new Promise(r => setTimeout(r, 200));
  const nodes = store.getState().nodes;
  const eq = nodes.find(n => n.type === 'eq');
  if (eq) store.getState().setNodeChannels(eq.id, 'eq', 2);

  await new Promise(r => setTimeout(r, 200));

  // Build connections: input → volume → eq(ch0) → gate → mixer(ch0) → output
  //                                 → eq(ch1)        → mixer(ch1)
  //                  application → compressor → mixer(ch2)
  const ids = Object.fromEntries(store.getState().nodes.map(n => [n.type, n.id]));
  const connect = (src, sHandle, tgt, tHandle) =>
    store.getState().onConnect({ source: src, sourceHandle: sHandle, target: tgt, targetHandle: tHandle });

  connect(ids.input, 'out-0', ids.volume, 'in-0');
  connect(ids.volume, 'out-0', ids.eq, 'in-0');
  connect(ids.volume, 'out-0', ids.eq, 'in-1');
  connect(ids.eq, 'out-0', ids.gate, 'in-0');
  connect(ids.gate, 'out-0', ids.mixer, 'in-0');
  connect(ids.eq, 'out-1', ids.mixer, 'in-1');
  connect(ids.application, 'out-0', ids.compressor, 'in-0');
  connect(ids.compressor, 'out-0', ids.mixer, 'in-2');

  // Creative FX chain (karaoke-style vocal coloring): volume → distortion →
  // chorus → reverb → delay → pan → mixer. Showcases the new effect nodes and
  // their source-colored edges.
  connect(ids.volume, 'out-0', ids.distortion, 'in-0');
  connect(ids.distortion, 'out-0', ids.chorus, 'in-0');
  connect(ids.chorus, 'out-0', ids.reverb, 'in-0');
  connect(ids.reverb, 'out-0', ids.delay, 'in-0');
  connect(ids.delay, 'out-0', ids.pan, 'in-0');
  connect(ids.pan, 'out-0', ids.mixer, 'in-3');

  connect(ids.mixer, 'out-0', ids.output, 'in-0');
  connect(ids.mixer, 'out-0', ids.recorder, 'in-0');

  return { ok: true, nodeCount: store.getState().nodes.length, edgeCount: store.getState().edges.length };
});
console.log('Layout result:', layout);

// Add two more workspaces (one disabled) so the workspace bar shows several
// tables, then return to the first for the screenshot.
await page.evaluate(async () => {
  const store = window.__audioStore;
  store.getState().addWorkspace();
  store.getState().renameWorkspace(store.getState().activeWorkspaceId, 'Stream Mix');
  store.getState().addWorkspace();
  store.getState().renameWorkspace(store.getState().activeWorkspaceId, 'Podcast');
  await store.getState().setWorkspaceEnabled(store.getState().activeWorkspaceId, false);
  store.getState().setActiveWorkspace(store.getState().workspaces[0].id);
  store.getState().renameWorkspace(store.getState().workspaces[0].id, 'Main');
});
await new Promise(r => setTimeout(r, 300));

await new Promise(r => setTimeout(r, 800));

// Fit view
await page.evaluate(() => document.querySelector('.react-flow__controls-fitview')?.click());
await new Promise(r => setTimeout(r, 800));

const shotPath = join(SHOT_DIR, 'wired.png');
await page.screenshot({ path: shotPath });
console.log('Screenshot saved:', shotPath);

// Test disconnect: remove the volume → eq channel 1 connection
await page.evaluate(() => {
  const store = window.__audioStore;
  const state = store.getState();
  const edge = state.edges.find(e => e.sourceHandle === 'out-0' && e.targetHandle === 'in-1');
  if (edge) {
    store.getState().onEdgesChange([{ id: edge.id, type: 'remove' }]);
  }
});

await new Promise(r => setTimeout(r, 500));
const shot2 = join(SHOT_DIR, 'after-disconnect.png');
await page.screenshot({ path: shot2 });
console.log('Screenshot saved:', shot2);

// Test channel count change: shrink EQ back to 1 channel — should remove the
// connection to out-1 / in-1
await page.evaluate(() => {
  const store = window.__audioStore;
  const eq = store.getState().nodes.find(n => n.type === 'eq');
  if (eq) store.getState().setNodeChannels(eq.id, 'eq', 1);
});

await new Promise(r => setTimeout(r, 500));
const shot3 = join(SHOT_DIR, 'after-channel-shrink.png');
await page.screenshot({ path: shot3 });
console.log('Screenshot saved:', shot3);

await app.close();

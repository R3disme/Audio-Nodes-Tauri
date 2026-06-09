// Quick smoke for the index-based engine + cycle detection. Loads the compiled
// addon directly (CommonJS) and exercises the control path:
//   - build a normal chain (input → volume → output)
//   - introduce a feedback cycle (A → B → A) — this runs recompute()/detect_cyclic
//     on the control thread on every connect; if Kahn's peel looped or panicked,
//     these calls would hang/throw.
//   - poll meters() and latencyMs() to confirm the engine is still responsive.
// Sound itself isn't asserted (headless meters read silence); this guards the
// refactor's control path, not audio.  Run: node scripts/_smoke_native_cycle.cjs

const path = require('path')
const addonPath = path.join(
  __dirname,
  '..',
  'native',
  'audio-engine',
  'audio-engine.win32-x64-msvc.node'
)

let addon
try {
  addon = require(addonPath)
} catch (e) {
  console.error('FAIL: could not load addon at', addonPath, '\n', e)
  process.exit(1)
}

const Engine = addon.NativeAudioEngine
if (!Engine) {
  console.error('FAIL: addon has no NativeAudioEngine export; keys =', Object.keys(addon))
  process.exit(1)
}

try {
  const eng = new Engine()

  // Normal acyclic chain.
  eng.createNode('in', 'input', 1, '')
  eng.createNode('vol', 'volume', 1, '')
  eng.createNode('out', 'output', 1, '')
  eng.connect('in', 0, 'vol', 0)
  eng.connect('vol', 0, 'out', 0)

  // Feedback cycle A ⇄ B (each connect re-runs recompute()/detect_cyclic).
  eng.createNode('a', 'volume', 1, '')
  eng.createNode('b', 'volume', 1, '')
  eng.connect('a', 0, 'b', 0)
  eng.connect('b', 0, 'a', 0) // closes the loop — must not hang
  eng.connect('a', 0, 'out', 0)

  // Self-loop too.
  eng.createNode('s', 'volume', 1, '')
  eng.connect('s', 0, 's', 0)

  const meters = eng.meters()
  const latency = eng.latencyMs()

  const meterCount = meters instanceof Map ? meters.size : Object.keys(meters || {}).length
  if (typeof latency !== 'number' || Number.isNaN(latency)) {
    console.error('FAIL: latencyMs() returned', latency)
    process.exit(1)
  }

  console.log(`OK: control path survived cycles. meters=${meterCount} latencyMs=${latency}`)
  process.exit(0)
} catch (e) {
  console.error('FAIL: engine threw during smoke:', e)
  process.exit(1)
}

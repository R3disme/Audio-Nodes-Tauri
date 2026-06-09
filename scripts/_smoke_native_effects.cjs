// Smoke: the 5 new native effect kinds construct, accept their params, connect, and
// the control path stays responsive (meters/latency). Sound itself is user-verified.
// Run: node scripts/_smoke_native_effects.cjs

const path = require('path')
const addon = require(path.join(__dirname, '..', 'native', 'audio-engine', 'audio-engine.win32-x64-msvc.node'))

const params = {
  filter: [['type', 0, 1], ['cutoff', 0, 800], ['q', 0, 2]],
  limiter: [['threshold', 0, -3], ['release', 0, 0.2]],
  expander: [['threshold', 0, -45], ['ratio', 0, 3], ['attack', 0, 0.005], ['release', 0, 0.2]],
  tremolo: [['mode', 0, 1], ['shape', 0, 1], ['rate', 0, 6], ['depth', 0, 0.8]],
  bitcrusher: [['bits', 0, 6], ['downsample', 0, 4], ['mix', 0, 0.9]]
}

try {
  const eng = new addon.NativeAudioEngine()
  eng.createNode('in', 'input', 1, '')
  eng.createNode('out', 'output', 1, '')
  let prev = 'in'
  for (const [type, plist] of Object.entries(params)) {
    eng.createNode(type, type, 1, '')
    for (const [p, idx, v] of plist) eng.setParam(type, p, idx, v)
    eng.connect(prev, 0, type, 0)
    prev = type
  }
  eng.connect(prev, 0, 'out', 0)

  const meters = eng.meters()
  const count = meters instanceof Map ? meters.size : Object.keys(meters || {}).length
  const lat = eng.latencyMs()
  if (typeof lat !== 'number' || Number.isNaN(lat)) throw new Error('latencyMs() bad: ' + lat)
  console.log(`OK: 5 new effect kinds wired in a chain; meters=${count} latencyMs=${lat}`)
  process.exit(0)
} catch (e) {
  console.error('FAIL:', e)
  process.exit(1)
}

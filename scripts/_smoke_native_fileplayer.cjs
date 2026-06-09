// Smoke: a 'fileplayer' node is now a fed-ring Loopback (not a silent passthrough).
// Confirms createNode('fileplayer') works and pushCapture() reaches its producer
// ring without throwing — the same bridge application capture uses.
// Run: node scripts/_smoke_native_fileplayer.cjs

const path = require('path')
const addon = require(path.join(__dirname, '..', 'native', 'audio-engine', 'audio-engine.win32-x64-msvc.node'))

try {
  const eng = new addon.NativeAudioEngine()
  eng.createNode('fp', 'fileplayer', 1, '')
  eng.createNode('out', 'output', 1, '')
  eng.connect('fp', 0, 'out', 0)

  // Feed a block of interleaved-stereo PCM into the file player's ring.
  const block = new Float32Array(2048 * 2)
  for (let i = 0; i < block.length; i++) block[i] = Math.sin(i * 0.01) * 0.5
  eng.pushCapture('fp', block)

  const meters = eng.meters()
  const count = meters instanceof Map ? meters.size : Object.keys(meters || {}).length
  console.log(`OK: fileplayer accepted pushCapture; meters=${count}`)
  process.exit(0)
} catch (e) {
  console.error('FAIL:', e)
  process.exit(1)
}

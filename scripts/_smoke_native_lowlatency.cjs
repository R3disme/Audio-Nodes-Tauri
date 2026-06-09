// Smoke: device-mode 'lowlatency' opens an output without crashing (WASAPI
// IAudioClient3 path, or graceful cpal fallback). Sound is user-verified; this only
// asserts the integration path is non-fatal and a stream comes up.
// Run: node scripts/_smoke_native_lowlatency.cjs

const path = require('path')
const addon = require(path.join(__dirname, '..', 'native', 'audio-engine', 'audio-engine.win32-x64-msvc.node'))

// Single engine so the latency number isn't polluted by device contention. Mode from
// argv (default 'exclusive' — the sub-15ms target; both input + output use WASAPI now).
const mode = process.argv[2] || 'exclusive'
;(async () => {
  try {
    const eng = new addon.NativeAudioEngine()
    eng.setDeviceMode(mode)
    eng.setLatencyMode('low')
    eng.createNode('in', 'input', 1, '')
    eng.createNode('out', 'output', 1, '')
    eng.connect('in', 0, 'out', 0)
    eng.setInputDevice('in', '')        // "" ⇒ default capture endpoint → WASAPI (or cpal fallback)
    eng.setOutputDevice('out', '')      // "" ⇒ default render endpoint → WASAPI (or cpal fallback)

    // Let the render/capture threads spin up + the cushion settle.
    await new Promise(r => setTimeout(r, 1500))
    const lat = eng.latencyMs()
    const meters = eng.meters()
    const count = meters instanceof Map ? meters.size : Object.keys(meters || {}).length
    if (typeof lat !== 'number' || Number.isNaN(lat)) throw new Error(`latencyMs() bad in ${mode}: ${lat}`)
    console.log(`OK: ${mode} in+out opened (no crash). meters=${count} latencyMs=${lat}`)
    process.exit(0)
  } catch (e) {
    console.error('FAIL:', e)
    process.exit(1)
  }
})()

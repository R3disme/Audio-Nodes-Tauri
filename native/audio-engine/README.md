# audio-engine-native

The native (Rust) audio engine for Audio Nodes, compiled to a Node-API addon and
loaded by the Electron **main** process. See `../../CLAUDE.md` and the migration
plan for the bigger picture.

## Status: Phase 0 (scaffold)

Proves the integration spine only — `renderer → IPC → main → N-API → Rust`. It
exposes `version()`, `engineInfo()`, and a `NativeAudioEngine` class with stub
device enumeration. No real audio yet.

## Build

```bash
# from this directory (installs @napi-rs/cli on first run)
npm install
npm run build          # release → audio-engine.<platform>.node + index.js/.d.ts
npm run build:debug    # faster, unoptimized
```

Or from the repo root: `npm run build:native`.

The build emits `audio-engine.<triple>.node` plus a generated `index.js` /
`index.d.ts` loader in this folder (git-ignored). The root app depends on this
package via a `file:` link, so the main process can `require('audio-engine-native')`.

## Roadmap

- **Phase 1** — cpal/WASAPI device I/O, lock-free command queue + arc-swap graph,
  fixed-block process thread, ThreadsafeFunction meter streaming. Vertical slice:
  input → volume → output + meters.
- **Phase 2** — port the DSP node types (eq, compressor, gate, mixer, pan,
  distortion, delay, chorus, reverb) + channel reconfiguration.
- **Phase 3** — WASAPI per-process loopback capture for the Source node, render
  routing for outputs, device auto-recovery.

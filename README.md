# 🎛 Audio Nodes

A node-based audio router & mixer for Windows — a fully customizable, Blender-style
alternative to the Windows volume mixer and tools like Voicemeeter. Wire **inputs**
(mics, line-in, virtual cables, per-app/window capture) through **effects** into
**outputs**, all on a visual canvas.

What sets it apart from other routers: it comes with its **own virtual audio cable**
(the *Audio Nodes Virtual Cable*, a kernel driver in this repo) and the app
**auto-detects virtual cables** — add a Virtual Output node and the cable is found,
badged and offered with zero configuration. See
[Routing to / from other apps](#-routing-to--from-other-apps-virtual-cable).

![Wired graph](screenshots/wired.png)

## ▶ Quick start (easiest)

**Double-click `start.bat`.**

On the first run it installs everything it needs and then opens the app; after that it
just launches. You don't even need to touch a terminal.

> Prefer PowerShell? Right-click `start.ps1` → **Run with PowerShell**.

## ▶ Start from a terminal

```bash
npm install   # first time only
npm start     # opens the app (hot-reload dev build)
```

| Command | What it does |
| --- | --- |
| `npm start` / `npm run dev` | Launch the app with hot reload |
| `npm run build` | Build to `out/` |
| `npm run preview` | Run the production build from `out/` |

## ✅ Requirements

- **[Node.js](https://nodejs.org) 18+** (LTS recommended) — bundles `npm`.
- **Windows 10/11** — window capture, `setSinkId` output routing and the virtual-cable
  driver are Windows-focused (the app runs elsewhere, but those features may not).

No global tooling is required for the default build; everything installs via `npm install`.

## 🎚 What's inside

- **Sources** — Input (mic / line-in), **File Player** (play a local audio file),
  **Application** (capture **one app's audio** — true per-process capture on the native
  engine: pick Spotify and only Spotify is heard, minimized apps included, listed by real
  app name like the Windows volume mixer; apps are listed **even before they start playing**,
  and the picker auto-refreshes; a "System audio" option captures everything
  except Audio Nodes itself). An **Exclusive** toggle (on by default) routes the captured
  app's own sound away from your speakers so you don't hear it twice — letting Audio Nodes
  be the app's only audio path (needs a virtual cable to park the app on)
- **Dynamics & tone** — Volume, 5-band Equalizer, Compressor, Gate, **Expander**,
  **Limiter** (brickwall), **Filter** (LP/HP/BP/notch), Pan
- **Creative / FX** — Reverb, Delay/Echo, Chorus, **Tremolo / Auto-pan**, Distortion,
  **Bitcrusher** (great for vocals & karaoke)
- **Mixing / Out** — 4-channel Mixer, **Output** (physical device),
  **Virtual Output** (route the mix into a virtual cable), **Recorder** (capture to a file)

Effect nodes are **multi-channel** (1–8 independent signal paths via the −/+ in the node
header — channel 0 never bleeds into channel 1). Sockets and wires are **color-coded by
node type** so signal flow is easy to trace. Select nodes and **group** them into a
collapsible container (**Ctrl+G**, **Ctrl+Shift+G** to ungroup) to keep big graphs tidy.

## 🗂 Workspaces (tables)

The tabs above the canvas are **independent node graphs**. Each has its own **enable/disable
toggle**, so several can run **in parallel** (keep one routing while you build another), or
sit disabled and silent. Rename, add, delete, and bulk **All on / All off**. Everything is
saved automatically and restored next launch.

## 🪟 Runs in the system tray

Audio Nodes is a background audio router: **minimize or close** and it drops to the **system
tray**, still routing audio while the UI and meters pause (so it barely uses any resources).
Click the tray icon to bring it back; **Quit** from the tray menu to fully exit.

## 🔌 Routing to / from other apps (virtual cable)

A real OS-level virtual device needs a **driver** — Windows won't let an app invent endpoints.
Audio Nodes has its own: the **Audio Nodes Virtual Cable** (a virtual *speaker* + *mic*
pair) in [`native/driver/`](native/driver/README.md). [VB-Audio Virtual
Cable](https://vb-audio.com/Cable/) works too.

**Automatic virtual inputs/outputs** — this is a headline feature, not an add-on:

- The app **enumerates and detects cables on its own** (ours by name, others — VB-Cable,
  VoiceMeeter, VAC, BlackHole… — by a heuristic). Plug-in/uninstall is picked up live via
  device-change events.
- A **Virtual Output** node's picker lists **only** virtual-cable endpoints — it can never
  grab your real speakers by mistake, and it stays silent until a cable is selected (so two
  outputs never fight over one device). When the Audio Nodes cable is present it's badged
  and preferred automatically.
- **Send your mix out:** a **Virtual Output** node plays into the cable (Playback); pick the
  cable (Recording) as the microphone in Discord / OBS / a game.
- **Pull audio in:** set another app's speaker to the cable (Playback); add an **Input**
  node on the cable (Recording) to bring that audio into your graph. (For pulling a
  single app's audio in, the **Application node** on the native engine does true
  per-process capture with no cable needed; the cable route remains useful on the Web
  Audio engine, where loopback capture is all-or-nothing.)

### Driver status: build it yourself

The driver is open source and **built from source on your machine**
(Visual Studio 2022 + the Windows Driver Kit, test-signed — see
[`native/driver/README.md`](native/driver/README.md) for the 3-command build). It's a
rebrand of the MIT [`VirtualDrivers/Virtual-Audio-Driver`](https://github.com/VirtualDrivers/Virtual-Audio-Driver),
vendored as a git submodule — run `git submodule update --init --recursive` after cloning.
**Settings ▸ Driver** has **Build** and **Install** buttons that run those scripts for you
(Build streams its output in-app; Install launches an elevated PowerShell).

A pre-built driver isn't shipped: one that installs on stock Windows (no test mode)
requires Microsoft **attestation signing**, which needs a paid EV certificate + a Partner
Center account — kernel drivers can't use ordinary code-signing, and the upstream
project's releases are test-signed too. The exact pipeline is documented in
[`native/driver/README.md` → Distribution](native/driver/README.md#distribution-shipping-to-other-machines)
should that ever change. [VB-Cable](https://vb-audio.com/Cable/) is the zero-build
alternative the app detects out of the box.

## ⚡ Engines: Native (Rust) & Web Audio

Audio Nodes runs on a **native Rust audio engine** (`native/audio-engine/`) by **default**, for
lower overhead and real, *measured* device latency. The **Web Audio** engine is the fully-featured
fallback — switch between them anytime in the Settings panel.

```bash
npm run build:native     # compile the Rust addon (needs the Rust toolchain)
```

- If the addon **isn't built**, the app **transparently uses Web Audio** for that session — so
  `start.bat` always has sound; build the addon to unlock the native engine.
- **Every node works on both engines** — File Player, Recorder and Application capture are all
  ported to native. Mismatched input/output sample rates are handled by a built-in resampler.
- **Latency modes** (Settings → Audio): the input cushion **self-tunes**, and you pick its range
  with **Low / Balanced / Safe**. An **Output backend** option adds WASAPI **low-latency** and
  **exclusive** modes (exclusive bypasses the Windows mixer for the lowest latency on capable
  hardware, but locks the device); both fall back to the shared path automatically.

## 🎨 Theming

Open the palette button in the toolbar:

- **Simple** — pick one accent color; background, panels, text and a node palette are derived.
- **Advanced** — fine-tune every interface token and each node color.
- **Picture** — generate a palette from an image (optionally shown as the canvas background;
  **animated GIFs/WebP keep animating**). Any common image format works.

There's also a **node-scale** slider, a hideable add-node panel, and per-node recolor (click
the color dot in a node header; right-click to reset).

## 🧩 Workflow

- **Presets** (toolbar) — one-click starting graphs: Mic→Speakers, Podcast, Karaoke, Streaming.
- **Export / Import** (toolbar) — save the whole config (all workspaces + theme) to a `.json`.
- **Guide** (toolbar `?`) — an in-app visual walkthrough.
- **Latency** — the toolbar shows the **measured** input→output latency; tune it in Settings → Audio.
- **Auto-recovery** — dropped input devices reconnect when they return (matched by name even if the
  device id changed); outputs re-bind their device.

## 🧪 End-to-end checks

```bash
npm run build
node scripts/check-errors.mjs   # adds every node type, asserts no console errors/warnings
node scripts/screenshot.mjs     # wires a demo graph, writes screenshots/
```

## 🛠 Stack

Tauri + Vite · React 18 + TypeScript (strict) · @xyflow/react (canvas) · Zustand ·
Web Audio API · Tailwind CSS · Rust audio engine · WDM/PortCls driver

## 📁 Project layout

```
src-tauri/     Tauri shell and Rust commands (window, tray, driver, audio bridge)
src/
  renderer/src/
    audio/        AudioEngine (Web Audio) + NativeEngine (Rust IPC) behind an AudioBackend seam
    components/   Toolbar, Sidebar, WorkspaceBar, NodeEditor, SettingsPanel, VU meters, nodes/
    platform/     Renderer bridge that exposes the legacy window.api surface on top of Tauri
    lib/          color/theme math, node colors, persistence
    store/        Zustand stores (audio graph + workspaces, settings/theme)
native/
  audio-engine/  Rust napi-rs audio engine (beta; build with npm run build:native)
  driver/        Audio Nodes Virtual Cable — fork+rebrand of an MIT virtual audio driver
scripts/         Playwright e2e (screenshot + error check)
```

## 📄 License

[MIT](LICENSE). The vendored driver under `native/driver/vendor/` is MIT (see its `LICENSE`).

# 🎛 Audio Nodes

A node-based audio mixer for Windows — a fully customizable, Blender-style alternative
to the Windows volume mixer and tools like Voicemeeter. Wire **inputs** (mics, line-in,
per-app/window capture) through **effects** into **outputs**, all on a visual canvas.

![Wired graph](screenshots/wired.png)

## ▶ Quick start (easiest)

**Double-click `start.bat`.**

On the first run it installs everything it needs and then opens the app; after that it
just launches. That's it — you don't need to touch a terminal.

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
- **Windows 10/11** — application/window capture and `setSinkId` output routing are
  Windows-focused (the app runs on other platforms, but those features may not).
- *(Optional)* **[VB-Audio Virtual Cable](https://vb-audio.com/Cable/)** or similar — only
  needed for the **Virtual Output** node and true per-app input isolation.

No global tooling is required; everything is installed locally via `npm install`.

## 📦 Dependencies

Installed automatically by `npm install`. Pinned versions live in `package.json` /
`package-lock.json`.

**Runtime**

| Package | Purpose |
| --- | --- |
| `react`, `react-dom` | UI |
| `@xyflow/react` | Node-graph canvas |
| `zustand` | State management (graph + settings) |
| `lucide-react` | Icons |
| `@electron-toolkit/preload`, `@electron-toolkit/utils` | Electron helpers |
| `playwright-core` | Drives the app for the e2e screenshot/error scripts |

**Dev / build**

| Package | Purpose |
| --- | --- |
| `electron`, `electron-vite` | Desktop shell + bundler |
| `typescript` | Type checking |
| `@vitejs/plugin-react` | React fast refresh |
| `tailwindcss`, `postcss`, `autoprefixer` | Styling |
| `@types/*` | Type definitions |

## 🎚 What's inside

- **Sources** — Input (mic / line-in), Application (capture a window's audio)
- **Effects** — Volume, 5-band Equalizer, Compressor, Gate, Pan
- **Creative / FX** — Reverb, Delay/Echo, Chorus, Distortion (great for vocals & karaoke)
- **Mixing / Out** — 4-channel Mixer, **Output** (physical monitor device),
  **Virtual Output** (route the mix to a virtual cable so other apps can use it)

Effect nodes are **multi-channel** (1–8 independent signal paths via the +/- in the node
header). Sockets and connection lines are **color-coded by node type** so signal flow is
easy to trace. Your graph (nodes, positions, parameters, connections) is **saved
automatically** and restored next launch.

## 🎨 Theming

Open the palette button in the toolbar to recolor the whole app:

- **Simple** — pick one accent color; the background, panels, text and a distinct node
  palette are auto-derived.
- **Advanced** — fine-tune every interface token and each node color.
- **Picture** — generate a palette from an image, and optionally show that image as the
  canvas background (with an opacity control).

There's also a **node scale** slider, and the **add-node panel collapses** to a slim rail.
Click the **color dot** in any node's header to recolor just that node (right-click to reset).

## 🧩 Workflow

- **Presets** (toolbar) — one-click starting graphs: Mic→Speakers, Podcast chain, Karaoke, Streaming mix.
- **Export / Import** (toolbar) — save the whole config (graph + theme) to a `.json` file and load it back or share it.
- **Guide** (toolbar `?`) — in-app help.
- **Latency** — the toolbar shows the estimated input→output latency.
- **Auto-recovery** — if an input device drops out (unplugged / default changed) the node reconnects when it returns, and outputs re-bind their device automatically.

> **Virtual devices:** creating a real OS-level virtual input/output that other apps see
> requires an audio **driver** — Windows doesn't let an app invent endpoints. Install
> [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (free); a **Virtual Output** node
> then feeds that cable so other apps can capture your mix.

### Tips
- Click a node in the sidebar to drop it on the canvas, or drag it where you want.
- Drag from an **output** socket (right) to an **input** socket (left) to connect.
- Select a node/edge and press **Delete** to remove it.
- For true **per-application isolation**, route the app through a virtual audio cable
  (e.g. VB-Audio Virtual Cable) and pick it as an **Input** device — Windows loopback
  capture otherwise grabs all system audio.

## 🧪 End-to-end checks

```bash
npm run build
node scripts/check-errors.mjs   # builds every node type, asserts no console errors
node scripts/screenshot.mjs     # wires a demo graph, writes screenshots/
```

## 🛠 Stack

Electron + electron-vite · React 18 + TypeScript (strict) · @xyflow/react (canvas) ·
Zustand · Web Audio API · Tailwind CSS

## 📁 Project layout

```
src/
  main/        Electron main process (window, desktopCapturer, display-media handler)
  preload/     Context-isolated IPC bridge
  renderer/
    src/
      audio/        AudioEngine — the Web Audio graph + effects
      components/   Toolbar, Sidebar, NodeEditor, ThemePanel, VU meters, nodes/
      lib/          color/theme math, node colors, persistence
      store/        Zustand stores (audio graph, settings/theme)
scripts/         Playwright e2e (screenshot + error check)
```

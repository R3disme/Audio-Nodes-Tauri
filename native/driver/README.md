# Audio Nodes Virtual Cable (kernel driver)

The **virtual audio device** that lets *other* apps route audio **into and out of
Audio Nodes** without VB‑Cable. It installs two endpoints:

- **"Audio Nodes Virtual Cable (Playback)"** — other apps (a game, Spotify, a
  browser) select this as their **speaker**; whatever they play lands in the cable.
- **"Audio Nodes Virtual Cable (Recording)"** — Audio Nodes (or Discord/OBS/…)
  selects this as a **microphone/input** and receives that audio.

Audio Nodes auto‑detects these endpoints (the Rust engine enumerates them via
WASAPI; the **Virtual Output** / **Input** nodes pick them up with no extra setup).

## How this is built (fork + rebrand, not from scratch)

Rather than hand‑write a WaveRT miniport, we **vendor a maintained, MIT‑licensed
driver** and rebrand it:

- `vendor/Virtual-Audio-Driver/` — git **submodule**, pinned to upstream
  [`VirtualDrivers/Virtual-Audio-Driver`](https://github.com/VirtualDrivers/Virtual-Audio-Driver)
  (SYSVAD‑derived; provides a virtual speaker + mic). We never edit it.
- `rebrand/` — `rebrand.ps1` + `names.psd1` copy the submodule into `build/` and
  stamp **only display strings + the hardware id** (→ "Audio Nodes Virtual Cable",
  `ROOT\AudioNodesVirtualCable`). No structural/GUID/service changes, so it builds
  and installs exactly like upstream.
- `build.ps1` — submodule → rebrand → `msbuild` → test‑cert → `Inf2Cat` + `signtool`
  → staged in `out/`.
- `install.ps1` / `uninstall.ps1` — trust the cert + `pnputil` install/remove.
- `build/`, `out/` are generated (git‑ignored).

> **Signing reality.** A kernel driver won't load unsigned. For **your own machine**
> we **test‑sign** (free). To install on **other people's** machines without test
> mode you must **attestation‑sign** via Partner Center, which still requires an
> **EV certificate (~$300/yr)** — Azure Trusted Signing does *not* cover drivers.
> See [Distribution](#distribution-shipping-to-other-machines).

## Prerequisites

- **Visual Studio 2022** with **Desktop development with C++**.
- **Windows Driver Kit (WDK)** for VS2022 (+ the WDK VS extension, for
  `Inf2Cat`/`StampInf`). The upstream CI installs it via
  `choco install windowsdriverkit11`.
- Git (to fetch the submodule).

## Build + install (test‑signed, your machine)

```powershell
# 0) one‑time: enable test signing (reboots; shows a "Test Mode" watermark)
bcdedit /set testsigning on      # elevated; reboot

# 1) get the upstream submodule (first checkout only)
git submodule update --init --recursive

# 2) build + test‑sign  → native/driver/out/
./build.ps1                      # Release x64

# 3) trust the cert + install   (ELEVATED PowerShell)
./install.ps1
```

The two endpoints appear in **Settings ▸ System ▸ Sound** and in any app's device
picker. To remove:

```powershell
./uninstall.ps1                  # elevated
bcdedit /set testsigning off     # optional, when you're done; reboot
```

If `pnputil` install is ever finicky, the manual fallback is **Device Manager ▸
Action ▸ Add legacy hardware ▸ … ▸ Have Disk ▸** `native/driver/out/VirtualAudioDriver.inf`.

## Using it in Audio Nodes

1. Add a **Virtual Output** node → pick **Audio Nodes Virtual Cable (Playback)**.
   In another app (Discord/OBS) choose **Audio Nodes Virtual Cable (Recording)** as
   its mic → it hears your Audio Nodes mix.
2. To pull another app's audio *in*, set that app's speaker to **…(Playback)** and
   add an **Input** node on **…(Recording)**.

The **Virtual Output** node badges our cable when it's detected. (Per‑app capture
*into* Audio Nodes will also be possible driver‑free via WASAPI per‑process
loopback — Rust engine Phase 3.)

## Distribution (shipping to other machines)

**Decision (2026‑06): not pursued — users build the driver themselves** (the EV
cert + Partner Center cost isn't justified right now). This section stays as the
reference pipeline should that ever change; it is a **money/paperwork problem, not
a code problem** — the build below is already the exact artifact that would be
submitted.

**The signing landscape (researched 2026‑06; re‑verify before acting):**

- Test signing only works on machines with test mode enabled (`bcdedit
  /set testsigning on`, reboot, "Test Mode" watermark) — fine for developers,
  unacceptable for end users.
- **There is no free route.** Windows 10/11 (Secure Boot) only loads kernel drivers
  countersigned by Microsoft (**attestation signing** or full WHQL) via the
  **Partner Center / Hardware Dev Center**, and registering there requires an
  **EV code‑signing certificate** (~$250–400/yr depending on CA). **Azure Trusted
  Signing (~$10/mo) explicitly does NOT cover kernel‑mode drivers** and is not
  accepted for Hardware Program registration.
- **Upstream doesn't solve it for us either:** `VirtualDrivers/Virtual-Audio-Driver`
  releases carry a SignPath.io authenticode signature, but that is *not* Microsoft
  attestation — their own README still requires test mode. So bundling upstream's
  release buys nothing, and rebranding would invalidate their signature anyway.

**Pipeline once an EV cert + Partner Center account exist:**

1. Register the EV cert with the Partner Center hardware account (one‑time).
2. `./build.ps1` as today, but **EV‑sign** the `.sys`/`.cat` instead of the test
   cert, pack `out/` into a `.cab` (`makecab /f`), EV‑sign the cab.
3. Submit the cab for **attestation signing**; Microsoft returns a countersigned
   package that installs on any Windows 10/11 x64 machine with **no test mode**.
   (Attestation covers Win10/11 desktop; Windows Server would need full WHQL/HLK.)
4. Ship it: publish the signed package as a GitHub release asset, and/or bundle it
   in a packaged installer (electron‑builder/NSIS) with an elevated
   `pnputil /add-driver VirtualAudioDriver.inf /install` step. The app already
   auto‑detects the endpoints, so no app change is needed.
5. Repeat 2–3 per driver release (each new binary needs its own attestation pass —
   another reason the submodule stays pinned).

**Until then:** users either build + test‑sign locally (above), or install
[VB‑Cable](https://vb-audio.com/Cable/) — the app's cable detection covers it out
of the box.

## Notes & caveats

- Upstream is **beta** and the submodule is **pinned** (tag `25.7.14`). Re‑test
  after bumping it.
- Don't run our cable **and** an upstream "Virtual Audio Driver" at the same time —
  they share the service binary name; uninstall one first. (We already give ours a
  distinct hardware id.)
- The shared‑mode format upstream exposes is fine; the Rust engine resamples to its
  master rate (Phase 3). Don't resample in the driver.
- License: upstream is MIT (see `vendor/Virtual-Audio-Driver/LICENSE`); our rebrand
  scripts add no kernel code.

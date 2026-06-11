// ────────────────────────────────────────────────────────────────────────────
// Per-process application capture (Windows 10 2004+).
//
// Replaces the renderer's getDisplayMedia bridge for the Application node on the
// native engine, fixing its three structural problems at once:
//   1. Chromium loopback hears ALL system audio (picking File Explorer still
//      captured Spotify) — WASAPI *process loopback* captures only the chosen
//      process tree.
//   2. desktopCapturer can't enumerate minimized windows — *audio sessions* list
//      every app currently rendering audio (the same data the Windows volume
//      mixer shows), window state irrelevant.
//   3. Window titles aren't app names (terminal → cwd, browser → tab, Spotify →
//      song) — we name apps from their executable.
//
// Two pieces:
//   - `list_audio_apps()`  — enumerate the default render endpoint's sessions →
//     `{ pid, name, exe, active }` per app.
//   - `ProcessCapture`     — ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_
//     PROCESS_LOOPBACK) with INCLUDE_TARGET_PROCESS_TREE for one app, or
//     EXCLUDE of *our own* process for pid 0 ("System audio" — everything except
//     Audio Nodes, so routing it to an output can't feed back). The event-driven
//     capture thread feeds the application node's ring exactly like a capture
//     device (same down-mix + linear resampler as `wasapi::capture_thread`).
//
// Safety: unsafe COM, mirroring engine/wasapi.rs — all COM objects are created
// on and confined to the capture thread; every fallible call surfaces an `Err`
// so the control thread can report failure (the renderer keeps the legacy
// all-system bridge as a fallback path for old saved graphs).
// ────────────────────────────────────────────────────────────────────────────

#![allow(clippy::missing_safety_doc)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::core::{implement, Interface, PWSTR};
use windows::Win32::Foundation::{CloseHandle, FALSE, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW,
    WaitForSingleObject, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    GW_OWNER,
};

use ringbuf::traits::{Producer, Split};
use ringbuf::{HeapProd, HeapRb};

use super::wasapi::MmcssGuard;
use super::{Shared, MAX_BLOCK_FRAMES, RING_FRAMES};

// ── Session enumeration ──────────────────────────────────────────────────────

/// One app with a live audio session on the default render device.
#[derive(Clone, Debug)]
pub struct AudioApp {
    pub pid: u32,
    /// Friendly name derived from the executable ("Spotify", "Chrome", …).
    pub name: String,
    /// Executable file name ("spotify.exe") — the stable identity used to
    /// re-resolve the pid when the app restarts.
    pub exe: String,
    /// Whether the session is actively rendering right now (volume-mixer "lit").
    pub active: bool,
}

/// Enumerate apps with audio sessions on the default render endpoint. Runs the
/// COM work on a short-lived MTA thread so the (napi) caller's COM state is
/// never touched. Best-effort: any failure returns an empty list.
pub fn list_audio_apps() -> Vec<AudioApp> {
    thread::Builder::new()
        .name("audio-sessions".into())
        .spawn(|| unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                return Vec::new();
            }
            let apps = enumerate_sessions().unwrap_or_default();
            CoUninitialize();
            apps
        })
        .ok()
        .and_then(|h| h.join().ok())
        .unwrap_or_default()
}

unsafe fn enumerate_sessions() -> Result<Vec<AudioApp>, String> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| e.to_string())?;
    let mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
    let sessions = mgr.GetSessionEnumerator().map_err(|e| e.to_string())?;
    let count = sessions.GetCount().map_err(|e| e.to_string())?;
    let me = GetCurrentProcessId();

    // One entry per process (a process can hold several sessions); active if any is.
    let mut by_pid: std::collections::HashMap<u32, AudioApp> = std::collections::HashMap::new();
    for i in 0..count {
        let Ok(ctl) = sessions.GetSession(i) else { continue };
        let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
        if ctl2.IsSystemSoundsSession().0 == 0 {
            continue; // S_OK (not S_FALSE) ⇒ the "System Sounds" pseudo-session
        }
        let pid = ctl2.GetProcessId().unwrap_or(0);
        if pid == 0 || pid == me {
            continue;
        }
        let active = ctl
            .GetState()
            .map(|s| s == AudioSessionStateActive)
            .unwrap_or(false);
        let entry = by_pid.entry(pid).or_insert_with(|| {
            let exe = process_exe(pid).unwrap_or_default();
            AudioApp { pid, name: pretty_name(&exe), exe, active: false }
        });
        entry.active |= active;
    }

    // Also list apps that have a visible window but no audio session yet, so an
    // app shows up *before* it starts playing (e.g. Spotify just opened). Process
    // loopback can be armed on these — audio flows once they render. Session apps
    // (with their `active` flag + correct name) win on pid collisions.
    for pid in enumerate_window_pids() {
        if pid == me || by_pid.contains_key(&pid) {
            continue;
        }
        if let Some(exe) = process_exe(pid) {
            by_pid.insert(pid, AudioApp { pid, name: pretty_name(&exe), exe, active: false });
        }
    }

    let mut apps: Vec<AudioApp> = by_pid.into_values().filter(|a| !a.exe.is_empty()).collect();
    // Actively-playing apps first, then alphabetical — mirrors what users expect
    // from the volume mixer.
    apps.sort_by(|a, b| b.active.cmp(&a.active).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(apps)
}

/// Pids of processes owning a visible, titled, top-level window (no owner window),
/// deduped. Skips tool/child windows so the list reads like a taskbar.
unsafe fn enumerate_window_pids() -> Vec<u32> {
    let mut pids: Vec<u32> = Vec::new();
    let _ = EnumWindows(Some(enum_windows_proc), LPARAM(&mut pids as *mut Vec<u32> as isize));
    pids.sort_unstable();
    pids.dedup();
    pids
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let visible = IsWindowVisible(hwnd).as_bool();
    let titled = GetWindowTextLengthW(hwnd) > 0;
    let top_level = GetWindow(hwnd, GW_OWNER).0 == 0; // no owner ⇒ a real app window
    if visible && titled && top_level {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            let pids = &mut *(lparam.0 as *mut Vec<u32>);
            pids.push(pid);
        }
    }
    TRUE
}

/// Executable file name ("spotify.exe") for a pid, or None if unqueryable.
unsafe fn process_exe(pid: u32) -> Option<String> {
    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid).ok()?;
    let mut buf = [0u16; 600];
    let mut len = buf.len() as u32;
    let res = QueryFullProcessImageNameW(h, PROCESS_NAME_FORMAT(0), PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(h);
    res.ok()?;
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    path.rsplit(['\\', '/']).next().map(|s| s.to_string()).filter(|s| !s.is_empty())
}

/// "spotify.exe" → "Spotify". Good enough for a picker label; the exe name is
/// shown alongside so nothing is ambiguous.
fn pretty_name(exe: &str) -> String {
    let stem = exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe);
    let mut chars = stem.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

// ── Process-loopback capture ─────────────────────────────────────────────────

/// Handle to a running process-loopback capture thread. Dropping it stops + joins.
pub struct ProcessCapture {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl ProcessCapture {
    /// Start capturing `pid`'s process tree (or, for `pid == 0`, everything
    /// *except* Audio Nodes itself) into `node_id`'s ring. The node's consumer is
    /// only swapped in once init succeeds, so failure leaves the node untouched.
    /// `takeover` additionally parks the app's own render endpoint on a virtual
    /// sink while captured (no duplicate through the speakers); best-effort.
    pub fn start(
        shared: Arc<Shared>,
        node_id: String,
        pid: u32,
        takeover: bool,
    ) -> Result<ProcessCapture, String> {
        let rb = HeapRb::<f32>::new(RING_FRAMES * 2);
        let (prod, cons) = rb.split();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let (tx, rx) = sync_channel::<Result<(), String>>(1);
        let sh = shared.clone();
        let nid = node_id.clone();
        let handle = thread::Builder::new()
            .name("proc-loopback".into())
            .spawn(move || unsafe { capture_thread(sh, nid, pid, takeover, prod, stop_t, tx) })
            .map_err(|e| e.to_string())?;

        match rx.recv() {
            Ok(Ok(())) => {
                if let Some(node) = shared.nodes.lock().unwrap().get(&node_id) {
                    *node.consumer.lock().unwrap() = Some(cons);
                    node.primed.store(false, Ordering::Relaxed); // re-cushion on the new ring
                }
                Ok(ProcessCapture { stop, handle: Some(handle) })
            }
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(e) => {
                let _ = handle.join();
                Err(e.to_string())
            }
        }
    }
}

impl Drop for ProcessCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Signals the sync activation waiter when the async COM activation completes.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler(SyncSender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler {
    fn ActivateCompleted(
        &self,
        _op: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

/// Raw VT_BLOB PROPVARIANT layout. windows-core 0.54's typed `PROPVARIANT` has no
/// blob constructor, and `ActivateAudioInterfaceAsync` only reads the pointer
/// synchronously, so a correctly-laid-out stack struct cast to the expected
/// pointer type is the simplest correct encoding.
#[repr(C)]
struct PropVariantBlob {
    vt: u16, // VT_BLOB = 65
    r1: u16,
    r2: u16,
    r3: u16,
    cb_size: u32,
    p_blob_data: *mut u8,
}

struct LoopbackCtx {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: HANDLE,
    sr: f32,
    nch: usize,
    is_float: bool,
}

unsafe fn capture_thread(
    shared: Arc<Shared>,
    node_id: String,
    pid: u32,
    takeover: bool,
    mut prod: HeapProd<f32>,
    stop: Arc<AtomicBool>,
    tx: SyncSender<Result<(), String>>,
) {
    if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
        let _ = tx.send(Err("CoInitializeEx failed".into()));
        return;
    }
    let ctx = match init_process_loopback(&shared, pid) {
        Ok(c) => {
            let _ = tx.send(Ok(()));
            c
        }
        Err(e) => {
            let _ = tx.send(Err(e));
            CoUninitialize();
            return;
        }
    };

    // Park the app's own output while we capture it (restored when this thread
    // ends — node removed, target changed, engine shutdown). pid 0 (system
    // audio) has no single app to park.
    let _takeover_guard = if takeover && pid != 0 {
        let exclude: Vec<String> = shared
            .open_streams
            .lock()
            .unwrap()
            .values()
            .map(|s| s.device_id.clone())
            .filter(|d| !d.is_empty() && !d.starts_with("pid:"))
            .collect();
        match TakeoverGuard::apply(pid, &exclude) {
            Ok((g, name)) => {
                eprintln!("[audio] takeover: pid {pid} parked on '{name}' while captured");
                Some(g)
            }
            Err(e) => {
                eprintln!("[audio] takeover unavailable for pid {pid}: {e}");
                None
            }
        }
    } else {
        None
    };

    let _mmcss = MmcssGuard::register();
    let node = shared.nodes.lock().unwrap().get(&node_id).cloned();
    if let Some(n) = &node {
        // Process loopback has no physical device buffer; report the share-mode
        // buffer depth so the latency readout stays honest.
        if let Ok(frames) = ctx.client.GetBufferSize() {
            n.dev_latency.store((frames as f32 / ctx.sr * 1000.0).to_bits(), Ordering::Relaxed);
        }
    }

    // Down-mix + linear resampler state (capture rate → master), mirroring
    // wasapi::capture_thread.
    let mut prev_l = 0.0f32;
    let mut prev_r = 0.0f32;
    let mut pos = 0.0f32;
    let mut dev: Vec<f32> = Vec::with_capacity(MAX_BLOCK_FRAMES * 2);
    let mut out: Vec<f32> = Vec::with_capacity(MAX_BLOCK_FRAMES * 4);

    while !stop.load(Ordering::Relaxed) {
        // Process loopback only signals while the target renders audio — the 200 ms
        // timeout keeps the stop flag responsive through silence.
        if WaitForSingleObject(ctx.event, 200) != WAIT_OBJECT_0 {
            continue;
        }
        loop {
            let avail = match ctx.capture.GetNextPacketSize() {
                Ok(n) => n,
                Err(_) => break,
            };
            if avail == 0 {
                break;
            }
            let mut pdata: *mut u8 = std::ptr::null_mut();
            let mut nframes: u32 = 0;
            let mut flags: u32 = 0;
            if ctx.capture.GetBuffer(&mut pdata, &mut nframes, &mut flags, None, None).is_err() {
                break;
            }
            let n = nframes as usize;
            let silent = (flags & 0x2) != 0; // AUDCLNT_BUFFERFLAGS_SILENT
            let master = shared.sr.load(Ordering::Relaxed) as f32;

            dev.clear();
            if n > 0 {
                if silent || pdata.is_null() {
                    dev.resize(n * ctx.nch, 0.0);
                } else if ctx.is_float {
                    dev.extend_from_slice(std::slice::from_raw_parts(pdata as *const f32, n * ctx.nch));
                } else {
                    let s = std::slice::from_raw_parts(pdata as *const i16, n * ctx.nch);
                    dev.extend(s.iter().map(|&v| v as f32 / 32768.0));
                }
            }

            out.clear();
            let matched = master < 1.0 || (master - ctx.sr).abs() <= 0.5;
            if matched {
                for i in 0..n {
                    let b = i * ctx.nch;
                    let l = dev[b];
                    let r = if ctx.nch >= 2 { dev[b + 1] } else { l };
                    out.push(l);
                    out.push(r);
                }
                if n > 0 {
                    let b = (n - 1) * ctx.nch;
                    prev_l = dev[b];
                    prev_r = if ctx.nch >= 2 { dev[b + 1] } else { prev_l };
                }
                pos = 0.0;
            } else {
                let step = ctx.sr / master;
                for i in 0..n {
                    let b = i * ctx.nch;
                    let cur_l = dev[b];
                    let cur_r = if ctx.nch >= 2 { dev[b + 1] } else { cur_l };
                    while pos < 1.0 {
                        out.push(prev_l + (cur_l - prev_l) * pos);
                        out.push(prev_r + (cur_r - prev_r) * pos);
                        pos += step;
                    }
                    pos -= 1.0;
                    prev_l = cur_l;
                    prev_r = cur_r;
                }
            }
            if !out.is_empty() {
                if let Some(nd) = &node {
                    nd.block_frames
                        .store((out.len() / 2).min(MAX_BLOCK_FRAMES) as u32, Ordering::Relaxed);
                }
                let _ = prod.push_slice(&out);
            }
            let _ = ctx.capture.ReleaseBuffer(nframes);
        }
    }

    let _ = ctx.client.Stop();
    let _ = CloseHandle(ctx.event);
    drop(ctx);
    CoUninitialize();
}

/// Activate an IAudioClient on the process-loopback virtual device and start an
/// event-driven capture stream. We *define* the capture format (the virtual
/// device has no mix format): stereo at the engine master rate (or 48 kHz before
/// the first output opens), float first, 16-bit PCM retry.
unsafe fn init_process_loopback(shared: &Arc<Shared>, pid: u32) -> Result<LoopbackCtx, String> {
    let (target, mode) = if pid == 0 {
        // "System audio": everything except our own process tree, so a graph that
        // routes this capture to a speaker can't feed back into itself.
        (GetCurrentProcessId(), PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE)
    } else {
        (pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE)
    };
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: target,
                ProcessLoopbackMode: mode,
            },
        },
    };
    let pv = PropVariantBlob {
        vt: 65, // VT_BLOB
        r1: 0,
        r2: 0,
        r3: 0,
        cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        p_blob_data: &params as *const _ as *mut u8,
    };

    let (done_tx, done_rx) = sync_channel::<()>(1);
    let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler(done_tx).into();
    let op = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&pv as *const _ as *const windows::core::PROPVARIANT),
        &handler,
    )
    .map_err(|e| format!("ActivateAudioInterfaceAsync failed: {e}"))?;
    done_rx
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "process-loopback activation timed out".to_string())?;

    let mut hr = windows::core::HRESULT(0);
    let mut iface: Option<windows::core::IUnknown> = None;
    op.GetActivateResult(&mut hr, &mut iface).map_err(|e| e.to_string())?;
    hr.ok().map_err(|e| format!("activation result: {e}"))?;
    let client: IAudioClient = iface
        .ok_or("no activated interface")?
        .cast()
        .map_err(|e: windows::core::Error| e.to_string())?;

    // Try float stereo first, then 16-bit PCM (both at the chosen rate).
    let master = shared.sr.load(Ordering::Relaxed);
    let sr = if master >= 8000 { master } else { 48000 };
    let mut is_float = true;
    let fmt_f32 = pcm_format(sr, 2, 32, true);
    let init = client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        200_000, // 20 ms buffer (the loopback engine ignores periodicity in shared mode)
        0,
        &fmt_f32,
        None,
    );
    if let Err(e_f32) = init {
        is_float = false;
        let fmt_i16 = pcm_format(sr, 2, 16, false);
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                200_000,
                0,
                &fmt_i16,
                None,
            )
            .map_err(|e| format!("Initialize failed (float: {e_f32}; i16: {e})"))?;
    }

    let event = CreateEventW(None, FALSE, FALSE, windows::core::PCWSTR::null())
        .map_err(|e| e.to_string())?;
    client.SetEventHandle(event).map_err(|e| e.to_string())?;
    let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
    client.Start().map_err(|e| e.to_string())?;

    Ok(LoopbackCtx { client, capture, event, sr: sr as f32, nch: 2, is_float })
}

fn pcm_format(sr: u32, nch: u16, bits: u16, float: bool) -> WAVEFORMATEX {
    let block_align = nch * bits / 8;
    WAVEFORMATEX {
        wFormatTag: if float { 3 } else { 1 }, // IEEE_FLOAT / PCM
        nChannels: nch,
        nSamplesPerSec: sr,
        nAvgBytesPerSec: sr * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits,
        cbSize: 0,
    }
}

// ── App takeover: per-app endpoint redirect ──────────────────────────────────
//
// Process loopback *taps* an app's audio — Windows still mixes the app to the
// speakers, so a captured app is heard twice (direct + through the graph).
// Verified: muting the app's session silences the capture too (the tap is
// post-session-volume), so the only clean takeover is **redirecting the app's
// render endpoint** away from the speakers — the same per-app routing Windows
// Settings ▸ App volume preferences / EarTrumpet / SteelSeries Sonar use, via
// the undocumented `IAudioPolicyConfigFactory` (Windows.Media.Internal.
// AudioPolicyConfig; two IIDs — 21H2+ and downlevel — mirroring EarTrumpet).
// Process loopback is endpoint-independent (documented), so capture is
// unaffected while the app renders silently into the parking endpoint.
//
// The parking endpoint must be inaudible: only known virtual sinks qualify
// (Audio Nodes Virtual Cable preferred, then VB-Cable/VoiceMeeter), minus any
// endpoint an Output node is currently using (parked audio would contaminate
// the mix that cable carries). No cable ⇒ no takeover (capture still works,
// with the duplicate; the UI says why).
//
// The redirect is **persisted by Windows per app path** (that's the API's
// contract), so it survives app restarts — takeover continuity for free — but a
// hard crash of Audio Nodes can leave an app parked. Every clean stop restores
// the default; a stranded app is fixable under Windows Settings ▸ Sound ▸ App
// volume preferences.

use windows::core::{interface, IUnknown, IUnknown_Vtbl, HRESULT, HSTRING};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{IMMDeviceCollection, DEVICE_STATE_ACTIVE};
use windows::Win32::System::Com::STGM_READ;
use windows::Win32::System::WinRT::RoGetActivationFactory;

/// `{e6327cad-dcec-4949-ae8a-991e976a79d2}` = DEVINTERFACE_AUDIO_RENDER.
const RENDER_IFACE_SUFFIX: &str = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
const POLICY_CONFIG_CLASS: &str = "Windows.Media.Internal.AudioPolicyConfig";

// Vtable mirrors EarTrumpet's IAudioPolicyConfigFactoryVariantFor21H2: IUnknown,
// 3 IInspectable slots, 19 unused slots, then the 3 real methods. Placeholders
// exist only to keep the real methods at the correct vtable offsets.
macro_rules! policy_factory_iface {
    ($name:ident, $guid:literal) => {
        #[interface($guid)]
        unsafe trait $name: IUnknown {
            unsafe fn _iids(&self) -> HRESULT;
            unsafe fn _runtime_class_name(&self) -> HRESULT;
            unsafe fn _trust_level(&self) -> HRESULT;
            unsafe fn _s04(&self) -> HRESULT;
            unsafe fn _s05(&self) -> HRESULT;
            unsafe fn _s06(&self) -> HRESULT;
            unsafe fn _s07(&self) -> HRESULT;
            unsafe fn _s08(&self) -> HRESULT;
            unsafe fn _s09(&self) -> HRESULT;
            unsafe fn _s10(&self) -> HRESULT;
            unsafe fn _s11(&self) -> HRESULT;
            unsafe fn _s12(&self) -> HRESULT;
            unsafe fn _s13(&self) -> HRESULT;
            unsafe fn _s14(&self) -> HRESULT;
            unsafe fn _s15(&self) -> HRESULT;
            unsafe fn _s16(&self) -> HRESULT;
            unsafe fn _s17(&self) -> HRESULT;
            unsafe fn _s18(&self) -> HRESULT;
            unsafe fn _s19(&self) -> HRESULT;
            unsafe fn _s20(&self) -> HRESULT;
            unsafe fn _s21(&self) -> HRESULT;
            unsafe fn _s22(&self) -> HRESULT;
            unsafe fn set_persisted_default_audio_endpoint(
                &self,
                process_id: u32,
                flow: i32,
                role: i32,
                device_id: *mut core::ffi::c_void,
            ) -> HRESULT;
            unsafe fn get_persisted_default_audio_endpoint(
                &self,
                process_id: u32,
                flow: i32,
                role: i32,
                device_id: *mut *mut core::ffi::c_void,
            ) -> HRESULT;
            unsafe fn clear_all_persisted_application_default_endpoints(&self) -> HRESULT;
        }
    };
}

policy_factory_iface!(IPolicyConfigFactory21H2, "ab3d4648-e242-459f-b02f-541c70306324");
policy_factory_iface!(IPolicyConfigFactoryDownlevel, "2a59116d-6c4f-45e0-a74f-707e3fef9258");

enum PolicyFactory {
    Modern(IPolicyConfigFactory21H2),
    Downlevel(IPolicyConfigFactoryDownlevel),
}

impl PolicyFactory {
    unsafe fn get() -> Result<PolicyFactory, String> {
        let class = HSTRING::from(POLICY_CONFIG_CLASS);
        if let Ok(f) = RoGetActivationFactory::<IPolicyConfigFactory21H2>(&class) {
            return Ok(PolicyFactory::Modern(f));
        }
        RoGetActivationFactory::<IPolicyConfigFactoryDownlevel>(&class)
            .map(PolicyFactory::Downlevel)
            .map_err(|e| format!("AudioPolicyConfig activation failed: {e}"))
    }

    /// `device_path == None` clears the override (back to the system default).
    /// Sets both eConsole and eMultimedia roles for eRender, like EarTrumpet.
    unsafe fn set_render_endpoint(&self, pid: u32, device_path: Option<&str>) -> Result<(), String> {
        let hstr = device_path.map(HSTRING::from);
        // HSTRING is repr(transparent) over the raw handle; null ⇒ clear.
        let raw: *mut core::ffi::c_void = match &hstr {
            Some(h) => std::mem::transmute_copy(h),
            None => std::ptr::null_mut(),
        };
        for role in [0i32, 1i32] {
            // eConsole, eMultimedia
            let hr = match self {
                PolicyFactory::Modern(f) => f.set_persisted_default_audio_endpoint(pid, 0, role, raw),
                PolicyFactory::Downlevel(f) => f.set_persisted_default_audio_endpoint(pid, 0, role, raw),
            };
            hr.ok().map_err(|e| format!("SetPersistedDefaultAudioEndpoint failed: {e}"))?;
        }
        Ok(())
    }
}

/// Find an inaudible render endpoint to park a taken-over app on: a known
/// virtual sink that no Output node is currently using. Returns
/// `(policy device path, friendly name)`.
unsafe fn find_parking_endpoint(exclude_names: &[String]) -> Option<(String, String)> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
    let collection: IMMDeviceCollection =
        enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).ok()?;
    let count = collection.GetCount().ok()?;

    // Only ever park on a known-silent virtual sink — parking on a real device
    // would just move the duplicate audio somewhere else.
    const VIRTUAL_SINKS: &[&str] = &[
        "audio nodes",      // our cable (preferred — entries are checked in order)
        "cable input",      // VB-Cable
        "voicemeeter input",
        "voicemeeter aux input",
        "virtual audio cable",
    ];

    let mut found: Vec<(usize, String, String)> = Vec::new();
    for i in 0..count {
        let Ok(device) = collection.Item(i) else { continue };
        let Ok(id_pw) = device.GetId() else { continue };
        let id = String::from_utf16_lossy(id_pw.as_wide());
        CoTaskMemFree(Some(id_pw.as_ptr() as *const _));
        let Ok(store) = device.OpenPropertyStore(STGM_READ) else { continue };
        let Ok(name_pv) = store.GetValue(&PKEY_Device_FriendlyName) else { continue };
        let name = name_pv.to_string();
        let lower = name.to_lowercase();
        let Some(rank) = VIRTUAL_SINKS.iter().position(|s| lower.contains(s)) else { continue };
        if exclude_names.iter().any(|n| !n.is_empty() && (n == &name || lower.contains(&n.to_lowercase()))) {
            continue; // an Output node renders here — parked audio would mix in
        }
        found.push((rank, format!("\\\\?\\SWD#MMDEVAPI#{id}{RENDER_IFACE_SUFFIX}"), name));
    }
    found.sort_by_key(|f| f.0);
    found.into_iter().next().map(|(_, path, name)| (path, name))
}

/// Best-effort name of the endpoint takeover would park apps on right now
/// (None ⇒ takeover unavailable). Runs COM on a short-lived thread.
pub fn takeover_device(exclude_names: Vec<String>) -> Option<String> {
    thread::Builder::new()
        .name("takeover-probe".into())
        .spawn(move || unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                return None;
            }
            let r = find_parking_endpoint(&exclude_names).map(|(_, name)| name);
            CoUninitialize();
            r
        })
        .ok()
        .and_then(|h| h.join().ok())
        .flatten()
}

/// Applies the redirect for a captured pid; restores the default on drop (the
/// capture thread's COM stays alive for the guard's whole lifetime).
struct TakeoverGuard {
    pid: u32,
}

impl TakeoverGuard {
    unsafe fn apply(pid: u32, exclude_names: &[String]) -> Result<(TakeoverGuard, String), String> {
        let (path, name) = find_parking_endpoint(exclude_names)
            .ok_or("no virtual sink to park the app on (install the Audio Nodes Virtual Cable or VB-Cable)")?;
        PolicyFactory::get()?.set_render_endpoint(pid, Some(&path))?;
        Ok((TakeoverGuard { pid }, name))
    }
}

impl Drop for TakeoverGuard {
    fn drop(&mut self) {
        unsafe {
            if let Ok(f) = PolicyFactory::get() {
                let _ = f.set_render_endpoint(self.pid, None);
            }
        }
    }
}


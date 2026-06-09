// ────────────────────────────────────────────────────────────────────────────
// WASAPI IAudioClient3 shared low-latency OUTPUT backend (Windows only).
//
// An opt-in alternative to the cpal output stream (selected by the device mode). It
// renders the engine graph to the **default render endpoint** via IAudioClient3's
// shared low-latency path — the smallest engine period the device allows — event-driven
// on a dedicated render thread. The device stays in shared mode, so loopback / app
// capture / multiple outputs keep working. Input capture stays on cpal; both feed the
// same rings, so the existing cushion + resampler logic is reused unchanged.
//
// Safety: this is unsafe COM. Every fallible call returns `Err` so `start()` can fall
// back to cpal (the stable path is never lost). All COM objects are created on, and
// confined to, the render thread (`!Send`); the thread stops + cleans up on `Drop`.
// The audio rendering itself reuses `super::render_output`, identical to the cpal path.
// ────────────────────────────────────────────────────────────────────────────

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use windows::core::{GUID, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, FALSE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient3, IAudioRenderClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED,
    AUDCLNT_E_UNSUPPORTED_FORMAT, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use ringbuf::traits::{Producer, Split};
use ringbuf::{HeapProd, HeapRb};

use super::{render_output, EvalState, Shared, MAX_BLOCK_FRAMES, RING_FRAMES};

// WAVEFORMATEX.wFormatTag values + the EXTENSIBLE float subformat
// ({00000003-0000-0010-8000-00AA00389B71}). The shared-mode mix format is always
// 32-bit IEEE float; anything else bails to cpal so we never blast misread samples.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x0000_0003_0000_0010_8000_00aa_0038_9b71);
const SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00aa_0038_9b71);

/// Sample format of the negotiated WASAPI stream — what we read/write in the I/O loop.
/// Shared mode is always F32 (the mix format); exclusive mode is whatever the device
/// accepts (consumer codecs typically reject float exclusive and require 16-bit PCM).
#[derive(Clone, Copy, PartialEq)]
enum SampleKind {
    F32,
    I16,
}
impl SampleKind {
    fn bytes(self) -> usize {
        match self {
            SampleKind::F32 => 4,
            SampleKind::I16 => 2,
        }
    }
}

/// Write one interleaved-stereo frame `(l, r)` into a device buffer of `nch` channels,
/// converting each sample with `conv` (identity for f32, scale-to-i16 for PCM).
#[inline]
fn write_frame<T: Copy>(out: &mut [T], i: usize, nch: usize, l: f32, r: f32, conv: impl Fn(f32) -> T) {
    let base = i * nch;
    if nch == 1 {
        out[base] = conv((l + r) * 0.5);
    } else {
        out[base] = conv(l);
        out[base + 1] = conv(r);
        let zero = conv(0.0);
        for c in 2..nch {
            out[base + c] = zero;
        }
    }
}

/// A 16-bit PCM `WAVEFORMATEXTENSIBLE` for exclusive-mode negotiation, reusing the
/// device's own channel count + mask (only changing float→int16) so the layout matches
/// what the hardware accepts. EXTENSIBLE is required for >2 channels (a plain
/// WAVEFORMATEX there yields E_INVALIDARG).
fn make_pcm16_ext(nch: u16, sr: u32, mask: u32) -> WAVEFORMATEXTENSIBLE {
    let block = nch * 2;
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE,
            nChannels: nch,
            nSamplesPerSec: sr,
            nAvgBytesPerSec: sr * block as u32,
            nBlockAlign: block,
            wBitsPerSample: 16,
            cbSize: 22,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 { wValidBitsPerSample: 16 },
        dwChannelMask: mask,
        SubFormat: SUBTYPE_PCM,
    }
}

/// The device's channel mask — the mix format's `dwChannelMask` when EXTENSIBLE, else a
/// default with `nch` low bits set. Reused for the i16 exclusive candidate.
unsafe fn channel_mask(fmt: *const WAVEFORMATEX, tag: u16, cb: u16, nch: usize) -> u32 {
    if tag == WAVE_FORMAT_EXTENSIBLE && (cb as usize) >= 22 {
        let ext: WAVEFORMATEXTENSIBLE = std::ptr::read_unaligned(fmt as *const WAVEFORMATEXTENSIBLE);
        ext.dwChannelMask
    } else if nch >= 32 {
        u32::MAX
    } else {
        (1u32 << nch) - 1
    }
}

/// Initialize an event-driven **exclusive** stream at the device's minimum period for one
/// candidate format, handling the buffer-alignment realign dance (which needs a fresh
/// client). Returns the initialized (not-yet-started) client.
unsafe fn init_exclusive_client(
    device: &IMMDevice,
    fmt: *const WAVEFORMATEX,
    sr: f32,
) -> Result<IAudioClient3, windows::core::Error> {
    let client: IAudioClient3 = device.Activate(CLSCTX_ALL, None)?;
    let (mut def_hns, mut min_hns) = (0i64, 0i64);
    let _ = client.GetDevicePeriod(Some(&mut def_hns as *mut i64), Some(&mut min_hns as *mut i64));
    let period = if min_hns > 0 { min_hns } else { 100_000 };
    match client.Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, period, fmt, None) {
        Ok(()) => Ok(client),
        Err(e) if e.code() == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED => {
            let aligned = client.GetBufferSize()?;
            let dur = (10_000_000.0_f64 * aligned as f64 / sr as f64).round() as i64;
            let client2: IAudioClient3 = device.Activate(CLSCTX_ALL, None)?;
            client2.Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, dur, dur, fmt, None)?;
            Ok(client2)
        }
        Err(e) => Err(e),
    }
}

/// Negotiate an exclusive format: try the float mix format first, then fall back to
/// 16-bit PCM (what most consumer codecs accept in exclusive). Returns the initialized
/// client + the chosen sample kind, or `Err` (⇒ cpal fallback).
unsafe fn negotiate_exclusive(
    device: &IMMDevice,
    mix_fmt: *const WAVEFORMATEX,
    nch: u16,
    rate: u32,
    mask: u32,
    sr: f32,
) -> Result<(IAudioClient3, SampleKind), String> {
    match init_exclusive_client(device, mix_fmt, sr) {
        Ok(c) => Ok((c, SampleKind::F32)),
        Err(e) if e.code() == AUDCLNT_E_UNSUPPORTED_FORMAT => {
            let ext = make_pcm16_ext(nch, rate, mask);
            let c = init_exclusive_client(device, &ext as *const _ as *const WAVEFORMATEX, sr)
                .map_err(|e| format!("exclusive i16 init failed: {e}"))?;
            Ok((c, SampleKind::I16))
        }
        Err(e) => Err(format!("exclusive init failed: {e}")),
    }
}

/// Handle to a running WASAPI render thread. Dropping it stops + joins the thread.
pub struct WasapiOutput {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl WasapiOutput {
    /// Open the default render endpoint and start an event-driven render thread —
    /// IAudioClient3 shared low-latency (`exclusive == false`) or WASAPI exclusive mode
    /// (`exclusive == true`, bypasses the mixer + locks the device). Returns `Err`
    /// (⇒ cpal fallback) on any failure during initialization.
    pub fn start(shared: Arc<Shared>, node_id: String, exclusive: bool) -> Result<WasapiOutput, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        // The thread reports its init result (so we can fall back), then renders.
        let (tx, rx) = sync_channel::<Result<(), String>>(1);

        let handle = thread::Builder::new()
            .name("wasapi-render".into())
            .spawn(move || unsafe { render_thread(shared, node_id, stop_thread, tx, exclusive) })
            .map_err(|e| e.to_string())?;

        match rx.recv() {
            Ok(Ok(())) => Ok(WasapiOutput { stop, handle: Some(handle) }),
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

impl Drop for WasapiOutput {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Initialized render objects, owned by (and dropped on) the render thread.
struct RenderCtx {
    client: IAudioClient3,
    render: IAudioRenderClient,
    event: HANDLE,
    buffer_frames: u32,
    sr: f32,
    nch: usize,
    kind: SampleKind,
}

/// COM-init this thread, open + start the stream, report the result, then render until
/// stopped. All COM objects stay on this thread and are released before CoUninitialize.
unsafe fn render_thread(
    shared: Arc<Shared>,
    node_id: String,
    stop: Arc<AtomicBool>,
    tx: SyncSender<Result<(), String>>,
    exclusive: bool,
) {
    if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
        let _ = tx.send(Err("CoInitializeEx failed".into()));
        return;
    }

    let ctx = match init_render(exclusive) {
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

    let mut st = EvalState::new();

    while !stop.load(Ordering::Relaxed) {
        // 200 ms timeout so a stalled device can't wedge the stop check.
        if WaitForSingleObject(ctx.event, 200) != WAIT_OBJECT_0 {
            continue;
        }
        let padding = match ctx.client.GetCurrentPadding() {
            Ok(p) => p,
            Err(_) => break,
        };
        // Output latency of the block we're about to render = the audio still queued
        // ahead of it (the live backlog). Measured the same way as the cpal path
        // (callback→playback), so the latency readout is comparable across backends —
        // not GetStreamLatency, which is the device's nominal *maximum* and over-reports.
        let dev_ms = padding as f32 / ctx.sr * 1000.0;
        let avail = ctx.buffer_frames.saturating_sub(padding) as usize;
        if avail == 0 {
            continue;
        }
        let frames = avail.min(MAX_BLOCK_FRAMES);
        let stereo = render_output(&shared, &node_id, &mut st, frames, ctx.sr, dev_ms);

        let ptr = match ctx.render.GetBuffer(frames as u32) {
            Ok(p) => p,
            Err(_) => break,
        };
        // Write the interleaved-stereo block into the device buffer in its format
        // (f32 for shared / float-exclusive; i16 for the common exclusive PCM case).
        match ctx.kind {
            SampleKind::F32 => {
                let out = std::slice::from_raw_parts_mut(ptr as *mut f32, frames * ctx.nch);
                for i in 0..frames {
                    write_frame(out, i, ctx.nch, stereo[2 * i], stereo[2 * i + 1], |s| s);
                }
            }
            SampleKind::I16 => {
                let out = std::slice::from_raw_parts_mut(ptr as *mut i16, frames * ctx.nch);
                for i in 0..frames {
                    write_frame(out, i, ctx.nch, stereo[2 * i], stereo[2 * i + 1], |s| {
                        (s.clamp(-1.0, 1.0) * 32767.0) as i16
                    });
                }
            }
        }
        let _ = ctx.render.ReleaseBuffer(frames as u32, 0);
        st.give(stereo);
    }

    let _ = ctx.client.Stop();
    let _ = CloseHandle(ctx.event);
    drop(ctx); // release the COM interfaces before uninitializing COM
    CoUninitialize();
}

/// Open the default render endpoint and initialize an event-driven stream — shared
/// low-latency (smallest engine period) or exclusive (device's minimum period, bypassing
/// the mixer). Returns started render objects.
unsafe fn init_render(exclusive: bool) -> Result<RenderCtx, String> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| e.to_string())?;
    let client0: IAudioClient3 = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;

    let fmt = client0.GetMixFormat().map_err(|e| e.to_string())?;
    if fmt.is_null() {
        return Err("null mix format".into());
    }
    // WAVEFORMATEX* is #[repr(packed)], so copy fields out by value (read_unaligned).
    let wf: WAVEFORMATEX = std::ptr::read_unaligned(fmt);
    let nch = wf.nChannels as usize;
    let sr = wf.nSamplesPerSec as f32;
    let bits = wf.wBitsPerSample;
    let tag = wf.wFormatTag;
    let cb = wf.cbSize;
    let is_float = match tag {
        WAVE_FORMAT_IEEE_FLOAT => bits == 32,
        WAVE_FORMAT_EXTENSIBLE if (cb as usize) >= 22 => {
            let ext: WAVEFORMATEXTENSIBLE = std::ptr::read_unaligned(fmt as *const WAVEFORMATEXTENSIBLE);
            let sub = ext.SubFormat; // copy the GUID out before comparing (packed field)
            bits == 32 && sub == SUBTYPE_IEEE_FLOAT
        }
        _ => false,
    };

    // Negotiate the stream + its sample format. Exclusive tries float then 16-bit PCM
    // (consumer codecs reject float exclusive); shared low-latency requires the float
    // mix format (no conversion). `client` becomes whichever client got initialized.
    let mask = channel_mask(fmt, tag, cb, nch);
    let (client, kind) = if exclusive {
        let res = negotiate_exclusive(&device, fmt, nch as u16, wf.nSamplesPerSec, mask, sr);
        CoTaskMemFree(Some(fmt as *const _));
        res?
    } else {
        let r = if is_float {
            let (mut def_p, mut fund_p, mut min_p, mut max_p) = (0u32, 0u32, 0u32, 0u32);
            let pr = client0.GetSharedModeEnginePeriod(fmt, &mut def_p, &mut fund_p, &mut min_p, &mut max_p);
            let period = if pr.is_ok() { min_p.max(fund_p).max(1) } else { 0 };
            if period > 0 {
                client0.InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, fmt, None)
            } else {
                Err(windows::core::Error::from_win32())
            }
        } else {
            Err(windows::core::Error::from_win32())
        };
        CoTaskMemFree(Some(fmt as *const _));
        if !is_float {
            return Err(format!("shared mix format not float (tag {tag}, bits {bits})"));
        }
        r.map_err(|e| format!("shared low-latency Initialize failed: {e}"))?;
        (client0, SampleKind::F32)
    };

    let event = CreateEventW(None, FALSE, FALSE, PCWSTR::null()).map_err(|e| e.to_string())?;
    client.SetEventHandle(event).map_err(|e| e.to_string())?;
    let render: IAudioRenderClient = client.GetService().map_err(|e| e.to_string())?;
    let buffer_frames = client.GetBufferSize().map_err(|e| e.to_string())?;

    // Pre-roll one buffer of silence (zeroed bytes = silence for f32 and i16 alike).
    if let Ok(p) = render.GetBuffer(buffer_frames) {
        std::ptr::write_bytes(p, 0, buffer_frames as usize * nch * kind.bytes());
        let _ = render.ReleaseBuffer(buffer_frames, 0);
    }
    client.Start().map_err(|e| e.to_string())?;

    Ok(RenderCtx { client, render, event, buffer_frames, sr, nch, kind })
}

// ── Capture (input) ──────────────────────────────────────────────────────────
//
// Mirrors WasapiOutput for the default *capture* endpoint, pushing PCM into the input
// node's ring (the same ring cpal's `input_cb` feeds), so the engine's cushion/eval are
// unchanged. The win: an exclusive capture stream runs at the device's *minimum* period
// (~3 ms), so `shared.in_frames` (the cushion's device-block term) shrinks far below
// cpal's ~10 ms shared period — the input half of the latency that "Low" mode couldn't
// touch. Negotiates float then 16-bit PCM (converted to/from f32); falls back to cpal on
// any failure.

/// Handle to a running WASAPI capture thread. Dropping it stops + joins the thread.
pub struct WasapiInput {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl WasapiInput {
    /// Open the default capture endpoint (shared low-latency or exclusive) and start an
    /// event-driven capture thread feeding `node_id`'s ring. Returns `Err` (⇒ cpal
    /// fallback). The node's consumer is only swapped in once init succeeds.
    pub fn start(shared: Arc<Shared>, node_id: String, exclusive: bool) -> Result<WasapiInput, String> {
        let rb = HeapRb::<f32>::new(RING_FRAMES * 2);
        let (prod, cons) = rb.split();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let (tx, rx) = sync_channel::<Result<(), String>>(1);
        let sh = shared.clone();
        let nid = node_id.clone();
        let handle = thread::Builder::new()
            .name("wasapi-capture".into())
            .spawn(move || unsafe { capture_thread(sh, nid, prod, stop_t, tx, exclusive) })
            .map_err(|e| e.to_string())?;

        match rx.recv() {
            Ok(Ok(())) => {
                if let Some(node) = shared.nodes.lock().unwrap().get(&node_id) {
                    *node.consumer.lock().unwrap() = Some(cons);
                    node.primed.store(false, Ordering::Relaxed); // re-cushion on the new ring
                }
                Ok(WasapiInput { stop, handle: Some(handle) })
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

impl Drop for WasapiInput {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

struct CaptureCtx {
    client: IAudioClient3,
    capture: IAudioCaptureClient,
    event: HANDLE,
    buffer_frames: u32,
    sr: f32,
    nch: usize,
    kind: SampleKind,
}

unsafe fn capture_thread(
    shared: Arc<Shared>,
    node_id: String,
    mut prod: HeapProd<f32>,
    stop: Arc<AtomicBool>,
    tx: SyncSender<Result<(), String>>,
    exclusive: bool,
) {
    if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
        let _ = tx.send(Err("CoInitializeEx failed".into()));
        return;
    }
    let ctx = match init_capture(exclusive) {
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

    // Cache the node Arc so the loop never locks the registry. dev_latency ≈ buffer depth.
    let node = shared.nodes.lock().unwrap().get(&node_id).cloned();
    if let Some(n) = &node {
        n.dev_latency.store((ctx.buffer_frames as f32 / ctx.sr * 1000.0).to_bits(), Ordering::Relaxed);
    }
    // Linear-resampler state (device rate → master), mirroring cpal's input_cb.
    let mut prev_l = 0.0f32;
    let mut prev_r = 0.0f32;
    let mut pos = 0.0f32;
    let mut dev: Vec<f32> = Vec::with_capacity(MAX_BLOCK_FRAMES * 2); // packet as f32, device nch
    let mut out: Vec<f32> = Vec::with_capacity(MAX_BLOCK_FRAMES * 4);

    while !stop.load(Ordering::Relaxed) {
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
            shared.in_frames.store(n.min(MAX_BLOCK_FRAMES) as u32, Ordering::Relaxed);
            let silent = (flags & 0x2) != 0; // AUDCLNT_BUFFERFLAGS_SILENT
            let master = shared.sr.load(Ordering::Relaxed) as f32;

            // 1) Convert the packet to f32 interleaved (device nch) into `dev`.
            dev.clear();
            if n > 0 {
                if silent || pdata.is_null() {
                    dev.resize(n * ctx.nch, 0.0);
                } else {
                    match ctx.kind {
                        SampleKind::F32 => {
                            dev.extend_from_slice(std::slice::from_raw_parts(pdata as *const f32, n * ctx.nch));
                        }
                        SampleKind::I16 => {
                            let s = std::slice::from_raw_parts(pdata as *const i16, n * ctx.nch);
                            dev.extend(s.iter().map(|&v| v as f32 / 32768.0));
                        }
                    }
                }
            }

            // 2) Down-mix to stereo + resample to master, pushing into the ring.
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

/// Open the default capture endpoint and initialize an event-driven stream (shared
/// low-latency = float; exclusive = float or negotiated 16-bit PCM at the device's
/// minimum period).
unsafe fn init_capture(exclusive: bool) -> Result<CaptureCtx, String> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eCapture, eConsole)
        .map_err(|e| e.to_string())?;
    let client0: IAudioClient3 = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;

    let fmt = client0.GetMixFormat().map_err(|e| e.to_string())?;
    if fmt.is_null() {
        return Err("null mix format".into());
    }
    let wf: WAVEFORMATEX = std::ptr::read_unaligned(fmt);
    let nch = wf.nChannels as usize;
    let sr = wf.nSamplesPerSec as f32;
    let bits = wf.wBitsPerSample;
    let tag = wf.wFormatTag;
    let cb = wf.cbSize;
    let is_float = match tag {
        WAVE_FORMAT_IEEE_FLOAT => bits == 32,
        WAVE_FORMAT_EXTENSIBLE if (cb as usize) >= 22 => {
            let ext: WAVEFORMATEXTENSIBLE = std::ptr::read_unaligned(fmt as *const WAVEFORMATEXTENSIBLE);
            let sub = ext.SubFormat;
            bits == 32 && sub == SUBTYPE_IEEE_FLOAT
        }
        _ => false,
    };
    let mask = channel_mask(fmt, tag, cb, nch);
    let (client, kind) = if exclusive {
        let res = negotiate_exclusive(&device, fmt, nch as u16, wf.nSamplesPerSec, mask, sr);
        CoTaskMemFree(Some(fmt as *const _));
        res?
    } else {
        let r = if is_float {
            let (mut def_p, mut fund_p, mut min_p, mut max_p) = (0u32, 0u32, 0u32, 0u32);
            let pr = client0.GetSharedModeEnginePeriod(fmt, &mut def_p, &mut fund_p, &mut min_p, &mut max_p);
            let period = if pr.is_ok() { min_p.max(fund_p).max(1) } else { 0 };
            if period > 0 {
                client0.InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, fmt, None)
            } else {
                Err(windows::core::Error::from_win32())
            }
        } else {
            Err(windows::core::Error::from_win32())
        };
        CoTaskMemFree(Some(fmt as *const _));
        if !is_float {
            return Err(format!("capture mix format not float (tag {tag}, bits {bits})"));
        }
        r.map_err(|e| format!("capture shared low-latency Initialize failed: {e}"))?;
        (client0, SampleKind::F32)
    };

    let event = CreateEventW(None, FALSE, FALSE, PCWSTR::null()).map_err(|e| e.to_string())?;
    client.SetEventHandle(event).map_err(|e| e.to_string())?;
    let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
    let buffer_frames = client.GetBufferSize().map_err(|e| e.to_string())?;
    client.Start().map_err(|e| e.to_string())?;

    Ok(CaptureCtx { client, capture, event, buffer_frames, sr, nch, kind })
}

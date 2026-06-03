// ────────────────────────────────────────────────────────────────────────────
// Phase 2 audio engine — real multi-channel DSP graph.
//
// Threading
//   • A dedicated **audio thread** owns every cpal `Stream` (they are `!Send`).
//     It only receives stream-create/drop commands; the streams' own callbacks
//     run on cpal's realtime threads.
//   • The napi object (control thread = JS main) holds only `Send + Sync` shared
//     state: the node registry, the directed edge list, and a published
//     `GraphSnapshot` (`ArcSwap`). Param edits hit lock-free atomics or a brief
//     per-node mutex; topology edits rebuild the snapshot. No audio-thread
//     round-trip for either.
//
// Audio flow (pull model)
//   Each output stream callback evaluates the graph by walking *backwards* from
//   its own node: `eval(node, channel)` sums the node's upstream inputs, runs the
//   node's per-channel DSP, updates that channel's meter, and returns a block.
//   Input nodes pop from their capture ring buffer. A per-block cache pops each
//   input exactly once so fan-out within one output's graph is correct.
//
// Channels
//   Effect nodes carry 1–8 independent signal paths (channel 0 never bleeds into
//   channel 1) — each channel has its own DSP state. Edges carry source/target
//   channel indices. The mixer is the asymmetric case: many input channels (each
//   with its own gain) fold into a single output.
//
// Scope / limitations (documented, not bugs):
//   • No resampling: input and output should run at the same sample rate (48 kHz
//     is the usual Windows default). A mismatch drifts.
//   • Multiple outputs each pull the shared input ring buffer (contended); the
//     common single-output case is correct.
//   • Reverb is an algorithmic (Freeverb-style) approximation, not the convolution
//     reverb of the Web Audio engine.
// ────────────────────────────────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, OutputCallbackInfo, Sample, SampleFormat, SizedSample, StreamConfig};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

const MAX_BLOCK_FRAMES: usize = 8192;
const RING_FRAMES: usize = 48_000; // ~1s of stereo headroom
const MAX_DEPTH: u32 = 64; // graph-recursion / cycle guard

// ── Meters (lock-free f32 in an AtomicU32) ──────────────────────────────────

pub struct Meter(AtomicU32);
impl Meter {
    fn new() -> Self {
        Meter(AtomicU32::new((-72f32).to_bits()))
    }
    fn with(v: f32) -> Self {
        Meter(AtomicU32::new(v.to_bits()))
    }
    fn set(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }
    fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
}

fn rms_to_db(rms: f32) -> f32 {
    if rms > 1e-7 {
        (20.0 * rms.log10()).max(-72.0)
    } else {
        -72.0
    }
}

fn rms(buf: &[f32]) -> f32 {
    if buf.is_empty() {
        return 0.0;
    }
    let sum: f32 = buf.iter().map(|s| s * s).sum();
    (sum / buf.len() as f32).sqrt()
}

// ── DSP processors (one instance per node channel; interleaved stereo) ───────

mod dsp;
use dsp::Dsp;

// ── Node kinds the engine understands ───────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Input,
    Output,
    Volume,
    Mixer,
    Eq,
    Compressor,
    Gate,
    Reverb,
    Delay,
    Chorus,
    Distortion,
    Pan,
    /// Anything unmapped — audio passes through untouched.
    Passthrough,
}

impl Kind {
    fn from_type(t: &str) -> Kind {
        match t {
            "input" | "application" => Kind::Input,
            "output" | "virtual" => Kind::Output,
            "volume" => Kind::Volume,
            "mixer" => Kind::Mixer,
            "eq" => Kind::Eq,
            "compressor" => Kind::Compressor,
            "gate" => Kind::Gate,
            "reverb" => Kind::Reverb,
            "delay" => Kind::Delay,
            "chorus" => Kind::Chorus,
            "distortion" => Kind::Distortion,
            "pan" => Kind::Pan,
            _ => Kind::Passthrough,
        }
    }
    /// DSP kinds carry one processor per channel; gain/routing kinds carry none.
    fn dsp_kind(self) -> bool {
        matches!(
            self,
            Kind::Eq
                | Kind::Compressor
                | Kind::Gate
                | Kind::Reverb
                | Kind::Delay
                | Kind::Chorus
                | Kind::Distortion
                | Kind::Pan
        )
    }
}

pub struct NodeState {
    kind: Kind,
    channels: usize,
    /// Linear gain (f32 bits). Input/output/volume scalar gain, and mixer master.
    gain: AtomicU32,
    muted: AtomicBool,
    /// One meter per channel (mixer/input/output have a single output meter).
    meters: Vec<Arc<Meter>>,
    /// Input nodes only: the consumer end of the capture ring buffer.
    consumer: Mutex<Option<HeapCons<f32>>>,
    /// DSP nodes only: per-channel processor state (locked only by the one audio
    /// callback that renders this node; control-thread param edits also lock it
    /// briefly).
    dsp: Vec<Mutex<Dsp>>,
    /// Mixer only: per-input-channel gains (lock-free).
    mixer_gains: Vec<AtomicU32>,
    /// Compressor only: per-channel gain-reduction readout (dB, ≤ 0).
    reduction: Vec<Arc<Meter>>,
}

impl NodeState {
    fn gain_lin(&self) -> f32 {
        if self.muted.load(Ordering::Relaxed) {
            0.0
        } else {
            f32::from_bits(self.gain.load(Ordering::Relaxed))
        }
    }
    fn reset_meters(&self) {
        for m in &self.meters {
            m.set(-72.0);
        }
        for r in &self.reduction {
            r.set(0.0);
        }
    }
}

// ── Edges + published graph snapshot ─────────────────────────────────────────

#[derive(Clone)]
struct Edge {
    src: String,
    src_ch: usize,
    tgt: String,
    tgt_ch: usize,
}

/// Immutable view the audio callbacks evaluate against. Rebuilt on any topology
/// change and published via `ArcSwap`, so callbacks read it lock-free.
struct GraphSnapshot {
    nodes: HashMap<String, Arc<NodeState>>,
    /// Edges grouped by target id (the inputs feeding each node).
    incoming: HashMap<String, Vec<Edge>>,
}
impl GraphSnapshot {
    fn empty() -> GraphSnapshot {
        GraphSnapshot { nodes: HashMap::new(), incoming: HashMap::new() }
    }
}

// ── Commands to the audio thread (stream lifecycle only) ─────────────────────

enum Command {
    CreateInputStream { id: String, device_id: String },
    CreateOutputStream { id: String, device_id: String },
    DropStream { id: String },
    Shutdown,
}

// ── Shared state (control thread + audio callbacks) ──────────────────────────

struct Shared {
    nodes: Mutex<HashMap<String, Arc<NodeState>>>,
    edges: Mutex<Vec<Edge>>,
    snapshot: ArcSwap<GraphSnapshot>,
    // Live device buffer sizes (frames) + sample rate, for the latency estimate.
    in_frames: AtomicU32,
    out_frames: AtomicU32,
    sr: AtomicU32,
}

pub struct Engine {
    shared: Arc<Shared>,
    tx: Sender<Command>,
}

impl Engine {
    pub fn new() -> Engine {
        let shared = Arc::new(Shared {
            nodes: Mutex::new(HashMap::new()),
            edges: Mutex::new(Vec::new()),
            snapshot: ArcSwap::from_pointee(GraphSnapshot::empty()),
            in_frames: AtomicU32::new(0),
            out_frames: AtomicU32::new(0),
            sr: AtomicU32::new(0),
        });
        let (tx, rx) = channel::<Command>();
        let thread_shared = shared.clone();
        thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || audio_thread(thread_shared, rx))
            .expect("spawn audio thread");
        Engine { shared, tx }
    }

    // ── Topology / params (control thread; no audio-thread round-trip) ──────

    pub fn create_node(&self, id: &str, node_type: &str, channels: u32, device_id: &str) {
        let kind = Kind::from_type(node_type);
        let ch = (channels.max(1)) as usize;

        let meters_count = match kind {
            Kind::Mixer | Kind::Input | Kind::Output => 1,
            _ => ch,
        };
        let meters = (0..meters_count).map(|_| Arc::new(Meter::new())).collect();

        let mut dsp: Vec<Mutex<Dsp>> = Vec::new();
        let mut reduction: Vec<Arc<Meter>> = Vec::new();
        if kind.dsp_kind() {
            for _ in 0..ch {
                if kind == Kind::Compressor {
                    let r = Arc::new(Meter::with(0.0));
                    reduction.push(r.clone());
                    dsp.push(Mutex::new(Dsp::new(kind, Some(r))));
                } else {
                    dsp.push(Mutex::new(Dsp::new(kind, None)));
                }
            }
        }

        let mixer_gains = if kind == Kind::Mixer {
            (0..ch).map(|_| AtomicU32::new(1f32.to_bits())).collect()
        } else {
            Vec::new()
        };

        let node = Arc::new(NodeState {
            kind,
            channels: ch,
            gain: AtomicU32::new(1f32.to_bits()),
            muted: AtomicBool::new(false),
            meters,
            consumer: Mutex::new(None),
            dsp,
            mixer_gains,
            reduction,
        });

        self.shared.nodes.lock().unwrap().insert(id.to_string(), node);
        match kind {
            Kind::Input => {
                let _ = self.tx.send(Command::CreateInputStream {
                    id: id.to_string(),
                    device_id: device_id.to_string(),
                });
            }
            Kind::Output => {
                let _ = self.tx.send(Command::CreateOutputStream {
                    id: id.to_string(),
                    device_id: device_id.to_string(),
                });
            }
            _ => {}
        }
        self.recompute();
    }

    /// Rough input→output latency estimate (ms) from the live device buffer
    /// sizes. 0 until streams are running. (Shared-mode WASAPI is typically a few
    /// tens of ms; this is an estimate, not a guarantee.)
    pub fn latency_ms(&self) -> f64 {
        let sr = self.shared.sr.load(Ordering::Relaxed);
        if sr == 0 {
            return 0.0;
        }
        let frames = self.shared.in_frames.load(Ordering::Relaxed)
            + self.shared.out_frames.load(Ordering::Relaxed);
        (frames as f64 / sr as f64 * 1000.0).round()
    }

    pub fn set_input_device(&self, id: &str, device_id: &str) {
        let _ = self.tx.send(Command::DropStream { id: id.to_string() });
        let _ = self.tx.send(Command::CreateInputStream {
            id: id.to_string(),
            device_id: device_id.to_string(),
        });
    }

    pub fn set_output_device(&self, id: &str, device_id: &str) {
        let _ = self.tx.send(Command::DropStream { id: id.to_string() });
        let _ = self.tx.send(Command::CreateOutputStream {
            id: id.to_string(),
            device_id: device_id.to_string(),
        });
        self.recompute();
    }

    pub fn set_gain(&self, id: &str, gain: f64) {
        if let Some(n) = self.shared.nodes.lock().unwrap().get(id) {
            n.gain.store((gain as f32).to_bits(), Ordering::Relaxed);
        }
    }

    pub fn set_muted(&self, id: &str, muted: bool) {
        if let Some(n) = self.shared.nodes.lock().unwrap().get(id) {
            n.muted.store(muted, Ordering::Relaxed);
        }
    }

    /// Generic effect-parameter setter. `index` selects an EQ band or mixer input
    /// channel; it is ignored by scalar params.
    pub fn set_param(&self, id: &str, param: &str, index: u32, value: f64) {
        let nodes = self.shared.nodes.lock().unwrap();
        let Some(node) = nodes.get(id) else { return };
        let v = value as f32;
        match node.kind {
            Kind::Mixer => match param {
                "master" => node.gain.store(v.to_bits(), Ordering::Relaxed),
                "channel" => {
                    if let Some(g) = node.mixer_gains.get(index as usize) {
                        g.store(v.to_bits(), Ordering::Relaxed);
                    }
                }
                _ => {}
            },
            _ => {
                for slot in &node.dsp {
                    slot.lock().unwrap().set_param(param, index as usize, v);
                }
            }
        }
    }

    pub fn connect(&self, source: &str, src_ch: u32, target: &str, tgt_ch: u32) {
        let mut edges = self.shared.edges.lock().unwrap();
        let (src_ch, tgt_ch) = (src_ch as usize, tgt_ch as usize);
        // Dedup so a replayed channel change doesn't double an edge.
        if !edges
            .iter()
            .any(|e| e.src == source && e.tgt == target && e.src_ch == src_ch && e.tgt_ch == tgt_ch)
        {
            edges.push(Edge {
                src: source.to_string(),
                src_ch,
                tgt: target.to_string(),
                tgt_ch,
            });
        }
        drop(edges);
        self.recompute();
    }

    pub fn disconnect(&self, source: &str, src_ch: u32, target: &str, tgt_ch: u32) {
        let (src_ch, tgt_ch) = (src_ch as usize, tgt_ch as usize);
        self.shared.edges.lock().unwrap().retain(|e| {
            !(e.src == source && e.tgt == target && e.src_ch == src_ch && e.tgt_ch == tgt_ch)
        });
        self.recompute();
    }

    pub fn destroy_node(&self, id: &str) {
        self.shared.nodes.lock().unwrap().remove(id);
        self.shared
            .edges
            .lock()
            .unwrap()
            .retain(|e| e.src != id && e.tgt != id);
        let _ = self.tx.send(Command::DropStream { id: id.to_string() });
        self.recompute();
    }

    /// Snapshot of every meter as `"<id>:<index>" -> dB`, plus per-channel
    /// compressor gain reduction as `"<id>#gr<index>" -> dB`.
    pub fn meters(&self) -> HashMap<String, f64> {
        let nodes = self.shared.nodes.lock().unwrap();
        let mut out = HashMap::with_capacity(nodes.len() * 2);
        for (id, node) in nodes.iter() {
            for (i, m) in node.meters.iter().enumerate() {
                out.insert(format!("{id}:{i}"), m.get() as f64);
            }
            for (i, r) in node.reduction.iter().enumerate() {
                out.insert(format!("{id}#gr{i}"), r.get() as f64);
            }
        }
        out
    }

    /// Rebuild the published snapshot from the current nodes + edges. Resets all
    /// meters so disconnected nodes read silence (active chains repopulate them
    /// on the next audio block).
    fn recompute(&self) {
        let nodes = self.shared.nodes.lock().unwrap();
        let edges = self.shared.edges.lock().unwrap();

        for node in nodes.values() {
            node.reset_meters();
        }

        let mut incoming: HashMap<String, Vec<Edge>> = HashMap::new();
        for e in edges.iter() {
            // Skip edges whose endpoints/channels no longer exist.
            let src_ok = nodes.get(&e.src).map(|n| e.src_ch < n.out_channels()).unwrap_or(false);
            let tgt_ok = nodes.get(&e.tgt).map(|n| e.tgt_ch < n.in_channels()).unwrap_or(false);
            if src_ok && tgt_ok {
                incoming.entry(e.tgt.clone()).or_default().push(e.clone());
            }
        }

        self.shared.snapshot.store(Arc::new(GraphSnapshot {
            nodes: nodes.clone(),
            incoming,
        }));
    }
}

impl NodeState {
    /// Number of output handles (mixer collapses to one).
    fn out_channels(&self) -> usize {
        match self.kind {
            Kind::Mixer => 1,
            _ => self.channels.max(1),
        }
    }
    /// Number of input handles.
    fn in_channels(&self) -> usize {
        self.channels.max(1)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

// ── Graph evaluation (runs inside an output stream callback) ─────────────────

/// Evaluate node `id`, output channel `ch`, into a fresh interleaved-stereo block
/// of `frames * 2` samples. `cache` pops each input exactly once per block so a
/// fan-out from one input within this output's graph stays correct.
fn eval(
    snap: &GraphSnapshot,
    id: &str,
    ch: usize,
    frames: usize,
    sr: f32,
    cache: &mut HashMap<String, Vec<f32>>,
    depth: u32,
) -> Vec<f32> {
    let n = frames * 2;
    let Some(node) = snap.nodes.get(id) else {
        return vec![0.0; n];
    };
    if depth > MAX_DEPTH {
        return vec![0.0; n];
    }

    // Input node: pop the capture ring (once per block), apply input gain + meter.
    if node.kind == Kind::Input {
        if let Some(cached) = cache.get(id) {
            return cached.clone();
        }
        let mut b = vec![0.0f32; n];
        {
            let mut guard = node.consumer.lock().unwrap();
            if let Some(cons) = guard.as_mut() {
                cons.pop_slice(&mut b);
            }
        }
        let g = node.gain_lin();
        if g != 1.0 {
            for s in b.iter_mut() {
                *s *= g;
            }
        }
        if let Some(m) = node.meters.first() {
            m.set(rms_to_db(rms(&b)));
        }
        cache.insert(id.to_string(), b.clone());
        return b;
    }

    let empty: Vec<Edge> = Vec::new();
    let incoming = snap.incoming.get(id).unwrap_or(&empty);

    let mut acc = vec![0.0f32; n];

    if node.kind == Kind::Mixer {
        // Every input channel folds into the single output, each with its gain.
        for e in incoming.iter() {
            let up = eval(snap, &e.src, e.src_ch, frames, sr, cache, depth + 1);
            let g = node
                .mixer_gains
                .get(e.tgt_ch)
                .map(|a| f32::from_bits(a.load(Ordering::Relaxed)))
                .unwrap_or(1.0);
            for i in 0..n {
                acc[i] += up[i] * g;
            }
        }
        let m = node.gain_lin();
        if m != 1.0 {
            for s in acc.iter_mut() {
                *s *= m;
            }
        }
        if let Some(meter) = node.meters.first() {
            meter.set(rms_to_db(rms(&acc)));
        }
        return acc;
    }

    // Sum every upstream feeding this output channel (Web Audio summing semantics).
    for e in incoming.iter().filter(|e| e.tgt_ch == ch) {
        let up = eval(snap, &e.src, e.src_ch, frames, sr, cache, depth + 1);
        for i in 0..n {
            acc[i] += up[i];
        }
    }

    match node.kind {
        Kind::Volume | Kind::Output => {
            let g = node.gain_lin();
            if g != 1.0 {
                for s in acc.iter_mut() {
                    *s *= g;
                }
            }
        }
        _ if node.kind.dsp_kind() => {
            if let Some(slot) = node.dsp.get(ch) {
                slot.lock().unwrap().process(&mut acc, sr);
            }
        }
        _ => {} // passthrough
    }

    let mi = ch.min(node.meters.len().saturating_sub(1));
    if let Some(meter) = node.meters.get(mi) {
        meter.set(rms_to_db(rms(&acc)));
    }
    acc
}

// ── Audio thread: owns the cpal streams ──────────────────────────────────────

fn audio_thread(shared: Arc<Shared>, rx: std::sync::mpsc::Receiver<Command>) {
    let host = cpal::default_host();
    let mut streams: HashMap<String, cpal::Stream> = HashMap::new();

    while let Ok(cmd) = rx.recv() {
        match cmd {
            Command::CreateInputStream { id, device_id } => {
                streams.remove(&id);
                match build_input(&host, &device_id, &shared, &id) {
                    Ok(stream) => {
                        if let Err(e) = stream.play() {
                            eprintln!("[audio] input play failed: {e}");
                        }
                        streams.insert(id, stream);
                    }
                    Err(e) => eprintln!("[audio] open input '{device_id}' failed: {e}"),
                }
            }
            Command::CreateOutputStream { id, device_id } => {
                streams.remove(&id);
                match build_output(&host, &device_id, &shared, &id) {
                    Ok(stream) => {
                        if let Err(e) = stream.play() {
                            eprintln!("[audio] output play failed: {e}");
                        }
                        streams.insert(id, stream);
                    }
                    Err(e) => eprintln!("[audio] open output '{device_id}' failed: {e}"),
                }
            }
            Command::DropStream { id } => {
                streams.remove(&id);
            }
            Command::Shutdown => break,
        }
    }
}

fn find_device(host: &cpal::Host, id: &str, output: bool) -> Option<Device> {
    let default = || {
        if output {
            host.default_output_device()
        } else {
            host.default_input_device()
        }
    };
    if id.is_empty() {
        return default();
    }
    let iter = if output {
        host.output_devices().ok()
    } else {
        host.input_devices().ok()
    };
    iter.and_then(|mut it| it.find(|d| d.name().map(|n| n == id).unwrap_or(false)))
        .or_else(default)
}

fn build_input(
    host: &cpal::Host,
    device_id: &str,
    shared: &Arc<Shared>,
    node_id: &str,
) -> Result<cpal::Stream, String> {
    let device = find_device(host, device_id, false).ok_or("no input device")?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let cfg: StreamConfig = supported.config();
    let in_ch = cfg.channels as usize;

    let rb = HeapRb::<f32>::new(RING_FRAMES * 2);
    let (prod, cons) = rb.split();
    if let Some(node) = shared.nodes.lock().unwrap().get(node_id) {
        *node.consumer.lock().unwrap() = Some(cons);
    }

    let err = |e| eprintln!("[audio] input stream error: {e}");
    let stream = match supported.sample_format() {
        SampleFormat::F32 => device.build_input_stream(&cfg, input_cb::<f32>(in_ch, prod, shared.clone()), err, None),
        SampleFormat::I16 => device.build_input_stream(&cfg, input_cb::<i16>(in_ch, prod, shared.clone()), err, None),
        SampleFormat::U16 => device.build_input_stream(&cfg, input_cb::<u16>(in_ch, prod, shared.clone()), err, None),
        f => return Err(format!("unsupported input sample format: {f:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(stream)
}

fn input_cb<T>(in_ch: usize, mut prod: HeapProd<f32>, shared: Arc<Shared>) -> impl FnMut(&[T], &cpal::InputCallbackInfo)
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let in_ch = in_ch.max(1);
    let mut stereo = vec![0f32; MAX_BLOCK_FRAMES * 2];
    move |data: &[T], _| {
        let frames = (data.len() / in_ch).min(MAX_BLOCK_FRAMES);
        shared.in_frames.store(frames as u32, Ordering::Relaxed);
        for i in 0..frames {
            let base = i * in_ch;
            let l = f32::from_sample(data[base]);
            let r = if in_ch >= 2 { f32::from_sample(data[base + 1]) } else { l };
            stereo[2 * i] = l;
            stereo[2 * i + 1] = r;
        }
        prod.push_slice(&stereo[..frames * 2]);
    }
}

fn build_output(
    host: &cpal::Host,
    device_id: &str,
    shared: &Arc<Shared>,
    node_id: &str,
) -> Result<cpal::Stream, String> {
    let device = find_device(host, device_id, true).ok_or("no output device")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let cfg: StreamConfig = supported.config();
    let out_ch = cfg.channels as usize;
    let sr = cfg.sample_rate.0 as f32;

    let err = |e| eprintln!("[audio] output stream error: {e}");
    let id = node_id.to_string();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => {
            device.build_output_stream(&cfg, output_cb::<f32>(out_ch, sr, shared.clone(), id), err, None)
        }
        SampleFormat::I16 => {
            device.build_output_stream(&cfg, output_cb::<i16>(out_ch, sr, shared.clone(), id), err, None)
        }
        SampleFormat::U16 => {
            device.build_output_stream(&cfg, output_cb::<u16>(out_ch, sr, shared.clone(), id), err, None)
        }
        f => return Err(format!("unsupported output sample format: {f:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(stream)
}

fn output_cb<T>(
    out_ch: usize,
    sr: f32,
    shared: Arc<Shared>,
    node_id: String,
) -> impl FnMut(&mut [T], &OutputCallbackInfo)
where
    T: SizedSample + FromSample<f32>,
{
    let out_ch = out_ch.max(1);
    let mut cache: HashMap<String, Vec<f32>> = HashMap::new();
    move |data: &mut [T], _| {
        let frames = (data.len() / out_ch).min(MAX_BLOCK_FRAMES);
        shared.out_frames.store(frames as u32, Ordering::Relaxed);
        shared.sr.store(sr as u32, Ordering::Relaxed);
        let snap = shared.snapshot.load();
        cache.clear();
        let stereo = eval(&snap, &node_id, 0, frames, sr, &mut cache, 0);

        for i in 0..frames {
            let l = stereo[2 * i];
            let r = stereo[2 * i + 1];
            let base = i * out_ch;
            if out_ch == 1 {
                data[base] = T::from_sample((l + r) * 0.5);
            } else {
                data[base] = T::from_sample(l);
                data[base + 1] = T::from_sample(r);
                for c in 2..out_ch {
                    data[base + c] = T::from_sample(0.0);
                }
            }
        }
    }
}

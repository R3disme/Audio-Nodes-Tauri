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
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

const MAX_BLOCK_FRAMES: usize = 8192;
const RING_FRAMES: usize = 48_000; // ~1s of stereo headroom
const MAX_DEPTH: u32 = 64; // graph-recursion / cycle guard

// Input/loopback latency cushion. The capture ring is read only once a cushion has
// built up, so ordinary jitter between the (independent) capture and render device
// callbacks can't drain it to silence — that empty-ring underrun is what produced the
// constant crackle / "not smooth" sound. If slow clock drift grows the cushion past the
// max, we drop back down to target to keep latency bounded; if it ever runs dry, we
// re-prime.
//
// The cushion is *derived at runtime* (see `cushion_frames`) from the live device
// callback block sizes rather than hardcoded, so it scales with the actual buffer sizes
// and sample rate instead of assuming 48k.
const CUSHION_BLOCKS: u32 = 3; // ~3 callback periods of jitter headroom
const CUSHION_FLOOR_MS: f32 = 12.0; // minimum cushion regardless of block size
const MAX_LATENCY_MS: f32 = 256.0; // drift cap before re-centering the cushion

/// Target input/loopback cushion in **mono frames**, derived from the live device block
/// sizes (`in_frames`/`out_frames`) and sample rate. `max(in, out)` tracks whichever side
/// jitters more and stays sane when there's no input stream; the floor keeps small-buffer
/// devices protected and covers the window before the first input block lands. 0 until a
/// stream is running (sr known).
fn cushion_frames(shared: &Shared) -> u32 {
    let sr = shared.sr.load(Ordering::Relaxed);
    if sr == 0 {
        return 0;
    }
    let block = shared
        .in_frames
        .load(Ordering::Relaxed)
        .max(shared.out_frames.load(Ordering::Relaxed));
    let floor = (sr as f32 * CUSHION_FLOOR_MS / 1000.0) as u32;
    (CUSHION_BLOCKS * block).max(floor)
}

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
    /// System-audio loopback capture (the Application node). Pops a ring like Input.
    Loopback,
    /// Records its incoming signal to a file. Passes audio through.
    Recorder,
    /// Anything unmapped — audio passes through untouched.
    Passthrough,
}

impl Kind {
    fn from_type(t: &str) -> Kind {
        match t {
            "input" => Kind::Input,
            "application" => Kind::Loopback,
            "recorder" => Kind::Recorder,
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
    /// Input/loopback nodes: the consumer end of the capture ring buffer.
    consumer: Mutex<Option<HeapCons<f32>>>,
    /// Input/loopback only: false until a latency cushion has accumulated in the
    /// ring. Gates reads so startup / callback jitter can't drain it to silence.
    primed: AtomicBool,
    /// Loopback (application) nodes: the producer end, fed by `push_capture` with
    /// PCM the renderer captures via getDisplayMedia (system loopback).
    producer: Mutex<Option<HeapProd<f32>>>,
    /// DSP nodes only: per-channel processor state (locked only by the one audio
    /// callback that renders this node; control-thread param edits also lock it
    /// briefly).
    dsp: Vec<Mutex<Dsp>>,
    /// Mixer only: per-input-channel gains (lock-free).
    mixer_gains: Vec<AtomicU32>,
    /// Compressor only: per-channel gain-reduction readout (dB, ≤ 0).
    reduction: Vec<Arc<Meter>>,
    /// Recorder only: whether it's actively capturing, and the interleaved-stereo
    /// accumulator (appended by the audio thread, drained → WAV on stop).
    recording: AtomicBool,
    rec_buf: Mutex<Vec<f32>>,
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
    /// Recorder node ids — evaluated as extra roots so they capture even when not
    /// routed to an output.
    recorders: Vec<String>,
    /// The single output that drives recorder evaluation (lowest id), so multiple
    /// outputs don't double-record.
    primary_output: Option<String>,
}
impl GraphSnapshot {
    fn empty() -> GraphSnapshot {
        GraphSnapshot { nodes: HashMap::new(), incoming: HashMap::new(), recorders: Vec::new(), primary_output: None }
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

        // Loopback (application) nodes are fed PCM over IPC (not a cpal stream), so
        // give them their capture ring up front.
        let (consumer, producer) = if kind == Kind::Loopback {
            let (prod, cons) = HeapRb::<f32>::new(RING_FRAMES * 2).split();
            (Some(cons), Some(prod))
        } else {
            (None, None)
        };

        let node = Arc::new(NodeState {
            kind,
            channels: ch,
            gain: AtomicU32::new(1f32.to_bits()),
            muted: AtomicBool::new(false),
            meters,
            consumer: Mutex::new(consumer),
            primed: AtomicBool::new(false),
            producer: Mutex::new(producer),
            dsp,
            mixer_gains,
            reduction,
            recording: AtomicBool::new(false),
            rec_buf: Mutex::new(Vec::new()),
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
        let inf = self.shared.in_frames.load(Ordering::Relaxed);
        let outf = self.shared.out_frames.load(Ordering::Relaxed);
        let cush = cushion_frames(&self.shared); // the input cushion is real latency too
        let frames = inf + outf + cush;
        // TEMP diagnostic: see which term dominates the reported latency.
        eprintln!(
            "[latency] sr={sr} in={inf}f ({:.1}ms) out={outf}f ({:.1}ms) cushion={cush}f ({:.1}ms) total={:.0}ms",
            inf as f64 / sr as f64 * 1000.0,
            outf as f64 / sr as f64 * 1000.0,
            cush as f64 / sr as f64 * 1000.0,
            frames as f64 / sr as f64 * 1000.0,
        );
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

    /// Feed captured PCM (interleaved stereo f32) into a loopback (application)
    /// node's ring. Called from the renderer's getDisplayMedia capture over IPC.
    pub fn push_capture(&self, id: &str, samples: &[f32]) {
        let nodes = self.shared.nodes.lock().unwrap();
        if let Some(node) = nodes.get(id) {
            if let Some(prod) = node.producer.lock().unwrap().as_mut() {
                prod.push_slice(samples);
            }
        }
    }

    /// Arm a recorder node: clear its buffer and start appending its signal.
    pub fn start_recording(&self, id: &str) -> bool {
        let nodes = self.shared.nodes.lock().unwrap();
        let Some(node) = nodes.get(id) else { return false };
        if node.kind != Kind::Recorder {
            return false;
        }
        {
            let mut buf = node.rec_buf.lock().unwrap();
            buf.clear();
            // Pre-reserve ~60s of interleaved stereo to limit reallocations on the
            // audio thread (it still grows for longer takes).
            let sr = self.shared.sr.load(Ordering::Relaxed).max(48000) as usize;
            buf.reserve(sr * 2 * 60);
        }
        node.recording.store(true, Ordering::Relaxed);
        true
    }

    /// Stop a recorder, write its buffer to a temp WAV, and return the file path.
    pub fn stop_recording(&self, id: &str) -> Option<String> {
        let samples = {
            let nodes = self.shared.nodes.lock().unwrap();
            let node = nodes.get(id)?;
            if !node.recording.swap(false, Ordering::Relaxed) {
                return None;
            }
            let taken = std::mem::take(&mut *node.rec_buf.lock().unwrap());
            taken
        };
        if samples.is_empty() {
            return None;
        }
        let sr = self.shared.sr.load(Ordering::Relaxed).max(48000);
        let path = std::env::temp_dir().join(format!("audionodes-rec-{}.wav", now_ms()));
        write_wav_i16(&path, &samples, sr, 2).ok()?;
        Some(path.to_string_lossy().into_owned())
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

        let recorders: Vec<String> = nodes
            .iter()
            .filter(|(_, n)| n.kind == Kind::Recorder)
            .map(|(id, _)| id.clone())
            .collect();
        let primary_output: Option<String> = nodes
            .iter()
            .filter(|(_, n)| n.kind == Kind::Output)
            .map(|(id, _)| id.clone())
            .min();

        self.shared.snapshot.store(Arc::new(GraphSnapshot {
            nodes: nodes.clone(),
            incoming,
            recorders,
            primary_output,
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

/// Pop and discard `count` samples from a consumer (used to cap input latency
/// when slow clock drift has over-filled the cushion).
fn drop_samples(cons: &mut HeapCons<f32>, count: usize) {
    let mut scratch = [0.0f32; 2048];
    let mut left = count;
    while left > 0 {
        let take = left.min(scratch.len());
        let popped = cons.pop_slice(&mut scratch[..take]);
        if popped == 0 {
            break;
        }
        left -= popped;
    }
}

/// Evaluate node `id`, output channel `ch`, into a fresh interleaved-stereo block
/// of `frames * 2` samples. `cache` pops each input exactly once per block so a
/// fan-out from one input within this output's graph stays correct.
fn eval(
    snap: &GraphSnapshot,
    id: &str,
    ch: usize,
    frames: usize,
    sr: f32,
    cushion: u32,
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

    // Input / loopback node: pop the capture ring (once per block), gain + meter.
    if node.kind == Kind::Input || node.kind == Kind::Loopback {
        if let Some(cached) = cache.get(id) {
            return cached.clone();
        }
        let mut b = vec![0.0f32; n];
        {
            let mut guard = node.consumer.lock().unwrap();
            if let Some(cons) = guard.as_mut() {
                let target = cushion as usize * 2;
                let max = (sr * MAX_LATENCY_MS / 1000.0) as usize * 2;
                let avail = cons.occupied_len();
                // Build the cushion before the first read so jitter can't underrun.
                if !node.primed.load(Ordering::Relaxed) && avail >= target + n {
                    node.primed.store(true, Ordering::Relaxed);
                }
                if node.primed.load(Ordering::Relaxed) {
                    if avail < n {
                        // Ran dry → emit silence (b stays zero) and re-prime.
                        node.primed.store(false, Ordering::Relaxed);
                    } else {
                        // Slow clock drift grew the cushion → drop back to target so
                        // latency stays bounded instead of accumulating delay.
                        if avail > max {
                            drop_samples(cons, avail - target);
                        }
                        cons.pop_slice(&mut b);
                    }
                }
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
            let up = eval(snap, &e.src, e.src_ch, frames, sr, cushion, cache, depth + 1);
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
        let up = eval(snap, &e.src, e.src_ch, frames, sr, cushion, cache, depth + 1);
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
        _ => {} // passthrough (incl. recorder)
    }

    // Recorder: append the (interleaved-stereo) signal while armed.
    if node.kind == Kind::Recorder && node.recording.load(Ordering::Relaxed) {
        let mut buf = node.rec_buf.lock().unwrap();
        buf.extend_from_slice(&acc);
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

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Write interleaved-stereo f32 samples to a 16-bit PCM WAV file.
fn write_wav_i16(path: &std::path::Path, samples: &[f32], sr: u32, channels: u16) -> std::io::Result<()> {
    use std::io::Write;
    let bits: u16 = 16;
    let block_align: u16 = channels * bits / 8;
    let byte_rate: u32 = sr * block_align as u32;
    let data_bytes: u32 = (samples.len() * 2) as u32;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_bytes).to_le_bytes())?;
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?; // PCM fmt chunk size
    f.write_all(&1u16.to_le_bytes())?; // format = PCM
    f.write_all(&channels.to_le_bytes())?;
    f.write_all(&sr.to_le_bytes())?;
    f.write_all(&byte_rate.to_le_bytes())?;
    f.write_all(&block_align.to_le_bytes())?;
    f.write_all(&bits.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_bytes.to_le_bytes())?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        f.write_all(&v.to_le_bytes())?;
    }
    f.flush()
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
    let in_sr = cfg.sample_rate.0 as f32;

    let rb = HeapRb::<f32>::new(RING_FRAMES * 2);
    let (prod, cons) = rb.split();
    if let Some(node) = shared.nodes.lock().unwrap().get(node_id) {
        *node.consumer.lock().unwrap() = Some(cons);
        node.primed.store(false, Ordering::Relaxed); // re-cushion on the new ring
    }

    let err = |e| eprintln!("[audio] input stream error: {e}");
    let stream = match supported.sample_format() {
        SampleFormat::F32 => device.build_input_stream(&cfg, input_cb::<f32>(in_ch, in_sr, prod, shared.clone()), err, None),
        SampleFormat::I16 => device.build_input_stream(&cfg, input_cb::<i16>(in_ch, in_sr, prod, shared.clone()), err, None),
        SampleFormat::U16 => device.build_input_stream(&cfg, input_cb::<u16>(in_ch, in_sr, prod, shared.clone()), err, None),
        f => return Err(format!("unsupported input sample format: {f:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(stream)
}

fn input_cb<T>(
    in_ch: usize,
    in_sr: f32,
    mut prod: HeapProd<f32>,
    shared: Arc<Shared>,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo)
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let in_ch = in_ch.max(1);
    // Streaming linear-resampler state, converting the input device rate to the
    // master (output) rate so the output callback can read the ring 1:1. When the
    // rates already match this whole path is bypassed (byte-identical pass-through).
    let mut prev_l = 0.0f32;
    let mut prev_r = 0.0f32;
    let mut pos = 0.0f32; // position (in input frames) of the next output sample
    let mut out: Vec<f32> = Vec::with_capacity(MAX_BLOCK_FRAMES * 4);
    move |data: &[T], _| {
        let frames = data.len() / in_ch;
        shared.in_frames.store(frames.min(MAX_BLOCK_FRAMES) as u32, Ordering::Relaxed);
        let master = shared.sr.load(Ordering::Relaxed) as f32;

        out.clear();
        if master < 1.0 || (master - in_sr).abs() <= 0.5 {
            // Matched rate (or master not yet known): interleave to stereo 1:1.
            for i in 0..frames {
                let base = i * in_ch;
                let l = f32::from_sample(data[base]);
                let r = if in_ch >= 2 { f32::from_sample(data[base + 1]) } else { l };
                out.push(l);
                out.push(r);
            }
            // Keep resampler continuity in case the rate diverges on a later block.
            if frames > 0 {
                let base = (frames - 1) * in_ch;
                prev_l = f32::from_sample(data[base]);
                prev_r = if in_ch >= 2 { f32::from_sample(data[base + 1]) } else { prev_l };
            }
            pos = 0.0;
        } else {
            // Resample input (in_sr) → master. `step` = input frames advanced per
            // emitted output sample; >1 decimates, <1 interpolates.
            let step = in_sr / master;
            for i in 0..frames {
                let base = i * in_ch;
                let cur_l = f32::from_sample(data[base]);
                let cur_r = if in_ch >= 2 { f32::from_sample(data[base + 1]) } else { cur_l };
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
        prod.push_slice(&out);
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
        let cushion = cushion_frames(&shared);
        let snap = shared.snapshot.load();
        cache.clear();
        let stereo = eval(&snap, &node_id, 0, frames, sr, cushion, &mut cache, 0);

        // Drive recording recorders as extra roots (so they capture even when not
        // routed to an output). Only the primary output does this, to avoid
        // double-recording when several outputs run.
        if snap.primary_output.as_deref() == Some(node_id.as_str()) {
            for rid in &snap.recorders {
                if snap.nodes.get(rid).map(|n| n.recording.load(Ordering::Relaxed)).unwrap_or(false) {
                    let _ = eval(&snap, rid, 0, frames, sr, cushion, &mut cache, 0);
                }
            }
        }

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

// ────────────────────────────────────────────────────────────────────────────
// Phase 1 audio engine — input → [volume] → output, with VU meters.
//
// Threading
//   • A dedicated **audio thread** owns every cpal `Stream` (they are `!Send`, so
//     they must never cross threads). It only receives stream-create/drop
//     commands; the streams' own callbacks run on cpal's realtime threads.
//   • The napi object (control thread = JS main) holds only `Send + Sync` shared
//     state: the node registry, per-output route snapshots (`ArcSwap`), and meter
//     atomics. Param/topology edits touch that state directly — no rebuilds.
//
// Audio flow
//   input device ─cpal capture─▶ SPSC ring buffer ─▶ output callback pulls,
//   walks the route (gain nodes), writes to the output device + updates meters.
//
// Scope / limitations (Phase 1 slice — documented, not bugs):
//   • Linear chains input→[volume|passthrough]*→output. Fan-in (mixer) takes the
//     first source only; other effect types are treated as transparent passthrough.
//   • No resampling yet: input and output should run at the same sample rate
//     (48 kHz is the usual Windows default). A mismatch is logged and will drift.
//   • One output device is the common case; multiple outputs each pull the shared
//     input ring buffer (contended) — fine for the slice, revisited later.
// ────────────────────────────────────────────────────────────────────────────

use std::collections::{HashMap, HashSet};
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

// ── Meters (lock-free f32 in an AtomicU32) ──────────────────────────────────

pub struct Meter(AtomicU32);
impl Meter {
    fn new() -> Self {
        Meter(AtomicU32::new((-72f32).to_bits()))
    }
    fn set(&self, db: f32) {
        self.0.store(db.to_bits(), Ordering::Relaxed);
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

// ── Node kinds the engine understands ───────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Input,
    Output,
    Volume,
    /// Any node type not yet ported (eq, gate, reverb, …) — audio passes through
    /// it untouched so the chain still produces sound in native mode.
    Passthrough,
}

impl Kind {
    fn from_type(t: &str) -> Kind {
        match t {
            "input" | "application" => Kind::Input,
            "output" | "virtual" => Kind::Output,
            "volume" => Kind::Volume,
            _ => Kind::Passthrough,
        }
    }
}

pub struct NodeState {
    kind: Kind,
    /// Linear gain (f32 bits). Applies to input/output/volume nodes.
    gain: AtomicU32,
    muted: AtomicBool,
    /// One meter per channel (slice fills them all with the same level).
    meters: Vec<Arc<Meter>>,
    /// Input nodes only: the consumer end of the capture ring buffer.
    consumer: Mutex<Option<HeapCons<f32>>>,
    /// Output nodes only: the live route the callback renders.
    route: Option<Arc<ArcSwap<Route>>>,
}

impl NodeState {
    fn new(kind: Kind, channels: usize) -> Arc<NodeState> {
        let meters = (0..channels.max(1)).map(|_| Arc::new(Meter::new())).collect();
        Arc::new(NodeState {
            kind,
            gain: AtomicU32::new(1f32.to_bits()),
            muted: AtomicBool::new(false),
            meters,
            consumer: Mutex::new(None),
            route: if kind == Kind::Output {
                Some(Arc::new(ArcSwap::from_pointee(Route::empty())))
            } else {
                None
            },
        })
    }
    fn gain_lin(&self) -> f32 {
        if self.muted.load(Ordering::Relaxed) {
            0.0
        } else {
            f32::from_bits(self.gain.load(Ordering::Relaxed))
        }
    }
    fn set_all_meters(&self, db: f32) {
        for m in &self.meters {
            m.set(db);
        }
    }
}

/// A flattened render plan for one output, recomputed on topology changes.
struct Route {
    /// The input node feeding this output (after tracing back through the chain).
    source: Option<Arc<NodeState>>,
    /// Gain-bearing chain nodes (volumes + this output) whose gains multiply.
    gain_nodes: Vec<Arc<NodeState>>,
    /// Every non-source chain node — their meters get the post-gain level.
    level_nodes: Vec<Arc<NodeState>>,
}
impl Route {
    fn empty() -> Route {
        Route { source: None, gain_nodes: vec![], level_nodes: vec![] }
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
    /// Directed edges (source_id → target_id). Channels are ignored in the slice.
    edges: Mutex<Vec<(String, String)>>,
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
        let node = NodeState::new(kind, channels.max(1) as usize);
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
        self.recompute_routes();
    }

    pub fn set_input_device(&self, id: &str, device_id: &str) {
        // Rebuild the capture stream on the new device; the node + consumer slot stay.
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
        self.recompute_routes();
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

    pub fn connect(&self, source: &str, target: &str) {
        self.shared
            .edges
            .lock()
            .unwrap()
            .push((source.to_string(), target.to_string()));
        self.recompute_routes();
    }

    pub fn disconnect(&self, source: &str, target: &str) {
        self.shared
            .edges
            .lock()
            .unwrap()
            .retain(|(s, t)| !(s == source && t == target));
        self.recompute_routes();
    }

    pub fn destroy_node(&self, id: &str) {
        self.shared.nodes.lock().unwrap().remove(id);
        self.shared
            .edges
            .lock()
            .unwrap()
            .retain(|(s, t)| s != id && t != id);
        let _ = self.tx.send(Command::DropStream { id: id.to_string() });
        self.recompute_routes();
    }

    /// Snapshot of every meter as `"<nodeId>:<index>" -> dB`.
    pub fn meters(&self) -> HashMap<String, f64> {
        let nodes = self.shared.nodes.lock().unwrap();
        let mut out = HashMap::with_capacity(nodes.len());
        for (id, node) in nodes.iter() {
            for (i, m) in node.meters.iter().enumerate() {
                out.insert(format!("{id}:{i}"), m.get() as f64);
            }
        }
        out
    }

    /// Trace each output back through the chain and publish its render plan.
    fn recompute_routes(&self) {
        let nodes = self.shared.nodes.lock().unwrap();
        let edges = self.shared.edges.lock().unwrap();
        for (out_id, out_node) in nodes.iter() {
            let Some(route_swap) = &out_node.route else { continue };
            let mut source = None;
            let mut gain_nodes: Vec<Arc<NodeState>> = Vec::new();
            let mut level_nodes: Vec<Arc<NodeState>> = Vec::new();
            let mut cur = out_id.clone();
            let mut seen = HashSet::new();
            seen.insert(cur.clone());
            loop {
                // First edge feeding `cur` (fan-in takes the first source — slice limit).
                let Some((src_id, _)) = edges.iter().find(|(_, t)| *t == cur).map(|e| (e.0.clone(), ())) else {
                    break;
                };
                if !seen.insert(src_id.clone()) {
                    break; // cycle guard
                }
                let Some(node) = nodes.get(&src_id) else { break };
                match node.kind {
                    Kind::Input => {
                        source = Some(node.clone());
                        break;
                    }
                    Kind::Volume => {
                        gain_nodes.push(node.clone());
                        level_nodes.push(node.clone());
                        cur = src_id;
                    }
                    Kind::Output | Kind::Passthrough => {
                        level_nodes.push(node.clone());
                        cur = src_id;
                    }
                }
            }
            // The output's own gain applies, and its meter shows the final level.
            gain_nodes.push(out_node.clone());
            level_nodes.push(out_node.clone());
            route_swap.store(Arc::new(Route { source, gain_nodes, level_nodes }));
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

// ── Audio thread: owns the cpal streams ──────────────────────────────────────

fn audio_thread(shared: Arc<Shared>, rx: std::sync::mpsc::Receiver<Command>) {
    let host = cpal::default_host();
    // Streams live here for their whole lifetime and never move to another thread.
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
    // Hand the consumer to the node so output callbacks can read it.
    if let Some(node) = shared.nodes.lock().unwrap().get(node_id) {
        *node.consumer.lock().unwrap() = Some(cons);
    }

    let err = |e| eprintln!("[audio] input stream error: {e}");
    let stream = match supported.sample_format() {
        SampleFormat::F32 => device.build_input_stream(&cfg, input_cb::<f32>(in_ch, prod), err, None),
        SampleFormat::I16 => device.build_input_stream(&cfg, input_cb::<i16>(in_ch, prod), err, None),
        SampleFormat::U16 => device.build_input_stream(&cfg, input_cb::<u16>(in_ch, prod), err, None),
        f => return Err(format!("unsupported input sample format: {f:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(stream)
}

fn input_cb<T>(in_ch: usize, mut prod: HeapProd<f32>) -> impl FnMut(&[T], &cpal::InputCallbackInfo)
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let in_ch = in_ch.max(1);
    let mut stereo = vec![0f32; MAX_BLOCK_FRAMES * 2];
    move |data: &[T], _| {
        let frames = (data.len() / in_ch).min(MAX_BLOCK_FRAMES);
        for i in 0..frames {
            let base = i * in_ch;
            let l = f32::from_sample(data[base]);
            let r = if in_ch >= 2 { f32::from_sample(data[base + 1]) } else { l };
            stereo[2 * i] = l;
            stereo[2 * i + 1] = r;
        }
        // Overrun (consumer behind) silently drops the excess — acceptable for a monitor.
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

    let route = shared
        .nodes
        .lock()
        .unwrap()
        .get(node_id)
        .and_then(|n| n.route.clone())
        .ok_or("output node missing route")?;

    let err = |e| eprintln!("[audio] output stream error: {e}");
    let stream = match supported.sample_format() {
        SampleFormat::F32 => device.build_output_stream(&cfg, output_cb::<f32>(out_ch, route), err, None),
        SampleFormat::I16 => device.build_output_stream(&cfg, output_cb::<i16>(out_ch, route), err, None),
        SampleFormat::U16 => device.build_output_stream(&cfg, output_cb::<u16>(out_ch, route), err, None),
        f => return Err(format!("unsupported output sample format: {f:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(stream)
}

fn output_cb<T>(
    out_ch: usize,
    route: Arc<ArcSwap<Route>>,
) -> impl FnMut(&mut [T], &OutputCallbackInfo)
where
    T: SizedSample + FromSample<f32>,
{
    let out_ch = out_ch.max(1);
    let mut stereo = vec![0f32; MAX_BLOCK_FRAMES * 2];
    move |data: &mut [T], _| {
        let frames = (data.len() / out_ch).min(MAX_BLOCK_FRAMES);
        let n = frames * 2;
        render(&route, &mut stereo[..n]);
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

/// Fill `stereo` (interleaved L/R) for one output block and update meters.
fn render(route_swap: &ArcSwap<Route>, stereo: &mut [f32]) {
    let route = route_swap.load();
    for s in stereo.iter_mut() {
        *s = 0.0;
    }
    let Some(source) = route.source.as_ref() else {
        for node in &route.level_nodes {
            node.set_all_meters(-72.0);
        }
        return;
    };

    // Pull captured audio from the input's ring buffer (zero-fill on underrun).
    let got = {
        let mut guard = source.consumer.lock().unwrap();
        match guard.as_mut() {
            Some(cons) => cons.pop_slice(stereo),
            None => 0,
        }
    };
    // Input gain → input meter (post-gain, matching the Web Audio engine).
    let g_in = source.gain_lin();
    if g_in != 1.0 {
        for s in stereo[..got].iter_mut() {
            *s *= g_in;
        }
    }
    source.set_all_meters(rms_to_db(rms(&stereo[..got])));

    // Cumulative gain of the chain (volumes + output).
    let mut g = 1.0f32;
    for node in &route.gain_nodes {
        g *= node.gain_lin();
    }
    if g != 1.0 {
        for s in stereo.iter_mut() {
            *s *= g;
        }
    }

    let out_db = rms_to_db(rms(stereo));
    for node in &route.level_nodes {
        node.set_all_meters(out_db);
    }
}

fn rms(buf: &[f32]) -> f32 {
    if buf.is_empty() {
        return 0.0;
    }
    let sum: f32 = buf.iter().map(|s| s * s).sum();
    (sum / buf.len() as f32).sqrt()
}

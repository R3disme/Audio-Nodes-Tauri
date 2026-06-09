// ────────────────────────────────────────────────────────────────────────────
// Per-channel DSP processors.
//
// One `Dsp` instance backs one channel of one effect node. Each `process` call
// transforms an interleaved-stereo block in place; `set_param` updates a named
// parameter (recomputing derived coefficients lazily on the next `process`, so
// the control thread never needs the sample rate).
//
// These mirror the Web Audio engine's effects (see AudioEngine.ts). Reverb is an
// algorithmic (Freeverb-style) approximation of the convolution reverb; the rest
// match closely.
// ────────────────────────────────────────────────────────────────────────────

use std::f32::consts::PI;
use std::sync::Arc;

use super::{Kind, Meter};

pub enum Dsp {
    Eq(Eq),
    Compressor(Comp),
    Gate(Gate),
    Reverb(Reverb),
    Delay(Delay),
    Chorus(Chorus),
    Distortion(Dist),
    Pan(Pan),
    Filter(Filter),
    Limiter(Limiter),
    Expander(Expander),
    Tremolo(Tremolo),
    Crusher(Crusher),
}

impl Dsp {
    pub fn new(kind: Kind, reduction: Option<Arc<Meter>>) -> Dsp {
        match kind {
            Kind::Eq => Dsp::Eq(Eq::new()),
            Kind::Compressor => Dsp::Compressor(Comp::new(reduction.unwrap_or_else(|| Arc::new(Meter::with(0.0))))),
            Kind::Gate => Dsp::Gate(Gate::new()),
            Kind::Reverb => Dsp::Reverb(Reverb::new()),
            Kind::Delay => Dsp::Delay(Delay::new()),
            Kind::Chorus => Dsp::Chorus(Chorus::new()),
            Kind::Distortion => Dsp::Distortion(Dist::new()),
            Kind::Filter => Dsp::Filter(Filter::new()),
            Kind::Limiter => Dsp::Limiter(Limiter::new()),
            Kind::Expander => Dsp::Expander(Expander::new()),
            Kind::Tremolo => Dsp::Tremolo(Tremolo::new()),
            Kind::Crusher => Dsp::Crusher(Crusher::new()),
            // Pan, plus a defensive fallback for non-DSP kinds (never constructed).
            _ => Dsp::Pan(Pan::new()),
        }
    }

    pub fn process(&mut self, buf: &mut [f32], sr: f32) {
        match self {
            Dsp::Eq(p) => p.process(buf, sr),
            Dsp::Compressor(p) => p.process(buf, sr),
            Dsp::Gate(p) => p.process(buf, sr),
            Dsp::Reverb(p) => p.process(buf, sr),
            Dsp::Delay(p) => p.process(buf, sr),
            Dsp::Chorus(p) => p.process(buf, sr),
            Dsp::Distortion(p) => p.process(buf),
            Dsp::Pan(p) => p.process(buf),
            Dsp::Filter(p) => p.process(buf, sr),
            Dsp::Limiter(p) => p.process(buf, sr),
            Dsp::Expander(p) => p.process(buf, sr),
            Dsp::Tremolo(p) => p.process(buf, sr),
            Dsp::Crusher(p) => p.process(buf),
        }
    }

    pub fn set_param(&mut self, param: &str, index: usize, value: f32) {
        match self {
            Dsp::Eq(p) => p.set_param(param, index, value),
            Dsp::Compressor(p) => p.set_param(param, value),
            Dsp::Gate(p) => p.set_param(param, value),
            Dsp::Reverb(p) => p.set_param(param, value),
            Dsp::Delay(p) => p.set_param(param, value),
            Dsp::Chorus(p) => p.set_param(param, value),
            Dsp::Distortion(p) => p.set_param(param, value),
            Dsp::Pan(p) => p.set_param(param, value),
            Dsp::Filter(p) => p.set_param(param, value),
            Dsp::Limiter(p) => p.set_param(param, value),
            Dsp::Expander(p) => p.set_param(param, value),
            Dsp::Tremolo(p) => p.set_param(param, value),
            Dsp::Crusher(p) => p.set_param(param, value),
        }
    }
}

// ── Biquad (RBJ cookbook, transposed direct form II) ─────────────────────────

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}
impl Biquad {
    fn identity() -> Self {
        Biquad { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: 0.0, z2: 0.0 }
    }
    fn set(&mut self, c: [f32; 5]) {
        self.b0 = c[0];
        self.b1 = c[1];
        self.b2 = c[2];
        self.a1 = c[3];
        self.a2 = c[4];
    }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

#[derive(Clone, Copy, PartialEq)]
enum FilterType {
    LowShelf,
    Peaking,
    HighShelf,
}

/// Coefficients normalised by a0, returned as [b0, b1, b2, a1, a2].
fn biquad_coeffs(ftype: FilterType, freq: f32, q: f32, gain_db: f32, sr: f32) -> [f32; 5] {
    let a = 10f32.powf(gain_db / 40.0);
    let w0 = 2.0 * PI * (freq / sr).clamp(1e-5, 0.4999);
    let cw = w0.cos();
    let sw = w0.sin();
    let alpha = sw / (2.0 * q.max(1e-4));
    let (b0, b1, b2, a0, a1, a2) = match ftype {
        FilterType::Peaking => (
            1.0 + alpha * a,
            -2.0 * cw,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cw,
            1.0 - alpha / a,
        ),
        FilterType::LowShelf => {
            let sa = 2.0 * a.sqrt() * alpha;
            (
                a * ((a + 1.0) - (a - 1.0) * cw + sa),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cw),
                a * ((a + 1.0) - (a - 1.0) * cw - sa),
                (a + 1.0) + (a - 1.0) * cw + sa,
                -2.0 * ((a - 1.0) + (a + 1.0) * cw),
                (a + 1.0) + (a - 1.0) * cw - sa,
            )
        }
        FilterType::HighShelf => {
            let sa = 2.0 * a.sqrt() * alpha;
            (
                a * ((a + 1.0) + (a - 1.0) * cw + sa),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cw),
                a * ((a + 1.0) + (a - 1.0) * cw - sa),
                (a + 1.0) - (a - 1.0) * cw + sa,
                2.0 * ((a - 1.0) - (a + 1.0) * cw),
                (a + 1.0) - (a - 1.0) * cw - sa,
            )
        }
    };
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

// ── EQ (5 fixed bands, only gain is adjustable) ──────────────────────────────

struct EqBand {
    ftype: FilterType,
    freq: f32,
    q: f32,
    gain_db: f32,
    l: Biquad,
    r: Biquad,
}

pub struct Eq {
    bands: Vec<EqBand>,
    sr: f32,
    dirty: bool,
}
impl Eq {
    fn new() -> Self {
        // Mirrors DEFAULT_EQ_BANDS in AudioEngine.ts.
        let defs = [
            (FilterType::LowShelf, 80.0, 0.7),
            (FilterType::Peaking, 240.0, 1.0),
            (FilterType::Peaking, 1000.0, 1.0),
            (FilterType::Peaking, 3500.0, 1.0),
            (FilterType::HighShelf, 10000.0, 0.7),
        ];
        let bands = defs
            .iter()
            .map(|&(ftype, freq, q)| EqBand {
                ftype,
                freq,
                q,
                gain_db: 0.0,
                l: Biquad::identity(),
                r: Biquad::identity(),
            })
            .collect();
        Eq { bands, sr: 0.0, dirty: true }
    }
    fn recompute(&mut self, sr: f32) {
        for b in &mut self.bands {
            let c = biquad_coeffs(b.ftype, b.freq, b.q, b.gain_db, sr);
            b.l.set(c);
            b.r.set(c);
        }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        if self.dirty || (sr - self.sr).abs() > 0.5 {
            self.recompute(sr);
            self.sr = sr;
            self.dirty = false;
        }
        let frames = buf.len() / 2;
        for i in 0..frames {
            let mut l = buf[2 * i];
            let mut r = buf[2 * i + 1];
            for b in &mut self.bands {
                l = b.l.process(l);
                r = b.r.process(r);
            }
            buf[2 * i] = l;
            buf[2 * i + 1] = r;
        }
    }
    fn set_param(&mut self, param: &str, index: usize, value: f32) {
        if param == "eqband" {
            if let Some(b) = self.bands.get_mut(index) {
                b.gain_db = value;
                self.dirty = true;
            }
        }
    }
}

// ── Compressor (feed-forward, soft knee, linked stereo) ──────────────────────

pub struct Comp {
    threshold: f32,
    knee: f32,
    ratio: f32,
    attack: f32,
    release: f32,
    env_db: f32, // smoothed gain reduction (dB, ≤ 0)
    att_c: f32,
    rel_c: f32,
    sr: f32,
    dirty: bool,
    reduction: Arc<Meter>,
}
impl Comp {
    fn new(reduction: Arc<Meter>) -> Self {
        Comp {
            threshold: -24.0,
            knee: 6.0,
            ratio: 4.0,
            attack: 0.003,
            release: 0.25,
            env_db: 0.0,
            att_c: 1.0,
            rel_c: 1.0,
            sr: 0.0,
            dirty: true,
            reduction,
        }
    }
    fn recompute(&mut self, sr: f32) {
        self.att_c = 1.0 - (-1.0 / (self.attack.max(1e-4) * sr)).exp();
        self.rel_c = 1.0 - (-1.0 / (self.release.max(1e-4) * sr)).exp();
    }
    /// Static compression curve → gain reduction in dB (≤ 0).
    fn reduction_db(&self, xdb: f32) -> f32 {
        let t = self.threshold;
        let k = self.knee;
        let r = self.ratio.max(1.0);
        if k > 0.0 && xdb > t - k / 2.0 && xdb < t + k / 2.0 {
            let over = xdb - t + k / 2.0;
            (1.0 / r - 1.0) * over * over / (2.0 * k)
        } else if xdb >= t + k / 2.0 {
            (t + (xdb - t) / r) - xdb
        } else {
            0.0
        }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        if self.dirty || (sr - self.sr).abs() > 0.5 {
            self.recompute(sr);
            self.sr = sr;
            self.dirty = false;
        }
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            let level = l.abs().max(r.abs());
            let xdb = 20.0 * (level + 1e-9).log10();
            let target = self.reduction_db(xdb);
            let c = if target < self.env_db { self.att_c } else { self.rel_c };
            self.env_db += (target - self.env_db) * c;
            let g = 10f32.powf(self.env_db / 20.0);
            buf[2 * i] = l * g;
            buf[2 * i + 1] = r * g;
        }
        self.reduction.set(self.env_db);
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "threshold" => self.threshold = value,
            "knee" => self.knee = value,
            "ratio" => self.ratio = value,
            "attack" => {
                self.attack = value;
                self.dirty = true;
            }
            "release" => {
                self.release = value;
                self.dirty = true;
            }
            _ => {}
        }
    }
}

// ── Noise gate (level-driven gain, linked stereo) ────────────────────────────

pub struct Gate {
    threshold: f32,
    attack: f32,
    release: f32,
    env: f32,  // detection envelope (linear)
    gate: f32, // current gate gain 0..1
    att_c: f32,
    rel_c: f32,
    det_c: f32,
    sr: f32,
    dirty: bool,
}
impl Gate {
    fn new() -> Self {
        Gate {
            threshold: -50.0,
            attack: 0.005,
            release: 0.1,
            env: 0.0,
            gate: 1.0,
            att_c: 1.0,
            rel_c: 1.0,
            det_c: 0.0,
            sr: 0.0,
            dirty: true,
        }
    }
    fn recompute(&mut self, sr: f32) {
        self.att_c = 1.0 - (-1.0 / (self.attack.max(1e-4) * sr)).exp();
        self.rel_c = 1.0 - (-1.0 / (self.release.max(1e-4) * sr)).exp();
        self.det_c = (-1.0 / (0.05 * sr)).exp(); // ~50 ms detector release
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        if self.dirty || (sr - self.sr).abs() > 0.5 {
            self.recompute(sr);
            self.sr = sr;
            self.dirty = false;
        }
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            let level = l.abs().max(r.abs());
            if level > self.env {
                self.env = level;
            } else {
                self.env *= self.det_c;
            }
            let db = if self.env > 1e-9 { 20.0 * self.env.log10() } else { -120.0 };
            let target = if db >= self.threshold { 1.0 } else { 0.0 };
            let c = if target > self.gate { self.att_c } else { self.rel_c };
            self.gate += (target - self.gate) * c;
            buf[2 * i] = l * self.gate;
            buf[2 * i + 1] = r * self.gate;
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "threshold" => self.threshold = value,
            "attack" => {
                self.attack = value;
                self.dirty = true;
            }
            "release" => {
                self.release = value;
                self.dirty = true;
            }
            _ => {}
        }
    }
}

// ── Distortion (tanh waveshaper + makeup, dry/wet) ───────────────────────────

pub struct Dist {
    drive: f32,
    mix: f32,
}
impl Dist {
    fn new() -> Self {
        Dist { drive: 5.0, mix: 0.5 }
    }
    fn process(&mut self, buf: &mut [f32]) {
        let k = self.drive.max(0.001);
        let makeup = 1.0 / k.max(1.0).sqrt();
        let dry = 1.0 - self.mix;
        for s in buf.iter_mut() {
            let wet = (k * *s).tanh() * makeup;
            *s = *s * dry + wet * self.mix;
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "drive" => self.drive = value,
            "mix" => self.mix = value,
            _ => {}
        }
    }
}

// ── Pan (StereoPanner equal-power, per the Web Audio spec) ────────────────────

pub struct Pan {
    pan: f32,
}
impl Pan {
    fn new() -> Self {
        Pan { pan: 0.0 }
    }
    fn process(&mut self, buf: &mut [f32]) {
        let p = self.pan.clamp(-1.0, 1.0);
        let x = if p <= 0.0 { p + 1.0 } else { p };
        let gl = (x * PI / 2.0).cos();
        let gr = (x * PI / 2.0).sin();
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            if p <= 0.0 {
                buf[2 * i] = l + r * gl;
                buf[2 * i + 1] = r * gr;
            } else {
                buf[2 * i] = l * gl;
                buf[2 * i + 1] = r + l * gr;
            }
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        if param == "pan" {
            self.pan = value;
        }
    }
}

// ── Delay / echo (stereo, feedback, dry/wet) ─────────────────────────────────

pub struct Delay {
    time: f32,
    feedback: f32,
    mix: f32,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    sr: f32,
}
impl Delay {
    fn new() -> Self {
        Delay {
            time: 0.3,
            feedback: 0.35,
            mix: 0.35,
            buf_l: Vec::new(),
            buf_r: Vec::new(),
            write: 0,
            sr: 0.0,
        }
    }
    fn ensure(&mut self, sr: f32) {
        if (sr - self.sr).abs() > 0.5 || self.buf_l.is_empty() {
            let len = ((5.0 * sr) as usize).max(1);
            self.buf_l = vec![0.0; len];
            self.buf_r = vec![0.0; len];
            self.write = 0;
            self.sr = sr;
        }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        self.ensure(sr);
        let len = self.buf_l.len();
        let d = ((self.time * sr) as usize).clamp(1, len - 1);
        let fb = self.feedback.clamp(0.0, 0.99);
        let dry = 1.0 - self.mix;
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            let read = (self.write + len - d) % len;
            let dl = self.buf_l[read];
            let dr = self.buf_r[read];
            self.buf_l[self.write] = l + dl * fb;
            self.buf_r[self.write] = r + dr * fb;
            buf[2 * i] = l * dry + dl * self.mix;
            buf[2 * i + 1] = r * dry + dr * self.mix;
            self.write = (self.write + 1) % len;
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "time" => self.time = value,
            "feedback" => self.feedback = value,
            "mix" => self.mix = value,
            _ => {}
        }
    }
}

// ── Chorus (LFO-modulated fractional delay, dry/wet) ─────────────────────────

const CHORUS_BASE_DELAY: f32 = 0.025; // 25 ms centre

pub struct Chorus {
    rate: f32,
    depth: f32,
    mix: f32,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write: usize,
    phase: f32,
    sr: f32,
}
impl Chorus {
    fn new() -> Self {
        Chorus {
            rate: 1.5,
            depth: 0.003,
            mix: 0.4,
            buf_l: Vec::new(),
            buf_r: Vec::new(),
            write: 0,
            phase: 0.0,
            sr: 0.0,
        }
    }
    fn ensure(&mut self, sr: f32) {
        if (sr - self.sr).abs() > 0.5 || self.buf_l.is_empty() {
            let len = (sr as usize).max(1); // 1 s
            self.buf_l = vec![0.0; len];
            self.buf_r = vec![0.0; len];
            self.write = 0;
            self.sr = sr;
        }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        self.ensure(sr);
        let len = self.buf_l.len();
        let dry = 1.0 - self.mix;
        let inc = 2.0 * PI * self.rate / sr;
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            let dt_l = (CHORUS_BASE_DELAY + self.depth * self.phase.sin()).max(0.0);
            let dt_r = (CHORUS_BASE_DELAY + self.depth * (self.phase + PI / 2.0).sin()).max(0.0);
            let wet_l = read_frac(&self.buf_l, self.write, dt_l * sr, len);
            let wet_r = read_frac(&self.buf_r, self.write, dt_r * sr, len);
            self.buf_l[self.write] = l;
            self.buf_r[self.write] = r;
            buf[2 * i] = l * dry + wet_l * self.mix;
            buf[2 * i + 1] = r * dry + wet_r * self.mix;
            self.write = (self.write + 1) % len;
            self.phase += inc;
            if self.phase > 2.0 * PI {
                self.phase -= 2.0 * PI;
            }
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "rate" => self.rate = value,
            "depth" => self.depth = value,
            "mix" => self.mix = value,
            _ => {}
        }
    }
}

/// Read `buf` `delay_samples` before `write` with linear interpolation.
#[inline]
fn read_frac(buf: &[f32], write: usize, delay_samples: f32, len: usize) -> f32 {
    let d = delay_samples.clamp(0.0, (len - 1) as f32);
    let pos = write as f32 - d;
    let pos = if pos < 0.0 { pos + len as f32 } else { pos };
    let i0 = pos.floor() as usize % len;
    let i1 = (i0 + 1) % len;
    let frac = pos - pos.floor();
    buf[i0] * (1.0 - frac) + buf[i1] * frac
}

// ── Reverb (Freeverb-style: parallel combs → series allpasses) ───────────────

const COMB_TUNING: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING: [usize; 4] = [556, 441, 341, 225];
const REVERB_INPUT_GAIN: f32 = 0.015;
const REVERB_WET_GAIN: f32 = 0.6;

struct Comb {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
    store: f32,
    damp1: f32,
    damp2: f32,
}
impl Comb {
    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let out = self.buf[self.idx];
        self.store = out * self.damp2 + self.store * self.damp1;
        self.buf[self.idx] = input + self.store * self.feedback;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
}

struct Allpass {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
}
impl Allpass {
    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let bufout = self.buf[self.idx];
        let out = -input + bufout;
        self.buf[self.idx] = input + bufout * self.feedback;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
}

pub struct Reverb {
    mix: f32,
    decay: f32,
    predelay: f32,
    combs: Vec<Comb>,
    allpasses: Vec<Allpass>,
    pre_buf: Vec<f32>,
    pre_idx: usize,
    sr: f32,
    dirty: bool,
}
impl Reverb {
    fn new() -> Self {
        Reverb {
            mix: 0.3,
            decay: 2.2,
            predelay: 0.02,
            combs: Vec::new(),
            allpasses: Vec::new(),
            pre_buf: Vec::new(),
            pre_idx: 0,
            sr: 0.0,
            dirty: true,
        }
    }
    fn rebuild(&mut self, sr: f32) {
        let scale = sr / 44100.0;
        self.combs = COMB_TUNING
            .iter()
            .map(|&t| {
                let len = ((t as f32) * scale) as usize;
                Comb {
                    buf: vec![0.0; len.max(1)],
                    idx: 0,
                    feedback: 0.0,
                    store: 0.0,
                    damp1: 0.2,
                    damp2: 0.8,
                }
            })
            .collect();
        self.allpasses = ALLPASS_TUNING
            .iter()
            .map(|&t| {
                let len = ((t as f32) * scale) as usize;
                Allpass { buf: vec![0.0; len.max(1)], idx: 0, feedback: 0.5 }
            })
            .collect();
        self.pre_buf = vec![0.0; (sr as usize).max(1)]; // up to 1 s pre-delay
        self.pre_idx = 0;
        self.update_feedback(sr);
    }
    fn update_feedback(&mut self, sr: f32) {
        let decay = self.decay.max(0.05);
        for c in &mut self.combs {
            let secs = c.buf.len() as f32 / sr;
            // T60 relation: feedback such that the comb decays by 60 dB over `decay`.
            c.feedback = 10f32.powf(-3.0 * secs / decay).min(0.98);
        }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        if (sr - self.sr).abs() > 0.5 || self.combs.is_empty() {
            self.rebuild(sr);
            self.sr = sr;
            self.dirty = false;
        } else if self.dirty {
            self.update_feedback(sr);
            self.dirty = false;
        }
        let plen = self.pre_buf.len();
        let pd = ((self.predelay * sr) as usize).min(plen - 1);
        let dry = 1.0 - self.mix;
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            let mono = (l + r) * 0.5;

            // Pre-delay line.
            self.pre_buf[self.pre_idx] = mono;
            let read = (self.pre_idx + plen - pd) % plen;
            let delayed = self.pre_buf[read];
            self.pre_idx = (self.pre_idx + 1) % plen;

            let input = delayed * REVERB_INPUT_GAIN;
            let mut acc = 0.0;
            for c in &mut self.combs {
                acc += c.process(input);
            }
            for ap in &mut self.allpasses {
                acc = ap.process(acc);
            }
            let wet = acc * REVERB_WET_GAIN;
            buf[2 * i] = l * dry + wet * self.mix;
            buf[2 * i + 1] = r * dry + wet * self.mix;
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "mix" => self.mix = value,
            "decay" => {
                self.decay = value;
                self.dirty = true;
            }
            "predelay" => self.predelay = value,
            _ => {}
        }
    }
}

// ── Filter (standalone biquad: low/high-pass, band-pass, notch) ───────────────

/// RBJ cookbook coefficients for the standalone filter types (normalised by a0).
/// `ftype`: 0 = low-pass, 1 = high-pass, 2 = band-pass (0 dB peak), 3 = notch.
fn filter_coeffs(ftype: u8, freq: f32, q: f32, sr: f32) -> [f32; 5] {
    let w0 = 2.0 * PI * (freq / sr).clamp(1e-5, 0.4999);
    let cw = w0.cos();
    let sw = w0.sin();
    let alpha = sw / (2.0 * q.max(1e-4));
    let a0 = 1.0 + alpha;
    let (b0, b1, b2, a1, a2) = match ftype {
        1 => ((1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0, -2.0 * cw, 1.0 - alpha), // high-pass
        2 => (alpha, 0.0, -alpha, -2.0 * cw, 1.0 - alpha),                              // band-pass
        3 => (1.0, -2.0 * cw, 1.0, -2.0 * cw, 1.0 - alpha),                             // notch
        _ => ((1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0, -2.0 * cw, 1.0 - alpha),    // low-pass
    };
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

pub struct Filter {
    ftype: u8,
    cutoff: f32,
    q: f32,
    l: Biquad,
    r: Biquad,
    sr: f32,
    dirty: bool,
}
impl Filter {
    fn new() -> Self {
        Filter { ftype: 0, cutoff: 1000.0, q: 0.707, l: Biquad::identity(), r: Biquad::identity(), sr: 0.0, dirty: true }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        if self.dirty || (sr - self.sr).abs() > 0.5 {
            let c = filter_coeffs(self.ftype, self.cutoff, self.q, sr);
            self.l.set(c);
            self.r.set(c);
            self.sr = sr;
            self.dirty = false;
        }
        let frames = buf.len() / 2;
        for i in 0..frames {
            buf[2 * i] = self.l.process(buf[2 * i]);
            buf[2 * i + 1] = self.r.process(buf[2 * i + 1]);
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "type" => self.ftype = value as u8,
            "cutoff" => self.cutoff = value,
            "q" => self.q = value,
            _ => {}
        }
        self.dirty = true;
    }
}

// ── Limiter (brickwall peak limiter: instant attack, adjustable release) ──────

pub struct Limiter {
    ceiling: f32, // linear threshold (from dB)
    release: f32,
    gain: f32, // current applied gain (≤ 1)
    rel_c: f32,
    sr: f32,
    dirty: bool,
}
impl Limiter {
    fn new() -> Self {
        Limiter { ceiling: 10f32.powf(-1.0 / 20.0), release: 0.10, gain: 1.0, rel_c: 1.0, sr: 0.0, dirty: true }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        if self.dirty || (sr - self.sr).abs() > 0.5 {
            self.rel_c = 1.0 - (-1.0 / (self.release.max(1e-4) * sr)).exp();
            self.sr = sr;
            self.dirty = false;
        }
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            let peak = l.abs().max(r.abs());
            // Gain needed to keep this peak under the ceiling.
            let target = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
            // Instant attack (catch the transient), smoothed release back up.
            if target < self.gain {
                self.gain = target;
            } else {
                self.gain += (target - self.gain) * self.rel_c;
            }
            buf[2 * i] = l * self.gain;
            buf[2 * i + 1] = r * self.gain;
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "threshold" => self.ceiling = 10f32.powf(value / 20.0),
            "release" => {
                self.release = value;
                self.dirty = true;
            }
            _ => {}
        }
    }
}

// ── Expander (downward expander: attenuate below threshold) ───────────────────

pub struct Expander {
    threshold: f32,
    ratio: f32,
    attack: f32,
    release: f32,
    env_db: f32, // smoothed gain reduction (dB, ≤ 0)
    att_c: f32,
    rel_c: f32,
    sr: f32,
    dirty: bool,
}
impl Expander {
    fn new() -> Self {
        Expander { threshold: -40.0, ratio: 2.0, attack: 0.005, release: 0.10, env_db: 0.0, att_c: 1.0, rel_c: 1.0, sr: 0.0, dirty: true }
    }
    /// Below threshold, attenuate by `(ratio-1)·(x-threshold)` dB (≤ 0). Above, unity.
    fn reduction_db(&self, xdb: f32) -> f32 {
        if xdb < self.threshold {
            (self.ratio.max(1.0) - 1.0) * (xdb - self.threshold)
        } else {
            0.0
        }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        if self.dirty || (sr - self.sr).abs() > 0.5 {
            self.att_c = 1.0 - (-1.0 / (self.attack.max(1e-4) * sr)).exp();
            self.rel_c = 1.0 - (-1.0 / (self.release.max(1e-4) * sr)).exp();
            self.sr = sr;
            self.dirty = false;
        }
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            let level = l.abs().max(r.abs());
            let xdb = 20.0 * (level + 1e-9).log10();
            let target = self.reduction_db(xdb);
            // More gain reduction = "attack" (gate closing faster than it opens).
            let c = if target < self.env_db { self.att_c } else { self.rel_c };
            self.env_db += (target - self.env_db) * c;
            let g = 10f32.powf(self.env_db / 20.0);
            buf[2 * i] = l * g;
            buf[2 * i + 1] = r * g;
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "threshold" => self.threshold = value,
            "ratio" => self.ratio = value,
            "attack" => {
                self.attack = value;
                self.dirty = true;
            }
            "release" => {
                self.release = value;
                self.dirty = true;
            }
            _ => {}
        }
    }
}

// ── Tremolo / Auto-pan (LFO-modulated amplitude or stereo position) ───────────

pub struct Tremolo {
    mode: u8,  // 0 = tremolo (amplitude), 1 = auto-pan (position)
    shape: u8, // 0 = sine, 1 = triangle
    rate: f32,
    depth: f32,
    phase: f32,
}
impl Tremolo {
    fn new() -> Self {
        Tremolo { mode: 0, shape: 0, rate: 5.0, depth: 0.7, phase: 0.0 }
    }
    /// Unipolar LFO in [0,1] for the current phase.
    #[inline]
    fn lfo01(&self) -> f32 {
        match self.shape {
            1 => {
                // Triangle.
                let t = self.phase / (2.0 * PI);
                if t < 0.5 { t * 2.0 } else { 2.0 - t * 2.0 }
            }
            _ => 0.5 + 0.5 * self.phase.sin(),
        }
    }
    fn process(&mut self, buf: &mut [f32], sr: f32) {
        let inc = 2.0 * PI * self.rate / sr.max(1.0);
        let depth = self.depth.clamp(0.0, 1.0);
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            let u = self.lfo01();
            if self.mode == 1 {
                // Auto-pan: equal-power, pan ∈ [-depth, depth].
                let p = (u * 2.0 - 1.0) * depth;
                let x = if p <= 0.0 { p + 1.0 } else { p };
                let gl = (x * PI / 2.0).cos();
                let gr = (x * PI / 2.0).sin();
                if p <= 0.0 {
                    buf[2 * i] = l + r * gl;
                    buf[2 * i + 1] = r * gr;
                } else {
                    buf[2 * i] = l * gl;
                    buf[2 * i + 1] = r + l * gr;
                }
            } else {
                // Tremolo: amplitude dips toward (1-depth) at the LFO trough.
                let g = 1.0 - depth * (1.0 - u);
                buf[2 * i] = l * g;
                buf[2 * i + 1] = r * g;
            }
            self.phase += inc;
            if self.phase > 2.0 * PI {
                self.phase -= 2.0 * PI;
            }
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "mode" => self.mode = value as u8,
            "shape" => self.shape = value as u8,
            "rate" => self.rate = value,
            "depth" => self.depth = value,
            _ => {}
        }
    }
}

// ── Bitcrusher (bit-depth quantize + sample-rate decimation, dry/wet) ─────────

pub struct Crusher {
    bits: f32,
    downsample: f32, // hold each sample for this many input samples (≥ 1)
    mix: f32,
    hold_l: f32,
    hold_r: f32,
    counter: f32,
}
impl Crusher {
    fn new() -> Self {
        Crusher { bits: 8.0, downsample: 1.0, mix: 1.0, hold_l: 0.0, hold_r: 0.0, counter: 0.0 }
    }
    fn process(&mut self, buf: &mut [f32]) {
        let levels = 2f32.powf(self.bits.clamp(1.0, 16.0));
        let half = (levels / 2.0).max(1.0);
        let step = self.downsample.max(1.0);
        let dry = 1.0 - self.mix;
        let frames = buf.len() / 2;
        for i in 0..frames {
            let l = buf[2 * i];
            let r = buf[2 * i + 1];
            self.counter += 1.0;
            if self.counter >= step {
                self.counter -= step;
                // Quantize to `bits` resolution.
                self.hold_l = (l * half).round() / half;
                self.hold_r = (r * half).round() / half;
            }
            buf[2 * i] = l * dry + self.hold_l * self.mix;
            buf[2 * i + 1] = r * dry + self.hold_r * self.mix;
        }
    }
    fn set_param(&mut self, param: &str, value: f32) {
        match param {
            "bits" => self.bits = value,
            "downsample" => self.downsample = value,
            "mix" => self.mix = value,
            _ => {}
        }
    }
}

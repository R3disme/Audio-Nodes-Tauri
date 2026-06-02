// ────────────────────────────────────────────────────────────────────────────
// Audio Nodes — native audio engine (Rust)
//
// Phase 0 scaffold. This crate compiles to a Node-API addon (`.node`) that the
// Electron main process loads. Right now it only proves the integration spine:
//   renderer ──IPC──► main ──N-API──► this crate
// returning version/diagnostic info and stub device lists.
//
// Phase 1 fills in the real engine: cpal/WASAPI device I/O, a lock-free command
// queue feeding an arc-swapped DSP graph on a fixed-block process thread, and a
// ThreadsafeFunction that streams RMS meter frames back to the renderer.
// ────────────────────────────────────────────────────────────────────────────

use cpal::traits::{DeviceTrait, HostTrait};
use napi_derive::napi;
use std::collections::HashMap;

mod engine;

/// Semantic version of the native engine crate (mirrors Cargo.toml).
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Enumerate audio endpoints in one direction via cpal's default host (WASAPI on
/// Windows). cpal exposes a device name but no stable id, so the name doubles as
/// the id for now; Phase 3's raw-WASAPI layer will supply stable endpoint ids.
fn list_devices(output: bool) -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_name = if output {
        host.default_output_device()
    } else {
        host.default_input_device()
    }
    .and_then(|d| d.name().ok());

    let devices = if output {
        host.output_devices()
    } else {
        host.input_devices()
    };

    let mut out = Vec::new();
    if let Ok(iter) = devices {
        for d in iter {
            if let Ok(name) = d.name() {
                let is_default = default_name.as_deref() == Some(name.as_str());
                out.push(AudioDevice {
                    id: name.clone(),
                    name,
                    is_default,
                });
            }
        }
    }
    out
}

/// Static diagnostic / capability info about this native build. The renderer's
/// NativeEngine logs this at init so we can confirm the addon loaded and see how
/// far the migration has progressed.
#[napi(object)]
pub struct EngineInfo {
    pub version: String,
    pub backend: String,
    /// Whether real audio I/O is wired yet. `false` until Phase 1 lands cpal/WASAPI.
    pub audio_ready: bool,
}

#[napi]
pub fn engine_info() -> EngineInfo {
    EngineInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        backend: "cpal/WASAPI".to_string(),
        audio_ready: true,
    }
}

/// An audio endpoint as seen by the native engine. Phase 3 will populate these
/// from WASAPI (richer than the renderer's MediaDeviceInfo: real default flags,
/// and eventually channel/sample-rate capabilities).
#[napi(object)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Handle to the native audio engine.
///
/// Phase 0 scaffold: it owns no real graph or streams yet. The Electron main
/// process holds a single instance and bridges calls to it over IPC. Methods are
/// intentionally thin until Phase 1 replaces the bodies with the real engine.
/// Handle to the native audio engine. Owns the control side; the realtime cpal
/// streams live on a dedicated audio thread (see engine.rs). The Electron main
/// process holds one instance and bridges calls over IPC.
#[napi]
pub struct NativeAudioEngine {
    engine: engine::Engine,
}

#[napi]
impl NativeAudioEngine {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        NativeAudioEngine { engine: engine::Engine::new() }
    }

    /// Kept for the main-process bridge; the engine starts in `new()`.
    #[napi]
    pub fn init(&self) {}

    #[napi]
    pub fn is_initialized(&self) -> bool {
        true
    }

    // ── Graph control ────────────────────────────────────────────────────────

    /// Create (or replace) a node. `node_type` is the store's type string; the
    /// engine maps unknown types to transparent passthrough so audio still flows.
    #[napi]
    pub fn create_node(&self, id: String, node_type: String, channels: u32, device_id: String) {
        self.engine.create_node(&id, &node_type, channels, &device_id);
    }

    #[napi]
    pub fn set_input_device(&self, id: String, device_id: String) {
        self.engine.set_input_device(&id, &device_id);
    }

    #[napi]
    pub fn set_output_device(&self, id: String, device_id: String) {
        self.engine.set_output_device(&id, &device_id);
    }

    #[napi]
    pub fn connect(&self, source: String, target: String) {
        self.engine.connect(&source, &target);
    }

    #[napi]
    pub fn disconnect(&self, source: String, target: String) {
        self.engine.disconnect(&source, &target);
    }

    #[napi]
    pub fn set_gain(&self, id: String, gain: f64) {
        self.engine.set_gain(&id, gain);
    }

    #[napi]
    pub fn set_muted(&self, id: String, muted: bool) {
        self.engine.set_muted(&id, muted);
    }

    #[napi]
    pub fn destroy_node(&self, id: String) {
        self.engine.destroy_node(&id);
    }

    /// Current meter levels: `"<nodeId>:<index>" -> dB`. Polled by the renderer.
    #[napi]
    pub fn meters(&self) -> HashMap<String, f64> {
        self.engine.meters()
    }

    // ── Device enumeration ─────────────────────────────────────────────────

    /// Capture (input) endpoints, enumerated via cpal/WASAPI.
    #[napi]
    pub fn input_devices(&self) -> Vec<AudioDevice> {
        list_devices(false)
    }

    /// Render (output) endpoints, enumerated via cpal/WASAPI.
    #[napi]
    pub fn output_devices(&self) -> Vec<AudioDevice> {
        list_devices(true)
    }
}

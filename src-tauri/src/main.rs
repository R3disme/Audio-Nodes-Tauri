#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use audio_engine_native::engine::{list_audio_apps, takeover_device, Engine};
use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Mutex,
};
use tauri::{AppHandle, CustomMenuItem, Manager, Runtime, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem, WindowEvent};

#[derive(Clone, Serialize)]
struct AudioDevice {
  id: String,
  name: String,
  #[serde(rename = "isDefault")]
  is_default: bool,
}

#[derive(Clone, Serialize)]
struct AudioDevices {
  inputs: Vec<AudioDevice>,
  outputs: Vec<AudioDevice>,
}

#[derive(Clone, Serialize)]
struct EngineInfo {
  version: String,
  backend: String,
  #[serde(rename = "audioReady")]
  audio_ready: bool,
}

#[derive(Clone, Serialize)]
struct AudioAppInfo {
  pid: u32,
  name: String,
  exe: String,
  active: bool,
}

#[derive(Clone, Serialize)]
struct WindowSource {
  id: String,
  name: String,
  #[serde(rename = "isScreen")]
  is_screen: bool,
  thumbnail: Option<String>,
  #[serde(rename = "appIcon")]
  app_icon: Option<String>,
}

#[derive(Clone, Serialize)]
struct SourceMatch {
  id: String,
  name: String,
}

#[derive(Clone, Serialize)]
struct DriverStatus {
  available: bool,
  building: bool,
}

#[derive(Clone, Serialize)]
struct BuildResult {
  code: i32,
  error: Option<String>,
}

#[derive(Clone, Serialize)]
struct InstallResult {
  ok: bool,
  error: Option<String>,
}

#[derive(Clone, Serialize)]
struct RecordingFile {
  bytes: Vec<u8>,
  ext: String,
  mime: String,
}

#[derive(Deserialize)]
struct BackgroundState {
  engine: String,
  busy: bool,
}

struct AppState {
  engine: Mutex<Engine>,
  driver_building: AtomicBool,
}

impl AppState {
  fn new() -> Self {
    Self {
      engine: Mutex::new(Engine::new()),
      driver_building: AtomicBool::new(false),
    }
  }
}

fn list_devices(output: bool) -> Vec<AudioDevice> {
  let host = cpal::default_host();
  let default_name = if output {
    host.default_output_device()
  } else {
    host.default_input_device()
  }
  .and_then(|device| device.name().ok());

  let devices = if output { host.output_devices() } else { host.input_devices() };
  devices
    .ok()
    .into_iter()
    .flatten()
    .filter_map(|device| {
      let name = device.name().ok()?;
      Some(AudioDevice {
        id: name.clone(),
        name: name.clone(),
        is_default: default_name.as_deref() == Some(name.as_str()),
      })
    })
    .collect()
}

fn engine_info() -> EngineInfo {
  EngineInfo {
    version: env!("CARGO_PKG_VERSION").to_string(),
    backend: "cpal/WASAPI".to_string(),
    audio_ready: true,
  }
}

fn driver_dir() -> String {
  Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("../native/driver")
    .to_string_lossy()
    .to_string()
}

fn driver_script(name: &str) -> String {
  Path::new(&driver_dir())
    .join(name)
    .to_string_lossy()
    .to_string()
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
  if let Some(window) = app.get_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[tauri::command]
fn renderer_bg_state(state: BackgroundState) {
  let _ = (state.engine, state.busy);
}

#[tauri::command]
fn driver_status(state: tauri::State<'_, AppState>) -> DriverStatus {
  DriverStatus {
    available: Path::new(&driver_script("build.ps1")).exists(),
    building: state.driver_building.load(Ordering::Relaxed),
  }
}

#[tauri::command]
async fn driver_build(app: AppHandle, state: tauri::State<'_, AppState>) -> BuildResult {
  let script = driver_script("build.ps1");
  if !Path::new(&script).exists() {
    return BuildResult {
      code: -1,
      error: Some("build.ps1 not found (native/driver missing)".to_string()),
    };
  }
  if state.driver_building.swap(true, Ordering::Relaxed) {
    return BuildResult {
      code: -1,
      error: Some("a build is already running".to_string()),
    };
  }

  let driver_dir = driver_dir();
  let app_clone = app.clone();
  let script_clone = script.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    let mut child = Command::new("powershell.exe")
      .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &script_clone])
      .current_dir(&driver_dir)
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn();

    let Ok(mut child) = child else {
      return BuildResult {
        code: -1,
        error: Some("failed to start PowerShell".to_string()),
      };
    };

    if let Some(stdout) = child.stdout.take() {
      let app = app_clone.clone();
      std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(stdout).lines().flatten() {
          let _ = app.emit_all("driver:log", line);
        }
      });
    }

    if let Some(stderr) = child.stderr.take() {
      let app = app_clone.clone();
      std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(stderr).lines().flatten() {
          let _ = app.emit_all("driver:log", line);
        }
      });
    }

    let code = match child.wait() {
      Ok(status) => status.code().unwrap_or(-1),
      Err(_) => -1,
    };
    BuildResult { code, error: None }
  })
  .await
  .unwrap_or(BuildResult {
    code: -1,
    error: Some("driver build task failed".to_string()),
  });

  state.driver_building.store(false, Ordering::Relaxed);
  result
}

#[tauri::command]
async fn driver_install(app: AppHandle) -> InstallResult {
  let script = driver_script("install.ps1");
  if !Path::new(&script).exists() {
    return InstallResult {
      ok: false,
      error: Some("install.ps1 not found".to_string()),
    };
  }

  let inner = format!("-NoExit -NoProfile -ExecutionPolicy Bypass -File \"{}\"", script);
  let cmd = format!("Start-Process powershell.exe -Verb RunAs -ArgumentList '{}'", inner);
  let _ = app.emit_all("driver:log", "> launching elevated installer (accept the UAC prompt)…");

  tauri::async_runtime::spawn_blocking(move || {
    Command::new("powershell.exe")
      .args(["-NoProfile", "-Command", &cmd])
      .current_dir(driver_dir())
      .spawn()
      .map(|_| InstallResult { ok: true, error: None })
      .unwrap_or_else(|e| InstallResult {
        ok: false,
        error: Some(e.to_string()),
      })
  })
  .await
  .unwrap_or(InstallResult {
    ok: false,
    error: Some("driver install task failed".to_string()),
  })
}

#[tauri::command]
fn list_window_sources() -> Vec<WindowSource> {
  list_audio_apps()
    .into_iter()
    .map(|app| WindowSource {
      id: app.exe.clone(),
      name: app.name,
      is_screen: false,
      thumbnail: None,
      app_icon: None,
    })
    .collect()
}

#[tauri::command]
fn find_source_by_name(name: String) -> Option<SourceMatch> {
  let lower = name.to_lowercase();
  list_audio_apps()
    .into_iter()
    .find(|app| app.name.to_lowercase() == lower || app.exe.to_lowercase() == lower)
    .map(|app| SourceMatch {
      id: app.exe,
      name: app.name,
    })
}

#[tauri::command]
fn arm_capture_source(_source_id: String) {}

#[tauri::command]
fn audio_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn audio_info() -> EngineInfo {
  engine_info()
}

#[tauri::command]
fn audio_get_devices() -> AudioDevices {
  AudioDevices {
    inputs: list_devices(false),
    outputs: list_devices(true),
  }
}

#[tauri::command]
fn audio_create_node(state: tauri::State<'_, AppState>, id: String, node_type: String, channels: u32, device_id: String) {
  if let Ok(engine) = state.engine.lock() {
    engine.create_node(&id, &node_type, channels, &device_id)
  }
}

#[tauri::command]
fn audio_set_output_device(state: tauri::State<'_, AppState>, id: String, device_id: String) {
  if let Ok(engine) = state.engine.lock() {
    engine.set_output_device(&id, &device_id)
  }
}

#[tauri::command]
fn audio_connect(state: tauri::State<'_, AppState>, source: String, source_channel: u32, target: String, target_channel: u32) {
  if let Ok(engine) = state.engine.lock() {
    engine.connect(&source, source_channel, &target, target_channel)
  }
}

#[tauri::command]
fn audio_disconnect(state: tauri::State<'_, AppState>, source: String, source_channel: u32, target: String, target_channel: u32) {
  if let Ok(engine) = state.engine.lock() {
    engine.disconnect(&source, source_channel, &target, target_channel)
  }
}

#[tauri::command]
fn audio_set_gain(state: tauri::State<'_, AppState>, id: String, gain: f64) {
  if let Ok(engine) = state.engine.lock() {
    engine.set_gain(&id, gain)
  }
}

#[tauri::command]
fn audio_set_muted(state: tauri::State<'_, AppState>, id: String, muted: bool) {
  if let Ok(engine) = state.engine.lock() {
    engine.set_muted(&id, muted)
  }
}

#[tauri::command]
fn audio_set_param(state: tauri::State<'_, AppState>, id: String, param: String, index: u32, value: f64) {
  if let Ok(engine) = state.engine.lock() {
    engine.set_param(&id, &param, index, value)
  }
}

#[tauri::command]
fn audio_set_latency_mode(state: tauri::State<'_, AppState>, mode: String) {
  if let Ok(engine) = state.engine.lock() {
    engine.set_latency_mode(&mode)
  }
}

#[tauri::command]
fn audio_set_device_mode(state: tauri::State<'_, AppState>, mode: String) {
  if let Ok(engine) = state.engine.lock() {
    engine.set_device_mode(&mode)
  }
}

#[tauri::command]
fn audio_destroy_node(state: tauri::State<'_, AppState>, id: String) {
  if let Ok(engine) = state.engine.lock() {
    engine.destroy_node(&id)
  }
}

#[tauri::command]
fn audio_poll_meters(state: tauri::State<'_, AppState>) -> std::collections::HashMap<String, f64> {
  state.engine.lock().map(|engine| engine.meters()).unwrap_or_default()
}

#[tauri::command]
fn audio_latency(state: tauri::State<'_, AppState>) -> f64 {
  state.engine.lock().map(|engine| engine.latency_ms()).unwrap_or(0.0)
}

#[tauri::command]
fn audio_start_recording(state: tauri::State<'_, AppState>, id: String) {
  if let Ok(engine) = state.engine.lock() {
    let _ = engine.start_recording(&id);
  }
}

#[tauri::command]
fn audio_stop_recording(state: tauri::State<'_, AppState>, id: String) -> Option<RecordingFile> {
  let path = state.engine.lock().ok()?.stop_recording(&id)?;
  let bytes = fs::read(&path).ok()?;
  Some(RecordingFile {
    bytes,
    ext: Path::new(&path)
      .extension()
      .and_then(|ext| ext.to_str())
      .unwrap_or("wav")
      .to_string(),
    mime: "audio/wav".to_string(),
  })
}

#[tauri::command]
fn audio_push_capture(state: tauri::State<'_, AppState>, id: String, samples: Vec<f32>, sample_rate: f64) {
  if let Ok(engine) = state.engine.lock() {
    engine.push_capture(&id, &samples, sample_rate)
  }
}

#[tauri::command]
fn audio_list_apps() -> Vec<AudioAppInfo> {
  list_audio_apps()
    .into_iter()
    .map(|app| AudioAppInfo {
      pid: app.pid,
      name: app.name,
      exe: app.exe,
      active: app.active,
    })
    .collect()
}

#[tauri::command]
fn audio_set_app_process(state: tauri::State<'_, AppState>, id: String, pid: i64, takeover: bool) {
  if let Ok(engine) = state.engine.lock() {
    engine.set_app_process(&id, pid, takeover)
  }
}

#[tauri::command]
fn audio_takeover_device() -> Option<String> {
  takeover_device(Vec::new())
}

fn tray_menu() -> SystemTrayMenu {
  SystemTrayMenu::new()
    .add_item(CustomMenuItem::new("show".to_string(), "Show Audio Nodes"))
    .add_native_item(SystemTrayMenuItem::Separator)
    .add_item(CustomMenuItem::new("quit".to_string(), "Quit"))
}

fn main() {
  tauri::Builder::default()
    .manage(AppState::new())
    .system_tray(SystemTray::new().with_menu(tray_menu()))
    .on_system_tray_event(|app, event| match event {
      SystemTrayEvent::LeftClick { .. } => show_main_window(app),
      SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
        "show" => show_main_window(app),
        "quit" => app.exit(0),
        _ => {}
      },
      _ => {}
    })
    .on_window_event(|event| {
      if let WindowEvent::CloseRequested { api, .. } = event.event() {
        api.prevent_close();
        let _ = event.window().hide();
      }
    })
    .invoke_handler(tauri::generate_handler![
      renderer_bg_state,
      driver_status,
      driver_build,
      driver_install,
      list_window_sources,
      find_source_by_name,
      arm_capture_source,
      audio_version,
      audio_info,
      audio_get_devices,
      audio_create_node,
      audio_set_output_device,
      audio_connect,
      audio_disconnect,
      audio_set_gain,
      audio_set_muted,
      audio_set_param,
      audio_set_latency_mode,
      audio_set_device_mode,
      audio_destroy_node,
      audio_poll_meters,
      audio_latency,
      audio_start_recording,
      audio_stop_recording,
      audio_push_capture,
      audio_list_apps,
      audio_set_app_process,
      audio_takeover_device
    ])
    .setup(|app| {
      if let Some(window) = app.get_window("main") {
        let _ = window.hide();
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
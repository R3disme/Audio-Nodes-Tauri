// napi-build wires up the N-API delay-load shim so the cdylib resolves Node/
// Electron symbols at load time. Required for the addon to load in the host.
fn main() {
    napi_build::setup();
}

# Branding for the Audio Nodes Virtual Cable.
#
# rebrand.ps1 stamps these onto a build copy of the vendored upstream driver
# (native/driver/vendor/Virtual-Audio-Driver) so we never edit the submodule.
# These are the *display* names users see in Windows Sound settings + the device
# identity. Change freely — they're all that distinguishes our cable from upstream.
@{
    # Provider / manufacturer / copyright shown in driver properties.
    Provider      = 'Audio Nodes'

    # Device description (Device Manager) + service display name.
    DeviceDesc    = 'Audio Nodes Virtual Cable'

    # Endpoint friendly names in Sound settings. The "speaker" is what other apps
    # play INTO; the "mic" is what Audio Nodes (or any app) records FROM.
    PlaybackName  = 'Audio Nodes Virtual Cable (Playback)'
    RecordingName = 'Audio Nodes Virtual Cable (Recording)'

    # Root-enumerated hardware id. Changed from upstream's ROOT\VirtualAudioDriver
    # so our cable is a distinct PnP device (don't run both at once — see README).
    HardwareId    = 'ROOT\AudioNodesVirtualCable'

    # Self-signed code-signing cert used for local test-signing (build.ps1).
    TestCertName  = 'Audio Nodes Test'
}

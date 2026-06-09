// Resolve a persisted audio device to a currently-present one.
//
// A saved `deviceId` can stop resolving across reboots / hot-plugs — Windows +
// Chromium hand out fresh ids, and a hub or dock can renumber endpoints. The
// device *name* (the MediaDeviceInfo.label we persist alongside the id) is far more
// stable, so when the exact id is gone we fall back to matching by label, then by a
// normalized label prefix (labels often carry a changing suffix like "(2- USB Audio)").
//
// Shared by both backends so the renderer can re-resolve a device before handing the
// id to either engine. Pure + dependency-free.

export type DeviceKind = 'audioinput' | 'audiooutput'

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Return the `deviceId` of a currently-present device matching the saved selection,
 * or `undefined` if none is present yet. Tries, in order: exact id, exact label,
 * normalized label prefix (either direction). Empty / "Default" names don't name-match
 * — an empty saved id already means "system default", handled by the caller.
 */
export function resolveDeviceId(
  devices: readonly MediaDeviceInfo[],
  savedId: string | undefined,
  savedName: string | undefined,
  kind: DeviceKind
): string | undefined {
  const pool = devices.filter(d => d.kind === kind)

  if (savedId) {
    const byId = pool.find(d => d.deviceId === savedId)
    if (byId) return byId.deviceId
  }

  const name = (savedName ?? '').trim()
  if (name && name.toLowerCase() !== 'default') {
    const byLabel = pool.find(d => d.label === name)
    if (byLabel) return byLabel.deviceId

    const target = norm(name)
    if (target) {
      const byPrefix = pool.find(d => {
        const l = norm(d.label)
        return l !== '' && (l.startsWith(target) || target.startsWith(l))
      })
      if (byPrefix) return byPrefix.deviceId
    }
  }

  return undefined
}

// STUB @zos/device
export function getDeviceInfo() {
  const s = globalThis.__stub || {}
  if (s.throwDeviceInfo) throw new Error('deviceInfo boom')
  return s.deviceInfo === undefined ? { width: 466, height: 466 } : s.deviceInfo
}

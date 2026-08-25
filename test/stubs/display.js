// STUB of @zos/display for the tests under Node.
export function setPageBrightTime(opts) {
  const s = globalThis.__stub || {}
  if (s.throwBrightTime) throw new Error('brightTime boom')
  s.brightTime = opts && opts.brightTime
  return true
}

export function resetPageBrightTime() {
  return true
}

export function setBrightness(opts) {
  const s = globalThis.__stub || {}
  if (s.throwBrightness) throw new Error('brightness boom')
  s.brightness = opts && opts.level
  return true
}

// SYSTEM brightness: it is read so it can be given back the way it was.
export function getBrightness() {
  const s = globalThis.__stub || {}
  if (s.throwGetBrightness) throw new Error('getBrightness boom')
  return s.initialBrightness === undefined ? 50 : s.initialBrightness
}

export function pauseDropWristScreenOff() {
  return true
}

export function pausePalmScreenOff() {
  return true
}

// STUBS of the Zepp APIs for the tests under Node. Driven by globalThis.__stub.
// Accelerometer: values in thousandths of g. With a still wrist the magnitude is
// gravity, ~1000 (measured on the device on 23 Aug); shaking the arm it reaches
// 2765. The stub returns whatever the test puts in __stub.acc.
export class Accelerometer {
  start() {
    const s = globalThis.__stub || {}
    if (s.throwAccStart) throw new Error('accelerometer unavailable')
    s.accStarted = true
  }
  stop() {
    const s = globalThis.__stub || {}
    s.accStarted = false
  }
  setFreqMode() {}
  getCurrent() {
    const s = globalThis.__stub || {}
    if (s.throwAcc) throw new Error('acc boom')
    return s.acc === undefined ? { x: 0, y: 0, z: 1000 } : s.acc
  }
}

export class Vibrator {
  start() {
    const s = globalThis.__stub || {}
    if (s.throwVibrate) throw new Error('vibrate boom')
    s.vibrations = (s.vibrations || 0) + 1
    s.vibrationModes = s.vibrationModes || []
    s.vibrationModes.push(s.__lastMode)
  }
  stop() {}
  setMode(m) {
    const s = globalThis.__stub || {}
    if (s.throwSetMode) throw new Error('setMode not supported')
    s.__lastMode = m
  }
  getConfig() {
    return {}
  }
}

export const VIBRATOR_SCENE_SHORT_LIGHT = 0
export const VIBRATOR_SCENE_SHORT_MIDDLE = 1
export const VIBRATOR_SCENE_SHORT_STRONG = 2
export const VIBRATOR_SCENE_DURATION = 3
export const VIBRATOR_SCENE_DURATION_LONG = 4
export const VIBRATOR_SCENE_STRONG_REMINDER = 5
export const VIBRATOR_SCENE_NOTIFICATION = 6
export const VIBRATOR_SCENE_CALL = 7
export const VIBRATOR_SCENE_TIMER = 8

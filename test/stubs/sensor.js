// STUBS of the Zepp APIs for the tests under Node. Driven by globalThis.__stub.
export class Sleep {
  updateInfo() {
    const s = globalThis.__stub || {}
    s.updateInfoCalls = (s.updateInfoCalls || 0) + 1
    if (s.throwUpdateInfo) throw new Error('updateInfo boom')
  }
  getSleepingStatus() {
    const s = globalThis.__stub || {}
    if (s.throwStatus) throw new Error('status boom')
    return s.sleepingStatus
  }
  getStage() {
    const s = globalThis.__stub || {}
    if (s.throwStage) throw new Error('stage boom')
    return s.stages
  }
  getInfo() {
    const s = globalThis.__stub || {}
    if (s.throwInfo) throw new Error('info boom')
    return s.info
  }
  // The stage codes as the device would give them. The tests set them to values
  // that are NON-contiguous and different from 0..3 on purpose: nothing must be
  // hardcoded in the source.
  getStageConstantObj() {
    const s = globalThis.__stub || {}
    if (s.throwStageConsts) throw new Error('stageConsts boom')
    return s.stageConstants
  }
}

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

// Wear: 0 not worn, 1 still on the wrist, 2 MOVING, 3 uncertain.
export class Wear {
  getStatus() {
    const s = globalThis.__stub || {}
    if (s.throwWear) throw new Error('wear boom')
    return s.wearStatus === undefined ? 1 : s.wearStatus
  }
  onChange() {}
  offChange() {}
}

export class HeartRate {
  getLast() {
    const s = globalThis.__stub || {}
    if (s.throwHr) throw new Error('hr boom')
    return s.hr
  }
  getCurrent() {
    return (globalThis.__stub || {}).hr
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

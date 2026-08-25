// Vibration. Three intensities, because "strong enough to wake me up" cannot be
// deduced from the documentation: it has to be tried on an actual wrist.
import {
  Vibrator,
  VIBRATOR_SCENE_SHORT_STRONG,
  VIBRATOR_SCENE_STRONG_REMINDER,
  VIBRATOR_SCENE_CALL,
} from '@zos/sensor'

export const LEVEL = { LIGHT: 1, REMINDER: 2, CALL: 3 }

function sceneFor(level) {
  if (level === LEVEL.LIGHT) return VIBRATOR_SCENE_SHORT_STRONG
  if (level === LEVEL.CALL) return VIBRATOR_SCENE_CALL
  return VIBRATOR_SCENE_STRONG_REMINDER
}

// Returns a diagnostic string: there is no console on the watch, so the result
// must be able to end up on screen or in the log.
export function buzz(level, repeats) {
  const n = repeats || 1
  try {
    const v = new Vibrator()
    for (let i = 0; i < n; i++) {
      try {
        v.setMode(sceneFor(level))
      } catch (e) {
        // Some firmware refuses setMode: try start() anyway.
      }
      v.start()
    }
    return 'ok'
  } catch (e) {
    return 'err:' + (e && e.message ? e.message : 'unknown')
  }
}

// The real alarm: it insists, because a single buzz during sleep is not enough.
export function wakeBuzz() {
  let out = ''
  for (let i = 0; i < 6; i++) {
    out = buzz(LEVEL.CALL, 1)
    if (out !== 'ok') break
  }
  return out
}

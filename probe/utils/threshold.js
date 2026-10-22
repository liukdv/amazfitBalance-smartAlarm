// Thresholds for changes between accelerometer vectors, in mg at 5 Hz.
// These are initial sensitivity presets, not calibrated sleep-stage boundaries.
// Persist the user's preset name so old numeric gravity-deviation thresholds
// cannot silently override this different measurement after an app update.
export const CONFIRMATIONS = 3
const CONFIRMATION_MS = 3000
// Consecutive readings from one short twitch must not count as separate confirmations.
const CONFIRMATION_GAP_MS = 500
const MAX_SAMPLE_GAP_MS = 1000

/** Use normal sensitivity when a saved preference is missing or invalid. */
export function normalizeSensitivity(value) {
  return value === 'low' || value === 'high' ? value : 'normal'
}

/** Return the preset, or a gentle +20% to -20% ramp over a valid alarm window. */
export function motionThreshold(sensitivity, remainingSec, windowSec) {
  const preset = normalizeSensitivity(sensitivity)
  const base = preset === 'high' ? 25 : preset === 'low' ? 100 : 50
  if (typeof remainingSec !== 'number' || !isFinite(remainingSec) ||
      typeof windowSec !== 'number' || !isFinite(windowSec) || windowSec <= 0) return base
  const remaining = Math.max(0, Math.min(1, remainingSec / windowSec))
  return Math.round(base * (0.8 + 0.4 * remaining))
}

/** Measure wrist activity; the caller may adjust threshold as the window advances. */
export class MotionDetector {
  constructor(sensitivity) {
    this.threshold = motionThreshold(sensitivity)
    this.reset()
  }

  /** Missing readings break continuity: do not compare across a sensor outage. */
  reset() {
    this.previous = null
    this.hits = []
  }

  /** Return activity and confirmations, or null until two valid samples exist. */
  sample(x, y, z, now) {
    if (![x, y, z, now].every((v) => typeof v === 'number' && isFinite(v))) {
      this.reset()
      return null
    }
    const magnitude = Math.sqrt(x * x + y * y + z * z)
    // Gravity is about 1000 mg at rest. Reject startup zeros and wrong units.
    if (magnitude < 300 || magnitude > 8000) {
      this.reset()
      return null
    }
    const previous = this.previous
    this.previous = { x, y, z, time: now }
    if (!previous || now < previous.time || now - previous.time > MAX_SAMPLE_GAP_MS) {
      this.hits = []
      return null
    }
    const dx = x - previous.x
    const dy = y - previous.y
    const dz = z - previous.z
    const movement = Math.sqrt(dx * dx + dy * dy + dz * dz)
    this.hits = this.hits.filter((time) => now - time < CONFIRMATION_MS)
    const lastHit = this.hits[this.hits.length - 1]
    if (movement > this.threshold &&
        (lastHit === undefined || now - lastHit >= CONFIRMATION_GAP_MS)) this.hits.push(now)
    return { movement, confirmations: this.hits.length, wake: this.hits.length >= CONFIRMATIONS }
  }
}

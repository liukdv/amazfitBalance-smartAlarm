// THE THRESHOLD CURVE — numbers tuned on the logs of the first two real nights
// (24→25 Aug 2026 and the 08:55 test).
//
// The ruler, measured on an actual wrist (thousandths of g, deviation from 1000):
//   dead still, "like a grave"    → peak ~20-30, mean ~15
//   light movement (rolling over) → peak ~100
//   significant movement          → peak ~500
//
// The threshold DROPS as the alarm time approaches: half an hour out it takes a
// significant movement, in the last few minutes a twitch is enough, and in the
// final minute anything above grave-level will do ("by then I have to get up
// anyway").
//
// TWO CRITERIA, in parallel:
//   PEAK  three readings above the threshold within three seconds (the jolt)
//   MEAN  the mean deviation over the last two minutes. In the last 10 minutes
//         it is FIXED at 50: the noise floor of a motionless body sits at 9-22,
//         and the old "half the peak" rule fell below that noise — proven on
//         25 Aug at 08:59, when it rang on «mean 26 over 20» as soon as the
//         threshold dropped. Beyond 10 minutes it stays at half the peak.

// Steps: the first one whose window covers the remaining seconds. Ordered from
// closest to the alarm time to furthest away.
const STEPS = [
  { within: 60, peak: 20 }, // last minute: grave level, almost anything counts
  { within: 120, peak: 40 },
  { within: 180, peak: 60 },
  { within: 300, peak: 80 }, // 5 → 3 min
  { within: 600, peak: 100 }, // 10 → 5 min: light movement
  { within: 900, peak: 200 }, // 15 → 10 min
  { within: 1200, peak: 300 }, // 20 → 15 min
]
const FAR = 500 // 30 → 20 min: only a significant movement

// In the last 10 minutes the mean stops following the peak: it stays put here.
const LAST_10_MIN = 600
const MEAN_LAST_10_MIN = 50

function normalize(secondsLeft) {
  return typeof secondsLeft === 'number' && isFinite(secondsLeft)
    ? Math.max(0, secondsLeft)
    : 0
}

/**
 * The PEAK threshold right now.
 * @param secondsLeft how many seconds remain until the alarm time
 */
export function peakThreshold(secondsLeft) {
  const s = normalize(secondsLeft)
  for (let i = 0; i < STEPS.length; i++) {
    if (s <= STEPS[i].within) return STEPS[i].peak
  }
  return FAR
}

// The MEAN threshold: fixed over the last 10 minutes, half the peak before that.
export function meanThreshold(secondsLeft) {
  const s = normalize(secondsLeft)
  if (s <= LAST_10_MIN) return MEAN_LAST_10_MIN
  return peakThreshold(s) / 2
}

// The steps, so they can be written to the diary and re-read the next morning.
export function describeCurve() {
  return (
    STEPS.map((g) => g.within + 's:' + g.peak).join(' ') +
    ' beyond:' + FAR +
    ' mean10m:' + MEAN_LAST_10_MIN
  )
}

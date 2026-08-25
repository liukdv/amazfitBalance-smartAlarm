// Alarm time arithmetic. Pure maths, testable without a watch.

// The next occurrence of HH:MM. If the time has already passed today, it is
// tomorrow: at 23:50 you set "07:30" meaning tomorrow morning, not this morning.
export function nextOccurrence(nowUnix, h, m) {
  const now = new Date(nowUnix * 1000)
  const t = new Date(now.getTime())
  t.setHours(h, m, 0, 0)
  let target = Math.floor(t.getTime() / 1000)
  if (target <= nowUnix) target += 24 * 3600
  return target
}

export const TICK_IN_WINDOW = 60
export const TICK_FAR = 1800 // half an hour: no need to wake up every minute all night

/**
 * How many seconds until the service should wake up again.
 *
 * Outside the window we move in long steps — 480 wake-ups in one night would
 * cost battery for nothing. But we NEVER jump straight to the target: a chain
 * that re-arms often survives a missed link, a single alarm eight hours away
 * does not. As the target approaches, the step shortens by itself.
 */
export function nextDelay(nowUnix, targetUnix, windowSec) {
  const windowOpens = targetUnix - windowSec
  if (nowUnix >= windowOpens) return TICK_IN_WINDOW
  const toWindow = windowOpens - nowUnix
  if (toWindow <= TICK_FAR) return Math.max(30, toWindow)
  return TICK_FAR
}

export function fmtTime(h, m) {
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return p(h) + ':' + p(m)
}

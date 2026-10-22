// Alarm time arithmetic. Pure maths, testable without a watch.

// Day numbers follow Date.getDay(); the UI starts the week on Monday.
export const WEEKDAYS = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' }, { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' },
]

/** Validate and deduplicate selected weekdays; an empty list means once. */
export function normalizeDays(days = []) {
  if (!Array.isArray(days) || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('Invalid repeat days')
  }
  return WEEKDAYS.filter(({ day }) => days.includes(day)).map(({ day }) => day)
}

/** Describe a saved recurrence in the editor and the alarm list. */
export function fmtDays(days = []) {
  const selected = normalizeDays(days)
  if (!selected.length) return 'Once'
  if (selected.length === 7) return 'Every day'
  if (selected.join(',') === '1,2,3,4,5') return 'Weekdays'
  if (selected.join(',') === '6,0') return 'Weekends'
  return WEEKDAYS.filter(({ day }) => selected.includes(day)).map(({ label }) => label).join(' ')
}

/** Find the next local HH:MM on an allowed day, strictly after nowUnix. */
export function nextOccurrence(nowUnix, h, m, days = []) {
  const selected = normalizeDays(days)
  const now = new Date(nowUnix * 1000)
  for (let offset = 0; offset <= 7; offset++) {
    const t = new Date(now.getTime())
    // Advance calendar dates, not 86400-second intervals across DST changes.
    t.setDate(now.getDate() + offset)
    t.setHours(h, m, 0, 0)
    const target = Math.floor(t.getTime() / 1000)
    if (target > nowUnix && (!selected.length || selected.includes(t.getDay()))) return target
  }
  throw new Error('Cannot find next alarm day')
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

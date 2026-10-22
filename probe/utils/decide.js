/** The background service only enforces the deadline; the page handles movement. */
export function decide({ nowUnix, targetUnix, windowSec }) {
  if (nowUnix >= targetUnix) return { fire: true, reason: 'deadline' }
  if (nowUnix < targetUnix - windowSec) return { fire: false, reason: 'outside window' }
  return { fire: false, reason: 'waiting for movement' }
}

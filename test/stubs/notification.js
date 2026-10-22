/** Record local notifications without touching an actual device. */
export function notify(options) {
  const s = globalThis.__stub || {}
  if (s.throwNotify) throw new Error('notification unavailable')
  if (s.rejectNotification) return 0
  s.notifications = (s.notifications || []).concat([options])
  return s.notifications.length
}

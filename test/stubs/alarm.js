// STUB @zos/alarm — records the alarms instead of scheduling them.
export const ONCE = 0
export const REPEAT_MINUTE = 1
export const REPEAT_HOUR = 2
export const REPEAT_DAY = 3

let seq = 100
export const __scheduled = []

export function __reset() {
  __scheduled.length = 0
  seq = 100
}

export function set(opts) {
  const s = globalThis.__stub || {}
  if (s.throwAlarmSet) throw new Error('alarm boom')
  const id = seq++
  __scheduled.push({ id, ...opts })
  return id
}

export function cancel(id) {
  const i = __scheduled.findIndex((a) => a.id === id)
  if (i >= 0) __scheduled.splice(i, 1)
  return 0
}

export function getAllAlarms() {
  const s = globalThis.__stub || {}
  if (s.throwGetAllAlarms) throw new Error('getAllAlarms not supported')
  return __scheduled.map((a) => a.id)
}

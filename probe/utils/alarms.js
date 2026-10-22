// Each alarm has its own file: a service tick must not overwrite another
// alarm's settings. The generation in every callback invalidates old timers.
import * as alarmMgr from '@zos/alarm'
import { getPackageInfo } from '@zos/app'
import { load, patch, readRecord, recordExists, save } from './store'
import { nextOccurrence, nextDelay, normalizeDays } from './schedule'
import { logEvent } from './log'

const INDEX = 'alarms.json'
const pathOf = (id) => 'alarm-' + id + '.json'
const stopped = () => ({ mode: 'idle', ringStop: 1, done: 1, targetUnix: 0 })
const validId = (id) => Number.isInteger(id) && id > 0
// Allow the deadline failsafes and their foreground vibration rounds to finish.
export const REPEAT_AFTER_SEC = 10 * 60

function write(path, value) {
  if (!save(value, path)) {
    logEvent('ALARM storage ERROR', { path })
    throw new Error('Cannot save alarm')
  }
}

function readIndex() {
  const index = readRecord(INDEX)
  if (index && Array.isArray(index.ids) && validId(index.nextId)) return index
  if (recordExists(INDEX)) throw new Error('Cannot read saved alarms')
  return null
}

function cancel(ids) {
  let count = 0
  Object.keys(ids || {}).forEach((key) => {
    try {
      alarmMgr.cancel(ids[key])
      count++
    } catch (e) {
      logEvent('ALARM cancel ERROR', { timer: ids[key], error: String(e) })
    }
  })
  return count
}

/** Migrate the existing alarm without moving its deadline or cancelling it. */
export function initAlarms() {
  const existing = readIndex()
  if (existing) return existing
  const old = load()
  const scheduled = {}
  const ids = alarmMgr.getAllAlarms()
  ids.forEach((id, i) => { scheduled['legacy' + i] = id })
  write(pathOf(1), { ...old, id: 1, generation: 1, legacy: true, scheduled })
  const index = { ids: [1], nextId: 2 }
  write(INDEX, index)
  logEvent('ALARMS migrated', { mode: old.mode, target: old.targetUnix })
  return index
}

/** Return saved alarms in creation order, including disabled ones. */
export function listAlarms() {
  const index = readIndex()
  if (!index) return []
  return index.ids.map((id) => {
    const alarm = readRecord(pathOf(id))
    if (!alarm) throw new Error('Cannot read alarm ' + id)
    return alarm
  })
}

/** Read one saved alarm; deleted alarms are never returned. */
export function getAlarm(id) {
  if (!validId(id)) return null
  const alarm = readRecord(pathOf(id))
  return alarm && !alarm.deleted ? alarm : null
}

/** An early vibration timeout leaves the exact-time failsafe armed. */
export function alarmEnabled(value) {
  return value.ringStop !== 1 && (
    value.mode === 'alarm' || value.mode === 'ringing' ||
    ((value.weekdays || []).length > 0 && !!(value.scheduled || {}).repeat) ||
    (value.targetUnix > Date.now() / 1000 &&
      Object.keys(value.scheduled || {}).length > 0)
  )
}

function decode(params) {
  if (typeof params === 'string') {
    try { return JSON.parse(params) } catch (e) { return null }
  }
  return params && typeof params === 'object' ? params : null
}

/** Take the alarm launch argument supplied to app.onCreate or page.onInit. */
export function pageAlarm(params) {
  let launch
  try {
    const data = getApp()._options.globalData
    launch = data.alarmLaunch
    data.alarmLaunch = null
  } catch (e) {}
  return alarmContext(params || launch)
}

/** Bind all reads, writes and timers to one immutable alarm generation. */
export function alarmContext(params) {
  const parsed = decode(params)
  let id = parsed && parsed.id
  let generation = parsed && parsed.generation
  const index = parsed ? null : readRecord(INDEX)
  if (!validId(id) && index && !parsed) {
    const legacy = getAlarm(1)
    if (legacy && legacy.legacy) {
      id = 1
      generation = legacy.generation
    }
  }
  const legacy = !index && !parsed && !recordExists(INDEX)
  const event = parsed ? parsed.event : params
  const current = () => {
    const value = getAlarm(id)
    return value && value.generation === generation ? value : null
  }
  const ctx = {
    id,
    generation,
    event,
    legacy,
    valid() { return legacy || !!current() },
    load() {
      if (legacy) return load()
      const value = current()
      if (!value) return stopped()
      const settings = load()
      return {
        ...value,
        debugLog: settings.debugLog,
        lookoutVisible: settings.lookoutVisible,
        motionSensitivity: settings.motionSensitivity,
      }
    },
    patch(delta) {
      if (legacy) return patch(delta)
      const value = current()
      if (!value) return stopped()
      const next = { ...value, ...delta }
      write(pathOf(id), next)
      return next
    },
    param(event) {
      return legacy ? event : JSON.stringify({ id, generation, event })
    },
    schedule(options, slot) {
      // Scheduling needs the alarm record, not global display or debug settings.
      const before = legacy ? load() : current()
      if (!before || before.ringStop === 1) return 0
      const timer = alarmMgr.set({ ...options, param: ctx.param(options.param) })
      if (!timer || timer < 0) throw new Error('Alarm timer rejected')
      if (legacy) return timer
      try {
        const value = current()
        if (!value || value.ringStop === 1) throw new Error('Alarm was stopped')
        const scheduled = { ...(value.scheduled || {}), [slot]: timer }
        write(pathOf(id), { ...value, scheduled })
        if (value.scheduled && value.scheduled[slot]) cancel({ old: value.scheduled[slot] })
      } catch (e) {
        cancel({ rejected: timer })
        throw e
      }
      return timer
    },
    stop() {
      if (legacy) {
        patch({ mode: 'idle', done: 1, ringStop: 1 })
        return cancel(alarmMgr.getAllAlarms())
      }
      const value = current()
      if (!value) return 0
      // Persist invalidation first: a queued callback may already be running.
      write(pathOf(id), {
        ...value, mode: 'idle', done: 1, ringStop: 1,
        generation: generation + 1, legacy: false, scheduled: {},
      })
      const count = cancel(value.scheduled)
      logEvent('ALARM stopped', { id, generation, cancelled: count })
      return count
    },
  }
  return ctx
}

/** Change an alarm, preserving other alarms and reporting scheduling failures. */
export function saveAlarm(id, hour, minute, enabled, days, bedtimeMin) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('Invalid alarm time')
  }
  const selected = days === undefined ? null : normalizeDays(days)
  if (bedtimeMin !== undefined &&
      (!Number.isInteger(bedtimeMin) || bedtimeMin < 0 || bedtimeMin >= 24 * 60)) {
    throw new Error('Invalid bedtime reminder')
  }
  const index = initAlarms()
  let old
  if (id === null || id === undefined) {
    id = index.nextId
    old = { ...load(), id, generation: 0, mode: 'idle', scheduled: {} }
    write(pathOf(id), old)
    write(INDEX, { ids: index.ids.concat(id), nextId: id + 1 })
  } else {
    old = getAlarm(id)
    if (!old) throw new Error('Alarm no longer exists')
    alarmContext(old).stop()
    old = getAlarm(id)
  }
  const now = Math.floor(Date.now() / 1000)
  const settings = load()
  const minutes = settings.windowMin
  const windowSec = typeof minutes === 'number' && minutes >= 0 && minutes <= 120
    ? Math.round(minutes * 60) : 1800
  return startOccurrence({
    ...old, alarmH: hour, alarmM: minute, mode: enabled ? 'alarm' : 'idle',
    weekdays: selected || normalizeDays(old.weekdays || []), windowSec,
    bedtimeMin: bedtimeMin === undefined ? (old.bedtimeMin || 0) : bedtimeMin,
  }, now)
}

// Both explicit saves and automatic repeats use the same scheduling path.
function startOccurrence(old, now, afterUnix = now) {
  const id = old.id
  const targetUnix = nextOccurrence(afterUnix, old.alarmH, old.alarmM, old.weekdays)
  const windowSec = old.windowSec
  const enabled = old.mode === 'alarm'
  const value = {
    ...old, generation: old.generation + 1,
    legacy: false, mode: enabled ? 'alarm' : 'idle', targetUnix, windowSec,
    ticks: 0, fired: 0, rings: 0, lastRingUnix: 0, ringStop: enabled ? 0 : 1,
    done: 0, startedUnix: now, lastReason: '', scheduled: {},
    bedtimeSent: 0, bedtimeError: '',
  }
  write(pathOf(id), value)
  if (!enabled) return value
  const ctx = alarmContext(value)
  const base = { appid: getPackageInfo().appId, repeat_type: alarmMgr.ONCE, store: true }
  try {
    ctx.schedule({ ...base, url: 'page/ring', date: targetUnix, param: 'failsafe' }, 'deadline')
    ctx.schedule({
      ...base, file: 'app-service/probe', date: targetUnix + 5, param: 'failsafe',
    }, 'failsafe')
    ctx.schedule({
      ...base, file: 'app-service/probe',
      date: now + nextDelay(now, targetUnix, windowSec), param: 'first',
    }, 'tick')
    const opensAt = Math.max(now + 60, targetUnix - windowSec)
    if (opensAt < targetUnix) {
      ctx.schedule({ ...base, url: 'page/lookout', date: opensAt, param: 'lookout' }, 'lookout')
    }
    if (value.weekdays.length) {
      ctx.schedule({
        ...base, file: 'app-service/probe', date: targetUnix + REPEAT_AFTER_SEC, param: 'repeat',
      }, 'repeat')
    }
    if (value.bedtimeMin > 0) {
      const bedtimeUnix = targetUnix - value.bedtimeMin * 60
      if (bedtimeUnix > now) {
        try {
          ctx.schedule({
            ...base, file: 'app-service/probe', date: bedtimeUnix, param: 'bedtime',
          }, 'bedtime')
        } catch (e) {
          // A failed optional reminder must not cancel the wake-up timers.
          ctx.patch({ bedtimeError: 'Alarm ON; bedtime reminder failed' })
          logEvent('BEDTIME schedule ERROR', { id, bedtimeUnix, error: String(e), stack: e && e.stack })
        }
      } else {
        logEvent('BEDTIME skipped', { id, bedtimeUnix, reason: 'time already passed' })
      }
    }
    logEvent('ALARM armed', { id, generation: value.generation, targetUnix, windowSec, weekdays: value.weekdays })
    return getAlarm(id)
  } catch (e) {
    ctx.stop()
    logEvent('ALARM arm ERROR', { id, error: String(e), stack: e && e.stack })
    const error = new Error('Alarm OFF: ' + e.message)
    error.alarmId = id
    throw error
  }
}

/** Dismiss this occurrence; OFF/delete use context.stop() to disable repeats. */
export function dismissAlarm(ctx) {
  if (!ctx.valid()) return { cancelled: 0, next: null }
  const value = ctx.load()
  const cancelled = ctx.stop()
  if (!(value.weekdays || []).length) return { cancelled, next: null }
  const now = Math.floor(Date.now() / 1000)
  try {
    // A smart alarm stopped before its deadline must not repeat later today.
    const next = startOccurrence(
      { ...getAlarm(value.id), mode: 'alarm' }, now, Math.max(now, value.targetUnix))
    logEvent('ALARM repeated', { id: value.id, previous: value.targetUnix, next: next.targetUnix })
    return { cancelled, next }
  } catch (e) {
    logEvent('ALARM repeat ERROR', { id: value.id, error: String(e), stack: e && e.stack })
    return { cancelled, next: null, error: String(e) }
  }
}

/** Remove one alarm; its old callbacks become harmless tombstone references. */
export function deleteAlarm(id) {
  const value = getAlarm(id)
  if (!value) return
  alarmContext(value).stop()
  write(pathOf(id), { ...getAlarm(id), deleted: true })
  const index = readIndex()
  write(INDEX, { ...index, ids: index.ids.filter((item) => item !== id) })
  logEvent('ALARM deleted', { id })
}

/** Debug STOP/RESET deliberately applies to every saved alarm. */
export function stopAllAlarms(remove = false) {
  listAlarms().forEach((value) => {
    if (remove) deleteAlarm(value.id)
    else alarmContext(value).stop()
  })
}

/** A single foreground sensor monitors the earliest overlapping window. */
export function foregroundAlarm() {
  const now = Math.floor(Date.now() / 1000)
  const values = listAlarms().filter((value) =>
    value.ringStop !== 1 && (value.mode === 'ringing' ||
      (value.mode === 'alarm' && now >= value.targetUnix - value.windowSec)))
  values.sort((a, b) =>
    (a.mode === 'ringing' ? 0 : 1) - (b.mode === 'ringing' ? 0 : 1) ||
    a.targetUnix - b.targetUnix)
  return values.length ? alarmContext(values[0]) : null
}

/** After STOP, hand the screen to another ringing alarm or open smart window. */
export function resumePending() {
  const ctx = foregroundAlarm()
  if (!ctx) return
  const value = ctx.load()
  const ringing = value.mode === 'ringing' || Date.now() / 1000 >= value.targetUnix
  ctx.schedule({
    appid: getPackageInfo().appId,
    url: ringing ? 'page/ring' : 'page/lookout',
    date: Math.floor(Date.now() / 1000) + 15,
    param: ringing ? 'ring' : 'lookout',
    repeat_type: alarmMgr.ONCE, store: true,
  }, ringing ? 'ring' : 'lookout')
}

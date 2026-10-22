import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import * as fs from '@zos/fs'
import * as timers from '@zos/alarm'
import * as ui from '@zos/ui'
import { load, patch, readRecord, save } from '../probe/utils/store.js'
import {
  initAlarms, listAlarms, getAlarm, saveAlarm, deleteAlarm,
  alarmContext, pageAlarm, stopAllAlarms, foregroundAlarm,
  alarmEnabled, dismissAlarm, REPEAT_AFTER_SEC,
} from '../probe/utils/alarms.js'
import { nextOccurrence, normalizeDays, fmtDays } from '../probe/utils/schedule.js'

let service, definition
globalThis.AppService = (value) => { service = value }
globalThis.Page = (value) => { definition = value }
let globalData = {}
globalThis.getApp = () => ({ _options: { globalData } })
await import('../probe/app-service/probe.js')
await import('../probe/page/ring.js')
const ring = definition
await import('../probe/page/lookout.js')
const lookout = definition
const realNow = Date.now
const realInterval = globalThis.setInterval
const realClear = globalThis.clearInterval
const originalTZ = process.env.TZ
let callbacks
let now

beforeEach(() => {
  globalThis.__stub = { acc: { x: 0, y: 0, z: 1000 } }
  fs.__reset()
  timers.__reset()
  ui.__reset()
  globalData = {}
  now = new Date(2026, 9, 20, 6, 0).getTime() / 1000
  Date.now = () => now * 1000
  callbacks = []
  globalThis.setInterval = (fn) => { callbacks.push(fn); return callbacks.length }
  globalThis.clearInterval = (id) => { callbacks[id - 1] = null }
})
afterEach(() => {
  Date.now = realNow
  globalThis.setInterval = realInterval
  globalThis.clearInterval = realClear
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

function arm(hour = 7, minute = 30) {
  return saveAlarm(null, hour, minute, true)
}
function context(value) {
  return alarmContext({ id: value.id, generation: value.generation })
}
function scheduledFor(id) {
  return timers.__scheduled.filter((timer) => {
    try { return JSON.parse(timer.param).id === id } catch (e) { return false }
  })
}
function openRing(value) {
  const page = { ...ring }
  page.onInit(context(value).param('ring'))
  page.build()
  return page
}

function bedtimeTimer(value) {
  return scheduledFor(value.id).find((timer) => JSON.parse(timer.param).event === 'bedtime')
}

test('bedtime is disabled by default and scheduled eight hours before a morning alarm', () => {
  now = new Date(2026, 9, 19, 20, 0).getTime() / 1000
  const plain = arm()
  assert.equal(plain.bedtimeMin, 0)
  assert.equal(bedtimeTimer(plain), undefined)
  const value = saveAlarm(null, 7, 30, true, [], 480)
  const timer = bedtimeTimer(value)
  assert.equal(timer.file, 'app-service/probe')
  assert.equal(timer.store, true)
  assert.equal(timer.date, new Date(2026, 9, 19, 23, 30).getTime() / 1000)
  assert.equal(value.targetUnix - timer.date, 8 * 3600)
  assert.equal(scheduledFor(value.id).find((entry) => entry.url === 'page/ring').date, value.targetUnix)
})

test('a Monday-only alarm reminds on Sunday and supports fractional hours', () => {
  now = new Date(2026, 9, 23, 12, 0).getTime() / 1000
  const value = saveAlarm(null, 7, 30, true, [1], 510)
  const bedtime = new Date(bedtimeTimer(value).date * 1000)
  assert.equal(bedtime.getDay(), 0)
  assert.equal(bedtime.getHours(), 23)
  assert.equal(bedtime.getMinutes(), 0)
})

test('bedtime subtraction means elapsed hours across the spring DST change', () => {
  process.env.TZ = 'Europe/Rome'
  now = new Date(2026, 2, 28, 12, 0).getTime() / 1000
  const value = saveAlarm(null, 7, 30, true, [0], 480)
  const timer = bedtimeTimer(value)
  assert.equal(value.targetUnix - timer.date, 8 * 3600)
  assert.equal(new Date(timer.date * 1000).getHours(), 22)
  assert.equal(new Date(timer.date * 1000).getMinutes(), 30)
})

test('an elapsed bedtime is skipped without delaying the morning alarm', () => {
  const value = saveAlarm(null, 7, 30, true, [], 480)
  assert.equal(bedtimeTimer(value), undefined)
  assert.equal(value.targetUnix, new Date(2026, 9, 20, 7, 30).getTime() / 1000)
  assert.equal(value.mode, 'alarm')
})

test('bedtime delivery creates one gentle notification without touching alarm timers', () => {
  const value = saveAlarm(null, 7, 30, true, [], 60)
  const before = [...timers.__scheduled]
  now = bedtimeTimer(value).date
  service.onInit(context(value).param('bedtime'))
  service.onInit(context(value).param('bedtime'))
  assert.equal(globalThis.__stub.notifications.length, 1)
  assert.equal(globalThis.__stub.notifications[0].title, 'Time to sleep')
  assert.match(globalThis.__stub.notifications[0].content, /07:30/)
  assert.equal(globalThis.__stub.notifications[0].vibrate, 4)
  assert.equal(getAlarm(value.id).bedtimeSent, value.targetUnix)
  assert.equal(getAlarm(value.id).mode, 'alarm')
  assert.equal(globalThis.__stub.vibrations || 0, 0)
  assert.deepEqual(timers.__scheduled, before)
})

test('early, stale and wake-up-time reminder callbacks cannot send a notice', () => {
  const value = saveAlarm(null, 7, 30, true, [], 60)
  const due = bedtimeTimer(value).date
  for (const time of [due - 1, due + 901, value.targetUnix]) {
    now = time
    service.onInit(context(value).param('bedtime'))
  }
  assert.equal(globalThis.__stub.notifications, undefined)
  assert.equal(getAlarm(value.id).mode, 'alarm')
})

test('changing the time or offset invalidates the previous reminder callback', () => {
  const original = saveAlarm(null, 7, 30, true, [], 60)
  const oldTimer = bedtimeTimer(original)
  const edited = saveAlarm(original.id, 8, 30, true, [], 90)
  assert.equal(bedtimeTimer(edited).date, edited.targetUnix - 90 * 60)
  assert.ok(!timers.__scheduled.some((timer) => timer.id === oldTimer.id))
  now = oldTimer.date
  service.onInit(context(original).param('bedtime'))
  assert.equal(globalThis.__stub.notifications, undefined)
})

test('disabling reminders preserves the wake-up and other alarms', () => {
  const a = saveAlarm(null, 7, 30, true, [], 60)
  const b = saveAlarm(null, 8, 30, true, [], 120)
  const otherTimers = scheduledFor(b.id)
  const disabled = saveAlarm(a.id, 7, 30, true, [], 0)
  assert.equal(bedtimeTimer(disabled), undefined)
  assert.equal(disabled.targetUnix, a.targetUnix)
  assert.equal(disabled.mode, 'alarm')
  assert.deepEqual(getAlarm(b.id), b)
  assert.deepEqual(scheduledFor(b.id), otherTimers)
})

test('OFF, deletion and debug STOP cancel reminders and reject late callbacks', () => {
  const off = saveAlarm(null, 7, 30, true, [], 60)
  const removed = saveAlarm(null, 8, 30, true, [], 120)
  const stopped = saveAlarm(null, 9, 30, true, [], 180)
  context(off).stop()
  deleteAlarm(removed.id)
  stopAllAlarms()
  now += 1800
  for (const value of [off, removed, stopped]) service.onInit(context(value).param('bedtime'))
  assert.equal(globalThis.__stub.notifications, undefined)
  assert.equal(timers.__scheduled.length, 0)
})

test('OFF and ON retain the per-alarm bedtime preference', () => {
  const value = saveAlarm(null, 7, 30, true, [], 60)
  context(value).stop()
  const enabled = saveAlarm(value.id, 7, 30, true)
  assert.equal(enabled.bedtimeMin, 60)
  assert.ok(bedtimeTimer(enabled))
})

test('weekly rollover schedules a new bedtime and allows one new notice', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4], 60)
  now = bedtimeTimer(value).date
  service.onInit(context(value).param('bedtime'))
  now = value.targetUnix + REPEAT_AFTER_SEC
  service.onInit(context(value).param('repeat'))
  const next = getAlarm(value.id)
  assert.equal(next.bedtimeMin, 60)
  assert.equal(next.bedtimeSent, 0)
  assert.equal(bedtimeTimer(next).date, next.targetUnix - 3600)
  now = bedtimeTimer(next).date
  service.onInit(context(value).param('bedtime'))
  service.onInit(context(next).param('bedtime'))
  assert.equal(globalThis.__stub.notifications.length, 2)
})

test('an invalid bedtime is rejected before changing an existing alarm or its timers', () => {
  const value = arm()
  const before = [...timers.__scheduled]
  for (const invalid of [-1, 1440, 1.5, '480', NaN, Infinity, null]) {
    assert.throws(() => saveAlarm(value.id, 8, 0, true, [], invalid), /Invalid bedtime/)
    assert.deepEqual(getAlarm(value.id), value)
    assert.deepEqual(timers.__scheduled, before)
  }
})

test('a rejected optional reminder leaves the alarm ON and reports the failure', () => {
  globalThis.__stub.rejectAlarm = (options) => JSON.parse(options.param).event === 'bedtime'
  const value = saveAlarm(null, 7, 30, true, [], 60)
  assert.equal(value.mode, 'alarm')
  assert.equal(value.ringStop, 0)
  assert.match(value.bedtimeError, /reminder failed/)
  assert.ok(value.scheduled.deadline)
  assert.ok(value.scheduled.failsafe)
})

test('notification API failures leave the exact-time wake-up working', () => {
  for (const failure of ['throwNotify', 'rejectNotification']) {
    const value = saveAlarm(null, 7, 30, true, [], 60)
    now = bedtimeTimer(value).date
    globalThis.__stub[failure] = true
    service.onInit(context(value).param('bedtime'))
    globalThis.__stub[failure] = false
    assert.equal(getAlarm(value.id).bedtimeSent, 0)
    assert.equal(getAlarm(value.id).mode, 'alarm')
    assert.ok(getAlarm(value.id).scheduled.deadline)
    now = value.targetUnix
    service.onInit(context(value).param('failsafe'))
    assert.equal(getAlarm(value.id).mode, 'ringing')
    now = new Date(2026, 9, 20, 6, 0).getTime() / 1000
  }
})

test('migration preserves the old deadline and already scheduled callbacks', () => {
  patch({ alarmH: 7, alarmM: 15, mode: 'alarm', targetUnix: now + 4500 })
  timers.set({ url: 'page/ring', date: now + 4500, param: 'failsafe' })
  const before = [...timers.__scheduled]
  initAlarms()
  assert.equal(getAlarm(1).targetUnix, now + 4500)
  assert.deepEqual(timers.__scheduled, before)
  assert.equal(alarmContext('failsafe').id, 1)
  assert.equal(alarmContext('failsafe').load().mode, 'alarm')
  initAlarms()
  assert.equal(listAlarms().length, 1)
})

test('two alarms have independent deadlines, services and persistent identities', () => {
  const a = arm(7, 30)
  const b = arm(8, 45)
  for (const value of [a, b]) {
    const scheduled = scheduledFor(value.id)
    assert.equal(scheduled.length, 4)
    assert.equal(scheduled.find((timer) => timer.url === 'page/ring').date, value.targetUnix)
    assert.ok(scheduled.every((timer) => timer.store === true))
    assert.equal(readRecord('alarm-' + value.id + '.json').alarmH, value.alarmH)
  }
  assert.equal(getAlarm(a.id).targetUnix + 75 * 60, getAlarm(b.id).targetUnix)
})

test('STOP cancels only the selected alarm, even while both are ringing', () => {
  const a = arm()
  const b = arm(7, 31)
  now = a.targetUnix
  const first = openRing(a)
  const second = openRing(b)
  const bTimers = scheduledFor(b.id).map((timer) => timer.id)
  first.stop()
  assert.equal(getAlarm(a.id).ringStop, 1)
  assert.equal(getAlarm(b.id).mode, 'ringing')
  assert.notEqual(second.bigText.props.TEXT, 'OFF')
  const after = scheduledFor(b.id).map((timer) => timer.id)
  assert.ok(bTimers.every((id) => after.includes(id)))
  const vibrations = globalThis.__stub.vibrations
  second.buzz()
  assert.ok(globalThis.__stub.vibrations > vibrations)
})

test('edited alarms ignore old service, ring-page and lookout callbacks', () => {
  const old = arm()
  const current = saveAlarm(old.id, 8, 20, true)
  const other = arm(9, 0)
  const before = [...timers.__scheduled]
  service.onInit(context(old).param('failsafe'))
  openRing(old)
  const page = { ...lookout }
  page.onInit(context(old).param('lookout'))
  page.build()
  assert.equal(globalThis.__stub.vibrations || 0, 0)
  assert.deepEqual(getAlarm(old.id), current)
  assert.equal(getAlarm(other.id).mode, 'alarm')
  assert.deepEqual(timers.__scheduled, before)
})

test('a service tick writes and reschedules only its own alarm', () => {
  const a = arm()
  const b = arm(8, 0)
  const otherTimers = scheduledFor(b.id)
  service.onInit(context(a).param('first'))
  assert.equal(getAlarm(a.id).ticks, 1)
  assert.deepEqual(getAlarm(b.id), b)
  assert.deepEqual(scheduledFor(b.id), otherTimers)
  assert.equal(scheduledFor(a.id).filter((timer) => timer.param.includes('"tick"')).length, 1)
})

test('a service reaches each deadline even if sensor readings are unavailable', () => {
  const a = arm()
  const b = arm(8, 0)
  now = a.targetUnix
  service.onInit(context(a).param('failsafe'))
  assert.equal(getAlarm(a.id).mode, 'ringing')
  assert.equal(getAlarm(b.id).mode, 'alarm')
  context(a).stop()
  now = b.targetUnix
  service.onInit(context(b).param('failsafe'))
  assert.equal(getAlarm(b.id).mode, 'ringing')
})

test('a stopped generation cannot schedule or overwrite a rearmed alarm', () => {
  const value = arm()
  const old = context(value)
  old.stop()
  const next = saveAlarm(value.id, 8, 0, true)
  old.patch({ mode: 'ringing' })
  assert.equal(old.schedule({ date: now + 60, param: 'tick' }, 'tick'), 0)
  assert.deepEqual(getAlarm(value.id), next)
})

test('delete leaves other timers intact and late callbacks silent', () => {
  const a = arm()
  const b = arm(8, 0)
  const before = scheduledFor(b.id)
  deleteAlarm(a.id)
  service.onInit(context(a).param('failsafe'))
  openRing(a)
  assert.equal(getAlarm(a.id), null)
  assert.deepEqual(scheduledFor(b.id), before)
  assert.equal(globalThis.__stub.vibrations || 0, 0)
})

test('scheduling failure rolls back accepted timers and leaves the alarm visibly off', () => {
  const other = arm(8, 0)
  const before = scheduledFor(other.id)
  globalThis.__stub.rejectAlarm = (options) => !!options.file
  assert.throws(() => arm(), /Alarm OFF/)
  const failed = listAlarms().find((alarm) => alarm.id !== 1 && alarm.id !== other.id)
  assert.equal(failed.mode, 'idle')
  assert.equal(scheduledFor(failed.id).length, 0)
  assert.deepEqual(scheduledFor(other.id), before)
})

test('failed persistence does not schedule an alarm', () => {
  initAlarms()
  globalThis.__stub.throwFsWrite = true
  assert.throws(() => arm(), /Cannot save alarm/)
  assert.equal(timers.__scheduled.length, 0)
})

test('an unreadable collection is not overwritten by migration', () => {
  const value = arm()
  save({ invalid: true }, 'alarms.json')
  const before = [...timers.__scheduled]
  assert.throws(() => initAlarms(), /Cannot read saved alarms/)
  assert.equal(getAlarm(value.id).mode, 'alarm')
  assert.deepEqual(timers.__scheduled, before)
})

test('an early timeout stays visibly enabled while the deadline failsafe remains', () => {
  const value = arm()
  context(value).patch({ mode: 'idle', done: 1, rings: 3 })
  assert.equal(alarmEnabled(getAlarm(value.id)), true)
  context(value).stop()
  assert.equal(alarmEnabled(getAlarm(value.id)), false)
})

test('zero window schedules no movement page', () => {
  patch({ windowMin: 0 })
  const value = arm()
  assert.equal(value.windowSec, 0)
  assert.equal(scheduledFor(value.id).some((timer) => timer.url === 'page/lookout'), false)
})

test('old untagged failsafes cannot revive the migrated alarm after editing it', () => {
  initAlarms()
  saveAlarm(1, 8, 0, true)
  const before = getAlarm(1)
  service.onInit('failsafe')
  const page = { ...ring }
  page.build()
  assert.equal(globalThis.__stub.vibrations || 0, 0)
  assert.deepEqual(getAlarm(1), before)
})

test('app launch parameters bind the page to the correct alarm and are consumed', () => {
  const value = arm()
  globalData.alarmLaunch = context(value).param('failsafe')
  assert.equal(pageAlarm().id, value.id)
  assert.equal(globalData.alarmLaunch, null)
})

test('overlapping windows monitor the earlier alarm and retain both deadlines', () => {
  const a = arm(7, 30)
  const b = arm(7, 40)
  now = a.targetUnix - 10 * 60
  assert.equal(foregroundAlarm().id, a.id)
  const page = { ...lookout }
  page.onInit(context(b).param('lookout'))
  page.build()
  assert.equal(page.alarm.id, a.id)
  assert.equal(page.target, a.targetUnix)
  assert.ok(scheduledFor(b.id).some((timer) => timer.url === 'page/ring'))
  page.onDestroy()
})

test('STOP hands over to the next overlapping window without disabling it', () => {
  const a = arm(7, 30)
  const b = arm(7, 40)
  now = a.targetUnix - 10 * 60
  openRing(a).stop()
  const pending = scheduledFor(b.id).find((timer) => timer.url === 'page/lookout')
  assert.equal(pending.date, now + 15)
  assert.equal(getAlarm(b.id).mode, 'alarm')
})

test('an incoming lookout does not hide a ringing alarm', () => {
  const a = arm(7, 30)
  const b = arm(7, 40)
  now = a.targetUnix - 10 * 60
  openRing(a)
  const page = { ...lookout }
  page.onInit(context(b).param('lookout'))
  page.build()
  assert.equal(globalThis.__stub.lastReplace.url, 'page/ring')
  assert.equal(JSON.parse(globalThis.__stub.lastReplace.params).id, a.id)
})

test('debug STOP and RESET deliberately stop all alarms', () => {
  const a = arm()
  const b = arm(8, 0)
  stopAllAlarms()
  assert.equal(getAlarm(a.id).ringStop, 1)
  assert.equal(getAlarm(b.id).ringStop, 1)
  assert.equal(timers.__scheduled.length, 0)
  stopAllAlarms(true)
  assert.equal(listAlarms().length, 0)
  assert.equal(alarmContext('failsafe').valid(), false)
})

test('global debug settings are shared while per-alarm counters stay independent', () => {
  const a = arm()
  const b = arm(8, 0)
  patch({ lookoutVisible: 1, debugLog: 0 })
  context(a).patch({ ticks: 10 })
  assert.equal(context(a).load().lookoutVisible, 1)
  assert.equal(context(b).load().debugLog, 0)
  assert.equal(getAlarm(b.id).ticks, 0)
  assert.equal(load().ticks, 0)
})

test('selected weekdays skip an unselected day and use today when still ahead', () => {
  // Tuesday, 20 October 2026 at 06:00.
  const today = nextOccurrence(now, 7, 30, [2, 4])
  assert.equal(today, new Date(2026, 9, 20, 7, 30).getTime() / 1000)
  const next = nextOccurrence(today, 7, 30, [2, 4])
  assert.equal(next, new Date(2026, 9, 22, 7, 30).getTime() / 1000)
  const monday = nextOccurrence(now, 7, 30, [1])
  assert.equal(monday, new Date(2026, 9, 26, 7, 30).getTime() / 1000)
})

test('one selected weekday repeats next week after its time has passed', () => {
  const start = new Date(2026, 9, 20, 8).getTime() / 1000
  assert.equal(nextOccurrence(start, 7, 30, [2]),
    new Date(2026, 9, 27, 7, 30).getTime() / 1000)
})

test('recurrence crosses a year boundary using local calendar days', () => {
  const start = new Date(2026, 11, 31, 23, 50).getTime() / 1000
  assert.equal(nextOccurrence(start, 0, 10, [5]),
    new Date(2027, 0, 1, 0, 10).getTime() / 1000)
})

test('daily recurrence keeps 07:30 over the spring and autumn DST changes', () => {
  process.env.TZ = 'Europe/Rome'
  const days = [0, 1, 2, 3, 4, 5, 6]
  const spring = new Date(2026, 2, 28, 7, 30).getTime() / 1000
  const autumn = new Date(2026, 9, 24, 7, 30).getTime() / 1000
  assert.equal(nextOccurrence(spring, 7, 30, days) - spring, 23 * 3600)
  assert.equal(nextOccurrence(autumn, 7, 30, days) - autumn, 25 * 3600)
  assert.equal(new Date(nextOccurrence(spring, 7, 30, days) * 1000).getHours(), 7)
  assert.equal(new Date(nextOccurrence(autumn, 7, 30, days) * 1000).getHours(), 7)
})

test('repeat days are validated before cancelling existing alarms', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  const before = [...timers.__scheduled]
  for (const days of [[7], [-1], ['Mon'], [1.5], null]) {
    assert.throws(() => saveAlarm(value.id, 8, 0, true, days), /Invalid repeat days/)
  }
  assert.deepEqual(getAlarm(value.id), value)
  assert.deepEqual(timers.__scheduled, before)
  assert.deepEqual(normalizeDays([0, 6, 0]), [6, 0])
  assert.equal(fmtDays([0, 1, 2, 3, 4, 5, 6]), 'Every day')
})

test('existing alarms remain single-use until days are explicitly selected', () => {
  initAlarms()
  const value = saveAlarm(1, 7, 30, true)
  assert.deepEqual(value.weekdays, [])
  assert.equal(value.scheduled.repeat, undefined)
  openRing(value).stop()
  assert.equal(getAlarm(value.id).ringStop, 1)
})

test('STOP before a smart deadline skips that entire occurrence, not just the early buzz', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 3])
  now = value.targetUnix - 15 * 60
  const page = openRing(value)
  page.stop()
  const next = getAlarm(value.id)
  assert.equal(next.targetUnix, new Date(2026, 9, 21, 7, 30).getTime() / 1000)
  assert.equal(next.mode, 'alarm')
  assert.deepEqual(next.weekdays, [2, 3])
  assert.equal(page.bigText.props.TEXT, 'STOPPED')
  assert.match(page.infoText.props.TEXT, /still ON/)
  assert.ok(scheduledFor(value.id).every((timer) =>
    JSON.parse(timer.param).generation === next.generation))
})

test('early smart STOP before midnight skips the scheduled day correctly', () => {
  now = new Date(2026, 9, 19, 23, 35).getTime() / 1000
  const value = saveAlarm(null, 0, 5, true, [2, 4])
  now = new Date(2026, 9, 19, 23, 50).getTime() / 1000
  dismissAlarm(context(value))
  assert.equal(getAlarm(value.id).targetUnix, new Date(2026, 9, 22, 0, 5).getTime() / 1000)
})

test('repeat rollover is persistent and works even without pressing STOP or opening the page', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  const rollover = scheduledFor(value.id).find((timer) => JSON.parse(timer.param).event === 'repeat')
  assert.equal(rollover.date, value.targetUnix + REPEAT_AFTER_SEC)
  assert.equal(rollover.store, true)
  now = rollover.date
  service.onInit(rollover.param)
  const next = getAlarm(value.id)
  assert.equal(next.targetUnix, new Date(2026, 9, 22, 7, 30).getTime() / 1000)
  assert.equal(next.mode, 'alarm')
  assert.ok(next.scheduled.repeat)
})

test('automatic rollover cannot cancel the current deadline before it has rung', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  const before = [...timers.__scheduled]
  now = value.targetUnix - 60
  service.onInit(context(value).param('repeat'))
  assert.deepEqual(getAlarm(value.id), value)
  assert.deepEqual(timers.__scheduled, before)
})

test('an early vibration timeout preserves the deadline and the later recurrence', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  context(value).patch({ mode: 'idle', done: 1, rings: 3 })
  now = value.targetUnix
  service.onInit(context(value).param('failsafe'))
  assert.equal(getAlarm(value.id).mode, 'ringing')
  now = value.targetUnix + REPEAT_AFTER_SEC
  service.onInit(context(value).param('repeat'))
  assert.equal(getAlarm(value.id).targetUnix, new Date(2026, 9, 22, 7, 30).getTime() / 1000)
})

test('a delayed repeat skips missed occurrences instead of ringing a backlog', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  now = new Date(2026, 9, 28, 12).getTime() / 1000
  service.onInit(context(value).param('repeat'))
  assert.equal(getAlarm(value.id).targetUnix, new Date(2026, 9, 29, 7, 30).getTime() / 1000)
  assert.equal(globalThis.__stub.vibrations || 0, 0)
})

test('late service and page callbacks from the dismissed occurrence cannot ring the next one', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  now = value.targetUnix
  dismissAlarm(context(value))
  const next = getAlarm(value.id)
  service.onInit(context(value).param('failsafe'))
  service.onInit(context(value).param('repeat'))
  openRing(value)
  assert.deepEqual(getAlarm(value.id), next)
  assert.equal(globalThis.__stub.vibrations || 0, 0)
})

test('OFF, deletion and debug STOP prevent a recurring alarm from rearming', () => {
  const off = saveAlarm(null, 7, 30, true, [2, 4])
  const removed = saveAlarm(null, 8, 0, true, [2, 4])
  const debug = saveAlarm(null, 9, 0, true, [2, 4])
  context(off).stop()
  deleteAlarm(removed.id)
  stopAllAlarms()
  now = debug.targetUnix + REPEAT_AFTER_SEC
  for (const value of [off, removed, debug]) service.onInit(context(value).param('repeat'))
  assert.equal(getAlarm(off.id).ringStop, 1)
  assert.equal(getAlarm(removed.id), null)
  assert.equal(getAlarm(debug.id).ringStop, 1)
  assert.equal(timers.__scheduled.length, 0)
})

test('automatically repeating one alarm does not change another alarm or its timers', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  const other = saveAlarm(null, 8, 0, true, [1, 5])
  const before = scheduledFor(other.id)
  now = value.targetUnix + REPEAT_AFTER_SEC
  service.onInit(context(value).param('repeat'))
  assert.deepEqual(getAlarm(other.id), other)
  assert.deepEqual(scheduledFor(other.id), before)
})

test('automatic repeats preserve the alarm window despite subsequent debug changes', () => {
  patch({ windowMin: 20 })
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  patch({ windowMin: 1 })
  now = value.targetUnix
  dismissAlarm(context(value))
  assert.equal(getAlarm(value.id).windowSec, 20 * 60)
})

test('failure to register the rollover timer leaves the recurring alarm OFF', () => {
  globalThis.__stub.rejectAlarm = (options) => JSON.parse(options.param).event === 'repeat'
  assert.throws(() => saveAlarm(null, 7, 30, true, [2, 4]), /Alarm OFF/)
  assert.equal(timers.__scheduled.length, 0)
  assert.ok(listAlarms().every((value) => !alarmEnabled(value)))
})

test('a failed repeat is reported on STOP and never claims that tomorrow is armed', () => {
  const value = saveAlarm(null, 7, 30, true, [2, 4])
  now = value.targetUnix
  const page = openRing(value)
  globalThis.__stub.throwAlarmSet = true
  page.stop()
  assert.equal(getAlarm(value.id).ringStop, 1)
  assert.equal(timers.__scheduled.length, 0)
  assert.equal(page.bigText.props.TEXT, 'OFF')
  assert.match(page.infoText.props.TEXT, /Repeat failed/)
})

test('a weekly recurrence continues through several weeks of unattended alarms', () => {
  let value = saveAlarm(null, 7, 30, true, [2, 4])
  for (let occurrence = 0; occurrence < 8; occurrence++) {
    now = value.targetUnix + REPEAT_AFTER_SEC
    service.onInit(context(value).param('repeat'))
    const next = getAlarm(value.id)
    const target = new Date(next.targetUnix * 1000)
    assert.ok([2, 4].includes(target.getDay()))
    assert.equal(target.getHours(), 7)
    assert.equal(target.getMinutes(), 30)
    assert.ok(next.targetUnix > value.targetUnix)
    assert.ok(next.scheduled.repeat)
    value = next
  }
})

test('retired sensor settings cannot disable the foreground movement window', () => {
  patch({ useLookout: 0, useStages: 1 })
  const alarm = arm()
  assert.ok(scheduledFor(alarm.id).some((timer) => timer.url === 'page/lookout'))
})

test('STOP during timer registration cancels the accepted timer and leaves the alarm off', () => {
  const alarm = arm()
  const ctx = context(alarm)
  globalThis.__stub.rejectAlarm = () => {
    ctx.stop()
    return false
  }
  assert.throws(() => ctx.schedule({
    file: 'app-service/probe', date: now + 60, param: 'tick',
  }, 'tick'), /Alarm was stopped/)
  assert.equal(getAlarm(alarm.id).ringStop, 1)
  assert.equal(scheduledFor(alarm.id).length, 0)
})

test('timer registration preserves changes made by another callback during scheduling', () => {
  const alarm = arm()
  const ctx = context(alarm)
  globalThis.__stub.rejectAlarm = () => {
    ctx.patch({ ticks: 17, lastReason: 'concurrent service callback' })
    return false
  }
  const timer = ctx.schedule({
    file: 'app-service/probe', date: now + 60, param: 'tick',
  }, 'tick')
  const saved = getAlarm(alarm.id)
  assert.equal(saved.ticks, 17)
  assert.equal(saved.lastReason, 'concurrent service callback')
  assert.equal(saved.scheduled.tick, timer)
  assert.equal(scheduledFor(alarm.id).filter((entry) => entry.id === timer).length, 1)
})

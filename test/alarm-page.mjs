import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import * as ui from '@zos/ui'
import * as fs from '@zos/fs'
import * as timers from '@zos/alarm'
import { KEY_HOME, GESTURE_UP, GESTURE_DOWN, GESTURE_LEFT, GESTURE_RIGHT } from '@zos/interaction'
import { initAlarms, listAlarms, saveAlarm, getAlarm, deleteAlarm } from '../probe/utils/alarms.js'
import { load, patch } from '../probe/utils/store.js'
import { diskSizes, logEvent } from '../probe/utils/log.js'

let definition
globalThis.Page = (value) => { definition = value }
globalThis.getApp = () => ({ _options: { globalData: {} } })
await import('../probe/page/index.js')
const main = definition
await import('../probe/page/edit.js')
const editor = definition
await import('../probe/page/debug.js')
const diagnostics = definition

let deferred
beforeEach((t) => {
  deferred = new Map()
  let nextTimer = 1
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    const id = nextTimer++
    deferred.set(id, callback)
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', (id) => deferred.delete(id))
  globalThis.__stub = { deviceInfo: { width: 480, height: 480 } }
  fs.__reset()
  timers.__reset()
  ui.__reset()
})

function openEditor(id) {
  const page = { ...editor }
  page.onInit(JSON.stringify({ id }))
  page.build()
  return page
}

test('sensitivity cycles, persists on reopening and preserves saved alarms', () => {
  initAlarms()
  const original = listAlarms()
  const page = { ...diagnostics }
  page.build()
  click('SENSITIVITY: NORMAL')
  assert.equal(load().motionSensitivity, 'high')
  ui.__reset()
  page.build()
  click('SENSITIVITY: HIGH')
  assert.equal(load().motionSensitivity, 'low')
  click('SENSITIVITY: LOW')
  assert.equal(load().motionSensitivity, 'normal')
  assert.deepEqual(listAlarms(), original)
})

test('a sensitivity save failure keeps the previous label and reports the error', () => {
  patch({ motionSensitivity: 'normal' })
  const page = { ...diagnostics }
  page.build()
  globalThis.__stub.throwFsWrite = true
  click('SENSITIVITY: NORMAL')
  globalThis.__stub.throwFsWrite = false
  assert.equal(load().motionSensitivity, 'normal')
  assert.ok(ui.__byType('TEXT').some((item) => /Cannot save sensitivity/.test(item.props.TEXT)))
  assert.ok(ui.__byType('BUTTON').some((item) =>
    (item.props.TEXT || item.props.text) === 'SENSITIVITY: NORMAL'))
})

test('FULL RESET restores both normal sensitivity and its label', () => {
  patch({ motionSensitivity: 'high' })
  const page = { ...diagnostics }
  page.build()
  click('FULL RESET')
  assert.equal(load().motionSensitivity, 'normal')
  click('SENSITIVITY: NORMAL')
  assert.equal(load().motionSensitivity, 'high')
})
function buttonFor(label) {
  const labelled = ui.__created.find((item) =>
    item.props.VISIBLE !== false && (item.props.TEXT || item.props.text) === label)
  assert.ok(labelled, 'Missing label: ' + label)
  if (labelled.type === 'BUTTON') return labelled
  assert.equal(labelled.enabled, false, label + ' label must pass touches through')
  const x = labelled.opts.x + labelled.opts.w / 2
  const y = labelled.opts.y + labelled.opts.h / 2
  const button = ui.__byType('BUTTON').find((item) => {
    const bounds = item.opts
    return item.props.VISIBLE !== false && x >= bounds.x && x < bounds.x + bounds.w &&
      y >= bounds.y && y < bounds.y + bounds.h
  })
  assert.ok(button, 'Missing button beneath label: ' + label)
  return button
}

function click(label) {
  buttonFor(label).opts.click_func()
}

test('main migrates the saved alarm and offers add, edit and a separate toggle', () => {
  patch({ alarmH: 19, alarmM: 30 })
  const page = { ...main }
  page.build()
  assert.equal(listAlarms().length, 1)
  click('19:30')
  assert.equal(globalThis.__stub.lastPush.url, 'page/edit')
  assert.equal(JSON.parse(globalThis.__stub.lastPush.params).id, 1)
  click('+ ADD ALARM')
  assert.equal(JSON.parse(globalThis.__stub.lastPush.params).id, null)
})

test('switching one row off preserves the other alarm and refreshes on return', () => {
  initAlarms()
  saveAlarm(1, 7, 30, true)
  const other = saveAlarm(null, 8, 10, true)
  const page = { ...main }
  page.build()
  click('ON')
  assert.equal(getAlarm(1).ringStop, 1)
  assert.equal(getAlarm(other.id).mode, 'alarm')
  const count = ui.__created.length
  page.onResume()
  assert.equal(ui.__created.length, count, 'Returning must not duplicate rows')
})

test('touch wheels edit a draft and leaving the editor preserves the original alarm and timers', () => {
  initAlarms()
  const alarm = saveAlarm(1, 7, 30, true)
  const before = [...timers.__scheduled]
  const page = openEditor(alarm.id)
  const wheels = ui.__byType('CYCLE_IMAGE_TEXT_LIST')
  assert.equal(wheels.length, 2)
  ui.__scrollTo(wheels[0], 21)
  ui.__scrollTo(wheels[1], 44)
  assert.equal(page.hour, 22)
  assert.equal(page.minute, 45)
  page.onDestroy()
  assert.deepEqual(getAlarm(alarm.id), alarm)
  assert.deepEqual(timers.__scheduled, before)
})

test('SAVE applies both wheel values once and preserves an enabled alarm', () => {
  initAlarms()
  saveAlarm(1, 7, 30, true)
  const page = openEditor(1)
  page.hour = 21
  page.minute = 48
  click('SAVE')
  const value = getAlarm(1)
  assert.equal(value.alarmH, 21)
  assert.equal(value.alarmM, 48)
  assert.equal(value.mode, 'alarm')
  assert.equal(globalThis.__stub.backCalls, 1)
})

test('editing a disabled alarm leaves it disabled', () => {
  initAlarms()
  const page = openEditor(1)
  page.minute = 5
  click('SAVE')
  assert.equal(getAlarm(1).mode, 'idle')
  assert.equal(timers.__scheduled.length, 0)
})

test('new alarm is saved and enabled without changing an existing alarm', () => {
  initAlarms()
  const before = getAlarm(1)
  const page = openEditor(null)
  page.hour = 20
  page.minute = 35
  click('SAVE')
  assert.equal(listAlarms().length, 2)
  assert.deepEqual(getAlarm(1), before)
  assert.equal(getAlarm(page.id).mode, 'alarm')
})

test('crown changes the selected field in both directions and wraps', () => {
  initAlarms()
  const page = openEditor(1)
  page.hour = 23
  globalThis.__stub.crownCallback(KEY_HOME, -12)
  assert.equal(page.hour, 0)
  globalThis.__stub.crownCallback(KEY_HOME, 12)
  assert.equal(page.hour, 23)
  click('MINUTE')
  page.minute = 59
  globalThis.__stub.crownCallback(KEY_HOME, -12)
  assert.equal(page.minute, 0)
  assert.equal(page.hour, 23)
  globalThis.__stub.crownCallback(KEY_HOME, -60)
  assert.equal(page.minute, 5)
  page.onDestroy()
  assert.equal(globalThis.__stub.crownCallback, null)
})

test('DELETE removes only the selected alarm', () => {
  initAlarms()
  const other = saveAlarm(null, 8, 10, true)
  openEditor(1)
  click('DELETE')
  assert.equal(getAlarm(1), null)
  assert.equal(getAlarm(other.id).mode, 'alarm')
})

test('a rejected timer shows an error and does not claim the alarm is enabled', () => {
  initAlarms()
  saveAlarm(1, 7, 30, true)
  const page = openEditor(1)
  globalThis.__stub.throwAlarmSet = true
  click('SAVE')
  assert.match(page.hintText.props.TEXT, /Alarm OFF/)
  assert.equal(getAlarm(1).mode, 'idle')
  assert.equal(globalThis.__stub.backCalls, undefined)
})

test('retrying SAVE after a scheduling failure does not create another alarm', () => {
  initAlarms()
  const page = openEditor(null)
  globalThis.__stub.throwAlarmSet = true
  click('SAVE')
  const id = page.id
  assert.equal(listAlarms().length, 2)
  globalThis.__stub.throwAlarmSet = false
  click('SAVE')
  assert.equal(page.id, id)
  assert.equal(listAlarms().length, 2)
  assert.equal(getAlarm(id).mode, 'alarm')
})

test('bottom actions fill a split segment and their labels fit inside the Balance', () => {
  initAlarms()
  openEditor(1)
  const buttons = ui.__byType('BUTTON')
  assert.ok(!buttons.some((button) => button.opts.text === 'CANCEL'))
  const remove = buttonFor('DELETE').opts
  const save = buttonFor('SAVE').opts
  assert.equal(remove.x, 0)
  assert.equal(save.x + save.w, 480)
  assert.equal(remove.x + remove.w, 239)
  assert.equal(save.x, 241)
  assert.equal(remove.y, save.y)
  assert.ok(remove.y > 360)
  for (const action of [remove, save]) {
    assert.equal(action.y + action.h, 480)
    assert.equal(action.radius, 0)
  }
  for (const label of ui.__byType('TEXT').filter((item) => ['DELETE', 'SAVE'].includes(item.opts.text))) {
    const { x, y, w, h } = label.opts
    for (const px of [x, x + w]) {
      for (const py of [y, y + h]) {
        assert.ok(Math.hypot(px - 240, py - 240) <= 240, label.opts.text + ' is clipped')
      }
    }
  }
  for (const button of buttons.filter((item) => item.opts !== remove && item.opts !== save)) {
    const { x, y, w, h, radius } = button.opts
    const r = Math.min(radius, w / 2, h / 2)
    for (const px of [x + r, x + w - r]) {
      for (const py of [y + r, y + h - r]) {
        assert.ok(Math.hypot(px - 240, py - 240) + r <= 240, button.opts.text + ' is clipped')
      }
    }
  }
})

test('bedtime wheels edit a draft duration without changing the wake-up time', () => {
  const original = saveAlarm(null, 7, 30, true, [1, 2, 3, 4, 5])
  const page = openEditor(original.id)
  click('BEDTIME: OFF')
  const wheels = ui.__byType('CYCLE_IMAGE_TEXT_LIST')
  assert.equal(wheels.length, 2, 'the editor reuses its wheels')
  ui.__scrollTo(wheels[0], 8)
  ui.__scrollTo(wheels[1], 14)
  click('REMINDER: OFF')
  click('DONE')
  assert.equal(page.hour, 7)
  assert.equal(page.minute, 30)
  assert.equal(page.bedtimeButton.props.TEXT, 'BEDTIME: 09:15 before')
  assert.deepEqual(getAlarm(original.id), original)
  click('SAVE')
  assert.equal(getAlarm(original.id).bedtimeMin, 555)
  assert.equal(getAlarm(original.id).alarmH, 7)
  assert.equal(getAlarm(original.id).alarmM, 30)
  assert.deepEqual(getAlarm(original.id).weekdays, [1, 2, 3, 4, 5])
})

test('leaving the editor discards bedtime edits and preserves all original timers', () => {
  const original = saveAlarm(null, 7, 30, true, [], 480)
  const before = [...timers.__scheduled]
  const page = openEditor(original.id)
  click('BEDTIME: 08:00 before')
  page.bedtimeHour = 9
  click('DONE')
  page.onDestroy()
  assert.deepEqual(getAlarm(original.id), original)
  assert.deepEqual(timers.__scheduled, before)
})

test('crown edits the bedtime duration independently and restores the alarm wheels', () => {
  const original = saveAlarm(null, 7, 30, false)
  const page = openEditor(original.id)
  click('BEDTIME: OFF')
  globalThis.__stub.crownCallback(KEY_HOME, -12)
  assert.equal(page.bedtimeHour, 9)
  assert.equal(page.hour, 7)
  click('MINUTES')
  globalThis.__stub.crownCallback(KEY_HOME, -60)
  assert.equal(page.bedtimeMinute, 5)
  assert.equal(page.minute, 30)
  assert.equal(page.hourButton.props.TEXT, 'HOURS')
  click('REMINDER: OFF')
  click('DONE')
  assert.equal(page.hourWheel.props.LIST_TOP.index, 6)
  assert.equal(page.minuteWheel.props.LIST_TOP.index, 29)
  assert.equal(page.hourButton.props.TEXT, 'HOUR')
  assert.equal(page.minuteButton.props.TEXT, 'MINUTE')
  click('BEDTIME: 09:05 before')
  assert.equal(page.hourWheel.props.LIST_TOP.index, 8)
  assert.equal(page.minuteWheel.props.LIST_TOP.index, 4)
})

test('turning bedtime OFF preserves the wake-up and persists after SAVE', () => {
  const original = saveAlarm(null, 7, 30, true, [], 480)
  openEditor(original.id)
  click('BEDTIME: 08:00 before')
  click('REMINDER: ON')
  click('DONE')
  click('SAVE')
  assert.equal(getAlarm(original.id).bedtimeMin, 0)
  assert.equal(getAlarm(original.id).mode, 'alarm')
})

test('an enabled zero-duration reminder stays in the selector with a clear message', () => {
  initAlarms()
  const page = openEditor(1)
  click('BEDTIME: OFF')
  page.bedtimeHour = 0
  page.bedtimeMinute = 0
  click('REMINDER: OFF')
  click('DONE')
  assert.equal(page.view, 'bedtime')
  assert.match(page.hintText.props.TEXT, /at least 1 minute/)
  assert.equal(getAlarm(1).bedtimeMin || 0, 0)
})

test('a bedtime scheduling failure is visible while keeping the wake-up enabled', () => {
  const page = openEditor(null)
  const target = new Date(Date.now() + 2 * 60 * 60 * 1000)
  page.hour = target.getHours()
  page.minute = target.getMinutes()
  page.bedtimeMin = 60
  globalThis.__stub.rejectAlarm = (options) => JSON.parse(options.param).event === 'bedtime'
  click('SAVE')
  assert.match(page.hintText.props.TEXT, /Alarm ON; bedtime reminder failed/)
  assert.equal(getAlarm(page.id).mode, 'alarm')
  assert.equal(globalThis.__stub.backCalls, undefined)
})

test('bedtime controls fit inside the round Balance display', () => {
  initAlarms()
  openEditor(1)
  click('BEDTIME: OFF')
  const visible = ui.__byType('BUTTON').filter((item) => item.props.VISIBLE !== false)
  assert.equal(visible.length, 4)
  const done = buttonFor('DONE')
  assert.equal(done.opts.x, 0)
  assert.equal(done.opts.w, 480)
  assert.equal(done.opts.y + done.opts.h, 480)
  for (const button of visible.filter((item) => item !== done)) {
    const { x, y, w, h } = button.opts
    for (const px of [x, x + w]) {
      for (const py of [y, y + h]) {
        assert.ok(Math.hypot(px - 240, py - 240) <= 240, button.opts.text + ' is clipped')
      }
    }
  }
})

test('weekday selection is a draft until SAVE and preserves the chosen time', () => {
  initAlarms()
  const page = openEditor(null)
  page.hour = 8
  page.minute = 45
  click('DAYS: Once')
  click('Mon')
  click('Wed')
  click('Fri')
  assert.deepEqual(page.days, [1, 3, 5])
  assert.equal(listAlarms().length, 1)
  click('DONE')
  assert.equal(page.daysButton.props.TEXT, 'DAYS: Mon Wed Fri')
  click('SAVE')
  const saved = getAlarm(page.id)
  assert.deepEqual(saved.weekdays, [1, 3, 5])
  assert.equal(saved.alarmH, 8)
  assert.equal(saved.alarmM, 45)
  assert.equal(saved.mode, 'alarm')
})

test('leaving the editor discards weekday edits without touching scheduled alarms', () => {
  const original = saveAlarm(null, 7, 30, true, [1, 2, 3, 4, 5])
  const scheduled = [...timers.__scheduled]
  const page = openEditor(original.id)
  click('DAYS: Weekdays')
  click('Fri')
  click('Sun')
  click('DONE')
  page.onDestroy()
  assert.deepEqual(getAlarm(original.id), original)
  assert.deepEqual(timers.__scheduled, scheduled)
})

test('deselecting all days means Once and removes the automatic rollover on SAVE', () => {
  const original = saveAlarm(null, 7, 30, true, [6, 0])
  const page = openEditor(original.id)
  click('DAYS: Weekends')
  click('Sat')
  click('Sun')
  assert.equal(page.daysTitle.props.TEXT, 'Once')
  click('DONE')
  click('SAVE')
  assert.deepEqual(getAlarm(original.id).weekdays, [])
  assert.equal(getAlarm(original.id).scheduled.repeat, undefined)
})

test('reopening the selector preserves its selection and ignores crown time edits', () => {
  initAlarms()
  const page = openEditor(1)
  const hour = page.hour
  click('DAYS: Once')
  click('Tue')
  globalThis.__stub.crownCallback(KEY_HOME, -60)
  assert.equal(page.hour, hour)
  click('DONE')
  click('DAYS: Tue')
  assert.deepEqual(page.days, [2])
  click('Tue')
  assert.deepEqual(page.days, [])
  click('DONE')
  assert.equal(page.daysButton.props.TEXT, 'DAYS: Once')
})

test('OFF and ON preserve recurrence days and the list shows the recurrence', () => {
  initAlarms()
  saveAlarm(1, 7, 30, true, [1, 2, 3, 4, 5])
  const page = { ...main }
  page.build()
  assert.ok(ui.__byType('TEXT').some((item) => item.opts.text.includes('Weekdays')))
  click('ON')
  assert.deepEqual(getAlarm(1).weekdays, [1, 2, 3, 4, 5])
  click('OFF')
  assert.deepEqual(getAlarm(1).weekdays, [1, 2, 3, 4, 5])
  assert.ok(getAlarm(1).scheduled.repeat)
})

test('all weekday buttons, presets and completion controls fit the round Balance', () => {
  initAlarms()
  openEditor(1)
  click('DAYS: Once')
  const visible = ui.__byType('BUTTON').filter((item) => item.props.VISIBLE !== false)
  assert.equal(visible.length, 10)
  const sunday = buttonFor('Sun').opts
  const weekdays = buttonFor('Weekdays').opts
  const weekend = buttonFor('Weekend').opts
  assert.ok(sunday.x + sunday.w < weekdays.x)
  assert.ok(weekdays.x + weekdays.w < weekend.x)
  assert.equal(sunday.y, weekdays.y)
  assert.equal(sunday.y, weekend.y)
  assert.ok(!visible.some((button) => button.opts.text === 'ONCE'))
  const done = buttonFor('DONE')
  assert.equal(done.opts.x, 0)
  assert.equal(done.opts.w, 480)
  assert.equal(done.opts.y + done.opts.h, 480)
  for (const button of visible.filter((item) => item !== done)) {
    const { x, y, w, h } = button.opts
    for (const px of [x, x + w]) {
      for (const py of [y, y + h]) {
        assert.ok(Math.hypot(px - 240, py - 240) <= 240, button.opts.text + ' is clipped')
      }
    }
  }
})


test('left swipe opens diagnostics without a Debug button or changes to alarms', () => {
  initAlarms()
  const page = { ...main }
  page.build()
  const alarms = listAlarms()
  const scheduled = [...timers.__scheduled]
  assert.equal(ui.__byType('BUTTON').some((item) => item.props.text === 'DEBUG'), false)
  const gesture = globalThis.__stub.gestureCallback
  assert.equal(typeof gesture, 'function')
  for (const direction of [GESTURE_UP, GESTURE_DOWN, GESTURE_RIGHT]) {
    assert.equal(gesture(direction), false, 'preserve scrolling and system back')
  }
  assert.equal(globalThis.__stub.lastPush, undefined)
  assert.equal(gesture(GESTURE_LEFT), true)
  assert.equal(globalThis.__stub.lastPush.url, 'page/debug')
  assert.deepEqual(listAlarms(), alarms)
  assert.deepEqual(timers.__scheduled, scheduled)
})

test('diagnostics swipe is removed on leaving the list and restored on return', () => {
  initAlarms()
  const page = { ...main }
  page.build()
  page.onPause()
  assert.equal(globalThis.__stub.gestureCallback, null)
  page.onResume()
  assert.equal(globalThis.__stub.gestureCallback(GESTURE_LEFT), true)
  assert.equal(globalThis.__stub.lastPush.url, 'page/debug')
  page.onDestroy()
  assert.equal(globalThis.__stub.gestureCallback, null)
})

test('weekday highlights follow selection and deselection on API 3.7', () => {
  initAlarms()
  const page = openEditor(1)
  click('DAYS: Once')
  const widgetCount = ui.__created.length
  const highlighted = () => ui.__byType('BUTTON')
    .filter((item) => item.props.VISIBLE !== false && item.props.normal_color === 0x285fa5)
    .map((item) => item.props.text)
  assert.deepEqual(highlighted(), [])
  assert.equal(page.daysTitle.props.TEXT, 'Once')
  click('Mon')
  click('Wed')
  click('Sun')
  assert.deepEqual(highlighted(), ['Mon', 'Wed', 'Sun'])
  click('Wed')
  assert.deepEqual(highlighted(), ['Mon', 'Sun'])
  assert.equal(page.daysTitle.props.TEXT, 'Repeat on')
  click('Mon')
  click('Sun')
  assert.deepEqual(highlighted(), [])
  assert.deepEqual(page.days, [])
  assert.equal(ui.__created.length, widgetCount, 'changing days must not accumulate widgets')
  assert.equal(page.dayWidgets.length, 12, 'seven days, two presets, a title, a Done button and its label')
})

test('day presets replace the draft and retain individual changes after DONE', () => {
  const original = saveAlarm(null, 7, 30, true, [2, 4])
  const page = openEditor(original.id)
  click('DAYS: Tue Thu')
  const highlighted = () => ui.__byType('BUTTON')
    .filter((item) => item.props.VISIBLE !== false && item.props.normal_color === 0x285fa5)
    .map((item) => item.props.text)
  assert.deepEqual(highlighted(), ['Tue', 'Thu'])
  click('Weekend')
  assert.deepEqual(page.days, [6, 0])
  assert.deepEqual(highlighted(), ['Sat', 'Sun'])
  click('Weekdays')
  assert.deepEqual(page.days, [1, 2, 3, 4, 5])
  assert.deepEqual(highlighted().sort(), ['Fri', 'Mon', 'Thu', 'Tue', 'Wed'])
  click('Mon')
  click('Wed')
  assert.deepEqual(getAlarm(original.id), original, 'presets remain a draft until SAVE')
  click('DONE')
  assert.ok(page.dayWidgets.every((item) => item.props.VISIBLE === false))
  click('DAYS: Tue Thu Fri')
  assert.deepEqual(highlighted(), ['Tue', 'Thu', 'Fri'])
  click('DONE')
  click('SAVE')
  assert.deepEqual(getAlarm(original.id).weekdays, [2, 4, 5])
})


function assertCenter(list, value) {
  const size = list.opts.data_size
  assert.equal((list.topIndex + 1) % size, value, 'chosen value is the middle of three rows')
  for (const offset of [-1, 0, 1]) {
    const index = (value + offset + size) % size
    const color = list.itemStyles[index]?.item_text_color ?? list.opts.item_text_color
    assert.equal(color, offset === 0 ? 0xffffff : 0x777788, 'only the middle row is highlighted')
  }
}

test('hour and minute centers are highlighted immediately without an initial focus event', () => {
  globalThis.__stub.silentWheelPosition = true
  const alarm = saveAlarm(null, 7, 30, true)
  const page = openEditor(alarm.id)
  assertCenter(page.hourWheel, 7)
  assertCenter(page.minuteWheel, 30)
  assert.equal(page.selected, 'hour')
  click('SAVE')
  assert.equal(getAlarm(alarm.id).alarmH, 7)
  assert.equal(getAlarm(alarm.id).alarmM, 30)
})

test('touch scrolling saves and highlights the visible middle row regardless of native focus', () => {
  const alarm = saveAlarm(null, 7, 30, true)
  const page = openEditor(alarm.id)
  ui.__scrollTo(page.hourWheel, 21, 21)
  ui.__scrollTo(page.minuteWheel, 44, 46)
  assertCenter(page.hourWheel, 22)
  assertCenter(page.minuteWheel, 45)
  assert.equal(page.hour, 22)
  assert.equal(page.minute, 45)
  click('SAVE')
  assert.equal(getAlarm(alarm.id).alarmH, 22)
  assert.equal(getAlarm(alarm.id).alarmM, 45)
})

test('taps and crown keep midnight values centered and highlighted across wrapping', () => {
  const alarm = saveAlarm(null, 23, 59, false)
  const page = openEditor(alarm.id)
  globalThis.__stub.crownCallback(KEY_HOME, -12)
  assertCenter(page.hourWheel, 0)
  click('MINUTE')
  globalThis.__stub.crownCallback(KEY_HOME, -12)
  assertCenter(page.minuteWheel, 0)
  page.hourWheel.opts.item_click_func(page.hourWheel, 23)
  assertCenter(page.hourWheel, 23)
  assert.equal(page.selected, 'hour')
  page.minuteWheel.opts.item_click_func(page.minuteWheel, 59)
  assertCenter(page.minuteWheel, 59)
  assert.equal(page.selected, 'minute')
})

test('bedtime centers are highlighted on entry and wake-up centers are restored on DONE', () => {
  globalThis.__stub.silentWheelPosition = true
  const alarm = saveAlarm(null, 7, 30, true, [], 480)
  const page = openEditor(alarm.id)
  click('BEDTIME: 08:00 before')
  assertCenter(page.hourWheel, 8)
  assertCenter(page.minuteWheel, 0)
  ui.__scrollTo(page.hourWheel, 8)
  ui.__scrollTo(page.minuteWheel, 14)
  assertCenter(page.hourWheel, 9)
  assertCenter(page.minuteWheel, 15)
  click('DONE')
  assertCenter(page.hourWheel, 7)
  assertCenter(page.minuteWheel, 30)
  click('SAVE')
  const saved = getAlarm(alarm.id)
  assert.equal(saved.alarmH, 7)
  assert.equal(saved.alarmM, 30)
  assert.equal(saved.bedtimeMin, 555)
})


function runDeferred() {
  for (const [id, callback] of [...deferred]) {
    deferred.delete(id)
    callback()
  }
}

test('selecting and deselecting weekdays replaces only the affected buttons', () => {
  initAlarms()
  const page = openEditor(1)
  click('DAYS: Once')
  const before = [...page.dayButtons]
  click('Wed')
  assert.equal(page.dayButtons.filter((button, i) => button !== before[i]).length, 1)
  assert.notEqual(page.dayButtons[2], before[2])
  click('Fri')
  const selected = [...page.dayButtons]
  click('Wed')
  click('Fri')
  assert.equal(page.dayButtons.filter((button, i) => button !== selected[i]).length, 2)
  assert.equal(page.dayWidgets.length, 12)
})

test('returning to an unchanged alarm list reuses every widget', () => {
  initAlarms()
  const page = { ...main }
  page.build()
  const before = [...ui.__created]
  page.onPause()
  page.onResume()
  assert.deepEqual(ui.__created, before)
})

test('toggling an alarm replaces only its toggle and preserves other widgets', () => {
  initAlarms()
  saveAlarm(1, 7, 30, true)
  saveAlarm(null, 8, 0, true)
  const page = { ...main }
  page.build()
  const before = new Set(ui.__created)
  click('ON')
  assert.equal(ui.__created.filter((item) => !before.has(item)).length, 1)
  assert.equal(page.widgets.length, before.size)
  assert.ok(ui.__byType('TEXT').some((item) => /Off/.test(item.props.TEXT)))
})

test('reused rows read edited time and days and their callbacks use the latest alarm', () => {
  initAlarms()
  const page = { ...main }
  page.build()
  const before = [...ui.__created]
  saveAlarm(1, 9, 42, false, [1, 3])
  page.onResume()
  assert.deepEqual(ui.__created, before)
  click('09:42')
  assert.equal(JSON.parse(globalThis.__stub.lastPush.params).id, 1)
  assert.ok(ui.__byType('TEXT').some((item) => /Mon Wed/.test(item.props.TEXT)))
  click('OFF')
  assert.equal(getAlarm(1).alarmH, 9)
  assert.equal(getAlarm(1).alarmM, 42)
  assert.deepEqual(getAlarm(1).weekdays, [1, 3])
})

test('adding and removing alarms rebuilds the list without leaving stale rows', () => {
  initAlarms()
  const page = { ...main }
  page.build()
  const other = saveAlarm(null, 8, 12, false)
  page.onResume()
  click('08:12')
  assert.equal(JSON.parse(globalThis.__stub.lastPush.params).id, other.id)
  deleteAlarm(1)
  page.onResume()
  assert.equal(ui.__byType('BUTTON').filter((item) => /^\d\d:\d\d$/.test(item.props.text)).length, 1)
  deleteAlarm(other.id)
  page.onResume()
  assert.ok(ui.__byType('TEXT').some((item) => item.props.text === 'No alarms'))
  assert.equal(page.widgets.length, ui.__created.length)
})

test('log sizes use metadata, reflect new data and never read log contents', () => {
  globalThis.__stub.fsReads = []
  assert.deepEqual(diskSizes(), { events: 0 })
  seedLargeLogs()
  globalThis.__stub.fsReads = []
  const size = diskSizes().events
  assert.equal(size, fs.__get('events.log').length)
  assert.deepEqual(globalThis.__stub.fsReads, [])
  logEvent('another sample')
  globalThis.__stub.fsReads = []
  assert.equal(diskSizes().events, fs.__get('events.log').length)
  assert.notEqual(diskSizes().events, size, 'a capped append can shrink the file')
  assert.deepEqual(globalThis.__stub.fsReads, [])
})

test('opening and resuming the list never reads or sends logs or samples sleep', () => {
  initAlarms()
  seedLargeLogs()
  globalThis.__stub.fsReads = []
  const page = { ...main }
  page.build()
  runDeferred()
  page.onPause()
  page.onResume()
  runDeferred()
  page.onDestroy()
  runDeferred()
  assert.equal(globalThis.__stub.requests, undefined)
  assert.equal(globalThis.__stub.fsReads.some((read) => /events.log|probe.csv/.test(read.path)), false)
  assert.deepEqual(globalThis.__stub.permissionAsked, ['device:os.bg_service'])
  assert.equal(fs.__get('events.log').length, 60000)
  assert.equal(ui.__byType('TEXT').some((item) => /^Logs:/.test(item.props.TEXT || item.props.text)), false)
})

test('diagnostics keeps local log controls without offering server upload', () => {
  initAlarms()
  const page = { ...diagnostics }
  page.build()
  const labels = ui.__byType('BUTTON').map((item) => item.props.TEXT || item.props.text)
  assert.equal(labels.includes('SEND LOGS'), false)
  assert.ok(labels.includes('STATE'))
  assert.ok(labels.includes('LOG: MINIMAL'))
  click('LOG: MINIMAL')
  assert.equal(load().debugLog, 1)
  assert.equal(globalThis.__stub.requests, undefined)
})

test('scrolling the selected wheel does not rewrite the field buttons', (t) => {
  initAlarms()
  const page = openEditor(1)
  const hourUpdates = t.mock.method(page.hourButton, 'setProperty')
  const minuteUpdates = t.mock.method(page.minuteButton, 'setProperty')
  ui.__scrollTo(page.hourWheel, 10)
  ui.__scrollTo(page.hourWheel, 11)
  assert.equal(page.hour, 12)
  assertCenter(page.hourWheel, 12)
  assert.equal(hourUpdates.mock.callCount(), 0)
  assert.equal(minuteUpdates.mock.callCount(), 0)
})


function seedLargeLogs() {
  const fd = fs.openSync({ path: 'events.log', flag: fs.O_CREAT | fs.O_RDWR })
  fs.writeSync({ fd, buffer: new Uint8Array(60000).fill(120).buffer })
  fs.closeSync({ fd })
}

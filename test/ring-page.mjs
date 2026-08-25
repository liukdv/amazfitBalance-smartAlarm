// Tests for the RING PAGE: the only place where the vibration really reaches the
// motor. If this page does not vibrate, or does not stop, the alarm does not
// exist.
import assert from 'node:assert/strict'
import * as uiStub from '@zos/ui'
import * as alarmStub from '@zos/alarm'
import * as fsStub from '@zos/fs'
import { load, patch } from '../probe/utils/store.js'
import { readEvents } from '../probe/utils/log.js'

let pass = 0
let fail = 0
const failures = []

let pageDef = null
globalThis.Page = (def) => {
  pageDef = def
}
globalThis.getApp = () => ({ _options: { globalData: {} } })

// Page timers are driven by hand: time does not flow by itself here.
const timers = []
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms })
  return timers.length
}
globalThis.clearInterval = (id) => {
  if (timers[id - 1]) timers[id - 1].cleared = true
}
function fireTimers(n) {
  for (let i = 0; i < n; i++) timers.filter((t) => !t.cleared).forEach((t) => t.fn())
}
// The delayed exit from the page: fired by hand.
const delayed = []
globalThis.setTimeout = (fn, ms) => {
  delayed.push({ fn, ms })
  return delayed.length
}
function fireDelayed() {
  delayed.splice(0).forEach((t) => t.fn())
}

await import('../probe/page/ring.js')

async function test(name, fn) {
  globalThis.__stub = {}
  uiStub.__reset()
  fsStub.__reset()
  alarmStub.__reset()
  timers.length = 0
  delayed.length = 0
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    failures.push(name + ' -> ' + e.message)
    console.log('  FAIL ' + name + '\n         ' + e.message)
  }
}

function newPage() {
  return Object.assign(Object.create(pageDef), pageDef)
}
function buttons() {
  return uiStub.__byType('BUTTON')
}
function texts() {
  return uiStub.__byType('TEXT').map((w) => String(w.props.TEXT || w.opts.text || ''))
}
function vibrations() {
  return (globalThis.__stub || {}).vibrations || 0
}

console.log('\n== the page rings as soon as it opens ==')

await test('freshly opened it VIBRATES at once, waiting for nothing', () => {
  const p = newPage()
  p.build()
  assert.ok(vibrations() > 0, 'open and mute: that is the whole project failing')
})

await test('the first buzz is strong (CALL scene), not a tap', () => {
  const p = newPage()
  p.build()
  const modes = (globalThis.__stub || {}).vibrationModes || []
  assert.ok(modes.length > 0)
  assert.ok(modes.every((m) => m === 7), 'expected VIBRATOR_SCENE_CALL on all of them: ' + modes.join(','))
})

await test('it insists on its own: after 5 timer rounds, many more vibrations', () => {
  const p = newPage()
  p.build()
  const afterOpen = vibrations()
  fireTimers(5)
  assert.ok(vibrations() > afterOpen, 'it does not insist: an alarm that buzzes once wakes nobody')
})

await test('it shows the time and the words WAKE UP, readable in the dark', () => {
  const p = newPage()
  p.build()
  const t = texts().join(' | ')
  assert.match(t, /WAKE UP/)
  assert.match(t, /\d\d:\d\d/)
})

await test('one button only, big: STOP', () => {
  const p = newPage()
  p.build()
  const labels = buttons().map((b) => String(b.opts.text))
  assert.deepEqual(labels, ['STOP'])
  assert.ok(buttons()[0].opts.h >= 70, 'button too small for a half-asleep finger')
})

// 22 Aug on the device: "on the first tap you cannot see the button text".
// Cause: white background and text left at the default colour, which is white.
await test('the button text is READABLE: never white on white', () => {
  const p = newPage()
  p.build()
  const b = buttons()[0].opts
  assert.ok(b.color !== undefined, 'text colour not declared: the system makes it white')
  assert.notEqual(b.color, b.normal_color, 'text the same colour as the background: invisible')
  assert.notEqual(b.color, b.press_color, 'text invisible while you press it')
})

console.log('\n== STOP must really stop ==')

await test('STOP: it stops vibrating and cancels the queued alarms', () => {
  const p = newPage()
  p.build()
  alarmStub.set({ appid: 1, url: 'page/ring', date: 1 }) // a replica in the queue
  buttons()[0].opts.click_func()
  const afterStop = vibrations()
  fireTimers(10)
  assert.equal(vibrations(), afterStop, 'it keeps vibrating after STOP')
  assert.equal(alarmStub.getAllAlarms().length, 0, 'surviving alarms: it would ring again')
})

// Evening of 22 Aug: the button worked on the first tap but the screen did not
// change, and it was pressed seven times in the belief that it was broken.
await test('STOP is VISIBLE: the screen says OFF', () => {
  const p = newPage()
  p.build()
  buttons()[0].opts.click_func()
  const t = texts().join(' | ')
  assert.match(t, /OFF/, 'no confirmation on screen: it looks broken even when it works')
  assert.ok(!/WAKE UP/.test(t), 'it still says WAKE UP: ' + t)
})

// 22 Aug: after the stop the page stayed there for over a minute (the single
// delayed home() closed nothing). Now there is a WATCHDOG: it retries every 2s.
await test('after STOP the page gets out of the way by itself (watchdog)', () => {
  const p = newPage()
  p.build()
  buttons()[0].opts.click_func()
  assert.equal((globalThis.__stub || {}).homeCalls, undefined, 'it disappears too fast: you cannot read the confirmation')
  fireTimers(1)
  assert.ok((globalThis.__stub || {}).homeCalls >= 1, 'the page stays open forever')
})

// ⚠️ GENTLE by necessity: the version that insisted with home+back+replace every
// 2s is the suspect for the TOTAL FREEZE and the watch REBOOT of 23 Aug.
await test('the exit is GENTLE: at most 2 home() calls, never a burst', () => {
  const p = newPage()
  p.build()
  buttons()[0].opts.click_func()
  fireTimers(20)
  assert.ok((globalThis.__stub || {}).homeCalls <= 2, 'a burst of navigation: that is what rebooted the watch')
  const after = (globalThis.__stub || {}).homeCalls
  fireTimers(10)
  assert.equal((globalThis.__stub || {}).homeCalls, after, 'it keeps calling home() forever')
})

await test('the diary says HOW the exit went (the outcome of home)', () => {
  const p = newPage()
  p.build()
  buttons()[0].opts.click_func()
  fireTimers(3)
  const ev = readEvents()
  assert.match(ev, /RING exiting/, 'the outcome of the first exit attempt is missing')
  assert.match(ev, /exit FAILED/, 'if we are still alive after 2 attempts it has to be written down')
})

// IDEMPOTENT STOP (22 Aug: 26 taps in 60s, each one rewriting the files = ~2s of
// freeze per tap). From the second tap on: zero writes, only "get out NOW".
await test('second tap: it exits IMMEDIATELY and rewrites nothing', () => {
  const p = newPage()
  p.build()
  buttons()[0].opts.click_func()
  const evBefore = readEvents()
  buttons()[0].opts.click_func()
  buttons()[0].opts.click_func()
  assert.ok((globalThis.__stub || {}).homeCalls >= 1, 'the second tap must try to exit at once')
  assert.equal(readEvents(), evBefore, 'repeated taps must NOT write logs (that was the 2s freeze)')
})

await test('home() broken: STOP works all the same, no frozen screen', () => {
  globalThis.__stub = { throwHome: true }
  const p = newPage()
  p.build()
  buttons()[0].opts.click_func()
  fireTimers(3)
  assert.equal(load().mode, 'idle', 'the stop must hold even if the page does not close')
  assert.match(readEvents(), /home ERR/, "home's error must end up in the diary")
})

await test('STOP writes the state: idle + ringStop, so the service does not reopen it', () => {
  const p = newPage()
  p.build()
  buttons()[0].opts.click_func()
  const s = load()
  assert.equal(s.mode, 'idle')
  assert.equal(s.ringStop, 1, 'without ringStop the service would reopen the page')
  assert.equal(s.done, 1)
})

// 23 Aug review, finding 1 (SERIOUS): the cap used to call stop() like a human
// STOP → it cancelled the failsafes and silenced the service. An early ring
// slept through left SILENCE at the deadline.
await test('vibration cap (battery): it stops vibrating but it is NOT a STOP', () => {
  const p = newPage()
  p.build()
  alarmStub.set({ appid: 1, url: 'page/ring', date: 999 }) // the FAILSAFE at the alarm time
  fireTimers(200)
  const final = vibrations()
  fireTimers(50)
  assert.equal(vibrations(), final, 'it would vibrate forever')
  assert.notEqual(load().mode, 'idle', 'the cap CLOSED the alarm: silence at the deadline')
  assert.equal(load().ringStop, 0, 'the cap passed itself off as a human STOP')
  assert.ok(alarmStub.getAllAlarms().length >= 1, 'the cap cancelled the FAILSAFE: dead alarm')
})

await test('after the cap, a human STOP still works and really closes it', () => {
  const p = newPage()
  p.build()
  fireTimers(200)
  buttons()[0].opts.click_func()
  assert.equal(load().mode, 'idle')
  assert.equal(load().ringStop, 1)
})

console.log('\n== two opens at once: the ringing must not fall silent ==')

// ⚠️ At the alarm time the page can be opened TWICE almost together: the
// failsafe alarm and the lookout handing over. With state shared between the
// instances, destroying the first switched off the second one's timer: one buzz
// and then silence (23 Aug review, finding 2).
await test('the second instance keeps vibrating even if the first one dies', () => {
  const a = newPage()
  a.build()
  const b = newPage()
  b.build()
  const before = vibrations()
  a.onDestroy() // the system closes the first one
  fireTimers(20)
  assert.ok(vibrations() > before, 'the ringing fell silent: one buzz and then nothing')
})

// ⛔ A surviving alarm must not restart the alarm after STOP.
await test('reopened after a STOP: it does NOT start vibrating again', () => {
  const a = newPage()
  a.build()
  buttons()[0].opts.click_func() // STOP
  const afterStop = vibrations()
  uiStub.__reset()
  const b = newPage()
  b.build()
  fireTimers(20)
  assert.equal(vibrations(), afterStop, 'it started ringing again after being switched off')
  assert.match(readEvents(), /reopened after STOP/)
})

console.log('\n== robustness: it opens even if something is broken ==')

await test('screen brightness time not settable: it vibrates all the same', () => {
  globalThis.__stub = { throwBrightTime: true }
  const p = newPage()
  p.build()
  assert.ok(vibrations() > 0)
})

await test('a throwing vibrator: the page stays alive and writes it down', () => {
  globalThis.__stub = { throwVibrate: true }
  const p = newPage()
  p.build()
  assert.ok(buttons().length === 1, 'the page must remain usable')
  assert.match(texts().join(' '), /buzz/, 'it must say what happened')
})

await test('timers unavailable: at least the first buzz goes off', () => {
  const real = globalThis.setInterval
  globalThis.setInterval = () => {
    throw new Error('no timers')
  }
  try {
    const p = newPage()
    p.build()
    assert.ok(vibrations() > 0, 'without timers it does not buzz even once')
  } finally {
    globalThis.setInterval = real
  }
})

await test('the diary records the open and the stop: in the morning you know what happened', () => {
  const p = newPage()
  p.build()
  buttons()[0].opts.click_func()
  const ev = readEvents()
  assert.ok(ev.indexOf('RING page opened') >= 0, 'the open is missing from the diary')
  assert.ok(ev.indexOf('RING STOPPED') >= 0, 'the stop is missing from the diary')
})

await test('it records the vibration, so "commanded" can be told from "felt"', () => {
  const p = newPage()
  p.build()
  assert.match(readEvents(), /RING buzz/)
})

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

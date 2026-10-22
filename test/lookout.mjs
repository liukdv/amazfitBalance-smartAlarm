// Tests for the LOOKOUT: the page that opens when the window opens and listens
// to the accelerometer — the only sensor that really feels movement, and one
// that only works with the app in the foreground.
//
// Activity is the change between XYZ vectors in mg, including rotations that
// keep their magnitude near 1000. Sensitivity gently increases through the window.
import assert from 'node:assert/strict'
import * as uiStub from '@zos/ui'
import * as fsStub from '@zos/fs'
import { patch, reset } from '../probe/utils/store.js'
import { initAlarms, getAlarm } from '../probe/utils/alarms.js'
import { readEvents } from '../probe/utils/log.js'

let pass = 0
let fail = 0
const failures = []

let pageDef = null
globalThis.Page = (def) => {
  pageDef = def
}
globalThis.getApp = () => ({ _options: { globalData: {} } })

const timers = []
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms })
  return timers.length
}
globalThis.clearInterval = (id) => {
  if (timers[id - 1]) timers[id - 1].cleared = true
}
function tick(n) {
  for (let i = 0; i < n; i++) {
    NOW += 0.2
    timers.filter((t) => !t.cleared).forEach((t) => t.fn())
  }
}

// The clock is driven by hand: the lookout always compares against the deadline.
let NOW = 1800000000
const realNow = Date.now
Date.now = () => Math.round(NOW * 1000)
const T = NOW + 1800 // target half an hour away

await import('../probe/page/lookout.js')

async function test(name, fn) {
  globalThis.__stub = {}
  uiStub.__reset()
  fsStub.__reset()
  timers.length = 0
  NOW = 1800000000
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: 1800 })
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
  return Object.assign(Object.create(pageDef), pageDef, {})
}
// Still wrist: only gravity on the z axis.
const STILL = { x: 0, y: 0, z: 1000 }
// A single spike is intentionally insufficient, including its return to rest.
const MOVING = { x: 0, y: 0, z: 3600 }

// Small rotations keep |acceleration| at 1000, unlike the old constant-offset
// fixtures which never actually moved between readings.
function move(n = 9, degrees = 5) {
  const angle = degrees * Math.PI / 180
  const turned = { x: 1000 * Math.sin(angle), y: 0, z: 1000 * Math.cos(angle) }
  for (let i = 0; i < n; i++) {
    globalThis.__stub.acc = i % 2 ? STILL : turned
    tick(1)
  }
}

function navigated() {
  return (globalThis.__stub.pushed || []).concat(globalThis.__stub.replaced || [])
}

console.log('\n== the lookout listens and only wakes you when it should ==')

await test('wrist STILL: it wakes nobody', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(100)
  assert.equal(navigated().length, 0, 'it woke someone with a motionless wrist')
})

await test('decisive MOVEMENT: it hands over to the ring page', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(5)
  assert.equal(navigated().length, 0)
  move()
  assert.ok(navigated().indexOf('page/ring') >= 0, 'the movement did not make the alarm ring')
})

// ⛔ THE MOST DANGEROUS BUG IN THE PROJECT (23 Aug review, finding 1): a (0,0,0)
// reading — the first samples after start(), the sensor not yet warm — gives a
// deviation of 1000, that is five times the threshold. Three readings like that
// and the alarm went off HALF AN HOUR EARLY believing it had seen movement.
await test('ZERO readings (sensor not warm): they must NOT wake you', () => {
  globalThis.__stub.acc = { x: 0, y: 0, z: 0 }
  const p = newPage()
  p.build()
  tick(50)
  assert.equal(navigated().length, 0, 'it woke on implausible readings: alarm half an hour early')
})

await test('readings on a different scale (g instead of mg): they must NOT wake you', () => {
  globalThis.__stub.acc = { x: 0, y: 0, z: 1 }
  const p = newPage()
  p.build()
  tick(50)
  assert.equal(navigated().length, 0, 'a different scale is not a movement')
})

await test('huge readings (raw ADC): they must NOT wake you', () => {
  globalThis.__stub.acc = { x: 0, y: 0, z: 16384 }
  const p = newPage()
  p.build()
  tick(50)
  assert.equal(navigated().length, 0, 'a full-scale value is not a movement')
})

await test('after implausible readings, REAL movement is still caught', () => {
  globalThis.__stub.acc = { x: 0, y: 0, z: 0 }
  const p = newPage()
  p.build()
  tick(10)
  assert.equal(navigated().length, 0)
  move()
  assert.ok(navigated().indexOf('page/ring') >= 0, 'the guard made the lookout deaf')
})

for (const [secondsLeft, threshold] of [[1500, 57], [30, 40]]) {
  await test('clear movement wakes with ' + secondsLeft + ' seconds remaining', () => {
    NOW = T - secondsLeft
    globalThis.__stub.acc = STILL
    const p = newPage()
    p.build()
    tick(1)
    move()
    assert.ok(navigated().includes('page/ring'))
    assert.match(readEvents(), new RegExp('movement [0-9]+ over ' + threshold))
  })
}

for (const windowSec of [60, 600, 1800]) {
  await test('sensitivity advances within a ' + windowSec + '-second window', () => {
    patch({ windowSec })
    NOW = T - windowSec
    globalThis.__stub.acc = STILL
    const p = newPage()
    p.build()
    tick(1)
    move(9, 3)
    assert.equal(navigated().length, 0, 'moderate motion should not pass at the start')
    NOW = T - windowSec / 10
    globalThis.__stub.acc = STILL
    tick(1)
    move(3, 3)
    assert.equal(navigated().length, 0, 'three adjacent readings must still be insufficient')
    move(6, 3)
    assert.ok(navigated().includes('page/ring'), 'the same motion should pass near the target')
  })
}

await test('a late opening uses the remaining window instead of restarting sensitivity', () => {
  patch({ windowSec: 600 })
  NOW = T - 60
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(1)
  move(9, 3)
  assert.ok(navigated().includes('page/ring'))
  assert.match(readEvents(), /"threshold":42/)
})

await test('a SINGLE isolated jolt is not enough (that is noise, not an awakening)', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(3)
  globalThis.__stub.acc = MOVING
  tick(1) // a single sample above the threshold
  globalThis.__stub.acc = STILL
  tick(20)
  assert.equal(navigated().length, 0, 'an isolated peak made it ring: false alarms all night')
})

await test('DEADLINE reached without moving: it rings anyway', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(3)
  assert.equal(navigated().length, 0)
  NOW = T // the moment arrives
  tick(1)
  assert.ok(navigated().indexOf('page/ring') >= 0, 'the lookout missed the deadline')
})

await test('an old numeric threshold does not override the new sensitivity', () => {
  patch({ motionThreshold: 1 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(1)
  move(40, 1)
  assert.equal(navigated().length, 0)
})

await test('small repeated motion stays below threshold throughout the last minute', () => {
  NOW = T - 61
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(1)
  move(250, 1)
  assert.equal(navigated().length, 0, 'tiny motion triggered the alarm near the deadline')
})

await test('a steady sensor offset is not continuous movement', () => {
  globalThis.__stub.acc = { x: 0, y: 0, z: 1122 }
  const p = newPage()
  p.build()
  tick(650)
  assert.equal(navigated().length, 0, 'a constant offset triggered the alarm')
})

await test('HIGH sensitivity applies to an existing migrated alarm', () => {
  initAlarms()
  const alarm = getAlarm(1)
  patch({ motionSensitivity: 'high' })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.onInit(JSON.stringify({ id: 1, generation: alarm.generation }))
  p.build()
  tick(1)
  move(9, 2.5)
  assert.ok(navigated().includes('page/ring'), 'saved alarm ignored the global preference')
  assert.match(readEvents(), /"sensitivity":"high"/)
})

await test('NORMAL sensitivity ignores the same small motion', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(1)
  move(20, 2.5)
  assert.equal(navigated().length, 0)
})

console.log('\n== it must NEVER stay on for nothing ==')

// The state is checked every 25 ticks and it takes 3 confirmations in a row: so
// the close arrives after ~75 readings, not immediately (23 Aug review, F1 — a
// single failed read switched the smart wake off for the whole night).
await test('alarm disarmed elsewhere: the lookout closes itself', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(2)
  patch({ mode: 'idle' }) // STOP pressed on the main page
  tick(80)
  assert.match(readEvents(), /LOOKOUT closed/, 'it stays on burning battery for nothing')
  assert.equal(timers.filter((t) => !t.cleared).length, 0, 'the timer keeps running')
})

// ⛔ THE MOST INSIDIOUS DEFECT THE REVIEW FOUND: reading the state can FAIL (the
// service rewrites that file from another process every minute, and mid-write it
// is unreadable). In that case `load()` answers "off" — and a single coincidence
// out of thousands of readings closed the lookout forever, silently, leaving the
// night without a smart wake.
await test('ONE failed state read must not switch the smart wake off', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  globalThis.__stub.throwFsOpen = true // the state becomes unreadable
  tick(30)
  globalThis.__stub.throwFsOpen = false
  assert.ok(!readEvents().includes('LOOKOUT closed'), 'it closed over one unlucky read')
  move()
  assert.ok(navigated().indexOf('page/ring') >= 0, 'after the false alarm it no longer feels movement')
})

// ⚠️ Stopping the timers is not enough: the SCREEN has to be GIVEN BACK and the
// page has to leave. Before, the page stayed on for an hour at brightness 1, and
// no live timer could ever have put it right (23 Aug review, finding 4).
await test('accelerometer will not start: screen released and page closed', () => {
  globalThis.__stub = { throwAccStart: true, acc: STILL, initialBrightness: 55 }
  const p = newPage()
  p.build()
  assert.match(readEvents(), /LOOKOUT accelerometer will NOT start/)
  assert.equal(timers.filter((t) => !t.cleared).length, 0, 'it started sampling without a sensor')
  assert.equal(globalThis.__stub.brightness, 55, 'brightness not restored: the watch stays dark')
  assert.ok((globalThis.__stub.homeCalls || 0) >= 1, 'screen left on for an hour for nothing')
})

await test('no target: it leaves at once instead of sampling forever', () => {
  patch({ targetUnix: 0 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  assert.match(readEvents(), /no target/)
  assert.equal(timers.filter((t) => !t.cleared).length, 0, 'it samples forever with the screen on')
  assert.ok((globalThis.__stub.homeCalls || 0) >= 1, 'it stays open for nothing')
})

// Brightness is a SYSTEM setting: it must be put back as it was, not set to 100.
await test('brightness is GIVEN BACK as it was, not at random', () => {
  globalThis.__stub = { acc: STILL, initialBrightness: 42 }
  const p = newPage()
  p.build()
  assert.equal(globalThis.__stub.brightness, 1, 'at night it must dim')
  tick(2)
  patch({ mode: 'idle' })
  tick(80) // closing takes three confirmations 25 ticks apart
  assert.equal(globalThis.__stub.brightness, 42, 'the watch is left with the wrong brightness all day')
})

// The fallback that PROMISED to stay listening but could not: timers and sensor
// were switched off before discovering that the navigation had failed (F3).
await test('BROKEN navigation: it really stays listening and tries again', () => {
  globalThis.__stub = { acc: STILL, initialBrightness: 50, throwReplace: true, throwPush: true }
  const p = newPage()
  p.build()
  move()
  assert.match(readEvents(), /still listening/, 'it did not even try to say so')
  assert.ok(timers.filter((t) => !t.cleared).length > 0, 'it killed the timer: "still listening" was an empty promise')
  assert.equal(globalThis.__stub.brightness, 50, 'screen left at full brightness in the bedroom for an hour')
  // Router repaired: on the next tick it must manage to open the alarm.
  globalThis.__stub.throwReplace = false
  tick(5)
  assert.ok(navigated().indexOf('page/ring') >= 0, 'it never tried again')
})

await test('sensor readings that throw: the lookout does not die', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  globalThis.__stub.throwAcc = true
  tick(20)
  assert.equal(navigated().length, 0, 'it woke you over a read error')
  globalThis.__stub.throwAcc = false
  move()
  assert.ok(navigated().indexOf('page/ring') >= 0, 'after the error it no longer feels anything')
})

console.log('\n== discretion and diary ==')

await test('very dark screen: black background and brightness at minimum', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  const rect = uiStub.__byType('FILL_RECT')[0]
  assert.ok(rect && rect.opts.color === 0x000000, 'background not black: it lights up the room')
  assert.equal(globalThis.__stub.brightness, 1, 'brightness not lowered')
})

await test('when it wakes you, the brightness goes back to normal', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(1)
  move()
  assert.equal(globalThis.__stub.brightness, 100, 'waking you with the screen dark: STOP would be invisible')
})

await test('VERBOSE records movement statistics without health data', () => {
  patch({ debugLog: 1 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(2)
  NOW += 61
  tick(2)
  const ev = readEvents()
  assert.match(ev, /LOOKOUT minute/)
  assert.match(ev, /"threshold":/)
  assert.match(ev, /"samples":/)
  assert.doesNotMatch(ev, /sleep|stage|wear|heart_rate/i)
})

// TEST SCREEN: same page, two outfits. At night it must not wake anyone.
await test('at night the lookout is nearly invisible', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  assert.equal(globalThis.__stub.brightness, 1, 'high brightness at night: it wakes you before the alarm does')
})

await test('TEST SCREEN on: readable, to see what is going on', () => {
  patch({ lookoutVisible: 1 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  assert.ok(globalThis.__stub.brightness > 1, 'in a test it must be readable')
  const labels = uiStub.__byType('TEXT').map((t) => String(t.opts.text))
  assert.ok(labels.some((t) => t.indexOf('TEST') >= 0), 'in a test it must say it is a test: ' + labels.join(' | '))
})

await test('the diary records the open, the minutes and the reason for waking', () => {
  patch({ debugLog: 1 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(2)
  NOW += 61 // a minute goes by
  tick(2)
  move()
  const ev = readEvents()
  assert.match(ev, /LOOKOUT opened/)
  assert.match(ev, /LOOKOUT minute/, 'the per-minute row is missing: without it the threshold cannot be tuned')
  assert.match(ev, /LOOKOUT WAKE/)
})


/** Observe screen updates without slowing or replacing the sensor loop. */
function trackDiagnosticText() {
  const label = uiStub.__byType('TEXT').find((widget) => widget.opts.h === 110)
  assert.ok(label)
  const updates = []
  const setProperty = label.setProperty
  label.setProperty = function (property, value) {
    if (property === uiStub.prop.TEXT) updates.push({ at: Date.now(), text: value })
    return setProperty.call(this, property, value)
  }
  return updates
}

await test('night mode skips diagnostic text updates while movement still triggers the alarm', () => {
  patch({ lookoutVisible: 0 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  const updates = trackDiagnosticText()
  tick(25)
  move()
  assert.equal(updates.length, 0)
  assert.ok(navigated().includes('page/ring'))
})

await test('test screen updates at most once per second while sampling remains at five Hz', () => {
  patch({ lookoutVisible: 1 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  const updates = trackDiagnosticText()
  let samples = 0
  const sample = p.motion.sample
  p.motion.sample = function (...args) {
    samples++
    return sample.apply(this, args)
  }
  tick(50)
  assert.equal(samples, 50)
  assert.equal(updates.length, 10)
  assert.match(updates[0].text, /movement 0 \/ 60/)
  for (let i = 1; i < updates.length; i++) {
    assert.ok(updates[i].at - updates[i - 1].at >= 1000)
  }
  assert.equal(navigated().length, 0)
})

await test('movement triggers between text refreshes without waiting for the next refresh', () => {
  patch({ lookoutVisible: 1 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  const updates = trackDiagnosticText()
  tick(2)
  assert.equal(updates.length, 1)
  const before = Date.now()
  move(7)
  assert.ok(navigated().includes('page/ring'))
  assert.equal(Date.now() - before, 1400)
  assert.equal(updates.length, 2)
  assert.ok(updates[updates.length - 1].at < Date.now())
})


await test('MINIMAL records opening and wake-up but no periodic logs or diagnostic sensor reads', () => {
  patch({ debugLog: 0 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  const before = readEvents()
  tick(610)
  assert.equal(readEvents(), before)
  assert.equal(globalThis.__stub.updateInfoCalls || 0, 0)
  move()
  assert.ok(navigated().includes('page/ring'))
  assert.match(readEvents(), /LOOKOUT opened/)
  assert.match(readEvents(), /LOOKOUT WAKE/)
})

await test('changing verbosity during listening enables and stops periodic diagnostics', () => {
  patch({ debugLog: 0 })
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(310)
  assert.equal(globalThis.__stub.updateInfoCalls || 0, 0)
  patch({ debugLog: 1 })
  tick(310)
  assert.equal(globalThis.__stub.updateInfoCalls || 0, 0)
  assert.match(readEvents(), /LOOKOUT minute/)
  assert.doesNotMatch(readEvents(), /sleep|stage|wear|heart_rate/i)
  patch({ debugLog: 0 })
  tick(25)
  const before = readEvents()
  const reads = globalThis.__stub.updateInfoCalls
  tick(310)
  assert.equal(readEvents(), before)
  assert.equal(globalThis.__stub.updateInfoCalls, reads)
})

await test('a short multi-reading burst is ignored while smaller sustained motion wakes', () => {
  NOW = T - 900
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(1)
  move(3, 15)
  globalThis.__stub.acc = STILL
  tick(20)
  assert.equal(navigated().length, 0)
  move(9, 3)
  assert.ok(navigated().includes('page/ring'))
})

Date.now = realNow

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

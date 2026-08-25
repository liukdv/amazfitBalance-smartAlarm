// Tests for the LOOKOUT: the page that opens when the window opens and listens
// to the accelerometer — the only sensor that really feels movement, and one
// that only works with the app in the foreground.
//
// The unit of the values is thousandths of g. With a still wrist the magnitude
// is ~1000 (gravity); the useful signal is how far it DEVIATES from 1000.
import assert from 'node:assert/strict'
import * as uiStub from '@zos/ui'
import * as fsStub from '@zos/fs'
import { load, patch, reset } from '../probe/utils/store.js'
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
  for (let i = 0; i < n; i++) timers.filter((t) => !t.cleared).forEach((t) => t.fn())
}

// The clock is driven by hand: the lookout always compares against the deadline.
let NOW = 1800000000
const realNow = Date.now
Date.now = () => NOW * 1000
const T = NOW + 1800 // target half an hour away

// The thresholds now DROP as the alarm time approaches: a test expecting a fixed
// number would be lying. They are asked of the same curve the lookout uses.
const { peakThreshold } = await import('../probe/utils/threshold.js')
// A movement that beats the threshold at a given moment, with some margin.
function movementOf(deviation) {
  return { x: 0, y: 0, z: 1000 + deviation }
}

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
// A jolt that beats even the highest threshold on the curve (half an hour from
// the alarm). Real measurement from 23 Aug: arm shaken → deviation 1765.
const MOVING = movementOf(2600)

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
  globalThis.__stub.acc = MOVING
  tick(5)
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
  globalThis.__stub.acc = MOVING
  tick(5)
  assert.ok(navigated().indexOf('page/ring') >= 0, 'the guard made the lookout deaf')
})

// ⭐ THE CURVE IN ACTION: the same movement that is not enough half an hour out
// wakes you three minutes from the alarm. It is the heart of the idea.
await test('THE CURVE: the same movement is not enough early, is enough late', () => {
  const medium = movementOf(300) // below the -30 min threshold (500), above the -2.5 min one (60)
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  globalThis.__stub.acc = medium
  tick(20)
  assert.equal(navigated().length, 0, 'half an hour out a medium movement must not wake you')

  NOW = T - 150 // two and a half minutes to go
  tick(10)
  assert.ok(navigated().indexOf('page/ring') >= 0, 'two minutes out the same movement must wake you')
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

// The threshold lives in the code, not in the saved state (23 Aug: the old state
// held 250 while the code said 200, silently). Here we prove that a movement
// BELOW the threshold — the slow turn measured at 122 — is not enough half an
// hour from the alarm (threshold 500). In the last 10 minutes, though, it MUST
// be enough: it is the "light movement" of the curve (threshold 100).
await test('slow turn (122): half an hour out it does NOT ring, at 8 minutes it DOES', () => {
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(3)
  globalThis.__stub.acc = { x: 0, y: 0, z: 1122 } // deviation 122
  tick(20)
  assert.equal(navigated().length, 0, 'half an hour out a slow turn must not wake you')

  NOW = T - 480 // 8 minutes to go: threshold 100
  tick(10)
  assert.ok(navigated().indexOf('page/ring') >= 0, 'at 8 minutes light movement must wake you')
})

await test('an old threshold in the state can NO LONGER lower the guard', () => {
  patch({ motionThreshold: 20 }) // leftover from an earlier version
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(3)
  globalThis.__stub.acc = { x: 0, y: 0, z: 1100 } // deviation 100: below 500 (half an hour out)
  tick(20)
  assert.equal(navigated().length, 0, 'a value left in the state overrode the threshold in the code')
})

console.log('\n== the second criterion: THE MEAN over two minutes ==')

// Restlessness: continuous micro-movements the peak never sees, but which say
// "he is surfacing out of sleep". Threshold FIXED at 50 in the last 10 minutes
// (25 Aug), half the peak further out.
// Time has to flow for REAL: the mean works on 10-second buckets.
function advance(seconds, acc) {
  for (let s = 0; s < seconds; s++) {
    globalThis.__stub.acc = acc
    NOW += 1
    tick(5) // 5 readings per second
  }
}

await test('prolonged restlessness: it wakes you without a single peak', () => {
  NOW = T - 280 // less than five minutes from the alarm: peak threshold 80, mean 50
  const p = newPage()
  p.build()
  // Continuous movement at 65: NEVER above the peak threshold (80), but the
  // two-minute mean goes past 50.
  advance(130, movementOf(65))
  assert.ok(navigated().indexOf('page/ring') >= 0, 'continuous micro-movements ignored: the mean criterion does not work')
  assert.match(readEvents(), /mean \d+ over \d+/, 'the reason must say it was the mean')
})

await test('background noise for two minutes: the mean must NOT wake you', () => {
  NOW = T - 200
  const p = newPage()
  p.build()
  advance(130, movementOf(30)) // the measured noise floor: 20-40
  assert.equal(navigated().length, 0, 'background noise tripped the mean: false alarms every night')
})

await test('history too short: the mean does not decide (few samples deceive)', () => {
  NOW = T - 280
  const p = newPage()
  p.build()
  advance(20, movementOf(65)) // above the mean (50) but only 20 seconds of data
  assert.equal(navigated().length, 0, 'it decided on twenty seconds of history')
})

await test('far from the alarm the mean stays strict (half the peak)', () => {
  NOW = T - 1500 // 25 minutes: peak threshold 500, mean 250
  const p = newPage()
  p.build()
  advance(130, movementOf(150))
  assert.equal(navigated().length, 0, 'at 25 minutes a mean of 150 must not be enough')
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
  globalThis.__stub.acc = MOVING
  tick(5)
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
  globalThis.__stub.acc = MOVING
  tick(5)
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
  globalThis.__stub.acc = MOVING
  tick(5)
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
  globalThis.__stub.acc = MOVING
  const p = newPage()
  p.build()
  tick(10)
  assert.equal(globalThis.__stub.brightness, 100, 'waking you with the screen dark: STOP would be invisible')
})

// ⭐ Every night leaves the answer to the open question by itself: are real-time
// stages usable? The alarm does not use them, but it records them.
await test('the sleep STAGES also end up in the diary, minute by minute', () => {
  globalThis.__stub.acc = STILL
  globalThis.__stub.sleepingStatus = 1
  globalThis.__stub.stages = [{ start: 100, stop: 200, model: 4 }]
  const p = newPage()
  p.build()
  tick(2)
  NOW += 61
  tick(2)
  const ev = readEvents()
  assert.match(ev, /"sleep":/, 'without the stages in the log the open question stays open')
  assert.match(ev, /"asleep":1/, 'the sleep status was not recorded')
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
  globalThis.__stub.acc = STILL
  const p = newPage()
  p.build()
  tick(2)
  NOW += 61 // a minute goes by
  tick(2)
  globalThis.__stub.acc = MOVING
  tick(5)
  const ev = readEvents()
  assert.match(ev, /LOOKOUT opened/)
  assert.match(ev, /LOOKOUT minute/, 'the per-minute row is missing: without it the threshold cannot be tuned')
  assert.match(ev, /LOOKOUT WAKE/)
})

Date.now = realNow

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

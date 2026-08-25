// Runs THE REAL app-service, tick by tick, over simulated nights.
//
// It is the test that comes closest to what will happen tonight: the service is
// woken, reads the fake sensors, decides, possibly vibrates and reschedules. If
// something does not add up here, nobody wakes up.
import assert from 'node:assert/strict'
import * as alarmStub from '@zos/alarm'
import * as fsStub from '@zos/fs'
import { load, patch, reset } from '../probe/utils/store.js'
import { readAll, readEvents, COLS } from '../probe/utils/log.js'
import { nextOccurrence } from '../probe/utils/schedule.js'

let pass = 0
let fail = 0
const failures = []

// Stage codes as the device would give them — deliberately NOT 0..3.
const C = { WAKE_STAGE: 4, REM_STAGE: 5, LIGHT_STAGE: 6, DEEP_STAGE: 7 }

// Capture the service definition.
let svc = null
globalThis.AppService = (def) => {
  svc = def
}
await import('../probe/app-service/probe.js')

function test(name, fn) {
  globalThis.__stub = {}
  fsStub.__reset()
  alarmStub.__reset()
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    failures.push(name + ' -> ' + e.message)
    console.log('  FAIL ' + name + '\n         ' + e.message)
  }
}

// Advances the fake clock: the service reads Date.now().
const realNow = Date.now
function setNow(unix) {
  Date.now = () => unix * 1000
}
function restoreNow() {
  Date.now = realNow
}

// One wake-up of the service.
function tick(param) {
  svc.onInit(param)
}

// Since the evening of 22 Aug the alarms come in TWO kinds: the ones that
// restart the service (`file:`) and the ones that open the ring page (`url:`).
// They have to be counted separately, otherwise "how many links the chain has"
// and "how many times I called the page" get mixed up.
function svcAlarms() {
  return alarmStub.__scheduled.filter((a) => a.file)
}
function pageAlarms() {
  return alarmStub.__scheduled.filter((a) => a.url && !a.file)
}

function stubAt({ sleeping, stage, now, wear }) {
  return {
    sleepingStatus: sleeping,
    wearStatus: wear === undefined ? 1 : wear, // 1 = on the wrist, still
    hr: 58,
    stageConstants: C,
    stages: stage !== null && stage !== undefined
      ? [{ start: (now - 300) * 1000, stop: (now - 30) * 1000, model: stage }]
      : [],
  }
}

/**
 * Simulates a night. `stageAt(t)` says which sleep stage you are in at time t.
 * Returns when it vibrated FOR THE FIRST TIME and how many wake-ups it took.
 */
function runNight({ start, target, windowSec, stageAt, sleepingAt, wearAt, state, maxTicks = 3000 }) {
  reset()
  patch({ mode: 'alarm', targetUnix: target, windowSec: windowSec, ...(state || {}) })
  let now = start
  let ticks = 0
  let firedAt = null
  while (ticks < maxTicks) {
    setNow(now)
    globalThis.__stub = stubAt({
      sleeping: sleepingAt ? sleepingAt(now) : 1,
      stage: stageAt ? stageAt(now) : null,
      wear: wearAt ? wearAt(now) : 1,
      now,
    })
    const before = load().fired || 0
    tick(ticks === 0 ? 'first' : 'tick')
    ticks++
    const st = load()
    if ((st.fired || 0) > before) {
      firedAt = now
      break
    }
    const svc = svcAlarms()
    const next = svc[svc.length - 1]
    if (!next) break // chain broken
    now = next.date
    alarmStub.__reset()
  }
  return { firedAt, ticks, state: load() }
}

const T = Math.floor(new Date(2026, 7, 22, 7, 30, 0, 0).getTime() / 1000)
const WIN = 30 * 60

console.log('\n== a whole night: the service always reaches the target ==')

test('deep sleep all night: it vibrates EXACTLY at the target', () => {
  const r = runNight({
    start: T - 8 * 3600,
    target: T,
    windowSec: WIN,
    stageAt: () => C.DEEP_STAGE,
    sleepingAt: () => 1,
  })
  assert.ok(r.firedAt !== null, 'IT NEVER VIBRATED: missed alarm')
  assert.ok(r.firedAt >= T, 'it vibrated before the target even though it was deep sleep')
  assert.ok(r.firedAt <= T + 60, 'it vibrated ' + (r.firedAt - T) + 's after the target')
})

test('light sleep inside the window: it goes early, but not too early', () => {
  const r = runNight({
    start: T - 8 * 3600,
    target: T,
    windowSec: WIN,
    stageAt: (t) => (t >= T - 12 * 60 ? C.LIGHT_STAGE : C.DEEP_STAGE),
    sleepingAt: () => 1,
  })
  assert.ok(r.firedAt !== null, 'it did not vibrate')
  assert.ok(r.firedAt <= T, 'it vibrated after the target')
  assert.ok(r.firedAt >= T - WIN, 'it vibrated BEFORE the window: woken far too early')
  assert.ok(r.firedAt >= T - 13 * 60, 'it vibrated while still in deep sleep')
})

// ⭐ SIMPLIFIED RULE (22 Aug, evening): awake inside the window = ring AT ONCE,
// even if you have been awake since arming it. Accepted consequence: arming it
// less than 30 min before the time rings almost immediately.
test('WITHOUT the lookout, awake at the start of the window: it vibrates on the FIRST reading', () => {
  const armedAt = T - 37 * 60 // armed 37 min earlier, like the night of 11 Aug
  const r = runNight({
    start: armedAt,
    target: T,
    windowSec: WIN,
    state: { useLookout: 0 },
    stageAt: () => null,
    sleepingAt: () => 0, // stays awake for the whole window
  })
  assert.ok(r.firedAt !== null, 'it never vibrated')
  assert.ok(r.firedAt < T, 'awake inside the window it had to go EARLY, not wait for the target')
  assert.ok(r.firedAt >= T - WIN, 'it vibrated BEFORE the window opened')
})

test('WITHOUT the lookout, waking up alone inside the window: it catches the awakening', () => {
  const r = runNight({
    start: T - 2 * 3600,
    target: T,
    windowSec: WIN,
    state: { useLookout: 0 },
    stageAt: () => null, // working assumption: stages never available during the night
    sleepingAt: (t) => (t >= T - 20 * 60 ? 0 : 1), // asleep, wakes at -20 min
  })
  assert.ok(r.firedAt !== null, 'it did not vibrate')
  assert.ok(r.firedAt <= T - 19 * 60, 'it had to catch the spontaneous awakening, it rang at -' + (T - r.firedAt) / 60 + ' min')
  assert.ok(r.firedAt >= T - WIN, 'it rang outside the window')
})

// With the simple rule no history is needed: any "awake" reading inside the
// window rings, even right after a sleep reading.
test('WITHOUT the lookout, asleep then awake inside the window: it rings when awake', () => {
  const start = T - 25 * 60
  const r = runNight({
    start,
    target: T,
    windowSec: WIN,
    state: { useLookout: 0 },
    stageAt: () => null,
    sleepingAt: (t) => (t === start ? 1 : 0), // one sleep reading, then awake
  })
  assert.ok(r.firedAt !== null, 'it did not vibrate')
  assert.ok(r.firedAt < T, 'awake inside the window: it had to ring without waiting for the target')
  assert.ok(r.firedAt >= T - WIN, 'it rang outside the window')
})

// The stages stay a viable route only by switching them back on by hand.
test('with the STAGES switched back on: it falls asleep in light sleep and catches the moment', () => {
  const r = runNight({
    start: T - 2 * 3600,
    target: T,
    windowSec: WIN,
    state: { useLookout: 0, useStages: 1 },
    stageAt: (t) => (t >= T - 15 * 60 ? C.LIGHT_STAGE : null),
    sleepingAt: (t) => (t >= T - 15 * 60 ? 1 : 0),
  })
  assert.ok(r.firedAt !== null)
  assert.ok(r.firedAt <= T - 13 * 60, 'it had to catch the light sleep as soon as it was classified')
})

test('sensors mute all night: it vibrates at the target anyway', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  let now = T - 3 * 3600
  let fired = null
  for (let i = 0; i < 400; i++) {
    setNow(now)
    globalThis.__stub = { throwStage: true, throwStatus: true, throwHr: true, throwUpdateInfo: true, throwStageConsts: true }
    const before = load().fired || 0
    tick(i === 0 ? 'first' : 'tick')
    if ((load().fired || 0) > before) {
      fired = now
      break
    }
    const nx = svcAlarms()[svcAlarms().length - 1]
    if (!nx) break
    now = nx.date
    alarmStub.__reset()
  }
  assert.ok(fired !== null, 'BROKEN SENSORS = NO ALARM: that was the defect to avoid')
  assert.ok(fired >= T && fired <= T + 60, 'vibrated ' + (fired - T) + 's from the target')
})

test('stage codes unavailable: never early, it vibrates at the target', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  let now = T - 20 * 60
  let fired = null
  for (let i = 0; i < 60; i++) {
    setNow(now)
    // A "light" stage but WITHOUT the device codes: it must not be trusted.
    globalThis.__stub = {
      sleepingStatus: 1,
      hr: 55,
      stages: [{ start: (now - 300) * 1000, stop: (now - 30) * 1000, model: 2 }],
    }
    const before = load().fired || 0
    tick(i === 0 ? 'first' : 'tick')
    if ((load().fired || 0) > before) {
      fired = now
      break
    }
    const nx = svcAlarms()[svcAlarms().length - 1]
    if (!nx) break
    now = nx.date
    alarmStub.__reset()
  }
  assert.ok(fired !== null, 'it did not vibrate')
  assert.ok(fired >= T, 'it vibrated on a stage with UNVERIFIED codes')
})

test('broken vibrator: the chain does not stall and it records it', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T + 10)
  globalThis.__stub = { sleepingStatus: 1, stages: [], throwVibrate: true }
  tick('first')
  const st = load()
  assert.ok(String(st.lastReason).indexOf('BUZZ') >= 0, 'the attempt must be recorded')
})

console.log('\n== ⭐ THE MOVEMENT ENGINE, over a whole night ==')

// The night as it works since 23 Aug: stages off, wrist movement decides.
// Movement as seen by the SERVICE only counts while the lookout is not
// listening: with the lookout on there must be a single decider (23 Aug review).
test('WITHOUT the lookout, I turn over in bed inside the window: it vibrates then', () => {
  const turn = T - 18 * 60 // a movement 18 minutes from the alarm
  const r = runNight({
    start: T - 6 * 3600,
    target: T,
    windowSec: WIN,
    state: { useLookout: 0 },
    stageAt: () => null,
    sleepingAt: () => 1,
    wearAt: (t) => (t >= turn && t < turn + 60 ? 2 : 1),
  })
  assert.ok(r.firedAt !== null, 'it never vibrated')
  assert.ok(r.firedAt >= turn, 'it vibrated BEFORE the movement: impossible')
  assert.ok(r.firedAt <= turn + 120, 'it ignored the movement and waited for the time')
})

test('a night as still as a stone: it vibrates at the exact time anyway', () => {
  const r = runNight({
    start: T - 6 * 3600,
    target: T,
    windowSec: WIN,
    stageAt: () => null,
    sleepingAt: () => 1,
    wearAt: () => 1, // never a movement
  })
  assert.ok(r.firedAt !== null, 'IT DID NOT VIBRATE: missed alarm')
  assert.ok(r.firedAt >= T, 'it went early for no reason')
  assert.ok(r.firedAt <= T + 60)
})

test('movements BEFORE the window: ignored, it does not ring hours early', () => {
  const r = runNight({
    start: T - 6 * 3600,
    target: T,
    windowSec: WIN,
    stageAt: () => null,
    sleepingAt: () => 1,
    wearAt: (t) => (t < T - WIN ? 2 : 1), // restless all night, then still
  })
  assert.ok(r.firedAt >= T, 'it rang because of a movement outside the window')
})

// ⭐ WITH the lookout (the normal case) the service must never go early: the
// lookout listens, and the service stays the safety net for the deadline.
// Without this rule, during the day the service would fire at once and it would
// be impossible to test the real alarm with a short window.
test('WITH the lookout: the service never goes early, not even awake and moving', () => {
  const r = runNight({
    start: T - 15 * 60,
    target: T,
    windowSec: 15 * 60,
    stageAt: () => null,
    sleepingAt: () => 0, // awake the whole time
    wearAt: () => 2, // and moving too
  })
  assert.ok(r.firedAt !== null, 'it did not vibrate at all')
  assert.ok(r.firedAt >= T, 'the service overrode the lookout and went early')
})

console.log('\n== the ringing INSISTS: 3 rounds, then it closes ==')

test('after the first vibration it enters ringing mode and reschedules at +60s', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T + 5)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T + 5 })
  alarmStub.__reset()
  tick('tick')
  const st = load()
  assert.equal(st.fired, 1)
  assert.equal(st.mode, 'ringing', 'after the first ring it must INSIST, not close')
  // What really matters: it opened the PAGE, the only thing that vibrates.
  assert.equal(pageAlarms().length, 1, 'it did not open the ring page: mute motor')
  assert.equal(pageAlarms()[0].url, 'page/ring')
  assert.equal(svcAlarms().length, 1, 'the next ring is missing')
  const next = svcAlarms()[0]
  assert.ok(next.date - (T + 5) >= 55 && next.date - (T + 5) <= 65, 'next ring expected at ~60s')
})

test('three rings in total, then idle and no leftover alarms', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  let now = T + 5
  setNow(now)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now })
  alarmStub.__reset()
  tick('tick') // ring 1
  for (let i = 0; i < 2; i++) {
    const svc = svcAlarms()
    const nx = svc[svc.length - 1]
    assert.ok(nx, 'ringing chain broken at round ' + (i + 2))
    now = nx.date
    alarmStub.__reset()
    setNow(now)
    globalThis.__stub = stubAt({ sleeping: 1, stage: null, now })
    tick('tick') // rings 2 and 3
  }
  const st = load()
  assert.equal(st.fired, 3, 'expected 3 rings, found ' + st.fired)
  assert.equal(st.mode, 'idle', 'after 3 rings it must close')
  assert.equal(st.done, 1)
  assert.equal(svcAlarms().length, 0, 'it would keep ringing forever')
})

test('STOP halfway through the ringing: no further rings', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T + 5)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T + 5 })
  alarmStub.__reset()
  tick('tick') // ring 1, enters ringing mode
  patch({ mode: 'idle', rings: 0 }) // STOP from the page
  const nx = svcAlarms()[svcAlarms().length - 1]
  setNow(nx.date)
  alarmStub.__reset()
  const before = load().fired
  tick('tick')
  assert.equal(load().fired, before, 'it rang after STOP')
  assert.equal(svcAlarms().length, 0)
})

test('two rings never closer than 45s (chain and failsafe together)', () => {
  reset()
  // Ringing, last ring 5 seconds ago: the failsafe wake-up must NOT produce a
  // double buzz.
  patch({ mode: 'ringing', targetUnix: T, windowSec: WIN, rings: 1, fired: 1, lastRingUnix: T + 5 })
  setNow(T + 10)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T + 10 })
  alarmStub.__reset()
  tick('failsafe')
  const st = load()
  assert.equal(st.fired, 1, 'double buzz too close together')
  assert.equal(st.mode, 'ringing', 'it must stay in ringing mode')
  assert.equal(svcAlarms().length, 1, 'it must still reschedule the next one')
})

console.log('\n== the failsafe alarm: if the chain dies, it rings ==')

test('chain never started, only the failsafe arrives at the target: IT VIBRATES', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  // No tick ever arrived: the very first wake-up is the failsafe.
  setNow(T + 5)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T + 5 })
  alarmStub.__reset()
  tick('failsafe')
  const st = load()
  assert.equal(st.fired, 1, 'THE FAILSAFE DID NOT RING: what is a failsafe for?')
  assert.equal(st.mode, 'ringing')
})

test('failsafe with the alarm ALREADY rung at the time: silence', () => {
  reset()
  // Healthy conclusion: the ringing happened AT the time or later.
  patch({ mode: 'idle', done: 1, fired: 3, targetUnix: T, lastRingUnix: T + 125 })
  setNow(T + 5)
  globalThis.__stub = stubAt({ sleeping: 0, stage: null, now: T + 5 })
  alarmStub.__reset()
  tick('failsafe')
  assert.equal(load().fired, 3, 'it rang again on an alarm that was already finished')
  assert.equal(svcAlarms().length, 0)
})

// 22 Aug review, finding 2: early natural awakening -> 3 rings -> you doze off
// again -> at the deadline the old code stayed SILENT.
test('ringing exhausted BEFORE the time: the failsafe rings again at the deadline', () => {
  reset()
  patch({ mode: 'idle', done: 1, fired: 3, targetUnix: T, lastRingUnix: T - 18 * 60 })
  setNow(T + 5)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T + 5 })
  alarmStub.__reset()
  tick('failsafe')
  const st = load()
  assert.equal(st.fired, 4, 'an ordinary alarm would have rung at 7:30: the failsafe must do it')
  assert.equal(st.mode, 'ringing', 'and it must insist like a real ring')
  assert.equal(svcAlarms().length, 1)
})

// 22 Aug review, finding 3: a corrupted state.json is re-read as DEFAULTS (idle)
// and silenced the chain AND the failsafe together.
test('corrupted/zeroed state: a live failsafe rings all the same', () => {
  reset() // exactly what load() returns after a corruption
  setNow(T + 5)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T + 5 })
  alarmStub.__reset()
  tick('failsafe')
  assert.equal(load().fired, 1, 'unreadable state + live failsafe = it rings, never silence')
  assert.equal(load().mode, 'ringing')
})

console.log('\n== consumption: how many wake-ups a night costs ==')

test('8 hours with a 30 min window: fewer than 60 wake-ups in total', () => {
  const r = runNight({
    start: T - 8 * 3600,
    target: T,
    windowSec: WIN,
    stageAt: () => C.DEEP_STAGE,
    sleepingAt: () => 1,
  })
  assert.ok(r.ticks < 60, 'too many wake-ups in one night: ' + r.ticks)
  assert.ok(r.ticks > 20, 'too few: the window was not covered minute by minute (' + r.ticks + ')')
})

console.log('\n== the chain must never break ==')

test('every wake-up schedules exactly one new one', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T - 3600)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T - 3600 })
  for (let i = 0; i < 10; i++) {
    alarmStub.__reset()
    tick('tick')
    assert.equal(svcAlarms().length, 1, 'round ' + i + ': chain broken or duplicated')
  }
})

test('idle mode: the service does not re-arm itself', () => {
  reset()
  setNow(T)
  globalThis.__stub = stubAt({ sleeping: 0, stage: null, now: T })
  alarmStub.__reset()
  tick('tick')
  assert.equal(svcAlarms().length, 0, 'a zombie chain eating battery')
})

console.log('\n== traceability: the diary tells the story of the night ==')

test('the diary records the wake-up, the decision and the vibration', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T + 5)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T + 5 })
  tick('first')
  const ev = readEvents()
  assert.ok(ev.indexOf('SVC awake') >= 0, 'the wake-up is missing from the diary')
  assert.ok(ev.indexOf('SVC decision') >= 0, 'the decision is missing')
  assert.ok(ev.indexOf('SVC VIBRATION') >= 0, 'the vibration is missing')
})

test('the samples stay readable after a night of writes', () => {
  const r = runNight({
    start: T - 8 * 3600,
    target: T,
    windowSec: WIN,
    stageAt: () => C.DEEP_STAGE,
    sleepingAt: () => 1,
  })
  const rows = readAll().split('\n').filter(Boolean)
  assert.ok(rows.length > 20, 'too few samples: ' + rows.length)
  assert.ok(rows[0].startsWith('ts_iso'), 'header out of place')
  rows.slice(1).forEach((l, i) => {
    assert.ok(l.split(',').length === COLS, 'sample ' + i + ' corrupted: ' + l)
  })
})

console.log('\n== real times: late evening, alarm in the morning ==')

test('I set 07:30 at 00:20: the target is the next morning, and it gets there', () => {
  const bedtime = Math.floor(new Date(2026, 7, 23, 0, 20, 0, 0).getTime() / 1000)
  const target = nextOccurrence(bedtime, 7, 30)
  assert.ok(target - bedtime > 7 * 3600, 'target too close: ' + (target - bedtime))
  const r = runNight({
    start: bedtime,
    target: target,
    windowSec: WIN,
    stageAt: () => C.DEEP_STAGE,
    sleepingAt: () => 1,
  })
  assert.ok(r.firedAt !== null, 'it did not vibrate on the real night')
  assert.ok(Math.abs(r.firedAt - target) <= 60)
})

test('TONIGHT in full: I arm it awake, I fall asleep, light sleep in the morning', () => {
  const bedtime = Math.floor(new Date(2026, 7, 23, 0, 30, 0, 0).getTime() / 1000)
  const target = nextOccurrence(bedtime, 7, 30)
  const asleepFrom = bedtime + 40 * 60 // falls asleep 40 min after arming it
  const r = runNight({
    start: bedtime,
    target: target,
    windowSec: WIN,
    sleepingAt: (t) => (t >= asleepFrom ? 1 : 0),
    stageAt: (t) => {
      if (t < asleepFrom) return null
      return t >= target - 10 * 60 ? C.LIGHT_STAGE : C.DEEP_STAGE
    },
  })
  assert.ok(r.firedAt !== null, 'it did not vibrate')
  assert.ok(r.firedAt >= target - 11 * 60, 'far too early: ' + (target - r.firedAt) / 60 + ' min before')
  assert.ok(r.firedAt <= target, 'past the target')
})

console.log('\n== the "night log" flag ==')

test('log OFF: no samples and no verbose log, but the alarm RINGS', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN, debugLog: 0 })
  setNow(T + 5)
  globalThis.__stub = stubAt({ sleeping: 1, stage: null, now: T + 5 })
  alarmStub.__reset()
  tick('first')
  assert.equal(load().fired, 1, 'with the log off the alarm MUST still ring')
  assert.equal(readAll(), '', 'samples written with the log off')
  const ev = readEvents()
  assert.ok(ev.indexOf('SVC VIBRATION') >= 0, 'the vibration must ALWAYS be recorded')
  assert.ok(ev.indexOf('SVC reading') < 0, 'verbose log present with the flag off')
})

test('log ON (default): every tick writes diary and sample', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T - 600)
  globalThis.__stub = stubAt({ sleeping: 1, stage: C.DEEP_STAGE, now: T - 600 })
  alarmStub.__reset()
  tick('first')
  assert.ok(readAll().split('\n').filter(Boolean).length >= 2, 'sample not written')
  assert.ok(readEvents().indexOf('SVC reading') >= 0, 'the default verbose log is missing')
})

restoreNow()

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

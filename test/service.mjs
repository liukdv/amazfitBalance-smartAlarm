// Runs THE REAL app-service, tick by tick, over simulated nights.
//
// It is the test that comes closest to what will happen tonight: the service is
// woken, checks the deadline, possibly vibrates and reschedules. If
// something does not add up here, nobody wakes up.
import assert from 'node:assert/strict'
import * as alarmStub from '@zos/alarm'
import * as fsStub from '@zos/fs'
import { load, patch, reset } from '../probe/utils/store.js'
import { readEvents } from '../probe/utils/log.js'
import { nextOccurrence } from '../probe/utils/schedule.js'

let pass = 0
let fail = 0
const failures = []

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

/** Simulate service callbacks until the first ring, recording the callback count. */
function runNight({ start, target, windowSec, state, maxTicks = 3000 }) {
  reset()
  patch({ mode: 'alarm', targetUnix: target, windowSec: windowSec, ...(state || {}) })
  let now = start
  let ticks = 0
  let firedAt = null
  while (ticks < maxTicks) {
    setNow(now)
    globalThis.__stub = {}
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

for (const windowSec of [0, 60, WIN]) {
  test('service reaches the target without sensors; window ' + windowSec + ' seconds', () => {
    const result = runNight({ start: T - 8 * 3600, target: T, windowSec })
    assert.ok(result.firedAt >= T && result.firedAt <= T + 60, 'missed or premature alarm')
    assert.equal(fsStub.__get('probe.csv'), null)
  })
}

test('obsolete saved sensor settings cannot cause an early service alarm', () => {
  const result = runNight({
    start: T - 3600, target: T, windowSec: WIN,
    state: { useStages: 1, useLookout: 0, debugLog: 1 },
  })
  assert.equal(result.firedAt, T)
  assert.equal(fsStub.__get('probe.csv'), null)
})

test('broken vibrator still opens the ring page, records the failure and reschedules', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T + 10)
  globalThis.__stub = { throwVibrate: true }
  tick('first')
  assert.match(load().lastReason, /BUZZ:err/)
  assert.equal(pageAlarms().length, 1)
  assert.equal(svcAlarms().length, 1)
})

test('retired monitoring mode cannot start another background chain', () => {
  reset()
  patch({ mode: 'monitor', maxTicks: 10 })
  setNow(T)
  tick('tick')
  assert.equal(svcAlarms().length, 0)
  assert.equal(fsStub.__get('probe.csv'), null)
})

console.log('\n== the ringing INSISTS: 3 rounds, then it closes ==')

test('after the first vibration it enters ringing mode and reschedules at +60s', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T + 5)
  globalThis.__stub = {}
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
  globalThis.__stub = {}
  alarmStub.__reset()
  tick('tick') // ring 1
  for (let i = 0; i < 2; i++) {
    const svc = svcAlarms()
    const nx = svc[svc.length - 1]
    assert.ok(nx, 'ringing chain broken at round ' + (i + 2))
    now = nx.date
    alarmStub.__reset()
    setNow(now)
    globalThis.__stub = {}
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
  globalThis.__stub = {}
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
  globalThis.__stub = {}
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
  globalThis.__stub = {}
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
  globalThis.__stub = {}
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
  globalThis.__stub = {}
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
  globalThis.__stub = {}
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
  })
  assert.ok(r.ticks < 60, 'too many wake-ups in one night: ' + r.ticks)
  assert.ok(r.ticks > 20, 'too few: the window was not covered minute by minute (' + r.ticks + ')')
})

console.log('\n== the chain must never break ==')

test('every wake-up schedules exactly one new one', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN })
  setNow(T - 3600)
  globalThis.__stub = {}
  for (let i = 0; i < 10; i++) {
    alarmStub.__reset()
    tick('tick')
    assert.equal(svcAlarms().length, 1, 'round ' + i + ': chain broken or duplicated')
  }
})

test('idle mode: the service does not re-arm itself', () => {
  reset()
  setNow(T)
  globalThis.__stub = {}
  alarmStub.__reset()
  tick('tick')
  assert.equal(svcAlarms().length, 0, 'a zombie chain eating battery')
})

console.log('\n== traceability: the diary tells the story of the night ==')

test('the diary records the wake-up, the decision and the vibration', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN, debugLog: 1 })
  setNow(T + 5)
  globalThis.__stub = {}
  tick('first')
  const ev = readEvents()
  assert.ok(ev.indexOf('SVC awake') >= 0, 'the wake-up is missing from the diary')
  assert.ok(ev.indexOf('SVC decision') >= 0, 'the decision is missing')
  assert.ok(ev.indexOf('SVC VIBRATION') >= 0, 'the vibration is missing')
})

test('VERBOSE keeps complete event rows over a night without collecting a CSV', () => {
  runNight({ start: T - 8 * 3600, target: T, windowSec: WIN, state: { debugLog: 1 } })
  const rows = readEvents().trimEnd().split('\n')
  assert.ok(rows.length > 20)
  for (const row of rows) assert.match(row, /^\d\d:\d\d:\d\d SVC /)
  assert.equal(fsStub.__get('probe.csv'), null)
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
  })
  assert.ok(r.firedAt !== null, 'it did not vibrate on the real night')
  assert.ok(Math.abs(r.firedAt - target) <= 60)
})

console.log('\n== the "night log" flag ==')

test('log OFF: no samples and no verbose log, but the alarm RINGS', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN, debugLog: 0 })
  setNow(T + 5)
  globalThis.__stub = {}
  alarmStub.__reset()
  tick('first')
  assert.equal(load().fired, 1, 'with the log off the alarm MUST still ring')
  assert.equal(fsStub.__get('probe.csv'), null)
  const ev = readEvents()
  assert.ok(ev.indexOf('SVC VIBRATION') >= 0, 'the vibration must ALWAYS be recorded')
  assert.ok(ev.indexOf('SVC reading') < 0, 'verbose log present with the flag off')
})

test('VERBOSE writes service state and decisions without health data or CSV', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN, debugLog: 1 })
  setNow(T - 600)
  tick('first')
  assert.equal(fsStub.__get('probe.csv'), null)
  assert.match(readEvents(), /SVC state/)
  assert.match(readEvents(), /SVC decision/)
  assert.doesNotMatch(readEvents(), /sleep|stage|wear|heart_rate/i)
})

test('fresh settings use MINIMAL and preserve an explicitly saved VERBOSE preference', () => {
  reset()
  assert.equal(load().debugLog, 0)
  patch({ debugLog: 1 })
  patch({ mode: 'alarm', targetUnix: T })
  assert.equal(load().debugLog, 1)
})

test('MINIMAL skips diagnostic sensor reads and periodic logs while keeping the service armed', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN, debugLog: 0 })
  globalThis.__stub = {}
  for (let i = 0; i < 3; i++) {
    setNow(T - 600 + i * 60)
    alarmStub.__reset()
    tick('tick')
    assert.equal(load().fired, 0)
    assert.equal(svcAlarms().length, 1)
  }
  assert.equal(globalThis.__stub.updateInfoCalls || 0, 0)
  assert.equal(fsStub.__get('probe.csv'), null)
  assert.equal(readEvents(), '')
  setNow(T)
  tick('failsafe')
  assert.equal(load().fired, 1)
  assert.equal(globalThis.__stub.updateInfoCalls || 0, 0)
  assert.match(readEvents(), /SVC VIBRATION/)
})

test('MINIMAL retains scheduling errors without collecting a diagnostic sensor sample', () => {
  reset()
  patch({ mode: 'alarm', targetUnix: T, windowSec: WIN, debugLog: 0 })
  setNow(T - 600)
  globalThis.__stub = { throwAlarmSet: true }
  tick('tick')
  assert.match(readEvents(), /SVC reschedule ERROR/)
  assert.equal(fsStub.__get('probe.csv'), null)
  assert.equal(globalThis.__stub.updateInfoCalls || 0, 0)
})

restoreNow()

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

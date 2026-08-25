// Tests for the alarm decision. It is the heart of the project: this is where it
// is settled whether you get woken at the right moment, or woken at all.
import assert from 'node:assert/strict'
import { decide } from '../probe/utils/decide.js'

let pass = 0
let fail = 0
const failures = []
function test(name, fn) {
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

// Stage codes as the device would give them — deliberately NOT 0..3: the
// hardcoded map was the defect found in the field (an unexpected model=4 turned
// up).
const C = { WAKE: 4, REM: 5, LIGHT: 6, DEEP: 7 }
const WAKEABLE = [C.WAKE, C.LIGHT, C.REM]

const T = 1000000 // fictitious deadline
const base = { targetUnix: T, windowSec: 1800, maxStaleSec: 600, wakeableModels: WAKEABLE }
// Since 23 Aug the stage route is OFF by default: the tests that concern it turn
// it back on explicitly, as they should — they are tests of preserved code.
const baseStages = { ...base, useStages: true }

console.log('\n== the alarm must ALWAYS ring at the deadline ==')

test('exactly at the deadline: it rings', () => {
  const d = decide({ ...base, nowUnix: T, sleepingStatus: 1, lastStageModel: C.DEEP, lastStageStop: T - 60 })
  assert.equal(d.fire, true, 'it does NOT ring at the deadline: unacceptable defect')
})

test('past the deadline: it rings anyway', () => {
  const d = decide({ ...base, nowUnix: T + 300, sleepingStatus: 1, lastStageModel: C.DEEP, lastStageStop: T })
  assert.equal(d.fire, true)
})

test('deep sleep at the deadline: it rings all the same', () => {
  const d = decide({ ...base, nowUnix: T, sleepingStatus: 1, lastStageModel: C.DEEP, lastStageStop: T - 30 })
  assert.equal(d.fire, true, 'deep sleep must not be able to block the alarm')
})

test('data completely missing at the deadline: it rings', () => {
  const d = decide({ ...base, nowUnix: T, sleepingStatus: null, lastStageModel: null, lastStageStop: null })
  assert.equal(d.fire, true)
})

test('AWAKE at the deadline: it rings (being awake does not switch the alarm off)', () => {
  const d = decide({ ...base, nowUnix: T, sleepingStatus: 0 })
  assert.equal(d.fire, true)
})

console.log('\n== outside the window it never rings ==')

test('one second before the window opens: nothing', () => {
  const d = decide({ ...base, nowUnix: T - 1801, sleepingStatus: 0 })
  assert.equal(d.fire, false)
  assert.match(d.reason, /outside window/)
})

test('awake but outside the window: nothing (do not ring hours early)', () => {
  const d = decide({ ...base, nowUnix: T - 7200, sleepingStatus: 0, lastStageModel: C.WAKE, lastStageStop: T - 7260 })
  assert.equal(d.fire, false)
})

console.log('\n== ⭐ MOVEMENT: the new heart (23 Aug) ==')

// The smart alarms that work look at movement, not at stages.
// wearStatus: 0 not worn, 1 still on the wrist, 2 MOVING, 3 uncertain.
test('wrist MOVING inside the window: it rings', () => {
  const d = decide({ ...base, nowUnix: T - 1200, sleepingStatus: 1, wearStatus: 2 })
  assert.equal(d.fire, true, 'you are turning over: this is the good moment')
  assert.match(d.reason, /movement/)
})

test('wrist STILL inside the window: it waits', () => {
  const d = decide({ ...base, nowUnix: T - 1200, sleepingStatus: 1, wearStatus: 1 })
  assert.equal(d.fire, false, 'motionless: this is not the moment')
})

test('movement OUTSIDE the window: nothing (the window always rules)', () => {
  const d = decide({ ...base, nowUnix: T - 7200, sleepingStatus: 1, wearStatus: 2 })
  assert.equal(d.fire, false)
  assert.match(d.reason, /outside window/)
})

test('watch TAKEN OFF the wrist: no ring on movement, but yes at the deadline', () => {
  const inside = decide({ ...base, nowUnix: T - 900, sleepingStatus: 1, wearStatus: 0 })
  assert.equal(inside.fire, false)
  const deadline = decide({ ...base, nowUnix: T, sleepingStatus: 1, wearStatus: 0 })
  assert.equal(deadline.fire, true, 'at the deadline it must ring regardless')
})

test('movement sensor MUTE: the alarm stays alive and rings at the deadline', () => {
  const inside = decide({ ...base, nowUnix: T - 900, sleepingStatus: 1, wearStatus: null })
  assert.equal(inside.fire, false)
  const deadline = decide({ ...base, nowUnix: T, sleepingStatus: 1, wearStatus: null })
  assert.equal(deadline.fire, true)
})

// ⭐ ONE SINGLE DECIDER (23 Aug): while the lookout is listening, we no longer
// look at "is he awake?" here. During the day that value is always 0 and would
// ring instantly, making it impossible to test the real alarm with a short
// window — which is how tests are done now.
test('lookout active: awake and still does NOT ring, the lookout decides', () => {
  const d = decide({ ...base, nowUnix: T - 600, sleepingStatus: 0, wearStatus: 1, lookoutActive: true })
  assert.equal(d.fire, false, 'the service overrode the lookout: a short-window test becomes impossible')
})

test('lookout active: the deadline still applies (safety net)', () => {
  const d = decide({ ...base, nowUnix: T, sleepingStatus: 0, wearStatus: 1, lookoutActive: true })
  assert.equal(d.fire, true)
  assert.match(d.reason, /deadline/)
})

test('lookout OFF: the old "awake inside the window" rule comes back', () => {
  const d = decide({ ...base, nowUnix: T - 600, sleepingStatus: 0, wearStatus: 1, lookoutActive: false })
  assert.equal(d.fire, true)
  assert.match(d.reason, /awake/)
})

console.log('\n== the STAGES: off by default, preserved ==')

test('favourable stage but the stage route is OFF: no ring', () => {
  const now = T - 900
  const d = decide({ ...base, nowUnix: now, sleepingStatus: 1, wearStatus: 1, lastStageModel: C.LIGHT, lastStageStop: now - 60 })
  assert.equal(d.fire, false, 'by default the stages must decide nothing any more')
  assert.match(d.reason, /movement/, 'the reason must say it is waiting for movement')
})

test('useStages switches the old logic back on (the code was not thrown away)', () => {
  const now = T - 900
  const d = decide({ ...base, nowUnix: now, sleepingStatus: 1, wearStatus: 1, useStages: true, lastStageModel: C.LIGHT, lastStageStop: now - 60 })
  assert.equal(d.fire, true)
  assert.match(d.reason, /favourable stage/)
})

test('useStages on: in deep sleep it still does not ring', () => {
  const now = T - 900
  const d = decide({ ...base, nowUnix: now, sleepingStatus: 1, wearStatus: 1, useStages: true, lastStageModel: C.DEEP, lastStageStop: now - 60 })
  assert.equal(d.fire, false)
})

console.log('\n== inside the window ==')

// ⭐ SIMPLIFIED RULE (decision of 22 Aug, evening): inside the window, AWAKE =
// ring IMMEDIATELY, with no history and no conditions. Consequences accepted
// explicitly: arming less than 30 min before the time rings almost at once, and
// a momentary "awake" late in the night rings (max earliness = the window).
// (The old everSlept, which waited for the deadline if you had never slept, was
// removed: too much machinery.)
test('AWAKE when the window opens: rings IMMEDIATELY (simple rule)', () => {
  const d = decide({ ...base, nowUnix: T - 1800, sleepingStatus: 0 })
  assert.equal(d.fire, true, 'awake inside the window = it rings, full stop')
  assert.match(d.reason, /awake/)
})

test('AWAKE halfway through the window: rings at once', () => {
  const d = decide({ ...base, nowUnix: T - 900, sleepingStatus: 0 })
  assert.equal(d.fire, true)
  assert.match(d.reason, /awake/)
})

test('awake but OUTSIDE the window: nothing, the window rules', () => {
  const d = decide({ ...base, nowUnix: T - 7200, sleepingStatus: 0 })
  assert.equal(d.fire, false)
  assert.match(d.reason, /outside window/)
})

test('asleep in deep sleep: the stage rules apply all the same', () => {
  const now = T - 900
  const d = decide({ ...base, nowUnix: now, sleepingStatus: 1, lastStageModel: C.DEEP, lastStageStop: now - 30 })
  assert.equal(d.fire, false, 'in deep sleep it does not ring')
})

test('recent light sleep: it rings', () => {
  const now = T - 900
  const d = decide({ ...baseStages, nowUnix: now, sleepingStatus: 1, lastStageModel: C.LIGHT, lastStageStop: now - 120 })
  assert.equal(d.fire, true)
  assert.match(d.reason, /favourable stage/)
})

test('recent REM: it rings', () => {
  const now = T - 900
  const d = decide({ ...baseStages, nowUnix: now, sleepingStatus: 1, lastStageModel: C.REM, lastStageStop: now - 60 })
  assert.equal(d.fire, true)
})

test('recent WAKE stage but status asleep: it rings (very light sleep)', () => {
  const now = T - 900
  const d = decide({ ...baseStages, nowUnix: now, sleepingStatus: 1, lastStageModel: C.WAKE, lastStageStop: now - 60 })
  assert.equal(d.fire, true)
})

test('recent deep sleep: it waits', () => {
  const now = T - 900
  const d = decide({ ...baseStages, nowUnix: now, sleepingStatus: 1, lastStageModel: C.DEEP, lastStageStop: now - 60 })
  assert.equal(d.fire, false)
  assert.match(d.reason, /unfavourable/)
})

test('favourable stage but OLD: not to be trusted', () => {
  const now = T - 900
  const d = decide({ ...baseStages, nowUnix: now, sleepingStatus: 1, lastStageModel: C.LIGHT, lastStageStop: now - 1800 })
  assert.equal(d.fire, false, 'a classification from half an hour ago must not make it ring')
  assert.match(d.reason, /too old/)
})

test('no stage available but asleep: it waits for the deadline', () => {
  const d = decide({ ...baseStages, nowUnix: T - 900, sleepingStatus: 1, lastStageModel: null, lastStageStop: null })
  assert.equal(d.fire, false)
  assert.match(d.reason, /no stage/)
})

console.log('\n== unknown stage codes: never guess ==')

test('device codes NOT available: no stage makes it ring', () => {
  const now = T - 900
  const d = decide({ ...baseStages, wakeableModels: [], nowUnix: now, sleepingStatus: 1, lastStageModel: C.LIGHT, lastStageStop: now - 60 })
  assert.equal(d.fire, false, 'without reliable codes you risk ringing in deep sleep')
  assert.match(d.reason, /unknown stage codes/)
})

test('a stage code never seen before (e.g. 9): NO ring, it waits for the time', () => {
  const now = T - 900
  const d = decide({ ...baseStages, nowUnix: now, sleepingStatus: 1, lastStageModel: 9, lastStageStop: now - 60 })
  assert.equal(d.fire, false)
})

test('wakeableModels missing entirely: behaves like an empty list', () => {
  const now = T - 900
  const d = decide({ targetUnix: T, windowSec: 1800, useStages: true, nowUnix: now, sleepingStatus: 1, lastStageModel: C.LIGHT, lastStageStop: now - 60 })
  assert.equal(d.fire, false)
})

console.log('\n== different windows ==')

for (const min of [5, 10, 20, 30]) {
  test('window of ' + min + ' min: inside it decides, outside never', () => {
    const win = min * 60
    const justBefore = decide({ ...baseStages, windowSec: win, nowUnix: T - win - 1, sleepingStatus: 1, lastStageModel: C.LIGHT, lastStageStop: T - win - 30 })
    const justInside = decide({ ...baseStages, windowSec: win, nowUnix: T - win, sleepingStatus: 1, lastStageModel: C.LIGHT, lastStageStop: T - win - 30 })
    assert.equal(justBefore.fire, false, 'it rang before the window opened')
    assert.equal(justInside.fire, true, 'light sleep at the opening: it should have rung')
  })
}

console.log('\n== a simulated night, minute by minute ==')

test('never rings in deep sleep, and rings by the deadline', () => {
  const win = 1800
  // Deep until -8 min, then light.
  let firedAt = null
  for (let t = T - win; t <= T; t += 60) {
    const stage = t < T - 480 ? C.DEEP : C.LIGHT
    const d = decide({ ...base, windowSec: win, nowUnix: t, sleepingStatus: 1, lastStageModel: stage, lastStageStop: t - 30 })
    if (d.fire) {
      firedAt = t
      break
    }
  }
  assert.ok(firedAt !== null, 'it never rang')
  assert.ok(firedAt <= T, 'it rang past the deadline')
  assert.ok(firedAt >= T - 480 - 60, 'it rang during deep sleep: ' + (T - firedAt) / 60 + ' min early')
})

test('a night entirely in deep sleep: it rings anyway, exactly at the deadline', () => {
  const win = 1800
  let firedAt = null
  for (let t = T - win; t <= T; t += 60) {
    const d = decide({ ...base, windowSec: win, nowUnix: t, sleepingStatus: 1, lastStageModel: C.DEEP, lastStageStop: t - 30 })
    if (d.fire) {
      firedAt = t
      break
    }
  }
  assert.equal(firedAt, T, 'it should have rung at the deadline, it rang at ' + firedAt)
})

test('I stay AWAKE for the whole window: it rings on the FIRST reading inside it', () => {
  const win = 600
  let firedAt = null
  for (let t = T - win; t <= T; t += 60) {
    const d = decide({ ...base, windowSec: win, nowUnix: t, sleepingStatus: 0 })
    if (d.fire) {
      firedAt = t
      break
    }
  }
  assert.equal(firedAt, T - win, 'awake = it rings as soon as the window opens, not at the deadline')
})

test('I sleep deeply and wake halfway through the window: it rings at that moment', () => {
  const win = 1800
  let firedAt = null
  for (let t = T - win; t <= T; t += 60) {
    const awake = t >= T - 900 // natural awakening halfway through the window
    const d = decide({
      ...base,
      windowSec: win,
      nowUnix: t,
      sleepingStatus: awake ? 0 : 1,
      lastStageModel: C.DEEP,
      lastStageStop: t - 30,
    })
    if (d.fire) {
      firedAt = t
      break
    }
  }
  assert.equal(firedAt, T - 900, 'an awakening halfway through the window must be caught at once')
})

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

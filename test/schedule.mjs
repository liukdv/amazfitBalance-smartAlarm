// Tests for the real alarm's timing. If this is wrong, nobody wakes up.
import assert from 'node:assert/strict'
import { nextOccurrence, nextDelay, fmtTime, TICK_IN_WINDOW, TICK_FAR } from '../probe/utils/schedule.js'

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

const at = (y, mo, d, h, mi) => Math.floor(new Date(y, mo - 1, d, h, mi, 0, 0).getTime() / 1000)
const hourOf = (u) => new Date(u * 1000).getHours()
const dayOf = (u) => new Date(u * 1000).getDate()

console.log('\n== next occurrence of the time ==')

test('a time later today: stays today', () => {
  const now = at(2026, 8, 11, 6, 0)
  const t = nextOccurrence(now, 7, 30)
  assert.equal(hourOf(t), 7)
  assert.equal(dayOf(t), 11)
})

test('a time already past: goes to tomorrow (the 23:50 case)', () => {
  const now = at(2026, 8, 10, 23, 50)
  const t = nextOccurrence(now, 7, 30)
  assert.equal(hourOf(t), 7)
  assert.equal(dayOf(t), 11, 'it should have been tomorrow, not this morning')
})

test('midnight chosen at 23:50: it is 10 minutes away', () => {
  const now = at(2026, 8, 10, 23, 50)
  const t = nextOccurrence(now, 0, 0)
  assert.equal(t - now, 600)
})

test('the exact same time: it means tomorrow, not right now', () => {
  const now = at(2026, 8, 11, 7, 30)
  const t = nextOccurrence(now, 7, 30)
  assert.equal(t - now, 24 * 3600)
})

test('across a month boundary', () => {
  const now = at(2026, 8, 31, 23, 0)
  const t = nextOccurrence(now, 7, 0)
  assert.equal(dayOf(t), 1)
})

console.log('\n== wake-up step: battery against reliability ==')

const TARGET = at(2026, 8, 11, 7, 30)
const WIN = 30 * 60

test('inside the window: one minute', () => {
  assert.equal(nextDelay(TARGET - 600, TARGET, WIN), TICK_IN_WINDOW)
})

test('exactly when the window opens: one minute', () => {
  assert.equal(nextDelay(TARGET - WIN, TARGET, WIN), TICK_IN_WINDOW)
})

test('in the middle of the night: a long step, not one minute', () => {
  assert.equal(nextDelay(TARGET - 5 * 3600, TARGET, WIN), TICK_FAR)
})

test('never a single jump all the way to the target', () => {
  const d = nextDelay(TARGET - 8 * 3600, TARGET, WIN)
  assert.ok(d <= TICK_FAR, 'a single alarm 8 hours out: if it is dropped, no alarm at all')
})

test('shortly before the window: it lands exactly on the opening', () => {
  const now = TARGET - WIN - 400
  const d = nextDelay(now, TARGET, WIN)
  assert.equal(now + d, TARGET - WIN, 'the wake-up must land on the opening')
})

test('never a delay that is too short (waste, and risk of being dropped)', () => {
  for (let s = 1; s <= 40; s++) {
    const now = TARGET - WIN - s
    assert.ok(nextDelay(now, TARGET, WIN) >= 30, 'delay too short at -' + s + 's')
  }
})

console.log('\n== a whole night, simulated wake-up by wake-up ==')

test('8 hours of sleep: few wake-ups outside, one a minute inside', () => {
  const start = TARGET - 8 * 3600
  let now = start
  let outside = 0
  let inside = 0
  let guard = 0
  while (now < TARGET && guard++ < 2000) {
    const d = nextDelay(now, TARGET, WIN)
    if (now >= TARGET - WIN) inside++
    else outside++
    now += d
  }
  assert.ok(guard < 2000, 'the chain does not converge on the target')
  assert.ok(outside <= 20, 'too many night wake-ups: ' + outside + ' (battery)')
  assert.ok(inside >= 25 && inside <= 32, 'wake-ups inside the window: ' + inside)
  assert.ok(outside + inside < 60, 'total wake-ups in one night: ' + (outside + inside))
})

test('a 5-minute window: the chain still reaches the target', () => {
  const w = 5 * 60
  let now = TARGET - 3 * 3600
  let n = 0
  while (now < TARGET && n++ < 500) now += nextDelay(now, TARGET, w)
  assert.ok(n < 500, 'does not converge')
  assert.ok(now >= TARGET - 60, 'it stops short of the target')
})

console.log('\n== formatting ==')

test('times with a leading zero', () => {
  assert.equal(fmtTime(7, 5), '07:05')
  assert.equal(fmtTime(0, 0), '00:00')
  assert.equal(fmtTime(23, 55), '23:55')
})

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

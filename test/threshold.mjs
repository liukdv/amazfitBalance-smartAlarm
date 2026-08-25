// Tests for the THRESHOLD CURVE: the number to beat drops as the alarm time
// approaches. Numbers tuned on the logs of the first real nights. Pure logic,
// testable without a watch.
import assert from 'node:assert/strict'
import { peakThreshold, meanThreshold, describeCurve } from '../probe/utils/threshold.js'

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

const min = (m) => m * 60

console.log('\n== the curve drops as the alarm time approaches ==')

test('from 30 to 20 minutes: only a SIGNIFICANT movement (500)', () => {
  assert.equal(peakThreshold(min(30)), 500)
  assert.equal(peakThreshold(min(21)), 500)
})

test('from 20 to 15 minutes: 300', () => {
  assert.equal(peakThreshold(min(20)), 300)
  assert.equal(peakThreshold(min(16)), 300)
})

test('from 15 to 10 minutes: 200', () => {
  assert.equal(peakThreshold(min(15)), 200)
  assert.equal(peakThreshold(min(11)), 200)
})

test('from 10 to 5 minutes: LIGHT movement (100)', () => {
  assert.equal(peakThreshold(min(10)), 100)
  assert.equal(peakThreshold(min(6)), 100)
})

test('from 5 to 3 minutes: 80', () => {
  assert.equal(peakThreshold(min(5)), 80)
  assert.equal(peakThreshold(min(4)), 80)
})

test('at 3 minutes 60, at 2 minutes 40: the final descent', () => {
  assert.equal(peakThreshold(min(3)), 60)
  assert.equal(peakThreshold(150), 60)
  assert.equal(peakThreshold(min(2)), 40)
  assert.equal(peakThreshold(90), 40)
})

test('last minute: GRAVE level (20), almost anything goes', () => {
  assert.equal(peakThreshold(60), 20)
  assert.equal(peakThreshold(10), 20)
  assert.equal(peakThreshold(0), 20)
})

console.log('\n== the curve must never climb back up ==')

test('minute by minute, the threshold NEVER rises on the way to the alarm', () => {
  let previous = Infinity
  for (let s = min(35); s >= 0; s -= 10) {
    const now = peakThreshold(s)
    assert.ok(
      now <= previous,
      'at ' + s + 's the threshold went back UP from ' + previous + ' to ' + now
    )
    previous = now
  }
})

test('the same movement that is not enough early is enough late', () => {
  const movement = 150 // a real turn, just above "light"
  assert.ok(movement < peakThreshold(min(25)), 'at 25 min a movement like this must not be enough')
  assert.ok(movement > peakThreshold(min(4)), 'at 4 min the same movement must be enough')
})

console.log('\n== the MEAN: fixed at 50 in the last 10 minutes, half the peak before ==')

test('in the last 10 minutes the mean is ALWAYS 50, even as the peak drops', () => {
  ;[min(10), min(7), min(4), min(2), 60, 30, 0].forEach((s) => {
    assert.equal(meanThreshold(s), 50, 'at ' + s + 's the mean is not 50')
  })
})

test('the mean of 50 sits ABOVE the measured noise of a still body (9-22)', () => {
  // On 25 Aug at 08:59 the old rule (half the peak = 20) rang for nothing:
  // «mean 26 over 20». The measured noise floor reaches 22.
  assert.ok(meanThreshold(60) > 22, 'the last-minute mean is below the noise: it always rings')
})

test('beyond 10 minutes the mean stays at half the peak', () => {
  assert.equal(meanThreshold(min(15)), peakThreshold(min(15)) / 2)
  assert.equal(meanThreshold(min(25)), peakThreshold(min(25)) / 2)
})

console.log('\n== robustness: absurd values must not throw the guard wide open ==')

test('NEGATIVE seconds (time already past): the lowest threshold, not zero', () => {
  assert.equal(peakThreshold(-100), 20)
})

test('non-numeric values: it falls back to the lowest threshold, not to zero', () => {
  ;[null, undefined, NaN, Infinity, 'hello'].forEach((v) => {
    const s = peakThreshold(v)
    assert.ok(s > 0, 'with ' + String(v) + ' the threshold became ' + s + ': any noise would wake you')
    const m = meanThreshold(v)
    assert.ok(m > 0, 'with ' + String(v) + ' the mean threshold became ' + m)
  })
})

test('huge times: the highest threshold stays', () => {
  assert.equal(peakThreshold(min(600)), 500)
})

test('the curve can describe itself, so it can be found again in the logs', () => {
  const d = describeCurve()
  assert.match(d, /beyond:/)
  assert.match(d, /mean10m:/)
  assert.ok(d.length > 10)
})

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

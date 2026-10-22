// Window-dependent motion sensitivity and sensor continuity, without the watch runtime.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MotionDetector, motionThreshold, normalizeSensitivity } from '../probe/utils/threshold.js'

const STILL = [0, 0, 1000]
const TURN = [100, 0, Math.sqrt(1000000 - 10000)]
const sample = (detector, vector, time) => detector.sample(...vector, time)

test('presets require progressively less activity and invalid settings use normal', () => {
  assert.ok(motionThreshold('low') > motionThreshold('normal'))
  assert.ok(motionThreshold('normal') > motionThreshold('high'))
  for (const value of [null, undefined, NaN, Infinity, 20, 'bad', '__proto__']) {
    assert.equal(normalizeSensitivity(value), 'normal')
    assert.equal(motionThreshold(value), motionThreshold('normal'))
  }
})

test('each preset ramps gently across the configured window duration', () => {
  for (const [preset, start, middle, end] of [
    ['high', 30, 25, 20], ['normal', 60, 50, 40], ['low', 120, 100, 80],
  ]) {
    for (const window of [60, 600, 1800, 3600]) {
      assert.equal(motionThreshold(preset, window, window), start)
      assert.equal(motionThreshold(preset, window / 2, window), middle)
      assert.equal(motionThreshold(preset, 0, window), end)
      let previous = start
      for (let remaining = window; remaining >= 0; remaining -= window / 100) {
        const threshold = motionThreshold(preset, remaining, window)
        assert.ok(threshold <= previous && threshold >= end)
        previous = threshold
      }
    }
  }
})

test('the ramp stays bounded before the window and after the deadline', () => {
  assert.equal(motionThreshold('normal', 3600, 1800), 60)
  assert.equal(motionThreshold('normal', -60, 1800), 40)
})

test('missing or invalid timing falls back to the base preset', () => {
  for (const preset of ['low', 'normal', 'high']) {
    const base = motionThreshold(preset)
    for (const invalid of [undefined, null, NaN, Infinity, -Infinity, '60']) {
      assert.equal(motionThreshold(preset, invalid, 1800), base)
      assert.equal(motionThreshold(preset, 60, invalid), base)
    }
    assert.equal(motionThreshold(preset, 60, 0), base)
    assert.equal(motionThreshold(preset, 60, -1), base)
  }
})

test('the first sample seeds the detector and a constant offset is not movement', () => {
  const detector = new MotionDetector()
  assert.equal(sample(detector, [0, 0, 1300], 0), null)
  for (let time = 200; time <= 5000; time += 200) {
    const activity = sample(detector, [0, 0, 1300], time)
    assert.equal(activity.movement, 0)
    assert.equal(activity.wake, false)
  }
})

test('rotation with unchanged gravity magnitude is detected on every axis', () => {
  for (const turn of [TURN, [0, TURN[0], TURN[2]], [TURN[2], TURN[0], 0]]) {
    const detector = new MotionDetector()
    const rest = turn[2] === 0 ? [1000, 0, 0] : STILL
    sample(detector, rest, 0)
    for (let time = 200; time <= 1400; time += 200) {
      assert.equal(sample(detector, time % 400 ? turn : rest, time).wake, time === 1400)
    }
  }
})

test('one isolated spike and its quick return produce only one confirmation', () => {
  const detector = new MotionDetector()
  sample(detector, STILL, 0)
  assert.equal(sample(detector, [0, 0, 3000], 200).wake, false)
  assert.equal(sample(detector, STILL, 400).confirmations, 1)
  for (let time = 600; time < 5000; time += 200) {
    assert.equal(sample(detector, STILL, time).wake, false)
  }
})

test('small noise does not trigger even at the most sensitive end of the window', () => {
  const detector = new MotionDetector('high')
  detector.threshold = motionThreshold('high', 0, 1800)
  for (let time = 0; time < 180000; time += 200) {
    const activity = sample(detector, [time % 400 ? 10 : -10, 0, 1000], time)
    if (activity) assert.equal(activity.wake, false)
  }
})

test('confirmations slide across the old 15-reading reset boundary', () => {
  const detector = new MotionDetector()
  for (let time = 0; time <= 2400; time += 200) sample(detector, STILL, time)
  for (let time = 2600; time <= 3800; time += 200) {
    assert.equal(sample(detector, time % 400 ? TURN : STILL, time).wake, time === 3800)
  }
})

test('confirmations expire by elapsed time, even when sampling is slower', () => {
  const detector = new MotionDetector()
  sample(detector, STILL, 0)
  sample(detector, TURN, 200)
  sample(detector, STILL, 400)
  sample(detector, TURN, 800)
  sample(detector, STILL, 1000)
  sample(detector, STILL, 1800)
  sample(detector, STILL, 2600)
  const activity = sample(detector, TURN, 3200)
  assert.equal(activity.confirmations, 2, 'the 200 ms reading has expired')
  assert.equal(activity.wake, false)
})

test('invalid samples break continuity without creating a movement on recovery', () => {
  const invalid = [[0, 0, 0], [0, 0, 1], [0, 0, 16384],
    [NaN, 0, 1000], [0, Infinity, 1000], [0, 0, undefined],
    ['0', 0, 1000], [null, 0, 1000]]
  for (const vector of invalid) {
    const detector = new MotionDetector()
    sample(detector, STILL, 0)
    sample(detector, TURN, 200)
    sample(detector, STILL, 400)
    assert.equal(sample(detector, vector, 600), null)
    assert.equal(sample(detector, TURN, 800), null)
    assert.equal(sample(detector, STILL, 1000).confirmations, 1)
  }
})

test('a sensor gap does not join unrelated positions or old confirmations', () => {
  const detector = new MotionDetector()
  sample(detector, STILL, 0)
  sample(detector, TURN, 200)
  sample(detector, STILL, 400)
  assert.equal(sample(detector, TURN, 1600), null)
  assert.equal(sample(detector, STILL, 1800).confirmations, 1)
})

test('a clock correction discards previous confirmations', () => {
  const detector = new MotionDetector()
  sample(detector, STILL, 1000)
  sample(detector, TURN, 1200)
  sample(detector, STILL, 1400)
  assert.equal(sample(detector, TURN, 500), null)
  assert.equal(sample(detector, STILL, 700).confirmations, 1)
})

test('sensitivity changes whether the same small rotation is enough', () => {
  const turn = [40, 0, Math.sqrt(1000000 - 1600)]
  for (const sensitivity of ['low', 'normal', 'high']) {
    const detector = new MotionDetector(sensitivity)
    sample(detector, STILL, 0)
    for (let time = 200; time <= 1400; time += 200) {
      const activity = sample(detector, time % 400 ? turn : STILL, time)
      assert.equal(activity.wake, time === 1400 && sensitivity === 'high')
    }
  }
})

test('a strong 600 ms burst followed by rest cannot produce three confirmations', () => {
  const detector = new MotionDetector()
  sample(detector, STILL, 0)
  for (let time = 200; time <= 5000; time += 200) {
    const vector = time <= 600 && time % 400 ? [0, 0, 3000] : STILL
    assert.equal(sample(detector, vector, time).wake, false)
  }
})

test('smaller repeated 55 mg changes now qualify at normal sensitivity', () => {
  const detector = new MotionDetector()
  const turn = [55, 0, Math.sqrt(1000000 - 55 * 55)]
  sample(detector, STILL, 0)
  for (let time = 200; time <= 1400; time += 200) {
    const activity = sample(detector, time % 400 ? turn : STILL, time)
    assert.ok(activity.movement < 60, 'exercise motion below the former normal threshold')
    assert.equal(activity.wake, time === 1400)
  }
})

test('confirmation spacing is inclusive at 500 ms and cannot be bypassed by rapid samples', () => {
  const detector = new MotionDetector()
  sample(detector, STILL, 0)
  assert.equal(sample(detector, TURN, 100).confirmations, 1)
  assert.equal(sample(detector, STILL, 599).confirmations, 1)
  assert.equal(sample(detector, TURN, 600).confirmations, 2)
  assert.equal(sample(detector, STILL, 1099).confirmations, 2)
  assert.equal(sample(detector, TURN, 1100).wake, true)
})

test('isolated jerks more than three seconds apart never accumulate into a wake', () => {
  const detector = new MotionDetector()
  sample(detector, STILL, 0)
  for (let time = 200; time <= 20000; time += 200) {
    const vector = time % 4000 === 200 ? TURN : STILL
    assert.equal(sample(detector, vector, time).wake, false)
  }
})

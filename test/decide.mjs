// The service enforces time; only the foreground accelerometer can wake early.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide } from '../probe/utils/decide.js'

const targetUnix = 1800000000

for (const windowSec of [0, 60, 600, 1800, 3600]) {
  test('background decision respects a ' + windowSec + '-second window and its deadline', () => {
    const at = (nowUnix) => decide({ nowUnix, targetUnix, windowSec })
    assert.deepEqual(at(targetUnix - windowSec - 1), { fire: false, reason: 'outside window' })
    if (windowSec > 0) {
      assert.deepEqual(at(targetUnix - windowSec), { fire: false, reason: 'waiting for movement' })
      assert.equal(at(targetUnix - 1).fire, false)
    }
    assert.deepEqual(at(targetUnix), { fire: true, reason: 'deadline' })
    assert.deepEqual(at(targetUnix + 60), { fire: true, reason: 'deadline' })
  })
}

test('obsolete sleep and wear inputs cannot trigger a background wake before the deadline', () => {
  const result = decide({
    nowUnix: targetUnix - 60, targetUnix, windowSec: 1800,
    sleepingStatus: 0, wearStatus: 2, useStages: true,
    lastStageModel: 6, lastStageStop: targetUnix - 90, wakeableModels: [6],
  })
  assert.equal(result.fire, false)
})

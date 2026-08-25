// The alarm decision, isolated and dependency-free: it is the heart of the
// project and it must be testable without a watch.
//
// ⭐ MOVEMENT VERSION (23 Aug 2026). The heart is no longer the sleep stages:
// it is WRIST MOVEMENT, like every smart alarm that actually works (Sleep as
// Android says so in writing, Sleep Cycle derives it from the microphone, Fitbit
// only computes stages at the morning sync). Stages read in real time are
// unusable for a structural reason: the staging algorithm classifies a minute
// using the 2 FOLLOWING minutes as well, so the stretch in progress always stays
// marked "light" and gets rewritten afterwards.
//
// The rule, in priority order:
//  1. At the deadline (or past it) → ALWAYS ring. An alarm that does not go off
//     is a worse defect than an imprecise one.
//  2. Outside the window → never.
//  3. Inside the window, AWAKE → ring (unless the lookout is on; see below).
//  4. Inside the window, WRIST MOVING → ring. That is the moment you are already
//     turning over: waking you there costs less than tearing you out of stillness.
//  5. Inside the window, if useStages is on, the old sleep-stage route.
//     Off by default: kept so it can be switched back on from the debug page.
//  6. Otherwise wait for the next tick.
//
// The stage codes are NOT hardcoded here: they come from outside (wakeableModels),
// read from the device with getStageConstantObj(). In the field a model=4 showed
// up that the old fixed 0..3 map did not foresee: guessing the codes means
// risking a ring in deep sleep. Without reliable codes the stage route stays off
// and the alarm rings at the deadline, like an ordinary one.

/**
 * @param {object} s state read from the watch
 *   nowUnix        seconds
 *   targetUnix     the alarm deadline
 *   windowSec      width of the window
 *   sleepingStatus 0 awake / 1 asleep / null unknown
 *   wearStatus     0 not worn / 1 still on the wrist / 2 MOVING / 3 uncertain
 *   lookoutActive  true = the lookout (accelerometer) decides; here we only act as a net
 *   useStages      true = re-enables the old sleep-stage route (default: off)
 *   lastStageModel stage code of the last classified phase
 *   lastStageStop  end of the last phase (unix), to measure its freshness
 *   wakeableModels stage codes on which waking up is allowed (from the device)
 *   maxStaleSec    past this age the classification is no longer trustworthy
 */
export function decide(s) {
  const {
    nowUnix,
    targetUnix,
    windowSec,
    sleepingStatus,
    wearStatus,
    lookoutActive = false,
    useStages = false,
    lastStageModel,
    lastStageStop,
    wakeableModels,
    maxStaleSec = 600,
  } = s

  if (nowUnix >= targetUnix) {
    return { fire: true, reason: 'deadline' }
  }

  const windowOpensAt = targetUnix - windowSec
  if (nowUnix < windowOpensAt) {
    return { fire: false, reason: 'outside window' }
  }

  // While the lookout is listening there is exactly ONE decider: the lookout,
  // which owns the accelerometer. We no longer look at "is he awake?" here,
  // because during the day that value is always 0 and would ring instantly —
  // making it impossible to test the real alarm with a short window. The service
  // stays the safety net: at the deadline (rule 1) it rings anyway.
  if (sleepingStatus === 0 && !lookoutActive) {
    return { fire: true, reason: 'awake inside window' }
  }

  // Movement as seen by the SERVICE (one bit, one sample per minute). It only
  // counts while the lookout is not listening: with the lookout on there must be
  // a single decider, otherwise an early-trigger path stays open that the
  // 23 Aug design wanted closed (review, finding 9).
  if (wearStatus === 2 && !lookoutActive) {
    return { fire: true, reason: 'wrist movement' }
  }

  // ── From here down: the OLD stage route. Off by default since 23 Aug 2026
  // (see the file header), kept because the idea of going back to it — or of
  // trying to predict the cycles — is still open.
  if (!useStages) {
    return { fire: false, reason: 'still, waiting for movement' }
  }

  const hasStage = lastStageModel !== null && lastStageModel !== undefined && lastStageModel !== ''
  if (!hasStage) {
    return { fire: false, reason: 'no stage available' }
  }

  const age = lastStageStop ? nowUnix - lastStageStop : null
  if (age === null || age > maxStaleSec) {
    // Classification too old to trust: better not to wake him out of deep sleep
    // on the strength of a reading from half an hour ago.
    return { fire: false, reason: 'stage too old (' + (age === null ? 'unknown age' : age + 's') + ')' }
  }

  const models = Array.isArray(wakeableModels) ? wakeableModels : []
  if (!models.length) {
    return { fire: false, reason: 'unknown stage codes, waiting for the deadline' }
  }

  const stage = Number(lastStageModel)
  if (models.indexOf(stage) >= 0) {
    return { fire: true, reason: 'favourable stage (' + stage + ')' }
  }

  return { fire: false, reason: 'unfavourable stage (' + stage + ')' }
}

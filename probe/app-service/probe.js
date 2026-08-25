// Background service. Woken by the Alarm API once a minute: it samples, decides,
// and reschedules its own next wake-up.
//
// Every step writes to the event diary. That is deliberate: if this service does
// not start, the only way to know is the ABSENCE of its lines; if it starts and
// fails, the reason has to be written down somewhere, because there is no
// console on a watch and nobody is watching while it happens.
//
// Every run must fit within ~600ms: nothing slow in here.
// Note: alarm.set() uses file/date as in the official CLI template, not
// url/delay as in the online documentation.
import * as alarmMgr from '@zos/alarm'
import { getPackageInfo } from '@zos/app'
import { appendLine, logEvent } from '../utils/log'
import { takeSample, readState, wakeableModels } from '../utils/sample'
import { load, patch } from '../utils/store'
import { decide } from '../utils/decide'
import { nextDelay } from '../utils/schedule'
import { wakeBuzz } from '../utils/vibrate'

const SERVICE_FILE = 'app-service/probe'
const RING_PAGE = 'page/ring'
const MAX_RINGS = 3 // the alarm insists: 3 rings one minute apart, then it gives up
const RING_GAP_MIN_SEC = 45 // two rings are never closer than this (chain + failsafe together)

// The "night log" flag (store.debugLog): once stable, the deep log can be turned
// off. ESSENTIAL events (vibrations, errors) are written regardless.
let DBG = true
function dbgEvent(tag, data) {
  if (DBG) logEvent(tag, data)
}

// The time is computed in seconds from Date.now(), not by building a Date
// object: it is verifiable arithmetic, and in the tests time can really be
// advanced.
function scheduleNext(delaySec) {
  const { appId } = getPackageInfo()
  const at = Math.floor(Date.now() / 1000) + (delaySec || 60)
  const id = alarmMgr.set({
    appid: appId,
    file: SERVICE_FILE,
    date: at,
    param: 'tick',
    repeat_type: alarmMgr.ONCE,
    store: true,
  })
  // Check that the alarm is REALLY queued: set() can return an id and the system
  // discard it anyway. Without this check the chain dies silently and it looks
  // like the service never started.
  let queued = 'n/a'
  try {
    queued = alarmMgr.getAllAlarms ? JSON.stringify(alarmMgr.getAllAlarms()) : 'n/a'
  } catch (e) {}
  dbgEvent('SVC rescheduled', { id, at, in: delaySec, queued })
  return id
}

// The service process can be killed as soon as onInit returns, and the
// vibrator's start() is asynchronous: a concrete suspicion (night of 11 Aug:
// "VIBRATION ok" in the log but the wearer, awake, felt nothing with the app
// closed) that the motor does not get time to spin up. We keep the process alive
// for ~350ms. Double limit, time plus iterations: in the tests the clock is
// frozen and time alone would never break the loop.
function holdAlive(ms) {
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < ms && i < 5000000) i++
  return Date.now() - t0
}

// ⭐ THE HEART OF THE 22 AUG EVENING VERSION.
// The service no longer rings by itself: it opens the ring page with an alarm
// that targets a PAGE (`url:`) instead of a service (`file:`). Reason: the diary
// of 22 Aug shows two "VIBRATION ok" entries commanded by the service (19:29:15
// and 19:30:17) that the motor ignored — in the background the vibrator does not
// respond. In the foreground it works, tried several times.
// The direct vibration is attempted anyway: if one day it works, it is a bonus.
function openRingPage(why) {
  let id = null
  try {
    const { appId } = getPackageInfo()
    // +15 and not +2: Date.now() here is FROZEN at the instant the process woke
    // up, but the logs written before reaching this point cost real seconds
    // (ticks measured up to 9s on 22 Aug). With +2 the alarm could be born
    // already in the past and the firmware might discard it (23 Aug review,
    // finding 2).
    id = alarmMgr.set({
      appid: appId,
      url: RING_PAGE,
      date: Math.floor(Date.now() / 1000) + 15,
      param: 'ring',
      repeat_type: alarmMgr.ONCE,
      store: true,
    })
  } catch (e) {
    try {
      logEvent('SVC page open ERROR', String(e && e.message))
    } catch (e2) {}
  }
  try {
    logEvent('SVC opens ring page', { id, why })
  } catch (e) {}
  return id
}

function ring(st, nowUnix, why) {
  const pageId = openRingPage(why)
  let res = 'err'
  try {
    res = wakeBuzz()
  } catch (e) {
    res = 'err:' + (e && e.message)
  }
  let held = 0
  try {
    held = holdAlive(350)
  } catch (e) {}
  try {
    logEvent('SVC VIBRATION', { res, why, round: (st.rings || 0) + 1, held_ms: held, page: pageId })
  } catch (e) {}
  return res
}

AppService({
  onInit(params) {
    let st
    try {
      st = load()
    } catch (e) {
      st = { mode: 'idle' }
      try {
        logEvent('SVC state ERROR', String(e && e.message))
      } catch (e2) {}
    }
    DBG = !st || st.debugLog !== 0

    try {
      dbgEvent('SVC awake', { param: params === undefined ? null : String(params) })
      dbgEvent('SVC state', { mode: st.mode, ticks: st.ticks, max: st.maxTicks, target: st.targetUnix, rings: st.rings })
    } catch (e) {}

    if (st.mode === 'idle') {
      // THE FAILSAFE RULE: a 'failsafe' alarm that arrives alive means nobody
      // cancelled it (STOP cancels everything). If the state says "closed" but
      // no ring happened at or after the deadline, something went wrong — the
      // ringing sequence ran out early and the sleeper dozed off again, or a
      // corrupted state was re-read as DEFAULTS — and an ordinary alarm would
      // have rung anyway: so we ring. (22 Aug review, findings 2 and 3.)
      const rangAtTarget = (st.targetUnix || 0) > 0 && (st.lastRingUnix || 0) >= st.targetUnix
      if (params === 'failsafe' && !rangAtTarget) {
        const nowU = Math.floor(Date.now() / 1000)
        try {
          logEvent('SVC FAILSAFE rings: state closed without a ring at the deadline', {
            target: st.targetUnix,
            lastRing: st.lastRingUnix,
            done: st.done,
          })
        } catch (e) {}
        ring(st, nowU, 'failsafe')
        try {
          patch({
            mode: 'ringing',
            rings: 1,
            fired: (st.fired || 0) + 1,
            lastRingUnix: nowU,
            done: 0,
            lastReason: 'failsafe_rang',
          })
        } catch (e) {}
        try {
          scheduleNext(60)
        } catch (e) {}
        return
      }
      try {
        dbgEvent('SVC idle, chain closed')
        if (DBG) appendLine(takeSample('idle_stop'))
      } catch (e) {}
      return
    }

    const nowUnix = Math.floor(Date.now() / 1000)
    let note = params === 'first' ? 'start_' + st.mode : st.mode
    if (params === 'failsafe') note += '|failsafe'
    let fired = false
    let finished = false

    // RINGING MODE: the decision has already been taken, we insist until STOP is
    // pressed or the rounds run out. An ordinary alarm does not stop after a
    // single buzz — neither does this one.
    if (st.mode === 'ringing') {
      // STOP pressed on the ring page: the ringing is over, we leave.
      if (st.ringStop === 1) {
        try {
          logEvent('SVC ringing already stopped by the user')
          patch({ mode: 'idle', done: 1 })
        } catch (e) {}
        return
      }
      const gap = nowUnix - (st.lastRingUnix || 0)
      if (gap >= RING_GAP_MIN_SEC) {
        ring(st, nowUnix, 'insisting')
        fired = true
      } else {
        note += '|ring too close - skipped'
      }
      const rings = (st.rings || 0) + (fired ? 1 : 0)
      finished = rings >= MAX_RINGS
      try {
        if (DBG) appendLine(takeSample(note + '|ring' + rings))
      } catch (e) {}
      // STOP pressed DURING this tick: do not resurrect the ringing and do not
      // reschedule (22 Aug review, finding 5).
      try {
        if (load().mode === 'idle') {
          logEvent('SVC STOP during the tick, standing down')
          return
        }
      } catch (e) {}
      try {
        patch({
          ticks: (st.ticks || 0) + 1,
          rings,
          fired: fired ? (st.fired || 0) + 1 : st.fired || 0,
          lastRingUnix: fired ? nowUnix : st.lastRingUnix || 0,
          lastReason: note,
          mode: finished ? 'idle' : 'ringing',
          done: finished ? 1 : 0,
        })
      } catch (e) {}
      if (finished) {
        try {
          logEvent('SVC ringing finished', { rings })
        } catch (e) {}
        return
      }
      try {
        scheduleNext(60)
      } catch (e) {
        try {
          logEvent('SVC reschedule ERROR', String(e && e.message))
        } catch (e2) {}
      }
      return
    }

    if (st.mode === 'alarm') {
      let raw = null
      try {
        raw = readState()
        dbgEvent('SVC reading', raw)
      } catch (e) {
        try {
          logEvent('SVC reading ERROR', String(e && e.message))
        } catch (e2) {}
      }

      // ⚠️ The decision is ALWAYS taken, even if the sensors do not answer.
      // With a null `raw` we pass empty values: decide() ignores the stages and
      // fires the alarm at the deadline anyway. It used to skip the decision
      // entirely when the reading failed — and in that case the alarm would
      // NEVER have gone off. It is the kind of defect you do not notice until it
      // happens, at night, once.
      const safe = raw || { sleepingStatus: null, wearStatus: null, lastStageModel: null, lastStageStop: null }
      if (!raw) note += '|reading failed'

      let models = []
      try {
        models = wakeableModels()
      } catch (e) {}

      let d
      try {
        d = decide({
          nowUnix,
          targetUnix: st.targetUnix,
          windowSec: st.windowSec,
          sleepingStatus: safe.sleepingStatus,
          wearStatus: safe.wearStatus,
          lookoutActive: st.useLookout !== 0,
          useStages: st.useStages === 1,
          lastStageModel: safe.lastStageModel,
          lastStageStop: safe.lastStageStop,
          wakeableModels: models,
        })
      } catch (e) {
        // Even if the decision blows up: past the deadline we ring.
        d = { fire: nowUnix >= st.targetUnix, reason: 'decide ERROR ' + (e && e.message) }
      }

      try {
        dbgEvent('SVC decision', { fire: d.fire, reason: d.reason, left: st.targetUnix - nowUnix, models })
      } catch (e) {}
      note += '|' + String(d.reason).replace(/[,|]/g, ' ')

      if (d.fire) {
        const res = ring(st, nowUnix, d.reason)
        note += '|BUZZ:' + res
        fired = true
      }
    }

    const ticks = (st.ticks || 0) + 1
    const limited = st.mode === 'monitor' && st.maxTicks > 0
    finished = limited && ticks >= st.maxTicks
    if (finished) note += '|monitor_done'

    try {
      if (DBG) appendLine(takeSample(note))
    } catch (e) {
      try {
        logEvent('SVC sample write ERROR', String(e && e.message))
      } catch (e2) {}
    }

    // STOP pressed DURING this tick: do not rewrite the state and do not
    // reschedule (22 Aug review, finding 5).
    try {
      if (load().mode === 'idle' && st.mode !== 'idle') {
        logEvent('SVC STOP during the tick, standing down')
        return
      }
    } catch (e) {}

    try {
      patch({
        ticks,
        lastReason: note,
        fired: fired ? (st.fired || 0) + 1 : st.fired || 0,
        rings: fired ? 1 : st.rings || 0,
        lastRingUnix: fired ? nowUnix : st.lastRingUnix || 0,
        // After the first ring we do NOT close any more: we switch to ringing
        // mode and insist. The chain only closes at the end of monitoring or at
        // the end of the ringing sequence.
        mode: fired ? 'ringing' : finished ? 'idle' : st.mode,
        done: finished ? 1 : st.done || 0,
      })
    } catch (e) {}

    if (finished) {
      try {
        logEvent('SVC end', { fired, finished, ticks })
      } catch (e) {}
      return
    }

    // Long step far from the window, one minute inside it: there is no need to
    // wake up 480 times a night, but the chain must keep re-arming itself.
    let delay = 60
    if (!fired && st.mode === 'alarm' && st.targetUnix) {
      try {
        delay = nextDelay(nowUnix, st.targetUnix, st.windowSec)
      } catch (e) {}
    }

    try {
      scheduleNext(delay)
    } catch (e) {
      try {
        logEvent('SVC reschedule ERROR', String(e && e.message))
        appendLine(takeSample('realarm_err'))
      } catch (e2) {}
    }
  },

  onDestroy() {},
})

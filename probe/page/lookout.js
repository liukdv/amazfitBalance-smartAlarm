// THE LOOKOUT — the idea that made the project work, 23 Aug 2026.
//
// The problem: the accelerometer (the only sensor that really feels movement) is
// forbidden to background services, and `Wear.getStatus()` on this watch NEVER
// switches to "moving" (tried: 161 readings with the arm shaking, always
// "still"). So in the background we are blind.
//
// The solution: we do not need to see all night — we need to see during the good
// HALF HOUR. When the window opens the system opens THIS page by itself; it sits
// in the foreground with an almost black screen and one minimal line of text,
// and there the accelerometer works: the wrist is sensed 5 times a second
// instead of once every 30 seconds. At the first real movement it hands over to
// the ring page.
//
// Real measurements from 23 Aug (test bench): with a still wrist the magnitude
// is ~1000 (that is gravity: the unit is thousandths of g), shaking the arm the
// peak reached 2765. The threshold therefore works on the DEVIATION from
// gravity.
//
// If this page were to die — screen switched off by the firmware, app closed by
// hand — nothing is lost: the service chain and the two failsafes stay armed,
// and at the deadline the alarm rings anyway.
import * as hmUI from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'
import { replace, push } from '@zos/router'
import { Accelerometer } from '@zos/sensor'
import { getDeviceInfo } from '@zos/device'
import {
  setPageBrightTime,
  resetPageBrightTime,
  setBrightness,
  getBrightness,
  pauseDropWristScreenOff,
} from '@zos/display'
import { home } from '@zos/router'
import { logEvent } from '../utils/log'
import { load, patch } from '../utils/store'
import { readState } from '../utils/sample'
import { peakThreshold, meanThreshold, describeCurve } from '../utils/threshold'

const RING_PAGE = 'page/ring'
const PERIOD_MS = 200 // 5 readings per second
const GRAVITY = 1000 // thousandths of g: what the accelerometer reads at rest

// ⛔ THE THRESHOLDS LIVE IN THE CODE (utils/threshold.js), NOT in the saved state.
// Discovered in the field on 23 Aug: state.json survives app updates and
// `load()` does {...DEFAULTS, ...saved}, so the OLD value always beats the new
// default — the code said 200 and the watch was using 250, silently. A design
// decision does not travel through a file: it lives in the code and changes with
// the code.

// THE TWO-MINUTE MEAN, kept in 10-second buckets instead of sample by sample:
// twelve numbers instead of six hundred, and the arithmetic stays exact.
const BUCKET_MS = 10000
const BUCKETS = 12 // 12 × 10s = 120s
// With less than a minute of data the mean is not reliable (few samples, a
// single movement inflates it): until there is enough history, only the peak
// decides.
//
// ⚠️ 100, not 250 (23 Aug review, F2). The window is 120 seconds, so it can hold
// at most 120 × frequency samples: with 250 the mean criterion only existed
// above 2.08 readings per second, and if the firmware slowed the timer down it
// would have SWITCHED ITSELF OFF SILENTLY — in the diary `mean2m` would have
// come out empty, indistinguishable from "there was no data".
const MIN_SAMPLES_MEAN = 100
const MIN_BUCKETS_MEAN = 6 // ...and at least a minute's worth of genuinely filled buckets

// How many consecutive non-'alarm' readings it takes to believe the alarm has
// been switched off (23 Aug review, F1). One is not enough: `load()` returns the
// default values — that is, "off" — on ANY read hiccup, and the file is rewritten
// by the service every minute from another process. A single coincidence out of
// thousands of readings switched the smart wake off for the rest of the night,
// silently.
const OFF_CONFIRMATIONS = 3
// And the state is not re-read five times a second: every 5 seconds is plenty
// (review F5: 9000 reads per window, each one rebuilding the file character by
// character — battery drain and timer jitter, which is exactly what fed F2).
const STATE_CHECK_EVERY_TICKS = 25
// Three samples above the threshold within three seconds. A deliberate choice:
// high threshold and strict confirmations, because the window lasts 30 minutes
// and there is plenty of time for a real movement to happen. Better to wait for
// the next one than to wake someone for a tremor.
const CONFIRMATIONS = 3
const CONFIRMATION_WINDOW = 15 // ...within 3 seconds (15 samples)

function screen() {
  try {
    const info = getDeviceInfo()
    if (info && info.width) return { w: info.width, h: info.height }
  } catch (e) {}
  return { w: 466, h: 466 }
}

let timerId = null
let acc = null
let accOn = false
let statusText = null
let line = null

let samples = 0
let aboveThreshold = 0 // confirmations inside the sliding window
let sinceLastReset = 0
let peakDeviation = 0
let sumDeviation = 0
let samplesThisMinute = 0
let peakThisMinute = 0
let aboveThisMinute = 0 // how many readings passed the threshold this minute
let nearThisMinute = 0 // ...and how many passed HALF the threshold: tells us how close we are
let lastLoggedMinute = 0
let openedAt = 0 // unix time when the page opened
let finished = false
// Brightness is a SYSTEM setting: if you lower it and do not put it back the way
// it was, the watch stays like that all day (23 Aug review). We note the value we
// found and always give that one back.
let originalBrightness = null

// The buckets of the sliding mean: sum and number of readings for each.
let bSum = []
let bCount = []
let bIdx = 0
let bEnd = 0

function resetBuckets(now) {
  bSum = []
  bCount = []
  for (let i = 0; i < BUCKETS; i++) {
    bSum.push(0)
    bCount.push(0)
  }
  bIdx = 0
  bEnd = now + BUCKET_MS
}

// Adds a reading, sliding the buckets along as time passes.
function addToMean(deviation, now) {
  let rounds = 0
  while (now >= bEnd && rounds < BUCKETS * 2) {
    bIdx = (bIdx + 1) % BUCKETS
    bSum[bIdx] = 0
    bCount[bIdx] = 0
    bEnd += BUCKET_MS
    rounds++
  }
  bSum[bIdx] += deviation
  bCount[bIdx] += 1
}

// The mean over the last two minutes, or null if the history is still too short.
function twoMinuteMean() {
  let sum = 0
  let count = 0
  let filled = 0
  for (let i = 0; i < BUCKETS; i++) {
    sum += bSum[i]
    count += bCount[i]
    if (bCount[i] > 0) filled++
  }
  // Two guards instead of one: enough readings AND enough buckets covered. The
  // second one is what matters if the timer slows down: few samples spread over
  // a real minute make an honest mean, many samples all in the last ten seconds
  // do not.
  if (count < MIN_SAMPLES_MEAN || filled < MIN_BUCKETS_MEAN) return null
  return sum / count
}

function dimScreen(level) {
  try {
    if (originalBrightness === null && typeof getBrightness === 'function') {
      const v = getBrightness()
      if (typeof v === 'number' && v > 0) originalBrightness = v
    }
  } catch (e) {}
  try {
    setBrightness({ level: level })
  } catch (e) {}
}

// To be called on EVERY exit, including the ones caused by errors: screen handed
// back to the system and brightness restored to what it was.
function releaseScreen() {
  try {
    setBrightness({ level: originalBrightness === null ? 100 : originalBrightness })
  } catch (e) {}
  try {
    resetPageBrightTime()
  } catch (e) {}
}

function magnitude(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z)
}

Page(
  BasePage({
    build() {
      const { w, h } = screen()
      samples = 0
      aboveThreshold = 0
      sinceLastReset = 0
      peakDeviation = 0
      sumDeviation = 0
      samplesThisMinute = 0
      peakThisMinute = 0
      lastLoggedMinute = 0
      aboveThisMinute = 0
      nearThisMinute = 0
      finished = false
      // ⚠️ A timer from a previous life must be killed HERE (23 Aug review, F6):
      // if the page were built twice without a close in between, the first timer
      // would keep running out of reach — double readings, battery drain, and
      // skewed per-minute counters.
      try {
        if (timerId !== null) clearInterval(timerId)
      } catch (e) {}
      timerId = null
      // ⚠️ This has to be reset too: if `start()` fails, `accOn` would keep the
      // value from a previous open and the page would believe it has the sensor,
      // sampling nothing with the screen on. Found by the tests while fixing F6.
      accOn = false
      // Re-read on every open: the system brightness may have been changed in
      // the meantime, and giving back a stale value would be worse than not
      // giving anything back at all.
      originalBrightness = null
      openedAt = Math.floor(Date.now() / 1000)

      const st = load()
      this.target = st.targetUnix || 0
      // Two outfits for the same page: the night one must not be seen, the test
      // one must. It is the same code: only the colours and the brightness
      // change, so what you test is what really runs.
      this.visible = st.lookoutVisible === 1

      // Screen on but as discreet as possible: black background, brightness at
      // minimum, and no switch-off when the wrist drops. It must be able to stay
      // on for half an hour next to a sleeping person without lighting the room.
      // ⚠️ The target must exist: without it, this page would sample forever with
      // the screen on (23 Aug review, finding 6).
      if (!this.target) {
        try {
          logEvent('LOOKOUT no target, leaving', {})
        } catch (e) {}
        finished = true
        releaseScreen()
        try {
          home()
        } catch (e) {}
        return
      }

      try {
        setPageBrightTime({ brightTime: 3600000 })
      } catch (e) {}
      dimScreen(this.visible ? 60 : 1)
      try {
        pauseDropWristScreenOff({ duration: 0 })
      } catch (e) {}

      try {
        hmUI.createWidget(hmUI.widget.FILL_RECT, {
          x: 0, y: 0, w: w, h: h, color: 0x000000,
        })
      } catch (e) {}

      try {
        statusText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 0, y: Math.round(h * 0.38), w: w, h: 34,
          color: this.visible ? 0x66ff99 : 0x252525,
          text_size: this.visible ? 20 : 15,
          align_h: hmUI.align.CENTER_H,
          text: this.visible ? 'TEST RUNNING' : 'alarm listening',
        })
      } catch (e) {}

      try {
        // ⚠️ Three lines need room: with h:70 and text at 24 the third one (the
        // mean) was CUT OFF and only one number was visible — seen on the device
        // on 23 Aug. 3 × 24 = 72 px did not fit in 70.
        line = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 0, y: Math.round(h * 0.47), w: w, h: 110,
          color: this.visible ? 0xffffff : 0x1a1a1a,
          text_size: this.visible ? 20 : 12,
          align_h: hmUI.align.CENTER_H,
          text_style: hmUI.text_style.WRAP, text: '',
        })
      } catch (e) {}

      try {
        acc = new Accelerometer()
        if (typeof acc.start === 'function') {
          acc.start()
          accOn = true
        }
      } catch (e) {
        try {
          logEvent('LOOKOUT accelerometer will NOT start', String(e && e.message))
        } catch (e2) {}
      }

      resetBuckets(Date.now())

      try {
        logEvent('LOOKOUT opened', { target: this.target, curve: describeCurve(), accOn })
      } catch (e) {}

      // If the accelerometer does not start, this page is useless: it gets out of
      // the way and lets the service work, which is already armed.
      // ⚠️ Releasing the screen first: otherwise it would stay on for an hour at
      // brightness 1, and nobody would ever put it right again because there is
      // no live timer left (23 Aug review, finding 4).
      if (!accOn) {
        try {
          if (statusText) statusText.setProperty(hmUI.prop.TEXT, 'sensor unavailable')
        } catch (e) {}
        finished = true
        releaseScreen()
        try {
          home()
        } catch (e) {}
        return
      }

      try {
        timerId = setInterval(() => {
          try {
            this.read()
          } catch (e) {}
        }, PERIOD_MS)
      } catch (e) {
        try {
          logEvent('LOOKOUT timer ERROR', String(e && e.message))
        } catch (e2) {}
      }
    },

    read() {
      if (finished) return
      const nowUnix = Math.floor(Date.now() / 1000)

      // The deadline beats everything, here too: if the moment has come, we ring
      // without waiting for any movement.
      if (this.target && nowUnix >= this.target) {
        this.wake('deadline')
        return
      }

      // STOP pressed elsewhere, or the alarm disarmed: the lookout has no reason
      // to stay on any more.
      //
      // ⚠️ But we do not trust ONE reading (23 Aug review, F1): `load()` returns
      // the default values — that is, "off" — merely because the file was
      // momentarily unreadable, and the service rewrites it every minute from
      // another process (two writes in a row, and in between the file is
      // inconsistent). A single coincidence out of thousands of readings switched
      // the smart wake off for the whole night, without a trace. So: we check
      // every 5 seconds, and it takes three confirmations in a row.
      this.tick = (this.tick || 0) + 1
      if (this.tick % STATE_CHECK_EVERY_TICKS === 0) {
        let off = false
        try {
          off = load().mode !== 'alarm'
        } catch (e) {
          off = false // could not read it: that proves nothing
        }
        this.offInARow = off ? (this.offInARow || 0) + 1 : 0
        if (this.offInARow >= OFF_CONFIRMATIONS) {
          this.close('alarm no longer armed')
          return
        }
      }

      let x = null, y = null, z = null
      try {
        if (typeof acc.getCurrent === 'function') {
          const c = acc.getCurrent()
          if (c) {
            x = c.x
            y = c.y
            z = c.z
          }
        }
        if (x === null && typeof acc.getX === 'function') {
          x = acc.getX()
          y = acc.getY()
          z = acc.getZ()
        }
      } catch (e) {}

      if (x === null || x === undefined) return

      // ⛔ PLAUSIBILITY GUARD (23 Aug review, finding 1 — it was the most
      // dangerous bug in the project). A still wrist reads ~1000: gravity is
      // always there. If (0,0,0) arrives — the first samples after start(), the
      // sensor not yet warm — the deviation comes out as 1000, that is FIVE TIMES
      // the threshold: three readings like that, 600 milliseconds, and the alarm
      // went off half an hour early believing it had seen movement. The same goes
      // for a different scale (values in g, or raw ADC): outside this range the
      // data cannot be interpreted, so it is discarded rather than guessed at.
      const mag = magnitude(x, y, z)
      if (mag < 300 || mag > 8000) return

      samples++
      samplesThisMinute++
      const deviation = Math.abs(mag - GRAVITY)
      if (deviation > peakDeviation) peakDeviation = deviation
      if (deviation > peakThisMinute) peakThisMinute = deviation
      sumDeviation += deviation
      addToMean(deviation, Date.now())

      // ⭐ THE THRESHOLD RIGHT NOW: it drops as the alarm time approaches. The
      // tighter the time, the less picky we can afford to be.
      const secondsLeft = this.target - nowUnix
      const threshold = peakThreshold(secondsLeft)
      const meanLimit = meanThreshold(secondsLeft)

      // Sliding window: it takes CONFIRMATIONS samples above the threshold within
      // CONFIRMATION_WINDOW readings. A single peak is noise; three in three
      // seconds is a body turning over.
      sinceLastReset++
      if (deviation > threshold) {
        aboveThreshold++
        aboveThisMinute++
      } else if (deviation > threshold / 2) {
        nearThisMinute++
      }
      if (sinceLastReset >= CONFIRMATION_WINDOW) {
        sinceLastReset = 0
        aboveThreshold = 0
      }

      // Current movement, threshold to beat and confirmations accumulated: during
      // a test you can see exactly what it is thinking.
      const mean = twoMinuteMean()
      try {
        if (line)
          line.setProperty(
            hmUI.prop.TEXT,
            'peak ' + Math.round(deviation) + ' / ' + threshold +
              '  (' + aboveThreshold + '/' + CONFIRMATIONS + ')' +
              '\nmean ' + (mean === null ? 'waiting 1 min' : Math.round(mean)) +
              ' / ' + Math.round(meanLimit)
          )
      } catch (e) {}

      // One diary line per minute: it is there to CALIBRATE the threshold after
      // the first real night (how much does a sleeping wrist actually move?), not
      // to narrate the story — writing costs, and here we write little.
      const minutes = Math.floor((nowUnix - openedAt) / 60)
      if (minutes > lastLoggedMinute) {
        lastLoggedMinute = minutes
        try {
          // The two columns that matter for calibration: how many times the
          // threshold was passed, and how many times we came close (half the
          // threshold). If in the morning "above" is always 0 but "near" is high,
          // the threshold is too strict — and you can see it without guessing.
          // ⭐ Alongside the movement we also record WHAT THE WATCH WAS SAYING
          // about the sleep stages in that same minute. The alarm no longer uses
          // them, but this way every night leaves behind the answer to the open
          // question by itself: are real-time stages usable? By comparing
          // "declared stage" with "measured movement" and with the morning
          // hypnogram, you can see whether and how much they lie. It costs one
          // line per minute and changes nothing about how it works.
          let stage = null
          try {
            const raw = readState()
            stage = {
              asleep: raw.sleepingStatus,
              stage: raw.lastStageModel,
              age: raw.lastStageStop ? nowUnix - raw.lastStageStop : null,
              hr: raw.hr,
            }
          } catch (e) {}
          logEvent('LOOKOUT minute', {
            min: minutes,
            threshold: threshold, // the ACTIVE threshold this minute: the curve can be re-read
            peak: Math.round(peakThisMinute),
            avg: samplesThisMinute ? Math.round(sumDeviation / samplesThisMinute) : 0,
            mean2m: mean === null ? null : Math.round(mean),
            above: aboveThisMinute,
            near: nearThisMinute,
            samples: samplesThisMinute,
            sleep: stage,
          })
        } catch (e) {}
        peakThisMinute = 0
        samplesThisMinute = 0
        aboveThisMinute = 0
        nearThisMinute = 0
        sumDeviation = 0
      }

      // FIRST CRITERION — the jolt: three readings above the threshold in three
      // seconds.
      if (aboveThreshold >= CONFIRMATIONS) {
        this.wake('peak ' + Math.round(deviation) + ' over ' + threshold)
        return
      }

      // SECOND CRITERION — restlessness: ten micro-movements in two minutes are a
      // body surfacing out of sleep, and the peak never sees them. The threshold
      // lives in utils/threshold.js: FIXED at 50 over the last 10 minutes (the
      // noise floor of a still body sits at 9-22, "half the peak" fell below it
      // and rang for nothing), half the peak before that.
      if (mean !== null && mean > meanLimit) {
        this.wake('mean ' + Math.round(mean) + ' over ' + Math.round(meanLimit))
      }
    },

    wake(why) {
      if (finished) return
      finished = true
      try {
        logEvent('LOOKOUT WAKE', { why, samples, peak: Math.round(peakDeviation) })
      } catch (e) {}
      try {
        patch({ lastReason: 'lookout:' + why })
      } catch (e) {}
      // Now it has to wake someone up, not hide: screen at full brightness.
      try {
        setBrightness({ level: 100 })
      } catch (e) {}

      // ⚠️ Timer and accelerometer are switched off ONLY IF we manage to leave
      // (23 Aug review, F3). They used to be closed above, and then, if both
      // navigation attempts failed, the page declared it was "still listening":
      // an empty promise — there was nothing left to listen with, and the screen
      // stayed at full brightness for an hour in the bedroom.
      let gone = false
      try {
        replace({ url: RING_PAGE })
        gone = true
      } catch (e) {}
      if (!gone) {
        try {
          push({ url: RING_PAGE })
          gone = true
        } catch (e) {}
      }
      if (gone) {
        // We are away: now, and only now, timer and sensor go off.
        try {
          if (timerId !== null) clearInterval(timerId)
        } catch (e) {}
        timerId = null
        try {
          if (acc && accOn && typeof acc.stop === 'function') acc.stop()
        } catch (e) {}
        accOn = false
        return
      }

      // Neither route worked: we stay REALLY listening — timer and accelerometer
      // have not been touched — and try again on the next tick. In the meantime
      // the screen goes discreet again: staying at full brightness in a bedroom,
      // for an hour, would be worse damage than the fault itself.
      try {
        logEvent('LOOKOUT cannot open the alarm page, still listening', { why })
      } catch (e) {}
      try {
        setBrightness({ level: originalBrightness === null ? 100 : originalBrightness })
      } catch (e) {}
      finished = false
    },

    close(why) {
      if (finished) return
      finished = true
      try {
        if (timerId !== null) clearInterval(timerId)
      } catch (e) {}
      timerId = null
      try {
        if (acc && accOn && typeof acc.stop === 'function') acc.stop()
      } catch (e) {}
      accOn = false
      try {
        logEvent('LOOKOUT closed', { why, samples })
      } catch (e) {}
      // Raising the brightness back is not enough: we really have to leave,
      // otherwise the screen stays on for up to an hour in the middle of the
      // night (23 Aug review).
      releaseScreen()
      try {
        home()
      } catch (e) {}
    },

    onDestroy() {
      try {
        if (timerId !== null) clearInterval(timerId)
      } catch (e) {}
      timerId = null
      try {
        if (acc && accOn && typeof acc.stop === 'function') acc.stop()
      } catch (e) {}
      accOn = false
      releaseScreen()
    },
  })
)

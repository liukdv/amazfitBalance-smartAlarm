// The alarm window opens this foreground page to read the accelerometer.
// Zepp OS does not expose this sensor to app services. The page keeps the
// display dim while monitoring; independent timers still enforce the deadline.
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
import { pageAlarm, foregroundAlarm } from '../utils/alarms'
import { MotionDetector, CONFIRMATIONS, normalizeSensitivity, motionThreshold } from '../utils/threshold'

const RING_PAGE = 'page/ring'
const PERIOD_MS = 200 // 5 readings per second
const TEXT_UPDATE_MS = 1000

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
let peakMovement = 0
let sumMovement = 0
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

Page(
  BasePage({
    onInit(params) {
      this.alarm = pageAlarm(params)
    },

    build() {
      this.alarm = this.alarm || pageAlarm()
      if (!this.alarm.valid() || this.alarm.load().ringStop === 1) {
        home()
        return
      }
      const foreground = foregroundAlarm()
      if (foreground) {
        this.alarm = foreground
        if (foreground.load().mode === 'ringing') {
          replace({ url: RING_PAGE, params: foreground.param('ring') })
          return
        }
      }
      const { w, h } = screen()
      samples = 0
      peakMovement = 0
      sumMovement = 0
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

      const st = this.alarm.load()
      this.target = st.targetUnix || 0
      this.windowSec = st.windowSec
      this.sensitivity = normalizeSensitivity(st.motionSensitivity)
      this.motion = new MotionDetector(this.sensitivity)
      this.motion.threshold = motionThreshold(this.sensitivity, this.target - openedAt, this.windowSec)
      // Two outfits for the same page: the night one must not be seen, the test
      // one must. It is the same code: only the colours and the brightness
      // change, so what you test is what really runs.
      this.visible = st.lookoutVisible === 1
      this.verbose = st.debugLog === 1
      this.lastTextUpdate = null

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

      try {
        logEvent('LOOKOUT opened', {
          target: this.target, metric: 'xyz-change-mg',
          sensitivity: this.sensitivity, threshold: this.motion.threshold, accOn,
        })
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
          const state = this.alarm.load()
          off = state.mode !== 'alarm'
          this.verbose = state.debugLog === 1
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

      // Use the alarm's actual window so a late opening does not restart the ramp.
      this.motion.threshold = motionThreshold(this.sensitivity, this.target - nowUnix, this.windowSec)
      const activity = this.motion.sample(x, y, z, Date.now())
      if (!activity) return

      samples++
      const { movement, confirmations } = activity
      if (movement > peakMovement) peakMovement = movement
      const threshold = this.motion.threshold
      if (this.verbose) {
        samplesThisMinute++
        if (movement > peakThisMinute) peakThisMinute = movement
        sumMovement += movement
        if (movement > threshold) {
          aboveThisMinute++
        } else if (movement > threshold / 2) {
          nearThisMinute++
        }
      }

      // Diagnostic rendering is independent of the five-Hz wake-up decision.
      try {
        if (this.visible && line) {
          const now = Date.now()
          if (this.lastTextUpdate === null || now - this.lastTextUpdate >= TEXT_UPDATE_MS) {
            line.setProperty(
              hmUI.prop.TEXT,
              'movement ' + Math.round(movement) + ' / ' + threshold +
                '\nconfirmations ' + confirmations + '/' + CONFIRMATIONS
            )
            this.lastTextUpdate = now
          }
        }
      } catch (e) {}

      // VERBOSE summarizes movement once a minute; MINIMAL skips the write.
      const minutes = Math.floor((nowUnix - openedAt) / 60)
      if (minutes > lastLoggedMinute) {
        lastLoggedMinute = minutes
        if (this.verbose) {
          try {
            logEvent('LOOKOUT minute', {
              min: minutes,
              threshold: threshold,
              peak: Math.round(peakThisMinute),
              avg: samplesThisMinute ? Math.round(sumMovement / samplesThisMinute) : 0,
              above: aboveThisMinute,
              near: nearThisMinute,
              samples: samplesThisMinute,
            })
          } catch (e) {}
        }
        peakThisMinute = 0
        samplesThisMinute = 0
        aboveThisMinute = 0
        nearThisMinute = 0
        sumMovement = 0
      }

      if (activity.wake) {
        this.wake('movement ' + Math.round(movement) + ' over ' + threshold)
      }
    },

    wake(why) {
      if (finished) return
      if (!this.alarm.valid() || this.alarm.load().ringStop === 1) {
        this.close('alarm no longer armed')
        return
      }
      finished = true
      try {
        logEvent('LOOKOUT WAKE', { why, samples, peak: Math.round(peakMovement) })
      } catch (e) {}
      try {
        this.alarm.patch({ lastReason: 'lookout:' + why })
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
        replace({ url: RING_PAGE, params: this.alarm.param('ring') })
        gone = true
      } catch (e) {}
      if (!gone) {
        try {
          push({ url: RING_PAGE, params: this.alarm.param('ring') })
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

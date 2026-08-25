// THE RING PAGE: the only place where vibration actually works.
//
// Why it exists: on the evening of 22 Aug the background service commanded the
// vibration twice ("VIBRATION ok" in the diary, exact times) and the motor never
// moved — the wearer was awake and felt nothing. On Zepp OS the vibrator only
// responds in the FOREGROUND. So the service no longer rings: it schedules an
// alarm with `url:` (page target, not `file:` which starts a service), the
// system opens THIS page, and here we vibrate repeatedly with the screen on
// until STOP is pressed — like a real alarm.
import * as hmUI from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'
import * as alarmMgr from '@zos/alarm'
import { getDeviceInfo } from '@zos/device'
import { setPageBrightTime, setBrightness } from '@zos/display'
import { home } from '@zos/router'
import { logEvent } from '../utils/log'
import { load, patch } from '../utils/store'
import { wakeBuzz } from '../utils/vibrate'

const BUZZ_EVERY_MS = 1800 // dense: it must wake you up, not remind you
const MAX_BUZZ = 160 // ~5 minutes, then it stops by itself (battery)

function screen() {
  try {
    const info = getDeviceInfo()
    if (info && info.width) return { w: info.width, h: info.height }
  } catch (e) {}
  return { w: 466, h: 466 }
}

function clockNow() {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

function cancelAll() {
  let n = 0
  try {
    const ids = alarmMgr.getAllAlarms ? alarmMgr.getAllAlarms() : []
    if (Array.isArray(ids))
      ids.forEach((id) => {
        try {
          alarmMgr.cancel(id)
          n++
        } catch (e) {}
      })
  } catch (e) {}
  return n
}

// ⚠️ These live on `this`, NOT as module variables (23 Aug review, finding 2).
// At the alarm time the page can be opened TWICE almost together — by the
// failsafe alarm and by the lookout handing over — and with shared state the
// destruction of the first instance switched off the second one's timer: the
// alarm buzzed once and then fell silent.
let infoText = null
let bigText = null
let stopBtn = null
let bg = null

// Leaving the page: ONLY home(), with the outcome captured.
//
// ⚠️ On the night of 23 Aug the "insistent" version (home + back + replace,
// every 2s, five times) is the prime suspect for the TOTAL FREEZE and the watch
// REBOOT: three navigation commands fired in a burst from one page are spam for
// the system UI. Now: a single, gentle command, and if it does not work, so be
// it — the crown always closes a page, a rebooted watch does not.
function tryExit() {
  try {
    home()
    return 'home ok'
  } catch (e) {
    return 'home ERR: ' + (e && e.message)
  }
}

Page(
  BasePage({
    build() {
      // Explicit reset: the page can be reopened (the service opens it, then the
      // failsafe arrives). Without this, the second open would find the counter
      // already at the cap and fall silent immediately.
      this.count = 0
      this.stopped = false
      this.timerId = null
      this.exitTimerId = null

      // ⛔ STOP already pressed (23 Aug review, finding 3): if a surviving alarm
      // reopens this page after the alarm has been switched off, we do NOT start
      // buzzing again. The service has always had a guard like this; the page did
      // not, and it would have started ringing again half an hour after STOP.
      try {
        const already = load()
        if (already.ringStop === 1 && already.done === 1) {
          logEvent('RING reopened after STOP, not ringing', {})
          this.closeNow()
          return
        }
      } catch (e) {}

      const { w, h } = screen()
      try {
        logEvent('RING page opened', { w, h })
      } catch (e) {}

      // Screen on for a long time: an alarm that goes dark after 5 seconds wakes
      // nobody.
      try {
        setPageBrightTime({ brightTime: 300000 })
      } catch (e) {}
      // The lookout has just spent the night at brightness 1 so as not to wake
      // anyone: if it is not raised here, the alarm screen arrives unreadable and
      // the STOP button practically invisible (23 Aug review).
      try {
        setBrightness({ level: 100 })
      } catch (e) {}

      try {
        bg = hmUI.createWidget(hmUI.widget.FILL_RECT, {
          x: 0,
          y: 0,
          w: w,
          h: h,
          color: 0x7f1d1d,
        })
      } catch (e) {}

      try {
        hmUI.createWidget(hmUI.widget.TEXT, {
          x: 0,
          y: Math.round(h * 0.16),
          w: w,
          h: 70,
          color: 0xffffff,
          text_size: 56,
          align_h: hmUI.align.CENTER_H,
          text: clockNow(),
        })
      } catch (e) {}

      try {
        bigText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 0,
          y: Math.round(h * 0.34),
          w: w,
          h: 40,
          color: 0xffd8d8,
          text_size: 24,
          align_h: hmUI.align.CENTER_H,
          text: 'WAKE UP',
        })
      } catch (e) {}

      try {
        infoText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 6,
          y: Math.round(h * 0.44),
          w: w - 12,
          h: 40,
          color: 0xffd8d8,
          text_size: 15,
          align_h: hmUI.align.CENTER_H,
          text_style: hmUI.text_style.WRAP,
          text: '-',
        })
      } catch (e) {}

      const BW = Math.round(w * 0.72)
      try {
        stopBtn = hmUI.createWidget(hmUI.widget.BUTTON, {
          x: Math.round((w - BW) / 2),
          y: Math.round(h * 0.6),
          w: BW,
          h: 88,
          text: 'STOP',
          text_size: 30,
          // The text colour has to be stated: without it the BUTTON draws it
          // WHITE, and on a white button that makes it invisible (seen on the
          // device on 22 Aug: "on the first tap you cannot see the text").
          color: 0x7f1d1d,
          normal_color: 0xffffff,
          press_color: 0xbbbbbb,
          radius: 44,
          click_func: () => this.stop(),
        })
      } catch (e) {}

      // First buzz IMMEDIATELY: that is the moment that counts.
      this.buzz()

      // Then it insists. Timers work inside pages (not inside services).
      try {
        this.timerId = setInterval(() => {
          try {
            this.buzz()
          } catch (e) {}
        }, BUZZ_EVERY_MS)
      } catch (e) {
        try {
          logEvent('RING timer ERROR', String(e && e.message))
        } catch (e2) {}
      }

      // The page records that it IS ringing, but does NOT increment `rings`:
      // that counter measures the SERVICE's insistence (cap MAX_RINGS). 23 Aug
      // review, finding 3: the double count closed the ringing sequence one
      // round earlier than intended.
      try {
        patch({ mode: 'ringing', lastRingUnix: Math.floor(Date.now() / 1000) })
      } catch (e) {}
    },

    buzz() {
      this.count++
      let res = 'err'
      try {
        res = wakeBuzz()
      } catch (e) {
        res = 'err:' + (e && e.message)
      }
      try {
        if (infoText) infoText.setProperty(hmUI.prop.TEXT, 'buzz ' + this.count + ' · ' + res)
      } catch (e) {}
      if (this.count === 1 || this.count % 10 === 0) {
        try {
          logEvent('RING buzz', { n: this.count, res })
        } catch (e) {}
      }
      if (this.count >= MAX_BUZZ) this.giveUp()
    },

    // The vibration CAP (battery) is NOT a STOP. 23 Aug review, finding 1: this
    // used to call stop(), which cancels ALL the failsafes and silences the
    // service — an early ring slept through would kill the alarm BEFORE the
    // deadline. Now we only give up on vibrating: state and failsafes stay
    // intact, the service keeps insisting and at the deadline the failsafe rings
    // again.
    giveUp() {
      try {
        if (this.timerId !== null) clearInterval(this.timerId)
      } catch (e) {}
      this.timerId = null
      try {
        logEvent('RING vibration cap reached, staying armed', { buzzes: this.count })
      } catch (e) {}
      try {
        if (infoText)
          infoText.setProperty(hmUI.prop.TEXT, 'paused after ' + this.count + ' buzzes · the alarm stays armed')
      } catch (e) {}
    },

    // Stopping must be VISIBLE. On the evening of 22 Aug the button already
    // worked on the first tap, but the screen stayed red and identical and the
    // page never went away: it was pressed 26 times in a minute, and EVERY tap
    // rewrote the log files (~2s of freeze each). Hence the two rules: the real
    // work is done ONCE only, and the following taps write nothing — they just
    // mean "get out NOW".
    stop() {
      if (this.stopped) {
        tryExit()
        return
      }
      this.stopped = true
      try {
        if (this.timerId !== null) clearInterval(this.timerId)
      } catch (e) {}
      this.timerId = null
      const n = cancelAll()
      try {
        patch({ mode: 'idle', done: 1, ringStop: 1 })
      } catch (e) {}
      try {
        logEvent('RING STOPPED', { buzzes: this.count, alarmsCancelled: n })
      } catch (e) {}
      try {
        if (bg) bg.setProperty(hmUI.prop.MORE, { x: 0, y: 0, w: 466, h: 466, color: 0x14532d })
      } catch (e) {}
      try {
        if (bigText) bigText.setProperty(hmUI.prop.TEXT, 'OFF')
      } catch (e) {}
      try {
        if (stopBtn) stopBtn.setProperty(hmUI.prop.TEXT, 'OK · EXIT')
      } catch (e) {}
      try {
        if (infoText)
          infoText.setProperty(hmUI.prop.TEXT, 'alarm off · ' + this.count + ' buzzes')
      } catch (e) {}

      // GENTLE EXIT: after 2s (long enough to read OFF) a SINGLE home(), and a
      // second attempt 3s later if we are still here — then that is it. The
      // outcome goes into the diary: in the morning we will know whether home()
      // works. (The aggressive home+back+replace ×5 version is the suspect for
      // the watch reboot of 23 Aug — never again bursts of navigation.)
      try {
        let tries = 0
        this.exitTimerId = setInterval(() => {
          tries++
          if (tries > 2) {
            try {
              clearInterval(this.exitTimerId)
            } catch (e) {}
            this.exitTimerId = null
            try {
              logEvent('RING exit FAILED, staying open', {})
            } catch (e) {}
            return
          }
          const outcome = tryExit()
          if (tries === 1) {
            try {
              logEvent('RING exiting', { outcome })
            } catch (e) {}
          }
        }, 2500)
      } catch (e) {
        tryExit()
      }
    },

    // Reopened by mistake after a STOP: leave without buzzing and without
    // touching the state, which is already the right one.
    closeNow() {
      this.stopped = true
      tryExit()
    },

    onDestroy() {
      try {
        if (this.timerId !== null) clearInterval(this.timerId)
      } catch (e) {}
      this.timerId = null
      try {
        if (this.exitTimerId !== null) clearInterval(this.exitTimerId)
      } catch (e) {}
      this.exitTimerId = null
    },
  })
)

// MAIN SCREEN — like a standard alarm clock (model: the Android alarm, cut down
// to the bone for a round watch).
//
// Front and centre is THE TIME that is set, below it the STATE (ARMED or off),
// and ONE single gesture: SET when it is off, DELETE when it is armed. The time
// is adjusted with just two circular buttons (+1 hour, +1 min); if the alarm is
// already armed, changing the time switches it off — what you see is always what
// will ring. Everything else lives behind `debug`.
//
// Defensive by construction: the first widget drawn is text, every block is
// isolated, and an error ends up ON THE SCREEN. There is no console on a watch.
import * as hmUI from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'
import { push } from '@zos/router'
import * as alarmMgr from '@zos/alarm'
import { getPackageInfo } from '@zos/app'
import { getDeviceInfo } from '@zos/device'
import { logEvent } from '../utils/log'
import { load, patch } from '../utils/store'
import { checkPermissions, askPermissions } from '../utils/perm'
import { nextOccurrence, nextDelay, fmtTime } from '../utils/schedule'
import { pendingBytes, sendAll } from '../utils/uplog'

const SERVICE_FILE = 'app-service/probe'
const RING_PAGE = 'page/ring'
const LOOKOUT_PAGE = 'page/lookout'

// Below this threshold it is not worth uploading or warning: merely opening the
// page already writes ~40 bytes of diary, and a warning that is always on is a
// warning people stop reading. Above it, there is real data stuck on the watch
// and you need to know (23 Aug).
const UPLOAD_THRESHOLD = 150

// The window width is read from the state (default 30 minutes) and changed from
// the debug page. Design choice, 23 Aug: **a test is a REAL alarm with a short
// window**, not a separate mock path — so what you test is exactly what will run
// tonight, and there are not two routes that can drift apart.
// Zero is a legitimate value: it means "ordinary alarm, rings at the exact time
// without listening to anything". Hence the check is >= 0, not > 0.
function windowSec() {
  try {
    const m = load().windowMin
    if (typeof m === 'number' && m >= 0 && m <= 120) return Math.round(m * 60)
  } catch (e) {}
  return 30 * 60
}

function screen() {
  try {
    const info = getDeviceInfo()
    if (info && info.width) return { w: info.width, h: info.height }
  } catch (e) {}
  return { w: 466, h: 466 }
}

let bigText = null
let subText = null
let errText = null
let actionBtn = null
let logText = null

function say(m) {
  try {
    if (bigText) bigText.setProperty(hmUI.prop.TEXT, String(m))
  } catch (e) {}
}
function sub(m) {
  try {
    if (subText) subText.setProperty(hmUI.prop.TEXT, String(m))
  } catch (e) {}
}
function showErr(where, e) {
  try {
    if (errText)
      errText.setProperty(hmUI.prop.TEXT, where + ': ' + (e && e.message ? e.message : String(e)))
  } catch (e2) {}
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

Page(
  BasePage({
    state: { h: 7, m: 30, armed: false, ringing: false, vlog: false },

    build() {
      const { w, h } = screen()

      // Last time's setting: in the evening you do not start from scratch.
      try {
        const s = load()
        if (typeof s.alarmH === 'number') this.state.h = s.alarmH
        if (typeof s.alarmM === 'number') this.state.m = s.alarmM
        this.state.armed = s.mode === 'alarm'
        this.state.ringing = s.mode === 'ringing'
        this.state.vlog = s.debugLog === 1
      } catch (e) {}

      // Only in VERBOSE: every diary line rewrites the whole file, and "which
      // page was opened" is not worth that cost in everyday use.
      try {
        if (this.state.vlog) logEvent('PAGE opened', { w, h })
      } catch (e) {}

      // The permission for the background service: without it the alarm never
      // starts.
      try {
        askPermissions(null)
      } catch (e) {}

      // AUTO-UPLOAD of the logs on every open (23 Aug: "let's get them off the
      // watch straight away"): every diary line copies the WHOLE file, so keeping
      // the files almost empty is what keeps the watch responsive. Silent and
      // fire-and-forget: no phone = try again on the next open. Never while it is
      // ringing: no extra work at that moment.
      // ⚠️ The outcome is recorded (23 Aug: the logs stopped arriving and there
      // was no way to tell whether the upload started and failed, or never
      // started at all — and a log explaining the fault cannot travel over the
      // faulty channel). The threshold is low: a short lookout session was under
      // 500 bytes and would not even trigger.
      this.pending = 0
      try {
        this.pending = pendingBytes()
        if (!this.state.ringing && this.pending >= UPLOAD_THRESHOLD) {
          sendAll(this, 'auto', (outcome) => {
            try {
              logEvent('UPLOAD auto', { outcome, bytes: this.pending })
            } catch (e) {}
            try {
              if (outcome.indexOf('ok') === 0) this.showPending(0)
              else this.showPending(pendingBytes(), outcome)
            } catch (e) {}
          })
        }
      } catch (e) {}

      const BW = Math.round(w * 0.78)
      const BX = Math.round((w - BW) / 2)
      const HALF = Math.round((BW - 10) / 2)
      let y = Math.round(h * 0.09)

      // THE TIME THAT IS SET: the protagonist of the screen.
      try {
        bigText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 0,
          y: y,
          w: w,
          h: 76,
          color: 0xffffff,
          text_size: 64,
          align_h: hmUI.align.CENTER_H,
          text: fmtTime(this.state.h, this.state.m),
        })
      } catch (e) {
        return
      }
      y += 80

      // The STATE: you must see at a glance whether it is armed or not.
      try {
        subText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 6,
          y: y,
          w: w - 12,
          h: 46,
          color: 0x9be29b,
          text_size: 16,
          align_h: hmUI.align.CENTER_H,
          text_style: hmUI.text_style.WRAP,
          text: '-',
        })
      } catch (e) {}
      y += 50

      try {
        errText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 6,
          y: y,
          w: w - 12,
          h: 30,
          color: 0xff6b6b,
          text_size: 13,
          align_h: hmUI.align.CENTER_H,
          text_style: hmUI.text_style.WRAP,
          text: '',
        })
      } catch (e) {}
      y += 32

      // The logs that have not left the watch yet. It has to be visible HERE, on
      // the watch: if the channel to the phone is mute, no message written in the
      // diary will ever be able to tell the story (23 Aug).
      try {
        logText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 6,
          y: y,
          w: w - 12,
          h: 24,
          color: 0xffc46b,
          text_size: 12,
          align_h: hmUI.align.CENTER_H,
          text: '',
        })
      } catch (e) {}
      y += 26
      this.showPending(this.pending || 0)

      const mkBtn = (x, wdt, label, size, bg, fg, cb) => {
        try {
          return hmUI.createWidget(hmUI.widget.BUTTON, {
            x: x,
            y: y,
            w: wdt,
            h: size,
            text: label,
            text_size: size >= 60 ? 24 : 17,
            color: fg,
            normal_color: bg,
            press_color: 0x5a5a62,
            radius: Math.round(size / 2),
            click_func: () => {
              try {
                if (this.state.vlog) logEvent('TAP', label)
              } catch (e) {}
              try {
                cb()
              } catch (e) {
                showErr(label, e)
              }
            },
          })
        } catch (e) {
          showErr('btn', e)
          return null
        }
      }

      // CIRCULAR adjustment, two buttons only: +1 hour and +1 minute (they wrap
      // around: 23→0, 59→0). As few buttons as possible.
      mkBtn(BX, HALF, 'HOUR +1', 46, 0x26262b, 0xdddddd, () => {
        this.state.h = (this.state.h + 1) % 24
        this.timeChanged()
      })
      // One minute at a time: with short tests, five-minute steps meant waiting
      // too long (23 Aug). Wraps around like the hours.
      mkBtn(BX + HALF + 10, HALF, 'MIN +1', 46, 0x26262b, 0xdddddd, () => {
        this.state.m = (this.state.m + 1) % 60
        this.timeChanged()
      })
      y += 54

      // ONE SINGLE GESTURE: SET when it is off, DELETE when it is armed.
      actionBtn = mkBtn(BX, BW, 'SET', 64, 0x1b5e20, 0xffffff, () => this.toggle())
      y += 72

      // The little button: small, dark, out of the way.
      try {
        const DW = Math.round(w * 0.34)
        hmUI.createWidget(hmUI.widget.BUTTON, {
          x: Math.round((w - DW) / 2),
          y: y,
          w: DW,
          h: 36,
          text: 'debug',
          text_size: 14,
          color: 0x9a9a9a,
          normal_color: 0x1c1c1c,
          press_color: 0x555555,
          radius: 18,
          click_func: () => {
            try {
              push({ url: 'page/debug' })
            } catch (e) {
              showErr('debug', e)
            }
          },
        })
      } catch (e) {
        showErr('btn', e)
      }

      this.refresh()
    },

    // How many logs are still stuck on the watch. Zero = everything has left.
    showPending(bytes, outcome) {
      try {
        if (!logText) return
        if (!bytes || bytes < UPLOAD_THRESHOLD) {
          logText.setProperty(hmUI.prop.TEXT, '')
          return
        }
        const kb = bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' bytes'
        logText.setProperty(
          hmUI.prop.TEXT,
          'logs to upload: ' + kb + (outcome && outcome !== 'ok' ? ' (' + outcome + ')' : '')
        )
      } catch (e) {}
    },

    // Changing the time SWITCHES THE ALARM OFF (23 Aug). It used to re-arm on
    // every tap: you could not tell whether it was still armed, and with
    // one-minute steps that would have meant sixty arm operations to pick an
    // hour. Now the gesture that arms is always and only SET, and the state on
    // screen says so.
    timeChanged() {
      const wasArmed = this.state.armed || this.state.ringing
      try {
        patch({ alarmH: this.state.h, alarmM: this.state.m })
      } catch (e) {}
      if (wasArmed) {
        try {
          cancelAll()
          patch({ mode: 'idle', rings: 0 })
        } catch (e) {}
        this.state.armed = false
        this.state.ringing = false
        this.refresh()
        sub('time changed · OFF\npress SET to arm it')
        return
      }
      this.refresh()
    },

    toggle() {
      if (this.state.armed || this.state.ringing) this.disarm()
      else this.arm()
    },

    refresh() {
      try {
        say(fmtTime(this.state.h, this.state.m))

        try {
          if (actionBtn)
            actionBtn.setProperty(
              hmUI.prop.TEXT,
              this.state.armed || this.state.ringing ? 'DELETE' : 'SET'
            )
        } catch (e) {}

        if (this.state.ringing) {
          sub('RINGING\nDELETE to switch it off')
          return
        }

        const now = Math.floor(Date.now() / 1000)
        const target = nextOccurrence(now, this.state.h, this.state.m)
        const hours = Math.floor((target - now) / 3600)
        const mins = Math.floor(((target - now) % 3600) / 60)
        const when = 'in ' + hours + 'h ' + mins + 'm'
        const winMin = Math.round(windowSec() / 60)
        sub(
          this.state.armed
            ? '● ARMED · rings ' + when +
                (winMin > 0 ? '\nlistening the ' + winMin + ' min before' : '\nexact time')
            : '○ no alarm\n' + when + ' if you set it'
        )
      } catch (e) {
        showErr('refresh', e)
      }
    },

    arm() {
      try {
        cancelAll()
        const now = Math.floor(Date.now() / 1000)
        const target = nextOccurrence(now, this.state.h, this.state.m)
        const WIN = windowSec()
        patch({
          mode: 'alarm',
          targetUnix: target,
          windowSec: WIN,
          ticks: 0,
          fired: 0,
          rings: 0,
          lastRingUnix: 0,
          ringStop: 0,
          // The daytime movement test suspends the "awake" rule: if it stayed on,
          // the real alarm would ignore your awakenings.
          motionOnly: 0,
          done: 0,
          startedUnix: now,
          lastReason: '',
          alarmH: this.state.h,
          alarmM: this.state.m,
        })

        const { appId } = getPackageInfo()

        // FAILSAFE ALARM at the exact time, armed FIRST: if the chain's set()
        // were to throw, without this ordering the failsafe would never be armed
        // and the UI would say "ARMED" with nothing behind it (22 Aug review,
        // finding 4). If the whole chain died, the failsafe rings anyway — worst
        // case, an ordinary alarm at the exact time.
        // FAILSAFE 1 — the ring page directly at the alarm time: it does not go
        // through the service, it does not go through any decision. Even if
        // everything else failed, at the exact time the system OPENS the app and
        // this vibrates in the foreground, where the motor really responds. It is
        // the lowest net, and it is the one that carries the weight.
        let pageId = null
        try {
          pageId = alarmMgr.set({
            appid: appId,
            url: RING_PAGE,
            date: target,
            param: 'failsafe',
            repeat_type: alarmMgr.ONCE,
            store: true,
          })
        } catch (e) {}

        // FAILSAFE 2 — the service at alarm time +5s: if the page did not open,
        // it tries to open it again (and retries the direct vibration).
        let failsafeId = null
        try {
          failsafeId = alarmMgr.set({
            appid: appId,
            file: SERVICE_FILE,
            date: target + 5,
            param: 'failsafe',
            repeat_type: alarmMgr.ONCE,
            store: true,
          })
        } catch (e) {}

        let id = null
        let delay = null
        try {
          delay = nextDelay(now, target, WIN)
          id = alarmMgr.set({
            appid: appId,
            file: SERVICE_FILE,
            date: now + delay,
            param: 'first',
            repeat_type: alarmMgr.ONCE,
            store: true,
          })
        } catch (e) {}

        // ⭐ THE LOOKOUT (23 Aug): when the window opens the system opens the page
        // that listens to the accelerometer — the only sensor that really feels
        // movement, and one that only works in the foreground. If the window is
        // already open (alarm armed less than 30 minutes ahead), it starts in one
        // minute instead of in the past.
        let lookoutId = null
        try {
          if (load().useLookout !== 0) {
            const opensAt = Math.max(now + 60, target - WIN)
            if (opensAt < target) {
              lookoutId = alarmMgr.set({
                appid: appId,
                url: LOOKOUT_PAGE,
                date: opensAt,
                param: 'lookout',
                repeat_type: alarmMgr.ONCE,
                store: true,
              })
            }
          }
        } catch (e) {}

        // None armed: the alarm does NOT exist, and the state must not pretend
        // otherwise.
        if (!id && !failsafeId && !pageId) {
          patch({ mode: 'idle' })
          this.state.armed = false
          this.refresh()
          showErr('set', new Error('no alarm accepted by the system'))
          return
        }

        let queued = 'n/a'
        try {
          queued = alarmMgr.getAllAlarms ? JSON.stringify(alarmMgr.getAllAlarms()) : 'n/a'
        } catch (e) {}
        try {
          logEvent('ALARM ARMED', {
            time: fmtTime(this.state.h, this.state.m),
            target,
            win: WIN,
            firstIn: delay,
            id,
            pageId,
            failsafeId,
            lookoutId,
            queued,
            perms: checkPermissions(),
          })
        } catch (e) {}

        this.state.armed = true
        this.state.ringing = false
        this.refresh()
        if (!pageId) showErr('failsafe', new Error('ring page NOT armed'))
        else if (!id) showErr('set', new Error('chain not armed, the failsafe remains'))
      } catch (e) {
        showErr('set', e)
      }
    },

    disarm() {
      try {
        const n = cancelAll()
        patch({ mode: 'idle', rings: 0 })
        try {
          logEvent('ALARM OFF', { cancelled: n })
        } catch (e) {}
        this.state.armed = false
        this.state.ringing = false
        this.refresh()
      } catch (e) {
        showErr('delete', e)
      }
    },

    onDestroy() {},
  })
)

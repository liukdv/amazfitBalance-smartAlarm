// DIAGNOSTICS SCREEN.
//
// Deliberately separate: the main screen must do one thing only, and a fault in
// here does not touch it (you only get here by pressing a button). Here, on the
// other hand, something can break without consequences.
//
// ⭐ HOW A TEST IS DONE, since 23 Aug. There are no more "test buttons" that
// rebuilt a fake alarm: they were a second route alongside the real one, and two
// routes can drift apart. Now:
//   1. WINDOW: 1 min
//   2. TEST SCREEN: YES   (so you can see the movement numbers)
//   3. go back, set the alarm 2 minutes ahead, press SET
// What runs is EXACTLY the code of the night, only compressed.
import * as hmUI from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'
import * as alarmMgr from '@zos/alarm'
import { getDeviceInfo } from '@zos/device'
import { readAll, logEvent, clear, diskSizes } from '../utils/log'
import { stageConsts, wakeableModels } from '../utils/sample'
import { load, patch, reset } from '../utils/store'
import { wakeBuzz } from '../utils/vibrate'
import { fmtTime } from '../utils/schedule'
import { sendAll } from '../utils/uplog'

// Version VISIBLE on screen: on 23 Aug minutes were lost looking for a button
// that only existed in the following build — the QR changes on every deploy and
// the old one installs the old package. To be bumped on every change delivered.
const BUILD = 'v14'

function screen() {
  try {
    const info = getDeviceInfo()
    if (info && info.width) return { w: info.width, h: info.height }
  } catch (e) {}
  return { w: 466, h: 466 }
}

let statusText = null
let detailText = null
let errText = null

function say(m) {
  try {
    if (statusText) statusText.setProperty(hmUI.prop.TEXT, String(m))
  } catch (e) {}
}
function detail(m) {
  try {
    if (detailText) detailText.setProperty(hmUI.prop.TEXT, String(m))
  } catch (e) {}
}
function showErr(where, e) {
  try {
    if (errText)
      errText.setProperty(hmUI.prop.TEXT, where + ': ' + (e && e.message ? e.message : String(e)))
  } catch (e2) {}
}

function samples() {
  try {
    const s = readAll()
    if (!s) return 0
    let n = 0
    for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++
    return Math.max(0, n - 1)
  } catch (e) {
    return -1
  }
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

// The window width currently set. 0 is legitimate (ordinary alarm), so `|| 30`
// cannot be used: it would wipe out exactly that zero.
function windowMinOf() {
  try {
    const m = load().windowMin
    if (typeof m === 'number' && m >= 0 && m <= 60) return m
  } catch (e) {}
  return 30
}

function clock(unix) {
  const d = new Date(unix * 1000)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

Page(
  BasePage({
    build() {
      const { w, h } = screen()
      this.vlog = false
      try {
        this.vlog = load().debugLog === 1
      } catch (e) {}
      try {
        if (this.vlog)
          logEvent('DEBUG opened', { w, h, stageConsts: stageConsts(), wakeable: wakeableModels() })
      } catch (e) {}

      const BW = Math.round(w * 0.8)
      const BX = Math.round((w - BW) / 2)
      let y = Math.round(h * 0.06)

      try {
        statusText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 0,
          y: y,
          w: w,
          h: 54,
          color: 0xffffff,
          text_size: 19,
          align_h: hmUI.align.CENTER_H,
          text_style: hmUI.text_style.WRAP,
          text: 'diagnostics ' + BUILD,
        })
      } catch (e) {
        return
      }
      y += 58

      try {
        detailText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 6,
          y: y,
          w: w - 12,
          h: 66,
          color: 0x9be29b,
          text_size: 14,
          align_h: hmUI.align.CENTER_H,
          text_style: hmUI.text_style.WRAP,
          text: '-',
        })
      } catch (e) {}
      y += 70

      try {
        errText = hmUI.createWidget(hmUI.widget.TEXT, {
          x: 6,
          y: y,
          w: w - 12,
          h: 40,
          color: 0xff6b6b,
          text_size: 13,
          align_h: hmUI.align.CENTER_H,
          text_style: hmUI.text_style.WRAP,
          text: '',
        })
      } catch (e) {}
      y += 44

      const btn = (label, bg, cb) => {
        let ref = null
        try {
          ref = hmUI.createWidget(hmUI.widget.BUTTON, {
            x: BX,
            y: y,
            w: BW,
            h: 46,
            text: label,
            text_size: 17,
            normal_color: bg,
            press_color: 0x777777,
            radius: 23,
            click_func: () => {
              try {
                if (this.vlog) logEvent('TAP', label)
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
        }
        y += 54
        return ref
      }

      btn('SEND LOGS', 0x0277bd, () => this.sendLog('manual'))
      btn('STATE', 0x333333, () => this.showState())

      // ⭐ THE WINDOW WIDTH (23 Aug). There are no "test buttons" any more: a test
      // IS a real alarm with a short window. Put 1 minute here, go back and set
      // the alarm one minute ahead: what you are testing is exactly the code that
      // will run tonight.
      // One minute at a time, wrapping 0→60→0. With 0 the alarm listens to
      // nothing and rings at the exact time, like an ordinary alarm.
      const winBtn = btn('WINDOW +1: ' + windowMinOf() + ' min', 0x4527a0, () => {
        const next = (windowMinOf() + 1) % 61
        patch({ windowMin: next })
        try {
          if (winBtn) winBtn.setProperty(hmUI.prop.TEXT, 'WINDOW +1: ' + next + ' min')
        } catch (e) {}
        say('window ' + next + ' min')
        detail(
          next === 0
            ? 'ORDINARY alarm: rings at the exact time'
            : 'listens in the ' + next + ' min before\nTEST: alarm in ' + (next + 1) + ' min'
        )
        try {
          logEvent('WINDOW changed', { min: next })
        } catch (e) {}
      })

      // ⭐ TEST SCREEN: the page that listens to the movement has two outfits.
      // At night it is nearly invisible (very dark grey, brightness at minimum)
      // so as not to wake anyone or light up the room; during tests it becomes
      // readable and shows the accelerometer numbers in real time. Same code,
      // only the colours change.
      const visBtn = btn(
        'TEST SCREEN: ' + (load().lookoutVisible === 1 ? 'YES' : 'no'),
        0x00695c,
        () => {
          const on = load().lookoutVisible !== 1
          patch({ lookoutVisible: on ? 1 : 0 })
          try {
            if (visBtn) visBtn.setProperty(hmUI.prop.TEXT, 'TEST SCREEN: ' + (on ? 'YES' : 'no'))
          } catch (e) {}
          say('test screen ' + (on ? 'ON' : 'off'))
          detail(on ? 'you will see movement and confirmations' : 'at night: almost invisible')
        }
      )

      btn('BUZZ', 0x8e44ad, () => say('alarm: ' + wakeBuzz()))

      // Diary verbosity. VERBOSE (default during the analysis phase): every tick
      // writes reading + decision + sample. MINIMAL: only arming, rings and
      // errors — for when the alarm is just there to be used.
      const logBtn = btn('LOG: ' + (this.vlog ? 'VERBOSE' : 'MINIMAL'), 0x00695c, () => {
        this.vlog = !(load().debugLog === 1)
        patch({ debugLog: this.vlog ? 1 : 0 })
        try {
          if (logBtn) logBtn.setProperty(hmUI.prop.TEXT, 'LOG: ' + (this.vlog ? 'VERBOSE' : 'MINIMAL'))
        } catch (e) {}
        say('log ' + (this.vlog ? 'VERBOSE' : 'MINIMAL'))
        detail(this.vlog ? 'every tick writes diary + sample' : 'only arming, rings, errors')
      })

      btn('STOP EVERYTHING', 0x5e1b1b, () => {
        const n = cancelAll()
        patch({ mode: 'idle', rings: 0 })
        say('STOPPED · ' + n + ' cancelled')
      })

      // EVERYTHING back to zero, for real (23 Aug: "let's take the system back in
      // hand"): alarms cancelled, log files DELETED from disk (not filled with
      // spaces: the ghost size was the slowness that survived reboots and
      // uploads), state back to defaults. The before/after sizes end up on
      // screen: the proof that everything really went back to 0.
      btn('FULL RESET', 0x7f1d1d, () => {
        const before = diskSizes()
        const n = cancelAll()
        clear()
        reset()
        const after = diskSizes()
        say('RESET · ' + n + ' alarms cancelled')
        detail(
          'diary ' + before.events + '→' + after.events + ' bytes\n' +
            'samples ' + before.csv + '→' + after.csv + ' bytes'
        )
      })

      this.showState()
    },

    // NOTE (23 Aug): `armReal` and `armTest` used to live here, rebuilding a
    // "test" alarm with compressed times. They were removed because they were a
    // SECOND route alongside the real one, and two routes can drift apart. Now a
    // test is the real alarm with a short window: you change the width above and
    // set the time from the main page.

    showState() {
      try {
        const s = load()
        const now = Math.floor(Date.now() / 1000)
        const ticks = (s.ticks || 0) + (s.maxTicks ? '/' + s.maxTicks : '')
        // The version sits in the status line (the title is covered by it
        // immediately): it is the first place anyone looks.
        let head = BUILD + ' · mode: ' + s.mode
        if (s.mode === 'idle' && s.done) head = s.fired ? 'COMPLETED: it vibrated' : 'COMPLETED'
        if (s.mode === 'alarm') head += ' · ' + fmtTime(s.alarmH, s.alarmM)
        if (s.mode === 'ringing') head = 'RINGING (' + (s.rings || 0) + ')'
        say(head + '\nticks ' + ticks + ' · buzzes ' + (s.fired || 0) +
          ' · log ' + (s.debugLog !== 0 ? 'on' : 'off'))
        // The ON-DISK size of the log files: it is the hidden cost of every write
        // (23 Aug), so it is kept in sight from here.
        const d = diskSizes()
        detail(
          'samples ' + samples() + ' · disk ev ' + d.events + 'B csv ' + d.csv + 'B' +
            (s.mode === 'alarm' && s.targetUnix ? '\nrings at ' + clock(s.targetUnix) : '') +
            '\n' + String(s.lastReason || '').slice(0, 70)
        )
      } catch (e) {
        showErr('state', e)
      }
    },

    // The actual upload lives in utils/uplog (shared with the main page's
    // auto-upload): only the on-screen wording stays here.
    sendLog(why) {
      say('uploading...')
      sendAll(this, why, (outcome) => {
        if (outcome.indexOf('ok') === 0) {
          say('LOGS SENT ' + outcome.slice(3))
          detail('local files cleared')
        } else if (outcome === 'no channel') {
          say('no channel')
          detail('app not wrapped in BaseApp?')
        } else {
          say('upload failed')
          detail('is the phone reachable?')
        }
      })
    },

    onDestroy() {},
  })
)

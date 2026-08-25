// State shared between the page and the background service.
//
// globalData cannot be used: every wake-up of the service is a brand new
// process and memory does not survive. The file is the only channel.
import { openSync, writeSync, closeSync, statSync, readSync, O_RDWR, O_CREAT } from '@zos/fs'

const PATH = 'state.json'

const DEFAULTS = {
  mode: 'idle', // idle | monitor | alarm | ringing
  targetUnix: 0,
  windowSec: 1800,
  ticks: 0,
  maxTicks: 0, // 0 = no limit; >0 means monitoring stops by itself
  fired: 0,
  rings: 0, // rings of the alarm currently going off (it insists up to 3 times)
  lastRingUnix: 0,
  ringStop: 0, // 1 once STOP has been pressed on the ring page
  useStages: 0, // 1 re-enables the old sleep-stage route (default: off since 23 Aug)
  useLookout: 1, // 1 = when the window opens, the lookout page opens and listens to the accelerometer
  // ⛔ NO movement threshold here: it lives as a constant in page/lookout.js.
  // This file survives app updates and the stored values beat the new defaults —
  // on 23 Aug the watch kept using 250 while the code said 200, and nothing
  // flagged it. Design decisions belong in the code and change with the code;
  // only what is genuinely the user's belongs here (alarm time, window, the
  // debug switches).
  windowMin: 30, // window width in minutes. Changed from the debug page: a test is a REAL alarm with a short window, not a separate mock path.
  // 0 = the lookout is nearly invisible (very dark grey on black, brightness at
  // minimum): at night it must be able to stay on next to a sleeping person
  // without waking them or lighting up the room. 1 = TEST SCREEN: full colours
  // and readable numbers, to see what is going on during a test.
  lookoutVisible: 0,
  lastReason: '',
  startedUnix: 0,
  done: 0, // 1 once a limited test has run to completion
  uploadSeq: 0, // upload counter: a gap means a lost upload
  debugLog: 1, // 1 = VERBOSE (default during this analysis phase): every tick writes reading + decision + sample. 0 = MINIMAL: only arming, rings, errors. Changed from the debug page; once stable the default will become 0.
  alarmH: 7, // the alarm hour chosen by the user
  alarmM: 30,
}

function readRaw() {
  try {
    const st = statSync({ path: PATH })
    if (!st || !st.size) return ''
    const fd = openSync({ path: PATH, flag: O_RDWR })
    const buf = new ArrayBuffer(st.size)
    readSync({ fd, buffer: buf, offset: 0, length: st.size, position: 0 })
    closeSync({ fd })
    const v = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i])
    return s
  } catch (e) {
    return ''
  }
}

export function load() {
  const raw = readRaw()
  if (!raw) return { ...DEFAULTS }
  try {
    const o = JSON.parse(raw)
    return { ...DEFAULTS, ...o }
  } catch (e) {
    return { ...DEFAULTS }
  }
}

export function save(obj) {
  try {
    const s = JSON.stringify(obj)
    const buf = new ArrayBuffer(s.length)
    const view = new Uint8Array(buf)
    for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xff
    // Truncation: we rewrite from the start and blank the tail of the old file,
    // otherwise garbage remains after the last brace and JSON.parse fails.
    let old = 0
    try {
      old = statSync({ path: PATH }).size
    } catch (e) {}
    const fd = openSync({ path: PATH, flag: O_RDWR | O_CREAT })
    writeSync({ fd, buffer: buf, offset: 0, length: buf.byteLength, position: 0 })
    if (old > buf.byteLength) {
      const pad = new ArrayBuffer(old - buf.byteLength)
      const pv = new Uint8Array(pad)
      for (let i = 0; i < pv.length; i++) pv[i] = 32 // spaces
      writeSync({ fd, buffer: pad, offset: 0, length: pad.byteLength, position: buf.byteLength })
    }
    closeSync({ fd })
    return true
  } catch (e) {
    return false
  }
}

export function patch(delta) {
  const s = load()
  const next = { ...s, ...delta }
  save(next)
  return next
}

export function reset() {
  save({ ...DEFAULTS })
  return { ...DEFAULTS }
}

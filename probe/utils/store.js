// State shared between the page and the background service.
//
// globalData cannot be used: every wake-up of the service is a brand new
// process and memory does not survive. The file is the only channel.
import { openSync, writeSync, closeSync, statSync, readSync, O_RDWR, O_CREAT } from '@zos/fs'

const PATH = 'state.json'

const DEFAULTS = {
  mode: 'idle', // idle | alarm | ringing
  targetUnix: 0,
  windowSec: 1800,
  ticks: 0,
  fired: 0,
  rings: 0, // rings of the alarm currently going off (it insists up to 3 times)
  lastRingUnix: 0,
  ringStop: 0, // 1 once STOP has been pressed on the ring page
  motionSensitivity: 'normal', // low | normal | high; numeric thresholds stay in code
  windowMin: 30, // window width in minutes. Changed from the debug page: a test is a REAL alarm with a short window, not a separate mock path.
  // 0 = the lookout is nearly invisible (very dark grey on black, brightness at
  // minimum): at night it must be able to stay on next to a sleeping person
  // without waking them or lighting up the room. 1 = TEST SCREEN: full colours
  // and readable numbers, to see what is going on during a test.
  lookoutVisible: 0,
  lastReason: '',
  startedUnix: 0,
  done: 0, // 1 once a limited test has run to completion
  debugLog: 0, // MINIMAL by default; enable VERBOSE explicitly for periodic diagnostics.
  alarmH: 7, // the alarm hour chosen by the user
  alarmM: 30,
}

function readRaw(path = PATH) {
  let fd = null
  try {
    const st = statSync({ path })
    if (!st || !st.size) return ''
    fd = openSync({ path, flag: O_RDWR })
    const buf = new ArrayBuffer(st.size)
    readSync({ fd, buffer: buf, offset: 0, length: st.size, position: 0 })
    const v = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i])
    return s
  } catch (e) {
    return ''
  } finally {
    if (fd !== null) {
      try { closeSync({ fd }) } catch (e) {}
    }
  }
}

/** Distinguish an absent collection from an unreadable one during migration. */
export function recordExists(path) {
  try { return !!statSync({ path }) } catch (e) { return false }
}

// Read an independent alarm record without silently inventing a replacement.
export function readRecord(path) {
  const raw = readRaw(path)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

export function load() {
  return { ...DEFAULTS, ...(readRecord(PATH) || {}) }
}

export function save(obj, path = PATH) {
  let fd = null
  try {
    const s = JSON.stringify(obj)
    const buf = new ArrayBuffer(s.length)
    const view = new Uint8Array(buf)
    for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xff
    // Truncation: we rewrite from the start and blank the tail of the old file,
    // otherwise garbage remains after the last brace and JSON.parse fails.
    let old = 0
    try {
      old = statSync({ path }).size
    } catch (e) {}
    fd = openSync({ path, flag: O_RDWR | O_CREAT })
    writeSync({ fd, buffer: buf, offset: 0, length: buf.byteLength, position: 0 })
    if (old > buf.byteLength) {
      const pad = new ArrayBuffer(old - buf.byteLength)
      const pv = new Uint8Array(pad)
      for (let i = 0; i < pv.length; i++) pv[i] = 32 // spaces
      writeSync({ fd, buffer: pad, offset: 0, length: pad.byteLength, position: buf.byteLength })
    }
    return true
  } catch (e) {
    return false
  } finally {
    if (fd !== null) {
      try { closeSync({ fd }) } catch (e) {}
    }
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

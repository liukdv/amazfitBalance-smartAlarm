// Local event log with bounded size and cleanup on every I/O failure.
import { openSync, writeSync, closeSync, statSync, readSync, rmSync, O_RDWR, O_CREAT } from '@zos/fs'

export const EVENTS_PATH = 'events.log'

function fileSize(path) {
  try {
    const st = statSync({ path })
    return st && typeof st.size === 'number' ? st.size : 0
  } catch (e) {
    return 0
  }
}

// Zepp OS does not expose TextEncoder: the log is ASCII, converted by hand.
function str2buf(s) {
  const buf = new ArrayBuffer(s.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xff
  return buf
}

// In blocks, not character by character: on files of tens of KB the old loop
// cost REAL seconds on the watch (23 Aug: ~3s per tap, measured).
function buf2str(buf) {
  const view = new Uint8Array(buf)
  try {
    const parts = []
    for (let i = 0; i < view.length; i += 2048)
      parts.push(String.fromCharCode.apply(null, view.subarray(i, Math.min(i + 2048, view.length))))
    return parts.join('')
  } catch (e) {
    let out = ''
    for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i])
    return out
  }
}

// ⭐ REAL DELETION (23 Aug). This filesystem does not truncate: "clearing" a file
// by filling it with spaces leaves it at its ALL-TIME MAXIMUM size forever, and
// every later write keeps copying all of it — the slowness that survived reboots
// and log uploads. rmSync really deletes: the file is reborn small on the next
// write.
function removeFile(path) {
  try {
    if (typeof rmSync !== 'function') return false
    rmSync({ path })
    return fileSize(path) === 0
  } catch (e) {
    return false
  }
}

export function diskSizes() {
  return { events: fileSize(EVENTS_PATH) }
}

// Appending by FULL RE-READ AND REWRITE, not by offset.
//
// It used to write at `position: statSync().size`. On the real device that size
// is not reliable and the two writers (page and service, separate processes)
// overwrote each other: the logs that arrived were missing the beginnings of
// lines and the header showed up in the middle of the data. Rewriting everything
// removes every assumption about offset semantics — but the cost grows with the
// file: on the evening of 22 Aug the diary reached ~200 lines and every write
// cost seconds (the service went from 2s to 9s per tick, the UI froze). Hence
// the CAP below.
//
// CAP: keep the most recent complete lines to bound the cost of each write.
// Logs stay local; trimming permanently discards the oldest entries.
// Saving an alarm writes events synchronously, so keep this rewrite small.
const MAX_BYTES = 16 * 1024

function appendTo(path, text) {
  let fd = null
  try {
    const current = readFile(path)
    let payload = current + text
    if (payload.length > MAX_BYTES) {
      const tail = payload.slice(payload.length - MAX_BYTES)
      const nl = tail.indexOf('\n')
      payload = tail.slice(nl + 1)
    }
    const buf = str2buf(payload)
    // AUTO-SHRINK: if the file on disk is bigger than the new content (the cap
    // trimming it, or the space-bloat left by the old clearing method), DELETE
    // it and rewrite from scratch: that is the only way to make it small again,
    // and a small file means every write is cheap.
    const old = fileSize(path)
    if (old > buf.byteLength) removeFile(path)
    fd = openSync({ path: path, flag: O_RDWR | O_CREAT })
    if (fd === undefined || fd === null) return false
    writeSync({ fd, buffer: buf, offset: 0, length: buf.byteLength, position: 0 })
    // Fallback in case the deletion did not succeed: the old tail beyond the new
    // end must be covered with spaces, otherwise the next read would drag it
    // along.
    const now = fileSize(path)
    if (now > buf.byteLength) {
      const pad = new ArrayBuffer(now - buf.byteLength)
      const pv = new Uint8Array(pad)
      for (let i = 0; i < pv.length; i++) pv[i] = 32
      writeSync({ fd, buffer: pad, offset: 0, length: pad.byteLength, position: buf.byteLength })
    }
    return true
  } catch (e) {
    return false
  } finally {
    if (fd !== null && fd !== undefined) {
      try { closeSync({ fd }) } catch (e) {}
    }
  }
}

function readFile(path) {
  let fd = null
  try {
    const size = fileSize(path)
    if (!size) return ''
    fd = openSync({ path: path, flag: O_RDWR })
    const buf = new ArrayBuffer(size)
    readSync({ fd, buffer: buf, offset: 0, length: size, position: 0 })
    let s = buf2str(buf)
    // Clearing fills the file with spaces instead of shortening it (this
    // filesystem offers no real truncation). So: content made only of spaces
    // counts as an empty file, and the padding tail must be stripped, otherwise
    // every later write would carry it along.
    s = s.replace(/[ \t\0]+$/, '')
    return s.replace(/\s+$/, '').length === 0 ? '' : s
  } catch (e) {
    return ''
  } finally {
    if (fd !== null && fd !== undefined) {
      try { closeSync({ fd }) } catch (e) {}
    }
  }
}

function truncate(path) {
  // First choice: DELETE the file (size on disk → 0, for real).
  if (removeFile(path)) return true
  // Fallback if rmSync is missing or fails: fill with spaces — the content is
  // gone but the size remains (the bloat will be reabsorbed by the auto-shrink
  // on the next write).
  let fd = null
  try {
    const old = fileSize(path)
    if (!old) return true
    fd = openSync({ path: path, flag: O_RDWR | O_CREAT })
    const pad = new ArrayBuffer(old)
    const pv = new Uint8Array(pad)
    for (let i = 0; i < pv.length; i++) pv[i] = 32
    writeSync({ fd, buffer: pad, offset: 0, length: pad.byteLength, position: 0 })
    return true
  } catch (e) {
    return false
  } finally {
    if (fd !== null && fd !== undefined) {
      try { closeSync({ fd }) } catch (e) {}
    }
  }
}

// Event diary: one line per step, timestamped.
export function logEvent(tag, data) {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  const t = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  let line = t + ' ' + tag
  if (data !== undefined && data !== null) {
    let s
    try {
      s = typeof data === 'string' ? data : JSON.stringify(data)
    } catch (e) {
      s = '[not serialisable]'
    }
    line += ' ' + String(s).slice(0, 400)
  }
  return appendTo(EVENTS_PATH, line.replace(/[\r\n]/g, ' ') + '\n')
}

export function readEvents() {
  return readFile(EVENTS_PATH)
}

export function clear() {
  // FULL RESET also removes diagnostics left by older installed versions.
  truncate('probe.csv')
  truncate(EVENTS_PATH)
  return true
}

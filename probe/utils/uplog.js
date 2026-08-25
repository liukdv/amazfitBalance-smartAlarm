// Sending the logs to the server (via the phone, over the calling page's zml
// channel).
//
// Born as the SEND LOGS button on the debug page; since 23 Aug the main page
// uses it AUTOMATICALLY on every open: the log files on the watch stay almost
// always empty — every diary write copies the whole file, so small files mean a
// responsive watch.
import * as alarmMgr from '@zos/alarm'
import { getDeviceInfo } from '@zos/device'
import { readAll, readEvents, clear } from './log'
import { load, patch } from './store'
import { checkPermissions } from './perm'
import { readState, stageConsts, wakeableModels } from './sample'

// How much material there is to ship (bytes of CSV + diary).
export function pendingBytes() {
  let n = 0
  try {
    n += (readAll() || '').length
  } catch (e) {}
  try {
    n += (readEvents() || '').length
  } catch (e) {}
  return n
}

export function buildPayload(why) {
  let st = {}
  try {
    st = load()
  } catch (e) {}
  const seq = (st.uploadSeq || 0) + 1
  const payload = {
    why: why,
    seq: seq,
    logId: 'w' + seq + '-' + Math.floor(Date.now() / 1000),
    at: new Date().toString(),
    atUnix: Math.floor(Date.now() / 1000),
    state: st,
  }
  try {
    payload.perms = checkPermissions()
  } catch (e) {}
  try {
    payload.device = getDeviceInfo()
  } catch (e) {}
  try {
    payload.stageConsts = stageConsts()
    payload.wakeable = wakeableModels()
  } catch (e) {}
  try {
    payload.alarms = alarmMgr.getAllAlarms ? alarmMgr.getAllAlarms() : 'n/a'
  } catch (e) {
    payload.alarms = 'err'
  }
  try {
    payload.raw = readState()
  } catch (e) {}
  try {
    // 64 KB per file: a whole VERBOSE night fits (24 KB was already not enough
    // for the evening of 22 Aug). The local cap is 100 KB: at worst only the
    // oldest tail is lost, and that is already on the server.
    const csv = readAll() || ''
    payload.csvBytes = csv.length
    payload.csv = csv.length > 64000 ? csv.slice(csv.length - 64000) : csv
  } catch (e) {}
  try {
    const ev = readEvents() || ''
    payload.eventsBytes = ev.length
    payload.events = ev.length > 64000 ? ev.slice(ev.length - 64000) : ev
  } catch (e) {}
  return payload
}

// Ships everything through `page.request` (the channel to the phone only exists
// inside zml pages). On a successful upload the local files are cleared.
// `onDone(outcome)` receives 'ok #N' / 'failed' / 'no channel' / 'error'.
export function sendAll(page, why, onDone) {
  const done = typeof onDone === 'function' ? onDone : () => {}
  if (!page || typeof page.request !== 'function') {
    done('no channel')
    return
  }
  const payload = buildPayload(why)
  try {
    page
      .request({ method: 'UPLOAD', payload: payload })
      .then((r) => {
        if (r && r.ok) {
          try {
            clear()
          } catch (e) {}
          try {
            patch({ uploadSeq: payload.seq })
          } catch (e) {}
          done('ok #' + payload.seq)
        } else {
          done('failed')
        }
      })
      .catch(() => {
        done('failed')
      })
  } catch (e) {
    done('error')
  }
}

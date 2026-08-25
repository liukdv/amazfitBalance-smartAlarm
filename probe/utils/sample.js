// A "sample" = one reading of the sleep state as the watch sees it.
// The measurement that matters is freshness_sec: how many seconds separate NOW
// from the end of the last phase the Amazfit algorithm has already classified.
// If it stays within a few minutes, a 30-minute-window alarm is feasible; if it
// is ~30 minutes, the project does not stand up.
import { Sleep, HeartRate, Wear } from '@zos/sensor'

const sleep = new Sleep()
const heart = new HeartRate()
const wear = new Wear()

// ⭐ THE NEW SIGNAL (23 Aug 2026): wrist MOVEMENT.
// Research into how commercial smart alarms actually work says they all look at
// movement, not at sleep stages — the stages are labels applied after the fact,
// and in real time they are unusable (the staging algorithm uses 2 minutes of
// FUTURE data to classify the present).
// The real accelerometer is forbidden in the background; `Wear.getStatus()` is
// the only movement signal an app-service can read: binary actigraphy, one
// sample per minute instead of 25 Hz.
export const WEAR = { OFF: 0, ON: 1, MOVING: 2, UNSURE: 3 }

export function wearStatus() {
  try {
    if (typeof wear.getStatus === 'function') {
      const s = wear.getStatus()
      return s === undefined || s === null ? null : Number(s)
    }
  } catch (e) {}
  return null
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function iso(d) {
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds())
  )
}

// The stage codes are asked of the DEVICE (getStageConstantObj, as in the
// official CLI template), never guessed: in the field a model=4 showed up that
// was outside every map imagined at a desk.
export function stageConsts() {
  try {
    if (typeof sleep.getStageConstantObj === 'function') {
      const o = sleep.getStageConstantObj()
      if (o && o.WAKE_STAGE !== undefined) return o
    }
  } catch (e) {}
  return null
}

// Stages on which waking up is allowed: awake, light sleep, REM. REM is included
// on purpose: waking up in REM is subjectively as easy as in light sleep. If the
// device does not expose the codes the list stays empty and the stage route
// switches itself off (the alarm rings at the deadline).
export function wakeableModels() {
  const c = stageConsts()
  if (!c) return []
  return [c.WAKE_STAGE, c.LIGHT_STAGE, c.REM_STAGE].filter((v) => typeof v === 'number')
}

// The timestamps of getStage() are documented as MINUTES FROM MIDNIGHT of the
// day ("based on the number of minutes at 0:00 of the day") — discovered in the
// field: the (small) values that arrived fell outside every epoch heuristic and
// ended up discarded. Some versions do use epoch (ms/s/min) though: both
// families are accepted, judged by order of magnitude.
export function toUnixSeconds(v, nowUnix) {
  if (typeof v !== 'number' || !isFinite(v)) return null
  if (v > 1e12) return Math.floor(v / 1000) // epoch milliseconds
  if (v > 1e9) return Math.floor(v)         // epoch seconds
  if (v > 1e7) return Math.floor(v * 60)    // epoch minutes
  if (v >= 0 && v < 2880) {
    // minutes from midnight: pick today or yesterday, whichever is nearest in the past
    const now = typeof nowUnix === 'number' ? nowUnix : Math.floor(Date.now() / 1000)
    const d = new Date(now * 1000)
    const midnight = now - (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds())
    let t = midnight + Math.floor(v * 60)
    if (t > now + 120) t -= 86400
    return t
  }
  return null
}

// Raw state reading, unformatted: used by the alarm decision, which needs the
// values and not a line of CSV.
export function readState() {
  const nowUnix = Math.floor(Date.now() / 1000)
  const out = {
    nowUnix,
    sleepingStatus: null,
    wearStatus: wearStatus(),
    lastStageModel: null,
    lastStageStop: null,
    hr: null,
  }

  try {
    sleep.updateInfo()
  } catch (e) {}

  try {
    const s = sleep.getSleepingStatus()
    out.sleepingStatus = s === undefined || s === null ? null : Number(s)
  } catch (e) {}

  try {
    const stages = sleep.getStage()
    if (Array.isArray(stages) && stages.length) {
      const last = stages[stages.length - 1]
      out.lastStageModel = last && last.model !== undefined ? Number(last.model) : null
      out.lastStageStop = toUnixSeconds(last && last.stop, nowUnix)
    }
  } catch (e) {}

  try {
    const hr = heart.getLast()
    out.hr = hr === undefined || hr === null ? null : Number(hr)
  } catch (e) {}

  return out
}

export function takeSample(note) {
  const now = new Date()
  const nowUnix = Math.floor(now.getTime() / 1000)

  let sleepingStatus = ''
  let wear = ''
  let stageCount = ''
  let lastModel = ''
  let rawStart = ''
  let rawStop = ''
  let stopUnix = ''
  let freshness = ''
  let hr = ''
  let infoStart = ''
  let infoEnd = ''
  const notes = []

  // 1. Force the recomputation: this is the heart of the experiment.
  try {
    sleep.updateInfo()
  } catch (e) {
    notes.push('updateInfo_err')
  }

  try {
    const s = sleep.getSleepingStatus()
    sleepingStatus = s === undefined || s === null ? '' : String(s)
  } catch (e) {
    notes.push('status_err')
  }

  // Wrist movement: the most important column since 23 Aug.
  const w = wearStatus()
  wear = w === null ? '' : String(w)

  try {
    const stages = sleep.getStage()
    if (Array.isArray(stages) && stages.length) {
      stageCount = String(stages.length)
      const last = stages[stages.length - 1]
      lastModel = last && last.model !== undefined ? String(last.model) : ''
      // The RAW values are always recorded: they are the evidence needed the
      // next morning to check that the unit interpretation was right.
      rawStart = last && last.start !== undefined ? String(last.start) : ''
      rawStop = last && last.stop !== undefined ? String(last.stop) : ''
      const sp = toUnixSeconds(last && last.stop, nowUnix)
      stopUnix = sp === null ? '' : String(sp)
      if (sp !== null) freshness = String(nowUnix - sp)
    } else {
      stageCount = '0'
      notes.push('no_stages')
    }
  } catch (e) {
    notes.push('stage_err')
  }

  try {
    const last = heart.getLast()
    hr = last === undefined || last === null ? '' : String(last)
  } catch (e) {
    notes.push('hr_err')
  }

  // getInfo() gives sleep start/end in minutes from midnight: another anchor to
  // calibrate the units against a real night.
  try {
    if (typeof sleep.getInfo === 'function') {
      const info = sleep.getInfo()
      if (info) {
        infoStart = info.startTime === undefined || info.startTime === null ? '' : String(info.startTime)
        infoEnd = info.endTime === undefined || info.endTime === null ? '' : String(info.endTime)
      }
    }
  } catch (e) {
    notes.push('info_err')
  }

  if (note) notes.push(note)

  // The note is the last CSV column: a comma in here would shift the count past
  // 14 columns and break the next morning's analysis.
  const noteField = notes.join('+').replace(/,/g, ';')

  return [
    iso(now),
    String(nowUnix),
    sleepingStatus,
    stageCount,
    lastModel,
    rawStart,
    rawStop,
    stopUnix,
    freshness,
    hr,
    infoStart,
    infoEnd,
    wear,
    noteField,
  ].join(',') + '\n'
}

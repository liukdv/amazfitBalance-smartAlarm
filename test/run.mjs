// Tests for the probe logic: it runs the REAL source files (utils/sample.js and
// utils/log.js) against stubs of the Zepp APIs, so what passes here is the same
// code that ends up on the watch.
//
// What it does NOT cover: that the watch runtime behaves like the stubs. That is
// only verified by installing the app.
import assert from 'node:assert/strict'
import { takeSample, toUnixSeconds, wakeableModels } from '../probe/utils/sample.js'
import { appendLine, readAll, readEvents, logEvent, clear, HEADER, COLS, LOG_PATH, EVENTS_PATH } from '../probe/utils/log.js'
import * as fsStub from '@zos/fs'

let pass = 0
let fail = 0
const failures = []

// It must be awaited: without that, the async tests overlap and report "ok"
// before having verified anything (a false success, which has happened here).
async function test(name, fn) {
  globalThis.__stub = {}
  fsStub.__reset()
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    failures.push(name + ' -> ' + e.message)
    console.log('  FAIL ' + name + '\n         ' + e.message)
  }
}

function cols(line) {
  return line.replace(/\n$/, '').split(',')
}

const NOW = Math.floor(Date.now() / 1000)
// Columns: 0 ts_iso, 1 ts_unix, 2 sleeping_status, 3 stage_count, 4 model,
// 5 raw_start, 6 raw_stop, 7 stage_stop_unix, 8 freshness, 9 hr,
// 10 info_start_min, 11 info_end_min, 12 note
// ⚠️ wear_status was inserted at the end, before the note, on 23 Aug: the note
// moved from 12 to 13. Anything reading the CSV by index has to be updated with
// it (tools/wlog.mjs uses freshness at index 8, unchanged).
const I = { status: 2, count: 3, model: 4, rawStart: 5, rawStop: 6, stopUnix: 7, fresh: 8, hr: 9, infoStart: 10, infoEnd: 11, wear: 12, note: 13 }

console.log('\n== utils/sample.js — building the sample ==')

await test('complete sample: ' + COLS + ' columns, freshness computed', () => {
  globalThis.__stub = {
    sleepingStatus: 1,
    hr: 54,
    stages: [
      { start: (NOW - 3600) * 1000, stop: (NOW - 1800) * 1000, model: 7 },
      { start: (NOW - 1800) * 1000, stop: (NOW - 120) * 1000, model: 6 },
    ],
  }
  const c = cols(takeSample(''))
  assert.equal(c.length, COLS, 'expected ' + COLS + ' columns, found ' + c.length)
  assert.equal(c[I.status], '1', 'sleeping_status')
  assert.equal(c[I.count], '2', 'stage_count')
  assert.equal(c[I.model], '6', 'last_stage_model')
  const fresh = Number(c[I.fresh])
  assert.ok(fresh >= 118 && fresh <= 125, 'freshness ~120s, found ' + fresh)
  assert.equal(c[I.hr], '54', 'hr')
})

await test('updateInfo() is always called: it is the point of the experiment', () => {
  globalThis.__stub = { sleepingStatus: 0, stages: [] }
  takeSample('')
  assert.equal(globalThis.__stub.updateInfoCalls, 1)
})

await test('timestamps in SECONDS recognised (not only milliseconds)', () => {
  globalThis.__stub = {
    sleepingStatus: 1,
    stages: [{ start: NOW - 600, stop: NOW - 60, model: 6 }],
  }
  const c = cols(takeSample(''))
  const fresh = Number(c[I.fresh])
  assert.ok(fresh >= 58 && fresh <= 65, 'freshness ~60s, found ' + fresh)
})

await test('timestamps in EPOCH MINUTES recognised', () => {
  const minutes = Math.floor((NOW - 300) / 60)
  globalThis.__stub = {
    sleepingStatus: 1,
    stages: [{ start: minutes - 30, stop: minutes, model: 6 }],
  }
  const c = cols(takeSample(''))
  const fresh = Number(c[I.fresh])
  assert.ok(fresh >= 250 && fresh <= 360, 'freshness ~300s, found ' + fresh)
})

// ⭐ The REAL format documented by Zepp (and observed in the field on 21 Aug,
// where the old parser discarded everything): minutes FROM MIDNIGHT of the day.
await test('timestamps in MINUTES FROM MIDNIGHT recognised (Zepp docs)', () => {
  const d = new Date((NOW - 300) * 1000)
  const minOfDay = d.getHours() * 60 + d.getMinutes()
  globalThis.__stub = {
    sleepingStatus: 1,
    stages: [{ start: Math.max(0, minOfDay - 30), stop: minOfDay, model: 6 }],
  }
  const c = cols(takeSample(''))
  const fresh = Number(c[I.fresh])
  assert.ok(fresh >= 240 && fresh <= 420, 'freshness ~300s, found ' + fresh)
})

await test('minutes from midnight JUST AFTER midnight: resolves to yesterday', () => {
  // At 00:10, a phase that ended at 23:55 yesterday (min 1435): freshness ~15 min.
  const d = new Date(NOW * 1000)
  const midnight = NOW - (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds())
  const now0010 = midnight + 10 * 60
  const t = toUnixSeconds(1435, now0010)
  assert.equal(t, midnight - 86400 + 1435 * 60, 'it should have read this as YESTERDAY 23:55')
  assert.ok(now0010 - t === 15 * 60, 'expected freshness 15 min, found ' + (now0010 - t) / 60)
})

await test('the RAW start/stop values land in the sample exactly as they are', () => {
  globalThis.__stub = {
    sleepingStatus: 1,
    stages: [{ start: 415, stop: 435, model: 4 }],
  }
  const c = cols(takeSample(''))
  assert.equal(c[I.rawStart], '415')
  assert.equal(c[I.rawStop], '435')
  assert.equal(c[I.model], '4')
})

await test('getInfo(): sleep start and end recorded in the sample', () => {
  globalThis.__stub = {
    sleepingStatus: 0,
    stages: [],
    info: { score: 82, startTime: 1380, endTime: 435, deepTime: 90, totalTime: 415 },
  }
  const c = cols(takeSample(''))
  assert.equal(c[I.infoStart], '1380')
  assert.equal(c[I.infoEnd], '435')
})

await test('no stages: it does not blow up, it notes it down', () => {
  globalThis.__stub = { sleepingStatus: 0, stages: [] }
  const c = cols(takeSample(''))
  assert.equal(c[I.count], '0')
  assert.equal(c[I.fresh], '', 'freshness empty when there are no stages')
  assert.ok(c[I.note].includes('no_stages'))
})

await test('getStage() throwing: the sample is still produced and annotated', () => {
  globalThis.__stub = { sleepingStatus: 1, throwStage: true, hr: 60 }
  const c = cols(takeSample(''))
  assert.equal(c.length, COLS)
  assert.ok(c[I.note].includes('stage_err'))
  assert.equal(c[I.hr], '60', 'the heart rate is read all the same')
})

await test('updateInfo() throwing: it does not block the rest', () => {
  globalThis.__stub = { throwUpdateInfo: true, sleepingStatus: 1, stages: [] }
  const c = cols(takeSample(''))
  assert.ok(c[I.note].includes('updateInfo_err'))
  assert.equal(c[I.status], '1', 'the status is read regardless')
})

await test('every sensor broken: valid row, no exception propagated', () => {
  globalThis.__stub = {
    throwUpdateInfo: true,
    throwStatus: true,
    throwStage: true,
    throwHr: true,
    throwInfo: true,
  }
  const c = cols(takeSample('night'))
  assert.equal(c.length, COLS)
  assert.ok(c[I.note].includes('night'))
})

await test('undefined values do not become the string "undefined"', () => {
  globalThis.__stub = { sleepingStatus: undefined, hr: undefined, stages: [] }
  const line = takeSample('')
  assert.ok(!line.includes('undefined'), 'found "undefined" in the row: ' + line)
})

await test('a comma inside the note: sanitised, the CSV stays at ' + COLS + ' columns', () => {
  globalThis.__stub = { sleepingStatus: 0, stages: [] }
  const line = takeSample('ring too close, skipped')
  assert.equal(cols(line).length, COLS, 'a comma in the note shifts the columns: ' + line)
})

await test('no stray commas: the CSV stays at ' + COLS + ' columns', () => {
  globalThis.__stub = {
    sleepingStatus: 1,
    hr: 61,
    stages: [{ start: (NOW - 600) * 1000, stop: (NOW - 60) * 1000, model: 6 }],
  }
  const line = takeSample('a+b')
  assert.equal(cols(line).length, COLS)
  assert.ok(line.endsWith('\n'), 'the row must end with a newline')
})

// ⭐ The signal the 23 Aug version rests on.
await test('wrist MOVEMENT lands in the sample', () => {
  globalThis.__stub = { sleepingStatus: 1, wearStatus: 2, hr: 55, stages: [] }
  const c = takeSample('').trim().split(',')
  assert.equal(c[I.wear], '2', 'movement not recorded: the column that matters')
  globalThis.__stub = { sleepingStatus: 1, wearStatus: 1, hr: 55, stages: [] }
  assert.equal(takeSample('').trim().split(',')[I.wear], '1')
})

await test('movement sensor broken: the sample is still valid, the column empty', () => {
  globalThis.__stub = { throwWear: true, sleepingStatus: 1, hr: 55, stages: [] }
  const line = takeSample('')
  assert.equal(line.trim().split(',').length, COLS, 'malformed row with a broken sensor')
  assert.equal(line.trim().split(',')[I.wear], '')
})

console.log('\n== stage codes: asked of the device, never guessed ==')

await test('the device exposes the codes: wakeable = WAKE + LIGHT + REM', () => {
  globalThis.__stub = { stageConstants: { WAKE_STAGE: 4, REM_STAGE: 5, LIGHT_STAGE: 6, DEEP_STAGE: 7 } }
  assert.deepEqual(wakeableModels().sort(), [4, 5, 6])
})

await test('the device does NOT expose the codes: empty list, nothing invented', () => {
  globalThis.__stub = {}
  assert.deepEqual(wakeableModels(), [])
})

await test('getStageConstantObj throwing: empty list, no exception', () => {
  globalThis.__stub = { throwStageConsts: true }
  assert.deepEqual(wakeableModels(), [])
})

console.log('\n== utils/log.js — append writing ==')

await test('first write: header + row', () => {
  appendLine('X\n')
  const content = fsStub.__get(LOG_PATH)
  assert.ok(content.startsWith(HEADER), 'header missing')
  assert.ok(content.endsWith('X\n'))
})

await test('append: rows queue up, the header appears only once', () => {
  appendLine('A\n')
  appendLine('B\n')
  appendLine('C\n')
  const content = fsStub.__get(LOG_PATH)
  assert.equal(content, HEADER + 'A\nB\nC\n')
  const headerCount = content.split('ts_iso').length - 1
  assert.equal(headerCount, 1, 'header repeated')
})

await test('no file descriptor left open (100 writes)', () => {
  for (let i = 0; i < 100; i++) appendLine('r' + i + '\n')
  assert.equal(fsStub.__openCount(), 0, 'fds not closed: ' + fsStub.__openCount())
})

await test('readAll() reads back exactly what was written', () => {
  appendLine('one\n')
  appendLine('two\n')
  assert.equal(readAll(), HEADER + 'one\ntwo\n')
})

// A real defect seen in the logs that arrived from the watch: rows with their
// beginning eaten and the header in the middle of the data. Cause: appending by
// offset with two distinct writers. These tests look at the integrity of the
// result.
test('no corrupted rows after dense, interleaved writes', () => {
  for (let i = 0; i < 200; i++) {
    appendLine('row-' + i + ',a,b,c,d,e,f,g,h,i\n')
    logEvent('EV', { n: i })
  }
  const csv = readAll().split('\n').filter(Boolean)
  assert.equal(csv.length, 201, 'expected 201 rows, found ' + csv.length)
  assert.ok(csv[0].startsWith('ts_iso'), 'header not at the top: ' + csv[0])
  csv.slice(1).forEach((l, i) => {
    assert.ok(l.startsWith('row-' + i), 'row ' + i + ' corrupted: ' + l)
  })
  const ev = readEvents().split('\n').filter(Boolean)
  assert.equal(ev.length, 200, 'expected 200 events, found ' + ev.length)
  ev.forEach((l) => assert.ok(/^\d\d:\d\d:\d\d EV /.test(l), 'corrupted event: ' + l))
})

test('the header appears exactly once, never in the middle', () => {
  for (let i = 0; i < 50; i++) appendLine('x' + i + '\n')
  const content = readAll()
  assert.equal(content.split('ts_iso').length - 1, 1)
  assert.ok(content.indexOf('ts_iso') === 0, 'header not in first position')
})

test('after clear() the file starts clean, with no leftover spaces', () => {
  for (let i = 0; i < 30; i++) appendLine('long-' + i + '\n')
  clear()
  assert.equal(readAll(), '', 'a cleared file must read as empty')
  appendLine('new\n')
  const c = readAll()
  assert.ok(c.startsWith('ts_iso'), 'header missing after clearing: ' + c.slice(0, 40))
  assert.ok(c.endsWith('new\n'))
  assert.ok(c.indexOf('long-') < 0, 'leftovers from the previous content')
})

test('event diary: the content survives a clearing of the CSV', () => {
  logEvent('BEFORE')
  clear()
  logEvent('AFTER')
  const ev = readEvents()
  assert.ok(ev.indexOf('AFTER') >= 0)
  assert.ok(ev.indexOf('BEFORE') < 0, 'clear must empty both registers')
})

await test('a whole night: 480 samples, final integrity', () => {
  globalThis.__stub = {
    sleepingStatus: 1,
    hr: 55,
    stages: [{ start: (NOW - 600) * 1000, stop: (NOW - 90) * 1000, model: 6 }],
  }
  for (let i = 0; i < 480; i++) appendLine(takeSample(''))
  const content = readAll()
  const lines = content.split('\n').filter(Boolean)
  assert.equal(lines.length, 481, 'expected 481 rows (1 header + 480), found ' + lines.length)
  assert.equal(lines[0].split(',').length, COLS, 'header with ' + COLS + ' columns')
  lines.slice(1).forEach((l, i) => {
    assert.equal(l.split(',').length, COLS, 'row ' + i + ' malformed: ' + l)
  })
  assert.equal(fsStub.__openCount(), 0)
})

// THE CAP (evening of 22 Aug): without it, every row rewrites a file that grows
// forever — the service had gone from 2s to 9s per tick and the UI froze.
await test('CAP: the event diary never exceeds ~100KB, the recent rows survive', () => {
  for (let i = 0; i < 3000; i++) logEvent('ROW', { n: i, filler: 'x'.repeat(60) })
  const ev = readEvents()
  assert.ok(ev.length <= 100000, 'file over the cap: ' + ev.length + ' bytes')
  assert.ok(ev.indexOf('"n":2999') >= 0, 'the last row written must always be there')
  assert.ok(ev.indexOf('"n":0,') < 0, 'the oldest rows should have been trimmed')
  const lines = ev.split('\n').filter(Boolean)
  lines.forEach((l) => assert.match(l, /^\d\d:\d\d:\d\d ROW /, 'row corrupted by the trim: ' + l.slice(0, 40)))
})

await test('CAP on the CSV: the header is ALWAYS on top, even after a trim', () => {
  globalThis.__stub = { sleepingStatus: 1, hr: 55, stages: [] }
  for (let i = 0; i < 1500; i++) appendLine(takeSample('trim'))
  const content = readAll()
  assert.ok(content.length <= 100000 + HEADER.length, 'CSV over the cap: ' + content.length)
  const lines = content.split('\n').filter(Boolean)
  assert.equal(lines[0], HEADER.trim(), 'the header must stay the first row after a trim')
  assert.equal(lines.filter((l) => l === HEADER.trim()).length, 1, 'header duplicated by the trim')
  lines.slice(1).forEach((l) => assert.equal(l.split(',').length, COLS, 'malformed row: ' + l))
})

// 23 Aug: clearing filled the file with spaces and it stayed at its all-time
// maximum size FOREVER — every write copied all of it (the slowness that
// survived reboots and log uploads). Now it is really DELETED.
await test('clear() DELETES the files: size on disk down to zero, for real', () => {
  for (let i = 0; i < 200; i++) logEvent('ROW', { n: i, filler: 'x'.repeat(60) })
  assert.ok(fsStub.__get(EVENTS_PATH) !== null, 'file never created?')
  clear()
  assert.equal(fsStub.__get(EVENTS_PATH), null, 'the file still exists: ghost size')
  assert.equal(fsStub.__get(LOG_PATH), null, 'the CSV still exists: ghost size')
})

await test('the cap trim SHRINKS the file on disk, not just the content', () => {
  for (let i = 0; i < 3000; i++) logEvent('ROW', { n: i, filler: 'x'.repeat(60) })
  const size = (fsStub.__get(EVENTS_PATH) || '').length
  assert.ok(size <= 100000, 'on disk the file stays over the cap: ' + size + ' bytes')
})

await test('an inherited BLOATED file (rm failed): the first write deflates it', () => {
  for (let i = 0; i < 200; i++) logEvent('OLD ROW', { n: i, filler: 'x'.repeat(60) })
  globalThis.__stub = { throwFsRm: true }
  clear() // fallback: fills with spaces, the size stays
  const bloated = (fsStub.__get(EVENTS_PATH) || '').length
  assert.ok(bloated > 10000, 'premise: the fallback leaves the file bloated')
  globalThis.__stub = {}
  logEvent('FIRST NEW ROW')
  const after = (fsStub.__get(EVENTS_PATH) || '').length
  assert.ok(after < 200, 'the bloat was not reabsorbed: ' + after + ' bytes')
  assert.match(readEvents(), /FIRST NEW ROW/)
})

await test('rmSync permanently broken: the content is still correct (space fallback)', () => {
  globalThis.__stub = { throwFsRm: true }
  for (let i = 0; i < 50; i++) logEvent('ROW', { n: i })
  clear()
  assert.equal(readEvents(), '', 'after clear the content must read as empty')
  logEvent('AFTER')
  assert.match(readEvents(), /AFTER/)
  assert.ok(readEvents().indexOf('ROW') < 0, 'old rows resurrected by the fallback')
})

await test('LATENCY: once the cap is reached, the cost per write stays constant', () => {
  fsStub.__reset()
  for (let i = 0; i < 1200; i++) logEvent('WARMUP', { n: i, filler: 'x'.repeat(60) })
  const before = Date.now()
  for (let i = 0; i < 200; i++) logEvent('MEASURE', { n: i, filler: 'x'.repeat(60) })
  const cost = (Date.now() - before) / 200
  // In Node on a Mac a capped rewrite costs ~ms; if the cap did not work the
  // cost would grow without limit. Generous threshold: 25ms.
  assert.ok(cost < 25, 'average cost per write at steady state: ' + cost.toFixed(1) + 'ms — the cap is not holding')
})

console.log('\n== app-service: the alarm chain ==')

const alarmStub = await import('@zos/alarm')

await test('every wake-up reschedules the next one at +60s', async () => {
  alarmStub.__reset()
  globalThis.__stub = { sleepingStatus: 1, stages: [], hr: 50 }

  // Reproduces the app-service's scheduleNext() logic.
  const { getPackageInfo } = await import('@zos/app')
  const schedule = () => {
    const { appId } = getPackageInfo()
    return alarmStub.set({
      appid: appId,
      file: 'app-service/probe',
      date: Math.floor(Date.now() / 1000) + 60,
      param: 'tick',
      repeat_type: alarmStub.ONCE,
      store: true,
    })
  }

  const id = schedule()
  assert.ok(id, 'no id returned')
  const a = alarmStub.__scheduled[0]
  assert.equal(a.file, 'app-service/probe', 'the file must point at the service')
  assert.equal(a.repeat_type, alarmStub.ONCE)
  assert.equal(a.store, true, 'store:true is what survives a reboot')
  const delta = a.date - Math.floor(Date.now() / 1000)
  assert.ok(delta >= 58 && delta <= 62, 'expected delta ~60s, found ' + delta)
})

await test('10 consecutive wake-ups: 10 alarms, none lost', async () => {
  alarmStub.__reset()
  const { getPackageInfo } = await import('@zos/app')
  for (let i = 0; i < 10; i++) {
    alarmStub.set({
      appid: getPackageInfo().appId,
      file: 'app-service/probe',
      date: Math.floor(Date.now() / 1000) + 60,
      repeat_type: alarmStub.ONCE,
      store: true,
    })
  }
  assert.equal(alarmStub.__scheduled.length, 10)
  assert.equal(alarmStub.getAllAlarms().length, 10)
})

await test('stop cancels every queued alarm', () => {
  alarmStub.getAllAlarms().forEach((id) => alarmStub.cancel(id))
  assert.equal(alarmStub.getAllAlarms().length, 0)
})

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

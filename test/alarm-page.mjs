// Tests for the ALARM SCREEN — the only one that matters tonight.
//
// It covers the evening path (pick the time, press SET) and above all the ways
// it could fail silently.
import assert from 'node:assert/strict'
import * as uiStub from '@zos/ui'
import * as alarmStub from '@zos/alarm'
import * as fsStub from '@zos/fs'
import { load, patch } from '../probe/utils/store.js'
import { nextOccurrence } from '../probe/utils/schedule.js'
import { logEvent, readEvents } from '../probe/utils/log.js'

let pass = 0
let fail = 0
const failures = []

let pageDef = null
globalThis.Page = (def) => {
  pageDef = def
}
globalThis.getApp = () => ({ _options: { globalData: {} } })

await import('../probe/page/index.js')

async function test(name, fn) {
  globalThis.__stub = {}
  uiStub.__reset()
  fsStub.__reset()
  alarmStub.__reset()
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

function newPage() {
  return Object.assign(Object.create(pageDef), pageDef, {
    state: { h: 7, m: 30, armed: false, ringing: false, vlog: false },
  })
}
function texts() {
  return uiStub.__byType('TEXT').map((w) => String(w.props.TEXT || ''))
}
function buttons() {
  return uiStub.__byType('BUTTON')
}
// The LIVE label of a button: the one changed with setProperty (SET becoming
// DELETE), not the one it was created with.
function label(x) {
  return String(x.props.TEXT !== undefined ? x.props.TEXT : x.opts.text)
}
function click(part) {
  const b = buttons().find((x) => label(x).includes(part))
  if (!b)
    throw new Error('button not found: ' + part + ' — ' + buttons().map(label).join(' / '))
  b.opts.click_func()
  return b
}

// The FOUR alarms that SET must leave in the queue:
//  - `first`    the service chain (sensors and decision)
//  - page       the RING PAGE at the exact time (the only thing that really
//               makes the motor vibrate: since 22 Aug we know the background
//               cannot)
//  - `failsafe` the service at alarm time +5s, which retries opening the page
//  - lookout    the page that listens to the accelerometer from the moment the
//               window opens (since 23 Aug: in the background no sensor feels
//               the movement, in the foreground it does)
const ARM_ALARMS = 4
function armAlarms() {
  const first = alarmStub.__scheduled.find((a) => a.param === 'first')
  const page = alarmStub.__scheduled.find((a) => a.url === 'page/ring')
  const failsafe = alarmStub.__scheduled.find((a) => a.param === 'failsafe' && a.file)
  const lookout = alarmStub.__scheduled.find((a) => a.url === 'page/lookout')
  return { first, page, failsafe, lookout }
}

console.log('\n== the screen always opens ==')

await test('build() draws, and shows the time in large type', () => {
  const p = newPage()
  p.build()
  assert.ok(uiStub.__created.length > 0, 'black screen')
  assert.ok(texts().some((t) => t.indexOf('07:30') >= 0), 'time not shown: ' + texts().join(' | '))
})

await test('FEW buttons: two adjustments, one gesture, the debug page', () => {
  const p = newPage()
  p.build()
  const labels = buttons().map(label)
  ;['HOUR +1', 'MIN +1', 'SET', 'debug'].forEach((l) =>
    assert.ok(labels.some((x) => x.includes(l)), 'missing ' + l)
  )
  assert.equal(buttons().length, 4, 'the first page must have 4 buttons, not ' + buttons().length)
  // No test buttons and no window picker on the first page: window is a fixed 30.
  ;['BUZZ', 'MONITOR', 'SAMPLE', 'PERMISSIONS', 'WINDOW', 'TEST'].forEach((l) =>
    assert.ok(!labels.some((x) => x.includes(l)), 'the first page must not have ' + l)
  )
})

await test('state VISIBLE: when off it says "no alarm", the gesture is SET', () => {
  const p = newPage()
  p.build()
  assert.ok(texts().some((t) => t.indexOf('no alarm') >= 0), 'the off state is not visible: ' + texts().join(' | '))
  assert.ok(buttons().some((b) => label(b) === 'SET'))
})

await test('after SET the state says ARMED and the gesture becomes DELETE', () => {
  const p = newPage()
  p.build()
  click('SET')
  assert.ok(texts().some((t) => t.indexOf('ARMED') >= 0), 'ARMED missing: ' + texts().join(' | '))
  assert.ok(buttons().some((b) => label(b) === 'DELETE'), 'the gesture should have become DELETE')
  click('DELETE')
  assert.ok(texts().some((t) => t.indexOf('no alarm') >= 0))
  assert.ok(buttons().some((b) => label(b) === 'SET'), 'the gesture should have gone back to SET')
})

await test('every API broken: the page opens all the same', () => {
  globalThis.__stub = {
    throwDeviceInfo: true,
    throwQueryPermission: true,
    throwRequestPermission: true,
    throwGetAllAlarms: true,
  }
  const p = newPage()
  p.build()
  assert.ok(uiStub.__created.length > 0, 'black screen with the APIs broken')
  assert.ok(buttons().length >= 4)
})

await test('BUTTON not supported: the time stays on screen anyway', () => {
  globalThis.__stub = { throwOnWidget: 'BUTTON' }
  const p = newPage()
  p.build()
  assert.ok(texts().some((t) => t.indexOf('07:30') >= 0))
})

console.log('\n== picking the time: two circular buttons ==')

await test('HOUR +1 advances and wraps at midnight', () => {
  const p = newPage()
  p.build()
  for (let i = 0; i < 17; i++) click('HOUR +1')
  assert.equal(p.state.h, 0, 'from 7, +17 must come back to 0')
})

// One minute at a time: with short tests five-minute steps made you wait too
// long (23 Aug). Wraps at 60.
await test('MIN +1 advances by one minute and wraps', () => {
  const p = newPage()
  p.build()
  click('MIN +1')
  assert.equal(p.state.m, 31)
  for (let i = 0; i < 29; i++) click('MIN +1')
  assert.equal(p.state.m, 0, 'from 31, +29 must come back to 0')
})

await test('the time on screen follows the taps (it is the protagonist)', () => {
  const p = newPage()
  p.build()
  click('HOUR +1')
  click('MIN +1')
  assert.ok(texts().some((t) => t.indexOf('08:31') >= 0), 'time not updated: ' + texts().join(' | '))
})

await test('the chosen time is saved and restored on reopening', () => {
  const p1 = newPage()
  p1.build()
  click('HOUR +1')
  click('MIN +1')
  const p2 = newPage()
  uiStub.__reset()
  p2.build()
  assert.equal(p2.state.h, 8, 'hour not restored')
  assert.equal(p2.state.m, 31, 'minutes not restored')
})

console.log('\n== SET: the gesture that has to work ==')

await test('SET schedules FOUR alarms: chain + ring page + failsafe + lookout', () => {
  const p = newPage()
  p.build()
  click('SET')
  assert.equal(alarmStub.__scheduled.length, ARM_ALARMS, 'expected ' + ARM_ALARMS + ', found ' + alarmStub.__scheduled.length)
  const { first, page, failsafe, lookout } = armAlarms()
  assert.ok(first, 'the first link of the chain is missing')
  assert.ok(page, 'THE RING PAGE IS MISSING: no vibration would reach the motor')
  assert.ok(failsafe, 'the failsafe alarm is missing')
  assert.equal(first.file, 'app-service/probe')
  assert.equal(first.store, true, 'without store the alarm does not survive a reboot')
  const s = load()
  assert.equal(page.date, s.targetUnix, 'the ring page must open at the EXACT time')
  assert.equal(page.store, true)
  assert.ok(!page.file, 'the page opens with url:, not with file: (file starts a mute service)')
  assert.equal(failsafe.date, s.targetUnix + 5, 'the failsafe must arrive just after the time')
  assert.ok(lookout, 'THE LOOKOUT IS MISSING: nobody would listen to the movement')
  assert.equal(lookout.date, s.targetUnix - s.windowSec, 'the lookout must open when the window opens')
  assert.ok(!lookout.file, 'the lookout is a PAGE: the accelerometer is forbidden in the background')
  assert.equal(lookout.store, true)
})

// If the alarm is less than half an hour away the window would already be open:
// the lookout cannot be born in the past.
await test('alarm a few minutes away: the lookout starts at once, never in the past', () => {
  const p = newPage()
  p.build()
  const now = Math.floor(Date.now() / 1000)
  const inTen = new Date((now + 600) * 1000)
  p.state.h = inTen.getHours()
  p.state.m = inTen.getMinutes()
  p.arm()
  const { lookout } = armAlarms()
  if (lookout) {
    assert.ok(lookout.date > now, 'lookout armed in the past: it would never open')
    assert.ok(lookout.date < load().targetUnix, 'lookout after the alarm: useless')
  }
})

await test('lookout switched off by configuration: the usual three alarms remain', () => {
  patch({ useLookout: 0 })
  const p = newPage()
  p.build()
  click('SET')
  assert.equal(alarmStub.__scheduled.length, 3, 'the lookout should have been switchable off')
  const { page, failsafe } = armAlarms()
  assert.ok(page && failsafe, 'switching the lookout off lost the real alarms')
})

// The lesson of 22 Aug evening, turned into a test: an alarm with `file:` starts
// a background service, and from there the vibrator does NOT respond. Only
// `url:` opens a page.
await test('at least one alarm points at a PAGE, not only at services', () => {
  const p = newPage()
  p.build()
  click('SET')
  const pages = alarmStub.__scheduled.filter((a) => a.url && !a.file)
  assert.ok(pages.length >= 1, 'every alarm points at a service: the alarm would stay mute')
})

await test('SET saves the target and the FIXED 30-minute window', () => {
  const p = newPage()
  p.build()
  click('SET')
  const s = load()
  assert.equal(s.mode, 'alarm')
  assert.equal(s.windowSec, 1800, 'fixed 30 min window')
  assert.equal(s.rings, 0)
  const now = Math.floor(Date.now() / 1000)
  assert.equal(s.targetUnix, nextOccurrence(now, 7, 30), 'wrong target')
  assert.ok(s.targetUnix > now, 'target in the past: it would never ring')
})

await test('the first wake-up is never more than half an hour away', () => {
  const p = newPage()
  p.build()
  click('SET')
  const { first } = armAlarms()
  const inSec = first.date - Math.floor(Date.now() / 1000)
  assert.ok(inSec > 0, 'wake-up in the past')
  assert.ok(inSec <= 1800 + 5, 'first wake-up in ' + inSec + 's: a single distant alarm is fragile')
})

await test('DELETE then SET again: never double chains nor double failsafes', () => {
  const p = newPage()
  p.build()
  click('SET')
  click('DELETE')
  click('SET')
  assert.equal(alarmStub.__scheduled.length, ARM_ALARMS, 'duplicated alarms: double vibrations')
})

// ⭐ Changing the time SWITCHES THE ALARM OFF (23 Aug). It used to re-arm on
// every tap and you could not tell whether it was still armed; with one-minute
// steps that would mean sixty arm operations to pick an hour.
await test('changing the time with the alarm ARMED: it SWITCHES IT OFF, and says so', () => {
  const p = newPage()
  p.build()
  click('SET')
  assert.equal(load().mode, 'alarm')
  click('HOUR +1')
  assert.equal(load().mode, 'idle', 'the alarm stayed armed on a time you can no longer see')
  assert.equal(alarmStub.__scheduled.length, 0, 'orphan alarms on the old time')
  assert.ok(
    texts().some((t) => t.indexOf('OFF') >= 0 || t.indexOf('SET') >= 0),
    'the screen does not say it is now off: ' + texts().join(' | ')
  )
  assert.ok(buttons().some((b) => label(b) === 'SET'), 'the gesture must go back to SET')
})

await test('after changing the time, SET arms on the new time', () => {
  const p = newPage()
  p.build()
  click('SET')
  click('HOUR +1')
  click('SET')
  const now = Math.floor(Date.now() / 1000)
  assert.equal(load().targetUnix, nextOccurrence(now, 8, 30), 'it armed a time different from the one on screen')
  assert.equal(alarmStub.__scheduled.length, ARM_ALARMS, 'duplicated alarms')
})

// Window 0 = ordinary alarm: no listening, it rings at the exact time.
await test('window at ZERO: no lookout, it rings at the exact time', () => {
  patch({ windowMin: 0 })
  const p = newPage()
  p.build()
  click('SET')
  const s = load()
  assert.equal(s.windowSec, 0, 'the zero window was not respected')
  const { lookout, page } = armAlarms()
  assert.ok(!lookout, 'with a zero window there is no point opening the lookout')
  assert.ok(page, 'the ring page at the alarm time must remain')
})

await test('changing the time while OFF: it stays off, no alarms', () => {
  const p = newPage()
  p.build()
  click('HOUR +1')
  assert.equal(load().mode, 'idle')
  assert.equal(alarmStub.__scheduled.length, 0, 'touching the time must not arm anything')
})

await test('SET does not touch the night-log flag', () => {
  patch({ debugLog: 0 })
  const p = newPage()
  p.build()
  click('SET')
  assert.equal(load().debugLog, 0, 'arming the alarm switched the log back on')
})

await test('DELETE cancels everything (failsafe included) and goes idle', () => {
  const p = newPage()
  p.build()
  click('SET')
  click('DELETE')
  assert.equal(alarmStub.__scheduled.length, 0, 'surviving alarms after DELETE')
  assert.equal(load().mode, 'idle')
})

await test('alarm refused by the system: error on screen AND state NOT armed', () => {
  globalThis.__stub = { throwAlarmSet: true }
  const p = newPage()
  p.build()
  click('SET')
  assert.ok(
    texts().some((t) => t.length && (t.indexOf('set') >= 0 || t.indexOf('alarm') >= 0 || t.indexOf('failsafe') >= 0)),
    'a silent failure here = a missed alarm: ' + texts().join(' | ')
  )
  // 22 Aug review, finding 4: the state used to stay 'alarm' and on reopening
  // the page said "ARMED" with zero alarms in the queue.
  assert.equal(load().mode, 'idle', 'the UI would say ARMED with nothing behind it')
  assert.equal(p.state.armed, false)
})

console.log('\n== auto-upload of the logs on every open ==')

// 23 Aug: "let's get the logs off the watch straight away" — every line copies
// the whole file, so almost-empty files mean a responsive watch. The main page
// ships them by itself on open, without asking anyone.
const settle = () => new Promise((r) => setImmediate(r))

// First, on a clean page: the warning must not appear out of nowhere.
await test('no logs pending: no pointless warning on screen', () => {
  const p = newPage()
  p.build()
  assert.ok(!texts().some((t) => t.indexOf('logs to upload') >= 0), 'warning shown for no reason')
})

await test('opening with a full diary: it uploads BY ITSELF and clears the files', async () => {
  for (let i = 0; i < 20; i++) logEvent('OLD ROW', { n: i, filler: 'x'.repeat(40) })
  const p = newPage()
  p.build()
  await settle()
  const sent = (globalThis.__stub.requests || []).filter((r) => r.method === 'UPLOAD')
  assert.equal(sent.length, 1, 'no automatic upload started')
  assert.ok(sent[0].payload.events.indexOf('OLD ROW') >= 0, 'the diary is not in the package')
  await settle()
  const after = readEvents()
  assert.ok(after.indexOf('OLD ROW') < 0, 'on a successful upload the local files must be cleared')
  // Only the trace of the upload remains: it is what tells you, in the morning,
  // that the channel worked — and it will leave with the next upload.
  assert.match(after, /UPLOAD auto.*ok/, "the upload's outcome must stay written down")
})

// ⚠️ 23 Aug: the logs stopped arriving and there was no way to tell whether the
// upload started and failed or never started. Now the outcome is ALWAYS noted.
await test('failed upload: it writes it in the diary, so you know in the morning', async () => {
  for (let i = 0; i < 20; i++) logEvent('ROW', { n: i, filler: 'x'.repeat(40) })
  globalThis.__stub.requestFails = true
  const p = newPage()
  p.build()
  await settle()
  await settle()
  assert.match(readEvents(), /UPLOAD auto.*failed/, 'a failed upload leaves no trace')
})

// The warning must be ON THE WATCH: if the channel is mute, no log will ever be
// able to report that the logs are not leaving.
await test('logs stuck on board: the page SAYS SO on screen', async () => {
  for (let i = 0; i < 20; i++) logEvent('ROW', { n: i, filler: 'x'.repeat(40) })
  globalThis.__stub.requestFails = true
  const p = newPage()
  p.build()
  await settle()
  await settle()
  assert.ok(
    texts().some((t) => t.indexOf('logs to upload') >= 0),
    'no on-screen warning about the stuck logs: ' + texts().join(' | ')
  )
})


await test('phone unreachable: the page lives on and the logs STAY', async () => {
  for (let i = 0; i < 20; i++) logEvent('ROW TO KEEP', { n: i, filler: 'x'.repeat(40) })
  globalThis.__stub.requestFails = true
  const p = newPage()
  p.build()
  await settle()
  await settle()
  assert.ok(readEvents().indexOf('ROW TO KEEP') >= 0, 'upload failed but files cleared: logs lost')
  assert.ok(texts().some((t) => t.indexOf('07:30') >= 0), 'the page must work regardless')
})

await test('diary almost empty: NO upload (no pointless traffic)', async () => {
  const p = newPage()
  p.build()
  await settle()
  const sent = (globalThis.__stub.requests || []).filter((r) => r.method === 'UPLOAD')
  assert.equal(sent.length, 0, 'it shipped nothing at all')
})

await test('while RINGING: no upload, zero extra work', async () => {
  for (let i = 0; i < 20; i++) logEvent('ROW', { n: i, filler: 'x'.repeat(40) })
  patch({ mode: 'ringing', rings: 1 })
  const p = newPage()
  p.build()
  await settle()
  const sent = (globalThis.__stub.requests || []).filter((r) => r.method === 'UPLOAD')
  assert.equal(sent.length, 0, 'shipping logs while it rings steals time from the ringing')
})

console.log('\n== the evening path, from start to finish ==')

await test('I open it, pick 6:45, press SET: everything is consistent', () => {
  const p = newPage()
  p.build()
  for (let i = 0; i < 23; i++) click('HOUR +1') // 7 -> 6 (full lap)
  for (let i = 0; i < 15; i++) click('MIN +1') // 30 -> 45
  assert.equal(p.state.h, 6)
  assert.equal(p.state.m, 45)
  click('SET')
  const s = load()
  const now = Math.floor(Date.now() / 1000)
  assert.equal(s.targetUnix, nextOccurrence(now, 6, 45))
  assert.equal(s.mode, 'alarm')
  assert.equal(alarmStub.__scheduled.length, ARM_ALARMS)
  assert.ok(texts().some((t) => t.indexOf('06:45') >= 0), 'the confirmed time does not appear')
  assert.ok(texts().some((t) => t.indexOf('ARMED') >= 0), 'the armed confirmation is missing')
})

await test('I reopen after arming: it still shows as armed', () => {
  const p1 = newPage()
  p1.build()
  click('SET')
  uiStub.__reset()
  const p2 = newPage()
  p2.build()
  assert.equal(p2.state.armed, true, 'an armed alarm must show as armed on reopening')
  assert.ok(texts().some((t) => t.indexOf('ARMED') >= 0))
})

await test('I open it WHILE it rings: the screen says to press DELETE', () => {
  patch({ mode: 'ringing', rings: 1, fired: 1 })
  const p = newPage()
  p.build()
  assert.ok(texts().some((t) => t.indexOf('RINGING') >= 0), 'no indication that it is ringing')
  click('DELETE')
  assert.equal(load().mode, 'idle')
})

await test('switching to the diagnostics page without breaking anything', () => {
  const p = newPage()
  p.build()
  click('debug')
  assert.deepEqual(globalThis.__stub.pushed, ['page/debug'])
})

await test('diagnostics unreachable: error on screen, alarm intact', () => {
  globalThis.__stub = { throwPush: true }
  const p = newPage()
  p.build()
  click('debug')
  click('SET')
  assert.equal(alarmStub.__scheduled.length, ARM_ALARMS, 'the alarm must work regardless')
})

console.log('\n----------------------------------------')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}

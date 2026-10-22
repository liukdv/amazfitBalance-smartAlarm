// Exercise the actual event log against the Zepp filesystem stub, including I/O failures.
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import * as fs from '@zos/fs'
import { logEvent, readEvents, diskSizes, clear, EVENTS_PATH } from '../probe/utils/log.js'

beforeEach(() => {
  globalThis.__stub = {}
  fs.__reset()
})

/** Seed a log left by an older installation without invoking the current logger. */
function seed(path, content) {
  const fd = fs.openSync({ path, flag: fs.O_RDWR | fs.O_CREAT })
  try {
    fs.writeSync({ fd, buffer: new TextEncoder().encode(content).buffer })
  } finally {
    fs.closeSync({ fd })
  }
}

test('sequential event writes preserve timestamps, order and structured data', () => {
  for (let i = 0; i < 200; i++) assert.equal(logEvent('EVENT', { n: i }), true)
  const lines = readEvents().trimEnd().split('\n')
  assert.equal(lines.length, 200)
  lines.forEach((line, i) => {
    assert.match(line, /^\d\d:\d\d:\d\d EVENT /)
    assert.deepEqual(JSON.parse(line.slice(15)), { n: i })
  })
  assert.equal(fs.__openCount(), 0)
})

test('event details cannot create extra lines and unserialisable data is tolerated', () => {
  logEvent('FIRST\nTAG', 'a\r\nb')
  const circular = {}
  circular.self = circular
  logEvent('SECOND', circular)
  const lines = readEvents().trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /FIRST TAG a  b$/)
  assert.match(lines[1], /SECOND \[not serialisable\]$/)
})

test('failed writes close every opened file', () => {
  logEvent('BEFORE')
  globalThis.__stub.throwFsWrite = true
  assert.equal(logEvent('WRITE FAILURE'), false)
  assert.equal(fs.__openCount(), 0)
  assert.match(readEvents(), /BEFORE/)
  assert.doesNotMatch(readEvents(), /WRITE FAILURE/)
})

test('failed reads close every opened file', () => {
  logEvent('BEFORE')
  globalThis.__stub.throwFsRead = true
  assert.equal(readEvents(), '')
  assert.equal(fs.__openCount(), 0)
})

test('failed opens do not escape to the alarm or leave handles open', () => {
  globalThis.__stub.throwFsOpen = true
  assert.equal(logEvent('OPEN FAILURE'), false)
  assert.equal(readEvents(), '')
  assert.equal(fs.__openCount(), 0)
})

test('FULL RESET removes events and the retired CSV from older installations', () => {
  logEvent('BEFORE')
  seed('probe.csv', 'old diagnostic samples\n')
  clear()
  assert.equal(fs.__get(EVENTS_PATH), null)
  assert.equal(fs.__get('probe.csv'), null)
  assert.equal(readEvents(), '')
  logEvent('AFTER')
  assert.match(readEvents(), /AFTER/)
  assert.doesNotMatch(readEvents(), /BEFORE/)
  assert.equal(fs.__get('probe.csv'), null)
})

test('failed clear fallback closes both files and preserves unwritten contents', () => {
  logEvent('BEFORE')
  seed('probe.csv', 'old diagnostic samples\n')
  globalThis.__stub = { throwFsRm: true, throwFsWrite: true }
  clear()
  assert.equal(fs.__openCount(), 0)
  globalThis.__stub = {}
  assert.match(readEvents(), /BEFORE/)
  assert.equal(fs.__get('probe.csv'), 'old diagnostic samples\n')
})

test('the cap retains complete recent lines and bounds the on-disk file at 16 KiB', () => {
  for (let i = 0; i < 1500; i++) logEvent('ROW', { n: i, filler: 'x'.repeat(90) })
  const content = readEvents()
  assert.ok(content.length <= 16 * 1024)
  assert.ok(fs.__get(EVENTS_PATH).length <= 16 * 1024)
  assert.match(content, /"n":1499,/)
  assert.doesNotMatch(content, /"n":0,/)
  for (const line of content.trimEnd().split('\n')) {
    assert.match(line, /^\d\d:\d\d:\d\d ROW /)
    assert.doesNotThrow(() => JSON.parse(line.slice(13)))
  }
  assert.equal(fs.__openCount(), 0)
})

test('a file padded by a failed deletion shrinks on the next successful write', () => {
  seed(EVENTS_PATH, 'OLD ROW\n'.repeat(2000))
  globalThis.__stub.throwFsRm = true
  clear()
  assert.equal(readEvents(), '')
  assert.ok(fs.__get(EVENTS_PATH).length > 10000)
  globalThis.__stub.throwFsRm = false
  logEvent('FIRST NEW ROW')
  assert.ok(fs.__get(EVENTS_PATH).length < 200)
  assert.match(readEvents(), /FIRST NEW ROW/)
})

test('permanently broken deletion still clears content without resurrecting old rows', () => {
  seed(EVENTS_PATH, 'OLD ROW\n'.repeat(200))
  globalThis.__stub.throwFsRm = true
  clear()
  assert.equal(readEvents(), '')
  logEvent('AFTER')
  assert.match(readEvents(), /AFTER/)
  assert.doesNotMatch(readEvents(), /OLD ROW/)
  assert.equal(fs.__openCount(), 0)
})

test('disk sizes use metadata without reading log contents', () => {
  assert.deepEqual(diskSizes(), { events: 0 })
  logEvent('EVENT')
  globalThis.__stub.fsReads = []
  assert.deepEqual(diskSizes(), { events: fs.__get(EVENTS_PATH).length })
  assert.deepEqual(globalThis.__stub.fsReads, [])
})

test('the next event shrinks an inherited large log while retaining recent entries', () => {
  seed(EVENTS_PATH, '00:00:00 OLD EVENT\n'.repeat(5000) + '00:00:00 RECENT EVENT\n')
  logEvent('NEW EVENT')
  assert.ok(fs.__get(EVENTS_PATH).length <= 16 * 1024)
  assert.match(readEvents(), /RECENT EVENT/)
  assert.match(readEvents(), /NEW EVENT/)
  assert.equal(fs.__openCount(), 0)
})

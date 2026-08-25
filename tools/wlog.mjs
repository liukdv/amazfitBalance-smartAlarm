// Reads the logs that arrived from the watch on the log server and makes them
// readable.
//   node tools/wlog.mjs           the latest events, summarised
//   node tools/wlog.mjs --csv     prints the sample CSV of the last upload
//   node tools/wlog.mjs --raw     raw JSON
//   node tools/wlog.mjs --clear   empties the log on the server
//
// The server is reached over SSH: set WLOG_SSH_HOST to your own host (or an
// entry in ~/.ssh/config), and WLOG_REMOTE_FILE if the path differs.
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const HOST = process.env.WLOG_SSH_HOST || 'wlog-server'
const REMOTE = process.env.WLOG_REMOTE_FILE || '/var/log/wlog/watch.jsonl'

function ssh(cmd) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, cmd], { encoding: 'utf8' })
}

if (args.includes('--clear')) {
  ssh('> ' + REMOTE)
  console.log('log emptied')
  process.exit(0)
}

let raw = ''
try {
  raw = ssh('cat ' + REMOTE + ' 2>/dev/null || true')
} catch (e) {
  console.error('server unreachable: ' + e.message)
  process.exit(1)
}

const events = raw
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch (e) {
      return { _unparsed: l }
    }
  })

if (!events.length) {
  console.log('no event received from the watch')
  process.exit(0)
}

if (args.includes('--raw')) {
  console.log(JSON.stringify(events, null, 1))
  process.exit(0)
}

const last = events[events.length - 1]

if (args.includes('--csv')) {
  console.log(last.csv || last.csvTail || '(no CSV)')
  process.exit(0)
}

if (args.includes('--events')) {
  console.log(last.events || '(no event diary)')
  process.exit(0)
}

console.log('events received: ' + events.length + '\n')
events.forEach((e, i) => {
  const when = (e._received || '').slice(11, 19)
  console.log('[' + (i + 1) + '] ' + when + ' UTC  reason: ' + (e.why || '?'))
})

console.log('\n--- LAST UPLOAD ---')
console.log('watch time: ' + (last.at || '?'))
if (last.device) console.log('device: ' + JSON.stringify(last.device))
if (last.perms) console.log('permissions: ' + JSON.stringify(last.perms))
console.log('queued alarms: ' + JSON.stringify(last.alarms))
if (last.state) {
  const s = last.state
  console.log(
    'state: mode=' + s.mode + ' ticks=' + s.ticks + (s.maxTicks ? '/' + s.maxTicks : '') +
      ' buzzes=' + s.fired + ' done=' + s.done
  )
  console.log('last decision: ' + (s.lastReason || '(none)'))
}
if (last.raw) console.log('sensor reading: ' + JSON.stringify(last.raw))
console.log('CSV: ' + (last.csvBytes || 0) + ' bytes · diary: ' + (last.eventsBytes || 0) + ' bytes')

// The diary is the part that says whether the SERVICE ever started at all.
const ev = (last.events || '').split('\n').filter(Boolean)
if (ev.length) {
  console.log('\n--- EVENT DIARY (last 25) ---')
  ev.slice(-25).forEach((l) => console.log('  ' + l))
  const svc = ev.filter((l) => l.indexOf(' SVC ') >= 0)
  console.log('\nservice lines in the diary: ' + svc.length)
} else {
  console.log('\n(no event diary in this upload)')
}

// The verdict on the service is read from the COUNTER, not from the diary: the
// diary can be incomplete, the counter cannot (state.json is rewritten whole).
// Concluding from the diary once meant declaring a live service dead.
if (last.state) {
  const t = last.state.ticks || 0
  console.log(
    'background service: ' +
      (t > 0 ? 'ACTIVE, ' + t + ' ticks executed' : 'no tick recorded')
  )
}

const tail = (last.csv || last.csvTail || '').split('\n').filter(Boolean)
if (tail.length > 1) {
  console.log('\nlatest samples:')
  tail.slice(-8).forEach((l) => console.log('  ' + l))
}

// The question that decides the project. The freshness_sec column is the 9th
// (index 8) of the schema in force since 22 Aug.
const dataRows = tail.slice(1).map((l) => l.split(','))
const fresh = dataRows.map((c) => Number(c[8])).filter((n) => !isNaN(n) && n > 0)
if (fresh.length) {
  const min = Math.min(...fresh)
  console.log(
    '\nSTAGE FRESHNESS: minimum ' + min + 's (' + Math.round(min / 60) + ' min) over ' + fresh.length + ' readings'
  )
  console.log(min <= 300 ? '  -> usable for an alarm' : '  -> too old, the alarm is not feasible')
} else {
  console.log('\nFRESHNESS: no stage classified yet (normal while awake)')
}

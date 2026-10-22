// Checks the built package: that all targets are there, that the app-service is
// inside (the build does NOT fail if it is missing) and that the test stubs did
// not end up in the real package.
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'probe', 'dist')
const WORK = join(ROOT, 'inspect', 'verify')

let problems = []
const ok = (m) => console.log('  ok   ' + m)
const bad = (m) => {
  problems.push(m)
  console.log('  FAIL ' + m)
}

const zabs = readdirSync(DIST)
  .filter((f) => f.endsWith('.zab'))
  .map((f) => ({ f, t: statSync(join(DIST, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)

if (!zabs.length) {
  console.log('no package in dist/ — run first: cd probe && zeus build')
  process.exit(1)
}

const zab = join(DIST, zabs[0].f)
console.log('\npackage: ' + zabs[0].f + '\n')

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
execFileSync('unzip', ['-o', '-q', zab, '-d', join(WORK, 'zab')])

const zpks = readdirSync(join(WORK, 'zab')).filter((f) => f.endsWith('.zpk'))
if (zpks.length === 3) ok('three targets in the package (Balance + Active 2 round + square)')
else bad('expected 3 targets, found ' + zpks.length)

const seenWidths = new Set()

zpks.forEach((zpk, i) => {
  const d = join(WORK, 'z' + i)
  execFileSync('unzip', ['-o', '-q', join(WORK, 'zab', zpk), '-d', d])
  const devZip = join(d, 'device.zip')
  if (!existsSync(devZip)) return bad('device.zip missing in target ' + i)
  const dev = join(WORK, 'dev' + i)
  execFileSync('unzip', ['-o', '-q', devZip, '-d', dev])

  const cfg = JSON.parse(readFileSync(join(dev, 'app.json'), 'utf8'))
  const w = cfg.designWidth
  seenWidths.add(w)
  const label = 'target ' + w + 'px'

  if (existsSync(join(dev, 'app-service', 'probe.bin'))) ok(label + ': app-service present')
  else bad(label + ': APP-SERVICE MISSING')

  if (existsSync(join(dev, 'page', 'index.bin'))) ok(label + ': alarm page present')
  else bad(label + ': alarm page missing')

  if (existsSync(join(dev, 'page', 'edit.bin'))) ok(label + ': time editor present')
  else bad(label + ': TIME EDITOR MISSING')

  if (existsSync(join(dev, 'page', 'debug.bin'))) ok(label + ': diagnostics page present')
  else bad(label + ': DIAGNOSTICS PAGE MISSING (tonight’s tests live there)')

  if (existsSync(join(dev, 'page', 'ring.bin'))) ok(label + ': RING PAGE present')
  else bad(label + ': RING PAGE MISSING (without it no vibration reaches the motor)')

  if (existsSync(join(dev, 'page', 'lookout.bin'))) ok(label + ': LOOKOUT present')
  else bad(label + ': LOOKOUT MISSING (without it nobody listens to the movement in the window)')

  const svc = cfg.module && cfg.module['app-service']
  if (svc && Array.isArray(svc.services) && svc.services.includes('app-service/probe'))
    ok(label + ': service declared in app.json')
  else bad(label + ': wrong app-service declaration')

  const perms = cfg.permissions || []
  ;['device:os.local_storage', 'device:os.alarm', 'device:os.bg_service', 'device:os.accelerometer', 'device:os.notification'].forEach((p) => {
    if (perms.includes(p)) ok(label + ': permission ' + p)
    else bad(label + ': missing permission ' + p)
  })

  if (perms.some((p) => p.startsWith('data:'))) bad(label + ': unused health-data permission')
  else ok(label + ': no health-data permissions')

  const nSources = (cfg.platforms || []).length
  if (nSources > 0) ok(label + ': ' + nSources + ' hardware variants covered')
  else bad(label + ': no hardware variant')

  if (w === 480) {
    const sources = (cfg.platforms || []).map((p) => p.deviceSource)
    if (sources.length === 3 && [8519936, 8519937, 8519939].every((id) => sources.includes(id)))
      ok(label + ': original Balance hardware variants covered')
    else bad(label + ': incorrect Balance hardware variants')
  }
})

if (seenWidths.has(480) && seenWidths.has(466) && seenWidths.has(390))
  ok('Balance (480), Active 2 round (466) and square (390) covered')
else bad('widths found: ' + [...seenWidths].join(', '))

// The test stubs live in test/stubs: if zeus ever bundled them, the app on the
// watch would run against fake sensors.
const grepHits = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else {
      const buf = readFileSync(p)
      if (buf.includes('__stub') || buf.includes('STUBS of the Zepp APIs')) grepHits.push(p)
    }
  }
}
walk(WORK)
if (!grepHits.length) ok('no test stub in the package')
else bad('TEST STUBS IN THE PACKAGE: ' + grepHits.join(', '))

console.log('\n----------------------------------------')
if (problems.length) {
  console.log(problems.length + ' problems')
  process.exit(1)
}
console.log('package verified, no problems')

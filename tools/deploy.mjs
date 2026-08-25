// The whole chain in one command: test -> build -> package check -> preview
// -> QR as PNG -> control decode.
//
// It exists because every step skipped here is a wasted round trip: you have to
// pick up the phone, scan, and open the app. The QR is not handed over unless it
// has first been verified as readable.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file: the project works wherever it is cloned.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TARGET = process.argv[2] || 'Amazfit Active 2 (Round)'
const OUTDIR = join(ROOT, 'inspect')
// Where the QR to scan is left. Override it with QR_DEST if you want it
// somewhere handier (a synced folder, the desktop, ...).
const DEST = process.env.QR_DEST || join(ROOT, '.tmp', 'QR-SmartAlarm.png')

const step = (n, s) => console.log('\n[' + n + '] ' + s)
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd: cwd || ROOT, encoding: 'utf8', stdio: 'pipe' })

try {
  mkdirSync(OUTDIR, { recursive: true })
  mkdirSync(dirname(DEST), { recursive: true })

  const suites = [
    ['test/run.mjs', 'logs and samples'],
    ['test/decide.mjs', 'alarm decision'],
    ['test/schedule.mjs', 'times and wake-up steps'],
    ['test/alarm-page.mjs', 'alarm screen'],
    ['test/service.mjs', 'service: simulated nights'],
    ['test/ring-page.mjs', 'ring page'],
    ['test/lookout.mjs', 'lookout: listening to movement'],
    ['test/threshold.mjs', 'threshold curve'],
  ]
  suites.forEach(([f, label], i) => {
    step(i + 1, 'test ' + label)
    const out = run('node', ['--import', './test/register.mjs', f])
    const m = out.match(/(\d+) passed, (\d+) failed/)
    console.log('    ok' + (m ? ' (' + m[1] + ' tests)' : ''))
  })

  step(3, 'build')
  run('zeus', ['build'], join(ROOT, 'probe'))
  console.log('    ok')

  step(4, 'package check')
  run('node', ['tools/verify-build.mjs'])
  console.log('    ok')

  step(5, 'preview for "' + TARGET + '"')
  const out = join(OUTDIR, 'preview-deploy.txt')
  const res = execFileSync('zeus', ['preview', '-t', TARGET], {
    cwd: join(ROOT, 'probe'),
    encoding: 'utf8',
    stdio: 'pipe',
  })
  writeFileSync(out, res)
  if (/login/i.test(res) && !/Login success/i.test(res)) {
    console.log('    ZEPP LOGIN REQUIRED in the browser — run again once done')
    process.exit(2)
  }
  const exp = (res.match(/expire on ([0-9-]+ [0-9:]+)/) || [])[1]
  console.log('    ok — QR valid until ' + (exp || '?'))

  step(6, 'QR -> PNG')
  run('node', ['tools/qr-to-png.mjs', out, join(OUTDIR, 'qr-deploy'), '12'])

  step(7, 'control decode')
  const dec = run('node', ['tools/qr-decode.mjs', out])
  const url = (dec.match(/content: (\S+)/) || [])[1]
  if (!url) throw new Error('QR generated but NOT decodable — not handing it over')
  console.log('    ok — ' + url.slice(0, 60) + '...')

  const png = join(OUTDIR, 'qr-deploy-a.png')
  if (!existsSync(png)) throw new Error('PNG not generated')
  writeFileSync(DEST, readFileSync(png))

  console.log('\n========================================')
  console.log('READY — QR to scan:')
  console.log(DEST)
  console.log('Zepp app: Device > General > Developer Mode > icon at the top right')
  console.log('========================================')
} catch (e) {
  console.error('\nFAILED: ' + (e.stdout || '') + (e.stderr || '') + (e.message || ''))
  process.exit(1)
}

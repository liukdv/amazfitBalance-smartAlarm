# amazfit-smart-alarm

A smart alarm for the **Amazfit Active 2** (Zepp OS 5), built as a Zepp mini app.

Amazfit removed the smart alarm from the Zepp app. This project rebuilds it: you
set a time, and in the 30 minutes before it the watch listens to your wrist and
rings at the first real movement — the moment you are already surfacing out of
sleep. If you never move, it rings at the exact time, like an ordinary alarm.

Status: **working**. It runs on a real watch and has been waking a real person up
since 23 August 2026. 225 tests across 8 suites cover the logic.

---

## Why movement and not sleep stages

The obvious idea is to read the sleep stages and ring during light sleep. It does
not work, for a structural reason: the staging algorithm classifies a minute
using the **two following minutes** as well, so the stretch in progress is always
provisionally marked "light" and rewritten afterwards. Read in real time, the
stages lie.

Every smart alarm that actually works looks at **movement** instead. So does this
one. Sleep stages are still read and written to the log every minute — so each
night leaves behind the evidence to re-examine the question — but they decide
nothing. The old stage route is preserved behind a switch (`useStages`).

## The problem this had to solve, and the trick that solved it

The accelerometer — the only sensor that really feels movement — is **forbidden
to background services** on Zepp OS. And `Wear.getStatus()`, which a background
service may read, never reports "moving" on this watch (tested: 161 readings with
the arm shaking, always "still"). In the background, the app is blind.

The way around it is the **lookout**: you do not need to see all night, only
during the good half hour. When the window opens the system opens a page
(`page/lookout.js`) that sits in the foreground with an almost black screen and
brightness at the minimum — invisible next to a sleeping person — and there the
accelerometer works, sampling the wrist 5 times a second. At the first real
movement it hands over to the ring page.

## The threshold curve

A still wrist reads ~1000 (that is gravity: the unit is thousandths of g). The
signal is the **deviation** from it: a light turn peaks around 100, a decisive
movement around 500, and the noise floor of a motionless body sits at 9-22.

The threshold to beat **drops as the alarm time approaches** — half an hour out
it takes a significant movement, in the last minute almost anything counts. Two
criteria run in parallel: a **peak** (three readings above the threshold within
three seconds — the jolt of turning over) and a **mean** over the last two
minutes (continuous restlessness the peak never sees). See
[`probe/utils/threshold.js`](probe/utils/threshold.js).

## Three safety nets

An alarm that fails to ring is a worse defect than an imprecise one, so nothing
depends on a single mechanism:

1. **The service chain** — a background service that re-arms itself at every
   wake-up (long steps during the night, one minute inside the window). A chain
   of single alarms, not one repeating alarm: if a link is dropped, the log shows
   a visible gap instead of a zombie service that quietly stopped recording.
2. **The ring page armed at the exact time**, independently of everything else.
   It goes through no service and no decision.
3. **The service again at the alarm time +5s**, which retries opening the page.

The lookout can die — screen switched off, app closed by hand — and the alarm
still rings.

## Commands

```bash
npm test      # 225 tests across 8 suites against stubs of the Zepp APIs
```

```bash
npm run deploy   # everything: test -> build -> verify -> QR as PNG -> control decode
```

`npm run deploy` is the normal command: if anything fails it stops **before**
producing the QR, so a broken package never gets scanned. The QR is written to
`.tmp/QR-SmartAlarm.png` (override with the `QR_DEST` environment variable) and
expires after 7 days.

Other targets: `npm run build`, `npm run verify` (checks the built package really
contains everything), `npm run check` (test + build + verify), `npm run bridge`
(interactive console to the device, live logs).

## Installing on the watch

1. In the Zepp app: **Profile → Settings → About** → tap the Zepp icon 7 times
   (once, to unlock developer mode).
2. `npm run deploy` → produces the QR as a PNG.
3. Zepp app: **Device → General → Developer Mode** → icon at the top right → scan
   the QR.
4. On the watch: top-right button → app list → **SmartAlarm**.

`probe/app.json` carries an `appId` tied to a Zepp developer account — replace it
with your own.

## Using it

The main screen is a plain alarm clock: the time in large type, the state below
it, and one gesture — **SET** when it is off, **DELETE** when it is armed. Two
buttons adjust the time (+1 hour, +1 minute, both wrapping). Changing the time
switches the alarm off, so what you see is always what will ring.

When it rings: one big **STOP** button. It insists — three rounds a minute apart —
because a single buzz during sleep wakes nobody.

Behind `debug` there is a diagnostics screen: window width, test screen, log
verbosity, a manual buzz, and a full reset. **A test is a real alarm with a short
window** — set the window to 1 minute, go back, set the alarm two minutes ahead.
There is deliberately no separate "test mode": two routes can drift apart.

## Getting the logs off the watch

There is no console on a watch, so the debugging is designed into the app: it
writes a sample CSV and an event diary, and ships them to a small HTTP receiver
through the phone. [`server/`](server/) holds that receiver (a ~100-line Python
script, a systemd unit, and an nginx snippet); `tools/wlog.mjs` reads what
arrived. Before using it, put your own host and a random token into
[`probe/app-side/index.js`](probe/app-side/index.js) and
[`server/wlog.service`](server/wlog.service) — the placeholders are inert.

If you do not want any of this, ignore `server/`: the alarm works without it.

## Layout

```
probe/
  app.json              targets: round (466px, 8 variants) and square (390px, 3 variants)
  app.js                app entry point
  page/index.js         main screen: pick the time, SET / DELETE
  page/lookout.js       the lookout: listens to the accelerometer inside the window
  page/ring.js          the ring page: the only place vibration reaches the motor
  page/debug.js         diagnostics
  app-service/probe.js  background service, re-arms itself every tick
  app-side/index.js     runs inside the Zepp app on the phone: ships the logs out
  utils/                decision, thresholds, scheduling, storage, logging
test/                   8 suites run against the real sources
test/stubs/             stubs of the @zos APIs
tools/                  build, package verification, QR, log reading
server/                 the log receiver
```

## Decisions worth knowing about

**`file`/`date`, not `url`/`delay`.** The online documentation for `@zos/alarm`
uses `url` and `delay`; the official template shipped with the installed CLI uses
`file` and `date`. The template wins — it is the one aligned with the runtime.

**`"services"`, not `"app-service"`.** Inside `module["app-service"]` the right
key is `services`. With the wrong key **the build still succeeds** but the
service never makes it into the package. That is why `npm run verify` exists.

**Vibration only works in the foreground.** A background service can command a
buzz, log "ok", and the motor never moves. That is why the service opens a page
instead of buzzing itself.

**Design decisions live in the code, not in the saved state.** `state.json`
survives app updates and stored values beat new defaults — the watch once kept
using a threshold of 250 while the source said 200, silently. Only genuine user
settings are persisted.

**Timestamps are normalised.** `getStage()` returns milliseconds, seconds, or
minutes depending on the version; `toUnixSeconds()` recognises the format from
its order of magnitude.

## Known limits

- Tested on one device: an Amazfit Active 2 (round). The square target builds but
  has never been installed.
- Battery cost of the lookout (screen on, accelerometer at 5 Hz, up to 30 min a
  night) is noticeable but was acceptable in practice; it has not been measured
  rigorously.
- The 600ms-per-run limit for an app service is not verifiable dry.
- The tests run against stubs. That the watch runtime behaves like the stubs is
  only ever verified by installing.

## License

MIT — see [LICENSE](LICENSE).

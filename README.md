# amazfit-smart-alarm

A smart alarm for the **Amazfit Active 2** (Zepp OS 5), built as a Zepp mini app.

Also includes an **Amazfit Balance (original, round, 480×480)** target for Zepp OS 4.
Balance support is experimental: packaging is configured, but alarm delivery,
movement thresholds and battery use still need testing on a real Balance.

Amazfit removed the smart alarm from the Zepp app. This project rebuilds it: you
set a time, and in the 30 minutes before it the watch listens to your wrist and
rings on confirmed wrist activity. Movement is a proxy for a favorable wake-up
moment, not a reliable identification of a sleep stage. If no activity qualifies,
it rings at the exact time, like an ordinary alarm.

Status: **working**. It runs on a real watch and has been waking a real person up
since 23 August 2026. Tests across 9 suites cover the logic; the new motion
sensitivity presets still need calibration on the original Balance.

---

## Sensors and permissions

The alarm uses wrist acceleration and the configured time window. It does not
read sleep stages, heart rate, breathing or wear status, including in VERBOSE
mode. The app requests no health-data permissions. It retains permissions for
local storage, alarms, background services, the accelerometer and notifications.

## The problem this had to solve, and the trick that solved it

The accelerometer — the only sensor that really feels movement — is **forbidden
to background services** on Zepp OS, so movement detection runs in a foreground
page while the background service enforces the alarm deadline.

The way around it is the **lookout**: you do not need to see all night, only
during the good half hour. When the window opens the system opens a page
(`page/lookout.js`) that sits in the foreground with an almost black screen and
brightness at the minimum — invisible next to a sleeping person — and there the
accelerometer works, sampling the wrist 5 times a second. At the first real
movement it hands over to the ring page.

## Movement sensitivity through the window

Activity is the magnitude of the change between consecutive XYZ accelerometer
vectors, sampled at 5 Hz. This includes wrist rotations even when total
acceleration stays near gravity. A constant sensor offset is not movement.

The threshold decreases gradually from **120% to 80% of the selected preset**
over the configured smart window, making the alarm slightly less sensitive at
its start and more sensitive near the target time. Three readings above the
current threshold are required within a sliding three-second interval, with at
least 500 ms between confirmations so one short twitch is insufficient. The first valid sample
only establishes a baseline; invalid readings or a gap longer than one second
reset the baseline and confirmations. The exact-time alarm remains independent.

In **debug → SENSITIVITY**, tap to cycle NORMAL → HIGH → LOW. HIGH requires
smaller movements. The presets use 50, 25 and 100 mg respectively, as initial
values to test on the watch rather than validated sleep-stage boundaries.
NORMAL therefore goes from 60 mg at the start to 50 mg halfway through and
40 mg near the deadline. The ramp uses the alarm's own window and target time,
including when listening starts late. The choice is saved globally and applies
when the next listening window opens.
Old numeric thresholds from earlier versions are ignored. TEST SCREEN shows
current movement, the current threshold and confirmations; the log records the
metric, preset, threshold and minute summaries. See
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
npm test      # 9 suites against stubs of the Zepp APIs
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

Install the build tools and dependencies once (Node.js 20+ and `unzip` required):

```bash
npm install -g @zeppos/zeus-cli
npm install
npm ci --prefix probe
zeus login
```

`npm run deploy` selects the original **Amazfit Balance** by default.
For Active 2 round, use `npm run deploy -- "Amazfit Active 2 (Round)"`;
the existing Active 2 targets remain available.

1. In the Zepp app: **Profile → Settings → About** → tap the Zepp icon 7 times
   (once, to unlock developer mode).
2. `npm run deploy` → produces the QR as a PNG.
3. Zepp app: **Device → General → Developer Mode** → icon at the top right → scan
   the QR.
4. On the watch: top-right button → app list → **SmartAlarm**.

`probe/app.json` carries an `appId` tied to a Zepp developer account — replace it
with your own.

## Using it

The main screen lists saved alarms, each with its own **ON/OFF** button.
Tap the time to edit it, or **+ ADD ALARM** to create another. Swipe the hour
and minute wheels; alternatively, select **HOUR** or **MINUTE** and turn the
crown. A bottom strip follows the display edge, split vertically into **DELETE**
on the left (red) and **SAVE** on the right (green). Swipe back to discard the
draft. **DELETE** removes only that alarm. New alarms are enabled; editing preserves ON/OFF.

Use **DAYS** to select any combination of Monday through Sunday, then **DONE**
and **SAVE**. Beside Sunday, **Weekdays** selects Monday–Friday and **Weekend**
selects Saturday–Sunday, replacing the current selection. You can then adjust
individual days. Selected days repeat every week; no selected days means **Once**,
the default for a new alarm. Deselect all days to return to a single-use alarm.
Day selection stays in the draft until SAVE; swiping back
discards both time and day changes. Existing alarms remain single-use until you select days.

Use **BEDTIME** to configure a reminder for that alarm. Switch **REMINDER** to
**ON**, choose the duration using **HOURS** and **MINUTES** with the same wheels
or crown, then **DONE → SAVE**. The range is 1 minute to 23 hours 59 minutes; OFF
is the default. These are duration fields, not a bedtime clock. For example,
07:30 with an 08:00 offset sends **Time to sleep** at 23:30 the previous evening.
In both the day and reminder selectors, **DONE** fills the bottom strip.
Swiping back discards the draft, including the reminder setting.

The reminder is a local watch notification, with a gentle vibration request,
scheduled from the alarm's final time. It needs the `device:os.notification`
permission and does not require the phone. Delivery and vibration still depend
on the watch firmware and notification settings. Repeat days apply to the
wake-up day: a Monday alarm can remind you on Sunday. Each repeated occurrence
schedules its own reminder; OFF/delete cancels future reminders for that alarm.
If its reminder time has already passed when an occurrence is scheduled, that
reminder is skipped. Callbacks more than 15 minutes late are also ignored.
Offsets use elapsed hours, including across daylight-saving changes.

If scheduling the reminder fails, the editor reports it while keeping the
wake-up alarm ON. For a quick device test, use a wake-up time five minutes ahead
with a three-minute bedtime offset and a smart window of zero.

For a recurring alarm, **STOP** dismisses the current occurrence and schedules
the next selected day, even when the smart alarm rang before its deadline.
**OFF** in the list disables the entire recurrence; switching it on again keeps
the selected days. If nobody presses STOP, the service schedules the next
occurrence ten minutes after the deadline, allowing the vibration rounds to finish.
The smart-window setting in debug applies when an alarm is enabled or saved;
automatic repetitions preserve that alarm's window.

When it rings, the big **STOP** button stops that alarm only. Other alarms retain
their own service and exact-time failsafes. Overlapping smart windows share the
one foreground accelerometer page: the earliest alarm is monitored first, and
STOP hands over to the next open window. Each alarm retains its own deadline.
The service still insists for three rounds a minute apart.

Version 0.5.0 / diagnostics v18 adds a separate bedtime reminder per alarm.
The automated tests and Zeus build do not validate firmware behavior: crown,
scrolling, recurring and simultaneous alarms, notifications, and background wake-up still need
a test on the physical Balance.

Swipe left on the alarm list to open diagnostics: window width, sensitivity, test screen, log
verbosity, a manual buzz, and a full reset. New settings default to MINIMAL; an
existing VERBOSE preference is preserved until changed here. **A test is a real alarm with a short
window** — set the window to 1 minute, go back, set the alarm two minutes ahead.
There is deliberately no separate "test mode": two routes can drift apart.

## Local diagnostics

Logs stay on the watch; the app does not upload them or run a phone-side service.
The alarm list does not read log contents or sample sleep data when it opens.
MINIMAL keeps alarm events and errors; VERBOSE adds service details and movement
summaries. STATE shows the event log size, and FULL RESET clears it together
with the saved alarms and any retired sample CSV. The 16 KiB size cap discards
the oldest log entries and limits the amount rewritten during UI actions.

## Layout

```
probe/
  app.json              targets: Balance (480px), Active 2 round (466px) and square (390px)
  app.js                app entry point
  page/index.js         saved alarms and independent ON/OFF controls
  page/edit.js          time wheels, crown, repeat days, save and delete
  page/lookout.js       the lookout: listens to the accelerometer inside the window
  page/ring.js          the ring page: the only place vibration reaches the motor
  page/debug.js         diagnostics
  app-service/probe.js  background service, re-arms itself every tick
  utils/                decision, thresholds, scheduling, storage, logging
test/                   9 suites run against the real sources
test/stubs/             stubs of the @zos APIs
tools/                  build, package verification and QR
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
- The original Balance target includes deviceSource 8519936, 8519937 and 8519939.
  It requires API_LEVEL 3.0 or newer; Zepp OS 4 on Balance supports this.
  Before relying on it, test movement-triggered waking and the exact-time
  fallback with a short window, including while Sleep Mode is enabled.
- Battery cost of the lookout (screen on, accelerometer at 5 Hz, up to 30 min a
  night) is noticeable but was acceptable in practice; it has not been measured
  rigorously.
- The 600ms-per-run limit for an app service is not verifiable dry.
- The tests run against stubs. That the watch runtime behaves like the stubs is
  only ever verified by installing.

## License

MIT — see [LICENSE](LICENSE).

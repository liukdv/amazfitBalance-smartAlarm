# SmartAlarm for Amazfit Balance

A Zepp OS smart alarm developed for the **original Amazfit Balance**, with a
round 480 × 480 display and Zepp OS 4. This is a modified version of
[Stefano Pochet's amazfit-smart-alarm](https://github.com/stefanopochet/amazfit-smart-alarm),
which originally targeted the Amazfit Active 2.

The app can wake you with vibration when it detects wrist activity during a
window before your chosen time. A separate timer targets the chosen time even
if no movement qualifies. Movement is a heuristic for choosing when to wake;
the app does not identify sleep stages or guarantee an optimal wake-up moment.

## Features and device support

- Multiple alarms with independent ON/OFF controls.
- Single-use alarms or weekly repetition on selected days.
- A bedtime reminder for each alarm, with an adjustable advance notice.
- Time wheels and crown input, with the selected value in the middle row.
- A configurable smart window and three movement sensitivity presets.
- Local diagnostics; no server setup or phone-side service.

| Device | Display width | Status in this fork |
| --- | --- | --- |
| Amazfit Balance, original model | 480 px | Development and manual testing device: Zepp OS 4, reported API_LEVEL 307 (3.7) |
| Amazfit Active 2, round | 466 px | Build target retained; current changes have not been tested on this hardware |
| Amazfit Active 2, square | 390 px | Build target retained; current changes have not been tested on this hardware |

Balance 2 is not configured as a target. The manifest declares API 3.0 as the
minimum and API 4.0 as the target; this does not establish compatibility with
other watch models.

The app version and device targets are defined in [probe/app.json](probe/app.json).
The version is also shown in the on-watch diagnostics screen. Automated tests
use simulated Zepp APIs; overnight reliability, battery consumption and
firmware-specific behavior still require testing on the watch.

## Build and install

Development builds have used Node.js 24 and Zeus CLI 1.9.3. You also need npm,
`unzip` for package verification, and a Zepp developer account.

From the repository root, install the tools and dependencies:

```bash
npm install -g @zeppos/zeus-cli@1.9.3
npm install
npm ci --prefix probe
zeus login
```

The global command installs Zeus under your configured npm prefix. The other
two install project dependencies into `node_modules/` and `probe/node_modules/`.
Make sure `zeus` and `unzip` are available on your shell's PATH.

For your own build, register an app in the
[Zepp developer console](https://developer.zepp.com/) and set `app.appId` in
[probe/app.json](probe/app.json) to the ID assigned to that app. This is an app
identifier, not a password. See Zepp's
[app registration instructions](https://docs.zepp.com/docs/distribute/#app-registration).

On the phone, enable developer mode in Zepp: **Profile → Settings → About**,
then tap the Zepp icon seven times. Menu names can vary between versions;
see the [official developer-mode guide](https://docs.zepp.com/docs/guides/tools/zepp-app/).

Generate a preview for the original Balance:

```bash
npm run deploy
```

This runs all nine test suites, builds the app, checks the packages, creates a
Zeus device preview, and generates a QR image. On success it prints `READY` and
writes `.tmp/QR-SmartAlarm.png`. The terminal also shows the preview's expiry.
Use the QR from a successful run; a failed run can leave an older image in place.

With the watch connected to Zepp, open the device's **Developer Mode**, choose
the QR scan action, and scan the image. Then open **SmartAlarm** from the watch's
app list and grant the requested permissions.

The `deploy` command creates a development preview; store submission is a
separate process. Set `QR_DEST` to change the output image path. To build a
preview for the retained Active 2 round target instead:

```bash
npm run deploy -- "Amazfit Active 2 (Round)"
```

On NixOS, if only `unzip` is missing, you can supply it for the command with:

```bash
nix-shell -p unzip --run 'npm run deploy'
```

## Set an alarm

The main screen lists saved alarms. Tap a time to edit it, **+ ADD ALARM** to
create another, or its **ON/OFF** button to enable or disable it.

Swipe the hour and minute wheels. The highlighted middle row is the selected
value. You can also select **HOUR** or **MINUTE** and turn the crown.

The bottom of the round display contains **DELETE** on the left in red and
**SAVE** on the right in green. DELETE is available for existing alarms. SAVE
applies the entire draft; new alarms are enabled, while editing preserves the
alarm's ON/OFF state. Swipe back to leave without saving.

### Repeat days

Open **DAYS** and select individual weekdays. The last row contains **Sun**,
**Weekdays** and **Weekend**:

- **Weekdays** replaces the selection with Monday–Friday.
- **Weekend** replaces it with Saturday–Sunday.
- Individual days remain editable after using either preset.
- No selected days means **Once**, the default for a new alarm. Deselect all
  days to return to a single-use alarm.

Selected days are highlighted. **DONE**, across the bottom edge, returns to the
alarm editor; **SAVE** is still needed to apply the changes.

For a repeating alarm, **STOP** dismisses the current occurrence and schedules
the next selected day. **OFF** disables the recurrence and preserves its
settings. If STOP is not pressed, a separate callback schedules the next
occurrence ten minutes after the target time.

### Bedtime reminder

Open **BEDTIME**, turn **REMINDER** on, and choose how long before the alarm to
notify you. **HOURS** and **MINUTES** select a duration, from 1 minute to
23 hours 59 minutes. Press **DONE**, then **SAVE**. The reminder is off by default.

For example, an alarm at 07:30 with an 08:00 advance notice schedules
**Time to sleep** for 23:30 the previous evening. Repeat days refer to the
wake-up day, so a Monday alarm can remind you on Sunday evening. The offset is
an elapsed duration, including across daylight-saving changes.

The reminder requests a local watch notification and vibration. Delivery and
vibration depend on the firmware and notification settings. A reminder whose
time has already passed when the alarm is scheduled is skipped, as are
callbacks arriving more than 15 minutes late. Disabling or deleting the alarm
cancels its pending reminder. A reminder scheduling failure is reported while
keeping the wake-up alarm enabled.

## Smart window and diagnostics

Swipe **right to left on the alarm list** to open diagnostics. Scroll to reach
all controls.

| Control | Purpose |
| --- | --- |
| STATE | Show alarm status, counters, the next target and local event-log size |
| WINDOW +1 | Cycle from 0 to 60 minutes; the default is 30. Zero selects an ordinary alarm without movement monitoring |
| SENSITIVITY | Cycle NORMAL → HIGH → LOW. HIGH responds to smaller movements; NORMAL is the default |
| TEST SCREEN | Show readable movement values while monitoring; NO uses a dim display. It changes the presentation, not the wake-up algorithm |
| BUZZ | Try the alarm vibration directly |
| LOG | Select MINIMAL or VERBOSE local logging; MINIMAL is the default |
| STOP EVERYTHING | Disable all saved alarms and cancel their timers |
| FULL RESET | Remove alarms from the list, cancel their timers, reset preferences and clear local logs |

The window setting is copied into an alarm when it is saved or enabled.
Changing it does not update already-armed alarms; save or re-enable those to
apply it. Automatic repetitions retain that alarm's window. Sensitivity and
test-screen settings are read when movement monitoring starts.

### How movement triggers the alarm

During the window, `page/lookout.js` runs in the foreground, keeps the display
on at low brightness, and reads the accelerometer every 200 ms (5 Hz). The
background service handles scheduled checks, bedtime notifications, repeated
occurrences and deadline recovery; it does not sample movement.

Activity is the magnitude of the difference between consecutive XYZ
accelerometer readings, including changes caused by wrist rotation. The base
thresholds are 25 mg for HIGH, 50 mg for NORMAL and 100 mg for LOW.

The threshold decreases from 120% of the base at the start of the window to
80% at the target time. For NORMAL, that is 60 mg down to 40 mg. Three readings
above the current threshold are needed within a rolling three-second interval,
with at least 500 ms between counted readings. This reduces triggering from a
single short twitch. Invalid readings or a gap longer than one second reset
the detector. See [probe/utils/threshold.js](probe/utils/threshold.js).

The app schedules the alarm page independently at the target time and a
background fallback check five seconds later. These timers remain separate
from movement monitoring. They improve resilience but still depend on Zepp OS
delivering the scheduled callbacks.

Overlapping windows share one foreground monitoring page, prioritizing an
already ringing alarm or the earliest target. Each alarm retains its own
deadline timers. STOP dismisses that alarm only and can hand over to another
pending alarm. Leaving a monitoring or ringing page is not equivalent to STOP.

The algorithm uses **only acceleration and time**. It does not read heart rate,
breathing, sleep stages or wear status. The sensitivity values are heuristics,
not validated boundaries between sleep stages.

## Data and permissions

Alarm settings and event logs stay in the app's storage on the watch. There is
no data-upload feature, server component or phone-side app service. The app
requests these permissions in its manifest:

- `device:os.local_storage`
- `device:os.alarm`
- `device:os.bg_service`
- `device:os.accelerometer`
- `device:os.notification`

MINIMAL logs retain important events and errors. VERBOSE adds service details
and movement summaries. The event log is capped at approximately 16 KiB,
discarding older entries. It is not a continuous recording of sensor samples.

The repository's `.gitignore` excludes dependencies, build packages, local
inspection output and preview QR files (`node_modules/`, `probe/dist/`,
`inspect/`, `.tmp/`).

## Development and verification

Run these commands from the repository root:

| Command | Action |
| --- | --- |
| `npm test` | Run nine suites against the app sources with Zepp API stubs |
| `npm run build` | Build all configured targets with Zeus |
| `npm run verify` | Inspect the latest build for targets, pages, service, permissions and accidental test-stub inclusion |
| `npm run check` | Run tests, build and package verification |
| `npm run deploy` | Run the checks and generate an installation preview QR |
| `npm run bridge` | Open Zeus's interactive bridge for device debugging |

For bridge debugging, Zeus and the Zepp phone app must use the same account.

The tests cover time arithmetic, independent alarms, recurrence, reminders,
movement detection, UI actions, logging and simulated service/page lifecycles.
They cannot validate actual vibration, notification delivery, firmware timing
or battery consumption. The dim monitoring page still keeps the display and
accelerometer active during the window; its battery cost has not been measured.

Useful short checks on a real watch:

1. Set WINDOW to 0, save an alarm a few minutes ahead, and check the target-time
   vibration and STOP behavior.
2. Set WINDOW to 1 and TEST SCREEN to YES, then save an alarm two minutes ahead.
   Wait for monitoring to open and check movement triggering and the fallback
   if no movement qualifies. Return TEST SCREEN to NO for night use.
3. With WINDOW at 0, set an alarm five minutes ahead and a three-minute bedtime
   offset. Check the reminder before the alarm.

These checks exercise the actual alarm path. Recurrence, overlapping alarms,
Sleep Mode and longer overnight use also need device testing.

### Source layout

```text
probe/
  app.json              App version, permissions and device targets
  app.js                App entry point and alarm launch context
  page/index.js         Alarm list and ON/OFF controls
  page/edit.js          Time, day and bedtime editors
  page/lookout.js       Foreground movement monitoring
  page/ring.js          Alarm screen, vibration and STOP
  page/debug.js         Settings and local diagnostics
  app-service/probe.js  Scheduled service callbacks
  utils/                Alarm state, scheduling, thresholds, storage and logs
test/                   Automated tests and Zepp API stubs
tools/                  Build verification, preview QR and development helpers
```

## License

MIT — see [LICENSE](LICENSE). The original copyright notice for Stefano Pochet
is retained. Dependencies retain their own licenses, including Apache-2.0 for
`@zeppos/zml`.

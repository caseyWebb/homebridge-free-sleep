# homebridge-free-sleep

Control an Eight Sleep Pod from Apple Home — **locally**, with no Eight Sleep account and no
cloud.

## What this is

[free-sleep](https://github.com/throwaway31265/free-sleep) replaces the firmware on an Eight
Sleep Pod with an open-source server that runs on the Pod itself and exposes a local REST
API. This plugin bridges that API into HomeKit.

Every other Eight Sleep HomeKit plugin authenticates against Eight Sleep's **cloud** with
your account credentials. That is exactly what free-sleep exists to avoid, and it does not
work at all on a Pod that has been firewalled off from the internet — which is the
recommended free-sleep setup. This plugin talks only to your Pod, on your LAN.

## Status: 0.3.0 published, M1–M4 complete — M5 (release) in progress

The full feature set is implemented and shipped to npm. Every side of the bed is a HomeKit
**Thermostat** (Off/Auto, 55–110°F) driven from a live cache of the Pod's status, plus:

- **Alarm events** — a per-side "Alarm" event (fires "When … is pressed" in the Home app's
  automation picker) and a "Dismiss Alarm" switch, backed by a scheduler that briefly polls the
  Pod faster around each predicted alarm instant so the short-lived vibration event is not missed
  (`alarmEvents`, on by default).
- **Away Mode** and **Skip Next Alarm** switches per side (`awayModeSwitch`/`skipAlarmSwitch`,
  both on by default), debounced and rate-limited against the Pod's expensive settings write.
- **Occupancy sensor** per side, opt-in via `occupancySource: 'presence' | 'vitals'` (default
  `'none'` — zero extra polling until you opt in), with proof-of-life `StatusActive` semantics so
  a dead detection stream can never masquerade as "Not Occupied".
- **Hub accessory**: a "Pod Connection" contact sensor that reports reachability and handles the
  Pod's daily reboot gracefully (last-known values served through the outage; nothing throws "No
  Response" for a routine restart), an always-published "Water Level" sensor (contact or leak
  style, `waterLowSensorType`), and four opt-in extras each gated by its own config key —
  "Prime" (a switch), "LED" (a lightbulb), per-side "Test Alarm" switches, and a "Server Fault"
  sensor.
- **(Unreleased)** Every HAP service on every accessory now carries its own distinct tile label
  in the Home app instead of a shared accessory-name fallback — see the ConfiguredName section
  of [docs/HOMEKIT.md](docs/HOMEKIT.md) and the `[Unreleased]` entry in
  [CHANGELOG.md](CHANGELOG.md).

Implemented and tested against **free-sleep v2.1.5**. See
[docs/ROADMAP.md](docs/ROADMAP.md) for the milestone history and what remains for M5, and
[CHANGELOG.md](CHANGELOG.md) for what changed in each release.

### Honesty caveat — read this before installing

This plugin has been extensively tested against a behavioral mock of the Pod's API and against
real API responses captured from a physical Pod 3. Core thermostat control has been paired and
verified end-to-end against a real Home app (the archived `thermostat-and-offline` change,
[#9](https://github.com/caseyWebb/homebridge-free-sleep/issues/9)/[#11](https://github.com/caseyWebb/homebridge-free-sleep/issues/11)).

**Everything shipped since then is implemented and covered by the test suite, but the specific
real-hardware confirmations below are still open** — tracked in
[#36](https://github.com/caseyWebb/homebridge-free-sleep/issues/36):

- **Offline handling**: a free-sleep restart on the Pod flips the connection sensor exactly
  twice; the same across the Pod's real daily reboot; whether a long (>10 min) outage's "No
  Response" escalation recovers promptly on reconnection or latches until the Home app is
  force-quit (this decides whether `noResponseAfterMs` should default to `0`); whether
  `StatusFault`/`StatusActive` surface anywhere in the Home app or only in Eve-class clients.
- **Slider drag**: a full-range (55→110°F) continuous drag on the real device never visibly
  snaps back mid-drag or after release (CI proves this against a mock with a virtual clock; this
  is the real-world confirmation).
- **Occupancy**: presence/vitals transitions flip the sensor within the expected window and
  `StatusActive` latches correctly on first real detection; the sensor stays inactive-but-quiet
  when biometrics is disabled on the Pod.
- **Hub extras**: a real prime cycle tracks and self-corrects on the tile; LED brightness slider
  feel (~5s settle is expected); each per-side Test Alarm fires only its own side; water-low
  reads correctly against the actual tank state; the server-fault sensor stays quiet in normal
  operation.
- **Alarm timing**: a real scheduled alarm produces a single press within ~3s of vibration start
  and Dismiss stops it; the documented DST caveat (our skipped-wall-clock resolution differs from
  `moment-timezone`'s by one hour for an alarm scheduled inside the transition hour — pinned by
  regression tests, at most one shifted prediction per transition).
- **Settings switches**: Away Mode toggled from the Home app agrees with the Pod's own UI, and
  with `awayModeTurnsSideOff` the side actually powers down first; Skip Next Alarm suppresses a
  real alarm and drops back to off afterward, and is refused in the dead window between a fired
  alarm and the following noon.
- **Service ConfiguredName** (unreleased, #49): every tile shows a distinct label rather than
  the accessory-name fallback, and a Home-app rename survives a plugin restart — traced through
  the installed HAP-NodeJS/Homebridge source, but confirmation on a real paired install is a
  post-merge follow-up, not a blocker.

None of the above are known bugs — they are real-hardware confirmations of behavior already
covered by the automated test suite against a behavioral mock. Treat the plugin as **stable but
not yet fully hardware-confirmed** until #36 closes.

## Requirements

- An Eight Sleep Pod running [free-sleep](https://github.com/throwaway31265/free-sleep)
  (tested against Pod 3 / free-sleep 2.1.5; Pod 1 and 2 are not supported by free-sleep).
- Node >=22 and Homebridge 2.x, on **separate always-on hardware** — a NAS, a Mac mini, a Pi.
  Not the Pod: it reboots daily and is memory-constrained.
- The Pod reachable on your LAN. A **static DHCP reservation for the Pod is strongly
  recommended** — this plugin identifies the Pod by the configured hostname/IP, and an address
  that changes underneath it will look like a permanent outage.

## Install

```sh
npm install -g @caseywebb/homebridge-free-sleep
```

Or, from the Homebridge UI's **Plugins** search box, type the exact scoped package name:

```
@caseywebb/homebridge-free-sleep
```

The UI matches a scoped package name (`@scope/homebridge-*`) directly against the npm registry,
bypassing its own search index entirely — so this works immediately after publish. Generic
terms like "free sleep" or "eight sleep" will **not** find it yet: that is npm's own
search-index lag catching up to a new package (typically hours, no fixed SLA), not something a
`keywords`/metadata change can fix. If you've already typed a generic term with no luck, try
the exact name above instead of waiting.

## Configuration

Minimal config — everything but `host` is optional:

```json
{
  "platforms": [
    {
      "platform": "FreeSleep",
      "host": "192.168.1.50"
    }
  ]
}
```

`sides` lets you publish only one side if the other is unused:

```json
{
  "platforms": [
    {
      "platform": "FreeSleep",
      "host": "192.168.1.50",
      "sides": "left"
    }
  ]
}
```

### Config keys

| Key | Type | Default | Notes |
|---|---|---|---|
| `host` | string | *(required)* | Pod's LAN hostname or IP. Normalized to lowercase. |
| `sides` | `'both'` \| `'left'` \| `'right'` | `'both'` | Which side accessories to publish. |
| `pollIntervals.*` | object | see `config.schema.json` | Advanced poll/write timing overrides (base/fast/slow poll intervals, backoff ceiling, write debounce, plus `deviceWriteDebounceMs` below). Most installs should leave these alone. |
| `pollIntervals.deviceWriteDebounceMs` | number (ms) | `500` | Write debounce for the device-wide lane specifically (currently only the LED lightbulb writes on it), independent of the side lanes' own write debounce. Minimum `500`. |
| `pollIntervals.alarmPollIntervalMs` | number (ms) | `3000` | The `deviceStatus` polling interval used while a fast-poll window is active around a predicted alarm instant (see `alarmEvents` below). Minimum `3000`. |
| `writeSettleMs` | number (ms) | `15000` | How long a write's optimistic value is protected from being overwritten by an in-flight poll. |
| `noResponseAfterMs` | number (ms) | `600000` | How long the Pod must be unreachable before thermostat reads start throwing instead of serving last-known values. `0` disables escalation. |
| `occupancySource` | `'none'` \| `'presence'` \| `'vitals'` | `'none'` | Publishes an `OccupancySensor` per enabled side, driven by the chosen source. `'none'` (default) publishes no sensor at all. Both sources require biometrics enabled on the Pod; `StatusActive` reports inactive until the source has proven itself live this launch (a real presence transition, or any vitals row ever), so the sensor is never confidently, permanently wrong. Disabling biometrics on the Pod itself takes up to `pollIntervals.slowPollIntervalMs` (~5 minutes by default) to take effect here, since that's how often this plugin re-checks it. See `docs/HOMEKIT.md`'s "Occupancy" section for the trust-signal detail per source. |
| `waterLowSensorType` | `'contact'` \| `'leak'` | `'contact'` | Chooses which HomeKit service type represents the hub's water-low sensor — a `ContactSensor` (default) or a `LeakSensor`. The sensor itself is always published, regardless of this setting or any other config key. |
| `primeSwitch` | boolean | `false` | Publishes a "Pod Prime" switch on the hub. Turning it on starts a prime cycle; the Pod has no stop command, so turning it off is refused (surfaces as "not allowed" in the Home app) rather than sent. |
| `ledLightbulb` | boolean | `false` | Publishes a "Pod LED" lightbulb (on/off + brightness) on the hub. Every write re-posts the Pod's full device-settings object (`v`/`gainLeft`/`gainRight`/`ledBrightness`), debounced by `pollIntervals.deviceWriteDebounceMs` (default 500ms) — the plugin re-reads the Pod's device status immediately before dispatch so the `gainLeft`/`gainRight` it carries along are as fresh as possible, not whatever was cached when the Home app write started. **Trade-off:** unlike the thermostat's target temperature, an LED write has no optimistic feedback — after debouncing, the slider can take up to roughly the fast-poll interval (default ~5s) to visibly settle at the written value in the Home app. This reads as "a little slow," not stuck or reverted: nothing pushes a disagreeing value in the interim. A small residual race remains even with the pre-dispatch refresh: a gain changed externally in the narrow window between that refresh completing and the write actually landing is still clobbered — bounded by one request's round trip, not a full ~30s poll interval. |
| `testAlarmSwitch` | boolean | `false` | Publishes two momentary switches on the hub, "Test Alarm Left" and "Test Alarm Right" — one boolean gates both. Turning either on triggers the Pod's alarm vibration on that side only, immediately, overriding away mode and power state; each tile self-resets to off after about a second regardless of outcome, while the physical vibration itself lasts at least 10 real seconds. (Split into two per-side switches rather than one both-sides switch — a hub-level trigger firing on both sides risked vibrating a sleeping partner's side as a side effect of testing the other.) |
| `serverFaultSensor` | boolean | `false` | Publishes a "Pod Server Fault" sensor on the hub, reflecting the Pod's own self-reported subsystem health (`GET /api/serverStatus`). Polled on the slow cadence, and only while this is enabled — the endpoint is not free (a real SQLite round-trip on every call upstream). |
| `alarmEvents` | boolean | `true` | Publishes each side's alarm-press `StatelessProgrammableSwitch` ("When … is pressed" in the Home app's automation picker) and its "Dismiss Alarm" switch, and runs the scheduler that briefly polls the Pod faster (`pollIntervals.alarmPollIntervalMs`) around each predicted alarm instant so the short-lived (as little as 10s) vibration event is not missed by the base ~30s poll. On by default — the extra polling only ever runs near an actually-enabled alarm and has zero effect on an alarm-free Pod. Set to `false` to opt out entirely (no services, no scheduler, no extra polling). |
| `keepAlive` | boolean | `true` | While a side is on, periodically re-posts its remaining time so the Pod's 12-hour `isOn` duration never silently expires. `false` disables the component entirely — no timer, no writes. |
| `keepAliveMs` | number (ms) | `43200000` (12h) | The duration re-posted as a side's remaining time when it is re-armed, matching the Pod's own 12-hour duration. |
| `keepAliveThresholdMs` | number (ms) | `1800000` (30min) | A side is re-armed once its remaining time drops below this. Must be strictly less than `keepAliveMs`; the config UI cannot enforce that, so an invalid combination fails loudly at Homebridge startup instead. Minimum `120000` (2min) — below that, the plugin's own internally-derived check cadence can no longer guarantee it catches every side before it expires. |
| `awayModeWritePolicy` | `'mirror'` \| `'block'` | `'mirror'` | Governs a write to one side while either side has away mode on (the Pod itself always applies such a write to both sides). `'mirror'` (default) lets the write through and issues a second real `POST /api/deviceStatus` to the other side, updating its cached state to match, so HomeKit shows the truth immediately. `'block'` refuses the write before it reaches the Pod, surfacing "not allowed" in the Home app instead. Either way, an away-mode change made outside this plugin (e.g. free-sleep's own web UI) is only detected on the next settings poll (default every 300s), not sooner. |
| `awayModeSwitch` | boolean | `true` | Publishes a per-side "Away Mode" switch, bound to `settings.{side}.awayMode` — pauses that side's schedules and alarms, the same field free-sleep's own web UI toggles. Writes are debounced locally (at least 2s) and rate-limited to at most one settings write per side per 10s window. |
| `skipAlarmSwitch` | boolean | `true` | Publishes a per-side "Skip Next Alarm" switch. Turning it on computes that side's next scheduled alarm occurrence (the alarm scheduled for the current *sleep day* — the calendar day, in the side's time zone, that began 12 hours ago — applied to today's date if it's before noon, otherwise tomorrow's, plus 2 minutes) and writes `scheduleOverrides.alarm.expiresAt` so free-sleep's own recurring alarm job skips it; turning it off clears the override. Self-clears (reads back off) once the computed time passes, with no write, and also proactively pushes to HomeKit at that exact instant, or when a poll observes the override changed by some other means (e.g. free-sleep's own web UI) — neither push needs a read. Writes are debounced locally (at least 2s) and rate-limited to at most one settings write per side per 10s window, same as Away Mode. Turning the switch on between an alarm ringing and the following noon — a "dead window" where the noon rule would otherwise target that already-elapsed alarm — is refused instead of writing an override that would skip nothing. |
| `awayModeTurnsSideOff` | boolean | `false` | When `awayModeSwitch` is enabled, turning a side's Away Mode switch on first turns that side off (confirmed), then enables away mode, as two sequenced writes — the reverse order would let the Pod's own both-sides mirroring turn the *other* side off too, which enabling away mode alone should not do. Turning Away Mode off never touches power, regardless of this setting. If the power-off pre-step is refused because the partner side is already away (`awayModeWritePolicy: 'block'`), the toggle still proceeds straight to the `awayMode: true` write — the Pod applies a settings write to both sides whenever either is away anyway, so aborting here would make Away Mode itself unreachable while the partner stays away. Separately, under the default `'mirror'` policy: enabling Away Mode with the partner side already away also turns the partner's side off, an unavoidable side effect of the Pod's own both-sides mirroring (`awayModeWritePolicy` above) — not something this option can prevent. |

Every key above is live and consumed — none are placeholders. An unrecognized top-level key
(almost always a typo) is logged as a warning rather than silently ignored.

## Security

free-sleep's API has **no authentication**. Anything on your LAN can control the bed. This
plugin does not change that — do not expose port 3000 to the internet.

## Documentation

- [docs/POD-API.md](docs/POD-API.md) — source-verified notes on free-sleep's API and the
  constraints that shape this plugin.
- [docs/HOMEKIT.md](docs/HOMEKIT.md) — HAP service/characteristic modeling decisions and the
  HomeKit-side gotchas they work around.
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones, what's not built yet, and non-goals.
- [CHANGELOG.md](CHANGELOG.md) — what changed in each release.
- `openspec/` — spec-driven change proposals. `openspec list` to see what is in flight.

## Licence

MIT

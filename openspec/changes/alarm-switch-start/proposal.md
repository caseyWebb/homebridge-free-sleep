## Why

The operator wakes to the iPhone's Sleep alarm, not the Pod's. iOS Shortcuts exposes that alarm
as three personal-automation triggers — "goes off", "is snoozed", "is dismissed" — and today the
bed is tied to them by Shortcuts that `POST` straight to the Pod's LAN API (`/api/alarm` to
start, `/api/execute` with a hand-built CBOR payload to stop). That breaks off the home LAN
(every dismiss away from home throws a Shortcuts error) and bypasses the plugin entirely.

Two of the three automations are already a Home action away: snooze is "Alarm off + Thermostat
to a warmer target", dismiss is "Alarm off + Thermostat Off". The missing piece is **starting the
alarm from HomeKit with the schedule's own parameters** on one side, through a tile whose on/off
state honestly tracks whether the bed is vibrating. The existing per-side "Dismiss Alarm" switch
already *is* that tile for the off half: it reads `isAlarmVibrating` and its OFF write dismisses.
Its ON write is, by `alarm-events`' contract, accepted and reverted — a deliberate guard against a
mis-tap starting a vibration. This change makes that ON write do the obvious thing behind an
opt-in flag, instead of adding a second tile that would mirror the same state.

(On a Pod 3 the dismiss write only stops a running vibration on a free-sleep build fixing
upstream #54; the operator's Pod runs the `caseyWebb/free-sleep` fork that does. The plugin's
write is the same either way.)

## What Changes

- New config key **`alarmSwitchStartsAlarm`** (boolean, default `false`). When `true`, an ON
  write to a side's "Dismiss Alarm" `Switch` (`src/services/alarm.ts`) calls
  `PodClient.postAlarm({side, ...alarmSwitchAlarm, force: true})` instead of scheduling the
  accept-then-revert. On success the service installs an `isAlarmVibrating: true` snapshot
  overlay for `max(10, duration)` s and requests a `deviceStatus` fast-poll window for that span
  plus 30 s; on failure it throws `SERVICE_COMMUNICATION_FAILURE` and reverts the tile.
- New config key **`alarmSwitchAlarm`** (`{duration: 180, vibrationIntensity: 100,
  vibrationPattern: 'double'}`, each field individually defaulted, same bounds as
  `AlarmRequestSchema`).
- New optional **`ServiceContext.requestAlarmPoll(untilMs)`**, wired by the platform to
  `PodPoller.requestMode('deviceStatus', {intervalMs: alarmPollIntervalMs, untilMs, reason:
  'alarm-switch'})` — the same primitive `AlarmWindowScheduler` uses around a scheduled alarm.
- `AlarmService.stop()` additionally clears the start overlay and releases the poll window.
- `config.schema.json`, README, `docs/HOMEKIT.md`, `docs/POD-API.md`, `CHANGELOG.md` updated.

## Endpoints touched

- `POST /api/alarm` — the ON write, only when `alarmSwitchStartsAlarm` is on. Not expensive (no
  job rebuild); physically vibrates the bed.
- `POST /api/deviceStatus` — the OFF write, unchanged from `alarm-events`.
- `GET /api/deviceStatus` — polled faster (the existing alarm cadence, default 3 s) for the
  alarm's duration + 30 s after each start. Bounded and purposeful, like the window scheduler's.
- No `/api/settings` or `/api/schedules` write.

## Capabilities

### Modified Capabilities
- `alarm-events`: the dismiss switch's ON write becomes conditional — the existing
  "accepted and reverted, never sent" requirement now applies only while
  `alarmSwitchStartsAlarm` is `false`; a new requirement covers the start path, the tile's
  lifetime, and the fast poll.
- `config`: adds `alarmSwitchStartsAlarm` and `alarmSwitchAlarm` as consumed keys.

## Non-goals

- No new HAP service, no new subtype, no change to the seeded `ConfiguredName` ("Dismiss
  Alarm" — never overwritten for existing installs; the operator renames the tile in Home).
- No plugin-side snooze: iOS owns the snooze interval and re-fires "goes off"; the temperature
  bump is an absolute Thermostat write the Shortcut makes itself.
- No change to the hub's "Test Alarm" switch or to `WriteQueue`/`AwayModeGuard`.
- No retry of a failed start (a second attempt landing while the first is in progress would
  re-fire the alarm).
- No support for making a stock free-sleep build stop a running Pod 3 vibration (upstream #54).

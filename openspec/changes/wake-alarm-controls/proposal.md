## Why

The operator does not wake up to the Pod's own vibration alarm — the iPhone's Sleep alarm is the
front end (full-screen lock-screen UI, Siri, Sleep Focus), and iOS Shortcuts exposes it as three
personal-automation triggers: "goes off", "is snoozed", "is dismissed". Today the bed is tied to
those triggers by Shortcuts that `POST` straight to the Pod's LAN API (`/api/alarm`,
`/api/execute`, `/api/deviceStatus`), which fails whenever the phone is off the home LAN (every
dismiss away from home throws a Shortcuts error) and bypasses the plugin entirely.

Everything the three automations need is a single Home action away except two pieces:

- **Start the alarm on one side.** The hub's "Test Alarm" switch exists but is a fixed, short,
  mid-intensity probe (`src/services/testAlarm.ts`'s `TRIGGER_PARAMS`), lives on the hub, and
  swallows failures by design. A real wake alarm wants the schedule's own parameters (180 s,
  intensity 100) and wants a failed trigger to be visible.
- **Snooze = stop the vibration and make the bed less comfortable.** Home scenes and Shortcuts
  "Control Home" actions can only set an *absolute* thermostat target; "current + 10 °F" has to
  be computed next to the cached snapshot, i.e. in the plugin.

"Dismiss" needs nothing new: "Dismiss Alarm" → off plus Thermostat → Off already exist. (On a
Pod 3 the dismiss write only actually stops a running vibration on a free-sleep build fixing
upstream #54 — the operator's Pod runs the `caseyWebb/free-sleep` fork that does; the plugin's
write is the same either way.)

## What Changes

- Add a per-side momentary **Wake Alarm `Switch`** on the side accessory
  (`src/services/wakeAlarm.ts`, new). ON → `PodClient.postAlarm({side, ...config.wakeAlarm,
  force: true})`; self-resets after ~1 s; a rejected post throws
  `SERVICE_COMMUNICATION_FAILURE` (not swallowed like Test Alarm's).
- Add a per-side momentary **Snooze `Switch`** on the side accessory (`src/services/snooze.ts`,
  new). ON → one `writeQueue.submitSide(side, {isAlarmVibrating: false, isOn: true,
  targetTemperatureF: clamp(effectiveCurrent + snoozeTemperatureDeltaF)})`; self-resets after
  ~1 s; `AwayModeBlockedError` → `NOT_ALLOWED_IN_CURRENT_STATE`, anything else →
  `SERVICE_COMMUNICATION_FAILURE`. With no cached target, degrades to a plain dismiss + warning.
- Four new config keys, all consumed: `wakeAlarmSwitch` (default `false`), `wakeAlarm`
  (`{duration: 180, vibrationIntensity: 100, vibrationPattern: 'double'}`), `snoozeSwitch`
  (default `false`), `snoozeTemperatureDeltaF` (default `10`, −55..55, non-zero). Both switches
  default off because each can physically act on a sleeping person's bed (same rationale as
  `testAlarmSwitch`).
- Two new subtypes (`wakeAlarm`, `snooze`) in `enabledServiceKeysFor`'s side table, two new
  `ConfiguredName` labels ("Wake Alarm", "Snooze"), construction and shutdown wiring in
  `src/platform.ts`, `config.schema.json` entries, README/HOMEKIT/POD-API/CHANGELOG updates.

## Endpoints touched

- `POST /api/alarm` — Wake Alarm. Not expensive (no job rebuild); fires a vibration.
- `POST /api/deviceStatus` — Snooze, via the existing `WriteQueue` side lane. Not expensive.
  `WriteQueue.dispatch`'s existing N8 peel sends the `isAlarmVibrating` part as its own
  guard-exempt request before the `{isOn, targetTemperatureF}` remainder.
- No `POST /api/settings` or `/api/schedules` write anywhere in this change.

## Capabilities

### New Capabilities
- `wake-alarm-controls`: the per-side Wake Alarm and Snooze momentary switches — what each
  press sends, the self-reset, the error mapping, the stacking/clamping of the snooze bump, and
  the degraded no-snapshot path.

### Modified Capabilities
- `config`: adds `wakeAlarmSwitch`, `wakeAlarm`, `snoozeSwitch`, `snoozeTemperatureDeltaF` as
  consumed keys with the defaults and bounds above.

## Non-goals

- No change to the existing "Dismiss Alarm" switch, the alarm-press event, or the hub's "Test
  Alarm" switch (its fixed parameters and swallowed failures stay as the PR #44 ruling left
  them).
- No plugin-side re-alarm timer for snooze — iOS owns the snooze interval and fires "goes off"
  again, which re-triggers Wake Alarm.
- No change to `WriteQueue`/`AwayModeGuard`; the snooze relies on the already-shipped N8 peel.
- No support for making a stock free-sleep build stop a running Pod 3 vibration; that is
  upstream #54 / the operator's fork, not this plugin.
- No Shortcuts/Home automation definitions in the repo — they are operator-side configuration;
  `docs/HOMEKIT.md` documents the intended three-automation mapping.

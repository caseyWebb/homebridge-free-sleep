## Context

See proposal.md — Why. Pre-existing state this builds on, all unmodified:

- **`TestAlarmService`** (`src/services/testAlarm.ts`): the momentary-switch pattern — `onSet`
  ignores `false`, fires on `true`, pushes `On` back to `false` after `RESET_DELAY_MS` (1000)
  via `ctx.timers`, exposes `stop()` for shutdown. Fixed `TRIGGER_PARAMS` (60/double/10s,
  `force: true`); rejections logged at `debug` and swallowed (N4).
- **`PodClient.postAlarm`** (`src/pod/client.ts`): validates against `AlarmRequestSchema`
  (`src/pod/types.ts`: intensity 1–100, duration positive int ≤ 180, pattern `double|rise`,
  mirroring free-sleep `server/src/db/schedulesSchema.ts`'s `AlarmSchema`), single attempt, no
  retry.
- **free-sleep `executeAlarm`** (`~/Code/free-sleep`, `server/src/jobs/alarmScheduler.ts`):
  returns early without vibrating when the side is in away mode or off unless `force` is set;
  clamps the real duration to `Math.max(10, duration)`.
- **free-sleep `updateSide`** (`server/src/routes/deviceStatus/updateDeviceStatus.ts`): applies
  `isOn` (duration 43200/0), then `targetTemperatureF` (`TEMP_LEVEL_*`, regardless of power
  state), then `isAlarmVibrating: false`. On the operator's fork (`caseyWebb/free-sleep`,
  `server/src/8sleep/alarm.ts`) that last step re-fires `ALARM_{SIDE}` with `du: 1` before
  `ALARM_CLEAR`, which is what actually stops a Pod 3 vibration (upstream #54).
- **`WriteQueue`** (`src/pod/writeQueue.ts`): `submitSide` merges same-lane submissions inside
  one debounce window into a single pending patch and installs `targetTemperatureF`/`isOn`/
  `isAlarmVibrating` overlays at submission. `dispatch` **peels** `isAlarmVibrating` out of any
  multi-field side patch into its own `settleWrite` *before* `awayModeGuard.decide()` runs for
  the remainder (the N8 ruling from the `alarm-events` PR #45 review).
- **`SnapshotStore.get()[side].targetTemperatureF`** is the *effective* value — raw observation
  with any live write overlay applied (`src/pod/snapshot.ts`, `effectiveSide`).
- **`clampTargetF`** (`src/pod/temperature.ts`): `F_MIN` 55 / `F_MAX` 110, the Pod's own
  zod bounds on `targetTemperatureF`.

## Decisions

### 1. Two new momentary switches on the side accessory, not changes to existing tiles

Alternatives considered: (a) make the hub's Test Alarm configurable — rejected: it is a hub
probe with deliberately swallowed failures, and the PR #44 ruling scoped it as "not a
configurable one"; (b) make the existing "Dismiss Alarm" switch bidirectional (ON = start) —
rejected: `alarm-events`' spec says ON is accepted-and-reverted, never sent, and silently
changing that for every existing user to get one operator's workflow is the wrong trade.
Separate, opt-in, per-side switches change nothing for anyone who does not enable them.

### 2. Wake Alarm surfaces failures; Test Alarm keeps swallowing them

A test probe that fails is a curiosity; a wake alarm that fails is a missed morning. `onSet`
awaits `postAlarm` and maps a rejection to `SERVICE_COMMUNICATION_FAILURE`, logged at `warn`.
The ~1 s self-reset is scheduled *before* the await so the tile timeline is identical on
success and failure. No retry (same double-fire reasoning as Test Alarm).

### 3. Snooze is one `submitSide` patch; the queue's peel does the splitting

`{isAlarmVibrating: false, isOn: true, targetTemperatureF}` in one call. Two calls would merge
into the same pending patch anyway (`submit`'s `Object.assign` into `rt.pending`), and the N8
peel then dispatches the dismiss first on its own, guard-exempt, followed by the remainder under
normal `AwayModeGuard` treatment. Consequences, all deliberate:

- the alarm stops even when the temperature bump is refused (`'block'` + partner away);
- the press's own promise rejects with `AwayModeBlockedError` → `NOT_ALLOWED_IN_CURRENT_STATE`
  in that case, which is honest: half of what was asked did not happen;
- two requests on the wire per press (observable in tests as two `postDeviceStatus` calls).

`isOn: true` is included because upstream applies `TEMP_LEVEL_*` regardless of power but an
off side does not heat — a snooze after the 12-hour duration lapsed would otherwise be a silent
no-op. On an on side it re-arms the 12-hour timer, which is harmless and arguably desired at
wake time.

### 4. The bump is relative to the *effective* target and clamped

Reading the effective (overlaid) target means two presses within the settle window stack
(+10, +20) instead of both computing from the same stale raw value. `Math.round` guards a
fractional base (the snapshot type allows it); `clampTargetF` keeps the request inside the Pod's
55–110 validation so a press near the ceiling never turns into a 400 from the Pod.

### 5. No cached target → dismiss only, loudly

Before the first successful poll `targetTemperatureF` is `undefined`. Guessing a base (e.g. 82.5)
could send a 20 °F swing; refusing entirely would leave the alarm ringing. Sending the dismiss
alone and logging at `warn` is the least-bad behaviour and is covered by the pure `snoozePatch`
helper's test.

### 6. Config shape

`wakeAlarm` is a nested object with a **fully-specified** `.default(...)` rather than
`.default({})`: zod v4's `.default()` returns its value without re-parsing, so an empty-object
default would skip the per-field defaults (the existing `PollIntervalsSchema` gets away with
`{}` only because all its fields are optional). `snoozeTemperatureDeltaF` is an int in −55..55
with a non-zero refinement — 0 would make the switch a worse "Dismiss Alarm". Both switches
default `false` for the same physical-disruption reason `testAlarmSwitch` does.

## Needs confirming on a real paired device

- That a Shortcuts personal automation (Sleep alarm "goes off" / "is snoozed" / "is dismissed")
  with a "Control Home" action reliably turns a momentary switch on when the phone is off the
  LAN (routes via the home hub), and that the ~1 s self-reset does not race the hub's write
  acknowledgement into a spurious failure in the Shortcuts UI.
- That a Pod 3 running the operator's fork actually stops vibrating on the Snooze press (the
  dismiss half) — the fork was verified by hand from the Pod's own API on 2026-10-29; the
  end-to-end HomeKit path has not been.
- That the Wake Alarm's `force: true` alarm on an *off* side behaves acceptably in the Home app
  (the side's Thermostat stays Off while the "Dismiss Alarm" switch turns on).

## Context

See proposal.md — Why. Pre-existing state this builds on:

- **`AlarmService`** (`src/services/alarm.ts`, `alarm-events`): one class owns the per-side
  alarm-press `StatelessProgrammableSwitch` and the "Dismiss Alarm" `Switch`. `onGet` reads
  `snapshot.get()[side].isAlarmVibrating` (the *effective* value: raw observation with any live
  overlay applied). OFF submits `{isAlarmVibrating: false}` through `writeQueue.submitSide`,
  whose overlay forces the effective value to `false` immediately (B2 guard suppresses the
  spurious rising edge if that overlay later lapses with raw still `true`). ON schedules a
  ~500 ms accept-then-revert and sends nothing. `handleChange` publishes the tile and fires
  `SINGLE_PRESS` on a `false → true` effective transition.
- **`SnapshotStore.setOverlay(side, field, value, ttlMs)`** (`src/pod/snapshot.ts`): installs a
  per-key overlay with a generation counter; a later `setOverlay` on the same key replaces it
  (clearing the old timer), `clearOverlay` is generation-checked (a stale handle is a no-op),
  and `maybeRetire` drops an overlay silently the moment raw agrees with it. Overlay install
  runs through `commit()`, so it emits a `Change` if the effective value moved.
- **`PodPoller.requestMode(classId, {intervalMs, untilMs, reason})`** returns a release
  function; `AlarmWindowScheduler` uses exactly this around each predicted scheduled alarm.
- **free-sleep `executeAlarm`** (`~/Code/free-sleep`, `server/src/jobs/alarmScheduler.ts`): sets
  `isAlarmVibrating` true synchronously after sending `ALARM_{SIDE}`, arms a timer that clears it
  after `Math.max(10, duration)` s, and returns early without vibrating when the side is away or
  off unless `force`. `POST /api/alarm` (`server/src/routes/alarm/alarm.ts`) validates against
  `AlarmJobSchema` (intensity 1–100, duration positive ≤ 180, pattern `double|rise`).
- **free-sleep dismiss on the operator's fork** (`caseyWebb/free-sleep`,
  `server/src/8sleep/alarm.ts`): `isAlarmVibrating: false` re-fires `ALARM_{SIDE}` with `du: 1`,
  then `ALARM_CLEAR`, then clears the flag and the pending end-timer — so after a dismiss the
  Pod reports `false` on the very next poll.

## Decisions

### 1. Extend the existing switch behind a flag; no second tile

A separate "Alarm" switch would show the same `isAlarmVibrating` state as "Dismiss Alarm" on
the same accessory — two tiles, one fact. `alarm-events`' "ON is never sent" rule exists to stop
a mis-tap from vibrating a bed, which is a default-safety argument, not an identity argument, so
the right shape is the same tile with the ON half enabled by `alarmSwitchStartsAlarm`
(default `false`). Everything about OFF, the press event, the B2 guard and the No-Response
escalation is untouched.

### 2. Optimistic "on" via a snapshot overlay sized to the real vibration

After a `200` from `postAlarm`, the Pod *is* vibrating and its own flag *is* true, but the plugin
will not observe that until its next `deviceStatus` poll. Rather than add a parallel local
shadow, the service installs the same kind of overlay the write queue uses — `isAlarmVibrating:
true`, TTL `max(10, duration) * 1000` ms (upstream's own floor) — so:

- the tile reads on at once, and `handleChange` fires the alarm-press event (a genuine rising
  edge: the alarm did just start);
- when a poll confirms `true`, `maybeRetire` drops the overlay silently and raw governs from
  then on — the tile follows the Pod's real end, including an end *earlier* than nominal (a
  dismiss from the web app) or *later* (a re-fire);
- if no poll ever confirms it (connection trouble), the overlay expires exactly when the alarm
  would have ended and the tile turns itself off — the "if nothing happens it toggles off at the
  end" guarantee holds without any extra timer.

An OFF write's dismiss overlay (`false`) replaces the start overlay on the same key at
submission, so "off" wins immediately and the stale start handle is a generation-checked no-op.

### 3. Fast-poll the alarm's span through a new optional context callback

The base ~30 s poll would see the *end* of a 180 s alarm up to 30 s late. `AlarmWindowScheduler`
already fast-polls around *scheduled* alarms but knows nothing about on-demand ones, and services
deliberately do not hold the poller. A one-method optional `requestAlarmPoll(untilMs)` on
`ServiceContext`, implemented by the platform as the identical `requestMode` call (interval
`pollIntervals.alarmPollIntervalMs`, reason `'alarm-switch'`), keeps the "services don't import
the poller" boundary and stays absent in hand-built test contexts. Window: `now + max(10,
duration) s + 30 s`; released on `stop()`, otherwise it lapses on its own.

### 4. Order: request first, then claim

`postAlarm` is awaited *before* the overlay/poll are installed, so a rejected request reverts the
tile (`scheduleRevert`) without ever having claimed "ringing" or fired a press. Failure maps to
`SERVICE_COMMUNICATION_FAILURE`, logged at `warn` (a missed wake-up should be visible), unlike the
hub's "Test Alarm" whose swallowed failure the PR #44 review explicitly accepted for a probe.

### 5. Config shape

`alarmSwitchAlarm` is a nested object with a **fully-specified** `.default(...)` rather than
`.default({})`: zod v4's `.default()` returns its value without re-parsing, so an empty-object
default would skip the per-field defaults (`PollIntervalsSchema` gets away with `{}` only because
all its fields are optional). Bounds mirror `AlarmRequestSchema`, so a bad config fails at parse
time rather than on the first morning.

## Needs confirming on a real paired device

- That a Shortcuts personal automation ("goes off") using a "Control Home" action turns the
  switch on reliably from outside the LAN via the home hub, and that the synchronous
  `postAlarm` round trip inside `onSet` stays within HomeKit's write-acknowledgement timeout.
- That the Pod 3 running the operator's fork reports `isAlarmVibrating: false` within one
  fast-poll interval of an OFF write — verified from the Pod's own API on 2026-10-29, not yet
  through HomeKit end to end.
- That the alarm-press event firing on the switch-started alarm does not trip any existing
  "when Alarm is pressed" automation the operator did not intend to re-fire.

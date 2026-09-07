## Why

Issue #16: a Pod alarm is a real-time hardware event (`isAlarmVibrating`, an in-memory flag
`executeAlarm` sets and a `setTimeout(max(10, duration) * 1000)` clears —
`server/src/jobs/alarmScheduler.ts`, `~/Code/free-sleep` pinned v2.1.5/`dc0c710`) that HomeKit
currently has no way to observe or act on. Schedules allow a 0–180 s duration
(`server/src/db/schedulesSchema.ts`'s `AlarmScheduleSchema`), and the platform's base
`deviceStatus` poll defaults to 30 s (`src/pod/poller.ts`) — so without a scheduled fast-poll
timed around each predicted alarm, a poll would routinely miss the entire event. `docs/
HOMEKIT.md`'s "Alarm ringing" section already fixes the HAP shape (`StatelessProgrammableSwitch`
on the rising edge, a "Dismiss Alarm" `Switch`, never a `MotionSensor`) and states plainly:
"Scheduled fast-poll is mandatory, not an optimisation... Without it the feature does not work."
`alarmPollIntervalMs` already exists in `src/config.ts` as a reserved, unconsumed key sized for
exactly this (`3000`, matching `poller.ts`'s `HARD_FLOOR_MS`) — this change is what makes it do
something.

## What Changes

- Add a new pod-level component, `AlarmWindowScheduler`, structurally a peer of `PodPoller`/
  `WriteQueue`/`KeepAlive` (`src/pod/`): on a self-rescheduling timer it derives each side's
  upcoming alarm instant(s) from the already-polled, cached `schedules` and `settings` documents
  (`GET /api/schedules`, `GET /api/settings` — both already polled every `slowPollIntervalMs` by
  the existing poller; no new endpoint, no new poll class) and, for each one inside its lookahead
  horizon, calls the existing `poller.requestMode('deviceStatus', { intervalMs:
  alarmPollIntervalMs, untilMs, reason: 'alarm' })` for a window of ±3 minutes around the
  predicted fire time. **No change to `poller.ts` itself** — `requestMode`'s stacking mode API
  was designed in `poller-and-write-queue`'s design.md ("Poll modes are a stack, and that is how
  the alarm window (#16) arrives") specifically so this arrives as a caller of an existing method,
  not a poller change.
- Faithfully reproduce upstream's own scheduling rules for which occurrences exist and when,
  each cited to `~/Code/free-sleep`:
  - A side/weekday's alarm only fires when `power.enabled && alarm.enabled && !settings[side]
    .awayMode && settings.timeZone` (`alarmScheduler.ts`'s `scheduleAlarm`, early returns).
  - The literal calendar weekday an alarm fires on is `power.off`-shifted, not the schedule's own
    day key, whenever the sleep session crosses midnight (`jobs/utils.ts`'s
    `getDayIndexForSchedule`/`isEndTimeNextDay`: the day shifts forward one when `power.off`'s
    hour is `<= 12`).
  - `scheduleOverrides.alarm.expiresAt` — not `.disabled` — is what the *recurring* schedule
    checks to skip a firing (`alarmScheduler.ts`'s recurring job body, and `docs/POD-API.md`);
    `.disabled` only gates the separate one-shot "alarm time override" job
    (`scheduleAlarmOverride`). A predicted regular occurrence at or before a future `expiresAt`
    is skipped; the override job's own one-shot time (when `!disabled` and both fields are set) is
    predicted separately.
  - `settings.timeZone` (not the bridge host's local timezone) is the timezone every `HH:mm` is
    interpreted in, matching `alarmScheduler.ts`'s own `moment.tz(settingsData.timeZone)` calls —
    computed with the runtime's built-in `Intl.DateTimeFormat`, no new npm dependency.
- Add two new per-side HomeKit services (`src/services/alarm.ts`), wired into
  `src/platform.ts`'s existing snapshot-change routing table and service-enablement/prune table
  (`isAlarmVibrating` is already a watched `Change` field emitted by `SnapshotStore` — see
  `snapshot.ts`'s `SideChangeField` — and today explicitly ignored by the platform's routing
  switch pending this change):
  - A `StatelessProgrammableSwitch` that fires `SINGLE_PRESS` on the rising edge of
    `isAlarmVibrating` (`previous === false && current === true` — a snapshot's first-ever
    observation, `previous === undefined`, deliberately never fires a press: it means "already
    vibrating when we started observing," not "just started").
  - A `Switch` "Dismiss Alarm": reports ON while `isAlarmVibrating` is observed true. Writing OFF
    submits `writeQueue.submitSide(side, { isAlarmVibrating: false })` — `POST
    /api/deviceStatus`, cheap, no job rebuild (confirmed against upstream's own dismiss call,
    `app/src/pages/ControlTempPage/AlarmDismissal.tsx`'s `postDeviceStatus({[side]:
    {isAlarmVibrating: false}})` — **not** `POST /api/alarm`, which is a different, unrelated
    endpoint this change does not touch; see Non-goals). Writing ON is accepted and quietly
    reverted to OFF after ~500 ms, mirroring `ThermostatService`'s existing away-mode-block
    revert-timer pattern, rather than ever sending an `isAlarmVibrating: true` patch to the Pod
    (unsupported server-side — `docs/POD-API.md`).
- `FreeSleepPlatform` constructs one `AlarmWindowScheduler` per launch (alongside the existing
  poller/write queue/keep-alive) and stops it on shutdown.
- `alarmPollIntervalMs` (`src/config.ts`, already schema-validated, default `3000`, minimum
  `3000`) becomes consumed by this change.

## Capabilities

### New Capabilities
- `pod-alarm-scheduler`: deriving upcoming per-side alarm instants from the cached schedules and
  settings documents, and requesting bounded `deviceStatus` fast-poll windows around them via the
  poller's existing mode-stacking API.
- `alarm-events`: the per-side `StatelessProgrammableSwitch` (rising-edge `SINGLE_PRESS`) and
  "Dismiss Alarm" `Switch`, and their wiring into the platform's snapshot-change routing and
  service-enablement/prune table.

### Modified Capabilities
- `config`: `alarmPollIntervalMs` moves from "reserved, validated, unused" to "consumed by
  `pod-alarm-scheduler`"; the reserved-keys requirement's own text no longer applies to this one
  key.
- `platform`: the snapshot-change routing table gains a route for `isAlarmVibrating` to the new
  alarm services (today explicitly documented as ignored); the per-role enabled-service set gains
  two subtypes for a side accessory; platform construction/shutdown gains the
  `AlarmWindowScheduler` lifecycle, alongside the existing poller/write-queue/keep-alive.

## Impact

- **Endpoints touched**: `GET /api/schedules` and `GET /api/settings` — already polled by the
  existing `PodPoller` at `slowPollIntervalMs` (default 300 s); this change adds a *reader* of
  the already-cached documents, not a new poll class or a new client method. `POST
  /api/deviceStatus` for the dismiss write — cheap (a device command, not a LowDB write; no job
  rebuild), and already implemented by `PodClient`/`WriteQueue`; this change adds a new caller
  (`writeQueue.submitSide(side, { isAlarmVibrating: false })`), not a new write path.
- **No expensive write.** Neither endpoint this change touches triggers `settingsDB.json`/
  `schedulesDB.json`'s job-rebuild watcher (`server/src/jobs/jobScheduler.ts`).
- New files: `src/pod/alarmWindowScheduler.ts`, `src/services/alarm.ts`, plus their unit tests.
- Modified files: `src/platform.ts` (construction/shutdown wiring, routing table, prune table),
  `src/config.ts`'s doc comment for `alarmPollIntervalMs` (schema shape unchanged — the field,
  default, and minimum already exist).
- The mock Pod (`test/mockPod.ts`) already models `isAlarmVibrating` and `ALARM_CLEAR` faithfully
  (`updateSide`'s alarm block); it needs one addition for this change's tests: a way for a test
  to directly set `state.deviceStatus[side].isAlarmVibrating = true` (fault-injection style, the
  same way `pod.fault(...)` already injects transport-level faults) to simulate a real alarm
  firing, since the mock has no scheduler of its own that would ever set this to `true` on its
  own.

## Non-goals

- **`POST /api/alarm`** (upstream's "fire an alarm right now" endpoint, `server/src/routes/alarm/
  alarm.ts` → `executeAlarm`) is not touched by this change at all. It belongs to issue #20's
  "Test alarm" switch. Firing an alarm is a genuine, non-idempotent side effect (unlike setting
  `isAlarmVibrating: false`, which the mock's `updateSide` — matching upstream's own
  `updateDeviceStatus.ts` — forces to `false` unconditionally whether or not it already was), so
  when #20 eventually adds a `PodClient` method for it, that method must opt out of the retry-on-
  5xx/network-error policy `pod-client/design.md`'s "Retry" section documents for every other
  write (design.md's "Retry" already flags this: "This safety argument does not extend to `POST
  /api/alarm`... when #16 adds it, it must opt out" — corrected here to #20, since #16/this
  change never adds it).
- **No "Skip Next Alarm" write UI.** This change *reads* `scheduleOverrides.alarm.timeOverride`/
  `.expiresAt`/`.disabled` to predict occurrences correctly; it never writes them. That switch is
  issue #17.
- **No "Test alarm" switch.** That is issue #20's hub-accessory work.
- **No change to the Pod's own alarm-scheduling logic**, its away-mode skip, or its 0–180 s
  duration bound — all upstream firmware behavior this plugin only ever observes.
- **Not fixed here: `WriteQueue`'s away-mode policy applies to a Dismiss-Alarm write exactly as
  it applies to any other side write, and upstream never away-mode-scopes alarm clearing at
  all.** `away-mode-guard` (concurrently in flight as of this writing, not yet landed/synced into
  the main specs) consults its configured policy for *every* side-lane dispatch, unconditionally
  — but upstream's `updateSide` never consults `controlBothSides`/`updateLeft`/`updateRight` for
  the `isAlarmVibrating` field at all; it always targets the literal `side` argument
  unconditionally (`test/mockPod.ts`'s `updateSide`, mirroring `server/src/routes/deviceStatus/
  updateDeviceStatus.ts`). Two distinct, differently-severe consequences follow once
  `away-mode-guard` lands:
  - Under policy `'mirror'`: a Dismiss-Alarm write also mirrors `isAlarmVibrating: false` to the
    other side. Harmless in practice — clearing an already-not-vibrating side's flag is a no-op
    server-side.
  - Under policy `'block'`: a Dismiss-Alarm write issued while *either* side is in away mode is
    refused outright, identically to any other blocked side write — meaning a user cannot stop a
    ringing alarm from HomeKit at all while either side is away. This is a real regression
    against issue #16's own "done when" bar ("dismissing from Home actually stops the
    vibration"), not merely cosmetic.
  This change does not modify `writeQueue.ts`/`awayModeGuard.ts` — both belong to the
  concurrently in-flight `away-mode-guard` change, whose landed shape this proposal cannot yet
  see. See design.md's Risks/Open Questions for the recommended fix (exempt an
  `isAlarmVibrating`-only patch from the away-mode policy entirely, matching upstream) and the
  sequencing question of whether it belongs in this change (once `away-mode-guard` has landed) or
  as an immediate follow-up.

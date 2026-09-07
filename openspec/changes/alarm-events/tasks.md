## 1. Mock Pod: fault-injection-style alarm control

- [ ] 1.1 Add `setAlarmVibrating(side: Side, value: boolean): void` to `test/mockPod.ts`'s
  `MockPod` interface and implementation, mutating `state.deviceStatus[side].isAlarmVibrating`
  directly with no HTTP round trip and no recorded command or request (design.md, "Mock Pod: one
  fault-injection-style addition"). Verify: a unit test in `test/mockPod.test.ts` calls it, then
  asserts a subsequent `GET /api/deviceStatus` reports the new value and that `requests`/
  `commands` gained no new entries from the call itself.
- [ ] 1.2 Confirm (add an assertion if not already covered) that `test/mockPod.ts`'s existing
  `updateSide` alarm branch still forces `isAlarmVibrating` to `false` and records `ALARM_CLEAR`
  regardless of which side's write set it, per `docs/POD-API.md`. Verify: existing/extended case
  in `test/mockPod.test.ts`.

## 2. Timezone/schedule-time arithmetic

- [ ] 2.1 Add a small utility module (e.g. `src/pod/scheduleTime.ts`) implementing the
  `Intl`-based "format, diff, correct" wall-clock-to-instant conversion for an IANA timezone,
  with no new npm dependency (design.md, "Timezone arithmetic"). Export a function computing the
  next future occurrence of a given `HH:mm` on a given weekday (or "any day," for the override
  case) in a given timezone, relative to a given "now" instant. Verify: `npm run typecheck`, plus
  unit tests in task 2.3.
- [ ] 2.2 Implement the calendar-day shift (`jobs/utils.ts`'s `isEndTimeNextDay`: shift the
  weekday forward one day when the schedule's `power.off` hour is `<= 12`) as a small, separately
  testable function. Verify: a table-driven unit test covering an AM `power.off` (shifts) and a
  PM `power.off` (does not shift), matching `jobs/utils.ts`'s exact boundary (`hour <= 12`).
- [ ] 2.3 Unit-test the timezone utility directly: for a timezone with a known, fixed UTC offset
  (no DST, e.g. `Asia/Tokyo`) assert the computed instant matches a hand-calculated expectation
  for several `HH:mm`/weekday combinations, including one where "today's occurrence already
  passed" (rolls to next week) and one where it has not (`pod-alarm-scheduler` spec, "The
  configured timezone governs the computed instant"). Verify: `npm test`.
- [ ] 2.4 Add the DST-transition pinned test flagged in design.md's Open Question 3: for a
  timezone with a known spring-forward or fall-back transition in a fixed, hardcoded test date
  (e.g. `America/Los_Angeles`), assert the utility resolves to a specific, documented instant —
  pinning current `Intl`/Node behavior so a future runtime change is caught, while explicitly
  commenting that the *correctness* of the chosen resolution is unverified against real hardware
  (design.md, "DST edges, noted honestly"). Verify: `npm test`.

## 3. Deriving upcoming alarm instants

- [ ] 3.1 Implement the eligibility predicate (`power.enabled && alarm.enabled &&
  !awayMode[side] && settings.timeZone`) as a pure function taking a side's daily schedule and
  the settings document. Verify: unit test covering all four independent failure cases plus the
  all-true case (`pod-alarm-scheduler` spec, "A fully-enabled weekday schedule produces an
  instant" and its four negative scenarios).
- [ ] 3.2 Implement the regular-occurrence derivation: for each side, each weekday, combine
  eligibility (3.1), the calendar-day shift (2.2), and the timezone utility (2.1) into one
  derived instant per eligible weekday. Verify: unit test seeding a full week's schedule and
  asserting the exact set of derived instants, including the overnight-crossing case
  (`pod-alarm-scheduler` spec, "An overnight session's alarm lands on the following calendar
  day").
- [ ] 3.3 Implement the `scheduleOverrides.alarm.expiresAt` suppression rule: a regular
  occurrence at or before a parseable, still-future `expiresAt` is dropped; `disabled` alone
  never revives it. Verify: unit tests for all four scenarios in `pod-alarm-scheduler` spec's "A
  future schedule-override expiry skips the regular occurrence it covers" requirement, including
  the `disabled: true` non-revival case.
- [ ] 3.4 Implement the override one-shot instant: when `disabled` is false and both
  `timeOverride` and `expiresAt` are set with `expiresAt` future, derive one additional instant
  at `timeOverride`'s next occurrence (any day), tagged distinctly from a regular occurrence.
  Verify: unit tests for `pod-alarm-scheduler` spec's "An active schedule override contributes
  its own one-shot instant" requirement, both scenarios.
- [ ] 3.5 Compose 3.1–3.4 into one function, `deriveUpcomingAlarms(schedules, settings, now):
  Array<{ side, instantMs, source: 'regular' | 'override' }>`, bounded by a lookahead horizon
  constant (design.md: one week plus a day). Verify: an end-to-end unit test against a
  realistic multi-day, multi-side fixture asserting the exact derived list.

## 4. `AlarmWindowScheduler`

- [ ] 4.1 Create `src/pod/alarmWindowScheduler.ts` exporting an `AlarmWindowScheduler` class,
  constructor options `{ snapshot: SnapshotStore, poller: PodPoller, timers?: TimerApi, logger?:
  Logger, alarmPollIntervalMs: number, windowMarginMs?: number }` (default margin 3 minutes per
  issue #16). Imports only `snapshot.ts`, `poller.ts`, and the task-3 derivation module — never
  `writeQueue.ts` (design.md, "A new peer module"). Verify: `npm run typecheck`.
- [ ] 4.2 Implement the per-tick recompute-and-reconcile logic (design.md, "Recomputation"):
  derive instants fresh from `snapshot.get().documents.{schedules,settings}`; activate any
  in-window, not-yet-active instant via `poller.requestMode('deviceStatus', { intervalMs:
  alarmPollIntervalMs, untilMs: instant + margin, reason: 'alarm' })`, keyed by
  `${side}:${instantMs}:${source}`; release and drop any previously-active key no longer present
  in the fresh derivation. Verify: unit tests in task 6.
- [ ] 4.3 Implement the self-rescheduling timer: `clamp(timeUntilSoonestUnarmedWindowStart,
  MIN_TICK_MS, RECOMPUTE_CEILING_MS)` (design.md's constants — propose `MIN_TICK_MS = 1000`,
  `RECOMPUTE_CEILING_MS = 300000`), using the injected `TimerApi` exclusively (no direct
  `setTimeout`/`Date.now`, matching `poller.ts`/`writeQueue.ts`/`keepAlive.ts`'s discipline).
  Verify: `npm run lint` (the `no-restricted-globals` scoping, if extended to this file — see
  task 4.5) and a fake-timer unit test asserting the next tick lands at the expected delay for a
  representative set of derived instants.
- [ ] 4.4 Implement `stop()`: cancel the scheduled timer and release every currently active
  window request, idempotent whether or not the timer was ever started (mirrors
  `PodPoller.stop()`/`WriteQueue.stop()`/`KeepAlive.stop()`'s shutdown convention). Verify: unit
  test asserting no timer remains and every previously-active `requestMode` release was called
  after `stop()`.
- [ ] 4.5 If `src/pod/{snapshot,poller,writeQueue}.ts`'s `no-restricted-globals`/
  `no-restricted-properties` ESLint scoping is file-listed rather than directory-wide, add
  `src/pod/alarmWindowScheduler.ts` (and `src/pod/scheduleTime.ts`) to that scope. Verify: `npm
  run lint` passes, and a deliberately-introduced bare `Date.now()` in the new file fails lint
  (then revert the deliberate break).

## 5. Config

- [ ] 5.1 In `src/config.ts`, update `alarmPollIntervalMs`'s doc comment from "Reserved for #16"
  to describe it as consumed by `pod-alarm-scheduler` — no schema shape change (field, default
  `3000`, minimum `3000` already correct). Verify: `npm run typecheck`, and extend
  `test/config.test.ts` per task 8.1.
- [ ] 5.2 Update `README.md`'s "Config keys" table: `alarmPollIntervalMs`'s row loses any
  "reserved/no effect yet" language. Verify: reading the rendered table.

## 6. `AlarmService` (HomeKit services)

- [ ] 6.1 Create `src/services/alarm.ts` exporting `AlarmService`, constructor `(ctx:
  ServiceContext, side: Side, platformStartedAt: number)`, exported subtypes `ALARM_PRESS_SUBTYPE
  = 'alarm-press'` and `ALARM_DISMISS_SUBTYPE = 'alarm-dismiss'` (design.md, "The two HAP
  services"). Verify: `npm run typecheck`.
- [ ] 6.2 Construct the `StatelessProgrammableSwitch` service (name `` `${accessory.displayName}
  Alarm` ``, subtype `alarm-press`), restored via `getServiceById` like `ThermostatService`/
  `ConnectionService`, with `setProps({ validValues: [ProgrammableSwitchEvent.SINGLE_PRESS] })`
  at construction and no `onGet`. Verify: a unit test constructs the service against the fake
  Homebridge API and asserts the characteristic's valid values are restricted to `SINGLE_PRESS`.
- [ ] 6.3 Construct the `Switch` "Dismiss Alarm" service (subtype `alarm-dismiss`) with `onGet`
  gated by the same `noResponseAfterMs`/`platformStartedAt` escalation predicate
  `ThermostatService.assertNotEscalated` uses. Verify: unit test asserting the escalation throws
  under the same conditions as the thermostat's own escalation test.
- [ ] 6.4 Implement `handleChange(change: Change)`: if `change.field === 'isAlarmVibrating' &&
  change.side === side`, (a) push the dismiss switch's `On` characteristic to `change.current`
  whenever it differs from the currently-published value, and (b) additionally fire
  `ProgrammableSwitchEvent.SINGLE_PRESS` on the press service iff `change.previous === false &&
  change.current === true` (`alarm-events` spec, rising-edge and pre-existing-vibration
  requirements). Verify: unit tests for exactly the four scenarios in `alarm-events` spec's
  first requirement (rising edge fires once, falling edge fires nothing, unchanged fires
  nothing, `previous === undefined` fires nothing).
- [ ] 6.5 Implement the dismiss switch's `onSet`: `false` calls
  `writeQueue.submitSide(side, { isAlarmVibrating: false })`, mapping `AwayModeBlockedError` to
  `NOT_ALLOWED_IN_CURRENT_STATE` (with a scheduled revert, task 6.6) and any other rejection to
  `SERVICE_COMMUNICATION_FAILURE` (identical shape to `ThermostatService.wireWrites`); `true`
  never calls `writeQueue` and instead schedules the same revert. Verify: unit tests for
  `alarm-events` spec's "Turning the switch off stops the alarm," "...is harmless," and "Turning
  the dismiss switch on is accepted and reverted" requirements, including asserting no
  `isAlarmVibrating: true` patch is ever submitted.
- [ ] 6.6 Implement the ~500 ms accept-then-revert timer for an on-write, reusing
  `ThermostatService`'s named delay constant and injected-`TimerApi` pattern, reverting to the
  snapshot's *actual current* `isAlarmVibrating` value (not a hardcoded `false`). Verify:
  fake-timer unit test asserting the switch's `On` characteristic reverts to the observed value
  after the delay, for both an actually-vibrating and a not-vibrating case.
- [ ] 6.7 Implement the B1 initial-publish call from the constructor (mirrors
  `ThermostatService`/`ConnectionService`): seed the dismiss switch's initial state from
  `ctx.snapshot.get()[side].isAlarmVibrating` without ever firing a press. Verify: unit test
  constructing the service against a snapshot already reporting `isAlarmVibrating: true` and
  asserting the dismiss switch reads `true` while the press service records zero presses.
- [ ] 6.8 Implement `stop()` clearing any pending revert timer, mirroring
  `ThermostatService.stop()`. Verify: unit test asserting no timer remains after `stop()` even
  with a revert pending.

## 7. Platform wiring

- [ ] 7.1 In `src/platform.ts`, construct one `AlarmWindowScheduler` per launch alongside
  `poller`/`writeQueue`/`keepAlive`, wiring `parsed.data.pollIntervals.alarmPollIntervalMs`
  through (falling back to the schema default when omitted, matching how `fastPollIntervalMs`
  is threaded today). Verify: `npm run typecheck`, extend `test/platform.wiring.test.ts`.
- [ ] 7.2 Add `alarmWindowScheduler.stop()` to the existing `api.on('shutdown', ...)` handler
  alongside `poller?.stop()`/`writeQueue?.stop()`/`keepAlive?.stop()`. Verify: unit test
  asserting no timer remains scheduled after a simulated shutdown (`platform` spec's "Shutdown
  releases everything" scenario, extended).
- [ ] 7.3 Add `ALARM_PRESS_SUBTYPE`/`ALARM_DISMISS_SUBTYPE` to `enabledServiceKeysFor`'s
  side-role branch (never the hub branch). Verify: unit test extending `platform.test.ts`'s
  prune-on-restore coverage, asserting a synthetic alarm service on the hub is pruned and one on
  a side accessory is kept (`platform` spec's modified "Exactly three bridged accessories..."
  requirement).
- [ ] 7.4 In `constructServicesFor`, construct one `AlarmService` per side role (never for the
  hub), storing it the same way `this.thermostats` stores `ThermostatService` instances. Verify:
  `npm run typecheck`, plus the fresh-install scenario in task 9's integration test.
- [ ] 7.5 In `handleSnapshotChanges`, add a branch routing an `isAlarmVibrating` change to that
  side's `AlarmService.handleChange(change)`, removing `isAlarmVibrating` from the "no published
  service watches these fields yet" comment. Verify: unit test asserting a left-side alarm
  change reaches only the left `AlarmService` (`platform` spec's new "A side's alarm-vibration
  change reaches that side's alarm services" scenario).
- [ ] 7.6 Add `thermostat.stop()`-style cleanup for each `AlarmService` in the shutdown handler
  (clearing any pending revert timer). Verify: unit test asserting no timer remains after
  shutdown even with a revert pending at shutdown time.

## 8. Config and platform tests

- [ ] 8.1 `test/config.test.ts`: assert `alarmPollIntervalMs`'s default (`3000`), minimum
  rejection (below `3000`), and that a valid non-default value is preserved (`config` spec's
  modified "Reserved keys..." requirement's new scenarios). Verify: `npm test`.
- [ ] 8.2 `test/platform.wiring.test.ts`: assert `alarmPollIntervalMs` is threaded from config
  into the constructed `AlarmWindowScheduler`. Verify: `npm test`.

## 9. End-to-end integration

- [ ] 9.1 Extend `test/mockPod.test.ts` or `test/integration/session.test.ts`: seed a schedule
  with an alarm due in a few (virtual) minutes, drive fake time up to the window's start, assert
  `deviceStatus` polling accelerates to `alarmPollIntervalMs`; call the new
  `pod.setAlarmVibrating(side, true)`; assert the press service fires exactly one `SINGLE_PRESS`
  and the dismiss switch reports on; drive the dismiss switch off through a real `WriteQueue`
  against the mock and assert the mock's `isAlarmVibrating` is `false` and an `ALARM_CLEAR`
  command was recorded; assert polling decelerates again once the window's `untilMs` passes.
  This is the end-to-end proof for issue #16's own "done when" bar. Verify: `npm test`.
- [ ] 9.2 Integration case for the pre-existing-vibration guard: bootstrap the platform against
  a mock already reporting `isAlarmVibrating: true` and assert the dismiss switch reads on while
  zero presses are recorded (`alarm-events` spec's "A pre-existing vibration observed at startup
  fires no press"). Verify: `npm test`.
- [ ] 9.3 Integration case for schedule-edit responsiveness: start with no near-term alarm,
  advance fake time partway, mutate the mock's `schedules` state directly to add a near-term
  alarm, advance past `RECOMPUTE_CEILING_MS`, and assert the fast-poll window activates without
  a restart (`pod-alarm-scheduler` spec's "A schedule edit is eventually reflected"). Verify:
  `npm test`.
- [ ] 9.4 Extend the platform's mock-Pod request-budget guardrail test (`platform` spec's "A
  simulated Home-app session against a mock Pod stays within its request budget") to confirm
  reading the two new alarm characteristics during a read burst causes no additional Pod
  request, consistent with every other published characteristic. Verify: `npm test`.

## 10. Away-mode interaction (gated — design.md Open Question 1)

- [ ] 10.1 Before starting this group, confirm with the tech lead (or check whether
  `away-mode-guard` has been archived/synced into `openspec/specs/pod-write-queue/spec.md` and
  `openspec/specs/away-mode-guard/spec.md`) whether this fix belongs in this change or as an
  immediate follow-up (design.md's Open Question 1). Do not implement 10.2 until resolved.
- [ ] 10.2 If resolved to fix here: in `WriteQueue.dispatch()`, treat a side patch whose only
  field is `isAlarmVibrating` as policy `'plain'` unconditionally, ahead of the existing
  `'block'`/`'mirror'` branch, citing `updateSide`'s alarm block never consulting
  `controlBothSides`/`updateLeft`/`updateRight` (design.md, "Away-mode interaction with the
  dismiss write"). This requires its own delta to `pod-write-queue`'s (or `away-mode-guard`'s,
  whichever the landed spec text lives under by then) spec — write it against the then-current
  main spec text, not this proposal's guess at it. Verify: a unit test asserting a Dismiss-Alarm
  write is neither blocked nor mirrored under either away-mode policy while either side is away,
  and that every other side write's away-mode behavior is unchanged.

## 11. Full local verification

- [ ] 11.1 Run all four CI gates locally per `CLAUDE.md` (`npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build`) and confirm all pass. No live Pod write at any point — mock Pod
  only, per this change's scope note.

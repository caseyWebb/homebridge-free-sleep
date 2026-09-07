## 1. Shared next-alarm computation module

**Adaptation note (implementation time):** resolution 2's provisional ownership claim was
resolved AGAINST this change by the tech-lead addendum: `alarm-events` implemented and now
owns `src/pod/alarmSchedule.ts` first (already merged into `main` ahead of this change), and
this change CONSUMES it — it must not create a duplicate module. `alarm-events`'s own
`deriveUpcomingAlarms` is eligibility-aware (skips a disabled day, uses the job-scheduler's own
weekday-shift convention) and does not implement the noon-based rule tasks 1.1/1.2 describe, so
tasks below are adapted to *add* a second, independent export (`nextAlarmSkipInstant`) to that
same consumed module rather than duplicating its DST-aware timezone-arithmetic primitives —
flagged for scrutiny in the implementation report given the module's ownership is not this
change's.

- [x] 1.1 ~~Create~~ **Extend** `src/pod/alarmSchedule.ts` (consumed, not owned — see adaptation
      note) with an exported `nextAlarmSkipInstant` function that computes the next alarm
      occurrence for a side from `Schedules`, `Settings['timeZone']`, and a supplied "now",
      applying the today-if-before-noon-else-tomorrow rule mirrored from
      `app/src/pages/ControlTempPage/AlarmDisabledDialog.tsx` composed with
      `AlarmNotification.tsx`'s "sleep day" (`now - 12h`) weekday-lookup convention (verified
      against both upstream sources this session), returning an epoch-ms instant (converted to a
      full ISO-8601 UTC string by the caller, `src/services/skipAlarm.ts`). Verified with a unit
      test table in `test/pod/alarmSchedule.test.ts` covering: before noon, at/after noon,
      exactly noon (upstream's `isSameOrAfter` boundary), an alarm exactly at midnight, and a
      time zone with a non-whole-hour UTC offset (`Asia/Kolkata`, UTC+5:30).
- [x] 1.2 Add a pure helper — `isSkipAlarmOn`, in `src/services/skipAlarm.ts` (not
      `alarmSchedule.ts`: this derivation has exactly one caller, unlike the shared module's
      other exports) — that derives the Skip-Next-Alarm on/off boolean from
      `scheduleOverrides.alarm.expiresAt` and a supplied "now" (non-empty and strictly after now
      = on). Verified with unit tests for empty, past, future, and unparseable `expiresAt`.
- [x] 1.3 `alarmSchedule.ts`'s own header comment (owned by `alarm-events`) already documents
      this module as a deliberate convergence point and names this change as its second
      consumer; `nextAlarmSkipInstant`'s own doc comment cross-references both upstream sources
      and explains why it is a second, independent export rather than a reuse of
      `deriveUpcomingAlarms`. Re-read against design.md's "Coordination, not coupling" for
      consistency — confirmed.

## 2. Close the ordering hazard in `WriteQueue`

- [x] 2.1 Implement the drain-inline mechanism in `src/pod/writeQueue.ts` (design.md, "The
      ordering hazard: mechanism..."): before a side lane's `dispatch()` calls
      `awayModeGuard.decide()`, detect a settings-lane write (pending or mutex-queued but not
      yet run) that touches `left.awayMode` or `right.awayMode`, remove it from `mutexQueue`
      if already enqueued, and run its flush-and-dispatch inline to full settlement before
      proceeding. Verified with unit tests (both submission orders x both settings-POST
      outcomes, through the real mutex against `startMockPod()`) asserting no deadlock occurs
      and that `decide()` is never called before that settings write settles.
- [x] 2.2 Added the regression test reproducing the hazard scenario from design.md /
      `specs/pod-write-queue/spec.md`'s new scenarios: a side write submitted, then — within
      the same debounce window — an `awayMode: false` settings write submitted whose
      `postSettings` is made to reject; asserts the side write's decision matches what it would
      have been had the settings write never been submitted (still governed by `awayMode:
      true`, still refused under `'block'`). Placed in `test/writeQueue.test.ts`'s
      "drain-before-decide" describe block, with a comment stating explicitly it is derived
      from first-principles analysis, not a recovered PR #39 probe. Verified: temporarily
      disabling the drain call reproduces the failure (confirmed this session), restoring it
      passes.
- [x] 2.3 Added the mirror-order regression test: settings write submitted first, side write
      second, settings write fails — asserts the side write's decision is already correctly
      governed by `awayMode: true`. Confirmed (this session) it passes with the drain call
      temporarily disabled too, proving 2.1 does not change already-correct behavior.
- [x] 2.4 Updated `src/pod/writeQueue.ts`'s module-level doc comment with a new
      "Drain-before-decide" section alongside the existing away-mode-guard note.

## 3. Config

- [x] 3.1 Added `awayModeSwitch` (boolean, default `true`), `skipAlarmSwitch` (boolean, default
      `true`), and `awayModeTurnsSideOff` (boolean, default `false`) to
      `FreeSleepConfigSchema` in `src/config.ts`. Verified with `test/config.test.ts` cases for
      each key's default and each key's type-rejection.
- [x] 3.2 Added matching fields to `config.schema.json` and a row per key to `README.md`'s
      config table. Verified with the existing schema-parity test extended to cover the three
      new keys (passes: `config.schema.json <-> FreeSleepConfigSchema parity`).

## 4. Away Mode switch service

- [x] 4.1 Created `src/services/awayMode.ts` (`AwayModeService`) with exported
      `AWAY_MODE_SUBTYPE`, following `THERMOSTAT_SUBTYPE`'s pattern. `onGet` reads the cached
      snapshot synchronously (preferring a locally-pending, not-yet-submitted value during the
      service-level debounce window), never fetches, never throws while a snapshot exists.
      Verified with a unit test asserting no request is made on read.
- [x] 4.2 Implemented `onSet`: a local debounce (>= 2s, via `ctx.timers`) coalescing rapid
      toggles to the latest value, plus a per-side 10-second rate-limit window (one combined
      `Math.max` computation), before calling `ctx.writeQueue.submitSettings({[side]:
      {awayMode: value}})`. On a settled failure, throws `HapStatusError
      (SERVICE_COMMUNICATION_FAILURE)` and schedules a corrective `refresh()`. Verified with
      unit tests: single toggle -> exactly one write after debounce; three toggles within 10s
      for one side -> at most one write; a second toggle within 10s of the first submission is
      delayed until the floor elapses; a failed write throws and reverts.
- [x] 4.3 Implemented `awayModeTurnsSideOff` sequencing: when enabled and turning a side's Away
      Mode on, submits and awaits a power-off side write before submitting the `awayMode: true`
      settings write; turning Away Mode off never touches power, regardless of the flag. A
      guarded (`AwayModeBlockedError`) power-off pre-step maps to `NOT_ALLOWED_IN_CURRENT_STATE`,
      distinct from the settings write's own always-`SERVICE_COMMUNICATION_FAILURE` mapping.
      Verified with unit tests for all three scenarios, including observed request ordering.
- [x] 4.4 Wired `AwayModeService` into `src/platform.ts`: constructed per side when
      `config.awayModeSwitch` is true, added to `enabledServiceKeysFor` for side roles, and
      routed `awayMode` snapshot changes to it (`isAwayModeChange`). Verified with unit tests
      (construction, prune-on-restore, routing, shutdown) in `test/platform.wiring.test.ts`.

## 5. Skip Next Alarm switch service

- [x] 5.1 Created `src/services/skipAlarm.ts` (`SkipAlarmService`) with exported
      `SKIP_ALARM_SUBTYPE`. `onGet` derives on/off from the local optimistic shadow when live,
      else from the cached snapshot's raw `scheduleOverrides.alarm.expiresAt` via
      `isSkipAlarmOn` and `ctx.timers.now()`, never fetching, never throwing while a snapshot
      exists. Verified with unit tests: unexpired override -> on; empty/past `expiresAt` -> off;
      self-clears (no write) once fake time advances past `expiresAt`.
- [x] 5.2 Implemented `onSet` ON: computes the next-alarm `expiresAt` via `nextAlarmSkipInstant`
      (task 1.1) from `ctx.snapshot.get()`'s cached schedules/settings, debounces locally
      (>= 2s), then calls `ctx.writeQueue.submitSettings({[side]: {scheduleOverrides: {alarm:
      {disabled: true, timeOverride: '', expiresAt}}}})`; installs the local shadow
      optimistically at submission time. On settled failure, throws
      `SERVICE_COMMUNICATION_FAILURE` and clears the shadow. Verified with unit tests including
      an end-to-end noon-boundary computation and ISO-8601 ('Z'-suffixed, unambiguous UTC)
      format check.
- [x] 5.3 Implemented `onSet` OFF: debounces locally (>= 2s), then calls
      `ctx.writeQueue.submitSettings({[side]: {scheduleOverrides: {alarm: {disabled: false,
      timeOverride: '', expiresAt: ''}}}})`, clearing the local shadow. Verified with a unit
      test.
- [x] 5.4 The shipped `settleWrite` machinery already requests a settings re-read on every
      successful settings dispatch — verified (not reimplemented) with a unit test asserting
      `requestFastPoll('settings', ...)` fires after a successful skip-alarm write.
- [x] 5.5 Wired `SkipAlarmService` into `src/platform.ts`: constructed per side when
      `config.skipAlarmSwitch` is true, added to `enabledServiceKeysFor`. **Adaptation:** no
      snapshot-change routing exists for this service — `scheduleOverrides.alarm.expiresAt` has
      no watched `Change` field in `snapshot.ts` (out of this change's scope; see
      `skipAlarm.ts`'s own module doc), so its only push trigger is its own accept-then-revert
      timer. Verified with unit tests (construction, prune-on-restore) in
      `test/platform.wiring.test.ts`.

## 6. Integration and documentation

- [x] 6.1 Added `test/integration/settingsSwitches.test.ts` exercising both switches end-to-end
      against `startMockPod()`, through the real platform (mirrors `session.test.ts`'s own
      harness): toggling Away Mode changes `settings.{side}.awayMode` in the mock's stored
      state, and (under the default `'mirror'` policy) a subsequent side write is mirrored to
      the other side too; toggling Skip Next Alarm produces a future `expiresAt` scoped to that
      side only (the other side's override and `awayMode` are untouched), and toggling it off
      clears the override. Also covers both config flags' pruning. Passes against the mock, no
      live Pod.
- [x] 6.2 `npm run lint`, `npm run typecheck`, `npm test` (868/868, full suite run twice), and
      `npm run build` all pass locally with the new files included.
- [x] 6.3 Added a new "Away Mode and Skip Next Alarm" subsection to `docs/HOMEKIT.md` plus two
      new service-table rows. `docs/POD-API.md` already documents every Pod-API-level citation
      this change relies on (`awayMode`, `scheduleOverrides.alarm.expiresAt`,
      `powerScheduler.ts`/`temperatureScheduler.ts`/`alarmScheduler.ts`'s early returns) from
      prior changes — the one new citation (`AlarmDisabledDialog.tsx`/`AlarmNotification.tsx`,
      free-sleep's web UI, not its REST API) is out of `POD-API.md`'s own stated scope and is
      instead cited in `alarmSchedule.ts`'s code comments and in the new `HOMEKIT.md` section.

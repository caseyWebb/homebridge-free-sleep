## 1. Shared next-alarm computation module

- [ ] 1.1 Create `src/pod/alarmSchedule.ts` exporting a function that computes the next alarm
      occurrence for a side from `Schedules`, `Settings['timeZone']`, and a supplied "now",
      applying the today-if-before-noon-else-tomorrow rule mirrored from
      `app/src/pages/ControlTempPage/AlarmDisabledDialog.tsx` (target day, alarm `HH:mm`, +2
      minutes), returning a full ISO-8601 string with UTC offset. Verify with a unit test
      table covering: before noon, at/after noon, an alarm exactly at midnight, and a
      time zone with a non-whole-hour UTC offset.
- [ ] 1.2 Add a pure helper (in the same module or `src/pod/types.ts` as appropriate) that
      derives the Skip-Next-Alarm on/off boolean from `scheduleOverrides.alarm.expiresAt` and
      a supplied "now" (non-empty and strictly after now = on). Verify with unit tests for
      empty, past, and future `expiresAt`.
- [ ] 1.3 Document in the module's own header comment that this file is a deliberate
      convergence point for the concurrent, not-yet-created alarm-fast-poll change
      (`docs/HOMEKIT.md`, "Alarm ringing"), per design.md's "Coordination, not coupling" —
      verify by re-reading the comment against design.md's Open Questions section for
      consistency.

## 2. Close the ordering hazard in `WriteQueue`

- [ ] 2.1 Implement the drain-inline mechanism in `src/pod/writeQueue.ts` (design.md, "The
      ordering hazard: mechanism..."): before a side lane's `dispatch()` calls
      `awayModeGuard.decide()`, detect a settings-lane write (pending or mutex-queued but not
      yet run) that touches `left.awayMode` or `right.awayMode`, remove it from `mutexQueue`
      if already enqueued, and run its flush-and-dispatch inline to full settlement before
      proceeding. Verify with a unit test asserting no deadlock occurs (the test completes
      within its normal fake-timer budget) and that `decide()` is never called before that
      settings write settles.
- [ ] 2.2 Add the regression test reproducing the hazard scenario from design.md /
      `specs/pod-write-queue/spec.md`'s new scenarios: a side write submitted, then — within
      the same debounce window — an `awayMode: false` settings write submitted whose
      `postSettings` is made to reject; assert the side write's resulting dispatch body and/or
      the guard's decision matches what it would have been had the settings write never been
      submitted (i.e., still governed by `awayMode: true`). Place it in
      `test/writeQueue.test.ts`, with a comment stating explicitly that it is derived from
      first-principles analysis of issue #18's ordering-hazard comment, not a recovered PR #39
      probe artifact (design.md explains why). Verify: the test fails against the pre-fix
      queue and passes after 2.1.
- [ ] 2.3 Add the mirror-order regression test: settings write submitted first, side write
      second, settings write fails — assert the side write's decision is already correctly
      governed by `awayMode: true` (the "reverse order is safe" case), so 2.1 doesn't regress
      the already-safe ordering. Verify: passes both before and after 2.1 (proving 2.1 doesn't
      change already-correct behavior).
- [ ] 2.4 Update `src/pod/writeQueue.ts`'s module-level doc comment to describe the drain-
      inline mechanism alongside the existing away-mode-guard note. Verify by reading the
      updated comment against design.md's decision text for accuracy.

## 3. Config

- [ ] 3.1 Add `awayModeSwitch` (boolean, default `true`), `skipAlarmSwitch` (boolean, default
      `true`), and `awayModeTurnsSideOff` (boolean, default `false`) to
      `FreeSleepConfigSchema` in `src/config.ts`. Verify with `test/config.test.ts` cases for
      each key's default and each key's type-rejection, per `specs/config/spec.md`'s new
      scenarios.
- [ ] 3.2 Add matching fields to `config.schema.json` and a row per key to `README.md`'s
      config table. Verify with the existing schema-parity test (`test/config.test.ts`, "every
      schema key has a UI field") extended to cover the three new keys.

## 4. Away Mode switch service

- [ ] 4.1 Create `src/services/awayMode.ts` (`AwayModeService`) with an exported subtype
      constant (e.g. `AWAY_MODE_SUBTYPE`), following `THERMOSTAT_SUBTYPE`'s pattern. `onGet`
      reads `ctx.snapshot.get().{side}.awayMode` synchronously, never fetches, never throws
      while a snapshot exists. Verify with a unit test asserting no request is made on read.
- [ ] 4.2 Implement `onSet`: a local debounce (>= 2s, via `ctx.timers`) coalescing rapid
      toggles to the latest value, plus a per-side 10-second rate-limit window, before calling
      `ctx.writeQueue.submitSettings({[side]: {awayMode: value}})`. On a settled failure,
      throw `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` and schedule a corrective
      `refresh()` (mirroring `ThermostatService`'s existing revert pattern). Verify with unit
      tests: single toggle -> exactly one write after debounce; three toggles within 10s for
      one side -> at most one write in that window; a failed write throws and later reads
      revert to the last-confirmed value.
- [ ] 4.3 Implement `awayModeTurnsSideOff` sequencing: when enabled and turning a side's Away
      Mode on, submit and await a power-off side write (`ctx.writeQueue.submitSide(side,
      {isOn: false})`) before submitting the `awayMode: true` settings write; turning Away
      Mode off never touches power, regardless of the flag. Verify with unit tests for: flag
      on + turning on while side is on -> power-off write observably precedes the settings
      write; flag off -> only the settings write occurs; turning off -> only the settings
      write occurs regardless of the flag.
- [ ] 4.4 Wire `AwayModeService` into `src/platform.ts`: construct it per side when
      `config.awayModeSwitch` is true, add its `(UUID, subtype)` to `enabledServiceKeysFor`
      for side roles, and route snapshot changes for the `awayMode` field to it if it needs to
      refresh proactively (check `isThermostatChange`-equivalent routing in
      `handleSnapshotChanges`). Verify with a unit test that disabling `awayModeSwitch` prunes
      an existing service on restore (mirroring the existing `pruneServices` test pattern).

## 5. Skip Next Alarm switch service

- [ ] 5.1 Create `src/services/skipAlarm.ts` (`SkipAlarmService`) with an exported subtype
      constant (e.g. `SKIP_ALARM_SUBTYPE`). `onGet` derives on/off from the local optimistic
      shadow (design.md, "local shadow") when live, else from
      `ctx.snapshot.get().{side}.scheduleOverrides.alarm.expiresAt` via task 1.2's helper and
      the current time (`ctx.timers.now()`), never fetching, never throwing while a snapshot
      exists. Verify with unit tests: unexpired override -> on; empty/past `expiresAt` -> off;
      switch self-clears (no write) once fake time advances past `expiresAt`.
- [ ] 5.2 Implement `onSet` ON: compute the next-alarm `expiresAt` via task 1.1's helper from
      `ctx.snapshot.get()`'s cached schedules/settings, debounce locally (>= 2s), then call
      `ctx.writeQueue.submitSettings({[side]: {scheduleOverrides: {alarm: {disabled: true,
      timeOverride: '', expiresAt}}}})`; install the local shadow optimistically at submission
      time. On settled failure, throw `SERVICE_COMMUNICATION_FAILURE` and clear the shadow.
      Verify with unit tests: before-noon and at/after-noon fixtures produce the expected
      target day; the written `expiresAt` is a full ISO-8601 string with offset (string match
      or `moment.parseZone` round-trip check); a failed write throws and reverts.
- [ ] 5.3 Implement `onSet` OFF: debounce locally (>= 2s), then call
      `ctx.writeQueue.submitSettings({[side]: {scheduleOverrides: {alarm: {disabled: false,
      timeOverride: '', expiresAt: ''}}}})`, clearing the local shadow. Verify with a unit
      test that turning off an active skip produces the expected clearing patch.
- [ ] 5.4 Trigger a settings refresh via the existing `requestFastPoll`/`poller.refresh
      ('settings')` path on a successful write from either 5.2 or 5.3 (design.md: shipped
      `settleWrite` machinery already does this — verify it fires, don't reimplement it).
      Verify with a unit test asserting `poller.refresh('settings')` (or the injected
      equivalent) is invoked once per successful settings write.
- [ ] 5.5 Wire `SkipAlarmService` into `src/platform.ts`: construct per side when
      `config.skipAlarmSwitch` is true, add to `enabledServiceKeysFor`, route relevant
      snapshot changes to it. Verify with a unit test that disabling `skipAlarmSwitch` prunes
      an existing service on restore.

## 6. Integration and documentation

- [ ] 6.1 Extend `test/mockPod.ts`-backed integration coverage (or add a focused integration
      test) exercising both switches end-to-end against the mock: toggling Away Mode changes
      `settings.{side}.awayMode` in the mock's stored state and (for `'mirror'` policy) a
      concurrent side write to the other side is reflected; toggling Skip Next Alarm produces
      a future `expiresAt` in the mock's settings and the mock's own `controlBothSides`/
      alarm-skip semantics are unaffected by unrelated fields. Verify: test passes against
      `test/mockPod.ts` with no live Pod.
- [ ] 6.2 Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` locally
      (per this project's CI gates) and confirm all four pass with the new files included.
      Verify: command exit codes are 0.
- [ ] 6.3 Update `docs/HOMEKIT.md`'s service table (or add a new subsection) documenting the
      Away Mode and Skip Next Alarm switches' HomeKit modeling choices, and update
      `docs/POD-API.md` if any upstream citation used in design.md needs a permanent home
      there. Verify by cross-checking every upstream path cited in design.md appears with a
      matching citation in the docs.

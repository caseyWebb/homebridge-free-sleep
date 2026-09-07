## 1. Vendored types (`src/pod/types.ts`)

- [x] 1.1 Add `ServerStatusSchema` (a fifth top-level block, per design.md's Decision 8) plus a
      local `StatusInfoSchema`-shaped object, citing
      `server/src/routes/serverStatus/serverStatusSchema.ts` in a doc comment with upstream
      version/commit provenance matching the file's existing citation style. Include the twelve
      always-present subsystems (`alarmSchedule`, `database`, `express`, `franken`,
      `frankenMonitor`, `jobs`, `logger`, `powerSchedule`, `primeSchedule`, `rebootSchedule`,
      `systemDate`, `temperatureSchedule`) as required and the six optional keys
      (`analyzeSleepLeft`, `analyzeSleepRight`, `biometricsInstallation`, `biometricsStream`,
      `biometricsCalibrationLeft`, `biometricsCalibrationRight`) as `.optional()` — **corrected
      (N2, PR #44 review)**: only the latter five of those six are actually gated by
      `biometrics.enabled` upstream; `biometricsInstallation` is set unconditionally
      (`server/src/serverStatus.ts`'s `updateServices()`), so calling all six "biometrics-gated"
      was inaccurate even though all six stay `.optional()` in the schema for the same
      read-side-leniency reason. Update the module doc's "Four blocks" table to "Five blocks"
      and note the deviation inline. Verify: a unit test in `test/types.test.ts` parses
      `test/fixtures/serverStatus.json` (task 7.1) successfully and rejects a document with a
      wrong-typed `status` value.
- [x] 1.2 Add a strict `AlarmRequestSchema` (`side`, `vibrationIntensity` 1–100,
      `vibrationPattern` `'double' | 'rise'`, `duration` 1–180 via `.positive().max(180)` —
      **corrected (N1, PR #44 review)**: originally `.min(0).max(180)`, i.e. accepted `0`;
      upstream's own `server/src/db/schedulesSchema.ts`'s `AlarmSchema.duration` is
      `z.number().int().positive().min(0).max(180)`, whose binding lower bound is `.positive()`,
      not the redundant `.min(0)` — `force`), citing `server/src/db/schedulesSchema.ts`'s
      `AlarmJobSchema` and `docs/POD-API.md`'s documented bounds (also corrected from "0–180" to
      "1–180"). Export the inferred `AlarmRequest` type. Verify: a unit test asserts an
      out-of-bounds `vibrationIntensity` (e.g. `0` or `101`) fails validation, and that
      `duration: 0` is rejected while `duration: 1` and `duration: 180` are accepted.
- [x] 1.3 Widen `DeviceStatusPatchSchema` is already `.partial()` over `isPriming: z.boolean()`
      at the top level — confirm no schema change is needed there (only `writeQueue.ts`'s
      `DevicePatch` needs widening, task 2.1); add a regression test asserting
      `DeviceStatusPatchSchema.safeParse({isPriming: true})` succeeds standalone (it already
      should, but this change is the first caller to rely on it in isolation from `left`/
      `right`/`settings`).

## 2. `WriteQueue` device-lane widening (`src/pod/writeQueue.ts`)

- [x] 2.1 Widen `DevicePatch` to `Partial<{v, gainLeft, gainRight, ledBrightness, isPriming}>`.
      Change `dispatch()`'s `lane === 'device'` branch to build
      `{ ...(patch.isPriming !== undefined ? {isPriming: patch.isPriming} : {}), ...(settingsKeys.length > 0 ? {settings: settingsFields} : {}) }`
      instead of unconditionally `{settings: patch}`, where `settingsFields` picks only `v`/
      `gainLeft`/`gainRight`/`ledBrightness` off the merged patch. Verify: a unit test in
      `test/writeQueue.test.ts` asserts a device-lane submission carrying only `isPriming`
      dispatches `{isPriming: true}` with no `settings` key, and a submission carrying only
      `ledBrightness` dispatches `{settings: {ledBrightness: N}}` with no `isPriming` key.
- [x] 2.2 Add a unit test asserting a device-lane submission merging both `isPriming` and a
      settings field within the same debounce window dispatches one request carrying both,
      matching `specs/pod-write-queue/spec.md`'s "A priming trigger and a device-settings
      write merge on the same lane" scenario.
- [x] 2.3 Add `deviceWriteDebounceMs` to `WriteQueueOptions` (default 500, matching design.md's
      Decision 4), and change `submit()`'s debounce-timer scheduling to use it for the
      `'device'` lane and `writeDebounceMs` for every other lane. Verify: a unit test asserts a
      device-lane write submitted twice 450 ms apart (below the new 500 ms default but above
      the shared 400 ms default) is still merged into one dispatch, while an equivalent
      side-lane write at the same spacing already would have flushed under the old shared
      value — i.e. the two lanes now demonstrably use different debounce windows.
- [x] 2.4 Confirm (via existing test re-run, no code change expected) that `settleWrite`'s
      `fastPollLane` computation already treats the `'device'` lane identically to `'left'`/
      `'right'` (`lane === 'settings' ? 'settings' : 'deviceStatus'`) — this is design.md's
      Decision 2 load-bearing fact. Verify: `test/writeQueue.test.ts`'s existing device-lane
      fast-poll assertions (if any) still pass unmodified; if none exist yet, add one asserting
      a successful device-lane dispatch calls `requestFastPoll('deviceStatus', …)`.

## 3. `PodClient` new endpoints (`src/pod/client.ts`)

- [x] 3.1 Add `getServerStatus(signal?): Promise<ServerStatus>` following the existing
      `getServices` pattern (`getJson('/api/serverStatus', ServerStatusSchema, signal)`).
      Verify: `test/client.test.ts` asserts a successful read against `test/mockPod.ts` (once
      task 6.2 lands) parses into the expected shape.
- [x] 3.2 Add a `retry` option threaded through `request`/`requestWithRetry` (defaulting to
      `true`, preserving every existing call site's behavior unchanged), and add
      `postAlarm(request: AlarmRequest, signal?): Promise<void>` that validates against
      `AlarmRequestSchema`, then issues the request with `retry: false` — calling
      `singleAttempt` directly rather than `requestWithRetry` when retry is disabled. Verify:
      a unit test against a fault-injecting mock asserts a network error or 5xx from the alarm
      endpoint results in exactly one request and an immediate rejection, while an identical
      fault against `postSettings` still retries once (regression-proofing that only the new
      method's behavior changed), matching `specs/pod-client/spec.md`'s "A failed trigger is
      not retried" scenario.
- [x] 3.3 Verify `postAlarm` still serializes through the existing per-endpoint `enqueue`
      mechanism: a unit test issues two concurrent `postAlarm` calls and asserts the mock
      observes them one after another, matching `specs/pod-client/spec.md`'s "Two alarm
      triggers... still serialized" scenario.

## 4. `SnapshotStore` server-fault plumbing (`src/pod/snapshot.ts`)

- [x] 4.1 Add a `serverStatus: ServerStatus | undefined` raw-state slot, an
      `observeServerStatus(data: ServerStatus): void` writer (mirroring `observeServices`), and
      a `recordServerStatusFailure(kind: ErrorKind): void` writer paired with a new
      `serverStatusConnection: { online: boolean; lastSuccessAt: number | null }` raw-state
      field, tracked independently of the existing `connection` field (which stays
      device-status-specific per design.md's Decision 7 and the modified pod-snapshot spec's
      new "Subsystem-health reachability" requirement). Verify: a unit test asserts a
      device-status failure does not change `serverStatusConnection.online` and vice versa.
- [x] 4.2 Add a derived `serverFault: boolean` to `EffectiveSnapshot` — computed as "any
      subsystem in `raw.serverStatus` has `status === 'failed'`", `false` when
      `raw.serverStatus` is `undefined`. Add `'serverFault'` to `DeviceChangeField` and wire it
      into `diffWatched`/`pushDeviceChange`. Verify: a unit test asserts a transition from an
      all-healthy to a one-failed-subsystem observation emits exactly one `serverFault` change,
      and an unchanged observation emits none, matching the modified pod-snapshot spec's two
      new scenarios under "Watched fields."
- [x] 4.3 Expose `documents.serverStatus` alongside the existing `documents.deviceStatus/
      settings/schedules/services` in `EffectiveDocuments`. Verify: `npm run typecheck` passes
      and an existing snapshot test asserting `documents`'s shape is updated to include it.

## 5. `PodPoller` subsystem-health class (`src/pod/poller.ts`)

- [x] 5.1 Register a fifth endpoint class, `'serverStatus'`, on `slowPollIntervalMs`, wired to
      `client.getServerStatus` / `snapshot.observeServerStatus` /
      `snapshot.recordServerStatusFailure`, with an `enabled` predicate reading
      `ctx.config.serverFaultSensor` off a value threaded into the poller at construction
      (matching how other config-derived poller behavior is threaded from `src/platform.ts`
      today). Verify: a unit test asserts the class polls when enabled and skips the request
      (while continuing to reschedule) when disabled, matching `specs/pod-poller/spec.md`'s
      modified "One shared poll per endpoint class" scenarios.
- [x] 5.2 Add a unit test asserting the `serverStatus` class's effective interval tracks
      `slowPollIntervalMs`'s configured value identically to `settings`/`schedules`/`services`,
      matching the modified pod-poller spec's "shares the slow-class interval configuration"
      scenario.

## 6. Mock Pod extensions (`test/mockPod.ts`, `test/fixtures/`)

- [x] 6.1 Add `test/fixtures/serverStatus.json`: all twelve always-present subsystems
      `'healthy'`, no biometrics-gated keys present (matching the default `services.json`
      fixture's `biometrics.enabled: true` — decide and document whether the default
      subsystem-health fixture includes the biometrics-gated keys to stay consistent with the
      default services fixture, or omits them to exercise the optional-key leniency path; note
      the choice in `test/fixtures/README.md`). **Revised (N2, PR #44 review):**
      `biometricsInstallation` is added to the fixture, present alongside the five genuinely
      biometrics-gated keys staying absent — it is not one of them (see task 1.1's correction).
      Verify: `test/fixtures.test.ts` parses it through `ServerStatusSchema` (task 1.1) and
      asserts every subsystem's status is not `'failed'`.
- [x] 6.2 Add `GET /api/serverStatus` to `KNOWN_ENDPOINTS` and the request switch: serve
      `state.serverStatus`, seeded from the new fixture with an optional whole-document
      `StartMockPodOptions.state.serverStatus` override, mirroring the existing `services`
      override convention. Verify: `test/mockPod.test.ts` asserts the default response reports
      no failed subsystem, and an override injecting a failed subsystem is served back
      unchanged, matching `specs/pod-test-double/spec.md`'s new "mock serves subsystem health"
      scenarios.
- [x] 6.3 Add `POST /api/alarm` to `KNOWN_ENDPOINTS` and the request switch: validate against
      `AlarmRequestSchema`, push an `ALARM_LEFT`/`ALARM_RIGHT` command (mirroring
      `TEMP_LEVEL_LEFT`/`TEMP_LEVEL_RIGHT`'s existing command-push pattern) whenever `force` is
      true or the addressed side is both on and not away, and record the request regardless.
      Respond `200` with the current schedules document, matching upstream's own response
      shape (`server/src/routes/alarm/alarm.ts`). Verify: `test/mockPod.test.ts` asserts a
      forced trigger against an off, away side is still recorded as a command, matching
      `specs/pod-test-double/spec.md`'s "overriding trigger is recorded" scenario.
- [x] 6.4 Confirm `applyDeviceStatusPatch`'s existing `if (patch.isPriming)` guard already
      reproduces the desired no-op-on-`false` behavior (design.md's Context: this is a direct
      copy of `updateDeviceStatus.ts`'s own truthiness guard, already present in the mock).
      Verify: add a regression test asserting a `{isPriming: false}` device-status POST records
      no priming-related command and does not clear an in-progress prime, matching
      `specs/pod-test-double/spec.md`'s "A false priming-trigger field changes nothing"
      scenario — this test should already pass against the unmodified mock; if it does not,
      that is a pre-existing mock bug this task also fixes.

## 7. Config (`src/config.ts`, `config.schema.json`)

- [x] 7.1 Add four new boolean keys — `primeSwitch`, `ledLightbulb`, `testAlarmSwitch`,
      `serverFaultSensor` — each `z.boolean().default(false)`, with a doc-comment table row
      naming `hub-accessory` as owner, matching `keepAlive`'s existing doc-comment style.
      Verify: `test/config.test.ts` asserts all four default to `false` when omitted and each
      can be independently set to `true`.
- [x] 7.2 Add `deviceWriteDebounceMs` to `PollIntervalsFieldsSchema` (`z.number().int().min(500,
      ...).optional()`), matching the existing per-field style. Verify: `test/config.test.ts`
      asserts the field defaults through `WriteQueue`'s own 500 ms default when omitted from
      config, and rejects a value below 500.
- [x] 7.3 Update `waterLowSensorType`'s doc comment from "Reserved — see module doc" to
      describe its now-live behavior, and update the top-of-file "Consumed vs. reserved config
      keys" table's `waterLowSensorType` row to name `hub-accessory` as owner — mirroring
      `away-mode-guard`'s own precedent for `awayModeWritePolicy` (tasks.md 5.1 there). Verify:
      `test/config.test.ts`'s existing `waterLowSensorType` acceptance/rejection cases continue
      to pass unmodified (no shape change, doc-only).
- [x] 7.4 Add the same six fields (four booleans, `deviceWriteDebounceMs`'s title/default under
      `pollIntervals`, and `waterLowSensorType`'s updated title) to `config.schema.json`,
      matching existing entries' `title`/`type`/`default`/`description` style. Verify: `npm
      test` still passes (schema JSON structure), and `test/config.test.ts`'s (or a new)
      cross-check that every `FreeSleepConfigSchema` key has a `config.schema.json` field
      continues to pass, matching `specs/config/spec.md`'s "The Homebridge UI form exposes
      exactly the schema's keys" requirement.

## 8. Hub services (`src/services/`)

- [x] 8.1 `src/services/waterLow.ts`: `WaterLowService`, subtype `waterLow`, publishing either
      `ContactSensor` or `LeakSensor` per `ctx.config.waterLowSensorType`, following
      `connection.ts`'s `ensureCharacteristic`/`getServiceById`/`wireReads`/`refresh` shape.
      Track the last-reported contact state in a private field so an `'unknown'`
      `waterLevelState` holds it and raises `StatusFault` instead of switching to low. Verify:
      a unit test in `test/services/waterLow.test.ts` covers all three `WaterLevel` states
      against both service-type configurations, matching every scenario in
      `specs/hub-accessory/spec.md`'s first two requirements.
- [x] 8.2 `src/services/prime.ts`: `PrimeService`, subtype `prime`, a `Switch` with `On`'s
      `onGet` reading `ctx.snapshot.get().isPriming ?? false` and `onSet` either calling
      `ctx.writeQueue.submitDeviceSettings({isPriming: true})` (on `true`) or throwing a new
      `PrimeCannotBeStoppedError` before any write (on `false`, design.md's Decision 3), mapped
      in the `onSet` catch to `HapStatusError(NOT_ALLOWED_IN_CURRENT_STATE)` with a retained,
      clearable ~500 ms revert timer pushing `isPriming`'s current cached value; a `stop()`
      method clearing that timer. Verify: a fake-timer unit test in
      `test/services/prime.test.ts` asserts writing `false` sends no request, rejects with the
      mapped HAP status, and the tile is corrected back within 500 ms — matching
      `specs/hub-accessory/spec.md`'s "Turning the switch off is refused" requirement's two
      scenarios.
- [x] 8.3 `src/services/led.ts`: `LedService`, subtype `led`, a `Lightbulb` with `On` and
      `Brightness`. `onSet` for either characteristic reads
      `ctx.snapshot.get().documents.deviceStatus?.settings`, refuses with
      `SERVICE_COMMUNICATION_FAILURE` if that is `undefined` (design.md's Decision 5), else
      submits a full four-key object via `ctx.writeQueue.submitDeviceSettings`, using
      `accessory.context.lastNonZeroBrightness ?? 100` when `On` is set `true` with no
      accompanying `Brightness`, and `0` when `On` is set `false`. Persist
      `lastNonZeroBrightness` to `accessory.context` on every nonzero write. Verify: a unit
      test in `test/services/led.test.ts` covers every scenario in `specs/hub-accessory/
      spec.md`'s LED requirement, including the "carries every other device setting unchanged"
      assertion (inspect the dispatched patch's keys against a snapshot seeded with distinct
      `gainLeft`/`gainRight`/`v` values).
- [x] 8.4 `src/services/testAlarm.ts`: `TestAlarmService`, taking a `side: Side` constructor
      argument, subtype `testAlarmLeft`/`testAlarmRight` per side (**revised, G0 tech-lead
      ruling, PR #44 review** — originally one shared instance targeting both sides; overturned
      because a hub-level both-sides trigger risks vibrating a sleeping partner's side). A
      momentary `Switch` per instance. `onSet(true)` calls `ctx.podClient.postAlarm(...)`
      (threading `PodClient` through `ServiceContext` — see task 9.2) for `this.side` only, with
      `force: true` and a fixed short `vibrationIntensity`/`vibrationPattern`/`duration`, and —
      regardless of the promise's outcome — schedules a ~1 s `ctx.timers.setTimeout` pushing `On`
      back to `false`; `stop()` clears that timer. Verify: a fake-timer unit test in
      `test/services/testAlarm.test.ts` asserts the tile resets to `off` after ~1 s both when the
      write succeeds and when it rejects, and that each side's switch only ever triggers its own
      side (never the other), matching `specs/hub-accessory/spec.md`'s "self-resets... regardless
      of outcome" scenario as revised for two per-side switches.
- [x] 8.5 `src/services/serverFault.ts`: `ServerFaultService`, subtype `serverFault`, a
      `ContactSensor` whose `ContactSensorState` reflects
      `ctx.snapshot.get().serverFault` (task 4.2) and whose `StatusFault`/`StatusActive` reflect
      the new `serverStatusConnection` slot (task 4.1) exactly as `connection.ts` derives its
      own from `connection` — per design.md's Decision 7, these two axes are independent.
      Verify: a unit test in `test/services/serverFault.test.ts` covers all three scenarios in
      `specs/hub-accessory/spec.md`'s server-fault requirement, including the "failing
      observation is distinguished from a failing subsystem" case (assert `ContactSensorState`
      is unchanged while `StatusFault` flips).

## 9. Platform wiring (`src/platform.ts`, `src/services/types.ts`)

- [x] 9.1 Grow `enabledServiceKeysFor('hub', hap)` to include the water-low sensor's
      `${ContactSensor.UUID}:waterLow` (or `${LeakSensor.UUID}:waterLow` per
      `config.waterLowSensorType` — requires threading `config` into this currently
      hap-only-parameterized function) unconditionally, and each of the other four services'
      `${UUID}:${subtype}` only when its config key is `true` — **revised (G0, PR #44 review)**:
      `testAlarmSwitch` now gates *two* keys, `${Switch.UUID}:testAlarmLeft` and
      `${Switch.UUID}:testAlarmRight`, together (still one boolean). Verify: a unit test in
      `test/platform.test.ts` (or wherever `enabledServiceKeysFor` is already covered) asserts
      the returned set's membership across all 16 combinations of the four boolean keys,
      matching `specs/platform/spec.md`'s modified "hub's enabled set grows and shrinks"
      scenario.
- [x] 9.2 Add `podClient: MinimalPodClient` (widened, task 3.2, to include `postAlarm`) to
      `ServiceContext` (`src/services/types.ts`), threaded through `serviceContextFor` — needed
      by `TestAlarmService` (task 8.4), which is the first service to call the client directly
      rather than solely through `writeQueue`/`snapshot`. Verify: `npm run typecheck` passes
      and `test/services/testAlarm.test.ts`'s fixture constructs a `ServiceContext` including
      it.
- [x] 9.3 Grow `constructServicesFor('hub', ...)` to always construct `WaterLowService` and to
      conditionally construct `PrimeService`/`LedService`/`TestAlarmService` (×2, one per
      side — **revised, G0**)/`ServerFaultService` behind their respective config keys, storing
      each in a new private field (mirroring `this.connectionService`) for `handleSnapshotChanges`
      and `shutdown` to reach — `TestAlarmService` in a `Map<Side, TestAlarmService>` mirroring
      `this.thermostats`'s own shape; `LedService` also now retained (S2, PR #44 review) rather
      than discarded after construction, since `handleSnapshotChanges` needs to reach it too.
      Verify: an integration-style test starting the platform with all four keys enabled
      asserts all six hub services (plus connection) exist on the hub accessory — both
      `TestAlarmService` instances included; a second test with all four disabled asserts only
      connection and water-low exist.
- [x] 9.4 Extend `handleSnapshotChanges` to route `'isPriming'` to `PrimeService.refresh()`,
      `'waterLevelState'` to `WaterLowService.refresh()`, and the new `'serverFault'` field to
      `ServerFaultService.refresh()`, replacing the corresponding clauses of the current
      "no published service watches these fields yet" comment. **Revised (S1/S2, PR #44
      review):** also routes the new `'serverStatusOnline'` field to `ServerFaultService.refresh()`
      (the reachability axis, alongside the payload axis above) and the new `'ledBrightness'`
      field to `LedService.refresh()`. Verify: a unit test asserts a snapshot change to each
      field calls only its own service's `refresh()` unaffected by the others, matching
      `specs/platform/spec.md`'s unmodified "A side change reaches only that side" pattern
      applied to these device-level routes.
- [x] 9.5 On `api.on('shutdown', ...)`, call `stop()` on `PrimeService` and every `TestAlarmService`
      instance (the services owning a revert/reset/confirm-check timer — **revised, G0/S3, PR
      #44 review**: two `TestAlarmService` instances now, iterated from the `Map`; `PrimeService`
      also now owns a second timer, `confirmCheckTimer`, cleared by the same `stop()`) alongside
      the existing `poller`/`writeQueue`/`keepAlive`/`thermostat` stops. Verify: a shutdown test
      asserts no pending timer remains after firing shutdown with a refused prime-off write and
      an in-flight test-alarm trigger on *each* side both outstanding, mirroring
      `away-mode-guard`'s own `platform.wiring.test.ts` precedent for `ThermostatService`'s
      revert timer.

## 11. PR #44 code review fixes

- [x] 11.1 (S1) Add `'serverStatusOnline'` to `src/pod/snapshot.ts`'s `DeviceChangeField`/`Change`
      union, diffed in `diffWatched` against `serverStatusConnection.online`, and route it to
      `ServerFaultService.refresh()` in `handleSnapshotChanges` alongside the existing
      `'serverFault'` route. Verify: `test/snapshot.test.ts` asserts a success-then-failure
      transition emits exactly one `serverStatusOnline` change with differing `previous`/
      `current`; `test/platform.wiring.test.ts` asserts it routes only to
      `ServerFaultService.refresh()`.
- [x] 11.2 (S2) Add `'ledBrightness'` to the same union/diff, retain `this.ledService` on the
      platform (previously discarded after construction), and route the field to
      `LedService.refresh()`. Verify: `test/snapshot.test.ts` covers the changed/unchanged
      cases; `test/platform.wiring.test.ts` asserts it routes only to `LedService.refresh()`.
- [x] 11.3 (S3) `PrimeService` schedules one bounded corrective `refresh()`
      (`scheduleConfirmCheck`, mirroring `scheduleRevert`'s retained/clearable-timer shape, torn
      down by `stop()`) after a successful on-write settles, at
      `(ctx.config.pollIntervals.fastPollIntervalMs ?? 5000) + 2000`ms. Verify:
      `test/services/prime.test.ts` asserts an unconfirmed prime returns the tile to off within
      the bound, a confirmed prime stays on, and a second write before the first check fires
      replaces (not stacks) the pending timer.
- [x] 11.4 (S4) Add `WriteQueueOptions.refreshDeviceStatus?: () => Promise<void>`, awaited by
      `dispatch()`'s `device`-lane branch immediately before assembling `body`, only when the
      cycle's patch carries any `DEVICE_SETTINGS_KEYS` field; the settings sub-object is then
      built by backfilling `DEVICE_SETTINGS_KEYS` from the (now freshly-refreshed)
      `snapshot.get().documents.deviceStatus?.settings`, with the patch's own explicit fields
      taking precedence. Wire `refreshDeviceStatus: () => poller.refresh('deviceStatus')` in
      `src/platform.ts`. Simplify `LedService.submitBrightness` to submit only `{ledBrightness}`,
      relying on this backfill instead of reading `v`/`gainLeft`/`gainRight` itself. Verify:
      `test/writeQueue.test.ts`'s dedicated "S4" describe block asserts the dispatched settings
      carry a gain changed by the refresh callback, not the value cached at submission time, and
      that an `isPriming`-only dispatch never calls the refresh callback; every pre-existing
      `test/writeQueue.test.ts` device-lane assertion updated for the now-backfilled dispatch
      shape.
- [x] 11.5 (G0) Split `TestAlarmService` into two per-side instances — see tasks 8.4/9.1/9.3/9.5's
      own revisions above — and update `specs/hub-accessory/spec.md`'s test-alarm requirement,
      `docs/HOMEKIT.md`'s alarm-row table, `README.md`'s `testAlarmSwitch` row, and
      `config.schema.json`'s `testAlarmSwitch` description to describe two per-side switches
      gated by the one existing boolean.
- [x] 11.6 (N1) Tighten `AlarmRequestSchema.duration` to `.positive().max(180)` (task 1.2's own
      revision) and correct `docs/POD-API.md`'s "0–180 seconds" to "1–180 seconds", citing
      upstream's `AlarmSchema.duration`.
- [x] 11.7 (N2) Correct `src/pod/types.ts`'s comment, design.md's Decision 8, and
      `test/fixtures/README.md` to state that only five of the six optional `ServerStatus` keys
      are biometrics-gated — `biometricsInstallation` is set unconditionally upstream — and add
      `biometricsInstallation` to `test/fixtures/serverStatus.json` (task 6.1's own revision).
- [x] 11.8 (N3) Seed `LedService`'s `lastNonZeroBrightness` from the currently-*observed*
      brightness at off-write time (before it is zeroed), not only from a value this plugin
      itself previously wrote. Verify: `test/services/led.test.ts` asserts an externally-set 30,
      turned off then on through this plugin, restores 30, not the plugin-write default of 100.
- [x] 11.9 (N4) Note in `docs/HOMEKIT.md`'s alarm row that `postAlarm`'s rejection is logged and
      swallowed — the HomeKit write itself always reports success.
- [x] 11.10 (N5, deferred) Leave a `TODO` comment in `src/services/types.ts` at the
      `MinimalPodClient` import, referencing this review, rather than restructuring
      `platform.ts`/`services/types.ts` module boundaries in this pass.
- [x] 11.11 (N6) Parameterize `test/pollBudget.test.ts`'s `wire()` helper with an optional
      `serverFaultSensorEnabled` flag threaded to `PodPoller`, and run the five-minute-session
      guardrail for both `false` and `true`, with a derived ceiling for the enabled case (`+2`
      requests: one extra bootstrap poll of the `serverStatus` class, one extra second poll of
      it at the scenario's own t=300s, on the same `slowPollIntervalMs` cadence as
      settings/schedules/services).

## 12. Full verification

- [x] 12.1 Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` locally and
      confirm all four succeed with every module, wiring, and test above in place (per
      `CLAUDE.md`, these are the CI gates).
- [x] 12.2 Run `openspec validate hub-accessory --type change --strict` and confirm it passes
      with no errors.

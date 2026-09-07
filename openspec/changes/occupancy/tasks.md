## 1. Fixtures and provenance (`pod-test-double`)

- [ ] 1.1 Copy the two real captures from
  `/private/tmp/claude-501/-Users-casey-Code-homebridge-free-sleep/3d52b58d-ec6d-41e6-a5b9-a40ad9dfc3ff/scratchpad/capture/metrics-presence.json`
  and `metrics-vitals.json` into `test/fixtures/metricsPresence.json` and
  `test/fixtures/metricsVitals.json` verbatim (no reordering, no key renaming — see design.md's
  Context note that the vitals rows are not left-first and use snake_case field names on
  purpose). Verify: `git diff` shows the two new files with byte-identical content to the
  scratchpad captures.
- [ ] 1.2 Add both to `test/fixtures/README.md`'s provenance table as "captured, verbatim,
  2026-09-06" (Pod 3, free-sleep 2.1.5), with a note that both sides read `present: false`
  (captured shortly after a restart, before any real transition) and that the vitals rows carry
  `hrv: 0`/`breathing_rate: 0` (confirming `README.md`'s "unvalidated" claim empirically).
  Verify: reading the rendered table.

## 2. Vendored types (`pod-client`)

- [ ] 2.1 In `src/pod/types.ts`, add `PresenceSideSchema` (`{ present: z.boolean(),
  lastUpdatedAt: z.string().optional() }`) and `PresenceSchema` (`{ left:
  PresenceSideSchema.optional(), right: PresenceSideSchema.optional() }`), matching upstream's
  own optional-everywhere leniency (`server/src/routes/metrics/presence.ts`'s
  `PresenceDataSchema`) rather than tightening it. Export `PresenceData` (`z.infer`). Verify:
  `PresenceSchema.parse(loadFixture('metricsPresence.json'))` succeeds in a new test.
- [ ] 2.2 In the same file, add `VitalsRecordSchema` (`{ id: z.number(), side: z.string(),
  timestamp: z.string(), heart_rate: z.number().nullable(), hrv: z.number().nullable(),
  breathing_rate: z.number().nullable() }`) — no range bounds on any numeric field (design.md's
  Context: the write-side `vitalsRecordSchema` bounds are never applied to what `GET /vitals`
  returns, and the real capture already violates them). Export `VitalsResponseSchema =
  z.array(VitalsRecordSchema)` and `VitalsRecord`/`VitalsResponse` types. Verify:
  `VitalsResponseSchema.parse(loadFixture('metricsVitals.json'))` succeeds.
- [ ] 2.3 New fixture-parsing test (mirrors the existing per-endpoint fixture tests) asserting
  both new fixtures parse through their respective schemas with no error, and that a fixture
  edited to violate the schema (e.g. `present` as a string) fails the suite naming the
  offending property (`pod-test-double` spec, "Every fixture parses through the vendored wire
  types"). Verify: `npm test`.

## 3. `PodClient` (`pod-client`)

- [ ] 3.1 Add `PodClient.getPresence(signal?: AbortSignal): Promise<PresenceData>` — `GET
  /api/metrics/presence`, parsed through `PresenceSchema`, following `getServices`'s exact
  shape (dedup, per-endpoint serialisation, JSON parse/validate). Verify: unit test against the
  mock (task 6) returns the seeded fixture.
- [ ] 3.2 Add `PodClient.getVitals(query?: { side?: Side; startTime?: string; endTime?: string
  }, signal?: AbortSignal): Promise<VitalsResponse>` — `GET /api/metrics/vitals` with query
  params appended only when given (via `URLSearchParams`, omitting absent keys entirely rather
  than sending them empty), parsed through `VitalsResponseSchema`. No `postPresence`/
  `postVitals` — read-only per proposal.md's Non-Goals. Verify: a unit test against the mock
  asserts the recorded request's query string matches exactly which params were passed, and
  that omitting `side` returns rows for both sides.

## 4. `PodPoller` (`pod-poller`)

- [ ] 4.1 Extend `EndpointClassId` to `'deviceStatus' | 'settings' | 'schedules' | 'services' |
  'presence' | 'vitals'`. Add `occupancySource?: 'none' | 'presence' | 'vitals'` to
  `PollerOptions` (default `'none'`), stored as an instance field. Verify: `npm run typecheck`.
- [ ] 4.2 Register the `'presence'` class: `baseIntervalMs: 30_000`, `read` calls
  `client.getPresence(signal)`, `apply` calls `snapshot.observePresence(value)`, `enabled`
  returns `this.occupancySource === 'presence' && snapshot.documents.services?.biometrics
  .enabled === true`. No `recordFailure` (design.md's "Neither class defines `recordFailure`").
  Verify: a fake-timer unit test with a fake client/snapshot asserts no request is made when
  `occupancySource` is `'none'` or `'vitals'`, or when the last-observed `services` document
  reports `biometrics.enabled: false` or is not yet observed.
- [ ] 4.3 Register the `'vitals'` class: `baseIntervalMs: 60_000`, `read` calls
  `client.getVitals({ startTime, endTime }, signal)` with `startTime`/`endTime` computed from
  `this.timers.now()` and a fixed `VITALS_OCCUPIED_WINDOW_MS = 180_000` constant (no `side`
  filter — one request serves both sides, design.md's "One combined vitals query per poll"),
  `apply` calls `snapshot.observeVitals(value)`, `enabled` mirrors 4.2 for `occupancySource ===
  'vitals'`. Verify: a fake-timer unit test asserts the request's `startTime`/`endTime` query
  params are exactly `now - 180_000` / `now` under the injected clock, and the same
  enabled/disabled matrix as 4.2.
- [ ] 4.4 Verify the `enabled` predicate's existing re-evaluation-every-tick behavior (already
  implemented, no code change needed here) correctly turns `'presence'`/`'vitals'` polling on
  the tick after `services` first reports `biometrics.enabled: true`, with no external kick —
  test by seeding the mock's `services` fixture with `biometrics.enabled: false`, running one
  `services` poll, then flipping the mock's state and running the next one.

## 5. `SnapshotStore` (`pod-snapshot`)

- [ ] 5.1 Add `raw.presence: PresenceData | undefined` and `raw.vitals: VitalsResponse |
  undefined` to `RawState`. Add `documents.presence`/`documents.vitals` to
  `EffectiveDocuments`/`computeEffective()`, matching `documents.schedules`/`documents.services`
  (readable, not watched, per `pod-snapshot`'s existing "schedules/services are readable but
  never watched" rule). Verify: `npm run typecheck`.
- [ ] 5.2 Add private per-side proof-of-life state: `presenceBaseline: Record<Side, string |
  undefined>` and `presenceProven`/`vitalsProven: Record<Side, boolean>`, initialized to
  `undefined`/`false`. Verify: `npm run typecheck`.
- [ ] 5.3 Implement `observePresence(data: PresenceData)`: inside `commit()`, for each side with
  a defined entry in `data`, if `presenceBaseline[side]` is `undefined`, set it to that side's
  `lastUpdatedAt` (design.md's baseline rule) without marking proven; otherwise, if the newly
  observed `lastUpdatedAt` differs from the baseline, set `presenceProven[side] = true` (sticky
  — never unset once true). Set `raw.presence = data`. Verify with a unit test: first
  observation never proves; a second, identical observation still does not prove; a third,
  differing observation proves and stays proven even if a fourth observation reverts to the
  baseline value (`pod-snapshot`-style: "Agreement... sticky" pattern extended to this field).
- [ ] 5.4 Implement `observeVitals(records: VitalsResponse)`: inside `commit()`, for each side,
  set `vitalsProven[side] = true` if any record in `records` has that `side` (sticky — never
  unset once true, regardless of whether a later poll's window is empty). Set `raw.vitals =
  records`. Verify with a unit test: an empty array leaves `vitalsProven` at its prior value for
  both sides (never regresses); a non-empty array for one side proves only that side; a later
  empty array does not un-prove it.
- [ ] 5.5 Extend `EffectiveSideStatus` with `presencePresent`, `presenceActive`,
  `vitalsOccupied`, `vitalsActive` (all `boolean | undefined`). `computeSide` derives:
  `presencePresent = raw.presence?.[side]?.present`; `presenceActive = presenceProven[side] ?
  true : (raw.presence === undefined ? undefined : false)` (undefined until first observed,
  then `false` until proven, matching every other "unknown until observed" field's shape);
  `vitalsOccupied = raw.vitals?.some(r => r.side === side && r.heart_rate != null)` (`undefined`
  when `raw.vitals` itself is `undefined`, `false` when observed but no matching fresh row);
  `vitalsActive` mirrors `presenceActive`'s undefined/false/true shape off `vitalsProven`.
  Verify with unit tests covering all three states (never observed / observed-not-proven /
  proven) for each of the four fields.
- [ ] 5.6 Add `'presencePresent' | 'presenceActive' | 'vitalsOccupied' | 'vitalsActive'` to
  `SideChangeField` and extend `diffWatched`'s per-side loop to compare all four, using the
  existing `pushSideChange` helper unchanged. Verify: a unit test asserts a commit that changes
  only `vitalsOccupied` produces exactly one notification carrying that one field, matching
  `pod-snapshot`'s "one notification per commit" requirement.

## 6. `pod-test-double`: mock endpoints and overrides

- [ ] 6.1 Add `GET /api/metrics/presence` to `test/mockPod.ts`'s known-endpoints switch,
  serving `state.presence` (seeded from `metricsPresence.json` via `buildInitialState`, like
  every other document). Verify: a test starts the mock and asserts a fresh read equals the
  fixture.
- [ ] 6.2 Add `GET /api/metrics/vitals` with real query filtering matching upstream's Prisma
  query (design.md's Context): filter by `side` if given (exact string match, not restricted to
  `'left'|'right'` — mirrors the real column's plain-`String` type), filter `timestamp >=
  startTime` / `<= endTime` if given (parse both the fixture's ISO `timestamp` and the query
  param the same way, e.g. via `Date.parse`), sorted ascending by timestamp. Verify: unit tests
  for each filter combination (side only, time range only, both, neither) against a seeded
  multi-row state.
- [ ] 6.3 Add `StartMockPodOptions.state.presence` (whole-document override, mirroring
  `schedules`/`services`'s override shape — no partial-merge convenience needed) and
  `state.vitals` (whole-array override) so a test can seed "left present: true" or a
  fresh/stale vitals row directly. Verify: a test starts the mock with an override and asserts
  reads reflect it.
- [ ] 6.4 Extend `reset()` to restore `state.presence`/`state.vitals` to the initial snapshot,
  alongside the existing four documents. Verify: a test performs no write to either new
  endpoint (there is none to perform) but confirms `reset()` restores an overridden seed.

## 7. `OccupancySensorService` (`occupancy-sensor`)

- [ ] 7.1 Create `src/services/occupancy.ts` exporting `OccupancySensorService`,
  `OCCUPANCY_SUBTYPE = 'occupancy'`, and `isOccupancyChange(change): boolean` (mirrors
  `isThermostatChange`). Constructor takes `(ctx: ServiceContext, side: Side)`, adds/restores
  `hap.Service.OccupancySensor` with that subtype, adds `StatusActive` if not already present
  (`ensureCharacteristic`-style helper, matching `ConnectionService`), wires `onGet` for
  `OccupancyDetected` and `StatusActive`, and calls `refresh()` once at construction (the B1
  pattern every other service follows). Verify: `npm run typecheck`.
- [ ] 7.2 Implement the source switch: read `ctx.config.occupancySource`; for `'presence'` use
  `(side.presencePresent, side.presenceActive)`; for `'vitals'` use `(side.vitalsOccupied,
  side.vitalsActive)`; for `'none'` this service is never constructed (task 8.1), so no branch
  is needed for it. `OccupancyDetected` onGet: `occupied === undefined ? characteristic.value :
  (occupied ? DETECTED : NOT_DETECTED)`. `StatusActive` onGet: `active === true`. Never throws
  (design.md's "never escalates" decision — no `assertNotEscalated`-style call anywhere in this
  file). Verify with unit tests: never-observed serves `characteristic.value`; observed-not-
  proven reports the raw occupied value with `StatusActive: false`; proven reports both.
- [ ] 7.3 Implement `refresh()`: recompute both characteristics from `ctx.snapshot.get()` and
  push via `updateValue` only on an actual change (the same `pushIfChanged` pattern
  `ConnectionService` uses). Verify: a unit test asserts no push when neither value changed.

## 8. Platform wiring (`platform`)

- [ ] 8.1 Change `enabledServiceKeysFor`'s signature to `(hap, role, occupancySource)`; for a
  side role, include `${hap.Service.OccupancySensor.UUID}:${OCCUPANCY_SUBTYPE}` in the returned
  set iff `occupancySource !== 'none'`; the hub's set is unchanged. Update the one call site in
  `discoverAccessories`/`pruneServices` to pass `config.occupancySource`. Verify: `npm run
  typecheck`, plus a unit test asserting a restored side accessory's occupancy service is
  pruned when config changes from `'presence'` to `'none'` across a restart, and added (not
  duplicated) when it changes the other way.
- [ ] 8.2 In `constructServicesFor`, construct an `OccupancySensorService` per side alongside
  the `ThermostatService` when `config.occupancySource !== 'none'`, stored in a new
  `Map<Side, OccupancySensorService>` field (mirrors `this.thermostats`). Verify:
  `npm run typecheck` and a unit test asserting the map is populated only when configured.
- [ ] 8.3 In `handleSnapshotChanges`, add a branch: `isOccupancyChange(change) &&
  this.occupancySensors.get(change.side)?.refresh()`, alongside the existing thermostat/
  connection branches — still inside the per-change try/catch so one failing service does not
  stop the others (existing pattern, unchanged). Verify: a unit test asserts a `vitalsOccupied`
  change reaches only the affected side's occupancy service.
- [ ] 8.4 Pass `parsed.data.occupancySource` into the `PodPoller` constructor call alongside the
  existing `pollIntervals`-derived options. Verify: `npm run typecheck` and
  `test/platform.wiring.test.ts` extended to assert the poller receives the configured value.

## 9. Config and docs (`config`)

- [ ] 9.1 In `src/config.ts`, move `occupancySource`'s doc comment from "Reserved — see module
  doc" to describe it as consumed by this change (mechanical edit only — the `z.enum(...)
  .default('none')` shape is unchanged). Update the module-level "Consumed vs. reserved" table
  to move `occupancySource` out of the reserved column. Verify: `npm run typecheck` and
  `test/config.test.ts` (task 9.3).
- [ ] 9.2 Update `config.schema.json`'s `occupancySource` field: drop "(reserved, no effect
  yet)" from its title. Verify: `node -e "JSON.parse(require('fs')
  .readFileSync('config.schema.json'))"` and that the key set still matches
  `Object.keys(FreeSleepConfigSchema.shape)`.
- [ ] 9.3 Update `README.md`'s config table row for `occupancySource`: drop "Reserved — no
  effect yet," describe the three values and the `StatusActive` trust caveat for `'presence'`/
  `'vitals'` in one or two sentences, linking to `docs/HOMEKIT.md`'s "Occupancy" section for
  detail. Verify: reading the rendered table.
- [ ] 9.4 Extend `test/config.test.ts`'s existing "reserved key with a valid value is preserved
  but not acted on" case set: remove `occupancySource` from that shared assertion (it is no
  longer merely preserved) and add a case confirming each of the three enum values still
  parses and defaults correctly (this schema shape itself does not change, so this is
  confirmation, not new validation logic). Verify: `npm test`.

## 10. Full local verification

- [ ] 10.1 Run all four CI gates locally per `CLAUDE.md` (`npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build`) and confirm all pass. No live Pod contact at any point — mock Pod
  and fixtures only.
- [ ] 10.2 Extend `test/integration/session.test.ts` (or wherever the whole-platform mock
  session lives) with one end-to-end scenario per source: with `occupancySource: 'presence'`
  and biometrics enabled, a presence transition posted into the mock's state flips the left
  side's `OccupancyDetected` within one presence-poll interval, and `StatusActive` only becomes
  true after that transition, never before. With `occupancySource: 'vitals'`, seeding a fresh
  vitals row flips occupancy within one vitals-poll interval, and `StatusActive` becomes true on
  the very first row (no "wait for a change" requirement, per design.md's asymmetry). Verify:
  `npm test`.

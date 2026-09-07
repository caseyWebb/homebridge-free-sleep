## 1. Config schema

- [ ] 1.1 In `src/config.ts`, add `keepAliveMs` (positive integer, default `43_200_000`,
  minimum bound per design.md Open Question 3) and `keepAliveThresholdMs` (positive integer,
  default `1_800_000`, same minimum bound) to `FreeSleepConfigSchema`, plus a `.refine` (or
  `.superRefine`) rejecting `keepAliveThresholdMs >= keepAliveMs`. Move `keepAlive`'s doc
  comment from "Reserved — see module doc" to describe it as consumed by this change. Verify
  with `npm run typecheck` and by extending `test/config.test.ts` (task 4.1).
- [ ] 1.2 Update `config.schema.json`: drop "(reserved, no effect yet)" from `keepAlive`'s
  title, and add `keepAliveMs`/`keepAliveThresholdMs` fields (type `integer`, matching
  defaults) so every schema key still has exactly one form field
  (`openspec/specs/config/spec.md`, "The Homebridge UI form exposes exactly the schema's
  keys"). Verify by inspecting the JSON is valid (`node -e "JSON.parse(require('fs').readFileSync('config.schema.json'))"`)
  and that its key set matches `Object.keys(FreeSleepConfigSchema.shape)`.
- [ ] 1.3 Update `README.md`'s "Config keys" table: `keepAlive`'s row loses "Reserved — no
  effect yet"; add rows for `keepAliveMs` and `keepAliveThresholdMs` describing their defaults
  and the threshold-below-duration constraint. Verify by reading the rendered table.

## 2. `KeepAlive` module

- [ ] 2.1 Create `src/pod/keepAlive.ts` exporting a `KeepAlive` class per design.md's "A new,
  small, timer-owning module" decision: constructor options `{ snapshot: SnapshotStore,
  writeQueue: WriteQueue, timers?: TimerApi, logger?: Logger, keepAliveMs: number,
  keepAliveThresholdMs: number, enabled: boolean }`. Verify with `npm run typecheck`.
- [ ] 2.2 Implement the derived cadence: check interval
  `clamp(keepAliveThresholdMs / 2, 60_000, 900_000)` and, per side, a `nextDueAtMs` cooldown of
  `now + (keepAliveMs - keepAliveThresholdMs)` set after a successful submission (design.md,
  "Check cadence and re-arm cooldown are both derived from the threshold"). Verify with a unit
  test asserting the computed interval for a representative set of threshold values (including
  the floor and ceiling clamps).
- [ ] 2.3 Implement the per-tick decision for each side: read `snapshot.get()[side]` fresh: skip
  if `isOn !== true`; skip if `now < nextDueAtMs[side]`; skip if `secondsRemaining === undefined`
  or `secondsRemaining * 1000 >= keepAliveThresholdMs`; otherwise call
  `writeQueue.submitSide(side, { secondsRemaining: Math.round(keepAliveMs / 1000) })` and, on a
  resolved (not rejected) submission, set `nextDueAtMs[side]`. Verify with the fake-timer unit
  tests in task 4.2–4.5.
- [ ] 2.4 Implement `start()`/constructor behavior: schedule nothing at all when `enabled` is
  `false` (design.md, Goals: "no HomeKit-visible surface" / config-gated). Implement `stop()`:
  cancel the scheduled timer and make it safe to call whether or not the timer was ever started
  (mirrors `PodPoller.stop()`/`WriteQueue.stop()`'s idempotent shutdown). Verify with the
  disabled-config and stop() unit tests (tasks 4.6–4.7).
- [ ] 2.5 Route all timer access through the injected `TimerApi` (`src/pod/snapshot.ts`) —
  no direct `setTimeout`/`Date.now` reference, consistent with `poller.ts`/`writeQueue.ts`.
  Verify: the existing `no-restricted-globals` ESLint scoping (if it covers this file) passes,
  or `npm run lint` passes with the same discipline applied by hand.

## 3. Platform wiring

- [ ] 3.1 In `src/platform.ts`, construct a `KeepAlive` alongside the existing `poller`/
  `writeQueue` construction, mapping `parsed.data.keepAlive` to `enabled` and
  `parsed.data.keepAliveMs`/`keepAliveThresholdMs` through unchanged. Verify with
  `npm run typecheck` and by extending `test/platform.wiring.test.ts`.
- [ ] 3.2 Add `keepAlive?.stop()` to the existing `api.on('shutdown', ...)` handler, alongside
  `poller?.stop()`/`writeQueue?.stop()`. Verify with a unit test asserting no timer remains
  scheduled after a simulated shutdown (mirrors the existing poller/write-queue shutdown test
  pattern).

## 4. Tests

- [ ] 4.1 `test/config.test.ts`: add cases for `keepAliveMs`/`keepAliveThresholdMs` defaults,
  type/range rejection, and the `keepAliveThresholdMs < keepAliveMs` cross-field rejection
  (`openspec/specs/config/spec.md`'s new "ADDED Requirements" scenarios). Verify: `npm test`.
- [ ] 4.2 New `test/keepAlive.test.ts`: using `createManualTimers()`/`createTimerHarness()`
  (`test/manualTimers.ts`, `test/timerHarness.ts`) and a fake `SnapshotStore` seeded via
  `observeDeviceStatus` from a fixture, assert a side observed on with `secondsRemaining` below
  the configured threshold produces exactly one `writeQueue.submitSide` call carrying
  `{ secondsRemaining: keepAliveMs / 1000 }` once the check timer fires
  (`pod-keep-alive` spec, "A side nearing expiry while on is re-armed"). Verify: `npm test`.
- [ ] 4.3 Same harness: a side observed on with `secondsRemaining` at or above the threshold
  produces no write across several tick advances (`pod-keep-alive` spec, "A side comfortably
  above the threshold is left alone"). Verify: `npm test`.
- [ ] 4.4 Same harness: a side observed off (including one whose `secondsRemaining` was
  previously below threshold, then observed as `0`/`isOn: false` — simulating the daily reboot)
  never produces a write, across several tick advances (`pod-keep-alive` spec, "A side that is
  off is never written to" and "A reboot is not mistaken for a side needing a keep-alive").
  Verify: `npm test`.
- [ ] 4.5 Same harness: after one re-arm fires, advance fake time by less than
  `keepAliveMs - keepAliveThresholdMs` with the snapshot's `secondsRemaining` left unchanged
  (simulating no poll having observed the new value yet, per `test/mockPod.ts`'s no-decay
  behavior, Context) and assert no second write is submitted; then advance past that point and
  assert a second re-arm does fire (`pod-keep-alive` spec, "A redundant re-arm is suppressed
  until it would matter again"). Verify: `npm test`.
- [ ] 4.6 Same harness: construct `KeepAlive` with `enabled: false` and a side already on and
  past the threshold; advance fake time well past the check interval; assert no write is ever
  submitted and no timer is scheduled (`pod-keep-alive` spec, "Disabling keep-alive stops all
  checks and writes"). Verify: `npm test`.
- [ ] 4.7 Same harness: call `stop()` (a) before the first tick and (b) after several ticks;
  assert no further check runs and no timer remains scheduled in either case, matching the
  shutdown-leaves-no-timers pattern already used for `PodPoller`/`WriteQueue` (`pod-keep-alive`
  spec, "Stopping the system cancels its schedule"). Verify: `npm test`, including that the
  test process exits cleanly with no open-handle warning.
- [ ] 4.8 Mock-Pod-as-oracle integration case in `test/mockPod.test.ts` or
  `test/integration/session.test.ts`: seed the mock with a side on and a low
  `secondsRemaining`, drive a `KeepAlive` tick through a real `WriteQueue` against the mock
  client, and assert the mock's resulting `secondsRemaining` equals `keepAliveMs / 1000` — this
  exercises the real `reduceDurationFields` path end-to-end rather than a hand-rolled fake
  (design.md Context, "the mock Pod is the oracle"). Verify: `npm test`.
- [ ] 4.9 Reduction-interaction case (documents the accepted race from design.md's Risks,
  rather than trying to prevent it): submit a `KeepAlive` re-arm and, within the same debounce
  window, submit `{ isOn: false }` for the same side through `WriteQueue` directly; assert the
  dispatched body and the mock's resulting state match `pod-write-queue`'s already-specified
  four-case reduction (`secondsRemaining` wins), confirming this change does not alter that
  existing, reviewed behavior. Verify: `npm test`.

## 5. Full local verification

- [ ] 5.1 Run all four CI gates locally per `CLAUDE.md` (`npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build`) and confirm all pass. No live Pod write at any point — mock Pod
  only, per this change's scope note.

## 6. User-intent priority (added at reconcile — design resolution 5)

- [ ] 6.1 Add the write origin (`'user'` default | `'keepAlive'`) to `submitSide` and drop
  keep-alive-origin duration fields when merged with a user-origin `isOn` in the same
  debounce window, before the four-case reduction. Verified by a mock-as-oracle test: user
  off + same-window re-arm → side ends OFF and no optimistic-tile reversion; re-arm alone →
  duration refreshed. Both directions asserted.

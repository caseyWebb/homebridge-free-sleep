## 1. `AwayModeGuard` module

- [ ] 1.1 Create `src/pod/awayModeGuard.ts`: an `AwayModeGuard` class taking `{ writeQueue,
      snapshot, policy: 'mirror' | 'block', timers?, logger? }` in its constructor, exposing
      `guardSideWrite(side: Side, patch: SidePatch): Promise<void>` — the named shared surface
      design.md commits to for `keep-alive` to adopt later. Same module-dependency discipline as
      `poller.ts`/`writeQueue.ts` (imports only `writeQueue.ts`, `snapshot.ts`, `types.ts`; no HAP,
      no `test/` import). Verify: `npm run typecheck` passes and `npm run lint` reports no
      violation of the `no-restricted-globals` rule scoped to `src/pod/*.ts`.
- [ ] 1.2 Add `AwayModeBlockedError` (extends `Error`, `name` set via `new.target.name` matching
      `WriteQueueStoppedError`'s existing pattern in `writeQueue.ts`) to the same module. Verify:
      a unit test constructs it and asserts `instanceof Error` and a stable `.name`.
- [ ] 1.3 Implement the decision: inside `writeQueue.runExclusive`, read `snapshot.get()`,
      compute `left.awayMode === true || right.awayMode === true`; when false, resolve `'plain'`.
      When true, resolve the configured `policy`. Verify: a unit test with a fake `SnapshotStore`
      (or a real `SnapshotStore` seeded via `observeSettings`) asserts the decision for all four
      `(leftAway, rightAway)` combinations crossed with both policies.
- [ ] 1.4 Implement the `'plain'` and `'block'` branches: `'plain'` calls
      `writeQueue.submitSide(side, patch)` and returns its promise unchanged; `'block'` throws
      `AwayModeBlockedError` **before** calling `writeQueue.submitSide` at all — no request of any
      kind. Verify: a unit test with a spy `WriteQueue` asserts `submitSide` is never called on
      the `'block'` path, and the rejection is `instanceof AwayModeBlockedError`.
- [ ] 1.5 Implement the `'mirror'` branch: call `writeQueue.submitSide(side, patch)` and, using
      the same reduced-patch fields the addressed write carries (`targetTemperatureF`, `isOn`,
      `isAlarmVibrating` — the overlayable fields per `snapshot.ts`'s `OverlayableField`), also
      call `writeQueue.submitSide(otherSide, patch)` with the identical values; return only the
      addressed side's promise to the caller. Verify: a unit test with a spy `WriteQueue` asserts
      both `submitSide` calls happen with matching field values, and the returned promise settles
      with the addressed side's outcome only.
- [ ] 1.6 Verify the exclusive-section boundary design.md specifies: the decision closure passed
      to `runExclusive` never itself calls or awaits `submitSide` — write a unit test using fake
      timers that submits an unrelated write via `writeQueue.runExclusive`/mutex queuing
      concurrently with a guarded call, and asserts the unrelated write is not delayed by a
      guarded write's debounce-plus-dispatch window (only by the synchronous decision).

## 2. Platform wiring

- [ ] 2.1 In `src/platform.ts`, construct one `AwayModeGuard` per launch (alongside the existing
      snapshot/poller/write-queue construction), passing `parsed.data.awayModeWritePolicy` as
      `policy` and the same shared `timers`. Verify: a platform-wiring test
      (`test/platform.wiring.test.ts` pattern) asserts exactly one `AwayModeGuard` instance is
      constructed per platform instantiation.
- [ ] 2.2 Add `awayModeGuard: AwayModeGuard` to `ServiceContext` (`src/services/types.ts`) and
      thread it through `serviceContextFor` in `src/platform.ts`, alongside `writeQueue`. Verify:
      `npm run typecheck` passes; a test constructing a `ServiceContext` fixture includes it.
- [ ] 2.3 On `api.on('shutdown', ...)`, no separate stop is needed for `AwayModeGuard` itself
      (it owns no timers or open handles of its own — it only calls into `writeQueue`, which is
      already stopped there); verify by asserting shutdown still leaves no open timer handle
      (existing `platform.wiring.test.ts` shutdown assertion continues to pass unmodified).

## 3. Thermostat write-path rewiring

- [ ] 3.1 In `src/services/thermostat.ts`, change `targetStateChar.onSet` and
      `targetTempChar.onSet` to call `this.ctx.awayModeGuard.guardSideWrite(this.side, patch)`
      instead of `this.ctx.writeQueue.submitSide(this.side, patch)` directly. Verify: existing
      `test/services/thermostat.test.ts` write-path tests continue to pass with a fake
      `AwayModeGuard` (or a real one wrapping a fake `WriteQueue`) substituted for direct
      `writeQueue` assertions.
- [ ] 3.2 Add a `catch` clause distinguishing `AwayModeBlockedError` from any other rejection:
      on `AwayModeBlockedError`, throw `new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_
      CURRENT_STATE)`; on anything else, keep the existing `SERVICE_COMMUNICATION_FAILURE`
      behavior unchanged. Verify: a unit test asserts each error type maps to its distinct HAP
      status.
- [ ] 3.3 On the `AwayModeBlockedError` path, schedule (via `this.ctx.timers.setTimeout`, ~500 ms)
      a call to `this.refresh()` to correct any characteristic value HAP applied optimistically
      ahead of the throw. Verify: a fake-timer test writes a temperature while blocked, advances
      time 500 ms, and asserts the characteristic's value is back to the cached snapshot's value
      (matching the "A blocked write throws a distinct HAP status and reverts the tile" scenario
      in `specs/thermostat-service/spec.md`).

## 4. Cross-cutting and integration tests

- [ ] 4.1 Add a test exercising the full stack — `FreeSleepPlatform` → `ThermostatService` →
      `AwayModeGuard` → `WriteQueue` → `PodClient` → `test/mockPod.ts` — asserting: with the left
      side away and `awayModeWritePolicy: 'block'`, a right-side temperature write is rejected,
      the mock records zero commands for it, and the left side's mock state is unchanged. Verify:
      the test passes against the real mock Pod (no live Pod), matching
      `specs/away-mode-guard/spec.md`'s "A blocked write never reaches the Pod" scenario.
- [ ] 4.2 Add the `'mirror'` counterpart: with the left side away and `awayModeWritePolicy:
      'mirror'`, a right-side temperature write reaches the mock Pod, the mock's own
      `controlBothSides` mirroring changes both sides' hardware state (already covered by
      `test/mockPod.test.ts`'s "away-mode both-sides mirroring" suite), and — the new assertion —
      the plugin's own cached snapshot reports the left side's target temperature updated too,
      without waiting for the next settings/deviceStatus poll. Verify: matches
      `specs/away-mode-guard/spec.md`'s "A mirrored write updates both sides' cached view"
      scenario.
- [ ] 4.3 Add a test for the "either side" symmetry requirement: right-away + left-write, and
      both-away + either-side-write, both apply the configured policy identically to the
      single-side-away cases already covered. Verify: matches "Either side being away is
      sufficient to trigger the policy."
- [ ] 4.4 Add a test for the concurrency requirement: submit an away-mode-toggling settings write
      and a side write to the other side at nearly the same simulated instant (fake timers, zero
      or minimal delay between the two calls), and assert the side write's guard decision is
      consistent with one clear ordering of the toggle (never a torn/partial state). Verify:
      matches "A concurrent away-mode toggle does not race the check."
- [ ] 4.5 Add a test asserting the zero-cost common path: with neither side away, a guarded write
      results in exactly the same single request the pre-guard `submitSide` call would have made,
      with no additional request of any kind. Verify: matches "Neither side away leaves a write
      untouched" and confirms this change adds no overhead to the already-tested
      `pod-write-queue` request-budget scenarios (`test/pollBudget.test.ts`).

## 5. Config and docs

- [ ] 5.1 No `src/config.ts` or `config.schema.json` change is needed — `awayModeWritePolicy`'s
      shape (`'mirror' | 'block'`, default `'mirror'`) already matches this change's design.
      Verify: `test/config.test.ts`'s existing `awayModeWritePolicy` cases
      (including the `'block'` acceptance and `'ignore'` rejection cases) continue to pass
      unmodified.
- [ ] 5.2 Update `README.md`'s reserved-keys table row for `awayModeWritePolicy`: remove
      "Reserved — no effect yet," state what `'mirror'` and `'block'` now each do, and document
      the residual out-of-band-change race in one sentence pointing at the settings poll
      interval. Verify: manual read-through; no automated check, since README prose isn't tested.
- [ ] 5.3 Update `config.schema.json`'s `awayModeWritePolicy` title from "Away-mode write policy
      (reserved, no effect yet)" to a description of the live behavior. Verify: `npm test` still
      passes (schema JSON structure/enum values are unchanged, only `title` text) and the
      Homebridge UI's config form (manual check, not automatable in this repo) renders the
      updated copy.

## 6. Full verification

- [ ] 6.1 Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` locally (per
      `CLAUDE.md`, these are the CI gates and must all pass before merging) and confirm all four
      succeed with the new module, wiring, and tests in place.

## 1. `AwayModeGuard` module

- [x] 1.1 Create `src/pod/awayModeGuard.ts`: an `AwayModeGuard` class taking `{ writeQueue,
      snapshot, policy: 'mirror' | 'block', timers?, logger? }` in its constructor, exposing
      `guardSideWrite(side: Side, patch: SidePatch): Promise<void>` — the named shared surface
      design.md commits to for `keep-alive` to adopt later. Same module-dependency discipline as
      `poller.ts`/`writeQueue.ts` (imports only `writeQueue.ts`, `snapshot.ts`, `types.ts`; no HAP,
      no `test/` import). Verify: `npm run typecheck` passes and `npm run lint` reports no
      violation of the `no-restricted-globals` rule scoped to `src/pod/*.ts`.
      **Adaptation (tech-lead resolution 2):** `AwayModeGuard` does NOT take `writeQueue` and does
      NOT expose `guardSideWrite` — enforcement moved inside `WriteQueue.dispatch()` itself (see
      group 3's adaptation and `design.md`'s "Resolutions"), so a front-door wrapper no longer
      exists. `AwayModeGuard` holds only `{ snapshot, policy, logger? }` and exposes one method,
      `decide(): 'plain' | 'mirror' | 'block'` — a pure, side-independent, synchronous decision.
      It imports only `snapshot.ts` (never `writeQueue.ts`), so `writeQueue.ts` can import *it*
      without a cycle. Implemented in `src/pod/awayModeGuard.ts`; unit-tested in
      `test/pod/awayModeGuard.test.ts`. `npm run typecheck`/`npm run lint` both pass.
- [x] 1.2 Add `AwayModeBlockedError` (extends `Error`, `name` set via `new.target.name` matching
      `WriteQueueStoppedError`'s existing pattern in `writeQueue.ts`) to the same module. Verify:
      a unit test constructs it and asserts `instanceof Error` and a stable `.name`.
      Implemented as specified. Tested in `test/pod/awayModeGuard.test.ts`.
- [x] 1.3 Implement the decision: inside `writeQueue.runExclusive`, read `snapshot.get()`,
      compute `left.awayMode === true || right.awayMode === true`; when false, resolve `'plain'`.
      When true, resolve the configured `policy`. Verify: a unit test with a fake `SnapshotStore`
      (or a real `SnapshotStore` seeded via `observeSettings`) asserts the decision for all four
      `(leftAway, rightAway)` combinations crossed with both policies.
      **Adaptation (tech-lead resolution 2):** no separate `runExclusive` call wraps the decision —
      `AwayModeGuard.decide()` is called directly from inside `WriteQueue.dispatch()`, which
      already runs as one atomic step under the queue's own mutex (see group 3's adaptation for
      why a second `runExclusive` is unnecessary there). The four-combination × two-policy matrix
      is unit-tested in `test/pod/awayModeGuard.test.ts` exactly as specified.
- [x] 1.4 Implement the `'plain'` and `'block'` branches: `'plain'` calls
      `writeQueue.submitSide(side, patch)` and returns its promise unchanged; `'block'` throws
      `AwayModeBlockedError` **before** calling `writeQueue.submitSide` at all — no request of any
      kind. Verify: a unit test with a spy `WriteQueue` asserts `submitSide` is never called on
      the `'block'` path, and the rejection is `instanceof AwayModeBlockedError`.
      **Adaptation:** `'plain'`/`'block'` are branches inside `WriteQueue.dispatch()` now, not a
      wrapper around `submitSide` — `'plain'` falls through to the existing dispatch code
      unchanged; `'block'` clears the write's own already-installed overlay, rejects every waiter
      with `AwayModeBlockedError`, and returns before any client call. Verified in
      `test/writeQueue.test.ts`'s "away-mode guard (9.6)" section: block never issues a request,
      rejects with `AwayModeBlockedError`, and leaves the cached view unchanged.
- [x] 1.5 Implement the `'mirror'` branch: call `writeQueue.submitSide(side, patch)` and, using
      the same reduced-patch fields the addressed write carries (`targetTemperatureF`, `isOn`,
      `isAlarmVibrating` — the overlayable fields per `snapshot.ts`'s `OverlayableField`), also
      call `writeQueue.submitSide(otherSide, patch)` with the identical values; return only the
      addressed side's promise to the caller. Verify: a unit test with a spy `WriteQueue` asserts
      both `submitSide` calls happen with matching field values, and the returned promise settles
      with the addressed side's outcome only.
      **Adaptation:** the mirrored write is issued by a new private `WriteQueue.mirrorToOtherSide`
      method, not a second `submitSide` call from an external wrapper. This is a deliberate,
      necessary adaptation, not a style choice: since the guard is now consulted on *every*
      side-lane dispatch (resolution 2), re-entering `submitSide`/`dispatch()` for the mirrored
      side would consult the guard again there too and — since neither the policy nor the away
      state changed — decide `'mirror'` again, mirroring back to the originating side forever.
      `mirrorToOtherSide` reuses the queue's own overlay-install/rebase/clear/fast-poll machinery
      (preserving the "one overlay writer" invariant and every guarantee `submitSide` already
      makes) via a dedicated one-shot mutex task that never re-enters the guarded dispatch path.
      Only the addressed side's own promise is affected by the guard's outcome; the mirror is
      fire-and-forget from the addressed dispatch's point of view. Verified in
      `test/writeQueue.test.ts` (both fake-client and real-mock-Pod cases) and in the full-stack
      `test/awayModeGuard.integration.test.ts`.
- [x] 1.6 Verify the exclusive-section boundary design.md specifies: the decision closure passed
      to `runExclusive` never itself calls or awaits `submitSide` — write a unit test using fake
      timers that submits an unrelated write via `writeQueue.runExclusive`/mutex queuing
      concurrently with a guarded call, and asserts the unrelated write is not delayed by a
      guarded write's debounce-plus-dispatch window (only by the synchronous decision).
      **Adaptation:** there is no separate exclusive section to bound any more — the guard's
      decision is one synchronous statement inside `dispatch()`, which already runs for its
      entire async lifetime under the queue's existing mutex (true before this change too, for
      every lane). The property this task cared about (a guarded write's own network round trip
      never blocks an unrelated dispatch beyond what the mutex already serializes) holds by
      construction: `mirrorToOtherSide` never awaits inside the addressed dispatch, so it cannot
      extend that dispatch's own mutex hold. Covered by `test/writeQueue.test.ts`'s existing 9.1
      "mutex" test (unchanged behavior) plus the away-mode-guard-specific 9.6 tests, which confirm
      a `'block'` decision issues no request at all (fastest possible path) and a `'mirror'`
      decision's addressed-side promise settles independently of the mirror's own dispatch.

## 2. Platform wiring

- [x] 2.1 In `src/platform.ts`, construct one `AwayModeGuard` per launch (alongside the existing
      snapshot/poller/write-queue construction), passing `parsed.data.awayModeWritePolicy` as
      `policy` and the same shared `timers`. Verify: a platform-wiring test
      (`test/platform.wiring.test.ts` pattern) asserts exactly one `AwayModeGuard` instance is
      constructed per platform instantiation.
      Implemented as specified, plus: the constructed `awayModeGuard` is passed into
      `WriteQueue`'s own constructor options (`awayModeGuard`), since the queue is now the one
      that consults it. (`AwayModeGuard` takes no `timers` — see 1.1's adaptation — so only
      `snapshot`/`policy` are passed.)
- [x] 2.2 Add `awayModeGuard: AwayModeGuard` to `ServiceContext` (`src/services/types.ts`) and
      thread it through `serviceContextFor` in `src/platform.ts`, alongside `writeQueue`. Verify:
      `npm run typecheck` passes; a test constructing a `ServiceContext` fixture includes it.
      Implemented as specified. Note: with enforcement moved inside `WriteQueue` (resolution 2),
      no service *needs* to read `ctx.awayModeGuard` to be protected — `writeQueue.submitSide`
      already guards every side write regardless of caller. It is threaded through `ServiceContext`
      anyway, for parity with `snapshot`/`writeQueue` and for any future consumer that wants to
      inspect the configured policy directly. Test fixtures updated in
      `test/services/thermostat.test.ts` and `test/services/connection.test.ts`.
- [x] 2.3 On `api.on('shutdown', ...)`, no separate stop is needed for `AwayModeGuard` itself
      (it owns no timers or open handles of its own — it only calls into `writeQueue`, which is
      already stopped there); verify by asserting shutdown still leaves no open timer handle
      (existing `platform.wiring.test.ts` shutdown assertion continues to pass unmodified).
      Confirmed true a fortiori under the adapted design: `AwayModeGuard` no longer calls into
      `writeQueue` at all (it is the other way around), owns no timers, and needs no stop() of its
      own. `platform.wiring.test.ts`'s existing shutdown test passes unmodified.

## 3. Thermostat write-path rewiring

- [x] 3.1 In `src/services/thermostat.ts`, change `targetStateChar.onSet` and
      `targetTempChar.onSet` to call `this.ctx.awayModeGuard.guardSideWrite(this.side, patch)`
      instead of `this.ctx.writeQueue.submitSide(this.side, patch)` directly. Verify: existing
      `test/services/thermostat.test.ts` write-path tests continue to pass with a fake
      `AwayModeGuard` (or a real one wrapping a fake `WriteQueue`) substituted for direct
      `writeQueue` assertions.
      **Adaptation (tech-lead resolution 2 — this is the central adaptation of this change):**
      this task is superseded, not implemented as written. `targetStateChar.onSet` and
      `targetTempChar.onSet` continue calling `this.ctx.writeQueue.submitSide(this.side, patch)`
      exactly as before this change — unchanged call sites. There is no `guardSideWrite` method
      and no rewiring of the call site at all. Protection comes from `WriteQueue.submitSide`
      itself: `dispatch()` now consults the injected `AwayModeGuard` for every side-lane write it
      processes, regardless of which service or feature called `submitSide`. This is exactly what
      resolution 2 mandates: "a front-door wrapper that callers must remember to use is exactly
      the bypass risk keep-alive's resolution 4 forbids." All existing `thermostat.test.ts`
      write-path tests pass unmodified (a default, policy-agnostic `AwayModeGuard` is
      constructed internally by `WriteQueue` when none is injected, so any test not exercising
      away mode sees identical behavior to before this change).
- [x] 3.2 Add a `catch` clause distinguishing `AwayModeBlockedError` from any other rejection:
      on `AwayModeBlockedError`, throw `new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_
      CURRENT_STATE)`; on anything else, keep the existing `SERVICE_COMMUNICATION_FAILURE`
      behavior unchanged. Verify: a unit test asserts each error type maps to its distinct HAP
      status.
      Implemented exactly as specified, in both the mode-write and setpoint-write `onSet` catch
      blocks. `AwayModeBlockedError` is imported from `src/pod/awayModeGuard.ts` (its new home —
      see 1.1's adaptation). Tested in `test/services/thermostat.test.ts`'s new "away-mode block
      maps to NOT_ALLOWED_IN_CURRENT_STATE and reverts the tile (3.2, 3.3)" describe block and, at
      the full-stack level, in `test/awayModeGuard.integration.test.ts`.
- [x] 3.3 On the `AwayModeBlockedError` path, schedule (via `this.ctx.timers.setTimeout`, ~500 ms)
      a call to `this.refresh()` to correct any characteristic value HAP applied optimistically
      ahead of the throw. Verify: a fake-timer test writes a temperature while blocked, advances
      time 500 ms, and asserts the characteristic's value is back to the cached snapshot's value
      (matching the "A blocked write throws a distinct HAP status and reverts the tile" scenario
      in `specs/thermostat-service/spec.md`).
      Implemented exactly as specified, as `ThermostatService.scheduleAwayModeRevert()`. Tested in
      `test/services/thermostat.test.ts`'s "~500ms after a blocked setpoint write, the
      characteristic is corrected back to the cached snapshot value" — deliberately without the
      test also wiring `ctx.snapshot.subscribe(() => service.refresh())`, to isolate this specific
      mechanism from the pre-existing (unrelated) snapshot-subscription-driven revert that a real
      `FreeSleepPlatform` provides via `handleSnapshotChanges`.

## 4. Cross-cutting and integration tests

- [x] 4.1 Add a test exercising the full stack — `FreeSleepPlatform` → `ThermostatService` →
      `AwayModeGuard` → `WriteQueue` → `PodClient` → `test/mockPod.ts` — asserting: with the left
      side away and `awayModeWritePolicy: 'block'`, a right-side temperature write is rejected,
      the mock records zero commands for it, and the left side's mock state is unchanged. Verify:
      the test passes against the real mock Pod (no live Pod), matching
      `specs/away-mode-guard/spec.md`'s "A blocked write never reaches the Pod" scenario.
      **Adaptation:** the call chain has no separate `AwayModeGuard` hop (resolution 2) — it is
      `FreeSleepPlatform` → `ThermostatService` → `WriteQueue` (consulting `AwayModeGuard`
      internally at dispatch) → `PodClient` → `test/mockPod.ts`. Implemented in
      `test/awayModeGuard.integration.test.ts`, driven through HAP's real `handleSetRequest`
      (matching `test/integration/session.test.ts`'s convention), with `ManualTimers` (real HTTP
      against the mock Pod).
- [x] 4.2 Add the `'mirror'` counterpart: with the left side away and `awayModeWritePolicy:
      'mirror'`, a right-side temperature write reaches the mock Pod, the mock's own
      `controlBothSides` mirroring changes both sides' hardware state (already covered by
      `test/mockPod.test.ts`'s "away-mode both-sides mirroring" suite), and — the new assertion —
      the plugin's own cached snapshot reports the left side's target temperature updated too,
      without waiting for the next settings/deviceStatus poll. Verify: matches
      `specs/away-mode-guard/spec.md`'s "A mirrored write updates both sides' cached view"
      scenario.
      Implemented in `test/awayModeGuard.integration.test.ts` and, at the `WriteQueue` level
      (against the real mock Pod, asserting the actual POST count), in `test/writeQueue.test.ts`.
- [x] 4.3 Add a test for the "either side" symmetry requirement: right-away + left-write, and
      both-away + either-side-write, both apply the configured policy identically to the
      single-side-away cases already covered. Verify: matches "Either side being away is
      sufficient to trigger the policy."
      Implemented at three levels: `test/pod/awayModeGuard.test.ts` (all four `(leftAway,
      rightAway)` combinations against both policies, proving `decide()` is side-independent by
      construction — it takes no `side` parameter at all), `test/writeQueue.test.ts` (right-away +
      left-write and both-away, against a real `WriteQueue`), and
      `test/awayModeGuard.integration.test.ts` (the same two cases full-stack).
- [x] 4.4 Add a test for the concurrency requirement: submit an away-mode-toggling settings write
      and a side write to the other side at nearly the same simulated instant (fake timers, zero
      or minimal delay between the two calls), and assert the side write's guard decision is
      consistent with one clear ordering of the toggle (never a torn/partial state). Verify:
      matches "A concurrent away-mode toggle does not race the check."
      Implemented in `test/writeQueue.test.ts` ("a concurrent away-mode toggle does not race the
      check"): `submitSettings` and `submitSide` are called back-to-back in the same synchronous
      tick; because `submitSettings`'s away-mode overlay installs synchronously at the call site
      (pre-existing `WriteQueue` behavior, unmodified by this change), the later side write's
      dispatch-time guard check always observes the toggle by the time it actually runs, for
      either submission order.
- [x] 4.5 Add a test asserting the zero-cost common path: with neither side away, a guarded write
      results in exactly the same single request the pre-guard `submitSide` call would have made,
      with no additional request of any kind. Verify: matches "Neither side away leaves a write
      untouched" and confirms this change adds no overhead to the already-tested
      `pod-write-queue` request-budget scenarios (`test/pollBudget.test.ts`).
      Implemented in `test/writeQueue.test.ts` and, full-stack, in
      `test/awayModeGuard.integration.test.ts`. `test/pollBudget.test.ts` itself needed no change
      and continues to pass unmodified — it never seeds away mode, so every write it exercises
      takes the `'plain'` branch, identical to pre-change behavior.

## 5. Config and docs

- [x] 5.1 No `src/config.ts` or `config.schema.json` change is needed — `awayModeWritePolicy`'s
      shape (`'mirror' | 'block'`, default `'mirror'`) already matches this change's design.
      Verify: `test/config.test.ts`'s existing `awayModeWritePolicy` cases
      (including the `'block'` acceptance and `'ignore'` rejection cases) continue to pass
      unmodified.
      Confirmed: `test/config.test.ts` passes unmodified (68/68). `config.schema.json`'s `type`,
      `default` and `oneOf` enum values for `awayModeWritePolicy` are unchanged — only its
      `title` text changed (see 5.3).
- [x] 5.2 Update `README.md`'s reserved-keys table row for `awayModeWritePolicy`: remove
      "Reserved — no effect yet," state what `'mirror'` and `'block'` now each do, and document
      the residual out-of-band-change race in one sentence pointing at the settings poll
      interval. Verify: manual read-through; no automated check, since README prose isn't tested.
      Done.
- [x] 5.3 Update `config.schema.json`'s `awayModeWritePolicy` title from "Away-mode write policy
      (reserved, no effect yet)" to a description of the live behavior. Verify: `npm test` still
      passes (schema JSON structure/enum values are unchanged, only `title` text) and the
      Homebridge UI's config form (manual check, not automatable in this repo) renders the
      updated copy.
      Done; `npm test` confirmed passing with the JSON structure otherwise unchanged.

## 6. Full verification

- [x] 6.1 Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` locally (per
      `CLAUDE.md`, these are the CI gates and must all pass before merging) and confirm all four
      succeed with the new module, wiring, and tests in place.
      All four gates pass locally (see PR description / final report for the exact run).

## Additional adaptation not tracked by a pre-existing task

The tech-lead resolution moving enforcement inside `WriteQueue` narrows a requirement
`pod-write-queue`'s own (already-shipped) spec previously made unconditionally ("The queue holds
no policy about away mode"). `proposal.md`'s Non-Goals ("No change to `WriteQueue`'s ... specs")
and `design.md`'s Context both predate resolution 2 and no longer hold on this one point. Rather
than leave the main `pod-write-queue` spec inaccurate after this change ships, a MODIFIED delta
was added at `openspec/changes/away-mode-guard/specs/pod-write-queue/spec.md`, narrowing that
requirement to describe the queue's own no-policy-on-keep-alive/schedules guarantees plus its new
away-mode consultation. `openspec validate away-mode-guard --type change --strict` passes with
this delta in place.

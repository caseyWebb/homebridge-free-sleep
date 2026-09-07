## 1. #33 — clamp target temperature at the service boundary

- [ ] 1.1 Add `clampTargetF(f: number): number` to `src/pod/temperature.ts`, clamping to
      `[F_MIN, F_MAX]`. Verify with a unit test in `test/pod/temperature.test.ts` (or wherever
      that module's existing tests live) covering below-range, in-range, and above-range input.
- [ ] 1.2 In `src/services/thermostat.ts`, apply `clampTargetF` to `side.targetTemperatureF`
      before `fToC` in `targetTempChar.onGet`. Verify with a unit test asserting `onGet` returns
      the clamped bound (converted) when the snapshot's `targetTemperatureF` is set above 110 or
      below 55.
- [ ] 1.3 In `src/services/thermostat.ts`'s `refresh()`, compute the target-temperature argument
      to `pushTemperature` as `side.targetTemperatureF === undefined ? undefined :
      clampTargetF(side.targetTemperatureF)`, so both the shadow comparison and the pushed value
      use the clamped degree. Leave `pushTemperature` itself and the `currentF` call site
      unchanged. Verify with the regression test in 1.4.
- [ ] 1.4 Add the #33 regression test to `test/services/thermostat.test.ts`: an observation
      reporting `targetTemperatureF` outside 55–110°F is published as the clamped bound and the
      shadow records the clamped value (not the raw one); a subsequent observation reporting an
      in-range degree different from that clamped bound still produces exactly one
      `updateValue` call. Verify: `npm test` passes and the new test fails against the
      pre-change code (confirm by temporarily reverting 1.2/1.3 locally, or by inspection that
      the old code's `shadow.targetF === observedF` comparison would use the raw out-of-range
      value).
- [ ] 1.5 Add a code comment at `computeCurrentState`'s delta calculation noting it
      deliberately uses the raw, unclamped `targetTemperatureF` (design.md, "#33: clamp at
      three read sites," row 3), pointing at the two clamped call sites so a future reader does
      not "fix" the asymmetry. Verify by reading the diff — no test needed for a comment.

## 2. #14 — full-range-drag-under-race integration test

- [ ] 2.1 In `test/integration/session.test.ts`, extend the "slider-drag guardrail (8.4)"
      `describe` block with a new test: drive `handleSetRequest` for `TargetTemperature` through
      every whole degree from `F_MIN` to `F_MAX` (56 writes), spaced so the whole drag exceeds
      `writeMaxDebounceMs` (use `bootSession` with a small `pollIntervals.writeMaxDebounceMs`
      override, e.g. 200ms, so the drag provably spans more than one write-queue batch without
      needing an unreasonably long test). Verify: the test compiles and the drag completes
      (`Promise.all` on every `handleSetRequest` call resolves) before assertions run.
- [ ] 2.2 In the same test, before starting the drag, record `contactState`-style instrumentation
      on the `TargetTemperature` characteristic (`vi.spyOn(targetTempChar, 'updateValue')`, per
      the pattern in `test/services/thermostat.test.ts` 5.1) so every push during the drag is
      observable. Mid-drag (after a handful of writes have already been submitted but before the
      first batch's dispatch has settled — use `pod.state.deviceStatus.left.targetTemperatureF`
      direct mutation to set a stale value distinct from every value the drag has used or will
      use, simulating an external/earlier observation), trigger a poll tick via `timers.advance`
      set to land inside that window. Verify: the spy's recorded call sequence, read back after
      the whole drag settles, contains no value equal to the injected stale reading, and the
      degrees the spy *did* record are non-decreasing (never regress toward an earlier point in
      the drag).
- [ ] 2.3 Assert the drag still ends with exactly the last degree written as both the published
      `TargetTemperature` value and the mock's recorded `POST /api/deviceStatus` body/bodies'
      final `targetTemperatureF` (allowing more than one POST now that the drag spans multiple
      batches, unlike 8.4's single-batch case — assert the *last* POST carries `F_MAX`, not that
      there is exactly one). Verify: `npm test` passes.
- [ ] 2.4 Confirm task 2.1–2.3's test would fail without the architecture described in
      design.md's "#14" decision — do this by inspection (walk `WriteQueue.submit`,
      `syncOverlays`, `SnapshotStore.computeSide` against the test's timeline) rather than by
      breaking the implementation, since there is no proposed code change to revert. Record the
      inspection's conclusion in the PR description, not in this file.

## 3. Docs

- [ ] 3.1 Update `docs/HOMEKIT.md`'s "Anti-jitter" section: state the full-range-drag guarantee
      explicitly (the overlay suppresses every disagreeing observation for `writeSettleMs`,
      re-armed on every write and on every successful dispatch, which is why a full-range drag
      cannot snap back), and add the clamp-at-the-boundary rule for `targetTemperatureF`
      (`F_MIN`/`F_MAX`, read schema stays lenient). Verify by re-reading the section against
      design.md's "Decisions" for accuracy — no test, this is documentation.

## 4. Verification gates

- [ ] 4.1 `npm run lint` passes with no new violations. Verify: exit code 0.
- [ ] 4.2 `npm run typecheck` passes. Verify: exit code 0.
- [ ] 4.3 `npm test` passes, including the two new tests (1.4, 2.1–2.3). Verify: exit code 0 and
      the new test names appear in vitest's output.
- [ ] 4.4 `npm run build` succeeds and `dist/` contains no test-only imports. Verify: exit code 0.
- [ ] 4.5 `openspec validate anti-jitter --strict` passes. Verify: exit code 0, no warnings.

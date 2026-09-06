## 1. Preconditions

- [ ] 1.1 Confirm the `tooling-and-ci` toolchain has landed and the test-only HAP dependency
  is installed: `npm test` exits 0 on the current tree, and
  `node --input-type=module -e "import('@homebridge/hap-nodejs').then(m => console.log(typeof m.Characteristic.TargetTemperature))"`
  prints `function`. If either fails, stop — this change cannot be verified without them.

## 2. The module

- [ ] 2.1 Create `src/pod/temperature.ts` exporting `F_MIN = 55`, `F_MAX = 110`,
  `fToC = (f) => (f - 32) * 5 / 9`, and `cToF = (c) => c * 9 / 5 + 32`, with no imports.
  Verify with a unit test in `test/pod/temperature.test.ts` asserting the anchor points
  `fToC(32) === 0`, `fToC(212) === 100`, `fToC(-40) === -40`, that `cToF` inverts `fToC`
  across 55–110 to within `Number.EPSILON * 100`, and that `fToC(40)` returns the true
  negative Celsius value rather than a clamped one — `npm test` passes.
- [ ] 2.2 Add `TARGET_TEMP_PROPS = { minValue: fToC(F_MIN), maxValue: fToC(F_MAX) + 0.2,
  minStep: 5 / 9 }` to the same module, with a comment stating that the `+0.2` margin and
  the `5/9` step are load-bearing and pointing at `docs/HOMEKIT.md`. Verify with unit
  assertions that `minValue === fToC(55)`, `minStep === 5 / 9`, and that the margin is
  strictly between 0 and one full step
  (`0 < maxValue - fToC(F_MAX) && maxValue - fToC(F_MAX) < minStep`) — the upper bound is
  what keeps a 111 °F grid point out, which the Pod's zod validator would reject
  (`~/Code/free-sleep/server/src/routes/deviceStatus/deviceStatusSchema.ts:9-10`).
- [ ] 2.3 Confirm the module stays runtime-HAP-free and stateless: verify
  `grep -rn "hap-nodejs\|homebridge" src/pod/temperature.ts` returns nothing, and that the
  file contains no `import` statement at all.

## 3. Verification against a real HAP characteristic

- [ ] 3.1 Before writing assertions, confirm how HAP-NodeJS actually enumerates a numeric
  characteristic that has `minValue`/`maxValue`/`minStep` but no explicit `validValues`:
  read `validValuesIterator` in the installed
  `node_modules/@homebridge/hap-nodejs/dist/lib/Characteristic.js` (or `.d.ts` plus source)
  and record in the commit message whether it walks the step grid. Verified by that reading;
  if it does not walk the grid, do task 3.2 by direct endpoint probing instead of by count
  and note the discrepancy for a follow-up to `docs/HOMEKIT.md` (design.md — Risks).
- [ ] 3.2 In `test/pod/temperature.test.ts`, construct a real
  `Characteristic.TargetTemperature` from `@homebridge/hap-nodejs`, call
  `setProps(TARGET_TEMP_PROPS)`, and assert
  `Array.from(char.validValuesIterator())` has length `F_MAX - F_MIN + 1` (56), with a
  comment naming the bug it guards. Verified by `npm test` passing.
- [ ] 3.3 Prove that assertion is not vacuous: temporarily replace `maxValue` with
  `fToC(F_MAX)` (no margin) and confirm the length assertion fails at 55, then restore the
  margin and confirm it passes at 56. Verified by observing both outcomes; record the
  observed counts in the commit message.
- [ ] 3.4 Add the golden round-trip test: for every integer `f` from `F_MIN` to `F_MAX`, call
  `char.updateValue(fToC(f))` on a characteristic with `TARGET_TEMP_PROPS` applied and assert
  `Math.round(cToF(char.value as number)) === f`. Verified by `npm test` passing all 56
  cases.
- [ ] 3.5 Prove the round-trip test catches the step bug independently of 3.2: temporarily
  set `minStep` to `0.5` and confirm the golden test fails (some degrees unreachable), then
  restore `5 / 9`. Verified by observing the failure and the subsequent pass.
- [ ] 3.6 Confirm the suite needs no Pod and no network: run `npm test` with networking
  disabled and verify it still exits 0.

## 4. Acceptance

- [ ] 4.1 Run `npm run lint`, `npm run typecheck`, and `npm test`; verify all three exit 0
  and that `npm run build` emits `dist/pod/temperature.js` while emitting nothing from
  `test/`.
- [ ] 4.2 Walk the delta spec `openspec/changes/temperature-mapping/specs/temperature-mapping/spec.md`
  requirement by requirement and confirm each scenario maps to a passing assertion (or, for
  the two non-CI-verifiable ones, to a recorded note): range endpoints, conversion
  exactness/invertibility/no-clamping, whole-degree grid, 56 valid values plus reachable
  upper endpoint plus nothing above it, golden round-trip against real HAP, and
  statelessness/offline/no-runtime-HAP. Verified by the checklist being complete.
- [ ] 4.3 Deferred to M2, not this change: on a real paired device, confirm the Home app's
  Fahrenheit slider steps one degree at a time and reaches both 55 °F and 110 °F
  (`docs/HOMEKIT.md` — the rendering claim CI cannot verify). Record the observation on
  issue #6 when the first Thermostat accessory ships; do not block this change on it.

## 5. Documentation correction (added at reconcile by tech lead)

- [ ] 5.1 Correct the margin-mechanism paragraph in `docs/HOMEKIT.md`: the `+0.2` margin and
  its consequence (110 °F unreachable without it) are right, but the documented cause is not —
  `(fToC(110) - fToC(55)) / (5/9)` evaluates to exactly 55.0, not 54.99…; the real failure is
  floating-point error accumulating across the ~55 repeated `minStep` additions in HAP's
  `validValuesIterator` walk (see design.md Risks and the task 3.1 reading of the installed
  library). Rewrite the paragraph to describe the observed mechanism, keeping the conclusion
  and the test guidance unchanged. Verified by re-reading against task 3.1's recorded findings.

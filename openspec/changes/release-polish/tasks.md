## 1. Shared naming convention (#49)

- [ ] 1.1 Add `src/services/serviceName.ts` (or equivalent) documenting/exporting the Decision-3
      label convention — a small helper (e.g. `sideServiceLabel(accessory, label)` returning
      `` `${accessory.displayName} ${label}` ``) for side-accessory sub-services; hub sub-services
      keep using their existing exported name constants directly. Verify: `npm run typecheck`
      passes and a new `test/services/serviceName.test.ts` unit-tests the helper's output for a
      couple of representative accessory display names (including one containing special
      characters, to confirm no escaping/formatting surprises).

## 2. ConfiguredName seeding per service (#49)

For each task below: add, immediately after the existing `addService`/`getServiceById` call,
```ts
if (!this.service.testCharacteristic(hap.Characteristic.ConfiguredName)) {
  this.service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
  this.service.setCharacteristic(hap.Characteristic.ConfiguredName, label);
}
```
(design.md, Decision 1 and 2) with `label` per Decision 3. Verify each with a unit test asserting:
(a) `ConfiguredName` is present and equals the expected label after first construction; (b) a
second construction against the same (now-deserialized-with-a-different-value) service leaves an
already-set `ConfiguredName` value unchanged, simulating a controller rename surviving a restart;
(c) no `characteristic-warning` event fires on either construction.

- [ ] 2.1 `ThermostatService` (`src/services/thermostat.ts`) — label `` `${accessory.displayName}
      Thermostat}` ``. Verify: `test/services/thermostat.test.ts` extended per the pattern above,
      `npm test` passes.
- [ ] 2.2 `AlarmService`'s alarm-press `StatelessProgrammableSwitch` and its "Dismiss Alarm"
      `Switch` (`src/services/alarm.ts`) — labels `` `${accessory.displayName} Alarm` `` and
      `` `${accessory.displayName} Dismiss Alarm` ``. Verify: `test/services/alarm.test.ts`
      extended, `npm test` passes.
- [ ] 2.3 `OccupancyService` (`src/services/occupancy.ts`) — label `` `${accessory.displayName}
      Occupancy` `` (already the existing `Name` convention; now also the `ConfiguredName` seed).
      Verify: `test/services/occupancy.test.ts` extended, `npm test` passes.
- [ ] 2.4 `AwayModeService` (`src/services/awayMode.ts`) — label `` `${accessory.displayName} Away
      Mode` ``, replacing the hardcoded `AWAY_MODE_NAMES[side]` as the `ConfiguredName` seed
      specifically (the `Name` characteristic argument is unchanged per design.md's Non-Goals).
      Verify: `test/services/awayMode.test.ts` extended, `npm test` passes.
- [ ] 2.5 `SkipAlarmService` (`src/services/skipAlarm.ts`) — label `` `${accessory.displayName}
      Skip Next Alarm` ``. Verify: `test/services/skipAlarm.test.ts` extended, `npm test` passes.
- [ ] 2.6 `ConnectionService` (`src/services/connection.ts`) — label `POD_CONNECTION_NAME`
      verbatim. Verify: `test/services/connection.test.ts` extended, `npm test` passes.
- [ ] 2.7 `LedService` (`src/services/led.ts`) — label `POD_LED_NAME` verbatim. Verify:
      `test/services/led.test.ts` extended, `npm test` passes.
- [ ] 2.8 `PrimeService` (`src/services/prime.ts`) — label `POD_PRIME_NAME` verbatim. Verify:
      `test/services/prime.test.ts` extended, `npm test` passes.
- [ ] 2.9 `WaterLowService` (`src/services/waterLow.ts`) — label `POD_WATER_LOW_NAME` verbatim
      (regardless of `waterLowSensorType`). Verify: `test/services/waterLow.test.ts` extended,
      `npm test` passes.
- [ ] 2.10 `ServerFaultService` (`src/services/serverFault.ts`) — label `POD_SERVER_FAULT_NAME`
      verbatim. Verify: `test/services/serverFault.test.ts` extended, `npm test` passes.
- [ ] 2.11 `TestAlarmService` (`src/services/testAlarm.ts`) — label `TEST_ALARM_NAMES[side]`
      verbatim (already fully-formed, e.g. "Test Alarm Left"). Verify:
      `test/services/testAlarm.test.ts` extended, `npm test` passes.

## 3. Upgrade-path and warning-free regression coverage (#49)

- [ ] 3.1 Add or extend an integration test (`test/integration/session.test.ts` or a new
      `test/integration/configuredName.test.ts`) that constructs a full platform against a fake
      Homebridge API seeded with pre-#49 cached-accessory JSON (services present, no
      `ConfiguredName` characteristic on any of them) and asserts every service ends up with its
      Decision-3 default `ConfiguredName` after the first restart, with zero
      `characteristic-warning` events emitted across the whole platform construction. Verify:
      `npm test` passes and the test fails if the guard in Section 2 is removed from any one
      service (spot-check by temporarily reverting one service's change locally, confirming this
      test catches it, then re-applying).
- [ ] 3.2 Add or extend a test asserting a second, later construction of every service (simulating
      a normal restart with `ConfiguredName` already present, both at its seeded default and with
      a distinct value simulating a controller rename) never calls `setCharacteristic` on
      `ConfiguredName` again — i.e. the stored value is whatever the test fixture put there going
      in. Verify: `npm test` passes.
- [ ] 3.3 Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` locally (all
      four CI gates per `CLAUDE.md`) and confirm all pass clean before this change is considered
      code-complete.
- [ ] 3.4 Manual check against the real paired Pod (Casey's install; design.md's "Needs
      confirmation on a real paired device" callouts): after deploying this change, open the Home
      app, confirm every side-accessory and hub tile now shows a distinct, sensible label (not the
      shared accessory-name fallback), rename one tile, restart Homebridge, and confirm the rename
      survived. Verify: manual observation in the Home app; not automatable.

## 4. README rewrite (#21)

- [ ] 4.1 Regenerate the config-key reference table from `src/config.ts` and `config.schema.json`
      as the two truth sources, dropping the now-false "Reserved keys are validated now… currently
      have no effect" paragraph — every key is consumed as of this change (confirmed via
      `grep -rn` for each key's usage across `src/` during planning; re-verify at implementation
      time in case a later change added a new reserved key). Verify: every key name in the table
      cross-checked one-for-one against `FreeSleepConfigSchema`'s shape and `config.schema.json`'s
      `properties`, by a line-by-line diff read of both files against the new table.
- [ ] 4.2 Rewrite the "Status" / feature-tour section to reflect the full M1–M4 shipped feature
      set (all 19 capabilities under `openspec/specs/`), replacing the "v0.1.0 (MVP)" framing.
      Verify: every capability directory name in `openspec/specs/` has a corresponding
      user-facing mention in the README.
- [ ] 4.3 Rewrite the "Honesty caveat" section: state what has been Home-app-verified (core
      thermostat control per the archived `thermostat-and-offline` change, #9/#11) versus what
      remains open, listing issue #36's actual outstanding hardware-session items (full-range
      slider drag, occupancy presence/vitals transitions, hub prime/LED/test-alarm/water-low/
      server-fault, real scheduled-alarm fast-poll + DST caveat, settings-switches away-mode/
      skip-alarm end-to-end) rather than the stale #9/#11-only framing. Verify: every open item
      listed traces to an unresolved comment on issue #36 as read during planning.
- [ ] 4.4 Rewrite the "Install" section to include the exact-name Homebridge UI search instruction
      from issue #22's research (`@caseywebb/homebridge-free-sleep` typed verbatim into the UI
      search box finds it today via config-ui-x's scoped-package short-circuit; generic terms do
      not yet, due to npm's own indexing lag, not a metadata problem). Verify: instruction text
      matches the mechanism issue #22's comment describes, read against `homebridge-config-ui-x`'s
      cited `plugins.service.ts:504-515` behavior (re-confirm the line numbers against whatever
      version is installed at implementation time, since `#22`'s research fixed no version pin).
- [ ] 4.5 Full read-through of the rewritten README against the current `npm run lint`/`typecheck`/
      `test`/`build` command set in `package.json`'s `scripts` and against `CLAUDE.md`, to confirm
      no stale command or requirement slipped through. Verify: manual read-through, each command
      mentioned actually exists in `package.json`.

## 5. docs/HOMEKIT.md and docs/ROADMAP.md freshness pass (#21)

- [ ] 5.1 Append a "Service ConfiguredName" section to `docs/HOMEKIT.md` documenting the Decision
      1–3 mechanism (unified convention, seed-once guard, why `testCharacteristic` rather than
      `accessory.context`) as a permanent reference, matching the doc's existing per-decision
      style. Verify: manual read-through against design.md for accuracy; no other section of the
      file changes since the rest was confirmed current during planning.
- [ ] 5.2 Rewrite `docs/ROADMAP.md`: mark M1–M4 as complete (past tense / done framing) and M5 as
      in progress, listing #49/#21/#22 as this milestone's remaining work with #22's own
      "optionally file the verified application" follow-up called out as the one item this change
      does not itself complete. Verify: every milestone bullet cross-checked against
      `openspec/changes/archive/` (each M1–M4 issue number has a corresponding archived change).

## 6. CHANGELOG.md (#21)

- [ ] 6.1 Create `CHANGELOG.md` with entries for 0.1.0, 0.2.0, 0.3.0 (derived from `git log` /
      `openspec/changes/archive/` per-change summaries and the existing README's own version
      history framing), and a 0.3.1 entry for this change's user-visible parts (distinct service
      tile names; docs rewrite is not separately user-visible but may be mentioned). Verify: every
      entry's issue/PR references resolve via `gh issue view`/`gh pr view`; version numbers match
      `package.json`'s `version` field progression (confirm via `git log -p -- package.json` or
      equivalent).

## 7. Verified-plugin application checklist (#22)

- [ ] 7.1 Write a ready-to-file verified-plugin application checklist (e.g.
      `docs/verified-plugin-application.md`) transcribing issue #22's research comment: the
      local/no-cloud differentiation against `@omarshahine/homebridge-eight-sleep` stated as the
      lead differentiator, and a criteria-by-criteria self-assessment (npm ✓, GitHub+issues ✓,
      `config.schema.json` ✓, Node LTS ✓, installs-without-starting-unconfigured ✓, no postinstall
      ✓, GitHub release notes per version ✓, dynamic platform ✓, error-handling discipline ✓ per
      reviews) with each checkmark tied to where in this repo it's demonstrated. Verify: every
      criterion in the doc traces to a specific file/section in this repo (e.g.
      `config.schema.json`'s existence, `CHANGELOG.md` from Section 6, this repo's own issue
      tracker) or to the exact wording of issue #22's research comment; no criterion invented
      beyond what that comment already established.
- [ ] 7.2 Note explicitly in the checklist doc (and cross-reference from `docs/ROADMAP.md`, Task
      5.2) that filing the application itself is a deliberate, separate action for the tech lead —
      not automated or triggered by this change. Verify: the doc contains no instruction to
      auto-file anything; a human must take the next step.

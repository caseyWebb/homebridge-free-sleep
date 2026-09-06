## 1. Service scaffolding

- [ ] 1.1 Create `src/services/types.ts` with the `ServiceContext` interface from design.md
  (`api`, `log`, `accessory`, `snapshot`, `writeQueue`, `timers`, `config`), importing HAP types
  from `homebridge` only. Verify with `npm run typecheck` and by grepping `src/services/` for
  `@homebridge/hap-nodejs` — there must be zero runtime imports of it.
- [ ] 1.2 Add the enabled-subtype table to `src/platform.ts`: side accessories enable the
  thermostat subtype `'thermostat'`, the hub enables the contact-sensor subtype `'connection'`.
  Verify with a unit test that a cached accessory carrying a service outside its role's set has
  that service pruned on restore, and that the in-set services survive.

## 2. Thermostat construction and properties

- [ ] 2.1 Create `src/services/thermostat.ts` that adds (or restores by
  `getServiceById(Service.Thermostat, 'thermostat')`) one thermostat per side accessory, calls
  `service.setPrimaryService(true)`, and adds exactly the five characteristics from design.md's
  table. Verify with a unit test against real HAP-NodeJS that the service's characteristic list
  contains those five and contains neither `HeatingThresholdTemperature` nor
  `CoolingThresholdTemperature`.
- [ ] 2.2 Declare all properties during construction: `TargetHeatingCoolingState` with
  `validValues: [OFF, AUTO]` (OFF first), `TargetTemperature` with `TARGET_TEMP_PROPS` from
  `src/pod/temperature.ts`, `CurrentTemperature` with `{ minValue: -270, maxValue: 100 }`, and no
  `setProps` on `CurrentHeatingCoolingState`. Verify with unit tests that
  `Array.from(targetState.validValuesIterator())` is exactly `[0, 3]` in that order, that
  `Array.from(targetTemp.validValuesIterator())` has length 56 with 110 °F reachable, and that a
  reading of `fToC(40)` written to `CurrentTemperature` is not clamped.
- [ ] 2.3 Assert construction ordering: every `setProps` call happens before any value is set and
  before the accessory is registered. Verify with a unit test that spies on `setProps` and
  `registerPlatformAccessories` through the fake Homebridge API and asserts the call ordering.

## 3. Thermostat reads

- [ ] 3.1 Implement the five `onGet` handlers, all synchronous, reading only
  `snapshot.get()`. Verify with a unit test that each handler's return value is not a promise, and
  that reading every characteristic 100 times against a started mock Pod adds zero entries to the
  mock's request recording.
- [ ] 3.2 Implement the sticky ±1 °F deadband for `CurrentHeatingCoolingState` exactly as
  design.md specifies, including the seed clause when `characteristic.value` is OFF. Verify with a
  table-driven unit test covering: side off → OFF; delta ≥ +1 → HEAT; delta ≤ −1 → COOL; an
  oscillation inside the deadband holding the previous state across at least six observations; and
  the first-ever-launch seed for both signs of delta.
- [ ] 3.3 Implement the unknown-snapshot fallback: when the device-status class reads as unknown,
  every `onGet` returns `characteristic.value`. Verify with a unit test that a platform started
  against a never-answering mock Pod serves the values a restored (cached) accessory already held,
  and that no handler throws.
- [ ] 3.4 Implement `TemperatureDisplayUnits`: lazy seed inside `onGet` from
  `snapshot.get().settings?.temperatureFormat` when `accessory.context.displayUnits` is unset;
  `onSet` stores to `accessory.context.displayUnits` only. Verify with unit tests that a
  `'celsius'` settings value seeds CELSIUS, that a subsequent write to FAHRENHEIT is served on the
  next read, that a later settings change to `'celsius'` does not overwrite it, and that the mock
  Pod recorded zero requests across the whole test.

## 4. Thermostat writes

- [ ] 4.1 Implement `onSet(TargetHeatingCoolingState)` → `writeQueue.submit(side, {isOn})` and
  `onSet(TargetTemperature)` → `writeQueue.submit(side, {targetTemperatureF: round(cToF(v))})`.
  Verify with unit tests against the mock Pod that OFF/AUTO produce a body carrying only `isOn`,
  that a setpoint write produces a body carrying only `targetTemperatureF` with the expected
  integer, and that no request reaches `POST /api/settings`.
- [ ] 4.2 Make each write handler await its submission promise and throw
  `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` on rejection. Verify with unit tests using the
  mock's fault injection that a connection-destroy fault makes the handler reject with that HAP
  status, and that a 400-rejected body does too.
- [ ] 4.3 Verify write coalescing end to end: a mode write and a setpoint write to the same side
  submitted 10 ms apart produce exactly one recorded `POST /api/deviceStatus` carrying both
  fields, and both handlers resolve. Verify with a unit test asserting on the mock's recording.

## 5. The °F shadow

- [ ] 5.1 Implement `accessory.context.publishedF` (`{targetF?, currentF?}`) and the single-writer
  push helpers for `TargetTemperature` and `CurrentTemperature` that compare in whole °F and update
  the shadow in the same statement. Verify with unit tests that two successive observations of the
  same degree produce exactly one `updateValue` call, and that a different degree produces a
  second.
- [ ] 5.2 Make `onSet(TargetTemperature)` claim the degree into the shadow without calling
  `updateCharacteristic`. Verify with a unit test that a write followed by the write queue's
  overlay change event and then by a confirming observation of the same degree produces **zero**
  `updateValue` calls on `TargetTemperature`.
- [ ] 5.3 Verify shadow persistence: a `simulateRestart` through the fake Homebridge API, followed
  by a first observation reporting the same degrees that were published before the restart,
  produces zero `updateValue` calls on either temperature characteristic.
- [ ] 5.4 Verify the failed-write revert: when a dispatch fails and the write queue clears its
  overlay, the resulting change event pushes the last observed degree back to HomeKit exactly once.

## 6. Connection sensor and the offline policy

- [ ] 6.1 Create `src/services/connection.ts` adding (or restoring by `getServiceById`) a
  `ContactSensor` named "Pod Connection" with subtype `'connection'` on the hub, carrying
  `ContactSensorState`, `StatusFault` and `StatusActive`. Verify with a unit test that the hub has
  exactly that one sensor, that neither side accessory has one, and that no thermostat carries
  `StatusFault` or `StatusActive`.
- [ ] 6.2 Map `connection.online` → `CONTACT_DETECTED` / `CONTACT_NOT_DETECTED` and `StatusFault` →
  `NO_FAULT` / `GENERAL_FAULT`, pushing only on an actual change. Verify with a unit test driving
  the snapshot through success → five consecutive failures → success and asserting exactly two
  `updateValue` calls on `ContactSensorState`.
- [ ] 6.3 Implement `StatusActive`: `false` until the first successful observation of the launch,
  `true` thereafter including during later outages. Verify with a unit test covering a launch
  against a never-answering Pod (stays `false`), a launch that succeeds then fails (goes `true` and
  stays `true`).
- [ ] 6.4 Implement the `noResponseAfterMs` escalation as the lazy read-time predicate from
  design.md, using `connection.lastSuccessAt ?? platformStartedAt` and the injected `timers.now()`.
  Verify with unit tests under the manual clock that: reads succeed just inside the window; reads
  throw `SERVICE_COMMUNICATION_FAILURE` just outside it; the first successful poll makes the very
  next read succeed; `noResponseAfterMs: 0` never escalates; and a launch that never reached the
  Pod escalates measured from platform start.
- [ ] 6.5 Verify no timer is created for escalation: after `stop()`, the manual clock reports zero
  pending callbacks owned by the services, and the vitest process exits without an open-handle
  warning.

## 7. Platform wiring

- [ ] 7.1 Construct the snapshot store, poller and write queue once in `src/platform.ts`, wire
  `writeQueue`'s `requestFastPoll` to `poller.requestMode('deviceStatus', …)`, and share them with
  every service. Verify with a unit test that one polling period against the mock Pod produces
  exactly one `GET /api/deviceStatus` regardless of how many services are published.
- [ ] 7.2 Order `didFinishLaunching` as: plan accessories → `await poller.bootstrap()` → construct
  services and register handlers → start recurring polling. Verify with a unit test that the first
  `onGet` after startup against a reachable mock Pod returns an observed value, and with a second
  test that a never-answering mock Pod still results in all three accessories published, polling
  running, and no read throwing.
- [ ] 7.3 Subscribe to `snapshot.subscribe` exactly once and dispatch each change per design.md's
  routing table, wrapping each service call in try/catch. Verify with unit tests that a left-side
  change updates only the left thermostat, that a `connection.online` change updates only the hub
  sensor, that an `awayMode` or `waterLevelState` change updates nothing and raises nothing, and
  that one throwing service does not prevent the others from being notified.
- [ ] 7.4 Stop the poller, the write queue and the snapshot subscription on Homebridge shutdown.
  Verify with a unit test that after shutdown no timer remains pending in the manual clock and no
  further `updateValue` occurs when a late in-flight response settles.

## 8. Integration harness and guardrails

- [ ] 8.1 Add `test/manualTimers.ts` — a `TimerApi` with a virtual `now()`, a sorted pending-callback
  list, `random: () => 0.5`, and an awaitable `advance(ms)`. Verify with its own unit test that
  callbacks fire in due order, that `now()` only moves under `advance`, and that global timers are
  untouched (a real `setTimeout` still fires).
- [ ] 8.2 Add `test/integration/session.test.ts`: boot `FreeSleepPlatform` through
  `test/fakeHomebridgeApi.ts` against a started `test/mockPod.ts`, with `ManualTimers`. Verify the
  harness itself by asserting three accessories are published with their expected services and that
  the mock recorded exactly the bootstrap requests.
- [ ] 8.3 Assert the read-burst guardrail: read every characteristic of all three accessories at
  t=0 and again at t=60 s, and verify the mock's recorded request count is unchanged across each
  burst (delta exactly 0).
- [ ] 8.4 Assert the slider-drag guardrail: six `TargetTemperature` writes 50 ms apart to one side,
  advance past the debounce, and verify exactly one recorded `POST /api/deviceStatus` whose body
  carries the last degree, and that all six handlers resolved.
- [ ] 8.5 Assert the outage guardrail: inject a connection-destroy fault on the device-status
  endpoint for enough requests to span several poll intervals, advance the clock across them, let
  it recover, and verify `ContactSensorState` changed exactly twice, that every read taken during
  the outage returned a value without throwing, and that the thermostat's reported values are the
  last-known ones.
- [ ] 8.6 Assert the offline-then-escalate path in the same harness: hold the fault past
  `noResponseAfterMs`, verify reads then throw `SERVICE_COMMUNICATION_FAILURE`, let the mock
  recover, and verify the very next read succeeds with the newly observed value.

## 9. Documentation and cross-change follow-ups

- [ ] 9.1 Update `docs/HOMEKIT.md` to record the decisions this change fixes that were previously
  open: `CurrentTemperature`'s `-270..100 °C` range, the connection sensor's polarity and its
  `StatusFault`/`StatusActive` semantics, and the read-time (timerless) escalation predicate.
  Verify by reading the diff — every statement must match the shipped code.
- [ ] 9.2 Post the "what needs a real paired device" list from design.md as comments on issues #9
  (items 1–9) and #11 (items 10–14). Verify the comments exist via `gh issue view 9` / `gh issue
  view 11`.
- [ ] 9.3 Report the `writeSettleMs` key collision upward: `platform-foundation`'s reserved-key
  table lists default `500` owned by this change, while `poller-and-write-queue` defines it as the
  15000 ms overlay window. Verify by confirming with the tech lead and, once resolved, that exactly
  one of the two artifacts states the default and the owner.
- [ ] 9.4 Note on issue #14 what this change already ships (the `publishedF` shadow, compare in °F,
  claim-on-write) and what remains for it (the explicit suppression window, `lastNonZeroBrightness`,
  the real-hardware no-snap-back confirmation). Verify via `gh issue view 14`.

## 10. Gates

- [ ] 10.1 Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`; all four pass.
- [ ] 10.2 Verify the published artifact stays clean: `npm run build` emits no `src/services/**`
  reference to `@homebridge/hap-nodejs`, and `dist/` contains no test file. Check by grepping
  `dist/`.
- [ ] 10.3 Verify the whole suite runs with no network and no Pod on the LAN, and that the vitest
  process exits without an open-handle warning.

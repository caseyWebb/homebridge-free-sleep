# HomeKit / HAP modeling decisions

Validated against HAP-NodeJS `latest` (`Characteristic.ts`, `ServiceDefinitions.ts`),
Homebridge 2.4.0, and the current `homebridge-plugin-template`. Where a decision hinges on
behaviour that can only be confirmed on a paired device, it says so.

## Service choice: `Thermostat`, not `HeaterCooler`

The Pod is a **single-setpoint** device. `HeaterCooler` cannot express that: per the HAP spec
`HeatingThresholdTemperature` is required whenever HEAT or AUTO is a valid
`TargetHeaterCoolerState`, and `CoolingThresholdTemperature` whenever COOL or AUTO is — so
AUTO forces a two-setpoint range UI. Restricting to HEAT-only or COOL-only gives one
threshold, but then you must flip the mode based on `target vs current`, mutating the Home
app's mode picker underneath the user.

`Thermostat` has exactly one `TargetTemperature`, and its threshold characteristics are
genuinely optional. **Omit them** — the Home app only renders a range control in AUTO if they
are present. `dillonp23/homebridge-eight8sleep` reached the same conclusion for this device.

### `TargetHeatingCoolingState` restricted to `[OFF, AUTO]`

`setProps({ validValues })` is enforced by HAP, not merely advisory:

- A client write of a value outside the list throws in `validateClientSuppliedValue` and
  becomes `HAPStatus.INVALID_VALUE_IN_REQUEST` before `onSet` runs.
- Our own `updateValue`/`onGet` returns are **clamped, not rejected** — an out-of-list value
  is silently replaced with `validValues[0]` plus a log line. So **list `OFF` first**, and
  watch the logs for that warning during testing.
- `setProps` re-validates the current value and rewrites it if now illegal, so always call
  `setProps` during construction, before any value is set.

Siri caveat: "set the bed to heat" will fail with `INVALID_VALUE_IN_REQUEST`. `AUTO` is what
Siri uses for "turn on", so the common path is fine. If it becomes a real complaint, an
opt-in that widens `validValues` and aliases HEAT/COOL to AUTO is possible, but it makes the
reported value fight the user's selection. Default stays `[OFF, AUTO]`.

### `CurrentHeatingCoolingState` has no "idle" value

Valid values are only `[OFF, HEAT, COOL]`. Never report `OFF` while the side is running — the
Home app builds the tile subtitle from *Current* state, so `Target=Auto, Current=Off` renders
a tile that says "Off" while the bed is actively heating. Use a sticky ±1 °F deadband:

```
if (!isOn)            -> OFF
else if (delta >= +1) -> HEAT
else if (delta <= -1) -> COOL
else                  -> previous non-OFF state   // sticky, stops HEAT/COOL flicker at setpoint
```

## Temperature: work in integer °F internally

Brute-forcing all 55–110 °F through free-sleep's `calculateLevelFromF` → `calculateTempInF`
produces **zero mismatches** — every integer °F round-trips exactly through the ±100 hardware
level scale. So integer °F is a faithful internal representation, and we convert to Celsius
only at the HAP boundary.

```ts
export const F_MIN = 55, F_MAX = 110;
export const fToC = (f: number) => (f - 32) * 5 / 9;
export const cToF = (c: number) => c * 9 / 5 + 32;

export const TARGET_TEMP_PROPS = {
  minValue: fToC(F_MIN),        // 12.777777777777779
  maxValue: fToC(F_MAX) + 0.2,  // the +0.2 is load-bearing — see below
  minStep: 5 / 9,               // exactly 1 °F
};
```

**`minStep = 5/9`, not `0.5`.** HAP snaps values onto a grid anchored at `minValue`:
`stepValue * Math.round((value - minValue) / stepValue) + minValue`. With `minValue = fToC(55)`
and `minStep = 5/9`, grid point *k* is exactly `fToC(55 + k)` — every integer °F is on-grid and
nothing else is. With `0.5` the grid points sit 0.9 °F apart, so consecutive slider positions
round to the same whole °F and the Fahrenheit slider visibly skips degrees.

**`maxValue` needs the `+0.2` margin.** What a client actually sees as "the values this
characteristic accepts" comes from `validValuesIterator()`, and for a numeric characteristic
with no explicit `validValues` list it enumerates the grid with a plain loop —
`for (let i = minValue; i <= maxValue; i += minStep) yield i` — not by computing a step count
via division. With exact endpoints — `minValue = fToC(55)`, `maxValue = fToC(110)`,
`minStep = 5/9` — the quotient `(maxValue - minValue) / minStep` evaluates to exactly `55` in
IEEE-754, so a floored-division account of the bug (as this section previously described) is
not what actually happens here: the loop instead accumulates floating-point error across the
~55 repeated `i += minStep` additions, and that error is what makes the last iteration
overshoot `maxValue` one step early — **110 °F becomes permanently unreachable**, yielding 55
grid points instead of 56. Confirmed against the installed `@homebridge/hap-nodejs`: with the
exact endpoint the iterator yields 55 values (top value 109 °F); with the `+0.2` margin it
yields 56 (top value 110 °F). Unit-testing our own arithmetic does not catch this — the test
has to go through HAP's validator:

```ts
expect(Array.from(char.validValuesIterator())).toHaveLength(56);
```

**Anti-jitter: publish °F, not °C.** After a client write, `handleSetRequest` assigns the raw
client float to `characteristic.value` without snapping it. So the stored value is e.g.
`17.79999`, not our canonical `fToC(64)`. If the poller then pushes the canonical value for
the *same* °F, HAP sees a change, emits an event, and the slider jumps. Keep a shadow
`publishedF[side]` (persisted in `accessory.context`), and only push when the °F actually
differs.

**The full-range-drag guarantee, and where `writeSettleMs` actually lives** (`anti-jitter`,
#14). Dragging the Home app's slider through its whole settable range never produces a visible
snap-back, including while a stale, disagreeing observation races the drag. This is not a
separate mechanism layered on top of the shadow above — it falls out of `WriteQueue`'s
optimistic overlay (`src/pod/writeQueue.ts`, `src/pod/snapshot.ts`), which already does
everything the original design's "`writeSettleMs` window per side" was reaching for:

- The overlay is installed **synchronously**, inside `submit`'s `Promise` executor, before the
  write's own `await` yields control — so there is no tick, and therefore no possible poll
  completion, between the shadow claiming a degree and the overlay pinning the snapshot to it.
- Every write in a drag re-installs the overlay for that field with a fresh `writeSettleMs`
  window and the newest value (`syncOverlays`, called on every `submit`, not just the first in a
  batch) — so the overlay entry is never absent during a continuous drag, and a disagreeing poll
  observation cannot land in a gap that doesn't exist.
- A drag spanning `writeMaxDebounceMs` starts a second write cycle with its own overlay-ownership
  map, but the snapshot's overlay table is keyed by `(side, field)`, not by cycle, so the second
  cycle's install simply replaces the first's with a newer generation — the two cycles agree,
  because both are chasing the same drag.

`writeSettleMs` (`src/config.ts`, default 15000) *is* this overlay's lifetime parameter, not a
second, parallel timestamp check — a `thermostat.ts`-local duplicate would only ever suppress a
strict *subset* of what the overlay already suppresses, making behavior worse, not better. See
`openspec/changes/anti-jitter/design.md`'s "#14" decision for the full argument, and
`test/integration/session.test.ts`'s "slider-drag guardrail" for the full-range-drag-under-race
proof against the mock.

**Clamp at the boundary, not in the read schema** (#33). `src/pod/types.ts`'s `SideStatusSchema`
is deliberately lenient about `targetTemperatureF` — a Pod reporting a value outside 55–110 °F
parses without error — but HAP's `TargetTemperature` characteristic can never report a value
outside that range (`TARGET_TEMP_PROPS`'s `minValue`/`maxValue`). `src/services/thermostat.ts`
calls `clampTargetF` (`src/pod/temperature.ts`) at every point an observed target temperature is
compared against or written into the `publishedF` shadow — `onGet` and `refresh`'s
`pushTemperature` call — so an out-of-range reading is published as the nearest bound and the
shadow never records a value HomeKit could not have produced. This does **not** apply to
`currentTemperatureF` (never clamped — see below) or to the sticky deadband's own delta
calculation, which deliberately uses the raw, unclamped target to decide heat-vs-cool direction.

**`CurrentTemperature`**: leave the default `minStep` of 0.1; widen the range but do **not**
clamp it to 55–110 °F. `currentTemperatureF` is derived from the measured level, which can go
below −100 in a cold room, producing a genuine sub-55 °F reading we should not lie about.
Shipped (`thermostat-and-offline`, #9): `{ minValue: -270, maxValue: 100 }` — the widest range
HAP legally permits for this characteristic, so no reading the Pod can produce is ever clamped.
`fToC(F_MIN)..fToC(F_MAX)+0.2` (the `TargetTemperature` range) was considered and rejected: it
is an arbitrary bound that would still clamp, just less often.

**`TemperatureDisplayUnits`**: the Apple Home app ignores it entirely and displays per the
iOS device's region setting. Serve it from `accessory.context`, seeded once from
`/api/settings.temperatureFormat`. **Never** write it through to `POST /api/settings` — that
is a LowDB write and would rebuild every scheduled job on the Pod because someone tapped a
unit toggle in Eve.

## "No Response" — the naive approach does not work

`updateCharacteristic(char, new Error(...))` is a **no-op in an `onGet`-based plugin.**
`updateValue` sees the Error, sets `this.statusCode`, and returns without emitting an event
or notifying any controller. Worse, the read path resets `statusCode = HAPStatus.SUCCESS` on
every successful `onGet`, and the `throw this.statusCode` branch is only reached when there is
**no** `onGet` handler at all.

The only way to surface No Response is to **throw from the handler** — and HAP-NodeJS's own
[wiki](https://github.com/homebridge/HAP-NodeJS/wiki/Presenting-Erroneous-Accessory-State-to-the-User)
warns against that for transient failures: it triggers extended No Response states that often
persist until the user force-quits the Home app, even after the error clears.

Our outages are *routine and short* (daily reboot). So:

1. **`onGet` never throws while a snapshot exists.** Serve last-known values, log at debug.
2. **`onSet` does throw** — `HapStatusError(SERVICE_COMMUNICATION_FAILURE)`. A failed write is
   a real user-visible failure, and it does not latch because the next read resets the status.
3. **Expose the outage as data**: a `ContactSensor` "Pod Connection" on the hub accessory
   (default on) gives real notifications and automation triggers. Set `StatusFault` /
   `StatusActive` on services that legally declare them — verified: `ContactSensor`,
   `LeakSensor`, `OccupancySensor` do; `Thermostat`, `Switch`, `Lightbulb` do **not**.
4. **Escalate only after `noResponseAfterMs`** (default 10 min, `0` disables), past which
   `onGet` starts throwing. Clears on the first successful poll.

Bootstrap: poll once inside `didFinishLaunching` before wiring handlers. If it fails, fall
back to `characteristic.value` — `PlatformAccessory` persists values across restarts.

### Connection sensor: polarity, status semantics, and escalation (shipped, `thermostat-and-offline`, #9/#11)

**Polarity — locked.** `ContactSensorState.CONTACT_DETECTED` while the Pod is reachable,
`CONTACT_NOT_DETECTED` while it is not. The Home app renders these as "Closed"/"Open", so an
outage reads as "Pod Connection — Open" and the natural automation trigger ("when Pod
Connection opens") fires on going offline — the event people actually want a notification for.
The inverse polarity was considered (arguably a clearer "closed" *state* reading) but makes the
notification-worthy event a *close*, which reads backwards; flipping it after users have built
automations on it would be breaking, so it is locked.

**`StatusFault`** tracks reachability directly: `GENERAL_FAULT` while unreachable, `NO_FAULT`
otherwise. **`StatusActive`** is `false` only until the plugin's first-ever successful
observation of the Pod this launch, then stays `true` — **including through later outages**.
A known-offline Pod is data the sensor is confidently reporting, not an absence of data, which
is the same reasoning this doc already applies to the occupancy sensor's `StatusActive` (see
"Occupancy" below), used here in the opposite direction: `StatusFault` carries the outage
signal instead.

**The connection sensor's own reads never escalate.** The `noResponseAfterMs` escalation
(below) is implemented only on the per-side `Thermostat`'s five characteristics, which have no
fault/status outlet of their own (`Thermostat` does not declare `StatusFault`/`StatusActive` —
see point 3 above). The connection sensor *is* the outage's data channel, so degrading its own
`ContactSensorState`/`StatusFault`/`StatusActive` is already the correct, permanent response to
an outage of any length — escalating it to a throwing read as well would just make the one
service meant to stay legible during an outage go dark too.

**The escalation predicate is evaluated lazily at read time, with no timer:**

```ts
const since = connection.lastSuccessAt ?? platformStartedAt;
const escalated = noResponseAfterMs > 0
  && !connection.online
  && timers.now() - since > noResponseAfterMs;
```

No timer is scheduled for it and nothing is cancelled on shutdown, because there is nothing to
cancel: `connection.online` and `lastSuccessAt` are the snapshot's own fields, already updated
by every poll outcome, so the predicate simply falls out of the current cached state on every
read. The `?? platformStartedAt` clause is what makes a launch where the Pod was never reached
escalate correctly, measured from process start rather than from a `lastSuccessAt` that stays
`null` forever.

## Alarm ringing: a programmable switch, not a motion sensor

`isAlarmVibrating` lives in an in-memory DB, set by `executeAlarm` and cleared by a
`setTimeout(max(10, duration) * 1000)`. Schedules allow 0–180 s, so **a 30 s poll will
routinely miss the entire alarm.**

- **`StatelessProgrammableSwitch`** fired on the rising edge — the correct HomeKit primitive
  for an instantaneous event, and it appears in the automation picker as "When … is pressed".
  HAP explicitly exempts `ProgrammableSwitchEvent` from the setProps revalidation path to
  avoid ghost presses.
- **`Switch` "Dismiss Alarm"** — ON while vibrating; writing OFF posts
  `{[side]: {isAlarmVibrating: false}}`. Writing ON should be accepted and quietly reverted
  after ~500 ms rather than throwing; an error for a harmless mis-tap is worse UX.
- **Not a `MotionSensor`** — "Motion detected" framing is wrong and it lands in the Sensors
  category with activity semantics we do not have.
- **Scheduled fast-poll is mandatory**, not an optimisation. Compute upcoming alarm times per
  side from `/api/schedules` + `timeZone`, honour `expiresAt` skips, and poll at ~3 s for
  ±3 min around each. Without it the feature does not work.
- **`alarmEvents` config flag, default `true`** (tech-lead resolution, `alarm-events` change):
  unlike the hub's opt-in extras, both services and the fast-poll scheduler are on by default —
  the extra polling load is bounded and only ever runs near an actually-enabled alarm, so it has
  no effect on an alarm-free Pod. The flag exists for opt-out and for keeping a soak profile's
  request volume frozen.
- **The dismiss write bypasses the away-mode guard entirely** (`alarm-events` change,
  tech-lead resolution 1): a `WriteQueue` patch whose only field is `isAlarmVibrating` is never
  blocked and never mirrored, regardless of `awayModeWritePolicy` — upstream's own `updateSide`
  never consults `controlBothSides` for this field either (`server/src/routes/deviceStatus/
  updateDeviceStatus.ts`), so this is parity, not a carve-out. Without it, a user could not stop
  a ringing alarm from HomeKit while either side was away under the `'block'` policy.

## Away Mode and Skip Next Alarm: two per-side `Switch`es over `POST /api/settings` (`settings-switches`, #17/#18)

Both bind a field only reachable through the expensive settings write (`docs/POD-API.md`: any
`settingsDB.json` write makes the Pod cancel and rebuild every scheduled job), so both debounce
locally (>= 2s, via the shared `TimerApi`) *above* `WriteQueue`'s own much shorter per-lane
debounce before ever calling `submitSettings` — the service-level timer, not the queue's, is
what satisfies each issue's own anti-storm requirement. `AwayModeService` additionally
rate-limits to one settings write per side per 10s.

- **Away Mode `Switch`** — `settings.{side}.awayMode`. `onGet` reads the cached, overlay-applied
  snapshot directly (the field is already in `snapshot.ts`'s `OverlayableField` union, unshipped
  by any prior change until this one's first real `submitSettings({awayMode})` caller). An
  optional `awayModeTurnsSideOff` config flag (default `false`) sequences a `submitSide(side,
  {isOn: false})` power-off *before* the `awayMode: true` settings write, confirmed first — the
  reverse order would let the Pod's own `controlBothSides` mirror `isOn: false` onto the *other*
  side too, which enabling away mode alone should not do. Turning Away Mode off never touches
  power, regardless of the flag.
- **Skip Next Alarm `Switch`** — reflects whether `settings.{side}.scheduleOverrides.alarm.
  expiresAt` is a non-empty, still-future timestamp; `ON` computes the next occurrence (a direct
  port of `AlarmNotification.tsx`'s "sleep day" convention + `AlarmDisabledDialog.tsx`'s
  noon-based target-date rule — see `src/pod/alarmSchedule.ts`'s `nextAlarmSkipInstant`) and
  posts `{disabled: true, timeOverride: '', expiresAt}`; `OFF` posts `{disabled: false,
  timeOverride: '', expiresAt: ''}`. `expiresAt` is not an `OverlayableField` (a
  continuously-recomputed derived boolean does not fit that raw-value-plus-settle-window model
  cleanly) — this switch instead keeps a small local optimistic shadow, live for
  `writeSettleMs`, mirroring `ThermostatService`'s own `publishedF` shadow pattern rather than
  extending `snapshot.ts` for one caller.
- **Error mapping**: `AwayModeGuard`'s `AwayModeBlockedError` -> `NOT_ALLOWED_IN_CURRENT_STATE`
  mapping gates `submitSide` only — neither switch's own `submitSettings` write is ever gated by
  it, so a failed settings write always surfaces as plain `SERVICE_COMMUNICATION_FAILURE`. The
  one exception: `awayModeTurnsSideOff`'s power-off pre-step *is* a guarded `submitSide` call, so
  a block there does map to `NOT_ALLOWED_IN_CURRENT_STATE`, same as `ThermostatService`.
- **The ordering hazard this change closes** (`src/pod/writeQueue.ts`'s "Drain-before-decide"):
  the first real `submitSettings({awayMode})` caller exposed a race between the settings lane's
  overlay-at-submission behavior and a concurrently-pending side write's away-mode decision —
  closed by draining any pending/queued `awayMode`-touching settings write to full settlement,
  inline, before a side lane ever consults `awayModeGuard.decide()`. See that module's own doc
  for the full mechanism and why draining inline (not merely awaiting) avoids deadlock.

## Other service choices

| Signal | Service | Why |
|---|---|---|
| Water low | `ContactSensor` (default), `LeakSensor` opt-in | `LeakSensor` gives louder alerts but the Home app says **"Water Leak Detected"** for an *empty tank* — actively alarming on a bed full of water tubing. `FilterMaintenance` is semantically closest but only renders as a sub-row of a linked AirPurifier/HeaterCooler; standalone it is an unusable tile. |
| Occupancy | `OccupancySensor`, source configurable | See below. |
| LED | `Lightbulb` + `Brightness` (default **off**) | Joins the Lights category, so "Hey Siri, turn off all the lights" hits it and it pollutes the Home tab's Lights status. Fine, but opt-in. |
| Prime | `Switch` (default off) | Write is one-way; there is no stop command. Writing OFF should refuse. Loud, runs for minutes. |
| Test alarm | Two per-side `Switch`es, "Test Alarm Left"/"Test Alarm Right" (default **off**) | One both-sides switch was rejected (PR #44 tech-lead ruling): a hub-level trigger firing on both sides risks vibrating a sleeping partner's side as a side effect of testing the other. Needs `force: true` since `executeAlarm` refuses when the side is off. `postAlarm`'s rejection is logged and swallowed, never surfaced to HomeKit (N4) — the switch always reports its write as having "succeeded" regardless of whether the trigger actually reached the Pod. |
| Away Mode | Two per-side `Switch`es, "Away Mode Left"/"Away Mode Right" (default **on**) | See above. |
| Skip Next Alarm | Two per-side `Switch`es, "Skip Next Alarm Left"/"Skip Next Alarm Right" (default **on**) | See above. |
| Connection | `ContactSensor` (default on) | See No Response above. |
| Server fault | `ContactSensor` (default off) | Any `/api/serverStatus` subsystem `=== 'failed'`. |
| Heart rate / HRV / breathing | **nothing in v1** | See below. |
| `wifiStrength` | **nothing** | It is a boot-time constant — `loadDeviceStatus` reads a module-level variable that is only refreshed by a separate 10 s interval, and never per request. Log it; do not build on it. |

### Occupancy

`occupancySource: 'none' | 'presence' | 'vitals'`.

`'presence'` reads `/api/metrics/presence`, which **is** populated in near-real time by the
Python biometrics stream (`BiometricProcessor._update_presence_api`) — but only when
biometrics are enabled, and the store is in-memory so it reads `present: false` after every
Pod restart. Set `StatusActive = false` until we have observed at least one `lastUpdatedAt`
change, so the Home app shows "inactive" rather than confidently "unoccupied". An occupancy
sensor that is permanently and wrongly "Not Occupied" is worse than no sensor, because people
build automations on it that silently never fire.

`'vitals'` derives occupancy from a `heart_rate` row in the last ~3 minutes. Same biometrics
prerequisite, but it does not reset on restart.

### Vitals as custom characteristics — not in v1

HomeKit has no native heart-rate/HRV/breathing characteristics, the Home app renders nothing
for custom ones, and a custom **Service** on a bridged accessory can make the *entire
accessory* show as "Not Supported". If shipped later it must be a separate, config-gated
accessory — never attached to the per-side Thermostat.

**Never** repurpose `CarbonDioxideLevel` / `AirQuality` / `LightLevel` for heart rate. It
lands in Home's Air Quality summary and Siri will cheerfully report "the air quality is 62".
Users who want automations get the derived boolean via `occupancySource: 'vitals'`.

## Homebridge 2.x API notes

Removals to avoid: `Characteristic.getValue()` → `.value`; `Characteristic.Formats/Perms/Units`
→ `api.hap.*`; `Accessory.getServiceByUUIDAndSubType()` → `getServiceById()`;
`Accessory.updateReachability()` (gone); **`Accessory.setPrimaryService(svc)` →
`svc.setPrimaryService()`**; `BatteryService` → `Battery`.

Import HAP **types** from `homebridge`; get all runtime enums from `api.hap` — never import
`@homebridge/hap-nodejs` at runtime (devDependency only, for tests).

Declare the `supports-hap` keyword alongside `homebridge-plugin`. The Homebridge UI reads a
transport declaration as complete, and `supports-matter` is only for plugins registering
through `api.matter`.

`setProps` after publish does **not** bump the HAP configuration number (there is an explicit
TODO in `Characteristic.ts` about it), so always call it during accessory construction, never
conditionally later.

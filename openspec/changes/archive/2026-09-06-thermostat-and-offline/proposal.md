## Why

Everything shipped so far is plumbing: a temperature boundary (`temperature-mapping`), an HTTP
client (`pod-client`), a cache and a write queue (`poller-and-write-queue`), and three
accessories that carry nothing but `AccessoryInformation` (`platform-foundation`). None of it is
reachable from the Home app. This change is the one that makes the plugin do its job — it puts a
`Thermostat` on each side accessory, wires it to the cached snapshot and the write queue, and
gives the Pod's routine daily reboot an honest HomeKit representation instead of the "No
Response" latch that the naive approach produces.

It is the last change in the M2 MVP and the first one a user could actually install. It closes
issues #9 (thermostat service per side) and #11 (offline handling across the Pod's daily reboot).

## What Changes

- **A `Thermostat` service per side accessory**, primary, with exactly five characteristics:
  `CurrentHeatingCoolingState`, `TargetHeatingCoolingState` (restricted to `[OFF, AUTO]`, OFF
  listed first), `CurrentTemperature` (widened, never clamped to the settable range),
  `TargetTemperature` (using `TARGET_TEMP_PROPS` from `temperature-mapping`), and
  `TemperatureDisplayUnits` (served from `accessory.context`, never written to the Pod).
  `HeatingThresholdTemperature` / `CoolingThresholdTemperature` are deliberately **absent**.
- **A "Pod Connection" `ContactSensor` on the hub accessory**, carrying `StatusActive` and
  `StatusFault`, that exposes the Pod's reachability as data a user can build notifications and
  automations on.
- **The No-Response policy** from docs/HOMEKIT.md, implemented for real: `onGet` never throws
  while any snapshot exists; `onSet` throws `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` when
  its write does not reach the Pod; escalation to a throwing `onGet` happens only after
  `noResponseAfterMs` of continuous unreachability and clears on the first successful poll.
- **The read path**: every `onGet` is synchronous and reads only the cached snapshot. No `onGet`
  handler is `async`, awaits, or touches the network.
- **The push path**: the platform subscribes each service to the snapshot's typed change events
  and calls `updateCharacteristic` only for fields that actually changed, comparing in **device
  units** (integer °F, booleans) via a `publishedF` shadow persisted in `accessory.context` —
  the minimal M2 slice of the anti-jitter scheme issue #14 completes.
- **The write path**: `onSet(TargetHeatingCoolingState)` and `onSet(TargetTemperature)` submit
  `{isOn}` / `{targetTemperatureF}` patches to the write queue's per-side lane and settle on that
  submission's outcome. A Home-app slider drag therefore produces one `POST /api/deviceStatus`.
- **Platform runtime wiring**: `didFinishLaunching` now bootstraps the poller before HAP
  handlers are registered, starts recurring polling, constructs the services, and stops the
  poller and write queue on shutdown.
- **An in-process integration test** that boots the platform against the mock Pod through the
  fake Homebridge API and asserts the three properties that everything above rests on: a read
  burst issues no Pod requests, a slider drag produces exactly one write, and a mock-Pod restart
  flips the connection sensor exactly twice.

### Non-goals

- **Every other service in docs/HOMEKIT.md's table.** Water level, occupancy, LED, prime, alarm
  (the `StatelessProgrammableSwitch` and its 3 s scheduled fast poll), dismiss-alarm, test-alarm
  and server-fault are M4 (#16, #19, #20) and are not added here. The hub gets exactly one
  service in this change.
- **The keep-alive (#12) and the away-mode write guard (#13).** `isOn: true` will still silently
  expire after 12 hours, and a write while away mode is on will still hit both sides — both are
  M3, both are explicitly the write queue's non-goals, and neither is regressed here.
- **The full anti-jitter treatment (#14).** This change ships the `publishedF` shadow and the
  compare-in-°F rule, which is what stops the poller from fighting the slider. The additional
  `writeSettleMs` suppression window, the `lastNonZeroBrightness` persistence, and the
  real-hardware confirmation that a full-range drag never snaps back stay on #14.
- **Widening `TargetHeatingCoolingState` to accept HEAT/COOL for Siri.** Documented in
  docs/HOMEKIT.md as a possible opt-in; not built.
- **Any new top-level config key.** This change consumes `noResponseAfterMs` and `writeSettleMs`,
  both already defined and defaulted by `platform-foundation`.
- **Changing `pod-client`, `pod-snapshot`, `pod-poller` or `pod-write-queue` behaviour.** This
  change is a consumer of all four; if it needs something they do not offer, that is a finding to
  report, not a silent edit.

## Capabilities

### New Capabilities

- `thermostat-service`: the per-side `Thermostat` — which characteristics exist, the properties
  each is constructed with, how each `onGet` derives its value from the cached snapshot, how the
  sticky ±1 °F deadband picks `CurrentHeatingCoolingState`, how `onSet` maps to a write-queue
  patch, how snapshot change events map to `updateCharacteristic` calls, and the `publishedF`
  shadow that keeps an unchanged °F from ever being pushed.
- `connection-status`: the plugin's outage policy — the hub's "Pod Connection" `ContactSensor`
  with `StatusActive`/`StatusFault`, the rule that `onGet` never throws while a snapshot exists,
  the `onSet` failure surface, and the `noResponseAfterMs` escalation and its clearing.

### Modified Capabilities

- `platform`: the requirement that every accessory carries only `AccessoryInformation` is
  replaced — side accessories now carry a `Thermostat` and the hub carries the connection
  `ContactSensor`. The platform additionally gains runtime responsibilities it did not have:
  owning the poller and write queue lifecycle, bootstrapping before HAP handlers are wired, and
  routing snapshot change events to the services it built.

## Impact

**free-sleep API endpoints touched** (all through `pod-client`, none directly):

| Endpoint | Direction | Cost |
|---|---|---|
| `GET /api/deviceStatus` | read, via the poller's existing 30 s class | Live hardware round-trip on a serialised socket queue. This change adds **no new poll**; it only reads the snapshot the poller already fills. |
| `POST /api/deviceStatus` | write, via the write queue's per-side lane | **Cheap.** Does not touch LowDB, so it does not rebuild scheduled jobs. |
| `GET /api/settings` | read, via the poller's existing 5 min class | Cheap LowDB read. Used once per accessory to seed `TemperatureDisplayUnits` from `temperatureFormat`, and for `awayMode` in the snapshot. |

**No expensive write.** This change issues **no `POST /api/settings` at all** — deliberately, and
this is the single most load-bearing constraint on it. `TemperatureDisplayUnits` is a HomeKit
characteristic a user can toggle from Eve at any time; writing it through would be a
`settingsDB.json` write, and every such write makes the Pod cancel and rebuild every scheduled
job. It is served from and written to `accessory.context` only.

**Code:**

- New: `src/services/thermostat.ts`, `src/services/connection.ts`, `src/services/types.ts`.
- Modified: `src/platform.ts` (service construction, poller/write-queue lifecycle, change-event
  routing, enabled-subtype table).
- New tests: unit tests per service against real HAP characteristics, plus
  `test/integration/session.test.ts` — the in-process platform-against-mock-Pod harness.
- No new runtime dependency. `@homebridge/hap-nodejs` stays devDependency-only; runtime HAP
  enums continue to come from `api.hap`.

**Downstream:** unblocks M3 (#12 keep-alive, #13 away guard, #14 jitter) and M4 (#16 alarm, #19
occupancy, #20 hub sensors), all of which add services alongside these rather than reshaping
them.
